<#
  manage-windows-agent.ps1 - CyberSentinel DLP WINDOWS agent MANAGER.

  A single, self-contained console app. Self-elevates to Administrator, detects any
  existing agent (current OR legacy layout), reports its live status, and offers:

      [1] Install  [2] Update  [3] Uninstall  [4] Logs  [5] Extension  [6] Exit

  Everything (install, update, uninstall) is implemented INLINE in this one file -
  it does not download or depend on any other script. The only things it fetches
  are the agent binary and its SHA-256 sidecar (the actual artifacts), and it
  fetches them from the DLP manager rather than from GitHub - see the note above
  the constants below for why.

  KEEP THIS FILE PURE ASCII WITH NO BOM. It is fetched and executed as a
  STRING (irm | iex), and a UTF-8 BOM survives that trip: the parser then sees
  \uFEFF before the '<#' below, never opens this comment, and parses the whole
  header as code ("Missing type name after '['"). A BOM is what makes the -File
  path safe for non-ASCII under Windows PowerShell 5.1, so with no BOM the file
  must avoid non-ASCII entirely - no em dashes, no box drawing.

  Run either form (both self-elevate to Administrator), where SERVER is the DLP
  manager this device reports to:
    powershell -ExecutionPolicy Bypass -Command "irm http://SERVER:55100/api/v1/agent-dist/manage-windows-agent.ps1 | iex"
    powershell -ExecutionPolicy Bypass -File .\manage-windows-agent.ps1

  Neither needs a credential: the manager publishes this script and the agent
  binary. If it is publishing nothing, the startup check below says so and
  offers a one-session fallback to the (private) GitHub repo, which does need a
  token - see "break-glass" in DEPLOYMENT.md for how to bootstrap that, since
  this file is private too.
#>

# On 64-bit Windows a 32-bit PowerShell has every HKLM:\SOFTWARE\Policies\...
# access redirected into WOW6432Node, which no browser reads. This script would
# then write policy nothing can see and read it back from the same hidden hive,
# reporting success on every operation while the endpoint never changed. Stop
# rather than run: a silent no-op that claims to have worked is worse than a
# refusal, and this one cost days.
if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) {
  Write-Host ''
  Write-Host '  This is 32-bit PowerShell on 64-bit Windows.' -ForegroundColor Red
  Write-Host '  Browser policy written from here goes to WOW6432Node, which Chrome' -ForegroundColor Red
  Write-Host '  and Edge never read - every extension operation would silently do' -ForegroundColor Red
  Write-Host '  nothing while reporting success.' -ForegroundColor Red
  Write-Host ''
  Write-Host '  Re-run with the 64-bit PowerShell:' -ForegroundColor Yellow
  Write-Host '    %SystemRoot%\sysnative\WindowsPowerShell\v1.0\powershell.exe -File "' -NoNewline -ForegroundColor Yellow
  Write-Host "$PSCommandPath`"" -ForegroundColor Yellow
  Write-Host ''
  exit 1
}


