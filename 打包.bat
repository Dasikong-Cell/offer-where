@echo off
chcp 65001 >nul
REM ============================================================
REM Package into a distributable zip (output to desktop)
REM Excludes: .git, chrome-cdp-profile (private login state), *.log
REM Includes: source, node_modules, node\ runtime
REM  => Recipients just unzip and double-click start_all.bat
REM ============================================================
set "ROOT=%~dp0"
set "STAGE=%TEMP%\job-apply-agent-portable"
REM Resolve the real desktop path (some systems redirect it)
for /f "usebackq delims=" %%D in (`powershell -NoProfile -Command "[Environment]::GetFolderPath('Desktop')"`) do set "DESKTOP=%%D"
if not defined DESKTOP set "DESKTOP=%USERPROFILE%\Desktop"
set "ZIP=%DESKTOP%\job-apply-agent-portable.zip"

echo 正在准备可移植包（排除 .git / 个人登录 profile / 日志）...
rd /s /q "%STAGE%" 2>nul
mkdir "%STAGE%" 2>nul
robocopy "%ROOT%." "%STAGE%" /E /XD .git chrome-cdp-profile data /XF *.log
if not exist "%STAGE%\node\node.exe" echo [提示] 未找到自带 node\，接收者需自行安装 Node 并 npm install。

echo 正在压缩到桌面：%ZIP%
powershell -NoProfile -Command "Compress-Archive -Path '%STAGE%\*' -DestinationPath '%ZIP%' -Force"

echo.
if exist "%ZIP%" (
  for %%A in ("%ZIP%") do echo 打包完成：%ZIP%  (大小约 %%~zA 字节)
  echo.
  echo 发送给别人后，对方解压步骤：
  echo   1. 解压到任意目录（路径不要含中文/空格最佳，但已做兼容）
  echo   2. 双击 创建桌面快捷方式.bat 生成桌面入口（可选）
  echo   3. 双击 start_all.bat 启动（首次会让你在各平台登录）
  echo   4. 双击 apply_*.bat 开始投递
) else (
  echo [失败] 压缩未生成文件，请检查磁盘空间或权限。
)
pause
