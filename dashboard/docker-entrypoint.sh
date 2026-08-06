#!/bin/sh
# Dashboard container entrypoint.
#
# Ensures a TLS certificate exists at /etc/nginx/ssl/ before nginx starts, then
# hands off to the stock nginx entrypoint. This runs as the unprivileged `nginx`
# user (the Dockerfile sets USER nginx), and /etc/nginx/ssl is chowned to nginx
# in the image, so the self-signed fallback can write there.
#
# Precedence:
#   1. Real certs bind-mounted at /etc/nginx/ssl/{fullchain,privkey}.pem
#      (e.g. docker-compose.prod.yml) — used as-is, never overwritten.
#   2. Nothing mounted — a self-signed pair is generated on first start so the
#      TLS 1.3 / HTTP/2 listener always comes up. Replace with real certs for
#      production; mount a persistent volume at /etc/nginx/ssl to keep the same
#      self-signed cert across container recreation.
set -e

SSL_DIR=/etc/nginx/ssl
CRT="$SSL_DIR/fullchain.pem"
KEY="$SSL_DIR/privkey.pem"

if [ ! -s "$CRT" ] || [ ! -s "$KEY" ]; then
    echo "[entrypoint] No TLS certificate found at $SSL_DIR — generating a self-signed pair (replace with a real cert for production)."
    if command -v openssl >/dev/null 2>&1; then
        mkdir -p "$SSL_DIR"
        openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
            -keyout "$KEY" -out "$CRT" \
            -subj "/CN=cybersentineldlp.local/O=CyberSentinel DLP/OU=self-signed" \
            -addext "subjectAltName=DNS:cybersentineldlp.local,DNS:localhost,IP:127.0.0.1" \
            -addext "keyUsage=digitalSignature,keyEncipherment" \
            -addext "extendedKeyUsage=serverAuth" \
            >/dev/null 2>&1 \
            && echo "[entrypoint] Self-signed certificate generated." \
            || echo "[entrypoint] WARNING: openssl failed to generate a certificate; the HTTPS listener will not start."
    else
        echo "[entrypoint] WARNING: openssl not available; cannot generate a certificate. The HTTPS listener will not start."
    fi
fi

# Delegate to the stock nginx entrypoint, which execs the CMD (nginx).
exec /docker-entrypoint.sh "$@"
