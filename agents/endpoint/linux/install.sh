#!/usr/bin/env bash
#
# CyberSentinel DLP - Linux Endpoint Agent installer.
#
# Freezes agent.py, policy_cache.py and print_monitor.py into ONE self-contained
# executable with PyInstaller, then installs it as a systemd service that
# survives reboots and crashes. The finished endpoint has no Python, no
# virtualenv and no source on disk — just the binary and its config.
#
#   sudo ./install.sh --server-url http://dlp.example.com:55000/api/v1
#
# Build once, ship everywhere (no toolchain on the endpoints):
#   sudo ./install.sh --build-only                     # on a build host
#   sudo ./install.sh --prebuilt-binary ./cybersentineldlp-agent --server-url ...
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
BUILD_DIR="/opt/cybersentinel/build"
RUN_DIR="/opt/cybersentinel/run"
CONFIG_DIR="/etc/cybersentinel"
LOG_DIR="/var/log/cybersentinel"
QUARANTINE_DIR="/opt/cybersentinel/quarantine"
SERVICE_NAME="cybersentineldlp-agent"
BIN_NAME="cybersentineldlp-agent"
LEGACY_VENV="/opt/cybersentinel/venv"
NO_START=0
SKIP_DEPS=0
KEEP_BUILD=0
BUILD_ONLY=0
PREBUILT_BINARY=""

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
TOTAL=9
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
  --install-dir PATH    Where the executable is installed (default: $INSTALL_DIR)
  --config-dir PATH     Config directory (default: $CONFIG_DIR)
  --service-name NAME   systemd unit name (default: $SERVICE_NAME)
  --prebuilt-binary P   Install an executable built elsewhere instead of
                        building here. The target then needs no Python and no
                        build toolchain at all.
  --build-only          Build the executable, print its path, and stop. Nothing
                        is installed, configured or started.
  --keep-build          Keep the build virtualenv so re-runs rebuild faster.
                        Without this the toolchain is deleted after the build.
  --no-start            Install and enable, but do not start now
  --skip-deps           Skip OS package installation (offline/managed images)
  -h, --help            Show this help

Re-running is safe: the executable is rebuilt and replaced while the endpoint's
agent_id and agent_key are preserved. Omit --server-url on a re-run to keep the
existing manager URL.
EOF
}

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------

while [ $# -gt 0 ]; do
  case "$1" in
    --server-url)      SERVER_URL="${2:-}";      shift 2 ;;
    --agent-name)      AGENT_NAME="${2:-}";      shift 2 ;;
    --log-level)       LOG_LEVEL="${2:-}";       shift 2 ;;
    --install-dir)     INSTALL_DIR="${2:-}";     shift 2 ;;
    --config-dir)      CONFIG_DIR="${2:-}";      shift 2 ;;
    --service-name)    SERVICE_NAME="${2:-}";    shift 2 ;;
    --prebuilt-binary) PREBUILT_BINARY="${2:-}"; shift 2 ;;
    --build-only)      BUILD_ONLY=1;             shift ;;
    --keep-build)      KEEP_BUILD=1;             shift ;;
    --no-start)        NO_START=1;               shift ;;
    --skip-deps)       SKIP_DEPS=1;              shift ;;
    -h|--help)         usage; exit 0 ;;
    *)                 usage >&2; die "Unknown option: $1" ;;
  esac
done

CONFIG_FILE="$CONFIG_DIR/agent_configure.json"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
BIN_PATH="$INSTALL_DIR/$BIN_NAME"

# Building and supplying a prebuilt binary are mutually exclusive intents;
# silently ignoring one of them is how the wrong binary ends up deployed.
if [ -n "$PREBUILT_BINARY" ] && [ "$BUILD_ONLY" -eq 1 ]; then
  die "--build-only and --prebuilt-binary are mutually exclusive."
fi

DO_BUILD=1
[ -n "$PREBUILT_BINARY" ] && DO_BUILD=0

printf '%s\n' "============================================================"
printf '%sCyberSentinel DLP - Linux Agent installer%s\n' "$C_BOLD" "$C_RESET"
printf '%s\n\n' "============================================================"

