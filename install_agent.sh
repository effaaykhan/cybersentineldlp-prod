#!/usr/bin/env bash
#
# CyberSentinel DLP Agent - Linux installation script.
# Requires root.
#
# Usage (one-liner):
#   curl -fsSL https://raw.githubusercontent.com/effaaykhan/cybersentineldlp-prod/main/install_agent.sh | sudo bash
#
# Unattended (no prompts):
#   curl -fsSL .../install_agent.sh | sudo bash -s -- --server-host dlp.corp.local --yes
#
# This is the ONLY file a client machine needs. Everything else — the agent
# executable, its checksum, and the systemd unit — is fetched from the repo.
#
# What this script does:
#   1. Validates server connectivity (IP or DNS hostname).
#   2. Cleans previous installs (systemd units, processes, legacy directories),
#      recovering the existing agent identity first.
#   3. Installs OS dependencies (none are required — the agent is a static
#      binary; OCR is opt-in via --with-ocr).
#   4. Downloads cybersentineldlp-agent from the repo, verifies its SHA-256
#      against the sidecar manifest, and refuses to install on a mismatch.
#   5. Optional GPG signature check (warn-only until a signing key is
#      provisioned).
#   6. Writes agent_configure.json by invoking the binary itself.
#   7. Installs and enables a systemd unit (boot + crash restart).
#   8. Starts the agent and verifies it stayed up.
#
# Tested on: Ubuntu 22.04/24.04/25.04, Debian 12, Rocky 9, Fedora 40.

set -euo pipefail

