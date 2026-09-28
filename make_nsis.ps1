# make_nsis.ps1 -- build OfferWhere-Setup.exe (the NSIS installer) from the portable zip.
#
# Why this exists (2026-09-28): the self-extracting exe solved "download one file, double-click
# it", but it could not give users what they expect from an installer -- a choosable directory,
# a Start Menu entry, and an entry in "Apps & features". This builds the installer that does,
# and it REPLACED the SFX as the published installer asset (the SFX source stays in the repo).
#
# What it embeds, and why that way
#   installer\offerwhere.nsi embeds the SAME job-apply-agent-portable.zip the SFX embeds, with
#   `SetCompress off`: the payload is already a zip, so a second compression pass buys ~0% and
#   costs minutes. Measured cost of embedding 362 MB this way: 3 s, +59 KB over the raw zip.
#   Unpacking is delegated to the system bsdtar, exactly like the SFX does.
#
# Usage:
#   ./make_nsis.ps1                          # pack zip from PACK_ZIP_DIR/Desktop -> OfferWhere-Setup.exe
#   ./make_nsis.ps1 -Zip D:\x\pkg.zip -Out D:\x\OfferWhere-Setup.exe
#   ./make_nsis.ps1 -SelfTest                # install silently, verify, then UNINSTALL silently and verify
#   ./make_nsis.ps1 -SelfTest -KeepExtracted # don't delete the installed tree (for inspection)
#
# -SelfTest touches this machine, and puts everything back: it installs into a throwaway temp
# directory, runs the uninstaller, and restores the registry keys, the desktop shortcut and the
# Start Menu entry it created. -KeepExtracted keeps only the installed tree; the registry and the
# shell entries are still restored, because those are the parts that leak invisibly.
#
# ASCII only, deliberately: PowerShell 5.1 reads a BOM-less script with the ANSI codepage, so
# any non-ASCII byte in here is a latent mojibake bug on someone else's machine.

