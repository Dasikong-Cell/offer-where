@echo off
chcp 65001 >nul
cd /d "%~dp0"

REM ===== 配置（变量均已赋值，避免「找不到 '.bat'」类空变量错误）=====
set "CDP_PORT=9222"
set "CDP_PROFILE=C:/chrome-cdp-profile"
set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"

if not exist "%CHROME%" (
  echo [错误] 未找到 Chrome：%CHROME%
  echo 请确认 Chrome 安装路径，或修改本文件中的 CHROME 变量。
  pause
  exit /b 1
)

echo ============================================
echo   启动 CDP Chrome（调试专用独立实例）
echo   端口 : %CDP_PORT%
echo   目录 : %CDP_PROFILE%
echo   注意 : 此实例 Cookie 与日常 Chrome 隔离，
echo          BOSS/51job 登录请在此窗口内操作。
echo ============================================
echo.

start "" "%CHROME%" ^
  --remote-debugging-port=%CDP_PORT% ^
  --user-data-dir=%CDP_PROFILE% ^
  --no-first-run ^
  --no-default-browser-check ^
  --disable-background-timer-throttling ^
  --disable-backgrounding-occluded-windows ^
  --disable-renderer-backgrounding

echo 已发起启动，等待端口就绪...
timeout /t 3 >nul
curl -s -m 3 http://127.0.0.1:%CDP_PORT%/json/version >nul 2>nul
if %errorlevel%==0 (
  echo [OK] CDP 已就绪: http://127.0.0.1:%CDP_PORT%
) else (
  echo [提示] 端口尚未就绪，请手动打开 http://127.0.0.1:%CDP_PORT%/json/version 确认。
)
echo.
pause