# The entire script is wrapped in main() and only invoked on the last line.
# Piping into a shell executes whatever bytes arrived, so a connection dropped
# mid-transfer would otherwise run a truncated installer — half-configuring an
# endpoint is worse than not touching it.
main() {

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

GITHUB_REPO="effaaykhan/cybersentineldlp-prod"
GITHUB_REF="main"
INSTALL_DIR="/opt/cybersentinel/agent"
CONFIG_DIR="/etc/cybersentinel"
LOG_DIR="/var/log/cybersentinel"
DATA_DIR="/var/lib/cybersentinel"
QUARANTINE_DIR="/opt/cybersentinel/quarantine"
RUN_DIR="/opt/cybersentinel/run"
BIN_NAME="cybersentineldlp-agent"
CONFIG_NAME="agent_configure.json"
SERVICE_NAME="cybersentineldlp-agent"
SERVER_PORT="55000"

SERVER_HOST=""
SERVER_URL=""
AGENT_NAME=""
HEARTBEAT_INTERVAL=""
POLICY_SYNC_INTERVAL=""
BINARY_URL=""
UNIT_URL_OVERRIDE=""
ASSUME_YES=0
WITH_OCR=0

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_CYAN=$'\033[36m'
else
  C_RESET=""; C_BOLD=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_CYAN=""
fi

info()    { printf '%s%s%s\n' "$C_CYAN"   "$1" "$C_RESET"; }
success() { printf '%s%s%s\n' "$C_GREEN"  "$1" "$C_RESET"; }
warn()    { printf '%s%s%s\n' "$C_YELLOW" "$1" "$C_RESET" >&2; }
err()     { printf '%s%s%s\n' "$C_RED"    "$1" "$C_RESET" >&2; }
die()     { printf '\n%sERROR:%s %s\n' "$C_RED$C_BOLD" "$C_RESET" "$1" >&2; exit 1; }
rule()    { printf '%s============================================================%s\n' "$C_CYAN" "$C_RESET"; }

usage() {
  cat <<EOF
CyberSentinel DLP Agent - Linux installer

Usage: curl -fsSL <url>/install_agent.sh | sudo bash -s -- [options]
   or: sudo ./install_agent.sh [options]

Options:
  --server-host HOST     Manager IP or hostname (port ${SERVER_PORT} is implied)
  --server-url URL       Full API base URL, overrides --server-host
  --agent-name NAME      Name registered with the manager (default: hostname)
  --heartbeat N          Heartbeat interval in seconds (default: 30)
  --policy-sync N        Policy sync interval in seconds (default: 60)
  --binary-url URL       Fetch the executable from here instead of the repo
  --unit-url URL         Fetch the systemd unit template from here instead
                         (both accept file:// for an internal mirror)
  --ref REF              Git branch or tag to fetch from (default: ${GITHUB_REF})
  --with-ocr             Also install tesseract (see note below)
  -y, --yes              Accept defaults, never prompt (for unattended runs)
  -h, --help             Show this help

Note on --with-ocr: screenshot OCR is a Windows agent feature. The Linux agent
does not use tesseract, so it is not installed unless you ask for it.
EOF
}

# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

# Accept an IPv4 literal, "localhost", or an RFC1123 hostname/FQDN. Operators
# in real environments use names like dlp.corp.local, not just IPs.
valid_server_host() {
  local v="${1:-}"
  [ -n "$v" ] || return 1
  [ "$v" = "localhost" ] && return 0
  if printf '%s' "$v" | grep -Eq '^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$'; then
    return 0
  fi
  [ "${#v}" -le 253 ] || return 1
  printf '%s' "$v" | grep -Eq '^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$'
}

valid_positive_int() {
  printf '%s' "${1:-}" | grep -Eq '^[0-9]+$' && [ "${1:-0}" -gt 0 ]
}

have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
# Prompting
#
# Piping into bash makes stdin the pipe, not the terminal, so `read` would
# consume the script's own bytes or hit EOF immediately. Read from /dev/tty
# instead, and fall back to defaults when there genuinely is no terminal.
# ---------------------------------------------------------------------------

TTY_OK=0
if [ -r /dev/tty ] && [ -w /dev/tty ] && [ "$ASSUME_YES" -eq 0 ]; then
  TTY_OK=1
fi

ask() {  # ask VARNAME "prompt text" "default"
  local __var="$1" __prompt="$2" __default="$3" __ans=""
  if [ "$TTY_OK" -eq 0 ] || [ "$ASSUME_YES" -eq 1 ]; then
    printf -v "$__var" '%s' "$__default"
    return 0
  fi
  printf '%s' "$__prompt" > /dev/tty
  IFS= read -r __ans < /dev/tty || __ans=""
  [ -n "$__ans" ] || __ans="$__default"
  printf -v "$__var" '%s' "$__ans"
}

# ---------------------------------------------------------------------------
# Download helper
# ---------------------------------------------------------------------------

fetch() {  # fetch URL DEST  — returns non-zero on any HTTP or transport error
  local url="$1" dest="$2"
  if have curl; then
    curl -fsSL --retry 3 --retry-delay 2 --max-time 300 -o "$dest" "$url"
  elif have wget; then
    wget -q --tries=3 --timeout=300 -O "$dest" "$url"
  else
    die "Neither curl nor wget is available. Install one and re-run."
  fi
}

fetch_stdout() {  # fetch_stdout URL
  local url="$1"
  if have curl; then
    curl -fsSL --retry 2 --max-time 30 "$url"
  elif have wget; then
    wget -q --tries=2 --timeout=30 -O - "$url"
  else
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------

while [ $# -gt 0 ]; do
  case "$1" in
    --server-host) SERVER_HOST="${2:-}";          shift 2 ;;
    --server-url)  SERVER_URL="${2:-}";           shift 2 ;;
    --agent-name)  AGENT_NAME="${2:-}";           shift 2 ;;
    --heartbeat)   HEARTBEAT_INTERVAL="${2:-}";   shift 2 ;;
    --policy-sync) POLICY_SYNC_INTERVAL="${2:-}"; shift 2 ;;
    --binary-url)  BINARY_URL="${2:-}";           shift 2 ;;
    --unit-url)    UNIT_URL_OVERRIDE="${2:-}";    shift 2 ;;
    --ref)         GITHUB_REF="${2:-}";           shift 2 ;;
    --with-ocr)    WITH_OCR=1;                    shift ;;
    -y|--yes)      ASSUME_YES=1; TTY_OK=0;        shift ;;
    -h|--help)     usage; exit 0 ;;
    *)             usage >&2; die "Unknown option: $1" ;;
  esac
done

