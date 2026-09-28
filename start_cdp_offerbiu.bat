@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"
call "%~dp0setenv.bat"
if errorlevel 1 exit /b 1

if not exist "%CHROME%" (
  echo [error] Chrome not found: %CHROME%
  pause & exit /b 1
)

REM ============================================================
REM Start ONLY the Offerbiu / Official Chrome window (port 9227).
REM Same profile and flags as start_cdp.bat, so reuse is safe.
REM ============================================================
set "PORT=9227"
set "OFFICIAL_PROFILE=%PROFILE%-official"
set "ARGS=--no-first-run --no-default-browser-check --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-blink-features=AutomationControlled --disable-infobars"

echo ============================================
echo   Offerbiu / Official window only
echo   port: %PORT%
echo   profile: %OFFICIAL_PROFILE%
echo ============================================
echo.

curl -s -m 2 http://127.0.0.1:%PORT%/json/version >nul 2>nul
if not errorlevel 1 (
  echo [OK] 9227 already running - reuse existing window
) else (
  start "" "%CHROME%" --remote-debugging-port=%PORT% --user-data-dir="%OFFICIAL_PROFILE%" --window-position=660,720 --window-size=760,900 %ARGS%
  timeout /t 4 >nul
  curl -s -m 2 http://127.0.0.1:%PORT%/json/version >nul 2>nul
  if errorlevel 1 ( echo [WARN] 9227 did not start - check Chrome install ) else ( echo [OK] 9227 window ready )
)

echo.
echo In this new window open https://offerbiu.com/ and log in, then go back to the
echo console and click "refresh connection status".
echo Both job collection and delivery for the company-site platform (offerbiu) use this window.
pause
