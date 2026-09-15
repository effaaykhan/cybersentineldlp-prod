<#
  manage-windows-defender.ps1 - Windows Security helper for the CyberSentinel
  DLP agent.

  WHY THIS IS A SEPARATE FILE

  It used to live inside manage-windows-agent.ps1. That script is fetched over
  HTTP and executed, and it contained Add-MpPreference, Get-MpThreat and
  quarantine inspection - a downloaded script that reads the antivirus threat
  list and then writes exclusions for itself. Defender classified the whole
  installer as Trojan:PowerShell/Killav.VDA!MTB and AMSI refused to run any of
  it, so nothing could be installed at all.

  That verdict is not wrong. A downloaded installer that weakens antivirus is
  dangerous whoever wrote it, and a DLP agent is not entitled to an exception.
  So the installer no longer contains any of it: it resolves the server,
  downloads a binary, verifies its checksum, writes a config and registers a
  scheduled task. Nothing else.

  What remains here is the same code, in a tool an administrator fetches
  DELIBERATELY, knowing what it does, when Defender has taken the agent. It is
  still likely to be flagged for the same reason - that is the honest cost of
  the behaviour, and the remedy is not to disguise it.

  THE ACTUAL FIX, for both this and the binary, is an Authenticode signature.
  A signed agent is not heuristically quarantined, needs no exclusion, and
  satisfies Smart App Control. Until then a false-positive submission to
  Microsoft (aka.ms/wdsi) is the supported route, and it is free.

  NEVER add to this file: turning real-time, behaviour or cloud protection off,
  removing definitions, or pulling files back out of quarantine. An earlier
  revision restored from quarantine unattended and was correctly identified as
  VirTool:Win32/DefenderTamperingRestore. An exclusion narrows what is scanned
  in future; those change whether scanning happens at all.
#>

$ErrorActionPreference = 'Continue'

$INSTALL_DIR = 'C:\Program Files\CyberSentinelDLP'
$DATA_DIR    = 'C:\ProgramData\CyberSentinelDLP'
$EXE_NAME    = 'cybersentineldlp_agent.exe'
$TASK_NAME   = 'CyberSentinel DLP Agent'
$PROC_NAME   = 'cybersentineldlp_agent'
$BOX_W       = 64

if ([Console]::OutputEncoding.CodePage -ne 65001) {
  try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
}

function Hr    { param([string]$ch='-',[string]$c='DarkCyan') Write-Host ('  ' + ($ch * $BOX_W)) -ForegroundColor $c }
function Blank { Write-Host '' }
function Info  { param([string]$m) Write-Host "   [..] $m" -ForegroundColor Gray }
function Ok    { param([string]$m) Write-Host "   [OK] $m" -ForegroundColor Green }
function Warn  { param([string]$m) Write-Host "   [!!] $m" -ForegroundColor Yellow }
function Err   { param([string]$m) Write-Host "   [xx] $m" -ForegroundColor Red }
function Hint  { param([string]$m) Write-Host "   $m" -ForegroundColor DarkGray }
function Field { param([string]$k,[string]$v) Write-Host ("   {0,-14} {1}" -f $k, $v) }

$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

function Wait-AgentProcess {
  param([int]$TimeoutSeconds = 25)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $p = Get-Process -Name $PROC_NAME -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($p) { return $p }
    Start-Sleep -Milliseconds 500
  }
  return $null
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
    Warn 'The agent did not start. Run the installer console and use [4] Logs.'
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

# ── Entry point ───────────────────────────────────────────────────────────
Blank
Hr '=' 'Blue'
Write-Host '   CyberSentinel DLP - Windows Security helper' -ForegroundColor Blue
Hr '=' 'Blue'
if (-not $isAdmin) {
  Blank
  Err 'This needs Administrator. Re-open PowerShell with "Run as administrator".'
  Blank
  return
}
Show-Defender $null
