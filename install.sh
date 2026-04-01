#!/bin/bash
set -e

REPO="https://github.com/effaaykhan/cybersentineldlp-prod.git"
DIR="cybersentineldlp-prod"

echo ""
echo "  CyberSentinel DLP — Server Installation"
echo "  ========================================="
echo ""

# Prerequisites
command -v docker &>/dev/null || { echo "[ERROR] Docker not installed."; exit 1; }
command -v python3 &>/dev/null || { echo "[ERROR] Python3 not installed."; exit 1; }
docker compose version &>/dev/null 2>&1 || { echo "[ERROR] Docker Compose v2 required."; exit 1; }
echo "[+] Prerequisites OK"

# Clone or update
if [ -d "$DIR" ]; then
  echo "[+] Updating existing installation..."
  cd "$DIR" && git pull --ff-only 2>/dev/null || true
else
  echo "[+] Cloning repository..."
  git clone "$REPO"
  cd "$DIR"
fi

# Generate .env with secure random passwords
if [ ! -f .env ]; then
  echo "[+] Generating .env with secure passwords..."
  python3 -c "
import secrets
s = secrets.token_urlsafe
c = open('.env.example').read()
c = c.replace('change-this-to-a-random-secret-key-min-32-chars', s(48))
c = c.replace('change-this-to-a-random-jwt-secret-min-32-chars', s(48))
c = c.replace('change-this-to-a-random-encryption-key', s(48))
c = c.replace('change-this-strong-postgres-password', s(24))
c = c.replace('change-this-strong-mongodb-password', s(24))
c = c.replace('change-this-strong-redis-password', s(24))
c = c.replace('change-this-strong-opensearch-password', s(24))
open('.env', 'w').write(c)
"
  echo "[+] .env created"
else
  echo "[+] .env exists, skipping"
fi

# Pull and start
echo "[+] Pulling images and starting services..."
docker compose -f docker-compose.prod.yml pull 2>/dev/null || true
docker compose -f docker-compose.prod.yml up -d

# Wait for health
echo "[+] Waiting for server to start..."
for i in $(seq 1 90); do
  if curl -sf http://localhost:55000/health &>/dev/null; then
    break
  fi
  sleep 2
  printf "."
done
echo ""

# Result
if curl -sf http://localhost:55000/health &>/dev/null; then
  IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")
  PASS=$(docker logs cybersentinel-manager 2>&1 | grep "generated_password" | head -1 | \
    python3 -c "import sys,json;print(json.loads(sys.stdin.read()).get('generated_password',''))" 2>/dev/null \
    || echo "")
  echo ""
  echo "  Installation Complete"
  echo "  ====================="
  echo "  Dashboard:  http://${IP}:4000"
  echo "  API:        http://${IP}:55000"
  echo "  API Docs:   http://${IP}:55000/api/v1/docs"
  echo ""
  echo "  Username:   admin"
  [ -n "$PASS" ] && echo "  Password:   ${PASS}" || echo "  Password:   docker logs cybersentinel-manager 2>&1 | grep generated_password"
  echo ""
  echo "  You must change this password on first login."
  echo ""
else
  echo ""
  echo "[ERROR] Server not healthy after 3 minutes."
  echo "  Check logs: docker compose -f docker-compose.prod.yml logs manager"
  exit 1
fi
