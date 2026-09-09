@echo off
chcp 65001 >nul
REM ============================================================
REM  为「当前这台电脑」在桌面生成快捷方式。
REM  - 优先生成真正的 .lnk 快捷方式（需系统允许 WScript.Shell COM）
REM  - 若被安全策略禁用，则退化为 .bat 桌面快捷方式（双击效果相同）
REM  生成的快捷方式指向「本包内」的 start_all.bat / apply_*.bat，
REM  所以你把整个 job-apply-agent 文件夹移动/发送给别人后，
REM  别人只需在自己的电脑上再双击一次本文件即可重建他们的桌面快捷方式。
REM ============================================================
set "PKG=%~dp0"
REM 解析真实桌面路径（部分机器桌面被重定向到非 %USERPROFILE%\Desktop）
for /f "usebackq delims=" %%D in (`powershell -NoProfile -Command "[Environment]::GetFolderPath('Desktop')"`) do set "DESKTOP=%%D"
if not defined DESKTOP set "DESKTOP=%USERPROFILE%\Desktop"

echo 正在为当前用户创建桌面快捷方式（指向 %PKG%）...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws=New-Object -ComObject WScript.Shell; $items=@(@{n='投递Agent-启动服务';t='start_all.bat'},@{n='投递Agent-BOSS投50';t='apply_boss.bat'},@{n='投递Agent-51job投50';t='apply_job51.bat'},@{n='投递Agent-猎聘投50';t='apply_liepin.bat'}); foreach($i in $items){ $lnk=$ws.CreateShortcut('%DESKTOP%\'+$i.n+'.lnk'); $lnk.TargetPath='%PKG%'+$i.t; $lnk.WorkingDirectory='%PKG%'; $lnk.Description='Job Apply Agent'; $lnk.Save(); Write-Host ('lnk: '+$i.n) }" 2>nul

if errorlevel 1 (
  REM ---- COM 被禁用，退化为 .bat 桌面快捷方式 ----
  echo @echo off > "%DESKTOP%\投递Agent-启动服务.bat"
  echo call "%PKG%start_all.bat" >> "%DESKTOP%\投递Agent-启动服务.bat"
  echo @echo off > "%DESKTOP%\投递Agent-BOSS投50.bat"
  echo call "%PKG%apply_boss.bat" >> "%DESKTOP%\投递Agent-BOSS投50.bat"
  echo @echo off > "%DESKTOP%\投递Agent-51job投50.bat"
  echo call "%PKG%apply_job51.bat" >> "%DESKTOP%\投递Agent-51job投50.bat"
  echo @echo off > "%DESKTOP%\投递Agent-猎聘投50.bat"
  echo call "%PKG%apply_liepin.bat" >> "%DESKTOP%\投递Agent-猎聘投50.bat"
  echo 已创建 4 个桌面 .bat 快捷方式（本机禁用了 .lnk COM，故用 .bat，效果相同）。
)

echo.
echo 完成。桌面现在应有「投递Agent-*.」快捷方式。
pause
