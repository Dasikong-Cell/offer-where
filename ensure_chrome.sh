#!/bin/bash
# 一键确保所有平台的「调试 Chrome」在线（幂等：已在线的跳过）
#
# 背景：机器休眠/重启或用户关窗后，各平台调试窗口会全部掉线（CDP 端口 ECONNREFUSED），
#       此时所有投递/采集都会失败，且报错容易被误读成"平台风控/链接失效"。
#       本脚本按 cdp.json 的端口逐个探活，掉线的用对应 profile 重新拉起（登录态保留）。
#
# 用法: bash ensure_chrome.sh
#
# 2026-09-26 修（这条对"打包分发"是致命的）：
#   此前本脚本把 Chrome 路径与 profile 目录**硬编码成开发机的绝对路径**
#   （%USERPROFILE%\AppData\Local\Google\Chrome\... 这类）。接收方解压后跑这个脚本
#   必然报「未找到 Chrome」，而 README 的脚本表偏偏还指向它 —— 开箱即用直接破功。
#   现在改成与 setenv.bat 同款的探测顺序，profile 也随包走（详见下方注释）。
#
# 仍然只覆盖 5 个核心平台（9223-9227）—— 与 start_all.bat 的分层一致，是有意为之：
#   其余平台用 start_platforms.bat（无参再开 9 个，all 开满）或控制台卡片「打开窗口」。
CHROME_BIN="${CHROME_BIN:-}"

# ── 1) 定位 Chrome：三处标准安装位置，顺序与 setenv.bat 严格一致 ──────────────
# 注意用 if 而不是 `[ ] && [ ] && cmd`：后者在条件为假时整行返回非零，
# 一旦将来给本脚本加上 `set -e` 就会在第一个不存在的路径上直接退出。
detect_chrome() {
  local c
  for c in \
    "/c/Program Files/Google/Chrome/Application/chrome.exe" \
    "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe" \
    "${LOCALAPPDATA:-}/Google/Chrome/Application/chrome.exe" \
    "${USERPROFILE:-}/AppData/Local/Google/Chrome/Application/chrome.exe" ; do
    if [ -n "$c" ] && [ -f "$c" ]; then
      printf '%s' "$c"
      return 0
    fi
  done
  return 1
}

if [ -n "$CHROME_BIN" ]; then
  CHROME="$CHROME_BIN"
else
  CHROME="$(detect_chrome)" || CHROME=""
fi
if [ -z "$CHROME" ] || [ ! -f "$CHROME" ]; then
  echo "[错误] 未检测到 Google Chrome。请先安装：https://www.google.com/chrome/"
  echo "       安装后重新运行本脚本即可。若 Chrome 装在非标准位置，"
  echo "       可用 CHROME_BIN=/path/to/chrome.exe bash ensure_chrome.sh 指定。"
  exit 1
fi

# ── 2) CDP 调试 profile：优先 C:\chrome-cdp-profile（登录态跨包复用，与 setenv.bat 一致）；
#      该目录不存在时退回**包内相对目录** —— 保证在别人的机器上也能直接跑起来。
#      Chrome 是原生 Windows 程序，这里的路径必须是 Windows 风格（C:/...），
#      所以用 `pwd -W`（MSYS 提供的 Windows 路径输出）而不是 POSIX 的 /c/... ──
if [ -d "/c/chrome-cdp-profile" ]; then
  BASE="C:/chrome-cdp-profile"
else
  BASE="$(cd "$(dirname "$0")" && { pwd -W 2>/dev/null || pwd; })/chrome-cdp-profile"
fi

# 2026-09-12 反检测加固：--disable-blink-features=AutomationControlled 抹掉 navigator.webdriver 自动化特征，
# 避免 BOSS/猎聘/51job 检测到调试器后强制重新登录或弹风控。
FLAGS="--no-first-run --no-default-browser-check \
  --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --disable-blink-features=AutomationControlled --disable-infobars"

launch() {
  local name="$1" port="$2" profile="$3" pos="$4"
  if curl -s -m 2 "http://127.0.0.1:${port}/json/version" >/dev/null 2>&1; then
    echo "[OK]   ${name} 已在线 (${port})"
    return 0
  fi
  echo "[启动] ${name} (${port}) profile=${profile}"
  "$CHROME" --remote-debugging-port="${port}" --user-data-dir="${profile}" \
    --window-position="${pos}" --window-size=760,900 $FLAGS >/dev/null 2>&1 &
  sleep 5
  if curl -s -m 3 "http://127.0.0.1:${port}/json/version" >/dev/null 2>&1; then
    echo "[OK]   ${name} 已启动"
  else
    echo "[WARN] ${name} 启动失败，请检查 Chrome 路径：${CHROME}"
  fi
}

echo "========== 确保调试 Chrome 在线 =========="
echo "Chrome:       ${CHROME}"
echo "Profile base: ${BASE}"
launch boss     9223 "${BASE}"              0,0
launch liepin   9224 "${BASE}-liepin"       660,0
launch job51    9225 "${BASE}-job51"        1320,0
launch zhilian  9226 "${BASE}-zhilian"      0,720
launch official 9227 "${BASE}-official"     660,720
echo "=========================================="
echo "提示：窗口拉起后登录态通常保留；若某平台仍提示未登录，用 focus_login.ts <平台> 置顶登录。"
echo "      其余平台窗口：start_platforms.bat（无参再开 9 个，all 开满）或控制台卡片「打开窗口」。"
