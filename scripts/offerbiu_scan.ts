/**
 * Offerbiu 校招信息库扫描（免登录）
 *
 * 背景：offerbiu.com/companies/ 无需登录即可浏览（页面顶部虽有「登录/注册」，但岗位列表是公开的）。
 *      每个岗位卡片的「投递入口」链接形如
 *        /jobs/new/?source=...&company=<公司>&title=<岗位>&city=<城市>&link=<URL编码的企业官网地址>
 *      解码 link 参数即为企业真实投递页（也有卡片直接给出 https 外链）。
 *
 * 用法: tsx scripts/offerbiu_scan.ts [页数] [是否入库 1/0]
 *   例: tsx scripts/offerbiu_scan.ts 10 1
 *
 * 输出：仅打印「软件相关」岗位（按 KEYWORDS 命中、EXCLUDE 排除），并可选入库为 source=offerbiu 候选。
 */
import { upsertJob } from '../server/db.ts';

import { ex } from './lib/browser.ts';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CTX = 'official'; // 复用 9227 真实 Chrome（与投递同一上下文，登录态共享）

/** 提取本页岗位卡片：公司/职位列表/城市文本 + 真实官网投递地址 */
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

/** 软件/技术相关关键词（命中即视为符合方向） */
const KEYWORDS = [
  '软件', '前端', '后端', '全栈', '开发', '程序', 'java', 'Java', 'JAVA',
  '测试', '算法', '数据', '人工智能', 'AI', 'ai', '机器学习', '计算机',
  'web', 'Web', 'WEB', 'python', 'Python', '嵌入式', '安卓', 'Android', 'iOS',
  '研发', '技术', 'IT', 'it', '系统', '网络', '运维', '云计算', '大数据', '芯片', '半导体',
];
/** 明显不属于软件方向的岗位（用于排除，避免海投不相关岗） */
const EXCLUDE = [
  '销售', '市场', '营销', '运营', '人力', 'HR', 'hr', '财务', '会计', '行政',
  '客服', '护士', '教师', '老师', '导购', '司机', '普工', '操作工',
  '机械', '结构', '硬件', '电气', '化工', '材料', '工艺', '飞行器', '动力',
  '泵', '阀', '制造', '生产', '质量', '供应链', '采购', '物流', '仓储',
  '设计', '土建', '建筑', '医学', '临床', '生物', '制药', '金融', '投资', '银行', '保险', '信托',
];

function flat(s: string): string { return (s || '').replace(/\s+/g, ' ').trim(); }

/** 从卡片文本里切出「公司名」与「职位列表」 */
function parseCard(txt: string) {
  const t = flat(txt);
  const company = (t.split('更新')[0] || '').trim() || '未知公司';
  let after = (t.split('更新')[1] || '').replace(/^\s*\d{1,2}月\d{1,2}日\s*/, '').trim();
  // 职位列表在标签（民企/央国企/城市/2027届...）之前
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
  const pages = Number(process.argv[2] || 10);
  const doSave = process.argv[3] !== '0';

  await ex(CTX, 'navigate', { url: 'https://offerbiu.com/companies/', waitUntil: 'domcontentloaded' });
  await sleep(8000);

  // SPA 渲染较慢：轮询等待「投递入口」卡片出现后再开始，避免提取到空列表
  // 注意：cdpDriver 的 eval 对「纯数字」返回值回传不稳，统一用 JSON.stringify 包成字符串
  const COUNT_CARDS = 'JSON.stringify(Array.from(document.querySelectorAll("a")).filter(a=>(a.innerText||"").indexOf("投递入口")>=0).length)';
  const WHERE = 'JSON.stringify({url: location.href, anchors: Array.from(document.querySelectorAll("a")).filter(a=>(a.innerText||"").indexOf("投递入口")>=0).length})';
  let ready = 0;
  for (let w = 0; w < 25; w++) {
    const pr = await ex(CTX, 'eval', { script: COUNT_CARDS });
    ready = Number(pr.data) || 0;
    if (w === 0 || w === 5 || w === 12) {
      const wp = await ex(CTX, 'eval', { script: WHERE });
      console.log(`  [诊断 w=${w}] count=${pr.data} where=${wp.data}`);
    }
    if (ready > 0) break;
    await sleep(1200);
  }
  console.log(`卡片渲染就绪：${ready} 个`);

  const seen = new Set<string>();
  const matched: any[] = [];
  let scanned = 0;

  for (let p = 0; p < pages; p++) {
    for (let k = 0; k < 6; k++) {
      await ex(CTX, 'eval', { script: 'window.scrollTo(0, document.body.scrollHeight); "ok"' });
      await sleep(1500);
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
      const item = { company, position, site: c.site, city: null as string | null };
      matched.push(item);
      if (doSave) {
        upsertJob({
          source: 'offerbiu',
          company,
          position,
          city: null,
          jd: flat(c.txt).slice(0, 300),
          apply_url: c.site,
          status: 'candidate',
        });
      }
      console.log(`[匹配] ${company} | ${position.slice(0, 60)} | ${c.site.slice(0, 80)}`);
    }
    console.log(`-- 第 ${p + 1} 页：本页 ${cards.length} 条，累计匹配 ${matched.length}`);

    const nx = await ex(CTX, 'click', { text: '下一页', timeout: 5000 });
    if (!nx.ok) {
      // 兜底：直接找元素点击（分页按钮可能是 li/span，文本点击匹配不到）
      const alt = await ex(CTX, 'eval', {
        script: '(()=>{const els=Array.from(document.querySelectorAll("button,li,a,span")).filter(b=>(b.innerText||"").trim()==="下一页");if(!els.length)return "NO_BTN";els[0].click();return "clicked"})()',
      });
      if ((alt.data as string) !== 'clicked') { console.log('无「下一页」，停止翻页'); break; }
    }
    await sleep(3000);
    // 等待新一页卡片渲染
    for (let w = 0; w < 20; w++) {
      const pr = await ex(CTX, 'eval', { script: COUNT_CARDS });
      if ((Number(pr.data) || 0) > 0) break;
      await sleep(1000);
    }
  }

  console.log(`\n=== 扫描完成：共浏览 ${scanned} 条，软件相关 ${matched.length} 条${doSave ? '（已入库）' : '（未入库）'} ===`);
  for (const m of matched) console.log(`- ${m.company} | ${m.position.slice(0, 50)} | ${m.site}`);
})();
