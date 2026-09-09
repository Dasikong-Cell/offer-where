@echo off
call "%~dp0setenv.bat"
if errorlevel 1 exit /b 1
cd /d "%ROOT%"
set PORT=4400
echo 后端服务启动中 (PORT=4400) ...
"%NODE%" "%ROOT%node_modules\tsx\dist\cli.mjs" server/index.ts
