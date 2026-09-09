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

REM 2) 启动后端服务（独立窗口，关闭该窗口即可停服）
start "JobApply-Server" cmd /k call "%~dp0start_server.bat"

echo 后端启动中，约 5 秒后可访问 http://127.0.0.1:4400
timeout /t 5 >nul
start "" http://127.0.0.1:4400
echo.
echo 启动完成。投递请双击 apply_*.bat；关闭时关掉「后端服务」窗口即可。
pause
