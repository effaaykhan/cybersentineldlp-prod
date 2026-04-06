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

# Step 4: Install OCR + video processing dependencies
# Chocolatey  → package manager
# Tesseract   → OCR engine (used by post-recording video redactor)
# Python 3    → host for the redactor helper script
# ffmpeg      → muxes original audio back into the redacted video (optional)
# pip pkgs    → opencv-python (frame I/O) + pytesseract (OCR bindings)
Write-ColorOutput "Step 4: Installing OCR + video processing dependencies..." -Type "Info"

function Test-CommandExists {
    param([string]$Command)
    $null = Get-Command $Command -ErrorAction SilentlyContinue
    return $?
}

function Install-Chocolatey {
    Write-ColorOutput "  Chocolatey not found — installing..." -Type "Warning"
    try {
        Set-ExecutionPolicy Bypass -Scope Process -Force
        # TLS 1.2 is required by chocolatey.org
        [System.Net.ServicePointManager]::SecurityProtocol =
            [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
        Invoke-Expression ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))

        # Refresh PATH for this session so `choco` is callable immediately.
        $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
        $userPath    = [Environment]::GetEnvironmentVariable("Path", "User")
        $env:Path    = "$machinePath;$userPath"
        if (Test-Path "$env:ProgramData\chocolatey\bin") {
            $env:Path = "$env:ProgramData\chocolatey\bin;$env:Path"
        }

        if (Test-CommandExists "choco") {
            Write-ColorOutput "  Chocolatey installed successfully" -Type "Success"
            return $true
        } else {
            Write-ColorOutput "  Chocolatey install ran but 'choco' is not on PATH yet" -Type "Warning"
            Write-ColorOutput "  You may need to open a new PowerShell window after install completes" -Type "Warning"
            return $false
        }
    } catch {
        Write-ColorOutput "  Failed to install Chocolatey: $($_.Exception.Message)" -Type "Error"
        return $false
    }
}

function Install-Tesseract {
    Write-ColorOutput "  Tesseract not found — installing via choco..." -Type "Warning"
    try {
        # -y auto-confirms; --no-progress keeps logs clean
        $proc = Start-Process -FilePath "choco" `
                              -ArgumentList "install","tesseract","-y","--no-progress" `
                              -Wait -PassThru -NoNewWindow
        if ($proc.ExitCode -ne 0) {
            Write-ColorOutput "  choco install tesseract exited with code $($proc.ExitCode)" -Type "Warning"
        }

        # Refresh PATH so `tesseract` is callable in this session.
        $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
        $userPath    = [Environment]::GetEnvironmentVariable("Path", "User")
        $env:Path    = "$machinePath;$userPath"

        # The chocolatey package drops tesseract into Program Files\Tesseract-OCR
        $tessDir = "C:\Program Files\Tesseract-OCR"
        if ((Test-Path "$tessDir\tesseract.exe") -and ($env:Path -notlike "*$tessDir*")) {
            $env:Path = "$tessDir;$env:Path"
        }

        if (Test-CommandExists "tesseract") {
            $ver = & tesseract --version 2>&1 | Select-Object -First 1
            Write-ColorOutput "  Tesseract installed: $ver" -Type "Success"
            return $true
        } else {
            Write-ColorOutput "  Tesseract install ran but 'tesseract' is not on PATH yet" -Type "Warning"
            Write-ColorOutput "  A reboot or new PowerShell session may be required" -Type "Warning"
            return $false
        }
    } catch {
        Write-ColorOutput "  Failed to install Tesseract: $($_.Exception.Message)" -Type "Error"
        return $false
    }
}

# 4a. Chocolatey
if (Test-CommandExists "choco") {
    $chocoVer = (& choco --version 2>&1 | Select-Object -First 1)
    Write-ColorOutput "  Chocolatey already installed (v$chocoVer)" -Type "Success"
    $chocoOk = $true
} else {
    $chocoOk = Install-Chocolatey
}

# 4b. Tesseract (only if choco is now available)
if ($chocoOk) {
    if (Test-CommandExists "tesseract") {
        $tessVer = (& tesseract --version 2>&1 | Select-Object -First 1)
        Write-ColorOutput "  Tesseract already installed: $tessVer" -Type "Success"
    } else {
        $tessOk = Install-Tesseract
        if (-not $tessOk) {
            Write-ColorOutput "  Tesseract install incomplete — post-recording redaction will be disabled until installed" -Type "Warning"
            Write-ColorOutput "  After this script finishes, run: choco install tesseract -y" -Type "Warning"
        }
    }
} else {
    Write-ColorOutput "  Skipping Tesseract — Chocolatey is not available" -Type "Warning"
    Write-ColorOutput "  Install manually from https://github.com/UB-Mannheim/tesseract/wiki, then re-run this script" -Type "Warning"
}

