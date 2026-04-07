#!/usr/bin/env bash
#
# CyberSentinel DLP — Server one-liner installer.
#
# This script downloads ONLY the production docker-compose file and
# environment template — no source code is ever placed on the production
# server. All services run from pre-built images on GHCR.
#
# Usage (one-liner):
#   curl -fsSL https://raw.githubusercontent.com/effaaykhan/cybersentineldlp-prod/main/install.sh | sudo bash
#
# Or to a custom directory:
#   curl -fsSL https://raw.githubusercontent.com/effaaykhan/cybersentineldlp-prod/main/install.sh | sudo INSTALL_DIR=/srv/cybersentinel bash
#
set -euo pipefail

# ─── Configuration ────────────────────────────────────────────────────
GITHUB_REPO="effaaykhan/cybersentineldlp-prod"
GITHUB_BRANCH="${GITHUB_BRANCH:-main}"
RAW_BASE="https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}"
INSTALL_DIR="${INSTALL_DIR:-/opt/cybersentinel}"
COMPOSE_FILE="docker-compose.prod.yml"
ENV_FILE=".env"
ENV_EXAMPLE=".env.example"

# ─── Helpers ──────────────────────────────────────────────────────────
c_blue()   { printf "\033[1;34m%s\033[0m\n" "$*"; }
c_green()  { printf "\033[1;32m%s\033[0m\n" "$*"; }
c_yellow() { printf "\033[1;33m%s\033[0m\n" "$*"; }
c_red()    { printf "\033[1;31m%s\033[0m\n" "$*" >&2; }
say()      { printf "[+] %s\n" "$*"; }
die()      { c_red "[FATAL] $*"; exit 1; }

require_root() {
    if [ "$(id -u)" -ne 0 ]; then
        die "This installer must be run as root (sudo)."
    fi
}

# ─── Banner ───────────────────────────────────────────────────────────
clear || true
c_blue "================================================================"
c_blue "  CyberSentinel DLP — Production Server Installer"
c_blue "================================================================"
echo
say "Repository : ${GITHUB_REPO} (branch ${GITHUB_BRANCH})"
say "Install dir: ${INSTALL_DIR}"
say "No source code will be deployed — only the compose file and .env."
echo

require_root

# ─── 1. Install Docker if missing ─────────────────────────────────────
install_docker() {
    say "Docker not found — installing via official convenience script."
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
    sh /tmp/get-docker.sh
    rm -f /tmp/get-docker.sh
    systemctl enable docker
    systemctl start docker
}

if ! command -v docker >/dev/null 2>&1; then
    install_docker
fi

if ! docker compose version >/dev/null 2>&1; then
    die "Docker is installed but 'docker compose' v2 is not available. Upgrade Docker."
fi
say "Docker $(docker --version | awk '{print $3}' | tr -d ',') OK"

# ─── 2. Create install dir ────────────────────────────────────────────
mkdir -p "${INSTALL_DIR}"
cd "${INSTALL_DIR}"
say "Working in ${INSTALL_DIR}"

# ─── 3. Download compose + env template ───────────────────────────────
say "Downloading ${COMPOSE_FILE}"
curl -fsSL "${RAW_BASE}/${COMPOSE_FILE}" -o "${COMPOSE_FILE}"

if [ ! -f "${ENV_FILE}" ]; then
    say "Downloading ${ENV_EXAMPLE}"
    curl -fsSL "${RAW_BASE}/${ENV_EXAMPLE}" -o "${ENV_EXAMPLE}"
fi

# ─── 4. Generate .env with secure random secrets ──────────────────────
gen_secret() {
    # 48 chars of url-safe random
    local n="${1:-48}"
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -base64 "$n" | tr -d '/+=' | head -c "$n"
    else
        head -c "$((n*2))" /dev/urandom | tr -dc 'A-Za-z0-9' | head -c "$n"
    fi
}

if [ ! -f "${ENV_FILE}" ]; then
    say "Generating ${ENV_FILE} with secure random passwords"
    cp "${ENV_EXAMPLE}" "${ENV_FILE}"
    SECRET_KEY="$(gen_secret 48)"
    JWT_SECRET="$(gen_secret 48)"
    ENCRYPTION_KEY="$(gen_secret 48)"
    POSTGRES_PASSWORD="$(gen_secret 24)"
    MONGODB_PASSWORD="$(gen_secret 24)"
    REDIS_PASSWORD="$(gen_secret 24)"
    OPENSEARCH_PASSWORD="$(gen_secret 24)"

    # Use python or sed for safe in-place substitution
    sed -i \
        -e "s|change-this-to-a-random-secret-key-min-32-chars|${SECRET_KEY}|" \
        -e "s|change-this-to-a-random-jwt-secret-min-32-chars|${JWT_SECRET}|" \
        -e "s|change-this-to-a-random-encryption-key|${ENCRYPTION_KEY}|" \
        -e "s|change-this-strong-postgres-password|${POSTGRES_PASSWORD}|" \
        -e "s|change-this-strong-mongodb-password|${MONGODB_PASSWORD}|" \
        -e "s|change-this-strong-redis-password|${REDIS_PASSWORD}|" \
        -e "s|change-this-strong-opensearch-password|${OPENSEARCH_PASSWORD}|" \
        "${ENV_FILE}"

    chmod 600 "${ENV_FILE}"
    say "${ENV_FILE} created with mode 600 (root only)"
