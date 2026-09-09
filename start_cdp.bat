@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"
call "%~dp0setenv.bat"
if errorlevel 1 exit /b 1

REM Reuse CHROME path detected by setenv.bat. If it is still blank, show a clear error.
if not defined CHROME (
  echo [error] CHROME not detected. Please install Google Chrome and try again.
  pause & exit /b 1
)
if not exist "%CHROME%" (
  echo [error] Chrome not found: %CHROME%
  pause & exit /b 1
)

REM ============================================================
REM Per-platform isolated Chrome windows (Zhideya-style):
REM each platform runs its OWN Chrome process, debug port and
REM user-data-dir, so platforms never crowd into one window.
REM BOSS reuses the existing profile (C:\chrome-cdp-profile) to
REM keep your login state. Every other platform gets a dedicated
REM profile so their logins stay separate and persist per machine.
REM ============================================================

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

echo ============================================
echo   Starting per-platform CDP Chrome windows
echo   BOSS    : %BOSS_PORT%  (%BOSS_PROFILE%)
echo   Liepin  : %LIE_PIN_PORT%  (%LIE_PIN_PROFILE%)
echo   51job   : %JOB51_PORT%  (%JOB51_PROFILE%)
echo   Zhilian : %ZHILIAN_PORT%  (%ZHILIAN_PROFILE%)
echo   Official: %OFFICIAL_PORT%  (%OFFICIAL_PROFILE%)
echo ============================================
echo.

set "ARGS=--no-first-run --no-default-browser-check --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding"

REM BOSS: prefer the shared profile (keeps login state); fall back to isolated
REM profile if it fails to start (e.g. profile locked by a leftover Chrome).
curl -s -m 2 http://127.0.0.1:%BOSS_PORT%/json/version >nul 2>nul
if not errorlevel 1 (
  echo [OK] BOSS already running on %BOSS_PORT% (reuse)
) else (
  start "" "%CHROME%" --remote-debugging-port=%BOSS_PORT% --user-data-dir="%BOSS_PROFILE%" --window-position=0,0 --window-size=760,900 %ARGS%
  timeout /t 3 >nul
  curl -s -m 2 http://127.0.0.1:%BOSS_PORT%/json/version >nul 2>nul
  if errorlevel 1 (
    echo [WARN] BOSS failed with shared profile; retry with isolated profile
    start "" "%CHROME%" --remote-debugging-port=%BOSS_PORT% --user-data-dir="%PROFILE%-boss" --window-position=0,0 --window-size=760,900 %ARGS%
  ) else (
    echo [OK] BOSS window ready on %BOSS_PORT%
  )
)

call :launch_platform liepin %LIE_PIN_PORT% "%LIE_PIN_PROFILE%" 780,0
call :launch_platform job51 %JOB51_PORT% "%JOB51_PROFILE%" 1560,0
call :launch_platform zhilian %ZHILIAN_PORT% "%ZHILIAN_PROFILE%" 2340,0
call :launch_platform official %OFFICIAL_PORT% "%OFFICIAL_PROFILE%" 3120,0
timeout /t 3 >nul
goto :after_launch_cdp

:launch_platform
curl -s -m 2 http://127.0.0.1:%~2/json/version >nul 2>nul
if not errorlevel 1 (
  echo [OK] %~1 already running on %~2 (reuse)
  goto :eof
)
start "" "%CHROME%" --remote-debugging-port=%~2 --user-data-dir="%~3" --window-position=%~4 --window-size=760,900 %ARGS%
timeout /t 3 >nul
curl -s -m 2 http://127.0.0.1:%~2/json/version >nul 2>nul
if errorlevel 1 ( echo [WARN] %~1 window did not start on %~2 ) else ( echo [OK] %~1 window ready on %~2 )
goto :eof

:after_launch_cdp

echo Waiting for debug ports...
timeout /t 4 >nul

for %%P in (9223 9224 9225 9226 9227) do (
  curl -s -m 3 http://127.0.0.1:%%P/json/version >nul 2>nul
  if !errorlevel!==0 ( echo [OK] port %%P ready ) else ( echo [WARN] port %%P not ready )
)

echo.
echo Done. Each platform is now in its own Chrome window.
echo Open console: http://127.0.0.1:4400/
pause
