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
