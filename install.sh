#!/usr/bin/env bash
#
# CyberSentinel DLP — Server installer / manager (one-liner).
#
# Downloads ONLY the production docker-compose file and environment template —
# no source code is ever placed on the production server. All services run from
# pre-built images on GHCR.
#
# Usage (one-liner):
#   curl -fsSL https://raw.githubusercontent.com/effaaykhan/cybersentineldlp-prod/main/install.sh | sudo bash
#
# On start it detects any existing installation and shows a menu:
#   [1] Install   [2] Update   [3] Delete   [4] Exit
#
# When run WITHOUT a terminal (e.g. a CI/cron pipe with no /dev/tty) it stays
# non-interactive: an existing install is UPDATED, otherwise a fresh INSTALL is
# performed — so the classic unattended one-liner keeps working.
#
# Custom directory:
#   curl -fsSL .../install.sh | sudo INSTALL_DIR=/srv/cybersentineldlp bash
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

# ─── Colours ──────────────────────────────────────────────────────────
# Enabled only when stdout is a real terminal (so piped/redirected output stays
# clean) — override with NO_COLOR=1 to force-disable.
if [ -t 1 ] && [ "${NO_COLOR:-0}" != "1" ]; then
    C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
    C_RED=$'\033[1;31m';   C_GREEN=$'\033[1;32m'; C_YELLOW=$'\033[1;33m'
    C_BLUE=$'\033[1;34m';  C_MAGENTA=$'\033[1;35m'; C_CYAN=$'\033[1;36m'
    C_GREY=$'\033[0;90m'
else
    C_RESET=; C_BOLD=; C_DIM=; C_RED=; C_GREEN=; C_YELLOW=; C_BLUE=; C_MAGENTA=; C_CYAN=; C_GREY=
fi

# ─── Helpers ──────────────────────────────────────────────────────────
c_blue()   { printf '%s%s%s\n' "${C_BLUE}"   "$*" "${C_RESET}"; }
c_green()  { printf '%s%s%s\n' "${C_GREEN}"  "$*" "${C_RESET}"; }
c_yellow() { printf '%s%s%s\n' "${C_YELLOW}" "$*" "${C_RESET}"; }
c_red()    { printf '%s%s%s\n' "${C_RED}"    "$*" "${C_RESET}" >&2; }
say()      { printf '%s❯%s %s\n' "${C_CYAN}" "${C_RESET}" "$*"; }
die()      { c_red "[FATAL] $*"; exit 1; }

# Panel / menu drawing primitives (left-bordered so colour codes never break
# right-edge alignment).
_bar()  { printf '  %s│%s  %s\n' "${C_GREY}" "${C_RESET}" "$*"; }
_top()  { printf '  %s╭─%s %s%s%s\n' "${C_GREY}" "${C_RESET}" "${C_BOLD}" "$*" "${C_RESET}"; }
_end()  { printf '  %s╰────────────────────────────────────────────────────────%s\n' "${C_GREY}" "${C_RESET}"; }