# ---------------------------------------------------------------------------
# 1. Preflight
# ---------------------------------------------------------------------------

step "Checking prerequisites"

[ "$(id -u)" -eq 0 ] || die "Must run as root. Try: sudo $0 $*"

if [ "$BUILD_ONLY" -eq 0 ]; then
  # systemd is the whole delivery mechanism here; fail loudly rather than
  # install files that nothing will ever start.
  [ -d /run/systemd/system ] || die "systemd is not the active init system. This installer targets systemd hosts."
  command -v systemctl >/dev/null 2>&1 || die "systemctl not found."
  [ -f "$SRC_DIR/cybersentineldlp-agent.service" ] || die "Missing cybersentineldlp-agent.service next to this script (looked in $SRC_DIR)."
fi

if [ "$DO_BUILD" -eq 1 ]; then
  # The three modules the user asked to be frozen together, plus the shim that
  # gives the finished binary its --selftest and --install-config modes.
  for f in agent.py policy_cache.py print_monitor.py agent_launcher.py \
           requirements.txt requirements-build.txt; do
    [ -f "$SRC_DIR/$f" ] || die "Missing $f next to this script (looked in $SRC_DIR)."
  done
else
  [ -f "$PREBUILT_BINARY" ] || die "--prebuilt-binary: no such file: $PREBUILT_BINARY"
  [ -x "$PREBUILT_BINARY" ] || chmod +x "$PREBUILT_BINARY"
  case "$(head -c 4 "$PREBUILT_BINARY" | od -An -tx1 | tr -d ' \n')" in
    7f454c46) ;;   # \x7fELF
    *) die "--prebuilt-binary is not a Linux ELF executable: $PREBUILT_BINARY" ;;
  esac
fi

IS_UPGRADE=0
[ -f "$CONFIG_FILE" ] && IS_UPGRADE=1

if [ "$BUILD_ONLY" -eq 0 ] && [ "$IS_UPGRADE" -eq 0 ] && [ -z "$SERVER_URL" ]; then
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

if [ "$BUILD_ONLY" -eq 1 ]; then
  ok "Build-only run — nothing will be installed"
elif [ "$IS_UPGRADE" -eq 1 ]; then
  ok "Existing install detected — upgrading in place, identity preserved"
else
  ok "Fresh install"
fi

# ---------------------------------------------------------------------------
# 2. OS packages
# ---------------------------------------------------------------------------

step "Installing OS packages"

if [ "$DO_BUILD" -eq 0 ]; then
  # Nothing to install: a frozen binary carries its own interpreter and every
  # library it needs. This is the whole point of shipping one.
  ok "Skipped — prebuilt binary needs no runtime packages"
elif [ "$SKIP_DEPS" -eq 1 ]; then
  info "Skipped (--skip-deps)"
elif command -v apt-get >/dev/null 2>&1; then
  info "Detected apt (Debian/Ubuntu)"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  # python3-venv is a separate package on Debian/Ubuntu and its absence is the
  # single most common cause of "python3 -m venv" failing mid-install.
  # binutils supplies objdump/objcopy, which PyInstaller uses to inspect and
  # assemble the executable; python3-dev supplies libpython, which it embeds.
  apt-get install -y -qq python3 python3-venv python3-dev binutils ca-certificates >/dev/null
  ok "python3, python3-venv, python3-dev, binutils installed"
elif command -v dnf >/dev/null 2>&1; then
  info "Detected dnf (RHEL/Rocky/Alma/Fedora)"
  dnf install -y -q python3 python3-devel binutils ca-certificates >/dev/null
  ok "python3, python3-devel, binutils installed"
elif command -v yum >/dev/null 2>&1; then
  info "Detected yum (RHEL/CentOS 7)"
  yum install -y -q python3 python3-devel binutils ca-certificates >/dev/null
  ok "python3, python3-devel, binutils installed"
elif command -v zypper >/dev/null 2>&1; then
  info "Detected zypper (openSUSE/SLES)"
  zypper --non-interactive --quiet install python3 python3-devel binutils ca-certificates >/dev/null
  ok "python3, python3-devel, binutils installed"
