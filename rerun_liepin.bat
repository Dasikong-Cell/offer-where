@echo off
chcp 65001 >nul
call "%~dp0setenv.bat"
if errorlevel 1 exit /b 1

REM Post-verification rerun for liepin: assumes SMS verify done in 9224 window.
REM The delivery engine aborts immediately if the session is still blocked
REM (safe.liepin.com), so a forgotten verification fails fast with a clear hint.

REM Check backend connectivity (port 4400)
curl -s -m 3 http://127.0.0.1:4400/ >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Backend is not running. Double-click start_all.bat first.
  pause & exit /b 1
)

REM Args: count (default 5), interval ms (default 30000)
set "COUNT=%~1"
if "%COUNT%"=="" set "COUNT=5"
set "IVL=%~2"
if "%IVL%"=="" set "IVL=30000"

echo ============================================
echo Liepin "rerun after verification"
echo Make sure the SMS verification is already done in the debug Chrome window (9224).
echo If safe.liepin.com still blocks us, this batch aborts on the first job with a hint.
echo Args: count=%COUNT%  interval=%IVL%ms
echo Press Ctrl+C to abort at any time
echo ============================================
echo.
"%NODE%" "%ROOT%node_modules\tsx\dist\cli.mjs" scripts/batch_multi.ts liepin %COUNT% %IVL%
echo.
echo Liepin rerun finished. If still blocked, complete the SMS verification in the
echo 9224 window first, then double-click this file again.
pause
