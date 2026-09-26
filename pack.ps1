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
  'peek_page.ts', 'probe2.ts', 'probe_boss_apply.ts', 'probe_chat.ts', 'probe_findim.ts',
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
# CORRECTION (2026-09-27, first CI run of 934430e, the "script slimming" commit): this check originally
# required EVERY drop entry to exist on disk ($allScriptNames). That made the package
# UNBUILDABLE on a clean checkout. Five entries -- _probe_cdp_diag.ts, _probe_resume_sent.ts,
# _tmp_plan_probe.ts, probe_findim.ts, probe_imdeep.ts -- match the .gitignore rules for
# local probe/temp scripts, so they exist on the author's disk but NEVER in the repo.
# The author's pack went green, the runner's died with "scriptDrop is stale" and took the
# whole Release pipeline down with it. Local-green / CI-red is the worst possible shape for
# a guard: it hides in the one environment that never runs.
# An entry is genuinely stale only if the repo USED TO track that file and it is gone from
# disk now (renamed or deleted -- which is exactly what would silently start shipping it
# again). Untracked drop targets are allowed to be absent.
$trackedNames = @()
try {
  $trackedNames = @(& git -C $root ls-files scripts 2>$null | ForEach-Object { ($_ -split '/')[-1] })
} catch { }
$staleDrops = @($scriptDrop | Where-Object {
  $allScriptNames -notcontains $_ -and $trackedNames -contains $_
})
if ($staleDrops) {
  Write-Host ("::error::scriptDrop entries no longer exist in scripts/: " + ($staleDrops -join ', '))
  Write-Host "[error] scriptDrop is stale (file renamed or removed?):"
  $staleDrops | ForEach-Object { Write-Host "   - $_" }
  exit 1
}

# fail-closed the THIRD way: every script that WILL be shipped must be TRACKED BY GIT.
# Why this exists (2026-09-27): probe_chat.ts lives on the author's disk but is gitignored,
# and it was missing from $scriptDrop -- so the author's zip shipped 67 scripts while the
# runner's shipped 66. The difference is invisible in every log line; it only shows up if you
# diff the two pack outputs by hand. That means the artifact handed to a stranger was NOT the
# artifact CI builds, for a reason nobody would ever notice.
# Same equivalence as the stale-drop check above: "a file exists in CI" == "git ls-files
# knows about it". So a shipped-but-untracked script is precisely a file CI cannot have.
# Guarded on $trackedNames being non-empty: outside a git work tree (or without git) this
# check cannot know anything, so it stands down and says so rather than false-failing.
$untrackedShipped = @($scriptFiles |
  Where-Object { $trackedNames -notcontains $_.Name } |
  ForEach-Object { $_.Name } | Sort-Object)
if ($trackedNames.Count -eq 0) {
  Write-Host "      scripts/ tracking check: SKIPPED (no git work tree, or git unavailable)"
} elseif ($untrackedShipped.Count -gt 0) {
  Write-Host ("::error::scripts shipped but not tracked by git (CI will not have them): " + ($untrackedShipped -join ', '))
  Write-Host "[error] a local-only script would be packaged here but is absent on the runner:"
  $untrackedShipped | ForEach-Object { Write-Host "   - $_" }
  Write-Host "        fix: add the name to `$scriptDrop, or commit the file."
  exit 1
} else {
  Write-Host ("      scripts/ tracking check: all " + $scriptFiles.Count + " shipped files are tracked by git")
}