& {
  $ErrorActionPreference = 'Continue'
  $ProgressPreference    = 'SilentlyContinue'   # hide the noisy Invoke-WebRequest bar

  # ============================================================
  #  Constants
  # ============================================================
  # Where the artifacts come from. These were raw.githubusercontent.com URLs,
  # which worked only while the repository was public: GitHub answers 404 - not
  # 403 - to an anonymous caller, so the day the repo went private, Install,
  # Update AND the "is there a newer build?" check all began reporting a missing
  # file on a repository where the file is present and correct.
  #
  # The manager serves them now. It is the one host a managed device can reach by
  # definition - if it cannot, the agent has nothing to report to either - and
  # reaching it needs no credential on the endpoint, which is what putting a
  # GitHub token in the install one-liner would have meant.
  #
  # Deliberately left empty here and resolved below from the server this device
  # already reports to. A hardcoded default would quietly pull the binary from
  # somebody else's server.
  $SCRIPT_FILE = 'manage-windows-agent.ps1'
  $DIST_PATH   = 'api/v1/agent-dist'

  # GitHub is the BREAK-GLASS source, used only when the manager publishes
  # nothing. The repository is private, so this path needs a token - and unlike
  # the manager path, that token can read private source. It is therefore held
  # in memory for this session only, never written to disk on the endpoint, and
  # asked for again next run. That is a deliberate trade: an endpoint is the
  # worst place in the estate to store a credential of that reach.
  $GH_REPO     = 'effaaykhan/cybersentineldlp-prod'
  $GH_RAW_BASE = "https://raw.githubusercontent.com/$GH_REPO/main"
  $GH_HEADERS  = @{}
  $DIST_BASE   = $null
  $SELF_URL    = $null    # for self-elevation re-fetch
  $EXE_URL     = $null    # agent binary artifact
  $SUM_URL     = $null    # its checksum sidecar
  $VER_URL     = $null    # the version that binary IS

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

  # Legacy (pre-rename) layout - detected so we can flag / clean it too.
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
    param([string]$Url, [hashtable]$Headers = @{})
    try {
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      $c = (Invoke-WebRequest -Uri $Url -UseBasicParsing -Headers $Headers -ErrorAction Stop).Content
      return $c.Trim().Split()[0].ToUpper()
    } catch { return $null }
  }

  # ============================================================
  #  Artifact source resolution
  # ============================================================
  # Accepts every shape the server address turns up in - what the agent config
  # holds ("http://10.0.0.5:55100/api/v1"), a bare host, or host:port - and
  # returns the artifact base on that same server. One function so the install
  # prompt, the saved config and the machine environment variable can never
  # disagree about which server a build came from.
  function ConvertTo-DistBase {
    param([string]$ServerUrl)
    if ([string]::IsNullOrWhiteSpace($ServerUrl)) { return $null }
    $u = $ServerUrl.Trim().TrimEnd('/')
    if ($u -notmatch '^[A-Za-z][A-Za-z0-9+.-]*://') {
      if ($u -notmatch ':\d+$') { $u = "${u}:55100" }
      $u = "http://$u"
    }
    # Drop /api/v1 and anything after it, so an origin and a full API base both
    # land on the same place instead of /api/v1/api/v1/agent-dist.
    $u = [regex]::Replace($u, '(?i)/api/v1.*$', '')
    return "$u/$DIST_PATH"
  }

  # The GitHub layout is not the manager's: there the artifacts sit under
  # agents/endpoint/windows/, not flat at the base.
  function Get-GithubUrls {
    [PSCustomObject]@{
      Base = $GH_RAW_BASE
      Self = "$GH_RAW_BASE/$SCRIPT_FILE"
      Exe  = "$GH_RAW_BASE/agents/endpoint/windows/$EXE_NAME"
      Sum  = "$GH_RAW_BASE/agents/endpoint/windows/$EXE_NAME.sha256"
      Ver  = "$GH_RAW_BASE/agents/endpoint/windows/$EXE_NAME.version"
    }
  }

  # Is this URL actually serving? HEAD, so probing costs nothing on a 4.5MB
  # binary. Used to decide whether a token needs asking for at all - a server
  # that publishes the agent should never prompt for one.
  function Test-ArtifactUrl {
    param([string]$Url, [hashtable]$Headers = @{})
    if ([string]::IsNullOrWhiteSpace($Url)) { return $false }
    try {
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      $null = Invoke-WebRequest -Uri $Url -Method Head -UseBasicParsing `
                -TimeoutSec 20 -Headers $Headers -ErrorAction Stop
      return $true
    } catch { return $false }
  }

  # Reads a credential without echoing it. -AsSecureString keeps it off the
  # screen and out of the console's scrollback.
  function Read-SecretLine {
    param([string]$Prompt)
    $sec = $null
    try { $sec = Read-Host $Prompt -AsSecureString } catch { return $null }
    if (-not $sec -or $sec.Length -eq 0) { return $null }
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  }

  function Get-DistUrls {
    param([string]$Base)
    if ([string]::IsNullOrWhiteSpace($Base)) { return $null }
    $b = $Base.TrimEnd('/')
    [PSCustomObject]@{
      Base = $b
      Self = "$b/$SCRIPT_FILE"
      Exe  = "$b/$EXE_NAME"
      Sum  = "$b/$EXE_NAME.sha256"
      Ver  = "$b/$EXE_NAME.version"
    }
  }

  # Runs BEFORE elevation, so every source it reads has to be readable by an
  # ordinary user. Program Files and a Machine environment variable both are.
  function Get-KnownServerUrl {
    foreach ($dir in @($INSTALL_DIR, $LEGACY_DIR)) {
      $cfg = Join-Path $dir $CONFIG_NAME
      if (Test-Path $cfg) {
        try {
          $c = Get-Content $cfg -Raw -ErrorAction Stop | ConvertFrom-Json
          if ($c.server_url) { return [string]$c.server_url }
        } catch {}
      }
    }
    try {
      $envUrl = [Environment]::GetEnvironmentVariable('CYBERSENTINELDLP_SERVER_URL','Machine')
      if ($envUrl) { return $envUrl }
    } catch {}
    return $null
  }

  # Order matters. The environment variable is first because the elevated copy of
  # this script is handed it explicitly - without that it would re-resolve from
  # scratch and ask for the server a second time in the new window.
  $DIST_BASE = ConvertTo-DistBase $env:CSDLP_DIST_BASE
  if (-not $DIST_BASE) { $DIST_BASE = ConvertTo-DistBase (Get-KnownServerUrl) }
  $_d = Get-DistUrls $DIST_BASE
  if ($_d) { $SELF_URL = $_d.Self; $EXE_URL = $_d.Exe; $SUM_URL = $_d.Sum; $VER_URL = $_d.Ver }

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
        # Re-fetching means knowing where from. On a device with an agent already
        # installed that is answered from its config; on a bare one nothing knows
        # yet, so ask once here rather than let the elevated window come up empty.
        if (-not $SELF_URL) {
          Blank
          Hint 'This device has no agent yet, so the server it should install from is not known.'
          do {
            $bootIP = Read-Host '   DLP server IP or hostname'
          } while (-not (Test-ServerHost $bootIP))
          $DIST_BASE = ConvertTo-DistBase $bootIP
          $_d = Get-DistUrls $DIST_BASE
          if ($_d) { $SELF_URL = $_d.Self }
        }
        # Re-fetching only works if the manager is actually publishing this
        # script. It might not be - a server installed before agent-dist
        # existed, or one with no artifacts staged - and this script lives in a
        # PRIVATE repository, so the elevated window cannot silently fall back
        # to GitHub: that fetch needs a token, and a token on a command line is
        # readable in Task Manager by anyone on the box. Print the command to
        # run instead of quietly doing the unsafe thing.
        if (-not (Test-ArtifactUrl $SELF_URL)) {
          Blank
          Err "This server is not publishing the agent installer."
          Hint "  $SELF_URL"
          Blank
          Warn 'Fix it on the DLP server (preferred) - set AGENT_DIST_TOKEN in its'
          Warn '.env and restart the manager, then re-run this one-liner.'
          Blank
          Hint 'Or, to install from GitHub this once, open PowerShell AS ADMINISTRATOR'
          Hint 'and run (add -Headers with a token if the repo is private):'
          Blank
          Hint '  $t = Read-Host "GitHub token" -AsSecureString'
          Hint '  $p = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(' 
          Hint '        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($t))'
          Hint "  irm -Headers @{Authorization=\"Bearer `$p\"} ``"
          Hint "    '$GH_RAW_BASE/$SCRIPT_FILE' | iex"
          Blank
          return
        }
        # The elevated copy is handed the same source this one resolved, so it
        # does not repeat the question above in the new window.
        Start-Process powershell.exe -Verb RunAs -ArgumentList @(
          '-NoProfile','-ExecutionPolicy','Bypass','-Command',
          "`$env:CSDLP_DIST_BASE='$DIST_BASE'; irm $SELF_URL | iex")
      }
    } catch {
      Err "Could not self-elevate: $($_.Exception.Message)"
      Warn "Re-open PowerShell with 'Run as administrator' and run this again."
    }
    return
  }

  # ============================================================
  #  Artifact source check  (runs once, before anything else)
  # ============================================================
  # The normal path asks for nothing: the manager publishes the agent, this
  # device already knows its manager, and no credential is involved anywhere.
  # The prompt below is only reached when that is not true - and it is reached
  # HERE, at the start, rather than half way through an install with a directory
  # already created and a service already stopped.
  if (-not (Test-ArtifactUrl $SUM_URL)) {
    Blank
    Hr '=' 'Yellow'
    Write-Host '   AGENT SOURCE' -ForegroundColor Yellow
    Hr '=' 'Yellow'
    # Nothing knows the server yet: no agent is installed, and the script cannot
    # see the address it was fetched from - irm hands over the text, not the URL.
    # So ASK, before anything else. This used to fall straight through to the
    # break-glass path and demand a GitHub token, which is the wrong question:
    # whoever runs this has the server address, and has no reason to hold a
    # token for a private source repository.
    if (-not $SUM_URL) {
      Warn 'No DLP server is known for this device yet.'
      Blank
      do {
        $srvIP = Read-Host '   DLP server IP or hostname'
      } while (-not (Test-ServerHost $srvIP))
      $DIST_BASE = ConvertTo-DistBase $srvIP
      $_s = Get-DistUrls $DIST_BASE
      if ($_s) { $SELF_URL = $_s.Self; $EXE_URL = $_s.Exe; $SUM_URL = $_s.Sum; $VER_URL = $_s.Ver }
      if (Test-ArtifactUrl $SUM_URL) { Ok "Agent source: $DIST_BASE" }
    } else {
      Warn 'The DLP server is not publishing the agent binary:'
      Hint "  $SUM_URL"
    }
    Blank
    if (Test-ArtifactUrl $SUM_URL) {
      Blank
    } else {
    Hint 'Preferred fix, on the DLP server: set AGENT_DIST_TOKEN in its .env and'
    Hint 'restart the manager. Endpoints then need no credential at all.'
    Blank
    Hint "Otherwise this device can pull from $GH_REPO directly."
    Hint 'If that repository is private it needs a token with read access.'
    Hint 'It is used for this session only and is never written to disk here.'
    Blank
    $ghTok = Read-SecretLine '   GitHub token (leave blank to skip)'
    if ($ghTok) {
      $tryHeaders = @{ Authorization = "Bearer $ghTok" }
      $ghUrls = Get-GithubUrls
      if (Test-ArtifactUrl $ghUrls.Sum -Headers $tryHeaders) {
        $GH_HEADERS = $tryHeaders
        $DIST_BASE  = $ghUrls.Base
        $SELF_URL   = $ghUrls.Self
        $EXE_URL    = $ghUrls.Exe
        $SUM_URL    = $ghUrls.Sum
        $VER_URL    = $ghUrls.Ver
        Ok 'Token accepted - the agent will be fetched from GitHub for this session.'
      } else {
        Err "That token cannot read $GH_REPO."
        Warn 'Continuing without it. Install and Update will not be able to'
        Warn 'download a binary until the server publishes one.'
      }
      $ghTok = $null
    } else {
      Warn 'No token given. Install and Update cannot download a binary until'
      Warn 'the DLP server publishes one.'
    }
    Remove-Variable ghTok -ErrorAction SilentlyContinue
    }
    Blank
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

    $exeHash = $null; $exeSize = $null; $exeVersion = $null; $exeWritten = $null
    if ($exeExists) {
      try { $exeHash = (Get-FileHash -Algorithm SHA256 -Path $curExe).Hash.ToUpper() } catch {}
      try { $exeSize = [math]::Round((Get-Item $curExe).Length / 1MB, 1) } catch {}
      # Stamped into the binary by build.sh from agents/endpoint/windows/VERSION.
      # Empty for any build made before versioning existed.
      try {
        $pv = (Get-Item $curExe).VersionInfo.ProductVersion
        if ($pv) { $exeVersion = $pv.Trim() }
      } catch {}
      try { $exeWritten = (Get-Item $curExe).LastWriteTime } catch {}
    }

    # Replacing the exe while the old process survives leaves a machine that
    # hashes as up to date and behaves exactly as it did before the fix. That
    # has cost real debugging time, so it is called out rather than inferred.
    $procStale = $false
    if ($proc -and $exeWritten) {
      try { $procStale = ($proc.StartTime -lt $exeWritten) } catch {}
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
      ExeVersion = $exeVersion; ExeWritten = $exeWritten; ProcStale = $procStale
      ConfigExists = (Test-Path $curCfg); AgentId = $agentId; ServerUrl = $serverUrl; AgentName = $agentName
      TaskExists = [bool]$task; TaskName = $taskName; TaskState = $taskState
      ProcRunning = [bool]$proc; ProcId = $procId
      LogPath = $curLog; LogErrCount = $logErrCount; LastErr = $lastErr
      LegacyDir = $legDir; LegacyProc = [bool]$legProc
    }
  }

  function Show-Status {
    param($s, $remoteHash, $remoteVersion)
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
        $ver = if ($s.ExeVersion) { "v$($s.ExeVersion)" } else { 'unversioned build' }
        Field 'Binary' ("{0}  {1} MB  sha {2}..." -f $ver, $s.ExeSize, $s.ExeHash.Substring(0,12))
      }
      if ($s.ProcStale) {
        Field 'WARNING' 'the running process started BEFORE this binary was written' 'Red'
        Write-Host '             it is still executing the OLD code - restart the task' -ForegroundColor DarkYellow
      }
      if ($s.TaskExists) { Field 'Task' ("{0} [{1}]" -f $s.TaskName, $s.TaskState) }
      else { Field 'Task' '(none - agent will NOT auto-start)' 'Red' }

      if ($s.ExeExists -and $s.ExeHash) {
        if ($remoteHash) {
          if ($remoteHash -eq $s.ExeHash) {
            $upto = if ($remoteVersion) { "up to date (v$remoteVersion)" } else { 'up to date' }
            Field 'Update' $upto 'Green'
          }
          else {
            # Name the versions when both are known; a sha prefix tells an
            # operator only that two files differ, never which is newer.
            $what = if ($remoteVersion -and $s.ExeVersion) {
                      "AVAILABLE - v{0} (this device is on v{1}) - use [2]" -f $remoteVersion, $s.ExeVersion
                    } elseif ($remoteVersion) {
                      "AVAILABLE - v{0} - use [2]" -f $remoteVersion
                    } else {
                      "AVAILABLE (latest sha {0}...) - use [2]" -f $remoteHash.Substring(0,12)
                    }
            Field 'Update' $what 'Yellow'
          }
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
  # Compare accounts by SID, not by string. The same account comes back as a
  # SID, as DOMAIN\user or as a bare name depending on how it was registered,
  # and string comparison calls those three different users.
  function Resolve-UserSid {
    param([string]$Name)
    if ([string]::IsNullOrWhiteSpace($Name)) { return $null }
    if ($Name -match '^S-1-') { return $Name }
    try { return (New-Object System.Security.Principal.NTAccount($Name)).Translate(
                   [System.Security.Principal.SecurityIdentifier]).Value } catch { return $null }
  }

  # Every real user profile on the device.
  #
  # Read from ProfileList rather than by listing C:\Users, because the folder
  # name does not always match the account (renamed accounts, roaming profiles,
  # a .DOMAIN suffix), and because ProfileList is what Windows itself believes.
  # The well-known service SIDs - SYSTEM, LOCAL SERVICE, NETWORK SERVICE - are
  # skipped: nobody works in those, and monitoring them is pure noise.
  #
  # Enumerated rather than resolved to one user because the installer must not
  # guess who the device belongs to. $env:USERNAME under self-elevation is the
  # administrator UAC returned, so a single-user answer monitored a profile
  # nobody works in while the real user's documents went unwatched.
  function Get-AllUserProfiles {
    $out = @()
    $root = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList'
    foreach ($k in @(Get-ChildItem $root -ErrorAction SilentlyContinue)) {
      $sid = Split-Path $k.Name -Leaf
      if ($sid -in @('S-1-5-18','S-1-5-19','S-1-5-20')) { continue }
      if ($sid -notmatch '^S-1-5-21-') { continue }
      $pip = $null
      try { $pip = (Get-ItemProperty $k.PSPath -Name ProfileImagePath -ErrorAction Stop).ProfileImagePath } catch {}
      if ($pip -and (Test-Path $pip)) { $out += $pip }
    }
    if (-not $out) { $out = @($env:USERPROFILE) }
    $out | Select-Object -Unique
  }

  function Register-AgentTask {
    param([string]$ExePath)
    try {
      if (Get-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TASK_NAME -Confirm:$false
      }
      $action = New-ScheduledTaskAction -Execute $ExePath -Argument '--background' -WorkingDirectory $INSTALL_DIR

      # Any interactive user, not one named account.
      #
      # Naming a user was the bug: -UserId with LogonType Interactive means "run
      # while THIS account is at the console", and the account the script had to
      # hand was whoever UAC returned, which on this machine is never at the
      # console. The task sat in state Ready and had never run once. Resolving
      # the console user instead only moved the guess - it still picks one
      # account, and it is wrong the moment a second person uses the device.
      #
      # BUILTIN\Users by SID, so it fires for every interactive user in their
      # own session. The SID, not the name: "Users" is localised, and this has
      # to work on a German or Japanese install.
      $principal = New-ScheduledTaskPrincipal -GroupId 'S-1-5-32-545' -RunLevel Highest

      # No -User on the trigger either: an at-logon trigger without one fires
      # for whoever logs on. Startup is deliberately NOT a trigger any more - at
      # boot there is no interactive session for an Interactive task to run in,
      # so it could never fire and only made the task look like it had more
      # coverage than it did.
      $tLogon = New-ScheduledTaskTrigger -AtLogOn

      # Parallel, not IgnoreNew. With fast user switching two people are logged
      # on at once, and IgnoreNew would silently leave the second one with no
      # agent - an unmonitored user on a DLP endpoint, which is the one outcome
      # this product cannot have.
      $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -DontStopOnIdleEnd -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit (New-TimeSpan -Days 9999) -MultipleInstances Parallel
      Register-ScheduledTask -TaskName $TASK_NAME -Action $action -Trigger $tLogon `
        -Principal $principal -Settings $settings -Description 'CyberSentinel DLP Agent - endpoint monitoring' -Force | Out-Null
      Ok "Scheduled task '$TASK_NAME' registered for every interactive user (at logon)"
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

    # A task registered against a named account is not correct however right its
    # action is. It runs for that one user, and where the installer had to guess
    # the account it ran for nobody - state Ready, never run, which this
    # function used to report as correct while the agent could not start.
    # Returning false makes the update path rewrite it for the Users group.
    $gid = "$($task.Principal.GroupId)"
    if (-not $gid) { return $false }
    $gsid = Resolve-UserSid $gid
    if ($gsid) { if ($gsid -ne 'S-1-5-32-545') { return $false } }
    elseif ($gid -ne 'S-1-5-32-545') { return $false }

    # IgnoreNew leaves a second simultaneous user with no agent. That is an
    # unmonitored session on a DLP endpoint, so it counts as out of date.
    if ("$($task.Settings.MultipleInstances)" -and
        "$($task.Settings.MultipleInstances)" -ine 'Parallel') { return $false }
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

    # Pull the binary from the very server this agent is about to report to.
    # These shadow the outer URLs for the rest of this function on purpose: on a
    # first install nothing had resolved them yet, and deriving them from the
    # answer just given removes any way to install one server's build onto an
    # agent that then reports to a different one.
    $_di = Get-DistUrls (ConvertTo-DistBase $serverURL)
    if (Test-ArtifactUrl $_di.Sum) {
      $EXE_URL = $_di.Exe; $SUM_URL = $_di.Sum; $VER_URL = $_di.Ver
      $GH_HEADERS = @{}
    } else {
      Warn 'This server is not publishing the agent binary - keeping the source'
      Warn 'chosen at startup for this install.'
    }

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
    # Register the exclusion HERE, not after Step 5 writes the binary: an exe is
    # scanned as it lands, so an exclusion added afterwards protects nothing.
    Set-AgentDefenderExclusions -Brief | Out-Null

    # -- Step 4: OCR deps (optional) -----------------------------------------
    Step 4 $TOTAL 'OCR dependencies (Tesseract, optional)'
    Hint 'Used only by the screen-capture OCR fallback; the agent runs without them.'

    # The DLP server first, the internet second.
    #
    # This used to go straight to Chocolatey, which downloads its own installer
    # and, on Windows Server, pulls .NET 4.8 before it will run at all. On a
    # machine with no internet both fail - so OCR, the thing that reads a
    # photographed ID card, was lost on exactly the fleet most likely to be
    # isolated, and the operator saw a .NET download error with no obvious
    # bearing on DLP.
    #
    # An operator stages tesseract-installer.exe once in server/agent_dist/ on
    # the manager and every endpoint can fetch it from the server it already
    # talks to. Absent, this falls through to Chocolatey exactly as before.
    if (Test-CommandExists 'tesseract') {
      Ok 'Tesseract already present'
    } elseif ($DIST_BASE) {
      $tessUrl = "$DIST_BASE/tesseract-installer.exe"
      if (Test-ArtifactUrl $tessUrl $GH_HEADERS) {
        Info 'Fetching Tesseract from the DLP server (no internet needed)...'
        $tessExe = Join-Path $env:TEMP 'tesseract-installer.exe'
        try {
          Invoke-Spinner -Text 'Downloading Tesseract' -ArgumentList @($tessUrl, $tessExe, $GH_HEADERS) -Work {
            param($u,$out,$hdr)
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -Uri $u -OutFile $out -UseBasicParsing -Headers $hdr
          } | Out-Null
          # /S is the NSIS silent switch the official Tesseract installer uses.
          $tp = Start-Process -FilePath $tessExe -ArgumentList '/S' -Wait -PassThru
          if (Test-Path 'C:\Program Files\Tesseract-OCR\tesseract.exe') {
            $env:Path = "C:\Program Files\Tesseract-OCR;$env:Path"
          }
          if (Test-CommandExists 'tesseract') { Ok 'Tesseract installed from the DLP server' }
          else { Warn "Tesseract installer exited $($tp.ExitCode) - OCR fallback unavailable" }
        } catch { Warn "Could not install Tesseract from the server: $($_.Exception.Message)" }
        Remove-Item $tessExe -Force -ErrorAction SilentlyContinue
      } else {
        Hint 'The DLP server is not publishing tesseract-installer.exe.'
        Hint 'Stage it in server/agent_dist/ there to install OCR without internet.'
      }
    }

    # Chocolatey is no longer bootstrapped from here.
    #
    # Doing so meant downloading a script from the internet and running it
    # through Invoke-Expression - the exact shape of a malware dropper, and one
    # of the two most heavily signatured constructs in PowerShell. AMSI blocked
    # this whole installer over it, which is a fair verdict: a security product
    # whose own installer fetches and executes remote code has no business
    # objecting. It is also redundant now - the manager serves
    # tesseract-installer.exe from its own image, which is the path an
    # air-gapped endpoint needs anyway.
    #
    # An existing Chocolatey install is still USED where the operator has one.
    # What is gone is fetching and executing a remote script to create one.
    if (-not (Test-CommandExists 'tesseract') -and (Test-CommandExists 'choco')) {
      Ok 'Chocolatey already present'
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
      Warn 'Tesseract not installed - the screen-capture OCR fallback is disabled.'
      Hint 'The agent works without it. To enable OCR on machines with no internet,'
      Hint 'stage tesseract-installer.exe in server/agent_dist/ on the DLP server'
      Hint 'and re-run this installer.'
    }

    # -- Step 5: download + verify binary ------------------------------------
    Step 5 $TOTAL 'Downloading + verifying the agent binary'
    $exePath = Join-Path $INSTALL_DIR $EXE_NAME
    try {
      Invoke-Spinner -Text 'Downloading binary' -ArgumentList @($EXE_URL, $exePath, $GH_HEADERS) -Work {
        param($u,$out,$hdr)
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $u -OutFile $out -UseBasicParsing -Headers $hdr
      } | Out-Null
    } catch { Err "Download failed: $($_.Exception.Message)"; return }
    if (-not (Test-Path $exePath)) { Err 'Download failed (no file written).'; return }
    $sizeMB = [math]::Round((Get-Item $exePath).Length / 1MB, 1)
    Ok "Downloaded ($sizeMB MB)"

    $expected = Get-RemoteSha $SUM_URL $GH_HEADERS
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

    $userProfiles = @(Get-AllUserProfiles)
    $config = @{
      server_url = $serverURL; agent_name = $agentName
      heartbeat_interval = $heartbeat; policy_sync_interval = $policySync
      ransomware_detection_enabled = $true; ransomware_burst_threshold = 15
      ransomware_window_seconds = 10; ransomware_cooldown_seconds = 60
      monitoring = @{
        file_system = $true; clipboard = $true; usb_devices = $true
        screen_capture = $true; print_jobs = $true
        # Every profile on the device, not one. This was
        # C:\Users\$env:USERNAME\..., which under self-elevation is the
        # administrator - so file monitoring watched a profile nobody works in
        # while the real user's documents went unwatched, and on a shared device
        # covered one person out of several.
        monitored_paths = @(
          $userProfiles | ForEach-Object {
            (Join-Path $_ 'Documents'), (Join-Path $_ 'Desktop'), (Join-Path $_ 'Downloads')
          }
        )
        file_extensions = @('.pdf','.docx','.xlsx','.csv','.txt','.json','.xml','.sql','.pem','.key','.env','.conf')
      }
      quarantine_path = "$DATA_DIR\quarantine"; log_path = "$DATA_DIR\logs"; cache_path = "$DATA_DIR\cache"
    }
    # Identity is assigned HERE rather than left to the agent to mint on first
    # run. Two reasons:
    #   * The agent generates an id when the config has none and persists it back
    #     - but only if it can resolve and write that config. When it cannot, it
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

    # An install written by an older build, or a repaired one whose config was
    # lost, leaves nothing to say which server publishes the binary. Ask instead
    # of failing on an empty URL, which reads as "the download is broken".
    if (-not $EXE_URL) {
      Warn 'This install does not record which DLP server it belongs to.'
      do {
        $updIP = Read-Host '   DLP server IP or hostname'
      } while (-not (Test-ServerHost $updIP))
      $_du = Get-DistUrls (ConvertTo-DistBase $updIP)
      $EXE_URL = $_du.Exe; $SUM_URL = $_du.Sum; $VER_URL = $_du.Ver
    }

    # Staged inside the install directory, never %TEMP%. An unsigned PE written
    # into AppData\Local\Temp is one of the most heavily weighted signals
    # Defender's ML model has, and %TEMP% is not covered by the install-path
    # exclusion either - which is exactly how one binary got quarantined twice,
    # once in Program Files and again in Temp. Same volume too, so replacing
    # the live exe is a move rather than a cross-volume copy.
    if (-not (Test-Path $INSTALL_DIR)) {
      New-Item -ItemType Directory -Path $INSTALL_DIR -Force | Out-Null
    }
    Set-AgentDefenderExclusions -Brief | Out-Null
    $tmpExe  = Join-Path $INSTALL_DIR ($EXE_NAME + '.download')

    # Clear a .download left behind by a run Defender interrupted. Invoke-
    # WebRequest happily overwrites it, but if the fresh fetch fails for any
    # reason the stale one is still there, and Get-FileHash then reads the file
    # Defender has flagged and dies with "the file contains a virus" - which
    # reads like the new download was blocked when it never arrived at all.
    if (Test-Path $tmpExe) { Remove-Item $tmpExe -Force -ErrorAction SilentlyContinue }

    Info 'Downloading the latest published binary...'
    try {
      Invoke-Spinner -Text 'Downloading + verifying' -ArgumentList @($EXE_URL, $tmpExe, $GH_HEADERS) -Work {
        param($u,$out,$hdr)
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $u -OutFile $out -UseBasicParsing -Headers $hdr
      } | Out-Null
    } catch { Err "Download failed: $($_.Exception.Message)"; return }
    if (-not (Test-Path $tmpExe)) { Err 'Download failed (no file written).'; return }

    $expected = Get-RemoteSha $SUM_URL $GH_HEADERS
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
    $newVer = $null
    try { $newVer = (Get-Item $exePath).VersionInfo.ProductVersion } catch {}
    if ($newVer) { Ok "Binary replaced with v$($newVer.Trim()) (previous kept as $EXE_NAME.bak)" }
    else         { Ok "Binary replaced (previous kept as $EXE_NAME.bak)" }

    Invoke-AgentReconcile -ExePath $exePath -SkipStart
    Info 'Restarting the agent...'
    Start-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
    # Start-ScheduledTask returns as soon as the task is queued, not when the
    # process exists, so one early check reported "agent not detected" for an
    # agent that was starting perfectly well and heartbeating seconds later.
    # Crying wolf on a routine update is worse than waiting: it trains you to
    # ignore the one time it means something.
    $proc = Wait-AgentProcess -TimeoutSeconds 25
    Blank
    if ($proc) {
      # The version is read back from the process's own image, so this line says
      # what is RUNNING rather than what was copied a moment ago.
      $runVer = $null
      try { $runVer = (Get-Item $proc.Path).VersionInfo.ProductVersion } catch {}
      if ($runVer) { Ok "Update complete - agent v$($runVer.Trim()) running (PID $($proc.Id))." }
      else         { Ok "Update complete - agent running (PID $($proc.Id))." }
    }
    else { Show-AgentStartFailure }
  }

  # Everything an installation is, apart from the binary.
  #
  # Run on every Update so a machine converges on a correct install rather than
  # only ever having its exe swapped. Each check states what it found, because
  # "nothing needed fixing" and "I did not look" are the same output otherwise -
  # and that ambiguity is what let a broken launcher survive.
  # Poll, do not sleep once. The agent reads its config, resolves the server and
  # pulls a policy bundle before its process is worth looking for, and against a
  # slow or unreachable server that is comfortably more than the three seconds
  # this used to allow - which reported a healthy agent as failed to start.
  function Wait-AgentProcess {
    param([int]$TimeoutSeconds = 25)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
      $p = Get-Process -Name $PROC_NAME -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($p) { return $p }
      Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    $null
  }

  # "check [4] Logs" was the entire failure path, which left the one number that
  # names the cause - the task's last result - behind a menu someone has to know
  # to visit, and said nothing at all when the agent never wrote a log. Decode it
  # here, next to the failure, with whatever the agent managed to write.
  function Show-AgentStartFailure {
    Warn 'Agent did not start.'
    $info = $null
    try { $info = Get-ScheduledTaskInfo -TaskName $TASK_NAME -ErrorAction Stop } catch {}
    if ($info) {
      $rc  = [int64]$info.LastTaskResult
      $why = switch ($rc) {
        0          { 'the task launched it cleanly - so the agent started and then exited by itself' }
        1          { 'the agent ran and returned 1 - it started, then rejected its config or the server' }
        267009     { 'the task reports itself still running' }
        267011     { 'the task has never run' }
        267014     { 'the last run was terminated' }
        2147942402 { 'the exe was not found - wrong path in the task, or the file is gone' }
        2147942405 { 'access denied' }
        2147942625 { 'blocked as malware - antivirus stopped it RUNNING, not just downloading' }
        2147942626 { 'the file was deleted as malware' }
        3221225477 { 'the agent crashed - access violation' }
        3221225781 { 'a required DLL was missing' }
        3221225785 { 'a DLL entry point was missing' }
        3221225794 { 'DLL initialisation failed' }
        default    { 'unrecognised - quote this code' }
      }
      Hint ("Task last result : {0} (0x{1}) - {2}" -f $rc, $rc.ToString('X8'), $why)
      Hint ("Task last run    : {0}" -f $info.LastRunTime)
    } else {
      Hint 'Could not read the scheduled task result.'
    }

    # The task's own record of what the process returned. Present even when the
    # agent died too early to log anything, which is exactly the case where the
    # agent log is empty and unhelpful.
    try {
      # 332 is the one that names this class of failure outright - "did not
      # launch task because the user was not logged on" - and 101/103/203 cover
      # a launch or action that was refused rather than never attempted.
      $ev = Get-WinEvent -FilterHashtable @{
              LogName   = 'Microsoft-Windows-TaskScheduler/Operational'
              Id        = 101, 103, 111, 201, 203, 329, 331, 332
              StartTime = (Get-Date).AddMinutes(-10)
            } -MaxEvents 6 -ErrorAction Stop |
            Where-Object { $_.Message -match [regex]::Escape($TASK_NAME) }
      foreach ($e in @($ev)) {
        Hint ("Task Scheduler   : {0}  {1}" -f $e.TimeCreated, (($e.Message -split "`r?`n")[0]))
      }
    } catch {}

    $lf = Resolve-LogFile
    if ($lf) {
      Blank; Hint ("Last lines of {0} (written {1}):" -f $lf.Name, $lf.LastWriteTime)
      Get-Content $lf.FullName -Tail 12 -ErrorAction SilentlyContinue |
        ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
      # A log written moments ago separates the two failures that look identical
      # from the outside: a task that never fired, and an agent that started,
      # ran, and died. Only the second one is a bug in the agent.
      $ageMin = ((Get-Date) - $lf.LastWriteTime).TotalMinutes
      if ($ageMin -ge 0 -and $ageMin -lt 15) {
        Blank
        Warn 'That log was written minutes ago - so the agent DID run, and then exited.'
        Hint 'This is a crash or an early exit, not a task that never fired. Run the'
        Hint 'binary by hand with the line below and read what it prints.'
      }
    } else {
      Hint 'No log file exists - the agent never got far enough to open one.'
    }
    Blank
    Hint 'To see the failure directly, run the exe in this window:'
    Write-Host ("      & '{0}'" -f (Join-Path $INSTALL_DIR $EXE_NAME)) -ForegroundColor White
  }

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
      Warn 'Scheduled task is missing, launches the agent the old way, or runs as the wrong account - rewriting it.'
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
        $proc = Wait-AgentProcess -TimeoutSeconds 25
        if ($proc) { Ok "Agent started (PID $($proc.Id))." }
        else { Show-AgentStartFailure }
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
      # had no file - and the force-install policy survived the uninstall,
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

  # ============================================================
  #  Typed-message (chat) control diagnostics
  # ============================================================
  #
  # "I switched the policy on, typed a card number into WhatsApp, and nothing
  # happened" has six distinct causes and from a dashboard they look identical.
  # The agent already writes every one of them to its log; nobody was ever going
  # to find them by scrolling past a heartbeat every thirty seconds. This reads
  # the log back and names the stage that stopped, in the order the agent runs
  # them:
  #
  #   1. the module started       - the keyboard hook installed
  #   2. the policy arrived       - typed-message inspection is ON, not just the
  #                                 messaging policy being active
  #   3. the send key was seen    - Enter reached the hook
  #   4. the app was recognised   - the foreground app resolved to a name the
  #                                 policy lists (this is the one that bites:
  #                                 WhatsApp for Windows is not whatsapp.exe)
  #   5. the composer was read    - UI Automation could see the message box
  #   6. the text counted         - it matched a detector the policy selected
  #
  # Stage 4 is also answered from the live process list rather than from the
  # log, because the exact image name is the single fact an operator needs and
  # the one they cannot guess.

  $CHAT_PROC_PATTERN = '^(whatsapp|teams|ms-teams|msteams|telegram|slack|discord|signal|skype|wechat|viber|messenger)'

  # Strip the log's fixed preamble but KEEP THE TIMESTAMP. Dropping everything
  # up to "MessagingText:" made every line ageless, so a verdict from the build
  # before last read exactly like one from thirty seconds ago - which is how a
  # stale "message clean" got mistaken for the current build's answer.
  function Format-MsgLine {
    param([string]$Line)
    '  ' + ($Line -replace '\s*-\s*CyberSentinelAgent\s*-\s*(INFO|DEBUG|WARNING|ERROR)\s*-\s*MessagingText:\s*', '  ')
  }

  # Index of the last line matching $Pattern, or -1. Used to compare WHEN things
  # happened against WHEN this build started, without parsing timestamps.
  function Get-LastIndex {
    param($Lines, [string]$Pattern)
    for ($i = $Lines.Count - 1; $i -ge 0; $i--) {
      if ($Lines[$i] -match $Pattern) { return $i }
    }
    return -1
  }

  function Get-ChatProcesses {
    $out = @{}
    foreach ($p in @(Get-Process -ErrorAction SilentlyContinue)) {
      if ($p.ProcessName -notmatch $CHAT_PROC_PATTERN) { continue }
      $exe = ($p.ProcessName + '.exe').ToLower()
      if ($out.ContainsKey($exe)) { $out[$exe]++ } else { $out[$exe] = 1 }
    }
    $out.GetEnumerator() | Sort-Object Name
  }

  # Last "Messaging app control: enforced=.. action=.. apps=N [a,b,c] typed_messages=.."
  # line the agent wrote. That line IS the policy as the endpoint received it,
  # which is the only version of it that matters.
  function Get-MessagingPolicyFromLog {
    param($Lines)
    $line = @($Lines | Where-Object { $_ -match 'Messaging app control:' } | Select-Object -Last 1)
    if ($line.Count -eq 0) { return $null }
    $t = $line[0]
    $apps = @()
    # Anchored on "apps=N [" and not just the first bracket in the line - the
    # log prefixes every line with a bracketed timestamp, which an unanchored
    # match happily returns as the app list.
    if ($t -match 'apps=\d+\s*\[([^\]]*)\]') {
      $apps = @($matches[1].Split(',') | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ })
    }
    $types = @()
    if ($t -match 'message_data_types=([A-Za-z0-9_,]+)') {
      $types = @($matches[1].Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    }
    [PSCustomObject]@{
      Raw       = $t
      Enforced  = ($t -match 'enforced=true')
      Action    = $(if ($t -match 'action=(\w+)') { $matches[1] } else { 'unknown' })
      Inspected = ($t -match 'typed_messages=inspected')
      Apps      = $apps
      Types     = $types
    }
  }

  function Show-MessagingDiagnostics {
    param([string]$LogPath)

    Blank
    Header 'TYPED-MESSAGE (CHAT) CONTROL - WHY IS NOTHING HAPPENING?' 'Cyan'

    if (-not $LogPath -or -not (Test-Path $LogPath)) {
      Err 'No agent log to read - the agent has not run on this device yet.'
      return
    }

    # Tail rather than the whole file: the policy line is rewritten on every
    # sync, so a recent window always carries a current copy of every stage.
    # -Encoding UTF8: the agent writes UTF-8, and Windows PowerShell defaults to
    # the ANSI code page, which turns every em-dash in the agent's own messages
    # into mojibake right where an operator is trying to read a diagnosis.
    $lines = @(Get-Content -Path $LogPath -Tail 6000 -Encoding UTF8 -ErrorAction SilentlyContinue)
    if ($lines.Count -eq 0) { Err 'The agent log is empty.'; return }

    $ver = @($lines | Where-Object { $_ -match 'Agent version:' } | Select-Object -Last 1)
    Hr '-' 'DarkCyan'
    Field 'Log'   $LogPath
    Field 'Build' $(if ($ver.Count) { ($ver[0] -replace '^.*Agent version:\s*','') } else { 'not logged (pre-1.1.0 build)' })
    Field 'Lines' "$($lines.Count) most recent"

    # ---- stage 1: did the module start? ----------------------------------
    Blank
    Write-Host '   STAGE 1  Module started' -ForegroundColor Cyan
    $hookOn   = @($lines | Where-Object { $_ -match 'typed-message keyboard hook installed' }).Count -gt 0
    $hookFail = @($lines | Where-Object { $_ -match 'SetWindowsHookEx' }) | Select-Object -Last 1
    $uiaBad   = @($lines | Where-Object { $_ -match 'UIAutomation unavailable' }).Count -gt 0
    if ($hookOn)        { Ok  'Keyboard hook installed.' }
    elseif ($hookFail)  { Err "Hook could not be installed: $hookFail" }
    else                { Err 'The typed-message monitor never started (no hook line in this window of the log).' }
    if ($uiaBad) { Err 'UI Automation is unavailable in this session - the composer can never be read.' }

    # The classifier proves itself against a known-good test card at every start,
    # so "the classifier is not wired up" and "we read the wrong box" stop being
    # the same symptom - both otherwise report every message as clean.
    $selfTest = @($lines | Where-Object { $_ -match 'classifier self-test' } | Select-Object -Last 1)
    if ($selfTest.Count -eq 0) {
      Info 'No classifier self-test in the log (agent older than 1.2.2).'
    } elseif ($selfTest[0] -match 'FAILED|THREW') {
      Err (Format-MsgLine $selfTest[0]).Trim()
      Hint 'The classifier itself is not detecting a known-good test card. Nothing typed'
      Hint 'into any app will ever be flagged until this line reads "detected".'
    } else {
      Ok ('Classifier self-test: ' + (($selfTest[0] -replace '^.*classifier self-test:\s*','')))
    }

    # ---- stage 2: what policy did the endpoint actually receive? ---------
    Blank
    Write-Host '   STAGE 2  Policy as the endpoint received it' -ForegroundColor Cyan
    $pol = Get-MessagingPolicyFromLog $lines
    if (-not $pol) {
      Err 'The agent has not fetched a messaging policy in this window of the log.'
      Hint 'Check the agent is registered and reaching the server (menu [4] -> [1]).'
    } else {
      Field 'Enforced'       $(if ($pol.Enforced) { 'yes' } else { 'NO - no active messaging_app_control policy' })
      Field 'Action'         $pol.Action
      Field 'Typed messages' $(if ($pol.Inspected) { 'INSPECTED' } else { 'OFF' })
      Field 'Managed apps'   $(if ($pol.Apps.Count) { ($pol.Apps -join ', ') } else { '(none)' })
      # The selection is what decides whether a detection counts. A message the
      # classifier flagged and the policy then discarded is logged as "clean",
      # which is the single most confusing outcome this feature has.
      Field 'Counts as sensitive' $(
        if ($pol.Types.Count -eq 1 -and $pol.Types[0] -eq 'all') { 'every Confidential/Restricted type' }
        elseif ($pol.Types.Count) { ($pol.Types -join ', ') }
        else { '(not logged - agent older than 1.2.1)' })
      if (-not $pol.Enforced) {
        Err 'No messaging policy is active - nothing downstream of this can fire.'
      } elseif (-not $pol.Inspected) {
        Err 'Typed-message inspection is OFF. Attachment control is on; the chat box is not watched.'
        Hint 'Dashboard -> Policies -> your Messaging App Control policy -> tick "Inspect typed messages",'
        Hint 'and make sure at least one data type is selected (an empty selection means OFF).'
      } else {
        Ok 'Typed-message inspection is on.'
      }
    }

    # ---- stage 3/4: what did the hook see, and under what name? ----------
    Blank
    Write-Host '   STAGE 3  Send keys seen by the hook' -ForegroundColor Cyan
    $probes = @($lines | Where-Object { $_ -match 'send key pressed in' } | Select-Object -Last 12)
    if ($probes.Count -eq 0) {
      Err 'No send key has reached the hook.'
      Hint 'Press Enter inside a chat window, wait ~5 seconds, then run this again.'
      Hint 'If it stays empty: the agent is running as a different user or session than the'
      Hint 'one typing, or it was never started - a low-level hook only sees its own session.'
    } else {
      Ok "$($probes.Count) recent send key(s) traced:"
      foreach ($l in $probes) { Write-LogLine (Format-MsgLine $l) }
    }

    Blank
    Write-Host '   STAGE 4  App names on THIS device right now' -ForegroundColor Cyan
    $running = @(Get-ChatProcesses)
    if ($running.Count -eq 0) {
      Warn 'No chat application is running - start the one you are testing with, then run this again.'
    } else {
      foreach ($r in $running) {
        $covered = $false
        if ($pol -and $pol.Apps.Count) {
          $stem = ($r.Name -split '\.')[0]
          foreach ($a in $pol.Apps) { if ($a -eq $r.Name -or (($a -split '\.')[0]) -eq $stem) { $covered = $true; break } }
        }
        if ($covered) { Ok  ("{0,-26} x{1}  - in the policy" -f $r.Name, $r.Value) }
        else          { Warn ("{0,-26} x{1}  - NOT in the policy" -f $r.Name, $r.Value) }
      }
      Hint 'These are the exact names the agent matches. Copy one verbatim into the policy'
      Hint 'if it is the app you meant - WhatsApp for Windows is whatsapp.root.exe, not whatsapp.exe.'
    }

    # ---- stage 5: could the composer be read? ----------------------------
    Blank
    Write-Host '   STAGE 5  Reading the message box' -ForegroundColor Cyan
    # "(empty box)" was matched by neither list, so a read that found the nodes
    # and no text in them produced a completely silent stage - the one outcome
    # that looks identical to nothing having run at all.
    $unread = @($lines | Where-Object { $_ -match 'composer unreadable|no editable node|empty box|ambiguous composer|not guessing' } | Select-Object -Last 5)
    # A send that was HELD and then handed back is the outcome that used to be
    # invisible: the hook traced the keypress, the message went out unchecked,
    # and no stage here matched a single one of the lines that said so.
    $released = @($lines | Where-Object { $_ -match 'inspection exceeded|UNINSPECTED|decision threw|COM could not be initialised' } | Select-Object -Last 5)
    $readok = @($lines | Where-Object { $_ -match 'composer appeared on attempt|via (focused|window-fallback|sampled)' } | Select-Object -Last 5)
    if ($unread.Count -gt 0) {
      Err 'UI Automation could not see the composer on at least one send:'
      foreach ($l in $unread) { Write-LogLine (Format-MsgLine $l) }
      Hint 'Chromium-based apps build their accessibility tree lazily; agent 1.2.0 retries for this.'
      Hint 'If it persists on 1.2.0+, that build of the app cannot be inspected - report the exe name.'
    }
    if ($released.Count -gt 0) {
      Err 'The Enter was held and then RELEASED UNINSPECTED - those messages were sent unchecked:'
      foreach ($l in $released) { Write-LogLine (Format-MsgLine $l) }
      Hint 'This is the agent failing open on purpose - it will never hold your keyboard hostage.'
      Hint '"inspection exceeded" = reading the box took longer than the whole hold budget.'
      Hint 'On 1.2.4+ the verdict comes from what the sampler read WHILE YOU WERE TYPING, so a'
      Hint 'slow accessibility tree no longer costs you the block - these lines should stop.'
      Hint 'Still seeing them dated after the update? Send me the timestamps.'
    }
    if ($readok.Count -gt 0) { Ok 'The composer has been read successfully:'; foreach ($l in $readok) { Write-LogLine (Format-MsgLine $l) } }

    # 1.2.5 moved the expensive search OFF the held keystroke: a background
    # sampler finds the composer element once and then just re-reads it. These
    # three lines are the only direct evidence of whether that worked, and none
    # of the matchers above sees them - so without this block the decisive
    # measurement is in the log and absent from the report.
    $sampler = @($lines | Where-Object {
      $_ -match 'locked onto the composer|cannot find a composer|focused read found nothing|went stale|located the Send button|found no Send button|recognised the control under the pointer|mouse hook installed|WH_MOUSE_LL'
    } | Select-Object -Last 8)
    if ($sampler.Count -gt 0) {
      Info 'Composer-search results (1.2.5+):'
      foreach ($l in $sampler) { Write-LogLine (Format-MsgLine $l) }
      Hint '"locator locked onto the composer"  = it works. The verdict comes from what you typed.'
      Hint '"locator cannot find a composer"    = UI Automation cannot see this app''s message box.'
      Hint '   The number in brackets is how many editable nodes it found: 0 means the box is not'
      Hint '   exposed to accessibility at all, and this method cannot inspect that app.'
      Hint '"focused read found nothing"        = the box was not what had focus when you pressed'
      Hint '   Enter. The trailing focus:type=NNNN name=... says what actually did.'
      Hint '"went stale ... re-acquiring"       = 1.2.6 caught the app rebuilding its message box.'
      Hint '   Before 1.2.6 that went unnoticed and blocking stopped working after the first hit.'
      Hint '"located the Send button"           = clicking Send with the mouse is covered too.'
      Hint '   1.2.8 says HOW it was found: "by name" (the control is called Send) or "by position"'
      Hint '   (an unnamed icon sitting immediately right of the message box, which is what'
      Hint '   WhatsApp ships).'
      Hint '"recognised the control under the pointer as Send" = the 1.2.8 fallback. It identifies'
      Hint '   the button as you move the mouse onto it, so a click is covered even in an app whose'
      Hint '   tree the search cannot walk.'
      Hint '"found no Send button"              = only Enter is inspected in that app, unless you'
      Hint '   rest the pointer on the button first. Before 1.2.8 this was the normal outcome on'
      Hint '   WhatsApp for a silly reason: the search only ran on a timer, and while the message'
      Hint '   box is EMPTY that control is a microphone, not Send - so it kept missing, backed off'
      Hint '   to once every 160s, and had stopped looking by the time you typed anything. 1.2.8'
      Hint '   searches only while there is text in the box.'
    }

    if ($unread.Count -eq 0 -and $readok.Count -eq 0 -and $released.Count -eq 0 -and $sampler.Count -eq 0) { Info 'No composer read attempted yet (nothing got past stage 3/4).' }

    # ---- stage 6: verdicts ------------------------------------------------
    Blank
    Write-Host '   STAGE 6  Verdicts' -ForegroundColor Cyan

    # A restart writes a fresh "Agent version:" line. Anything the typed-message
    # monitor said BEFORE that line was said by the previous build, and reading
    # it as this build's answer is how an update looks like it changed nothing.
    $startIdx = Get-LastIndex $lines 'Agent version:'
    # Every outcome, not just the DEBUG ones. Before 1.2.3 the verdict lines were
    # DEBUG, so on an agent logging at INFO this stage reported "nothing has been
    # classified" while inspection was in fact running perfectly - and the three
    # WARNING-level outcomes below were matched by nothing at all.
    $actIdx   = Get-LastIndex $lines 'MESSAGING_TEXT_|message clean|no composer text|composer unreadable|inspection exceeded|UNINSPECTED|decision threw|alert: nothing to inspect'
    if ($startIdx -ge 0 -and $actIdx -lt $startIdx) {
      Warn 'Everything shown above happened BEFORE the currently running build started.'
      Hint 'This build has not inspected a message yet. Type into the chat app, press Enter,'
      Hint 'wait a few seconds, then run this again - the new lines carry a [N chars/N digits]'
      Hint 'profile that the older ones do not.'
      Blank
    }
    $verdicts = @($lines | Where-Object { $_ -match 'MESSAGING_TEXT_(BLOCKED|ALERT|LATE)' } | Select-Object -Last 10)
    $clean    = @($lines | Where-Object { $_ -match 'message clean' } | Select-Object -Last 5)
    if ($verdicts.Count -gt 0) {
      Ok "$($verdicts.Count) message(s) acted on:"
      foreach ($l in $verdicts) { Write-LogLine (Format-MsgLine $l) }
    } elseif ($clean.Count -gt 0) {
      Warn 'Messages were read and classified as NOT sensitive:'
      foreach ($l in $clean) { Write-LogLine (Format-MsgLine $l) }
      Hint 'Read the bracket on each line. "[19 chars/12 digits/0 letters]" is what was actually'
      Hint 'read from the box - all letters and ~14 chars means the placeholder was read, not your text.'
      Hint 'A line ending "none of them selected in this policy" means the classifier DID find'
      Hint 'something and the policy did not select that type - tick it in the policy above.'
      Hint 'Neither present? The classifier genuinely saw nothing: check the format you typed.'
      Hint 'An Aadhaar is only detected in 4-4-4 form (1234 5678 9012), not as 12 unbroken digits.'
    } elseif ($released.Count -gt 0) {
      Err 'Messages were held but never classified - see the released lines in stage 5.'
      Hint 'Nothing was inspected, so nothing could be blocked. Fix that first.'
    } else {
      Info 'No message has been classified yet.'
      if ($ver.Count -and ($ver[0] -notmatch '1\.2\.[3-9]|1\.[3-9]|[2-9]\.')) {
        Hint 'On agents older than 1.2.3 the verdict lines are DEBUG, so an agent logging at'
        Hint 'INFO shows this message even when inspection is working. Update to 1.2.3+.'
      }
    }

    # ---- stage 7: did the block reach the console? ------------------------
    #
    # This stage exists because of a real and very expensive failure: messages
    # WERE being blocked on the endpoint - dialog on screen, keystroke dropped -
    # and not one of those blocks produced an event, an alert or an incident in
    # the console. Blocking that leaves no record is indistinguishable from not
    # blocking at all the moment anyone asks for evidence.
    Blank
    Write-Host '   STAGE 7  Did it reach the console?' -ForegroundColor Cyan

    $blocked7 = @($lines | Where-Object { $_ -match 'MESSAGING_TEXT_(BLOCKED|ALERT|LATE)' })
    $dropped  = @($lines | Where-Object { $_ -match 'DROPPING EVENTS|Dropping event because no active policies' } | Select-Object -Last 3)
    $failed   = @($lines | Where-Object { $_ -match 'Failed to send event \(HTTP' } | Select-Object -Last 5)
    $spooled  = @($lines | Where-Object { $_ -match 'spooled event\(s\)|Event spool is FULL' } | Select-Object -Last 3)

    # The spool is the physical evidence: every event the server refused or
    # never answered is written here and replayed later, so a file that exists
    # and is growing IS the answer to "where did my alerts go".
    $spoolFile = $null
    foreach ($d in @($INSTALL_DIR, $LEGACY_DIR, "$DATA_DIR\logs", "$LEGACY_DATA\logs")) {
      if ($d -and (Test-Path (Join-Path $d 'cybersentineldlp_events.spool'))) {
        $spoolFile = Get-Item (Join-Path $d 'cybersentineldlp_events.spool'); break
      }
    }

    if ($dropped.Count -gt 0) {
      Err 'The agent DISCARDED its own events - they never left this machine:'
      foreach ($l in $dropped) { Write-LogLine (Format-MsgLine $l) }
      Hint 'Before 1.2.8 the agent only sent events when it held a file, clipboard or USB policy.'
      Hint 'Messaging, print, app-control and network-share policies are fetched separately and did'
      Hint 'not count, so an endpoint whose only policy was the messaging one blocked messages and'
      Hint 'threw away every record of it. 1.2.8 counts all of them. If you see this line dated'
      Hint 'AFTER updating to 1.2.8, this agent genuinely has no policy assigned in any channel.'
    }
    if ($failed.Count -gt 0) {
      Err 'The server REFUSED events (they are spooled on disk, not lost):'
      foreach ($l in $failed) { Write-LogLine (Format-MsgLine $l) }
      Hint 'From 1.2.8 the line carries the server''s own answer. "422" names the field it rejected;'
      Hint 'the whole event is discarded on a 422, which is why one bad field costs the entire'
      Hint 'record. 401/403 = the agent key. 000/timeout = it cannot reach the manager at all.'
    }
    if ($spoolFile) {
      $kb = [math]::Round($spoolFile.Length / 1KB, 1)
      Warn "Event spool present: $($spoolFile.FullName) - ${kb} KB, last written $($spoolFile.LastWriteTime)"
      Hint 'Every line in that file is an event the server did not accept. It is replayed on the'
      Hint 'next successful heartbeat, so fix the cause and the backlog lands by itself.'
    }
    if ($spooled.Count -gt 0) { foreach ($l in $spooled) { Write-LogLine (Format-MsgLine $l) } }

    if ($blocked7.Count -gt 0 -and $dropped.Count -eq 0 -and $failed.Count -eq 0 -and -not $spoolFile) {
      Ok "$($blocked7.Count) enforcement action(s) recorded, and nothing reports a delivery failure."
      Hint 'The events were accepted by the manager. In the console they appear under'
      Hint 'Events with type "messaging" (channel MESSAGING), and a blocked Confidential or'
      Hint 'Restricted message also raises an incident automatically.'
      Hint 'Still nothing there? Check you are looking at the right server and that the event list'
      Hint 'is not filtered to a date range or a single agent.'
    } elseif ($blocked7.Count -eq 0) {
      Info 'No enforcement action to deliver yet - block a message first (stage 6).'
    }

    Blank
    Hr '-' 'DarkCyan'
    Hint 'Test with a REAL test card number - the detector runs a Luhn checksum, so an'
    Hint 'invented 16-digit string is correctly ignored. These pass: 4111 1111 1111 1111'
    Hint '(Visa), 5500 0000 0000 0004 (Mastercard), 3400 0000 0000 009 (Amex).'
    Hint 'An Aadhaar must be in 4-4-4 form (1234 5678 9012), not 12 unbroken digits.'
    Hint 'Phone numbers are deliberately NOT selected by default - they are ordinary chat traffic.'
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
      Write-Host '   [5] ' -ForegroundColor Cyan -NoNewline; Write-Host 'Chat / typed-message control - why is nothing happening?'
      Write-Host '   [6] ' -ForegroundColor Cyan -NoNewline; Write-Host 'Back to main menu'
      Blank
      $c = Read-Host '   Choose (1-6)'
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
        '5' {
          try { Show-MessagingDiagnostics -LogPath $log.FullName }
          catch { Err "Diagnostics failed: $($_.Exception.Message)" }
        }
        '6' { return }
        default { Warn 'Enter a number from 1 to 6.' }
      }
    }
  }

  # ============================================================
  #  Windows Security  (Defender / ASR / Controlled folder access)
  # ============================================================
  #
  # The agent is an unsigned binary that installs a low-level keyboard hook,
  # reads print spool files and watches removable media. Every one of those is
  # also what a keylogger does, and without an Authenticode signature there is
  # nothing to tell Defender which of the two this is. A freshly built binary
  # additionally has zero prevalence in Defender's cloud, so first-sight
  # heuristics apply on the very build you are trying to roll out.
  #
  # The real fix is code signing. Until there is a certificate, the supported
  # answer is an explicit exclusion - which is a deliberate, visible act by an
  # administrator, so it is a menu entry and never something Install does
  # quietly on your behalf.

  function Get-SmartAppControlState {
    # Smart App Control (Win11 22H2+) blocks unsigned binaries outright and
    # ignores Defender exclusions entirely, so it has to be reported separately
    # or the exclusions below look broken.
    try {
      $v = (Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' `
              -Name 'VerifiedAndReputablePolicyState' -ErrorAction Stop).VerifiedAndReputablePolicyState
      switch ($v) { 0 { 'off' } 1 { 'ON' } 2 { 'evaluation' } default { "unknown ($v)" } }
    } catch { 'not present' }
  }

  # Defender policy for this script, in one place. It has exactly one allowed
  # write and a permanent forbidden list.
  #
  # ALLOWED: registering the agent's own install and data directories as path
  # exclusions. That is an ordinary installer step for an unsigned agent whose
  # whole job looks like the software it is built to catch, it is scoped to two
  # directories this script created itself, and without it the binary is taken
  # mid-download - the file is scanned as it is written, so the exclusion has
  # to be in place BEFORE the fetch, not after.
  #
  # FORBIDDEN, permanently: turning real-time, behaviour or cloud protection
  # off, removing definitions, and pulling files back out of quarantine. An
  # earlier revision did that last one - restore from quarantine, then exempt
  # the folder, unattended - and AMSI quarantined this script as
  # Trojan:PowerShell/Killav.VDA!MTB. That verdict was fair: a downloaded
  # installer that quietly weakens antivirus is dangerous whoever wrote it. An
  # exclusion narrows what gets scanned in future; the forbidden list changes
  # whether scanning happens at all, and overrides a verdict Defender has
  # already reached on a specific file.
  #
  # The consequence is that a copy Defender has ALREADY taken cannot be
  # recovered from here, and nothing below tries. The exclusion stops the NEXT
  # copy being taken, and Update downloads a fresh binary into the now-excluded
  # directory - which is why recovery works without anyone opening Windows
  # Security. Show-AgentDefenderSteps stays as the fallback for when the write
  # is refused: Defender managed by Intune or group policy, or a third-party AV
  # in charge. The durable fix is still an Authenticode signature on the agent,
  # which is also the only thing that satisfies Smart App Control.
  # Readable is reported separately from Missing, because "Defender says there
  # is no exclusion" and "we could not ask Defender" are different facts that
  # were previously collapsed into the same alarming sentence. Get-MpPreference
  # throws on plenty of healthy machines - the Defender module missing from a
  # Server Core image, WMI wedged, a third-party AV having taken over - and
  # treating that as a definite "no exclusion" both cries wolf on the way in
  # and, worse, reports a freshly added exclusion as REFUSED on the way out.
  #
  # Note that Protection history > Allow on device does NOT create a path
  # exclusion. It clears one specific detection on one specific file, so the
  # binary survives while Missing stays non-empty. That combination is honest
  # rather than contradictory, and it is why the download can succeed on a
  # machine this still reports as unexcluded.
  function Get-AgentExclusionState {
    $have = $null
    try { $have = @((Get-MpPreference -ErrorAction Stop).ExclusionPath) }
    catch { return [PSCustomObject]@{ Readable = $false; Missing = @($INSTALL_DIR, $DATA_DIR) } }
    $missing = @()
    foreach ($p in @($INSTALL_DIR, $DATA_DIR)) {
      if (-not $p) { continue }
      $t = $p.TrimEnd('\')
      $hit = @($have) | Where-Object { $_ -and $_.TrimEnd('\') -ieq $t }
      if (-not $hit) { $missing += $p }
    }
    # Missing is built with @() and assigned to a property, so it survives as an
    # array. Emitting a bare list from a function would not: the pipeline
    # unrolls it, an empty one becomes nothing and a single entry becomes a
    # string, and every @(...).Count at a call site then reads wrong.
    [PSCustomObject]@{ Readable = $true; Missing = $missing }
  }

  function Set-AgentDefenderExclusions {
    param([switch]$Brief)
    if (-not (Get-Command Add-MpPreference -ErrorAction SilentlyContinue)) {
      return (Show-AgentDefenderSteps -Brief:$Brief)
    }
    $before = Get-AgentExclusionState
    if ($before.Readable -and @($before.Missing).Count -eq 0) {
      if (-not $Brief) { Ok 'Defender already excludes the agent directories' }
      return $true
    }
    if (-not $isAdmin) { return (Show-AgentDefenderSteps -Brief:$Brief) }

    $failed = @()
    foreach ($p in @($before.Missing)) {
      try { Add-MpPreference -ExclusionPath $p -ErrorAction Stop }
      catch { $failed += $p }
    }

    # Read it back rather than trusting the call to have worked. Where Defender
    # is managed centrally the cmdlet returns without an error and changes
    # nothing, which would otherwise look like success right up until the
    # download is eaten again.
    $after = Get-AgentExclusionState
    if ($after.Readable) {
      if (@($after.Missing).Count -gt 0) {
        Warn 'Defender would not accept the exclusion - it is managed by policy, or another AV is in charge.'
        return (Show-AgentDefenderSteps -Brief:$Brief)
      }
      Ok "Defender exclusion registered for $INSTALL_DIR and $DATA_DIR"
    } elseif (@($failed).Count -gt 0) {
      Warn "Defender rejected the exclusion for: $($failed -join ', ')"
      return (Show-AgentDefenderSteps -Brief:$Brief)
    } else {
      # The add did not error but the read-back is unavailable. Do not call that
      # a failure and send someone into Windows Security for nothing.
      Ok "Defender exclusion submitted for $INSTALL_DIR and $DATA_DIR"
      Hint 'Defender preferences could not be read back, so this is unconfirmed.'
    }
    if (@(Get-AgentQuarantine).Count -gt 0) {
      Hint 'An already-quarantined copy stays quarantined; this script does not reach'
      Hint 'into quarantine. Update fetches a fresh binary instead, and that copy is'
      Hint 'covered by the exclusion just registered.'
    }
    return $true
  }

  function Show-AgentDefenderSteps {
    param([switch]$Brief)
    $q = @(Get-AgentQuarantine)
    $st = Get-AgentExclusionState
    $okPath = $st.Readable -and @($st.Missing).Count -eq 0
    if ($okPath -and $q.Count -eq 0) {
      if (-not $Brief) { Ok "Defender exclusion already present for $INSTALL_DIR" }
      return $true
    }

    Blank
    if ($q.Count -gt 0) { Warn "Defender has acted on the agent $($q.Count) time(s)." }
    if (-not $st.Readable) { Warn 'Could not read Defender exclusions on this device.' }
    elseif (-not $okPath)  { Warn "No Defender exclusion covers $($st.Missing -join ' or ')." }
    Hint 'The agent is unsigned and behaves like the software it is built to catch,'
    Hint 'so Defender judges it on behaviour and quarantines it. This script could'
    Hint 'not register the exclusion itself, so an administrator has to do it in'
    Hint 'Windows Security, in this order:'
    Blank
    if ($q.Count -gt 0) {
      Write-Host '    1. Virus & threat protection > Protection history' -ForegroundColor Yellow
      Write-Host '       Find the agent entry, Actions > Allow on device.' -ForegroundColor Yellow
      Write-Host '       Do this FIRST: exempting a folder Defender has already' -ForegroundColor DarkYellow
      Write-Host '       emptied looks like it worked and leaves you no binary.' -ForegroundColor DarkYellow
      Blank
    }
    Write-Host '    2. Virus & threat protection > Manage settings >'         -ForegroundColor Yellow
    Write-Host '       Exclusions > Add an exclusion > Folder:'               -ForegroundColor Yellow
    Write-Host "         $INSTALL_DIR"                                        -ForegroundColor White
    Write-Host "         $DATA_DIR"                                           -ForegroundColor White
    Blank
    Hint 'Then re-run this script. On a fleet, configure those exclusions through'
    Hint 'Intune or group policy instead. The durable fix is an Authenticode'
    Hint 'signature on the agent - that also covers Smart App Control, which'
    Hint 'blocks unsigned binaries and ignores exclusions entirely.'
    return $false
  }

  function Get-AgentQuarantine {
    # Threats whose resources name our install dir. Get-MpThreat lists what is
    # currently held; Get-MpThreatDetection lists what has been acted on.
    $hits = @()
    foreach ($cmd in 'Get-MpThreat','Get-MpThreatDetection') {
      if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { continue }
      try {
        foreach ($t in @(& $cmd -ErrorAction Stop)) {
          $res = @($t.Resources) -join ' '
          if ($res -match [regex]::Escape($PROC_NAME) -or $res -match [regex]::Escape($INSTALL_DIR)) {
            $hits += [PSCustomObject]@{
              Name = $t.ThreatName; Detected = $t.InitialDetectionTime; Resources = $res
            }
          }
        }
      } catch {}
    }
    $hits
  }

  function Show-Defender {
    param($s)
    Blank; Hr '=' 'Cyan'
    Write-Host '   WINDOWS SECURITY' -ForegroundColor Cyan
    Hr '=' 'Cyan'; Blank

    if (-not (Get-Command Get-MpComputerStatus -ErrorAction SilentlyContinue)) {
      Warn 'Microsoft Defender cmdlets are not available on this device.'
      Hint 'A third-party antivirus is probably managing protection instead -'
      Hint "exclude $INSTALL_DIR and $PROC_NAME.exe there by hand."
      Blank; Read-Host '   Press Enter to return to the menu' | Out-Null; return
    }

    $mp = $null; try { $mp = Get-MpComputerStatus -ErrorAction Stop } catch {}
    $pref = $null; try { $pref = Get-MpPreference -ErrorAction Stop } catch {}
    if ($mp) {
      Field 'Real-time' $(if ($mp.RealTimeProtectionEnabled) { 'on' } else { 'off' })
      Field 'Tamper prot' $(if ($mp.IsTamperProtected) { 'on' } else { 'off' })
    }
    $sac = Get-SmartAppControlState
    Field 'Smart App Ctl' $sac $(if ($sac -eq 'ON') { 'Red' } else { 'Gray' })

    $exPath = @(); $exProc = @()
    if ($pref) { $exPath = @($pref.ExclusionPath); $exProc = @($pref.ExclusionProcess) }
    $hasPath = ($exPath | Where-Object { $_ -and $_.TrimEnd('\') -ieq $INSTALL_DIR.TrimEnd('\') }).Count -gt 0
    $hasProc = ($exProc | Where-Object { $_ -and $_ -imatch [regex]::Escape($PROC_NAME) }).Count -gt 0
    Field 'Excluded' $(if ($hasPath -and $hasProc) { 'yes (path + process)' }
                       elseif ($hasPath -or $hasProc) { 'PARTIAL' } else { 'no' }) `
                     $(if ($hasPath -and $hasProc) { 'Green' } else { 'Yellow' })

    $q = @(Get-AgentQuarantine)
    if ($q.Count -gt 0) {
      Blank; Err "Defender has acted on the agent $($q.Count) time(s):"
      foreach ($h in ($q | Select-Object -First 5)) {
        Hint ("  {0}  {1}" -f $h.Detected, $h.Name)
      }
    } elseif (-not (Test-Path (Join-Path $INSTALL_DIR $EXE_NAME))) {
      Blank; Err 'The agent binary is missing from disk and no detection is recorded.'
      Hint 'It may have been removed by something other than Defender.'
    } else {
      Blank; Ok 'No Defender detection recorded against the agent.'
    }

    if ($sac -eq 'ON') {
      Blank
      Err 'Smart App Control is ON. It blocks unsigned binaries and IGNORES exclusions.'
      Hint 'Nothing below will make the agent run while it is on. It can only be'
      Hint 'turned off (Windows Security -> App & browser control -> Smart App'
      Hint 'Control), and Windows makes that permanent until the OS is reinstalled.'
    }

    Blank
    Write-Host '   [1] Allow the agent  ' -ForegroundColor Green -NoNewline
    Write-Host '- exclude its directories so the next copy is not taken'
    Write-Host '   [2] Show recent blocks' -ForegroundColor Yellow -NoNewline
    Write-Host ' - Defender / ASR / folder-access events naming the agent'
    Write-Host '   [3] Back            ' -ForegroundColor Gray -NoNewline
    Write-Host '- return without changing anything'
    Blank
    switch ((Read-Host '   Choose an option (1-3)').Trim()) {
      '1' { Invoke-DefenderAllow }
      '2' { Show-DefenderEvents }
      default { return }
    }
    Blank; Read-Host '   Press Enter to return to the menu' | Out-Null
  }

  function Invoke-DefenderAllow {
    Blank; Write-Host '   Allowing the agent in Microsoft Defender' -ForegroundColor Cyan; Hr '-' 'DarkCyan'
    if (-not $isAdmin) { Err 'This needs Administrator. Re-run the script elevated.'; return }

    # Registers the path exclusions. Never touches a protection setting and
    # never reaches into quarantine - see the policy note above
    # Set-AgentDefenderExclusions.
    if (-not (Set-AgentDefenderExclusions)) { return }

    $exe = Join-Path $INSTALL_DIR $EXE_NAME
    if (-not (Test-Path $exe)) {
      Blank; Warn 'The exclusion is in place but the binary is gone - Defender removed it.'
      Hint 'Use [2] Update from the main menu to fetch a fresh copy; it will not be'
      Hint 'quarantined again now that the exclusion is present.'
      return
    }
    Blank; Info 'Restarting the agent...'
    Start-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
    $proc = Wait-AgentProcess -TimeoutSeconds 25
    if ($proc) {
      $v = $null; try { $v = (Get-Item $proc.Path).VersionInfo.ProductVersion } catch {}
      if ($v) { Ok "Agent v$($v.Trim()) running (PID $($proc.Id))." } else { Ok "Agent running (PID $($proc.Id))." }
    } else {
      Show-AgentStartFailure
    }
  }

  function Show-DefenderEvents {
    Blank; Write-Host '   Recent Windows Security events naming the agent' -ForegroundColor Cyan; Hr '-' 'DarkCyan'
    # 1116/1117 malware detected/acted on, 1015 behaviour, 1121 ASR block,
    # 1123 controlled folder access block. Each has a different fix, so they are
    # reported as found rather than collapsed into "Defender blocked it".
    $ids = 1006,1007,1015,1116,1117,1121,1123
    try {
      $ev = Get-WinEvent -FilterHashtable @{
              LogName = 'Microsoft-Windows-Windows Defender/Operational'; Id = $ids
            } -MaxEvents 200 -ErrorAction Stop |
            Where-Object { $_.Message -imatch [regex]::Escape($PROC_NAME) -or
                           $_.Message -imatch [regex]::Escape($INSTALL_DIR) } |
            Select-Object -First 10
      if (-not $ev) { Ok 'No Defender events mention the agent.'; return }
      foreach ($e in $ev) {
        Blank
        Field 'When' $e.TimeCreated.ToString('yyyy-MM-dd HH:mm:ss')
        Field 'Event' ("{0} - {1}" -f $e.Id, $(switch ($e.Id) {
          1121 { 'blocked by an Attack Surface Reduction rule' }
          1123 { 'blocked by Controlled folder access' }
          1015 { 'suspicious behaviour detected' }
          1116 { 'malware detected' }
          1117 { 'action taken on detected malware' }
          default { 'Defender event' }
        }))
        $m = ($e.Message -split "`n" | Where-Object { $_ -match 'Name:|Path:|Detection|Rule' } |
              Select-Object -First 3) -join '; '
        if ($m) { Hint ("  " + $m.Trim()) }
      }
      Blank
      Hint 'ASR (1121) and folder access (1123) are NOT fixed by an antivirus'
      Hint 'exclusion - they need their own allow entry in that feature.'
    } catch {
      Warn 'Could not read the Defender event log.'
      Hint "  $($_.Exception.Message)"
    }
    Show-CodeIntegrityEvents
  }

  # Code integrity is a different subsystem from the antivirus, with a different
  # log and no relationship to exclusions. It is what produces "we can't confirm
  # who published <exe> that the app tried to load" - the app being svchost.exe,
  # because Task Scheduler is what launches the agent. Missing this log is how a
  # signing problem gets mistaken for a malware detection and chased with
  # exclusions that could never have worked.
  function Show-CodeIntegrityEvents {
    Blank; Write-Host '   Code integrity (Smart App Control / WDAC)' -ForegroundColor Cyan; Hr '-' 'DarkCyan'
    $sac = Get-SmartAppControlState
    Field 'Smart App Ctl' $sac $(if ($sac -eq 'ON') { 'Red' } else { 'Gray' })
    try {
      $ci = Get-WinEvent -LogName 'Microsoft-Windows-CodeIntegrity/Operational' `
              -MaxEvents 200 -ErrorAction Stop |
            Where-Object { $_.Message -imatch [regex]::Escape($PROC_NAME) } |
            Select-Object -First 5
      if (-not $ci) {
        Ok 'No code-integrity event mentions the agent.'
      } else {
        foreach ($e in $ci) {
          Blank
          Field 'When'  $e.TimeCreated.ToString('yyyy-MM-dd HH:mm:ss')
          Field 'Event' ("{0} - {1}" -f $e.Id, $(switch ($e.Id) {
            3076 { 'would have been blocked (audit mode)' }
            3077 { 'BLOCKED - the binary is not signed or not trusted' }
            3033 { 'failed code-integrity checks' }
            default { 'code-integrity event' }
          })) $(if ($e.Id -eq 3077) { 'Red' } else { 'Yellow' })
        }
        Blank
        Err 'This is NOT an antivirus detection and an exclusion cannot fix it.'
        Hint 'The agent is unsigned. Either sign the binary, or turn off Smart App'
        Hint 'Control (Windows Security -> App & browser control), which Windows'
        Hint 'makes permanent until the OS is reinstalled.'
      }
    } catch {
      Hint '  (no code-integrity log on this device - the feature is not active)'
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

  # -- Browsers ----------------------------------------------------------
  #
  # One table, one place. Everything else - force-install, managed config,
  # private browsing, removal - reads from here, so a browser can never be
  # half-handled by one function and missed by another.
  #
  # THE VALUE NAMES ARE NOT INTERCHANGEABLE. Chrome reads
  # IncognitoModeAvailability; Edge reads InPrivateModeAvailability. Writing
  # Chrome's name into Edge's key does nothing whatsoever, and reads back looking
  # exactly like success - which is how Edge stayed open while the screen said it
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
  # endpoint. That pre-staging is the useful behaviour - claiming the browser is
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
  # per-browser setting - pushing them here would give an endpoint a way to
  # disagree with the policy that is supposed to govern it.
  # Writes ONLY wantVersion. Deliberately separate from Set-ManagedConfig: the
  # update path does not know the server URL or the agent id, and calling the
  # full writer there would have blanked both - silently detaching the extension
  # from its server while appearing to do nothing but nudge a version.
  function Set-ManagedWantVersion {
    param([string]$Root, [string]$ExtId, [string]$WantVersion)
    if (-not $WantVersion) { return }
    $mp = Join-Path $Root "3rdparty\extensions\$ExtId\policy"
    if (-not (Test-Path $mp)) { New-Item -Path $mp -Force | Out-Null }
    Set-ItemProperty -Path $mp -Name 'wantVersion' -Value $WantVersion -Type String
  }

  function Set-ManagedConfig {
    param([string]$Root, [string]$ExtId, [string]$ServerUrl, [string]$AgentId, [string]$WantVersion)
    $mp = Join-Path $Root "3rdparty\extensions\$ExtId\policy"
    if (-not (Test-Path $mp)) { New-Item -Path $mp -Force | Out-Null }
    Set-ItemProperty -Path $mp -Name 'serverUrl' -Value $ServerUrl -Type String
    if ($AgentId) { Set-ItemProperty -Path $mp -Name 'agentId' -Value $AgentId -Type String }
    else { Remove-ItemProperty -Path $mp -Name 'agentId' -ErrorAction SilentlyContinue }
    # Nothing outside the browser can press "check for updates". Managed policy,
    # though, reaches a RUNNING extension immediately - so writing the published
    # version here and letting the extension notice it change is the remote
    # equivalent of pressing the button. The extension ignores it when it
    # already matches its own version.
    if ($WantVersion) { Set-ItemProperty -Path $mp -Name 'wantVersion' -Value $WantVersion -Type String }
  }

  # InPrivate / Incognito coverage.
  #
  # There is NO browser policy that turns an extension on in InPrivate. Chrome
  # and Edge require the user to tick "Allow in InPrivate" per extension, by
  # design, and enterprise policy cannot tick it for them - so a force-installed
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

  # -- Making an update actually happen ----------------------------------
  #
  # Writing the force-install policy does NOT deploy a new build. It tells the
  # browser which extension to keep installed; the browser then checks the update
  # feed on its own schedule - roughly every few hours - so a freshly published
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
  # "did the update land?" - the version is the name of the folder the browser
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
  # deliberate - you debug the extension you deploy - but it means a leftover
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
    Hint 'They will be asked to close normally, so open tabs are restored on the'
    Hint 'next launch. Anything unsaved - a half-written mail, a form, an upload'
    Hint 'in progress - is the user\'s to deal with, so do not run this on a'
    Hint 'machine somebody is working on.'
    $go = Read-Host '   Close them now? (Y/n)'
    if ($go -eq 'n' -or $go -eq 'N') { Warn 'Left running - the refresh was skipped.'; return $false }

    # Ask politely, then WAIT. The previous version allowed two seconds before
    # force-killing whatever was left, which is not long enough for a browser to
    # flush session state - so the "polite" close was decoration and the real
    # mechanism was the kill. On a machine in use that discards open tabs.
    #
    # Force is now a separate, explicit decision, taken only after a real grace
    # period and only by someone who has been told what it costs.
    foreach ($n in $running) {
      Info "Asking $n to close..."
      Get-Process -Name $n -ErrorAction SilentlyContinue | ForEach-Object {
        $null = $_.CloseMainWindow()
      }
    }

    $graceUntil = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $graceUntil) {
      $left = @($names | Where-Object { Get-Process -Name $_ -ErrorAction SilentlyContinue })
      if (@($left).Count -eq 0) { break }
      $secs = [int]($graceUntil - (Get-Date)).TotalSeconds
      Write-Host ("`r   waiting for $($left -join ' and ') to close  ({0}s)   " -f $secs) -NoNewline
      Start-Sleep -Milliseconds 700
    }
    Write-Host ("`r" + (' ' * 66) + "`r") -NoNewline

    $stubborn = @($names | Where-Object { Get-Process -Name $_ -ErrorAction SilentlyContinue })
    if (@($stubborn).Count -gt 0) {
      Blank
      Warn "$($stubborn -join ' and ') did not exit."
      Hint 'Usually a dialog waiting on an answer, or background processes kept'
      Hint 'alive by "continue running background apps" / startup boost.'
      Hint 'Forcing it closes them immediately and DISCARDS anything unsaved.'
      $force = Read-Host '   Force them closed? (y/N)'
      if ($force -eq 'y' -or $force -eq 'Y') {
        foreach ($n in $stubborn) {
          Get-Process -Name $n -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        }
      } else {
        Warn 'Left running - the refresh was skipped.'
        return $false
      }
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
        # Second, independent lever: a running extension sees this change at once
        # and asks the browser to check its feed. Belt and braces, because the
        # two fail differently - the policy above is the browser's decision, this
        # one is the extension's request.
        Set-ManagedWantVersion -Root $b.Root -ExtId $ExtId -WantVersion $WantVersion
        Info "$($b.Name): minimum version $WantVersion, extension asked to check"
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

    # -- 1. stop force-installing it ---------------------------------------
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

    # -- 2. check the browser really did forget it -------------------------
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
          Set-ManagedConfig -Root $b.Root -ExtId $ExtId -ServerUrl $ApiBase -AgentId $AgentId -WantVersion $WantVersion
        }
        Ok 'Policy restored.'
      } catch { Err "Could not restore the policy: $($_.Exception.Message)" }
      return
    }
    Ok 'The browser uninstalled it and cleared its record.'

    # -- 3. force it again -------------------------------------------------
    try {
      foreach ($b in $BROWSERS) {
        $null = Set-ForcelistEntry -Root $b.Root -ExtId $ExtId -UpdateUrl $UpdateUrl
        Set-ExtensionSettingsPolicy -Root $b.Root -ExtId $ExtId -UpdateUrl $UpdateUrl -MinVersion $WantVersion
        Set-ManagedConfig -Root $b.Root -ExtId $ExtId -ServerUrl $ApiBase -AgentId $AgentId -WantVersion $WantVersion
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
  # nothing - so it is a confirmation, not a trap.
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

  # Read a policy value through an EXPLICIT registry view, ignoring whatever
  # view this process would be given by default.
  #
  # This exists because of the failure mode it detects. On 64-bit Windows a
  # 32-bit PowerShell has every HKLM:\SOFTWARE\Policies\... access silently
  # redirected into HKLM\SOFTWARE\WOW6432Node\Policies\..., while the browser
  # reads the 64-bit view. The script then WRITES policy the browser cannot see
  # and READS it back from the same redirected hive - so it reports success,
  # every time, on changes that never reached Chrome. Deploy looks fine, Repair
  # appears to withdraw the policy, Remove appears to remove it, and the
  # extension sits there unchanged through all of it.
  function Get-PolicyValueInView {
    param([string]$SubKey, [string]$Name, [ValidateSet('Registry64','Registry32')][string]$View)
    try {
      $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, $View)
      $k = $base.OpenSubKey($SubKey)
      if (-not $k) { return $null }
      if ($Name) { return $k.GetValue($Name) }
      $vals = @{}
      foreach ($n in $k.GetValueNames()) { $vals[$n] = $k.GetValue($n) }
      return $vals
    } catch { return $null }
  }

  # Everything the browser's own view of the world says, in one screen.
  #
  # Written after three separate "fixes" that each looked right and changed
  # nothing on the endpoint. The problem was never the mechanism, it was that
  # nothing here reported what the BROWSER could see - only what this script had
  # done. Those are different, and the gap between them is where every one of
  # those attempts died.
  function Show-ExtensionDiagnostics {
    param([string]$ExtId, [string]$WantVersion, [string]$UpdateUrl)

    Blank
    Hr '=' 'Cyan'
    Write-Host '   EXTENSION DIAGNOSTICS' -ForegroundColor Cyan
    Hr '=' 'Cyan'

    # 1. The trap that makes every other line here a lie.
    Blank
    Write-Host '   Registry view' -ForegroundColor White
    $procBits = if ([Environment]::Is64BitProcess) { '64-bit' } else { '32-bit' }
    $osBits   = if ([Environment]::Is64BitOperatingSystem) { '64-bit' } else { '32-bit' }
    Field '  PowerShell' $procBits
    Field '  Windows'    $osBits
    if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) {
      Err '  32-bit PowerShell on 64-bit Windows: every policy write from this'
      Err '  script is redirected to WOW6432Node and the browser never sees it.'
      Hint '  Re-run this script with the 64-bit PowerShell:'
      Hint '    %SystemRoot%\sysnative\WindowsPowerShell\v1.0\powershell.exe'
    } else {
      Ok '  Not redirected - writes land where the browser reads.'
    }

    # 2. What the browser actually reads, taken from the 64-bit view directly.
    foreach ($b in $BROWSERS) {
      Blank
      Write-Host "   $($b.Name) policy (64-bit view - what the browser reads)" -ForegroundColor White
      $sub = $b.Root -replace '^HKLM:\\', ''

      $fl = Get-PolicyValueInView -SubKey "$sub\ExtensionInstallForcelist" -Name $null -View Registry64
      if (-not $fl -or $fl.Count -eq 0) {
        Err '  ExtensionInstallForcelist: EMPTY - the browser is not being told to install anything.'
      } else {
        $mine = @($fl.Values | Where-Object { "$_" -like "$ExtId;*" })
        if (@($mine).Count -gt 0) { Ok "  ExtensionInstallForcelist: our entry present" }
        else { Err "  ExtensionInstallForcelist: $($fl.Count) entr(y/ies), NONE ours" }
      }

      $es = Get-PolicyValueInView -SubKey $sub -Name 'ExtensionSettings' -View Registry64
      if (-not $es) {
        Warn '  ExtensionSettings: absent - no minimum_version_required, so an old build satisfies policy.'
      } else {
        try {
          $entry = ($es | ConvertFrom-Json).$ExtId
          if (-not $entry) { Warn '  ExtensionSettings: present, but no entry for our extension.' }
          else { Ok "  ExtensionSettings: installation_mode=$($entry.installation_mode) minimum_version_required=$($entry.minimum_version_required)" }
        } catch { Err '  ExtensionSettings: present but NOT VALID JSON - the browser ignores the whole policy.' }
      }

      $mv = Get-PolicyValueInView -SubKey "$sub\3rdparty\extensions\$ExtId\policy" -Name 'wantVersion' -View Registry64
      Field '  managed wantVersion' $(if ($mv) { $mv } else { '(not set)' })
    }

    # 3. Redirected copies, which are the fingerprint of the trap above.
    $shadow = $false
    foreach ($b in $BROWSERS) {
      $sub = $b.Root -replace '^HKLM:\\', ''
      $fl32 = Get-PolicyValueInView -SubKey "$sub\ExtensionInstallForcelist" -Name $null -View Registry32
      if ($fl32 -and $fl32.Count -gt 0) { $shadow = $true }
    }
    if ($shadow) {
      Blank
      Warn '   A COPY OF THIS POLICY EXISTS UNDER WOW6432Node.'
      Hint '   Written by a 32-bit process at some point. The browser ignores that'
      Hint '   view entirely, so it is not what is stopping an update - but it is a'
      Hint '   second, stale copy of a security policy, and leaving it there means'
      Hint '   the next person to read the registry finds two answers.'
      Blank
      $drop = Read-Host '   Delete the WOW6432Node copy? (y/N)'
      if ($drop -eq 'y' -or $drop -eq 'Y') {
        foreach ($b in $BROWSERS) {
          $sub = $b.Root -replace '^HKLM:\\', ''
          try {
            $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, 'Registry32')
            $k = $base.OpenSubKey("$sub\\ExtensionInstallForcelist", $true)
            if ($k) {
              foreach ($n in @($k.GetValueNames())) {
                if ("$($k.GetValue($n))" -like "$ExtId;*") { $k.DeleteValue($n, $false) }
              }
              $k.Close()
              Ok "  $($b.Name): removed the redirected copy"
            }
          } catch { Warn "  $($b.Name): could not clean it - $($_.Exception.Message)" }
        }
      }
    }

    # 4. Is the browser actually running, and does it have windows?
    #
    # These are different questions and the difference is the whole problem.
    # Edge keeps background processes alive after the last window closes
    # (startup boost / "continue running background apps"), so "I closed it"
    # routinely means the process never exited - and a browser that never
    # exits never re-reads policy or re-runs a force-install.
    Blank
    Write-Host '   Browser processes' -ForegroundColor White
    foreach ($b in $BROWSERS) {
      $all = @(Get-Process -Name $b.Process -ErrorAction SilentlyContinue)
      $win = @($all | Where-Object { $_.MainWindowHandle -ne 0 })
      if (@($all).Count -eq 0) { Field "  $($b.Name)" 'not running' }
      elseif (@($win).Count -eq 0) {
        Field "  $($b.Name)" "$(@($all).Count) background process(es), NO window"
        Hint "    Closed but still resident - it has not restarted, so policy is stale."
        Hint "    Turn off Settings > System > 'Continue running background apps'"
        Hint "    and 'Startup boost', then close it; or just leave it - the"
        Hint "    extension self-updates from v2.8.0 and needs no restart at all."
        Hint "    Last resort on a machine nobody is using, and it DISCARDS open"
        Hint "    tabs:  taskkill /IM $($b.Exe) /F"
      }
      else { Field "  $($b.Name)" "running, $(@($win).Count) window(s)" }
    }

    # 5. What is actually installed.
    Blank
    Write-Host '   Installed on disk' -ForegroundColor White
    $inst = @(Get-InstalledExtensionVersions $ExtId)
    if (@($inst).Count -eq 0) { Warn '  not present in any profile' }
    else { foreach ($i in $inst) { Field "  $($i.Browser) / $($i.User) / $($i.Profile)" "v$($i.Version)" } }
    Field '  published on the server' "v$WantVersion"

    # 5. Can this machine reach the feed at all?
    Blank
    Write-Host '   Update feed' -ForegroundColor White
    Field '  url' $UpdateUrl
    try {
      $r = Invoke-WebRequest -Uri $UpdateUrl -UseBasicParsing -TimeoutSec 10
      # Match the <updatecheck> version, NOT the first version= in the document.
      # The XML declaration is <?xml version='1.0'?>, so a loose match reports
      # "advertises v1.0" on a perfectly good feed - which is exactly what the
      # first run of this diagnostic did, on the one line that mattered most.
      $m = [regex]::Match($r.Content, "<updatecheck[^>]*\sversion=['""]([^'""]+)['""]")
      if (-not $m.Success) {
        $m = [regex]::Match($r.Content, "codebase=['""][^'""]+['""]\s+version=['""]([^'""]+)['""]")
      }
      if ($m.Success) {
        $feedVer = $m.Groups[1].Value
        if ($feedVer -eq $WantVersion) { Ok "  reachable - advertises v$feedVer" }
        else { Warn "  reachable, but advertises v$feedVer while the server publishes v$WantVersion" }

        # The manifest is only half of it. The browser then downloads the CRX
        # from `codebase`, and THAT is the fetch that actually delivers the new
        # build - a reachable manifest with an unreachable package looks exactly
        # like "nothing is happening".
        $cb = [regex]::Match($r.Content, "codebase=['""]([^'""]+)['""]")
        if ($cb.Success) {
          $crxUrl = $cb.Groups[1].Value
          Field '  package url' $crxUrl
          # HEAD first because it is cheap, then fall back to a ranged GET.
          # An older server serves this route as GET-only and answers HEAD with
          # 405 - which this reported as "PACKAGE NOT reachable" on a server the
          # browser was downloading from perfectly well. Test the verb the
          # BROWSER uses before calling it unreachable.
          $pkgOk = $false
          try {
            $h = Invoke-WebRequest -Uri $crxUrl -UseBasicParsing -TimeoutSec 30 -Method Head
            $len = $h.Headers['Content-Length']
            Ok "  package reachable - $([math]::Round(([int64]$len)/1MB,1)) MB, $($h.Headers['Content-Type'])"
            $pkgOk = $true
          } catch {
            $code = $null
            if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
            if ($code -eq 405) { Info '  (server does not answer HEAD - retrying the way the browser fetches it)' }
            else { Warn "  HEAD failed ($($_.Exception.Message)) - retrying as GET" }
            try {
              $g = Invoke-WebRequest -Uri $crxUrl -UseBasicParsing -TimeoutSec 60 `
                                     -Headers @{ Range = 'bytes=0-2047' }
              $magic = ''
              if ($g.Content -and $g.Content.Length -ge 4) {
                $magic = -join ([char[]]$g.Content[0..3])
              }
              if ($magic -eq 'Cr24') { Ok '  package reachable and is a valid CRX' ; $pkgOk = $true }
              else { Ok '  package reachable' ; $pkgOk = $true }
            } catch {
              Err "  PACKAGE NOT reachable: $($_.Exception.Message)"
              Hint '  The manifest resolves but the .crx does not. The browser can see'
              Hint '  that an update exists and cannot download it, which is silent.'
            }
          }
        }
      }
      else { Warn '  reachable, but the response is not an update manifest' }
    } catch {
      Err "  NOT reachable from this machine: $($_.Exception.Message)"
      Hint '  The browser fetches this itself. If this fails, no update can ever arrive.'
    }
    Blank
    Hr '=' 'Cyan'
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
      Write-Host '   [5] ' -ForegroundColor Cyan    -NoNewline; Write-Host 'Diagnose         - what the BROWSER sees, not what this script did'
      Write-Host '   [6] ' -ForegroundColor Gray    -NoNewline; Write-Host 'Back to main menu'
      Blank
      $c = Read-Host '   Choose (1-6)'
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
              Set-ManagedConfig -Root $b.Root -ExtId $extId -ServerUrl $apiBase -AgentId $agentId -WantVersion $info.version
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
              # different answers. Either it has never been installed here - a
              # browser start fixes that - or it WAS installed and its files
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
        '5' {
          Show-ExtensionDiagnostics -ExtId $extId -WantVersion $info.version -UpdateUrl $updateUrl
          Blank; Read-Host '   Press Enter to continue' | Out-Null
        }
        '6' { return }
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
    $remoteHash = $null; $remoteVersion = $null
    if ($s.ExeExists -and $s.ExeHash) {
      # One spinner, both sidecars: the sha decides whether an update exists, the
      # version says what it is called. The .version file is absent on builds
      # made before versioning, so a missing one is not an error.
      $remote = Invoke-Spinner -Text 'Checking for the latest agent build' -ArgumentList @($SUM_URL, $VER_URL, $GH_HEADERS) -Work {
        param($sumUrl, $verUrl, $hdr)
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $h = $null; $v = $null
        try { $h = ((Invoke-WebRequest -Uri $sumUrl -UseBasicParsing -Headers $hdr -ErrorAction Stop).Content).Trim().Split()[0].ToUpper() } catch { }
        try { $v = ((Invoke-WebRequest -Uri $verUrl -UseBasicParsing -Headers $hdr -ErrorAction Stop).Content).Trim() } catch { }
        [PSCustomObject]@{ Hash = $h; Version = $v }
      }
      if ($remote) { $remoteHash = $remote.Hash; $remoteVersion = $remote.Version }
    }
    Show-Status $s $remoteHash $remoteVersion

    Blank
    Write-Host '   [1] Install    ' -ForegroundColor Green  -NoNewline; Write-Host '- set up the agent on this device'
    Write-Host '   [2] Update     ' -ForegroundColor Cyan   -NoNewline; Write-Host '- fetch the latest build and repair the install'
    Write-Host '   [3] Uninstall  ' -ForegroundColor Red    -NoNewline; Write-Host '- stop and completely remove the agent'
    Write-Host '   [4] Logs       ' -ForegroundColor Yellow -NoNewline; Write-Host '- view / follow the agent log file'
    Write-Host '   [5] Extension  ' -ForegroundColor Magenta -NoNewline; Write-Host '- force-install the browser extension (web + AI control)'
    Write-Host '   [6] Security   ' -ForegroundColor Blue    -NoNewline; Write-Host '- Windows Defender blocked the agent? diagnose and allow it'
    Write-Host '   [7] Exit       ' -ForegroundColor Gray   -NoNewline; Write-Host '- do nothing and quit'
    Blank
    $choice = Read-Host '   Choose an option (1-7)'

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
      '6' {
        try { Show-Defender $s } catch { Err "Security step failed: $($_.Exception.Message)" }
      }
      '7' { Blank; Info 'Exiting - no changes made.'; return }
      default { Blank; Warn 'Invalid choice - please enter a number from 1 to 7.'; Start-Sleep -Milliseconds 900 }
    }
  }
}
