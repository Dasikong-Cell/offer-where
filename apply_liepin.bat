@echo off
chcp 65001 >nul
call "%~dp0setenv.bat"
if errorlevel 1 exit /b 1

REM Check whether the backend is running (port connectivity)
curl -s -m 3 http://127.0.0.1:4400/ >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Backend is not running. Double-click start_all.bat first.
  pause & exit /b 1
)

echo Starting Liepin batch delivery ^(limit 50, interval 20s^)...
echo NOTE: if Liepin asks for SMS verification, finish it inside the debug
echo       Chrome window first, then run this launcher again.
echo Press Ctrl+C to abort at any time.
echo.
"%NODE%" "%ROOT%node_modules\tsx\dist\cli.mjs" scripts/batch_multi.ts liepin 50 20000
echo.
echo Liepin delivery finished.
pause
