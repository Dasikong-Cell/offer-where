# make_sfx.ps1 -- build OfferWhere-Setup.exe, the single-file self-extracting installer.
#
# Why this exists (2026-09-28): the portable zip needs two steps from the recipient
# ("extract to an English path, then find and double-click start_all.bat"), and step two
# is where people get lost -- an 180k-entry archive dumps a wall of files with no obvious
# entry point. The SFX collapses that into: download ONE file, double-click it, confirm,
# and the first-run Install dialog appears by itself.
#
# File layout produced:
#   [ stub.exe (PE) ][ payload: job-apply-agent-portable.zip ][ footer: 24 bytes ]
#   footer = "OFWSFX01" (8) + uint64 payloadOffset + uint64 payloadLength
# The stub seeks to EOF-24 to find it. Little-endian, which is what every Windows target is.
#
# The magic string and the footer size are NOT restated here as literals: they are read
# out of tools/sfx/offerwhere_sfx.c and asserted. If someone edits the stub's footer, this
# script fails loudly instead of quietly producing a file the stub cannot open.
#
# Usage:
#   ./make_sfx.ps1                      # pack zip from PACK_ZIP_DIR/Desktop -> OfferWhere-Setup.exe
#   ./make_sfx.ps1 -Zip D:\x\pkg.zip -Out D:\x\OfferWhere-Setup.exe
#   ./make_sfx.ps1 -SelfTest            # additionally run the produced exe unattended
#
# ASCII only, deliberately: PowerShell 5.1 reads a BOM-less script with the ANSI codepage,
# so any non-ASCII byte in here is a latent mojibake bug on someone else's machine.

[CmdletBinding()]
param(
  [string]$Stub,
  [string]$Zip,
  [string]$Out,
  [switch]$SelfTest,
  [string]$SelfTestDir,
  [switch]$KeepExtracted,
  [int]$SelfTestTimeoutSec = 900
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

# Deletions go through .NET, never through Remove-Item. Reason (learned the hard way): some
# Windows environments interpose a "safe delete" shim that routes Remove-Item to the Recycle
# Bin, and the Recycle Bin refuses a 360MB exe ("Some operations were aborted") -- the shim
# then throws and aborts this whole script at the first overwrite. A build tool must not
# depend on the shell's trash policy for artifacts it created itself.
function Remove-FileForce([string]$path) {
  if (Test-Path -LiteralPath $path) { [System.IO.File]::Delete($path) }
}
function Remove-TreeForce([string]$path) {
  if (Test-Path -LiteralPath $path) { [System.IO.Directory]::Delete($path, $true) }
}

function Say([string]$msg) { Write-Host $msg }

# ---------------------------------------------------------------- paths
if (-not $Stub) { $Stub = Join-Path $root 'tools\sfx\build\stub.exe' }
if (-not $Zip) {
  $dir = $env:PACK_ZIP_DIR
  if (-not $dir) { $dir = [Environment]::GetFolderPath('Desktop') }
  $Zip = Join-Path $dir 'job-apply-agent-portable.zip'
}
if (-not $Out) { $Out = Join-Path (Split-Path -Parent $Zip) 'OfferWhere-Setup.exe' }

foreach ($p in @($Stub, $Zip)) {
  if (-not (Test-Path -LiteralPath $p)) { throw "missing input: $p" }
}
$stubLen = (Get-Item -LiteralPath $Stub).Length
$zipLen = (Get-Item -LiteralPath $Zip).Length
Say ("stub : " + $Stub + "  " + $stubLen + " bytes")
Say ("zip  : " + $Zip + "  " + [math]::Round($zipLen / 1MB, 1) + " MB")
Say ("out  : " + $Out)

# ------------------------------------------------- footer contract (single source of truth)
$cSrc = Join-Path $root 'tools\sfx\offerwhere_sfx.c'
if (-not (Test-Path -LiteralPath $cSrc)) { throw "missing stub source: $cSrc" }
$cText = Get-Content -LiteralPath $cSrc -Raw
$magicM = [regex]::Match($cText, "FOOTER_MAGIC\[8\]\s*=\s*\{([^}]*)\}")
if (-not $magicM.Success) { throw 'cannot read FOOTER_MAGIC from offerwhere_sfx.c' }
$magic = -join ([regex]::Matches($magicM.Groups[1].Value, "'(.)'") | ForEach-Object { $_.Groups[1].Value })
$sizeM = [regex]::Match($cText, '#define\s+FOOTER_SIZE\s+(\d+)')
if (-not $sizeM.Success) { throw 'cannot read FOOTER_SIZE from offerwhere_sfx.c' }
$footerSize = [int]$sizeM.Groups[1].Value
if ($magic.Length -ne 8) { throw ("stub FOOTER_MAGIC must be 8 chars, got '" + $magic + "'") }
if ($footerSize -ne ($magic.Length + 16)) {
  throw ("stub FOOTER_SIZE=" + $footerSize + " disagrees with magic length " + $magic.Length + " (+16 for two uint64)")
}
Say ("footer: '" + $magic + "' + 2 x uint64 = " + $footerSize + " bytes (read from the stub source)")

# ---------------------------------------------------------------- build
Remove-FileForce $Out
$fs = [System.IO.File]::Create($Out)
$bw = New-Object System.IO.BinaryWriter($fs)
try {
  # The stub is ~75KB, so reading it whole is cheaper than streaming it.
  $stubBytes = [System.IO.File]::ReadAllBytes($Stub)
  $bw.Write($stubBytes)
  $zin = [System.IO.File]::OpenRead($Zip)
  try {
    $buf = New-Object byte[] (1MB)
    while (($n = $zin.Read($buf, 0, $buf.Length)) -gt 0) { $bw.Write($buf, 0, $n) }
  } finally { $zin.Close() }
  $bw.Write([System.Text.Encoding]::ASCII.GetBytes($magic))
  $bw.Write([uint64]$stubLen)
  $bw.Write([uint64]$zipLen)
} finally {
  $bw.Flush()
  $bw.Close()
}

# ------------------------------------------------- structural verification (no extraction)
function Get-SliceSha256 {
  param([string]$Path, [long]$Offset, [long]$Length)
  $s = [System.IO.File]::OpenRead($Path)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $s.Position = $Offset
    $buf = New-Object byte[] (1MB)
    $left = $Length
    while ($left -gt 0) {
      $want = [int][Math]::Min([long]$buf.Length, $left)
      $read = $s.Read($buf, 0, $want)
      if ($read -le 0) { throw 'unexpected EOF while hashing the payload slice' }
      $sha.TransformBlock($buf, 0, $read, $null, 0) | Out-Null
      $left -= $read
    }
    $sha.TransformFinalBlock((New-Object byte[] 0), 0, 0) | Out-Null
    return (([BitConverter]::ToString($sha.Hash)) -replace '-', '')
  } finally {
    $sha.Dispose()
    $s.Close()
  }
}

