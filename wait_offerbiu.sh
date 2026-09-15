#!/bin/bash
# 轮询检测 offerbiu 登录态（9227 窗口）：只读 /json/list 的标签 URL，不新建标签、不打断用户操作。
# 一旦当前窗口离开 offerbiu.com/login（说明登录成功），自动采集 companies 页面岗位。
# 注意：只采集入库（只读），不做真实投递 —— 投递涉及发信给 HR，必须人工确认后再发。
cd "C:/Users/吉学静/WorkBuddy/2026-09-02-09-33-33/job-apply-agent"
for i in $(seq 1 288); do
  sleep 15
  URLS=$(curl -s --max-time 6 http://127.0.0.1:9227/json/list | grep -o '"url": "[^"]*"')
  echo "[poll $i] $(date +%H:%M:%S) $URLS"
  if echo "$URLS" | grep -q "offerbiu.com" && ! echo "$URLS" | grep -q "offerbiu.com/login"; then
    echo "== OFFERBIU LOGGED IN at $(date) =="
    echo "== collect offerbiu companies (limit 30) =="
    curl -s --max-time 240 -X POST http://127.0.0.1:4400/api/offerbiu/collect -H "Content-Type: application/json" -d '{"limit":30}'
    echo ""
    echo "== COLLECT DONE =="
    break
  fi
done
echo "== poll finished (timeout or done) =="
