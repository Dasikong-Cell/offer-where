$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
if (-not $root) { Write-Host "[error] cannot resolve script directory"; exit 1 }

# ── CI diagnosability ─────────────────────────────────────────────────────────
# GitHub Actions logs are NOT readable without a token, but check-run ANNOTATIONS
# are. Emitting the `::error::` workflow command turns every failure branch into
# an annotation, so a red release run can be diagnosed via the public API alone
# (2026-09-26: v1.0.0's "打包" step failed on the runner while the identical
# pack.ps1 was green in ci.yml's Windows job, and the log was unreachable).
# Messages must stay ASCII (this file is ASCII-only; see the encoding note below).
trap { Write-Host ("::error::pack.ps1 unexpected failure: " + $_.Exception.Message.Replace("`r"," ").Replace("`n"," ")); break }

# Zip destination: PACK_ZIP_DIR (set by CI) wins; otherwise the user's Desktop.
# Fallback chain exists because GetFolderPath('Desktop') is the one environment
# assumption this script used to make blindly -- an empty/redirected Desktop
# would make tar fail with an unexplainable exit 1.
$destDir = $env:PACK_ZIP_DIR
if (-not $destDir) { $destDir = [Environment]::GetFolderPath('Desktop') }
if (-not ($destDir -and (Test-Path $destDir))) {
  $destDir = $root
  Write-Host "::error::zip destination directory unavailable, falling back to repo root"
  Write-Host "[warn] zip destination directory unavailable, falling back to repo root"
}
$zip = Join-Path $destDir "job-apply-agent-portable.zip"
$tar = Join-Path $env:SystemRoot "System32\tar.exe"
if (-not (Test-Path $tar)) { Write-Host "::error::tar.exe not found (needs Windows 10 1803+)"; Write-Host "[error] tar.exe not found (needs Windows 10 1803+)"; exit 1 }

# NOTE: keep this script ASCII-only.
#  1) PowerShell 5.1 reads a BOM-less .ps1 as ANSI/GBK -> UTF-8 Chinese breaks parsing.
#  2) Passing non-ASCII args to native exes (robocopy/tar) is unreliable.

$sw = [Diagnostics.Stopwatch]::StartNew()

# ── ALLOW-LIST packaging ──────────────────────────────────────────────────────
# Deliver only what an end user needs. Anything not listed here is simply never
# archived -- that automatically keeps out: .env (API keys!), data/ (personal
# resume + DB + browser profiles), src/, dist/, .git/, internal reports.
# Do NOT go back to "--exclude=<name>": bsdtar matches exclude patterns against
# directory NAMES too, so "--exclude=./dist" also killed node_modules/tsx/dist/
# and produced a package that could not start.
$dirs  = @("node", "node_modules", "public", "scripts")
# server/ and shared/ are archived file-by-file so their tsc build artifacts (*.js emitted
# next to *.ts) can be dropped -- the app runs .ts via tsx, so those .js are redundant and
# a stale copy could shadow its same-named .ts.
# NOTE: do NOT reintroduce tar's --exclude here. bsdtar matches a pattern such as
# `server/*.js` at ANY path level, so it also deleted node_modules/**/server/*.js
# (254 dependency files silently lost -- caught by the audit assertion below).
# Enumerating files explicitly is the only reliable way to scope it to the top level.
$splitDirs = @("server", "shared")
# ── build stamp ───────────────────────────────────────────────────────────────
# Every distributed zip must be traceable. History: a hand-made zip on the desktop
# turned out to be a snapshot of a HALF-FINISHED working tree (some fixes in, some
# out) matched by no commit at all -- impossible to tell what a recipient had.
# version.json is written into the archive root and is gitignored.
$commit = "unknown"
$dirty = $false
try {
  if (Get-Command git -ErrorAction SilentlyContinue) {
    $c = & git -C $root rev-parse --short HEAD 2>$null
    if ($LASTEXITCODE -eq 0 -and $c) { $commit = (@($c)[0]).Trim() }
    $st = & git -C $root status --porcelain 2>$null
    if ($st) { $dirty = $true }
  }
} catch { }
$stamp = @{
  commit  = $commit
  dirty   = $dirty
  builtAt = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssK")
} | ConvertTo-Json -Compress
Set-Content -Path (Join-Path $root 'version.json') -Value $stamp -Encoding ascii
Write-Host "[0/2] build stamp: $stamp"

