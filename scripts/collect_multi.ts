/* 通用多平台岗位采集：job51 / liepin / boss
 * 用法: node scripts/collect_multi.ts <platforms,逗号分隔> [每平台目标数]
 * 例:   node scripts/collect_multi.ts job51,liepin 40
 *
 * 说明：各平台列表页 DOM 不同，这里按平台分别写提取脚本，统一产出
 * {url, position, company, salary, city} 后写库（source=平台名，status=candidate）。
 */
import { upsertJob } from '../server/db.ts';
import { randomUUID } from 'crypto';

const B = 'http://127.0.0.1:4400/api/browser/exec';
const ex = (platform: string, b: any) => fetch(B, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ platform, ...b }),
}).then((r) => r.json());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const platforms = (process.argv[2] || 'job51').split(',').map((s) => s.trim()).filter(Boolean);
const PER_PLATFORM = Number(process.argv[3] || 40);

const EXCLUDE = ['销售', '运营', '客服', '人事', '财务', '行政', '文员', '护士', '老师', '教师', '导购', '司机', '普工'];
const KEEP = ['开发', 'java', '前端', '软件', '程序', '技术', '工程师', 'web', '后端', '全栈', '算法', '测试', '运维', '数据', 'python', 'go', 'c++', '计算机'];

// 51job：列表项 .joblist-item 带 sensorsdata(JSON)，直接取 jobTitle/jobSalary/jobArea，比猜选择器稳
// 注意：列表项内第一个 jobs.51job.com 链接常是公司聚合页 /all/coXXX（必须排除），
// 真实岗位链接在其它 <a> 上且可能是相对路径 —— 所以要遍历全部 a 并转成绝对 URL 再匹配。
const EXTRACT_51 = `(() => {
  const out = [];
  const ABS = (h) => { try { return new URL(h, location.href).href; } catch (e) { return ''; } };
  document.querySelectorAll('.joblist-item').forEach(it => {
    const sdEl = it.querySelector('[sensorsdata]');
    let title = '', salary = '', city = '';
    if (sdEl) { try { const o = JSON.parse(sdEl.getAttribute('sensorsdata')); title = o.jobTitle || ''; salary = o.jobSalary || ''; city = o.jobArea || ''; } catch (e) {} }
    const allHrefs = Array.from(it.querySelectorAll('a[href]')).map(a => ABS(a.getAttribute('href'))).filter(Boolean);
    const href = (allHrefs.find(h => /jobs\\.51job\\.com\\/[^/]+\\/[^/]+\\.html/.test(h) && !/\\/all\\/|\\/campus\\//.test(h)) || '').split('?')[0];
    if (!href) return;
    const company = ((it.querySelector('.cname') || {}).innerText || '').trim();
    out.push({ url: href, position: title, company, salary, city });
  });
  return out;
})()`;

// 猎聘：卡片 [class*="job-card-pc-container"]，链接 /lptjob/<id>，职位名在 .ellipsis-1 的 title
const EXTRACT_LIEPIN = `(() => {
  const out = [];
  document.querySelectorAll('[class*="job-card-pc-container"]').forEach(c => {
    const a = c.querySelector('a[data-nick="job-detail-job-info"]');
    if (!a) return;
    const href = (a.href || '').split('?')[0];
    if (!/lptjob|liepin\\.com\\/job\\//.test(href)) return;
    const t = a.querySelector('.ellipsis-1');
    const position = t ? ((t.getAttribute('title') || t.innerText || '').trim()) : '';
    const compEl = c.querySelector('[data-nick="job-detail-company-info"]');
    const company = compEl ? (compEl.innerText || '').trim().split(/\\n/)[0].slice(0, 40) : '';
    const txt = (c.innerText || '').replace(/\\s+/g, ' ');
    const m = txt.match(/\\d+\\s*[-~]\\s*\\d+\\s*(?:k|K|千|万)?/);
    const cityM = txt.match(/【\\s*([^】]{2,10})\\s*】/);
    out.push({ url: href, position, company, salary: m ? m[0] : '', city: cityM ? cityM[1] : '' });
  });
  return out;
})()`;

