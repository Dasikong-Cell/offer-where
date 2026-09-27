# build_app.ps1 -- build the OfferWhere native shell and stamp it for provenance.
#
# WHY THIS EXISTS
#   dist-app/ is a COMMITTED build artifact: the portable zip ships it, and the
#   desktop shortcut prefers it over start_all.bat. A committed binary can silently
#   drift from the source it came from -- edit a .rs file, forget to rebuild, pack,
#   ship. Nothing in tsc / selftest / contract tests / smoke can see that, because
#   the assertion has to span "source on disk" and "bytes inside the binary".
#   So this script turns it into a mechanical check:
#     - hash every source file under src-tauri/ (recipe recorded in the artifact;
#       CRLF-normalized and ordinal-ordered -- see Get-FileSha256Norm for why)
#     - hash the two shipped artifacts
#     - write dist-app/BUILD_INFO.json
#   pack.ps1 recomputes the same thing and REFUSES to build a package if anything
#   moved. See the provenance guard in pack.ps1.
#
# ASCII-ONLY, deliberately: a contract test enumerates every *.ps1 in the repo root
# and in scripts/ and asserts 0 bytes > 127. Windows PowerShell 5.1 decodes a
# BOM-less script as GBK, so a non-ASCII byte can break the script on someone
# else's machine while still working here. Do not add CJK text or box-drawing here.
#
# THIS MACHINE HAS NO MSVC, so the build goes through the x86_64-pc-windows-gnu
# toolchain with a portable MinGW. Export the toolchain environment BEFORE calling
# this script (full recipe in the rust-windows-gnu skill):
#
#   $env:RUSTUP_HOME='D:\_rustup'; $env:CARGO_HOME='D:\_cargo'
#   $env:RUSTUP_TOOLCHAIN='stable-x86_64-pc-windows-gnu'
#   $env:CARGO_TARGET_DIR='D:\_ow_b10'; $env:CARGO_BUILD_JOBS='1'
#   $env:TMP='D:\_wp'; $env:TEMP='D:\_wp'
#   $env:Path='D:\_wrappers;D:\_mingw\mingw64\bin;' +
#             'D:\_rustup\toolchains\stable-x86_64-pc-windows-gnu\bin;' + $env:Path
#   .\build_app.ps1
#
# Then commit dist-app/offer-where.exe, dist-app/WebView2Loader.dll and
# dist-app/BUILD_INFO.json together in ONE commit, so they can never disagree.

param(
  # Cargo target dir. Defaults to CARGO_TARGET_DIR, then src-tauri\target.
  [string]$TargetDir = '',
  # Skip the build AND the artifact copy, then re-hash whatever is already committed in
  # dist-app/ (useful after changing the hash rule; needs no cargo output, so it works
  # on a machine without the Rust toolchain).
  [switch]$StampOnly
)

$ErrorActionPreference = 'Stop'

# Repo root = the directory holding this script (it lives at the repo root).
$root = $PSScriptRoot
if (-not $root) { $root = (Get-Location).Path }
$srcRoot = Join-Path $root 'src-tauri'
$appDir = Join-Path $root 'dist-app'
$exeName = 'offer-where.exe'
# WebView2Loader.dll is the ONLY non-system DLL the exe imports (verified by reading
# the PE import table, not by grepping strings -- string greps give false positives).
# Without it sitting next to the exe, the app cannot start at all.
$dllName = 'WebView2Loader.dll'
$extra = @($dllName)

# Directories under src-tauri/ that are build output or VCS metadata, not source.
$excludeDirNames = @('target', '.git', 'gen')
# Recorded verbatim in BUILD_INFO.json so pack.ps1 does not have to re-derive the rule.
# Kept free of quotes and angle brackets on purpose: Windows PowerShell 5.1's
# ConvertTo-Json escapes those to \u0027 / \u003c / \u003e, which makes the stamp noisy
# and (worse) makes its bytes depend on the PowerShell version that wrote it.
$aggregateRule = 'sha256 of the UTF-8 text formed by, for every source file in ORDINAL path order: ' +
                 'relative path + LF + lowercase hex sha256 of the file bytes with CRLF normalized to LF + LF'

function Get-RelPath([string]$Full, [string]$Base) {
  return ($Full.Substring($Base.Length + 1)).Replace('\', '/')
}

# Raw bytes hash. Correct ONLY for the shipped artifacts (the exe/dll are binary and
# git never rewrites them), so this is the one used for dist-app/, not for sources.
function Get-FileSha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLower()
}

