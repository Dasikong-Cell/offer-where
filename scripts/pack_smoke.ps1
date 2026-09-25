# pack_smoke.ps1 -- real acceptance smoke test for the portable package.
#
# Flow: pack.ps1 -> extract the zip into a FRESH dir -> start the server with the
# BUNDLED node -> probe /api/ping + /api/health + a DB-backed endpoint -> clean up.
#
# ASCII-only on purpose: PowerShell 5.1 reads a BOM-less .ps1 as ANSI/GBK, so any
# non-ASCII character (e.g. Chinese comments) breaks parsing. Keep it ASCII.
#
# Exit code 0 = package is truly "unzip and run"; non-zero = something is broken
# (the CI workflow calls this on windows-latest to guard the real delivery path).

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$tar = Join-Path $env:SystemRoot "System32\tar.exe"

Write-Host "[1/4] packing ..."
& (Join-Path $root "pack.ps1")
# Must mirror pack.ps1's destination resolution exactly (PACK_ZIP_DIR -> Desktop -> repo root).
$destDir = $env:PACK_ZIP_DIR
if (-not $destDir) { $destDir = [Environment]::GetFolderPath('Desktop') }
if (-not ($destDir -and (Test-Path $destDir))) { $destDir = $root }
$zip = Join-Path $destDir "job-apply-agent-portable.zip"
if (-not (Test-Path $zip)) { throw "zip not found after pack: $zip" }
Write-Host ("      zip = " + $zip + " (" + [math]::Round((Get-Item $zip).Length / 1MB, 1) + " MB)")