else
  warn "No supported package manager found (apt/dnf/yum/zypper)."
  warn "Continuing — python3 with the venv module must already be present."
fi

if [ "$DO_BUILD" -eq 1 ]; then
  command -v python3 >/dev/null 2>&1 || die "python3 not found after package installation."
  PY_VER="$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
  python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' \
    || die "Python 3.8+ required to build, found $PY_VER."
  ok "Python $PY_VER (build-time only — not needed once the binary exists)"
fi

# ---------------------------------------------------------------------------
# 3. Directories
# ---------------------------------------------------------------------------

step "Creating directories"

# A onefile executable unpacks itself somewhere on every start. Left to default
# it uses /tmp, which is mounted noexec on plenty of hardened and CIS-benchmarked
# hosts — the binary then dies at exec time with a message that points nowhere
# near the real cause. Give it a directory we control. This path is baked into
# the executable at build time, so it has to exist even on a --build-only run:
# the freshly built binary is executed here to verify it.
install -d -m 0700 "$RUN_DIR"
install -d -m 0700 "$BUILD_DIR"

if [ "$BUILD_ONLY" -eq 1 ]; then
  ok "$BUILD_DIR, $RUN_DIR"
else
  install -d -m 0755 "$INSTALL_DIR"
  install -d -m 0750 "$CONFIG_DIR"
  install -d -m 0750 "$LOG_DIR"
  # Quarantined files are, by definition, the sensitive ones. Nobody but root.
  install -d -m 0700 "$QUARANTINE_DIR"
  ok "$INSTALL_DIR, $CONFIG_DIR, $LOG_DIR, $QUARANTINE_DIR, $RUN_DIR"
fi

# ---------------------------------------------------------------------------
# 4. Build toolchain
# ---------------------------------------------------------------------------

if [ "$DO_BUILD" -eq 1 ]; then
  step "Preparing build toolchain"

  BUILD_VENV="$BUILD_DIR/venv"

  # The venv is a build artifact now, not a runtime dependency, but it is still
  # a venv rather than system pip: modern distros ship Python marked
  # EXTERNALLY-MANAGED (PEP 668), where "pip install" either refuses outright
  # or, with --break-system-packages, writes to a location the next apt upgrade
  # can silently wipe. This install previously lost watchdog exactly that way.
  if [ ! -x "$BUILD_VENV/bin/python" ]; then
    python3 -m venv "$BUILD_VENV" 2>/dev/null || die \
      "Failed to create build virtualenv at $BUILD_VENV. On Debian/Ubuntu install python3-venv, on RHEL install python3-devel."
    ok "Created $BUILD_VENV"
  else
    ok "Reusing $BUILD_VENV"
  fi

  "$BUILD_VENV/bin/python" -m pip install --quiet --upgrade pip setuptools wheel \
    || die "Could not upgrade pip inside the build virtualenv (no network access to PyPI?)."

  "$BUILD_VENV/bin/python" -m pip install --quiet --upgrade \
      -r "$SRC_DIR/requirements.txt" -r "$SRC_DIR/requirements-build.txt" \
    || die "Dependency installation failed. Check network access to PyPI."

  # Import them for real. pip reporting success is not the same as the module
  # loading — wheels for the wrong architecture or a half-written venv both
  # pass the install step and then fail later.
  "$BUILD_VENV/bin/python" - <<'PYCHECK' || die "Dependencies installed but failed to import."
from importlib.metadata import version

import requests                                              # noqa: F401
from watchdog.observers import Observer                      # noqa: F401
from watchdog.events import FileSystemEventHandler           # noqa: F401
import PyInstaller                                           # noqa: F401

# watchdog dropped its module-level __version__ attribute, so ask the package
# metadata instead of the module. Plain text, no colour codes: this output is
# routinely captured to a log or piped through the rollout script, where raw
# escape sequences are just noise.
print("      requests %s, watchdog %s, pyinstaller %s"
      % (version("requests"), version("watchdog"), version("pyinstaller")))
