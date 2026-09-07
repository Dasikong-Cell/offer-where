/* 51job 用「列表页直投」路径投递（runJob51List），而非详情页 runJob51。
 * 背景：详情页路径点完按钮后页面仍显示「立即投递」，确认不了成功；
 * 列表页直投（搜索结果每行「投递」→ 弹 Element-UI 对话框 → 勾附件简历 → 发送）此前已验证成功。
 * 用法: node scripts/apply_51_list.ts [目标数]
 */
const KEYWORDS = ['Java开发', '软件开发', '前端开发', '软件工程师', 'Java'];
const TARGET = Number(process.argv[2] || 50);

(async () => {
  let total = 0;
  for (const kw of KEYWORDS) {
    if (total >= TARGET) break;
    const want = TARGET - total;
    console.log(`\n>>> 关键词「${kw}」目标再投 ${want} 个`);
    const r = await fetch('http://127.0.0.1:4400/api/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'job51', action: 'keyword', keyword: kw, maxApply: want }),
    });
    const d: any = await r.json();
    console.log(`status=${d.status} | ${(d.message || '').slice(0, 120)}`);
    console.log('appliedCount=', d.appliedCount);
    (d.logs || []).slice(-6).forEach((l: any) => {
      console.log(`   [${l.ok ? 'OK ' : 'FAIL'}] ${l.step} :: ${(l.detail || '').slice(0, 90)}`);
    });
    total += d.appliedCount || 0;
    console.log(`累计投递 ${total}`);
  }
  console.log(`\n=== 51job 列表页直投完成，累计 ${total} 个 ===`);
})();
