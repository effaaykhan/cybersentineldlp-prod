<#
.SYNOPSIS
    Generates 24 MB DLP test samples: sensitive + normal, as PDF and ZIP.

.DESCRIPTION
    These probe the boundary BELOW the agent's 25 MiB inspection cap
    (MAX_FILE_SIZE in agent.cpp / MAX_EXTRACT_BYTES in document_extract.py).
    A file this size is still fully inspected, so the decision must come from
    the CONTENT, not the size — the opposite of the >25 MB "too_large" test.

    Expected results when copied to a monitored USB drive:
        sensitive-24mb.pdf  -> Restricted -> BLOCKED  (content)
        sensitive-24mb.zip  -> Restricted -> BLOCKED  (content, read inside archive)
        normal-24mb.pdf     -> Public     -> ALLOWED
        normal-24mb.zip     -> Public     -> ALLOWED

    Padding is CRYPTOGRAPHIC RANDOM bytes on purpose:
      * random data is incompressible, so the .zip stays ~24 MB on disk
        (zeroes from `fsutil createnew` compress ~1000:1 and never reach the cap);
      * random bytes are not text, so the extractor discards them instead of
        spending the 1,000,000-character classifier budget (MAX_TEXT_CHARS) on
        padding, which would push the real content out of the scan window.

    In the PDF the padding is a valid but UNREFERENCED stream object: the file
    stays structurally valid and opens in any viewer, yet no text extractor
    ever turns the padding into characters.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\New-DlpSizeSamples.ps1
#>
[CmdletBinding()]
param(
    [string]$OutDir = "$env:USERPROFILE\dlp-samples",
    [int]$PadBytes = 24000000
)

$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 does not load these by default, so [ZipArchive] /
# [ZipArchiveMode] / [CompressionLevel] resolve only after an explicit load.
# PowerShell 7 already has them and the load is a harmless no-op there, hence
# the tolerant catch. ZipArchive+ZipArchiveMode+CompressionLevel live in
# System.IO.Compression; ZipFile lives in System.IO.Compression.FileSystem.
foreach ($assembly in 'System.IO.Compression', 'System.IO.Compression.FileSystem') {
    try { Add-Type -AssemblyName $assembly -ErrorAction Stop } catch { }
}
if (-not ('System.IO.Compression.ZipArchiveMode' -as [type])) {
    throw "Could not load System.IO.Compression. PowerShell 5.1+ / .NET 4.5+ is required."
}

# Deliberately high-weight, unambiguous detectors (rules table: AWS Access Key
# 0.95, Credit Card 0.95, SSN 0.9). Any one alone clears the >=0.8 "Restricted"
# threshold, so the test does not hinge on a single rule staying enabled.
# 4111 1111 1111 1111 is the standard Luhn-valid Visa test number.
$Sensitive = @(
    'CONFIDENTIAL - INTERNAL USE ONLY'
    'Customer payment record'
    'Card: 4111 1111 1111 1111'
    'SSN: 123-45-6789'
    'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE'
)

# Plain prose only. No e-mail addresses, IPs, phone numbers or financial/legal
# keywords — each of those carries weight (e.g. Email Address 0.3) and would
# drag a "normal" file up to Internal, muddying the result.
$Normal = @(
    'Team Offsite Notes'
    'The venue has been confirmed for the annual team offsite.'
    'Please bring comfortable shoes for the walking tour.'
    'Lunch will be provided on both days.'
)

function Add-Ascii {
    param($Stream, [string]$Text)
    $bytes = [System.Text.Encoding]::GetEncoding('ISO-8859-1').GetBytes($Text)
    $Stream.Write($bytes, 0, $bytes.Length)
}

function Add-RandomBytes {
    param($Stream, [int]$Count)
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $chunk = 1048576
        $buf = New-Object byte[] $chunk
        $left = $Count
        while ($left -gt 0) {
            $n = [Math]::Min($chunk, $left)
            if ($n -ne $buf.Length) { $buf = New-Object byte[] $n }
            $rng.GetBytes($buf)
            $Stream.Write($buf, 0, $n)
            $left -= $n
        }
    } finally { $rng.Dispose() }
}

