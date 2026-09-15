#!/bin/bash
# 一键确保所有平台的「调试 Chrome」在线（幂等：已在线的跳过）
#
# 背景：机器休眠/重启或用户关窗后，各平台调试窗口会全部掉线（CDP 端口 ECONNREFUSED），
#       此时所有投递/采集都会失败，且报错容易被误读成"平台风控/链接失效"。
#       本脚本按 cdp.json 的端口逐个探活，掉线的用对应 profile 重新拉起（登录态保留）。
#
# 用法: bash ensure_chrome.sh
CHROME="/c/Users/吉学静/AppData/Local/Google/Chrome/Application/chrome.exe"
BASE="C:/chrome-cdp-profile"

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
launch boss     9223 "${BASE}"              0,0
launch liepin   9224 "${BASE}-liepin"       660,0
launch job51    9225 "${BASE}-job51"        1320,0
launch zhilian  9226 "${BASE}-zhilian"      0,720
launch official 9227 "${BASE}-official"     660,720
echo "=========================================="
echo "提示：窗口拉起后登录态通常保留；若某平台仍提示未登录，用 focus_login.ts <平台> 置顶登录。"
