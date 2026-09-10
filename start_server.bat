@echo off
chcp 65001 >nul
call "%~dp0setenv.bat"
if errorlevel 1 exit /b 1
cd /d "%ROOT%"
set PORT=4400
echo 后端服务启动中 (PORT=4400)，日志写入 server.log ...
"%NODE%" "%ROOT%node_modules\tsx\dist\cli.mjs" server/index.ts >> server.log 2>&1
