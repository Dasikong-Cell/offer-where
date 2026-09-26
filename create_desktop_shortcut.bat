@echo off
chcp 65001 >nul
REM ============================================================
REM Create a single desktop entry - OfferWhere
REM Double-click to start services and open the console page.
REM No per-platform icons, keeping the desktop clean.
REM
REM  - Prefer a real .lnk (requires WScript.Shell COM)
REM  - Fall back to a .bat if COM is disabled (same effect)
REM
REM 2026-09-26 rename: this file used to be "创建桌面快捷方式.bat" and produced a
REM desktop entry named "投递Agent". Both are ASCII now, deliberately: a CJK-named
REM entry inside the zip is stored as GBK bytes WITHOUT the UTF-8 flag
REM (see docs/out-of-box-test-2026-09-25.md), so on an English Windows the extracted
REM name is mojibake and the recipient cannot tell which file to double-click.
REM Side benefit: the CJK entry name was also interpolated into the PowerShell
REM CreateShortcut command line, which is codepage-sensitive.
REM ============================================================
set "PKG=%~dp0"
REM Resolve the real desktop path (some systems redirect it away from %USERPROFILE%\Desktop)
for /f "usebackq delims=" %%D in (`powershell -NoProfile -Command "[Environment]::GetFolderPath('Desktop')"`) do set "DESKTOP=%%D"
if not defined DESKTOP set "DESKTOP=%USERPROFILE%\Desktop"

REM Single source of truth for the entry name: used by the .lnk, by the .bat fallback
REM and by every message below, so the three can never drift apart.
set "ENTRY=OfferWhere"

echo 正在桌面创建唯一入口 "%ENTRY%" ...
echo 指向：%PKG%start_all.bat

REM 图标：包内自带 public\app.ico（靛蓝渐变底 + 白对话气泡；
REM   同一份文件还用作控制台 favicon 与控制台侧边栏品牌标记，改图标只需改这一处）。
REM 不存在时留空 —— 没有图标顶多难看，不该因此建不出快捷方式。
set "ICON=%PKG%public\app.ico"
if not exist "%ICON%" set "ICON="

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws=New-Object -ComObject WScript.Shell; $lnk=$ws.CreateShortcut('%DESKTOP%\%ENTRY%.lnk'); $lnk.TargetPath='%PKG%start_all.bat'; $lnk.WorkingDirectory='%PKG%'; $lnk.Description='offer-where console'; if('%ICON%' -ne ''){ $lnk.IconLocation='%ICON%,0' }; $lnk.Save()" 2>nul

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
  ) > "%DESKTOP%\%ENTRY%.bat"
  echo 已创建：%DESKTOP%\%ENTRY%.bat（本机禁用了 .lnk COM，故用 .bat，双击效果相同）
) else (
  echo 已创建：%DESKTOP%\%ENTRY%.lnk
)

echo.
echo 双击桌面「%ENTRY%」即可打开控制台：选择平台 → 设置数量 → 开始投递。
REM 旧的中文名入口不自动删除 —— 删桌面文件属于用户自己的决定，脚本不越权代劳。
if exist "%DESKTOP%\投递Agent.lnk" echo 提示：桌面旧入口「投递Agent.lnk」已停止更新，可自行删除。
if exist "%DESKTOP%\投递Agent.bat" echo 提示：桌面旧入口「投递Agent.bat」已停止更新，可自行删除。
pause
