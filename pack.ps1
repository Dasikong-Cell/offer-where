$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
if (-not $root) { Write-Host "[error] cannot resolve script directory"; exit 1 }
$zip = Join-Path ([Environment]::GetFolderPath('Desktop')) "job-apply-agent-portable.zip"
$tar = Join-Path $env:SystemRoot "System32\tar.exe"
if (-not (Test-Path $tar)) { Write-Host "[error] tar.exe not found (needs Windows 10 1803+)"; exit 1 }

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
$dirs  = @("node", "node_modules", "public", "server", "shared", "scripts")
$files = @("package.json", "package-lock.json", "tsconfig.json", ".env.example",
           "README.md", "DEVELOPMENT.md", "LOGIN_GUIDE.md", "LICENSE")

# every launcher/config script at repo root (.bat / .sh / .ps1)
$scripts = Get-ChildItem $root -File -Force |
  Where-Object { @('.bat', '.sh', '.ps1') -contains $_.Extension } |
  Select-Object -ExpandProperty Name

$items = @()
$items += $dirs   | Where-Object { Test-Path (Join-Path $root $_) }
$items += $files  | Where-Object { Test-Path (Join-Path $root $_) }
$items += $scripts

Write-Host "[1/2] packaging $($items.Count) top-level items ..."
Write-Host ("      dirs: " + (($items | Where-Object { $dirs -contains $_ }) -join ', '))
Write-Host ("      files: " + (($items | Where-Object { $files -contains $_ }) -join ', '))
Write-Host ("      scripts: " + ($scripts -join ', '))

if (Test-Path $zip) {
  try { Remove-Item $zip -Force -ErrorAction Stop }
  catch { Write-Host "[warn] could not delete old zip; tar will overwrite it" }
}
& $tar -a -c -f $zip -C $root @items
if ($LASTEXITCODE -ne 0) { Write-Host "[error] tar failed with code $LASTEXITCODE"; exit 1 }

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
  "shared/agentPrompt.ts",
  "package.json",
  "setenv.bat",
  "start_all.bat",
  "start_server.bat"
)
$missing = $must | Where-Object { $listing -notcontains $_ }
if ($missing) {
  Write-Host "[error] archive is incomplete, missing:"
  $missing | ForEach-Object { Write-Host "   - $_" }
  exit 1
}
# secrets / personal data must NOT be in there
$forbidden = $listing | Where-Object { $_ -eq ".env" -or $_ -like "data/*" -or $_ -like "src/*" -or $_ -like ".git/*" }
if ($forbidden) {
  Write-Host "[error] archive contains files that must never be shipped:"
  $forbidden | Select-Object -First 10 | ForEach-Object { Write-Host "   - $_" }
  exit 1
}

$sw.Stop()
$size = (Get-Item $zip).Length
Write-Host "  verified: all required files present, no secrets, no personal data"
Write-Host ("PACKED: " + $zip)
Write-Host ("  zip " + [math]::Round($size/1MB,1) + " MB | " + $listing.Count + " entries | elapsed " + [math]::Round($sw.Elapsed.TotalSeconds,1) + " s")
