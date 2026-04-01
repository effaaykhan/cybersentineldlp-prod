# CyberSentinel DLP — Windows Agent One-Line Installer
# Usage: irm https://raw.githubusercontent.com/effaaykhan/cybersentineldlp-prod/main/install-agent.ps1 | iex
# Or:    powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/effaaykhan/cybersentineldlp-prod/main/install-agent.ps1 | iex"

param(
    [string]$ServerUrl = "",
    [string]$AgentName = $env:COMPUTERNAME
)

$ErrorActionPreference = "Stop"
$REPO_BASE = "https://raw.githubusercontent.com/effaaykhan/cybersentineldlp-prod/main"
$INSTALL_DIR = "C:\Program Files\CyberSentinel"
$DATA_DIR = "C:\ProgramData\CyberSentinel"
$SVC_NAME = "CyberSentinelAgent"

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

# Stop existing service if running
$existingSvc = Get-Service -Name $SVC_NAME -ErrorAction SilentlyContinue
if ($existingSvc) {
    Write-Host "[+] Stopping existing service..."
    Stop-Service -Name $SVC_NAME -Force -ErrorAction SilentlyContinue
    & nssm remove $SVC_NAME confirm 2>$null
    Start-Sleep -Seconds 2
}

# Install NSSM if not present
$nssmPath = (Get-Command nssm -ErrorAction SilentlyContinue).Source
if (-not $nssmPath) {
    Write-Host "[+] Installing NSSM service manager..."
    $nssmZip = "$env:TEMP\nssm.zip"
    $nssmDir = "$env:TEMP\nssm-2.24"
    Invoke-WebRequest -Uri "https://nssm.cc/release/nssm-2.24.zip" -OutFile $nssmZip -UseBasicParsing
    Expand-Archive -Path $nssmZip -DestinationPath $env:TEMP -Force
    Copy-Item "$nssmDir\win64\nssm.exe" "C:\Windows\System32\nssm.exe" -Force
    $nssmPath = "C:\Windows\System32\nssm.exe"
    Write-Host "[+] NSSM installed" -ForegroundColor Green
}

# Register service
Write-Host "[+] Registering Windows service..."
& nssm install $SVC_NAME "$exePath"
& nssm set $SVC_NAME AppDirectory "$INSTALL_DIR"
& nssm set $SVC_NAME DisplayName "CyberSentinel DLP Agent"
& nssm set $SVC_NAME Description "Endpoint Data Loss Prevention Agent"
& nssm set $SVC_NAME Start SERVICE_AUTO_START
& nssm set $SVC_NAME AppStdout "$DATA_DIR\logs\agent_stdout.log"
& nssm set $SVC_NAME AppStderr "$DATA_DIR\logs\agent_stderr.log"
& nssm set $SVC_NAME AppRotateFiles 1
& nssm set $SVC_NAME AppRotateBytes 10485760
& nssm set $SVC_NAME AppRestartDelay 5000
& nssm set $SVC_NAME ObjectName LocalSystem

# Start service
Write-Host "[+] Starting agent service..."
& nssm start $SVC_NAME

Start-Sleep -Seconds 5

# Verify
$svcStatus = (Get-Service -Name $SVC_NAME -ErrorAction SilentlyContinue).Status
if ($svcStatus -eq "Running") {
    Write-Host ""
    Write-Host "  Installation Complete" -ForegroundColor Green
    Write-Host "  =====================" -ForegroundColor Green
    Write-Host "  Agent:    $exePath"
    Write-Host "  Config:   $INSTALL_DIR\agent_config.json"
    Write-Host "  Logs:     $DATA_DIR\logs\"
    Write-Host "  Service:  $SVC_NAME (Running)"
    Write-Host "  Server:   $ServerUrl"
    Write-Host ""
    Write-Host "  The agent will register itself with the server automatically."
    Write-Host "  Check the dashboard to see this endpoint appear." -ForegroundColor Yellow
    Write-Host ""
} else {
    Write-Host ""
    Write-Host "[WARN] Service installed but status is: $svcStatus" -ForegroundColor Yellow
    Write-Host "  Check logs: Get-Content '$DATA_DIR\logs\agent_stderr.log' -Tail 20"
    Write-Host ""
}
