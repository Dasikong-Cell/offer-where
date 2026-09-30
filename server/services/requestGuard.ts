/**
 * 请求来源守卫（纯函数，便于单测）
 * ==========================================================================
 * 背景：本服务是「本机 Chrome 自动化」工具，API 会触发**真实副作用**
 * （批量投递、邮箱直投发信、OCR 回填、自动回复发信）。若 CORS 放开 `*` 且无来源校验，
 * 用户浏览任意网页时，该页面的 JS 就能静默调用本机 API —— 必须拦截。
 *
 * ⚠️ 2026-09-25 修复：副作用不只在「写方法」上。`GET /api/auto-reply/run?realSend=1`
 *    这类**带副作用的 GET** 能被恶意页面用 `<img src="http://127.0.0.1:4400/api/...">`
 *    触发：简单 GET 不触发 CORS 预检，响应虽因不回显 CORS 头而读不到，但服务端已执行副作用。
 *    故**不再对只读方法无条件放行**，来源校验对所有方法一视同仁。
 *
 * 策略：
 *  - 允许来源白名单 = 本机回环（127.0.0.1/localhost，端口=服务端口）+ Vite 开发端口
 *    + 显式追加的 EXTRA_ORIGINS（局域网小团队共用时填对方访问地址）。
 *  - OPTIONS 预检：中间件已短路（仅对白名单回显 CORS 头），此处保持放行。
 *  - 带 Origin：必须命中白名单。同源请求（含控制台同源 GET）不带 Origin；
 *    带了 Origin 即为跨源脚本调用 —— 读写都拦。
 *  - 不带 Origin：看 Sec-Fetch-Site。`cross-site`（恶意页面的 img/script/fetch）一律拒；
 *    `none`（直接导航 / 双击启动器 / 本机脚本 / curl）与 `same-origin` 放行。
 */

/** 组装允许来源白名单 */
export function buildAllowedOrigins(port: number, extra: string[] = []): Set<string> {
  const set = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    'http://127.0.0.1:5173',
    'http://localhost:5173', // Vite 开发前端
  ]);
  for (const raw of extra) {
    const o = String(raw || '').trim().replace(/\/+$/, '');
    if (o) set.add(o);
  }
  return set;
}

/**
 * 把「本机局域网网卡地址」转成允许来源（`http://<ip>:<port>`）。
 * ==========================================================================
 * 背景：手机 / 平板通过 `http://<局域网IP>:<端口>` 打开控制台时，页面里的写请求
 * 虽然**同源**，但浏览器对非 GET 的同源请求**仍会带 `Origin: http://<局域网IP>:<端口>`**；
 * 若该来源不在白名单里，会被 `checkRequestOrigin` 判 403 —— 表现就是「手机上能打开、
 * 一点保存/投递就失败」。原先要用户手填 `EXTRA_ORIGINS`，容易漏。
 * 这里由服务端在 HOST 非回环时自动把本机网卡地址补进白名单，免手工。
 * 纯函数，便于单测。
 */
export function lanOriginsFromIps(port: number, ips: string[]): string[] {
  const out: string[] = [];
  for (const raw of ips) {
    const ip = String(raw || '').trim();
    if (!ip) continue;
    out.push(`http://${ip}:${port}`);
  }
  return out;
}

export interface OriginCheckInput {
  method: string;
  origin?: string;
  secFetchSite?: string;
  allowed: Set<string>;
}

export type OriginCheckResult = { ok: true } | { ok: false; reason: string };

/**
 * 判定请求是否放行。
 * 注：不区分「安全方法」——因为存在带真实副作用的 GET（如 auto-reply/run?realSend=1）。
 */
