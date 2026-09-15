/**
 * Offerbiu 定向采集（按关键词搜索，免登录）
 *
 * 背景：盲目翻页命中率极低（20 页/180 条只筛出 4 条软件岗，约 2%）。
 *      companies 页有搜索框（placeholder「搜索公司、岗位、行业、城市、备注关键词」），
 *      按「软件 / 开发 / Java / 前端 …」搜索可大幅提高软件岗命中率。
 *
 * 用法: tsx scripts/offerbiu_search.ts [关键词,逗号分隔] [每关键词页数] [是否入库 1/0]
 *   例: tsx scripts/offerbiu_search.ts 软件,开发,Java,前端,后端 1 1
 */
import { upsertJob } from '../server/db.ts';

import { ex } from './lib/browser.ts';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CTX = 'official';
const SEARCH_SEL = 'input[placeholder*="搜索"]';

const COUNT_CARDS = 'JSON.stringify(Array.from(document.querySelectorAll("a")).filter(a=>(a.innerText||"").indexOf("投递入口")>=0).length)';

/** 聚焦搜索框并派发回车（不依赖 activeElement，比 press 更稳） */
const PRESS_ENTER = `(() => {
  const el = document.querySelector('input[placeholder*="搜索"]');
  if (!el) return 'NO_INPUT';
  el.focus();
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
  return 'ok';
})()`;

const EXTRACT = `(() => {
  const out = [];
  const anchors = Array.from(document.querySelectorAll('a')).filter(a => (a.innerText || '').indexOf('投递入口') >= 0);
  for (const a of anchors) {
    let el = a, root = null;
    for (let i = 0; i < 8; i++) {
      el = el.parentElement; if (!el) break;
      const t = (el.innerText || '');
      if (t.indexOf('更新') >= 0 && t.length > 20) { root = el; break; }
    }
    if (!root) root = a.parentElement;
    const txt = (root.innerText || '');
    let site = '';
    const jobsNew = root.querySelector('a[href*="/jobs/new/"]');
    if (jobsNew) {
      const h = jobsNew.getAttribute('href') || '';
      const idx = h.indexOf('link=');
      if (idx >= 0) {
        let v = h.slice(idx + 5);
        const amp = v.indexOf('&'); if (amp >= 0) v = v.slice(0, amp);
        try { site = decodeURIComponent(v); } catch (e) { site = v; }
      }
    }
    if (!site) {
      const ext = Array.from(root.querySelectorAll('a[href^="http"]')).find(x => (x.getAttribute('href') || '').indexOf('offerbiu.com') < 0);
      if (ext) site = (ext.getAttribute('href') || '').split('?')[0];
    }
    out.push({ txt: txt.slice(0, 400), site });
  }
  return out;
})()`;

const KEYWORDS = [
  '软件', '前端', '后端', '全栈', '开发', '程序', 'java', '测试', '算法', '数据',
  '人工智能', 'AI', '机器学习', '计算机', 'web', 'python', '嵌入式', '安卓', 'android', 'ios',
  '研发', '技术', 'IT', '系统', '网络', '运维', '云计算', '大数据', '芯片', '半导体',
];
const EXCLUDE = [
  '销售', '市场', '营销', '运营', '人力', 'HR', '财务', '会计', '行政', '客服',
  '护士', '教师', '老师', '导购', '司机', '普工', '操作工', '机械', '结构', '硬件',
  '电气', '化工', '材料', '工艺', '飞行器', '动力', '泵', '阀', '制造', '生产',
  '质量', '供应链', '采购', '物流', '仓储', '土建', '建筑', '医学', '临床', '生物',
  '制药', '金融', '投资', '银行', '保险', '信托',
];

function flat(s: string): string { return (s || '').replace(/\s+/g, ' ').trim(); }

