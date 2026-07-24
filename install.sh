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
#   curl -fsSL https://raw.githubusercontent.com/effaaykhan/cybersentineldlp-prod/main/install.sh | sudo INSTALL_DIR=/srv/cybersentineldlp bash
#
set -euo pipefail

# ─── Configuration ────────────────────────────────────────────────────
GITHUB_REPO="effaaykhan/cybersentineldlp-prod"
GITHUB_BRANCH="${GITHUB_BRANCH:-main}"
RAW_BASE="https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}"
INSTALL_DIR="${INSTALL_DIR:-/opt/cybersentineldlp}"
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

    # Derive a reasonable default origin from the host's first IP so the
    # API's CORS allowlist is not left wide open and does not need to be
    # hand-edited on every install. Operators can tighten it later.
    HOST_IP_GUESS="$(hostname -I 2>/dev/null | awk '{print $1}' || echo 127.0.0.1)"
    # The dashboard is served on DASHBOARD_HOST_PORT (default 3023), so the
    # browser's Origin carries that port. Listing the bare host would not match
    # it. Same-origin nginx proxying means CORS is usually not exercised at all,
    # but the allowlist should still describe reality.
    DASH_PORT_DEFAULT="$(grep -E '^DASHBOARD_HOST_PORT=' "${ENV_EXAMPLE}" 2>/dev/null | cut -d= -f2- | tr -d '"'"'"' ' | head -1)"
    DASH_PORT_DEFAULT="${DASH_PORT_DEFAULT:-3023}"
    CORS_JSON_DEFAULT="[\"http://${HOST_IP_GUESS}:${DASH_PORT_DEFAULT}\",\"https://${HOST_IP_GUESS}:${DASH_PORT_DEFAULT}\",\"http://localhost:${DASH_PORT_DEFAULT}\",\"http://127.0.0.1:${DASH_PORT_DEFAULT}\"]"
    ALLOWED_HOSTS_DEFAULT="${HOST_IP_GUESS},localhost,127.0.0.1"

    # Safe in-place substitution. `|` as the sed delimiter so the JSON
    # bracket/quote characters don't need extra escaping.
    sed -i \
        -e "s|change-this-to-a-random-secret-key-min-32-chars|${SECRET_KEY}|" \
        -e "s|change-this-to-a-random-jwt-secret-min-32-chars|${JWT_SECRET}|" \
        -e "s|change-this-to-a-random-encryption-key|${ENCRYPTION_KEY}|" \
        -e "s|change-this-strong-postgres-password|${POSTGRES_PASSWORD}|" \
        -e "s|change-this-strong-mongodb-password|${MONGODB_PASSWORD}|" \
        -e "s|change-this-strong-redis-password|${REDIS_PASSWORD}|" \
        -e "s|change-this-strong-opensearch-password|${OPENSEARCH_PASSWORD}|" \
        -e "s|^CORS_ORIGINS=.*|CORS_ORIGINS=${CORS_JSON_DEFAULT}|" \
        -e "s|^ALLOWED_HOSTS=.*|ALLOWED_HOSTS=${ALLOWED_HOSTS_DEFAULT}|" \
        "${ENV_FILE}"

    chown root:root "${ENV_FILE}"
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
chmod 700 "${INSTALL_DIR}/certs"
if [ ! -f "${INSTALL_DIR}/certs/fullchain.pem" ] || [ ! -f "${INSTALL_DIR}/certs/privkey.pem" ]; then
    say "Generating self-signed TLS certificate (replace with real cert later)"
    if command -v openssl >/dev/null 2>&1; then
        # Stronger key (RSA 4096), explicit SAN entries so modern
        # browsers don't reject the cert outright, and the operator's
        # hostname baked in if we can resolve it.
        HOSTNAME_CN="$(hostname -f 2>/dev/null || hostname 2>/dev/null || echo cybersentineldlp.local)"
        HOST_IP_SAN="$(hostname -I 2>/dev/null | awk '{print $1}' || echo 127.0.0.1)"
        openssl req -x509 -nodes -newkey rsa:4096 -days 825 \
            -keyout "${INSTALL_DIR}/certs/privkey.pem" \
            -out    "${INSTALL_DIR}/certs/fullchain.pem" \
            -subj "/CN=${HOSTNAME_CN}/O=CyberSentinel DLP/OU=self-signed" \
            -addext "subjectAltName=DNS:${HOSTNAME_CN},DNS:cybersentineldlp.local,DNS:localhost,IP:127.0.0.1,IP:${HOST_IP_SAN}" \
            -addext "keyUsage=digitalSignature,keyEncipherment" \
            -addext "extendedKeyUsage=serverAuth" \
            >/dev/null 2>&1
        chown root:root "${INSTALL_DIR}/certs/privkey.pem" "${INSTALL_DIR}/certs/fullchain.pem"
        chmod 600 "${INSTALL_DIR}/certs/privkey.pem"
        chmod 644 "${INSTALL_DIR}/certs/fullchain.pem"
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

