$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
if (-not $root) { Write-Host "[error] cannot resolve script directory"; exit 1 }

# -- CI diagnosability ---------------------------------------------------------
# GitHub Actions logs are NOT readable without a token, but check-run ANNOTATIONS
# are. Emitting the `::error::` workflow command turns every failure branch into
# an annotation, so a red release run can be diagnosed via the public API alone
# (2026-09-26: v1.0.0's "pack" step failed on the runner while the identical
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

# -- ALLOW-LIST packaging ------------------------------------------------------
# Deliver only what an end user needs. Anything not listed here is simply never
# archived -- that automatically keeps out: .env (API keys!), data/ (personal
# resume + DB + browser profiles), src/, dist/, .git/, internal reports.
# Do NOT go back to "--exclude=<name>": bsdtar matches exclude patterns against
# directory NAMES too, so "--exclude=./dist" also killed node_modules/tsx/dist/
# and produced a package that could not start.
$dirs  = @("node", "node_modules", "public")
# server/ and shared/ are archived file-by-file so their tsc build artifacts (*.js emitted
# next to *.ts) can be dropped -- the app runs .ts via tsx, so those .js are redundant and
# a stale copy could shadow its same-named .ts.
# NOTE: do NOT reintroduce tar's --exclude here. bsdtar matches a pattern such as
# `server/*.js` at ANY path level, so it also deleted node_modules/**/server/*.js
# (254 dependency files silently lost -- caught by the audit assertion below).
# Enumerating files explicitly is the only reliable way to scope it to the top level.
$splitDirs = @("server", "shared")
# -- build stamp ---------------------------------------------------------------
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
# start_platforms.bat / create_desktop_shortcut.bat (the real launchers plus the
# desktop-entry helper), and ensure_chrome.sh (README's script table and the
# console's "window offline" hint still point at it as a manual recovery path).
# NOTE: all root launchers are ASCII as of 2026-09-26. The desktop-entry helper was
# renamed FROM a CJK name precisely because a CJK entry inside the zip is stored as
# GBK bytes WITHOUT the UTF-8 flag, so an English Windows extracts it as mojibake and
# the recipient cannot even tell which file to double-click.
# The one remaining CJK-named root script is the legacy repacker (dropped from the
# package below), so it is built from codepoints at runtime instead of literally.
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

# -- scripts/ pruning (2026-09-26) ---------------------------------------------
# scripts/ used to ship wholesale. By now ~93 files live there and a third of them
# are one-off debug instrumentation (DOM probes, diag dumps, temp scripts) that only
# ever ran on the author's machine. A recipient looking for "how do I collect jobs"
# cannot tell `diag_chat_sendflow.ts` from `collect_boss.ts`.
#
# The line is drawn by KIND, not by "looks unused":
#   DROP  one-off debug/temp tools (diag*, probe*, peek_*, `_`-prefixed temp scripts)
#         + dev-only tooling (pack_smoke.ps1 repacks and needs pack.ps1, which never
#           ships; icon_candidates.py is the icon design scratchpad and needs Pillow)
#   KEEP  everything else, *including* collectors/checkers that no document mentions
#         (collect_zhilian.ts, apply_one51.ts, cleanup_data.ts, countjobs.ts, ...).
#         Those are part of the CLI capability surface -- a user can run them with the
#         bundled node, and "not mentioned in README" is not evidence of junk.
# Nothing here is taken on trust: the reference guard below refuses to ship a package
# in which any drop target is still referenced by a shipped file.
$scriptDrop = @(
  # --- one-off debug instrumentation (by kind) ---
  '_probe_cdp_diag.ts', '_probe_resume_sent.ts', '_tmp_plan_probe.ts',
  'diag51.ts', 'diag51b.ts', 'diag51c.ts',
  'diag_boss_list.ts', 'diag_boss_msgs.ts',
  'diag_chat.ts', 'diag_chat_click.ts', 'diag_chat_dom.ts', 'diag_chat_input.ts',
  'diag_chat_list.ts', 'diag_chat_resume_pick.ts', 'diag_chat_sendflow.ts',
  'diag_chat_upload_resume.ts',
  'diag_job51_jd.ts', 'diag_job51_jd_modal.ts', 'diag_job51_modal.ts', 'diag_login.ts',
  'peek_page.ts', 'probe2.ts', 'probe_boss_apply.ts', 'probe_findim.ts',
  'probe_imdeep.ts', 'probe_multi.ts',
  # --- dev-only tooling ---
  'pack_smoke.ps1',        # repack+smoke driver; pack.ps1 itself is never shipped
  'calibrate_pending.sh',  # bash calibration one-shot (needs Git Bash; author-only)
  'icon_candidates.py'     # icon candidate renderer (needs Pillow; design-time only)
)
$allScriptNames = @(Get-ChildItem (Join-Path $root 'scripts') -Recurse -File -Force | ForEach-Object { $_.Name })
$scriptFiles = @(Get-ChildItem (Join-Path $root 'scripts') -Recurse -File -Force |
  Where-Object { $scriptDrop -notcontains $_.Name })
