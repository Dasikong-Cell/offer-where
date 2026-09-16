/**
 * Offerbiu 校招信息库岗位采集（登录态持久化）
 * 抽取为独立服务，供 /api/offerbiu/collect 与批量连投（/api/apply/batch）复用。
 *
 * 采集对象：校招信息库「推荐岗位」卡片中的「投递入口」——即企业官方投递链接
 * （jobs.bytedance.com / 51job / zhaopin / 企业官网 careers / 微信公众号文章 等），
 * 每条返回 { company, position, city, apply_url(官网), jd }。
 */
import { execAction } from './browser.js';
import * as db from '../db.js';

const LOGIN_DETECT = `(() => {
  const links = Array.from(document.querySelectorAll('a[href]'));
  const loginLink = links.find(a => /\\/login/.test(a.getAttribute('href') || '') && /登录/.test(a.innerText || ''));
  return { needLogin: Boolean(loginLink) };
})()`;

const SCROLL = `(() => {
  for (let k = 0; k < 6; k++) {
    for (let i = 0; i < 10; i++) window.scrollTo(0, document.body.scrollHeight);
    // 用 Promise 让出事件循环，等 SPA 懒加载
    const w = (ms) => new Promise(r => setTimeout(r, ms));
    w(400);
  }
  return 'ok';
})()`;

const CITY = ['北京','上海','广州','深圳','杭州','成都','南京','武汉','西安','重庆','苏州','天津','长沙','青岛','宁波','东莞','无锡','佛山','合肥','厦门','福州','济南','郑州','大连','珠海','常州','沈阳','长春','哈尔滨','石家庄','昆明','贵阳','南宁','南昌','太原','兰州','海口','新乡','汉中','安顺','鞍山','吉林','烟台','潍坊','温州','金华','台州','绍兴','嘉兴','泉州','惠州','中山','江门','湛江','保定','唐山','徐州','扬州','镇江','芜湖','蚌埠','洛阳','襄阳','宜昌','株洲','柳州','绵阳','宜宾','廊坊','威海','临沂'];
const TAGS_RE = /(制造业|央国企|国企|民企|外企|IT|互联网|游戏|电商|金融|政府|事业单位|社会组织|医疗|教育|汽车|通信|能源|消费|地产|物流|传媒|人工智能|大数据|芯片|半导体|航空|航天|船舶|电子|化工|机械|生物|制药|届|秋招|实习|补录|提前批|尽快投递|需要笔试|免笔试|投递入口|加入投递)/;

/** 读取当前页码（用于翻页后校验是否真的翻过去了） */
const PAGE_INDICATOR = `JSON.stringify((function(){var t=document.body?document.body.innerText:'';var m=t.match(/当前第\\s*(\\d+)\\s*\\/\\s*(\\d+)\\s*页/);return {page:m?Number(m[1]):null,total:m?Number(m[2]):null};})())`;

const EXTRACT = `(() => {
  const CITY = ${JSON.stringify(CITY)};
  const TAGS_RE = ${TAGS_RE.toString()};
  const anchors = Array.from(document.querySelectorAll('a')).filter(a => (a.innerText || '').includes('投递入口'));
  const seen = new Set();
  const out = [];
  for (const a of anchors) {
    const url = a.href;
    if (!/^https?:/.test(url) || seen.has(url)) continue;
    let el = a, root = null;
    for (let i = 0; i < 6; i++) { el = el.parentElement; if (!el) break; const t = (el.innerText || '').replace(/\\s+/g, ' ').trim(); if (t.length > 20 && t.includes('更新')) { root = el; break; } }
    if (!root) root = a.parentElement;
    const txt = (root.innerText || '').replace(/\\s+/g, ' ').trim();
    const company = txt.split('更新')[0].replace(/投递入口|加入投递|尽快投递|秋招|实习|补录|提前批|精选|需要笔试|可投岗位|推荐岗位|校招信息库|我的投递/g, '').trim().slice(0, 60) || '未知公司';
    let after = (txt.split('更新')[1] || '').replace(/^\\s*\\d{1,2}月\\d{1,2}日\\s*/, '');
    let position = after;
    const cut = position.search(TAGS_RE);
    if (cut > 0) position = position.slice(0, cut);
    position = position.replace(/等\\s*\\d+\\s*项/, '').replace(/[、，]\\s*$/, '').trim().slice(0, 80) || company;
    const city = CITY.find(c => txt.includes(c)) || null;
    seen.add(url);
    out.push({ company, position, city, apply_url: url, jd: txt.slice(0, 300) });
  }
  return out;
})()`;

