#!/usr/bin/env bash
#
# make-training-set.sh — one-shot training set for the ML sensitivity classifier.
#
# Wires together the three helpers in this folder:
#   build_real_csv.py  -> a balanced set from public Hugging Face datasets
#   folder_to_csv.py   -> your own documents (pdf/docx/image-OCR), run in the
#                         manager container
#   merge_csv.py       -> combine + de-dup + balance, preferring your own rows
#
# Produces one text,label CSV ready to upload at
#   Enforce -> ML Classifier -> Retrain   (or --upload to POST it for you).
#
# Examples:
#   ./make-training-set.sh                              # public set only
#   ./make-training-set.sh --docs ./my-docs             # public + your documents
#   ./make-training-set.sh --docs ./my-docs --no-public # only your documents
#   ./make-training-set.sh --docs ./my-docs --upload --token "$TOKEN"
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# defaults
DOCS=""
CONTAINER="cybersentinel-manager"
INCLUDE_PUBLIC=1
PUBLIC_PER_LEVEL=300
BALANCE="min"
PER_LEVEL=0
OUTPUT="training-set.csv"
DO_UPLOAD=0
HOST="http://localhost:55000"
TOKEN=""
REPLACE=0

die() { echo "error: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --docs)              DOCS="$2"; shift 2;;
    --container)         CONTAINER="$2"; shift 2;;
    --public)            INCLUDE_PUBLIC=1; shift;;
    --no-public)         INCLUDE_PUBLIC=0; shift;;
    --public-per-level)  PUBLIC_PER_LEVEL="$2"; shift 2;;
    --balance)           BALANCE="$2"; shift 2;;
    --per-level)         PER_LEVEL="$2"; shift 2;;
    -o|--output)         OUTPUT="$2"; shift 2;;
    --upload)            DO_UPLOAD=1; shift;;
    --host)              HOST="${2%/}"; shift 2;;
    --token)             TOKEN="$2"; shift 2;;
    --replace)           REPLACE=1; shift;;
    -h|--help)           sed -n '2,30p' "${BASH_SOURCE[0]}"; exit 0;;
    *)                   die "unknown option: $1 (see --help)";;
  esac
done

command -v python3 >/dev/null || die "python3 not found"
[[ $INCLUDE_PUBLIC -eq 0 && -z "$DOCS" ]] && die "nothing to build: pass --docs and/or drop --no-public"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
INPUTS=()
PREFER=()

# 1) public set ---------------------------------------------------------------
if [[ $INCLUDE_PUBLIC -eq 1 ]]; then
  echo ">> building public set (${PUBLIC_PER_LEVEL}/level) from Hugging Face datasets…"
  PER_LEVEL="$PUBLIC_PER_LEVEL" python3 "$SCRIPT_DIR/build_real_csv.py" "$TMP/public.csv" \
    | tail -1
  INPUTS+=("$TMP/public.csv")
fi

# 2) your documents (via the manager container for OCR/pdf/docx) --------------
if [[ -n "$DOCS" ]]; then
  [[ -d "$DOCS" ]] || die "--docs is not a directory: $DOCS"
  command -v docker >/dev/null || die "docker not found (needed to extract your documents)"
  docker inspect "$CONTAINER" >/dev/null 2>&1 || die "container not running: $CONTAINER (set --container)"
  echo ">> extracting your documents from '$DOCS' via container '$CONTAINER'…"
  CDOCS="/tmp/mts-$$-docs"
  docker exec "$CONTAINER" rm -rf "$CDOCS" 2>/dev/null || true
  docker cp "$DOCS" "$CONTAINER:$CDOCS" >/dev/null
  docker cp "$SCRIPT_DIR/folder_to_csv.py" "$CONTAINER:/tmp/mts-$$-f2c.py" >/dev/null
  docker exec -e PYTHONPATH=/app -w /app "$CONTAINER" \
    python3 "/tmp/mts-$$-f2c.py" "$CDOCS" -o "/tmp/mts-$$-mine.csv" || die "extraction failed"
  docker cp "$CONTAINER:/tmp/mts-$$-mine.csv" "$TMP/mine.csv" >/dev/null
  docker exec "$CONTAINER" sh -c "rm -rf $CDOCS /tmp/mts-$$-f2c.py /tmp/mts-$$-mine.csv" 2>/dev/null || true
  INPUTS+=("$TMP/mine.csv")
  PREFER=(--prefer "$TMP/mine.csv")
fi

[[ ${#INPUTS[@]} -gt 0 ]] || die "no inputs were produced"

# 3) merge + balance ----------------------------------------------------------
echo ">> merging + balancing -> $OUTPUT"
MERGE_ARGS=(-o "$OUTPUT" --balance "$BALANCE")
[[ $PER_LEVEL -gt 0 ]] && MERGE_ARGS+=(--per-level "$PER_LEVEL")
python3 "$SCRIPT_DIR/merge_csv.py" "${INPUTS[@]}" "${PREFER[@]}" "${MERGE_ARGS[@]}"

# 4) optional upload ----------------------------------------------------------
if [[ $DO_UPLOAD -eq 1 ]]; then
  [[ -n "$TOKEN" ]] || die "--upload needs --token <admin bearer token>"
  command -v curl >/dev/null || die "curl not found"
  echo ">> uploading to $HOST/api/v1/ml-classifier/retrain (replace=$REPLACE)…"
  B64="$(base64 -w0 "$OUTPUT" 2>/dev/null || base64 "$OUTPUT" | tr -d '\n')"
  RBOOL=$([[ $REPLACE -eq 1 ]] && echo true || echo false)
  printf '{"csv_b64":"%s","replace":%s}' "$B64" "$RBOOL" > "$TMP/payload.json"
  curl -sS -X POST "$HOST/api/v1/ml-classifier/retrain" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d @"$TMP/payload.json" | python3 -m json.tool 2>/dev/null || echo "(upload response not JSON)"
fi

echo ">> done: $OUTPUT"
