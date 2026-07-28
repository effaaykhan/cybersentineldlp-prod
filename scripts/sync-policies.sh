#!/usr/bin/env bash
#
# sync-policies.sh — mirror THIS dev server's (.204) policies to the mirror
# server (.76) via git + CI.
#
# Flow: export the current policies from the manager's Postgres into
# server/data/exported_policies.json, commit, and push. CI rebuilds the manager
# image with the export baked in; on the mirror server's next image pull the
# seeder applies the newly-created policies (INSERT ... ON CONFLICT (name) DO
# NOTHING — never overwrites operator edits).
#
# The mirror server must opt in with DLP_SEED_EXPORTED_POLICIES=1 in its .env, so
# client installs still receive only the curated default_policies.json.
#
# Usage:
#   scripts/sync-policies.sh                       # export -> commit -> push
#   scripts/sync-policies.sh --no-push             # export -> commit only
#   scripts/sync-policies.sh --container NAME      # custom manager container
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTAINER="cybersentinel-manager"
PUSH=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --container) CONTAINER="$2"; shift 2;;
    --no-push)   PUSH=0; shift;;
    -h|--help)   sed -n '2,26p' "${BASH_SOURCE[0]}"; exit 0;;
    *) echo "unknown option: $1"; exit 2;;
  esac
done

command -v docker >/dev/null || { echo "docker not found"; exit 1; }
docker inspect "$CONTAINER" >/dev/null 2>&1 || { echo "manager container '$CONTAINER' not running (use --container)"; exit 1; }

OUT="$REPO/server/data/exported_policies.json"

echo ">> exporting policies from '$CONTAINER'…"
# The container's app user can't write the mounted repo dir, so export to /tmp
# and copy it out host-side.
docker cp "$SCRIPT_DIR/export_policies.py" "$CONTAINER:/tmp/export_policies.py" >/dev/null
docker exec -e PYTHONPATH=/app -w /app "$CONTAINER" python3 /tmp/export_policies.py /tmp/exported_policies.json
docker cp "$CONTAINER:/tmp/exported_policies.json" "$OUT" >/dev/null

cd "$REPO"
git add server/data/exported_policies.json
if git diff --cached --quiet -- server/data/exported_policies.json; then
  echo ">> no policy changes since last sync — nothing to commit."
  exit 0
fi

N=$(python3 -c "import json;print(len(json.load(open('$OUT'))))")
echo ">> changes to be synced:"
git --no-pager diff --cached --stat -- server/data/exported_policies.json
git commit -q -m "chore(policies): sync ${N} policies from dev server to mirror seed"
echo ">> committed."

if [[ $PUSH -eq 1 ]]; then
  git push origin main
  echo ">> pushed. CI rebuilds the manager image; on the mirror server run:"
  echo "     docker compose -f docker-compose.prod.yml pull manager && \\"
  echo "     docker compose -f docker-compose.prod.yml up -d manager"
  echo "   (with DLP_SEED_EXPORTED_POLICIES=1 in its .env) to apply."
else
  echo ">> not pushed (--no-push). Push when ready: git push origin main"
fi
