/* BOSS 直聘 单级采集：搜索结果页直接含岗位直链（.job-card-wrap → job_detail URL）
 * 城市锁定昆明（101290100），关键词围绕 Java / 软件开发 / 前端 / 测试 等。
 * 与 51job / 智联 不同，BOSS 搜索列表页每个卡片就带岗位详情链接，无需进公司页二级跳转。
 */
import { upsertJob } from '../server/db.ts';

import { makeEx } from './lib/browser.ts';
const ex = makeEx('boss');
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

// 昆明城市码
const CITY = '101290100';
const CITY_NAME = '昆明';

const KEYWORDS = [
  'Java开发', 'Java', '软件开发', '软件工程师', '后端开发', 'Web前端', '前端开发',
  'Python开发', '测试工程师', '数据开发', '计算机', '运维工程师',
];

const EXCLUDE = [
  '销售', '顾问', '运营', '客服', '人事', '财务', '行政', '文员', '护士', '老师', '教师',
  '导购', '司机', '普工', '商务', '中介', '主播', '兼职',
];
const KEEP = [
  '开发', 'java', '前端', '软件', '程序', '技术', '工程师', 'web', '后端', '全栈',
  'api', '算法', '测试', '运维', '数据', 'python', 'go', 'c++', '计算机', 'net', '架构',
];

/** 单页抽取：.job-card-wrap 卡片 → 岗位直链 + 职位/公司/薪资 */
const EXTRACT = `(() => {
  const ABS = (h) => { try { return new URL(h, location.href).href; } catch (e) { return ''; } };
  const PUA = /[\\uE000-\\uF8FF]/; // 私有区字形（BOSS 薪资加密字体）
  const out = [];
  const seen = new Set();
  document.querySelectorAll('.job-card-wrap').forEach(card => {
    const a = card.querySelector('a[href*="job_detail"]');
    if (!a) return;
    const url = ABS(a.getAttribute('href')).split('?')[0];
    if (!url || seen.has(url)) return;
    seen.add(url);
    const position = ((card.querySelector('.job-name') || {}).innerText || a.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 50);
    const company = ((card.querySelector('.boss-name') || {}).innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
    let salary = ((card.querySelector('.job-salary') || {}).innerText || '').trim();
    if (PUA.test(salary)) salary = ''; // 字形加密，无法还原，置空
    out.push({ url, position, company, salary });
  });
  return out;
})()`;

(async () => {
  const pool: Array<{ url: string; company: string; position: string; city: string; salary: string }> = [];
  let kwIdx = 0;
  for (const kw of KEYWORDS) {
    if (pool.length >= 60) break;
    kwIdx++;
    const url = `https://www.zhipin.com/web/geek/jobs?query=${encodeURIComponent(kw)}&city=${CITY}`;
    const nav = await ex('navigate', { url, waitUntil: 'domcontentloaded' });
    if (!nav.ok) { console.log(`[${kwIdx}] 导航失败: ${JSON.stringify(nav).slice(0, 120)}`); continue; }
    await sleep(3500);
    // 滚动加载更多（BOSS 懒加载，滚几次出满）
    for (let i = 0; i < 8; i++) {
      await ex('eval', { script: 'window.scrollBy(0, 1000); "ok"' });
      await sleep(700);
    }
    const r = await ex('eval', { script: EXTRACT });
    const items: any[] = r.data || [];
    let added = 0;
    for (const it of items) {
      const pos = (it.position || '').toLowerCase();
      if (EXCLUDE.some((e) => pos.includes(e))) continue;
      if (!KEEP.some((k) => pos.includes(k))) continue;
      if (pool.find((x) => x.url === it.url)) continue;
      pool.push({
        url: it.url,
        company: it.company || null,
        position: it.position || null,
        city: CITY_NAME,
        salary: it.salary || null,
      });
      added++;
    }
    console.log(`[${kwIdx}/${KEYWORDS.length}] 关键词=${kw} 抓${items.length} 入池+${added} 累计${pool.length}`);
    await sleep(800);
  }

  // 尝试点击「加载更多」兜底（部分关键词底部有该按钮）
  console.log(`\n=== 共采集 ${pool.length} 个候选岗位，开始写库 ===`);
  let inserted = 0;
  for (const j of pool) {
    upsertJob({
      source: 'boss',
      company: j.company || null,
      position: j.position || null,
      city: j.city || null,
      salary: j.salary || null,
      apply_url: j.url,
      status: 'candidate',
    });
    inserted++;
  }
  console.log(`=== BOSS 入库 ${inserted} 个（source=boss, status=candidate）===`);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
