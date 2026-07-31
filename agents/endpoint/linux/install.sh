#!/usr/bin/env bash
#
# CyberSentinel DLP - Linux Endpoint Agent installer.
#
# Installs the agent as a systemd service that survives reboots and crashes.
# Safe to re-run: a second run upgrades the code and dependencies in place and
# preserves the endpoint's registered identity.
#
#   sudo ./install.sh --server-url http://dlp.example.com:55000/api/v1
#
# Supports Debian/Ubuntu (apt), RHEL/Rocky/Alma/Fedora (dnf/yum), and
# openSUSE (zypper).

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

SERVER_URL=""
AGENT_NAME=""
LOG_LEVEL="INFO"
INSTALL_DIR="/opt/cybersentinel/agent"
VENV_DIR="/opt/cybersentinel/venv"
CONFIG_DIR="/etc/cybersentinel"
LOG_DIR="/var/log/cybersentinel"
QUARANTINE_DIR="/opt/cybersentinel/quarantine"
SERVICE_NAME="cybersentineldlp-agent"
NO_START=0
SKIP_DEPS=0

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE=""   # derived from CONFIG_DIR after arg parsing

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'
else
  C_RESET=""; C_BOLD=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""
fi

STEP=0
TOTAL=8
step() { STEP=$((STEP + 1)); printf '%s[%d/%d]%s %s\n' "$C_BLUE$C_BOLD" "$STEP" "$TOTAL" "$C_RESET" "$1"; }
info() { printf '      %s\n' "$1"; }
ok()   { printf '      %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$1"; }
warn() { printf '      %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$1" >&2; }
die()  { printf '\n%sERROR:%s %s\n' "$C_RED$C_BOLD" "$C_RESET" "$1" >&2; exit 1; }

usage() {
  cat <<EOF
CyberSentinel DLP - Linux Agent installer

Usage: sudo ./install.sh --server-url URL [options]

Required on first install:
  --server-url URL      Manager API base URL, including /api/v1
                        e.g. http://192.168.1.10:55000/api/v1

Options:
  --agent-name NAME     Name registered with the manager (default: hostname)
  --log-level LEVEL     DEBUG|INFO|WARNING|ERROR (default: INFO)
  --install-dir PATH    Agent code directory (default: $INSTALL_DIR)
  --config-dir PATH     Config directory (default: $CONFIG_DIR)
  --service-name NAME   systemd unit name (default: $SERVICE_NAME)
  --no-start            Install and enable, but do not start now
  --skip-deps           Skip OS package installation (offline/managed images)
  -h, --help            Show this help

Re-running is safe: code and dependencies are upgraded in place while the
endpoint's agent_id and agent_key are preserved. Omit --server-url on a
re-run to keep the existing manager URL.
EOF
}

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------

while [ $# -gt 0 ]; do
  case "$1" in
    --server-url)   SERVER_URL="${2:-}";   shift 2 ;;
    --agent-name)   AGENT_NAME="${2:-}";   shift 2 ;;
    --log-level)    LOG_LEVEL="${2:-}";    shift 2 ;;
    --install-dir)  INSTALL_DIR="${2:-}";  shift 2 ;;
    --config-dir)   CONFIG_DIR="${2:-}";   shift 2 ;;
    --service-name) SERVICE_NAME="${2:-}"; shift 2 ;;
    --no-start)     NO_START=1;            shift ;;
    --skip-deps)    SKIP_DEPS=1;           shift ;;
    -h|--help)      usage; exit 0 ;;
    *)              usage >&2; die "Unknown option: $1" ;;
  esac
done

CONFIG_FILE="$CONFIG_DIR/agent_configure.json"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"

printf '%s\n' "============================================================"
printf '%sCyberSentinel DLP - Linux Agent installer%s\n' "$C_BOLD" "$C_RESET"
printf '%s\n\n' "============================================================"

# ---------------------------------------------------------------------------
# 1. Preflight
# ---------------------------------------------------------------------------

step "Checking prerequisites"

[ "$(id -u)" -eq 0 ] || die "Must run as root. Try: sudo $0 $*"

# systemd is the whole delivery mechanism here; fail loudly rather than install
# files that nothing will ever start.
[ -d /run/systemd/system ] || die "systemd is not the active init system. This installer targets systemd hosts."
command -v systemctl >/dev/null 2>&1 || die "systemctl not found."

