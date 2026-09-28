@echo off
REM !! KEEP THIS FILE PURE ASCII (no BOM, no non-ASCII bytes) !!
REM cmd.exe re-reads a .bat by byte offset; with chcp 65001 active, multi-byte
REM characters desynchronise that offset and cmd starts skipping real command
REM lines. See the header comment in start_cdp.bat for the full incident.
REM ============================================================
REM Common environment init (called by all launchers)
REM Uses paths relative to this file so the folder can be moved.
REM ============================================================
set "ROOT=%~dp0"

REM 1) Node runtime: prefer bundled node/ so recipients do not need Node installed
if exist "%ROOT%node\node.exe" ( set "NODE=%ROOT%node\node.exe" ) else ( set "NODE=node" )

REM 2) Auto-detect Chrome (required by the CDP debug instance)
set "CHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not defined CHROME (
  echo [ERROR] Google Chrome was not detected. Please install it first:
  echo         https://www.google.com/chrome/
  echo         Then double-click this launcher again.
  pause & exit 1
)

REM 3) CDP debug profile: prefer local C:\chrome-cdp-profile to keep login state.
REM    Fallback to the bundled relative directory on other machines.
if exist "C:\chrome-cdp-profile" ( set "PROFILE=C:\chrome-cdp-profile" ) else ( set "PROFILE=%ROOT%chrome-cdp-profile" )