# sha256 of the file bytes after CRLF -> LF normalization. This is the hash used for
# every SOURCE file. Two portability bugs lived here; both were caught by CI, not here.
#
# (1) LINE ENDINGS. Hashing raw on-disk bytes makes the stamp a fact about the machine
#     that checked the tree out, not about the source. git on the Windows CI runner
#     runs with core.autocrlf=true, which rewrites src-tauri/'s 8 TEXT files to CRLF;
#     icon.ico (binary) is left alone. So pack.ps1 -- whose whole job is to prove "the
#     committed exe matches the committed source" -- refused to pack a tree that was
#     perfect: measured 2026-09-27 on run 36331333538,
#       stamped f057d715a817...   current 4747e9e230f3...
#     while the identical commit was green locally (LF checkout). Reproduced offline:
#     hashing the CRLF variants reproduces 4747e9e2 exactly, and the file list CI
#     reported as modified is exactly the 8 text files. Normalizing CRLF away makes
#     LF and CRLF checkouts of one commit hash the same.
# (2) SORT ORDER. "Sort-Object path" is culture-sensitive, so the aggregate also
#     depended on the machine locale. Ordinal is a pure byte order -- see
#     Sort-EntriesByPathOrdinal below.
#
# Applied to EVERY file including binaries, on purpose: git does not rewrite binaries,
# so both sides see identical bytes for them and the normalization is a no-op. One
# rule, no text/binary guesswork. (icon.ico does contain a few 0x0D0A byte pairs; both
# sides strip the same ones, so the comparison stays meaningful.)
function Get-FileSha256Norm([string]$Path) {
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  # 28591 = ISO-8859-1: maps every byte to U+0000..U+00FF, so GetString/GetBytes round
  # trips byte-for-byte. Decoding as UTF-8 instead would corrupt binary input into
  # U+FFFD and silently hash the wrong thing.
  $enc = [System.Text.Encoding]::GetEncoding(28591)
  $text = $enc.GetString($bytes).Replace("`r`n", "`n")
  $sha = [System.Security.Cryptography.SHA256]::Create()
  return ([System.BitConverter]::ToString($sha.ComputeHash($enc.GetBytes($text))) -replace '-', '').ToLower()
}

# Sort source entries by path using StringComparer.Ordinal.
# WHY: Sort-Object compares with the current culture, so zh-CN here and en-US on the
# runner could order the same set differently and produce different aggregate hashes.
# Ordinal is byte order: identical on every machine and trivially reproducible in
# another language, which is how scripts/contract_tests.ts re-derives this hash.
function Sort-EntriesByPathOrdinal($Entries) {
  $paths = New-Object System.Collections.Generic.List[string]
  foreach ($e in $Entries) { $paths.Add([string]$e.path) }
  $paths.Sort([System.StringComparer]::Ordinal)
  # Ordinal-keyed lookup: a plain @{} hashtable is case-INSENSITIVE, which would merge
  # two paths differing only in case. Nothing here has that shape today; the Ordinal
  # comparer keeps it that way if a file is ever added.
  $map = New-Object 'System.Collections.Generic.Dictionary[string,object]' ([System.StringComparer]::Ordinal)
  foreach ($e in $Entries) { $map[[string]$e.path] = $e }
  $out = New-Object System.Collections.Generic.List[object]
  foreach ($p in $paths) { $out.Add($map[$p]) }
  return $out.ToArray()
}

function Get-SourceEntries {
  param([string]$Root, [string]$SrcRoot, [string[]]$Exclude)
  $entries = New-Object System.Collections.Generic.List[object]
  foreach ($f in (Get-ChildItem -LiteralPath $SrcRoot -Recurse -File -Force)) {
    $rel = Get-RelPath $f.FullName $Root
    $parts = $rel.Split('/')
    # parts[0] is 'src-tauri'; only intermediate directory names are candidates.
    $skip = $false
    for ($i = 1; $i -lt ($parts.Length - 1); $i++) {
      if ($Exclude -contains $parts[$i]) { $skip = $true; break }
    }
    if ($skip) { continue }
    $entries.Add([pscustomobject]@{ path = $rel; sha256 = (Get-FileSha256Norm $f.FullName) })
  }
  return (Sort-EntriesByPathOrdinal $entries)
}

