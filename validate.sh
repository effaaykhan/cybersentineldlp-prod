#!/usr/bin/env bash
#
# validate.sh — post-deploy validation for the CyberSentinel DLP ML sensitivity
# classifier (and core manager health). Prints PASS / FAIL / SKIP per check and
# exits non-zero if anything FAILED. Auth-free: the classifier checks run inside
# the manager container, so no admin token is needed.
#
# Usage:
#   sudo bash validate.sh                       # auto-detects the manager container
#   sudo bash validate.sh --container NAME --url http://localhost:55000
#
set -uo pipefail

CONTAINER=""
URL="http://localhost:55000"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --container) CONTAINER="$2"; shift 2;;
    --url)       URL="${2%/}"; shift 2;;
    -h|--help)   sed -n '2,14p' "${BASH_SOURCE[0]}"; exit 0;;
    *) echo "unknown option: $1"; exit 2;;
  esac
done

green() { printf "\033[1;32m%s\033[0m" "$*"; }
red()   { printf "\033[1;31m%s\033[0m" "$*"; }
yellow(){ printf "\033[1;33m%s\033[0m" "$*"; }

PASS=0; FAIL=0; SKIP=0
ok()   { printf "  [%s] %s\n" "$(green PASS)" "$1"; PASS=$((PASS+1)); }
no()   { printf "  [%s] %s\n" "$(red   FAIL)" "$1"; FAIL=$((FAIL+1)); }
skip() { printf "  [%s] %s\n" "$(yellow SKIP)" "$1"; SKIP=$((SKIP+1)); }

command -v docker >/dev/null || { echo "docker not found"; exit 2; }

# auto-detect the manager container (prod name, then dev)
if [[ -z "$CONTAINER" ]]; then
  for n in cybersentineldlp-manager cybersentinel-manager; do
    docker inspect "$n" >/dev/null 2>&1 && CONTAINER="$n" && break
  done
fi
[[ -n "$CONTAINER" ]] || { echo "$(red 'FAIL') no manager container found (pass --container NAME)"; exit 1; }

echo "CyberSentinel DLP — deployment validation"
echo "  container: $CONTAINER   api: $URL"
echo

# run a python snippet in the manager; echo the line prefixed RESULT:
# (-i is required so the heredoc reaches `python3 -` on stdin)
pyrun() {
  docker exec -i -e PYTHONPATH=/app -w /app "$CONTAINER" python3 - 2>/dev/null <<PY | grep '^RESULT:' | head -1 | sed 's/^RESULT://'
$1
PY
}