for f in agent.py requirements.txt cybersentineldlp-agent.service; do
  [ -f "$SRC_DIR/$f" ] || die "Missing $f next to this script (looked in $SRC_DIR)."
done

IS_UPGRADE=0
[ -f "$CONFIG_FILE" ] && IS_UPGRADE=1

if [ "$IS_UPGRADE" -eq 0 ] && [ -z "$SERVER_URL" ]; then
  usage >&2
  die "--server-url is required for a first install."
fi

# A bare host:port is the most common mistake and produces a confusing 404 at
# registration time rather than an install-time error.
if [ -n "$SERVER_URL" ]; then
  case "$SERVER_URL" in
    http://*|https://*) ;;
    *) die "--server-url must start with http:// or https:// (got: $SERVER_URL)" ;;
  esac
  case "$SERVER_URL" in
    */api/v1|*/api/v1/) ;;
    *) warn "--server-url does not end in /api/v1 — registration will likely 404." ;;
  esac
fi

if [ "$IS_UPGRADE" -eq 1 ]; then
  ok "Existing install detected — upgrading in place, identity preserved"
else
  ok "Fresh install"
fi

# ---------------------------------------------------------------------------
# 2. OS packages
# ---------------------------------------------------------------------------

step "Installing OS packages"

if [ "$SKIP_DEPS" -eq 1 ]; then
  info "Skipped (--skip-deps)"
elif command -v apt-get >/dev/null 2>&1; then
  info "Detected apt (Debian/Ubuntu)"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  # python3-venv is a separate package on Debian/Ubuntu and its absence is the
  # single most common cause of "python3 -m venv" failing mid-install.
  apt-get install -y -qq python3 python3-venv python3-dev ca-certificates >/dev/null
  ok "python3, python3-venv installed"
elif command -v dnf >/dev/null 2>&1; then
  info "Detected dnf (RHEL/Rocky/Alma/Fedora)"
  dnf install -y -q python3 python3-devel ca-certificates >/dev/null
  ok "python3 installed"
elif command -v yum >/dev/null 2>&1; then
  info "Detected yum (RHEL/CentOS 7)"
  yum install -y -q python3 python3-devel ca-certificates >/dev/null
  ok "python3 installed"
elif command -v zypper >/dev/null 2>&1; then
  info "Detected zypper (openSUSE/SLES)"
  zypper --non-interactive --quiet install python3 python3-devel ca-certificates >/dev/null
  ok "python3 installed"
else
  warn "No supported package manager found (apt/dnf/yum/zypper)."
  warn "Continuing — python3 with the venv module must already be present."
fi

command -v python3 >/dev/null 2>&1 || die "python3 not found after package installation."

PY_VER="$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' \
  || die "Python 3.8+ required, found $PY_VER."
ok "Python $PY_VER"

# ---------------------------------------------------------------------------
# 3. Directories
# ---------------------------------------------------------------------------

step "Creating directories"

install -d -m 0755 "$INSTALL_DIR"
install -d -m 0750 "$CONFIG_DIR"
install -d -m 0750 "$LOG_DIR"
# Quarantined files are, by definition, the sensitive ones. Nobody but root.
install -d -m 0700 "$QUARANTINE_DIR"
ok "$INSTALL_DIR, $CONFIG_DIR, $LOG_DIR, $QUARANTINE_DIR"

# ---------------------------------------------------------------------------
# 4. Virtualenv
# ---------------------------------------------------------------------------

step "Building Python virtualenv"

# A venv rather than system pip is not a style choice: modern distros ship
# Python marked EXTERNALLY-MANAGED (PEP 668), where "pip install" either
# refuses outright or, with --break-system-packages, installs into a location
# the next apt upgrade can silently wipe. This install previously lost its
# watchdog module exactly that way.
if [ ! -x "$VENV_DIR/bin/python" ]; then
  python3 -m venv "$VENV_DIR" 2>/dev/null || die \
    "Failed to create virtualenv at $VENV_DIR. On Debian/Ubuntu install python3-venv, on RHEL install python3-devel."
  ok "Created $VENV_DIR"
else
  ok "Reusing $VENV_DIR"
fi

"$VENV_DIR/bin/python" -m pip install --quiet --upgrade pip setuptools wheel \
  || die "Could not upgrade pip inside the virtualenv (no network access to PyPI?)."

"$VENV_DIR/bin/python" -m pip install --quiet --upgrade -r "$SRC_DIR/requirements.txt" \
  || die "Dependency installation failed. Check network access to PyPI."

