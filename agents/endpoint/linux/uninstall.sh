#!/usr/bin/env bash
#
# CyberSentinel DLP - Linux Endpoint Agent uninstaller.
#
# By default this removes the service and the code but KEEPS the config
# (agent identity) and the quarantine directory, so a reinstall re-attaches to
# the same agent record on the manager. Pass --purge to remove everything.

set -euo pipefail

INSTALL_DIR="/opt/cybersentinel/agent"
VENV_DIR="/opt/cybersentinel/venv"
CONFIG_DIR="/etc/cybersentinel"
LOG_DIR="/var/log/cybersentinel"
QUARANTINE_DIR="/opt/cybersentinel/quarantine"
SERVICE_NAME="cybersentineldlp-agent"
PURGE=0

usage() {
  cat <<EOF
Usage: sudo ./uninstall.sh [--purge] [--service-name NAME]

  --purge            Also remove config (agent identity), logs and quarantine.
  --service-name     systemd unit name (default: $SERVICE_NAME)

Without --purge, $CONFIG_DIR and $QUARANTINE_DIR are left in place so that
reinstalling reuses the same agent identity on the manager.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --purge)        PURGE=1; shift ;;
    --service-name) SERVICE_NAME="${2:-}"; shift 2 ;;
    -h|--help)      usage; exit 0 ;;
    *)              usage >&2; echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "ERROR: must run as root (sudo)." >&2; exit 1; }

echo "Stopping and disabling $SERVICE_NAME..."
systemctl stop "$SERVICE_NAME" 2>/dev/null || true
systemctl disable "$SERVICE_NAME" 2>/dev/null || true
rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
systemctl daemon-reload
systemctl reset-failed "$SERVICE_NAME" 2>/dev/null || true
echo "  service removed"

rm -rf "$INSTALL_DIR" "$VENV_DIR"
rm -f /etc/sysctl.d/99-cybersentinel-inotify.conf
echo "  code and virtualenv removed"

if [ "$PURGE" -eq 1 ]; then
  # Quarantine can hold the only remaining copy of a file the agent pulled out
  # of a user's directory. Say so rather than deleting it silently.
  if [ -d "$QUARANTINE_DIR" ] && [ -n "$(ls -A "$QUARANTINE_DIR" 2>/dev/null)" ]; then
    echo
    echo "  WARNING: $QUARANTINE_DIR is not empty. Quarantined files may be the"
    echo "           only copy of the data they contain. Deleting in 10s —"
    echo "           press Ctrl-C to abort and back them up first."
    sleep 10
  fi
  rm -rf "$CONFIG_DIR" "$LOG_DIR" "$QUARANTINE_DIR"
  echo "  config, logs and quarantine removed (--purge)"
  echo
  echo "Fully removed. The agent record remains on the manager — delete it there too."
else
  echo "  config kept:     $CONFIG_DIR"
  echo "  logs kept:       $LOG_DIR"
  echo "  quarantine kept: $QUARANTINE_DIR"
  echo
  echo "Uninstalled. Re-running install.sh will reuse the existing agent identity."
fi
