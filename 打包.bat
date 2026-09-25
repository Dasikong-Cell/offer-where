@echo off
chcp 65001 >nul
REM ============================================================
REM 分发打包入口 —— 委托给 pack.ps1
REM
REM ⚠️ 2026-09-25 变更原因（安全）：
REM   本脚本原先用 robocopy + Compress-Archive 打包，排除项只有
REM     /XD .git chrome-cdp-profile data  /XF *.log
REM   —— **不排除 `.env`**。也就是说跑它打出来的包会带上你的
REM   API Key / 邮箱授权码等凭据，分发给别人即等于泄露。
REM   而 pack.ps1 是白名单式打包（未列出的文件一律不进包）+ fail-closed 断言
REM   （显式校验不存在 .env / data / src / .git 与 server 编译产物），
REM   所以这里改为直接委托给它，只保留一个入口。
REM
REM 新包会额外带 version.json（提交号 + 构建时间），便于追溯是哪个版本。
REM ============================================================
set "ROOT=%~dp0"
if not exist "%ROOT%pack.ps1" (
  echo [错误] 未找到 pack.ps1，无法打包。
  pause & exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%pack.ps1"
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo 打包完成。发送给别人后，对方解压步骤：
  echo   1. 解压到任意目录（路径不含中文/空格最佳）
  echo   2. 双击 start_all.bat 启动（首次让你在各平台登录）
  echo   3. 看控制台首页「开箱自检」面板确认还差什么
  echo   4. 先「仅预览」再真实投递
  echo   （可选）双击 创建桌面快捷方式.bat 生成桌面入口
) else (
  echo [失败] 打包未通过校验（退出码 %RC%），请查看上方 pack.ps1 的报错。
)
pause