# Product banner — slant "CyberSentinel" wordmark with a cyan→blue gradient and a
# gentle line-by-line reveal on a real terminal. Pure-ASCII art so it renders on
# every locale/code page; colour + animation degrade to plain text when piped.
banner() {
    local art=(
'    ______      __              _____            __  _            __'
'   / ____/_  __/ /_  ___  _____/ ___/___  ____  / /_(_)___  ___  / /'
'  / /   / / / / __ \/ _ \/ ___/\__ \/ _ \/ __ \/ __/ / __ \/ _ \/ /'
' / /___/ /_/ / /_/ /  __/ /   ___/ /  __/ / / / /_/ / / / /  __/ /'
' \____/\__, /_.___/\___/_/   /____/\___/_/ /_/\__/_/_/ /_/\___/_/'
'      /____/'
    )
    local grad=()
    if [ -n "${C_RESET}" ]; then
        if [ "$(tput colors 2>/dev/null || echo 0)" -ge 256 ]; then
            # pale-cyan → blue vertical fade
            grad=($'\033[38;5;123m' $'\033[38;5;87m' $'\033[38;5;51m' $'\033[38;5;45m' $'\033[38;5;39m' $'\033[38;5;33m')
        else
            grad=("${C_CYAN}" "${C_CYAN}" "${C_CYAN}" "${C_BLUE}" "${C_BLUE}" "${C_BLUE}")
        fi
    fi
    printf '\n'
    local i
    for i in "${!art[@]}"; do
        printf '%s%s%s\n' "${grad[i]:-}" "${art[i]}" "${C_RESET}"
        if [ "${HAVE_TTY}" -eq 1 ] && [ "${NO_ANIM:-0}" != "1" ]; then sleep 0.03 2>/dev/null || true; fi
    done
    printf '%s\n' "         ${C_BOLD}D A T A   L O S S   P R E V E N T I O N${C_RESET}   ${C_DIM}·   S E R V E R${C_RESET}"
    printf '%s\n' "               ${C_GREY}Server Installer  ·  Manager Console${C_RESET}"
    printf '\n'
}

require_root() {
    if [ "$(id -u)" -ne 0 ]; then
        die "This installer must be run as root (sudo)."
    fi
}

# Is a controlling terminal available? `curl | sudo bash` feeds the SCRIPT to
# bash on stdin, so we must read menu input from /dev/tty, not stdin. When even
# /dev/tty can't be opened (CI/cron), we run non-interactively instead.
HAVE_TTY=0
if { : < /dev/tty; } 2>/dev/null; then HAVE_TTY=1; fi

# prompt VAR "message" "default" — reads one line from the controlling terminal.
# Falls back to the default when there is no tty or the user just hits enter.
prompt() {
    local _var="$1" _msg="$2" _default="${3:-}" _reply=""
    if [ "${HAVE_TTY}" -eq 1 ]; then
        printf "%s" "${_msg}" > /dev/tty
        IFS= read -r _reply < /dev/tty || _reply=""
    fi
    [ -z "${_reply}" ] && _reply="${_default}"
    printf -v "${_var}" '%s' "${_reply}"
}

install_docker() {
    say "Docker not found — installing via official convenience script."
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
    sh /tmp/get-docker.sh
    rm -f /tmp/get-docker.sh
    systemctl enable docker
    systemctl start docker
}

ensure_docker() {
    if ! command -v docker >/dev/null 2>&1; then
        install_docker
    fi
    if ! docker compose version >/dev/null 2>&1; then
        die "Docker is installed but 'docker compose' v2 is not available. Upgrade Docker."
    fi
    say "Docker $(docker --version | awk '{print $3}' | tr -d ',') OK"
}

# True when this host already carries a deployment: either the compose file is
# on disk or containers named cybersentineldlp-* exist (running or stopped).
is_installed() {
    if [ -f "${INSTALL_DIR}/${COMPOSE_FILE}" ]; then
        return 0
    fi
    if command -v docker >/dev/null 2>&1 \
        && docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^cybersentineldlp-'; then
        return 0
    fi
    return 1
}

