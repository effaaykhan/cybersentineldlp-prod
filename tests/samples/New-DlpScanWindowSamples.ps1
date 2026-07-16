<#
.SYNOPSIS
    Generates samples that probe the CONTENT SCAN WINDOW, not the file-size cap.

.DESCRIPTION
    These validate the fix for the filler bypass: text past the scan budget was
    never examined, yet the read was reported complete — so a secret placed after
    the cut-off classified as Public and was allowed.

    All four files are far below the 25 MiB size cap, so nothing here is decided
    by size. The whole point is WHERE in the file the sensitive data sits.

    Expected results when copied to a monitored USB drive:

      scanwindow-secret-v1.txt      BLOCKED  Restricted, extraction=readable
          1.5M chars of filler, secret at the very end. Before the fix this was
          ALLOWED as Public — the secret sat past character 1,000,000 and was
          never scanned. Now it is found on content. THIS IS THE KEY TEST.

      scanwindow-secret-v1.zip      BLOCKED  Restricted, extraction=readable
          Same attack inside an archive: filler member first (aaa-), secret
          member second (zzz-). Members are scanned in entry order.

      scanwindow-clean-v1.txt       ALLOWED  Public
          5M chars, genuinely clean. The false-positive guard: proves the fix
          blocks on unscanned content, not merely on being large. Takes a few
          seconds to evaluate — that is the scan doing real work.

      scanwindow-overbudget-v1.txt  BLOCKED  extraction=too_large
          12M chars, secret at the end, past even the raised 10M budget. Cannot
          be fully scanned, so it must be refused rather than called clean.
          Expect level=Public with a BLOCK — correct, not a bug: the classifier
          honestly reports what it saw, and policy decides about what it didn't.

    Filenames end in -v1 on purpose. The agent keys evaluated files on
    drive+filename, so re-copying a name it has already seen is skipped. Bump to
    -v2 for a second run.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\New-DlpScanWindowSamples.ps1
#>
[CmdletBinding()]
param(
    [string]$OutDir = "$env:USERPROFILE\dlp-samples"
)

$ErrorActionPreference = 'Stop'

foreach ($assembly in 'System.IO.Compression', 'System.IO.Compression.FileSystem') {
    try { Add-Type -AssemblyName $assembly -ErrorAction Stop } catch { }
}
if (-not ('System.IO.Compression.ZipArchiveMode' -as [type])) {
    throw "Could not load System.IO.Compression. PowerShell 5.1+ / .NET 4.5+ is required."
}

# One high-weight detector is enough to clear the >=0.8 Restricted threshold
# (AWS Access Key carries 0.95), so the test does not hinge on several rules.
$Secret = "CONFIDENTIAL - customer export`nAWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE`nCard: 4111 1111 1111 1111`n"

# Deliberately inert prose: no e-mail, IP, phone, financial or legal keywords,
# each of which carries weight and would drag the "clean" file up to Internal.
$FillerLine = "The quarterly team offsite agenda item number seven for review.`n"

function Add-Filler {
    param($Stream, [int]$Chars)
    $chunk = $FillerLine * 1000
    $bytes = [System.Text.Encoding]::ASCII.GetBytes($chunk)
    $written = 0
    while ($written -lt $Chars) {
        $n = [Math]::Min($bytes.Length, $Chars - $written)
        $Stream.Write($bytes, 0, $n)
        $written += $n
    }
}

function Add-Text {
    param($Stream, [string]$Text)
    $bytes = [System.Text.Encoding]::ASCII.GetBytes($Text)
    $Stream.Write($bytes, 0, $bytes.Length)
}

function New-FillerFile {
    param([string]$Path, [int]$FillerChars, [string]$Trailer)
    $fs = [System.IO.File]::Create($Path)
    try {
        Add-Filler $fs $FillerChars
        if ($Trailer) { Add-Text $fs $Trailer }
    } finally { $fs.Close() }
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Write-Host "Generating scan-window samples into $OutDir ..." -ForegroundColor Cyan

# 1. The bypass itself: secret parked behind 1.5M chars of filler.
New-FillerFile (Join-Path $OutDir 'scanwindow-secret-v1.txt') 1500000 $Secret

# 2. False-positive guard: large but genuinely clean.
New-FillerFile (Join-Path $OutDir 'scanwindow-clean-v1.txt') 5000000 ''

# 3. Past even the raised budget: must be refused, not blessed.
New-FillerFile (Join-Path $OutDir 'scanwindow-overbudget-v1.txt') 12000000 $Secret

# 4. Same attack, archived. Filler member is written FIRST so the secret sits
#    behind it in entry order — exactly how the 87KB proof-of-concept worked.
$zipPath = Join-Path $OutDir 'scanwindow-secret-v1.zip'
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
$zs = [System.IO.File]::Create($zipPath)
$za = New-Object System.IO.Compression.ZipArchive($zs, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    $e = $za.CreateEntry('aaa-filler.txt')
    $s = $e.Open(); try { Add-Filler $s 1500000 } finally { $s.Close() }
    $e = $za.CreateEntry('zzz-secret.txt')
    $s = $e.Open(); try { Add-Text $s $Secret } finally { $s.Close() }
} finally { $za.Dispose(); $zs.Close() }

Write-Host ''
$expected = @{
    'scanwindow-secret-v1.txt'     = 'BLOCK  (Restricted - secret found past 1M chars)'
    'scanwindow-secret-v1.zip'     = 'BLOCK  (Restricted - secret found inside archive)'
    'scanwindow-clean-v1.txt'      = 'ALLOW  (Public - false-positive guard)'
    'scanwindow-overbudget-v1.txt' = 'BLOCK  (too_large - cannot be fully scanned)'
}
Get-ChildItem $OutDir -Filter 'scanwindow-*' | Sort-Object Name | ForEach-Object {
    '{0,-30} {1,12:N0} bytes   expect: {2}' -f $_.Name, $_.Length, $expected[$_.Name]
}
Write-Host ''
Write-Host 'All are far below the 25 MiB cap: these test WHERE the data sits, not file size.' -ForegroundColor Yellow
