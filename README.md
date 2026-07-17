# CyberSentinel DLP

Data Loss Prevention (DLP) is the practice of detecting and preventing unauthorized transmission of sensitive data outside an organization. CyberSentinel DLP is an enterprise platform that monitors endpoints, cloud storage, and network channels — classifying sensitive content in real time and enforcing security policies to block, alert, or quarantine data exfiltration attempts before they succeed.

## Key Features

- **Endpoint Monitoring** — File system, USB transfers, clipboard, screen capture, and print job monitoring on Windows and Linux
- **Kernel-Level Enforcement** — Windows minifilter driver intercepts file operations at the IRP level for tamper-proof blocking
- **Content Classification** — 20+ detection patterns with Luhn checksum validation, SHA-256 fingerprinting, keyword matching, and Shannon entropy analysis
- **Deep Content Inspection** — reads inside binary documents (PDF/DOCX/XLSX/PPTX), expands archives (zip/tar/gz/7z) with zip-bomb limits, and **OCRs scanned PDFs and images** (Tesseract) so a photographed secret is caught like a typed one. Content that cannot be inspected is never treated as clean — policy decides.
- **Outage Resilience** — endpoint agents cache the last policy and enforce it even if they restart while the server is unreachable; events raised during an outage are spooled to disk and replayed on reconnect, so a block never happens without an audit record
- **Policy Engine** — Priority-based deterministic evaluation with nested condition trees, channel-aware enforcement, and atomic hot-reload
- **Cloud Integration** — Google Drive and OneDrive monitoring via OAuth with delta-query polling
- **Real-Time Decisions** — Sub-10ms local policy evaluation on agents; server-side decision API for content-aware blocking
- **SIEM Integration** — Splunk and OpenSearch/Elasticsearch connectors
- **Dashboard** — React-based UI for event viewer, policy builder, rule management, agent fleet monitoring, and classification analytics
- **Granular RBAC** — A global super-admin plus domain-scoped admins (Threat, Data Protection, Access Control) who see and control only their own policies and reporting, layered on ABAC department/clearance visibility
- **Sequential Agent IDs** — Agents are assigned WIN-001, WIN-002, LIN-001 format IDs automatically

---

## Installation

### Server (one-liner)

**Requirements:** Docker Engine 24+, Docker Compose v2+, Python 3, 8 GB RAM

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/effaaykhan/cybersentineldlp-prod/main/install.sh)
```

This clones the repo, generates secure passwords, starts all services, and prints the admin credentials.

#### Install updates

Pull the latest images, **apply any new database migrations**, then restart. The
migration step is required for upgrades — the app auto-creates the schema on a
fresh install, but new columns/roles on existing tables only land via Alembic
(for example the domain-scoped RBAC release adds `policies.domain` and three
admin roles):

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
docker exec cybersentinel-manager alembic upgrade head
```

#### Verify
```bash
docker ps
```

#### Pinning a release (recommended for client deployments)

Every release is published to GHCR under both a moving `:latest` tag and an
immutable version tag (current: **`2.1.0`**), for `dlp-manager` and
`dlp-dashboard`. Client/production hosts should **pin the version** so an
upstream `:latest` change never lands unexpectedly. Set it once in `.env`:

```bash
echo "DLP_IMAGE_TAG=2.1.0" >> .env
```

and reference `${DLP_IMAGE_TAG:-latest}` in your image lines, or simply edit the
two `image:` tags in `docker-compose.prod.yml` from `:latest` to `:2.1.0`. To roll
a client back, point the tag at a known-good version and `up -d` again — the
image carries all code and dependencies, so nothing else changes on the host.

> The published images are self-contained: **no source code or build files are
> ever copied to the deployment host** — only the two container images are pulled.
> Everything the platform needs at runtime (including the OCR engine) is baked in.

**Manual install (production, step-by-step):**

