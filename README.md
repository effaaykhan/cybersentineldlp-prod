# CyberSentinel DLP

**Enterprise-Grade Data Loss Prevention Platform**

[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED.svg)](https://docs.docker.com/compose/)
[![Python 3.11+](https://img.shields.io/badge/python-3.11+-blue.svg)](https://www.python.org/downloads/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.104-009688.svg)](https://fastapi.tiangolo.com)
[![React](https://img.shields.io/badge/React-18.2-61DAFB.svg)](https://react.dev)

Production-ready Data Loss Prevention platform with **dynamic rule-based classification**, real-time endpoint monitoring, cloud storage integration, and automated policy enforcement.

---

## ✨ Key Features

### 🎯 **Dynamic Classification System**
- **Rule-Based Detection** — 20+ pre-configured rules for PII, financial data, credentials
- **Confidence Scoring** — Weighted scoring (0.0-1.0) with classification levels
- **No-Code Management** — Add/edit/test rules via UI without code changes
- **Real-Time Testing** — Interactive tool to test content against rules

### 🔒 **Endpoint Protection**
- **File System Monitoring** — Real-time detection of file create/modify/delete
- **Clipboard Monitoring** — Captures and classifies clipboard content (Windows)
- **USB Device Control** — Block unauthorized USB file transfers
- **Content Classification** — Automatic PII detection with confidence scoring

### ☁️ **Cloud Integration**
- **Google Drive** — OAuth connection, folder monitoring, activity polling
- **OneDrive** — Microsoft Graph integration with delta queries

### 📊 **Policy Engine**
- **Classification-Aware Policies** — Use confidence scores and classification levels
- **Flexible Conditions** — Supports numeric operators (>=, <=, >, <)
- **Multiple Actions** — Log, alert, block, quarantine
- **Agent Scoping** — Assign policies to specific endpoints

### 🎨 **Management Dashboard**
- **Real-Time Monitoring** — Live event stream and alerts
- **Rules Management** — Create, test, and manage classification rules
- **Policy Builder** — Visual policy creation with classification conditions
- **Analytics** — Event trends, top violators, compliance reports

---

## 🚀 Quick Start — One-Liner Installation

### **Prerequisites**

- Docker 20.10+ and Docker Compose v2.0+
- 4 GB RAM (8 GB recommended)
- 20 GB disk space

### **Install CyberSentinel DLP Server**

Run this single command on your server:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/effaaykhan/Data-Loss-Prevention/main/install.sh)
```

**That's it!** The script will:
1. ✅ Download production-ready Docker images from GitHub Container Registry
2. ✅ Create installation directory at `~/cybersentinel-dlp`
3. ✅ Generate secure configuration with random passwords
4. ✅ Start all services (PostgreSQL, MongoDB, Redis, OpenSearch, API, Dashboard)
5. ✅ Import 20 default classification rules

**No source code needed. No build steps. Just run and go.**

---

## 📱 Access Your DLP Platform

After installation completes (1-2 minutes), access:

| Service | URL | Default Credentials |
|---------|-----|-------------------|
| **Dashboard** | `http://localhost:4000` | `admin@cybersentinel.local` / `admin123` |
| **API** | `http://localhost:55000` | Same as above |
| **API Docs** | `http://localhost:55000/docs` | Interactive Swagger UI |

> ⚠️ **Change the default password immediately** after first login!

---

## 📖 Step-by-Step Installation Guide

### 1. Server Installation

#### Option A: One-Liner (Recommended)

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/effaaykhan/Data-Loss-Prevention/main/install.sh)
```

#### Option B: Manual Installation

```bash
# 1. Create directory
mkdir -p ~/cybersentinel-dlp && cd ~/cybersentinel-dlp

# 2. Download docker-compose file
curl -fsSL https://raw.githubusercontent.com/effaaykhan/Data-Loss-Prevention/main/docker-compose.prod.yml -o docker-compose.yml

# 3. Create .env file
cat > .env << EOF
POSTGRES_PASSWORD=YourSecurePassword123!
MONGODB_PASSWORD=YourSecurePassword123!
REDIS_PASSWORD=YourSecurePassword123!
OPENSEARCH_PASSWORD=YourSecurePassword123!
JWT_SECRET=$(openssl rand -hex 32)
ENVIRONMENT=production
EOF

# 4. Start services
docker compose pull
docker compose up -d

# 5. Wait for services (30-60 seconds)
docker compose logs -f manager
```

#### Verify Installation

```bash
# Check all services are running
docker compose ps

# Test API health
curl http://localhost:55000/api/v1/health
# Expected: {"status":"healthy"}

# Open dashboard
# http://localhost:4000
```

You should see 8 running containers:
- `postgres` - PostgreSQL database
- `mongodb` - Event storage
- `redis` - Cache and sessions
- `opensearch` - Search and analytics
- `manager` - API server
- `dashboard` - React UI
- `celery-worker` - Background tasks
- `celery-beat` - Scheduled jobs

---

### 2. Agent Installation

#### Windows Agent (Compiled C++ - No Dependencies)

Run in **elevated PowerShell** (Run as Administrator):

```powershell
iex (irm https://raw.githubusercontent.com/effaaykhan/Data-Loss-Prevention/main/agents/endpoint/newWindowsAgent/Install-CyberSentinelAgent.ps1)
```

When prompted, enter your server URL: `http://<SERVER-IP>:55000/api/v1`

**What it does:**
- Downloads compiled agent executable
- Installs to `C:\Program Files\CyberSentinel\`
- Creates scheduled task (runs at startup as SYSTEM)
- Registers with server immediately
- Appears in Dashboard → Agents within 30 seconds

**Capabilities:**
- File system monitoring
- Clipboard monitoring
- USB device detection
- File transfer blocking
- Google Drive local mirror monitoring

#### Linux Agent

Run on any Linux machine with Python 3.8+:

```bash
curl -sLO https://raw.githubusercontent.com/effaaykhan/Data-Loss-Prevention/main/install_linux_agent.py
sudo python3 install_linux_agent.py --server-url http://<SERVER-IP>:55000/api/v1
```

**What it does:**
- Downloads agent from GitHub
- Creates virtual environment
- Installs dependencies
- Generates config with unique agent ID
- Creates systemd service
- Starts and registers with server

**Capabilities:**
- File system monitoring
- File transfer detection
- Content classification
- Policy sync

---

### 3. First-Time Setup

#### 1. Login and Change Password

1. Navigate to `http://localhost:4000`
2. Login with `admin@cybersentinel.local` / `admin123`
3. Go to **Settings** → **Change Password**
4. Set a strong password

#### 2. Explore Pre-Configured Rules

1. Go to **Rules** page
2. View 20 default rules (SSN, credit cards, API keys, etc.)
3. Click **Test Rules** to try classification
4. Test content:
   ```
   My SSN is 123-45-6789
   Credit Card: 4111-1111-1111-1111
   Email: john@example.com
   ```
5. See classification: **Restricted** with **~95% confidence**

#### 3. Create Your First Policy

1. Go to **Policies** page
2. Click **Create Policy**
3. Example: **Block Restricted Data on USB**
   ```json
   {
     "name": "Block Restricted Data on USB",
     "conditions": {
       "match": "all",
       "rules": [
         {
           "field": "classification_level",
           "operator": "equals",
           "value": "Restricted"
         },
         {
           "field": "destination_type",
           "operator": "equals",
           "value": "removable_drive"
         }
       ]
     },
     "actions": {
       "block": {},
       "alert": {
         "severity": "critical"
       }
     }
   }
   ```
4. Click **Save** and **Enable**

#### 4. Monitor Events

1. Go to **Events** page
2. See real-time events from agents
3. Click on events to see classification metadata
4. Filter by agent, classification level, or date range

---

## 📚 Complete Documentation

### Classification System

The DLP platform uses a sophisticated classification system:

**Classification Levels** (based on confidence score):
- **Public** (0.0-0.3) — No sensitive data
- **Internal** (0.3-0.6) — Low-sensitivity internal data
- **Confidential** (0.6-0.8) — Sensitive data requiring protection
- **Restricted** (0.8-1.0) — Highly sensitive (PII, secrets)

**How It Works:**
1. Content is analyzed against all enabled rules
2. Each rule has a weight (0.0-1.0)
3. Matched rules contribute their weight to confidence score
4. Total confidence determines classification level
5. Events include classification metadata for policy evaluation

**Pre-Configured Rules (20):**
- PII: SSN, Aadhaar, PAN, Email, Phone
- Financial: Credit Cards, IFSC codes, UPI IDs
- Credentials: AWS keys, GitHub tokens, API keys, DB strings
- Document markers: Confidential, Financial, Medical terms
- Network: IP addresses

### Classification-Based Policies

Create sophisticated policies using classification results:

**Example 1: High-Confidence Alert**
```json
{
  "conditions": {
    "match": "all",
    "rules": [
      {"field": "confidence_score", "operator": ">=", "value": 0.8},
      {"field": "event_type", "operator": "equals", "value": "clipboard"}
    ]
  },
  "actions": {"alert": {"severity": "high"}}
}
```

**Example 2: Graduated Response**
```json
{
  "conditions": {
    "match": "all",
    "rules": [
      {"field": "classification_level", "operator": "in",
       "value": ["Confidential", "Restricted"]},
      {"field": "destination_type", "operator": "in",
       "value": ["email", "cloud_storage", "removable_drive"]}
    ]
  },
  "actions": {"quarantine": {}, "alert": {}}
}
```

### API Reference

Full API documentation available at: `http://localhost:55000/docs`

**Authentication:**
```bash
# Login
curl -X POST http://localhost:55000/api/v1/auth/login \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=admin@cybersentinel.local&password=admin123"

# Returns: {"access_token": "...", "token_type": "bearer"}

# Use token
curl -H "Authorization: Bearer <token>" http://localhost:55000/api/v1/agents/
```

**Key Endpoints:**
- `POST /api/v1/rules` — Create classification rule
- `POST /api/v1/rules/test` — Test content classification
- `GET /api/v1/rules/statistics` — Rule statistics
- `POST /api/v1/policies` — Create policy
- `GET /api/v1/events` — Query events with filters
- `GET /api/v1/agents` — List registered agents
- `GET /api/v1/alerts` — View alerts

---

## 🛠️ Management & Operations

### Service Management

```bash
cd ~/cybersentinel-dlp

# View status
docker compose ps

# View logs
docker compose logs -f
docker compose logs -f manager
docker compose logs -f dashboard

# Restart services
docker compose restart

# Stop services
docker compose down

# Start services
docker compose up -d

# Update to latest images
docker compose pull
docker compose up -d
```

### Backup

```bash
# Backup PostgreSQL
docker compose exec postgres pg_dump -U cybersentinel cybersentinel > backup_$(date +%Y%m%d).sql

# Backup MongoDB
docker compose exec mongodb mongodump --archive > backup_mongo_$(date +%Y%m%d).archive

# Backup environment
cp .env .env.backup
```

### Update System

```bash
# Pull latest images
docker compose pull

# Restart with new images
docker compose up -d

# View deployment logs
docker compose logs -f
```

---

## 🔧 Configuration

### Environment Variables

Configuration is in `~/cybersentinel-dlp/.env`:

```bash
# Database Passwords
POSTGRES_PASSWORD=<auto-generated>
MONGODB_PASSWORD=<auto-generated>
REDIS_PASSWORD=<auto-generated>
OPENSEARCH_PASSWORD=<auto-generated>

# JWT Secret
JWT_SECRET=<auto-generated>

# Environment
ENVIRONMENT=production
```

**Change passwords before production deployment!**

### Agent Configuration

Both Windows and Linux agents use `agent_config.json`:

```json
{
  "server_url": "http://<SERVER-IP>:55000/api/v1",
  "agent_id": "<auto-generated>",
  "agent_name": "<hostname>",
  "heartbeat_interval": 30,
  "policy_sync_interval": 60,
  "monitoring": {
    "file_system": true,
    "clipboard": true,
    "usb_devices": true,
    "monitored_paths": ["/home/user/Documents"],
    "file_extensions": [".pdf", ".docx", ".xlsx"]
  }
}
```

---

## ❓ Troubleshooting

### Server Won't Start

```bash
# Check logs
docker compose logs manager

# OpenSearch needs more memory
sudo sysctl -w vm.max_map_count=262144

# Make permanent
echo "vm.max_map_count=262144" | sudo tee -a /etc/sysctl.conf
```

### Agent Not Connecting

```bash
# Test server reachability
curl http://<SERVER-IP>:55000/api/v1/health

# Check agent config
cat /etc/cybersentinel/agent_config.json

# View agent logs
sudo journalctl -u cybersentinel-agent -f  # Linux
Get-Content C:\ProgramData\CyberSentinel\cybersentinel_agent.log -Tail 50  # Windows
```

### Rules Page Not Loading

```bash
# Restart dashboard
docker compose restart dashboard

# Clear browser cache
# Hard refresh: Ctrl+Shift+R (Windows/Linux) or Cmd+Shift+R (Mac)
```

---

## 📦 Technology Stack

**Backend:**
- FastAPI 0.104 — Async REST API
- SQLAlchemy 2.0 — Async ORM
- Celery 5.3 — Task queue
- PostgreSQL 15 — Relational data
- MongoDB 7 — Event storage
- Redis 7 — Cache/sessions
- OpenSearch 2 — Search/analytics

**Frontend:**
- React 18.2 — UI framework
- TypeScript 5.3 — Type safety
- Vite 5.0 — Build tool
- TanStack Query 5.14 — Server state
- Tailwind CSS 3.3 — Styling

**Infrastructure:**
- Docker & Docker Compose
- GitHub Container Registry (GHCR)
- Nginx (Alpine)

---

## 📖 Additional Resources

- **Classification System Guide**: [CLASSIFICATION_SYSTEM.md](CLASSIFICATION_SYSTEM.md)
- **Policy Examples**: [CLASSIFICATION_POLICIES_GUIDE.md](CLASSIFICATION_POLICIES_GUIDE.md)
- **Deployment Guide**: [DEPLOYMENT_COMPLETE.md](DEPLOYMENT_COMPLETE.md)
- **Integration Guide**: [INTEGRATION_COMPLETE.md](INTEGRATION_COMPLETE.md)

---

## 🤝 Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

---

## 📄 License

This project is licensed under the MIT License. See [LICENSE](LICENSE) file for details.

---

## 🔒 Security Notice

This is Data Loss Prevention software that monitors:
- File system operations
- Clipboard content
- USB device connections
- Network transfers

**Ensure you have proper authorization before deployment.**

---

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/effaaykhan/Data-Loss-Prevention/issues)
- **Documentation**: [Wiki](https://github.com/effaaykhan/Data-Loss-Prevention/wiki)
- **API Docs**: `http://localhost:55000/docs`

---

**Built with ❤️ for enterprise data protection**

```
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║            CyberSentinel DLP — Enterprise Edition             ║
║                                                               ║
║  Protect your data. Ensure compliance. Stay secure.          ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
```