status_summary() {
    _top "Current state"
    _bar ""
    if is_installed; then
        _bar "${C_GREEN}●${C_RESET}  ${C_BOLD}Existing installation detected${C_RESET}"
        _bar "   ${C_GREY}dir     ${C_RESET} ${INSTALL_DIR}"
        if [ -f "${INSTALL_DIR}/${COMPOSE_FILE}" ] && command -v docker >/dev/null 2>&1; then
            local running
            running="$( (cd "${INSTALL_DIR}" 2>/dev/null && docker compose -f "${COMPOSE_FILE}" ps -q 2>/dev/null | wc -l | tr -d ' ') || echo 0)"
            _bar "   ${C_GREY}running ${C_RESET} ${running} container(s)"
        fi
        local ver
        ver="$(curl -fsS http://localhost:55100/health 2>/dev/null | grep -oE '"version":"[^"]+"' | head -1 | cut -d'"' -f4 || true)"
        if [ -n "${ver}" ]; then
            _bar "   ${C_GREY}api     ${C_RESET} ${C_GREEN}healthy${C_RESET} ${C_DIM}(v${ver})${C_RESET}"
        else
            _bar "   ${C_GREY}api     ${C_RESET} ${C_YELLOW}not responding on :55100${C_RESET}"
        fi
    else
        _bar "${C_YELLOW}●${C_RESET}  No existing installation"
        _bar "   ${C_GREY}dir     ${C_RESET} ${C_DIM}${INSTALL_DIR} (empty)${C_RESET}"
    fi
    _bar ""
    _end
    echo
}

# Wait (≈3 min) for the manager API to report healthy. Returns non-zero on timeout.
wait_manager_health() {
    say "Waiting for the manager API to come up (max ~3 minutes)"
    local i
    for i in $(seq 1 90); do
        if curl -fsS http://localhost:55100/health >/dev/null 2>&1; then
            echo; return 0
        fi
        sleep 2
        printf "."
    done
    echo
    return 1
}

# ══════════════════════════════════════════════════════════════════════
#  ACTION: INSTALL  (fresh install or idempotent re-apply)
# ══════════════════════════════════════════════════════════════════════
# NOTE: the body below is intentionally left un-indented so the embedded
# heredocs (WRAP / ROT) keep their closing markers at column 0.
do_install() {
c_blue "── Install ───────────────────────────────────────────────────"
say "Repository : ${GITHUB_REPO} (branch ${GITHUB_BRANCH})"
say "Install dir: ${INSTALL_DIR}"
echo

# ─── 1. Ensure Docker ─────────────────────────────────────────────────
ensure_docker

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

# Fetch the validation script NOW, in the same healthy network window as the
# files above — NOT after the long image pull, during which DNS/network can drop
# (as seen in the field). It only runs later (section 8c); running it needs no
# internet. Non-fatal: validation is optional, so a miss here never aborts.
say "Downloading validate.sh"
if curl -fsSL --retry 4 --retry-delay 2 --retry-all-errors --connect-timeout 15 \
        "${RAW_BASE}/validate.sh" -o "${INSTALL_DIR}/validate.sh"; then
    chmod +x "${INSTALL_DIR}/validate.sh"
else
    c_yellow "[!] Could not download validate.sh now — will retry after startup."
    rm -f "${INSTALL_DIR}/validate.sh"
fi

# csdlp — the single operations CLI (status/doctor/logs/update/rollback/backup).
# Installed to the deployment dir and symlinked onto PATH so `csdlp` works anywhere.
say "Downloading csdlp (operations CLI)"
if curl -fsSL --retry 4 --retry-delay 2 --retry-all-errors --connect-timeout 15 \
        "${RAW_BASE}/csdlp" -o "${INSTALL_DIR}/csdlp"; then
    chmod +x "${INSTALL_DIR}/csdlp"
    ln -sf "${INSTALL_DIR}/csdlp" /usr/local/bin/csdlp 2>/dev/null \
        && say "csdlp installed — run 'csdlp help'" \
        || c_yellow "[!] csdlp saved to ${INSTALL_DIR}/csdlp (could not symlink to /usr/local/bin)"
else
    c_yellow "[!] Could not download csdlp now — fetch later: curl -fsSL ${RAW_BASE}/csdlp -o ${INSTALL_DIR}/csdlp"
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
        # The dashboard nginx runs as the unprivileged `nginx` user (UID/GID 101
        # in nginx:alpine) and mounts privkey.pem read-only. A root:root 600 key
        # is unreadable to that user, so nginx aborts with "cannot load
        # certificate key ... Permission denied" and crash-loops. Group-own the
        # key to GID 101 and make it group-readable so the container can read it.
        # The certs/ dir stays 700-root, so the key is still not exposed to
        # non-root users on the host. (If you swap nginx base images, update 101.)
        chown root:101 "${INSTALL_DIR}/certs/privkey.pem" "${INSTALL_DIR}/certs/fullchain.pem"
        chmod 640 "${INSTALL_DIR}/certs/privkey.pem"
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
if ! wait_manager_health; then
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
# validate.sh was fetched up-front (section 3). If it's missing — because the
# network dropped during the image pull — make one more attempt now; running it
# itself needs no internet (docker + curl to localhost only).
if [ ! -x "${INSTALL_DIR}/validate.sh" ]; then
    say "Fetching validate.sh (deferred from earlier)"
    curl -fsSL --retry 4 --retry-delay 2 --retry-all-errors --connect-timeout 15 \
        "${RAW_BASE}/validate.sh" -o "${INSTALL_DIR}/validate.sh" 2>/dev/null \
        && chmod +x "${INSTALL_DIR}/validate.sh" || true
fi

if [ -x "${INSTALL_DIR}/validate.sh" ]; then
    echo
    say "Running post-install validation"
    if bash "${INSTALL_DIR}/validate.sh" --container cybersentineldlp-manager --url http://localhost:55100; then
        say "Validation passed"
    else
        c_yellow "[!] One or more validation checks did not pass. The stack is up, but"
        c_yellow "    review the output above. Re-run any time:"
        c_yellow "      sudo bash ${INSTALL_DIR}/validate.sh"
    fi
    echo
else
    c_yellow "[!] validate.sh unavailable (network was down) — skipping automated validation."
    c_yellow "    Run it manually once the network settles:"
    c_yellow "      curl -fsSL ${RAW_BASE}/validate.sh -o ${INSTALL_DIR}/validate.sh && sudo bash ${INSTALL_DIR}/validate.sh"
fi

# ─── 8d. Auto-update (hourly image pull) ──────────────────────────────
# Keeps this deployment current: an hourly cron pulls the latest manager +
# dashboard images from GHCR (rebuilt by CI on every push) and recreates ONLY
# those services when the image actually changed — the data tier is never
# touched. Default ON so a fresh deploy stays up to date; disable with
# AUTO_UPDATE=0 if you want pinned / manually-controlled updates (recommended
# for production that must gate every change).
#
# NOTE: this does NOT enable the dev-policy mirror (DLP_SEED_EXPORTED_POLICIES);
# that stays opt-in via install-mirror-autopull.sh, so client installs keep only
# the curated default policies.
if [ "${AUTO_UPDATE:-1}" != "0" ]; then
    AP_WRAPPER="${INSTALL_DIR}/auto-pull.sh"
    AP_LOG="/var/log/cybersentineldlp-autopull.log"
    AP_SERVICES="${AUTO_UPDATE_SERVICES:-manager dashboard}"
    AP_MINUTE="${AUTO_UPDATE_MINUTE:-37}"
    say "Installing hourly auto-update (image pull) — disable with AUTO_UPDATE=0"
    cat > "${AP_WRAPPER}" <<WRAP
#!/usr/bin/env bash
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
cd "${INSTALL_DIR}" || exit 1
echo "===== autopull \$(date -Is 2>/dev/null || date) ====="
# Retry the pull — large GHCR layers can drop mid-download ("unexpected EOF").
# Completed layers are cached so each retry resumes. If it never completes we
# skip up -d and leave the running containers untouched (no recreate onto a
# half-pulled image); the next run retries.
tries=0
until docker compose -f "${COMPOSE_FILE}" pull ${AP_SERVICES}; do
  tries=\$((tries+1))
  if [ \$tries -ge 5 ]; then
    echo "pull still failing after \$tries attempts — leaving containers as-is; will retry next run"
    echo "===== done (pull failed) \$(date -Is 2>/dev/null || date) ====="
    exit 1
  fi
  echo "pull interrupted — retry \$tries/5 in 30s (cached layers resume)"
  sleep 30
done
docker compose -f "${COMPOSE_FILE}" up -d ${AP_SERVICES}
echo "===== done \$(date -Is 2>/dev/null || date) ====="
WRAP
    chmod +x "${AP_WRAPPER}"
    touch "${AP_LOG}"
    _cron_tmp="$(mktemp)"
    crontab -l 2>/dev/null | grep -vE "auto-pull\.sh|CyberSentinel DLP — auto-update" > "${_cron_tmp}" || true
    grep -q '^MAILTO=' "${_cron_tmp}" || printf 'MAILTO=""\n' >> "${_cron_tmp}"
    printf '%s\n%s %s\n' "# CyberSentinel DLP — auto-update (hourly image pull)" \
        "${AP_MINUTE} * * * *" "${AP_WRAPPER} >> ${AP_LOG} 2>&1" >> "${_cron_tmp}"
    crontab "${_cron_tmp}" && rm -f "${_cron_tmp}"
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
    say "Auto-update installed (hourly at minute ${AP_MINUTE}). Log: ${AP_LOG}"
else
    say "Auto-update disabled (AUTO_UPDATE=0) — update manually: docker compose -f ${COMPOSE_FILE} pull && up -d"
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
echo "  Dashboard   : https://${HOST_IP}:${DASH_PORT}/  (TLS 1.3 + HTTP/2)"
echo "  Manager API : http://${HOST_IP}:55100"
echo "  API Docs    : http://${HOST_IP}:55100/api/v1/docs"
echo "  Health probe: http://${HOST_IP}:55100/health"
echo
c_yellow "  NOTE: The dashboard serves HTTPS (TLS 1.3 + HTTP/2) directly on"
c_yellow "        port ${DASH_PORT} — the same port as before, now TLS. It uses the"
c_yellow "        self-signed certs in ${INSTALL_DIR}/certs/, so browsers will warn"
c_yellow "        until you replace them with a CA-issued cert (drop your own"
c_yellow "        fullchain.pem / privkey.pem there and recreate the dashboard),"
c_yellow "        or front the deployment with Caddy / Traefik + Let's Encrypt."
c_yellow "        Old http://${HOST_IP}:${DASH_PORT} links auto-redirect to HTTPS."
c_yellow "        Endpoint agents are unaffected — they talk directly to the"
c_yellow "        manager on :55100."
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
echo "  csdlp status                                               # health + versions"
echo "  csdlp logs manager -f                                      # follow manager logs"
echo "  docker compose -f ${INSTALL_DIR}/${COMPOSE_FILE} ps"
echo "  docker compose -f ${INSTALL_DIR}/${COMPOSE_FILE} down       # stop everything"
if [ "${AUTO_UPDATE:-1}" != "0" ]; then
echo "  tail -f /var/log/cybersentineldlp-autopull.log             # hourly auto-update log"
echo "  crontab -e   # edit/disable the auto-update schedule (or reinstall with AUTO_UPDATE=0)"
fi
echo
c_blue "Next: install agents on endpoints (run on Windows boxes):"
echo "  powershell -ExecutionPolicy Bypass -Command \"irm ${RAW_BASE}/manage-windows-agent.ps1 | iex\""
echo
}
# ── end do_install ────────────────────────────────────────────────────

# ══════════════════════════════════════════════════════════════════════
#  ACTION: UPDATE  (pull latest images, refresh compose/CLI, migrate)
# ══════════════════════════════════════════════════════════════════════
# Never touches .env, certs, or data volumes.
do_update() {
    c_blue "── Update ────────────────────────────────────────────────────"
    if [ ! -f "${INSTALL_DIR}/${COMPOSE_FILE}" ]; then
        die "No installation found at ${INSTALL_DIR} — choose Install first."
    fi
    ensure_docker
    cd "${INSTALL_DIR}"
    say "Updating deployment in ${INSTALL_DIR}"

    # Refresh the compose file + helper tools from the repo — an update may ship
    # compose changes (new service, new env var). .env and certs are left alone.
    say "Refreshing ${COMPOSE_FILE}"
    if curl -fsSL --retry 4 --retry-delay 2 --retry-all-errors --connect-timeout 15 \
            "${RAW_BASE}/${COMPOSE_FILE}" -o "${COMPOSE_FILE}.new"; then
        mv "${COMPOSE_FILE}.new" "${COMPOSE_FILE}"
    else
        rm -f "${COMPOSE_FILE}.new"
        c_yellow "[!] Could not refresh ${COMPOSE_FILE} — keeping the existing one."
    fi

    for f in csdlp validate.sh; do
        if curl -fsSL --retry 4 --retry-delay 2 --retry-all-errors --connect-timeout 15 \
                "${RAW_BASE}/${f}" -o "${INSTALL_DIR}/${f}.new" 2>/dev/null; then
            mv "${INSTALL_DIR}/${f}.new" "${INSTALL_DIR}/${f}"
            chmod +x "${INSTALL_DIR}/${f}"
        else
            rm -f "${INSTALL_DIR}/${f}.new"
        fi
    done
    ln -sf "${INSTALL_DIR}/csdlp" /usr/local/bin/csdlp 2>/dev/null || true

    say "Pulling latest images from ghcr.io/${GITHUB_REPO} ..."
    docker compose -f "${COMPOSE_FILE}" pull

    say "Recreating services with the new images"
    docker compose -f "${COMPOSE_FILE}" up -d --remove-orphans

    if ! wait_manager_health; then
        c_red "[!] Manager API did not become healthy within 3 minutes after the update."
        c_red "    Check: docker compose -f ${INSTALL_DIR}/${COMPOSE_FILE} logs manager"
        c_red "    Roll back if needed:  csdlp rollback"
        return 1
    fi

    # This IS an upgrade path — apply any migrations the new image ships.
    say "Applying database migrations (alembic upgrade head)"
    if docker exec cybersentineldlp-manager alembic upgrade head >/dev/null 2>&1; then
        say "Migrations applied (or already up to date)"
    else
        c_yellow "[!] 'alembic upgrade head' reported an issue — inspect with:"
        c_yellow "      docker exec cybersentineldlp-manager alembic current"
    fi

    local ver
    ver="$(curl -fsS http://localhost:55100/health 2>/dev/null | grep -oE '"version":"[^"]+"' | head -1 | cut -d'"' -f4 || true)"
    echo
    c_green "================================================================"
    c_green "  Update Complete${ver:+  —  version ${ver}}"
    c_green "================================================================"
    local host_ip dash_port
    host_ip="$(hostname -I 2>/dev/null | awk '{print $1}' || echo localhost)"
    dash_port=$(grep -E '^DASHBOARD_HOST_PORT=' "${INSTALL_DIR}/${ENV_FILE}" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'" | head -1)
    dash_port="${dash_port:-3023}"
    echo "  Dashboard : https://${host_ip}:${dash_port}/"
    echo "  Verify    : csdlp status"
    echo
}

# ══════════════════════════════════════════════════════════════════════
#  ACTION: DELETE  (stop + remove the deployment; optional data wipe)
# ══════════════════════════════════════════════════════════════════════
do_delete() {
    c_blue "── Delete ────────────────────────────────────────────────────"
    if ! is_installed; then
        c_yellow "No installation found at ${INSTALL_DIR} — nothing to delete."
        return 0
    fi

    c_red "This STOPS and REMOVES the CyberSentinel DLP deployment on this host."
    local ans
    prompt ans "Proceed? [y/N]: " "N"
    case "${ans}" in
        y|Y|yes|YES) ;;
        *) say "Delete cancelled."; return 0 ;;
    esac

    # Data-volume wipe is a separate, explicit confirmation — this is the only
    # irreversible part (destroys all events/incidents/policies/config).
    local rmvol
    prompt rmvol "Also DELETE all data volumes (postgres, mongodb, opensearch, redis, ml-models)? This DESTROYS ALL DLP DATA. [y/N]: " "N"

    # Image removal — reclaims the several GB install.sh pulled. Off by default so
    # a reinstall stays fast; note base images (postgres/mongo/redis/opensearch)
    # may be shared with other stacks on this host.
    local rmimg
    prompt rmimg "Also remove the downloaded Docker images (manager/dashboard/relay + postgres/mongo/redis/opensearch)? [y/N]: " "N"

    if [ -f "${INSTALL_DIR}/${COMPOSE_FILE}" ] && command -v docker >/dev/null 2>&1; then
        cd "${INSTALL_DIR}"
        # Build the down flags from the operator's choices: containers + network
        # always; volumes and images on request. Doing it in one `down` keeps the
        # compose project the single source of truth for what to remove.
        local down_flags=(--remove-orphans)
        case "${rmvol}" in y|Y|yes|YES) down_flags+=(-v);        say "Stopping the stack and removing data volumes" ;; *) say "Stopping the stack (keeping data volumes)" ;; esac
        case "${rmimg}" in y|Y|yes|YES) down_flags+=(--rmi all); say "Images will also be removed" ;; esac
        docker compose -f "${COMPOSE_FILE}" down "${down_flags[@]}" || true
    elif command -v docker >/dev/null 2>&1; then
        # No compose file but tagged containers exist — remove them by name.
        say "Removing cybersentineldlp-* containers"
        docker ps -a --format '{{.Names}}' 2>/dev/null | grep '^cybersentineldlp-' \
            | xargs -r docker rm -f >/dev/null 2>&1 || true
        # Fallback image removal (no compose): drop just the GHCR app images by
        # repository match — base images are left alone to avoid nuking shared ones.
        case "${rmimg}" in
            y|Y|yes|YES)
                say "Removing CyberSentinel DLP app images"
                docker images --format '{{.ID}} {{.Repository}}' 2>/dev/null \
                    | awk '/cybersentineldlp-prod/{print $1}' | sort -u \
                    | xargs -r docker rmi -f >/dev/null 2>&1 || true
                ;;
        esac
    fi

    # System footprint the installer added: auto-update cron, logrotate rule,
    # its log file, and the csdlp symlink.
    say "Removing auto-update cron entry, logrotate rule, log, and csdlp symlink"
    local _cron_tmp
    _cron_tmp="$(mktemp)"
    crontab -l 2>/dev/null | grep -vE "auto-pull\.sh|CyberSentinel DLP — auto-update" > "${_cron_tmp}" || true
    crontab "${_cron_tmp}" 2>/dev/null || true
    rm -f "${_cron_tmp}"
    rm -f /etc/logrotate.d/cybersentineldlp-autopull
    rm -f /var/log/cybersentineldlp-autopull.log
    rm -f /usr/local/bin/csdlp

    # Optionally remove the install directory (compose, .env, certs, backups).
    local rmdir
    prompt rmdir "Remove the install directory ${INSTALL_DIR} (compose, .env, certs, backups)? [y/N]: " "N"
    case "${rmdir}" in
        y|Y|yes|YES)
            case "${INSTALL_DIR}" in
                ""|/|/root|/home|/etc|/usr|/var|/bin|/sbin|/lib|/boot)
                    c_red "Refusing to 'rm -rf ${INSTALL_DIR}' — remove it manually if you really mean to."
                    ;;
                *)
                    # Warn about the stale-volume trap: removing .env while KEEPING
                    # volumes means a future install mints new passwords the old
                    # volumes will reject.
                    case "${rmvol}" in
                        y|Y|yes|YES) : ;;
                        *) c_yellow "[!] You kept the data volumes but are deleting ${ENV_FILE}. A future"
                           c_yellow "    reinstall will generate NEW passwords the old volumes will reject."
                           c_yellow "    Back up ${INSTALL_DIR}/${ENV_FILE} now if you intend to reinstall." ;;
                    esac
                    rm -rf "${INSTALL_DIR}"
                    say "Removed ${INSTALL_DIR}"
                    ;;
            esac
            ;;
        *)
            say "Kept ${INSTALL_DIR} (its ${ENV_FILE} + certs remain)."
            ;;
    esac

    echo
    c_green "Delete complete."
    _bar "${C_GREY}containers/network${C_RESET}  removed"
    case "${rmvol}" in
        y|Y|yes|YES) _bar "${C_GREY}data volumes      ${C_RESET}  ${C_RED}removed (data destroyed)${C_RESET}" ;;
        *)           _bar "${C_GREY}data volumes      ${C_RESET}  kept — reinstall reuses them (keep ${ENV_FILE})" ;;
    esac
    case "${rmimg}" in
        y|Y|yes|YES) _bar "${C_GREY}docker images     ${C_RESET}  removed" ;;
        *)           _bar "${C_GREY}docker images     ${C_RESET}  kept (faster reinstall)" ;;
    esac
    _bar "${C_GREY}docker engine     ${C_RESET}  ${C_DIM}left installed — shared component, remove via your package manager if desired${C_RESET}"
    echo
}