# ─── 6b. Guard against a stale OpenSearch volume ──────────────────────
# OPENSEARCH_INITIAL_ADMIN_PASSWORD is applied ONLY when OpenSearch first
# initialises its security index. If a volume survives from an earlier attempt,
# the password baked into it wins and the value in .env is ignored forever —
# every request then fails with "Authentication finally failed for admin", the
# healthcheck goes unhealthy, and the manager never starts behind a confusing
# "dependency failed to start" error.
#
# We can't repair that in place (the password lives inside the security index),
# so detect it and tell the operator exactly what to run rather than dying with
# a dependency error 3 minutes later.
OS_VOL="$(docker volume ls -q 2>/dev/null | grep -E '(^|_)opensearch_data$' | head -1 || true)"
if [ -n "${OS_VOL}" ]; then
    ENV_OS_PASS="$(grep -E '^OPENSEARCH_PASSWORD=' "${ENV_FILE}" 2>/dev/null | cut -d= -f2- | head -1)"
    say "Existing OpenSearch volume detected (${OS_VOL}) — verifying its password still matches ${ENV_FILE}"
    docker compose -f "${COMPOSE_FILE}" up -d opensearch >/dev/null 2>&1 || true
    OS_OK=0
    for _ in $(seq 1 30); do
        if docker compose -f "${COMPOSE_FILE}" exec -T opensearch \
             curl -s -f -k -u "admin:${ENV_OS_PASS}" https://localhost:9200/_cluster/health >/dev/null 2>&1; then
            OS_OK=1; break
        fi
        sleep 5
    done
    if [ "${OS_OK}" -ne 1 ]; then
        echo
        c_red "[FATAL] The existing OpenSearch volume rejects the password in ${ENV_FILE}."
        c_red ""
        c_red "OpenSearch only honours OPENSEARCH_INITIAL_ADMIN_PASSWORD the first time it"
        c_red "initialises. This volume was created by an earlier run with a different"
        c_red "password, so it can never accept the current one and cannot be fixed in place."
        c_red ""
        c_red "If this box holds no data you need (a failed/first install), reset and re-run:"
        c_red "  cd ${INSTALL_DIR}"
        c_red "  docker compose -f ${COMPOSE_FILE} down -v      # deletes ALL volumes"
        c_red "  curl -fsSL ${RAW_BASE}/install.sh | sudo bash"
        c_red ""
        c_red "If you DO have data to keep, restore the original OPENSEARCH_PASSWORD into"
        c_red "${ENV_FILE} instead — that value is the only one this volume will accept."
        exit 1
    fi
    say "Existing OpenSearch volume accepts the configured password"
fi