function parseCard(txt: string) {
  const t = flat(txt);
  const company = (t.split('更新')[0] || '').trim() || '未知公司';
  const after = (t.split('更新')[1] || '').replace(/^\s*\d{1,2}月\d{1,2}日\s*/, '').trim();
  const cut = after.search(/(民企|央国企|外企|国企|通信|互联网|金融|制造|能源|地产|医疗|教育|汽车|消费|传媒|人工智能|政府|事业单位|社会组织|电子|化工|机械|生物|制药|北京|上海|广州|深圳|杭州|成都|南京|武汉|西安|重庆|苏州|天津|长沙|青岛|宁波|东莞|无锡|佛山|合肥|厦门|福州|济南|郑州|大连|珠海|常州|沈阳|长春|哈尔滨|石家庄|昆明|贵阳|南宁|南昌|太原|兰州|海口|20\d\d\s*届|尽快投递|秋招|实习|补录|提前批|需要笔试|免笔试|投递入口|加入投递)/);
  const position = (cut > 0 ? after.slice(0, cut) : after).trim() || company;
  return { company, position };
}

function isSoftwareRelated(position: string): boolean {
  const p = (position || '').toLowerCase();
  if (!p) return false;
  if (EXCLUDE.some((e) => p.toLowerCase().includes(e.toLowerCase()))) return false;
  return KEYWORDS.some((k) => p.toLowerCase().includes(k.toLowerCase()));
}

(async () => {
  const kws = (process.argv[2] || '软件,开发,Java,前端,后端,计算机,算法,数据,测试,人工智能,程序员,IT')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const perPages = Number(process.argv[3] || 1);
  const doSave = process.argv[4] !== '0';

  await ex(CTX, 'navigate', { url: 'https://offerbiu.com/companies/', waitUntil: 'domcontentloaded' });
  await sleep(8000);
  for (let w = 0; w < 25; w++) {
    const pr = await ex(CTX, 'eval', { script: COUNT_CARDS });
    if ((Number(pr.data) || 0) > 0) break;
    await sleep(1200);
  }

  const seen = new Set<string>();
  const matched: any[] = [];
  let scanned = 0;

  for (const kw of kws) {
    const fill = await ex(CTX, 'fill', { selector: SEARCH_SEL, value: kw, timeout: 8000 });
    if (!fill.ok) { console.log(`[${kw}] 未找到搜索框，跳过`); continue; }
    await sleep(600);
    await ex(CTX, 'eval', { script: PRESS_ENTER });

    // 等搜索结果渲染
    let n = 0;
    for (let w = 0; w < 20; w++) {
      const pr = await ex(CTX, 'eval', { script: COUNT_CARDS });
      n = Number(pr.data) || 0;
      if (n > 0) break;
      await sleep(1000);
    }
    await sleep(1500);

    for (let pg = 0; pg < perPages; pg++) {
      for (let k = 0; k < 4; k++) {
        await ex(CTX, 'eval', { script: 'window.scrollTo(0, document.body.scrollHeight); "ok"' });
        await sleep(1200);
      }
      const r = await ex(CTX, 'eval', { script: EXTRACT });
      const cards: Array<{ txt: string; site: string }> = (r.data as any) || [];
      scanned += cards.length;

      for (const c of cards) {
        const { company, position } = parseCard(c.txt);
        const key = (c.site || '') + '|' + company;
        if (!c.site || seen.has(key)) continue;
        seen.add(key);
        if (!isSoftwareRelated(position)) continue;
        matched.push({ company, position, site: c.site });
        if (doSave) {
          upsertJob({
            source: 'offerbiu', company, position, city: null,
            jd: flat(c.txt).slice(0, 300), apply_url: c.site, status: 'candidate',
          });
        }
        console.log(`[${kw}] ${company} | ${position.slice(0, 55)} | ${c.site.slice(0, 75)}`);
      }
      if (perPages > 1 && pg < perPages - 1) {
        const nx = await ex(CTX, 'click', { text: '下一页', timeout: 5000 });
        if (!nx.ok) break;
        await sleep(2500);
        for (let w = 0; w < 15; w++) {
          const pr = await ex(CTX, 'eval', { script: COUNT_CARDS });
          if ((Number(pr.data) || 0) > 0) break;
          await sleep(1000);
        }
      }
    }
    console.log(`-- 关键词「${kw}」：结果 ${n} 条，累计匹配 ${matched.length}`);
  }

  console.log(`\n=== 定向采集完成：浏览 ${scanned} 条，软件相关 ${matched.length} 条${doSave ? '（已入库）' : '（未入库）'} ===`);
  for (const m of matched) console.log(`- ${m.company} | ${m.position.slice(0, 50)} | ${m.site}`);
})();