RAW_BASE="https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_REF}"
REMOTE_DIR="${RAW_BASE}/agents/endpoint/linux"
[ -n "$BINARY_URL" ] || BINARY_URL="${REMOTE_DIR}/dist/${BIN_NAME}"
SUM_URL="${BINARY_URL}.sha256"
SIG_URL="${BINARY_URL}.asc"
UNIT_URL="${UNIT_URL_OVERRIDE:-${REMOTE_DIR}/${SERVICE_NAME}.service}"
CONFIG_FILE="${CONFIG_DIR}/${CONFIG_NAME}"
BIN_PATH="${INSTALL_DIR}/${BIN_NAME}"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"

clear 2>/dev/null || true
rule
printf '%s   CyberSentinel DLP Agent - Linux Installation Script      %s\n' "$C_CYAN$C_BOLD" "$C_RESET"
rule
echo

[ "$(id -u)" -eq 0 ] || die "This installer must run as root. Pipe it into 'sudo bash', or run with sudo."
[ -d /run/systemd/system ] || die "systemd is not the active init system. This installer targets systemd hosts."
have systemctl || die "systemctl not found."

# ---------------------------------------------------------------------------
# Step 1: Configuration
# ---------------------------------------------------------------------------

info "Step 1: Configuration Setup"
echo

if [ -z "$SERVER_URL" ]; then
  while :; do
    [ -n "$SERVER_HOST" ] || ask SERVER_HOST "Enter server IP or hostname (default: localhost): " "localhost"
    if valid_server_host "$SERVER_HOST"; then break; fi
    err "Invalid host. Use an IPv4 literal, 'localhost', or an RFC1123 hostname/FQDN."
    SERVER_HOST=""
    [ "$TTY_OK" -eq 1 ] || die "No terminal available to re-prompt. Pass --server-host explicitly."
  done
  SERVER_URL="http://${SERVER_HOST}:${SERVER_PORT}/api/v1"
else
  # A bare host:port is the most common mistake and shows up as a confusing 404
  # at registration rather than an install-time error.
  case "$SERVER_URL" in
    http://*|https://*) ;;
    *) die "--server-url must start with http:// or https:// (got: $SERVER_URL)" ;;
  esac
  case "$SERVER_URL" in
    */api/v1|*/api/v1/) ;;
    *) warn "--server-url does not end in /api/v1 — registration will likely 404." ;;
  esac
  SERVER_HOST="$(printf '%s' "$SERVER_URL" | sed -E 's#^https?://##; s#[:/].*$##')"
fi
success "Server URL: $SERVER_URL"
echo

info "Testing server connectivity..."
HEALTH_URL="http://${SERVER_HOST}:${SERVER_PORT}/health"
if HEALTH_OUT="$(fetch_stdout "$HEALTH_URL" 2>/dev/null)" && \
   printf '%s' "$HEALTH_OUT" | grep -q 'healthy'; then
  success "Server is healthy"
else
  warn "Could not reach server at $HEALTH_URL - continuing anyway"
fi
echo

[ -n "$AGENT_NAME" ] || ask AGENT_NAME "Enter Agent Name (default: $(hostname)): " "$(hostname)"
success "Agent Name: $AGENT_NAME"
echo

while :; do
  [ -n "$HEARTBEAT_INTERVAL" ] || ask HEARTBEAT_INTERVAL "Enter heartbeat interval in seconds (default: 30): " "30"
  if valid_positive_int "$HEARTBEAT_INTERVAL"; then break; fi
  err "Please enter a valid positive number."
  HEARTBEAT_INTERVAL=""
  [ "$TTY_OK" -eq 1 ] || die "No terminal available to re-prompt. Pass --heartbeat explicitly."
done
success "Heartbeat Interval: $HEARTBEAT_INTERVAL seconds"
echo

while :; do
  [ -n "$POLICY_SYNC_INTERVAL" ] || ask POLICY_SYNC_INTERVAL "Enter policy sync interval in seconds (default: 60): " "60"
  if valid_positive_int "$POLICY_SYNC_INTERVAL"; then break; fi
  err "Please enter a valid positive number."
  POLICY_SYNC_INTERVAL=""
  [ "$TTY_OK" -eq 1 ] || die "No terminal available to re-prompt. Pass --policy-sync explicitly."