function Get-AggregateHash($Entries) {
  $sb = New-Object System.Text.StringBuilder
  foreach ($e in $Entries) {
    [void]$sb.Append($e.path).Append("`n").Append($e.sha256).Append("`n")
  }
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($sb.ToString())
  $sha = [System.Security.Cryptography.SHA256]::Create()
  return ([System.BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').ToLower()
}

if (-not (Test-Path -LiteralPath $srcRoot)) {
  Write-Host "[error] src-tauri/ not found next to this script: $srcRoot"
  exit 1
}

# -- 1) build ------------------------------------------------------------------
if (-not $StampOnly) {
  Write-Host '[1/3] npx tauri build --no-bundle ...'
  Push-Location $root
  # Native tools (cargo / the linker) write progress and warnings to stderr. With
  # $ErrorActionPreference='Stop', Windows PowerShell 5.1 converts ANY stderr output
  # from a native command into a terminating NativeCommandError -- and it throws only
  # AFTER the command has finished. So a perfectly good build dies at the very end,
  # with the artifact already on disk, and the error text is just a progress line.
  # (Measured 2026-09-27: "Info Looking up installed tauri packages..." killed a
  # 3.5-minute build after it had succeeded.) Scope it back to Continue for this call
  # and judge success by $LASTEXITCODE, which is the actual contract.
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & npx.cmd tauri build --no-bundle
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prevEap
    Pop-Location
  }
  if ($code -ne 0) {
    Write-Host "[error] build failed with exit code $code"
    exit 1
  }
}

# -- 2) locate artifacts and copy them into dist-app/ --------------------------
# Skipped entirely with -StampOnly. Re-stamping means "re-derive the stamp from the
# bytes that are already committed in dist-app/" -- it must NOT require a cargo target
# dir, and in particular must work on a machine with no Rust toolchain at all (the
# normal case for a re-stamp, e.g. after changing the hash rule). Until 2026-09-27 this
# step ran unconditionally, so -StampOnly died with "built exe not found:
# src-tauri\target\release\offer-where.exe" unless the build output happened to still
# be around -- which is exactly what its own doc comment promised it did not need.
if (-not $StampOnly) {
  $resolvedTarget = $TargetDir
  if (-not $resolvedTarget) { $resolvedTarget = $env:CARGO_TARGET_DIR }
  if (-not $resolvedTarget) { $resolvedTarget = Join-Path $srcRoot 'target' }
  $releaseDir = Join-Path $resolvedTarget 'release'
  Write-Host "[2/3] artifacts from $releaseDir"

  $builtExe = Join-Path $releaseDir $exeName
  if (-not (Test-Path -LiteralPath $builtExe)) {
    Write-Host "[error] built exe not found: $builtExe"
    Write-Host '        pass -TargetDir <cargo target dir> if CARGO_TARGET_DIR is unset here.'
    exit 1
  }
  New-Item -ItemType Directory -Force -Path $appDir | Out-Null
  Copy-Item -LiteralPath $builtExe -Destination (Join-Path $appDir $exeName) -Force
  foreach ($n in $extra) {
    $src = Join-Path $releaseDir $n
    if (Test-Path -LiteralPath $src) {
      Copy-Item -LiteralPath $src -Destination (Join-Path $appDir $n) -Force
      Write-Host "      copied $n"
    } else {
      Write-Host "      [warn] $n not found in the build output; keeping any existing copy"
    }
  }
} else {
  Write-Host '[2/3] -StampOnly: keeping the artifacts already committed in dist-app/'
}

# -- 3) stamp ------------------------------------------------------------------
Write-Host '[3/3] hashing source set and artifacts ...'
$srcEntries = @(Get-SourceEntries -Root $root -SrcRoot $srcRoot -Exclude $excludeDirNames)
if (-not $srcEntries -or $srcEntries.Count -eq 0) {
  Write-Host '[error] no source files found under src-tauri/ -- refusing to write a stamp'
  exit 1
}
$srcHash = Get-AggregateHash $srcEntries

$artifacts = New-Object System.Collections.Generic.List[object]
foreach ($n in (@($exeName) + $extra)) {
  $p = Join-Path $appDir $n
  if (-not (Test-Path -LiteralPath $p)) {
    Write-Host "[error] artifact missing from dist-app/: $n"
    exit 1
  }
  $fi = Get-Item -LiteralPath $p
  $artifacts.Add([pscustomobject]@{
    path   = 'dist-app/' + $n
    size   = $fi.Length
    sha256 = (Get-FileSha256 $p)
  })
}
# [!] Do NOT write @($artifacts) anywhere below. Measured on Windows PowerShell 5.1
# (2026-09-27): the array subexpression operator applied to a
# System.Collections.Generic.List[object] throws
#   ArgumentException: "Parameter type mismatch" (Chinese locale text; keep this
#   comment ASCII -- a contract test asserts 0 bytes > 127 in every *.ps1)
# -- with no hint about which expression did it. The same operator on List[string],
# on ArrayList, or on the ToArray() result is fine, so this is specific to
# List[object]. Convert once and use the array from here on.
$artifactArr = $artifacts.ToArray()

$info = [pscustomobject]@{
  schema         = 1
  product        = 'OfferWhere'
  arch           = 'x86_64-pc-windows-gnu'
  builtAt        = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ssK')
  hashRule       = $aggregateRule
  excludeDirNames= $excludeDirNames
  sourceHash     = $srcHash
  sourceCount    = $srcEntries.Count
  sourceFiles    = $srcEntries
  artifacts      = $artifactArr
}
# -Encoding ascii: every value written here is 7-bit by construction (relative paths,
# hex hashes, ISO timestamp), and .json is one of the extensions pack.ps1's portability
# guard reads looking for the author's machine identity -- so keeping the stamp ASCII
# is also what keeps that guard meaningful for this file.
$json = $info | ConvertTo-Json -Depth 6
$out = Join-Path $appDir 'BUILD_INFO.json'
[System.IO.File]::WriteAllText($out, $json + "`n", [System.Text.Encoding]::ASCII)

Write-Host ''
Write-Host ("      sourceHash = " + $srcHash + "  (" + $srcEntries.Count + " files)")
foreach ($a in $artifactArr) {
  Write-Host ("      " + $a.path + "  " + $a.size + " bytes  " + $a.sha256)
}
Write-Host "      wrote $out"
Write-Host ''
Write-Host 'OK. Commit dist-app/ (exe + dll + BUILD_INFO.json) together with the src-tauri change.'