# fail-closed: npm leaves duplicate copies behind when an install is interrupted. It renames the
# package it is about to replace to ".<name>-<8 random chars>" and deletes it afterwards; a crash
# in between leaves the full copy on disk. On 2026-09-27 the author's node_modules carried 69 of
# them: 48,456 files / 340 MiB of duplicated packages. They were packaged silently, inflating the
# zip from 352.7 MB to 454.7 MB and making the local package differ from the CI one by 48,525
# entries -- visible in no log line at all, only in a hand-diff of the two archives.
# The pattern is npm-specific, and it has to be tight: the author's node_modules also contains
# genuine dotted files such as node_modules/jszip/.jekyll-metadata, and a first version of this
# check flagged exactly that -- a false alarm, which is how guards end up being switched off.
# Two independent conditions, both of which must hold:
#   1. npm only ever renames a package INTO ITS OWN PARENT, i.e. node_modules/, node_modules/.bin/
#      or a scope directory node_modules/@scope/. Never inside a package, never deeper.
#   2. the trailing token npm appends is 8 random base64-ish chars and in practice always mixes
#      case and digits ("Gra2BtSh", "ufHTURG0"). ".jekyll-metadata" fails this: all lowercase.
# Depth 1 covers the plain packages, the scoped ones and the files inside node_modules/.bin.
$nmRoot = Join-Path $root 'node_modules'
$npmTemp = @()
if (Test-Path -LiteralPath $nmRoot) {
  $npmTemp = @(Get-ChildItem -LiteralPath $nmRoot -Force -Recurse -Depth 1 -ErrorAction SilentlyContinue |
    Where-Object {
      $rel = ($_.FullName.Substring($root.Length + 1) -replace '\\', '/')
      $seg = $rel.Split('/')
      if ($seg.Length -lt 2) { return $false }
      $parentRel = ($seg[0..($seg.Length - 2)] -join '/')
      $parentIsNpmSlot = ($parentRel -eq 'node_modules') -or ($parentRel -eq 'node_modules/.bin') -or ($parentRel -match '^node_modules/@[^/]+$')
      $m = [regex]::Match($_.Name, '^\..*-([A-Za-z0-9]{8})$')
      $parentIsNpmSlot -and $m.Success -and ($m.Groups[1].Value -cmatch '[A-Z]') -and ($m.Groups[1].Value -match '[0-9]')
    } |
    ForEach-Object { ($_.FullName.Substring($root.Length + 1) -replace '\\', '/') } |
    Sort-Object)
}
if ($npmTemp) {
  Write-Host ("::error::node_modules holds npm temp leftovers from an interrupted install: " + (($npmTemp | Select-Object -First 10) -join ', '))
  Write-Host "[error] these duplicate packages would be shipped; remove them (or run a clean install):"
  $npmTemp | Select-Object -First 10 | ForEach-Object { Write-Host "   - $_" }
  exit 1
} else {
  Write-Host "      node_modules: 0 npm temp leftovers"
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
# list file adds a second encoding hop (the file itself) on top of the argv encoding, and
# args cost nothing. Keep it that way.
# CORRECTION (2026-09-26, measured): an earlier version of this comment claimed
# "scripts/ and node_modules/ still hold many non-ASCII paths". That is false -- the whole
# shipped set is 100% ASCII (0 non-ASCII paths out of 173080 files across node/,
# node_modules/, public/, server/, shared/, scripts/, verified by a full walk; the archive
# listing is likewise 0 bytes >127 across all 181290 entries). The argument therefore
# stands on robustness, NOT on "there are CJK names today". See the ASCII-only guard below,
# which now enforces that property instead of leaving it to luck.
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
# 2026-09-27: this guard ALSO catches references to files that are gitignored on purpose
# (scripts/*probe*.ts and friends exist only on the author's disk, so the author's pack is
# green while the runner's fails -- the same local-green/CI-red shape as the stale-drop
# check above). The message says "fix the path", but the right fix is usually to drop the
# `scripts/` prefix from a source comment so it reads as prose rather than as a shippable
# path. References from docs/ are fine: docs/ is not in the ship set, so it is not scanned.
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

# -- ASCII-only guard, shipping set (2026-09-26) -------------------------------
# A CJK filename inside a zip is stored as GBK bytes WITHOUT the UTF-8 flag, so an
# English Windows extracts it as mojibake and the recipient cannot even tell which file
# to double-click. That is exactly why the desktop-entry helper was renamed to ASCII.
# Measured 2026-09-26: the packaged archive is 100% ASCII (all 181290 entries; 0 bytes
# >127 in the whole `tar -tf` listing) and the shipped directories hold 0 non-ASCII
# paths out of 173080 files. That property is load-bearing, not cosmetic: `tar -tf`
# output is decoded with the console codepage (gb2312 on a zh-CN box, possibly UTF-8 on
# a runner), so a non-ASCII entry can decode to U+FFFD or simply compare unequal and
# silently defeat BOTH the $must pins and the $shippedDev basename compare -- the very
# assertion that failed v1.0.1. Assert it instead of assuming it.
# Runs BEFORE tar: a CJK launcher costs 3s here instead of 5min. This half covers the
# root launchers, $files, and the file-enumerated server/ + shared/ + scripts/.
# The wholesale dirs (node/, node_modules/, public/) are NOT in $members -- tar recurses
# into them itself, so they are covered by the archive-level twin below.
$nonAsciiMembers = @($members | Where-Object { $_ -match '[^\x00-\x7F]' })
if ($nonAsciiMembers) {
  Write-Host ("::error::ship set contains non-ASCII names: " + (($nonAsciiMembers | Select-Object -First 10) -join ', '))
  Write-Host "[error] these would ship with a name that extracts as mojibake on an English Windows:"
  $nonAsciiMembers | Select-Object -First 10 | ForEach-Object { Write-Host "   - $_" }
  exit 1
}

# -- PORTABILITY GUARD, author identity (2026-09-26) ---------------------------
# Bug class: a path that only works on the machine that wrote it. Four of them were
# found in the ship set on 2026-09-26 -- ensure_chrome.sh and scripts/start_cdp_chrome.sh
# hardcoded the author's Chrome path, and three ts one-shots (apply_boss / batch_apply /
# batch_multi) hardcoded ROOT to the author's repo path. All four work perfectly on the
# author's box, so none of them is caught by tsc / selftest / contract tests / smoke --
# they only break at runtime, on a recipient's machine.
# Matching the generic shape `X:/Users/...` was tried first and REJECTED: it also flags
# a legitimate comment that documents the old bug using a placeholder
# (server/services/localEnv.ts writes `C:/Users/<author>/AppData/...`). Guessing at
# shapes produces false alarms that get the guard disabled. So assert the concrete
# thing instead: the packing user's own account name and the absolute path of this
# checkout must not appear in any shipped text file. Whoever runs pack.ps1 IS the
# author, so $env:USERNAME / $root is exactly the identity to look for, and the check
# stays correct when someone else packs the project.
# A 3-char floor keeps very short account names from matching ordinary prose; it also
# means a 1-2 char account name is not caught by the name check (acceptable: rare, and
# the two $root forms below still catch any packaged absolute path).
# Runs BEFORE tar: ~2s over ~350 files, versus a 5min pack plus a bug report.
$textExt = @('.ts', '.js', '.mjs', '.cjs', '.json', '.md', '.html', '.htm', '.css',
             '.sh', '.bat', '.cmd', '.ps1', '.txt', '.yml', '.yaml', '.example')
$identities = @($env:USERNAME, $root, ($root -replace '\\', '/')) |
  Where-Object { $_ -and $_.Length -ge 3 }
$scanSet = @($members | Where-Object {
  -not $_.StartsWith('node_modules/') -and -not $_.StartsWith('node/') -and
  $textExt -contains ([System.IO.Path]::GetExtension($_).ToLower())
})
$identityLeaks = New-Object System.Collections.Generic.List[string]
foreach ($rel in $scanSet) {
  $full = Join-Path $root $rel
  if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { continue }
  $txt = ''
  try { $txt = [System.IO.File]::ReadAllText($full) } catch { continue }
  foreach ($id in $identities) {
    if ($txt.IndexOf($id, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
      $identityLeaks.Add($rel + '  <- contains "' + $id + '"')
      break
    }
  }
}
if ($identityLeaks.Count -gt 0) {
  Write-Host ("::error::shipped files leak the author's machine identity: " + (($identityLeaks | Select-Object -First 10) -join ' | '))
  Write-Host "[error] these work only on the machine that packed them:"
  $identityLeaks | Select-Object -First 10 | ForEach-Object { Write-Host "   - $_" }
  exit 1
}
Write-Host ("      portability: " + $scanSet.Count + " shipped text files scanned, 0 author-identity leaks")

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
# NOTE: `tar -tf` output is decoded with the console codepage, so a CJK-named entry might
# not compare equal in this process. That blind spot is now closed by construction rather
# than by hand: the ASCII-only guard below asserts the archive holds ZERO non-ASCII entry
# names, so every name in it -- the CJK legacy packer included -- is in the reliably
# comparable class. (The packer is also dropped by the Get-ChildItem filter above, which
# uses real .NET strings; that is the primary defence, this is the belt.)
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
# -- ASCII-only guard, archive level (2026-09-26) ------------------------------
# Twin of the pre-tar check: same rationale (see the note above that block), but this
# one reads the REAL archive listing, so it also covers node/, node_modules/ and
# public/, which tar recurses into on its own without $members ever seeing them.
$nonAsciiEntries = @($listing | Where-Object { $_ -match '[^\x00-\x7F]' })
if ($nonAsciiEntries) {
  Write-Host ("::error::archive contains non-ASCII entry names: " + (($nonAsciiEntries | Select-Object -First 10) -join ', '))
  Write-Host "[error] archive contains non-ASCII entry names (they extract as mojibake on an English Windows):"
  $nonAsciiEntries | Select-Object -First 10 | ForEach-Object { Write-Host "   - $_" }
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