done
success "Policy Sync Interval: $POLICY_SYNC_INTERVAL seconds"
echo

printf '%s============================================================%s\n' "$C_YELLOW" "$C_RESET"
printf '%sConfiguration Summary:%s\n' "$C_YELLOW" "$C_RESET"
printf '  Server URL:          %s\n' "$SERVER_URL"
printf '  Agent Name:          %s\n' "$AGENT_NAME"
printf '  Heartbeat Interval:  %s seconds\n' "$HEARTBEAT_INTERVAL"
printf '  Policy Sync:         %s seconds\n' "$POLICY_SYNC_INTERVAL"
printf '%s============================================================%s\n' "$C_YELLOW" "$C_RESET"
echo

if [ "$TTY_OK" -eq 1 ]; then
  ask CONFIRM "Proceed with installation? (Y/N) " "N"
  case "$CONFIRM" in
    [Yy]*) ;;
    *) warn "Installation cancelled by user."; exit 0 ;;
  esac
fi
echo

# ---------------------------------------------------------------------------
# Step 2: Remove any previous agent, preserving its identity
#
# Endpoints in the field may run the agent started by hand from a home
# directory, or an older unit name, or the earlier virtualenv-based install.
# Find and remove all of them so the new agent never coexists with or races
# the old one. Recover the agent_id FIRST, so a migrated endpoint keeps its
# dashboard identity instead of re-registering as a phantom.
# ---------------------------------------------------------------------------

info "Step 2: Removing previous agent installations..."

LEGACY_UNITS="cybersentinel-agent cybersentineldlp cybersentinel_agent dlp-agent"
LEGACY_DIRS="/opt/CyberSentinel /opt/cybersentinel/venv"
FOUND=0
RECOVERED_CONFIG=""
RECOVERED_ID=""

# 2a. Recover an existing identity BEFORE deleting anything. No python is
#     assumed here — the whole point of the frozen binary is that the endpoint
#     may not have an interpreter at all.
for cfg in "$CONFIG_FILE" \
           "/opt/cybersentinel/${CONFIG_NAME}" \
           "/opt/cybersentinel/agent/${CONFIG_NAME}" \
           "/etc/cybersentinel/agent_config.json" \
           "$HOME/${CONFIG_NAME}" \
           /home/*/"${CONFIG_NAME}" \
           /home/*/linuxagent2/"${CONFIG_NAME}"; do
  [ -f "$cfg" ] || continue
  id="$(grep -o '"agent_id"[[:space:]]*:[[:space:]]*"[^"]*"' "$cfg" 2>/dev/null \
        | head -1 | sed 's/.*"\([^"]*\)"[[:space:]]*$/\1/')"
  if [ -n "$id" ]; then
    RECOVERED_CONFIG="$cfg"
    RECOVERED_ID="$id"
    info "Found existing agent identity: $id  (from $cfg)"
    break
  fi
done

# 2b. Stop every agent process, old and new.
#
# Deliberately not `pkill -f`: this installer's own command line can contain
# the binary's name (via --binary-url, or the curl one-liner itself), and
# pkill would happily match and kill the shell running this script. Collect
# PIDs and drop our own process and our parent before signalling anything.
AGENT_PIDS=""
for pat in "$BIN_NAME" "linux_agent.py" "cybersentinel_agent"; do
  pids="$(pgrep -f "$pat" 2>/dev/null | grep -vx "$$" | grep -vx "${PPID:-0}" || true)"
  if [ -n "$pids" ]; then
    info "Stopping running agent matching: $pat"
    AGENT_PIDS="$AGENT_PIDS $pids"
    FOUND=1
  fi
done
if [ -n "${AGENT_PIDS// /}" ]; then
  # shellcheck disable=SC2086
  kill -TERM $AGENT_PIDS 2>/dev/null || true
  sleep 2
  # shellcheck disable=SC2086
  kill -KILL $AGENT_PIDS 2>/dev/null || true
fi

