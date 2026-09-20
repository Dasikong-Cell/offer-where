/**
 * 请求来源守卫（纯函数，便于单测）
 * ==========================================================================
 * 背景：本服务是「本机 Chrome 自动化」工具，API 会触发**真实副作用**
 * （批量投递、邮箱直投发信、OCR 回填）。若 CORS 放开 `*` 且无来源校验，
 * 用户浏览任意网页时，该页面的 JS 就能静默调用本机 API —— 必须拦截。
 *
 * 策略：
 *  - 允许来源白名单 = 本机回环（127.0.0.1/localhost，端口=服务端口）+ Vite 开发端口
 *    + 显式追加的 EXTRA_ORIGINS（局域网小团队共用时填对方访问地址）。
 *  - 只读方法（GET/HEAD/OPTIONS）不校验（无副作用）。
 *  - 写方法：带 Origin 则必须命中白名单；不带 Origin（curl / 本机脚本 / 导航提交）
 *    则看 Sec-Fetch-Site，跨站一律拒绝。
 */

export const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

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

/** 判定请求是否放行 */
export function checkRequestOrigin(input: OriginCheckInput): OriginCheckResult {
  const method = String(input.method || 'GET').toUpperCase();
  if (SAFE_METHODS.has(method)) return { ok: true };

  const origin = input.origin;
  if (origin) {
    return input.allowed.has(origin) ? { ok: true } : { ok: false, reason: '禁止的请求来源' };
  }
  if (String(input.secFetchSite || '').toLowerCase() === 'cross-site') {
    return { ok: false, reason: '禁止的跨站请求' };
  }
  return { ok: true };
}
