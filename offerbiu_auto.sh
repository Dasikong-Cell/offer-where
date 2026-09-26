#!/bin/bash
# offerbiu 一键全自动：免登录扫描 companies 岗位 → 筛软件相关入库 → 自动投递
# 用法: bash offerbiu_auto.sh [扫描页数] [最多投递数]
#   例: bash offerbiu_auto.sh 20 12
# 前置：后端 4400 在线；9227(official) 调试 Chrome 已启动；邮箱授权码已配（/api/mail/config 的 hasAuthCode=true）
# 2026-09-26 修：原为硬编码的开发机绝对路径，换机器/换目录即失效 → 改用脚本自身所在目录
cd "$(cd "$(dirname "$0")" && pwd)"
PAGES="${1:-20}"
MAX="${2:-12}"

echo "=========================================="
echo " offerbiu 一键全自动（扫描 ${PAGES} 页 / 最多投 ${MAX} 个）"
echo "=========================================="

echo ""
echo "== [1/2] 扫描 companies 并筛选软件相关岗位 =="
"./node/node.exe" "./node_modules/tsx/dist/cli.mjs" scripts/offerbiu_scan.ts "$PAGES" 1

echo ""
echo "== [2/2] 对软件相关岗位自动投递 =="
"./node/node.exe" "./node_modules/tsx/dist/cli.mjs" scripts/offerbiu_apply.ts "$MAX"

echo ""
echo "== 全部完成 =="
