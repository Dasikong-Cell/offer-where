@echo off
chcp 65001 >nul
REM !! KEEP THIS FILE PURE ASCII (no BOM, no non-ASCII bytes) !!
REM cmd.exe re-reads a .bat by byte offset; with chcp 65001 active, multi-byte
REM characters desynchronise that offset and cmd starts skipping real command
REM lines. See the header comment in start_cdp.bat for the 2026-09-29 incident.
REM ============================================================
REM Create a single desktop entry - OfferWhere
REM Double-click to start services and open the console page.
REM No per-platform icons, keeping the desktop clean.
REM
REM  - Prefer a real .lnk (requires WScript.Shell COM)
REM  - Fall back to a .bat if COM is disabled (same effect)
REM
REM 2026-09-27: the entry now prefers the native shell (offer-where.exe) when it is
REM present next to this script, and only falls back to start_all.bat otherwise.
REM Both branches (.lnk and .bat) bake the SAME resolved target, so they cannot
REM disagree about what the entry launches.
REM
REM 2026-09-26 rename: this file used to carry a CJK name and produced a CJK-named
REM desktop entry. Both are ASCII now, deliberately: a CJK-named
REM entry inside the zip is stored as GBK bytes WITHOUT the UTF-8 flag
REM (see docs/out-of-box-test-2026-09-25.md), so on an English Windows the extracted
REM name is mojibake and the recipient cannot tell which file to double-click.
REM Side benefit: the CJK entry name was also interpolated into the PowerShell
REM CreateShortcut command line, which is codepage-sensitive.
REM
REM 2026-09-27: added a /silent switch. install_first_run.bat (the first-run
REM install dialog) calls this with /silent so the desktop entry is created without
REM any console output or pause -- the dialog already owns the user interaction.
REM ============================================================
set "PKG=%~dp0"
REM /silent: invoked by the first-run install dialog. Create the entry quietly,
REM with no echoes and no pause.
set "SILENT="
if /i "%~1"=="/silent" set "SILENT=1"

REM Resolve the real desktop path (some systems redirect it away from %USERPROFILE%\Desktop)
for /f "usebackq delims=" %%D in (`powershell -NoProfile -Command "[Environment]::GetFolderPath('Desktop')"`) do set "DESKTOP=%%D"
if not defined DESKTOP set "DESKTOP=%USERPROFILE%\Desktop"

REM Single source of truth for the entry name: used by the .lnk, by the .bat fallback
REM and by every message below, so the three can never drift apart.
set "ENTRY=OfferWhere"

REM Entry target: prefer the native shell (no console window, tray icon, owns the
REM backend and the 5 Chrome windows). Fall back to start_all.bat when absent
REM (development tree / packages shipped without the shell).
REM Decide by EXISTENCE, not by "was it packaged", so one script is correct both
REM on the dev machine and on a recipient machine.
REM
REM !! 2026-09-28 fix (real defect): the shell lives at **dist-app\offer-where.exe**
REM   inside the package (pack.ps1 ships only the three files under dist-app;
REM   DEVELOPMENT.md:70 also states dist-app/ is the preferred entry for both the
REM   portable package and the desktop entry). The check here used to look at
REM   `%PKG%offer-where.exe` in the ROOT -- a path that exists NEITHER in the dev
REM   tree NOR in the distributed package -- so the condition was always false and
REM   the desktop entry always fell back to start_all.bat: after clicking
REM   "Install" the user still got a console window plus a Chrome --app tab, and
REM   the native shell was never used once, while all four gates stayed green
REM   ($must pinned the exe under dist-app, and the reference check did not cover
REM   paths between root launchers). Now there is exactly one location (dist-app\);
REM   if it moves again, pack.ps1's launcher cross-reference guard and the contract
REM   tests fail together, so it can no longer degrade to .bat silently.
set "TARGET=%PKG%start_all.bat"
if exist "%PKG%dist-app\offer-where.exe" set "TARGET=%PKG%dist-app\offer-where.exe"

if not defined SILENT (
  echo Creating the single desktop entry "%ENTRY%" ...
  echo Target: %TARGET%
)

REM Icon: public\app.ico ships in the package (indigo gradient + white chat bubble;
REM   the same file is also the console favicon and the sidebar brand mark, so
REM   changing the icon means changing this one file only).
REM Leave it blank if missing -- a missing icon is cosmetic, it must not block
REM creating the shortcut.
set "ICON=%PKG%public\app.ico"
if not exist "%ICON%" set "ICON="

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws=New-Object -ComObject WScript.Shell; $lnk=$ws.CreateShortcut('%DESKTOP%\%ENTRY%.lnk'); $lnk.TargetPath='%TARGET%'; $lnk.WorkingDirectory='%PKG%'; $lnk.Description='offer-where console'; if('%ICON%' -ne ''){ $lnk.IconLocation='%ICON%,0' }; $lnk.Save()" 2>nul

if errorlevel 1 (
  REM Fallback: .lnk COM disabled. Write a desktop .bat that points at THIS package.
  REM !! 2026-09-25 fix: this used to hard-code the dev machine's absolute path
  REM   (%USERPROFILE%\WorkBuddy\2026-09-02-09-33-33\job-apply-agent\), which
  REM   created a shortcut pointing at a non-existent directory on other machines.
  REM   Now it bakes the actual current path (%PKG%).
  REM 2026-09-27: the entry now bakes the resolved %TARGET% (exe first), matching
  REM   the .lnk branch.
  REM   Use `start ""` instead of `call`: the target may be an .exe (a GUI program,
  REM   and `call` would block until it exits).
  ( echo @echo off
    echo chcp 65001 ^>nul
    echo set "TARGET=%TARGET%"
    echo if not exist "%%TARGET%%" ^( echo [ERR] OfferWhere entry not found ^& pause ^& exit /b 1 ^)
    echo start "" "%%TARGET%%"
  ) > "%DESKTOP%\%ENTRY%.bat"
  if not defined SILENT echo Created: %DESKTOP%\%ENTRY%.bat (this machine has .lnk COM disabled, so a .bat is used; double-click works the same)
) else (
  if not defined SILENT echo Created: %DESKTOP%\%ENTRY%.lnk
)

if not defined SILENT (
  echo.
  echo Double-click "%ENTRY%" on the desktop to open the console: pick a platform, set the count, start delivery.
  REM Legacy CJK-named entries are NOT deleted automatically -- removing files from
  REM the user's desktop is the user's call, the script does not overstep.
  REM The legacy names are built from code points inside PowerShell so this file
  REM can stay pure ASCII (see the header rule).
  powershell -NoProfile -Command "$d=[Environment]::GetFolderPath('Desktop'); $n=[string]::Concat([char]0x6295,[char]0x9012,'Agent'); foreach($e in @($n+'.lnk',$n+'.bat')){ if(Test-Path (Join-Path $d $e)){ Write-Host ('Note: legacy desktop entry '+$e+' is no longer updated; you may delete it yourself.') } }" 2>nul
  pause
)
