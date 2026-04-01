# CyberSentinel DLP Agent - Installation Script
# Requires Administrator privileges
# Usage: powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/effaaykhan/cybersentineldlp-prod/main/install-agent.ps1 | iex"

#Requires -RunAsAdministrator

# Configuration
$GITHUB_REPO = "effaaykhan/cybersentineldlp-prod"
$INSTALL_DIR = "C:\Program Files\CyberSentinel"
$DATA_DIR = "C:\ProgramData\CyberSentinel"
$EXE_NAME = "cybersentinel_agent.exe"
$CONFIG_NAME = "agent_config.json"
$TASK_NAME = "CyberSentinel DLP Agent"
$RAW_BASE = "https://raw.githubusercontent.com/$GITHUB_REPO/main"

# Colors for output
function Write-ColorOutput {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Message,
        [ValidateSet("Info", "Success", "Warning", "Error")]
        [string]$Type = "Info"
    )
    switch ($Type) {
        "Info"    { Write-Host $Message -ForegroundColor Cyan }
        "Success" { Write-Host $Message -ForegroundColor Green }
        "Warning" { Write-Host $Message -ForegroundColor Yellow }
        "Error"   { Write-Host $Message -ForegroundColor Red }
    }
}

function Test-IPAddress {
    param([string]$IP)
    if ($IP -eq "localhost" -or $IP -eq "") { return $true }
    return $IP -match '^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$'
}

function Test-PositiveInteger {
    param([string]$Value)
    $num = 0
    if ([int]::TryParse($Value, [ref]$num)) { return $num -gt 0 }
    return $false
}

Clear-Host
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "   CyberSentinel DLP Agent - Windows Installation Script   " -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

# Step 1: Configuration
Write-ColorOutput "Step 1: Configuration Setup" -Type "Info"
Write-Host ""

do {
    $serverIP = Read-Host "Enter server IP address (default: localhost)"
    if ([string]::IsNullOrWhiteSpace($serverIP)) { $serverIP = "localhost" }
    if (-not (Test-IPAddress $serverIP)) {
        Write-ColorOutput "Invalid IP address format. Please try again." -Type "Error"
    }
} while (-not (Test-IPAddress $serverIP))

$serverURL = "http://${serverIP}:55000/api/v1"
Write-ColorOutput "Server URL: $serverURL" -Type "Success"
Write-Host ""

# Test server connectivity
Write-ColorOutput "Testing server connectivity..." -Type "Info"
try {
    $healthUrl = "http://${serverIP}:55000/health"
    $resp = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 10
    if ($resp.status -eq "healthy") {
        Write-ColorOutput "Server is healthy" -Type "Success"
    }
} catch {
    Write-ColorOutput "Could not reach server at $healthUrl - continuing anyway" -Type "Warning"
}
Write-Host ""

$defaultAgentName = $env:COMPUTERNAME
$agentName = Read-Host "Enter Agent Name (default: $defaultAgentName)"
if ([string]::IsNullOrWhiteSpace($agentName)) { $agentName = $defaultAgentName }
Write-ColorOutput "Agent Name: $agentName" -Type "Success"
Write-Host ""

do {
    $heartbeatInput = Read-Host "Enter heartbeat interval in seconds (default: 30)"
    if ([string]::IsNullOrWhiteSpace($heartbeatInput)) { $heartbeatInterval = 30; break }
    if (-not (Test-PositiveInteger $heartbeatInput)) {
        Write-ColorOutput "Please enter a valid positive number." -Type "Error"
    } else { $heartbeatInterval = [int]$heartbeatInput; break }
} while ($true)
Write-ColorOutput "Heartbeat Interval: $heartbeatInterval seconds" -Type "Success"
Write-Host ""

do {
    $policySyncInput = Read-Host "Enter policy sync interval in seconds (default: 60)"
    if ([string]::IsNullOrWhiteSpace($policySyncInput)) { $policySyncInterval = 60; break }
    if (-not (Test-PositiveInteger $policySyncInput)) {
        Write-ColorOutput "Please enter a valid positive number." -Type "Error"
    } else { $policySyncInterval = [int]$policySyncInput; break }
} while ($true)
Write-ColorOutput "Policy Sync Interval: $policySyncInterval seconds" -Type "Success"
Write-Host ""

