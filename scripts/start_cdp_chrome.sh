#!/usr/bin/env bash
# 启动带远程调试端口、且【禁用后台标签页节流】的 Chrome。
# 多平台并行投递的前提：不加这些 flag，非活动 tab 的 setTimeout 会被降频到 1 次/秒
# （5 分钟后 1 次/分），引擎的 waitForSelector 会超时，导致并行批次失败。
#
# 用法:
#   ./scripts/start_cdp_chrome.sh                 # 默认 9222 + C:/chrome-cdp-profile
#   ./scripts/start_cdp_chrome.sh 9223 C:/cdp-boss  # 为某平台启独立实例（配合 cdp.json 改端口）
#
# 2026-09-26 修：Chrome 路径此前硬编码成开发机的绝对路径（%USERPROFILE%\AppData\Local\...）。
#   本脚本位于 scripts/，而 scripts/ 是**会进发布包**的 ⇒ 接收方机器上必然「未找到 Chrome」。
#   改为在四处标准位置里找第一个存在的；仍可用 CHROME_BIN 显式覆盖（非标准安装路径）。
set -euo pipefail

PORT="${1:-9222}"
PROFILE="${2:-C:/chrome-cdp-profile}"

CHROME="${CHROME_BIN:-}"
if [ -z "$CHROME" ]; then
  # 用 if 而不是 `[ ] && [ ] && set`：set -e 下短路链返回非零会直接终止脚本。
  for c in \
    "/c/Program Files/Google/Chrome/Application/chrome.exe" \
    "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe" \
    "${LOCALAPPDATA:-}/Google/Chrome/Application/chrome.exe" \
    "${USERPROFILE:-}/AppData/Local/Google/Chrome/Application/chrome.exe" ; do
    if [ -n "$c" ] && [ -f "$c" ]; then
      CHROME="$c"
      break
    fi
  done
fi

if [ -z "$CHROME" ] || [ ! -f "$CHROME" ]; then
  echo "未找到 Chrome。请安装 Google Chrome，或用 CHROME_BIN=/path/to/chrome.exe 指定。" >&2
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
