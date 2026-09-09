$root = "C:\Users\吉学静\WorkBuddy\2026-09-02-09-33-33\job-apply-agent"
$stage = Join-Path $env:TEMP "job-apply-agent-portable"
$zip = Join-Path ([Environment]::GetFolderPath('Desktop')) "job-apply-agent-portable.zip"

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null

Write-Host "复制项目到临时目录(排除 .git / chrome-cdp-profile / *.log) ..."
Copy-Item -Path "$root\*" -Destination $stage -Recurse -Force
Remove-Item (Join-Path $stage ".git") -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $stage "chrome-cdp-profile") -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $stage "data") -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem $stage -Recurse -Filter *.log | Remove-Item -Force -ErrorAction SilentlyContinue

Write-Host "压缩到桌面: $zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -Force

$size = (Get-Item $zip).Length
Write-Host ("PACKED: " + $zip + "  (" + [math]::Round($size/1MB, 1) + " MB)")