# 2c. Remove legacy systemd units. The current unit is left alone here — it is
#     rewritten in Step 7 — but any differently-named one must go, or two
#     agents will both monitor and both report.
for u in $LEGACY_UNITS; do
  if systemctl list-unit-files "${u}.service" >/dev/null 2>&1 && \
     [ -f "/etc/systemd/system/${u}.service" ]; then
    info "Removing legacy unit: ${u}.service"
    systemctl stop "$u" 2>/dev/null || true
    systemctl disable "$u" 2>/dev/null || true
    rm -f "/etc/systemd/system/${u}.service"
    FOUND=1
  fi
done

# 2d. Remove @reboot cron entries left by hand-rolled installs.
if have crontab; then
  if crontab -l 2>/dev/null | grep -q 'linux_agent\.py\|cybersentinel'; then
    info "Removing cron entries referencing the agent"
    crontab -l 2>/dev/null | grep -v 'linux_agent\.py\|cybersentinel' | crontab - || true
    FOUND=1
  fi
fi

# 2e. Delete legacy directories. Exact paths only — the live install tree is
#     never matched by these.
for d in $LEGACY_DIRS; do
  if [ -d "$d" ]; then
    rm -rf "$d"
    info "Removed legacy directory: $d"
    FOUND=1
  fi
done
if [ -f "${INSTALL_DIR}/agent.py" ]; then
  rm -f "${INSTALL_DIR}/agent.py"
  info "Removed superseded ${INSTALL_DIR}/agent.py"
  FOUND=1
fi

systemctl daemon-reload 2>/dev/null || true

if [ -n "$RECOVERED_ID" ]; then
  success "Previous agent removed; identity $RECOVERED_ID will be carried over"
elif [ "$FOUND" -eq 1 ]; then
  success "Previous agent removed (no stored identity found)"
else
  success "No previous agent found — clean install"
fi
echo

# ---------------------------------------------------------------------------
# Step 3: Create directories
# ---------------------------------------------------------------------------

info "Step 3: Creating installation directories..."
install -d -m 0755 "$INSTALL_DIR"
install -d -m 0750 "$CONFIG_DIR"
install -d -m 0750 "$LOG_DIR"
install -d -m 0750 "$DATA_DIR/cache"
# Quarantined files are, by definition, the sensitive ones. Nobody but root.
install -d -m 0700 "$QUARANTINE_DIR"
# The executable unpacks itself here on every start. Not /tmp, which is mounted
# noexec on plenty of hardened hosts.
install -d -m 0700 "$RUN_DIR"
success "Directories created"
echo

# ---------------------------------------------------------------------------
# Step 4: Optional dependencies
# ---------------------------------------------------------------------------

info "Step 4: Checking dependencies..."

if [ "$WITH_OCR" -eq 1 ]; then
  info "  Installing tesseract (--with-ocr)..."
  if   have apt-get; then DEBIAN_FRONTEND=noninteractive apt-get update -qq && apt-get install -y -qq tesseract-ocr >/dev/null 2>&1 || true
  elif have dnf;     then dnf install -y -q tesseract >/dev/null 2>&1 || true
  elif have yum;     then yum install -y -q tesseract >/dev/null 2>&1 || true
  elif have zypper;  then zypper --non-interactive --quiet install tesseract-ocr >/dev/null 2>&1 || true
  else warn "  No supported package manager found; install tesseract manually."
  fi
  if have tesseract; then
    success "  Tesseract installed: $(tesseract --version 2>&1 | head -1)"
  else
    warn "  Tesseract install incomplete — OCR features will be unavailable."
  fi
else
  # Saying "no dependencies" is not a shortcut here: the agent is a frozen
  # binary carrying its own Python runtime, requests and watchdog.
  success "  None required — the agent ships as a self-contained executable"
  info "  (screenshot OCR is a Windows agent feature; use --with-ocr to install tesseract anyway)"
fi
echo

# ---------------------------------------------------------------------------
# Step 5: Download the agent, with a SHA-256 integrity check
# ---------------------------------------------------------------------------

info "Step 5: Downloading agent from GitHub..."

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
TMP_BIN="$TMP_DIR/$BIN_NAME"

info "Downloading binary: $BINARY_URL"
if ! fetch "$BINARY_URL" "$TMP_BIN"; then
  err "Error downloading agent from $BINARY_URL"
  warn "Check internet connectivity and that the executable is published in the repo."
  warn "Publish it with:  sudo ./install.sh --build-only"
  warn "then commit the result to agents/endpoint/linux/dist/${BIN_NAME}"
  die "Download failed."