# ══════════════════════════════════════════════════════════════════════
#  Menu / entrypoint
# ══════════════════════════════════════════════════════════════════════
# menu item:  _mi KEY COLOR NAME DESC
_mi() {
    printf '  %s│%s   %s%s[%s]%s  %s%-8s%s %s%s%s\n' \
        "${C_GREY}" "${C_RESET}" "${C_BOLD}" "$2" "$1" "${C_RESET}" \
        "$2" "$3" "${C_RESET}" "${C_GREY}" "$4" "${C_RESET}"
}

main_menu() {
    status_summary
    local default_hint choice
    if is_installed; then
        default_hint="2"   # existing install → Update is the natural default
    else
        default_hint="1"   # nothing here yet → Install
    fi

    while true; do
        _top "Choose an action"
        _bar ""
        _mi 1 "${C_GREEN}"  "Install" "fresh install (or safely re-apply)"
        _mi 2 "${C_CYAN}"   "Update"  "pull latest images + apply migrations"
        _mi 3 "${C_YELLOW}" "Delete"  "stop & remove (optionally wipe data)"
        _mi 4 "${C_GREY}"   "Exit"    "quit without making changes"
        _bar ""
        _end
        echo
        prompt choice "  ${C_BOLD}➜${C_RESET}  Enter choice ${C_DIM}[1-4, default ${default_hint}]${C_RESET}: " "${default_hint}"
        echo
        case "${choice}" in
            1) do_install; return 0 ;;
            2) do_update;  return 0 ;;
            3) do_delete;  return 0 ;;
            4|q|Q|exit) say "Nothing to do — bye."; return 0 ;;
            *) c_yellow "Invalid choice: '${choice}'. Enter 1, 2, 3, or 4."; echo ;;
        esac
    done
}

# ─── Entry ────────────────────────────────────────────────────────────
clear 2>/dev/null || true
banner
say "Repository  ${C_DIM}${GITHUB_REPO} (${GITHUB_BRANCH})${C_RESET}"
say "Install dir ${C_DIM}${INSTALL_DIR}${C_RESET}"
say "No source code is deployed — only the compose file and .env."

require_root

if [ "${HAVE_TTY}" -eq 1 ]; then
    main_menu
else
    # No terminal (CI/cron pipe): keep the classic unattended behaviour.
    if is_installed; then
        say "No interactive terminal detected — UPDATING the existing install."
        do_update
    else
        say "No interactive terminal detected — performing a fresh INSTALL."
        do_install
    fi
fi