$files = @("package.json", "package-lock.json", "tsconfig.json", ".env.example",
           "README.md", "DEVELOPMENT.md", "LOGIN_GUIDE.md", "LICENSE", "version.json")

# Only END-USER launchers ship. Repack helpers, CLI one-shots, bash collectors and
# CDP debug launchers stay in the repo: a recipient facing 20 root entries cannot
# tell which file to double-click, and none of them is needed to run the app.
# History (2026-09-25 out-of-box test, P2-2): the first version of this list only
# dropped the *.bat helpers, so the *.sh one-shots and the repacker itself still
# shipped -- the comment claimed otherwise, which is exactly how such lists rot.
# KEEP (deliberately): setenv.bat / start_all.bat / start_server.bat /
# start_platforms.bat (the real launchers), the CJK desktop-shortcut helper, and
# ensure_chrome.sh (README's script table and the console's "window offline" hint
# still point at it as a manual recovery path).
# NOTE: names below are ASCII by requirement (see the encoding note at the top).
# The legacy repacker is named with two CJK characters, so it is built from
# codepoints at runtime instead of being written literally.
$repackBat = ([char]0x6253) + ([char]0x5305) + '.bat'   # legacy robocopy-based packer
$dropScripts = @(
  # CDP / one-shot apply launchers
  'apply_boss.bat', 'apply_job51.bat', 'apply_liepin.bat', 'rerun_liepin.bat',
  'start.bat', 'start_cdp.bat', 'start_cdp_offerbiu.bat', $repackBat,
  # bash one-shots and wait loops (need Git Bash on the author's box; useless on a
  # clean Windows machine, where the console/API is the supported way in)
  'collect_all.sh', 'offerbiu_auto.sh',
  'wait_liepin.sh', 'wait_offerbiu.sh', 'wait_zhilian.sh',
  # the packer itself -- recipients do not build packages
  'pack.ps1'
)
$scripts = Get-ChildItem $root -File -Force |
  Where-Object { @('.bat', '.sh', '.ps1') -contains $_.Extension -and $dropScripts -notcontains $_.Name } |
  Select-Object -ExpandProperty Name

$items = @()
$items += $dirs      | Where-Object { Test-Path (Join-Path $root $_) }
$items += $splitDirs | Where-Object { Test-Path (Join-Path $root $_) }
$items += $files     | Where-Object { Test-Path (Join-Path $root $_) }
$items += $scripts

Write-Host "[1/2] packaging $($items.Count) top-level items ..."
Write-Host ("      dirs: " + (($items | Where-Object { $dirs -contains $_ }) -join ', '))
Write-Host ("      split(minus *.js): " + (($items | Where-Object { $splitDirs -contains $_ }) -join ', '))
Write-Host ("      files: " + (($items | Where-Object { $files -contains $_ }) -join ', '))
Write-Host ("      scripts: " + ($scripts -join ', '))

if (Test-Path $zip) {
  try { Remove-Item $zip -Force -ErrorAction Stop }
  catch { Write-Host "[warn] could not delete old zip; tar will overwrite it" }
}

# Expand server/ and shared/ into their files (minus tsc artifacts); every member is then
# passed to tar as an argument. Using args (rather than a -T list file) keeps the
# Chinese-named root launchers intact -- an ASCII-encoded
# list file would corrupt them.
$members = New-Object System.Collections.Generic.List[string]
foreach ($d in $dirs) { if (Test-Path (Join-Path $root $d)) { $members.Add($d) } }
foreach ($d in $splitDirs) {
  $base = Join-Path $root $d
  if (Test-Path $base) {
    Get-ChildItem $base -Recurse -File -Force |
      Where-Object { $_.Extension -ne '.js' } |
      ForEach-Object { $members.Add(($_.FullName.Substring($root.Length + 1) -replace '\\', '/')) }
  }
}
foreach ($f in $files)   { if (Test-Path (Join-Path $root $f)) { $members.Add($f) } }
foreach ($s in $scripts) { $members.Add($s) }

& $tar -a -c -f $zip -C $root @members
if ($LASTEXITCODE -ne 0) { Write-Host "::error::tar failed with exit code $LASTEXITCODE (zip=$zip)"; Write-Host "[error] tar failed with code $LASTEXITCODE"; exit 1 }

