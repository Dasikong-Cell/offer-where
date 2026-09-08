@echo off
chcp 65001 >nul
cd /d "%~dp0"

REM 检查后端是否启动（端口连通性即可，不支持 status 动作）
curl -s -m 3 http://127.0.0.1:4400/ >nul 2>nul
if errorlevel 1 (
  echo [错误] 后端服务未启动，请先双击 start_all.bat。
  pause & exit /b 1
)

echo 开始 猎聘 批量投递（上限 50，间隔 20s）...
echo 注意：猎聘若提示短信验证，请先在调试 Chrome 内完成验证再重跑。
echo 按 Ctrl+C 可随时中止。
echo.
node_modules\.bin\tsx scripts/batch_multi.ts liepin 50 20000
echo.
echo 猎聘投递结束。
pause
