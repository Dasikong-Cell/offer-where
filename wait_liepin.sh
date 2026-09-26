#!/bin/bash
# 轮询检测猎聘(9224)登录态：一旦登录成功，自动重投 liepin 50 份。
# 背景：猎聘 PC 岗位页对未登录访问会拦到 wow.liepin.com/t1012695/transit.html 中转页（页面无投递按钮），
#       投递会被判 unavailable。必须先在该调试窗口登录猎聘。
# 只读当前页面（不导航），不打断用户操作。
# 2026-09-26 修：原为硬编码的开发机绝对路径，换机器/换目录即失效 → 改用脚本自身所在目录
cd "$(cd "$(dirname "$0")" && pwd)"
for i in $(seq 1 240); do
  sleep 15
  RES=$(curl -s --max-time 20 -X POST http://127.0.0.1:4400/api/browser/exec -H "Content-Type: application/json" -d "{\"platform\":\"liepin\",\"action\":\"eval\",\"script\":\"(()=>{const t=(document.body?document.body.innerText:'').trim();const ok=(t.indexOf('你好')>=0||t.indexOf('杨先生')>=0||t.indexOf('杨欣宇')>=0);const need=(t.indexOf('登录/注册')>=0&&t.indexOf('密码登录')>=0);return ok?'LOGGED':(need?'NEED_LOGIN':'UNKNOWN')})()\"}")
  echo "[poll $i] $(date +%H:%M:%S) $RES"
  if echo "$RES" | grep -q "LOGGED"; then
    echo "== LIEPIN LOGGED IN at $(date) =="
    echo "== auto apply liepin 50 =="
    "./node/node.exe" "./node_modules/tsx/dist/cli.mjs" scripts/batch_multi.ts liepin 50 15
    echo "== LIEPIN APPLY DONE =="
    break
  fi
done
echo "== poll finished (timeout or done) =="
