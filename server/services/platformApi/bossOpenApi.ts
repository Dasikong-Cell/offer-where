/**
 * 平台 API 通道 —— BOSS 直聘 / 猎聘（方案落地脚手架）
 * ==========================================================================
 * 调研结论（2026-09-18，详见 docs/BOSS_OPENAPI_PLAN.md）：
 *
 *   ① 「开放平台」确实存在，但**都是 B 端（企业/服务商）侧**：
 *      · BOSS：open.zhipin.com / hi-open.zhipin.com/open-apis（企业协作 BossHi：员工 IM、
 *        通讯录、消息推送），接入需企业实名 + 创建应用 + **IP 白名单**，鉴权为
 *        `tenant_access_token`，请求头 `Authorization: Bearer <token>`，响应 `code/msg/data/traceId`。
 *      · 猎聘：developer.liepin.com / api.liepin.com（职位基础信息、薪资元数据等）。
 *      → 这类接口的调用方是「招聘方/服务商」，**没有面向求职者的一键投递能力**，
 *        求职者个人账号拿不到凭证，也无法用它投自己的简历。
 *
 *   ② 因此「彻底消验证码」的正解不是找官方 API，而是把「平台登录会话」搬出用户本机：
 *      职得鸭之所以验证码无感，是因为它的平台操作发生在**云端**（服务端机房 IP + 服务端会话），
 *      用户本地只上传简历。详见 PLAN 文档第 3 节的三条可选架构。
 *
 *   ③ 本模块提供两条**真实可跑**的骨架，在拿到对应前提时可立即接通：
 *      A) openPlatformClient —— 官方 B 端开放平台客户端（token 缓存 + Bearer + code!=0 判错）。
 *         需 env `BOSS_OPEN_APP_ID` / `BOSS_OPEN_APP_SECRET`。
 *         ⚠️ 它**不能投递求职者简历**，此处只让「凭证→调用→错误处理」这段管道就绪，
 *            以便将来做企业侧/服务商侧业务，**禁止**挪用来做代投。
 *      B) webApiClient —— 复用本地已登录 Chrome 的会话 Cookie（经 CDP 读取，含 httpOnly），
 *         直连平台 JSON 接口做**只读检索**（岗位搜索/详情）。
 *         相比整页自动化：少渲染、快、指纹面小。但仍是逆向私有接口，
 *         需 env `PLATFORM_WEBAPI_ENABLED=1` 显式开启，且必须低频、单人自用。
 *
 *   ④ 关键边界（务必遵守）：**「投递」这一步仍走现有 CDP 整页链路**。
 *      原因：平台投递接口带服务端签名参数（BOSS 的 `__zp_stoken__`/tk、猎聘的 `X-XSRF-TOKEN`），
 *      纯 HTTP 复现签名 = 持续对抗平台的加密升级，维护成本极高且极易封号；
 *      而整页自动化是「真浏览器里点真按钮」，签名由页面自己算，稳定性反而更高。
 *      所以本模块的定位是：**检索提速 + 登录态诊断**，不是替代投递引擎。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execCdpAction } from '../cdpDriver.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const CDP_JSON = path.join(__dir, '..', '..', '..', 'data', 'browser', 'cdp.json');

/** 本模块支持的平台（与 data/browser/cdp.json 的键一致） */
export type ApiPlatform = 'boss' | 'liepin';

/** 每个平台在 CDP 里使用的上下文键（复用已登录标签） */
const CTX: Record<ApiPlatform, string> = { boss: 'boss', liepin: 'liepin' };
/** 各平台「会话 Cookie 归属域」，用于过滤出真正有用的那几条 */
const COOKIE_DOMAIN: Record<ApiPlatform, string> = { boss: 'zhipin.com', liepin: 'liepin.com' };

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

/** 读取 cdp.json 里某平台的 CDP 端点 */
export function readCdpEndpoint(platform: ApiPlatform): string {
  try {
    const cfg = JSON.parse(fs.readFileSync(CDP_JSON, 'utf-8'));
    const ep = cfg?.[platform];
    if (typeof ep === 'string' && ep.trim()) return ep.trim();
  } catch { /* 忽略，用默认端口 */ }
  return platform === 'boss' ? 'http://127.0.0.1:9223' : 'http://127.0.0.1:9224';
}

