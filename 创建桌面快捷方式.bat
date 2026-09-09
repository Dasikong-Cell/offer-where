@echo off
chcp 65001 >nul
REM ============================================================
REM  在桌面创建「唯一入口」快捷方式 —— 投递Agent
REM  双击它 → 启动服务并打开控制台页面（在页面里选平台、填数量即可）。
REM  不再为每个平台单独建图标，保持桌面清爽。
REM
REM  - 优先生成真正的 .lnk（需系统允许 WScript.Shell COM）
REM  - 被安全策略禁用时退化为 .bat（双击效果相同）
REM ============================================================
set "PKG=%~dp0"
REM 解析真实桌面路径（部分机器桌面被重定向到非 %USERPROFILE%\Desktop）
for /f "usebackq delims=" %%D in (`powershell -NoProfile -Command "[Environment]::GetFolderPath('Desktop')"`) do set "DESKTOP=%%D"
if not defined DESKTOP set "DESKTOP=%USERPROFILE%\Desktop"

echo 正在桌面创建唯一入口「投递Agent」...
echo 指向：%PKG%start_all.bat

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws=New-Object -ComObject WScript.Shell; $lnk=$ws.CreateShortcut('%DESKTOP%\投递Agent.lnk'); $lnk.TargetPath='%PKG%start_all.bat'; $lnk.WorkingDirectory='%PKG%'; $lnk.Description='简历投递 Agent 控制台'; $lnk.Save()" 2>nul

if errorlevel 1 (
  REM 退化：系统禁用 .lnk COM。写纯 ASCII 桌面 .bat（用 %%USERPROFILE%% 规避中文路径），加 pause 兜底防闪退
  ( echo @echo off
    echo chcp 65001 ^>nul
    echo set "PKG=%%USERPROFILE%%\WorkBuddy\2026-09-02-09-33-33\job-apply-agent\"
    echo if not exist "%%PKG%%start_all.bat" ^( echo [ERR] start_all.bat not found ^& pause ^& exit /b 1 ^)
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
