#!/usr/bin/env bash
#
# CyberSentinel DLP — Server uninstaller.
#
# Stops and removes the CyberSentinel DLP stack. By default it keeps your data
# (Postgres/Mongo/OpenSearch/Redis volumes) so you can reinstall over it. Pass
# --purge to also delete the volumes and the install directory — that is
# IRREVERSIBLE and wipes events, agents, policies and users.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/effaaykhan/cybersentineldlp-prod/main/uninstall.sh | sudo bash
#   curl -fsSL .../uninstall.sh | sudo bash -s -- --purge          # also delete all data
#   sudo INSTALL_DIR=/srv/cybersentineldlp bash uninstall.sh       # custom dir
#
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/cybersentineldlp}"
COMPOSE_FILE="docker-compose.prod.yml"
PURGE=0
ASSUME_YES=0
for arg in "$@"; do
    case "$arg" in
        --purge) PURGE=1 ;;
        --yes|-y) ASSUME_YES=1 ;;
        *) echo "Unknown option: $arg" >&2; exit 2 ;;
    esac
done

c_blue()   { printf "\033[1;34m%s\033[0m\n" "$*"; }
c_green()  { printf "\033[1;32m%s\033[0m\n" "$*"; }
c_yellow() { printf "\033[1;33m%s\033[0m\n" "$*"; }
c_red()    { printf "\033[1;31m%s\033[0m\n" "$*" >&2; }
say()      { printf "[+] %s\n" "$*"; }
die()      { c_red "[FATAL] $*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run as root (sudo)."

c_blue "================================================================"
c_blue "  CyberSentinel DLP — Server Uninstaller"
c_blue "================================================================"
echo
say "Install dir: ${INSTALL_DIR}"
if [ "$PURGE" -eq 1 ]; then
    c_red   "Mode:        PURGE — containers, volumes (ALL DATA) and ${INSTALL_DIR} will be DELETED"
else
    say     "Mode:        stop & remove containers; data volumes are KEPT (use --purge to delete them)"
fi
echo

# Locate the compose file. Fall back to `docker compose ls` if the install dir
# was moved, so we can still bring the project down.
COMPOSE_PATH="${INSTALL_DIR}/${COMPOSE_FILE}"
if [ ! -f "$COMPOSE_PATH" ]; then
    c_yellow "[!] ${COMPOSE_PATH} not found."
    ALT="$(docker compose ls --all 2>/dev/null | awk '/cybersentineldlp/ {print $NF; exit}')"
    if [ -n "${ALT:-}" ] && [ -f "$ALT" ]; then
        COMPOSE_PATH="$ALT"
        say "Using discovered compose file: $COMPOSE_PATH"
    else
        c_yellow "[!] No compose file found; will fall back to removing containers/volumes by name."
        COMPOSE_PATH=""
    fi
fi

# Confirmation gate for the destructive path.
if [ "$PURGE" -eq 1 ] && [ "$ASSUME_YES" -ne 1 ]; then
    c_red "This will PERMANENTLY DELETE all CyberSentinel DLP data on this host."
    printf "Type the word DELETE to proceed: "
    read -r reply </dev/tty || die "No terminal for confirmation; re-run with --yes to skip the prompt."
    [ "$reply" = "DELETE" ] || die "Aborted — nothing was changed."
fi

# Bring the stack down.
DOWN_ARGS=""
[ "$PURGE" -eq 1 ] && DOWN_ARGS="--volumes"
if [ -n "$COMPOSE_PATH" ]; then
    say "Stopping and removing containers${DOWN_ARGS:+ + volumes} ..."
    docker compose -f "$COMPOSE_PATH" down $DOWN_ARGS --remove-orphans || true
else
    # No compose file: remove by the project's container/volume name prefix.
    say "Removing containers by name ..."
    docker ps -aq --filter "name=cybersentineldlp" | xargs -r docker rm -f || true
    if [ "$PURGE" -eq 1 ]; then
        say "Removing volumes by name ..."
        docker volume ls -q | grep -iE 'cybersentineldlp' | xargs -r docker volume rm || true
    fi
fi

# Purge also removes leftover named volumes the compose down might miss, the
# network, and the install directory.
if [ "$PURGE" -eq 1 ]; then
    say "Removing any remaining CyberSentinel DLP volumes ..."
    docker volume ls -q | grep -iE 'cybersentineldlp' | xargs -r docker volume rm || true
    docker network ls -q --filter "name=cybersentineldlp" | xargs -r docker network rm 2>/dev/null || true
    if [ -d "$INSTALL_DIR" ]; then
        say "Deleting ${INSTALL_DIR} ..."
        rm -rf "$INSTALL_DIR"
    fi
fi

echo
if [ "$PURGE" -eq 1 ]; then
    c_green "CyberSentinel DLP fully removed — containers, data volumes and ${INSTALL_DIR} deleted."
else
    c_green "CyberSentinel DLP stopped and removed. Data volumes were KEPT."
    say "Reinstall over the existing data:  curl -fsSL https://raw.githubusercontent.com/effaaykhan/cybersentineldlp-prod/main/install.sh | sudo bash"
    say "Delete the data later:             sudo bash uninstall.sh --purge"
fi
echo