// BOSS：列表卡片含 a[href*="job_detail"]
const EXTRACT_BOSS = `(() => {
  const out = [];
  document.querySelectorAll('[class*="job-card"], .job-card-wrapper, li').forEach(c => {
    const a = c.querySelector('a[href*="job_detail"]');
    if (!a) return;
    const href = (a.href || '').split('?')[0];
    const position = ((c.querySelector('.job-title, .job-name, [class*="job-name"], [class*="job-title"]') || {}).innerText || '').trim();
    const company = ((c.querySelector('.company-name, [class*="company-name"]') || {}).innerText || '').trim();
    const txt = (c.innerText || '').replace(/\\s+/g, ' ');
    const m = txt.match(/\\d+\\s*[-~]\\s*\\d+\\s*[kK]/);
    out.push({ url: href, position, company, salary: m ? m[0] : '', city: '' });
  });
  return out;
})()`;

const CFG: Record<string, { search: (kw: string) => string; keywords: string[]; extract: string }> = {
  job51: {
    search: (kw) => `https://we.51job.com/pc/search?keyword=${encodeURIComponent(kw)}`,
    keywords: ['Java开发', 'Java', '软件开发', '前端开发', '软件工程师', '计算机', 'Web前端', '后端开发'],
    extract: EXTRACT_51,
  },
  liepin: {
    search: (kw) => `https://www.liepin.com/zhaopin/?key=${encodeURIComponent(kw)}&curPage=0`,
    keywords: ['Java', '软件开发', '前端', '软件工程师', '后端开发', '计算机'],
    extract: EXTRACT_LIEPIN,
  },
  boss: {
    search: (kw) => `https://www.zhipin.com/web/geek/job?query=${encodeURIComponent(kw)}&city=100010000`,
    keywords: ['Java', 'Java开发', '前端开发', '软件工程师', '后端开发'],
    extract: EXTRACT_BOSS,
  },
};

async function collectOne(platform: string) {
  const cfg = CFG[platform];
  if (!cfg) { console.log(`[${platform}] 无采集配置`); return 0; }
  const pool: Array<{ url: string; position: string; company: string; salary: string; city: string }> = [];
  const MAX_PAGES = 3; // 每关键词翻 3 页，扩大候选池以凑满 50 份
  for (const kw of cfg.keywords) {
    if (pool.length >= PER_PLATFORM) break;
    for (let pg = 0; pg < MAX_PAGES; pg++) {
      if (pool.length >= PER_PLATFORM) break;
      const url = cfg.search(kw).replace(/curPage=\d+/, `curPage=${pg}`);
      const nav = await ex(platform, { action: 'navigate', url, waitUntil: 'domcontentloaded' });
      if (!nav.ok) { console.log(`[${platform}] kw=${kw} p${pg} 导航失败`); continue; }
      await sleep(4000);
      for (let i = 0; i < 4; i++) { await ex(platform, { action: 'eval', script: 'window.scrollBy(0,900);"ok"' }); await sleep(800); }
      const r = await ex(platform, { action: 'eval', script: cfg.extract });
      const items: any[] = r.data || [];
      let added = 0;
      for (const it of items) {
        const pos = (it.position || '').toLowerCase();
        if (EXCLUDE.some((e) => pos.includes(e))) continue;
        if (!KEEP.some((k) => pos.includes(k))) continue;
        if (pool.find((x) => x.url === it.url)) continue;
        pool.push(it); added++;
      }
      console.log(`[${platform}] kw=${kw} p${pg} 抓${items.length} 入池+${added} 累计${pool.length}`);
      await sleep(700);
    }
  }
  const target = pool.slice(0, PER_PLATFORM);
  for (const j of target) {
    upsertJob({
      source: platform,
      company: j.company || null,
      position: j.position || null,
      city: j.city || null,
      salary: j.salary || null,
      apply_url: j.url,
      status: 'candidate',
    });
  }
  console.log(`[${platform}] === 入库 ${target.length} 个 ===`);
  return target.length;
}

(async () => {
  for (const p of platforms) { await collectOne(p); }
  console.log('采集全部完成');
})();