fi
[ -s "$TMP_BIN" ] || die "Downloaded file is empty: $BINARY_URL"

# A misconfigured proxy or a repo path typo returns an HTML error page, and
# some setups serve it with a 200. Check what actually arrived rather than
# trusting that the transfer reported success.
case "$(head -c 4 "$TMP_BIN" | od -An -tx1 | tr -d ' \n')" in
  7f454c46) ;;   # \x7fELF
  *) die "Downloaded file is not a Linux ELF executable. Check $BINARY_URL — the path may be wrong, or the file is not published yet." ;;
esac
BIN_SIZE="$(du -h "$TMP_BIN" | cut -f1)"
success "Binary downloaded ($BIN_SIZE)"

# SECURITY: verify SHA-256 against the sidecar checked into the repo. This
# matters more here than in an ordinary installer — a curl-pipe-to-root install
# has no other check on what it just executed. If the sidecar is not yet
# published, warn clearly and continue so a first rollout is not blocked.
EXPECTED_HASH=""
info "Fetching integrity manifest: $SUM_URL"
if SUM_CONTENT="$(fetch_stdout "$SUM_URL" 2>/dev/null)" && [ -n "$SUM_CONTENT" ]; then
  EXPECTED_HASH="$(printf '%s' "$SUM_CONTENT" | head -1 | awk '{print $1}' | tr 'A-Z' 'a-z')"
fi

if [ -n "$EXPECTED_HASH" ]; then
  if have sha256sum; then
    ACTUAL_HASH="$(sha256sum "$TMP_BIN" | awk '{print $1}' | tr 'A-Z' 'a-z')"
  elif have shasum; then
    ACTUAL_HASH="$(shasum -a 256 "$TMP_BIN" | awk '{print $1}' | tr 'A-Z' 'a-z')"
  else
    ACTUAL_HASH=""
    warn "Neither sha256sum nor shasum available — cannot verify integrity."
  fi
  if [ -n "$ACTUAL_HASH" ]; then
    if [ "$ACTUAL_HASH" != "$EXPECTED_HASH" ]; then
      err "CRITICAL: SHA-256 mismatch — refusing to install a tampered binary."
      err "  expected: $EXPECTED_HASH"
      err "  actual  : $ACTUAL_HASH"
      rm -f "$TMP_BIN"
      exit 2
    fi
    success "SHA-256 verified: $ACTUAL_HASH"
  fi
else
  warn "WARNING: no SHA-256 sidecar at $SUM_URL — skipping integrity check."
  warn "  Publish one with: sha256sum ${BIN_NAME} > ${BIN_NAME}.sha256"
fi

# Optional GPG signature check — the Linux counterpart of Authenticode. Warn
# only, so unsigned dev builds still install; make this fatal once a signing
# key is provisioned and its public key is on the endpoints.
if have gpg; then
  if SIG_CONTENT="$(fetch_stdout "$SIG_URL" 2>/dev/null)" && [ -n "$SIG_CONTENT" ]; then
    printf '%s' "$SIG_CONTENT" > "$TMP_DIR/sig.asc"
    if gpg --verify "$TMP_DIR/sig.asc" "$TMP_BIN" >/dev/null 2>&1; then
      success "GPG signature OK"
    else
      warn "WARNING: GPG signature present but did NOT verify (missing public key, or bad signature)."
    fi
  else
    warn "No GPG signature published at $SIG_URL — binary is unsigned."
  fi
fi
echo

# ---------------------------------------------------------------------------
# Step 6: Install and verify the executable
# ---------------------------------------------------------------------------

info "Step 6: Installing the executable..."

chmod 0750 "$TMP_BIN"
# Verify before install, not after: a downloaded file that runs is a different
# claim from a downloaded file that exists.
if ! SELFTEST_OUT="$(timeout 120 "$TMP_BIN" --selftest 2>&1)"; then
  err "The downloaded executable failed its self-test:"
  printf '%s\n' "$SELFTEST_OUT" >&2
  die "Refusing to install a binary that cannot load its own modules."
