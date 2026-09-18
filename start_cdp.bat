@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"
call "%~dp0setenv.bat"
if errorlevel 1 exit /b 1

REM Reuse CHROME path detected by setenv.bat. If it is still blank, show a clear error.
if not defined CHROME (
  echo [error] CHROME not detected. Please install Google Chrome and try again.
  pause & exit /b 1
)
if not exist "%CHROME%" (
  echo [error] Chrome not found: %CHROME%
  pause & exit /b 1
)

REM ============================================================
REM Per-platform isolated Chrome windows (Zhideya-style):
REM each platform runs its OWN Chrome process, debug port and
REM user-data-dir, so platforms never crowd into one window.
REM BOSS reuses the existing profile (C:\chrome-cdp-profile) to
REM keep your login state. Every other platform gets a dedicated
REM profile so their logins stay separate and persist per machine.
REM ============================================================

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

echo ============================================
echo   Starting per-platform CDP Chrome windows
echo   BOSS    : %BOSS_PORT%  (%BOSS_PROFILE%)
echo   Liepin  : %LIE_PIN_PORT%  (%LIE_PIN_PROFILE%)
echo   51job   : %JOB51_PORT%  (%JOB51_PROFILE%)
echo   Zhilian : %ZHILIAN_PORT%  (%ZHILIAN_PROFILE%)
echo   Official: %OFFICIAL_PORT%  (%OFFICIAL_PROFILE%)
echo ============================================
echo.

REM 2026-09-12 反检测加固：--disable-blink-features=AutomationControlled 让 navigator.webdriver 返回 false，
REM 抹掉 CDP 自动化特征，避免 BOSS/猎聘/51job 检测到调试器后强制重新登录或弹风控。
REM （--disable-infobars 在 Chrome151 已近似空操作，保留无害）
REM ============================================================================
REM Chrome 启动参数（2026-09-19 依据竞品取证结论复核）
REM
REM 核心一条：--disable-blink-features=AutomationControlled
REM   等价于职得鸭（puppeteer-real-browser）往 --disable-features 里追加 AutomationControlled，
REM   作用是让 navigator.webdriver 返回 false，抹掉 CDP 自动化标志。
REM
REM 刻意【不】做的两件事（否则会主动扩大指纹差异面）：
REM   · 不批量禁用 Chrome 自带特性（Translate / MediaRouter / BackForwardCache …）——
REM     chrome-launcher 的默认 flags 会禁掉这些，而**正常用户的 Chrome 是开着的**，
REM     禁用它们反而让浏览器更容易被识别。职得鸭照抄了这套默认 flags，是它的一处技术债。
REM   · 不启用 --disable-component-update —— 保持组件更新通道正常，贴近真实安装。
REM
REM 已知仍落后竞品的一点（记录在案，勿忘）：
REM   职得鸭用 rebrowser-puppeteer-core，消除了 CDP `Runtime.enable` 的运行时泄漏，
REM   因此它可以正常使用**完整** puppeteer API；我们目前只能靠"绝不调用 Runtime.enable"
REM   手工规避（见 server/services/cdpDriver.ts 注释），CDP 能力被自我限制。
REM   这是架构级改动，需单独 PoC 验证后再替换，不在本次范围内。
REM   自检：scripts/check_stealth.ts 可实测当前窗口到底泄露了哪些指纹。
REM ============================================================================
set "ARGS=--no-first-run --no-default-browser-check --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-blink-features=AutomationControlled --disable-infobars"

REM Window layout: 640x700 grid so all 5 windows fit on a 1920x1080 screen
set "WIN_W=640"
set "WIN_H=700"
set "BOSS_POS=0,0"
set "LIE_PIN_POS=660,0"
set "JOB51_POS=1320,0"
set "ZHILIAN_POS=0,720"
set "OFFICIAL_POS=660,720"

REM BOSS: prefer the shared profile (keeps login state); fall back to isolated
REM profile if it fails to start (e.g. profile locked by a leftover Chrome).
curl -s -m 2 http://127.0.0.1:%BOSS_PORT%/json/version >nul 2>nul
if not errorlevel 1 (
  echo [OK] BOSS already running on %BOSS_PORT% (reuse)
) else (
  start "" "%CHROME%" --remote-debugging-port=%BOSS_PORT% --user-data-dir="%BOSS_PROFILE%" --window-position=%BOSS_POS% --window-size=%WIN_W%,%WIN_H% %ARGS%
  timeout /t 3 >nul
  curl -s -m 2 http://127.0.0.1:%BOSS_PORT%/json/version >nul 2>nul
  if errorlevel 1 (
    echo [WARN] BOSS failed with shared profile; retry with isolated profile
    start "" "%CHROME%" --remote-debugging-port=%BOSS_PORT% --user-data-dir="%PROFILE%-boss" --window-position=%BOSS_POS% --window-size=%WIN_W%,%WIN_H% %ARGS%
  ) else (
    echo [OK] BOSS window ready on %BOSS_PORT%
  )
)

call :launch_platform liepin %LIE_PIN_PORT% "%LIE_PIN_PROFILE%" %LIE_PIN_POS%
call :launch_platform job51 %JOB51_PORT% "%JOB51_PROFILE%" %JOB51_POS%
call :launch_platform zhilian %ZHILIAN_PORT% "%ZHILIAN_PROFILE%" %ZHILIAN_POS%
call :launch_platform official %OFFICIAL_PORT% "%OFFICIAL_PROFILE%" %OFFICIAL_POS%
timeout /t 3 >nul
goto :after_launch_cdp

:launch_platform
curl -s -m 2 http://127.0.0.1:%~2/json/version >nul 2>nul
if not errorlevel 1 (
  echo [OK] %~1 already running on %~2 (reuse)
  goto :eof
)
start "" "%CHROME%" --remote-debugging-port=%~2 --user-data-dir="%~3" --window-position=%~4 --window-size=760,900 %ARGS%
timeout /t 3 >nul
curl -s -m 2 http://127.0.0.1:%~2/json/version >nul 2>nul
if errorlevel 1 ( echo [WARN] %~1 window did not start on %~2 ) else ( echo [OK] %~1 window ready on %~2 )
goto :eof

:after_launch_cdp

echo Waiting for debug ports...
timeout /t 4 >nul

for %%P in (9223 9224 9225 9226 9227) do (
  curl -s -m 3 http://127.0.0.1:%%P/json/version >nul 2>nul
  if !errorlevel!==0 ( echo [OK] port %%P ready ) else ( echo [WARN] port %%P not ready )
)

echo.
echo Done. Each platform is now in its own Chrome window.
echo Open console: http://127.0.0.1:4400/
pause
