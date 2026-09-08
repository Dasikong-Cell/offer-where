@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo   一键启动：CDP Chrome + 后端服务
echo   CDP  : http://127.0.0.1:9222
echo   后端 : http://127.0.0.1:4400  (必须 4400)
echo ============================================
echo.

REM 1) 启动 CDP Chrome（独立调试实例，Cookie 与日常 Chrome 隔离）
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 ^
  --user-data-dir=C:/chrome-cdp-profile ^
  --no-first-run ^
  --no-default-browser-check ^
  --disable-background-timer-throttling ^
  --disable-backgrounding-occluded-windows ^
  --disable-renderer-backgrounding
timeout /t 3 >nul

REM 2) 启动后端服务（显式 PORT=4400，否则脚本连不上）
start "JobApply-Server" cmd /k "title 后端服务 && cd /d %~dp0 && set PORT=4400 && npm run server"

echo 后端启动中，约 5 秒后可访问 http://127.0.0.1:4400
timeout /t 5 >nul
start "" http://127.0.0.1:4400
echo.
echo 启动完成。投递请双击 apply_*.bat；关闭时关掉「后端服务」窗口即可。
pause
