@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================
echo   简历自动投递 Agent 启动器
echo   后端: http://localhost:3000
echo   前端: http://localhost:5173
echo ============================================
echo.

REM 检查 Node 是否可用
where node >nul 2>nul
if %errorlevel% neq 0 (
  echo [错误] 未检测到 Node.js，请先安装 Node 18+ 并加入 PATH。
  pause
  exit /b 1
)

REM 启动后端服务（独立窗口）
start "JobApply-Server" cmd /k "title 后端服务 && npm run server"
timeout /t 4 >nul

REM 启动前端开发服务器（独立窗口）
start "JobApply-Client" cmd /k "title 前端服务 && npm run dev:client"
timeout /t 6 >nul

REM 打开浏览器
start "" http://localhost:5173

echo 服务已启动，前端窗口正在打开。
echo 关闭时请直接关闭两个命令行窗口即可。
echo.
pause
