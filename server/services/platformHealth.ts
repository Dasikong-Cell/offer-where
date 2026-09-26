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
import http from 'node:http';
import { execCdpAction } from './cdpDriver.js';
import { DELIVERY_PLATFORMS } from './connection.js';
import { resolveCdpEndpoint, defaultCdpEndpoint } from './platformPorts.js';

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

  // ── 2026-09-21 新增登记的平台 ──────────────────────────────────────────────
  // ⚠️ anon 词来自**调试窗口实机访问首页采集**（匿名态，2026-09-21）；
  //    logged 词为通用保守值（未实机校准）—— 各自登录一次后可用控制台 🩺 复核并按需补充。
  //    保守取值的好处：匹配不上只会判 unknown（不误报"已登录"），不会造成误放行。
  nowcoder: {
    // 牛客网（校招/笔试面试社区 + 岗位）。补登记：此前在 SUPPORTED_PLATFORMS 里却缺窗口/巡检配置
    home: 'https://www.nowcoder.com/',
    logged: ['退出登录', '个人中心', '我的简历'],
    anon: ['登录', '注册', '登录/注册'],
  },
  offerbiu: {
    // 官网/微信推文聚合通道（邮箱直投为主）。与 official 共用 9227 窗口，故无独立端口
    home: 'https://www.offerbiu.com/',
    logged: ['退出登录', '个人中心'],
    anon: ['登录', '注册'],
    note: '与 official 共用 9227 窗口；主链路是邮箱直投（不经页面登录）',
  },
  easyzhipin: {
    // 落地页为主（「我要求职」引导下载 APP），求职主流程在 APP 内，Web 端可用性待评估
    home: 'https://www.easyzhipin.com/',
    logged: ['退出登录', '个人中心'],
    anon: ['企业登录', '扫码登录', '登录', '下载易直聘APP'],
    note: '易直聘以 APP 为主，Web 端目前是落地页；投递链路需先评估 Web 可操作性',
  },
  job58: {
    // ⚠️ 不是 jobs.58.com（那是「58集团社会招聘」自招官网）；求职频道是城市子域 {城市}.58.com/job/
    home: 'https://km.58.com/job/',
    logged: ['退出登录', '个人中心', '我的简历'],
    anon: ['用户登录', '短信登录', '账号登录', '免费注册', 'App扫码登录', '忘记密码'],
    note: '未登录会重定向到 passport.58.com/login；城市前缀（km=昆明）需与目标城市一致',
  },
  chinahr: {
    // 中华英才网已并入「新华英才」，域名仍为 chinahr.com
    home: 'https://www.chinahr.com/',
    logged: ['退出登录', '个人中心', '我的简历'],
    anon: ['登录|注册', '登录/注册', '企业入口', '登录'],
  },
  dianzhang: {
    // BOSS 同集团（店长/服务业垂直）
    home: 'https://www.dianzhangzhipin.com/',
    logged: ['退出登录', '个人中心', '我的简历'],
    anon: ['注册', '登录'],
  },
  yupao: {
    // 鱼泡直聘（蓝领/建筑垂直），首页会按 IP 城市自动切换
    home: 'https://www.yupao.com/',
    // ⚠️ 实测（登录后）：导航出现「消息 / 简历 / 先生」；登录前是「登录丨注册」+「登录，查看更多职位」
    logged: ['消息', '简历', '退出登录', '个人中心'],
    anon: ['登录丨注册', '登录，查看更多职位', '我要找工作'],
  },
  maimai: {
    // 脉脉高聘 = 脉脉旗下的招聘模块
    home: 'https://maimai.cn/gaopin',
    logged: ['退出登录', '个人中心', '招聘管理'],
    anon: ['登录/注册', '登录', '注册'],
  },
  ganji: {
    // 58 同集团。⚠️ 首次访问常触发风控验证码（整页替换），故 anon 词含验证码特征
    home: 'https://www.ganji.com/zhaopin/',
    logged: ['退出登录', '个人中心'],
    anon: ['微信扫码登录', '赶集招聘扫码登录', '账号登录', '验证码校验', '请输入验证码'],
    note: '风控较严：首次访问可能直接落到 antibot 验证码页，需人工过一次',
  },
  iguopin: {
    // 国聘（央企国企招聘平台）
    home: 'https://www.iguopin.com/',
    // ⚠️ 实测教训：anon 里**不能放「我要招人」** —— 它登录后也在导航里，
    //    会把已登录误判成未登录（实测踩到：已登录显示手机号仍报 not-logged-in）。
    logged: ['退出登录', '个人中心', '我的简历', '消息'],
    anon: ['登录/注册', '注册'],
  },
  yingjiesheng: {
    // 应届生求职网（校招垂直）
    home: 'https://www.yingjiesheng.com/',
    logged: ['退出登录', '个人中心', '我的简历'],
    anon: ['登录/注册', '登录', '注册', '通知'],
  },
};

