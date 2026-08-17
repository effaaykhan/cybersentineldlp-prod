<#
  manage-windows-agent.ps1 — CyberSentinel DLP WINDOWS agent MANAGER.

  A single, self-contained console app. Self-elevates to Administrator, detects any
  existing agent (current OR legacy layout), reports its live status, and offers:

      [1] Install  [2] Update  [3] Uninstall  [4] Logs  [5] Extension  [6] Exit

  Everything (install, update, uninstall) is implemented INLINE in this one file —
  it does not download or depend on any other script. The only things it fetches
  from GitHub are the agent binary and its SHA-256 sidecar (the actual artifacts).

  Run either form (both self-elevate to Administrator):
    powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/effaaykhan/cybersentineldlp-prod/main/manage-windows-agent.ps1 | iex"
    powershell -ExecutionPolicy Bypass -File .\manage-windows-agent.ps1
#>

& {
  $ErrorActionPreference = 'Continue'
  $ProgressPreference    = 'SilentlyContinue'   # hide the noisy Invoke-WebRequest bar

  # ============================================================
  #  Constants
  # ============================================================
  $GITHUB_REPO = 'effaaykhan/cybersentineldlp-prod'
  $RAW_BASE    = "https://raw.githubusercontent.com/$GITHUB_REPO/main"
  $SELF_URL    = "$RAW_BASE/manage-windows-agent.ps1"                                   # for self-elevation re-fetch
  $EXE_URL     = "$RAW_BASE/agents/endpoint/windows/cybersentineldlp_agent.exe"         # agent binary artifact
  $SUM_URL     = "$EXE_URL.sha256"                                                      # its checksum sidecar

  $INSTALL_DIR = 'C:\Program Files\CyberSentinelDLP'
  $DATA_DIR    = 'C:\ProgramData\CyberSentinelDLP'
  $EXE_NAME    = 'cybersentineldlp_agent.exe'
  $CONFIG_NAME = 'agent_config.json'
  $LOG_NAME    = 'cybersentineldlp_agent.log'
  $VBS_NAME    = 'launch_agent.vbs'
  $TASK_NAME   = 'CyberSentinel DLP Agent'
  $PROC_NAME   = 'cybersentineldlp_agent'

  # Legacy (pre-rename) layout — detected so we can flag / clean it too.
  $LEGACY_DIR   = 'C:\Program Files\CyberSentinel'
  $LEGACY_DATA  = 'C:\ProgramData\CyberSentinel'
  $LEGACY_PROC  = 'cybersentinel_agent'
  $TASK_NAMES   = @($TASK_NAME, 'CyberSentinelAgent', 'CyberSentinel Agent')
  $SVC_NAMES    = @('CyberSentinelAgent', 'CyberSentinelDLPAgent')

  $BOX_W = 64

  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

  # ============================================================
  #  UI primitives  (ASCII-only, so every console code page renders it)
  # ============================================================
  function Hr        { param([string]$ch='-',[string]$c='DarkCyan') Write-Host ('  ' + ($ch * $BOX_W)) -ForegroundColor $c }
  function Blank     { Write-Host '' }
  function Info      { param([string]$m) Write-Host "   [..] $m" -ForegroundColor Gray }
  function Ok        { param([string]$m) Write-Host "   [OK] $m" -ForegroundColor Green }
  function Warn      { param([string]$m) Write-Host "   [!!] $m" -ForegroundColor Yellow }
  function Err       { param([string]$m) Write-Host "   [xx] $m" -ForegroundColor Red }
  function Hint      { param([string]$m) Write-Host "   $m" -ForegroundColor DarkGray }

  function Header {
    param([string]$Title,[string]$Color='Cyan')
    Hr '=' $Color
    Write-Host ('   ' + $Title) -ForegroundColor $Color
    Hr '=' $Color
  }

  function Step {
    param([int]$N,[int]$Total,[string]$Title)
    Blank
    Write-Host ("   [ Step {0}/{1} ]  {2}" -f $N,$Total,$Title) -ForegroundColor Cyan
    Hr '-' 'DarkCyan'
  }

  function Field {
    param([string]$Label,[string]$Value,[string]$Color='Gray')
    Write-Host ('   {0} : ' -f $Label.PadRight(8)) -ForegroundColor DarkGray -NoNewline
    Write-Host $Value -ForegroundColor $Color
  }

  # Animated (or instant) product banner. Pure-ASCII slant wordmark.
  function Show-Banner {
    param([switch]$Animate)
    $art = @(
      '    ______      __              _____            __  _            __',
      '   / ____/_  __/ /_  ___  _____/ ___/___  ____  / /_(_)___  ___  / /',
      '  / /   / / / / __ \/ _ \/ ___/\__ \/ _ \/ __ \/ __/ / __ \/ _ \/ /',
      ' / /___/ /_/ / /_/ /  __/ /   ___/ /  __/ / / / /_/ / / / /  __/ /',
      ' \____/\__, /_.___/\___/_/   /____/\___/_/ /_/\__/_/_/ /_/\___/_/',
      '      /____/'
    )
    $colors = @('DarkCyan','Cyan','Cyan','Cyan','DarkCyan','DarkCyan')
    Blank
    for ($i = 0; $i -lt $art.Count; $i++) {
      Write-Host $art[$i] -ForegroundColor $colors[$i]
      if ($Animate) { Start-Sleep -Milliseconds 55 }
    }
    Write-Host '        D A T A   L O S S   P R E V E N T I O N   ---   A G E N T' -ForegroundColor White
    if ($Animate) { Start-Sleep -Milliseconds 120 }
    Write-Host '                  W i n d o w s   M a n a g e r   C o n s o l e' -ForegroundColor DarkGray
    Blank
  }

  # Run a scriptblock while showing an animated spinner. Uses a background runspace
  # so it truly animates. Returns the work's last output value; re-throws if the
  # work throws (so the caller's try/catch reports it). Only a runspace-CREATION
  # failure falls back to running inline.
  function Invoke-Spinner {
    param(
      [Parameter(Mandatory=$true)][scriptblock]$Work,
      [object[]]$ArgumentList = @(),
      [string]$Text = 'Working'
    )
    $ps = $null
    try { $ps = [PowerShell]::Create() } catch { $ps = $null }
    if (-not $ps) { return (& $Work @ArgumentList) }

    $cursorHidden = $false
    try { [Console]::CursorVisible = $false; $cursorHidden = $true } catch {}
    try {
      [void]$ps.AddScript($Work)
      foreach ($a in $ArgumentList) { [void]$ps.AddArgument($a) }
      $handle = $ps.BeginInvoke()
      $frames = @('|','/','-','\')
      $i = 0
      while (-not $handle.IsCompleted) {
        Write-Host -NoNewline ("`r   {0} {1}..." -f $frames[$i % $frames.Count], $Text) -ForegroundColor Cyan
        Start-Sleep -Milliseconds 90
        $i++
      }
      $out = @($ps.EndInvoke($handle))
      return ($out | Select-Object -Last 1)
    } finally {
      if ($cursorHidden) { try { [Console]::CursorVisible = $true } catch {} }
      Write-Host -NoNewline ("`r{0}`r" -f (' ' * ($Text.Length + 10)))
      try { $ps.Dispose() } catch {}
    }
  }

  # ============================================================
  #  Small validators / helpers
  # ============================================================
  function Test-ServerHost {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
    if ($Value -eq 'localhost') { return $true }
    if ($Value -match '^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$') { return $true }
    if ($Value.Length -le 253 -and `
        $Value -match '^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$') { return $true }
    return $false
  }
  function Test-PositiveInteger {
    param([string]$Value)
    $n = 0
    if ([int]::TryParse($Value, [ref]$n)) { return $n -gt 0 }
    return $false
  }
  function Test-CommandExists {
    param([string]$Command)
    $null = Get-Command $Command -ErrorAction SilentlyContinue
    return $?
  }
  function Get-RemoteSha {
    param([string]$Url)
    try {
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      $c = (Invoke-WebRequest -Uri $Url -UseBasicParsing -ErrorAction Stop).Content
      return $c.Trim().Split()[0].ToUpper()
    } catch { return $null }
  }

  # ============================================================
  #  Elevation
  # ============================================================
  $isAdmin = ([Security.Principal.WindowsPrincipal] `
      [Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $isAdmin) {
    Warn 'Administrator rights required - relaunching in an elevated window...'
    try {
      if ($PSCommandPath) {
        Start-Process powershell.exe -Verb RunAs -ArgumentList @(
          '-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`"")
      } else {
        Start-Process powershell.exe -Verb RunAs -ArgumentList @(
          '-NoProfile','-ExecutionPolicy','Bypass','-Command',"irm $SELF_URL | iex")
      }
    } catch {
      Err "Could not self-elevate: $($_.Exception.Message)"
      Warn "Re-open PowerShell with 'Run as administrator' and run this again."
    }
    return
  }

  # ============================================================
  #  Detection
  # ============================================================
  function Get-AgentStatus {
    $curExe = Join-Path $INSTALL_DIR $EXE_NAME
    $curCfg = Join-Path $INSTALL_DIR $CONFIG_NAME
    $curLog = Join-Path $INSTALL_DIR $LOG_NAME

    $exeExists = Test-Path $curExe
    $dirExists = Test-Path $INSTALL_DIR
    $proc      = Get-Process -Name $PROC_NAME -ErrorAction SilentlyContinue | Select-Object -First 1

    $task = $null
    foreach ($n in $TASK_NAMES) {
      $t = Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
      if ($t) { $task = $t; break }
    }

    $legProc = Get-Process -Name $LEGACY_PROC -ErrorAction SilentlyContinue | Select-Object -First 1
    $legDir  = Test-Path $LEGACY_DIR
    $isLegacy = (($legDir) -or ($legProc)) -and (-not ($dirExists -or $exeExists -or $proc -or $task))

    $agentId = $null; $serverUrl = $null; $agentName = $null
    if (Test-Path $curCfg) {
      try {
        $c = Get-Content $curCfg -Raw -ErrorAction Stop | ConvertFrom-Json
        $agentId = $c.agent_id; $serverUrl = $c.server_url; $agentName = $c.agent_name
      } catch {}
    }

    $exeHash = $null; $exeSize = $null
    if ($exeExists) {
      try { $exeHash = (Get-FileHash -Algorithm SHA256 -Path $curExe).Hash.ToUpper() } catch {}
      try { $exeSize = [math]::Round((Get-Item $curExe).Length / 1MB, 1) } catch {}
    }

    $installed = $dirExists -or $exeExists -or [bool]$proc -or [bool]$task -or $isLegacy

    $health = 'NOT INSTALLED'; $healthColor = 'Yellow'
    if ($isLegacy) {
      $health = 'LEGACY INSTALL (pre-rename) - Uninstall then Install recommended'; $healthColor = 'Yellow'
    } elseif ($installed) {
      if ($exeExists) {
        if ($proc)     { $health = 'RUNNING';                                  $healthColor = 'Green' }
        elseif ($task) { $health = 'STOPPED (installed, autostart configured)'; $healthColor = 'Yellow' }
        else           { $health = 'BROKEN - installed but no autostart task';  $healthColor = 'Red' }
      } else {
        if ($proc) { $health = 'RUNNING but binary missing on disk!';          $healthColor = 'Red' }
        else       { $health = 'BROKEN - install dir present, binary missing';  $healthColor = 'Red' }
      }
    }

    $logErrCount = 0; $lastErr = $null
    if (Test-Path $curLog) {
      try {
        $tail = Get-Content $curLog -Tail 80 -ErrorAction SilentlyContinue
        $errLines = $tail | Where-Object { $_ -match '(?i)\b(error|critical|fatal|exception|traceback)\b' }
        $logErrCount = @($errLines).Count
        if ($logErrCount -gt 0) { $lastErr = ($errLines | Select-Object -Last 1) }
      } catch {}
    }

    $taskName = $null; $taskState = $null
    if ($task) { $taskName = $task.TaskName; $taskState = $task.State }
    $procId = $null
    if ($proc) { $procId = $proc.Id }

    [PSCustomObject]@{
      Installed = $installed; IsLegacy = $isLegacy; Health = $health; HealthColor = $healthColor
      InstallDir = $INSTALL_DIR; ExeExists = $exeExists; ExeHash = $exeHash; ExeSize = $exeSize
      ConfigExists = (Test-Path $curCfg); AgentId = $agentId; ServerUrl = $serverUrl; AgentName = $agentName
      TaskExists = [bool]$task; TaskName = $taskName; TaskState = $taskState
      ProcRunning = [bool]$proc; ProcId = $procId
      LogPath = $curLog; LogErrCount = $logErrCount; LastErr = $lastErr
      LegacyDir = $legDir; LegacyProc = [bool]$legProc
    }
  }

  function Show-Status {
    param($s, $remoteHash)
    Hr '-' 'DarkCyan'
    Write-Host -NoNewline '   STATUS  : '
    Write-Host $s.Health -ForegroundColor $s.HealthColor

    if ($s.Installed -and -not $s.IsLegacy) {
      if ($s.ProcRunning) { Field 'PID' "$($s.ProcId)" }
      Field 'Path' $s.InstallDir
      if ($s.AgentName) { Field 'Agent' $s.AgentName }
      if ($s.AgentId)   { Field 'ID'    $s.AgentId }
      if ($s.ServerUrl) { Field 'Server' $s.ServerUrl }
      if ($s.ExeExists -and $s.ExeHash) {
        Field 'Binary' ("{0} MB  sha {1}..." -f $s.ExeSize, $s.ExeHash.Substring(0,12))
      }
      if ($s.TaskExists) { Field 'Task' ("{0} [{1}]" -f $s.TaskName, $s.TaskState) }
      else { Field 'Task' '(none - agent will NOT auto-start)' 'Red' }

      if ($s.ExeExists -and $s.ExeHash) {
        if ($remoteHash) {
          if ($remoteHash -eq $s.ExeHash) { Field 'Update' 'up to date' 'Green' }
          else { Field 'Update' ("AVAILABLE (latest sha {0}...) - use [2]" -f $remoteHash.Substring(0,12)) 'Yellow' }
        } else {
          Field 'Update' 'could not check (offline / GitHub unreachable)' 'DarkGray'
        }
      }
      if ($s.LogErrCount -gt 0) {
        Field 'Log' ("{0} recent error line(s)" -f $s.LogErrCount) 'Yellow'
        if ($s.LastErr) {
          $le = $s.LastErr.Trim()
          if ($le.Length -gt 90) { $le = $le.Substring(0,90) + '...' }
          Write-Host "             $le" -ForegroundColor DarkYellow
        }
      }
    } elseif ($s.IsLegacy) {
      Write-Host "   NOTE    : found legacy 'CyberSentinel' files/process." -ForegroundColor Yellow
      Write-Host '             Uninstall (3) then Install (1) for the current agent.' -ForegroundColor Yellow
    }
    Hr '-' 'DarkCyan'
  }

  # ============================================================
  #  INSTALL  (fully inline - no external script)
  # ============================================================
  function Invoke-Install {
    param($Status)
    $TOTAL = 9
    Blank
    Header 'INSTALL CyberSentinel DLP Agent' 'Green'

    # -- Step 1: configuration ------------------------------------------------
    Step 1 $TOTAL 'Configuration'
    do {
      $serverIP = Read-Host '   Server IP or hostname (default: localhost)'
      if ([string]::IsNullOrWhiteSpace($serverIP)) { $serverIP = 'localhost' }
      if (-not (Test-ServerHost $serverIP)) { Err "Invalid host. Use an IPv4 literal, 'localhost', or a hostname/FQDN." }
    } while (-not (Test-ServerHost $serverIP))
    $serverURL = "http://${serverIP}:55100/api/v1"

    $reachable = Invoke-Spinner -Text "Testing server at ${serverIP}:55100" -ArgumentList @($serverIP) -Work {
      param($ip)
      try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $r = Invoke-RestMethod -Uri "http://${ip}:55100/health" -TimeoutSec 8
        if ($r.status -eq 'healthy') { 'healthy' } else { 'reachable' }
      } catch { $null }
    }
    if ($reachable) { Ok "Server reachable ($reachable)" } else { Warn 'Could not reach the server - continuing anyway.' }

    $defaultAgentName = $env:COMPUTERNAME
    $agentName = Read-Host "   Agent name (default: $defaultAgentName)"
    if ([string]::IsNullOrWhiteSpace($agentName)) { $agentName = $defaultAgentName }

    do {
      $hb = Read-Host '   Heartbeat interval seconds (default: 30)'
      if ([string]::IsNullOrWhiteSpace($hb)) { $heartbeat = 30; break }
      if (-not (Test-PositiveInteger $hb)) { Err 'Enter a positive number.' } else { $heartbeat = [int]$hb; break }
    } while ($true)

    do {
      $ps = Read-Host '   Policy sync interval seconds (default: 60)'
      if ([string]::IsNullOrWhiteSpace($ps)) { $policySync = 60; break }
      if (-not (Test-PositiveInteger $ps)) { Err 'Enter a positive number.' } else { $policySync = [int]$ps; break }
    } while ($true)

    Blank
    Header 'Configuration summary' 'Yellow'
    Field 'Server'    $serverURL
    Field 'Agent'     $agentName
    Field 'Heartbeat' "$heartbeat s"
    Field 'PolicySnc' "$policySync s"
    Hr '=' 'Yellow'
    $go = Read-Host '   Proceed with installation? (Y/N)'
    if ($go -ne 'Y' -and $go -ne 'y') { Warn 'Installation cancelled.'; return }

    # -- Step 2: remove previous installs (recover identity first) ------------
    Step 2 $TOTAL 'Removing any previous agent'
    $recoveredId = $null
    foreach ($cfg in @((Join-Path $INSTALL_DIR $CONFIG_NAME), (Join-Path $LEGACY_DIR $CONFIG_NAME))) {
      if ((Test-Path $cfg) -and -not $recoveredId) {
        try {
          $id = (Get-Content $cfg -Raw -ErrorAction Stop | ConvertFrom-Json).agent_id
          if ($id) { $recoveredId = $id; Info "Found existing agent identity: $id" }
        } catch {}
      }
    }
    foreach ($p in @($PROC_NAME, $LEGACY_PROC)) {
      Get-Process -Name $p -ErrorAction SilentlyContinue | ForEach-Object {
        Info "Stopping $($_.Name) (PID $($_.Id))"; Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
      }
    }
    $handled = @{}
    foreach ($n in $TASK_NAMES) {
      if (Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $n -Confirm:$false -ErrorAction SilentlyContinue
        $handled[$n] = $true
      }
    }
    Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {
      (($_.Actions.Arguments -join ' ') -match '\\CyberSentinel\\') -or
      (($_.Actions.Execute   -join ' ') -match '\\CyberSentinel\\')
    } | ForEach-Object {
      if (-not $handled[$_.TaskName]) {
        Info "Removing legacy task: $($_.TaskName)"
        Stop-ScheduledTask -TaskName $_.TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $_.TaskName -Confirm:$false -ErrorAction SilentlyContinue
      }
    }
    foreach ($svc in $SVC_NAMES) {
      if (Get-Service -Name $svc -ErrorAction SilentlyContinue) {
        Stop-Service $svc -Force -ErrorAction SilentlyContinue; sc.exe delete $svc 2>$null | Out-Null
      }
    }
    foreach ($d in @($LEGACY_DIR, $LEGACY_DATA)) {
      if (Test-Path $d) { Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue; Info "Removed legacy dir: $d" }
    }
    if ($recoveredId) { Ok "Previous agent removed; identity $recoveredId will be carried over" }
    else { Ok 'Clean install (no previous agent found)' }

    # -- Step 3: directories --------------------------------------------------
    Step 3 $TOTAL 'Creating directories'
    foreach ($d in @($INSTALL_DIR, "$DATA_DIR\logs", "$DATA_DIR\quarantine", "$DATA_DIR\cache")) {
      if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
    }
    Ok 'Directories ready'

    # -- Step 4: OCR deps (optional) -----------------------------------------
    Step 4 $TOTAL 'OCR dependencies (Chocolatey + Tesseract, optional)'
    Hint 'Used only by the screen-capture OCR fallback; the agent runs without them.'
    if (Test-CommandExists 'choco') {
      Ok 'Chocolatey already present'
    } else {
      Info 'Installing Chocolatey...'
      try {
        Set-ExecutionPolicy Bypass -Scope Process -Force
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072
        Invoke-Expression ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
        $env:Path = "$([Environment]::GetEnvironmentVariable('Path','Machine'));$([Environment]::GetEnvironmentVariable('Path','User'))"
        if (Test-Path "$env:ProgramData\chocolatey\bin") { $env:Path = "$env:ProgramData\chocolatey\bin;$env:Path" }
      } catch { Warn "Chocolatey install failed: $($_.Exception.Message)" }
    }
    if (Test-CommandExists 'choco') {
      if (Test-CommandExists 'tesseract') {
        Ok 'Tesseract already present'
      } else {
        Info 'Installing Tesseract (this can take a minute)...'
        try {
          $p = Start-Process -FilePath 'choco' -ArgumentList 'install','tesseract','-y','--no-progress' -Wait -PassThru -NoNewWindow
          $env:Path = "$([Environment]::GetEnvironmentVariable('Path','Machine'));$([Environment]::GetEnvironmentVariable('Path','User'))"
          if (Test-Path 'C:\Program Files\Tesseract-OCR\tesseract.exe') { $env:Path = "C:\Program Files\Tesseract-OCR;$env:Path" }
          if (Test-CommandExists 'tesseract') { Ok 'Tesseract installed' }
          else { Warn 'Tesseract not on PATH yet - screen OCR fallback may need a new session/reboot' }
        } catch { Warn "Tesseract install failed: $($_.Exception.Message)" }
      }
    } else {
      Warn 'Chocolatey unavailable - skipping Tesseract (screen OCR fallback disabled)'
    }

    # -- Step 5: download + verify binary ------------------------------------
    Step 5 $TOTAL 'Downloading + verifying the agent binary'
    $exePath = Join-Path $INSTALL_DIR $EXE_NAME
    try {
      Invoke-Spinner -Text 'Downloading binary' -ArgumentList @($EXE_URL, $exePath) -Work {
        param($u,$out)
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $u -OutFile $out -UseBasicParsing
      } | Out-Null
    } catch { Err "Download failed: $($_.Exception.Message)"; return }
    if (-not (Test-Path $exePath)) { Err 'Download failed (no file written).'; return }
    $sizeMB = [math]::Round((Get-Item $exePath).Length / 1MB, 1)
    Ok "Downloaded ($sizeMB MB)"

    $expected = Get-RemoteSha $SUM_URL
    if ($expected) {
      $actual = (Get-FileHash -Algorithm SHA256 -Path $exePath).Hash.ToUpper()
      if ($actual -ne $expected) {
        Err 'SHA-256 MISMATCH - refusing to install a tampered/corrupt binary.'
        Hint "expected $expected"
        Hint "actual   $actual"
        Remove-Item $exePath -Force -ErrorAction SilentlyContinue
        return
      }
      Ok "SHA-256 verified ($($actual.Substring(0,16))...)"
    } else {
      Warn 'No checksum sidecar reachable - integrity check skipped.'
    }

    # -- Step 6: environment + config ----------------------------------------
    Step 6 $TOTAL 'Writing configuration'
    [Environment]::SetEnvironmentVariable('CYBERSENTINELDLP_SERVER_URL', $serverURL, 'Machine')
    $env:CYBERSENTINELDLP_SERVER_URL = $serverURL

    $config = @{
      server_url = $serverURL; agent_name = $agentName
      heartbeat_interval = $heartbeat; policy_sync_interval = $policySync
      ransomware_detection_enabled = $true; ransomware_burst_threshold = 15
      ransomware_window_seconds = 10; ransomware_cooldown_seconds = 60
      monitoring = @{
        file_system = $true; clipboard = $true; usb_devices = $true
        screen_capture = $true; print_jobs = $true
        monitored_paths = @("C:\Users\$env:USERNAME\Documents","C:\Users\$env:USERNAME\Desktop","C:\Users\$env:USERNAME\Downloads")
        file_extensions = @('.pdf','.docx','.xlsx','.csv','.txt','.json','.xml','.sql','.pem','.key','.env','.conf')
      }
      quarantine_path = "$DATA_DIR\quarantine"; log_path = "$DATA_DIR\logs"; cache_path = "$DATA_DIR\cache"
    }
    # Identity is assigned HERE rather than left to the agent to mint on first
    # run. Two reasons:
    #   * The agent generates an id when the config has none and persists it back
    #     — but only if it can resolve and write that config. When it cannot, it
    #     generates a fresh one every restart, and the dashboard grows a new row
    #     per reboot.
    #   * The browser extension has to report under this exact id so a device
    #     running BOTH appears once, not twice. This script is the only place
    #     that knows the identity and can hand it to the extension's policy.
    if ($recoveredId) {
      Info "Preserving identity $recoveredId"
    } else {
      $slug = ($agentName.ToLower() -replace '[^a-z0-9]', '-').Trim('-')
      if (-not $slug) { $slug = 'endpoint' }
      $recoveredId = "win-$slug-$([guid]::NewGuid().ToString('N').Substring(0,8))"
      Info "Assigned agent identity $recoveredId"
    }
    $config.agent_id = $recoveredId
    $configPath = Join-Path $INSTALL_DIR $CONFIG_NAME
    $config | ConvertTo-Json -Depth 4 | Out-File -FilePath $configPath -Encoding ASCII -Force   # ASCII = no BOM
    Ok 'Configuration written'

    # -- Step 7: launcher -----------------------------------------------------
    Step 7 $TOTAL 'Creating hidden background launcher'
    $vbsPath = Join-Path $INSTALL_DIR $VBS_NAME
    @"
Set objShell = CreateObject("Wscript.Shell")
objShell.Run """$exePath""", 0, False
"@ | Out-File -FilePath $vbsPath -Encoding ASCII -Force
    Ok 'Launcher created (no console window on start)'

    # -- Step 8: scheduled task ----------------------------------------------
    Step 8 $TOTAL 'Registering auto-start scheduled task'
    try {
      if (Get-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TASK_NAME -Confirm:$false
      }
      $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbsPath`"" -WorkingDirectory $INSTALL_DIR
      $tLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
      $tBoot  = New-ScheduledTaskTrigger -AtStartup
      $tBoot.Delay = 'PT30S'
      $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
      $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -DontStopOnIdleEnd -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit (New-TimeSpan -Days 9999) -MultipleInstances IgnoreNew
      Register-ScheduledTask -TaskName $TASK_NAME -Action $action -Trigger @($tLogon,$tBoot) `
        -Principal $principal -Settings $settings -Description 'CyberSentinel DLP Agent - endpoint monitoring' -Force | Out-Null
      Ok "Scheduled task '$TASK_NAME' registered (logon + startup)"
    } catch {
      Err "Could not create scheduled task: $($_.Exception.Message)"
      Hint "You can start it manually: wscript.exe `"$vbsPath`""
    }

    # -- Step 9: start --------------------------------------------------------
    Step 9 $TOTAL 'Starting the agent'
    try { Start-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue } catch {}
    $proc = $null
    for ($i = 0; $i -lt 6 -and -not $proc; $i++) {
      Start-Sleep -Seconds 2
      $proc = Get-Process -Name $PROC_NAME -ErrorAction SilentlyContinue | Select-Object -First 1
    }
    Blank
    if ($proc) {
      Header 'INSTALL COMPLETE' 'Green'
      Ok "Agent is running (PID $($proc.Id))"
    } else {
      Header 'INSTALL FINISHED (agent not detected yet)' 'Yellow'
      Warn 'Process not seen yet - it may still be initializing. Check the log.'
    }
    Field 'Path'   $INSTALL_DIR
    Field 'Server' $serverURL
    Field 'Log'    (Join-Path $INSTALL_DIR $LOG_NAME)
    if ($recoveredId) { Field 'ID' "$recoveredId (migrated)" 'Yellow' }
  }

  # ============================================================
  #  UPDATE  (fully inline - no external script)
  # ============================================================
  function Invoke-Update {
    Blank
    Header 'UPDATE agent binary' 'Cyan'
    $exePath = Join-Path $INSTALL_DIR $EXE_NAME
    $tmpExe  = Join-Path $env:TEMP $EXE_NAME

    Info 'Downloading the latest published binary...'
    try {
      Invoke-Spinner -Text 'Downloading + verifying' -ArgumentList @($EXE_URL, $tmpExe) -Work {
        param($u,$out)
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $u -OutFile $out -UseBasicParsing
      } | Out-Null
    } catch { Err "Download failed: $($_.Exception.Message)"; return }
    if (-not (Test-Path $tmpExe)) { Err 'Download failed (no file written).'; return }

    $expected = Get-RemoteSha $SUM_URL
    $actual   = (Get-FileHash -Algorithm SHA256 -Path $tmpExe).Hash.ToUpper()
    if ($expected -and $expected -ne $actual) {
      Remove-Item $tmpExe -Force -ErrorAction SilentlyContinue
      Err 'SHA-256 mismatch - download corrupt. Installed agent left untouched.'
      return
    }
    $sizeMB = [math]::Round((Get-Item $tmpExe).Length / 1MB, 1)
    Ok "Downloaded + verified ($sizeMB MB, sha $($actual.Substring(0,12))...)"

    if (Test-Path $exePath) {
      $current = (Get-FileHash -Algorithm SHA256 -Path $exePath).Hash.ToUpper()
      if ($current -eq $actual) {
        Remove-Item $tmpExe -Force -ErrorAction SilentlyContinue
        Ok 'Already up to date - nothing to do.'
        return
      }
    }

    Info 'Stopping the agent...'
    Stop-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
    Get-Process -Name $PROC_NAME -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

    if (Test-Path $exePath) { Copy-Item $exePath "$exePath.bak" -Force -ErrorAction SilentlyContinue }
    $replaced = $false
    for ($i = 1; $i -le 10 -and -not $replaced; $i++) {
      try { Copy-Item $tmpExe $exePath -Force; $replaced = $true } catch { Start-Sleep -Milliseconds 700 }
    }
    Remove-Item $tmpExe -Force -ErrorAction SilentlyContinue
    if (-not $replaced) { Err "Could not replace $exePath (file locked). Agent is stopped - retry or reboot."; return }
    Ok "Binary replaced (previous kept as $EXE_NAME.bak)"

    Info 'Restarting the agent...'
    Start-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
    $proc = Get-Process -Name $PROC_NAME -ErrorAction SilentlyContinue | Select-Object -First 1
    Blank
    if ($proc) { Ok "Update complete - agent running (PID $($proc.Id))." }
    else { Warn "Agent not detected yet - start it with: Start-ScheduledTask -TaskName '$TASK_NAME'" }
  }

  # ============================================================
  #  UNINSTALL  (both layouts, offline-capable)
  # ============================================================
  function Uninstall-Agent {
    Blank
    Header 'UNINSTALL agent' 'Red'
    $removed = $false

    foreach ($p in @($PROC_NAME, $LEGACY_PROC)) {
      Get-Process -Name $p -ErrorAction SilentlyContinue | ForEach-Object {
        Info "Stopping $($_.Name) (PID $($_.Id))"
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue; $removed = $true
      }
    }
    Start-Sleep -Milliseconds 200

    $handled = @{}
    foreach ($n in $TASK_NAMES) {
      if (Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue) {
        Info "Removing scheduled task: $n"
        Stop-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $n -Confirm:$false -ErrorAction SilentlyContinue
        $handled[$n] = $true; $removed = $true
      }
    }
    Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {
      (($_.Actions.Arguments -join ' ') -match 'CyberSentinel(DLP)?\\') -or
      (($_.Actions.Execute   -join ' ') -match 'CyberSentinel(DLP)?\\')
    } | ForEach-Object {
      if (-not $handled[$_.TaskName]) {
        Info "Removing scheduled task: $($_.TaskName)"
        Stop-ScheduledTask -TaskName $_.TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $_.TaskName -Confirm:$false -ErrorAction SilentlyContinue; $removed = $true
      }
    }

    foreach ($svc in $SVC_NAMES) {
      if (Get-Service -Name $svc -ErrorAction SilentlyContinue) {
        Info "Removing service: $svc"
        Stop-Service $svc -Force -ErrorAction SilentlyContinue; sc.exe delete $svc 2>$null | Out-Null; $removed = $true
      }
    }

    # The browser extension is deployed BY the agent, so it goes with the agent.
    # Left behind, its force-install policy would keep reinstalling an extension
    # configured to report to a manager this machine no longer talks to.
    try {
      $extId = $null
      $idFile = Join-Path $DATA_DIR 'extension-id.txt'
      if (Test-Path $idFile) { $extId = (Get-Content $idFile -Raw -ErrorAction SilentlyContinue).Trim() }
      if ($extId) { Remove-ExtensionPolicy $extId; Info 'Removed the browser extension policy'; $removed = $true }
    } catch { Warn "Could not remove the browser extension policy: $($_.Exception.Message)" }

    foreach ($d in @($INSTALL_DIR, $DATA_DIR, $LEGACY_DIR, $LEGACY_DATA)) {
      if (Test-Path $d) {
        Info "Deleting $d"
        Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path $d) { Warn "Could not fully delete $d (a file may be locked - reboot and re-run)" } else { $removed = $true }
      }
    }

    try { [Environment]::SetEnvironmentVariable('CYBERSENTINELDLP_SERVER_URL', $null, 'Machine') } catch {}

    Blank
    if ($removed) {
      Ok 'CyberSentinel DLP agent removed from this endpoint.'
      Warn "It will show as 'disconnected' on the dashboard until you delete it there."
    } else { Ok 'Nothing to remove.' }
  }

  # ============================================================
  #  VIEW LOGS
  # ============================================================
  # Colourise a single log line by the severity keyword it carries.
  function Write-LogLine {
    param([string]$Line)
    if ($null -eq $Line) { return }
    $c = 'Gray'
    if     ($Line -match '(?i)\b(error|critical|fatal|exception|traceback)\b')                     { $c = 'Red' }
    elseif ($Line -match '(?i)\b(warn|warning)\b')                                                 { $c = 'Yellow' }
    elseif ($Line -match '(?i)\b(started|running|connected|registered|success|heartbeat)\b')       { $c = 'Green' }
    elseif ($Line -match '(?i)\bdebug\b')                                                          { $c = 'DarkGray' }
    Write-Host "   $Line" -ForegroundColor $c
  }
  function Write-LogLines {
    param($Lines)
    $arr = @($Lines)
    if ($arr.Count -eq 0) { Warn 'No matching lines.'; return }
    foreach ($l in $arr) { Write-LogLine $l }
  }

  # Locate the agent's active log. Default location is next to the EXE
  # (INSTALL_DIR\cybersentineldlp_agent.log); the agent rotates old logs to
  # <log>.<timestamp> in the same folder. Also checks the data-dir logs folder
  # and the legacy layout. Returns the most-recently-written FileInfo, or $null.
  function Resolve-LogFile {
    $cands = New-Object System.Collections.Generic.List[string]
    $cands.Add((Join-Path $INSTALL_DIR $LOG_NAME))
    $cands.Add((Join-Path $LEGACY_DIR  $LOG_NAME))
    foreach ($dir in @($INSTALL_DIR, $LEGACY_DIR, "$DATA_DIR\logs", "$LEGACY_DATA\logs")) {
      if (Test-Path $dir) {
        Get-ChildItem -Path $dir -Filter "$LOG_NAME*" -File -ErrorAction SilentlyContinue |
          ForEach-Object { $cands.Add($_.FullName) }
        Get-ChildItem -Path $dir -Filter '*.log' -File -ErrorAction SilentlyContinue |
          ForEach-Object { $cands.Add($_.FullName) }
      }
    }
    $cands |
      Where-Object { $_ -and (Test-Path $_) } |
      Select-Object -Unique |
      Get-Item -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1
  }

  function Show-Logs {
    Blank
    Header 'AGENT LOGS' 'Cyan'

    $log = Resolve-LogFile
    if (-not $log) {
      Warn 'No log file found yet.'
      Hint "Looked next to the binary ($INSTALL_DIR) and in $DATA_DIR\logs"
      Hint 'The agent creates its log the first time it runs - install/start it, then look here.'
      Blank; Read-Host '   Press Enter to return to the menu' | Out-Null
      return
    }

    $sizeKB = [math]::Round($log.Length / 1KB, 1)
    Hr '-' 'DarkCyan'
    Field 'File'    $log.FullName
    Field 'Size'    "$sizeKB KB"
    Field 'Updated' $log.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')

    while ($true) {
      Blank
      Write-Host '   [1] ' -ForegroundColor Cyan -NoNewline; Write-Host 'Tail last 100 lines'
      Write-Host '   [2] ' -ForegroundColor Cyan -NoNewline; Write-Host 'Follow live         (press any key to stop)'
      Write-Host '   [3] ' -ForegroundColor Cyan -NoNewline; Write-Host 'Errors & warnings only (recent)'
      Write-Host '   [4] ' -ForegroundColor Cyan -NoNewline; Write-Host 'Open in Notepad'
      Write-Host '   [5] ' -ForegroundColor Cyan -NoNewline; Write-Host 'Back to main menu'
      Blank
      $c = Read-Host '   Choose (1-5)'
      switch ($c.Trim()) {
        '1' {
          Blank; Hr '-' 'DarkCyan'
          Write-LogLines (Get-Content -Path $log.FullName -Tail 100 -ErrorAction SilentlyContinue)
          Hr '-' 'DarkCyan'
        }
        '2' {
          Blank; Info 'Following live output - press any key to stop...'; Hr '-' 'DarkCyan'
          try {
            $lines = @(Get-Content -Path $log.FullName -ErrorAction SilentlyContinue)
            $start = [Math]::Max(0, $lines.Count - 20)
            for ($k = $start; $k -lt $lines.Count; $k++) { Write-LogLine $lines[$k] }
            $shown = $lines.Count
            while (-not [Console]::KeyAvailable) {
              Start-Sleep -Milliseconds 600
              $now = @(Get-Content -Path $log.FullName -ErrorAction SilentlyContinue)
              if ($now.Count -gt $shown) {
                for ($k = $shown; $k -lt $now.Count; $k++) { Write-LogLine $now[$k] }
                $shown = $now.Count
              } elseif ($now.Count -lt $shown) {
                $shown = $now.Count   # log rotated / truncated - resync
              }
            }
            $null = [Console]::ReadKey($true)   # consume the key that stopped the follow
          } catch {
            Warn "Live follow not available here ($($_.Exception.Message)) - use [1] or [4] instead."
          }
          Hr '-' 'DarkCyan'; Info 'Stopped following.'
        }
        '3' {
          Blank; Hr '-' 'DarkCyan'
          $lines = Get-Content -Path $log.FullName -Tail 400 -ErrorAction SilentlyContinue |
            Where-Object { $_ -match '(?i)\b(error|critical|fatal|warn|warning|exception|traceback)\b' } |
            Select-Object -Last 200
          if (@($lines).Count -eq 0) { Ok 'No error or warning lines in the recent log.' }
          else { Write-LogLines $lines }
          Hr '-' 'DarkCyan'
        }
        '4' {
          try { Start-Process notepad.exe -ArgumentList "`"$($log.FullName)`""; Ok 'Opened in Notepad.' }
          catch { Err "Could not open Notepad: $($_.Exception.Message)" }
        }
        '5' { return }
        default { Warn 'Enter a number from 1 to 5.' }
      }
    }
  }

  # ============================================================
  #  Browser extension  (force-install via enterprise policy)
  # ============================================================
  #
  # WHY POLICY AND NOT "load unpacked": an unpacked extension can be switched off
  # by the user in two clicks at chrome://extensions, and its id is derived from
  # the folder path so it differs on every machine. A force-installed extension
  # cannot be disabled or removed by the user, updates itself, and has one stable
  # id everywhere. For a DLP control that difference is the whole point.
  #
  # ONE AGENT PER DEVICE: the same policy key also carries this machine's agent
  # id, which the extension reads through chrome.storage.managed. It then reports
  # under the endpoint agent instead of enrolling a second one, so a device
  # running both shows up ONCE on the dashboard with USB, print and browser
  # activity on the same agent.

  $CHROME_POLICY = 'HKLM:\SOFTWARE\Policies\Google\Chrome'
  $EDGE_POLICY   = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge'

  function Get-BrowserPolicyRoots {
    # Both are written unconditionally. Writing the key for a browser that is not
    # installed is harmless, and it means the control is already in place if that
    # browser is installed later — which is exactly the gap a user would drive
    # through otherwise.
    @(
      [PSCustomObject]@{ Name = 'Chrome'; Root = $CHROME_POLICY },
      [PSCustomObject]@{ Name = 'Edge';   Root = $EDGE_POLICY }
    )
  }

  # Normalise whatever we know about the server into the API base, e.g.
  # http://10.0.0.5:55100/api/v1
  function Resolve-ServerApiBase {
    param([string]$Known)
    if ($Known -and $Known -match '/api/v\d+$') { return $Known.TrimEnd('/') }
    if ($Known) {
      try { $u = [Uri]$Known; return "$($u.Scheme)://$($u.Authority)/api/v1" } catch {}
    }
    $ip = Read-Host '   Server IP or hostname'
    if ([string]::IsNullOrWhiteSpace($ip)) { return $null }
    return "http://${ip}:55100/api/v1"
  }

  function Get-ExtensionStatus {
    param([string]$ExtId)
    $out = [PSCustomObject]@{ Forced = @(); Managed = $null; AgentId = $null; ServerUrl = $null }
    foreach ($b in Get-BrowserPolicyRoots) {
      $fl = Join-Path $b.Root 'ExtensionInstallForcelist'
      if (Test-Path $fl) {
        $props = Get-ItemProperty -Path $fl -ErrorAction SilentlyContinue
        foreach ($p in $props.PSObject.Properties) {
          if ($p.Name -like 'PS*') { continue }
          if ($ExtId -and ($p.Value -like "$ExtId;*")) { $out.Forced += $b.Name }
        }
      }
      if ($ExtId) {
        $mp = Join-Path $b.Root "3rdparty\extensions\$ExtId\policy"
        if (Test-Path $mp) {
          $m = Get-ItemProperty -Path $mp -ErrorAction SilentlyContinue
          if ($m.agentId)   { $out.AgentId   = $m.agentId }
          if ($m.serverUrl) { $out.ServerUrl = $m.serverUrl }
          $out.Managed = $b.Name
        }
      }
    }
    $out
  }

  # Write "<id>;<update_url>" into the forcelist, reusing our own slot if we
  # already own one. Blindly appending would leave a stale entry behind on every
  # re-run, and Chrome would then try to install both.
  function Set-ForcelistEntry {
    param([string]$Root, [string]$ExtId, [string]$UpdateUrl)
    $fl = Join-Path $Root 'ExtensionInstallForcelist'
    if (-not (Test-Path $fl)) { New-Item -Path $fl -Force | Out-Null }

    $entry = "$ExtId;$UpdateUrl"
    $props = Get-ItemProperty -Path $fl -ErrorAction SilentlyContinue
    $slot = $null
    $used = @()
    if ($props) {
      foreach ($p in $props.PSObject.Properties) {
        if ($p.Name -like 'PS*') { continue }
        $used += $p.Name
        if ($p.Value -like "$ExtId;*") { $slot = $p.Name }
      }
    }
    if (-not $slot) {
      $n = 1
      while ($used -contains "$n") { $n++ }
      $slot = "$n"
    }
    Set-ItemProperty -Path $fl -Name $slot -Value $entry -Type String
    return $slot
  }

  # Only what an ADMINISTRATOR owns. Enforcement mode and the uninspectable rule
  # are properties of the Web Activity Control policy on the server, not of a
  # per-browser setting — pushing them here would give an endpoint a way to
  # disagree with the policy that is supposed to govern it.
  function Set-ManagedConfig {
    param([string]$Root, [string]$ExtId, [string]$ServerUrl, [string]$AgentId)
    $mp = Join-Path $Root "3rdparty\extensions\$ExtId\policy"
    if (-not (Test-Path $mp)) { New-Item -Path $mp -Force | Out-Null }
    Set-ItemProperty -Path $mp -Name 'serverUrl' -Value $ServerUrl -Type String
    if ($AgentId) { Set-ItemProperty -Path $mp -Name 'agentId' -Value $AgentId -Type String }
    else { Remove-ItemProperty -Path $mp -Name 'agentId' -ErrorAction SilentlyContinue }
  }

  # InPrivate / Incognito coverage.
  #
  # There is NO browser policy that turns an extension on in InPrivate. Chrome
  # and Edge require the user to tick "Allow in InPrivate" per extension, by
  # design, and enterprise policy cannot tick it for them — so a force-installed
  # DLP extension simply does not run there. That is a genuine hole: anything a
  # user does in an InPrivate window is uninspected.
  #
  # The only control that actually closes it is to disable InPrivate browsing,
  # which is a supported policy and a normal posture on a managed endpoint. It is
  # a browser-wide change, not a DLP-only one, so it is asked rather than
  # assumed, and it is trivially reversible (delete the value).
  function Set-InPrivateAvailability {
    param([bool]$Disable)
    foreach ($b in Get-BrowserPolicyRoots) {
      if (-not (Test-Path $b.Root)) { New-Item -Path $b.Root -Force | Out-Null }
      if ($Disable) {
        # 1 = InPrivate/Incognito disabled. 0 = available (the default).
        Set-ItemProperty -Path $b.Root -Name 'IncognitoModeAvailability' -Value 1 -Type DWord
      } else {
        Remove-ItemProperty -Path $b.Root -Name 'IncognitoModeAvailability' -ErrorAction SilentlyContinue
      }
    }
  }

  function Get-InPrivateDisabled {
    foreach ($b in Get-BrowserPolicyRoots) {
      $v = (Get-ItemProperty -Path $b.Root -Name 'IncognitoModeAvailability' -ErrorAction SilentlyContinue).IncognitoModeAvailability
      if ($v -eq 1) { return $true }
    }
    return $false
  }

  # ── Making an update actually happen ──────────────────────────────────
  #
  # Writing the force-install policy does NOT deploy a new build. It tells the
  # browser which extension to keep installed; the browser then checks the update
  # feed on its own schedule — roughly every few hours — so a freshly published
  # version does not appear when you press Deploy, and the whole thing looks
  # broken. chrome://extensions -> Update forces it, but that is a manual step on
  # every endpoint and not something to hand an operator.
  #
  # A force-installed extension is self-healing: if its files are missing at
  # startup, the browser re-downloads it from the update URL. So deleting the
  # cached copy while the browser is closed makes the next launch fetch whatever
  # the server is publishing now. That is deterministic, unlike waiting.
  #
  # Profiles are enumerated across ALL users on the box, not from $env:LOCALAPPDATA:
  # this script self-elevates, so that variable points at the ADMINISTRATOR's
  # profile and would silently miss the extension belonging to the person actually
  # logged in.

  function Get-BrowserProfileDirs {
    $roots = @()
    foreach ($u in (Get-ChildItem 'C:\Users' -Directory -ErrorAction SilentlyContinue)) {
      $roots += Join-Path $u.FullName 'AppData\Local\Google\Chrome\User Data'
      $roots += Join-Path $u.FullName 'AppData\Local\Microsoft\Edge\User Data'
    }
    $profiles = @()
    foreach ($r in $roots) {
      if (-not (Test-Path $r)) { continue }
      $browser = if ($r -match 'Edge') { 'Edge' } else { 'Chrome' }
      foreach ($d in (Get-ChildItem $r -Directory -ErrorAction SilentlyContinue |
                      Where-Object { $_.Name -eq 'Default' -or $_.Name -like 'Profile *' })) {
        $profiles += [PSCustomObject]@{ Browser = $browser; Path = $d.FullName; Name = $d.Name; User = (Split-Path (Split-Path (Split-Path (Split-Path $r -Parent) -Parent) -Parent) -Leaf) }
      }
    }
    $profiles
  }

  # Which version is actually on disk, per profile. This is the honest answer to
  # "did the update land?" — the version is the name of the folder the browser
  # unpacked it into (e.g. "2.1.0_0").
  function Get-InstalledExtensionVersions {
    param([string]$ExtId)
    $found = @()
    foreach ($p in (Get-BrowserProfileDirs)) {
      $dir = Join-Path $p.Path "Extensions\$ExtId"
      if (-not (Test-Path $dir)) { continue }
      foreach ($v in (Get-ChildItem $dir -Directory -ErrorAction SilentlyContinue)) {
        $found += [PSCustomObject]@{
          Browser = $p.Browser; User = $p.User; Profile = $p.Name
          Version = ($v.Name -replace '_\d+$', ''); Path = $v.FullName
        }
      }
    }
    $found
  }

  # Where did the browser get this extension from?
  #
  # THE TRAP THIS EXISTS FOR: manifest.json pins the signing key, so an unpacked
  # "Load unpacked" copy has the SAME extension id as the published build. That is
  # deliberate — you debug the extension you deploy — but it means a leftover
  # unpacked folder from an earlier test occupies the id the policy is trying to
  # fill. The managed build never takes over, and every symptom points somewhere
  # else: the popup, the icon and the settings all come from the stale folder, so
  # publishing a new version changes nothing and looks like the server or the
  # script is broken.
  #
  # Chrome records the origin in each profile's Preferences JSON as a numeric
  # `location` under extensions.settings.<id>. The values that matter here:
  #   1  = installed from a packaged .crx
  #   4  = LOADED UNPACKED  <- the one that shadows everything
  #   10 = installed by enterprise policy (what we want)
  function Get-ExtensionInstallSources {
    param([string]$ExtId)
    $out = @()
    foreach ($p in (Get-BrowserProfileDirs)) {
      foreach ($file in @('Secure Preferences', 'Preferences')) {
        $path = Join-Path $p.Path $file
        if (-not (Test-Path $path)) { continue }
        try {
          $json = Get-Content $path -Raw -ErrorAction Stop | ConvertFrom-Json
          $entry = $json.extensions.settings.$ExtId
          if (-not $entry) { continue }
          $loc = $entry.location
          $label = switch ($loc) {
            1  { 'packaged .crx' }
            4  { 'LOADED UNPACKED' }
            5  { 'component' }
            10 { 'enterprise policy' }
            default { "location $loc" }
          }
          $out += [PSCustomObject]@{
            Browser = $p.Browser; User = $p.User; Profile = $p.Name
            Location = $loc; Label = $label
            Path = $entry.path
            Version = $entry.manifest.version
          }
          break   # one record per profile is enough
        } catch { }
      }
    }
    $out
  }

  function Stop-Browsers {
    $names = @('chrome', 'msedge')
    $running = @()
    foreach ($n in $names) {
      if (Get-Process -Name $n -ErrorAction SilentlyContinue) { $running += $n }
    }
    if ($running.Count -eq 0) { return $true }

    Blank
    Warn "Chrome/Edge must be closed to replace the extension's files."
    $go = Read-Host '   Close them now? (Y/n)'
    if ($go -eq 'n' -or $go -eq 'N') { Warn 'Left running - the refresh was skipped.'; return $false }

    foreach ($n in $running) {
      Info "Closing $n..."
      # Ask politely first so open tabs are restored on next launch.
      Get-Process -Name $n -ErrorAction SilentlyContinue | ForEach-Object {
        $null = $_.CloseMainWindow()
      }
      Start-Sleep -Seconds 2
      Get-Process -Name $n -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2
    return $true
  }

  # Delete the cached copy so the next launch re-downloads the published build.
  function Invoke-ExtensionRefresh {
    param([string]$ExtId, [string]$WantVersion)

    $before = Get-InstalledExtensionVersions $ExtId
    if (@($before).Count -eq 0) {
      Info 'The extension is not installed in any profile yet - nothing to refresh.'
      Hint 'It installs itself the next time a browser starts.'
      return
    }

    $stale = @($before | Where-Object { $_.Version -ne $WantVersion })
    if (@($stale).Count -eq 0) {
      Ok "Every profile already has v$WantVersion."
      return
    }

    Blank
    Warn "$(@($stale).Count) profile(s) are on an older build:"
    foreach ($s in $stale) { Hint "  $($s.Browser) / $($s.User) / $($s.Profile) : v$($s.Version)" }

    if (-not (Stop-Browsers)) { return }

    $removed = 0
    foreach ($s in $before) {
      $extDir = Split-Path $s.Path -Parent
      try {
        Remove-Item $extDir -Recurse -Force -ErrorAction Stop
        $removed++
      } catch {
        Warn "Could not remove $extDir : $($_.Exception.Message)"
      }
    }
    Ok "Cleared the cached extension from $removed profile(s)."
    Hint "Start Chrome/Edge - it re-downloads v$WantVersion from the server within a"
    Hint 'few seconds and re-applies the policy. Nothing else to do.'
  }

  function Remove-ExtensionPolicy {
    param([string]$ExtId)
    foreach ($b in Get-BrowserPolicyRoots) {
      $fl = Join-Path $b.Root 'ExtensionInstallForcelist'
      if (Test-Path $fl) {
        $props = Get-ItemProperty -Path $fl -ErrorAction SilentlyContinue
        foreach ($p in $props.PSObject.Properties) {
          if ($p.Name -like 'PS*') { continue }
          if ($p.Value -like "$ExtId;*") {
            Remove-ItemProperty -Path $fl -Name $p.Name -ErrorAction SilentlyContinue
            Info "$($b.Name): removed forcelist entry $($p.Name)"
          }
        }
      }
      $mp = Join-Path $b.Root "3rdparty\extensions\$ExtId"
      if (Test-Path $mp) {
        Remove-Item $mp -Recurse -Force -ErrorAction SilentlyContinue
        Info "$($b.Name): removed managed configuration"
      }
    }
  }

  function Show-Extension {
    param($Status)
    Blank
    Header 'BROWSER EXTENSION' 'Cyan'

    $apiBase = Resolve-ServerApiBase $Status.ServerUrl
    if (-not $apiBase) { Warn 'No server given - cannot continue.'; Blank; Read-Host '   Press Enter to return' | Out-Null; return }

    # The server is the source of truth for the id, so nobody ever types a
    # 32-character extension id by hand - the single most error-prone step in a
    # force-install, and one that fails completely silently when wrong.
    $info = $null
    $info = Invoke-Spinner -Text 'Asking the DLP server for the published extension' -ArgumentList @($apiBase) -Work {
      param($b)
      try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-RestMethod -Uri "$b/extension/info" -TimeoutSec 10 -ErrorAction Stop
      } catch { $null }
    }

    if (-not $info -or -not $info.extension_id) {
      Err 'The server has not published a browser extension yet.'
      Hint 'On the DLP server run:'
      Hint "  python3 scripts/pack-extension.py --server $($apiBase -replace '/api/v\d+$','')"
      Hint 'then come back here.'
      Blank; Read-Host '   Press Enter to return to the menu' | Out-Null
      return
    }

    $extId     = $info.extension_id
    $updateUrl = "$apiBase/extension/update.xml"
    $st        = Get-ExtensionStatus $extId

    Hr '-' 'DarkCyan'
    Field 'Extension ID' $extId
    Field 'Version'      $info.version
    Field 'Update feed'  $updateUrl
    if ($Status.Installed -and -not $Status.IsLegacy) {
      Hint 'The agent applies this automatically on every policy sync, from its'
      Hint 'own config - so changing the server in agent_config.json and'
      Hint 'restarting the agent moves the extension with it. Use [1] below only'
      Hint 'to apply it right now instead of waiting for the next sync.'
    }
    if (@($st.Forced).Count -gt 0) {
      Field 'Force-installed' ((@($st.Forced) | Select-Object -Unique) -join ', ') 'Green'
    } else {
      Field 'Force-installed' 'no - the extension is not deployed on this device' 'Yellow'
    }
    if ($st.AgentId) { Field 'Reports as' "$($st.AgentId)  (shared with the endpoint agent)" 'Green' }
    $installed = Get-InstalledExtensionVersions $extId
    if (@($installed).Count -gt 0) {
      $vers = (@($installed) | Select-Object -ExpandProperty Version -Unique) -join ', '
      $col = if (@($installed | Where-Object { $_.Version -ne $info.version }).Count -gt 0) { 'Yellow' } else { 'Green' }
      Field 'Installed' "v$vers  in $(@($installed).Count) profile(s)" $col
    } else {
      Field 'Installed' 'not yet - installs on the next browser start' 'Yellow'
    }

    $sources = Get-ExtensionInstallSources $extId
    $unpacked = @($sources | Where-Object { $_.Location -eq 4 })
    if (@($sources).Count -gt 0) {
      $labels = (@($sources) | Select-Object -ExpandProperty Label -Unique) -join ', '
      Field 'Installed via' $labels $(if (@($unpacked).Count -gt 0) { 'Red' } else { 'Green' })
    }
    if (@($unpacked).Count -gt 0) {
      Blank
      Err 'AN UNPACKED COPY IS LOADED, AND IT IS WHAT YOU ARE SEEING.'
      foreach ($u in $unpacked) {
        Hint "  $($u.Browser) / $($u.User) / $($u.Profile)  v$($u.Version)"
        if ($u.Path) { Hint "    from: $($u.Path)" }
      }
      Hint 'It has the same extension id as the published build (the signing key is'
      Hint 'pinned so you debug what you deploy), so it occupies the slot the policy'
      Hint 'is trying to fill. Nothing published will ever take effect until it is'
      Hint 'gone - the popup, the icon and the settings all come from that folder.'
      Blank
      Hint 'FIX: chrome://extensions -> find CyberSentinel DLP -> Remove.'
      Hint '     Then run [1] here again.'
    }
    if (Get-InPrivateDisabled) {
      Field 'InPrivate' 'disabled - no uninspected browsing' 'Green'
    } else {
      Field 'InPrivate' 'available - browsing there is NOT inspected' 'Yellow'
    }

    # Which identity the extension should report under. Without one it enrols
    # separately and this device appears TWICE on the dashboard.
    $agentId = $Status.AgentId
    if (-not $agentId) { $agentId = $st.AgentId }

    while ($true) {
      Blank
      Write-Host '   [1] ' -ForegroundColor Green  -NoNewline; Write-Host 'Deploy / update  - force-install into Chrome and Edge'
      Write-Host '   [2] ' -ForegroundColor Red    -NoNewline; Write-Host 'Remove           - drop the policy (user can then uninstall it)'
      Write-Host '   [3] ' -ForegroundColor Gray   -NoNewline; Write-Host 'Back to main menu'
      Blank
      $c = Read-Host '   Choose (1-3)'
      switch ($c.Trim()) {
        '1' {
          Blank
          if (-not $agentId) {
            Warn 'This device has no known agent id, so the extension would enrol'
            Warn 'as a SEPARATE agent and the device would appear twice on the'
            Warn 'dashboard. Install the agent first ([1] on the main menu), or'
            Warn 'continue and accept two rows.'
            Blank
            $go = Read-Host "   Continue without an agent id? (y/N)"
            if ($go -ne 'y' -and $go -ne 'Y') { continue }
          } else {
            Info "The extension will report as agent '$agentId' - one agent for this device."
          }

          # No policy can enable an extension in InPrivate, so the only way to
          # avoid an uninspected window is to not have one. Asked, not assumed:
          # it affects all browsing, not just DLP.
          if (-not (Get-InPrivateDisabled)) {
            Blank
            Warn 'Extensions do not run in InPrivate/Incognito windows, and no'
            Warn 'policy can change that - so anything done there is invisible to'
            Warn 'DLP. Disabling InPrivate is the only way to close that hole.'
            $ip = Read-Host '   Disable InPrivate browsing on this device? (Y/n)'
            if ($ip -ne 'n' -and $ip -ne 'N') {
              try { Set-InPrivateAvailability $true; Ok 'InPrivate browsing disabled' }
              catch { Err "Could not disable InPrivate: $($_.Exception.Message)" }
            } else {
              Warn 'Left enabled - InPrivate browsing stays uninspected.'
            }
          }

          try {
            foreach ($b in Get-BrowserPolicyRoots) {
              $slot = Set-ForcelistEntry -Root $b.Root -ExtId $extId -UpdateUrl $updateUrl
              Set-ManagedConfig -Root $b.Root -ExtId $extId -ServerUrl $apiBase -AgentId $agentId
              Ok "$($b.Name): force-installed (slot $slot) + configured"
            }
            Blank
            Ok 'Policy written.'

            # Writing the policy is not the same as deploying the build - the
            # browser fetches on its own schedule. Finish the job here rather
            # than leaving someone to wonder why nothing changed.
            Invoke-ExtensionRefresh -ExtId $extId -WantVersion $info.version

            Blank
            Info 'Verify at chrome://extensions - it must show:'
            Hint "    ID       $extId"
            Hint "    Version  $($info.version)"
            Hint '    "Installed by enterprise policy"'
            Hint 'A different ID means the policy points at an extension this'
            Hint 'server does not publish, and it will NEVER update: use [2]'
            Hint 'Remove here, then Deploy again.'
            if (-not $agentId) { Warn 'No agent id was set - this browser will enrol as its own agent.' }
          } catch {
            Err "Could not write the policy: $($_.Exception.Message)"
            Hint 'This needs an ELEVATED PowerShell (Run as administrator).'
          }
          Blank; Read-Host '   Press Enter to continue' | Out-Null
          return
        }
        '2' {
          Blank
          Warn 'This removes the enterprise policy. The extension stops being'
          Warn 'force-installed and the user can then disable or remove it.'
          if ($Status.Installed -and -not $Status.IsLegacy) {
            Blank
            Warn 'NOTE: the agent re-applies this policy on its next sync, so the'
            Warn 'extension will come back within a minute or two. To remove it'
            Warn 'for good, uninstall the agent ([3] on the main menu).'
          }
          Blank
          $confirm = Read-Host "   Type 'y' to confirm (anything else cancels)"
          if ($confirm -eq 'y' -or $confirm -eq 'Y') {
            try { Remove-ExtensionPolicy $extId; Ok 'Policy removed. Restart the browser to apply.' }
            catch { Err "Removal failed: $($_.Exception.Message)" }
          } else { Warn 'Cancelled - no changes made.' }
          Blank; Read-Host '   Press Enter to continue' | Out-Null
          return
        }
        '3' { return }
        default { Warn 'Enter 1, 2, or 3.' }
      }
    }
  }

  # ============================================================
  #  Main menu loop
  # ============================================================
  $first = $true
  while ($true) {
    Clear-Host
    Show-Banner -Animate:$first
    $first = $false

    $s = Get-AgentStatus
    $remoteHash = $null
    if ($s.ExeExists -and $s.ExeHash) {
      $remoteHash = Invoke-Spinner -Text 'Checking for the latest agent build' -ArgumentList @($SUM_URL) -Work {
        param($u)
        try {
          [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
          ((Invoke-WebRequest -Uri $u -UseBasicParsing -ErrorAction Stop).Content).Trim().Split()[0].ToUpper()
        } catch { }
      }
    }
    Show-Status $s $remoteHash

    Blank
    Write-Host '   [1] Install    ' -ForegroundColor Green  -NoNewline; Write-Host '- set up the agent on this device'
    Write-Host '   [2] Update     ' -ForegroundColor Cyan   -NoNewline; Write-Host '- replace the binary with the latest build'
    Write-Host '   [3] Uninstall  ' -ForegroundColor Red    -NoNewline; Write-Host '- stop and completely remove the agent'
    Write-Host '   [4] Logs       ' -ForegroundColor Yellow -NoNewline; Write-Host '- view / follow the agent log file'
    Write-Host '   [5] Extension  ' -ForegroundColor Magenta -NoNewline; Write-Host '- force-install the browser extension (web + AI control)'
    Write-Host '   [6] Exit       ' -ForegroundColor Gray   -NoNewline; Write-Host '- do nothing and quit'
    Blank
    $choice = Read-Host '   Choose an option (1-6)'

    switch ($choice.Trim()) {
      '1' {
        if ($s.Installed -and -not $s.IsLegacy) {
          Blank
          Warn "Agent is already installed (status: $($s.Health))."
          Warn 'No need to install. Use [2] Update to refresh the binary,'
          Warn 'or [3] Uninstall first for a clean reinstall.'
        } else {
          try { Invoke-Install $s } catch { Err "Install failed: $($_.Exception.Message)" }
        }
        Blank; Read-Host '   Press Enter to return to the menu' | Out-Null
      }
      '2' {
        if (-not $s.Installed -or $s.IsLegacy) {
          Blank
          Warn 'No current agent is installed - nothing to update.'
          Warn 'Choose [1] Install to set it up first.'
        } else {
          try { Invoke-Update } catch { Err "Update failed: $($_.Exception.Message)" }
        }
        Blank; Read-Host '   Press Enter to return to the menu' | Out-Null
      }
      '3' {
        if (-not $s.Installed) {
          Blank; Warn 'No CyberSentinel DLP agent found - nothing to uninstall.'
        } else {
          Blank
          Warn 'This STOPS and COMPLETELY REMOVES the agent:'
          Hint '  - kills the running process'
          Hint '  - removes the scheduled task / any legacy service'
          Hint '  - deletes the install and data directories (current + legacy)'
          Blank
          $confirm = Read-Host "   Type 'y' to confirm uninstall (anything else cancels)"
          if ($confirm -eq 'y' -or $confirm -eq 'Y') { try { Uninstall-Agent } catch { Err "Uninstall failed: $($_.Exception.Message)" } }
          else { Warn 'Uninstall cancelled - no changes made.' }
        }
        Blank; Read-Host '   Press Enter to return to the menu' | Out-Null
      }
      '4' {
        try { Show-Logs } catch { Err "Log view failed: $($_.Exception.Message)" }
      }
      '5' {
        try { Show-Extension $s } catch { Err "Extension step failed: $($_.Exception.Message)" }
      }
      '6' { Blank; Info 'Exiting - no changes made.'; return }
      default { Blank; Warn 'Invalid choice - please enter 1, 2, 3, 4, 5, or 6.'; Start-Sleep -Milliseconds 900 }
    }
  }
}
