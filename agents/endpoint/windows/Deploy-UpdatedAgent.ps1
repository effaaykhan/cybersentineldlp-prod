# PowerShell script to deploy updated CyberSentinel Agent
# Run as Administrator

#Requires -RunAsAdministrator

Write-Host "=========================================="  -ForegroundColor Cyan
Write-Host "CyberSentinel Agent Deployment Script" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

$agentPath = "C:\Program Files\CyberSentinel"
$serviceName = "CyberSentinelAgent"
$newExecutable = Join-Path $PSScriptRoot "cybersentinel_agent.exe"

# Check if new executable exists
if (-not (Test-Path $newExecutable)) {
    Write-Host "ERROR: cybersentinel_agent.exe not found in current directory!" -ForegroundColor Red
    Write-Host "Please compile the agent first using build.sh in MSYS2" -ForegroundColor Yellow
    exit 1
}

# Check if agent directory exists
if (-not (Test-Path $agentPath)) {
    Write-Host "ERROR: CyberSentinel installation not found at $agentPath" -ForegroundColor Red
    Write-Host "Please install the agent first" -ForegroundColor Yellow
    exit 1
}

Write-Host "New Features in This Update:" -ForegroundColor Green
Write-Host "  ✓ Real-time content classification before blocking" -ForegroundColor White
Write-Host "  ✓ Only blocks files with sensitive data" -ForegroundColor White
Write-Host "  ✓ Fixed USB connection/disconnection alerts" -ForegroundColor White
Write-Host "  ✓ Enhanced logging with classification details" -ForegroundColor White
Write-Host ""

# Get file info
$newFileInfo = Get-Item $newExecutable
$newFileSize = "{0:N2}" -f ($newFileInfo.Length / 1MB)
$newFileDate = $newFileInfo.LastWriteTime

Write-Host "New executable info:" -ForegroundColor Cyan
Write-Host "  Size: $newFileSize MB"
Write-Host "  Date: $newFileDate"
Write-Host ""

# Confirm deployment
$confirmation = Read-Host "Deploy this update? (Y/N)"
if ($confirmation -ne 'Y' -and $confirmation -ne 'y') {
    Write-Host "Deployment cancelled" -ForegroundColor Yellow
    exit 0
}

Write-Host ""
Write-Host "Starting deployment..." -ForegroundColor Cyan

# Step 1: Stop the service
Write-Host "[1/5] Stopping CyberSentinel service..." -ForegroundColor Yellow
try {
    $service = Get-Service -Name $serviceName -ErrorAction Stop
    if ($service.Status -eq 'Running') {
        Stop-Service -Name $serviceName -Force -ErrorAction Stop
        Start-Sleep -Seconds 2
        Write-Host "  ✓ Service stopped" -ForegroundColor Green
    } else {
        Write-Host "  ✓ Service already stopped" -ForegroundColor Green
    }
} catch {
    Write-Host "  ✗ Failed to stop service: $_" -ForegroundColor Red
    exit 1
}

# Step 2: Backup old executable
Write-Host "[2/5] Backing up old executable..." -ForegroundColor Yellow
$backupName = "cybersentinel_agent.exe.backup.$(Get-Date -Format 'yyyyMMdd_HHmmss')"
$backupPath = Join-Path $agentPath $backupName
try {
    Copy-Item (Join-Path $agentPath "cybersentinel_agent.exe") $backupPath -ErrorAction Stop
    Write-Host "  ✓ Backup created: $backupName" -ForegroundColor Green
} catch {
    Write-Host "  ✗ Failed to create backup: $_" -ForegroundColor Red
    Write-Host "  Continuing anyway..." -ForegroundColor Yellow
}

