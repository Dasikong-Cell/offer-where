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

REM 1) Start one isolated Chrome window per platform (Zhideya-style)
REM    Pre-check each debug port: if already listening, reuse it instead of
REM    starting a second instance (which would silently fail on port conflict).
set "ARGS=--no-first-run --no-default-browser-check --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding"

REM BOSS: prefer the shared profile (keeps login state); if it fails to start
REM (e.g. profile locked by a leftover Chrome), fall back to an isolated profile
REM so the window always appears.
curl -s -m 2 http://127.0.0.1:%BOSS_PORT%/json/version >nul 2>nul
if not errorlevel 1 (
  echo [OK] BOSS already running on port %BOSS_PORT% (reuse)
) else (
  start "" "%CHROME%" --remote-debugging-port=%BOSS_PORT% --user-data-dir="%BOSS_PROFILE%" --window-position=0,0 --window-size=760,900 %ARGS%
  timeout /t 3 >nul
  curl -s -m 2 http://127.0.0.1:%BOSS_PORT%/json/version >nul 2>nul
  if errorlevel 1 (
    echo [WARN] BOSS window failed with shared profile; retry with isolated profile
    start "" "%CHROME%" --remote-debugging-port=%BOSS_PORT% --user-data-dir="%PROFILE%-boss" --window-position=0,0 --window-size=760,900 %ARGS%
  ) else (
    echo [OK] BOSS window ready on port %BOSS_PORT%
  )
)

call :launch_platform liepin %LIE_PIN_PORT% "%LIE_PIN_PROFILE%" 780,0
call :launch_platform job51 %JOB51_PORT% "%JOB51_PROFILE%" 1560,0
call :launch_platform zhilian %ZHILIAN_PORT% "%ZHILIAN_PROFILE%" 2340,0
call :launch_platform official %OFFICIAL_PORT% "%OFFICIAL_PROFILE%" 3120,0
timeout /t 3 >nul
goto :after_launch

:launch_platform
curl -s -m 2 http://127.0.0.1:%~2/json/version >nul 2>nul
if not errorlevel 1 (
  echo [OK] %~1 already running on port %~2 (reuse)
  goto :eof
)
start "" "%CHROME%" --remote-debugging-port=%~2 --user-data-dir="%~3" --window-position=%~4 --window-size=760,900 %ARGS%
timeout /t 3 >nul
curl -s -m 2 http://127.0.0.1:%~2/json/version >nul 2>nul
if errorlevel 1 ( echo [WARN] %~1 window did not start on port %~2 ) else ( echo [OK] %~1 window ready on port %~2 )
goto :eof

:after_launch

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
