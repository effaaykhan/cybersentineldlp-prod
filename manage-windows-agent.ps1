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
  # Kept only so an install left by an older build can be cleaned up. Nothing
  # writes this any more - see Step 7.
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
  # The scheduled task, defined in ONE place.
  #
  # It used to be written only by Install. Update replaced the binary and never
  # looked at the task, so a machine whose task was wrong - pointing at the old
  # .vbs launcher, say - had no way to be corrected short of uninstalling. A
  # correct binary with a broken launcher is not an updated agent.
  #
  # Returns $true when the task is registered.
  function Register-AgentTask {
    param([string]$ExePath)
    try {
      if (Get-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TASK_NAME -Confirm:$false
      }
      $action = New-ScheduledTaskAction -Execute $ExePath -Argument '--background' -WorkingDirectory $INSTALL_DIR
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
      return $true
    } catch {
      Err "Could not create scheduled task: $($_.Exception.Message)"
      return $false
    }
  }

  # Is the registered task the one we would write today?
  #
  # The check that matters is that it launches the binary directly. A task still
  # calling wscript.exe against launch_agent.vbs is the state that produced
  # "An Application Control policy has blocked this file" at every logon.
  function Test-AgentTaskCurrent {
    param([string]$ExePath)
    $task = Get-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
    if (-not $task) { return $false }
    foreach ($a in @($task.Actions)) {
      $exe = "$($a.Execute)"
      $arg = "$($a.Arguments)"
      if ($exe -match '(?i)wscript|cscript|powershell|cmd\.exe') { return $false }
      if ($arg -match '(?i)\.vbs') { return $false }
      if ($exe -notmatch '(?i)cybersentineldlp_agent\.exe') { return $false }
    }
    return $true
  }

  function Invoke-Install {
    param($Status)
    $TOTAL = 8
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

    # -- Step 7: scheduled task ----------------------------------------------
    #
    # The task runs the agent DIRECTLY. It used to run
    #   wscript.exe "C:\Program Files\CyberSentinelDLP\launch_agent.vbs"
    # where the .vbs existed only to start the exe with a hidden window.
    #
    # That wrapper was never needed - the agent hides its own console when
    # given --background - and it was actively harmful. Windows blocks script
    # hosts under Application Control, Smart App Control and the ASR rules, so
    # at every logon the machine showed
    #   "An Application Control policy has blocked this file"  (0x800711C7)
    # and the agent never started at all. VBScript is also on its way out of
    # Windows entirely, so the wrapper was going to fail eventually regardless.
    #
    # Nothing in this chain is a script any more, so there is nothing left for
    # a script policy to block.
    Step 7 $TOTAL 'Registering auto-start scheduled task'

    # Any launcher left by an older install is dead weight that Windows will
    # keep complaining about. Take it with us.
    $legacyVbs = Join-Path $INSTALL_DIR $VBS_NAME
    if (Test-Path $legacyVbs) {
      Remove-Item $legacyVbs -Force -ErrorAction SilentlyContinue
      Info 'Removed the old launch_agent.vbs launcher.'
    }

    if (-not (Register-AgentTask -ExePath $exePath)) {
      Hint "You can start it manually: `"$exePath`" --background"
    }

    # -- Step 8: start --------------------------------------------------------
    Step 8 $TOTAL 'Starting the agent'
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

    $binaryCurrent = $false
    if (Test-Path $exePath) {
      $current = (Get-FileHash -Algorithm SHA256 -Path $exePath).Hash.ToUpper()
      if ($current -eq $actual) { $binaryCurrent = $true }
    }

    if ($binaryCurrent) {
      # NOT a reason to stop.
      #
      # This used to say "already up to date - nothing to do" and return, which
      # made Update a synonym for "replace the exe". An installation is a
      # binary, a config, a scheduled task and a set of browser policies, and
      # any of them can be wrong while the exe is perfectly current - which is
      # exactly the state a machine was left in when the task still pointed at
      # the blocked .vbs launcher. There was then no menu item that could fix
      # it: Install refuses because the agent is installed, and Update refused
      # because the binary matched.
      Remove-Item $tmpExe -Force -ErrorAction SilentlyContinue
      Ok 'Binary is already the published build.'
      Invoke-AgentReconcile -ExePath $exePath
      return
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

    Invoke-AgentReconcile -ExePath $exePath -SkipStart
    Info 'Restarting the agent...'
    Start-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
    # Same patience as the install path (6 x 2s), not a single 3s look.
    # Start-ScheduledTask returns as soon as the task is queued, not when the
    # process exists, so one early check reported "agent not detected" for an
    # agent that was starting perfectly well and heartbeating seconds later.
    # Crying wolf on a routine update is worse than waiting another 9 seconds:
    # it trains you to ignore the one time it means something.
    $proc = $null
    for ($i = 0; $i -lt 6 -and -not $proc; $i++) {
      Start-Sleep -Seconds 2
      $proc = Get-Process -Name $PROC_NAME -ErrorAction SilentlyContinue | Select-Object -First 1
    }
    Blank
    if ($proc) { Ok "Update complete - agent running (PID $($proc.Id))." }
    else { Warn "Agent not detected yet - start it with: Start-ScheduledTask -TaskName '$TASK_NAME'" }
  }

  # Everything an installation is, apart from the binary.
  #
  # Run on every Update so a machine converges on a correct install rather than
  # only ever having its exe swapped. Each check states what it found, because
  # "nothing needed fixing" and "I did not look" are the same output otherwise -
  # and that ambiguity is what let a broken launcher survive.
  function Invoke-AgentReconcile {
    param([string]$ExePath, [switch]$SkipStart)
    Blank
    Info 'Checking the rest of the installation...'

    # A launcher from an older build. Windows blocks it under Application
    # Control, so leaving it costs an error dialog at every logon.
    $legacyVbs = Join-Path $INSTALL_DIR $VBS_NAME
    if (Test-Path $legacyVbs) {
      Remove-Item $legacyVbs -Force -ErrorAction SilentlyContinue
      Ok 'Removed the old launch_agent.vbs launcher.'
    }

    if (Test-AgentTaskCurrent -ExePath $ExePath) {
      Ok 'Scheduled task is correct.'
    } else {
      Warn 'Scheduled task is missing or launches the agent the old way - rewriting it.'
      $null = Register-AgentTask -ExePath $ExePath
    }

    $configPath = Join-Path $INSTALL_DIR $CONFIG_NAME
    if (Test-Path $configPath) { Ok 'Configuration present.' }
    else { Warn "No $CONFIG_NAME - run [1] Install to write one." }

    if (-not $SkipStart) {
      $proc = Get-Process -Name $PROC_NAME -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($proc) {
        Ok "Agent is running (PID $($proc.Id))."
      } else {
        Info 'Agent is not running - starting it.'
        Start-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 3
        $proc = Get-Process -Name $PROC_NAME -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($proc) { Ok "Agent started (PID $($proc.Id))." }
        else { Warn "Agent did not start - check [4] Logs." }
      }
    }
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
      # The id comes from the FORCELIST first, and the agent's file second.
      #
      # extension-id.txt is only written once the agent has run, so an endpoint
      # where the extension was deployed from [5] but the agent never started
      # had no file — and the force-install policy survived the uninstall,
      # quietly reinstalling an extension pointed at a manager this machine no
      # longer talks to. The registry entry is the thing actually doing that, so
      # it is the honest place to read it from.
      $extIds = @()
      foreach ($b in $BROWSERS) {
        $fl = Join-Path $b.Root 'ExtensionInstallForcelist'
        if (-not (Test-Path $fl)) { continue }
        $props = Get-ItemProperty -Path $fl -ErrorAction SilentlyContinue
        foreach ($pr in $props.PSObject.Properties) {
          if ($pr.Name -like 'PS*') { continue }
          $id = ("$($pr.Value)" -split ';')[0]
          if ($id -match '^[a-p]{32}$') { $extIds += $id }
        }
      }
      $idFile = Join-Path $DATA_DIR 'extension-id.txt'
      if (Test-Path $idFile) {
        $fromFile = (Get-Content $idFile -Raw -ErrorAction SilentlyContinue).Trim()
        if ($fromFile) { $extIds += $fromFile }
      }
      foreach ($id in ($extIds | Select-Object -Unique)) {
        Remove-ExtensionPolicy $id
        Info "Removed the browser extension policy ($id)"
        $removed = $true
      }
      if (@($extIds).Count -eq 0) { Info 'No browser extension policy was present.' }
    } catch { Warn "Could not remove the browser extension policy: $($_.Exception.Message)" }

    # Private browsing was disabled BY this agent's deployment, so it goes with
    # it. Leaving it behind means a machine with no DLP on it still cannot open
    # an Incognito or InPrivate window, with nothing installed to explain why
    # and no menu item left that could undo it.
    try {
      $restored = @()
      foreach ($b in $BROWSERS) {
        if (-not (Test-Path $b.Root)) { continue }
        $cur = (Get-ItemProperty -Path $b.Root -Name $b.PrivateValue -ErrorAction SilentlyContinue).$($b.PrivateValue)
        if ($null -ne $cur) {
          Remove-ItemProperty -Path $b.Root -Name $b.PrivateValue -ErrorAction SilentlyContinue
          $restored += "$($b.Name) $($b.PrivateLabel)"
          $removed = $true
        }
      }
      if (@($restored).Count -gt 0) {
        Info "Re-allowed private browsing: $($restored -join ', ')"
      } else {
        Info 'Private browsing was not restricted by this agent.'
      }
    } catch { Warn "Could not restore private browsing: $($_.Exception.Message)" }

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

  # ── Browsers ──────────────────────────────────────────────────────────
  #
  # One table, one place. Everything else — force-install, managed config,
  # private browsing, removal — reads from here, so a browser can never be
  # half-handled by one function and missed by another.
  #
  # THE VALUE NAMES ARE NOT INTERCHANGEABLE. Chrome reads
  # IncognitoModeAvailability; Edge reads InPrivateModeAvailability. Writing
  # Chrome's name into Edge's key does nothing whatsoever, and reads back looking
  # exactly like success — which is how Edge stayed open while the screen said it
  # was closed.
  $BROWSERS = @(
    [PSCustomObject]@{
      Name         = 'Chrome'
      Root         = 'HKLM:\SOFTWARE\Policies\Google\Chrome'
      Process      = 'chrome'
      Exe          = 'chrome.exe'
      PrivateValue = 'IncognitoModeAvailability'
      PrivateLabel = 'Incognito'
    },
    [PSCustomObject]@{
      Name         = 'Edge'
      Root         = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge'
      Process      = 'msedge'
      Exe          = 'msedge.exe'
      PrivateValue = 'InPrivateModeAvailability'
      PrivateLabel = 'InPrivate'
    }
  )

  # Is this browser actually on the box?
  #
  # Used for REPORTING, never to decide whether to write policy. Policy is always
  # written for both: a machine with no Chrome today gets Chrome fully managed the
  # moment someone installs it, extension and all, with nobody revisiting the
  # endpoint. That pre-staging is the useful behaviour — claiming the browser is
  # "configured" when it is not installed is the misleading part, and that is what
  # this fixes.
  function Test-BrowserInstalled {
    param($Browser)
    foreach ($view in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths',
                        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths')) {
      $k = Join-Path $view $Browser.Exe
      if (Test-Path $k) {
        $p = (Get-ItemProperty -Path $k -ErrorAction SilentlyContinue).'(default)'
        if ($p -and (Test-Path $p)) { return $p }
      }
    }
    $candidates = @()
    if ($Browser.Name -eq 'Chrome') {
      $candidates += "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
      $candidates += "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
      # Chrome installs per-user without admin rights, so a machine-wide check
      # alone reports "not installed" for a browser somebody is using right now.
      foreach ($u in (Get-ChildItem 'C:\Users' -Directory -ErrorAction SilentlyContinue)) {
        $candidates += Join-Path $u.FullName 'AppData\Local\Google\Chrome\Application\chrome.exe'
      }
    } else {
      $candidates += "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
      $candidates += "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
    }
    foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
    return $null
  }

  # The browsers plus everything currently true about them. One call, one answer,
  # read back from the registry rather than assumed from what we tried to write.
  function Get-Browsers {
    foreach ($b in $BROWSERS) {
      $path = Test-BrowserInstalled $b
      $priv = $null
      if (Test-Path $b.Root) {
        $priv = (Get-ItemProperty -Path $b.Root -Name $b.PrivateValue -ErrorAction SilentlyContinue).$($b.PrivateValue)
      }
      [PSCustomObject]@{
        Name            = $b.Name
        Root            = $b.Root
        Process         = $b.Process
        PrivateValue    = $b.PrivateValue
        PrivateLabel    = $b.PrivateLabel
        Installed       = [bool]$path
        ExePath         = $path
        Running         = [bool](Get-Process -Name $b.Process -ErrorAction SilentlyContinue)
        PrivateDisabled = ($priv -eq 1)
        PrivateRaw      = $priv
      }
    }
  }

  # Set private browsing and VERIFY it, per browser. Returns what is actually
  # true afterwards, not what we intended.
  function Set-PrivateBrowsing {
    param([bool]$Disable)
    $results = @()
    foreach ($b in $BROWSERS) {
      $err = $null
      try {
        if (-not (Test-Path $b.Root)) { New-Item -Path $b.Root -Force | Out-Null }
        if ($Disable) {
          # 1 = disabled, 0 = available (the default), 2 = forced.
          Set-ItemProperty -Path $b.Root -Name $b.PrivateValue -Value 1 -Type DWord -ErrorAction Stop
        } else {
          Remove-ItemProperty -Path $b.Root -Name $b.PrivateValue -ErrorAction SilentlyContinue
        }
        # An earlier build wrote Chrome's value name under BOTH roots. Inert
        # under Edge, but it reads back as coverage that never existed.
        if ($b.Name -eq 'Edge') {
          Remove-ItemProperty -Path $b.Root -Name 'IncognitoModeAvailability' -ErrorAction SilentlyContinue
        }
      } catch { $err = $_.Exception.Message }

      # Read it back. "I called Set-ItemProperty" is not evidence.
      $now = $null
      if (Test-Path $b.Root) {
        $now = (Get-ItemProperty -Path $b.Root -Name $b.PrivateValue -ErrorAction SilentlyContinue).$($b.PrivateValue)
      }
      $want = if ($Disable) { 1 } else { $null }
      $results += [PSCustomObject]@{
        Name = $b.Name; Label = $b.PrivateLabel
        Applied = ($now -eq $want); Value = $now; Error = $err
      }
    }
    $results
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
    foreach ($b in $BROWSERS) {
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

  # THE LEVER THAT ACTUALLY FORCES AN UPDATE.
  #
  # ExtensionInstallForcelist only says "this extension must be PRESENT". Once it
  # is present the browser has exactly what it was asked for, and picks up new
  # versions on its own multi-hour schedule. That is why every attempt to make it
  # update now has failed - restarting, and withdrawing/restoring the entry, were
  # both trying to provoke a decision the browser had no reason to revisit.
  #
  # ExtensionSettings carries minimum_version_required. Telling the browser the
  # installed copy is TOO OLD is a statement it has to act on: it disables the
  # extension and updates it from update_url. Documented and supported rather
  # than a trick, it needs no restart, and - unlike withdrawing the forcelist
  # entry - it never leaves the endpoint without the extension even briefly.
  #
  # Stored as one JSON string under the browser's policy root. The policy is a
  # dictionary keyed by extension id, so any entry for a DIFFERENT extension is
  # read back and preserved; overwriting the value wholesale would silently drop
  # rules this script did not write.
  function Set-ExtensionSettingsPolicy {
    param([string]$Root, [string]$ExtId, [string]$UpdateUrl, [string]$MinVersion)

    $merged = @{}
    try {
      $raw = (Get-ItemProperty -Path $Root -Name 'ExtensionSettings' -ErrorAction SilentlyContinue).ExtensionSettings
      if ($raw) {
        foreach ($prop in ($raw | ConvertFrom-Json).PSObject.Properties) { $merged[$prop.Name] = $prop.Value }
      }
    } catch { $merged = @{} }

    $entry = @{
      installation_mode = 'force_installed'
      update_url        = $UpdateUrl
    }
    if ($MinVersion) { $entry['minimum_version_required'] = $MinVersion }
    $merged[$ExtId] = $entry

    if (-not (Test-Path $Root)) { New-Item -Path $Root -Force | Out-Null }
    # -Depth matters: the default of 2 would flatten our nested entry to the
    # string "System.Collections.Hashtable" and the policy would be ignored.
    Set-ItemProperty -Path $Root -Name 'ExtensionSettings' `
                     -Value ($merged | ConvertTo-Json -Depth 10 -Compress) -Type String
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

  # Per browser, never collapsed to a single yes/no. Reporting "disabled" because
  # ONE browser is covered is how Edge stayed wide open while the screen said the
  # hole was closed.

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
  #   7  = EXTERNAL_POLICY_DOWNLOAD - installed by ExtensionInstallForcelist,
  #        which is what a healthy managed endpoint reports. This was previously
  #        documented (and coded) as 10, so the ONE value that means "working"
  #        fell through to the default branch and printed a bare "location 7" -
  #        a correct install rendered as something unrecognised.
  #   9  = EXTERNAL_POLICY (policy, but not via an update URL)
  #   10 = EXTERNAL_COMPONENT - not policy at all
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
          $label = if ($null -eq $loc -or "$loc" -eq '') { 'recorded, origin unknown' }
                   else {
                     switch ($loc) {
                       1  { 'packaged .crx' }
                       2  { 'external pref' }
                       3  { 'external registry' }
                       4  { 'LOADED UNPACKED' }
                       5  { 'component' }
                       6  { 'external pref download' }
                       7  { 'enterprise policy' }
                       8  { 'command line' }
                       9  { 'enterprise policy (local)' }
                       10 { 'external component' }
                       default { "location $loc" }
                     }
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

    # Verify, rather than assume.
    #
    # This used to sleep two seconds and return $true no matter what happened.
    # The caller takes that as permission to delete the extension's files, so a
    # browser that did not actually exit - a hung renderer, a process an updater
    # restarted, a profile still being flushed - meant deleting a directory
    # Chrome still had open. Windows then removes what it can and fails on the
    # rest, which leaves a HALF an extension on disk: no icon, no popup, and a
    # manifest still there for Chrome to load. That is the "the logo is gone and
    # clicking it says file not found" state, and nothing in the script noticed.
    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $deadline) {
      $still = @()
      foreach ($n in $names) {
        if (Get-Process -Name $n -ErrorAction SilentlyContinue) { $still += $n }
      }
      if ($still.Count -eq 0) {
        # File handles can outlive the process by a moment.
        Start-Sleep -Milliseconds 800
        return $true
      }
      Start-Sleep -Milliseconds 500
    }

    Err "$($still -join ' and ') is still running after 15s - not touching the extension."
    Hint 'Close every window (including any background instance from the tray),'
    Hint 'then run this again. Refusing here is deliberate: deleting files from'
    Hint 'under a running browser is what leaves the extension half-installed.'
    return $false
  }

  # Is a browser actually OPEN?
  #
  # Not the same question as "is there a process called msedge". Edge keeps
  # background processes alive after every window is closed (startup boost,
  # extension service workers, the WebView host), and Chrome does the same when
  # background apps are enabled. Asking Get-Process alone reports a browser that
  # is running when the machine's owner would tell you it is shut.
  #
  # That is not a detail: it decided which branch the update took, so a script
  # run on a machine with no browser open announced "Working with: Edge - leave
  # the window open" and then waited for a window that was never there.
  #
  # A visible main window is the honest test.
  function Get-OpenBrowsers {
    $open = @()
    foreach ($b in $BROWSERS) {
      $procs = @(Get-Process -Name $b.Process -ErrorAction SilentlyContinue |
                 Where-Object { $_.MainWindowHandle -ne 0 })
      if (@($procs).Count -gt 0) { $open += $b.Name }
    }
    $open
  }

  # Wait for the published version to land, reporting as it goes.
  # ``Browsers`` limits the check to the browsers we actually acted on. Without
  # it, one closed browser holding an old copy makes the wait unsatisfiable:
  # it can never update while it is not running, so waiting for EVERY profile
  # means waiting for something that cannot happen, then reporting failure.
  function Wait-ForExtensionVersion {
    param([string]$ExtId, [string]$Version, [int]$TimeoutSeconds = 300, [string[]]$Browsers)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $spin = @('|', '/', '-', '\')
    $i = 0
    while ((Get-Date) -lt $deadline) {
      $found = @(Get-InstalledExtensionVersions $ExtId)
      if ($Browsers) { $found = @($found | Where-Object { $Browsers -contains $_.Browser }) }
      if (@($found).Count -gt 0) {
        $stale = @($found | Where-Object { $_.Version -ne $Version })
        if (@($stale).Count -eq 0) { Write-Host ("`r" + (' ' * 60) + "`r") -NoNewline; return $true }
      }
      $left = [int]($deadline - (Get-Date)).TotalSeconds
      Write-Host ("`r   {0} waiting for the browser to fetch v{1}  ({2}s left)   " -f $spin[$i % 4], $Version, $left) -NoNewline
      $i++
      Start-Sleep -Milliseconds 800
    }
    Write-Host ("`r" + (' ' * 60) + "`r") -NoNewline
    return $false
  }

  # Bring this machine onto the published build.
  #
  # THREE ATTEMPTS AT THIS, AND WHAT THEY TAUGHT:
  #
  #   Deleting <Profile>\Extensions\<id>\ breaks it. The browser's record of an
  #   extension lives in the profile's Preferences, not with the files, so the
  #   delete leaves it listing an extension it cannot load and it will not
  #   re-fetch for hours.
  #
  #   Toggling the forcelist entry while the browser runs WORKS. It was dropped
  #   only because it had been made the single path, so a closed browser fell
  #   into a branch that could not finish. That was a dispatch bug, not a
  #   verdict on the mechanism.
  #
  #   "The browser fetches updates when it starts" - which replaced it - is
  #   simply not true, and is why this kept hanging for five minutes and giving
  #   up. Chrome and Edge check the extension update feed on a TIMER (a few
  #   hours), delayed and jittered after launch. Restarting does not schedule
  #   that check any sooner, so "close it and open it again" was asking the
  #   operator to perform a ritual with no effect.
  #
  # So: branch on what the browser is actually doing.
  #
  #   RUNNING -> round-trip the forcelist entry. Both browsers apply
  #     ExtensionInstallForcelist changes live. Removing the entry makes the
  #     BROWSER uninstall the extension itself - which keeps its Preferences
  #     record consistent, the exact thing that deleting Extensions\<id>\ got
  #     wrong - and putting the entry back makes it install whatever the feed
  #     advertises right now. No restart, no files touched, seconds not hours.
  #
  #   CLOSED -> there is nothing to toggle and nothing to wait for: the policy
  #     already names the new version, so the next start installs it. Say that
  #     and stop, rather than watching a browser that will never open.
  #
  # The removal is wrapped so the entry is ALWAYS put back, including on Ctrl-C.
  # An interrupted update must not be able to leave the endpoint unmanaged.
  function Invoke-ExtensionUpdate {
    param([string]$ExtId, [string]$WantVersion, [string]$UpdateUrl)

    $open = @(Get-OpenBrowsers)

    if (@($open).Count -eq 0) {
      Blank
      Hr '-' 'DarkCyan'
      Ok 'Policy is set to the new version. Nothing else to do here.'
      Hint "$($BROWSERS.Name -join ' and ') are closed, so there is nothing to update"
      Hint 'in place. The next time one starts it installs the published build'
      Hint "directly - it never sees the old one."
      Hr '-' 'DarkCyan'
      Blank
      return $true
    }

    # --- Tell the browser the installed copy is too old ---------------------
    # No withdrawing, no restoring, no window where the endpoint is unprotected.
    # minimum_version_required is an instruction the browser must act on, and it
    # applies live.
    Blank
    Info "Requiring v$WantVersion on $($open -join ' and ') - no restart needed."
    try {
      foreach ($b in $BROWSERS) {
        Set-ExtensionSettingsPolicy -Root $b.Root -ExtId $ExtId -UpdateUrl $UpdateUrl -MinVersion $WantVersion
        Info "$($b.Name): minimum version set to $WantVersion"
      }
    } catch {
      Err "Could not write the ExtensionSettings policy: $($_.Exception.Message)"
      return $false
    }

    Blank
    Info 'Watching for it to land - this window can be left alone.'

    if (Wait-ForExtensionVersion -ExtId $ExtId -Version $WantVersion -TimeoutSeconds 180 -Browsers $open) {
      Blank
      Ok "$($open -join ' and ') on v$WantVersion."
      $shut = @($BROWSERS.Name | Where-Object { $open -notcontains $_ })
      if (@($shut).Count -gt 0) {
        Hint "$($shut -join ' and ') not running - will install v$WantVersion on next start."
      }
      return $true
    }

    $now = @(Get-InstalledExtensionVersions $ExtId)
    Blank
    if (@($now).Count -eq 0) {
      Warn 'The extension is not on disk in any profile.'
      Hint 'If the browser has been started since, it cannot reach the feed:'
      Hint "  $UpdateUrl"
      Hint 'Try that URL in the browser itself - it should return XML naming'
      Hint "version $WantVersion."
    } else {
      $stuck = @($now | Where-Object { $open -contains $_.Browser -and $_.Version -ne $WantVersion })
      $later = @($now | Where-Object { $open -notcontains $_.Browser -and $_.Version -ne $WantVersion })
      if (@($later).Count -gt 0) {
        foreach ($n in $later) { Hint "  $($n.Browser) / $($n.User) / $($n.Profile) : v$($n.Version) - not running, installs on next start" }
      }
      if (@($stuck).Count -eq 0) {
        Blank
        Ok 'Nothing is stuck - every running browser is up to date.'
        return $true
      }
      Warn "Still not on v${WantVersion}:"
      foreach ($n in $stuck) { Hint "  $($n.Browser) / $($n.User) / $($n.Profile) : v$($n.Version)" }
      Blank
      Hint 'The policy is correct and nothing is broken. The browser accepted the'
      Hint 'entry but has not finished installing yet.'
      Blank
      Hint 'The one trigger that is always immediate belongs to the browser:'
      Hint '  open chrome://extensions (or edge://extensions),'
      Hint '  turn on Developer mode, press Update.'
      Blank
      Hint 'Closing the browser also works - the next start installs the published'
      Hint 'build directly. (Starting it does NOT schedule an update check any'
      Hint 'sooner; that is on a multi-hour timer of its own.)'
      Blank
      Hint 'If it stays on the old version after that, use [3] Repair.'
    }
    return $false
  }

  # For a browser whose RECORD of the extension is wrong.
  #
  # Restarting cannot fix that: the browser believes the extension is installed
  # and never re-fetches it. The symptoms are an extension listed with no icon,
  # a popup that says the file was not found, or a version that will not move no
  # matter how often the policy is written.
  #
  # The only thing that clears the record is the browser's own uninstall, and
  # the only way to ask for that from outside is to stop force-installing it and
  # let the browser act on that. Hence two starts. This is a recovery path, not
  # the way updates normally happen - [1] handles those with a single restart.
  function Invoke-ExtensionRepair {
    param(
      [string]$ExtId, [string]$UpdateUrl, [string]$ApiBase,
      [string]$AgentId, [string]$WantVersion
    )

    Blank
    Info 'Repair is for a browser that lists the extension but cannot load it -'
    Info 'no icon, or a popup that says the file was not found. It clears the'
    Info "browser's own record of it, which a restart alone will not do."
    Blank
    Warn 'It needs the browser opened and closed twice.'
    Blank
    $go = Read-Host '   Repair now? (y/N)'
    if ($go -ne 'y' -and $go -ne 'Y') { Warn 'Cancelled - nothing changed.'; return }

    # ── 1. stop force-installing it ───────────────────────────────────────
    try {
      Remove-ExtensionPolicy $ExtId
      Ok 'Force-install policy withdrawn.'
    } catch {
      Err "Could not remove the policy: $($_.Exception.Message)"
      Hint 'This needs an ELEVATED PowerShell (Run as administrator).'
      return
    }

    Blank
    Hr '-' 'DarkCyan'
    Warn 'STEP 1 of 2: open the browser, wait for the window, then close it.'
    Hint 'That start is what makes it uninstall the extension and forget it.'
    Hr '-' 'DarkCyan'
    Blank
    Read-Host '   Press Enter once you have done that' | Out-Null

    # ── 2. check the browser really did forget it ─────────────────────────
    $left = @(Get-InstalledExtensionVersions $ExtId)
    if (@($left).Count -gt 0) {
      Blank
      Err 'The browser has not uninstalled it.'
      foreach ($l in $left) { Hint "  still present: $($l.Browser) / $($l.User) / $($l.Profile) : v$($l.Version)" }
      Blank
      Hint 'Either it was not started, or it was started as a different Windows'
      Hint 'user than the profiles listed above.'
      Blank
      Warn 'Putting the policy back - the extension is unchanged.'
      try {
        foreach ($b in $BROWSERS) {
          $null = Set-ForcelistEntry -Root $b.Root -ExtId $ExtId -UpdateUrl $UpdateUrl
          Set-ExtensionSettingsPolicy -Root $b.Root -ExtId $ExtId -UpdateUrl $UpdateUrl -MinVersion $WantVersion
          Set-ManagedConfig -Root $b.Root -ExtId $ExtId -ServerUrl $ApiBase -AgentId $AgentId
        }
        Ok 'Policy restored.'
      } catch { Err "Could not restore the policy: $($_.Exception.Message)" }
      return
    }
    Ok 'The browser uninstalled it and cleared its record.'

    # ── 3. force it again ─────────────────────────────────────────────────
    try {
      foreach ($b in $BROWSERS) {
        $null = Set-ForcelistEntry -Root $b.Root -ExtId $ExtId -UpdateUrl $UpdateUrl
        Set-ExtensionSettingsPolicy -Root $b.Root -ExtId $ExtId -UpdateUrl $UpdateUrl -MinVersion $WantVersion
        Set-ManagedConfig -Root $b.Root -ExtId $ExtId -ServerUrl $ApiBase -AgentId $AgentId
        Ok "$($b.Name): force-install restored (minimum v$WantVersion) + configured"
      }
    } catch {
      Err "Could not restore the policy: $($_.Exception.Message)"
      Hint 'Run [1] Deploy to put it back.'
      return
    }

    Blank
    Hr '-' 'DarkCyan'
    Warn "STEP 2 of 2: open the browser again. It installs v$WantVersion fresh."
    Hr '-' 'DarkCyan'
    Blank
    Info 'Watching for it to land.'
    if (Wait-ForExtensionVersion -ExtId $ExtId -Version $WantVersion -TimeoutSeconds 300) {
      Blank
      Ok "Repaired - every profile is on v$WantVersion."
      Hint 'chrome://extensions should show that version, an icon, and'
      Hint '"Installed by enterprise policy".'
      return
    }

    Blank
    Warn "It has not appeared as v$WantVersion yet."
    Hint 'The policy IS in place, so it will arrive once the browser fetches it.'
    Hint 'If it does not, the browser cannot reach the update feed:'
    Hint "  $UpdateUrl"
  }

  # Asked on EVERY deploy, whatever the current state.
  #
  # Not conditional on private browsing still being open: a deploy is the moment
  # someone is looking at this machine's coverage, and silently skipping the
  # question because it happened to be handled last time hides the one blind spot
  # the extension cannot cover. Three explicit choices, and Enter changes
  # nothing — so it is a confirmation, not a trap.
  function Invoke-PrivateBrowsingPrompt {
    Blank
    Info 'Private browsing:'
    foreach ($b in (Get-Browsers)) {
      $where = ''
      if (-not $b.Installed) { $where = '  (not installed)' }
      if ($b.PrivateDisabled) { Ok "  $($b.Name) $($b.PrivateLabel): disabled$where" }
      else { Warn "  $($b.Name) $($b.PrivateLabel): available - NOT inspected$where" }
    }
    Hint 'Extensions cannot run in a private window and no policy can change that,'
    Hint 'so disabling it is the only way to remove that blind spot.'
    Blank
    $want = Read-Host '   [d] disable everywhere   [a] allow everywhere   [Enter] leave as is'
    if ($want -eq 'd' -or $want -eq 'D') {
      Blank
      # Report what the registry says AFTERWARDS. "I called Set-ItemProperty" is
      # not evidence, and it was not evidence for Edge.
      foreach ($r in (Set-PrivateBrowsing $true)) {
        if ($r.Applied) {
          Ok "$($r.Name) $($r.Label) disabled"
        } else {
          $why = ''
          if ($r.Error) { $why = " - $($r.Error)" }
          Err "$($r.Name) $($r.Label) NOT disabled$why"
        }
      }
      $running = @(Get-Browsers | Where-Object { $_.Running })
      if (@($running).Count -gt 0) {
        Blank
        Warn 'A browser is running and keeps allowing private windows until it'
        Warn 'restarts - the policy is only read at startup.'
        foreach ($r in $running) { Hint "  running: $($r.Name)" }
        $c = Read-Host '   Close it now so this takes effect? (Y/n)'
        if ($c -ne 'n' -and $c -ne 'N') { $null = Stop-Browsers }
      } else {
        Hint 'Takes effect the next time the browser starts.'
      }
    } elseif ($want -eq 'a' -or $want -eq 'A') {
      foreach ($r in (Set-PrivateBrowsing $false)) {
        if ($r.Applied) {
          Ok "$($r.Name) $($r.Label) allowed again"
        } else {
          $why = ''
          if ($r.Error) { $why = " - $($r.Error)" }
          Err "$($r.Name): could not clear the policy$why"
        }
      }
      Warn 'Anything done in a private window is not inspected.'
    } else {
      Info 'Left unchanged.'
    }
  }

  function Remove-ExtensionPolicy {
    param([string]$ExtId)
    foreach ($b in $BROWSERS) {
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
      # ExtensionSettings must go too. It carries installation_mode
      # force_installed independently of the forcelist, so dropping only the
      # forcelist entry would leave the extension pinned and un-removable -
      # Remove would report success and change nothing. Only OUR key is
      # deleted; entries for other extensions are written back.
      try {
        $raw = (Get-ItemProperty -Path $b.Root -Name 'ExtensionSettings' -ErrorAction SilentlyContinue).ExtensionSettings
        if ($raw) {
          $keep = @{}
          foreach ($prop in ($raw | ConvertFrom-Json).PSObject.Properties) {
            if ($prop.Name -ne $ExtId) { $keep[$prop.Name] = $prop.Value }
          }
          if ($keep.Count -gt 0) {
            Set-ItemProperty -Path $b.Root -Name 'ExtensionSettings' `
                             -Value ($keep | ConvertTo-Json -Depth 10 -Compress) -Type String
          } else {
            Remove-ItemProperty -Path $b.Root -Name 'ExtensionSettings' -ErrorAction SilentlyContinue
          }
          Info "$($b.Name): removed ExtensionSettings entry"
        }
      } catch { Warn "$($b.Name): could not clean ExtensionSettings - $($_.Exception.Message)" }

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
    foreach ($b in (Get-Browsers)) {
      if (-not $b.Installed) {
        # Policy IS written for it, and that is deliberate: install Chrome
        # tomorrow and it arrives already managed. Calling that "configured"
        # would be a lie; saying nothing would hide that it is already handled.
        Field $b.Name 'not installed - policy pre-staged, applies if installed' 'DarkGray'
        continue
      }
      $forced = (@($st.Forced) -contains $b.Name)
      $bits = @()
      if ($forced) { $bits += 'extension forced' } else { $bits += 'extension NOT forced' }
      if ($b.PrivateDisabled) { $bits += "$($b.PrivateLabel) disabled" }
      else { $bits += "$($b.PrivateLabel) AVAILABLE - not inspected" }
      $col = 'Yellow'
      if ($forced -and $b.PrivateDisabled) { $col = 'Green' }
      Field $b.Name ($bits -join '; ') $col
    }

    # Which identity the extension should report under. Without one it enrols
    # separately and this device appears TWICE on the dashboard.
    $agentId = $Status.AgentId
    if (-not $agentId) { $agentId = $st.AgentId }

    while ($true) {
      Blank
      Write-Host '   [1] ' -ForegroundColor Green   -NoNewline; Write-Host 'Deploy / update  - force-install into Chrome and Edge'
      Write-Host '   [2] ' -ForegroundColor Magenta -NoNewline; Write-Host 'Private browsing - disable it, or allow it again'
      Write-Host '   [3] ' -ForegroundColor Yellow  -NoNewline; Write-Host 'Repair           - no icon / "file not found" / stuck on an old build'
      Write-Host '   [4] ' -ForegroundColor Red     -NoNewline; Write-Host 'Remove           - drop the policy (user can then uninstall it)'
      Write-Host '   [5] ' -ForegroundColor Gray    -NoNewline; Write-Host 'Back to main menu'
      Blank
      $c = Read-Host '   Choose (1-5)'
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

          Invoke-PrivateBrowsingPrompt

          try {
            foreach ($b in $BROWSERS) {
              $slot = Set-ForcelistEntry -Root $b.Root -ExtId $extId -UpdateUrl $updateUrl
              # Also state the minimum version. The forcelist alone only asks for
              # the extension to exist, which an out-of-date copy already
              # satisfies - this is what makes a deploy converge on the published
              # build instead of leaving whatever is already installed.
              Set-ExtensionSettingsPolicy -Root $b.Root -ExtId $extId -UpdateUrl $updateUrl -MinVersion $info.version
              Set-ManagedConfig -Root $b.Root -ExtId $extId -ServerUrl $apiBase -AgentId $agentId
              Ok "$($b.Name): force-installed (slot $slot), minimum v$($info.version) + configured"
            }
            Blank
            Ok 'Policy written.'

            # Writing the policy is not the same as deploying the build: the
            # browser only fetches a new version on its own schedule, which can
            # be hours. Say where things actually stand, and offer the one route
            # that makes it immediate.
            $installed = @(Get-InstalledExtensionVersions $extId)
            if (@($installed).Count -eq 0) {
              # Nothing on disk is ambiguous, and the two readings need
              # different answers. Either it has never been installed here — a
              # browser start fixes that — or it WAS installed and its files
              # went away while the browser's record of it stayed, which a start
              # cannot fix because the browser still believes it has it.
              # Watching tells the two apart without having to ask.
              Blank
              Info 'Not on disk in any profile.'
              Blank
              $doNow = Read-Host '   Install it now? (Y/n)'
              if ($doNow -ne 'n' -and $doNow -ne 'N') {
                if (-not (Invoke-ExtensionUpdate -ExtId $extId -WantVersion $info.version -UpdateUrl $updateUrl)) {
                  Blank
                  Warn 'It did not arrive after a browser start.'
                  Hint 'That usually means the browser still holds a record of an'
                  Hint 'extension whose files are gone - it believes it already has'
                  Hint 'this one, so it never fetches it. A restart cannot clear that.'
                  Hint 'Use [3] Repair, which does.'
                }
              } else {
                Info 'Left as it is - the browser installs it the next time it starts.'
              }
            } else {
              $stale = @($installed | Where-Object { $_.Version -ne $info.version })
              if (@($stale).Count -eq 0) {
                Blank
                Ok "Every profile is already on v$($info.version)."
              } else {
                Blank
                Warn "$(@($stale).Count) profile(s) are on an older build:"
                foreach ($sv in $stale) { Hint "  $($sv.Browser) / $($sv.User) / $($sv.Profile) : v$($sv.Version)" }
                Blank
                Blank
                $doNow = Read-Host '   Bring it up to date now? (Y/n)'
                if ($doNow -ne 'n' -and $doNow -ne 'N') {
                  $null = Invoke-ExtensionUpdate -ExtId $extId -WantVersion $info.version -UpdateUrl $updateUrl
                } else {
                  Info 'Left as it is - the browser will update it on its own within a few hours.'
                }
              }
            }

            Blank
            Info 'Verify at chrome://extensions - it must show:'
            Hint "    ID       $extId"
            Hint "    Version  $($info.version)"
            Hint '    "Installed by enterprise policy"'
            Hint 'A different ID means the policy points at an extension this'
            Hint 'server does not publish, and it will NEVER update: use [4]'
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
          Invoke-PrivateBrowsingPrompt
          Blank; Read-Host '   Press Enter to continue' | Out-Null
          return
        }
        '3' {
          Invoke-ExtensionRepair -ExtId $extId -UpdateUrl $updateUrl -ApiBase $apiBase -AgentId $agentId -WantVersion $info.version
          Blank; Read-Host '   Press Enter to continue' | Out-Null
          return
        }
        '4' {
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
        '5' { return }
        default { Warn 'Enter 1, 2, 3, 4 or 5.' }
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
    Write-Host '   [2] Update     ' -ForegroundColor Cyan   -NoNewline; Write-Host '- fetch the latest build and repair the install'
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
          Hint '  - removes the browser extension policy'
          Hint '  - re-allows Incognito / InPrivate browsing'
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
