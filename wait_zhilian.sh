#!/bin/bash
# 轮询检测 zhilian(9226 调试窗口) 登录态；一旦登录成功，自动：
#   1) 采集 zhilian 到 50 份
#   2) 补采 job51（collect_51job，补足 50）
#   3) 四平台并发各投递 50 份
# 用户只需在置顶的 9226 窗口登录 zhilian，无需再回复。轮询 18 分钟超时。
# 2026-09-26 修：原为硬编码的开发机绝对路径，换机器/换目录即失效 → 改用脚本自身所在目录
cd "$(cd "$(dirname "$0")" && pwd)"
BASE="http://127.0.0.1:4400/api/browser/exec"
for i in $(seq 1 72); do
  sleep 15
  RES=$(curl -s --max-time 12 -X POST "$BASE" -H "Content-Type: application/json" -d "{\"platform\":\"zhilian\",\"action\":\"eval\",\"script\":\"(()=>{const links=[].slice.call(document.querySelectorAll('a')).map(a=>(a.innerText||'').trim());const need=links.some(t=>t==='登录/注册'||t.indexOf('登录/注册')>=0);return need?'NEED_LOGIN':'LOGIN_OK';})()\"}")
  echo "[poll $i] $(date +%H:%M:%S) $RES"
  if echo "$RES" | grep -q "LOGIN_OK"; then
    echo "== ZHILIAN LOGGED IN at $(date) =="
    echo "== [step1] collect zhilian to 50 =="
    "./node/node.exe" "./node_modules/tsx/dist/cli.mjs" scripts/collect_multi.ts zhilian 50
    echo "== [step2] top-up job51 (collect_51job) =="
    "./node/node.exe" "./node_modules/tsx/dist/cli.mjs" scripts/collect_51job.ts
    echo "== [step3] batch apply 4 platforms x 50 =="
    "./node/node.exe" "./node_modules/tsx/dist/cli.mjs" scripts/batch_multi.ts boss,job51,liepin,zhilian 50 15
    echo "== ALL DONE =="
    break
  fi
done
echo "== poll finished (timeout or done) =="