export interface CookieItem {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  expires?: number;
}

/**
 * 从已登录的调试 Chrome 里读出该平台的 Cookie（含 httpOnly）。
 * 注意：CDP 读的是**调试 profile** 的会话，与用户日常 Chrome 完全隔离；
 * 若返回空，多半是「登在用户自己的 Chrome 里了」，需引导到正确窗口登录。
 */
export async function getSessionCookies(platform: ApiPlatform): Promise<CookieItem[]> {
  const ep = readCdpEndpoint(platform);
  const r: any = await execCdpAction(CTX[platform], 'cookies', { filterDomain: COOKIE_DOMAIN[platform] }, ep);
  if (!r?.ok) throw new Error(`读取 ${platform} Cookie 失败：${r?.error || '未知错误'}`);
  return (r.data as CookieItem[]) || [];
}

/** 把 Cookie 数组拼成 Cookie 请求头 */
export function toCookieHeader(cookies: CookieItem[]): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

/**
 * ⚠️ Cookie 名判定登录态是**弱信号**，实测会误报（2026-09-19 复盘）：
 *   · 猎聘未登录访客同样带 `XSRF-TOKEN` / `__gc_id` / `c_flag` / `__uuid` / `need_bind_tel`；
 *     真正的会话 Cookie 名（`fe_se*` / `__sessionId` / `acw_tc`）在未登录时也可能存在。
 *   · BOSS 的 `__zp_stoken__` 是反爬 token，任何访客都有；只有 `wt2` 更接近「已登录」。
 *   → 所以这里只作 **hint**（快、不用导航页面），权威判定请用页面级 `verifyLoginViaPage()`
 *     或 CLI `scripts/check_logins.ts`（anon 优先规则）。
 */
const AUTH_COOKIE: Record<ApiPlatform, RegExp> = {
  boss: /^(wt2|__zp_stoken__|bst)$/i,
  liepin: /^(fe_seal|fe_se|liepin_token|__sessionId|__session_seq)$/i,
};

export interface LoginHint {
  /** 弱信号结论：存在疑似会话 Cookie。仅供参考，不代表一定已登录 */
  loggedIn: boolean;
  matched: string[];
  /** 判定依据的可靠性说明 */
  confidence: 'cookie-hint';
  note: string;
}

export async function isLoggedIn(platform: ApiPlatform): Promise<LoginHint> {
  const cookies = await getSessionCookies(platform);
  const matched = cookies.filter((c) => AUTH_COOKIE[platform].test(c.name)).map((c) => c.name);
  return {
    loggedIn: matched.length > 0,
    matched,
    confidence: 'cookie-hint',
    note: 'Cookie 名仅为弱信号（未登录访客也可能带同名 Cookie）；权威判定请用 verifyLoginViaPage 或 scripts/check_logins.ts',
  };
}

/** 各平台登录/未登录的页面特征词（**anon 优先**：命中 anon 即判未登录） */
const LOGIN_PAGE_MARKERS: Record<ApiPlatform, { home: string; logged: string[]; anon: string[] }> = {
  boss: {
    home: 'https://www.zhipin.com/',
    logged: ['消息', '简历', '退出登录', '个人中心'],
    anon: ['扫码登录', '验证码登录', '账号密码登录', '手机号登录', '登录/注册', '立即登录'],
  },
  liepin: {
    // ⚠️ 用求职者中心 c.liepin.com：www.liepin.com 对已登录用户会重定向过去，
    // 在重定向前取样会读到营销页登录框 → 把已登录误判为未登录（实测踩到）。
    home: 'https://c.liepin.com/',
    logged: ['你好，', '编辑求职期望', '我的简历', '退出登录', '个人中心'],
    anon: ['登录/注册', '密码登录', '获取验证码', '登录猎聘', '立即登录'],
  },
};

