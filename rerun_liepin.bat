@echo off
chcp 65001 >nul
call "%~dp0setenv.bat"
if errorlevel 1 exit /b 1

REM Post-verification rerun for liepin: assumes SMS verify done in 9224 window.
REM The delivery engine aborts immediately if the session is still blocked
REM (safe.liepin.com), so a forgotten verification fails fast with a clear hint.

REM Check backend connectivity (port 4400)
curl -s -m 3 http://127.0.0.1:4400/ >nul 2>nul
if errorlevel 1 (
  echo [错误] 后端服务未启动，请先双击 start_all.bat。
  pause & exit /b 1
)

REM Args: count (default 5), interval ms (default 30000)
set "COUNT=%~1"
if "%COUNT%"=="" set "COUNT=5"
set "IVL=%~2"
if "%IVL%"=="" set "IVL=30000"

echo ============================================
echo 猎聘「验证后重跑」：请先确认已在调试 Chrome（9224 窗口）完成短信验证
echo 若仍被 safe.liepin.com 拦截，本批次会在第一个岗位立即中止并提示
echo 参数：数量=%COUNT%  间隔=%IVL%ms
echo 按 Ctrl+C 可随时中止
echo ============================================
echo.
"%NODE%" "%ROOT%node_modules\tsx\dist\cli.mjs" scripts/batch_multi.ts liepin %COUNT% %IVL%
echo.
echo 猎聘重跑结束。若提示仍被拦截，请回 9224 窗口完成短信验证后再双击本文件。
pause
