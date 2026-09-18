/**
 * 平台可用性巡检（登录态 + 风控 + 连接）
 * ==========================================================================
 * 为什么需要：这个项目最反复的失败模式是「**静默失败**」——
 *   平台掉登录 / 被风控拦 / Chrome 没起来，投递脚本照样跑完，只是每条都 fail，
 *   用户看到「跑了 50 个，投出 0 个」却不知道为什么。
 *   实测踩过的具体案例：
 *     · 51job 触发滑块 → 整页被替换成「滑动验证页面」，所有选择器命中 null，
 *       早期甚至把这种情况误报成「岗位已下架」；
 *     · 猎聘掉登录 → 判定页选错（营销首页重定向）会得出**反向**结论；
 *     · 本来只是 Chrome 没启动 → 报「未登录」，让人去反复扫码。
 *
 * 本模块把「连接 / 登录态 / 风控」三件事收敛成**一个结论 + 一条处置建议**，
 * 供 API（控制台展示）与 CLI（scripts/check_logins.ts）共用，避免各处重复实现导致判定不一致。
 *
 * 判定规则（顺序即优先级）：
 *   1) CDP 连不上            → offline       （先看 Chrome 起没起，别怀疑登录）
 *   2) 页面命中风控特征      → blocked       （需人工过验证 + 冷却，别继续刷）
 *   3) 命中未登录特征（anon） → not-logged-in（anon **优先**于 logged，防误报）
 *   4) 命中已登录特征        → ok
 *   5) 都不命中              → unknown       （不猜；多半是页面没加载完或改版）
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { execCdpAction } from './cdpDriver.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const CDP_JSON = path.join(__dir, '..', '..', 'data', 'browser', 'cdp.json');

export type HealthVerdict = 'ok' | 'not-logged-in' | 'blocked' | 'offline' | 'unknown';

/** 各平台的判定页与特征词。⚠️ 判定页必须选「受保护页」而不是公开营销页 */
export const PLATFORM_PAGE: Record<string, { home: string; logged: string[]; anon: string[]; note?: string }> = {
  boss: {
    home: 'https://www.zhipin.com/',
    logged: ['消息', '简历', '退出登录', '个人中心'],
    anon: ['扫码登录', '验证码登录', '账号密码登录', '手机号登录', '登录/注册', '立即登录'],
  },
  job51: {
    home: 'https://www.51job.com/',
    logged: ['我的求职', '我的简历', '在线简历', '个人中心', '退出登录', '简历快推'],
    anon: ['请登录', '账号登录', '登录并投递', '扫码登录', '短信登录', '登录/注册'],
  },
  liepin: {
    // ⚠️ 必须用求职者中心：www.liepin.com 对已登录用户会**重定向**到 c.liepin.com，
    // 在重定向前取样会读到营销页的登录框 → 把已登录误判为未登录（实测踩到）
    home: 'https://c.liepin.com/',
    logged: ['你好，', '编辑求职期望', '我的简历', '退出登录', '个人中心'],
    anon: ['登录/注册', '密码登录', '获取验证码', '登录猎聘', '立即登录'],
  },
  zhilian: {
    home: 'https://www.zhaopin.com/',
    logged: ['退出登录', '我的智联', '个人中心', '我的简历'],
    anon: ['登录/注册', '密码登录', '立即登录', '微信登录', '扫码登录', '获取验证码'],
  },
};

/** 风控/验证页特征（整页会被替换，所有业务选择器都会命中 null） */
export const BLOCK_RE = /(访问验证|滑动验证|安全验证|人机验证|请按住滑块|拖动到最右边|验证码页面)/i;

/** 建议动作：把结论翻译成「用户下一步该做什么」 */
const ACTION: Record<HealthVerdict, string> = {
  offline: 'Chrome 调试窗口没起来 → 跑 scripts/ensure_chrome.sh（或 start_all.bat）',
  blocked: '被风控拦住 → 在该平台窗口人工过一次滑块/短信，冷却 10 分钟后再跑；期间勿并发采集/投递',
  'not-logged-in': '未登录 → 用 scripts/focus_login.ts <平台> 把登录页置顶，人工登录',
  unknown: '页面内容不符合预期 → 手动打开该平台窗口确认；若页面正常请更新 PLATFORM_PAGE 特征词',
  ok: '正常',
};

export interface PlatformHealth {
  platform: string;
  endpoint: string;
  connected: boolean;
  loggedIn: boolean | null;
  blocked: boolean;
  verdict: HealthVerdict;
  /** 命中的特征词，便于排查 */
  matched: { logged: string[]; anon: string[] };
  /** 页面标题（风控页一眼可辨） */
  title?: string;
  detail: string;
  action: string;
}

export function readEndpoint(platform: string): string {
  try {
    const cfg = JSON.parse(fs.readFileSync(CDP_JSON, 'utf-8'));
    const ep = cfg?.[platform];
    if (typeof ep === 'string' && ep.trim()) return ep.trim();
  } catch { /* 用默认 */ }
  const DEF: Record<string, number> = { boss: 9223, bosschat: 9223, liepin: 9224, job51: 9225, zhilian: 9226, official: 9227, offerbiu: 9227 };
  return `http://127.0.0.1:${DEF[platform] || 9223}`;
}