PYCHECK

  # PyInstaller embeds libpython into the executable. Distros that ship a
  # static-only Python fail here with a message about a missing Python library;
  # catch it now, while we can still name the package that fixes it.
  "$BUILD_VENV/bin/python" - <<'PYLIB' || die "Python was built without a shared libpython, which PyInstaller needs. Install python3-dev (Debian/Ubuntu) or python3-devel / python3-libs (RHEL/SUSE)."
import sysconfig, os, sys
name = sysconfig.get_config_var("INSTSONAME") or ""
for key in ("LIBDIR", "LIBPL", "srcdir"):
    d = sysconfig.get_config_var(key)
    if d and name and os.path.exists(os.path.join(d, name)):
        sys.exit(0)
sys.exit(0 if sysconfig.get_config_var("Py_ENABLE_SHARED") else 1)
PYLIB
  ok "Shared libpython present"
else
  step "Using prebuilt binary"
  info "$PREBUILT_BINARY"
  # A PyInstaller executable is only as portable as the glibc it was linked
  # against: one built on a newer distro will not start on an older one.
  info "Built elsewhere — verified below by running it here."
fi

# ---------------------------------------------------------------------------
# 5. Freeze into a single executable
# ---------------------------------------------------------------------------

if [ "$DO_BUILD" -eq 1 ]; then
  step "Building single-file executable"

  STAGE_DIR="$BUILD_DIR/src"
  rm -rf "$STAGE_DIR"
  install -d -m 0700 "$STAGE_DIR"
  install -m 0600 "$SRC_DIR/agent.py"          "$STAGE_DIR/agent.py"
  install -m 0600 "$SRC_DIR/policy_cache.py"   "$STAGE_DIR/policy_cache.py"
  install -m 0600 "$SRC_DIR/print_monitor.py"  "$STAGE_DIR/print_monitor.py"
  install -m 0600 "$SRC_DIR/agent_launcher.py" "$STAGE_DIR/agent_launcher.py"

  AGENT_VERSION="$(grep -m1 '^AGENT_VERSION' "$STAGE_DIR/agent.py" | cut -d'"' -f2 || true)"
  [ -n "$AGENT_VERSION" ] || AGENT_VERSION="unknown"
  info "Freezing agent.py v${AGENT_VERSION} + policy_cache.py + print_monitor.py"
  info "This takes a minute or two."

  # --hidden-import is doing real work for the first three: the current agent
  # imports neither policy_cache nor print_monitor, so PyInstaller's static
  # analysis would leave them out of the bundle entirely. They are named
  # explicitly so the executable carries all three modules as asked, and
  # --selftest below proves they arrived.
  #
  # watchdog picks its observer backend at runtime by platform, which static
  # analysis also cannot see; naming the inotify backend keeps file monitoring
  # working in the frozen build instead of silently degrading to polling.
  BUILD_LOG="$BUILD_DIR/pyinstaller.log"
  if ! ( cd "$STAGE_DIR" && "$BUILD_VENV/bin/pyinstaller" \
        --onefile \
        --name "$BIN_NAME" \
        --distpath "$BUILD_DIR/dist" \
        --workpath "$BUILD_DIR/work" \
        --specpath "$BUILD_DIR/spec" \
        --paths "$STAGE_DIR" \
        --hidden-import agent \
        --hidden-import policy_cache \
        --hidden-import print_monitor \
        --hidden-import watchdog.observers.inotify \
        --hidden-import watchdog.observers.inotify_buffer \
        --hidden-import watchdog.observers.polling \
        --exclude-module tkinter \
        --runtime-tmpdir "$RUN_DIR" \
        --noupx --clean --noconfirm --log-level WARN \
        agent_launcher.py ) >"$BUILD_LOG" 2>&1; then
    printf '\n%sPyInstaller failed.%s Last 40 lines of %s:\n\n' "$C_RED$C_BOLD" "$C_RESET" "$BUILD_LOG" >&2
    tail -40 "$BUILD_LOG" >&2 || true
    die "Could not build the executable."
  fi

  BUILT="$BUILD_DIR/dist/$BIN_NAME"
  [ -f "$BUILT" ] || die "PyInstaller reported success but $BUILT does not exist."
  chmod 0750 "$BUILT"
  ok "Built $BUILT ($(du -h "$BUILT" | cut -f1))"