/**
 * 从 Offerbiu 校招信息库采集岗位卡片入库为岗位池。
 * 前置：本机浏览器上下文已登录 Offerbiu（登录态持久化）。
 *
 * 2026-09-16 增强：支持**翻页**采集。实测 /companies/ 共 912 页 / 8201 条，
 * 旧实现只取第 1 页（约 50 条）。传 pages>1 会点「下一页」逐页抓取，
 * 用 apply_url 去重后 upsert 入库，直到收满 limit 或翻到末页。
 *
 * @param limit 最多入库多少条（默认 50）
 * @param pages 最多翻多少页（默认 1；设为 0 或负数按 1 处理）
 * @returns 采集数量与岗位行
 */
/**
 * 按关键词采集 offerbiu 岗位（利用列表页的搜索框精准筛选）。
 *
 * 背景：/companies/ 共 8201 条，但**匿名访问在翻到第 3 页后停止**，
 * 顺序翻页收益很低（每页仅 9 条）。而搜索框可把结果集按关键词收窄
 * （实测「软件」1812 条/202 页、「Java」155 条/18 页），
 * 于是「逐关键词 × 前几页」能高效拿到大量**对口**岗位，且不依赖登录。
 *
 * @param keywords 关键词数组（如 ['软件','Java','前端','算法']）
 * @param pagesPerKeyword 每个关键词最多翻几页（默认 3，匿名可用）
 * @param perKeyword 每个关键词最多入库多少条（默认 27）
 */
export async function collectOfferbiuByKeywords(
  keywords: string[],
  opts: { pagesPerKeyword?: number; perKeyword?: number } = {},
): Promise<{ collected: number; jobs: any[]; perKeyword: Record<string, number> }> {
  const pagesPerKeyword = Math.max(1, Number(opts.pagesPerKeyword) || 3);
  const perKeyword = Math.max(1, Number(opts.perKeyword) || 27);
  const kws = (keywords || []).map((k) => String(k).trim()).filter(Boolean);
  if (!kws.length) return { collected: 0, jobs: [], perKeyword: {} };

  await execAction('offerbiu', 'navigate', { url: 'https://offerbiu.com/companies/', headless: false });
  await execAction('offerbiu', 'wait', { timeout: 3000 });

  const collected: any[] = [];
  const seen = new Set<string>();
  const counts: Record<string, number> = {};
  const searchSel = 'input[placeholder*="搜索"]';
  const readPage = async (): Promise<number | null> => {
    const r = await execAction('offerbiu', 'eval', { script: PAGE_INDICATOR });
    try { return (JSON.parse(String(r.data)) as any)?.page ?? null; } catch { return null; }
  };

  for (const kw of kws) {
    // 填入关键词即触发筛选（实测无需回车）
    const f = await execAction('offerbiu', 'fill', { selector: searchSel, value: kw, timeout: 6000 });
    if (!f.ok) { console.warn(`[offerbiu] 搜索「${kw}」失败：${f.error}`); continue; }
    await execAction('offerbiu', 'wait', { timeout: 2600 });
    let pageNum = (await readPage()) ?? 1;
    let got = 0;
    for (let p = 0; p < pagesPerKeyword; p++) {
      await execAction('offerbiu', 'eval', { script: SCROLL });
      await execAction('offerbiu', 'wait', { timeout: 1800 });
      const evalRes = await execAction('offerbiu', 'eval', { script: EXTRACT });
      const raw = (evalRes.data as Array<{ company: string; position: string; city: string | null; apply_url: string; jd: string }>) || [];
      for (const c of raw) {
        if (!c.apply_url || seen.has(c.apply_url)) continue;
        seen.add(c.apply_url);
        const job = db.upsertJob({
          source: 'offerbiu',
          company: c.company,
          position: c.position,
          city: c.city,
          jd: c.jd,
          apply_url: c.apply_url,
        });
        collected.push(job);
        got++;
        counts[kw] = (counts[kw] || 0) + 1;
        if (got >= perKeyword) break;
      }
      if (got >= perKeyword) break;
      if (p < pagesPerKeyword - 1) {
        let moved = false;
        for (let attempt = 0; attempt < 3 && !moved; attempt++) {
          let nx = await execAction('offerbiu', 'realClick', { text: '下一页', timeout: 4000 });
          if (!nx.ok) nx = await execAction('offerbiu', 'click', { text: '下一页', timeout: 5000 });
          if (!nx.ok) break;
          await execAction('offerbiu', 'wait', { timeout: 2600 });
          const cur = await readPage();
          if (cur && cur > pageNum) { pageNum = cur; moved = true; }
        }
        if (!moved) break; // 该关键词翻到头（或匿名 3 页上限）
      }
    }
  }
  return { collected: collected.length, jobs: collected, perKeyword: counts };
}

