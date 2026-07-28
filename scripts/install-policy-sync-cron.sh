#!/usr/bin/env bash
#
# install-policy-sync-cron.sh — set up the hourly policy-sync cron + logrotate on
# the DEV server (.204). Idempotent; run as root. Captures the .204-side
# automation so it can be recreated after a rebuild.
#
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WRAPPER="$REPO/scripts/policy-sync-cron.sh"
LOG="/var/log/cybersentineldlp-policy-sync.log"
CRON_LINE="7 * * * * ${WRAPPER} >> ${LOG} 2>&1"
MARKER="# CyberSentinel DLP — hourly policy sync (dev DB -> git -> mirror)"

[ "$(id -u)" = "0" ] || { echo "run as root"; exit 1; }
[ -f "$WRAPPER" ] || { echo "missing $WRAPPER"; exit 1; }
chmod +x "$WRAPPER"
touch "$LOG"

# Refresh the cron line, preserving any other crontab entries.
tmp="$(mktemp)"
crontab -l 2>/dev/null | grep -vE "policy-sync-cron\.sh|CyberSentinel DLP — hourly policy sync" > "$tmp" || true
grep -q '^MAILTO=' "$tmp" || printf 'MAILTO=""\n' >> "$tmp"
printf '%s\n%s\n' "$MARKER" "$CRON_LINE" >> "$tmp"
crontab "$tmp"
rm -f "$tmp"

# Keep the hourly log bounded.
cat > /etc/logrotate.d/cybersentineldlp-policy-sync <<'ROT'
/var/log/cybersentineldlp-policy-sync.log {
    weekly
    rotate 4
    compress
    missingok
    notifempty
    copytruncate
}
ROT

echo "Installed. Active schedule:"
crontab -l | grep -A0 "policy-sync-cron.sh"
echo "Log: ${LOG}"
