<#
  update-agent.ps1 — fetch ONLY the latest CI-compiled agent binary and swap it in.

  Downloads cybersentineldlp_agent.exe (+ its .sha256) from the repo, verifies the
  hash, stops the running agent, replaces the binary in place, and restarts it.
  Configuration, logs and the scheduled task are left untouched — this updates the
  executable only.

  Run in an ELEVATED PowerShell (Run as Administrator). BOTH forms are safe — the
  whole body runs inside a script block and uses `return`, so piping into iex will
  NOT close your PowerShell window:
    irm https://raw.githubusercontent.com/effaaykhan/cybersentineldlp-prod/main/update-agent.ps1 | iex
    powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/effaaykhan/cybersentineldlp-prod/main/update-agent.ps1 | iex"
#>

& {
  $ErrorActionPreference = 'Stop'

  $GITHUB_REPO = 'effaaykhan/cybersentineldlp-prod'
  $RAW_BASE    = "https://raw.githubusercontent.com/$GITHUB_REPO/main"
  $INSTALL_DIR = 'C:\Program Files\CyberSentinelDLP'
  $EXE_NAME    = 'cybersentineldlp_agent.exe'
  $TASK_NAME   = 'CyberSentinel DLP Agent'
  $PROC_NAME   = 'cybersentineldlp_agent'

  $exePath = Join-Path $INSTALL_DIR $EXE_NAME
  $dlUrl   = "$RAW_BASE/agents/endpoint/windows/$EXE_NAME"
  $sumUrl  = "$dlUrl.sha256"
  $tmpExe  = Join-Path $env:TEMP $EXE_NAME

  function Info($m) { Write-Host "[*] $m" -ForegroundColor Cyan }
  function Ok($m)   { Write-Host "[+] $m" -ForegroundColor Green }
  function Err($m)  { Write-Host "[!] $m" -ForegroundColor Red }

  # 0) Must be elevated (write to Program Files + control the scheduled task).
  $admin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $admin) { Err "Run this in an ELEVATED PowerShell (Run as Administrator)."; return }
  if (-not (Test-Path $INSTALL_DIR)) { Err "Agent not found at $INSTALL_DIR - run install-agent.ps1 first."; return }

  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

  # 1) Download the new binary + its hash to a temp file (installed agent untouched yet).
  Info "Downloading latest agent binary..."
  try {
      Invoke-WebRequest -Uri $dlUrl -OutFile $tmpExe -UseBasicParsing
      $expected = (Invoke-WebRequest -Uri $sumUrl -UseBasicParsing).Content.Trim().Split()[0].ToUpper()
  } catch {
      Err "Download failed: $($_.Exception.Message)"; return
  }
  $actual = (Get-FileHash -Algorithm SHA256 -Path $tmpExe).Hash.ToUpper()
  if ($expected -ne $actual) {
      Remove-Item $tmpExe -Force -ErrorAction SilentlyContinue
      Err "SHA-256 mismatch - download corrupt. Installed agent left untouched."
      Err "  expected $expected"
      Err "  actual   $actual"
      return
  }
  $sizeMB = [math]::Round((Get-Item $tmpExe).Length / 1MB, 1)
  Ok "Downloaded + verified ($sizeMB MB, sha $($actual.Substring(0,12))...)"

  # 2) If it already matches what's installed, there's nothing to do.
  if (Test-Path $exePath) {
      $current = (Get-FileHash -Algorithm SHA256 -Path $exePath).Hash.ToUpper()
      if ($current -eq $actual) {
          Remove-Item $tmpExe -Force -ErrorAction SilentlyContinue
          Ok "Already up to date - agent binary is the latest. Nothing to do."
          return
      }
  }

  # 3) Stop the agent (scheduled task + process) so the .exe file unlocks.
  Info "Stopping agent..."
  Stop-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
  Get-Process -Name $PROC_NAME -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

  # 4) Back up the current binary, then replace it (retry: the lock can linger briefly).
  if (Test-Path $exePath) { Copy-Item $exePath "$exePath.bak" -Force -ErrorAction SilentlyContinue }
  $replaced = $false
  for ($i = 1; $i -le 10; $i++) {
      try { Copy-Item $tmpExe $exePath -Force; $replaced = $true; break }
      catch { Start-Sleep -Milliseconds 700 }   # still locked - let the process exit
  }
  Remove-Item $tmpExe -Force -ErrorAction SilentlyContinue
  if (-not $replaced) {
      Err "Could not replace $exePath (file still locked). Agent is stopped - retry, or reboot and retry."
      return
  }
  Ok "Binary replaced (previous kept as $EXE_NAME.bak)."

  # 5) Restart the agent and confirm it's running.
  Info "Starting agent..."
  Start-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
  $proc = Get-Process -Name $PROC_NAME -ErrorAction SilentlyContinue
  if ($proc) { Ok "Agent running (PID $($proc.Id)). Update complete." }
  else { Write-Host "[!] Agent not detected yet - start it with:  Start-ScheduledTask -TaskName '$TASK_NAME'" -ForegroundColor Yellow }
}