$checks = New-Object System.Collections.Generic.List[string]
$failed = 0
function Check([string]$name, [bool]$ok, [string]$detail) {
  if ($ok) { $checks.Add('  [ok]   ' + $name + '  ' + $detail) }
  else { $checks.Add('  [FAIL] ' + $name + '  ' + $detail); $script:failed++ }
}

$outLen = (Get-Item -LiteralPath $Out).Length
Check 'output size = stub + zip + footer' ($outLen -eq ($stubLen + $zipLen + $footerSize)) `
  ($outLen.ToString() + ' vs ' + ($stubLen + $zipLen + $footerSize).ToString())

$f = [System.IO.File]::OpenRead($Out)
try {
  $f.Position = $outLen - $footerSize
  $fb = New-Object byte[] $footerSize
  $got = $f.Read($fb, 0, $footerSize)
} finally { $f.Close() }
Check 'footer readable' ($got -eq $footerSize) ($got.ToString() + ' of ' + $footerSize + ' bytes')
$fMagic = [System.Text.Encoding]::ASCII.GetString($fb, 0, 8)
$fOff = [BitConverter]::ToUInt64($fb, 8)
$fLen = [BitConverter]::ToUInt64($fb, 16)
Check "footer magic = $magic" ($fMagic -eq $magic) ("got '" + $fMagic + "'")
Check 'footer offset = stub size' ($fOff -eq [uint64]$stubLen) ($fOff.ToString() + ' vs ' + $stubLen.ToString())
Check 'footer length = zip size' ($fLen -eq [uint64]$zipLen) ($fLen.ToString() + ' vs ' + $zipLen.ToString())
Check 'payload range inside the file' (($fOff + $fLen) -le [uint64]$outLen) (($fOff + $fLen).ToString() + ' <= ' + $outLen.ToString())

# Read the first 4 bytes of the payload: a zip must start with PK\x03\x04. Cheap, and it
# catches "footer points at the wrong offset" even when the sizes happen to line up.
$f2 = [System.IO.File]::OpenRead($Out)
try {
  $f2.Position = [long]$fOff
  $sig = New-Object byte[] 4
  $null = $f2.Read($sig, 0, 4)
} finally { $f2.Close() }
$sigOk = ($sig[0] -eq 0x50) -and ($sig[1] -eq 0x4B) -and ($sig[2] -eq 3) -and ($sig[3] -eq 4)
Check 'payload begins with the zip signature (PK 03 04)' $sigOk `
  (($sig | ForEach-Object { $_.ToString('X2') }) -join ' ')