else
  step "Staging prebuilt binary"
  BUILT="$BUILD_DIR/dist/$BIN_NAME"
  install -d -m 0700 "$BUILD_DIR/dist"
  install -m 0750 "$PREBUILT_BINARY" "$BUILT"
  AGENT_VERSION="prebuilt"
  ok "Staged $BUILT ($(du -h "$BUILT" | cut -f1))"
fi

# Verify the executable before it is anywhere near a service unit. --selftest
# proves all three modules plus requests and watchdog are really inside it;
# --help proves the agent's own entry point runs end to end. A build that
# produces a file is not the same as a build that produces a working program.
info "Verifying the executable"
if ! SELFTEST_OUT="$(timeout 120 "$BUILT" --selftest 2>&1)"; then
  printf '\n%sThe executable failed its self-test.%s Output:\n\n' "$C_RED$C_BOLD" "$C_RESET" >&2
  printf '%s\n' "$SELFTEST_OUT" >&2
  die "Refusing to install a binary that cannot load its own modules."
fi
printf '%s\n' "$SELFTEST_OUT" | sed 's/^/      /'

if ! HELP_OUT="$(timeout 120 "$BUILT" --help 2>&1)"; then
  printf '\n%sThe executable could not run the agent entry point.%s Output:\n\n' "$C_RED$C_BOLD" "$C_RESET" >&2
  printf '%s\n' "$HELP_OUT" >&2
  die "Refusing to install a binary whose main entry point fails."
fi
ok "Executable verified (selftest + agent entry point)"

if [ "$BUILD_ONLY" -eq 1 ]; then
  cat <<EOF

============================================================
${C_GREEN}${C_BOLD}Build complete${C_RESET}
============================================================

  Executable   ${BUILT}
  Size         $(du -h "$BUILT" | cut -f1)
  Contains     agent.py (v${AGENT_VERSION}), policy_cache.py, print_monitor.py,
               the Python runtime, requests and watchdog

Copy it to another machine and install without any toolchain there:

  scp ${BUILT} host:/tmp/
  sudo ./install.sh --prebuilt-binary /tmp/${BIN_NAME} \\
       --server-url ${SERVER_URL:-<manager-url>}

Note: a PyInstaller binary is linked against this host's glibc, so build on the
oldest distro you intend to deploy to.

EOF
  exit 0
fi

step "Installing executable"

# Replace via a temporary name in the same directory: install(1) over a running
# binary would fail with ETXTBSY on some kernels, and a partially written
# executable is worse than an old one.
install -m 0750 "$BUILT" "$BIN_PATH.new"
mv -f "$BIN_PATH.new" "$BIN_PATH"
ok "$BIN_PATH"

# ---------------------------------------------------------------------------
# 6. Configuration
# ---------------------------------------------------------------------------

step "Writing configuration"

# The binary writes its own config. That is deliberate: it keeps the target
# free of any Python dependency, so a --prebuilt-binary install works on a
# machine with no interpreter at all.
CONF_OUT="$(CS_SERVER_URL="$SERVER_URL" CS_AGENT_NAME="$AGENT_NAME" \
            CS_QUARANTINE_DIR="$QUARANTINE_DIR" CS_CONFIG_FILE="$CONFIG_FILE" \
            "$BIN_PATH" --install-config 2>&1)" \
  || { printf '%s\n' "$CONF_OUT" >&2; die "Failed to write configuration."; }

printf '%s\n' "$CONF_OUT" | grep -v '^CS_EFFECTIVE_SERVER_URL=' | sed 's/^/    /'

# On an upgrade --server-url is optional, so read back whatever is actually in
# effect. Otherwise the summary and the rollout hint print a placeholder.
EFFECTIVE_URL="$(printf '%s\n' "$CONF_OUT" | sed -n 's/^CS_EFFECTIVE_SERVER_URL=//p' | tail -1)"
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
    -e "s|__BIN_PATH__|$BIN_PATH|g" \
    -e "s|__RUN_DIR__|$RUN_DIR|g" \
    -e "s|__CONFIG_FILE__|$CONFIG_FILE|g" \
    -e "s|__LOG_DIR__|$LOG_DIR|g" \
    "$SRC_DIR/cybersentineldlp-agent.service" > "$UNIT_PATH"