[CmdletBinding()]
param(
  [string]$Zip,
  [string]$Out,
  [string]$Makensis,
  [string]$AppVer,
  [switch]$SelfTest,
  [string]$SelfTestDir,
  [switch]$KeepExtracted,
  [int]$SelfTestTimeoutSec = 1800
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

# Deletions go through .NET, never Remove-Item: some environments route Remove-Item to the
# Recycle Bin, which refuses multi-hundred-MB files and then throws, aborting the script.
function Remove-FileForce([string]$path) {
  if (Test-Path -LiteralPath $path) { [System.IO.File]::Delete($path) }
}
function Remove-TreeForce([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return }
  # An uninstaller that is still winding down keeps live handles in the tree it is deleting
  # (it runs from a copy of itself in %TEMP%\~nsu.tmp). Deleting concurrently throws
  # "access denied" on some arbitrary file -- on a 124k-file tree that is where the run
  # actually died. Retry the transient lock; rethrow if it never clears.
  for ($i = 0; $i -lt 10; $i++) {
    try { [System.IO.Directory]::Delete($path, $true); return } catch { Start-Sleep -Milliseconds 500 }
  }
  [System.IO.Directory]::Delete($path, $true)
}
function Say([string]$msg) { Write-Host $msg }

# Icon helpers. System.Drawing is not loaded in a fresh PowerShell 5.1 session, so it is
# loaded explicitly -- and a failure to load is reported as a check failure, never swallowed
# (a guard that quietly stops running is the failure mode this repo has already paid for).
Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
function Test-DrawingAvailable { return ($null -ne ('System.Drawing.Icon' -as [type])) }
# Hash a rendered bitmap rather than the file: the exe stores the icon as a PE resource, and
# the .ico stores it as a directory of images, so byte comparison is meaningless. Rendering
# both at 32x32 and hashing the pixels compares "what the user sees".
function Get-IconPixelHash($icon) {
  $bmp = $icon.ToBitmap()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $h = [System.Security.Cryptography.SHA256]::Create().ComputeHash($ms.ToArray())
  $bmp.Dispose()
  $ms.Dispose()
  return ([BitConverter]::ToString($h) -replace '-', '')
}

# Registry helpers for the self-test. They go through Microsoft.Win32.Registry rather than
# Remove-Item/New-Item on the HKCU: provider, for the same reason the file helpers go through
# .NET -- the hook that rewrites Remove-Item assumes a filesystem path.
# A snapshot is $null when the key does not exist, which is how the caller tells "this
# machine had no install" (so the self-test must clean up after itself) from "it had one"
# (so the self-test must put the original values back, not delete them).
function Get-RegSnapshot([string]$path) {
  $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($path)
  if (-not $k) { return $null }
  $snap = @{}
  foreach ($n in $k.GetValueNames()) {
    $snap[$n] = @{ Value = $k.GetValue($n, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); Kind = $k.GetValueKind($n) }
  }
  $k.Close()
  return $snap
}
function Remove-RegTree([string]$path) {
  $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($path)
  if ($k) { $k.Close(); [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($path, $false) }
}
# A dedicated existence test rather than `(Get-RegSnapshot p) -ne $null`: -ne on a hashtable
# goes through PowerShell's collection filtering and does not answer the question you asked.
function Test-RegKeyExists([string]$path) {
  $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($path)
  if ($k) { $k.Close(); return $true }
  return $false
}
function Restore-RegSnapshot([string]$path, $snap) {
  Remove-RegTree $path
  if ($null -eq $snap) { return }
  $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($path)
  if (-not $k) { return }
  foreach ($n in $snap.Keys) { $k.SetValue($n, $snap[$n].Value, $snap[$n].Kind) }
  $k.Close()
}

# ---------------------------------------------------------------- paths
if (-not $Zip) {
  $dir = $env:PACK_ZIP_DIR
  if (-not $dir) { $dir = [Environment]::GetFolderPath('Desktop') }
  $Zip = Join-Path $dir 'job-apply-agent-portable.zip'
}
if (-not $Out) { $Out = Join-Path (Split-Path -Parent $Zip) 'OfferWhere-Setup.exe' }
if (-not (Test-Path -LiteralPath $Zip)) { throw "missing input zip: $Zip" }

$nsi = Join-Path $root 'installer\offerwhere.nsi'
if (-not (Test-Path -LiteralPath $nsi)) { throw "missing installer script: $nsi" }

# NSIS's File command only treats a BACKSLASH as a path separator: an absolute path written
# with forward slashes is taken as one long file name and fails with "no files found"
# (verified 2026-09-28 against a minimal script, both slash directions). Normalise here so a
# caller passing slashes -- or any tool that rewrites them -- cannot produce that error.
$Zip = $Zip.Replace('/', '\')
$Out = $Out.Replace('/', '\')

# ---------------------------------------------------------------- script invariants
# The .nsi must stay pure ASCII. The Chinese UI comes from NSIS's own SimpChinese language
# files; the moment a non-ASCII byte enters the script, the build depends on the machine's
# code page and starts emitting mojibake on somebody else's box.
$nsiBytes = [System.IO.File]::ReadAllBytes($nsi)
$nonAscii = 0
foreach ($b in $nsiBytes) { if ($b -gt 127) { $nonAscii++ } }
if ($nonAscii -gt 0) {
  throw ("installer\offerwhere.nsi must be pure ASCII, found " + $nonAscii + " non-ASCII byte(s). Keep UI text in NSIS's language files, not in the script.")
}

# ---------------------------------------------------------------- version strings
# DisplayVersion is whatever the caller says (the release tag in CI). VIProductVersion needs
# four numeric fields, so derive them from a leading v<year>.<month>.<day> when present and
# fall back to 0.0.0.0 rather than failing the build over cosmetics.
#
# The version.json fallback cannot read a `version` key, because pack.ps1 does not write one:
# the stamp is {commit, builtAt, dirty}. Reading a key that is never there is not a fallback,
# it is a silent one -- and it used to end at the plausible-looking string "0.0.0", which then
# shows up verbatim as DisplayVersion in "Apps & features". So build the same shape the release
# tag has (v<date>-<shortcommit>) out of what the file actually contains.
#
# It lives in the REPO ROOT, not next to the zip: pack.ps1 writes it to $root and then puts the
# zip in $PACK_ZIP_DIR. Anchoring the lookup at (Split-Path -Parent $Zip) therefore missed it
# every single time -- the "fallback" could never fire, which is why the warning below is the
# first thing that ever told us so.
if (-not $AppVer) {
  $vj = Join-Path $root 'version.json'
  if (Test-Path -LiteralPath $vj) {
    try {
      $stamp = Get-Content -LiteralPath $vj -Raw | ConvertFrom-Json
      if ($stamp.version) {
        $AppVer = [string]$stamp.version
      } elseif ($stamp.builtAt) {
        $d = $null
        try { $d = [datetime]::Parse([string]$stamp.builtAt, [Globalization.CultureInfo]::InvariantCulture) } catch { $d = $null }
        if ($d) {
          $AppVer = 'v' + $d.ToString('yyyy.MM.dd', [Globalization.CultureInfo]::InvariantCulture)
          if ($stamp.commit) { $AppVer = $AppVer + '-' + [string]$stamp.commit }
          # Mark a build made from a working tree that had uncommitted changes. The release
          # tag never carries this suffix, so a local -SelfTest build cannot be mistaken for
          # the tagged one in the uninstall entry.
          if ($stamp.dirty) { $AppVer = $AppVer + '-dirty' }
        }
      }
    } catch { $AppVer = $null }
  }
  if (-not $AppVer) {
    Say 'WARNING: no -AppVer and nothing usable in version.json; the installer will report version 0.0.0'
    $AppVer = '0.0.0'
  }
}

$ProductVer = '0.0.0.0'
$m = [regex]::Match($AppVer, 'v?(\d{4})[.\-](\d{1,2})[.\-](\d{1,2})')
if ($m.Success) {
  $ProductVer = [string]([int]$m.Groups[1].Value) + '.' + [string]([int]$m.Groups[2].Value) + '.' + [string]([int]$m.Groups[3].Value) + '.0'
}

# ---------------------------------------------------------------- locate makensis
# Never assume the runner image ships NSIS: the actions/runner-images Windows Server 2022
# manifest lists `NSIS 3.10`, but the Server 2025 one has no NSIS at all (only InnoSetup/WiX).
# `windows-latest` moves between images, so presence is probed, not assumed.
#
# !! The list below is duplicated on purpose-avoidance grounds: release.yml installs NSIS
#    when it is missing and then has to *verify* it can be found. Two resolvers written
#    independently drift, and on 2026-09-29 they did: release.yml verified with
#    `Get-Command makensis` alone after `choco install`, which cannot see a PATH change in
#    an already-running session, so it failed while NSIS was in fact installed. Keep the
#    two lists identical in content; a contract assertion pins them together.
if (-not $Makensis) {
  $c = Get-Command makensis -ErrorAction SilentlyContinue
  if ($c) { $Makensis = $c.Source }
}
if (-not $Makensis) {
  $cands = @(
    (Join-Path $env:ProgramFiles 'NSIS\makensis.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'NSIS\makensis.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\NSIS\makensis.exe'),
    'C:\ProgramData\chocolatey\bin\makensis.exe',
    'C:\ProgramData\chocolatey\lib\nsis\tools\makensis.exe'
  )
  foreach ($cand in $cands) {
    if ($cand -and (Test-Path -LiteralPath $cand)) { $Makensis = $cand; break }
  }
}
if (-not $Makensis) {
  throw 'makensis not found. Install NSIS (choco install nsis -y) or pass -Makensis <path>.'
}

$zipLen = (Get-Item -LiteralPath $Zip).Length
# The icon the .nsi defaults to. Verified here rather than left to makensis: a missing icon
# is a build error with a much better message from us ("did public/app.ico move?") than from
# the compiler, and this file has already shipped once as "a product whose first impression
# is NSIS's default logo" simply because nothing looked.
$iconFile = Join-Path $root 'public\app.ico'
if (-not (Test-Path -LiteralPath $iconFile)) {
  throw ('the installer icon is missing: ' + $iconFile + ' -- the .nsi defaults ICON_FILE to it, and the wizard plus the setup exe would silently fall back to the NSIS default icon.')
}
Say ('makensis : ' + $Makensis)
Say ('script   : ' + $nsi)
Say ('zip      : ' + $Zip + '  ' + $zipLen + ' bytes')
Say ('version  : ' + $AppVer + '  (VIProductVersion ' + $ProductVer + ')')
Say ('icon     : ' + $iconFile + '  ' + (Get-Item -LiteralPath $iconFile).Length + ' bytes')
Say ('out      : ' + $Out)

# ---------------------------------------------------------------- build
Remove-FileForce $Out
$defs = @(
  ('/DPAYLOAD_ZIP=' + $Zip),
  ('/DOUTFILE=' + $Out),
  ('/DAPPVER=' + $AppVer),
  ('/DPRODUCTVER=' + $ProductVer)
)
# Capture makensis's output rather than letting it go to the host. A native program's stderr
# is not reliably merged by callers that redirect the pipeline, and the first run of this
# script lost the actual compiler error that way -- the log simply stopped mid-compile.
$mkOut = & $Makensis $defs $nsi 2>&1
foreach ($line in $mkOut) { Say ('  ' + [string]$line) }
if ($LASTEXITCODE -ne 0) { throw ('makensis failed with exit code ' + $LASTEXITCODE) }

if (-not (Test-Path -LiteralPath $Out)) { throw 'makensis reported success but produced no output file' }
$outLen = (Get-Item -LiteralPath $Out).Length
$delta = $outLen - $zipLen
Say ('installer: ' + $outLen + ' bytes  (+' + $delta + ' over the payload zip)')

# Fail closed on the ONE failure mode that matters here: an installer that does not actually
# carry the payload. That is not hypothetical -- the Tauri bundler route produced a 3.5 MB
# installer for a 362 MB product and looked fine.
# The band is wide because icon resources are legitimate and NOT compressed by NSIS:
#   with no icon            ~59 KB overhead
#   with public\app.ico     ~295 KB overhead (the 16/32/48/64/128/256 layers are stored raw,
#                           and there are two of them: the installer's and the uninstaller's)
# Anything tiny means an empty shell; anything huge means the payload got recompressed (slow,
# and a sign SetCompress off is gone). Do not "fix" a build by widening this -- check which
# of the two causes applies first.
if ($delta -lt 30000) {
  throw ('installer is only +' + $delta + ' bytes over the zip -- the payload was NOT embedded. Refusing to publish an installer that cannot install anything.')
}
if ($delta -gt 900000) {
  throw ('installer is +' + $delta + ' bytes over the zip -- that is far more than the ~295 KB of expected overhead (stub, uninstaller, 4 pages, installer icon, uninstaller icon). Check that `SetCompress off` is still in front of the File command in installer\offerwhere.nsi.')
}

# ---------------------------------------------------------------- setup exe icon
# installer\offerwhere.nsi points Icon / MUI_ICON / MUI_UNICON at public\app.ico. Asserting
# that the .nsi SAYS so would be satisfied by the .nsi saying so while makensis quietly fell
# back to its own default -- which is exactly what shipped before this check existed: the
# first file a user ever sees (download bar, Explorer, SmartScreen prompt) carried NSIS's
# logo. So compare the icon actually embedded in the built exe against the source.
$iconProblems = @()
if (-not (Test-DrawingAvailable)) {
  $iconProblems += 'System.Drawing could not be loaded, so the setup exe icon was NOT verified'
} else {
  try {
    $srcIcon = New-Object System.Drawing.Icon($iconFile, 32, 32)
    $srcHash = Get-IconPixelHash $srcIcon
    $srcIcon.Dispose()
    $builtIcon = [System.Drawing.Icon]::ExtractAssociatedIcon($Out)
    if (-not $builtIcon) {
      $iconProblems += 'the built installer has no associated icon at all'
    } else {
      $builtHash = Get-IconPixelHash $builtIcon
      $builtIcon.Dispose()
      Say ('  icon check : built ' + $builtHash.Substring(0, 16) + '... vs source ' + $srcHash.Substring(0, 16) + '...')
      if ($builtHash -ne $srcHash) {
        $iconProblems += 'the setup exe icon does not match public\app.ico -- the Icon/MUI_ICON directives were dropped or point elsewhere'
      }
    }
  } catch {
    $iconProblems += ('the icon check itself failed: ' + $_.Exception.Message)
  }
}
foreach ($p in $iconProblems) { Say ('  FAIL: ' + $p) }
if ($iconProblems.Count -gt 0) {
  throw ('NSIS icon check failed: ' + ($iconProblems -join ' | '))
}

# ---------------------------------------------------------------- self-test
if ($SelfTest) {
  $dest = $SelfTestDir
  if (-not $dest) { $dest = Join-Path $env:TEMP ('ow-nsistest-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)) }
  # A trailing backslash would escape the closing quote when this path is handed to the
  # installer (the SFX hit exactly this with its own -C argument).
  $dest = $dest.TrimEnd('\')
  Remove-TreeForce $dest

  # Snapshot the staging dirs NSIS creates under %TEMP% so "no residue" can be judged by
  # difference rather than by hoping the temp folder was empty to begin with.
  # Two different naming families, both NSIS's:
  #   ns*.tmp    the installer's own staging (InstallerDir / $PLUGINSDIR)
  #   ~nsu*.tmp  the copy the UNINSTALLER makes of itself before relaunching
  # The second one only exists because this self-test now runs the uninstaller for real --
  # checking only for ns*.tmp would call a leftover uninstaller copy "clean".
  $tmpBefore = @(Get-ChildItem -LiteralPath $env:TEMP -Directory -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'ns*.tmp' -or $_.Name -like '~nsu*.tmp' } | Select-Object -ExpandProperty Name)

  # Same reasoning for the default install location: this machine may legitimately already
  # have one from an earlier run, so only a change caused by THIS run counts as a problem.
  $shell = Join-Path $env:LOCALAPPDATA 'OfferWhere'
  $shellBefore = Test-Path -LiteralPath $shell

  # The two shell entries the installer creates. They live OUTSIDE the install directory, so
  # a self-test that only looks inside $dest cannot see them at all -- and indeed two earlier
  # runs left a desktop "OfferWhere.lnk" on this machine, pointing at a temp folder that was
  # deleted afterwards, without a single assertion noticing.
  $lnkPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'OfferWhere.lnk'
  $smDir = Join-Path ([Environment]::GetFolderPath('Programs')) 'OfferWhere'
  $entryBefore = @{}
  foreach ($e in @($lnkPath, $smDir)) { $entryBefore[$e] = Test-Path -LiteralPath $e }

  # ...and the same reasoning again for the REGISTRY, which is the part that is visible
  # outside this script. A silent install writes HKCU\Software\OfferWhere (InstallDir) and
  # the Uninstall\OfferWhere key that "Apps & features" reads. Running -SelfTest on a machine
  # that already has OfferWhere installed would therefore repoint that machine's uninstall
  # entry at a temp directory -- and on a machine that does not, it leaves a new OfferWhere
  # entry behind pointing at a folder this script deletes at the end. Neither was noticed
  # until the wizard was photographed for the release notes and its directory page came up
  # pre-filled with the PREVIOUS self-test's temp path (2026-09-28). So: snapshot, assert,
  # and put back. DeleteSubKeyTree rather than Remove-Item -- the hook routes Remove-Item to
  # the recycle bin, which a registry path cannot satisfy.
  $regApp = 'Software\OfferWhere'
  $regUninst = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\OfferWhere'
  $regAppBefore = Get-RegSnapshot $regApp
  $regUninstBefore = Get-RegSnapshot $regUninst

  Say ''
  Say ('self-test: silent install -> ' + $dest)
  $procsBefore = @(Get-Process -Name 'offer-where' -ErrorAction SilentlyContinue).Count
  $t0 = Get-Date

  # NOT a bare `& $Out /S ...`. PowerShell does not wait for a GUI subsystem binary, so `&`
  # returns the moment the process is created and every check below would run against a
  # half-written directory. ProcessStartInfo + WaitForExit gives a real wait and a real
  # timeout. (Same lesson make_sfx.ps1 records -- it cost a full bogus failure report there.)
  #
  # /D= must be LAST and must NOT be quoted, even if the path contains spaces -- NSIS takes
  # everything after "/D=" to the end of the raw command line. This is not pedantry: quoting
  # it makes NSIS reject the switch silently and install to the default location instead,
  # which is exactly what the first run of this self-test did (it landed 123548 files in
  # %LOCALAPPDATA%\OfferWhere and reported 4 failures).
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Out
  $psi.Arguments = '/S /D=' + $dest
  $psi.UseShellExecute = $false
  $proc = [System.Diagnostics.Process]::Start($psi)
  $exited = $proc.WaitForExit($SelfTestTimeoutSec * 1000)
  if (-not $exited) {
    try { $proc.Kill() } catch { }
    throw ('self-test timed out after ' + $SelfTestTimeoutSec + 's -- the installer never returned')
  }
  $rc = $proc.ExitCode
  $proc.Dispose()
  $elapsed = ((Get-Date) - $t0).TotalSeconds
  $procsAfter = @(Get-Process -Name 'offer-where' -ErrorAction SilentlyContinue).Count

  $entryExe = Join-Path $dest 'dist-app\offer-where.exe'
  $entryBat = Join-Path $dest 'start_all.bat'
  $uninst = Join-Path $dest 'Uninstall.exe'
  # The marker the app's own first-run guard looks for. The installer writes it so the
  # user is not asked to press "Install" a second time for shortcuts it already made.
  $marker = Join-Path $dest 'data\.installed'

  # What "Apps & features" would actually show. Checking that Uninstall.exe is on disk only
  # proves the file was written; the list reads the registry, so that is what gets asserted.
  $regUninstAfter = Get-RegSnapshot $regUninst
  $regAppAfter = Get-RegSnapshot $regApp
  $regUninstString = ''
  if ($regUninstAfter -and $regUninstAfter.ContainsKey('UninstallString')) { $regUninstString = [string]$regUninstAfter['UninstallString'].Value }
  $regDisplayName = ''
  if ($regUninstAfter -and $regUninstAfter.ContainsKey('DisplayName')) { $regDisplayName = [string]$regUninstAfter['DisplayName'].Value }
  # InstallDir is what pre-fills the directory page on the next install (InstallDirRegKey).
  $regRemembered = ''
  if ($regAppAfter -and $regAppAfter.ContainsKey('InstallDir')) { $regRemembered = [string]$regAppAfter['InstallDir'].Value }
  $shellAfter = Test-Path -LiteralPath $shell
  $stat = $null
  if (Test-Path -LiteralPath $dest) {
    $stat = Get-ChildItem -LiteralPath $dest -Recurse -File -Force -ErrorAction SilentlyContinue |
      Measure-Object -Property Length -Sum
  }
  $fileCount = 0
  $byteSum = 0
  if ($stat) { $fileCount = $stat.Count; $byteSum = $stat.Sum }

  $tmpAfter = @(Get-ChildItem -LiteralPath $env:TEMP -Directory -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'ns*.tmp' -or $_.Name -like '~nsu*.tmp' } | Select-Object -ExpandProperty Name)
  $newResidue = @($tmpAfter | Where-Object { $tmpBefore -notcontains $_ })

  Say ('  exit code     : ' + $rc)
  Say ('  elapsed       : ' + [math]::Round($elapsed, 1) + ' s')
  Say ('  files         : ' + $fileCount + ', ' + [math]::Round($byteSum / 1MB, 0) + ' MB')
  Say ('  entry exe     : ' + (Test-Path -LiteralPath $entryExe))
  Say ('  entry bat     : ' + (Test-Path -LiteralPath $entryBat))
  Say ('  uninstaller   : ' + (Test-Path -LiteralPath $uninst))
  Say ('  first-run mark: ' + (Test-Path -LiteralPath $marker) + '  (present => no redundant "Install" prompt)')
  Say ('  uninstall reg : ' + $regDisplayName + '  ' + $regUninstString)
  Say ('  remembered dir: ' + $regRemembered + '  (pre-fills the directory page next time)')
  Say ('  shells running: ' + $procsBefore + ' -> ' + $procsAfter + '  (silent install must not launch the app)')
  Say ('  temp residue  : ' + $newResidue.Count + ' new ns*.tmp / ~nsu*.tmp dir(s)')
  Say ('  default loc   : ' + $shellBefore + ' -> ' + $shellAfter + '  (a /D= install must not touch it)')
  foreach ($d in $newResidue) { Say ('    ' + $d) }

  $problems = @()
  if ($rc -ne 0) { $problems += ('installer exit code was ' + $rc + ', expected 0') }
  if ($fileCount -lt 120000) { $problems += ('only ' + $fileCount + ' files extracted, expected ~124500') }
  if (-not (Test-Path -LiteralPath $entryBat)) { $problems += 'start_all.bat is missing -- the payload is incomplete' }
  if (-not (Test-Path -LiteralPath $uninst)) { $problems += 'Uninstall.exe is missing -- no uninstall entry would work' }
  if (-not (Test-Path -LiteralPath $marker)) { $problems += 'data\.installed is missing -- the app would show its first-run "Install" dialog and ask for the shortcut we just created' }
  if ($regDisplayName -ne 'OfferWhere') { $problems += ('the uninstall entry is not registered ("Apps & features" would show nothing); DisplayName=' + $regDisplayName) }
  if ($regUninstString -notlike ('*' + $dest + '*')) { $problems += ('the uninstall entry points somewhere else: ' + $regUninstString) }
  if ($regRemembered -ne $dest) { $problems += ('InstallDir was not remembered as ' + $dest + ' but as ' + $regRemembered) }

  # ------------------------------------------------------------ uninstall for real
  # The uninstaller is the other half of "a real installer", and it is the half that can
  # destroy somebody's resume. Until 2026-09-28 nothing exercised it: the self-test stopped
  # at "Uninstall.exe exists on disk". So it gets run for real here -- silently, against the
  # throwaway tree -- and the promises in the release notes are checked against it.
  #
  # The one that matters most: data\ must SURVIVE a silent uninstall. NSIS answers /S prompts
  # with the default button, and that prompt is MB_DEFBUTTON2 (= No = keep), so this also pins
  # that choice -- swapping to MB_DEFBUTTON1 would silently start deleting user data in the
  # unattended path, which is the path nobody watches.
  #
  # AND: say out loud which volume was exercised. The first version of the uninstaller kept
  # data\ by Rename-ing it out of $INSTDIR and back, which cannot cross volumes -- installed to
  # another drive it failed and fell through to the delete-everything branch. The default
  # $SelfTestDir lives in %TEMP%, i.e. the same volume as $LOCALAPPDATA, so a green run here
  # could not have caught that. The current uninstaller enumerates instead of Rename-ing and is
  # volume-agnostic by construction (a contract test forbids Rename coming back), but the
  # report should still not imply a cross-volume run happened when it did not.
  $destRoot = [System.IO.Path]::GetPathRoot($dest)
  $localRoot = [System.IO.Path]::GetPathRoot($env:LOCALAPPDATA)
  $sameVolume = ($destRoot -eq $localRoot)
  # Residue has to be judged over the WHOLE run, so take a second snapshot now: the first one
  # was taken before the install, and the uninstaller's own copy under %TEMP%\~nsu*.tmp only
  # appears during the uninstall. The first version of this check therefore reported
  # "0 new staging dirs" while a stale ~nsu1.tmp\Un.exe sat in %TEMP% -- the guard was
  # measuring the wrong half of the run.
  $tmpBeforeUn = @(Get-ChildItem -LiteralPath $env:TEMP -Directory -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'ns*.tmp' -or $_.Name -like '~nsu*.tmp' } | Select-Object -ExpandProperty Name)
  Say ''
  Say ('self-test: volumes -- install dest ' + $destRoot + ' vs $LOCALAPPDATA ' + $localRoot +
       ' -> ' + $(if ($sameVolume) { 'SAME (cross-volume path NOT exercised)' } else { 'DIFFERENT (the hazard is live in this run)' }))

  $uninstProblems = @()
  if ($problems.Count -eq 0) {
    $shortcutBefore = $entryBefore[$lnkPath]
    Say ('self-test: silent uninstall (desktop shortcut before: ' + $shortcutBefore + ')')
    $upsi = New-Object System.Diagnostics.ProcessStartInfo
    $upsi.FileName = $uninst
    $upsi.Arguments = '/S'
    $upsi.UseShellExecute = $false
    $uproc = [System.Diagnostics.Process]::Start($upsi)
    $uexited = $uproc.WaitForExit($SelfTestTimeoutSec * 1000)
    if (-not $uexited) {
      try { $uproc.Kill() } catch { }
      $uninstProblems += 'the uninstaller never returned'
    } else {
      $urc = $uproc.ExitCode
      $uproc.Dispose()
      # The uninstaller's process exit is NOT the end of the uninstall. NSIS copies the
      # uninstaller to %TEMP%\~nsu.tmp, relaunches from there and the ORIGINAL process
      # returns immediately -- so checking right after WaitForExit inspects a tree that is
      # still being deleted. Measured on 2026-09-28: the assertions below reported 24 leftover
      # top-level entries, 124553 files and "the uninstaller left the installed tree behind",
      # and the same tree was down to 0 files a minute later; the run finally died on
      # "access denied" because our own cleanup was deleting the same tree concurrently.
      # So wait for the END STATE, and fail on a timeout instead: an uninstaller that really
      # does nothing still fails here, it just fails after the budget rather than instantly.
      $settleBudget = [Math]::Min(300, $SelfTestTimeoutSec)
      $settleSec = 0.0
      while ($settleSec -lt $settleBudget -and (Test-Path -LiteralPath $entryBat)) {
        Start-Sleep -Milliseconds 500
        $settleSec += 0.5
      }
      $entryGone = -not (Test-Path -LiteralPath $entryBat)
      $dataKept = Test-Path -LiteralPath $marker
      $uninstGone = -not (Test-Path -LiteralPath $uninst)
      $shortcutGone = -not (Test-Path -LiteralPath $lnkPath)
      $regGone = -not (Test-RegKeyExists $regUninst)
      # Anything still sitting next to data\ is a survivor the uninstaller should have removed.
      # Checking only for start_all.bat would let a regression that leaves 124000 files behind
      # call itself a pass.
      $leftover = @()
      if (Test-Path -LiteralPath $dest) {
        $leftover = @(Get-ChildItem -LiteralPath $dest -Force -ErrorAction SilentlyContinue |
          Where-Object { $_.Name -ne 'data' } | Select-Object -ExpandProperty Name)
      }
      # The uninstaller's own copy: NSIS writes it to %TEMP%\~nsu<chosen>.tmp and re-executes
      # from there. It normally removes itself, but it demonstrably does not always manage it
      # -- a stale ~nsu1.tmp\Un.exe (150 KB) survived a full green run, and the same happens
      # with a 20-line probe installer that has no MessageBox and no keep-data logic, so it is
      # an NSIS behaviour rather than ours. Reported and removed rather than asserted on: a
      # hard failure would make -SelfTest permanently red for something we cannot fix, and
      # ignoring it silently is how a temp directory fills up one run at a time.
      $tmpAfterUn = @(Get-ChildItem -LiteralPath $env:TEMP -Directory -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like 'ns*.tmp' -or $_.Name -like '~nsu*.tmp' } | Select-Object -ExpandProperty Name)
      $unResidue = @($tmpAfterUn | Where-Object { $tmpBeforeUn -notcontains $_ })
      foreach ($d in $unResidue) { Remove-TreeForce (Join-Path $env:TEMP $d) }
      Say ('  uninstall cue : ' + $(if ($unResidue.Count -eq 0) { '(none left by the uninstaller)' } else { (($unResidue -join ', ') + '  -> removed (NSIS self-copy; see make_nsis.ps1)') }))
      Say ('  exit code     : ' + $urc)
      Say ('  settle wait   : ' + $settleSec + ' s  (the uninstaller returns before it finishes)')
      Say ('  tree removed  : ' + $entryGone + '  (start_all.bat gone)')
      Say ('  data kept     : ' + $dataKept + '  (data\.installed survived /S)')
      Say ('  uninstaller   : gone=' + $uninstGone)
      Say ('  desktop .lnk  : gone=' + $shortcutGone + ' (created by this run: ' + (-not $shortcutBefore) + ')')
      Say ('  uninstall reg : gone=' + $regGone)
      Say ('  leftover      : ' + $(if ($leftover.Count -eq 0) { '(nothing but data\)' } else { ($leftover -join ', ') }))
      if ($urc -ne 0) { $uninstProblems += ('silent uninstall exit code was ' + $urc + ', expected 0') }
      if (-not $entryGone) { $uninstProblems += ('the uninstaller left the installed tree behind after ' + $settleSec + ' s of waiting -- it removed nothing at all') }
      if (-not $dataKept) { $uninstProblems += 'a silent uninstall DELETED data\ -- the default button must be "keep"' }
      if ($leftover.Count -ne 0) { $uninstProblems += ('the uninstaller kept entries it should have removed: ' + ($leftover -join ', ')) }
      if (-not $regGone) { $uninstProblems += 'the uninstaller left its registry entry, so it would still appear in Apps & features' }
      if ((-not $shortcutBefore) -and (-not $shortcutGone)) { $uninstProblems += 'the uninstaller left the desktop shortcut this run created' }
    }
    foreach ($p in $uninstProblems) { Say ('  FAIL: ' + $p) }
  }
  $problems += $uninstProblems

  Restore-RegSnapshot $regApp $regAppBefore
  Restore-RegSnapshot $regUninst $regUninstBefore
  $regLeak = (Test-RegKeyExists $regApp) -or (Test-RegKeyExists $regUninst)
  if ($regLeak -and (-not $regAppBefore) -and (-not $regUninstBefore)) {
    $problems += 'the registry restore left an OfferWhere key behind that this run created'
  }

  # Same treatment for the two shell entries. The installer creating them is CORRECT -- that
  # is the feature. The self-test leaving them behind is not: two earlier runs on this machine
  # had already left a desktop "OfferWhere" pointing at a temp folder, and nothing noticed
  # because nothing looked (the desktop is not part of any assertion). The uninstall test above
  # normally removes them; this covers the paths where it did not run.
  foreach ($e in @($lnkPath, $smDir)) {
    $existedBefore = $entryBefore[$e]
    if (-not $existedBefore) {
      if (Test-Path -LiteralPath $e) {
        try {
          if ((Get-Item -LiteralPath $e -Force).PSIsContainer) { Remove-TreeForce $e } else { Remove-FileForce $e }
          Say ('  cleaned up    : ' + $e)
        } catch { $problems += ('could not remove ' + $e + ' which this run created: ' + $_.Exception.Message) }
      }
    }
  }

  if ($procsAfter -ne $procsBefore) { $problems += 'a silent install launched the app, which it must not do' }
  if ($newResidue.Count -gt 0) { $problems += ('the installer left ' + $newResidue.Count + ' staging dir(s) behind under %TEMP%') }
  if ((-not $shellBefore) -and $shellAfter) { $problems += ('this run created ' + $shell + ' even though /D= pointed elsewhere') }

  if (-not $KeepExtracted) { Remove-TreeForce $dest }

  if ($problems.Count -gt 0) {
    foreach ($p in $problems) { Say ('  FAIL: ' + $p) }
    # Carry the detail in the exception too. The Say lines above go to the host, and a
    # caller that collects a failed invocation can lose them -- the first run of this
    # self-test reported nothing but "failed with 4 problem(s)".
    throw ('NSIS self-test failed with ' + $problems.Count + ' problem(s): ' + ($problems -join ' | '))
  }
  Say '  self-test     : OK'
}