# ── VERIFY the archive before declaring success ───────────────────────────────
Write-Host "[2/2] verifying archive ..."
$listing = & $tar -tf $zip
$must = @(
  "node/node.exe",
  "node_modules/tsx/dist/cli.mjs",
  "node_modules/better-sqlite3/package.json",
  "node_modules/@napi-rs/canvas/package.json",
  "public/console.html",
  "server/index.ts",
  "server/services/platformPorts.ts",
  "shared/agentPrompt.ts",
  "package.json",
  "version.json",
  "setenv.bat",
  "start_all.bat",
  "start_server.bat",
  "start_platforms.bat"
)
$missing = $must | Where-Object { $listing -notcontains $_ }
if ($missing) {
  Write-Host ("::error::archive incomplete, missing: " + (($missing | Select-Object -First 10) -join ', '))
  Write-Host "[error] archive is incomplete, missing:"
  $missing | ForEach-Object { Write-Host "   - $_" }
  exit 1
}
# dev/self-use scripts must NOT ship (see $dropScripts for the rationale).
# NOTE: `tar -tf` output is decoded with the console codepage, so CJK-named entries
# may not compare equal in this process. This check therefore reliably covers the
# ASCII names; the CJK legacy packer is verified by listing the archive by hand
# (it is dropped by the Get-ChildItem filter above, which uses real .NET strings).
# Compare on BASENAME: the rule is "these names never ship, at any path level".
# An exact-path compare only ever protected the root copy -- which is exactly how
# v1.0.1 slipped a root `start.bat` into the archive on the runner (the root copy
# was in fact filtered, so it must have arrived via a packaged directory).
$shippedDev = $listing | Where-Object { $dropScripts -contains ($_ -replace '^.*/', '') }
if ($shippedDev) {
  $names  = ($shippedDev | Select-Object -First 10) -join ', '
  $atRoot = ($dropScripts | Where-Object { Test-Path (Join-Path $root $_) }) -join ', '
  Write-Host ("::error::developer-only scripts shipped: " + $names + " | present at repo root: [" + $atRoot + "]")
  Write-Host ("      diagnostic: zip=" + $zip + " ; scriptsSelected=" + ($scripts -join ','))
  Write-Host "[error] archive contains developer-only scripts:"
  $shippedDev | ForEach-Object { Write-Host "   - $_" }
  exit 1
}
# secrets / personal data must NOT be in there
$forbidden = $listing | Where-Object { $_ -eq ".env" -or $_ -like "data/*" -or $_ -like "src/*" -or $_ -like ".git/*" }
if ($forbidden) {
  Write-Host ("::error::archive contains files that must never be shipped: " + (($forbidden | Select-Object -First 10) -join ', '))
  Write-Host "[error] archive contains files that must never be shipped:"
  $forbidden | Select-Object -First 10 | ForEach-Object { Write-Host "   - $_" }
  exit 1
}

# tsc build artifacts (.js) under server/ or shared/ must never ship (tsx runs .ts directly)
$leftover = $listing | Where-Object { $_ -match '^server/.*\.js$' -or $_ -match '^shared/.*\.js$' }
if ($leftover) {
  Write-Host ("::error::archive still contains tsc build artifacts: " + (($leftover | Select-Object -First 10) -join ', '))
  Write-Host "[error] archive still contains tsc build artifacts (.js under server/ or shared/):"
  $leftover | Select-Object -First 10 | ForEach-Object { Write-Host "   - $_" }
  exit 1
}
# Reverse assertion: node_modules must not be damaged -- compare against the on-disk truth,
# not a guessed threshold. History: `--exclude=server/*.js` silently dropped 254 dependency
# files under node_modules/**/server/*.js before this audit caught it.
$diskNmJs = (Get-ChildItem (Join-Path $root 'node_modules') -Recurse -File -Force |
             Where-Object { $_.Extension -eq '.js' } | Measure-Object).Count
$zipNmJs  = ($listing | Where-Object { $_ -match '^node_modules/.*\.js$' } | Measure-Object).Count
if ($zipNmJs -lt $diskNmJs) {
  Write-Host ("::error::node_modules lost files: zip .js=$zipNmJs but disk .js=$diskNmJs")
  Write-Host "[error] node_modules lost files: zip .js=$zipNmJs but disk .js=$diskNmJs"
  exit 1
}

$sw.Stop()
$size = (Get-Item $zip).Length
Write-Host "  verified: all required files present, no secrets, no personal data"
Write-Host ("PACKED: " + $zip)
Write-Host ("  zip " + [math]::Round($size/1MB,1) + " MB | " + $listing.Count + " entries | elapsed " + [math]::Round($sw.Elapsed.TotalSeconds,1) + " s")