/**
 * 页面级权威登录判定：导航到首页 → 读正文 → anon 优先。
 * 与 `scripts/check_logins.ts` 同规则，供 API 与巡检复用。
 */
export async function verifyLoginViaPage(platform: ApiPlatform): Promise<{
  verdict: 'logged-in' | 'not-logged-in' | 'unknown';
  logged: string[];
  anon: string[];
  attempts: number;
}> {
  const c = LOGIN_PAGE_MARKERS[platform];
  const ep = readCdpEndpoint(platform);
  const nav: any = await execCdpAction(CTX[platform], 'navigate', { url: c.home, timeout: 30000 }, ep);
  if (!nav?.ok) return { verdict: 'unknown', logged: [], anon: [], attempts: 0 };

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // 页面未稳定时标记会读空 → 判 unknown 抖动（实测猎聘有一次返回 unknown）。
  // 策略：等 readyState 就绪 + 最多 3 次取样，取得非 unknown 结论即返回。
  const MAX = 3;
  let last: { logged: string[]; anon: string[]; verdict: 'logged-in' | 'not-logged-in' | 'unknown' } =
    { logged: [], anon: [], verdict: 'unknown' };
  for (let attempt = 1; attempt <= MAX; attempt++) {
    await sleep(attempt === 1 ? 4500 : 3000);
    try { await execCdpAction(CTX[platform], 'eval', { script: 'document.readyState' }, ep); } catch { /* ignore */ }
    const r: any = await execCdpAction(
      CTX[platform], 'eval',
      { script: '(document.body.innerText||String()).replace(/\\s+/g," ").slice(0,1500)' }, ep,
    );
    const t = String(r?.data || '');
    const logged = c.logged.filter((k) => t.includes(k));
    const anon = c.anon.filter((k) => t.includes(k));
    last = { logged, anon, verdict: anon.length ? 'not-logged-in' : logged.length ? 'logged-in' : 'unknown' };
    if (last.verdict !== 'unknown') return { ...last, attempts: attempt };
  }
  return { ...last, attempts: MAX };
}

// ---------------------------------------------------------------------------
// A) 官方 B 端开放平台客户端（BOSS / BossHi）
// ---------------------------------------------------------------------------

/**
 * ⚠️ 能力边界声明：官方开放平台是**招聘方/服务商**接口，**不能投递求职者简历**。
 * 保留此客户端仅为「拿到企业凭证时立刻可用」，任何代投用途都属越界。
 */
export const OPEN_PLATFORM_SCOPE = {
  host: 'https://hi-open.zhipin.com',
  tokenPath: '/open-apis/auth/tenant_access_token/internal',
  /** 官方文档明确要求的调用前提 */
  prerequisites: ['创建应用', '申请权限', '获取访问凭证', '设置 IP 白名单'],
  /** 官方可用能力（全是企业侧） */
  capabilities: ['企业内员工 IM 消息', '通讯录/用户信息', '部门权限'],
  /** 明确不支持 */
  unsupported: ['求职者投递简历', '求职者账号代操作', '职位搜索（对求职者开放）'],
} as const;

interface TokenCache { token: string; expireAt: number }
const tokenCache = new Map<string, TokenCache>();

/**
 * 获取 tenant_access_token（B 端）。带内存缓存，避免频繁刷新触发限流。
 * 官方响应：{ code:0, msg:'success', traceId, data:{ tenant_access_token, expire } }（expire 单位秒）
 */
