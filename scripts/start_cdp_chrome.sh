#!/usr/bin/env bash
# 启动带远程调试端口、且【禁用后台标签页节流】的 Chrome。
# 多平台并行投递的前提：不加这些 flag，非活动 tab 的 setTimeout 会被降频到 1 次/秒
# （5 分钟后 1 次/分），引擎的 waitForSelector 会超时，导致并行批次失败。
#
# 用法:
#   ./scripts/start_cdp_chrome.sh                 # 默认 9222 + C:/chrome-cdp-profile
#   ./scripts/start_cdp_chrome.sh 9223 C:/cdp-boss  # 为某平台启独立实例（配合 cdp.json 改端口）
set -euo pipefail

PORT="${1:-9222}"
PROFILE="${2:-C:/chrome-cdp-profile}"
CHROME="/c/Users/吉学静/AppData/Local/Google/Chrome/Application/chrome.exe"

if [ ! -f "$CHROME" ]; then
  echo "未找到 Chrome: $CHROME" >&2
  exit 1
fi

echo "启动 Chrome: port=$PORT profile=$PROFILE (已禁用后台节流)"
exec "$CHROME" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --no-default-browser-check \
  --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --disable-features=CalculateNativeWinOcclusion \
  "about:blank"