$srcSha = (Get-FileHash -LiteralPath $Zip -Algorithm SHA256).Hash.ToLower()
$sliceSha = (Get-SliceSha256 -Path $Out -Offset ([long]$fOff) -Length ([long]$fLen)).ToLower()
Check 'embedded payload sha256 = zip sha256' ($srcSha -eq $sliceSha) ($sliceSha.Substring(0, 16) + '... vs ' + $srcSha.Substring(0, 16) + '...')

$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
if (Test-Path -LiteralPath $tar) {
  $listing = & $tar -tf $Zip 2>&1
  $need = @('install_first_run.bat', 'start_all.bat', 'setenv.bat', 'create_desktop_shortcut.bat', 'dist-app/offer-where.exe')
  $missing = @($need | Where-Object { $listing -notcontains $_ })
  Check 'payload zip holds the install chain' ($missing.Count -eq 0) `
    ($(if ($missing.Count -eq 0) { $need.Count.ToString() + ' required entries present' } else { 'missing: ' + ($missing -join ', ') }))
  Check 'payload zip entry count' ($listing.Count -gt 100000) ($listing.Count.ToString() + ' entries')
} else {
  Check 'tar.exe available for listing' $false 'not found'
}

Say ''
Say '======== structural verification ========'
foreach ($c in $checks) { Say $c }
if ($failed -gt 0) {
  Say ('FAILED: ' + $failed + ' check(s)')
  Say '========================================'
  exit 1
}
Say 'all structural checks passed'
Say '========================================'

# ------------------------------------------------- unattended end-to-end (opt-in)
# This is the only check that exercises copy_payload + tar extraction + the dest check,
# i.e. the real code path a recipient triggers. It costs a full extraction, so it is
# opt-in; structural checks above are the cheap default.
if ($SelfTest) {
  $dest = $SelfTestDir
  if (-not $dest) { $dest = Join-Path $env:TEMP ('ow-sfxtest-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)) }
  $log = Join-Path $env:TEMP ('ow-sfxlog-' + [Guid]::NewGuid().ToString('N').Substring(0, 8) + '.txt')
  if (Test-Path -LiteralPath $dest) { Remove-TreeForce $dest }
  Say ''
  Say ('self-test: running the produced exe unattended -> ' + $dest)
  $env:OFFERWHERE_SFX_DEST = $dest
  $env:OFFERWHERE_SFX_LOG = $log
  # Silent mode is supposed to install WITHOUT starting the app. Rather than trust that,
  # count the running shells before and after: an unattended run that silently launched a
  # GUI would otherwise look identical to a clean one.
  $procsBefore = @(Get-Process -Name 'offer-where' -ErrorAction SilentlyContinue).Count
  $t0 = Get-Date
  # Must NOT be a bare `& $Out --extract-only`. PowerShell does not wait for a GUI
  # subsystem binary (the stub is built -mwindows), so `&` returns the moment the process is
  # created: the checks then run against a half-written directory and the cleanup can delete
  # the destination out from under a running extraction. That is not a theory -- the first
  # run of this script did exactly that and reported 5 bogus failures.
  # ProcessStartInfo + WaitForExit gives a real wait AND a real timeout.
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Out
  $psi.Arguments = '--extract-only'
  $psi.UseShellExecute = $false
  $proc = [System.Diagnostics.Process]::Start($psi)
  $exited = $proc.WaitForExit($SelfTestTimeoutSec * 1000)
  if (-not $exited) {
    try { $proc.Kill() } catch { }
    throw ('self-test timed out after ' + $SelfTestTimeoutSec + 's -- the installer never returned')
  }
  $rc = $proc.ExitCode
  $proc.Dispose()
  Remove-Item Env:\OFFERWHERE_SFX_DEST -ErrorAction SilentlyContinue
  Remove-Item Env:\OFFERWHERE_SFX_LOG -ErrorAction SilentlyContinue
  $procsAfter = @(Get-Process -Name 'offer-where' -ErrorAction SilentlyContinue).Count
  $elapsed = ((Get-Date) - $t0).TotalSeconds
  $shell = Join-Path $dest 'dist-app\offer-where.exe'
  $logText = ''
  # The stub writes the step log as UTF-8 bytes (see its logline()). PowerShell 5.1 defaults
  # to the ANSI codepage, which turns any non-ASCII path in that log into mojibake -- exactly
  # the kind of garbled output that makes a failure report useless. Say UTF-8 here.
  if (Test-Path -LiteralPath $log) { $logText = Get-Content -LiteralPath $log -Raw -Encoding UTF8 }
  Say ('  exit code     : ' + $rc)
  Say ('  elapsed       : ' + [math]::Round($elapsed, 1) + ' s')
  Say ('  shell present : ' + (Test-Path -LiteralPath $shell))
  Say ('  shells running: ' + $procsBefore + ' -> ' + $procsAfter)
  # Measure what an install actually costs. These two numbers are quoted to the user in the
  # stub's own confirm dialog and in the Release notes, so they get measured, not guessed --
  # the text previously said "about 360k files, needs 1.2GB free" and had never once been
  # checked against a real extraction.
  if (Test-Path -LiteralPath $dest) {
    $stat = Get-ChildItem -LiteralPath $dest -Recurse -File -Force -ErrorAction SilentlyContinue |
      Measure-Object -Property Length -Sum
    Say ('  extracted     : ' + $stat.Count + ' files, ' + [math]::Round($stat.Sum / 1MB, 0) + ' MB on disk')
  }
  Say '  step log      :'
  foreach ($l in ($logText -split "`r?`n")) { if ($l.Trim()) { Say ('    ' + $l.Trim()) } }

  $st = New-Object System.Collections.Generic.List[string]
  $stFailed = 0
  function StCheck([string]$name, [bool]$ok, [string]$detail) {
    if ($ok) { $st.Add('  [ok]   ' + $name + '  ' + $detail) }
    else { $st.Add('  [FAIL] ' + $name + '  ' + $detail); $script:stFailed++ }
  }
  StCheck 'unattended exit code 0' ($rc -eq 0) ($rc.ToString())
  StCheck 'native shell extracted' (Test-Path -LiteralPath $shell) $shell
  StCheck 'start_all.bat extracted' (Test-Path -LiteralPath (Join-Path $dest 'start_all.bat')) ''
  StCheck 'install_first_run.bat extracted' (Test-Path -LiteralPath (Join-Path $dest 'install_first_run.bat')) ''
  StCheck 'log shows a clean run' ($logText -match '\[8\] ok') 'expects "[8] ok, shell present"'
  StCheck 'log shows the silent auto-confirm' ($logText -match '\[4\] confirmed') 'silent mode must confirm by itself'
  StCheck 'no app was launched' ($procsAfter -le $procsBefore) ($procsBefore.ToString() + ' -> ' + $procsAfter.ToString())
  StCheck 'dest differs from the default install dir' ($dest -notlike '*\OfferWhere') $dest
  Say ''
  Say '======== unattended self-test ========'
  foreach ($s in $st) { Say $s }
  Say ('======================================')

  # On failure the extracted tree is LEFT IN PLACE: deleting the evidence of a failure is
  # how you end up debugging the same bug twice. On success it is reclaimed (131k files).
  if ($stFailed -gt 0) {
    Say ('SELF-TEST FAILED: ' + $stFailed + ' check(s)')
    Say ('  left in place for inspection: ' + $dest)
    Say ('  step log kept at            : ' + $log)
    exit 1
  }
  if ($KeepExtracted) {
    Say ('self-test passed; tree kept at ' + $dest)
  } else {
    Remove-TreeForce $dest
    Remove-FileForce $log
    Say 'self-test passed (extracted tree reclaimed)'
  }
}

Say ''
Say ('OK: ' + $Out + '  ' + [math]::Round($outLen / 1MB, 1) + ' MB')