fi
printf '%s\n' "$SELFTEST_OUT" | sed 's/^/  /'

# Replace via a temporary name in the same directory: writing over a running
# binary fails with ETXTBSY, and a half-written executable is worse than an old
# one.
install -m 0750 "$TMP_BIN" "${BIN_PATH}.new"
mv -f "${BIN_PATH}.new" "$BIN_PATH"
success "Installed: $BIN_PATH"
echo

# ---------------------------------------------------------------------------
# Step 7: Configuration
# ---------------------------------------------------------------------------

info "Step 7: Creating configuration file..."

# Carry over a recovered identity by seeding the config the binary is about to
# read. agent_id and agent_key are issued per endpoint by the manager at
# registration; without this a re-install would register as a brand-new agent
# and orphan this endpoint's history. Seeding rather than hand-writing JSON
# keeps the schema owned by one place — the binary itself.
if [ -n "$RECOVERED_CONFIG" ] && [ "$RECOVERED_CONFIG" != "$CONFIG_FILE" ] && [ ! -f "$CONFIG_FILE" ]; then
  install -m 0600 "$RECOVERED_CONFIG" "$CONFIG_FILE"
  info "Seeded config from $RECOVERED_CONFIG to preserve identity $RECOVERED_ID"
fi

CONF_OUT="$(CS_SERVER_URL="$SERVER_URL" \
            CS_AGENT_NAME="$AGENT_NAME" \
            CS_HEARTBEAT_INTERVAL="$HEARTBEAT_INTERVAL" \
            CS_POLICY_SYNC_INTERVAL="$POLICY_SYNC_INTERVAL" \
            CS_QUARANTINE_DIR="$QUARANTINE_DIR" \
            CS_CONFIG_FILE="$CONFIG_FILE" \
            "$BIN_PATH" --install-config 2>&1)" || {
  printf '%s\n' "$CONF_OUT" >&2
  die "Failed to write configuration. If the published binary predates --install-config, rebuild and republish it."
}
printf '%s\n' "$CONF_OUT" | grep -v '^CS_EFFECTIVE_SERVER_URL=' | sed 's/^/  /'
success "Configuration created: $CONFIG_FILE"
echo

# ---------------------------------------------------------------------------
# Step 8: systemd unit
# ---------------------------------------------------------------------------

info "Step 8: Installing systemd service..."

# Recursive monitoring consumes one inotify watch per directory. The stock
# 65536 is reachable on a workstation or file server, and exhaustion is silent:
# file events simply stop being delivered.
cat > /etc/sysctl.d/99-cybersentinel-inotify.conf <<'SYSCTL'
# Raised for the CyberSentinel DLP agent: recursive monitoring consumes one
# inotify watch per directory, and exhaustion silently drops file events.
fs.inotify.max_user_watches = 524288
fs.inotify.max_user_instances = 1024
SYSCTL
sysctl --quiet --load=/etc/sysctl.d/99-cybersentinel-inotify.conf 2>/dev/null \
  || warn "Could not apply inotify sysctls now; they will apply after reboot."

# Fetch the unit template rather than generating one inline, so there is a
# single source of truth for the service definition. An inline copy here would
# drift from the one in the repo, and the drift would be invisible until the
# day the two disagree about something that matters.
UNIT_TMPL="$TMP_DIR/unit.service"
if ! fetch "$UNIT_URL" "$UNIT_TMPL"; then
  die "Could not fetch the systemd unit template from $UNIT_URL"
fi
grep -q '^\[Service\]' "$UNIT_TMPL" || die "Fetched unit template does not look like a systemd unit: $UNIT_URL"

sed -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" \
    -e "s|__BIN_PATH__|$BIN_PATH|g" \
    -e "s|__RUN_DIR__|$RUN_DIR|g" \
    -e "s|__CONFIG_FILE__|$CONFIG_FILE|g" \
    -e "s|__LOG_DIR__|$LOG_DIR|g" \
    "$UNIT_TMPL" > "$UNIT_PATH"
chmod 0644 "$UNIT_PATH"

if grep -q '__[A-Z_]*__' "$UNIT_PATH"; then
  die "Unit file still contains unsubstituted placeholders — the template at $UNIT_URL expects variables this installer does not set."