# fail-closed the other way: a drop entry that no longer exists means the list has rotted.
# NOTE: compare against $allScriptNames (the unfiltered listing) -- comparing against
# $scriptFiles would always report every entry as stale, since that list is the result
# of removing them (2026-09-26: wrote it the wrong way round first; the guard failed
# loudly rather than silently passing, which is the point of fail-closed).
$staleDrops = @($scriptDrop | Where-Object { $allScriptNames -notcontains $_ })
if ($staleDrops) {
  Write-Host ("::error::scriptDrop entries no longer exist in scripts/: " + ($staleDrops -join ', '))
  Write-Host "[error] scriptDrop is stale (file renamed or removed?):"
  $staleDrops | ForEach-Object { Write-Host "   - $_" }
  exit 1
}

$items = @()
$items += $dirs      | Where-Object { Test-Path (Join-Path $root $_) }
$items += $splitDirs | Where-Object { Test-Path (Join-Path $root $_) }
$items += $files     | Where-Object { Test-Path (Join-Path $root $_) }
$items += $scripts
$items += 'scripts'

Write-Host "[1/2] packaging $($items.Count) top-level items ..."
Write-Host ("      dirs: " + (($items | Where-Object { $dirs -contains $_ }) -join ', '))
Write-Host ("      split(minus *.js): " + (($items | Where-Object { $splitDirs -contains $_ }) -join ', '))
Write-Host ("      files: " + (($items | Where-Object { $files -contains $_ }) -join ', '))
Write-Host ("      root launchers: " + ($scripts -join ', '))
Write-Host ("      scripts/ : " + $scriptFiles.Count + " files shipped, " + $scriptDrop.Count + " dev-only dropped (" + ($scriptDrop -join ', ') + ")")

# NOTE: the old zip is deleted just before tar runs (below), NOT here. Deleting early
# meant that a failed validation left the user with no artifact at all -- noticed on
# 2026-09-26 when the reference guard aborted after this point and the desktop zip was
# already gone.

# Expand server/ and shared/ into their files (minus tsc artifacts); every member is then
# passed to tar as an argument. Using args (rather than a -T list file) is deliberate: a
# list file written as ASCII would corrupt non-ASCII names. Every root launcher is ASCII
# today (2026-09-26), but scripts/ and node_modules/ still hold many non-ASCII paths, so
# this stays args-based.
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
# scripts/ is enumerated file-by-file so the dev-only drop list is actually enforced.
# [!] Do NOT also pass the bare directory name: `tar -c scripts` recurses and archives
# everything inside it, silently undoing the enumeration (2026-09-26: the archive-level
# assertion below caught exactly that). Passing the file paths alone is enough -- tar
# creates the parent entry implicitly.
foreach ($sf in $scriptFiles) {
  $members.Add(($sf.FullName.Substring($root.Length + 1) -replace '\\', '/'))
}

# -- REFERENCE GUARD (runs BEFORE tar, so a bad drop costs 3s instead of 5min) --
# The safety net for pruning: if a file that WILL be shipped (server code, the console,
# the manual, a launcher, or another shipped script) mentions `scripts/<name>`, then that
# script must be in the archive. This is what makes "drop by kind" safe -- a drop that
# removes something still in use fails the build instead of shipping a dead reference.
# History: this guard immediately found two dangling references that had been sitting in
# shipped code (`scripts/ensure_chrome.sh` -- the file is at the repo root, so the console's
# offline hint was telling users to run a path that does not exist).
$refFiles = New-Object System.Collections.Generic.List[string]
foreach ($d in @('server', 'shared')) {
  $p = Join-Path $root $d
  if (Test-Path $p) {
    Get-ChildItem $p -Recurse -File -Force |
      Where-Object { $_.Extension -in @('.ts', '.html') -and $_.Name -notlike '*.d.ts' } |
      ForEach-Object { $refFiles.Add($_.FullName) }
  }
}
$pub = Join-Path $root 'public'
if (Test-Path $pub) {
  Get-ChildItem $pub -Recurse -File -Force -Filter *.html | ForEach-Object { $refFiles.Add($_.FullName) }
}
foreach ($f in @('README.md', 'DEVELOPMENT.md', 'LOGIN_GUIDE.md')) {
  $p = Join-Path $root $f
  if (Test-Path $p) { $refFiles.Add($p) }
}
foreach ($s in $scripts) { $refFiles.Add((Join-Path $root $s)) }
foreach ($sf in $scriptFiles) { $refFiles.Add($sf.FullName) }

