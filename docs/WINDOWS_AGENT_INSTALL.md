# Windows Agent Installation Guide

## Prerequisites

- Windows 10/11 (64-bit)
- Administrator privileges
- Network access to the CyberSentinel server (port 55000)
- .NET Framework 4.5+ (pre-installed on Windows 10/11)

## Step 1: Get the server URL

Your CyberSentinel server should be running and accessible. Verify:

```powershell
curl http://<SERVER_IP>:55000/health
```

You should see `{"status":"healthy",...}`.

## Step 2: Download the agent

Option A -- Copy from this repository:

```
agents/endpoint/windows/cybersentinel_agent.exe
```

Option B -- Download from the server (if hosted):

```powershell
Invoke-WebRequest -Uri "http://<SERVER_IP>:55000/downloads/agent" -OutFile "cybersentinel_agent.exe"
```

## Step 3: Create installation directory

Open PowerShell as Administrator:

```powershell
New-Item -ItemType Directory -Path "C:\Program Files\CyberSentinel" -Force
Copy-Item cybersentinel_agent.exe "C:\Program Files\CyberSentinel\"
```

## Step 4: Create agent configuration

```powershell
@"
{
  "server_url": "http://<SERVER_IP>:55000/api/v1",
  "agent_name": "$env:COMPUTERNAME",
  "heartbeat_interval": 30,
  "policy_sync_interval": 60,
  "monitoring": {
    "file_system": true,
    "clipboard": true,
    "usb_devices": true,
    "screen_capture": true,
    "print_jobs": true,
    "monitored_paths": [
      "C:\\Users\\$env:USERNAME\\Documents",
      "C:\\Users\\$env:USERNAME\\Desktop",
      "C:\\Users\\$env:USERNAME\\Downloads"
    ],
    "file_extensions": [".pdf", ".docx", ".xlsx", ".csv", ".txt", ".json", ".xml", ".sql", ".pem", ".key"]
  },
  "quarantine_path": "C:\\ProgramData\\CyberSentinel\\quarantine",
  "log_path": "C:\\ProgramData\\CyberSentinel\\logs",
  "cache_path": "C:\\ProgramData\\CyberSentinel\\cache"
}
"@ | Set-Content "C:\Program Files\CyberSentinel\agent_config.json"
```

Replace `<SERVER_IP>` with your actual server address.

## Step 5: Create data directories

```powershell
New-Item -ItemType Directory -Path "C:\ProgramData\CyberSentinel\quarantine" -Force
New-Item -ItemType Directory -Path "C:\ProgramData\CyberSentinel\logs" -Force
New-Item -ItemType Directory -Path "C:\ProgramData\CyberSentinel\cache" -Force
```

## Step 6: Install NSSM (service manager)

Download NSSM from https://nssm.cc/download or use Chocolatey:

```powershell
choco install nssm -y
```

## Step 7: Register as Windows service

```powershell
nssm install CyberSentinelAgent "C:\Program Files\CyberSentinel\cybersentinel_agent.exe"
nssm set CyberSentinelAgent AppDirectory "C:\Program Files\CyberSentinel"
nssm set CyberSentinelAgent DisplayName "CyberSentinel DLP Agent"
nssm set CyberSentinelAgent Description "Endpoint Data Loss Prevention Agent"
nssm set CyberSentinelAgent Start SERVICE_AUTO_START
nssm set CyberSentinelAgent AppStdout "C:\ProgramData\CyberSentinel\logs\agent_stdout.log"
nssm set CyberSentinelAgent AppStderr "C:\ProgramData\CyberSentinel\logs\agent_stderr.log"
nssm set CyberSentinelAgent AppRotateFiles 1
nssm set CyberSentinelAgent AppRotateBytes 10485760
nssm set CyberSentinelAgent AppRestartDelay 5000
nssm set CyberSentinelAgent ObjectName LocalSystem
```

## Step 8: Start the service

```powershell
nssm start CyberSentinelAgent
```

Verify it is running:

```powershell
nssm status CyberSentinelAgent
```

Expected output: `SERVICE_RUNNING`

## Step 9: Verify registration

The agent automatically registers with the server on first start. Check the server dashboard or API:

```powershell
curl http://<SERVER_IP>:55000/api/v1/agents/
```

Your agent should appear with status `active`.

## Step 10: Verify monitoring

1. Copy a test file to a USB drive -- the agent should detect and report it
2. Copy sensitive text (e.g., a fake SSN `123-45-6789`) to clipboard -- should be detected
3. Press PrintScreen -- screen capture should be logged
4. Check the dashboard at `http://<SERVER_IP>:3023` for events

## Kernel Driver (Optional)

The kernel minifilter driver provides deeper file operation interception. It requires:

- Windows Driver Kit (WDK) for building
- Test signing enabled or a valid code signing certificate
- Driver loaded via `fltmc load CyberSentinelFilter`

The user-mode agent works without the kernel driver using Windows API hooks.

To install the kernel driver:

```powershell
# Enable test signing (development only, reboot required)
bcdedit /set testsigning on

# Copy driver files
Copy-Item kernel\csfilter.sys C:\Windows\System32\drivers\
Copy-Item kernel\csfilter.inf C:\Windows\INF\

# Install the driver
rundll32.exe setupapi.dll,InstallHinfSection DefaultInstall 132 C:\Windows\INF\csfilter.inf

# Load the minifilter
fltmc load CyberSentinelFilter
```

## Service Management

```powershell
# Stop the agent
nssm stop CyberSentinelAgent

# Restart the agent
nssm restart CyberSentinelAgent

# View logs
Get-Content "C:\ProgramData\CyberSentinel\logs\agent_stdout.log" -Tail 50

# Check agent status
nssm status CyberSentinelAgent
```

## Uninstall

```powershell
nssm stop CyberSentinelAgent
nssm remove CyberSentinelAgent confirm
Remove-Item "C:\Program Files\CyberSentinel" -Recurse -Force
# Optionally remove data:
Remove-Item "C:\ProgramData\CyberSentinel" -Recurse -Force
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Agent not registering | Check firewall allows outbound to port 55000 |
| Service crashes on start | Check `agent_config.json` is valid JSON, verify server URL |
| USB events not detected | Ensure `usb_devices: true` in config, agent must run as SYSTEM |
| No events in dashboard | Check agent logs in `C:\ProgramData\CyberSentinel\logs\` |
| Policy sync failing | Verify server is reachable, check API key in agent logs |
| High CPU usage | Reduce monitored paths, increase `policy_sync_interval` |
