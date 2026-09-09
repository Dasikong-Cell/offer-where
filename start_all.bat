@echo off
chcp 65001 >nul
call "%~dp0setenv.bat"
if errorlevel 1 exit /b 1

echo ============================================
echo   One-click launch: per-platform CDP Chrome + backend
echo   Each platform opens its OWN Chrome window (Zhideya-style)
echo   Backend: http://127.0.0.1:4400  (must be 4400)
echo ============================================
echo.

REM Reuse CHROME path detected by setenv.bat. If it is still blank, show a clear error.
if not defined CHROME (
  echo [error] CHROME not detected. Please install Google Chrome and try again.
  pause & exit /b 1
)
if not exist "%CHROME%" (
  echo [error] Chrome not found: %CHROME%
  pause & exit /b 1
)

set "BOSS_PORT=9223"
set "LIE_PIN_PORT=9224"
set "JOB51_PORT=9225"
set "ZHILIAN_PORT=9226"
set "OFFICIAL_PORT=9227"

set "BOSS_PROFILE=%PROFILE%"
set "LIE_PIN_PROFILE=%PROFILE%-liepin"
set "JOB51_PROFILE=%PROFILE%-job51"
set "ZHILIAN_PROFILE=%PROFILE%-zhilian"
set "OFFICIAL_PROFILE=%PROFILE%-official"

REM 1) Start one isolated Chrome window per platform
start "" "%CHROME%" --remote-debugging-port=%BOSS_PORT% --user-data-dir="%BOSS_PROFILE%" --window-position=0,0 --window-size=760,900 --no-first-run --no-default-browser-check --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding
start "" "%CHROME%" --remote-debugging-port=%LIE_PIN_PORT% --user-data-dir="%LIE_PIN_PROFILE%" --window-position=780,0 --window-size=760,900 --no-first-run --no-default-browser-check --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding
start "" "%CHROME%" --remote-debugging-port=%JOB51_PORT% --user-data-dir="%JOB51_PROFILE%" --window-position=1560,0 --window-size=760,900 --no-first-run --no-default-browser-check --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding
start "" "%CHROME%" --remote-debugging-port=%ZHILIAN_PORT% --user-data-dir="%ZHILIAN_PROFILE%" --window-position=2340,0 --window-size=760,900 --no-first-run --no-default-browser-check --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding
start "" "%CHROME%" --remote-debugging-port=%OFFICIAL_PORT% --user-data-dir="%OFFICIAL_PROFILE%" --window-position=3120,0 --window-size=760,900 --no-first-run --no-default-browser-check --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding
timeout /t 4 >nul

REM 2) Start backend (skip if already running to avoid port conflict)
curl -s -m 3 http://127.0.0.1:4400/api/health >nul 2>nul
if errorlevel 1 (
  start "JobApply-Server" cmd /k call "%~dp0start_server.bat"
) else (
  echo 后端服务已在运行，跳过启动。
)

echo 打开投递控制台...
timeout /t 2 >nul
start "" http://127.0.0.1:4400/
echo.
echo 已为每个平台打开独立 Chrome 窗口（并排排列）。
echo 在控制台选择平台与数量后点「开始投递」即可，各平台互不干扰。
echo 关闭时关掉标题为「JobApply-Server」的窗口即可停服。
pause
