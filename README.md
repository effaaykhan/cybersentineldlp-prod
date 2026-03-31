# CyberSentinel DLP

Data Loss Prevention (DLP) is the practice of detecting and preventing unauthorized transmission of sensitive data outside an organization. CyberSentinel DLP is an enterprise platform that monitors endpoints, cloud storage, and network channels — classifying sensitive content in real time and enforcing security policies to block, alert, or quarantine data exfiltration attempts before they succeed.

## Key Features

- **Endpoint Monitoring** — File system, USB transfers, clipboard, screen capture, and print job monitoring on Windows and Linux
- **Kernel-Level Enforcement** — Windows minifilter driver intercepts file operations at the IRP level for tamper-proof blocking
- **Content Classification** — 20+ detection patterns with Luhn/Verhoeff checksum validation, SHA-256 fingerprinting, keyword matching, and Shannon entropy analysis
- **Policy Engine** — Priority-based deterministic evaluation with nested condition trees, channel-aware enforcement, and atomic hot-reload
- **Cloud Integration** — Google Drive and OneDrive monitoring via OAuth with delta-query polling
- **Real-Time Decisions** — Sub-10ms local policy evaluation on agents; server-side decision API for content-aware blocking
- **SIEM Integration** — Splunk and OpenSearch/Elasticsearch connectors
- **Dashboard** — React-based UI for event viewer, policy builder, rule management, agent fleet monitoring, and classification analytics

---

## Installation

### Server

**Requirements:** Docker Engine 24+, Docker Compose v2+, 8 GB RAM

```bash
git clone https://github.com/effaaykhan/cybersentineldlp-prod.git
cd cybersentineldlp-prod
cp .env.example .env
```

Edit `.env` — set all passwords and generate `SECRET_KEY`:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

Start:

```bash
docker compose up -d
```

Get the auto-generated admin password (must be changed on first login):

```bash
docker logs cybersentinel-manager 2>&1 | grep "generated_password"
```

Dashboard: `http://<server-ip>:3023`
API docs: `http://<server-ip>:55000/api/v1/docs`

### Windows Agent

**Requirements:** Windows 10/11 64-bit, Administrator privileges

```powershell
# Create directories
New-Item -ItemType Directory -Path "C:\Program Files\CyberSentinel" -Force
New-Item -ItemType Directory -Path "C:\ProgramData\CyberSentinel\logs" -Force
New-Item -ItemType Directory -Path "C:\ProgramData\CyberSentinel\quarantine" -Force
New-Item -ItemType Directory -Path "C:\ProgramData\CyberSentinel\cache" -Force

# Copy agent binary
Copy-Item cybersentinel_agent.exe "C:\Program Files\CyberSentinel\"
```

Create `C:\Program Files\CyberSentinel\agent_config.json`:

```json
{
  "server_url": "http://<SERVER_IP>:55000/api/v1",
  "agent_name": "WORKSTATION-01",
  "heartbeat_interval": 30,
  "policy_sync_interval": 60,
  "monitoring": {
    "file_system": true,
    "clipboard": true,
    "usb_devices": true,
    "screen_capture": true,
    "print_jobs": true,
    "monitored_paths": ["C:\\Users"],
    "file_extensions": [".pdf", ".docx", ".xlsx", ".csv", ".txt", ".json", ".sql", ".pem", ".key"]
  }
}
```

Install as service (requires [NSSM](https://nssm.cc/download)):

```powershell
nssm install CyberSentinelAgent "C:\Program Files\CyberSentinel\cybersentinel_agent.exe"
nssm set CyberSentinelAgent Start SERVICE_AUTO_START
nssm set CyberSentinelAgent ObjectName LocalSystem
nssm start CyberSentinelAgent
```

Full guide: [docs/WINDOWS_AGENT_INSTALL.md](docs/WINDOWS_AGENT_INSTALL.md)

### Linux Agent

**Requirements:** Python 3.8+, systemd

```bash
cd agents/endpoint/linux
pip install -r requirements.txt

# Configure
export CYBERSENTINEL_SERVER_URL=http://<SERVER_IP>:55000/api/v1

# Run
python agent.py
```

Install as systemd service:

```bash
sudo cp systemd/cybersentinel-agent.service /etc/systemd/system/
sudo systemctl enable cybersentinel-agent
sudo systemctl start cybersentinel-agent
```

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

MIT
