# CyberSentinel DLP

Data Loss Prevention (DLP) is the practice of detecting and preventing unauthorized transmission of sensitive data outside an organization. CyberSentinel DLP is an enterprise platform that monitors endpoints, cloud storage, and network channels — classifying sensitive content in real time and enforcing security policies to block, alert, or quarantine data exfiltration attempts before they succeed.

## Key Features

- **Endpoint Monitoring** — File system, USB transfers, clipboard, screen capture, and print job monitoring on Windows and Linux
- **Kernel-Level Enforcement** — Windows minifilter driver intercepts file operations at the IRP level for tamper-proof blocking
- **Content Classification** — 20+ detection patterns with Luhn checksum validation, SHA-256 fingerprinting, keyword matching, and Shannon entropy analysis
- **Policy Engine** — Priority-based deterministic evaluation with nested condition trees, channel-aware enforcement, and atomic hot-reload
- **Cloud Integration** — Google Drive and OneDrive monitoring via OAuth with delta-query polling
- **Real-Time Decisions** — Sub-10ms local policy evaluation on agents; server-side decision API for content-aware blocking
- **SIEM Integration** — Splunk and OpenSearch/Elasticsearch connectors
- **Dashboard** — React-based UI for event viewer, policy builder, rule management, agent fleet monitoring, and classification analytics
- **Sequential Agent IDs** — Agents are assigned WIN-001, WIN-002, LIN-001 format IDs automatically

---

## Installation

### Server (one-liner)

**Requirements:** Docker Engine 24+, Docker Compose v2+, Python 3, 8 GB RAM

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/effaaykhan/cybersentineldlp-prod/main/install.sh)
```

This clones the repo, generates secure passwords, starts all services, and prints the admin credentials.

#### Install the updates
```
docker compose -f docker-compose.prod.yml pull
```
```
docker compose -f docker-compose.prod.yml up -d
```
#### Verify
```
docker ps
```

**Manual install:**

```bash
git clone https://github.com/effaaykhan/cybersentineldlp-prod.git
cd cybersentineldlp-prod
cp .env.example .env
# Edit .env — set passwords, or run: python3 -c "import secrets; print(secrets.token_urlsafe(48))"
docker compose -f docker-compose.prod.yml up -d
docker logs cybersentinel-manager 2>&1 | grep "generated_password"
```

- Dashboard: `http://<server-ip>:4000`
- API docs: `http://<server-ip>:55000/api/v1/docs`

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

Requires MSYS2 with MinGW-w64:

```bash
cd agents/endpoint/windows
g++ -std=c++17 -O2 agent.cpp screen_capture_monitor.cpp print_monitor.cpp \
    -o cybersentinel_agent.exe \
    -lwinhttp -lwbemuuid -lole32 -loleaut32 -luser32 \
    -lws2_32 -lsetupapi -ladvapi32 -lcfgmgr32 -lshell32 -lwinspool -static
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

MIT