# The unit ships with INFO; honour --log-level without a second template.
sed -i "s|^Environment=CYBERSENTINEL_LOG_LEVEL=.*|Environment=CYBERSENTINEL_LOG_LEVEL=$LOG_LEVEL|" "$UNIT_PATH"
chmod 0644 "$UNIT_PATH"

if grep -q '__[A-Z_]*__' "$UNIT_PATH"; then
  die "Unit file still contains unsubstituted placeholders — check $SRC_DIR/cybersentineldlp-agent.service."
fi

# systemd does not reject a directive it does not recognise — it logs "Unknown
# key" and carries on, so a misplaced setting looks installed while doing
# nothing. StartLimitIntervalSec was in [Service] here and was being dropped
# exactly that way. Fail on it rather than ship a unit whose hardening is
# decorative.
if command -v systemd-analyze >/dev/null 2>&1; then
  VERIFY_OUT="$(systemd-analyze verify "$UNIT_PATH" 2>&1 || true)"
  if printf '%s' "$VERIFY_OUT" | grep -q 'Unknown key'; then
    printf '\n%s\n' "$VERIFY_OUT" >&2
    die "The unit contains directives this systemd silently ignores (see 'Unknown key' above)."
  fi
  if [ -n "$VERIFY_OUT" ]; then
    printf '%s\n' "$VERIFY_OUT" | sed 's/^/      /' >&2
  fi
  ok "Unit accepted by systemd-analyze"
fi

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
  # signed off. A onefile binary also has to unpack itself before it runs, so
  # give it a few seconds to extract, import, read config, register, and either
  # settle or die — then check what actually happened.
  for _ in $(seq 1 15); do
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
# Clean up superseded artifacts and the toolchain
# ---------------------------------------------------------------------------

# Only now, with the new binary confirmed running. On an upgrade from the older
# interpreted install these are what the outgoing service was executing, so
# deleting them any earlier would leave nothing to fall back to if the freeze
# or the restart went wrong.
if [ -f "$INSTALL_DIR/agent.py" ]; then
  rm -f "$INSTALL_DIR/agent.py"
  ok "Removed superseded $INSTALL_DIR/agent.py"
fi
if [ -d "$LEGACY_VENV" ]; then
  rm -rf "$LEGACY_VENV"
  ok "Removed superseded runtime virtualenv $LEGACY_VENV (~50 MB)"
fi

if [ "$KEEP_BUILD" -eq 1 ]; then
  info "Build tree kept at $BUILD_DIR (--keep-build)"
else
  rm -rf "$BUILD_DIR"
  ok "Build toolchain and staged source removed — only the executable remains"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

cat <<EOF

============================================================
${C_GREEN}${C_BOLD}Installation complete${C_RESET}
============================================================

  Executable   ${BIN_PATH} (agent v${AGENT_VERSION})
               one file: agent.py + policy_cache.py + print_monitor.py
               + Python runtime + requests + watchdog
  Config       ${CONFIG_FILE}
  Logs         ${LOG_DIR}/agent.log  +  journalctl
  Quarantine   ${QUARANTINE_DIR}
  Unpack dir   ${RUN_DIR}
  Service      ${SERVICE_NAME} (enabled at boot)

Common commands:
  systemctl status ${SERVICE_NAME}
  journalctl -u ${SERVICE_NAME} -f
  systemctl restart ${SERVICE_NAME}
  ${BIN_PATH} --selftest
  ${BIN_PATH} --config ${CONFIG_FILE} --dump-policies

To roll out to another machine, copy this directory across and run:
  sudo ./install.sh --server-url ${SERVER_URL:-<manager-url>}

Or skip the toolchain on the endpoints entirely — build once, then:
  sudo ./install.sh --prebuilt-binary ./${BIN_NAME} --server-url ${SERVER_URL:-<manager-url>}

EOF