export async function collectOfferbiu(limit = 50, pages = 1): Promise<{ collected: number; jobs: any[]; needLogin?: boolean }> {
  // 1) 打开首页，判断登录态（存在指向 /login 的登录入口 => 未登录）
  const home = await execAction('offerbiu', 'navigate', { url: 'https://offerbiu.com/home', headless: false });
  if (!home.ok) throw new Error('打开 Offerbiu 失败：' + home.error);
  const loginCheck = await execAction('offerbiu', 'eval', { script: LOGIN_DETECT });
  const needLogin = (loginCheck.data as any)?.needLogin;
  // 重要修正（2026-09-12）：companies 页的岗位列表对匿名用户可见，
  // 页面顶部存在「登录/注册」入口**不代表**内容被锁。
  // 旧版在此直接 throw，导致免登录采集被完全阻断（实测可正常浏览 801 页 / 7203 条）。
  // 现在仅提示并继续采集；若确实取不到列表再考虑登录。
  if (needLogin) {
    console.warn('[offerbiu] 当前未登录；岗位列表仍可公开浏览，继续采集（若列表为空再考虑登录）');
  }

  // 2) 进入校招信息库（推荐岗位）
  await execAction('offerbiu', 'navigate', { url: 'https://offerbiu.com/companies/', headless: false });

  const maxTotal = Math.max(1, Number(limit) || 50);
  const maxPages = Math.max(1, Number(pages) || 1);
  const collected: any[] = [];
  const seen = new Set<string>();
  const readPage = async (): Promise<number | null> => {
    const r = await execAction('offerbiu', 'eval', { script: PAGE_INDICATOR });
    try { return (JSON.parse(String(r.data)) as any)?.page ?? null; } catch { return null; }
  };
  let pageNum = (await readPage()) ?? 1;

  // 3) 逐页：滚动触发懒加载 → 抽取卡片 → 入库（apply_url 去重）→ 点「下一页」（带页码校验 + 重试）
  //    实测：/companies/ 每页仅 9 个「投递入口」，SPA 翻页会重建分页控件导致偶发点击失效。
  for (let p = 0; p < maxPages; p++) {
    await execAction('offerbiu', 'eval', { script: SCROLL });
    await execAction('offerbiu', 'wait', { timeout: 2000 });
    const evalRes = await execAction('offerbiu', 'eval', { script: EXTRACT });
    const raw = (evalRes.data as Array<{ company: string; position: string; city: string | null; apply_url: string; jd: string }>) || [];
    for (const c of raw) {
      if (!c.apply_url || seen.has(c.apply_url)) continue;
      seen.add(c.apply_url);
      const job = db.upsertJob({
        source: 'offerbiu',
        company: c.company,
        position: c.position,
        city: c.city,
        jd: c.jd,
        apply_url: c.apply_url,
      });
      collected.push(job);
      if (collected.length >= maxTotal) break;
    }
    if (collected.length >= maxTotal) break;
    if (p < maxPages - 1) {
      let moved = false;
      for (let attempt = 0; attempt < 4 && !moved; attempt++) {
        // 先真实鼠标点击（SPA 分页控件对合成点击常失效），失败再退回普通 click
        let nx = await execAction('offerbiu', 'realClick', { text: '下一页', timeout: 4000 });
        if (!nx.ok) nx = await execAction('offerbiu', 'click', { text: '下一页', timeout: 5000 });
        if (!nx.ok) { console.warn('[offerbiu] 未找到「下一页」，停止翻页'); break; }
        await execAction('offerbiu', 'wait', { timeout: 2800 });
        const cur = await readPage();
        if (cur && cur > pageNum) { pageNum = cur; moved = true; }
      }
      if (!moved) { console.warn(`[offerbiu] 翻页未生效（停在第 ${pageNum} 页），结束采集`); break; }
    }
  }
  return { collected: collected.length, jobs: collected };
}
