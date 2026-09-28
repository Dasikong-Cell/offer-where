@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"
call "%~dp0setenv.bat"
if errorlevel 1 exit /b 1

REM !! KEEP THIS FILE PURE ASCII (no BOM, no non-ASCII bytes) !!
REM Reason: cmd.exe re-reads a .bat by byte offset. With chcp 65001 active,
REM multi-byte characters desynchronise that offset, so cmd starts executing
REM fragments of comment lines AND SILENTLY SKIPS real command lines.
REM Observed 2026-09-29: the four "call :launch_platform ..." lines below were
REM skipped entirely (only BOSS came up), while Chinese REM text was executed
REM as bogus commands ("'ebdriver' is not recognized", "'EM' is not...").
REM Same class of bug as the "PS 5.1 reads .ps1 as ANSI" rule: keep launchers ASCII.

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

REM 2026-09-12 anti-detection hardening: --disable-blink-features=AutomationControlled
REM makes navigator.webdriver return false, wiping the CDP automation fingerprint,
REM so BOSS / Liepin / 51job do not force a re-login or raise a risk-control prompt
REM after detecting the debugger.  (--disable-infobars is a no-op on Chrome 151;
REM kept because it is harmless.)
REM ============================================================================
REM Chrome launch flags (re-verified 2026-09-19 against competitor findings)
REM
REM The one that matters: --disable-blink-features=AutomationControlled
REM   Equivalent to appending AutomationControlled to --disable-features, the way
REM   puppeteer-real-browser does it. Makes navigator.webdriver return false and
REM   wipes the CDP automation marker.
REM
REM Two things we deliberately do NOT do (they would widen the fingerprint gap):
REM   - Do not mass-disable built-in Chrome features (Translate / MediaRouter /
REM     BackForwardCache ...). chrome-launcher's default flags disable these, but
REM     a normal user's Chrome HAS them on, so disabling them makes the browser
REM     easier to fingerprint. Competitors copied those defaults; that is a debt.
REM   - Do not enable --disable-component-update: keep the component update
REM     channel normal, closer to a real install.
REM
REM Known gap vs competitors (recorded so we do not forget):
REM   Competitors use rebrowser-puppeteer-core, which removes the CDP
REM   Runtime.enable leak, so they can use the FULL puppeteer API. We can only
REM   avoid it by hand ("never call Runtime.enable"; see the comments in
REM   server/services/cdpDriver.ts), which self-limits our CDP capability.
REM   That is an architectural change needing its own PoC; out of scope here.
REM   Self-check: scripts/check_stealth.ts reports which fingerprints leak.
REM ============================================================================
set "ARGS=--no-first-run --no-default-browser-check --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-blink-features=AutomationControlled --disable-infobars"

REM Window layout: 640x700 grid so all 5 windows fit on a 1920x1080 screen
set "WIN_W=640"
set "WIN_H=700"
set "BOSS_POS=0,0"
set "LIE_PIN_POS=660,0"
set "JOB51_POS=1320,0"
set "ZHILIAN_POS=0,720"
set "OFFICIAL_POS=660,720"

REM BOSS: prefer the shared profile (keeps login state); fall back to isolated
REM profile if it fails to start (e.g. profile locked by a leftover Chrome).
curl -s -m 2 http://127.0.0.1:%BOSS_PORT%/json/version >nul 2>nul
if not errorlevel 1 (
  echo [OK] BOSS already running on %BOSS_PORT% (reuse)
) else (
  start "" "%CHROME%" --remote-debugging-port=%BOSS_PORT% --user-data-dir="%BOSS_PROFILE%" --window-position=%BOSS_POS% --window-size=%WIN_W%,%WIN_H% %ARGS%
  timeout /t 3 >nul
  curl -s -m 2 http://127.0.0.1:%BOSS_PORT%/json/version >nul 2>nul
  if errorlevel 1 (
    echo [WARN] BOSS failed with shared profile; retry with isolated profile
    start "" "%CHROME%" --remote-debugging-port=%BOSS_PORT% --user-data-dir="%PROFILE%-boss" --window-position=%BOSS_POS% --window-size=%WIN_W%,%WIN_H% %ARGS%
  ) else (
    echo [OK] BOSS window ready on %BOSS_PORT%
  )
)

call :launch_platform liepin %LIE_PIN_PORT% "%LIE_PIN_PROFILE%" %LIE_PIN_POS%
call :launch_platform job51 %JOB51_PORT% "%JOB51_PROFILE%" %JOB51_POS%
call :launch_platform zhilian %ZHILIAN_PORT% "%ZHILIAN_PROFILE%" %ZHILIAN_POS%
call :launch_platform official %OFFICIAL_PORT% "%OFFICIAL_PROFILE%" %OFFICIAL_POS%
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

REM Tally the ports instead of just listing them. On 2026-09-29 this script printed
REM "Done. Each platform is now in its own Chrome window." while only 1 of 5 ports
REM was actually up -- a confident closing line that was simply false, because the
REM parser had eaten the launch calls. Never assert success that was not measured.
set /a READY=0
for %%P in (9223 9224 9225 9226 9227) do (
  curl -s -m 3 http://127.0.0.1:%%P/json/version >nul 2>nul
  if !errorlevel!==0 (
    set /a READY+=1
    echo [OK] port %%P ready
  ) else (
    echo [WARN] port %%P NOT ready
  )
)

echo.
if not !READY!==5 (
  echo [WARN] Only !READY! of 5 debug ports are up.
  echo        Re-run this file. If the SAME port keeps failing, that platform's
  echo        Chrome profile is probably locked by a leftover chrome.exe using it.
  echo        Do not trust a "Done" line -- the port tally above is the measurement.
) else (
  echo Done. All 5 platforms are up, each in its own Chrome window.
)
echo Open console: http://127.0.0.1:4400/
echo.
echo Next: log in inside each window (BOSS is the one the real-delivery check uses).
pause
