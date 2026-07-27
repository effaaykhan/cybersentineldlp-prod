# CyberSentinel DLP — Complete Project Summary

**CyberSentinel DLP** is an enterprise **Data Loss Prevention** platform: endpoint agents watch for sensitive‑data exfiltration across many channels (files, clipboard, USB, screen capture, print, network, cloud drives), a FastAPI control plane classifies content and evaluates policies, and a React console gives SOC analysts real‑time visibility, enforcement, and incident management. It integrates with SIEMs (Wazuh, Splunk, ELK) and cloud storage (Google Drive, OneDrive).

- **Backend version:** 2.0.0 · **API base:** `/api/v1` · **Manager port:** 55000
- **Company:** Virtual Galaxy Infotech Ltd. · **License:** Apache 2.0
- **Prod repo (agent binary):** `effaaykhan/cybersentineldlp-prod`

---

## Table of Contents
1. [High‑Level Architecture](#1-high-level-architecture)
2. [Technology Stack](#2-technology-stack)
3. [Deployment Topology (Docker)](#3-deployment-topology-docker)
4. [Data Stores](#4-data-stores)
5. [Event Processing Pipeline](#5-event-processing-pipeline)
6. [Backend — API Modules & Endpoints](#6-backend--api-modules--endpoints)
7. [Backend — Services](#7-backend--services)
8. [Classification Engine](#8-classification-engine)
9. [Policy Engine & Actions](#9-policy-engine--actions)
10. [Integrations (SIEM) & Cloud Connectors](#10-integrations-siem--cloud-connectors)
11. [Core, Tasks & Data Models](#11-core-tasks--data-models)
12. [Auth, RBAC, ABAC & SSO](#12-auth-rbac-abac--sso)
13. [Endpoint Agents](#13-endpoint-agents)
14. [Dashboard — Routes & Navigation](#14-dashboard--routes--navigation)
15. [Dashboard — Pages & Sections](#15-dashboard--pages--sections)
16. [Policy Types](#16-policy-types)
17. [Dashboard — Shared Components & State](#17-dashboard--shared-components--state)
18. [Recent Updates (this cycle)](#18-recent-updates-this-cycle)
19. [Repository Layout](#19-repository-layout)
20. [Notes & Known Gaps](#20-notes--known-gaps)

---

## 1. High-Level Architecture

Three tiers plus data services:

- **Endpoint Agents** (Windows C++, Linux Python) — monitor local activity, classify content locally, enforce (block/quarantine), and report events. They register, heartbeat, pull versioned policy bundles, and POST events to the manager.
- **Manager (FastAPI)** — ingests events, classifies content, evaluates policies, executes actions, auto‑creates incidents, mirrors data across stores, exposes the REST API, forwards to SIEMs, and polls cloud drives.
- **Dashboard (React SPA)** — analyst console for dashboards, events, alerts, incidents, agents, rules, policies, users, and settings.
- **Data services** — PostgreSQL (relational/config), MongoDB (raw events), OpenSearch (analytics indices), Redis (cache/blacklist/broker), Celery (scheduled jobs).

---

## 2. Technology Stack

**Backend:** Python · FastAPI 0.104 · Uvicorn · Pydantic 2.5 · SQLAlchemy 2.0 (async) + Alembic (22 migrations) · Motor 3.3 / PyMongo 4.6 · redis‑py 5 · opensearch‑py 2.4 · Celery 5.3 · python‑jose (JWT/HS256) · passlib[bcrypt] · structlog · reportlab (PDF) · scikit‑learn / spaCy / transformers (ML libs bundled for extensibility) · cryptography/Fernet (token encryption).

**Frontend:** React 18 · TypeScript · Vite 5 · react‑router‑dom 6 · TanStack Query 5 · Zustand 4 (auth store, persisted) · Recharts 2 · Tailwind CSS 3 · lucide‑react · react‑hot‑toast · axios · tailwind‑merge. Served as a static build behind nginx.

**Windows agent:** C++17, MSYS2 MinGW‑w64 (`g++ -std=c++17 -O2 -static`), Win32/WinHTTP/WMI/SetupAPI, Tesseract OCR, optional KMDF/FltMgr kernel minifilter.

**Linux agent:** Python 3 · `requests` · `watchdog` (inotify) · systemd unit.

---

## 3. Deployment Topology (Docker)

`docker-compose.yml` orchestrates the stack (also `docker-compose.prod.yml`, `docker-compose.deploy.yml`):

| Service | Container | Image / Build | Port(s) | Role |
|---|---|---|---|---|
| **manager** | cybersentinel-manager | build `./server` | 55000 | FastAPI API (4 uvicorn workers); code volume‑mounted (`./server:/app`) |
| **dashboard** | cybersentinel-dashboard | build `./dashboard` | 3023→3000 | React build served by nginx (baked image — rebuild to deploy) |
| **postgres** | cybersentinel-postgres | postgres:15‑alpine | 5432 | Relational/config + event mirror |
| **mongodb** | cybersentinel-mongodb | mongo:7 | 27017 | Raw DLP events (authoritative) |
| **redis** | cybersentinel-redis | redis:7‑alpine | 6379 | Cache, JWT blacklist, Celery broker |
| **opensearch** | cybersentinel-opensearch | opensearchproject/opensearch:2.11 | 9200, 9600 | Analytics event indices |
| **celery-worker** | cybersentinel-celery-worker | build `./server` | — | Background task worker |
| **celery-beat** | cybersentinel-celery-beat | build `./server` | — | Scheduler |

Deployment helpers: `deploy.sh`, `deploy-ubuntu.sh`, `install.sh`, `Makefile`, `systemd/`, `config/env-templates/`. Docs: `DEPLOYMENT.md`, `README.md`, `INTEGRATION_COMPLETE.md`, `ONEDRIVE_SETUP_GUIDE.md`, `CLASSIFICATION_SYSTEM.md`, `CLASSIFICATION_POLICIES_GUIDE.md`, `WINDOWS_AGENT_INSTALL.md`, `TESTING_COMMANDS.md`, `UTILITY_COMMANDS.md`, `SECURITY.md`, `CHANGELOG.md`.

---

## 4. Data Stores

- **PostgreSQL** (authoritative for relational/config): users & RBAC, roles/permissions, policies + conditions + actions + policy‑agent links, rules, data labels, classified files, fingerprints, agents & agent logs, incidents/alerts, scans, audit logs, cloud connections & protected folders, and an `events` mirror for analytics/export.
- **MongoDB** (authoritative for raw events): collections `dlp_events`, `incidents` (auto‑incidents), `agents`, `classified_files`. Agents write here first; mirrored to Postgres via `pg_event_mirror`. Indexes on `dlp_events` (id, dept/timestamp, dept/severity) and `incidents`.
- **OpenSearch**: Wazuh‑style **daily rolling indices** `cybersentinel-events-YYYY.MM.DD` with an index template; used for analytics/dashboard aggregations; ~90‑day retention.
- **Redis**: JWT token blacklist (logout/revocation), user→department attribute cache, rate limiting, and Celery broker/result backend.

---

## 5. Event Processing Pipeline

1. **Ingest** — agent POSTs to `/events` (or `/decision/events/batch`). Fields declared on `EventCreate` are persisted (undeclared fields are dropped by design).
2. **Enrich** — resolve user → department/clearance (ABAC tagging via `user_dept_cache`), stamp timestamp/source.
3. **Classify** — `classification_engine` labels content (Public/Internal/Confidential/Restricted + confidence).
4. **Evaluate** — `database_policy_evaluator` / `decision_engine` match policies → decide action (priority + action precedence).
5. **Act** — `action_executor` runs actions (alert/block/quarantine/notify/webhook/…); block/quarantine or high/critical → auto‑incident.
6. **Persist & fan‑out** — write to MongoDB, mirror to Postgres (`pg_event_mirror`), index to OpenSearch, optionally forward to SIEMs.

---

## 6. Backend — API Modules & Endpoints

All routes are under `/api/v1/<prefix>`.

**`/auth`** — `POST /register`, `POST /login` (access+refresh JWT), `POST /refresh`, `POST /change-password`, `POST /logout` (Redis blacklist), `GET /me`, `GET /users/check`, `POST /sso/exchange` (SIEM‑signed SSO).

**`/users`** — `GET /me`, `GET /`, `POST /`, `GET/PUT/DELETE /{user_id}`.

**`/permissions`** — `GET /` (permission catalog).

**`/agents`** *(supports optional `X-Agent-Key`)* — `GET /`, `GET /all` (lifecycle status), `POST /` (register), `GET /{id}`, `PUT /{id}/heartbeat`, `DELETE /{id}/unregister`, `DELETE /{id}`, `POST /cleanup-stale`, `GET /stats/summary`, `POST /{id}/policies/sync` (versioned bundle), `POST /{id}/policy/evaluate` (real‑time content classification).

**`/events`** — `POST /` (ingest + background processing + auto‑incident), `GET /` (query, ABAC‑scoped), `GET /{id}`, `GET /stats/summary`, `GET /stats/by-type`, `GET /stats/by-severity`, `DELETE /clear`.

**`/classification`** — `POST /classify`, `GET /patterns`, `GET /labels`, `POST /cache/invalidate`, `GET /files`, `GET /files/{id}`, `GET /stats/summary`, `GET /stats/by-type`.

**`/rules`** — `POST /`, `GET /`, `GET /statistics`, `GET/PUT/DELETE /{id}`, `POST /{id}/toggle`, `POST /test`, `POST /bulk-import`, `POST /validate-regex`.

**`/policies`** — `GET /`, `GET /{id}`, `POST /`, `PUT /{id}`, `DELETE /{id}`, `POST /{id}/enable`, `POST /{id}/disable`, `POST /cache/refresh`, `GET /stats/summary`.

**`/alerts`** — `GET /`, `GET /{id}`, `POST /{id}/acknowledge`, `POST /{id}/resolve`.

**`/incidents`** — `GET /`, `GET /statistics`, `GET /{id}`, `POST /`, `PATCH /{id}`, `POST /{id}/comments`, `GET /{id}/comments`, plus auto‑incidents: `GET /auto/list`, `GET /auto/{id}`, `PATCH /auto/{id}`.

**`/dashboard`** — `GET /overview`, `GET /timeline`, `GET /stats/agents`, `GET /stats/classification`.

**`/analytics`** — `GET /trends`, `GET /top-violators`, `GET /data-types`, `GET /policy-violations`, `GET /severity-distribution`, `GET /summary`.

**`/export`** — CSV + PDF for `trends`, `violators`, `data-types`, `policy-violations`, plus `GET /analytics/summary/pdf`.

**`/audit-logs`** — `GET /`, `GET /actions`.

**`/fingerprints`** — `POST /`, `POST /from-content`, `POST /check`, `GET /`, `DELETE /{id}`.

**`/scans`** — `POST /`, `GET /`, `GET /{id}`, `GET /{id}/results` (data‑discovery scans).

**`/decision`** *(agent enforcement API)* — `POST /` (single decision), `POST /events/batch`, `GET /policies/sync`, `GET /policy/latest`, `GET /policy/download`.

**`/siem`** *(SSRF‑guarded)* — `GET/POST/DELETE /connectors`, `POST /connectors/{name}/test`, `GET /connectors/health`, `POST /forward-event`, `POST /forward-batch`.

**`/google-drive`** & **`/onedrive`** — `POST /connect`, `GET /callback`, `GET /connections`, `GET /connections/{id}/folders`, `DELETE /connections/{id}`, `GET …/status`, `GET …/protected-folders`, `POST /connections/{id}/baseline`, `POST /poll`.

---

## 7. Backend — Services

`server/app/services/`:

- **abac_service** — builds the ABAC visibility predicate; emits both SQLAlchemy and Mongo filters so the two stores stay in sync.
- **agent_service** — agent CRUD/registration.
- **alert_service** — alert CRUD / acknowledge / resolve.
- **analytics_service** — dashboard/report aggregation across Postgres + OpenSearch.
- **audit_service** — audit logging incl. ABAC‑deny/scope logging.
- **blacklist_service** — JWT token blacklisting in Redis.
- **classification_engine** — multi‑technique sensitive‑data classifier (see §8).
- **event_mapper** — Mongo doc → Postgres `events` row mapper.
- **event_processor** — validation → normalization → enrichment → classification → policy evaluation.
- **event_service** — event CRUD/query.
- **export_service** — CSV + PDF report generation (reportlab).
- **fingerprint_service** — SHA‑256 document fingerprinting/matching.
- **google_drive_oauth / _polling / _event_normalizer** — Drive OAuth (Fernet‑encrypted tokens), Activity API polling, event normalization.
- **onedrive_oauth / _polling / _event_normalizer** — Microsoft Graph OAuth, delta polling, normalization.
- **incident_service** — incident + comment CRUD/statistics.
- **permission_service** — resolves effective permission set (ADMIN wildcard ∪ role perms ∪ direct grants).
- **pg_event_mirror** — dual‑write Mongo→Postgres (failure‑isolated; bulk variant).
- **policy_service / rule_service** — policy & rule CRUD/business logic.
- **reporting_service** — scheduled report generation + SMTP email (daily/weekly/monthly).
- **scan_service** — data‑discovery scan orchestration.
- **user_dept_cache** — user→department/attrs with Redis caching (ingest tagging).
- **user_service** — user CRUD.

---

## 8. Classification Engine

`services/classification_engine.py` — a **pattern + heuristic** engine (not ML at runtime; ML libraries are bundled for extensibility). Techniques:

1. **File fingerprinting** — SHA‑256 exact‑hash match → authoritative `Restricted` (confidence 1.0).
2. **Regex patterns** — precompiled/cached, with validators: **Luhn** (credit cards), **Verhoeff** (Aadhaar).
3. **Keyword matching** — case sensitive/insensitive.
4. **Dictionary matching** — external wordlists (set intersection).
5. **Entropy analysis** — Shannon entropy for encoded/encrypted content.
6. **Context‑aware scoring** — file‑type risk (`.xlsx/.csv/.sql/.env/.pem/.key` high‑risk) + source‑channel risk (clipboard/usb/removable/email/cloud).

- Rules are **database‑driven** (`Rule`, `DataLabel` tables), module‑cached (60s TTL), refreshable via `/classification/cache/invalidate`. Content capped at 10 MB.
- **Classification levels** by confidence: `Public` (<0.3), `Internal` (0.3–0.6), `Confidential` (0.6–0.8), `Restricted` (≥0.8).
- **Detected data types** (rule‑driven; agents detect a broad set locally): credit card, SSN, PAN, Aadhaar, IFSC, UPI, passport, email, phone, API keys (Stripe/JWT/AWS/GitHub), AWS keys, private keys (PEM/OpenSSH/PuTTY), DB connection strings, IPv4/v6, bank account/MICR, DOB, source code.

---

## 9. Policy Engine & Actions

**Policy engine** (`server/app/policies/`):

- **decision_engine.py** — deterministic: candidate policies → sort by **priority DESC** → resolve ties by **action precedence** (`block 100 > quarantine 90 > encrypt 80 > alert 50 > warn 40 > allow 10 > log 5`) → default **allow + log**. Returns action, reason, policy, severity, cache TTL, `should_create_incident`. Cache TTL: block 60s / allow 600s / default 300s. Fail‑open; target <100 ms.
- **database_policy_evaluator.py** — loads active Postgres policies (generation‑counter cache). Evaluates **condition trees**: `match = all|any|none`, nested rules; operators `equals, contains, starts_with, matches_any_prefix, matches_regex, in, >=, <=, >, <`; dotted field paths. Returns `PolicyMatch` list.
- **agent_policy_transformer.py** — builds the per‑agent bundle: filters by platform + capability flags, groups by policy type, computes a **SHA‑256 version hash**.
- **cache_control.py** — shared generation counter to invalidate evaluator caches.

**Actions** (`server/app/actions/`):

- **action_types.py** — `ActionType`: `alert, block, quarantine, redact, encrypt, notify, webhook, audit, tag, escalate, delete, preserve, flag_for_review, create_incident, track`. Enums: `RedactionMethod`, `EncryptionAlgorithm` (AES‑256/128, RSA‑2048/4096), `NotificationChannel` (email/slack/teams/pagerduty/sms/webhook/siem).
- **action_executor.py** — dispatches each action; notify supports email (SMTP), Slack, Teams, PagerDuty, SMS.

---

## 10. Integrations (SIEM) & Cloud Connectors

**SIEM** (`server/app/integrations/siem/`):
- **base.py** — `SIEMConnector` ABC (`connect/test/send_event/send_batch/query/create_alert/health_check` + `format_dlp_event`).
- **splunk_connector.py** — Splunk (HEC send/batch/query/alert).
- **elk_connector.py** — Elasticsearch/Logstash/Kibana (index events/batch, query, alert, index template).
- **integration_service.py** — connector registry; `connect_all / send_event_to_all / send_batch_to_all / health_check_all`.
- **Wazuh** — integrated via `WAZUH_*` config (host/port + UDP syslog + API) and Wazuh‑style OpenSearch indices; Splunk/ELK via connectors and the `/siem` router.

**Cloud connectors** — Google Drive & OneDrive: OAuth connect (Fernet‑encrypted tokens), folder/baseline selection, delta/Activity polling every 5 min (Celery), event normalization into the DLP pipeline. Two modes: **Local** monitoring (agent watches `G:\My Drive`) and **Cloud API** monitoring (log‑only).

---

## 11. Core, Tasks & Data Models

**Core** (`server/app/core/`): `config` (Pydantic settings for PG/Mongo/Redis/OpenSearch/JWT/SMTP/Wazuh/ML/retention), `database` (async SQLAlchemy + Motor init, index creation, DI), `security` (bcrypt, JWT create/decode, `get_current_user`, `require_role`, `require_permission`, Redis blacklist), `opensearch` (daily index template/rollover), `cache` (Redis), `observability`, `timezone`, `validation`, `logging` (structlog). **Middleware:** `rate_limit`, `request_id`, `security` headers.

**Celery tasks** (`server/app/tasks/`, UTC): `generate_daily_reports` (08:00), `generate_weekly_reports` (Mon 09:00), `generate_monthly_reports` (1st 10:00), `poll_google_drive_activity` (5 min), `poll_onedrive_activity` (5 min), `cleanup_old_events` (02:00 retention purge).

**Data models** (`server/app/models/`, PostgreSQL): `users` (+`UserRole`), `roles`, `permissions`, `role_permissions`, `user_permissions`, `agents`, `agent_logs`, `events`, `alerts`, `incidents`, `incident_comments`, `policies`, `policy_actions`, `policy_conditions`, `policy_agents`, `rules`, `data_labels`, `classified_files`, `file_fingerprints`, `scan_jobs`, `scan_results`, `audit_logs`, `devices`, `endpoints`, `google_drive_connections`, `google_drive_protected_folders`, `onedrive_connections`, `onedrive_protected_folders`.

---

## 12. Auth, RBAC, ABAC & SSO

- **Auth:** JWT (HS256) access (30 min) + refresh (7 day); bcrypt passwords; Redis token blacklist; `must_change_password` flow.
- **Roles** (`UserRole`): `ADMIN`, `ANALYST`, `MANAGER`, `VIEWER`, `AGENT`. Hierarchy ADMIN(3) > ANALYST/MANAGER(2) > VIEWER(1).
- **Permissions:** fine‑grained catalog; granted by role and by direct user grant. Effective set = ADMIN wildcard ∪ role perms ∪ direct grants. Enforced by `require_permission`; denials audited.
- **ABAC:** visibility scoped by user `department` + `clearance_level`; applied uniformly to events/alerts/incidents/analytics across Postgres and Mongo; ADMIN bypasses.
- **SSO:** `POST /auth/sso/exchange` — a SIEM signs a token with shared `DLP_SSO_SECRET`; DLP verifies and issues its own JWTs. Disabled (503) if the secret is unset.

---

## 13. Endpoint Agents

Two agents register, heartbeat, pull versioned policy bundles, classify locally, enforce, and POST events. Transport is JSON over HTTP; the server supports an optional `X-Agent-Key` header (agents currently operate without it via the backward‑compat path).

### 13.1 Windows Agent (C++)
Monolithic `agent.cpp` plus modules; compiled with MSYS2 MinGW‑w64; deployed to `C:\Program Files\CyberSentinel\` and run as **Scheduled Task "CyberSentinel DLP Agent"** (not a service). Config `agent_config.json` reads `server_url, agent_name, agent_id, heartbeat_interval, policy_sync_interval`; everything else comes from server‑pushed policies.

**Monitors (worker threads):**
- **File system** — `ReadDirectoryChangesW`, recursive; subtypes `file_created/modified/deleted/renamed`; 2 s dedup; 10 MB cap; per‑line `content_changes` diff on modify.
- **Clipboard** — 200 ms poll of `CF_UNICODETEXT`; classifies and clears clipboard **before** emitting the event (beats the paste race); subtype `clipboard_copy`.
- **USB device** — `WM_DEVICECHANGE`; subtypes `usb_connect/usb_disconnect/usb_blocked`; captures **serial number, manufacturer, product/model (via USBSTOR disk node), volume label, volume serial, filesystem, drive letter, capacity, VID/PID** (cached at connect so disconnect reports the same).
- **USB file‑transfer** — polls removable drives (1 s), baseline diff; subtype `usb_file_transfer`; block/quarantine/alert.
- **Screen capture / OCR** — low‑level keyboard hook intercepts PrintScreen / Alt+PrintScreen / Win+Shift+S; kills capture tools (Snipping Tool, Greenshot, ShareX, Lightshot, Snagit, OBS, Bandicam, ScreenToGif, Flameshot, PicPick, FastStone); a background **Tesseract OCR** thread flags whether the foreground window is Restricted/Confidential and only then swallows the keystroke (+clears clipboard +warns). `event_type="screen_capture"`.
- **Print** — `FindFirstPrinterChangeNotification`; classifies document name; **cancels the job** (`SetJob(JOB_CONTROL_DELETE)`) for Restricted/Confidential. `event_type="print_attempt"`.
- **Network exfiltration** — WMI process‑creation consumer; on **curl/wget/PowerShell/bitsadmin/certutil/python** it **suspends** the process, extracts referenced file paths, classifies, and **terminates** if Confidential/Restricted (full block); detects `-EncodedCommand`/base64 evasion; **browsers = alert only**. `event_type="network_exfil"`.

**Enforcement:** USB block in 3 layers (registry `USBSTOR Start=4` + stop service; `CM_Disable_DevNode`; eject via `IOCTL_STORAGE_EJECT_MEDIA`), reversible when the policy is removed. File block = delete; **quarantine** = move to `C:\Quarantine\…` with auto‑restore (files 10 min, USB transfers 2 min).

**Local classifier:** broad regex/keyword engine (18+ data types incl. Aadhaar/PAN/IFSC/UPI, credit card w/ Luhn, SSN, API/private keys). For USB transfers it can also call the server (`POST /agents/{id}/policy/evaluate`, fail‑open).

**Kernel minifilter** (`kernel/csfilter.c`): KMDF/FltMgr driver **`CyberSentinelFilter`**, altitude 370100, intercepts `IRP_MJ_CREATE/WRITE/SET_INFORMATION` on **removable media only**; sends events to user mode over comm port `\CyberSentinelPort` (5 s timeout, fail‑open ALLOW); user side (`filter_comm.h`) reads first 64 KB → `PolicyEngine::Evaluate` → Allow/Warn/Block.

**Protocol:** `POST /agents` (register), `PUT /agents/{id}/heartbeat`, `POST /agents/{id}/policies/sync` (bundle groups: file_system, clipboard, usb_device, usb_file_transfer, file_transfer, google_drive_local), `POST /events`, `POST /agents/{id}/policy/evaluate`, `DELETE /agents/{id}/unregister`.

### 13.2 Linux Agent (Python)
`agent.py` deployed to `/opt/cybersentinel/`, config `/etc/cybersentinel/agent_config.json`, run via systemd unit `cybersentinel-agent.service` (Restart=always). **Capabilities: file‑system monitoring only** (`watchdog`/inotify, recursive) plus path‑based transfer detection (hash‑match a file appearing at a monitored destination against protected sources). Subtypes `file_created/modified/moved/deleted`; transfers `transfer_blocked/transfer_attempt`. FS events are detection‑only; block/quarantine fire only on transfer events. **Local regex classifier** (narrower set: credit card/PAN, SSN, email, API key, PEM key; no Aadhaar; no Public/Internal/Confidential/Restricted taxonomy). Quarantine = move to `/opt/cybersentinel/quarantine/…`; block = delete. Heartbeat 3 s, policy sync 60 s. (`print_monitor.py`, `policy_cache.py` exist but are not wired into `agent.py`.)

### 13.3 Capability parity
| Capability | Windows | Linux |
|---|---|---|
| File‑system monitor | ✅ | ✅ |
| Clipboard | ✅ (block via clear) | ❌ |
| USB device + details | ✅ (serial/model/volume/drive) | ❌ |
| USB file‑transfer block/quarantine | ✅ | Path‑based only |
| Screen capture / OCR | ✅ (hook + Tesseract) | ❌ |
| Print monitor | ✅ (cancels job) | Code exists, not wired |
| Network exfil block | ✅ (suspend→classify→kill) | ❌ |
| Kernel minifilter | ✅ (altitude 370100) | ❌ |
| Local classifier | Broad (18+ types) | Narrow (5 types) |
| Real‑time server classify | ✅ (`/policy/evaluate`) | ❌ |

---

## 14. Dashboard — Routes & Navigation

Vite + React SPA; routes in `src/App.tsx`, shell in `src/components/Layout.tsx` (Sidebar + Header + `<main>` + Footer).

| Path | Page | Source |
|---|---|---|
| `/login` | Login | `pages/Login.tsx` |
| `/auth/sso` | SSO callback | `pages/SSOCallback.tsx` |
| `/dashboard` | Dashboard | `pages/Dashboard.tsx` |
| `/agents` | Agents | `pages/Agents.tsx` |
| `/events` | Events | `pages/Events.tsx` |
| `/alerts` | Alerts | `pages/Alerts.tsx` |
| `/rules` | Rules | `pages/Rules.tsx` |
| `/policies` | Policies | `app/dashboard/policies/page.tsx` |
| `/incidents` | Incidents | `app/dashboard/incidents/page.tsx` |
| `/log-explorer` | Log Explorer | `app/dashboard/log-explorer/page.tsx` |
| `/admin/users` | User Management | `pages/UserManagement.tsx` |
| `/settings` | Settings | `pages/Settings.tsx` |

**Sidebar groups** (permission‑gated; a group hides if empty): **Overview** (Dashboard) · **Monitor** (Agents, Events, Alerts, Incidents, Log Explorer) · **Enforce** (Rules, Policies) · **Administer** (User Management, Settings). **Header:** breadcrumb page title, "Live" indicator, user menu (Settings / Log out).

*(Dead, non‑routed duplicates exist: `pages/{Policies,Incidents,LogExplorer,AuditTrail}.tsx` and several `app/dashboard/*` pages.)*

---

## 15. Dashboard — Pages & Sections

**Dashboard** — live stats (5 s refetch). 4 drill‑down **stat cards** (Total Events, Active Agents w/ % online, Critical Alerts, Blocked Events w/ block‑rate). **Charts:** Events Over Time (area, hourly, IST), Events by Type (clickable donut + legend), Events by Severity (clickable bar). **DLP Enforcement** panel (Blocked / Critical / Total → drill‑down). Themed tooltips with "click to filter" hints.

**Agents** — live agent list (incl. disconnected/history). Binary **lifecycle** (active/disconnected). 3 clickable stat filters (Total/Active/Disconnected). Table: Status, Agent ID (`agent_code`/UUID), Name+hostname, OS+version, IP, Last Seen, Registered, Actions; row → `/events?agent=`. **Remove** (soft‑delete, reappears on next heartbeat) and **Cleanup Stale** (two‑step preview→apply, older‑than‑N‑days).

**Events** — KQL‑style search + Quick Filters (Critical/Blocked/File/USB/Clipboard/With Classifications); dashboard drill‑down chips; agent‑name resolution; **Manual Refresh** (also triggers cloud polling) and **Clear Logs**. **EventDetailModal:** blocked‑transfer flow view (Source→USB destination, block status, SHA‑256, raw JSON); general view with classification result + confidence, detected sensitive‑data labels, matched policies, clipboard content, file info + quarantine, **content‑changes diff** (added/removed lines), and the **USB Device Details** grid (product/manufacturer/serial/volume label/serial/filesystem/drive letter/capacity/VID/PID) + expandable raw JSON.

**Alerts** — live alerts (10 s). 3 stat filters (Total/High/Critical), search. List: severity, status (New/Acknowledged/Resolved), title, description, agent, time, event id. **AlertDetailsModal** fetches the full event.

**Incidents** — auto‑incidents from blocked/critical events (15 s). 4 stat cards + **3‑column Kanban** (Open/Investigating/Resolved). Cards show title, user, event count, severity. **Detail modal:** info grid, classification badge, **Update Status** buttons, related events (expandable), raw JSON.

**Log Explorer** — full‑text search + time presets (5 m–90 d) + custom range; filters (type/severity/classification/agent/user). 4 stat cards (Results/Clipboard/USB/Blocked). **CSV + JSON export.** Results table with expandable rows (matched rules, detected content, raw JSON).

**Rules** (classification rules) — stats (Total/Enabled/Disabled/By‑type), search + type tabs (regex/keyword/dictionary). Table: toggle status, name, type, category, severity, weight, matches. **RuleModal** (create/edit), **RuleTestModal** (test against sample content), bulk import, regex validation.

**Policies** — active + inactive `PolicyTable`s; stats (Total/Active/Inactive/Violations‑24h). **Create Policy** (3‑step wizard: Type → Config → Review), **Refresh Bundles**, per‑row context menu (View/Edit/Duplicate/Activate‑Deactivate/Delete), **PolicyDetailsModal**. See §16 for policy types.

**User Management** (admin‑gated) — table: Email, Username, Full Name, Department, Role, Clearance, Permissions (effective/total + "+N direct"), Status, Actions. Create/Edit dialog with **PermissionPicker** (grouped checkboxes) + clearance (0–10) + department + active toggle. **Deactivate** (soft) and **Hard‑Delete** (type‑email‑to‑confirm, audited).

**Settings** — Account Security (change password), System Settings, OpenSearch/Database settings, Notifications, **Cloud Connectors** (Connect Google Drive / OneDrive via OAuth popups), About (v2.0.0). Cloud folder/baseline selection lives in the cloud policy forms.

**Login / SSO** — sign‑in (username/password, show/hide) + change‑password mode; blueprint‑grid background. SSO callback exchanges `?token=` at `/auth/sso/exchange` and populates the auth store.

---

## 16. Policy Types

Nine policy types (`components/policies/PolicyTypeSelector.tsx`, `types/policy.ts`):

1. **Clipboard Monitoring** — predefined + custom regex patterns (live test); block/alert/log.
2. **File System Monitoring** — monitored dirs + extensions + patterns + create/modify/delete events; detect‑oriented (block/quarantine/alert/log).
3. **File Transfer Monitoring** — protected sources + monitored destinations + extensions + sensitive patterns; block/quarantine/alert.
4. **USB Device Monitoring** — connect/disconnect/file‑transfer events; alert/log/block.
5. **USB File Transfer Monitoring** — monitored dirs; block/quarantine/alert.
6. **Google Drive (Local)** — watch `G:\My Drive` folders/extensions/events; log/alert/block.
7. **Google Drive (Cloud API)** — OAuth connection, protected folders, baseline, 5–60 min polling; log‑only.
8. **OneDrive (Cloud API)** — Microsoft Graph OAuth, protected folders, baseline, polling; log‑only.
9. **Classification‑Aware Policy** — condition tree (match ALL/ANY on `classification_level`, `confidence_score`, `labels`, `event_type`, `destination_type`, `file_extension`) → actions alert/block/quarantine/log.

`utils/policyUtils.ts` provides validation, regex testing, action‑rank resolution, API↔frontend transforms, and `predefinedPatterns` (SSN, credit card, email, phone, API/private keys, Indian identifiers Aadhaar/PAN/IFSC/UPI, source‑code detectors).

---

## 17. Dashboard — Shared Components & State

- **StatsCard** — semantic color palettes, optional trend chip, subtext, drill‑down link with hover arrow.
- **Charts** — Recharts (Area/Bar/Pie), shared theming in `styles/charts.ts`, custom tooltips, dashboard widgets (`EventsTimeline`, `RecentEvents`, `TopUsers`, `TopViolations`).
- **Drill‑down system** (`lib/drilldown.ts`) — centralized `drillDownUrl(filters)` → `/events?…` (whitelisted fields: severity, module/event_type, action, classification, channel, dates).
- **Cloud connector UIs** — OAuth flows + `ProtectedFolderSelector` (OneDrive/Google Drive) for folder selection & baselines.
- **RBAC gating** — `hooks/usePermission.ts` (`has/hasAny/role/permissions/isAdmin`) drives sidebar visibility and admin page/action gating (UI‑only; backend re‑enforces).
- **Auth state** — Zustand + `persist` (localStorage `dlp-auth-v3`): `isAuthenticated`, `user`, `accessToken`, `refreshToken`. Login POSTs `/auth/login` then resolves identity via `/auth/me`; ADMIN is a global wildcard. `refreshMe`, `logout`, `setTokens` (SSO). API client via axios (`lib/api/*`).
- Common: `LoadingSpinner`, `ErrorMessage`, `Footer` (VGI branding), global `Toaster`, modals with Escape/scroll‑lock.

---

## 18. Recent Updates (this cycle)

- **Agent visibility fix** — a live heartbeat (or re‑registration) now clears `is_deleted`, so a running, soft‑deleted agent can never stay hidden. `AGENT_TIMEOUT_SECONDS` raised 30→120 s to stop flicker.
- **Binary agent lifecycle** — collapsed to **active / disconnected**; removed the `decommissioned` concept and the inactive/stale tiers (endpoint + UI).
- **USB device details capture** — Windows agent now reports serial, manufacturer, real model (from the USBSTOR disk node), volume label/serial, filesystem, drive letter, and capacity; the server persists these on `EventCreate`/`event_doc`, and the Events modal shows a **USB Device Details** card.
- **Dashboard UI refresh** — a cohesive light "instrument" theme: single indigo accent, monospace telemetry for all data, hairline cards, regrouped sidebar, filled top bar; the legacy dark "Obsidian Vault" overlay was retired.

---

## 19. Repository Layout

```
Data-Loss-Prevention/
├── server/                     FastAPI backend
│   ├── app/
│   │   ├── api/v1/             REST routers (agents, events, policies, siem, …)
│   │   ├── services/          business logic (classification, ABAC, cloud, …)
│   │   ├── policies/          decision engine, evaluator, bundle transformer
│   │   ├── actions/           action types + executor
│   │   ├── integrations/siem/ Splunk / ELK connectors
│   │   ├── models/            SQLAlchemy entities
│   │   ├── core/              config, db, security, opensearch, cache
│   │   ├── tasks/             Celery jobs
│   │   └── middleware/        rate limit, request id, security headers
│   ├── alembic/versions/      22 migrations
│   └── requirements.txt
├── dashboard/                  React SPA (Vite)
│   └── src/{pages,app,components,lib,hooks,styles,types}
├── agents/endpoint/
│   ├── windows/               agent.cpp, monitors, kernel/ minifilter
│   └── linux/                 agent.py, systemd unit
├── database/                   Postgres + Mongo init
├── ml/models/                  ML model dir (extensibility)
├── config/env-templates/       env samples
├── scripts/  systemd/  docs/   ops, service units, docs
├── docker-compose*.yml         stack definitions
└── *.md                        README, DEPLOYMENT, CLASSIFICATION_*, ONEDRIVE_SETUP, …
```

---

## 20. Notes & Known Gaps

- **Agent transport auth:** the server supports an optional `X-Agent-Key`, but the shipped agents currently post without it (backward‑compat path); agent traffic defaults to plain HTTP.
- **Linux agent** covers file‑system + path‑based transfers only; clipboard/USB/screen/print/network are Windows‑only. Its `print_monitor.py` and `policy_cache.py` are present but not wired into `agent.py`.
- **Classification at runtime** is pattern/heuristic‑based; the bundled ML libraries (scikit‑learn, spaCy, transformers) are available for future ML classification but are not the active path.
- **Cloud API monitoring** (Google Drive / OneDrive) is log‑only; enforcement there is not applied.
- Several **non‑routed duplicate pages** exist under `src/pages/` and `src/app/dashboard/` — only the files listed in §14 are live.

---

*Generated as a point‑in‑time summary of the CyberSentinel DLP codebase. Verify specifics against the current source before relying on them for security‑critical decisions.*
