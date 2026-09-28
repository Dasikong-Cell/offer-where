@echo off
chcp 65001 >nul
REM Needed for the !var! port tally at the end of this script.
setlocal enabledelayedexpansion
call "%~dp0setenv.bat"
if errorlevel 1 exit /b 1

REM !! KEEP THIS FILE PURE ASCII (no BOM, no non-ASCII bytes) !!
REM cmd.exe re-reads a .bat by byte offset; with chcp 65001 active, multi-byte
REM characters desynchronise that offset and cmd starts skipping real command
REM lines. See the header comment in start_cdp.bat for the 2026-09-29 incident.

REM First-run install guidance: when not installed yet (data/.installed missing),
REM show the "Install" dialog, create a desktop entry and write the marker; every
REM later run skips it and does not bother the user again.
REM data/ is not shipped, so the first double-click after extracting always shows
REM it once per recipient.
if not exist "%~dp0data\.installed" (
  call "%~dp0install_first_run.bat"
)

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

REM Window layout: 640x700 grid so all 5 windows fit on a 1920x1080 screen
set "WIN_W=640"
set "WIN_H=700"
set "BOSS_POS=0,0"
set "LIE_PIN_POS=660,0"
set "JOB51_POS=1320,0"
set "ZHILIAN_POS=0,720"
set "OFFICIAL_POS=660,720"

REM 1) Start one isolated Chrome window per platform (Zhideya-style)
REM    Pre-check each debug port: if already listening, reuse it instead of
REM    starting a second instance (which would silently fail on port conflict).
REM 2026-09-12 anti-detection hardening: --disable-blink-features=AutomationControlled
REM    wipes the navigator.webdriver automation fingerprint.
set "ARGS=--no-first-run --no-default-browser-check --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-blink-features=AutomationControlled --disable-infobars"

REM BOSS: prefer the shared profile (keeps login state); if it fails to start
REM (e.g. profile locked by a leftover Chrome), fall back to an isolated profile
REM so the window always appears.
curl -s -m 2 http://127.0.0.1:%BOSS_PORT%/json/version >nul 2>nul
if not errorlevel 1 (
  echo [OK] BOSS already running on port %BOSS_PORT% (reuse)
) else (
  start "" "%CHROME%" --remote-debugging-port=%BOSS_PORT% --user-data-dir="%BOSS_PROFILE%" --window-position=%BOSS_POS% --window-size=%WIN_W%,%WIN_H% %ARGS%
  timeout /t 3 >nul
  curl -s -m 2 http://127.0.0.1:%BOSS_PORT%/json/version >nul 2>nul
  if errorlevel 1 (
    echo [WARN] BOSS window failed with shared profile; retry with isolated profile
    start "" "%CHROME%" --remote-debugging-port=%BOSS_PORT% --user-data-dir="%PROFILE%-boss" --window-position=%BOSS_POS% --window-size=%WIN_W%,%WIN_H% %ARGS%
  ) else (
    echo [OK] BOSS window ready on port %BOSS_PORT%
  )
)

call :launch_platform liepin %LIE_PIN_PORT% "%LIE_PIN_PROFILE%" %LIE_PIN_POS%
call :launch_platform job51 %JOB51_PORT% "%JOB51_PROFILE%" %JOB51_POS%
call :launch_platform zhilian %ZHILIAN_PORT% "%ZHILIAN_PROFILE%" %ZHILIAN_POS%
call :launch_platform official %OFFICIAL_PORT% "%OFFICIAL_PROFILE%" %OFFICIAL_POS%
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
  echo Backend already running, skipping start.
)

echo Opening the delivery console...
REM Wait until backend is ready (cold start is ~6s). Poll /api/ping instead of a fixed sleep,
REM otherwise the console opens too early and shows a connection error.
set /a _try=0
:wait_ready
curl -s -m 2 http://127.0.0.1:4400/api/ping >nul 2>nul
if not errorlevel 1 goto :ready
set /a _try+=1
if %_try% GEQ 40 goto :ready
timeout /t 1 >nul
goto :wait_ready
:ready
REM 2026-09-26 change: the console is no longer stuffed into a tab of the user's
REM   everyday browser. Chrome's --app= opens a SEPARATE window (no address bar,
REM   no tab strip, the app icon shows in the taskbar, closer to a desktop app).
REM   To restore the old behaviour (a new tab in the default browser), delete the
REM   whole if block below and replace it with one line:
REM     start "" http://127.0.0.1:4400/
REM The else branch is effectively unreachable -- this script already hard-checks
REM CHROME at the top (undefined or missing both exit /b 1). It stays as
REM defence in depth: if that precondition is ever removed, this still degrades to
REM "at least it opens".
if defined CHROME (
  start "" "%CHROME%" --app=http://127.0.0.1:4400/ --no-first-run --no-default-browser-check
) else (
  echo [warn] CHROME undefined, falling back to the default browser for the console.
  start "" http://127.0.0.1:4400/
)
echo.
REM Tally the ports instead of asserting success. On 2026-09-29 the sibling script
REM (start_cdp.bat) printed "each platform is now in its own Chrome window" while
REM only 1 of 5 ports was up -- the parser had silently skipped the launch calls.
REM Never close with a claim that was not measured.
set /a _cdpReady=0
for %%P in (9223 9224 9225 9226 9227) do (
  curl -s -m 2 http://127.0.0.1:%%P/json/version >nul 2>nul
  if !errorlevel!==0 set /a _cdpReady+=1
)
if not !_cdpReady!==5 (
  echo [WARN] Only !_cdpReady! of 5 platform debug ports are up ^(9223-9227^).
  echo        Re-run start_cdp.bat; if the same port keeps failing, its Chrome
  echo        profile is probably locked by a leftover chrome.exe.
) else (
  echo Opened a separate Chrome window per platform ^(arranged side by side^).
)
echo In the console pick a platform and a count, then click "Start delivery".
echo To stop the backend, close the window titled "JobApply-Server".
echo.
REM 2026-09-25 first-run finding: this script only opens the 5 core platform
REM windows, while 15 platforms are registered. Previously there was no hint at
REM all, so a first-time user saw the remaining platform cards as "offline" with
REM no idea what to do.
echo Note: this run opened the 5 core platform windows (BOSS / Liepin / 51job / Zhilian / Official).
echo       For the other platforms (chinahr / yupao / maimai / iguopin / yingjiesheng / nowcoder ...), two options:
echo         - double-click start_platforms.bat (opens 9 more by default; add "all" for every platform)
echo         - or click "Open window" on the platform card in the console
pause