# 4c. Python 3 (host for the post-recording video redactor)
if ($chocoOk) {
    if (Test-CommandExists "python") {
        $pyVer = (& python --version 2>&1 | Select-Object -First 1)
        Write-ColorOutput "  Python already installed: $pyVer" -Type "Success"
    } else {
        Write-ColorOutput "  Python not found — installing via choco..." -Type "Warning"
        try {
            $proc = Start-Process -FilePath "choco" `
                                  -ArgumentList "install","python","-y","--no-progress" `
                                  -Wait -PassThru -NoNewWindow
            if ($proc.ExitCode -ne 0) {
                Write-ColorOutput "  choco install python exited with code $($proc.ExitCode)" -Type "Warning"
            }
            # Refresh PATH so `python` and `pip` are callable in this session.
            $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
            $userPath    = [Environment]::GetEnvironmentVariable("Path", "User")
            $env:Path    = "$machinePath;$userPath"

            if (Test-CommandExists "python") {
                $pyVer = (& python --version 2>&1 | Select-Object -First 1)
                Write-ColorOutput "  Python installed: $pyVer" -Type "Success"
            } else {
                Write-ColorOutput "  Python install ran but not on PATH yet — may need a new PowerShell session" -Type "Warning"
            }
        } catch {
            Write-ColorOutput "  Failed to install Python: $($_.Exception.Message)" -Type "Error"
        }
    }
}

# 4d. ffmpeg (optional — used to mux audio back into redacted videos)
if ($chocoOk) {
    if (Test-CommandExists "ffmpeg") {
        Write-ColorOutput "  ffmpeg already installed" -Type "Success"
    } else {
        Write-ColorOutput "  ffmpeg not found — installing via choco (optional)..." -Type "Warning"
        try {
            Start-Process -FilePath "choco" `
                          -ArgumentList "install","ffmpeg","-y","--no-progress" `
                          -Wait -NoNewWindow | Out-Null
            $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
            $userPath    = [Environment]::GetEnvironmentVariable("Path", "User")
            $env:Path    = "$machinePath;$userPath"
            if (Test-CommandExists "ffmpeg") {
                Write-ColorOutput "  ffmpeg installed (audio will be preserved in redacted videos)" -Type "Success"
            } else {
                Write-ColorOutput "  ffmpeg install incomplete — redacted videos will be silent" -Type "Warning"
            }
        } catch {
            Write-ColorOutput "  ffmpeg install failed (non-fatal): $($_.Exception.Message)" -Type "Warning"
        }
    }
}

# 4e. Python packages: opencv-python + pytesseract
if (Test-CommandExists "python") {
    Write-ColorOutput "  Installing/updating Python packages: opencv-python, pytesseract..." -Type "Info"
    try {
        & python -m pip install --upgrade pip --quiet 2>&1 | Out-Null
        & python -m pip install --quiet opencv-python pytesseract 2>&1 | Out-Null
        $cvCheck = & python -c "import cv2, pytesseract; print(cv2.__version__)" 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-ColorOutput "  Python deps installed (opencv $cvCheck, pytesseract)" -Type "Success"
        } else {
            Write-ColorOutput "  Python package install verification failed: $cvCheck" -Type "Warning"
        }
    } catch {
        Write-ColorOutput "  Failed to install Python packages: $($_.Exception.Message)" -Type "Warning"
        Write-ColorOutput "  After this script finishes, run: python -m pip install opencv-python pytesseract" -Type "Warning"
    }
} else {
    Write-ColorOutput "  Skipping pip install — Python is not on PATH yet" -Type "Warning"
}

Write-Host ""

# Step 5: Download agent binary
Write-ColorOutput "Step 5: Downloading agent from GitHub..." -Type "Info"

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

# Also download the post-recording video redactor Python helper. The agent
# expects to find it at INSTALL_DIR\dlp_video_redactor.py.
$scriptUrl  = "$RAW_BASE/agents/endpoint/windows/dlp_video_redactor.py"
$scriptDest = Join-Path $INSTALL_DIR "dlp_video_redactor.py"
try {
    Write-ColorOutput "Downloading video redactor helper: $scriptUrl" -Type "Info"
    Invoke-WebRequest -Uri $scriptUrl -OutFile $scriptDest -UseBasicParsing
    Write-ColorOutput "Helper script installed: $scriptDest" -Type "Success"
} catch {
    Write-ColorOutput "Failed to download video redactor helper: $($_.Exception.Message)" -Type "Warning"
    Write-ColorOutput "Post-recording video redaction will not work until the helper is present" -Type "Warning"
}
Write-Host ""

# Step 6: Set environment variable
Write-ColorOutput "Step 6: Setting environment variables..." -Type "Info"
[Environment]::SetEnvironmentVariable("CYBERSENTINEL_SERVER_URL", $serverURL, "Machine")
$env:CYBERSENTINEL_SERVER_URL = $serverURL
Write-ColorOutput "Environment variable set" -Type "Success"
Write-Host ""

# Step 7: Create configuration file
Write-ColorOutput "Step 7: Creating configuration file..." -Type "Info"

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

# Step 8: Create VBScript launcher for hidden background execution
Write-ColorOutput "Step 8: Creating background launcher..." -Type "Info"

$vbsPath = Join-Path $INSTALL_DIR "launch_agent.vbs"
$vbsContent = @"
Set objShell = CreateObject("Wscript.Shell")
objShell.Run """$exePath""", 0, False
"@
$vbsContent | Out-File -FilePath $vbsPath -Encoding ASCII -Force
Write-ColorOutput "Background launcher created: $vbsPath" -Type "Success"
Write-Host ""

# Step 9: Configure scheduled task
Write-ColorOutput "Step 9: Configuring auto-start scheduled task..." -Type "Info"

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

# Step 10: Start the agent
Write-ColorOutput "Step 10: Starting the agent..." -Type "Info"

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
