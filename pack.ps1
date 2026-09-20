$root = $PSScriptRoot
if (-not $root) { $root = "C:\Users\吉学静\WorkBuddy\2026-09-02-09-33-33\job-apply-agent" }
$stage = Join-Path $env:TEMP "job-apply-agent-portable"
$zip = Join-Path ([Environment]::GetFolderPath('Desktop')) "job-apply-agent-portable.zip"

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null

Write-Host "复制项目到临时目录 ..."
Copy-Item -Path "$root\*" -Destination $stage -Recurse -Force

# 排除目录：版本库 / 调试 profile / 运行数据(含个人简历) / 开发期前端 / 旧构建产物 / 内部材料
$dropDirs = @(
  ".git", "chrome-cdp-profile", "chrome-cdp-profile-official",
  "data", "src", "dist", "zhideya_analysis", "zhideya-analysis",
  ".workbuddy", ".github"
)
foreach ($d in $dropDirs) {
  $p = Join-Path $stage $d
  if (Test-Path $p) { Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue }
}

# 排除文件：开发期构建配置 / 内部工作报告（README/DEVELOPMENT/LOGIN_GUIDE 保留给使用者）
$dropFiles = @(
  "index.html", "vite.config.ts", "vite.config.js", "vite.config.d.ts",
  "postcss.config.js", "tailwind.config.js", "tsconfig.node.json",
  "ARCH_REPORT.md", "BOSS_OPENAPI_PLAN.md",
  "DELIVERY_auto_run.md", "DELIVERY_gagajob.md", "DELIVERY_offerbiu.md", "DELIVERY_test.md",
  "REFERENCE_gagajob.md", "OPTIMIZATION_PLAN_2026-09-19.md", "FIXES_2026-09-19.md",
  "OVERVIEW.md", "OVERVIEW_offerbiu_round_2026-09-18.md", "OVERVIEW_offerbiu_round2_2026-09-18.md",
  "ZHIDEYA_ANALYSIS.md", "ZHIDEYA_DEEP_ANALYSIS.md", "ZHIDEYA_FORENSICS.md",
  "probe.json", "probe2.json"
)
foreach ($f in $dropFiles) {
  $p = Join-Path $stage $f
  if (Test-Path $p) { Remove-Item $p -Force -ErrorAction SilentlyContinue }
}
# 收紧：内部评估报告按前缀清理（保留 README/DEVELOPMENT/LOGIN_GUIDE）
Get-ChildItem $stage -Filter "ASSESSMENT_*.md" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
Get-ChildItem $stage -Recurse -Filter *.log -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

Write-Host "压缩到桌面: $zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -Force

$size = (Get-Item $zip).Length
Write-Host ("PACKED: " + $zip + "  (" + [math]::Round($size/1MB, 1) + " MB)")