Write-Host "============================================================" -ForegroundColor Yellow
Write-Host "Configuration Summary:" -ForegroundColor Yellow
Write-Host "  Server URL:          $serverURL"
Write-Host "  Agent Name:          $agentName"
Write-Host "  Heartbeat Interval:  $heartbeatInterval seconds"
Write-Host "  Policy Sync:         $policySyncInterval seconds"
Write-Host "============================================================" -ForegroundColor Yellow
Write-Host ""

$confirm = Read-Host "Proceed with installation? (Y/N)"
if ($confirm -ne "Y" -and $confirm -ne "y") {
    Write-ColorOutput "Installation cancelled by user." -Type "Warning"
    exit 0
}

Write-Host ""

# Step 2: Remove old installations
Write-ColorOutput "Step 2: Removing previous installations..." -Type "Info"

Stop-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TASK_NAME -Confirm:$false -ErrorAction SilentlyContinue
Stop-ScheduledTask -TaskName "CyberSentinelAgent" -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "CyberSentinelAgent" -Confirm:$false -ErrorAction SilentlyContinue
$svc = Get-Service -Name "CyberSentinelAgent" -ErrorAction SilentlyContinue
if ($svc) {
    Stop-Service "CyberSentinelAgent" -Force -ErrorAction SilentlyContinue
    sc.exe delete "CyberSentinelAgent" 2>$null
}
Stop-Process -Name "cybersentinel_agent" -Force -ErrorAction SilentlyContinue
Write-ColorOutput "Previous installations cleaned" -Type "Success"
Write-Host ""

# Step 3: Create directories
Write-ColorOutput "Step 3: Creating installation directories..." -Type "Info"

foreach ($d in @($INSTALL_DIR, "$DATA_DIR\logs", "$DATA_DIR\quarantine", "$DATA_DIR\cache")) {
    if (-not (Test-Path $d)) {
        New-Item -ItemType Directory -Path $d -Force | Out-Null
    }
}
Write-ColorOutput "Directories created" -Type "Success"
Write-Host ""

# Step 4: Download agent binary
Write-ColorOutput "Step 4: Downloading agent from GitHub..." -Type "Info"

$exePath = Join-Path $INSTALL_DIR $EXE_NAME
$downloadUrl = "$RAW_BASE/agents/endpoint/windows/$EXE_NAME"

try {
    Write-ColorOutput "Downloading from: $downloadUrl" -Type "Info"
    Invoke-WebRequest -Uri $downloadUrl -OutFile $exePath -UseBasicParsing
    $fileSize = [math]::Round((Get-Item $exePath).Length / 1MB, 1)
    Write-ColorOutput "Downloaded successfully ($fileSize MB)" -Type "Success"
} catch {
    Write-ColorOutput "Error downloading agent: $($_.Exception.Message)" -Type "Error"
    Write-ColorOutput "Please check internet connection and GitHub repository access" -Type "Warning"
    exit 1
}
Write-Host ""

# Step 5: Set environment variable
Write-ColorOutput "Step 5: Setting environment variables..." -Type "Info"
[Environment]::SetEnvironmentVariable("CYBERSENTINEL_SERVER_URL", $serverURL, "Machine")
$env:CYBERSENTINEL_SERVER_URL = $serverURL
Write-ColorOutput "Environment variable set" -Type "Success"
Write-Host ""

# Step 6: Create configuration file
Write-ColorOutput "Step 6: Creating configuration file..." -Type "Info"

$configPath = Join-Path $INSTALL_DIR $CONFIG_NAME
$config = @{
    server_url = $serverURL
    agent_name = $agentName
    heartbeat_interval = $heartbeatInterval
    policy_sync_interval = $policySyncInterval
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
}

$config | ConvertTo-Json -Depth 4 | Out-File -FilePath $configPath -Encoding UTF8 -Force
Write-ColorOutput "Configuration created: $configPath" -Type "Success"
Write-Host ""

# Step 7: Create VBScript launcher for hidden background execution
Write-ColorOutput "Step 7: Creating background launcher..." -Type "Info"

$vbsPath = Join-Path $INSTALL_DIR "launch_agent.vbs"
$vbsContent = @"
Set objShell = CreateObject("Wscript.Shell")
objShell.Run """$exePath""", 0, False
"@
$vbsContent | Out-File -FilePath $vbsPath -Encoding ASCII -Force
Write-ColorOutput "Background launcher created: $vbsPath" -Type "Success"
Write-Host ""

# Step 8: Configure scheduled task
Write-ColorOutput "Step 8: Configuring auto-start scheduled task..." -Type "Info"

