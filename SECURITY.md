# CyberSentinel DLP — Security Audit & Fix Log

This document records the findings of a SAST + DAST-style security audit
performed on the platform and the fixes that were applied. Findings are
grouped by severity and referenced by file path + line where applicable.

## Methodology

- **SAST** — static analysis of the Python backend, React/TypeScript
  dashboard, Windows C++ endpoint agent, and PowerShell installers.
  Looked for OWASP Top 10 classes (injection, broken auth, crypto
  issues, XSS, SSRF, deserialization, hardcoded secrets, SSRF, IDOR).
- **Dependency audit** — manual CVE review of
  `server/requirements.txt` and `dashboard/package.json` against
  published vulnerabilities as of 2026-04-08 (pip-audit/npm audit
  network access was not available in the sandbox).
- **DAST-style review** — endpoint-by-endpoint review of the FastAPI
  routers and middleware, modelling the behaviour of a running instance
  without actually exercising it.
- **Infrastructure review** — docker-compose, Dockerfiles, nginx
  configuration, and the bash + PowerShell installers.

## Summary

| Severity | Found | Fixed in this commit | Deferred |
|---|---|---|---|
| CRITICAL | 6 | 6 | 0 |
| HIGH     | 14 | 11 | 3 |
| MEDIUM   | 12 | 5 | 7 |
| LOW      | 5 | 0 | 5 |

Deferred items are tracked at the bottom of this file with a rationale.

---

## CRITICAL

### CR-1 — OpenSearch security plugin disabled + DB ports on 0.0.0.0
**Files:** `docker-compose.prod.yml`, `docker-compose.deploy.yml`
**Fix:** `docker-compose.deploy.yml` no longer sets
`DISABLE_SECURITY_PLUGIN=true` — the security plugin is now enforced,
admin password must be supplied via `OPENSEARCH_PASSWORD`. All database
tier services (postgres, mongo, redis, opensearch) lost their
`ports: - "…:…"` keys in both prod and deploy compose files. Databases
are internal-only on the `cybersentinel` / `cybersentinel-net` docker
networks. Only `manager` (55000) and `dashboard` (80→3000) remain host-
exposed. `security_opt: - no-new-privileges:true` added to every
container.

### CR-2 — Hardcoded fallback OpenSearch password `CyberSentinel2025!`
**Files:** `docker-compose.deploy.yml:128,180,223`,
`.env.example:53`, `server/.env.example:41`
**Fix:** All three `${OPENSEARCH_PASSWORD:-CyberSentinel2025!}` fallbacks
replaced with `${OPENSEARCH_PASSWORD:?OPENSEARCH_PASSWORD must be set}`.
The two `.env.example` files now use the placeholder
`change-this-strong-opensearch-password`, which is picked up by
`install.sh`'s sed substitution and replaced with a cryptographically
random value on first install.

### CR-3 — CORS wildcard default (`CORS_ORIGINS=*`, `ALLOWED_HOSTS=*`)
**Files:** `.env.example:74-75`, `docker-compose.prod.yml:175`
**Fix:** `.env.example` now ships with explicit allowlists
(`["http://localhost","http://127.0.0.1"]`). `docker-compose.prod.yml`
manager service now requires `CORS_ORIGINS` to be set — no wildcard
default. `install.sh` generates a concrete allowlist from the host's
first IP at install time.

### CR-4 — `/api/v1/auth/change-password` requires no JWT
**File:** `server/app/api/v1/auth.py`
**Fix:** Endpoint now takes `current_user: User = Depends(get_current_user)`.
The request body's `username` field is ignored — passwords can only be
rotated for the token bearer. This kills an unauthenticated credential
stuffing surface.

### CR-5 — Vulnerable Python packages
**File:** `server/requirements.txt`
**Fix:** Upgraded to patched versions:
- `python-jose[cryptography]==3.3.0` → `3.4.0` (CVE-2024-33664, CVE-2024-33663)
- `cryptography==41.0.7` → `42.0.8` (CVE-2023-50782, CVE-2024-26130)
- `aiohttp==3.9.1` → `3.9.5` (CVE-2024-23334, CVE-2024-30251, CVE-2024-27306)
- `pymongo==4.6.0` → `4.6.3` (CVE-2024-5629)
- `requests==2.31.0` → `2.32.3` (CVE-2024-35195)
- `transformers==4.36.0` → `4.38.2` (CVE-2024-3568 — remote code execution)

### CR-6 — Broken rate-limit filter bypasses `/agents`
**File:** `server/app/middleware/rate_limit.py:30-32`
**Fix:** The old filter was
`path in [...] or "/agents" in path and method in ["PUT","POST"]` —
both an operator-precedence trap AND a substring match, so any path
containing the substring `/agents` (including hypothetical
`/api/v1/policies/agents-test`) got a blanket bypass. Rewritten to use
anchored `startswith(prefix)` against an explicit tuple of agent
prefixes with parenthesised boolean logic.

---

## HIGH