# Import them for real. pip reporting success is not the same as the module
# loading — wheels for the wrong architecture or a half-written venv both pass
# the install step and then fail at service start. Import the exact symbols
# agent.py imports rather than just the top-level packages.
"$VENV_DIR/bin/python" - <<'PYCHECK' || die "Dependencies installed but failed to import."
from importlib.metadata import version

import requests                                              # noqa: F401
from watchdog.observers import Observer                      # noqa: F401
from watchdog.events import FileSystemEventHandler           # noqa: F401

# watchdog dropped its module-level __version__ attribute, so ask the package
# metadata instead of the module.
print("      \033[32m✓\033[0m requests %s, watchdog %s" % (version("requests"), version("watchdog")))
PYCHECK

# ---------------------------------------------------------------------------
# 5. Agent code
# ---------------------------------------------------------------------------

step "Installing agent"

install -m 0750 "$SRC_DIR/agent.py" "$INSTALL_DIR/agent.py"
AGENT_VERSION="$(grep -m1 '^AGENT_VERSION' "$INSTALL_DIR/agent.py" | cut -d'"' -f2 || echo 'unknown')"
ok "agent.py v${AGENT_VERSION} -> $INSTALL_DIR"

# ---------------------------------------------------------------------------
# 6. Configuration
# ---------------------------------------------------------------------------

step "Writing configuration"

# Identity handling is the crux of multi-machine deployment. agent_id and
# agent_key are issued per endpoint by the manager on registration; copying a
# populated config between machines makes every endpoint collapse into a single
# agent record server-side. So: never ship identity, and never overwrite it.
SERVER_URL="$SERVER_URL" AGENT_NAME="$AGENT_NAME" LOG_LEVEL="$LOG_LEVEL" \
QUARANTINE_DIR="$QUARANTINE_DIR" CONFIG_FILE="$CONFIG_FILE" \
"$VENV_DIR/bin/python" <<'PYCONF' || die "Failed to write configuration."
import json, os, socket, sys

path       = os.environ["CONFIG_FILE"]
server_url = os.environ.get("SERVER_URL") or ""
agent_name = os.environ.get("AGENT_NAME") or ""
quarantine = os.environ["QUARANTINE_DIR"]

existing = {}
if os.path.exists(path):
    try:
        with open(path) as fh:
            existing = json.load(fh)
    except Exception as exc:
        print("      ! Existing config unreadable (%s); regenerating." % exc, file=sys.stderr)
        existing = {}

cfg = dict(existing)

if server_url:
    cfg["server_url"] = server_url
elif not cfg.get("server_url"):
    print("      ! No server_url available.", file=sys.stderr)
    sys.exit(1)

if agent_name:
    cfg["agent_name"] = agent_name
elif not cfg.get("agent_name"):
    cfg["agent_name"] = socket.gethostname()

# Leave agent_id/agent_key absent on a fresh install. The agent generates a
# UUID, registers, receives its key, and persists both itself. Anything we
# invent here would either collide across the fleet or be thrown away.
cfg.setdefault("heartbeat_interval", 30)
cfg.setdefault("policy_sync_interval", 60)

quar = dict(cfg.get("quarantine") or {})
quar.setdefault("enabled", True)
quar["folder"] = quar.get("folder") or quarantine
cfg["quarantine"] = quar

mon = dict(cfg.get("monitoring") or {})
mon.setdefault("file_system", True)
# Empty by design: monitored paths come from the manager's policy bundle. A
# non-empty fallback here would have every endpoint watching directories no
# policy asked for.
mon.setdefault("monitored_paths", [])
mon.setdefault("exclude_paths", [
    "/proc", "/sys", "/dev", "/run", "/snap",
    "/var/lib/docker", "/var/log",
    "~/.cache", "~/.local/share", "~/.config",
    "~/snap", "~/.mozilla", "~/.thunderbird",
    quarantine,
])
cfg["monitoring"] = mon

tmp = path + ".tmp"
with open(tmp, "w") as fh:
    json.dump(cfg, fh, indent=2)
os.chmod(tmp, 0o600)          # holds the agent API key
os.replace(tmp, path)         # atomic: never leave a half-written config

