#!/usr/bin/env bash
# 校准 3 个待登录平台的自动回复聊天驱动（对标增强 / 简历卡片通用化）
#
# 用法：
#   bash scripts/calibrate_pending.sh nowcoder
#   bash scripts/calibrate_pending.sh iguopin
#   bash scripts/calibrate_pending.sh yingjiesheng
#   bash scripts/calibrate_pending.sh all
#
# 脚本自动做：探后端 → 探 CDP 标签 → 跑探针 --dump → 给回填指引。
# 不能替你做的（人工）：登录 profile、把探针命中的真实 class 回填到 platformsChat.ts、置 calibrated:true。
# 详见 docs/calibrate-pending-platforms-runbook.md

set -u

PORT=4400
NODE_BIN="./node/node.exe"
TSX="node_modules/tsx/dist/cli.mjs"
PROBE="scripts/probe_chat.ts"

# CDP 端口（与 data/browser/cdp.json 对齐）
declare -A CDP_PORT=( [nowcoder]=9237 [iguopin]=9235 [yingjiesheng]=9236 )
# 标签 profile 路径（与 data/browser/browserLaunch.json 对齐）
declare -A PROFILE=( [nowcoder]="C:/chrome-cdp-profile-nowcoder" [iguopin]="C:/chrome-cdp-profile-iguopin" [yingjiesheng]="C:/chrome-cdp-profile-yingjiesheng" )

TARGET="${1:-nowcoder}"
if [ "$TARGET" = "all" ]; then
  TARGETS="nowcoder iguopin yingjiesheng"
else
  TARGETS="$TARGET"
fi

# 校验平台名
for p in $TARGETS; do
  if [ -z "${CDP_PORT[$p]+x}" ]; then
    echo "未知平台: $p （支持 nowcoder / iguopin / yingjiesheng / all）"
    exit 1
  fi
done

# 后端探活
echo "== 后端探活 (:$PORT) =="
if ! curl -s -m 4 "http://127.0.0.1:${PORT}/api/ping" | grep -q ok; then
  echo "  后端未起。先起后端："
  echo "    PORT=4400 ./node/node.exe node_modules/tsx/dist/cli.mjs server/index.ts"
  exit 1
fi
echo "  ok"

for p in $TARGETS; do
  port=${CDP_PORT[$p]}
  prof=${PROFILE[$p]}
  echo ""
  echo "================================ ${p} (CDP :${port}) ================================"

  # CDP 标签是否存在
  if ! curl -s -m 4 "http://127.0.0.1:${port}/json/version" >/dev/null 2>&1; then
    echo "  CDP 端口 :${port} 无 Chrome 标签（农场未起该平台）"
    if [ "$p" = "iguopin" ] || [ "$p" = "yingjiesheng" ]; then
      echo "  该平台标签已被移出浏览器农场（browserLaunch.json 的 profiles 不含 :${port}）。校准前需先加回："
      echo "    1) 编辑 data/browser/browserLaunch.json，在 profiles 中加："
      echo "         \"${port}\": \"${prof}\""
      echo "    2) 重启 watchdog（或 start_all.bat）让农场起该标签"
      echo "    3) 在该标签登录 ${p} 并养熟（有会话列表、cookie 未过期）"
    else
      echo "  标签未起：运行 start_all.bat 或重启 watchdog。"
    fi
    echo "  完成后重跑： bash scripts/calibrate_pending.sh $p"
    continue
  fi
  echo "  CDP 标签在跑"

  echo "  确认该标签已登录 ${p} 且停在 IM 页（未登录会 NO_LIST）。"
  echo "  >>> 跑探针（--dump 打印真实 class 锚点）..."
  "$NODE_BIN" "$TSX" "$PROBE" "$p" --dump

  echo ""
  echo "  >>> 下一步（人工回填）："
  echo "    打开 server/services/apply/platformsChat.ts，找到 ${p}ChatDriver 的 cfg({...})"
  echo "    把上方探针命中的真实 class 填入对应字段（对照 docs/chat-driver-calibration-checklist.md 2）："
  echo "      listItemSelector / nameSelector / messageSelector / textSelector / mineClassRe / hrClassRe / inputSelector / sendSelector"
  echo "    末尾加 calibrated: true"
  echo "    然后： npm run verify    # tsc + console:check 全绿"
  echo "    预览验证： GET /api/auto-reply/run?platform=${p}&unreadOnly=0&limit=5 （省略 realSend = 预览）"
done
