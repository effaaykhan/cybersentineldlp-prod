#!/usr/bin/env bash
#
# install-mirror-autopull.sh — run ONCE on the MIRROR server (.76) as root.
#
# Makes .76 fully hands-off for policy sync:
#   1. opts into the dev-server exported-policy seed (DLP_SEED_EXPORTED_POLICIES=1),
#   2. installs an hourly cron that pulls the latest manager/dashboard images and
#      recreates ONLY those services when the image actually changed,
#   3. applies the current images immediately.
#
# The data tier (postgres/mongo/redis/opensearch) is never touched.
#
# One-liner:
#   curl -fsSL https://raw.githubusercontent.com/effaaykhan/cybersentineldlp-prod/main/scripts/install-mirror-autopull.sh | sudo bash
#
# Env overrides: INSTALL_DIR (default /opt/cybersentineldlp),
#                COMPOSE_FILE (default docker-compose.prod.yml),
#                SERVICES (default "manager dashboard"),
#                CRON_MINUTE (default 37).
#
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/cybersentineldlp}"
COMPOSE="${COMPOSE_FILE:-docker-compose.prod.yml}"
SERVICES="${SERVICES:-manager dashboard}"
CRON_MINUTE="${CRON_MINUTE:-37}"
ENV_FILE="$INSTALL_DIR/.env"
WRAPPER="$INSTALL_DIR/auto-pull.sh"
LOG="/var/log/cybersentineldlp-autopull.log"

[ "$(id -u)" = "0" ] || { echo "run as root (sudo)"; exit 1; }
command -v docker >/dev/null || { echo "docker not found"; exit 1; }
[ -f "$INSTALL_DIR/$COMPOSE" ] || { echo "compose not found at $INSTALL_DIR/$COMPOSE — set INSTALL_DIR"; exit 1; }

# 1) Opt into the exported-policy seed (idempotent).
if [ -f "$ENV_FILE" ]; then
    if ! grep -q '^DLP_SEED_EXPORTED_POLICIES=' "$ENV_FILE"; then
        printf '\n# Apply policies synced from the dev server\nDLP_SEED_EXPORTED_POLICIES=1\n' >> "$ENV_FILE"
        echo "[+] added DLP_SEED_EXPORTED_POLICIES=1 to .env"
    else
        echo "[+] DLP_SEED_EXPORTED_POLICIES already set"
    fi
else
    echo "[!] $ENV_FILE not found — add DLP_SEED_EXPORTED_POLICIES=1 yourself"
fi

# 2) Write the auto-pull wrapper (paths baked in; run-time bits escaped).
cat > "$WRAPPER" <<WRAP
#!/usr/bin/env bash
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
cd "$INSTALL_DIR" || exit 1
echo "===== autopull \$(date -Is 2>/dev/null || date) ====="
docker compose -f "$COMPOSE" pull $SERVICES 2>&1
# up -d recreates ONLY services whose image/config changed; a no-op otherwise.
docker compose -f "$COMPOSE" up -d $SERVICES 2>&1
echo "===== done \$(date -Is 2>/dev/null || date) ====="
WRAP
chmod +x "$WRAPPER"
echo "[+] wrote $WRAPPER"

# 3) Install hourly cron + logrotate (preserving other crontab entries).
touch "$LOG"
tmp="$(mktemp)"
crontab -l 2>/dev/null | grep -vE "auto-pull\.sh|CyberSentinel DLP — mirror auto-pull" > "$tmp" || true
grep -q '^MAILTO=' "$tmp" || printf 'MAILTO=""\n' >> "$tmp"
printf '%s\n%s %s\n' \
  "# CyberSentinel DLP — mirror auto-pull (dev policies -> here)" \
  "${CRON_MINUTE} * * * *" "$WRAPPER >> $LOG 2>&1" >> "$tmp"
crontab "$tmp"; rm -f "$tmp"
echo "[+] installed hourly cron (minute ${CRON_MINUTE})"

cat > /etc/logrotate.d/cybersentineldlp-autopull <<'ROT'
/var/log/cybersentineldlp-autopull.log {
    weekly
    rotate 4
    compress
    missingok
    notifempty
    copytruncate
}
ROT

# 4) Apply the current images now (also recreates manager with the new env flag).
echo "[+] applying current images now…"
bash "$WRAPPER" || true

echo
echo "Done. This server now auto-pulls hourly (minute ${CRON_MINUTE}) and applies"
echo "policies synced from the dev server. Log: $LOG"
