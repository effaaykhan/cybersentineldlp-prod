<#
.SYNOPSIS
    Completely removes the CyberSentinel DLP Windows agent (new and legacy).

.DESCRIPTION
    Stops the agent, removes its scheduled task(s) and any legacy service, and
    deletes the install and data directories — for BOTH the current
    "CyberSentinelDLP" layout and the pre-rename "CyberSentinel" layout, so this
    cleans up an endpoint no matter which version it is running.

    It does NOT deregister the agent from the server. After uninstall the agent
    simply stops sending heartbeats and shows as "disconnected" on the dashboard;
    delete it there if you want it gone from the fleet list.

.USAGE
    Run in an elevated PowerShell (Run as Administrator):
        powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/effaaykhan/cybersentineldlp-prod/main/uninstall-agent.ps1 | iex"
    or from a checkout:
        powershell -ExecutionPolicy Bypass -File .\uninstall-agent.ps1
#>
[CmdletBinding()]
param([switch]$Quiet)

$ErrorActionPreference = 'Continue'

function Info($m)  { Write-Host "[+] $m" -ForegroundColor Cyan }
function Ok($m)    { Write-Host "[+] $m" -ForegroundColor Green }
function Warn($m)  { Write-Host "[!] $m" -ForegroundColor Yellow }

# Require elevation: removing a scheduled task registered for another context and
# deleting under Program Files both need admin.
$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Warn "This uninstaller must run as Administrator. Re-open PowerShell with 'Run as administrator'."
    exit 1
}

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  CyberSentinel DLP Agent — Uninstaller" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

$TASK_NAMES = @("CyberSentinel DLP Agent", "CyberSentinelAgent", "CyberSentinel Agent")
$PROC_NAMES = @("cybersentineldlp_agent", "cybersentinel_agent")
$DIRS = @(
    "C:\Program Files\CyberSentinelDLP", "C:\ProgramData\CyberSentinelDLP",
    "C:\Program Files\CyberSentinel",    "C:\ProgramData\CyberSentinel"
)

$removed = $false

# 1. Stop the processes (exact names — the two never match each other).
foreach ($p in $PROC_NAMES) {
    Get-Process -Name $p -ErrorAction SilentlyContinue | ForEach-Object {
        Info "Stopping $($_.Name) (PID $($_.Id))"
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
        $removed = $true
    }
}

# 2. Remove scheduled tasks by known name AND by the path they launch, so a task
#    survives no matter what it was named. The path pattern matches BOTH the
#    "CyberSentinelDLP" and legacy "CyberSentinel" install dirs (this is the
#    uninstaller — unlike the installer, we want to remove every one of ours).
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

# 3. Remove any legacy Windows service.
foreach ($svcName in @("CyberSentinelAgent", "CyberSentinelDLPAgent")) {
    if (Get-Service -Name $svcName -ErrorAction SilentlyContinue) {
        Info "Removing service: $svcName"
        Stop-Service $svcName -Force -ErrorAction SilentlyContinue
        sc.exe delete $svcName 2>$null | Out-Null
        $removed = $true
    }
}

# 4. Delete install + data directories (both layouts).
foreach ($d in $DIRS) {
    if (Test-Path $d) {
        Info "Deleting $d"
        Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path $d) { Warn "Could not fully delete $d (a file may be locked — reboot and re-run)" }
        else { $removed = $true }
    }
}

Write-Host ""
if ($removed) {
    Ok "CyberSentinel DLP agent removed from this endpoint."
    Warn "It will show as 'disconnected' on the dashboard until you delete it there."
} else {
    Ok "No CyberSentinel DLP agent found — nothing to remove."
}
Write-Host ""
if (-not $Quiet) { Read-Host "Press Enter to exit" }
