@echo off
chcp 65001 >nul
REM ============================================================
REM Release packaging entry point -- delegates to pack.ps1
REM
REM !! 2026-09-25 change (security):
REM   This script used to package with robocopy + Compress-Archive, with only
REM     /XD .git chrome-cdp-profile data  /XF *.log
REM   excluded -- it did NOT exclude `.env`. So running it produced a package
REM   carrying your API keys / mailbox auth codes; handing that to someone else
REM   is a credential leak.
REM   pack.ps1 is whitelist-based (anything unlisted never enters the package)
REM   plus fail-closed assertions (explicitly verifies .env / data / src / .git
REM   and server build output are absent), so this script now delegates to it and
REM   keeps a single entry point.
REM
REM The new package also carries version.json (commit + build time) for traceability.
REM
REM !! KEEP THIS FILE PURE ASCII (no BOM, no non-ASCII bytes) !!
REM cmd.exe re-reads a .bat by byte offset; with chcp 65001 active, multi-byte
REM characters desynchronise that offset and cmd starts skipping real command
REM lines. See the header comment in start_cdp.bat for the 2026-09-29 incident.
REM ============================================================
set "ROOT=%~dp0"
if not exist "%ROOT%pack.ps1" (
  echo [ERROR] pack.ps1 not found, cannot package.
  pause & exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%pack.ps1"
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo Packaging done. Steps for the recipient after downloading:
  echo   1. Extract to any directory ^(a path without non-ASCII chars or spaces is best^)
  echo   2. Double-click start_all.bat ^(first run asks you to log in on each platform^)
  echo   3. Check the "first-run self-check" panel on the console home page to see what is missing
  echo   4. Preview only first, then do a real delivery
  echo   ^(optional^) double-click create_desktop_shortcut.bat to create a desktop entry
) else (
  echo [FAILED] packaging did not pass validation ^(exit code %RC%^), see the pack.ps1 error above.
)
pause