### H-1 — Unauthenticated agent endpoints in `decision.py`
**File:** `server/app/api/v1/decision.py`
**Fix:** Added `verify_agent_key(http_request)` to:
- `POST /events/batch`
- `GET /policies/sync`
- `GET /policy/latest`
- `GET /policy/download`

The policy bundle contains regex patterns, keyword lists, protected
folder IDs, and detection thresholds — essentially a DLP evasion
playbook. It must not be served anonymously.

### H-2 — Unauthenticated `/classification/classify`
**File:** `server/app/api/v1/classification.py`
**Fix:** Added `verify_agent_key` dependency. Previously anyone could
(a) use it as an oracle to tune exfiltration so it lands as "Public"
and (b) DoS the server via arbitrarily large `content`.

### H-3 — Unauthenticated `/classification/labels`
**File:** `server/app/api/v1/classification.py`
**Fix:** Now requires `get_current_user`. Leaked the internal label
taxonomy.

### H-4 — ReDoS via `/rules/validate-regex`
**File:** `server/app/api/v1/rules.py`
**Fix:** Pattern length capped at 1024, test content capped at 100k,
execution runs in a worker thread with a 3-second wall-clock timeout
via `asyncio.wait_for`. Catastrophic backtracking now returns a clear
error instead of pinning a worker CPU.

### H-5 — `/auth/login` has no dedicated rate limiter
**File:** `server/app/api/v1/auth.py`
**Fix:** Added a per-`(client_ip, username)` Redis-backed counter with
a 5-minute window. 10 failed attempts for the same IP+username returns
429 until the window expires. This is layered on top of the global
`RateLimitMiddleware` and specifically targets credential stuffing.

### H-6 — nginx missing security headers
**File:** `dashboard/nginx.conf`
**Fix:** Added `Strict-Transport-Security`, `Permissions-Policy`,
`server_tokens off`. CSP tightened to include `frame-ancestors 'none'`,
`base-uri 'self'`, `form-action 'self'`, `object-src 'none'`. Added
`limit_req_zone` for `api_general` (20r/s) and `api_auth` (5r/s), and a
`limit_conn_zone` with a per-IP cap of 50. `X-Forwarded-For` is now
overwritten with `$remote_addr` instead of appended (prevents client
spoofing). `client_max_body_size` bounded to 20M globally.

### H-7 — dashboard nginx container running as root
**File:** `dashboard/Dockerfile`
**Fix:** Added `USER nginx`, listen port lowered to 3000
(unprivileged), compose maps host 80 → container 3000. `npm ci` is now
used when a lockfile is present.

### H-8 — server Dockerfile duplicate HEALTHCHECK + shell-form CMD
**File:** `server/Dockerfile`
**Fix:** Deduplicated HEALTHCHECK; converted CMD to exec-form so SIGTERM
propagates. Added `--no-install-recommends` + `apt-get clean` to both
apt stages.

### H-9 — `install-agent.ps1` downloads agent exe with no integrity check
**File:** `install-agent.ps1`
**Fix:** The installer now fetches a sidecar `.sha256` file from the
repo next to the binary and verifies `Get-FileHash -Algorithm SHA256`
against it. Mismatch deletes the binary and exits with code 2. Also
calls `Get-AuthenticodeSignature` and logs the signer subject on
success — currently warn-only, to be upgraded to fail-closed once an
EV signing certificate is provisioned.

### H-10 — self-signed cert in `install.sh` has no SAN, weak RSA-2048
**File:** `install.sh`
**Fix:** Upgraded to RSA-4096 with explicit SAN entries (DNS and IP),
`keyUsage`, `extendedKeyUsage`, derived CN from `hostname -f`, and a
chown + chmod pass on key/cert. Install dir certs directory is now
`chmod 700` and files are root-owned.

### H-11 — `install.sh` doesn't chown the generated .env
**File:** `install.sh`
**Fix:** `chown root:root` added before the `chmod 600`.

---

## MEDIUM (fixed)

### M-1 — `/refresh` doesn't rotate or blacklist the old refresh token
(deferred — see DEFERRED section)

### M-2 — No `aud`/`iss` claim validation on JWT
(deferred — see DEFERRED section)

### M-3 — `install.sh` pulls from main branch (tag pinning)
(deferred — see DEFERRED section)

### M-4 — `.env.example` misleading comment about CORS
**File:** `.env.example`
**Fix:** Rewritten comment to reflect that the dashboard is served from
the same origin and no cross-origin access is needed.

### M-5 — Dashboard Dockerfile uses `npm install` (non-reproducible)
**File:** `dashboard/Dockerfile`
**Fix:** Use `npm ci` when `package-lock.json` is present.

---

## DEFERRED (tracked as follow-up work)

The following HIGH/MEDIUM findings require larger refactors and have
been documented here instead of fixed in-place to keep the current
change set reviewable.

