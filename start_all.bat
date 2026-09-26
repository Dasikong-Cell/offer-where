@echo off
chcp 65001 >nul
call "%~dp0setenv.bat"
if errorlevel 1 exit /b 1

echo ============================================
echo   One-click launch: per-platform CDP Chrome + backend
echo   Each platform opens its OWN Chrome window (Zhideya-style)
echo   Backend: http://127.0.0.1:4400  (must be 4400)
echo ============================================
echo.

REM Reuse CHROME path detected by setenv.bat. If it is still blank, show a clear error.
if not defined CHROME (
  echo [error] CHROME not detected. Please install Google Chrome and try again.
  pause & exit /b 1
)
if not exist "%CHROME%" (
  echo [error] Chrome not found: %CHROME%
  pause & exit /b 1
)

set "BOSS_PORT=9223"
set "LIE_PIN_PORT=9224"
set "JOB51_PORT=9225"
set "ZHILIAN_PORT=9226"
set "OFFICIAL_PORT=9227"

set "BOSS_PROFILE=%PROFILE%"
set "LIE_PIN_PROFILE=%PROFILE%-liepin"
set "JOB51_PROFILE=%PROFILE%-job51"
set "ZHILIAN_PROFILE=%PROFILE%-zhilian"
set "OFFICIAL_PROFILE=%PROFILE%-official"

REM Window layout: 640x700 grid so all 5 windows fit on a 1920x1080 screen
set "WIN_W=640"
set "WIN_H=700"
set "BOSS_POS=0,0"
set "LIE_PIN_POS=660,0"
set "JOB51_POS=1320,0"
set "ZHILIAN_POS=0,720"
set "OFFICIAL_POS=660,720"

REM 1) Start one isolated Chrome window per platform (Zhideya-style)
REM    Pre-check each debug port: if already listening, reuse it instead of
REM    starting a second instance (which would silently fail on port conflict).
REM 2026-09-12 反检测加固：--disable-blink-features=AutomationControlled 抹掉 navigator.webdriver 自动化特征
set "ARGS=--no-first-run --no-default-browser-check --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-blink-features=AutomationControlled --disable-infobars"

REM BOSS: prefer the shared profile (keeps login state); if it fails to start
REM (e.g. profile locked by a leftover Chrome), fall back to an isolated profile
REM so the window always appears.
curl -s -m 2 http://127.0.0.1:%BOSS_PORT%/json/version >nul 2>nul
if not errorlevel 1 (
  echo [OK] BOSS already running on port %BOSS_PORT% (reuse)
) else (
  start "" "%CHROME%" --remote-debugging-port=%BOSS_PORT% --user-data-dir="%BOSS_PROFILE%" --window-position=%BOSS_POS% --window-size=%WIN_W%,%WIN_H% %ARGS%
  timeout /t 3 >nul
  curl -s -m 2 http://127.0.0.1:%BOSS_PORT%/json/version >nul 2>nul
  if errorlevel 1 (
    echo [WARN] BOSS window failed with shared profile; retry with isolated profile
    start "" "%CHROME%" --remote-debugging-port=%BOSS_PORT% --user-data-dir="%PROFILE%-boss" --window-position=%BOSS_POS% --window-size=%WIN_W%,%WIN_H% %ARGS%
  ) else (
    echo [OK] BOSS window ready on port %BOSS_PORT%
  )
)

call :launch_platform liepin %LIE_PIN_PORT% "%LIE_PIN_PROFILE%" %LIE_PIN_POS%
call :launch_platform job51 %JOB51_PORT% "%JOB51_PROFILE%" %JOB51_POS%
call :launch_platform zhilian %ZHILIAN_PORT% "%ZHILIAN_PROFILE%" %ZHILIAN_POS%
call :launch_platform official %OFFICIAL_PORT% "%OFFICIAL_PROFILE%" %OFFICIAL_POS%
timeout /t 3 >nul
goto :after_launch

:launch_platform
curl -s -m 2 http://127.0.0.1:%~2/json/version >nul 2>nul
if not errorlevel 1 (
  echo [OK] %~1 already running on port %~2 (reuse)
  goto :eof
)
start "" "%CHROME%" --remote-debugging-port=%~2 --user-data-dir="%~3" --window-position=%~4 --window-size=760,900 %ARGS%
timeout /t 3 >nul
curl -s -m 2 http://127.0.0.1:%~2/json/version >nul 2>nul
if errorlevel 1 ( echo [WARN] %~1 window did not start on port %~2 ) else ( echo [OK] %~1 window ready on port %~2 )
goto :eof

:after_launch

REM 2) Start backend (skip if already running to avoid port conflict)
curl -s -m 3 http://127.0.0.1:4400/api/health >nul 2>nul
if errorlevel 1 (
  start "JobApply-Server" cmd /k call "%~dp0start_server.bat"
) else (
  echo 后端服务已在运行，跳过启动。
)

echo 打开投递控制台...
REM Wait until backend is ready (cold start is ~6s). Poll /api/ping instead of a fixed sleep,
REM otherwise the console opens too early and shows a connection error.
set /a _try=0
:wait_ready
curl -s -m 2 http://127.0.0.1:4400/api/ping >nul 2>nul
if not errorlevel 1 goto :ready
set /a _try+=1
if %_try% GEQ 40 goto :ready
timeout /t 1 >nul
goto :wait_ready
:ready
REM 2026-09-26 改：控制台不再塞进用户日常浏览器的某个标签，而是用 Chrome 的 --app=
REM   打开**独立窗口**（无地址栏/标签栏，任务栏显示本应用图标，更像个桌面程序）。
REM   想恢复旧行为（默认浏览器新标签），删掉下面整个 if 块换成一行：
REM     start "" http://127.0.0.1:4400/
REM else 分支实际上不可达 —— 脚本开头已强校验 CHROME（未定义/文件不存在都 exit /b 1）。
REM   留着属于纵深防御：万一将来有人挪掉那道前置校验，这里还能退化成「至少能打开」。
if defined CHROME (
  start "" "%CHROME%" --app=http://127.0.0.1:4400/ --no-first-run --no-default-browser-check
) else (
  echo [warn] CHROME 未定义，回退为默认浏览器打开控制台。
  start "" http://127.0.0.1:4400/
)
echo.
echo 已为每个平台打开独立 Chrome 窗口（并排排列）。
echo 在控制台选择平台与数量后点「开始投递」即可，各平台互不干扰。
echo 关闭时关掉标题为「JobApply-Server」的窗口即可停服。
echo.
REM 2026-09-25 开箱实测补充：本脚本只开 5 个核心平台窗口，而项目已登记 15 个平台。
REM 此前没有任何提示，首跑用户会看到控制台里其余平台卡片显示「离线」而无从下手。
echo 提示：本次打开了 5 个核心平台窗口（BOSS / 猎聘 / 51job / 智联 / 官网）。
echo       其余平台（中华英才 / 鱼泡 / 脉脉 / 国聘 / 应届生 / 牛客 等）需要窗口时，二选一：
echo         - 双击 start_platforms.bat（默认再开 9 个；加 all 则全部打开）
echo         - 或在控制台对应平台卡片上点「打开窗口」
pause