fi

# systemd does not reject a directive it does not recognise; it logs
# "Unknown key" and carries on, so a misplaced setting looks installed while
# doing nothing at all.
if have systemd-analyze; then
  VERIFY_OUT="$(systemd-analyze verify "$UNIT_PATH" 2>&1 || true)"
  if printf '%s' "$VERIFY_OUT" | grep -q 'Unknown key'; then
    printf '\n%s\n' "$VERIFY_OUT" >&2
    die "The unit contains directives this systemd silently ignores (see 'Unknown key' above)."
  fi
fi

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null 2>&1
success "Scheduled at boot: ${SERVICE_NAME}.service"
echo

# ---------------------------------------------------------------------------
# Step 9: Start and verify
# ---------------------------------------------------------------------------

info "Step 9: Starting the agent..."

systemctl restart "$SERVICE_NAME"

# Reporting success the instant systemctl returns is how broken installs get
# signed off. Give the agent time to unpack, import, read config, register, and
# either settle or die — then check what actually happened.
for _ in $(seq 1 15); do
  sleep 1
  systemctl is-active --quiet "$SERVICE_NAME" || break
done

if systemctl is-active --quiet "$SERVICE_NAME"; then
  AGENT_PID="$(systemctl show -p MainPID --value "$SERVICE_NAME")"
  success "Agent is running! (PID: $AGENT_PID)"
else
  err "Service failed to stay running. Last 30 log lines:"
  journalctl -u "$SERVICE_NAME" -n 30 --no-pager >&2 || true
  die "Installation completed but the agent is not running."
fi
echo

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

printf '%s============================================================%s\n' "$C_GREEN" "$C_RESET"
printf '%s           Installation Completed Successfully!             %s\n' "$C_GREEN$C_BOLD" "$C_RESET"
printf '%s============================================================%s\n' "$C_GREEN" "$C_RESET"
echo
printf '%sInstallation Details:%s\n' "$C_YELLOW" "$C_RESET"
printf '  Location:        %s\n' "$INSTALL_DIR"
printf '  Executable:      %s (%s, self-contained)\n' "$BIN_NAME" "$BIN_SIZE"
printf '  Configuration:   %s\n' "$CONFIG_FILE"
printf '  Logs:            %s/agent.log  +  journalctl\n' "$LOG_DIR"
printf '  Quarantine:      %s\n' "$QUARANTINE_DIR"
printf '  Service:         %s (enabled at boot)\n' "$SERVICE_NAME"
printf '  Runs As:         root (required for quarantine and process control)\n'
printf '  Server:          %s\n' "$SERVER_URL"
echo
printf '%sManagement Commands:%s\n' "$C_YELLOW" "$C_RESET"
printf '  Start Agent:     systemctl start %s\n'    "$SERVICE_NAME"
printf '  Stop Agent:      systemctl stop %s\n'     "$SERVICE_NAME"
printf '  Check Status:    systemctl status %s\n'   "$SERVICE_NAME"
printf '  View Logs:       journalctl -u %s -f\n'   "$SERVICE_NAME"
printf '  Disable Auto:    systemctl disable %s\n'  "$SERVICE_NAME"
printf '  Enable Auto:     systemctl enable %s\n'   "$SERVICE_NAME"
printf '  Verify Binary:   %s --selftest\n'         "$BIN_PATH"
printf '  Show Policies:   %s --config %s --dump-policies\n' "$BIN_PATH" "$CONFIG_FILE"
echo

if [ -n "$RECOVERED_ID" ]; then
  printf '%sMigrated from a previous agent — identity %s%s\n' "$C_YELLOW" "$RECOVERED_ID" "$C_RESET"
  printf '%s  carried over; the old install was removed in Step 2.%s\n' "$C_YELLOW" "$C_RESET"
  echo
fi

printf '%sUninstall (removes the agent completely):%s\n' "$C_YELLOW" "$C_RESET"
printf '  curl -fsSL %s/uninstall.sh | sudo bash\n' "$REMOTE_DIR"
echo
printf '%s============================================================%s\n' "$C_GREEN" "$C_RESET"
echo

}

main "$@"