/** 风控/验证页特征（整页会被替换，所有业务选择器都会命中 null） */
export const BLOCK_RE = /(访问验证|滑动验证|安全验证|人机验证|请按住滑块|拖动到最右边|验证码页面)/i;

/** 建议动作：把结论翻译成「用户下一步该做什么」 */
const ACTION: Record<HealthVerdict, string> = {
  offline: 'Chrome 调试窗口没起来 → 跑根目录的 ensure_chrome.sh（或 start_all.bat）',
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

/**
 * 取平台端点。统一走 `platformPorts.ts`（`cdp.json` 覆盖值 > 内置默认端口）。
 *
 * 历史坑：本函数此前自带一份**只含 7 个平台**的兜底表，其余平台一律 `|| 9223` ——
 * 即国聘/鱼泡/中华英才等 8 个新登记平台会被**错配到 BOSS 的端口**，
 * 巡检结果因此张冠李戴。端口表已收敛为一份。
 */
export function readEndpoint(platform: string): string {
  const ep = resolveCdpEndpoint(platform);
  if (ep) return ep;
  // 未登记平台：退回 boss 端口，保持「可探测」而不是抛错
  return defaultCdpEndpoint('boss') as string;
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
 * @param platforms 平台列表，缺省 = **全部已登记平台**（DELIVERY_PLATFORMS，15 个）
 * @param deep      true 时导航页面做权威判定（慢，约 8s/平台）；false 只测 CDP 连接
 *
 * ⚠️ 缺省值此前是硬编码的 4 个平台 —— 新增平台后巡检看不到它们（"登记了却巡检不到"）。
 *    现与 DELIVERY_PLATFORMS 同源。并发执行（Promise.all），未启动的平台秒级失败，
 *    因此把 4 个扩到 15 个不会线性拖慢（实测总耗时仍主要取决于已启动窗口数）。
 */
export async function probePlatformHealth(platforms?: string[], deep = true): Promise<PlatformHealth[]> {
  const list = platforms?.length ? platforms : DELIVERY_PLATFORMS;
  return Promise.all(list.map((p) => probeOne(p, deep)));
}

// ── 全量 deep 巡检的 TTL 缓存（控制台专用） ────────────────────────────────────
/**
 * 为什么要缓存：控制台**每次打开/刷新**都会调 `/api/platforms/health`（deep 默认 1，
 * 见 console.html 的 loadDashboard），而 deep=1 会逐个**导航 15 个平台的真实页面**
 * 再取样判定登录态——为了结论准确，这一步不能省，实测约 12.7s。
 * 于是每次刷新首页都要先空等十几秒（那段时间平台卡片还画不出来）。
 *
 * 缓存规则（刻意收窄，避免"缓存把真实状态藏起来"）：
 *   · **只缓存「全量 + deep」**这一种调用（即控制台仪表盘那次），键固定；
 *   · 带 `platforms=` 的**定向调用永不缓存** —— 那是用户主动复核（典型场景：
 *     刚在窗口里登录完，点自动回复页的「检测」或某张卡片的 🩺 想立刻看到 ok），
 *     必须拿到实时结果；同理 `deep=0`（只测连接，本来就快）也不缓存；
 *   · `forceRefresh`（API 的 `?refresh=1`）跳过缓存并覆盖。
 * 代价：登录态结论最长可能滞后 `FULL_SET_TTL_MS`；想立刻刷新就带 `?refresh=1`。
 */
const FULL_SET_TTL_MS = 45_000;
let fullSetCache: { at: number; data: PlatformHealth[] } | null = null;

/** 手动失效缓存（如登录完成后由服务端调用）。 */
export function invalidateHealthCache(): void {
  fullSetCache = null;
}

/**
 * 控制台用的全量巡检（带 TTL 缓存）。返回值里带 `cached`/`ageMs`，
 * 便于 API 与前端如实标注"这是 N 秒前的结果"，而不是假装刚跑过。
 */
export async function probePlatformHealthCached(
  platformList: string[] | undefined,
  deep: boolean,
  forceRefresh = false,
): Promise<{ list: PlatformHealth[]; cached: boolean; ageMs: number }> {
  const targeted = !!platformList?.length;
  const list = targeted ? (platformList as string[]) : DELIVERY_PLATFORMS;
  const cacheable = !targeted && deep;

  if (cacheable && !forceRefresh && fullSetCache) {
    const age = Date.now() - fullSetCache.at;
    if (age < FULL_SET_TTL_MS) return { list: fullSetCache.data, cached: true, ageMs: age };
  }

  const data = await Promise.all(list.map((p) => probeOne(p, deep)));
  if (cacheable) fullSetCache = { at: Date.now(), data };
  return { list: data, cached: false, ageMs: 0 };
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
