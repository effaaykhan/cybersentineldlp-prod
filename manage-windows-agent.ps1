<#
  manage-windows-agent.ps1 — CyberSentinel DLP WINDOWS agent MANAGER (universal, one file).

  Self-elevates to Administrator, detects any existing agent (current OR legacy
  layout) and reports its live status (running / stopped / broken / not installed,
  plus recent log errors and whether a newer build is available), then offers:

      [1] Install    [2] Update    [3] Uninstall    [4] Exit

  Behaviour:
    - Install    : if an agent already exists, says so and does nothing; on a fresh
                   device it runs the full base installer.
    - Update     : swaps in the latest binary; if nothing is installed it tells you
                   to Install instead.
    - Uninstall  : asks ONCE to confirm, then fully stops and removes the agent,
                   its task/service and its files (both current and legacy layouts).
    - Exit       : does nothing.

  Run either form (both self-elevate to Administrator):
    powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/effaaykhan/cybersentineldlp-prod/main/manage-windows-agent.ps1 | iex"
    powershell -ExecutionPolicy Bypass -File .\manage-windows-agent.ps1
#>

& {
  $ErrorActionPreference = 'Continue'

  # ---- Shared constants (MUST match install/update/uninstall scripts) ----
  $GITHUB_REPO = 'effaaykhan/cybersentineldlp-prod'
  $RAW_BASE    = "https://raw.githubusercontent.com/$GITHUB_REPO/main"
  $SELF_URL    = "$RAW_BASE/manage-windows-agent.ps1"
  $INSTALL_URL = "$RAW_BASE/install-agent.ps1"
  $UPDATE_URL  = "$RAW_BASE/update-agent.ps1"
  $SUM_URL     = "$RAW_BASE/agents/endpoint/windows/cybersentineldlp_agent.exe.sha256"

  $INSTALL_DIR = 'C:\Program Files\CyberSentinelDLP'
  $DATA_DIR    = 'C:\ProgramData\CyberSentinelDLP'
  $EXE_NAME    = 'cybersentineldlp_agent.exe'
  $CONFIG_NAME = 'agent_config.json'
  $LOG_NAME    = 'cybersentineldlp_agent.log'
  $TASK_NAME   = 'CyberSentinel DLP Agent'
  $PROC_NAME   = 'cybersentineldlp_agent'

  # Legacy (pre-rename) layout — detected so we can flag/clean it too.
  $LEGACY_DIR   = 'C:\Program Files\CyberSentinel'
  $LEGACY_DATA  = 'C:\ProgramData\CyberSentinel'
  $LEGACY_PROC  = 'cybersentinel_agent'
  $TASK_NAMES   = @($TASK_NAME, 'CyberSentinelAgent', 'CyberSentinel Agent')
  $SVC_NAMES    = @('CyberSentinelAgent', 'CyberSentinelDLPAgent')

  function Info($m){ Write-Host "[*] $m" -ForegroundColor Cyan }
  function Ok($m)  { Write-Host "[+] $m" -ForegroundColor Green }
  function Warn($m){ Write-Host "[!] $m" -ForegroundColor Yellow }
  function Err($m) { Write-Host "[x] $m" -ForegroundColor Red }

  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

  # ================= Look & feel: banner + spinner =================

  # Animated (or instant) product banner. Pure-ASCII slant wordmark so it renders
  # correctly on every Windows console code page (no unicode box characters).
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
    # cyan gradient for a bit of depth
    $colors = @('DarkCyan','Cyan','Cyan','Cyan','DarkCyan','DarkCyan')
    for ($i = 0; $i -lt $art.Count; $i++) {
      Write-Host $art[$i] -ForegroundColor $colors[$i]
      if ($Animate) { Start-Sleep -Milliseconds 55 }
    }
    Write-Host '        D A T A   L O S S   P R E V E N T I O N   ---   A G E N T' -ForegroundColor White
    if ($Animate) { Start-Sleep -Milliseconds 120 }
    Write-Host '                  W i n d o w s   M a n a g e r   C o n s o l e' -ForegroundColor DarkGray
    Write-Host ''
  }

  # Run a scriptblock while showing an animated spinner. Uses a background runspace
  # so the spinner really animates during the work. Returns the work's output (last
  # value). If the work throws, the exception is re-thrown for the caller's
  # try/catch to handle (same as a plain synchronous call). Only a failure to
  # CREATE the runspace falls back to running the work inline.
  function Invoke-Spinner {
    param(
      [Parameter(Mandatory=$true)][scriptblock]$Work,
      [object[]]$ArgumentList = @(),
      [string]$Text = 'Working'
    )
    $ps = $null
    try { $ps = [PowerShell]::Create() } catch { $ps = $null }
    if (-not $ps) { return (& $Work @ArgumentList) }   # no runspace: run inline

    $cursorHidden = $false
    try { [Console]::CursorVisible = $false; $cursorHidden = $true } catch {}
    try {
      [void]$ps.AddScript($Work)
      foreach ($a in $ArgumentList) { [void]$ps.AddArgument($a) }
      $handle = $ps.BeginInvoke()

      $frames = @('|','/','-','\')
      $i = 0
      while (-not $handle.IsCompleted) {
        Write-Host -NoNewline ("`r  {0} {1}..." -f $frames[$i % $frames.Count], $Text) -ForegroundColor Cyan
        Start-Sleep -Milliseconds 90
        $i++
      }
      $out = @($ps.EndInvoke($handle))   # re-throws if the work threw unhandled
      return ($out | Select-Object -Last 1)
    } finally {
      if ($cursorHidden) { try { [Console]::CursorVisible = $true } catch {} }
      Write-Host -NoNewline ("`r{0}`r" -f (' ' * ($Text.Length + 8)))   # wipe spinner line
      try { $ps.Dispose() } catch {}
    }
  }

  # ================= Elevation =================

  # Self-elevate to Administrator (works from a file OR from irm|iex).
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
        # Running via irm|iex (no file on disk): re-fetch self in an elevated shell.
        Start-Process powershell.exe -Verb RunAs -ArgumentList @(
          '-NoProfile','-ExecutionPolicy','Bypass','-Command',"irm $SELF_URL | iex")
      }
    } catch {
      Err "Could not self-elevate: $($_.Exception.Message)"
      Warn "Re-open PowerShell with 'Run as administrator' and run this again."
    }
    return
  }

  # ================= Detection =================

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

    # Legacy artifacts — only treated as "the install" if no current layout exists.
    $legProc = Get-Process -Name $LEGACY_PROC -ErrorAction SilentlyContinue | Select-Object -First 1
    $legDir  = Test-Path $LEGACY_DIR
    $isLegacy = (($legDir) -or ($legProc)) -and (-not ($dirExists -or $exeExists -or $proc -or $task))

    # Config details
    $agentId = $null; $serverUrl = $null; $agentName = $null
    if (Test-Path $curCfg) {
      try {
        $c = Get-Content $curCfg -Raw -ErrorAction Stop | ConvertFrom-Json
        $agentId = $c.agent_id; $serverUrl = $c.server_url; $agentName = $c.agent_name
      } catch {}
    }

    # Installed binary hash + size
    $exeHash = $null; $exeSize = $null
    if ($exeExists) {
      try { $exeHash = (Get-FileHash -Algorithm SHA256 -Path $curExe).Hash.ToUpper() } catch {}
      try { $exeSize = [math]::Round((Get-Item $curExe).Length / 1MB, 1) } catch {}
    }

    $installed = $dirExists -or $exeExists -or [bool]$proc -or [bool]$task -or $isLegacy

    # Health verdict
    $health = 'NOT INSTALLED'; $healthColor = 'Yellow'
    if ($isLegacy) {
      $health = 'LEGACY INSTALL (pre-rename) - Uninstall then Install recommended'; $healthColor = 'Yellow'
    } elseif ($installed) {
      if ($exeExists) {
        if ($proc)     { $health = 'RUNNING';                                    $healthColor = 'Green' }
        elseif ($task) { $health = 'STOPPED (installed, autostart configured)';   $healthColor = 'Yellow' }
        else           { $health = 'BROKEN - installed but no autostart task';    $healthColor = 'Red' }
      } else {
        if ($proc) { $health = 'RUNNING but binary missing on disk!';            $healthColor = 'Red' }
        else       { $health = 'BROKEN - install dir present, binary missing';   $healthColor = 'Red' }
      }
    }

    # Recent log errors (best-effort)
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

  # ================= Status banner =================

  function Show-Status($s, $remoteHash) {
    Write-Host '  +----------------------------------------------------------------+' -ForegroundColor DarkCyan
    Write-Host -NoNewline '   Status  : '
    Write-Host $s.Health -ForegroundColor $s.HealthColor

    if ($s.Installed -and -not $s.IsLegacy) {
      if ($s.ProcRunning) { Write-Host "   PID     : $($s.ProcId)" }
      Write-Host "   Path    : $($s.InstallDir)"
      if ($s.AgentName) { Write-Host "   Agent   : $($s.AgentName)" }
      if ($s.AgentId)   { Write-Host "   ID      : $($s.AgentId)" }
      if ($s.ServerUrl) { Write-Host "   Server  : $($s.ServerUrl)" }
      if ($s.ExeExists -and $s.ExeHash) {
        Write-Host "   Binary  : $($s.ExeSize) MB  sha $($s.ExeHash.Substring(0,12))..."
      }
      if ($s.TaskExists) { Write-Host "   Task    : $($s.TaskName) [$($s.TaskState)]" }
      else { Write-Host "   Task    : (none - agent will NOT auto-start)" -ForegroundColor Red }

      # Update-available hint (remoteHash is $null when offline / not checked)
      if ($s.ExeExists -and $s.ExeHash) {
        if ($remoteHash) {
          if ($remoteHash -eq $s.ExeHash) {
            Write-Host '   Update  : up to date' -ForegroundColor Green
          } else {
            Write-Host "   Update  : AVAILABLE (latest sha $($remoteHash.Substring(0,12))...) - use [2] Update" -ForegroundColor Yellow
          }
        } else {
          Write-Host '   Update  : could not check (offline / GitHub unreachable)' -ForegroundColor DarkGray
        }
      }

      if ($s.LogErrCount -gt 0) {
        Write-Host "   Log     : $($s.LogErrCount) recent error line(s) in $($s.LogPath)" -ForegroundColor Yellow
        if ($s.LastErr) {
          $le = $s.LastErr.Trim()
          if ($le.Length -gt 100) { $le = $le.Substring(0,100) + '...' }
          Write-Host "             last: $le" -ForegroundColor DarkYellow
        }
      }
    } elseif ($s.IsLegacy) {
      Write-Host "   Note    : found legacy 'CyberSentinel' files/process." -ForegroundColor Yellow
      Write-Host '             Uninstall (3) then Install (1) for the current agent.' -ForegroundColor Yellow
    }
    Write-Host '  +----------------------------------------------------------------+' -ForegroundColor DarkCyan
  }

  # ================= Uninstall (both layouts, offline-capable) =================

  function Uninstall-Agent {
    $removed = $false

    # 1) Stop processes (exact names, so old/new never cross-match).
    foreach ($p in @($PROC_NAME, $LEGACY_PROC)) {
      Get-Process -Name $p -ErrorAction SilentlyContinue | ForEach-Object {
        Info "Stopping $($_.Name) (PID $($_.Id))"
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
        $removed = $true
      }
    }
    Start-Sleep -Milliseconds 150

    # 2) Remove scheduled tasks by known name AND by the path they launch.
    $handled = @{}
    foreach ($n in $TASK_NAMES) {
      if (Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue) {
        Info "Removing scheduled task: $n"
        Stop-ScheduledTask   -TaskName $n -ErrorAction SilentlyContinue
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
        Stop-ScheduledTask   -TaskName $_.TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $_.TaskName -Confirm:$false -ErrorAction SilentlyContinue
        $removed = $true
      }
    }

    # 3) Remove any legacy Windows service.
    foreach ($svc in $SVC_NAMES) {
      if (Get-Service -Name $svc -ErrorAction SilentlyContinue) {
        Info "Removing service: $svc"
        Stop-Service $svc -Force -ErrorAction SilentlyContinue
        sc.exe delete $svc 2>$null | Out-Null
        $removed = $true
      }
    }

    # 4) Delete install + data directories (both layouts).
    foreach ($d in @($INSTALL_DIR, $DATA_DIR, $LEGACY_DIR, $LEGACY_DATA)) {
      if (Test-Path $d) {
        Info "Deleting $d"
        Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path $d) { Warn "Could not fully delete $d (a file may be locked - reboot and re-run)" }
        else { $removed = $true }
      }
    }

    # 5) Clear the machine-wide server URL env var the installer set.
    try { [Environment]::SetEnvironmentVariable('CYBERSENTINELDLP_SERVER_URL', $null, 'Machine') } catch {}

    Write-Host ''
    if ($removed) {
      Ok 'CyberSentinel DLP agent removed from this endpoint.'
      Warn "It will show as 'disconnected' on the dashboard until you delete it there."
    } else {
      Ok 'Nothing to remove.'
    }
  }

  # ================= Main menu loop =================

  $first = $true
  while ($true) {
    Clear-Host
    Show-Banner -Animate:$first
    $first = $false

    $s = Get-AgentStatus

    # Check the latest published build (animated; only when a binary is installed).
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

    Write-Host ''
    Write-Host '   [1] Install    ' -ForegroundColor Green  -NoNewline; Write-Host '- set up the agent on this device (fresh install)'
    Write-Host '   [2] Update     ' -ForegroundColor Cyan   -NoNewline; Write-Host '- replace the agent binary with the latest build'
    Write-Host '   [3] Uninstall  ' -ForegroundColor Red    -NoNewline; Write-Host '- stop and completely remove the agent + files'
    Write-Host '   [4] Exit       ' -ForegroundColor Gray   -NoNewline; Write-Host '- do nothing and quit'
    Write-Host ''
    $choice = Read-Host '   Choose an option (1-4)'

    switch ($choice.Trim()) {
      '1' {
        Write-Host ''
        if ($s.Installed -and -not $s.IsLegacy) {
          Warn "Agent is already installed (status: $($s.Health))."
          Warn 'No need to install. Use [2] Update to refresh the binary,'
          Warn 'or [3] Uninstall first if you want a clean reinstall.'
        } else {
          if ($s.IsLegacy) {
            Info 'A legacy install was found - the installer migrates it and preserves the old agent ID.'
          }
          Info 'Launching the base installer (it will ask for the server address, etc.)...'
          Write-Host ''
          try {
            $installer = Invoke-Spinner -Text 'Downloading installer' -ArgumentList @($INSTALL_URL) -Work {
              param($u)
              [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
              Invoke-RestMethod -Uri $u -UseBasicParsing
            }
            if ($installer) { Invoke-Expression $installer }
            else { Err 'Could not download the installer (offline / GitHub unreachable).' }
          } catch { Err "Installer failed: $($_.Exception.Message)" }
        }
        Write-Host ''
        Read-Host '   Press Enter to return to the menu' | Out-Null
      }

      '2' {
        Write-Host ''
        if (-not $s.Installed -or $s.IsLegacy) {
          Warn 'No current agent is installed - there is nothing to update.'
          Warn 'Choose [1] Install to set it up first.'
        } else {
          Info 'Launching the updater (binary-only swap; config and task are kept)...'
          Write-Host ''
          try {
            $updater = Invoke-Spinner -Text 'Downloading updater' -ArgumentList @($UPDATE_URL) -Work {
              param($u)
              [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
              Invoke-RestMethod -Uri $u -UseBasicParsing
            }
            if ($updater) { Invoke-Expression $updater }
            else { Err 'Could not download the updater (offline / GitHub unreachable).' }
          } catch { Err "Updater failed: $($_.Exception.Message)" }
        }
        Write-Host ''
        Read-Host '   Press Enter to return to the menu' | Out-Null
      }

      '3' {
        Write-Host ''
        if (-not $s.Installed) {
          Warn 'No CyberSentinel DLP agent found - nothing to uninstall.'
        } else {
          Warn 'This STOPS and COMPLETELY REMOVES the CyberSentinel DLP agent:'
          Warn '  - kills the running process'
          Warn '  - removes the scheduled task / any legacy service'
          Warn '  - deletes the install and data directories (current + legacy)'
          Write-Host ''
          $confirm = Read-Host "   Type 'y' to confirm uninstall (anything else cancels)"
          if ($confirm -eq 'y' -or $confirm -eq 'Y') {
            Write-Host ''
            Uninstall-Agent
          } else {
            Warn 'Uninstall cancelled - no changes made.'
          }
        }
        Write-Host ''
        Read-Host '   Press Enter to return to the menu' | Out-Null
      }

      '4' {
        Write-Host ''
        Info 'Exiting - no changes made.'
        return
      }

      default {
        Write-Host ''
        Warn 'Invalid choice - please enter 1, 2, 3, or 4.'
        Start-Sleep -Milliseconds 900
      }
    }
  }
}
