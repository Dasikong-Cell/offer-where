@echo off
REM ============================================================
REM  公共环境初始化（所有启动器都先 call 它）
REM  作用：把路径全部改成「相对于本文件所在目录」，
REM        这样整个 job-apply-agent 文件夹移动到任何地方、
REM        拷给任何人都能用（不再依赖本机绝对路径）。
REM ============================================================
set "ROOT=%~dp0"

REM 1) Node 运行时：优先用自带的 node/（打包进项目，接收者无需安装 Node）
if exist "%ROOT%node\node.exe" ( set "NODE=%ROOT%node\node.exe" ) else ( set "NODE=node" )

REM 2) Chrome 自动探测（调试用 CDP 实例依赖它）
set "CHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not defined CHROME (
  echo [错误] 未检测到 Google Chrome。请先安装：https://www.google.com/chrome/
  echo         安装后重新双击本启动器即可。
  pause & exit 1
)

REM 3) CDP 调试 profile：本机优先复用 C:\chrome-cdp-profile（保留你的登录态），
REM    其它机器/别人电脑没有该目录时，自动用包内相对目录（首次运行需自己登录）。
if exist "C:\chrome-cdp-profile" ( set "PROFILE=C:\chrome-cdp-profile" ) else ( set "PROFILE=%ROOT%chrome-cdp-profile" )
