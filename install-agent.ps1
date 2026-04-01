# CyberSentinel DLP — Windows Agent One-Line Installer
# Usage: powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/effaaykhan/cybersentineldlp-prod/main/install-agent.ps1 | iex"

$ErrorActionPreference = "Stop"
$REPO_BASE = "https://raw.githubusercontent.com/effaaykhan/cybersentineldlp-prod/main"
$INSTALL_DIR = "C:\Program Files\CyberSentinel"
$DATA_DIR = "C:\ProgramData\CyberSentinel"
$TASK_NAME = "CyberSentinelAgent"

Write-Host ""
Write-Host "  CyberSentinel DLP - Windows Agent Installation" -ForegroundColor Green
Write-Host "  ================================================" -ForegroundColor Green
Write-Host ""

# Check admin
if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "[ERROR] Run this as Administrator." -ForegroundColor Red; exit 1
}

# Get server URL
$ServerUrl = Read-Host "Enter DLP server URL (e.g. http://192.168.1.100:55000/api/v1)"
$ServerUrl = $ServerUrl.TrimEnd('/')

# Test server
Write-Host "[+] Testing server connectivity..."
try {
    $healthUrl = ($ServerUrl -replace '/api/v1$', '') + "/health"
    $resp = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 10
    if ($resp.status -eq "healthy") { Write-Host "[+] Server is healthy" -ForegroundColor Green }
} catch {
    Write-Host "[WARN] Could not reach server - continuing anyway" -ForegroundColor Yellow
}

# Remove old installs
Stop-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TASK_NAME -Confirm:$false -ErrorAction SilentlyContinue
$svc = Get-Service -Name $TASK_NAME -ErrorAction SilentlyContinue
if ($svc) { Stop-Service $TASK_NAME -Force -ErrorAction SilentlyContinue; sc.exe delete $TASK_NAME 2>$null }
Stop-Process -Name "cybersentinel_agent" -Force -ErrorAction SilentlyContinue

# Create directories
Write-Host "[+] Creating directories..."
foreach ($d in @($INSTALL_DIR, "$DATA_DIR\logs", "$DATA_DIR\quarantine", "$DATA_DIR\cache")) {
    New-Item -ItemType Directory -Path $d -Force | Out-Null
}

# Download agent binary
Write-Host "[+] Downloading agent binary..."
$exePath = "$INSTALL_DIR\cybersentinel_agent.exe"
try {
    Invoke-WebRequest -Uri "$REPO_BASE/agents/endpoint/windows/cybersentinel_agent.exe" -OutFile $exePath -UseBasicParsing
    Write-Host "[+] Downloaded ($([math]::Round((Get-Item $exePath).Length/1MB,1)) MB)" -ForegroundColor Green
} catch {
    Write-Host "[ERROR] Download failed: $_" -ForegroundColor Red; exit 1
}

# Set environment variable
[Environment]::SetEnvironmentVariable("CYBERSENTINEL_SERVER_URL", $ServerUrl, "Machine")
$env:CYBERSENTINEL_SERVER_URL = $ServerUrl

# Create config
Write-Host "[+] Creating configuration..."
@{
    server_url = $ServerUrl
    agent_name = $env:COMPUTERNAME
    heartbeat_interval = 30
    policy_sync_interval = 60
    monitoring = @{
        file_system = $true
        clipboard = $true
        usb_devices = $true
        screen_capture = $true
        print_jobs = $true
        monitored_paths = @("C:\Users\$env:USERNAME\Documents","C:\Users\$env:USERNAME\Desktop","C:\Users\$env:USERNAME\Downloads")
        file_extensions = @(".pdf",".docx",".xlsx",".csv",".txt",".json",".xml",".sql",".pem",".key",".env",".conf")
    }
    quarantine_path = "$DATA_DIR\quarantine"
    log_path = "$DATA_DIR\logs"
    cache_path = "$DATA_DIR\cache"
} | ConvertTo-Json -Depth 4 | Set-Content "$INSTALL_DIR\agent_config.json" -Encoding UTF8

# Create scheduled task — runs hidden, starts on boot, auto-restarts
Write-Host "[+] Registering scheduled task..."
$action = New-ScheduledTaskAction -Execute $exePath -WorkingDirectory $INSTALL_DIR
$trigger1 = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$trigger2 = New-ScheduledTaskTrigger -AtStartup
$trigger2.Delay = "PT30S"
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Days 9999) `
    -MultipleInstances IgnoreNew `
    -Hidden

Register-ScheduledTask `
    -TaskName $TASK_NAME `
    -Action $action `
    -Trigger @($trigger1, $trigger2) `
    -Settings $settings `
    -RunLevel Highest `
    -User $env:USERNAME `
    -Description "CyberSentinel DLP Agent — monitors files, clipboard, USB, screen capture" `
    -Force | Out-Null

# Start
Write-Host "[+] Starting agent..."
Start-ScheduledTask -TaskName $TASK_NAME
Start-Sleep 5

# Verify
$proc = Get-Process -Name "cybersentinel_agent" -ErrorAction SilentlyContinue
if ($proc) {
    Write-Host ""
    Write-Host "  Installation Complete" -ForegroundColor Green
    Write-Host "  =====================" -ForegroundColor Green
    Write-Host "  Agent:   $exePath"
    Write-Host "  Config:  $INSTALL_DIR\agent_config.json"
    Write-Host "  Logs:    $INSTALL_DIR\cybersentinel_agent.log"
    Write-Host "  Server:  $ServerUrl"
    Write-Host "  Task:    $TASK_NAME (hidden, auto-restart on boot)"
    Write-Host ""
    Write-Host "  Commands:" -ForegroundColor Cyan
    Write-Host "    Logs:    Get-Content '$INSTALL_DIR\cybersentinel_agent.log' -Tail 30"
    Write-Host "    Stop:    Stop-ScheduledTask -TaskName $TASK_NAME"
    Write-Host "    Start:   Start-ScheduledTask -TaskName $TASK_NAME"
    Write-Host "    Remove:  Unregister-ScheduledTask -TaskName $TASK_NAME -Confirm:`$false"
    Write-Host ""
} else {
    Write-Host "[!] Process not started yet. Check logs:" -ForegroundColor Yellow
    Write-Host "    Get-Content '$INSTALL_DIR\cybersentinel_agent.log' -Tail 20"
}
