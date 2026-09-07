/* 51job 两级采集（与智联同款套路）
 * 原因：51job 新版列表页 .joblist-item 内的 <a> 只有公司聚合页 /all/coXXX.html，
 *       没有岗位详情链接（实测 matched=[]，SPA）。真实岗位直链在公司页里。
 * 流程：搜索列表页收公司链接 → 进公司页收 jobs.51job.com/<city>/<id>.html 岗位直链 → 写库
 */
import { upsertJob } from '../server/db.ts';

const B = 'http://127.0.0.1:4400/api/browser/exec';
const ex = (platform: string, b: any) => fetch(B, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ platform, ...b }),
}).then((r) => r.json());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const KEYWORDS = ['Java开发', 'Java', '软件开发', '前端开发', '软件工程师', '计算机', 'Web前端', '后端开发'];
const EXCLUDE = ['销售', '运营', '客服', '人事', '财务', '行政', '文员', '护士', '老师', '教师', '导购', '司机', '普工'];
const KEEP = ['开发', 'java', '前端', '软件', '程序', '技术', '工程师', 'web', '后端', '全栈', '算法', '测试', '运维', '数据', 'python', 'go', 'c++', '计算机', 'net'];

/** 列表页：收公司聚合页链接 */
const EXTRACT_COMPANY = `(() => {
  const ABS = (h) => { try { return new URL(h, location.href).href; } catch (e) { return ''; } };
  const set = new Set();
  document.querySelectorAll('a[href]').forEach(a => {
    const h = ABS(a.getAttribute('href'));
    if (h && /jobs\\.51job\\.com\\/all\\/co[A-Za-z0-9]+\\.html/.test(h)) set.add(h.split('?')[0]);
  });
  return Array.from(set);
})()`;

/** 公司页：收岗位直链 + 职位名/公司名/薪资/城市 */
const EXTRACT_JOBS = `(() => {
  const ABS = (h) => { try { return new URL(h, location.href).href; } catch (e) { return ''; } };
  const company = ((document.querySelector('h1') || {}).innerText || document.title || '').trim().split(/\\n/)[0].slice(0, 40);
  const out = [];
  const seen = new Set();
  document.querySelectorAll('a[href]').forEach(a => {
    const h = ABS(a.getAttribute('href'));
    if (!h) return;
    if (!/jobs\\.51job\\.com\\/[^/]+\\/[^/]+\\.html/.test(h)) return;
    if (/\\/all\\/|\\/campus\\//.test(h)) return;
    const url = h.split('?')[0];
    if (seen.has(url)) return;
    seen.add(url);
    const position = (a.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 50);
    const box = a.closest('[class]') || a;
    const txt = (box.innerText || '').replace(/\\s+/g, ' ');
    const sal = (txt.match(/\\d+\\s*[-~]\\s*\\d+\\s*(?:千|万|元\\/月|元\\/天)/) || [])[0] || '';
    const city = (txt.match(/(昆明|北京|上海|广州|深圳|武汉|西安|杭州|南京|成都|重庆|东莞|长沙|苏州|天津|郑州)/) || [])[1] || '';
    out.push({ url, position, company, salary: sal, city });
  });
  return out;
})()`;

(async () => {
  // 阶段1：搜索列表收公司
  const comps: string[] = [];
  for (const kw of KEYWORDS) {
    if (comps.length >= 30) break;
    const nav = await ex('job51', { action: 'navigate', url: `https://we.51job.com/pc/search?keyword=${encodeURIComponent(kw)}`, waitUntil: 'domcontentloaded' });
    if (!nav.ok) { console.log(`列表 kw=${kw} 导航失败`); continue; }
    await sleep(4000);
    for (let i = 0; i < 3; i++) { await ex('job51', { action: 'eval', script: 'window.scrollBy(0,900);"ok"' }); await sleep(800); }
    const r = await ex('job51', { action: 'eval', script: EXTRACT_COMPANY });
    const got: string[] = r.data || [];
    got.forEach((u) => { if (!comps.includes(u)) comps.push(u); });
    console.log(`列表 kw=${kw} 公司+${got.length} 累计${comps.length}`);
    await sleep(600);
  }

  // 阶段2：公司页收岗位
  const pool: any[] = [];
  let idx = 0;
  for (const c of comps) {
    if (pool.length >= 45) break;
    idx++;
    const nav = await ex('job51', { action: 'navigate', url: c, waitUntil: 'domcontentloaded' });
    if (!nav.ok) continue;
    await sleep(3200);
    for (let i = 0; i < 3; i++) { await ex('job51', { action: 'eval', script: 'window.scrollBy(0,900);"ok"' }); await sleep(700); }
    const r = await ex('job51', { action: 'eval', script: EXTRACT_JOBS });
    const items: any[] = r.data || [];
    let added = 0;
    for (const it of items) {
      const pos = (it.position || '').toLowerCase();
      if (EXCLUDE.some((e) => pos.includes(e))) continue;
      if (!KEEP.some((k) => pos.includes(k))) continue;
      if (pool.find((x) => x.url === it.url)) continue;
      pool.push(it); added++;
    }
    console.log(`公司[${idx}/${comps.length}] ${it0(items)} 抓${items.length} 入池+${added} 累计${pool.length}`);
    await sleep(500);
  }

  for (const j of pool) {
    upsertJob({
      source: 'job51',
      company: j.company || null,
      position: j.position || null,
      city: j.city || null,
      salary: j.salary || null,
      apply_url: j.url,
      status: 'candidate',
    });
  }
  console.log(`=== 51job 入库 ${pool.length} 个 ===`);
})();

function it0(items: any[]): string { return items[0]?.company || ''; }
