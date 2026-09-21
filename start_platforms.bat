@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title JobApply - Platform Launcher

REM ============================================================
REM  Extra platform launcher (per-platform CDP Chrome window)
REM  Usage:
REM     start_platforms.bat                 -> open the 9 new platforms
REM     start_platforms.bat job58 yupao     -> open only the listed ones
REM     start_platforms.bat all             -> open all 14 registered platforms
REM  Each platform gets its OWN Chrome profile + debug port.
REM  Log in inside each window; then use the console health check.
REM ============================================================

call "%~dp0setenv.bat"
if errorlevel 1 exit /b 1
if not defined CHROME (
  echo [error] Chrome not found. Please install Google Chrome first.
  pause & exit /b 1
)

set "SEL=%*"
if "%SEL%"=="" set "SEL=easyzhipin job58 chinahr dianzhang yupao maimai ganji iguopin yingjiesheng"

REM id:port:x:y  (3 columns x 3 rows, window 620x340 so a 1080p screen fits all)
set "NEWTBL=easyzhipin:9228:0:0 job58:9229:640:0 chinahr:9230:1280:0 dianzhang:9231:0:360 yupao:9232:640:360 maimai:9233:1280:360 ganji:9234:0:720 iguopin:9235:640:720 yingjiesheng:9236:1280:720"
set "ALLTBL=boss:9223:0:0 liepin:9224:640:0 job51:9225:1280:0 zhilian:9226:0:360 nowcoder:9237:0:720 official:9227:640:720 %NEWTBL%"

if /i "%SEL%"=="all" set "SEL=ALL"

if /i "%SEL%"=="ALL" (
  call :run_table "%ALLTBL%"
) else (
  for %%A in (%SEL%) do call :launch_one %%A
)

echo.
echo Done. Tips:
echo   - Log in inside each window (scan QR / password).
echo   - Then open http://127.0.0.1:4400/ and click the platform health check.
echo   - Windows already running on their port are reused, not duplicated.
echo.
pause
endlocal
exit /b 0

REM ------------------------------------------------------------
:run_table
for %%E in (%~1) do (
  for /f "tokens=1-4 delims=:" %%a in ("%%E") do call :launch %%a %%b %%c %%d
)
goto :eof

REM ------------------------------------------------------------
:launch_one
for %%E in (%ALLTBL%) do (
  for /f "tokens=1-4 delims=:" %%a in ("%%E") do (
    if /i "%%a"=="%~1" call :launch %%a %%b %%c %%d
  )
)
goto :eof

REM ------------------------------------------------------------
:launch
set "ID=%~1"
set "PORT=%~2"
set "WX=%~3"
set "WY=%~4"

curl -s -m 2 http://127.0.0.1:%PORT%/json/version >nul 2>nul
if not errorlevel 1 (
  echo [OK]   %ID% already running on port %PORT%  ^(reuse^)
  goto :eof
)

REM BOSS uses the shared profile so its login state is preserved; others get isolated profiles.
if /i "%ID%"=="boss" (
  set "UDD=%PROFILE%"
) else (
  set "UDD=%PROFILE%-%ID%"
)

start "" "%CHROME%" --remote-debugging-port=%PORT% --user-data-dir="%UDD%" --window-position=%WX%,%WY% --window-size=620,340 --no-first-run --no-default-browser-check --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-blink-features=AutomationControlled --disable-infobars
timeout /t 3 >nul

curl -s -m 2 http://127.0.0.1:%PORT%/json/version >nul 2>nul
if errorlevel 1 (
  echo [WARN] %ID% did not start on port %PORT%
) else (
  echo [OK]   %ID% ready on port %PORT%
)
goto :eof