export function checkRequestOrigin(input: OriginCheckInput): OriginCheckResult {
  const method = String(input.method || 'GET').toUpperCase();
  // OPTIONS 预检由中间件短路处理（不回显非白名单来源的 CORS 头），此处保持放行
  if (method === 'OPTIONS') return { ok: true };

  // 带 Origin：必须命中白名单（跨源脚本调用，读写都拦）
  const origin = input.origin;
  if (origin) {
    return input.allowed.has(origin) ? { ok: true } : { ok: false, reason: '禁止的请求来源' };
  }

  // 不带 Origin：看 Sec-Fetch-Site。跨站（恶意 img/script/fetch）一律拒
  if (String(input.secFetchSite || '').toLowerCase() === 'cross-site') {
    return { ok: false, reason: '禁止的跨站请求' };
  }
  return { ok: true };
}

// ── 「令牌能否注入页面」的判据 ────────────────────────────────────────────────
/**
 * 把 IP 归一化成可比较的形式（处理 IPv6 映射前缀与端口/方括号）。
 * `::ffff:192.168.1.5` -> `192.168.1.5`
 */
export function normalizeIp(raw: string): string {
  let s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  // 去掉可能的端口（IPv4:port）与 IPv6 方括号
  s = s.replace(/^\[|\]$/g, '');
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  return s;
}

/** 是否回环地址 */
export function isLoopbackIp(raw: string): boolean {
  const ip = normalizeIp(raw);
  return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('127.');
}

/** 是否私有 / 链路本地地址（RFC1918 + 169.254） */
export function isPrivateIp(raw: string): boolean {
  const ip = normalizeIp(raw);
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false; // 纯 IPv6 不在此列（IPv6 有 fe80:: 等，另行处理）
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/** 是否是 IPv6 链路本地 / 唯一本地地址 */
export function isPrivateIpv6(raw: string): boolean {
  const ip = normalizeIp(raw);
  return ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd');
}

/**
 * 🔴 是否允许把访问令牌注入首页 HTML。
 *
 * 背景（2026-09-30 实测）：`GET /` 原本在鉴权开启时无条件注入令牌，理由是
 * 「同源，外部站点读不到」。但 **CORS 只挡跨源 JS 读取，挡不住任何人直接用浏览器
 * 打开这个 URL 看源码**。实测（REQUIRE_AUTH=1）：
 *   匿名 GET /                    -> 200，响应体里带完整 48 位令牌
 *   用该令牌 GET /api/resume/file -> 200，348KB 简历被完整下载
 *   ⇒ 一旦暴露到公网，等于**鉴权被完全绕过**，任何人都能触发不可撤销的真实投递。
 *
 * 修法：只在「确实来自本机或内网直连」时才注入 ——
 *   1) 对端地址必须是回环或私有网段；
 *   2) **且** 不带任何转发头（X-Forwarded-For / X-Real-IP / Forwarded / X-Forwarded-Host）。
 *      反代 / 隧道转发时必然带这些头 ⇒ 一律不注入（这正是公网暴露的那条路径）。
 *
 * 为什么保留注入：控制台靠它免填令牌。本机与同一 Wi-Fi 的手机都要用它，
 * 而这两条路径都是「用户自己的设备 + 自己的网络」，注入不构成新增暴露面。
 */
export interface TokenInjectInput {
  /** `req.socket.remoteAddress` */
  remoteAddress?: string;
  /** 请求头（只需大小写不敏感地取这几个转发头） */
  headers?: Record<string, unknown>;
}

export function canInjectToken(input: TokenInjectInput): boolean {
  const ip = String(input.remoteAddress || '');
  const local = isLoopbackIp(ip) || isPrivateIp(ip) || isPrivateIpv6(ip);
  if (!local) return false;

  // ⚠️ 头部名统一转小写再比对：Node 运行时给的是小写，但纯函数必须对调用方的大小写不敏感
  //    （单测里写 `Forwarded` 大写就漏判 —— 实测踩过）。
  const h = (input.headers || {}) as Record<string, unknown>;
  const lower: Record<string, unknown> = {};
  for (const k of Object.keys(h)) lower[k.toLowerCase()] = h[k];

  const forwarded = ['x-forwarded-for', 'x-real-ip', 'forwarded', 'x-forwarded-host']
    .some((k) => {
      const v = lower[k];
      return v !== undefined && String(v).trim() !== '';
    });
  return !forwarded;
}
