@echo off
chcp 65001 >nul
REM ============================================================
REM Create a single desktop entry - DeliveryAgent
REM Double-click to start services and open the console page.
REM No per-platform icons, keeping the desktop clean.
REM
REM  - Prefer a real .lnk (requires WScript.Shell COM)
REM  - Fall back to a .bat if COM is disabled (same effect)
REM ============================================================
set "PKG=%~dp0"
REM Resolve the real desktop path (some systems redirect it away from %USERPROFILE%\Desktop)
for /f "usebackq delims=" %%D in (`powershell -NoProfile -Command "[Environment]::GetFolderPath('Desktop')"`) do set "DESKTOP=%%D"
if not defined DESKTOP set "DESKTOP=%USERPROFILE%\Desktop"

echo 正在桌面创建唯一入口「投递Agent」...
echo 指向：%PKG%start_all.bat

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws=New-Object -ComObject WScript.Shell; $lnk=$ws.CreateShortcut('%DESKTOP%\投递Agent.lnk'); $lnk.TargetPath='%PKG%start_all.bat'; $lnk.WorkingDirectory='%PKG%'; $lnk.Description='简历投递 Agent 控制台'; $lnk.Save()" 2>nul

if errorlevel 1 (
  REM Fallback: .lnk COM disabled. Write a desktop .bat that points at THIS package.
  REM ⚠️ 2026-09-25 修：此前这里硬编码了开发机的绝对路径
  REM   （%USERPROFILE%\WorkBuddy\2026-09-02-09-33-33\job-apply-agent\），
  REM   在别人的机器上会生成一个指向不存在目录的快捷方式。改为烘焙当前实际路径（%PKG%）。
  ( echo @echo off
    echo chcp 65001 ^>nul
    echo set "PKG=%PKG%"
    echo if not exist "%%PKG%%start_all.bat" ^( echo [ERR] start_all.bat not found in %%PKG%% ^& pause ^& exit /b 1 ^)
    echo call "%%PKG%%start_all.bat"
    echo pause
  ) > "%DESKTOP%\投递Agent.bat"
  echo 已创建：%DESKTOP%\投递Agent.bat（本机禁用了 .lnk COM，故用 .bat，双击效果相同）
) else (
  echo 已创建：%DESKTOP%\投递Agent.lnk
)

echo.
echo 双击桌面「投递Agent」即可打开控制台：选择平台 → 设置数量 → 开始投递。
pause