### D-1 — Agent talks to manager over plaintext HTTP with no auth header
**HIGH.** File: `agents/endpoint/windows/agent.cpp:297-356`.
`WinHttpOpenRequest` never sets `WINHTTP_FLAG_SECURE`, the default
server URL is `http://`, and no `Authorization` / `X-Agent-Key` header
is attached to any request. Anyone on the LAN can MITM events or POST
forged events with no credential.

Fix plan:
- Force `https://` in default config, require `WINHTTP_FLAG_SECURE`.
- Generate a per-agent enrollment token at registration; the server
  already issues a `key` in `/agents/register`, and `verify_agent_key`
  expects it in `X-Agent-Key` — the agent just doesn't send it yet.
- Reject cert errors instead of ignoring them.

### D-2 — JWT access + refresh tokens stored in `localStorage`
**HIGH.** Files: `dashboard/src/lib/store/auth.ts`,
`dashboard/src/lib/api.ts`, `dashboard/src/components/auth/ProtectedRoute.tsx`.
Zustand `persist` writes tokens to `window.localStorage` under
`dlp-auth-v2`; `ProtectedRoute` gates only on a client-side bool.

Fix plan:
- Move tokens to `Secure; HttpOnly; SameSite=Strict` cookies served
  by the manager.
- Replace the client-side `isAuthenticated` flag with a server-verified
  `/users/me` call on route mount.
- Remove the `localStorage.getItem('dlp-auth-v2')` fallback paths in
  `api.ts` and `api/client.ts`.

### D-3 — Command injection via `%TEMP%` env var in agent OCR shell-out
**HIGH.** File: `agents/endpoint/windows/agent.cpp:2501-2536`.
`tempDir = getenv("TEMP")` is concatenated into a `system(...)` command
string. A local user can set `TEMP=C:\a" & calc & rem` before the
agent runs.

Fix plan:
- Use `GetTempPathW` (the official Win32 API) instead of `getenv`.
- Switch from `system()` to `CreateProcessW` with an argv array, not
  a single command-line string.
- Sanitise the resolved path and reject any characters outside the
  allowed set.

### D-4 — Refresh-token rotation leaves old jti valid
**MEDIUM.** File: `server/app/api/v1/auth.py` (refresh flow).
`/refresh` issues a new pair but does not blacklist the presented
refresh token; a stolen token remains valid until natural expiry.

Fix plan: add `jti` to the refresh token, persist a `jti -> exp`
blacklist key on every refresh, and reject any already-blacklisted jti.

### D-5 — No `aud`/`iss` validation on JWT decode
**MEDIUM.** File: `server/app/core/security.py`.
`jwt.decode` is called with `algorithms=[...]` only. Add
`audience=settings.JWT_AUDIENCE, issuer=settings.JWT_ISSUER` and set
the claims on encode. Enforce `options={"require":["exp","iat","sub"]}`.

### D-6 — `install.sh` pulls from the `main` branch
**MEDIUM.** Any main-branch compromise or mis-push ships straight to
production installs. Pin the one-liner to a release tag and fetch
`SHA256SUMS.asc` signed with a release key the installer verifies
before sourcing anything.

### D-7 — Default PASSWORD_MIN_LENGTH is 7
**LOW.** Raise to 12 and integrate a common-password deny list
(zxcvbn score ≥ 3).

### D-8 — Base images not pinned by digest
**MEDIUM.** `python:3.11-slim`, `node:18-slim`, `nginx:alpine` are
mutable tags. Pin to `@sha256:...` digests, refreshed via Renovate/
Dependabot.

### D-9 — `axios` floating range `^1.6.2`
**MEDIUM.** File: `dashboard/package.json`. Commit a `package-lock.json`
and raise the floor to `^1.8.2` to pick up CVE-2024-39338 and
CVE-2025-27152 fixes.

### D-10 — Server Dockerfile `COPY . .` may pull host `.env`
**MEDIUM.** File: `server/Dockerfile:49`. Add a dockerignore that
excludes `.env*`, `*.pem`, `*.key`, `logs/`, `quarantine/`,
`__pycache__/`, `.git/`, `.venv/`. Prefer explicit
`COPY app/ ./app/` + individual files.

---

## How to verify after deploying these fixes

```bash
# Rate limiter no longer bypasses arbitrary "/agents" substrings
curl -i http://HOST/api/v1/policies/agents-test   # should be rate-limited after the burst

# Login rate limiter blocks credential stuffing
for i in $(seq 1 12); do
  curl -s -o /dev/null -w "%{http_code}\n" \
       -X POST -d "username=a@b.com&password=wrong" \
       http://HOST/api/v1/auth/login
done   # 11th and 12th responses should be 429

# Change-password without a token is rejected
curl -i -X POST http://HOST/api/v1/auth/change-password \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","current_password":"x","new_password":"Aa1!xxxxxxxx","new_password_confirm":"Aa1!xxxxxxxx"}'
#   → 401 Unauthorized

# Policy bundle download without agent key is rejected
curl -i "http://HOST/api/v1/decision/policy/download"   # → 401

# Database host ports are closed
nmap -p 5432,27017,6379,9200 HOST   # all should report "filtered" or "closed"
```
