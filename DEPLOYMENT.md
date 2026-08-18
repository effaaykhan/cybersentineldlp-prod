# CyberSentinel DLP — Deployment Guide

This is the canonical install guide for the CyberSentinel DLP platform.
It covers:

1. [Server installation](#1-server-installation) — one-liner on a fresh
   Ubuntu/Debian box. Pulls pre-built images from GHCR. **No source code
   ever lands on the production host**, and the backend image itself ships
   as **compiled binaries** (see [Source protection](#source-protection)).
2. [Building the Windows agent](#2-building-the-windows-agent) — compile
   the C++ binary on a build box and publish it (with a SHA-256 sidecar)
   to the repo so endpoints can fetch a verified copy.
3. [Installing the Windows agent on endpoints](#3-installing-the-windows-agent-on-endpoints)
   — one-liner on each endpoint. Verifies the SHA-256 of the downloaded
   binary against the sidecar before running it.
4. [Day-2 ops with `csdlp`](#4-day-2-ops-with-csdlp) — one CLI for status,
   diagnostics, logs, safe updates, rollback, and backups.

> **Repo:** `effaaykhan/cybersentineldlp-prod`
> **GHCR images:**
> - `ghcr.io/effaaykhan/cybersentineldlp-prod/dlp-manager:latest`
> - `ghcr.io/effaaykhan/cybersentineldlp-prod/dlp-dashboard:latest`
>
> Both packages must be public for the one-liner installer to work
> without authentication.

---

## 1. Server installation

### Prerequisites

- Ubuntu 20.04+ / Debian 11+ / any systemd Linux with `sudo`.
- Outbound HTTPS to `ghcr.io`, `raw.githubusercontent.com`, and
  `registry-1.docker.io` (Docker Hub for the postgres / mongo / redis /
  opensearch base images).
- 4 vCPU / 8 GB RAM minimum, 16 GB recommended.
- 50 GB free disk for OpenSearch + MongoDB volumes.

### One-liner install

```bash
curl -fsSL https://raw.githubusercontent.com/effaaykhan/cybersentineldlp-prod/main/install.sh | sudo bash
```

What this does, in order:

1. Installs Docker (via `get.docker.com`) if it's not already there and
   enables/starts the daemon.
2. Creates `/opt/cybersentineldlp/`. Override with
   `INSTALL_DIR=/srv/cybersentineldlp` env var if you want a different path.
3. Downloads `docker-compose.prod.yml` and `.env.example` from the
   repo via `raw.githubusercontent.com`. **No source tree, no `.git`,
   no Python files, no Dockerfiles are ever copied to the host.**
4. Generates `/opt/cybersentineldlp/.env` (mode `600`, root-owned) with
   cryptographically random values for:
   - `SECRET_KEY` (48-char URL-safe random)
   - `JWT_SECRET` (48-char)
   - `ENCRYPTION_KEY` (48-char)
   - `POSTGRES_PASSWORD` / `MONGODB_PASSWORD` / `REDIS_PASSWORD` /
     `OPENSEARCH_PASSWORD` (24-char each)
   - `CORS_ORIGINS` and `ALLOWED_HOSTS` set to the host's first IP +
     `localhost` (no wildcard).
5. Generates a self-signed RSA-4096 TLS certificate in
   `/opt/cybersentineldlp/certs/` with proper Subject Alternative Names.
   This satisfies the dashboard nginx bind mount; replace with a real
   cert later if you front the deployment with a TLS-terminating proxy.
6. `docker compose pull` — fetches all images from GHCR and Docker Hub.
7. `docker compose up -d` — starts all services.
8. Polls `http://localhost:55100/health` for up to 3 minutes.
9. Prints connection details and the bootstrap admin password from
   the manager log.

### What's installed

```
/opt/cybersentineldlp/
├── docker-compose.prod.yml          # ~12 KB, fetched from repo
├── .env                              # mode 600, root-owned
├── .env.example                      # placeholders, harmless
├── certs/
│   ├── fullchain.pem                 # self-signed RSA-4096 + SAN
│   └── privkey.pem                   # mode 600, root-owned
└── data/                             # reserved for future host bind mounts
```

Containers running after install:

| Container | Image | Host port | Purpose |
|---|---|---|---|
| `cybersentineldlp-postgres` | `postgres:16-alpine` | _none_ | Users, RBAC, audit logs |
| `cybersentineldlp-mongodb` | `mongo:7.0` | _none_ | DLP events, alerts, incidents |
| `cybersentineldlp-redis` | `redis:7-alpine` | _none_ | Token blacklist, rate limit, cache |
| `cybersentineldlp-opensearch` | `opensearchproject/opensearch:2.11.0` | _none_ | Event search index |
| `cybersentineldlp-manager` | `ghcr.io/effaaykhan/cybersentineldlp-prod/dlp-manager:latest` (compiled) | **55100** | FastAPI API |
| `cybersentineldlp-dashboard` | `ghcr.io/effaaykhan/cybersentineldlp-prod/dlp-dashboard:latest` | **3023** → 3000 (HTTPS / TLS 1.3) | React SPA + nginx |
| `cybersentineldlp-celery-worker` | (same manager image) | _none_ | Async event processing |
| `cybersentineldlp-celery-beat` | (same manager image) | _none_ | Scheduled tasks |

> **Database tier is internal-only** since the security audit. Postgres,
> Mongo, Redis, and OpenSearch are no longer published to `0.0.0.0`. For
> ops use `docker compose exec` (e.g.
> `docker compose -f /opt/cybersentineldlp/docker-compose.prod.yml exec postgres psql -U cybersentineldlp`).

### First-time login

After the install script finishes, it prints the bootstrap admin
password. If you missed it:

```bash
docker logs cybersentineldlp-manager 2>&1 | grep generated_password
```

Open the dashboard at **`https://<server-ip>:3023/`** (TLS 1.3 + HTTP/2;
self-signed cert → browser warning until you install a real one — plain
`http://` on that port auto-redirects to HTTPS). Log in as `admin` with
that password, and **change it on the first login** (Settings → Profile
→ Change Password). The audit hardened `/api/v1/auth/change-password`
to require a valid JWT, so the dashboard's change-password flow is the
only way to rotate it.

> **Self-registration is disabled.** All new accounts must be created
> by an admin via the Users page (Admin → Users → New User), since the
> data layer doesn't have per-tenant scoping yet.

### Source protection

The manager/celery image ships as **compiled native binaries**, not Python:

On every push, CI (`.github/workflows/build-images.yml`) compiles the backend
in **two passes**, both producing ordinary CPython `.so` extension modules:

| Pass | Tool | Covers | Count |
|---|---|---|---|
| 1 | Cython — `server/compile_app.py` | engine/service modules: classification, ML classifier, policy evaluation, detection, EDM, actions, tasks, … | 92 |
| 2 | Nuitka — `server/compile_framework.py` | the FastAPI framework layer: `app/main.py`, `app/core/security.py`, `app/api/**` | 29 |

Two compilers are needed because Cython 3 cannot compile handler parameters
that default to FastAPI markers (`= Depends(...)` / `= Query(...)`) — it fails
with `TypeError: Expected unicode, got Depends`. Nuitka compiles
Python-as-Python and has no such limit, so it takes the routers. The runtime
interpreter simply imports the resulting `.so`, exactly as it imports numpy's.

- The compile runs on GitHub's runners; **the client server never compiles
  and never receives source** — it only `docker pull`s the finished image.
- Because the Dockerfile is **multi-stage**, the source-bearing build stage
  is discarded — `docker save` / `docker cp` on the pulled image find only
  `.so`. `cat /app/app/main.py` returns *No such file or directory*.
- **What is still `.py`, deliberately:** package `__init__.py` (import wiring
  only — the `app/api/v1/__init__.py` router table and a few re-export stubs);
  `alembic/versions/*` (Alembic imports migration files by path at runtime, so
  compiling them would break `alembic upgrade head`); and `scripts/*` (one-off
  ops utilities invoked as `python scripts/foo.py`). These are schema DDL and
  admin glue, not engine logic.
- Build guards fail the image if any of that regresses: the classification
  engine must have produced a `.so`, `app/main.*.so` must exist (proving the
  Nuitka pass ran), there must be ≥110 `.so`, and **zero** non-`__init__`
  `.py` may survive under `app/`.
- This is deterrence, not DRM: a determined root user can still
  reverse-engineer a `.so`, but casual copy-paste theft is stopped.

> Dev is unaffected: `docker-compose.yml` bind-mounts `./server` over
> `/app`, shadowing the compiled code with live source for hot-reload — so
> the same Dockerfile yields compiled **prod** images while **dev** edits
> raw `.py`.

### The `csdlp` operations CLI

`install.sh` also drops **`csdlp`** — a single command for all day-2
operations — into the deployment dir and symlinks it onto `PATH`:

```bash
csdlp help        # full command guide
csdlp status      # health of every service + versions
csdlp doctor      # full diagnostics (secrets redacted)
```

If it isn't on `PATH` (e.g. the symlink step needed root):

```bash
sudo /opt/cybersentineldlp/csdlp self-install     # copies to /usr/local/bin/csdlp
# or fetch standalone:
curl -fsSL https://raw.githubusercontent.com/effaaykhan/cybersentineldlp-prod/main/csdlp \
  -o /usr/local/bin/csdlp && chmod +x /usr/local/bin/csdlp
```

See [Day-2 ops with `csdlp`](#4-day-2-ops-with-csdlp).

---

## 2. Building the Windows agent

The agent is a single C++ executable (`cybersentineldlp_agent.exe`) compiled
on Windows with MSYS2 MinGW. It's checked into the repo as a binary,
along with a SHA-256 sidecar so endpoint installs can verify integrity.

### Prerequisites

- Windows 10/11 build box.
- [MSYS2](https://www.msys2.org/) installed.
- Inside the MSYS2 MinGW 64-bit terminal:
  ```bash
  pacman -S --needed mingw-w64-x86_64-gcc git
  ```

### Compile

```bash
# In MSYS2 MinGW 64-bit terminal
cd /c/cybersentineldlp-prod
git pull origin main
cd agents/endpoint/windows
./build.sh
```

`build.sh` runs:

```bash
g++ -std=c++17 -O2 \
    agent.cpp screen_capture_monitor.cpp print_monitor.cpp \
    -o cybersentineldlp_agent.exe \
    -lwinhttp -lwbemuuid -lole32 -loleaut32 -luser32 -lgdi32 \
    -lws2_32 -lsetupapi -ladvapi32 -lcfgmgr32 -lshell32 -lwinspool -static
```

You should see `cybersentineldlp_agent.exe` (~4 MB) appear in the same
directory.

### Generate the SHA-256 sidecar

The endpoint installer verifies the binary against this sidecar before
running it.

```bash
# Same MSYS2 terminal
sha256sum cybersentineldlp_agent.exe > cybersentineldlp_agent.exe.sha256
cat cybersentineldlp_agent.exe.sha256
```

You should see a line like:
```
3a9f4e1c5b7d... *cybersentineldlp_agent.exe
```

> Pure-PowerShell alternative if you don't want MSYS2:
> ```powershell
> cd C:\cybersentineldlp-prod\agents\endpoint\windows
> (Get-FileHash -Algorithm SHA256 cybersentineldlp_agent.exe).Hash.ToLower() `
>   | Out-File -Encoding ASCII cybersentineldlp_agent.exe.sha256
> ```

### Commit + push

```bash
git add cybersentineldlp_agent.exe cybersentineldlp_agent.exe.sha256
git status   # confirm both are staged

git commit -m "build: agent $(date +%Y-%m-%d) (commit $(git rev-parse --short HEAD))"
git push origin main
```

Use a more descriptive message if you prefer, e.g.
`build: agent with screen-capture sticky-block fixes`.

### Verify the upload landed

```bash
curl -fsI https://raw.githubusercontent.com/effaaykhan/cybersentineldlp-prod/main/agents/endpoint/windows/cybersentineldlp_agent.exe | head -1
curl -fsSL https://raw.githubusercontent.com/effaaykhan/cybersentineldlp-prod/main/agents/endpoint/windows/cybersentineldlp_agent.exe.sha256
```

Both should return successfully. The SHA-256 should match what you
generated locally.

> **Re-builds:** every time you change `agent.cpp` or one of the
> `*_monitor.cpp` files, repeat compile + sha256sum + commit + push.
> The sidecar **must** be regenerated with each new binary or the
> endpoint installer will refuse to run it.

---

## 3. Installing the Windows agent on endpoints

### One-liner install

Run this **as Administrator** on each Windows endpoint. It launches the interactive
manager (`manage-windows-agent.ps1`) — pick **Install** from its menu:

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/effaaykhan/cybersentineldlp-prod/main/manage-windows-agent.ps1 | iex"
```

The same script also handles **Update** and **Uninstall** from its menu. What the
**Install** option does:

1. **Step 1 — Configuration.** Prompts for the server hostname/IP
   (`localhost`, an IPv4 literal, or an RFC1123 FQDN like
   `dlp.corp.local`), agent name, heartbeat interval, and policy sync
   interval. Tests `http://<server>:55100/health` before continuing.
2. **Step 2 — Cleanup.** Stops the existing scheduled task / process /
   service if present. Safe to re-run on an already-installed endpoint.
3. **Step 3 — Directories.** Creates `C:\Program Files\CyberSentinel`
   and `C:\ProgramData\CyberSentinelDLP\{logs,quarantine,cache}`.
4. **Step 4 — OCR deps.** Installs Chocolatey + Tesseract if missing
   (used by the screen-capture classifier's Stage 4 OCR fallback).
5. **Step 5 — Agent binary download with SHA-256 verification.**
   - Pulls `cybersentineldlp_agent.exe` from `raw.githubusercontent.com`.
   - Pulls the sidecar `.sha256` from the same location.
   - Computes the local SHA-256 with `Get-FileHash`.
   - **If the hashes don't match, deletes the binary and exits with
     code 2.** No tampered installs.
   - Optional `Get-AuthenticodeSignature` check (warn-only until an EV
     signing cert is provisioned).
6. **Step 6 — Environment.** Sets `CYBERSENTINELDLP_SERVER_URL` for the
   machine.
7. **Step 7 — Config file.** Writes
   `C:\Program Files\CyberSentinelDLP\agent_config.json` with the
   monitored paths, file extensions, and intervals from step 1.
8. **Step 8 — Scheduled task.** Registers `CyberSentinel DLP Agent`
   with both `AtLogon` and `AtStartup` triggers, `RunLevel Highest`,
   `RestartCount 999` so it auto-recovers on crash. The task runs the
   `.exe` directly — there is no script wrapper, deliberately: a `.vbs`
   launcher is blocked by Application Control and Smart App Control
   (`0x800711C7`), which stopped the agent starting at all. The binary is
   linked for the GUI subsystem, so no console window is ever created.
9. **Step 9 — Start.** Runs the task and prints the PID.

### What gets installed

```
C:\Program Files\CyberSentinelDLP\
├── cybersentineldlp_agent.exe          # the binary, hash-verified
├── agent_config.json                # server URL, intervals, monitored paths
└── cybersentineldlp_agent.log          # written at runtime

C:\ProgramData\CyberSentinelDLP\
├── logs\
├── quarantine\
└── cache\
```

Plus the scheduled task `CyberSentinel DLP Agent` (visible in
`taskschd.msc`).

### Verify

```powershell
# Process running?
Get-Process cybersentineldlp_agent | Select-Object Id, StartTime, Path

# Tail the agent log
Get-Content "C:\Program Files\CyberSentinelDLP\cybersentineldlp_agent.log" -Tail 50

# Confirm the dashboard sees the agent
# (open http://<server>:80/ in a browser → Agents page)
```

### Re-install / update an existing endpoint

The same one-liner works — it cleans the previous install in step 2.
Operators don't have to uninstall first.

For just updating the binary without rerunning the full installer:

```powershell
Stop-Process -Name "cybersentineldlp_agent" -Force -ErrorAction SilentlyContinue
Start-Sleep 2
Invoke-WebRequest -UseBasicParsing `
    -Uri "https://raw.githubusercontent.com/effaaykhan/cybersentineldlp-prod/main/agents/endpoint/windows/cybersentineldlp_agent.exe" `
    -OutFile "C:\Program Files\CyberSentinelDLP\cybersentineldlp_agent.exe"

# Verify hash
$expected = (Invoke-WebRequest -UseBasicParsing `
    -Uri "https://raw.githubusercontent.com/effaaykhan/cybersentineldlp-prod/main/agents/endpoint/windows/cybersentineldlp_agent.exe.sha256").Content.Trim().Split()[0].ToUpper()
$actual = (Get-FileHash -Algorithm SHA256 "C:\Program Files\CyberSentinelDLP\cybersentineldlp_agent.exe").Hash.ToUpper()
if ($expected -ne $actual) {
    Write-Host "HASH MISMATCH — refusing to start" -ForegroundColor Red
    exit 2
}

Start-ScheduledTask -TaskName "CyberSentinel DLP Agent"
```

### Uninstall

```powershell
Stop-Process -Name "cybersentineldlp_agent" -Force -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "CyberSentinel DLP Agent" -Confirm:$false
Remove-Item "C:\Program Files\CyberSentinelDLP" -Recurse -Force
Remove-Item "C:\ProgramData\CyberSentinelDLP" -Recurse -Force
```

---

## 4. Day-2 ops with `csdlp`

`csdlp` is the single tool for operating the server — run it anywhere on the
host (it auto-detects the deployment under `/opt/cybersentineldlp`).
`csdlp help` prints the full guide.

| Task | Command |
|---|---|
| Health of the whole stack | `csdlp status` |
| Full diagnostics (secrets redacted) → shareable file | `csdlp doctor --bundle` |
| Tail / follow logs | `csdlp logs [service] [-f]` |
| **Safe** update (backup → pull → migrate → health-gate → auto-rollback) | `csdlp update` |
| Update to a specific published version | `csdlp update <tag>` |
| Undo the last update | `csdlp rollback` |
| Snapshot Postgres + Mongo | `csdlp backup` |
| Restore from a backup dir | `csdlp restore <dir>` |
| Run DB migrations | `csdlp migrate` |
| Restart one service / all | `csdlp restart [service]` |
| First-boot admin password | `csdlp secret admin-password` |
| Deployed image + API version | `csdlp version` |

### Safe update + rollback

CI (`.github/workflows/build-images.yml`) rebuilds and re-publishes the GHCR
images on every push to `main`. To roll a server forward:

```bash
csdlp update              # latest images, safely
csdlp update 2.3.0        # or a specific published tag
csdlp update sha-a1b2c3d  # or one exact CI build (see below)
csdlp rollback            # revert to the pre-update versions
csdlp update latest       # release a pin left by a rollback
```

`update` first snapshots the current image versions **and takes a DB
backup**, then pulls, runs migrations, brings the stack up, and polls
`/health`. **If the stack is unhealthy afterwards it automatically rolls
back** to the versions it saved. Volumes (postgres/mongo/opensearch data)
are always preserved. `.env` is the only per-server difference, so these
commands behave identically on every server.

**How a version is pinned for recovery.** Every CI build carries an
immutable `sha-<commit>` tag, so the snapshot records a tag that can be
**re-pulled** — recovery works even if the old image was pruned locally, or
if you are rebuilding on a host that never ran that version. Images with no
CI provenance (locally-built dev images) fall back to the local image ID,
which is lost to `docker image prune`; `csdlp version` shows which of the
two you have.

After a rollback the good version is **pinned**, because a bare
`csdlp update` would otherwise pull `:latest` again — the very build you
just rolled away from — and silently undo the recovery. Moving off a pin is
deliberate: name a tag, or run `csdlp update latest`.

### Diagnostics

```bash
csdlp status            # quick: is everything healthy right now?
csdlp doctor            # deep: services, /health, per-dependency probes,
                        # recent errors per service, disk/mem, .env (redacted)
csdlp doctor --bundle   # same, written to a file to send to the vendor
```

Because `doctor` redacts every secret, its output is safe to share.

### Under the hood (raw equivalents)

`csdlp` just wraps `docker compose`. The raw commands (run from
`/opt/cybersentineldlp`, compose file `docker-compose.prod.yml`):

```bash
# update
sudo docker compose -f docker-compose.prod.yml pull && \
sudo docker compose -f docker-compose.prod.yml up -d

# logs
sudo docker compose -f docker-compose.prod.yml logs --tail=100 -f manager

# backup (csdlp backup does this with the .env credentials automatically)
sudo docker compose -f docker-compose.prod.yml exec -T postgres \
    pg_dump -U "$(sed -n 's/^POSTGRES_USER=//p' .env)" \
            "$(sed -n 's/^POSTGRES_DB=//p' .env)" | gzip > postgres-$(date +%F).sql.gz
```

Always back up `/opt/cybersentineldlp/.env` offline — it's the one thing you
can't regenerate.

### Endpoint — view agent logs

Easiest: run the Windows agent manager (`manage-windows-agent.ps1`) and pick
**[4] Logs** — it locates the active log (handling rotation), colour-codes by
severity, and can follow live or filter to errors/warnings. Or directly:

```powershell
Get-Content "C:\Program Files\CyberSentinelDLP\cybersentineldlp_agent.log" -Tail 100 -Wait
```

### Endpoint — stop / start the agent

```powershell
# Stop
Stop-Process -Name "cybersentineldlp_agent" -Force -ErrorAction SilentlyContinue

# Start
Start-ScheduledTask -TaskName "CyberSentinel DLP Agent"

# Disable auto-start (without uninstalling)
Disable-ScheduledTask -TaskName "CyberSentinel DLP Agent"

# Re-enable
Enable-ScheduledTask -TaskName "CyberSentinel DLP Agent"
```

### Common failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `denied: denied` on `docker pull ghcr.io/effaaykhan/...` | Stale `~/.docker/config.json` from previous account | `docker logout ghcr.io && rm /root/.docker/config.json` |
| `denied` even after logout | GHCR packages are still private | `https://github.com/effaaykhan?tab=packages` → Package settings → Change visibility → Public |
| `TLS handshake timeout` on Docker Hub | Transient or proxy/firewall | Re-run `docker compose pull`. Persistent → set up a registry mirror. |
| Manager unhealthy on first boot | OpenSearch still initialising | Wait 90s, check `docker logs cybersentineldlp-opensearch`. |
| Manager 500s on `/auth/login` | `SECRET_KEY` not set / changed | Check `.env`. Restart manager. |
| Endpoint installer: `CRITICAL: SHA-256 mismatch` | Repo binary doesn't match its sidecar | Rebuild + regenerate sidecar (Section 2). |
| Endpoint can't reach manager | Firewall on port 55100 | `Test-NetConnection -ComputerName <server> -Port 55100` |
| Dashboard shows 0 agents | Agent not sending heartbeat | Tail `cybersentineldlp_agent.log` for HTTP errors. |

### Verification commands (all the security fixes from the audit)

```bash
SERVER=http://<your-server>

# Self-registration is admin-only now
curl -i -X POST $SERVER/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"x@y.z","password":"Aa1!xxxxxxxx","full_name":"x","organization":"x"}'
# → 401 Unauthorized

# /agents/{id}/policy/evaluate now requires X-Agent-Key
curl -i -X POST $SERVER/api/v1/agents/abc/policy/evaluate \
  -H "Content-Type: application/json" -d '{}'
# → 401

# SIEM SSRF guard rejects metadata IPs
curl -i -X POST $SERVER/api/v1/siem/connectors \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"x","siem_type":"elk","host":"169.254.169.254","port":80}'
# → 400 "resolves to 169.254.169.254 which is in the blocked network..."

# Audit logs are admin-only
curl -i $SERVER/api/v1/audit-logs/ -H "Authorization: Bearer VIEWER_TOKEN"
# → 403 Forbidden

# Database tier is internal-only
nmap -p 5432,27017,6379,9200 $SERVER
# all should report closed/filtered (or `host down` if firewalled)
```

### Where to find more

- **Operations CLI**: `csdlp` (repo root) — `csdlp help`
- **Backend compilation**: `server/compile_app.py` + `server/Dockerfile`
- **Security audit findings + fix log**: `SECURITY.md`
- **Server compose**: `docker-compose.prod.yml`
- **Agent source**: `agents/endpoint/windows/` (Windows), `agents/endpoint/linux/` (Linux)
- **CI workflow**: `.github/workflows/build-images.yml`
- **Persistent automation memory** for Claude Code: `~/.claude/projects/-home-soc-Data-Loss-Prevention/memory/`