Write-Host "[2/4] extracting into a fresh directory ..."
$tmp = Join-Path $env:TEMP ("jobapply_smoke_" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
& $tar -xf $zip -C $tmp
if ($LASTEXITCODE -ne 0) { throw "tar extract failed with code $LASTEXITCODE" }

Write-Host "[3/4] asserting fresh-machine state ..."
foreach ($f in @(
  "node/node.exe",
  "node_modules/tsx/dist/cli.mjs",
  "node_modules/better-sqlite3/package.json",
  "server/index.ts",
  "shared/agentPrompt.ts",
  "public/console.html",
  ".env.example",
  "package.json"
)) {
  if (-not (Test-Path (Join-Path $tmp $f))) { throw "missing required file in package: $f" }
}
foreach ($bad in @(".env", "data", "src", ".git")) {
  if (Test-Path (Join-Path $tmp $bad)) { throw "file that must never ship is present: $bad" }
}
$srvJs = Get-ChildItem (Join-Path $tmp 'server') -Recurse -File -Filter *.js -ErrorAction SilentlyContinue
if ($srvJs) { throw "tsc build artifacts leaked into package: server/**/*.js (" + ($srvJs | Measure-Object).Count + " files)" }
Write-Host "      required files present, no secrets/personal data, no build artifacts"

Write-Host "[4/4] starting the packaged server with the bundled node ..."
$env:PORT = "4401"
$env:HOST = "127.0.0.1"
$node = Join-Path $tmp "node\node.exe"
$cli = Join-Path $tmp "node_modules\tsx\dist\cli.mjs"
$p = Start-Process -FilePath $node -ArgumentList @($cli, "server/index.ts") -WorkingDirectory $tmp -PassThru -WindowStyle Hidden
try {
  $ready = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Seconds 2
    try {
      $r = Invoke-RestMethod -Uri "http://127.0.0.1:4401/api/ping" -TimeoutSec 4
      if ($r.ok) { $ready = $true; break }
    } catch { }
  }
  if (-not $ready) { throw "packaged server never became ready on :4401" }

  $h = Invoke-RestMethod -Uri "http://127.0.0.1:4401/api/health" -TimeoutSec 8
  if ($h.status -ne 'ok') { throw "health not ok: " + ($h | ConvertTo-Json -Compress) }

  # DB-backed endpoint: proves the bundled native SQLite module actually loaded.
  $q = Invoke-RestMethod -Uri "http://127.0.0.1:4401/api/apply/quota?platform=boss" -TimeoutSec 8
  if ($q.platform -ne 'boss') { throw "quota endpoint broken: " + ($q | ConvertTo-Json -Compress) }

  # ── P0 regression guard: the port table MUST resolve without data/browser/cdp.json ──
  # data/ never ships (it holds the resume, DB and login profiles), so a recipient has
  # no cdp.json. History (2026-09-25 out-of-box test): connection.ts / browser.ts
  # returned null when the file was missing -> every platform reported "not configured"
  # and the apply engine degraded to Playwright's own Chromium -> the recipient got
  # "Chromium 浏览器未下载。请执行：npx playwright install chromium" and the app's
  # single core feature was dead on arrival. This assert is the guard for that.
  $conn = Invoke-RestMethod -Uri "http://127.0.0.1:4401/api/browser/connections" -TimeoutSec 15
  $boss = $conn.connections.boss
  if (-not $boss.endpoint) { throw "port table lost its built-in fallback: boss endpoint is null without data/browser/cdp.json" }
  if ($boss.endpoint -ne 'http://127.0.0.1:9223') { throw "unexpected default boss endpoint: " + $boss.endpoint }

  # first-run self check must return the checklist (this is what tells a recipient
  # what is still missing instead of leaving them staring at a blank console)
  $sc = Invoke-RestMethod -Uri "http://127.0.0.1:4401/api/selfcheck" -TimeoutSec 20
  if (-not $sc.items -or @($sc.items).Count -lt 5) { throw "selfcheck did not return the expected checklist" }

  # response SHAPE guard for the platform health feed. History (2026-09-25): the API
  # returns {deep, summary, platforms:[...]} (an ARRAY), but console.html indexed it as
  # a keyed map (health[platformId]) and read non-existent fields (st.status / st.logged
  # instead of verdict) -> all 15 dashboard cards silently showed "未知" forever while
  # typecheck and every other test stayed green. deep=0 does not navigate any page, so
  # this assert is fast and cannot disturb the platform windows.
  $ph = Invoke-RestMethod -Uri "http://127.0.0.1:4401/api/platforms/health?deep=0" -TimeoutSec 40
  $items = @($ph.platforms)
  if ($items.Count -lt 10) { throw "platforms/health did not return the full platform array (got $($items.Count))" }
  $one = $items[0]
  if (-not $one.platform -or -not $one.verdict) {
    throw "platforms/health items must expose .platform and .verdict -- console.html maps them by that field"
  }
  Write-Host ("      platforms/health: " + $items.Count + " items, sample=" + $one.platform + "/" + $one.verdict)

  # build stamp must be shipped so a recipient can tell which revision they have
  if (-not (Test-Path (Join-Path $tmp 'version.json'))) { throw "version.json (build stamp) is missing from the package" }

  # console document must be served
  $doc = Invoke-WebRequest -Uri "http://127.0.0.1:4401/" -TimeoutSec 8 -UseBasicParsing
  if ($doc.StatusCode -ne 200 -or $doc.RawContentLength -lt 1000) { throw "console not served properly" }

  # the app must have recreated data/chat.db from scratch
  if (-not (Test-Path (Join-Path $tmp 'data/chat.db'))) { throw "data/chat.db was not auto-created" }

  Write-Host ("SMOKE OK  health=" + ($h | ConvertTo-Json -Compress) + "  consoleBytes=" + $doc.RawContentLength)
} finally {
  if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  # tsx spawns a child process; kill anything still holding the temp dir
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like ("*" + $tmp + "*") } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1
  if (Test-Path $tmp) {
    try { [System.IO.Directory]::Delete($tmp, $true) } catch { Write-Host ("[warn] could not remove " + $tmp) }
  }
  Write-Host "cleaned up smoke dir"
}
