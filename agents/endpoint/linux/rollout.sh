#!/usr/bin/env bash
#
# CyberSentinel DLP - fleet rollout helper.
#
# Pushes this directory to a list of endpoints over SSH and runs install.sh on
# each. Intended for small/medium fleets where you already have SSH key access;
# for larger estates drive install.sh from Ansible/Salt instead.
#
#   ./rollout.sh --server-url http://10.0.0.5:55000/api/v1 \
#                --hosts alice@10.0.0.11,bob@10.0.0.12
#
#   ./rollout.sh --server-url http://10.0.0.5:55000/api/v1 --hosts-file fleet.txt
#
# By default every target builds its own executable, which needs a Python build
# toolchain and PyPI access on each one. For a fleet it is usually better to
# build once and ship the binary:
#
#   sudo ./install.sh --build-only
#   ./rollout.sh --server-url ... --hosts-file fleet.txt \
#                --prebuilt-binary /opt/cybersentinel/build/dist/cybersentineldlp-agent
#
# Requires passwordless sudo on the targets, or run as root there.

set -euo pipefail

SERVER_URL=""
HOSTS=""
HOSTS_FILE=""
SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=15"
PARALLEL=4
EXTRA_ARGS=""
PREBUILT_BINARY=""

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<EOF
Usage: ./rollout.sh --server-url URL (--hosts LIST | --hosts-file PATH) [options]

  --server-url URL     Manager API base URL passed through to install.sh
  --hosts LIST         Comma-separated [user@]host entries
  --hosts-file PATH    File with one [user@]host per line (# comments allowed)
  --parallel N         Concurrent installs (default: $PARALLEL)
  --ssh-opts "..."     Extra ssh options
  --extra "..."        Extra flags forwarded to install.sh
  --prebuilt-binary P  Ship this already-built executable instead of building
                       on every target. The targets then need no Python and no
                       build toolchain. Build it with: install.sh --build-only
  -h, --help           Show this help

Each host registers as its own agent: install.sh never copies identity, so
agent_id/agent_key are generated per endpoint on first start.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --server-url) SERVER_URL="${2:-}"; shift 2 ;;
    --hosts)      HOSTS="${2:-}";      shift 2 ;;
    --hosts-file) HOSTS_FILE="${2:-}"; shift 2 ;;
    --parallel)   PARALLEL="${2:-}";   shift 2 ;;
    --ssh-opts)   SSH_OPTS="${2:-}";   shift 2 ;;
    --extra)      EXTRA_ARGS="${2:-}"; shift 2 ;;
    --prebuilt-binary) PREBUILT_BINARY="${2:-}"; shift 2 ;;
    -h|--help)    usage; exit 0 ;;
    *)            usage >&2; echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

[ -n "$SERVER_URL" ] || { usage >&2; echo "ERROR: --server-url is required." >&2; exit 1; }

# Which files each target needs depends on whether it builds or just installs.
# Getting this list wrong fails on the target's preflight check rather than
# here, which is a slow and confusing way to find out.
if [ -n "$PREBUILT_BINARY" ]; then
  [ -f "$PREBUILT_BINARY" ] || { echo "ERROR: no such file: $PREBUILT_BINARY" >&2; exit 1; }
  PAYLOAD=("$PREBUILT_BINARY" "$SRC_DIR/install.sh" "$SRC_DIR/uninstall.sh"
           "$SRC_DIR/cybersentineldlp-agent.service")
  REMOTE_INSTALL_ARGS="--prebuilt-binary \"\$HOME/.cybersentinel-deploy/$(basename "$PREBUILT_BINARY")\""
else
  PAYLOAD=("$SRC_DIR/agent.py" "$SRC_DIR/policy_cache.py" "$SRC_DIR/print_monitor.py"
           "$SRC_DIR/agent_launcher.py" "$SRC_DIR/install.sh" "$SRC_DIR/uninstall.sh"
           "$SRC_DIR/requirements.txt" "$SRC_DIR/requirements-build.txt"
           "$SRC_DIR/cybersentineldlp-agent.service")
  REMOTE_INSTALL_ARGS=""
fi

for f in "${PAYLOAD[@]}"; do
  [ -f "$f" ] || { echo "ERROR: missing file needed for rollout: $f" >&2; exit 1; }
done

TARGETS=()
if [ -n "$HOSTS" ]; then
  IFS=',' read -r -a TARGETS <<< "$HOSTS"
fi
if [ -n "$HOSTS_FILE" ]; then
  [ -f "$HOSTS_FILE" ] || { echo "ERROR: no such file: $HOSTS_FILE" >&2; exit 1; }
  while read -r line; do
    line="${line%%#*}"
    line="$(echo "$line" | tr -d '[:space:]')"
    [ -n "$line" ] && TARGETS+=("$line")
  done < "$HOSTS_FILE"
fi

[ "${#TARGETS[@]}" -gt 0 ] || { echo "ERROR: no targets given." >&2; exit 1; }

RESULT_DIR="$(mktemp -d)"
trap 'rm -rf "$RESULT_DIR"' EXIT

deploy_one() {
  local target="$1"
  local safe="${target//[^A-Za-z0-9]/_}"
  local log="$RESULT_DIR/$safe.log"

  {
    echo "=== $target ==="
    # shellcheck disable=SC2086
    ssh $SSH_OPTS "$target" "rm -rf ~/.cybersentinel-deploy && mkdir -p ~/.cybersentinel-deploy" || return 1
    # shellcheck disable=SC2086
    scp $SSH_OPTS -q "${PAYLOAD[@]}" "$target:~/.cybersentinel-deploy/" || return 1
    # shellcheck disable=SC2086
    ssh $SSH_OPTS "$target" \
      "cd ~/.cybersentinel-deploy && chmod +x install.sh uninstall.sh && sudo ./install.sh --server-url '$SERVER_URL' $REMOTE_INSTALL_ARGS $EXTRA_ARGS" || return 1
  } >"$log" 2>&1

  return $?
}

echo "Rolling out to ${#TARGETS[@]} host(s), ${PARALLEL} at a time..."
echo

pids=()
for target in "${TARGETS[@]}"; do
  deploy_one "$target" &
  pids+=("$!:$target")

  # Simple concurrency gate: drain the oldest job once the window is full.
  if [ "${#pids[@]}" -ge "$PARALLEL" ]; then
    entry="${pids[0]}"; pids=("${pids[@]:1}")
    wait "${entry%%:*}" || true
  fi
done
for entry in "${pids[@]}"; do wait "${entry%%:*}" || true; done

OK=0; FAILED=0; FAILED_HOSTS=()
for target in "${TARGETS[@]}"; do
  safe="${target//[^A-Za-z0-9]/_}"
  if grep -q "Installation complete" "$RESULT_DIR/$safe.log" 2>/dev/null; then
    printf '  \033[32m✓\033[0m %s\n' "$target"
    OK=$((OK + 1))
  else
    printf '  \033[31m✗\033[0m %s\n' "$target"
    FAILED=$((FAILED + 1)); FAILED_HOSTS+=("$target")
  fi
done

echo
echo "Succeeded: $OK    Failed: $FAILED"

# A rollout that quietly half-worked is worse than one that failed loudly:
# print the actual errors for every host that did not finish.
if [ "$FAILED" -gt 0 ]; then
  for target in "${FAILED_HOSTS[@]}"; do
    safe="${target//[^A-Za-z0-9]/_}"
    echo
    echo "--- $target (last 20 lines) ---"
    tail -20 "$RESULT_DIR/$safe.log" 2>/dev/null || echo "  no output captured"
  done
  exit 1
fi