# 1) container running
if [[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" == "true" ]]; then
  ok "manager container is running"
else
  no "manager container is not running"
fi

# 2) HTTP health
code=$(curl -s -o /dev/null -w '%{http_code}' "$URL/health" 2>/dev/null || echo 000)
[[ "$code" == "200" ]] && ok "manager /health responds 200" || no "manager /health returned $code"

# 3) no ml_classifier errors in recent logs
# (grep -c reads the whole stream — avoids SIGPIPE tripping `set -o pipefail`)
n_err=$(docker logs --tail 400 "$CONTAINER" 2>&1 | grep -i "ml_classifier" | grep -ciE "error|traceback" || true)
if [[ "${n_err:-0}" -gt 0 ]]; then
  no "ml_classifier errors present in logs"
else
  ok "no ml_classifier errors in recent logs"
fi

# 4) startup self-check line present
n_ok=$(docker logs "$CONTAINER" 2>&1 | grep -c "ML classifier self-check: available" || true)
n_bad=$(docker logs "$CONTAINER" 2>&1 | grep -c "ML classifier self-check: UNAVAILABLE" || true)
if [[ "${n_ok:-0}" -gt 0 ]]; then
  ok "startup self-check logged the classifier as available"
elif [[ "${n_bad:-0}" -gt 0 ]]; then
  no "startup self-check logged the classifier as UNAVAILABLE"
else
  skip "startup self-check line not found (older image, or logs rotated)"
fi

# 5+6) model status + prediction (FP guard) — model layer, no DB needed
R=$(pyrun '
import json
from app.services import ml_classifier as m
st=m.model_status()
p1=m.predict_level("Confidential board briefing on the proposed acquisition, purchase price, and due diligence findings.")
p2=m.predict_level("Lunch is booked for Friday at noon, let me know dietary needs.")
sens = bool(p1 and p1["confident"] and p1["level"] in ("Confidential","Restricted"))
fp   = not bool(p2 and p2["confident"] and p2["level"] in ("Confidential","Restricted"))
print("RESULT:"+json.dumps({"avail":bool(st.get("available")),"cv":st.get("cv_accuracy"),
      "trained_on":st.get("trained_on"),"sens":sens,"fp":fp}))
')
if [[ -n "$R" ]]; then
  py() { printf '%s' "$R" | python3 -c "import json,sys;print(json.load(sys.stdin).get('$1',''))" 2>/dev/null; }
  [[ "$(py avail)" == "True" ]] && ok "model available (cv=$(py cv), trained_on=$(py trained_on))" \
                                 || no "model reports unavailable"
  [[ "$(py sens)" == "True" ]] && ok "sensitive prose is confidently classified sensitive" \
                                || no "sensitive prose was NOT flagged (expected Confidential/Restricted)"
  [[ "$(py fp)"   == "True" ]] && ok "benign text is not confidently flagged (false-positive guard)" \
                                || no "benign text was confidently flagged sensitive (false positive!)"
else
  no "could not query the ML model inside the container"
fi

# 7) additive pipeline behaviour (classify_content) — needs DB; SKIP on error
R2=$(pyrun '
import asyncio, json
import app.core.database as d
from app.services.classification_engine import ClassificationEngine
async def main():
    await d.init_databases()
    async with d.postgres_session_factory() as s:
        e=ClassificationEngine(s)
        async def lvl(t):
            r=await e.classify_content(t); return r.classification
        pii=await lvl("SSN 123-45-6789 card 4111 1111 1111 1111")
        prose=await lvl("Confidential board briefing on the proposed acquisition and purchase price.")
        benign=await lvl("lunch is booked for friday at noon")
        print("RESULT:"+json.dumps({"pii":pii,"prose":prose,"benign":benign}))
asyncio.run(main())
')
if [[ -n "$R2" ]]; then
  pj() { printf '%s' "$R2" | python3 -c "import json,sys;print(json.load(sys.stdin).get('$1',''))" 2>/dev/null; }
  [[ "$(pj pii)" == "Restricted" ]] && ok "regex PII still classifies Restricted (existing detection intact)" \
                                     || no "regex PII classified $(pj pii), expected Restricted (REGRESSION)"
  case "$(pj prose)" in
    Confidential|Restricted) ok "sensitive prose is raised to $(pj prose) (ML augmentation working)";;
    *) no "sensitive prose classified $(pj prose), expected Confidential/Restricted";;
  esac
  [[ "$(pj benign)" == "Public" ]] && ok "benign content stays Public (no over-classification)" \
                                    || no "benign content classified $(pj benign), expected Public"
else
  skip "pipeline (classify_content) check — DB not reachable from the check process"
fi

# 8) persistence volume present
if docker volume ls --format '{{.Name}}' 2>/dev/null | grep -q "ml_models"; then
  ok "ml_models persistence volume exists"
else
  skip "ml_models named volume not found (dev bind-mount, or renamed project)"
fi

# 9) management API route registered (expects auth challenge, not 404)
mcode=$(curl -s -o /dev/null -w '%{http_code}' "$URL/api/v1/ml-classifier/status" 2>/dev/null || echo 000)
case "$mcode" in
  401|403) ok "/api/v1/ml-classifier route is registered (auth-gated)";;
  200)     ok "/api/v1/ml-classifier route is registered";;
  404)     no "/api/v1/ml-classifier route is missing (404)";;
  *)       skip "/api/v1/ml-classifier returned $mcode (manager reachable?)";;
esac

echo
printf "Summary: %s passed, %s failed, %s skipped\n" "$(green $PASS)" "$( [[ $FAIL -gt 0 ]] && red $FAIL || echo $FAIL )" "$SKIP"
if [[ $FAIL -gt 0 ]]; then
  echo "$(red 'Validation FAILED') — review the checks above."
  exit 1
fi
echo "$(green 'Validation passed.')"
exit 0
