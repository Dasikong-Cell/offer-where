/* 通用多平台岗位采集：job51 / liepin / boss
 * 用法: node scripts/collect_multi.ts <platforms,逗号分隔> [每平台目标数]
 * 例:   node scripts/collect_multi.ts job51,liepin 40
 *
 * 说明：各平台列表页 DOM 不同，这里按平台分别写提取脚本，统一产出
 * {url, position, company, salary, city} 后写库（source=平台名，status=candidate）。
 */
import { upsertJob } from '../server/db.ts';
import { randomUUID } from 'crypto';

import { ex } from './lib/browser.ts';
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
    if (!/lptjob/.test(href)) return;
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

// BOSS：列表卡片 = .job-card-wrap（实测单页 90 个），卡片内 a[href*="job_detail"] 即岗位直链。
// ⚠️ 选择器踩坑修正（2026-09-19 实测）：
//   · 旧版用 `.job-title` 取职位名 —— 该元素的 innerText 是「职位名\n薪资」，而 BOSS 薪资用
//     **加密字体**渲染（Unicode 私有区 U+E000–U+F8FF），抽取时数字丢失，于是变成 `"Java\n-K"` 这种脏值入库。
//     正确选择器是 `.job-name`（只有职位名）。
//   · 旧版用 `.company-name` 取公司名 —— 该选择器在列表卡片上**不存在**，导致 company 全为空。
//     正确选择器是 `.boss-name`（实测命中，如「兆富科技」）。
//   · 旧版用 `[class*="job-card"], li` 这种宽泛选择器遍历容器，易产生嵌套重复项。
const EXTRACT_BOSS = `(() => {
  const out = [];
  const PUA = /[\\uE000-\\uF8FF]/;
  document.querySelectorAll('.job-card-wrap').forEach(c => {
    const a = c.querySelector('a[href*="job_detail"]');
    if (!a) return;
    const href = (a.href || '').split('?')[0];
    if (!href) return;
    const position = ((c.querySelector('.job-name') || {}).innerText || '').trim();
    const company = ((c.querySelector('.boss-name') || {}).innerText || '').trim();
    let salary = ((c.querySelector('.job-salary') || {}).innerText || '').trim();
    if (PUA.test(salary)) salary = ''; // 加密字体，数字无法还原
    const txt = (c.innerText || '').replace(/\\s+/g, ' ');
    const cityM = txt.match(/(昆明|北京|上海|广州|深圳|杭州|成都|重庆|武汉|西安|南京|苏州|长沙|郑州|天津|厦门|青岛)/);
    out.push({ url: href, position, company, salary, city: cityM ? cityM[1] : '' });
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
        // 无直链 / 无职位名的候选无法投递、也无法去重，直接丢弃（避免脏数据入库）
        if (!it.url || !it.position) continue;
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
    // 写库前最后一道护栏：没有直链的岗位投不了，不入库
    if (!j.url) continue;
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