Use this on any fresh Ubuntu/Debian server. Every step below is required; skipping
one is the usual cause of a failed first boot (see [Troubleshooting](#troubleshooting-first-install)).

**Prerequisites:** Docker Engine 24+, Docker Compose v2+, ≥ 8 GB RAM, ≥ 20 GB free
disk. Ports `55000` (API) and `3023` (dashboard) free on the host. The pre-built
images ship every runtime dependency — including the OCR stack (Tesseract +
poppler) — so **nothing else needs installing on the host.**

```bash
# 1. Get the deployment files (compose + env template + config)
git clone https://github.com/effaaykhan/cybersentineldlp-prod.git
cd cybersentineldlp-prod

# 2. Create and fill in the environment file
cp .env.example .env
```

Edit `.env` and set **every** value below — these are mandatory and the stack
**refuses to start** if any is missing (Compose errors with `Set this password in
.env file` / `CORS_ORIGINS must be set`):

| Variable | What to set it to |
|----------|-------------------|
| `POSTGRES_PASSWORD`, `MONGODB_PASSWORD`, `REDIS_PASSWORD`, `OPENSEARCH_PASSWORD` | A strong unique password each |
| `SECRET_KEY`, `JWT_SECRET` | A random string **≥ 32 chars** each |
| `CORS_ORIGINS` | JSON list of the URL(s) you serve the dashboard on, e.g. `["http://<server-ip>:3023"]` |

Generate strong secrets quickly:
```bash
for v in SECRET_KEY JWT_SECRET POSTGRES_PASSWORD MONGODB_PASSWORD REDIS_PASSWORD OPENSEARCH_PASSWORD; do
  echo "$v=$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
done   # paste the output into .env
```

```bash
# 3. Provide TLS certs for the dashboard container. The compose file mounts
#    ./certs/fullchain.pem and ./certs/privkey.pem — if these files are absent,
#    Docker creates them as empty DIRECTORIES and the dashboard fails to start.
#    Generate a self-signed pair (replace later with a real cert behind your proxy):
mkdir -p certs
openssl req -x509 -nodes -newkey rsa:2048 -days 365 \
  -keyout certs/privkey.pem -out certs/fullchain.pem \
  -subj "/CN=cybersentinel-dlp"

# 4. Start the stack (pulls pre-built images from GHCR)
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d

# 5. Mark the migration state. On a FRESH install the manager auto-creates the
#    full schema at startup, so DON'T run `alembic upgrade head` here — it errors
#    with "type userrole already exists". Instead stamp the DB as current so
#    future upgrades apply cleanly:
docker exec cybersentinel-manager alembic stamp head
```

> **Upgrading an existing install** is the opposite: run `alembic upgrade head`
> (see [Install updates](#install-updates)) so new columns/roles land on the
> already-populated database.

```bash
# 6. Retrieve the admin password. On first boot the manager seeds user `admin`
#    with a RANDOM password, unique to this deployment, logged exactly once:
docker logs cybersentinel-manager 2>&1 | grep generated_password
```

**First login:** username **`admin`**, with the password from step 6. Change it
after logging in (Settings → Profile → Change Password).

> Prefer to set it yourself (e.g. from a secrets manager, for automated
> deployments)? Put `DLP_ADMIN_PASSWORD=<your-password>` in `.env` **before** the
> first start and that is used instead — nothing is written to the logs. It must
> meet the password policy: 7+ chars with upper, lower, digit and a symbol.
> This only applies when seeding a brand-new database; it never changes an
> existing admin's password.

- Dashboard: `http://<server-ip>:3023`  (override with `DASHBOARD_HOST_PORT` in `.env`)
- API docs: `http://<server-ip>:55000/api/v1/docs`

#### Verify the install

```bash
docker compose -f docker-compose.prod.yml ps      # all services "Up (healthy)"
curl -f http://localhost:55000/health             # -> {"status":"healthy"}
```

Confirm OCR is active in the pulled image (used for scanned PDFs / images):
```bash
docker exec cybersentinel-manager tesseract --version   # prints "tesseract 5.x"
```
If that command is **not found**, you are on an image built before OCR shipped —
`docker compose -f docker-compose.prod.yml pull` again to get the current image.
DLP still runs without it; scanned/image files are treated as *uninspectable*
(blocked by the "Block Uninspectable Content" policy) rather than being OCR-read.

#### Troubleshooting (first install)

| Symptom | Cause & fix |
|---------|-------------|
| Compose exits with `Set this password in .env file` or `CORS_ORIGINS must be set` | A mandatory `.env` var is empty. Fill in the table above. |
| `dashboard` container restarts / nginx cert errors | `./certs/fullchain.pem` or `privkey.pem` missing → Docker made them directories. `rm -rf certs && ` re-run step 3. |
| Login fails right after install | Migrations not applied — run step 5 (`alembic upgrade head`). |
| `manager` unhealthy for > 2 min | It waits for OpenSearch/Postgres/Mongo/Redis to be healthy first; check `docker compose -f docker-compose.prod.yml ps` and give OpenSearch ~60s on first boot. |
| Port already in use | Change `DASHBOARD_HOST_PORT` in `.env`, or free port `55000`. |

#### First login & roles

Sign in with the admin credentials printed above (a global **super admin**). Then,
under **User Management → Create User**, assign accounts one of the domain-scoped
admin roles — **Threat Admin**, **Data Protection Admin**, or **Access Control
Admin** — so each only sees and manages the policies and reporting in their
domain. The super admin retains visibility across all domains.

### Windows Agent (one-liner)

**Requirements:** Windows 10/11 64-bit, PowerShell as Administrator

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/effaaykhan/cybersentineldlp-prod/main/install-agent.ps1 | iex"
```

This downloads the agent binary, creates configuration, registers a scheduled task (runs as current user for clipboard/screen access), and starts monitoring.

#### To start the agent:
```powershell
Start-ScheduledTask -TaskName "CyberSentinel DLP Agent"
```

#### To Stop the agent:
```powershell
Stop-ScheduledTask -TaskName "CyberSentinel DLP Agent"
```
```powershell
Stop-Process -Name "cybersentinel_agent" -ErrorAction SilentlyContinue
```

### Linux Agent

**Requirements:** Python 3.8+, systemd

```bash
cd agents/endpoint/linux
pip install -r requirements.txt
export CYBERSENTINEL_SERVER_URL=http://<SERVER_IP>:55000/api/v1
python agent.py
```

Install as systemd service:

```bash
sudo cp systemd/cybersentinel-agent.service /etc/systemd/system/
sudo systemctl enable cybersentinel-agent
sudo systemctl start cybersentinel-agent
```

### Windows Agent Compilation (from source)

Requires MSYS2 with MinGW-w64 (run from an **MSYS2 MinGW 64-bit** shell). The
simplest path is the bundled script, which backs up the existing binary and
prints the deploy steps:

```bash
cd agents/endpoint/windows
./build.sh
```

Or compile directly (equivalent to what `build.sh` runs):

```bash
cd agents/endpoint/windows
g++ -std=c++17 -O2 \
    agent.cpp screen_capture_monitor.cpp print_monitor.cpp network_exfil_monitor.cpp \
    -o cybersentinel_agent.exe \
    -lwinhttp -lwbemuuid -lole32 -loleaut32 -luser32 -lgdi32 \
    -lws2_32 -lsetupapi -ladvapi32 -lcfgmgr32 -lshell32 -lwinspool \
    -luiautomationcore -lpsapi -static
```

If `g++` is missing: `pacman -S mingw-w64-x86_64-gcc`.

---

## Resources

| Document | Description |
|----------|-------------|
| [Integration Guide](INTEGRATION_COMPLETE.md) | Classification system integration details |
| [Classification System](CLASSIFICATION_SYSTEM.md) | Detection rules, confidence scoring, label architecture |
| [Classification Policies Guide](CLASSIFICATION_POLICIES_GUIDE.md) | Policy configuration for classification-based enforcement |
| [Testing Commands](TESTING_COMMANDS.md) | Step-by-step manual testing procedures |
| [Utility Commands](UTILITY_COMMANDS.md) | Common operational commands |
| [Windows Agent Build](agents/endpoint/windows/BUILD_INSTRUCTIONS.md) | Compiling the Windows agent from source |
| [Windows Agent Install](docs/WINDOWS_AGENT_INSTALL.md) | Detailed Windows agent deployment guide |
| [Changelog](CHANGELOG.md) | Version history |

---

## Contributors

<table>
  <tr>
    <td align="center">
      <a href="https://github.com/effaaykhan">
        <img src="https://github.com/effaaykhan.png" width="80px;" alt=""/>
        <br />
        <sub><b>effaaykhan</b></sub>
      </a>
    </td>
  </tr>
</table>

## License

**Proprietary — All rights reserved.** This repository is *source-available*: it
is public for demonstration and review only. Use, copying, modification,
distribution, and deployment require prior written permission. See
[LICENSE](LICENSE) for the full terms.
