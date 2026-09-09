@echo off
chcp 65001 >nul
call "%~dp0setenv.bat"
if errorlevel 1 exit /b 1

echo ============================================
echo   一键启动：CDP Chrome + 后端服务
echo   CDP  : http://127.0.0.1:9222
echo   后端 : http://127.0.0.1:4400  (必须 4400)
echo ============================================
echo.

REM 1) 启动 CDP Chrome（独立调试实例，Cookie 与日常 Chrome 隔离）
start "" "%CHROME%" ^
  --remote-debugging-port=9222 ^
  --user-data-dir="%PROFILE%" ^
  --no-first-run ^
  --no-default-browser-check ^
  --disable-background-timer-throttling ^
  --disable-backgrounding-occluded-windows ^
  --disable-renderer-backgrounding
timeout /t 3 >nul

REM 2) 启动后端服务（已在运行则跳过，避免重复启动报端口占用）
curl -s -m 3 http://127.0.0.1:4400/api/health >nul 2>nul
if errorlevel 1 (
  start "JobApply-Server" cmd /k call "%~dp0start_server.bat"
) else (
  echo 后端服务已在运行，跳过启动。
)

echo 打开投递控制台...
timeout /t 5 >nul
start "" http://127.0.0.1:4400/
echo.
echo 已打开控制台 http://127.0.0.1:4400/
echo 在页面里选择平台与数量后点「开始投递」即可。
echo 关闭时关掉标题为「JobApply-Server」的窗口即可停服。
pause
