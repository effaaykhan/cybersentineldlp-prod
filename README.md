# CyberSentinel DLP

Enterprise Data Loss Prevention platform for monitoring, classifying, and controlling sensitive data across endpoints, cloud storage, and network channels.

## Architecture

```
Endpoint Agents (Windows/Linux)
        |
        v
  POST /api/v1/events  ──>  Event Processor Pipeline
        |                      1. Validate
        |                      2. Normalize
        |                      3. Enrich
        |                      4. Classify (regex + keyword + fingerprint + entropy)
        |                      5. Evaluate Policies
        |                      6. Execute Actions (block / alert / quarantine / encrypt)
        v
  MongoDB (events)  +  PostgreSQL (policies, users, rules)  +  OpenSearch (search)
        |
        v
  Dashboard (React)  ──  port 3023
```

## Components

| Component | Stack | Port |
|-----------|-------|------|
| API Server | FastAPI, Python 3.11 | 55000 |
| Dashboard | React, TypeScript, Vite, Tailwind | 3023 |
| Windows Agent | C++ (minifilter kernel driver + user-mode service) | - |
| Linux Agent | Python (watchdog + systemd) | - |
| PostgreSQL | 15-alpine | 5432 |
| MongoDB | 7 | 27017 |
| Redis | 7-alpine | 6379 |
| OpenSearch | 2.11 | 9200 |

## Quick Start

### Prerequisites

- Docker Engine 24+
- Docker Compose v2+
- 8 GB RAM minimum

### 1. Clone and configure

```bash
git clone https://github.com/effaaykhan/cybersentineldlp-prod.git
cd cybersentineldlp-prod
cp .env.example .env
```

Edit `.env` and set all passwords:

```
SECRET_KEY=<random-64-char-string>
POSTGRES_PASSWORD=<strong-password>
MONGODB_PASSWORD=<strong-password>
REDIS_PASSWORD=<strong-password>
OPENSEARCH_PASSWORD=<strong-password>
APP_TIMEZONE=Asia/Kolkata
```

Generate a secret key:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

### 2. Start services

```bash
docker compose up -d
```

Wait for all services to become healthy:

```bash
docker ps --format "table {{.Names}}\t{{.Status}}"
```

### 3. Get admin credentials

The system generates a random admin password on first boot:

```bash
docker logs cybersentinel-manager 2>&1 | grep "generated_password"
```

Login at `http://your-server:3023` with username `admin` and the generated password. You will be forced to change it on first login.

### 4. Verify

```bash
# Health check
curl http://localhost:55000/health

# API docs
open http://localhost:55000/api/v1/docs
```

## Features

### Endpoint Monitoring

- **File system** -- creation, modification, deletion, rename tracking
- **USB devices** -- arrival/removal detection, file transfer blocking
- **Clipboard** -- content capture, classification, automatic clearing
- **Screen capture** -- PrintScreen detection, capture tool monitoring
- **Print jobs** -- document name, page count, user attribution
- **Kernel driver** -- minifilter for IRP-level file operation interception (Windows)

### Content Classification

- 20 built-in detection rules (SSN, credit cards, Aadhaar, PAN, API keys, private keys)
- Luhn checksum validation for credit card numbers
- Verhoeff algorithm validation for Aadhaar numbers
- SHA-256 file fingerprinting with exact match
- Shannon entropy analysis for encoded/encrypted content detection
- Context-aware scoring (file type and channel multipliers)
- Keyword and dictionary matching
- Four classification levels: Public, Internal, Confidential, Restricted

### Policy Engine

- Priority-based deterministic evaluation (first match wins)
- Nested condition trees (AND/OR/NOT logic)
- Channel-aware enforcement (USB, clipboard, cloud, network, email, print)
- Actions: block, alert, quarantine, encrypt, redact, notify, webhook
- Atomic policy reload with version checksums
- 5-second cache with instant invalidation on policy changes
- Offline enforcement via local agent policy cache

### Cloud Monitoring

- Google Drive (OAuth 2.0, folder-level polling, activity tracking)
- OneDrive (Microsoft Graph API, delta queries, multi-tenant)

### Security

- JWT authentication with mandatory password change on first login
- Agent API key authentication (X-Agent-Key header)
- Separate encryption keys for JWT and OAuth token storage
- PII redaction in structured logs
- Rate limiting with per-endpoint controls
- CORS enforcement (wildcard rejected in production)
- Security headers (HSTS, CSP, X-Frame-Options)
- Soft delete with audit trail preservation

## API Reference

Base URL: `http://your-server:55000/api/v1`

Interactive docs: `http://your-server:55000/api/v1/docs`

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/auth/login` | POST | None | User login |
| `/auth/change-password` | POST | None | Password change (required on first login) |
| `/events/` | POST | Agent Key | Submit DLP event |
| `/agents/` | POST | None | Agent registration (returns API key) |
| `/agents/{id}/heartbeat` | PUT | Agent Key | Agent heartbeat |
| `/agents/{id}/policies/sync` | POST | Agent Key | Policy bundle sync |
| `/decision/` | POST | Agent Key | Real-time block/allow decision |
| `/decision/policy/latest` | GET | JWT | Policy version check |
| `/decision/policy/download` | GET | JWT | Full policy bundle download |
| `/classification/classify` | POST | None | Classify content |
| `/rules/` | CRUD | JWT | Detection rule management |
| `/rules/test` | POST | JWT | Test content against rules |
| `/rules/validate-regex` | POST | JWT | Validate regex pattern |
| `/policies/` | CRUD | JWT | Policy management |
| `/alerts/` | GET | JWT | Alert queries |

## Windows Agent

See [Windows Agent Installation Guide](docs/WINDOWS_AGENT_INSTALL.md).

Pre-built binary: `agents/endpoint/windows/cybersentinel_agent.exe` (3.9 MB, statically linked, no runtime dependencies).

## Linux Agent

```bash
cd agents/endpoint/linux
pip install -r requirements.txt
python agent.py --server-url http://your-server:55000/api/v1
```

Or install as a systemd service -- see `systemd/cybersentinel-agent.service`.

## Configuration

All configuration is via environment variables. See `.env.example` for the full list.

Key settings:

| Variable | Default | Description |
|----------|---------|-------------|
| `SECRET_KEY` | required | JWT signing key (min 32 chars) |
| `ENCRYPTION_KEY` | falls back to SECRET_KEY | Separate key for OAuth token encryption |
| `APP_TIMEZONE` | UTC | Display timezone (e.g., Asia/Kolkata) |
| `CORS_ORIGINS` | * | Allowed origins (wildcard blocked in production) |
| `PASSWORD_MIN_LENGTH` | 7 | Minimum password length |

## Production Deployment

Use `docker-compose.prod.yml` for production:

```bash
docker compose -f docker-compose.prod.yml up -d
```

This uses pre-built GHCR images, enables OpenSearch security, enforces TLS, and adds container resource limits.

For TLS, mount certificates:

```
TLS_CERT_PATH=/etc/letsencrypt/live/your.domain
```

## License

MIT
