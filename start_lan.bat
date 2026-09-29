@echo off
chcp 65001 >nul
setlocal
call "%~dp0setenv.bat"
if errorlevel 1 exit /b 1

REM !! KEEP THIS FILE PURE ASCII (no BOM, no non-ASCII bytes) !!
REM cmd.exe re-reads a .bat by byte offset; with chcp 65001 active, multi-byte
REM characters desynchronise that offset and cmd starts skipping real command
REM lines. See the header comment in start_cdp.bat for the 2026-09-29 incident.

REM ============================================================
REM  LAN / mobile mode.
REM  The backend ALSO listens on your LAN so a phone or tablet on
REM  the SAME Wi-Fi can open the console. Desktop and phone share
REM  ONE backend and ONE SQLite (data/chat.db): anything changed on
REM  either side shows up on the other after a refresh.
REM  Use this only on a trusted network (home Wi-Fi) -- everyone on
REM  the same network can open the console and trigger real actions.
REM  Never port-forward it; public exposure is not supported.
REM ============================================================

set "HOST=0.0.0.0"

REM Detect this machine's LAN IPv4 addresses as a plain string.
REM Written to a temp file on purpose: putting this one-liner inside a
REM for /f command would nest quotes and parentheses into the for parser.
set "LAN_IPS_FILE=%TEMP%\offerwhere_lan_ips.txt"
"%NODE%" -e "const os=require('os'),fs=require('fs');const a=os.networkInterfaces(),o=[];for(const k of Object.keys(a)){for(const n of a[k]){if(String(n.family)==='IPv4'){if(!n.internal)o.push(n.address);}}}fs.writeFileSync(process.argv[1],o.join(' '));" "%LAN_IPS_FILE%" 2>nul
set "IPS="
if exist "%LAN_IPS_FILE%" set /p IPS=<"%LAN_IPS_FILE%"
if exist "%LAN_IPS_FILE%" del "%LAN_IPS_FILE%" >nul 2>nul

echo ============================================
echo   LAN mode: backend listens on 0.0.0.0:4400
echo   This PC : http://127.0.0.1:4400
if defined IPS (
  for %%p in (%IPS%) do echo   Phone   : http://%%p:4400
) else (
  echo   [warn] No LAN IPv4 address found. Check Wi-Fi / Ethernet.
)
echo ============================================
echo.

curl -s -m 3 http://127.0.0.1:4400/api/ping >nul 2>nul
if not errorlevel 1 (
  echo [note] A backend is ALREADY running on port 4400.
  echo        If it was started without HOST=0.0.0.0, it serves only this PC.
  echo        Close the "JobApply-Server" window first, then re-run this script.
) else (
  start "JobApply-Server" cmd /k call "%~dp0start_server.bat"
)

echo Waiting for the backend to become ready...
set /a _try=0
:wait_ready
curl -s -m 2 http://127.0.0.1:4400/api/ping >nul 2>nul
if not errorlevel 1 goto :ready
set /a _try+=1
if %_try% GEQ 40 goto :ready
timeout /t 1 >nul
goto :wait_ready
:ready
echo Backend is up.
echo.
echo On the phone: connect to the SAME Wi-Fi and open the "Phone" URL above.
echo The console also shows this address at the bottom of its sidebar.
echo To stop the backend, close the window titled "JobApply-Server".
echo.

if defined CHROME (
  start "" "%CHROME%" --app=http://127.0.0.1:4400/ --no-first-run --no-default-browser-check
) else (
  start "" http://127.0.0.1:4400/
)
pause