# ─── 6c. Guard against a stale Postgres volume ────────────────────────
# Postgres bakes POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB into its data
# directory ONLY the first time it initialises an EMPTY volume. If a
# postgres_data volume survives from an earlier run, a changed POSTGRES_PASSWORD
# in .env is silently ignored — the role keeps its original password. The
# manager then can't authenticate (cross-container connections hit the
# scram-sha-256 rule in pg_hba, which enforces the password), the postgres
# healthcheck/manager dependency fails, and the install dies 3 minutes later
# behind a confusing "dependency failed to start".
#
# We probe exactly the way the manager connects — over the network to the
# `postgres` service hostname (NOT 127.0.0.1, which pg_hba trusts) using the
# container's OWN configured creds, so this works regardless of whether the
# user is dlp_user (dev) or cybersentineldlp (prod). A wrong-password volume
# can't be fixed in place, so detect it and tell the operator what to run.
PG_VOL="$(docker volume ls -q 2>/dev/null | grep -E '(^|_)postgres_data$' | head -1 || true)"
if [ -n "${PG_VOL}" ]; then
    say "Existing Postgres volume detected (${PG_VOL}) — verifying its password still matches ${ENV_FILE}"
    docker compose -f "${COMPOSE_FILE}" up -d postgres >/dev/null 2>&1 || true
    PG_OK=0
    PG_AUTHFAIL=0
    for _ in $(seq 1 30); do
        PG_OUT="$(docker compose -f "${COMPOSE_FILE}" exec -T postgres \
            sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -h postgres -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT 1"' 2>&1 || true)"
        case "${PG_OUT}" in
            *1*) if printf '%s' "${PG_OUT}" | grep -q '^1$'; then PG_OK=1; break; fi ;;
        esac
        # A wrong password won't heal by waiting — stop the retry loop early.
        case "${PG_OUT}" in
            *"password authentication failed"*) PG_AUTHFAIL=1; break ;;
        esac
        sleep 5
    done
    if [ "${PG_OK}" -ne 1 ]; then
        echo
        if [ "${PG_AUTHFAIL}" -eq 1 ]; then
            c_red "[FATAL] The existing Postgres volume rejects the password in ${ENV_FILE}."
        else
            c_red "[FATAL] Could not verify the existing Postgres volume's password (postgres never became reachable)."
        fi
        c_red ""
        c_red "Postgres applies POSTGRES_PASSWORD only the first time it initialises an"
        c_red "EMPTY data volume. This volume was created by an earlier run with a"
        c_red "different password, so the role keeps the old one and the manager can"
        c_red "never authenticate — this cannot be fixed by editing .env."
        c_red ""
        c_red "If this box holds no data you need (a failed/first install), reset and re-run:"
        c_red "  cd ${INSTALL_DIR}"
        c_red "  docker compose -f ${COMPOSE_FILE} down -v      # deletes ALL volumes"
        c_red "  curl -fsSL ${RAW_BASE}/install.sh | sudo bash"
        c_red ""
        c_red "If you DO have data to keep, restore the original POSTGRES_PASSWORD into"
        c_red "${ENV_FILE} instead — that value is the only one this volume will accept."
        exit 1
    fi
    say "Existing Postgres volume accepts the configured password"
fi

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

# ─── 8b. Mark the migration state ─────────────────────────────────────
# The manager auto-creates the whole schema at startup, so on a fresh install
# `alembic upgrade head` would fail ("type userrole already exists"). We stamp
# instead, which records the DB as being at the latest revision so future
# upgrades apply cleanly.
#
# Only stamp when the DB has never been stamped. If this is a re-run against an
# existing install, stamping would silently mark pending migrations as done and
# skip them — that case is an upgrade and must use `alembic upgrade head`.
# `alembic current` prints the revision on stdout ("022_ioc_threat_intel (head)")
# and its INFO chatter on stderr, so non-empty stdout == already stamped. Don't
# pattern-match the revision id: this project names them "022_ioc_threat_intel",
# not hex hashes, so a /[0-9a-f]{6,}/ test silently never matches.
if [ -n "$(docker exec cybersentineldlp-manager alembic current 2>/dev/null | tr -d '[:space:]')" ]; then
    say "Alembic revision already stamped — leaving migration state untouched"
    c_yellow "  (upgrading an existing install? run: docker exec cybersentineldlp-manager alembic upgrade head)"
else
    say "Stamping database at the latest Alembic revision (fresh install)"
    docker exec cybersentineldlp-manager alembic stamp head >/dev/null 2>&1 \
        && say "Migration state stamped" \
        || c_yellow "[!] Could not stamp Alembic revision — run it manually: docker exec cybersentineldlp-manager alembic stamp head"
fi

# ─── 8c. Post-install validation (ML classifier + core health) ────────
# Downloads validate.sh (kept in INSTALL_DIR so the operator can re-run it) and
# runs the PASS/FAIL checks. Non-fatal: a failed check warns but does not abort
# an otherwise-healthy install, since the ML augmentation is additive.
say "Downloading validate.sh"
# Retry: this file was occasionally missed on slow/flaky links because the fetch
# had no retries. --retry-all-errors also rides out brief raw-CDN propagation.
if curl -fsSL --retry 4 --retry-delay 2 --retry-all-errors --connect-timeout 15 \
        "${RAW_BASE}/validate.sh" -o "${INSTALL_DIR}/validate.sh"; then
    chmod +x "${INSTALL_DIR}/validate.sh"
    echo
    say "Running post-install validation"
    if bash "${INSTALL_DIR}/validate.sh" --container cybersentineldlp-manager --url http://localhost:55000; then
        say "Validation passed"
    else
        c_yellow "[!] One or more validation checks did not pass. The stack is up, but"
        c_yellow "    review the output above. Re-run any time:"
        c_yellow "      sudo bash ${INSTALL_DIR}/validate.sh"
    fi
    echo
