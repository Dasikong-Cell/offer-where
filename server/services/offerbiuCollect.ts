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
 * @returns 采集数量与岗位行
 */
export async function collectOfferbiu(limit = 50): Promise<{ collected: number; jobs: any[]; needLogin?: boolean }> {
  // 1) 打开首页，判断登录态（存在指向 /login 的登录入口 => 未登录）
  const home = await execAction('offerbiu', 'navigate', { url: 'https://offerbiu.com/home', headless: false });
  if (!home.ok) throw new Error('打开 Offerbiu 失败：' + home.error);
  const loginCheck = await execAction('offerbiu', 'eval', { script: LOGIN_DETECT });
  const needLogin = (loginCheck.data as any)?.needLogin;
  if (needLogin) {
    throw new Error('Offerbiu 尚未登录：请在自动打开的浏览器窗口中登录（或访问 https://offerbiu.com/login 完成登录），登录态会持久化，关闭后再次点击采集即可。');
  }

  // 2) 进入校招信息库（推荐岗位）
  await execAction('offerbiu', 'navigate', { url: 'https://offerbiu.com/companies/', headless: false });
  // 3) 循环滚动触发懒加载
  await execAction('offerbiu', 'eval', { script: SCROLL });
  await execAction('offerbiu', 'wait', { timeout: 2000 });
  // 4) 抽取真实岗位卡片（公司 / 岗位 / 城市 / 官网投递入口）
  const evalRes = await execAction('offerbiu', 'eval', { script: EXTRACT });
  const raw = (evalRes.data as Array<{ company: string; position: string; city: string | null; apply_url: string; jd: string }>) || [];

  const collected: any[] = [];
  for (const c of raw.slice(0, Number(limit) || 50)) {
    const job = db.upsertJob({
      source: 'offerbiu',
      company: c.company,
      position: c.position,
      city: c.city,
      jd: c.jd,
      apply_url: c.apply_url,
    });
    collected.push(job);
  }
  return { collected: collected.length, jobs: collected };
}