# Step 3: Deploy new executable
Write-Host "[3/5] Deploying new executable..." -ForegroundColor Yellow
try {
    Copy-Item $newExecutable (Join-Path $agentPath "cybersentinel_agent.exe") -Force -ErrorAction Stop
    Write-Host "  ✓ New executable deployed" -ForegroundColor Green
} catch {
    Write-Host "  ✗ Failed to deploy: $_" -ForegroundColor Red

    # Try to restore backup
    if (Test-Path $backupPath) {
        Write-Host "  Restoring backup..." -ForegroundColor Yellow
        Copy-Item $backupPath (Join-Path $agentPath "cybersentinel_agent.exe") -Force
        Write-Host "  ✓ Backup restored" -ForegroundColor Green
    }
    exit 1
}

# Step 4: Verify deployment
Write-Host "[4/5] Verifying deployment..." -ForegroundColor Yellow
$deployedFile = Get-Item (Join-Path $agentPath "cybersentinel_agent.exe")
$deployedSize = "{0:N2}" -f ($deployedFile.Length / 1MB)
$deployedDate = $deployedFile.LastWriteTime

if ($deployedFile.Length -eq $newFileInfo.Length) {
    Write-Host "  ✓ Deployment verified" -ForegroundColor Green
    Write-Host "  Size: $deployedSize MB" -ForegroundColor Gray
    Write-Host "  Date: $deployedDate" -ForegroundColor Gray
} else {
    Write-Host "  ✗ File size mismatch!" -ForegroundColor Red
    Write-Host "  Expected: $newFileSize MB" -ForegroundColor Gray
    Write-Host "  Got: $deployedSize MB" -ForegroundColor Gray
}

# Step 5: Start the service
Write-Host "[5/5] Starting CyberSentinel service..." -ForegroundColor Yellow
try {
    Start-Service -Name $serviceName -ErrorAction Stop
    Start-Sleep -Seconds 2

    $service = Get-Service -Name $serviceName
    if ($service.Status -eq 'Running') {
        Write-Host "  ✓ Service started successfully" -ForegroundColor Green
    } else {
        Write-Host "  ✗ Service failed to start (Status: $($service.Status))" -ForegroundColor Red
        Write-Host "  Check logs: C:\Program Files\CyberSentinel\service.log" -ForegroundColor Yellow
    }
} catch {
    Write-Host "  ✗ Failed to start service: $_" -ForegroundColor Red
    Write-Host "  Check logs: C:\Program Files\CyberSentinel\service_error.log" -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "=========================================="  -ForegroundColor Cyan
Write-Host "✓ Deployment Complete!" -ForegroundColor Green
Write-Host "=========================================="  -ForegroundColor Cyan
Write-Host ""

Write-Host "Testing the Update:" -ForegroundColor Cyan
Write-Host ""
Write-Host "1. Test USB Connection Alerts:" -ForegroundColor Yellow
Write-Host "   • Connect a USB drive" -ForegroundColor White
Write-Host "   • Check dashboard for 'USB device connected' alert" -ForegroundColor White
Write-Host "   • Disconnect USB drive" -ForegroundColor White
Write-Host "   • Check dashboard for 'USB device disconnected' alert" -ForegroundColor White
Write-Host ""

Write-Host "2. Test Classification-Based Blocking:" -ForegroundColor Yellow
Write-Host "   • Create file with sensitive data (Aadhaar, phone, email)" -ForegroundColor White
Write-Host "   • Copy to USB - should be BLOCKED with classification details" -ForegroundColor White
Write-Host "   • Create normal file" -ForegroundColor White
Write-Host "   • Copy to USB - should be ALLOWED" -ForegroundColor White
Write-Host ""

Write-Host "View Logs:" -ForegroundColor Cyan
Write-Host "  Get-Content 'C:\Program Files\CyberSentinel\cybersentinel_agent.log' -Tail 50" -ForegroundColor Gray
Write-Host ""

Write-Host "Rollback (if needed):" -ForegroundColor Cyan
Write-Host "  Stop-Service $serviceName -Force" -ForegroundColor Gray
Write-Host "  Copy-Item '$backupPath' 'C:\Program Files\CyberSentinel\cybersentinel_agent.exe' -Force" -ForegroundColor Gray
Write-Host "  Start-Service $serviceName" -ForegroundColor Gray
Write-Host ""
