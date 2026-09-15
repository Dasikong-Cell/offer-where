#!/bin/bash
# 全平台补采集（串行，避免抢同一后端/浏览器资源）
# 注意：各平台用各自验证过有效的采集器：
#   boss    -> collect_boss.ts（单级，昆明关键词）
#   job51   -> collect_51job.ts（两级；collect_multi 的 EXTRACT_51 当前失效，抓 0）
#   liepin  -> collect_multi.ts liepin（EXTRACT_LIEPIN 有效）
#   zhilian -> collect_zhilian.ts（两级）
cd "C:/Users/吉学静/WorkBuddy/2026-09-02-09-33-33/job-apply-agent"
NODE="./node/node.exe"
TSX="./node_modules/tsx/dist/cli.mjs"

echo "========== 补采集开始 =========="
echo ""
echo "== [1/4] liepin =="
"$NODE" "$TSX" scripts/collect_multi.ts liepin 50 2>&1 | tail -5
echo ""
echo "== [2/4] zhilian =="
"$NODE" "$TSX" scripts/collect_zhilian.ts 2>&1 | tail -5
echo ""
echo "== [3/4] job51 =="
"$NODE" "$TSX" scripts/collect_51job.ts 2>&1 | tail -5
echo ""
echo "== [4/4] boss =="
"$NODE" "$TSX" scripts/collect_boss.ts 2>&1 | tail -5
echo ""
echo "========== 补采集结束 =========="
echo ""
echo "=== 各平台待投量 ==="
"$NODE" "$TSX" scripts/countjobs.ts 2>&1 | head -10