$refs = New-Object System.Collections.Generic.List[string]
foreach ($f in $refFiles) {
  $txt = Get-Content -LiteralPath $f -Raw
  foreach ($m in [regex]::Matches($txt, 'scripts/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+')) {
    if (-not $refs.Contains($m.Value)) { $refs.Add($m.Value) }
  }
}
# only enforce for paths that exist in the repo: a typo pointing at nothing is a doc bug,
# not something the drop list caused -- but it must not be silently ignored either, so it
# is reported as an error too (that is how the ensure_chrome.sh hint was caught).
$missingOnDisk = @($refs | Where-Object { -not (Test-Path (Join-Path $root $_)) })
if ($missingOnDisk) {
  Write-Host ("::error::shipped files reference scripts that do not exist: " + (($missingOnDisk | Select-Object -First 10) -join ', '))
  Write-Host "[error] dangling references (fix the path in the referencing file):"
  $missingOnDisk | Select-Object -First 10 | ForEach-Object { Write-Host "   - $_" }
  exit 1
}
$notShipped = @($refs | Where-Object { $members -notcontains $_ })
if ($notShipped) {
  Write-Host ("::error::referenced scripts are excluded by the drop list: " + (($notShipped | Select-Object -First 10) -join ', '))
  Write-Host "[error] these are referenced by shipped files but would not be packaged:"
  $notShipped | Select-Object -First 10 | ForEach-Object { Write-Host "   - $_" }
  exit 1
}

# All validations passed -- now (and only now) it is safe to replace the previous zip.
if (Test-Path $zip) {
  try { Remove-Item $zip -Force -ErrorAction Stop }
  catch { Write-Host "[warn] could not delete old zip; tar will overwrite it" }
}

& $tar -a -c -f $zip -C $root @members
if ($LASTEXITCODE -ne 0) { Write-Host "::error::tar failed with exit code $LASTEXITCODE (zip=$zip)"; Write-Host "[error] tar failed with code $LASTEXITCODE"; exit 1 }

# -- VERIFY the archive before declaring success -------------------------------
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
  "start_platforms.bat",
  # Pinned as of 2026-09-26. The desktop-entry helper is ASCII now, and that is what
  # makes this assertion possible at all: tar -tf output is decoded with the console
  # codepage, so a CJK-named entry could not be compared reliably (see the note above
  # the $shippedDev check). Renaming it closed that blind spot.
  "create_desktop_shortcut.bat",
  # scripts/ is now file-enumerated (see $scriptDrop), so pin the ones that must always
  # be there: the single script the server spawns at runtime, the shared CDP helper, and
  # a representative collector. Without these the app starts but one core feature is dead.
  "scripts/ocr_wechat_jd.ts",
  "scripts/lib/browser.ts",
  "scripts/lib/apiAuth.ts",
  "scripts/collect_boss.ts"
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
# ASCII names (as of 2026-09-26 that is every root launcher, so `$must` pins them all);
# the CJK legacy packer is verified by listing the archive by hand
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

# -- scripts/ guards (2026-09-26) ----------------------------------------------
# (a) no drop target may survive in the archive (the enumeration above is the only
#     thing enforcing the drop list -- prove it worked instead of assuming).
$shippedDrops = $listing | Where-Object { $scriptDrop -contains ($_ -replace '^.*/', '') }
if ($shippedDrops) {
  Write-Host ("::error::dropped dev scripts are still in the archive: " + (($shippedDrops | Select-Object -First 10) -join ', '))
  Write-Host "[error] scripts/ drop list was not enforced:"
  $shippedDrops | Select-Object -First 10 | ForEach-Object { Write-Host "   - $_" }
  exit 1
}
# (b) every referenced script must be inside the REAL archive too (the pre-tar guard worked
#     on the intended member list; this proves tar did not silently skip any of them).
$danglingInZip = @($refs | Where-Object { $listing -notcontains $_ })
if ($danglingInZip) {
  Write-Host ("::error::referenced scripts missing from the archive: " + (($danglingInZip | Select-Object -First 10) -join ', '))
  Write-Host "[error] these are referenced by shipped files but absent from the zip:"
  $danglingInZip | Select-Object -First 10 | ForEach-Object { Write-Host "   - $_" }
  exit 1
}
Write-Host ("      scripts/ verified: " + $scriptFiles.Count + " shipped, " + $scriptDrop.Count + " dev-only excluded, " + $refs.Count + " referenced paths all present")
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
