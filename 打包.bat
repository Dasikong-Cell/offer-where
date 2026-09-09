@echo off
chcp 65001 >nul
REM ============================================================
REM  打包成可分发压缩包（输出到桌面）
REM  排除：.git（版本库，不需要）、chrome-cdp-profile（你的个人登录态，隐私！）
REM         *.log（运行日志）
REM  包含：源码、node_modules（运行依赖）、node\（自带 Node 运行时）
REM  => 接收者解压后直接双击 start_all.bat 即可，无需安装 Node / 任何环境。
REM ============================================================
set "ROOT=%~dp0"
set "STAGE=%TEMP%\job-apply-agent-portable"
REM 解析真实桌面路径（部分机器桌面被重定向）
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
