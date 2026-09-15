/**
 * job51 投递（自动跳过校招/应届生岗位）
 *
 * 背景：51job 的「校招/应届生岗位」需要单独的校招简历，且点击后会跳转到「应届生求职网」，
 *       自动投递一定返回 unavailable。之前批量投递会逐个白跑一遍（实测 50 个里 14 个是这类），
 *       既浪费时间又容易触发滑块风控。
 *       本脚本先把它们挑出来跳过，只投递可以自动投的社招岗位，并在结尾汇总需手动处理的校招岗。
 *
 * 用法: tsx scripts/apply_job51.ts [最多投递数]
 *   例: tsx scripts/apply_job51.ts 20
 *
 * 注意：51job 对连续投递会弹「访问验证」滑块（need_captcha）。
 *       一旦频繁出现滑块，应暂停、人工在 9225 窗口拖一次滑块后再继续。
 */
const API = 'http://127.0.0.1:4400';

/** 校招/应届生岗位特征词 */
const CAMPUS = ['校招', '应届生', '在校生', '校园招聘', '届校招'];

function isCampus(j: any): boolean {
  const s = `${j.position || ''} ${j.jd || ''}`.toLowerCase();
  return CAMPUS.some((k) => s.includes(k.toLowerCase()));
}

(async () => {
  const max = Number(process.argv[2] || 20);
  const r = await fetch(`${API}/api/jobs`);
  const body: any = await r.json();
  const jobs: any[] = body.jobs || body || [];

  const cand = jobs.filter((j) => j.source === 'job51' && j.status === 'candidate');
  const campus = cand.filter(isCampus);
  const normal = cand.filter((j) => !isCampus(j));

  console.log(`job51 待投 ${cand.length} 个`);
  console.log(` - 可自动投递（社招）：${normal.length}`);
  console.log(` - 校招/应届生（跳过，需手动）：${campus.length}`);
  if (campus.length) {
    console.log('   校招岗清单（51job 自动投递不可用，请在 51job 手动投递）：');
    for (const c of campus.slice(0, 15)) {
      console.log(`   · ${c.company || '?'} | ${(c.position || '').slice(0, 40)}`);
    }
    if (campus.length > 15) console.log(`   … 其余 ${campus.length - 15} 个略`);
  }
  console.log('');

  let applied = 0, manual = 0, captcha = 0, other = 0;
  for (const j of normal.slice(0, max)) {
    console.log(`>>> ${j.company || '?'} | ${(j.position || '').slice(0, 45)}`);
    try {
      const res = await fetch(`${API}/api/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: 'job51', jobId: j.id, channel: 'auto' }),
      });
      const out: any = await res.json();
      console.log(`    => ${out.status} | ${(out.message || '').slice(0, 90)}`);
      if (out.status === 'applied') applied++;
      else if (out.status === 'need_manual') manual++;
      else if (out.status === 'need_captcha') captcha++;
      else other++;
    } catch (e: any) {
      console.log(`    => 请求失败 ${e?.message || e}`);
      other++;
    }
  }

  console.log('');
  console.log(`=== 完成：成功 ${applied} / 需人工 ${manual} / 需滑块 ${captcha} / 其他 ${other} ===`);
  if (captcha > 0) {
    console.log('提示：出现滑块说明 51job 已触发风控，请在 9225 窗口手动拖一次滑块，稍后再跑本脚本。');
  }
})();
