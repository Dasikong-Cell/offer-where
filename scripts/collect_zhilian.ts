/* 采集智联软件岗：搜索列表收 companydetail → 公司页收 jobdetail 职位 → 写库 */
import { upsertJob } from '../server/db.ts';

const BASE = 'http://127.0.0.1:4400/api/browser/exec';
async function exec(body: any) {
  const r = await fetch(BASE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform: 'zhilian', ...body }) });
  return r.json();
}
async function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
function toHttps(u: string) { return u.replace(/^http:\/\//, 'https://').split('?')[0]; }

const KEYWORDS = ['前端开发', 'Python开发', '测试工程师', '运维工程师', 'Java工程师', '数据分析'];
const EXCLUDE = ['销售', '运营', '客服', '人事', '财务', '行政', '文员', '助理', '护士', '老师', '教师', '销售代表', '导购'];
const KEEP = ['开发', 'java', '前端', '软件', '程序', '技术', '工程师', 'web', '后端', '全栈', 'api', '算法', '测试', '运维', '数据'];

const companyPool = new Set<string>();
const jobPool: Array<{ url: string; company: string; position: string; city: string; salary: string }> = [];

(async () => {
  // 1) 搜索列表页收集公司链接
  for (const kw of KEYWORDS) {
    if (companyPool.size >= 40) break;
    const url = `https://www.zhaopin.com/jobs?kw=${encodeURIComponent(kw)}`;
    const nav = await exec({ action: 'navigate', url, waitUntil: 'domcontentloaded' });
    if (!nav.ok) { console.log('nav fail', kw, JSON.stringify(nav).slice(0, 100)); continue; }
    await sleep(3500);
    for (let i = 0; i < 3; i++) { await exec({ action: 'eval', script: 'window.scrollBy(0,900);"ok"' }); await sleep(700); }
    const r = await exec({ action: 'eval', script: `(() => { const s=new Set(); document.querySelectorAll('a[href*="companydetail"]').forEach(a=>{const h=a.href; if(h) s.add(h.split('?')[0]);}); return Array.from(s); })()` });
    const links: string[] = (r.data || []).map(toHttps);
    links.forEach((l) => companyPool.add(l));
    console.log(`关键词[${kw}] 公司+${links.length} 累计${companyPool.size}`);
    await sleep(800);
  }

  // 2) 公司页收集职位
  let idx = 0;
  for (const comp of companyPool) {
    if (jobPool.length >= 60) break;
    idx++;
    const nav = await exec({ action: 'navigate', url: comp, waitUntil: 'domcontentloaded' });
    if (!nav.ok) continue;
    await sleep(3000);
    for (let i = 0; i < 4; i++) { await exec({ action: 'eval', script: 'window.scrollBy(0,800);"ok"' }); await sleep(600); }
    const r = await exec({
      action: 'eval',
      script: `(() => {
        const company = (document.querySelector('.company-header__name, .company-name, h1')||{}).innerText || document.title || '';
        const items = document.querySelectorAll('.joblist-box__item, .hot-job__card');
        const out = [];
        items.forEach(it => {
          const a = it.querySelector('a[href*="jobdetail"]');
          const href = a ? a.href.split('?')[0] : null;
          if(!href) return;
          const name = (it.querySelector('.jobinfo__name, .hot-job__title')||{}).innerText || (a.innerText||'');
          const salary = (it.querySelector('.jobinfo__salary, .hot-job__salary')||{}).innerText || '';
          const loc = (it.querySelector('[class*="location"], [class*="city"], [class*="area"]')||{}).innerText || '';
          out.push({ url: href.replace(/^http:\\/\\//,'https://'), company: company.trim(), position: name.trim().replace(/\\s+/g,' ').slice(0,50), salary: salary.trim(), city: loc.trim().replace(/\\s+/g,' ').slice(0,20) });
        });
        return out;
      })()`,
    });
    const jobs: any[] = r.data || [];
    let added = 0;
    for (const j of jobs) {
      const pos = (j.position || '').toLowerCase();
      if (EXCLUDE.some((e) => pos.includes(e))) continue;
      if (!KEEP.some((k) => pos.includes(k))) continue;
      if (jobPool.find((x) => x.url === j.url)) continue;
      jobPool.push(j); added++;
    }
    console.log(`公司[${idx}/${companyPool.size}] ${(jobs[0]?.company || comp).slice(0, 30)} 职位+${added} 累计${jobPool.length}`);
    await sleep(600);
  }

  // 3) 写库
  const target = jobPool.slice(0, 55);
  for (const j of target) {
    upsertJob({ source: 'zhilian', company: j.company || null, position: j.position || null, city: j.city || null, salary: j.salary || null, apply_url: j.url, status: 'candidate' });
  }
  console.log(`\n=== 采集完成：公司${companyPool.size}个，职位${jobPool.length}个，入库${target.length}个 ===`);
})();