export async function getTenantAccessToken(appId?: string, appSecret?: string): Promise<string> {
  const id = appId || process.env.BOSS_OPEN_APP_ID || '';
  const secret = appSecret || process.env.BOSS_OPEN_APP_SECRET || '';
  if (!id || !secret) {
    throw new Error('未配置 BOSS_OPEN_APP_ID / BOSS_OPEN_APP_SECRET，无法获取开放平台凭证（求职者侧无需此凭证）');
  }
  const cached = tokenCache.get(id);
  if (cached && cached.expireAt > Date.now() + 30_000) return cached.token;

  const res = await fetch(`${OPEN_PLATFORM_SCOPE.host}${OPEN_PLATFORM_SCOPE.tokenPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: id, app_secret: secret }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (json?.code !== 0) throw new Error(`获取凭证失败：code=${json?.code} msg=${json?.msg} traceId=${json?.traceId}`);
  const token = json?.data?.tenant_access_token || json?.data?.access_token;
  if (!token) throw new Error(`凭证响应缺少 token 字段：${JSON.stringify(json).slice(0, 200)}`);
  const expireSec = Number(json?.data?.expire ?? json?.data?.expire_in ?? 7200);
  tokenCache.set(id, { token, expireAt: Date.now() + Math.max(60, expireSec) * 1000 });
  return token;
}

/**
 * 调用 BossHi 开放平台的通用请求（Bearer + code!=0 判错 + traceId 透出便于报障）。
 * 官方约定：绝不用 msg 判断成败，一律看 code。
 */
export async function callOpenPlatform<T = any>(
  apiPath: string,
  opts: { method?: 'GET' | 'POST'; body?: unknown; query?: Record<string, string | number> } = {},
): Promise<T> {
  const token = await getTenantAccessToken();
  const qs = opts.query
    ? '?' + new URLSearchParams(Object.entries(opts.query).map(([k, v]) => [k, String(v)])).toString()
    : '';
  const res = await fetch(`${OPEN_PLATFORM_SCOPE.host}${apiPath}${qs}`, {
    method: opts.method || 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json: any = await res.json().catch(() => ({}));
  if (json?.code !== 0) {
    throw new Error(`开放平台调用失败：code=${json?.code} msg=${json?.msg} traceId=${json?.traceId}`);
  }
  return json as T;
}

// ---------------------------------------------------------------------------
// B) 逆向 Web API 客户端（只读检索；投递仍走 CDP）
// ---------------------------------------------------------------------------

/** 是否允许走逆向 Web API（默认关闭，需显式 env 开启，避免误用/滥用） */
export function webApiEnabled(): boolean {
  return String(process.env.PLATFORM_WEBAPI_ENABLED || '') === '1';
}

function assertWebApiEnabled(): void {
  if (!webApiEnabled()) {
    throw new Error('Web API 通道未启用：请设置环境变量 PLATFORM_WEBAPI_ENABLED=1（仅限低频率、单人自用）');
  }
}

export interface WebJobItem {
  jobId: string;
  title: string;
  company: string;
  city?: string;
  salary?: string;
  url?: string;
}

/** 带浏览器 UA + Referer 的通用 JSON 请求（复用调试 Chrome 的登录 Cookie） */
async function webJson<T = any>(
  platform: ApiPlatform,
  url: string,
  init: { method?: string; body?: unknown; referer: string },
): Promise<T> {
  assertWebApiEnabled();
  const cookies = await getSessionCookies(platform);
  if (!cookies.length) throw new Error(`${platform} 未读到会话 Cookie，请先在调试浏览器登录`);
  const headers: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Referer: init.referer,
    Cookie: toCookieHeader(cookies),
  };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json;charset=UTF-8';
  const res = await fetch(url, { method: init.method || 'GET', headers, body: init.body ? JSON.stringify(init.body) : undefined });
  const text = await res.text();
  try { return JSON.parse(text) as T; } catch { throw new Error(`响应非 JSON（HTTP ${res.status}）：${text.slice(0, 160)}`); }
}

/**
 * BOSS 岗位检索（逆向只读）。
 * ⚠️ 端点与字段随平台前端版本变动，**上线前必须实测校准**；本函数只保证请求骨架正确。
 */
export async function bossSearchJobs(keyword: string, city = '101280600', page = 1): Promise<WebJobItem[]> {
  const url = `https://www.zhipin.com/wapi/zpgeek/search/joblist.json?scene=1&query=${encodeURIComponent(keyword)}`
    + `&city=${encodeURIComponent(city)}&page=${page}&pageSize=30`;
  const json: any = await webJson('boss', url, { referer: 'https://www.zhipin.com/web/geek/job?query=' + encodeURIComponent(keyword) });
  if (json?.code !== 0 && json?.code !== undefined) throw new Error(`BOSS 检索失败：code=${json?.code} message=${json?.message}`);
  const list: any[] = json?.zpData?.jobList || [];
  return list.map((j) => ({
    jobId: String(j.encryptJobId || j.jobId || ''),
    title: j.jobName || '',
    company: j.brandName || j.companyName || '',
    city: j.cityName || j.areaDistrict || '',
    salary: j.salaryDesc || '',
    url: j.encryptJobId ? `https://www.zhipin.com/job_detail/${j.encryptJobId}.html` : undefined,
  }));
}

/**
 * 猎聘岗位检索（逆向只读）。
 * 真实端点为 `api-c.liepin.com/api/com.liepin.searchfront4c.pc-search-job`，
 * 需 `X-XSRF-TOKEN` 等头；此处仅搭骨架，字段需实测校准。
 */
export async function liepinSearchJobs(keyword: string, cityCode = '410', page = 1): Promise<WebJobItem[]> {
  const url = 'https://api-c.liepin.com/api/com.liepin.searchfront4c.pc-search-job';
  const json: any = await webJson('liepin', url, {
    method: 'POST',
    referer: 'https://www.liepin.com/zhaopin/?key=' + encodeURIComponent(keyword),
    body: { data: { mainSearchPcConditionForm: { city: cityCode, key: keyword, currentPage: page, pageSize: 30 } } },
  });
  const list: any[] = json?.data?.data?.jobCardList || json?.data?.jobCardList || [];
  return list.map((it) => {
    const j = it.job || it;
    return {
      jobId: String(j.jobId || ''),
      title: j.title || '',
      company: it.compName || j.compName || '',
      city: j.dq || '',
      salary: j.salary || '',
      url: j.jobId ? `https://www.liepin.com/job/${j.jobId}.shtml` : undefined,
    };
  });
}

/**
 * 「投递」为什么**不**走 HTTP —— 显式拒绝，防止误用。
 * BOSS/猎聘的投递请求带服务端下发的加密签名参数（BOSS `__zp_stoken__`/tk、猎聘 `X-XSRF-TOKEN`），
 * 纯 HTTP 复现需持续对抗平台签名升级，封号与维护成本都不可接受。
 * 正确做法：继续用 CDP 整页链路（services/apply/*），让页面自己算签名。
 */
export function applyViaWebApiNotSupported(platform: ApiPlatform): never {
  throw new Error(
    `[${platform}] 投递不走 HTTP 通道：平台投递接口带服务端加密签名，纯 HTTP 无法稳定复现。` +
    `请使用 CDP 整页投递链路（services/apply/*），检索可走 bossSearchJobs/liepinSearchJobs 提速。`,
  );
}

// ---------------------------------------------------------------------------
// 自检：输出当前环境下两条通道的可用性
// ---------------------------------------------------------------------------

/**
 * 平台通道自检。
 * @param deep true 时额外做**页面级**权威登录判定（会导航首页，较慢但准确）
 */
export async function probePlatformApi(deep = false): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {
    webApiEnabled: webApiEnabled(),
    openPlatformConfigured: !!(process.env.BOSS_OPEN_APP_ID && process.env.BOSS_OPEN_APP_SECRET),
    deep,
    targets: {},
  };
  for (const p of ['boss', 'liepin'] as ApiPlatform[]) {
    try {
      const r = await isLoggedIn(p);
      const entry: Record<string, unknown> = {
        endpoint: readCdpEndpoint(p),
        // 弱信号（Cookie 名）
        cookieHint: r.loggedIn,
        authCookies: r.matched,
      };
      if (deep) {
        const v = await verifyLoginViaPage(p);
        entry.pageVerdict = v.verdict;   // 权威结论
        entry.pageLogged = v.logged;
        entry.pageAnon = v.anon;
        entry.pageAttempts = v.attempts;
      }
      (out.targets as any)[p] = entry;
    } catch (e: any) {
      (out.targets as any)[p] = { endpoint: readCdpEndpoint(p), error: e?.message || String(e) };
    }
  }
  return out;
}
