# Multi-stage build for production-ready Vite dashboard

# Stage 1: Build the application
FROM node:18-slim AS builder

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies. Use `npm ci` when a lockfile is present (strict,
# reproducible) and fall back to `npm install` if the lockfile has not
# yet been committed. Both use --no-audit/--no-fund for quieter CI.
RUN if [ -f package-lock.json ]; then \
        npm ci --no-audit --no-fund; \
    else \
        npm install --no-audit --no-fund; \
    fi

# Copy application source
COPY . .

# Accept build arguments for Vite environment variables
# VITE_API_URL intentionally defaults to empty so the app uses relative "/api/v1"
# paths at runtime, which the nginx reverse proxy forwards to the backend.
# Override only for non-proxied setups: --build-arg VITE_API_URL=http://host:55100/api/v1
ARG VITE_API_URL=
ARG VITE_WS_URL=
ARG VITE_APP_NAME=CyberSentinel DLP
ARG VITE_APP_VERSION=2.0.0

# Set environment variables for build
ENV NODE_ENV=production
ENV VITE_API_URL=${VITE_API_URL}
ENV VITE_WS_URL=${VITE_WS_URL}
ENV VITE_APP_NAME=${VITE_APP_NAME}
ENV VITE_APP_VERSION=${VITE_APP_VERSION}

# Build application
RUN npm run build

# Production image with nginx
FROM nginx:alpine AS runner

# openssl is needed by the entrypoint to generate a self-signed TLS cert when
# no real one is mounted, so the TLS 1.3 / HTTP/2 listener always comes up.
RUN apk add --no-cache openssl

# Copy nginx configuration (main conf + shared server-body snippet)
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY snippets/dashboard-app.conf /etc/nginx/snippets/dashboard-app.conf

# Container entrypoint: ensures /etc/nginx/ssl holds a cert before nginx starts.
COPY docker-entrypoint.sh /usr/local/bin/dashboard-entrypoint.sh
RUN chmod +x /usr/local/bin/dashboard-entrypoint.sh

# Copy built files
COPY --from=builder /app/dist /usr/share/nginx/html

# Drop privileges — run nginx as the unprivileged `nginx` user that the
# official image already ships with. nginx:alpine's default /etc/nginx/
# nginx.conf has `user  nginx;` so the worker processes already drop
# privs, but the master runs as root. nginx binds the unprivileged port 3000
# (where it terminates TLS 1.3 + HTTP/2) and runs the master as `nginx` too.
#
# /etc/nginx/ssl is created and chowned to nginx so the entrypoint's
# self-signed fallback can write the cert there when none is mounted. The
# /var/cache/nginx, /var/run, and /var/log/nginx directories must be writable
# by the nginx user — the base image already chowns them.
RUN mkdir -p /etc/nginx/ssl \
 && touch /var/run/nginx.pid \
 && chown -R nginx:nginx /etc/nginx/ssl /var/cache/nginx /var/run/nginx.pid /var/log/nginx /usr/share/nginx/html

USER nginx

# Expose the single unprivileged port nginx listens on: 3000 (HTTPS/TLS 1.3).
EXPOSE 3000

# Ensure a TLS cert exists, then run nginx in the foreground.
ENTRYPOINT ["/usr/local/bin/dashboard-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