else
    say "${ENV_FILE} already exists — keeping existing secrets"
fi

# ─── 5. Generate self-signed TLS certs if missing ─────────────────────
# docker-compose.prod.yml mounts ./certs/fullchain.pem and ./certs/privkey.pem
# into the dashboard nginx container. The compose-up will fail if those
# files don't exist, so we drop a self-signed pair if the operator hasn't
# provided real certs.
mkdir -p "${INSTALL_DIR}/certs"
if [ ! -f "${INSTALL_DIR}/certs/fullchain.pem" ] || [ ! -f "${INSTALL_DIR}/certs/privkey.pem" ]; then
    say "Generating self-signed TLS certificate (replace with real cert later)"
    if command -v openssl >/dev/null 2>&1; then
        openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
            -keyout "${INSTALL_DIR}/certs/privkey.pem" \
            -out    "${INSTALL_DIR}/certs/fullchain.pem" \
            -subj "/CN=cybersentinel.local" >/dev/null 2>&1
        chmod 600 "${INSTALL_DIR}/certs/privkey.pem"
    else
        # No openssl — drop empty placeholders just so the bind-mount succeeds.
        : > "${INSTALL_DIR}/certs/fullchain.pem"
        : > "${INSTALL_DIR}/certs/privkey.pem"
        c_yellow "[!] openssl missing — created empty cert placeholders. HTTPS will not work."
    fi
fi

# ─── 6. Create data directories used by bind mounts ───────────────────
# (compose maps quarantine + logs into named volumes by default; this is
# just for any host paths the operator may add later)
mkdir -p "${INSTALL_DIR}/data"

# ─── 7. Pull pre-built images and start ───────────────────────────────
say "Pulling pre-built images from ghcr.io/${GITHUB_REPO} ..."
docker compose -f "${COMPOSE_FILE}" pull

say "Starting all services in detached mode"
docker compose -f "${COMPOSE_FILE}" up -d

# ─── 8. Wait for health ───────────────────────────────────────────────
say "Waiting for the manager API to come up (max ~3 minutes)"
for i in $(seq 1 90); do
    if curl -fsS http://localhost:55000/health >/dev/null 2>&1; then
        break
    fi
    sleep 2
    printf "."
done
echo

if ! curl -fsS http://localhost:55000/health >/dev/null 2>&1; then
    c_red "[FATAL] Manager API did not become healthy within 3 minutes."
    c_red "Check the logs:"
    c_red "  docker compose -f ${INSTALL_DIR}/${COMPOSE_FILE} logs manager"
    exit 1
fi

# ─── 9. Print connection details ──────────────────────────────────────
HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || echo localhost)"

# Try to extract the bootstrap admin password the manager logs on first run.
ADMIN_PASS=""
if command -v docker >/dev/null 2>&1; then
    ADMIN_PASS=$(docker logs cybersentinel-manager 2>&1 \
        | grep -m1 'generated_password' \
        | sed -n 's/.*"generated_password": *"\([^"]*\)".*/\1/p' || true)
fi

echo
c_green "================================================================"
c_green "  Installation Complete"
c_green "================================================================"
echo
say "Install dir : ${INSTALL_DIR}"
say "Compose file: ${INSTALL_DIR}/${COMPOSE_FILE}"
say "Env file    : ${INSTALL_DIR}/${ENV_FILE} (mode 600)"
say "Certs       : ${INSTALL_DIR}/certs/  (self-signed unless replaced)"
echo
c_blue "Endpoints:"
echo "  Dashboard   : https://${HOST_IP}/         (or http://${HOST_IP}/)"
echo "  Manager API : http://${HOST_IP}:55000"
echo "  API Docs    : http://${HOST_IP}:55000/api/v1/docs"
echo
c_blue "First-login credentials:"
echo "  Username : admin"
if [ -n "${ADMIN_PASS}" ]; then
    echo "  Password : ${ADMIN_PASS}"
else
    echo "  Password : run \`docker logs cybersentinel-manager 2>&1 | grep generated_password\`"
fi
c_yellow "  → Change this password on first login."
echo
c_blue "Useful commands:"
echo "  docker compose -f ${INSTALL_DIR}/${COMPOSE_FILE} ps"
echo "  docker compose -f ${INSTALL_DIR}/${COMPOSE_FILE} logs -f manager"
echo "  docker compose -f ${INSTALL_DIR}/${COMPOSE_FILE} pull && docker compose -f ${INSTALL_DIR}/${COMPOSE_FILE} up -d   # update"
echo "  docker compose -f ${INSTALL_DIR}/${COMPOSE_FILE} down                                                              # stop"
echo