try {
    # Remove existing task if present
    $existingTask = Get-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
    if ($existingTask) {
        Unregister-ScheduledTask -TaskName $TASK_NAME -Confirm:$false
    }

    # Action: run VBScript launcher (hidden, no CMD window)
    $action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$vbsPath`"" -WorkingDirectory $INSTALL_DIR

    # Triggers: at logon AND at startup
    $triggerLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $triggerStartup = New-ScheduledTaskTrigger -AtStartup
    $triggerStartup.Delay = "PT30S"

    # Principal: run with highest privileges as current user
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest

    # Settings: always running, auto-restart, no time limit
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -DontStopOnIdleEnd `
        -RestartCount 999 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit (New-TimeSpan -Days 9999) `
        -MultipleInstances IgnoreNew

    Register-ScheduledTask `
        -TaskName $TASK_NAME `
        -Action $action `
        -Trigger @($triggerLogon, $triggerStartup) `
        -Principal $principal `
        -Settings $settings `
        -Description "CyberSentinel DLP Agent - Data Loss Prevention monitoring (clipboard, USB, files, screen capture)" `
        -Force | Out-Null

    Write-ColorOutput "Scheduled task created successfully!" -Type "Success"
    Write-ColorOutput "Task Name: $TASK_NAME" -Type "Info"
    Write-ColorOutput "Agent will start automatically at logon (hidden, no CMD window)" -Type "Success"

} catch {
    Write-ColorOutput "Error creating scheduled task: $($_.Exception.Message)" -Type "Error"
    Write-ColorOutput "You can manually start the agent with: wscript.exe `"$vbsPath`"" -Type "Warning"
}

Write-Host ""

# Step 9: Start the agent
Write-ColorOutput "Step 9: Starting the agent..." -Type "Info"

try {
    Start-ScheduledTask -TaskName $TASK_NAME
    Start-Sleep -Seconds 5

    $process = Get-Process -Name "cybersentinel_agent" -ErrorAction SilentlyContinue
    if ($process) {
        Write-ColorOutput "Agent is running! (PID: $($process.Id))" -Type "Success"
        Write-ColorOutput "Running in background mode (no visible window)" -Type "Success"
    } else {
        Write-ColorOutput "Agent started, waiting for process to initialize..." -Type "Warning"
        Start-Sleep -Seconds 5
        $process = Get-Process -Name "cybersentinel_agent" -ErrorAction SilentlyContinue
        if ($process) {
            Write-ColorOutput "Agent is running! (PID: $($process.Id))" -Type "Success"
        } else {
            Write-ColorOutput "Process not detected yet. Check logs for details." -Type "Warning"
        }
    }
} catch {
    Write-ColorOutput "Error starting agent: $($_.Exception.Message)" -Type "Error"
    Write-ColorOutput "You can manually start it: Start-ScheduledTask -TaskName '$TASK_NAME'" -Type "Info"
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "           Installation Completed Successfully!            " -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Installation Details:" -ForegroundColor Yellow
Write-Host "  Location:        $INSTALL_DIR"
Write-Host "  Executable:      $EXE_NAME"
Write-Host "  Configuration:   $CONFIG_NAME"
Write-Host "  Launcher:        launch_agent.vbs (hidden execution)"
Write-Host "  Scheduled Task:  $TASK_NAME"
Write-Host "  Runs As:         $env:USERNAME (for clipboard/screen access)"
Write-Host "  Server:          $serverURL"
Write-Host ""
Write-Host "Management Commands:" -ForegroundColor Yellow
Write-Host "  Start Agent:     Start-ScheduledTask -TaskName '$TASK_NAME'"
Write-Host "  Stop Agent:      Stop-Process -Name 'cybersentinel_agent' -Force"
Write-Host "  Check Status:    Get-Process -Name 'cybersentinel_agent'"
Write-Host "  View Logs:       Get-Content '$INSTALL_DIR\cybersentinel_agent.log' -Tail 30"
Write-Host "  Disable Auto:    Disable-ScheduledTask -TaskName '$TASK_NAME'"
Write-Host "  Enable Auto:     Enable-ScheduledTask -TaskName '$TASK_NAME'"
Write-Host ""
Write-Host "Uninstall:" -ForegroundColor Yellow
Write-Host "  Unregister-ScheduledTask -TaskName '$TASK_NAME' -Confirm:`$false"
Write-Host "  Stop-Process -Name 'cybersentinel_agent' -Force"
Write-Host "  Remove-Item '$INSTALL_DIR' -Recurse -Force"
Write-Host "  Remove-Item '$DATA_DIR' -Recurse -Force"
Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Read-Host "Press Enter to exit"