kept = [k for k in ("agent_id", "agent_key") if existing.get(k)]
print("      \033[32m✓\033[0m server_url = %s" % cfg["server_url"])
print("      \033[32m✓\033[0m agent_name = %s" % cfg["agent_name"])
if kept:
    print("      \033[32m✓\033[0m preserved existing identity (%s)" % ", ".join(kept))
else:
    print("      \033[32m✓\033[0m no identity yet — agent will register on first start")
PYCONF

# On an upgrade --server-url is optional, so read back whatever is actually in
# effect. Otherwise the summary and the rollout hint print a placeholder.
EFFECTIVE_URL="$("$VENV_DIR/bin/python" -c \
  "import json,sys; print(json.load(open(sys.argv[1])).get('server_url',''))" \
  "$CONFIG_FILE" 2>/dev/null || true)"
[ -n "$EFFECTIVE_URL" ] && SERVER_URL="$EFFECTIVE_URL"

# ---------------------------------------------------------------------------
# 7. Kernel limits + systemd unit
# ---------------------------------------------------------------------------

step "Installing systemd service"

# Recursive inotify watches are consumed one per directory. The stock 65536 is
# reachable on a developer workstation or file server, and the failure mode is
# silent: watchdog stops delivering events for paths it could not register.
cat > /etc/sysctl.d/99-cybersentinel-inotify.conf <<'SYSCTL'
# Raised for the CyberSentinel DLP agent: recursive monitoring consumes one
# inotify watch per directory, and exhaustion silently drops file events.
fs.inotify.max_user_watches = 524288
fs.inotify.max_user_instances = 1024
SYSCTL
sysctl --quiet --load=/etc/sysctl.d/99-cybersentinel-inotify.conf 2>/dev/null \
  || warn "Could not apply inotify sysctls now; they will apply after reboot."
ok "inotify limits raised"

sed -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" \
    -e "s|__VENV_DIR__|$VENV_DIR|g" \
    -e "s|__CONFIG_FILE__|$CONFIG_FILE|g" \
    -e "s|__LOG_DIR__|$LOG_DIR|g" \
    "$SRC_DIR/cybersentineldlp-agent.service" > "$UNIT_PATH"

# The unit ships with INFO; honour --log-level without a second template.
sed -i "s|^Environment=CYBERSENTINEL_LOG_LEVEL=.*|Environment=CYBERSENTINEL_LOG_LEVEL=$LOG_LEVEL|" "$UNIT_PATH"
chmod 0644 "$UNIT_PATH"

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null 2>&1
ok "$UNIT_PATH (enabled at boot)"

# ---------------------------------------------------------------------------
# 8. Start and verify
# ---------------------------------------------------------------------------

step "Starting service"

if [ "$NO_START" -eq 1 ]; then
  info "Skipped (--no-start). Start it with: systemctl start $SERVICE_NAME"
else
  systemctl restart "$SERVICE_NAME"

  # Reporting success the instant systemctl returns is how broken installs get
  # signed off. Give the agent a few seconds to import, read config, register,
  # and either settle or die, then check what actually happened.
  for _ in $(seq 1 10); do
    sleep 1
    systemctl is-active --quiet "$SERVICE_NAME" || break
  done

  if systemctl is-active --quiet "$SERVICE_NAME"; then
    ok "$SERVICE_NAME is active"
  else
    printf '\n%sService failed to stay running.%s Last 30 log lines:\n\n' "$C_RED$C_BOLD" "$C_RESET" >&2
    journalctl -u "$SERVICE_NAME" -n 30 --no-pager >&2 || true
    die "Installation completed but the agent is not running."
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

cat <<EOF

============================================================
${C_GREEN}${C_BOLD}Installation complete${C_RESET}
============================================================

  Agent        ${INSTALL_DIR}/agent.py (v${AGENT_VERSION})
  Virtualenv   ${VENV_DIR}
  Config       ${CONFIG_FILE}
  Logs         ${LOG_DIR}/agent.log  +  journalctl
  Quarantine   ${QUARANTINE_DIR}
  Service      ${SERVICE_NAME} (enabled at boot)

Common commands:
  systemctl status ${SERVICE_NAME}
  journalctl -u ${SERVICE_NAME} -f
  systemctl restart ${SERVICE_NAME}
  ${VENV_DIR}/bin/python ${INSTALL_DIR}/agent.py --config ${CONFIG_FILE} --dump-policies

To roll out to another machine, copy this directory across and run:
  sudo ./install.sh --server-url ${SERVER_URL:-<manager-url>}

EOF