else
    c_yellow "[!] Could not download validate.sh (transient network issue?) — skipping automated validation."
    c_yellow "    Run it manually once the network settles:"
    c_yellow "      curl -fsSL ${RAW_BASE}/validate.sh -o ${INSTALL_DIR}/validate.sh && sudo bash ${INSTALL_DIR}/validate.sh"
fi

# ─── 9. Print connection details ──────────────────────────────────────
HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || echo localhost)"

# The manager seeds the first admin with a RANDOM password (unique per
# deployment) and logs it exactly once — there is no fixed default any more.
# Pull it back out of the logs so the operator never has to go hunting.
# If DLP_ADMIN_PASSWORD was set in .env, the manager uses that and logs nothing.
ADMIN_PASS="$(docker compose -f "${COMPOSE_FILE}" logs manager 2>&1 \
    | grep -oE '"generated_password": "[^"]+"' | head -1 \
    | sed -e 's/^"generated_password": "//' -e 's/"$//' || true)"

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
# Dashboard host port comes from .env (DASHBOARD_HOST_PORT). Fall back
# to the compose default so the banner matches what's actually bound.
DASH_PORT=$(grep -E '^DASHBOARD_HOST_PORT=' "${INSTALL_DIR}/${ENV_FILE}" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'" | head -1)
DASH_PORT="${DASH_PORT:-3023}"

c_blue "Endpoints:"
echo "  Dashboard      : http://${HOST_IP}:${DASH_PORT}/"
echo "  Manager API    : http://${HOST_IP}:55000"
echo "  API Docs       : http://${HOST_IP}:55000/api/v1/docs"
echo "  Health probe   : http://${HOST_IP}:55000/health"
echo
c_yellow "  NOTE: TLS termination is NOT enabled by default. The dashboard"
c_yellow "        nginx serves plain HTTP on container port 3000 (published as"
c_yellow "        ${DASH_PORT} on this host). For HTTPS, front the"
c_yellow "        deployment with Caddy / Traefik / nginx-proxy + Let's"
c_yellow "        Encrypt, or mount a custom nginx-ssl.conf into the dashboard"
c_yellow "        container. Self-signed certs are generated in ${INSTALL_DIR}/certs/"
c_yellow "        for that purpose."
echo
c_blue "First-login credentials:"
echo "  Username : admin"
if [ -n "${ADMIN_PASS}" ]; then
    echo "  Password : ${ADMIN_PASS}"
    c_yellow "  → Randomly generated for THIS deployment and shown only once."
    c_yellow "    Record it now, then change it after first login"
    c_yellow "    (Settings → Profile → Change Password)."
    c_yellow "    To retrieve it again:"
    c_yellow "      docker logs cybersentineldlp-manager 2>&1 | grep generated_password"
else
    echo "  Password : (set by you via DLP_ADMIN_PASSWORD in ${ENV_FILE})"
    c_yellow "  → If you did NOT set DLP_ADMIN_PASSWORD, the admin may already have"
    c_yellow "    existed. Retrieve the first-boot password with:"
    c_yellow "      docker logs cybersentineldlp-manager 2>&1 | grep generated_password"
fi
echo
c_blue "Database tier (internal-only — no host port binding):"
echo "  postgres / mongodb / redis / opensearch are reachable only on the"
echo "  internal docker network. Use 'docker compose exec <svc>' for ops."
echo
c_blue "Useful commands:"
echo "  docker compose -f ${INSTALL_DIR}/${COMPOSE_FILE} ps"
echo "  docker compose -f ${INSTALL_DIR}/${COMPOSE_FILE} logs -f manager"
echo "  docker compose -f ${INSTALL_DIR}/${COMPOSE_FILE} pull && \\"
echo "    docker compose -f ${INSTALL_DIR}/${COMPOSE_FILE} up -d   # rolling update"
echo "  docker compose -f ${INSTALL_DIR}/${COMPOSE_FILE} down       # stop everything"
echo
c_blue "Next: install agents on endpoints (run on Windows boxes):"
echo "  powershell -ExecutionPolicy Bypass -Command \"irm ${RAW_BASE}/install-agent.ps1 | iex\""
echo
