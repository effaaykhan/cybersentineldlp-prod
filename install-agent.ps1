# CyberSentinel DLP — Windows Agent One-Line Installer
# Usage: irm https://raw.githubusercontent.com/effaaykhan/cybersentineldlp-prod/main/install-agent.ps1 | iex
# Or:    powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/effaaykhan/cybersentineldlp-prod/main/install-agent.ps1 | iex"
#
# Installs as a Scheduled Task running as the current user (not SYSTEM)
# so clipboard and screen capture monitoring work correctly.

param(
    [string]$ServerUrl = "",
    [string]$AgentName = $env:COMPUTERNAME
)

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
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "[ERROR] Run this as Administrator." -ForegroundColor Red
    exit 1
}

# Get server URL
if (-not $ServerUrl) {
    $ServerUrl = Read-Host "Enter DLP server URL (e.g. http://192.168.1.100:55000/api/v1)"
}
$ServerUrl = $ServerUrl.TrimEnd('/')

# Test server
Write-Host "[+] Testing server connectivity..."
try {
    $healthUrl = ($ServerUrl -replace '/api/v1$', '') + "/health"
    $resp = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 10
    if ($resp.status -eq "healthy") {
        Write-Host "[+] Server is healthy" -ForegroundColor Green
    }
} catch {
    Write-Host "[WARN] Could not reach server at $healthUrl - continuing anyway" -ForegroundColor Yellow
}

# Create directories
Write-Host "[+] Creating directories..."
foreach ($dir in @($INSTALL_DIR, "$DATA_DIR\logs", "$DATA_DIR\quarantine", "$DATA_DIR\cache")) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
}

# Download agent binary
Write-Host "[+] Downloading agent binary..."
$exePath = "$INSTALL_DIR\cybersentinel_agent.exe"
$downloadUrl = "$REPO_BASE/agents/endpoint/windows/cybersentinel_agent.exe"
try {
    Invoke-WebRequest -Uri $downloadUrl -OutFile $exePath -UseBasicParsing
    $size = [math]::Round((Get-Item $exePath).Length / 1MB, 1)
    Write-Host "[+] Downloaded ($size MB)" -ForegroundColor Green
} catch {
    Write-Host "[ERROR] Failed to download agent binary: $_" -ForegroundColor Red
    exit 1
}

# Create config
Write-Host "[+] Creating configuration..."
$config = @{
    server_url = $ServerUrl
    agent_name = $AgentName
    heartbeat_interval = 30
    policy_sync_interval = 60
    monitoring = @{
        file_system = $true
        clipboard = $true
        usb_devices = $true
        screen_capture = $true
        print_jobs = $true
        monitored_paths = @(
            "C:\Users\$env:USERNAME\Documents",
            "C:\Users\$env:USERNAME\Desktop",
            "C:\Users\$env:USERNAME\Downloads"
        )
        file_extensions = @(".pdf", ".docx", ".xlsx", ".csv", ".txt", ".json", ".xml", ".sql", ".pem", ".key", ".env", ".conf")
    }
    quarantine_path = "$DATA_DIR\quarantine"
    log_path = "$DATA_DIR\logs"
    cache_path = "$DATA_DIR\cache"
} | ConvertTo-Json -Depth 4

$config | Set-Content "$INSTALL_DIR\agent_config.json" -Encoding UTF8

# Remove existing NSSM service if present (migration from old install)
$existingSvc = Get-Service -Name $TASK_NAME -ErrorAction SilentlyContinue
if ($existingSvc) {
    Write-Host "[+] Removing old NSSM service..."
    Stop-Service -Name $TASK_NAME -Force -ErrorAction SilentlyContinue
    $nssmCmd = Get-Command nssm -ErrorAction SilentlyContinue
    if ($nssmCmd) {
        & nssm remove $TASK_NAME confirm 2>$null
    } else {
        sc.exe delete $TASK_NAME 2>$null
    }
    Start-Sleep -Seconds 2
}

# Remove existing scheduled task if present
$existingTask = Get-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
if ($existingTask) {
    Write-Host "[+] Removing existing scheduled task..."
    Stop-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TASK_NAME -Confirm:$false
    Start-Sleep -Seconds 2
}

# Set environment variable for server URL (machine-level)
Write-Host "[+] Setting environment variable..."
[Environment]::SetEnvironmentVariable("CYBERSENTINEL_SERVER_URL", $ServerUrl, "Machine")

# Create scheduled task — runs as current user at logon + at startup
Write-Host "[+] Creating scheduled task..."
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$action = New-ScheduledTaskAction `
    -Execute "$exePath" `
    -WorkingDirectory "$INSTALL_DIR"

# Trigger 1: At user logon
$triggerLogon = New-ScheduledTaskTrigger -AtLogOn -User $currentUser

# Trigger 2: At system startup (with 30 second delay for network)
$triggerStartup = New-ScheduledTaskTrigger -AtStartup
$triggerStartup.Delay = "PT30S"

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Days 365) `
    -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal `
    -UserId $currentUser `
    -LogonType Interactive `
    -RunLevel Highest

Register-ScheduledTask `
    -TaskName $TASK_NAME `
    -Action $action `
    -Trigger @($triggerLogon, $triggerStartup) `
    -Settings $settings `
    -Principal $principal `
    -Description "CyberSentinel DLP Endpoint Agent - monitors files, clipboard, USB, and screen capture" `
    -Force | Out-Null

# Start the task now
Write-Host "[+] Starting agent..."
Start-ScheduledTask -TaskName $TASK_NAME

Start-Sleep -Seconds 5

# Verify
$taskInfo = Get-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
$taskState = if ($taskInfo) { $taskInfo.State } else { "Not Found" }
$processRunning = Get-Process -Name "cybersentinel_agent" -ErrorAction SilentlyContinue

if ($processRunning) {
    Write-Host ""
    Write-Host "  Installation Complete" -ForegroundColor Green
    Write-Host "  =====================" -ForegroundColor Green
    Write-Host "  Agent:    $exePath"
    Write-Host "  Config:   $INSTALL_DIR\agent_config.json"
    Write-Host "  Logs:     $DATA_DIR\logs\"
    Write-Host "  Task:     $TASK_NAME ($taskState)"
    Write-Host "  User:     $currentUser"
    Write-Host "  Server:   $ServerUrl"
    Write-Host ""
    Write-Host "  The agent runs as your user account so clipboard" -ForegroundColor Yellow
    Write-Host "  and screen capture monitoring work correctly." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Commands:" -ForegroundColor Cyan
    Write-Host "    Stop:    Stop-ScheduledTask -TaskName $TASK_NAME"
    Write-Host "    Start:   Start-ScheduledTask -TaskName $TASK_NAME"
    Write-Host "    Status:  (Get-ScheduledTask -TaskName $TASK_NAME).State"
    Write-Host "    Logs:    Get-Content '$INSTALL_DIR\cybersentinel_agent.log' -Tail 30"
    Write-Host "    Remove:  Unregister-ScheduledTask -TaskName $TASK_NAME -Confirm:`$false"
    Write-Host ""
} else {
    Write-Host ""
    Write-Host "[WARN] Task registered ($taskState) but process not detected yet." -ForegroundColor Yellow
    Write-Host "  It may take a few seconds to start. Check:"
    Write-Host "    Get-Process *cybersentinel*"
    Write-Host "    Get-Content '$INSTALL_DIR\cybersentinel_agent.log' -Tail 20"
    Write-Host ""
}