function cdpAlive(endpoint: string, timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(`${endpoint}/json/version`, { method: 'GET', timeout: timeoutMs }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(res.statusCode === 200 && d.length > 0));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 探测单个平台的可用性 */
export async function probeOne(platform: string, deep = true): Promise<PlatformHealth> {
  const endpoint = readEndpoint(platform);
  const base: PlatformHealth = {
    platform, endpoint, connected: false, loggedIn: null, blocked: false,
    verdict: 'offline', matched: { logged: [], anon: [] }, detail: '', action: ACTION.offline,
  };

  if (!(await cdpAlive(endpoint))) {
    return { ...base, detail: `CDP 端点 ${endpoint} 无响应` };
  }
  base.connected = true;
  if (!deep) return { ...base, verdict: 'unknown', detail: '仅检测连接（未做页面判定）', action: ACTION.unknown };

  const cfg = PLATFORM_PAGE[platform];
  if (!cfg) return { ...base, verdict: 'unknown', detail: '该平台未配置页面判定规则', action: ACTION.unknown };

  try {
    await execCdpAction(platform, 'navigate', { url: cfg.home, timeout: 30000 }, endpoint);
  } catch (e: any) {
    return { ...base, verdict: 'unknown', detail: `导航失败：${e?.message || e}`, action: ACTION.unknown };
  }

  // 最多 3 次取样：SPA 首页常在导航后再跳一次，过早取样会读出 unknown 抖动
  let title = '';
  let logged: string[] = [];
  let anon: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    await sleep(attempt === 1 ? 4500 : 3000);
    const r: any = await execCdpAction(
      platform, 'eval',
      { script: 'JSON.stringify({t:document.title||"",b:(document.body?document.body.innerText:"")||""}).slice(0,6000)' },
      endpoint,
    ).catch(() => undefined);
    let t = '', b = '';
    try { const o = JSON.parse(String(r?.data || '{}')); t = o.t || ''; b = o.b || ''; } catch { /* 忽略 */ }
    title = t;
    // 风控页优先判：整页被替换时业务特征词一个都不会命中
    if (BLOCK_RE.test(t) || (b.length < 600 && BLOCK_RE.test(b))) {
      const h: PlatformHealth = {
        ...base, blocked: true, verdict: 'blocked', title: t, matched: { logged: [], anon: [] },
        detail: `命中风控验证页（标题「${t || '无'}」，正文 ${b.length} 字）`, action: ACTION.blocked,
      };
      return h;
    }
    logged = cfg.logged.filter((k) => b.includes(k));
    anon = cfg.anon.filter((k) => b.includes(k));
    if (logged.length || anon.length) {
      const verdict: HealthVerdict = anon.length ? 'not-logged-in' : 'ok';
      return {
        ...base, verdict, loggedIn: verdict === 'ok', title: t, matched: { logged, anon },
        detail: verdict === 'ok'
          ? `页面命中已登录特征：${logged.join('、')}`
          : `页面命中未登录特征：${anon.join('、')}`,
        action: ACTION[verdict],
      };
    }
  }
  return {
    ...base, verdict: 'unknown', title, matched: { logged, anon },
    detail: `3 次取样均未命中任何特征（${title ? `标题「${title}」` : '无标题'}）`, action: ACTION.unknown,
  };
}

/**
 * 批量巡检。
 * @param platforms 平台列表，缺省 = 主要投递平台
 * @param deep      true 时导航页面做权威判定（慢，约 8s/平台）；false 只测 CDP 连接
 */
export async function probePlatformHealth(platforms?: string[], deep = true): Promise<PlatformHealth[]> {
  const list = platforms?.length ? platforms : ['boss', 'job51', 'liepin', 'zhilian'];
  return Promise.all(list.map((p) => probeOne(p, deep)));
}

/**
 * 汇总成一句人话。
 * ⚠️ 「连接正常」≠「可用」：必须分开说，否则 deep=0 时会得出「0/4 可用」这种误导性结论
 * （实测踩到：只测连接时所有平台都是 unknown，被当成「全都不可用」）。
 */
export function summarizeHealth(list: PlatformHealth[], deep = true): string {
  const connected = list.filter((h) => h.connected).length;
  const head = `${connected}/${list.length} 连接正常`;
  if (!deep) return `${head}（未做页面判定；用 ?deep=1 可查登录态与风控）`;
  const ok = list.filter((h) => h.verdict === 'ok').length;
  const bad = list.filter((h) => h.verdict !== 'ok');
  if (!bad.length) return `${head}，登录态全部正常 ✅`;
  return `${head}，登录态 ${ok}/${list.length} 正常；异常：` + bad.map((h) => `${h.platform}(${h.verdict})`).join('、');
}
