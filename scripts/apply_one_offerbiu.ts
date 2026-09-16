/**
 * 单个 offerbiu 岗位投递（一次只处理一个，避免在多个企业官网之间频繁跳转触发风控/混乱）
 *
 * 用法: tsx scripts/apply_one_offerbiu.ts <公司名关键词> [--email]
 *   例: tsx scripts/apply_one_offerbiu.ts DolphinDB
 *       tsx scripts/apply_one_offerbiu.ts 启明信息 --email   (强制走邮箱通道)
 *
 * 说明：会先在 offerbiu 候选中按公司名匹配，打印将投递的岗位，再调用 /api/apply。
 *      若返回 need_manual（常见于企业官网需要微信扫码/手机号登录），
 *      页面已置顶在 9227 窗口，可人工登录后再次运行本脚本续投。
 */
const API = 'http://127.0.0.1:4400';

(async () => {
  const kw = process.argv[2];
  const channel = process.argv.includes('--email') ? 'email' : 'auto';
  if (!kw) {
    console.error('用法: tsx scripts/apply_one_offerbiu.ts <公司名关键词> [--email]');
    process.exit(1);
  }

  const r = await fetch(`${API}/api/jobs`);
  const body: any = await r.json();
  const jobs: any[] = body.jobs || body || [];
  const hit = jobs
    .filter((j) => j.source === 'offerbiu' && j.status === 'candidate')
    .filter((j) => (j.company || '').includes(kw));

  if (!hit.length) {
    console.log(`未找到公司名含「${kw}」的 offerbiu 待投岗位`);
    return;
  }
  const j = hit[0];
  console.log(`将投递：${j.company} | ${(j.position || '').slice(0, 60)}`);
  console.log(`入口：${(j.apply_url || '').slice(0, 100)}`);
  console.log(`通道：${channel}`);
  console.log('');

  const res = await fetch(`${API}/api/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: 'offerbiu', jobId: j.id, channel, realSend: true }),
  });
  const out: any = await res.json();
  console.log(`结果：${out.status}`);
  console.log(`说明：${out.message || ''}`);
  const logs = out.logs || [];
  if (logs.length) {
    console.log('--- 步骤 ---');
    for (const l of logs.slice(-14)) {
      const t = (l as any).text || (l as any).msg || JSON.stringify(l);
      console.log(` - ${String(t).slice(0, 150)}`);
    }
  }
  if (out.preview) {
    console.log('--- 邮件预览 ---');
    console.log(`收件人：${out.preview.to}`);
    console.log(`标题：${out.preview.subject}`);
  }
})();