function New-PaddedPdf {
    param([string]$Path, [string[]]$Lines, [int]$Pad)

    $fs = [System.IO.File]::Create($Path)
    try {
        $off = New-Object 'System.Int64[]' 7

        Add-Ascii $fs "%PDF-1.4`n"
        # Binary marker comment: tells tools the file is not pure ASCII.
        $fs.Write([byte[]]@(0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A), 0, 6)

        $off[1] = $fs.Position
        Add-Ascii $fs "1 0 obj`n<< /Type /Catalog /Pages 2 0 R >>`nendobj`n"

        $off[2] = $fs.Position
        Add-Ascii $fs "2 0 obj`n<< /Type /Pages /Kids [3 0 R] /Count 1 >>`nendobj`n"

        $off[3] = $fs.Position
        Add-Ascii $fs ("3 0 obj`n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
                       "/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`nendobj`n")

        $ops = "BT`n/F1 12 Tf`n72 720 Td`n14 TL`n"
        foreach ($line in $Lines) {
            $escaped = $line.Replace('\', '\\').Replace('(', '\(').Replace(')', '\)')
            $ops += "($escaped) Tj`nT*`n"
        }
        $ops += "ET`n"

        $off[4] = $fs.Position
        Add-Ascii $fs "4 0 obj`n<< /Length $($ops.Length) >>`nstream`n"
        Add-Ascii $fs $ops
        Add-Ascii $fs "endstream`nendobj`n"

        $off[5] = $fs.Position
        Add-Ascii $fs "5 0 obj`n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`nendobj`n"

        # Object 6: the padding. Valid object, correct /Length, referenced by
        # nothing — so it inflates the file without ever becoming text.
        $off[6] = $fs.Position
        Add-Ascii $fs "6 0 obj`n<< /Length $Pad >>`nstream`n"
        Add-RandomBytes $fs $Pad
        Add-Ascii $fs "`nendstream`nendobj`n"

        $xref = $fs.Position
        Add-Ascii $fs "xref`n0 7`n0000000000 65535 f `n"
        for ($i = 1; $i -le 6; $i++) {
            Add-Ascii $fs ('{0:D10} 00000 n {1}' -f $off[$i], "`n")
        }
        Add-Ascii $fs "trailer`n<< /Size 7 /Root 1 0 R >>`nstartxref`n$xref`n%%EOF`n"
    } finally { $fs.Close() }
}

function New-PaddedZip {
    param([string]$Path, [string]$EntryName, [string[]]$Lines, [int]$Pad)

    if (Test-Path $Path) { Remove-Item $Path -Force }
    $zs = [System.IO.File]::Create($Path)
    $za = New-Object System.IO.Compression.ZipArchive($zs, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        # The real content goes in FIRST. Archive members are concatenated in
        # entry order and the joined text is clipped at MAX_TEXT_CHARS, so
        # putting it first keeps it inside the classifier's scan window.
        $entry = $za.CreateEntry($EntryName)
        $s = $entry.Open()
        try { Add-Ascii $s (($Lines -join "`n") + "`n") } finally { $s.Close() }

        # Stored, not deflated: random data will not compress anyway, and this
        # keeps the archive's on-disk size exact and the run fast.
        # NB: not $pad — PowerShell variables are case-insensitive, so that
        # would silently overwrite the $Pad byte count parameter.
        $padEntry = $za.CreateEntry('zz-pad.bin', [System.IO.Compression.CompressionLevel]::NoCompression)
        $s = $padEntry.Open()
        try { Add-RandomBytes $s $Pad } finally { $s.Close() }
    } finally { $za.Dispose(); $zs.Close() }
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Write-Host "Generating 24 MB samples into $OutDir ..." -ForegroundColor Cyan
New-PaddedPdf (Join-Path $OutDir 'sensitive-24mb.pdf') $Sensitive $PadBytes
New-PaddedPdf (Join-Path $OutDir 'normal-24mb.pdf')    $Normal    $PadBytes
New-PaddedZip (Join-Path $OutDir 'sensitive-24mb.zip') '00-secret.txt' $Sensitive $PadBytes
New-PaddedZip (Join-Path $OutDir 'normal-24mb.zip')    '00-notes.txt'  $Normal    $PadBytes

Write-Host ''
Get-ChildItem $OutDir -Filter '*-24mb.*' | Sort-Object Name | ForEach-Object {
    $mib = [Math]::Round($_.Length / 1MB, 2)
    $cap = if ($_.Length -lt 26214400) { 'under 25 MiB cap - will be inspected' } else { 'OVER CAP - wrong!' }
    '{0,-22} {1,12:N0} bytes  {2,6} MiB  {3}' -f $_.Name, $_.Length, $mib, $cap
}
Write-Host ''
Write-Host 'Expected on USB copy:  sensitive-* = BLOCKED (Restricted) | normal-* = ALLOWED (Public)' -ForegroundColor Yellow
