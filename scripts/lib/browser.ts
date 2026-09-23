/**
 * scripts/lib/browser.ts
 * 统一的浏览器执行封装（防踩坑）。
 *
 * 后端接口：POST http://127.0.0.1:<PORT>/api/browser/exec
 * 请求体：{ platform, action, ...args }
 * 返回：    execAction() 的结果（通常含 { ok, data, ... }）
 *
 * ── 历史教训（2026-09-12 offerbiu 采集事故）──────────────────────────────
 *   项目里散落 N 处本地 ex() 副本，签名不一致：
 *     · 2 参：ex(platform, body)              body 内含 action，展开成 { platform, ...body }
 *     · 3 参：ex(platform, action, args)      展开成 { platform, action, ...args }
 *   一旦「定义了 2 参，却按 3 参调用」：
 *     action 字符串 'eval' 被当作 body 展开 → { platform, '0':'e','1':'a','2':'v','3':'l' }
 *     后端收不到 action 字段 → 400「缺少 action 参数」，.data 恒 undefined，
 *     采集/投递在静默中全部失败（offerbiu_scan 当时恒返回 0 条即此因）。
 *
 * ── 本模块统一两种写法，缺 action 直接抛错，不再静默失败 ──────────────────
 *   ex(platform, { action: 'eval', script })          // 2 参对象写法
 *   ex(platform, 'eval', { script })                  // 3 参写法
 *   const ex = makeEx('boss'); ex('eval', { script })  // 平台固定时的闭包写法
 */

import { authHeaders } from './apiAuth.ts';

const PORT = Number(process.env.PORT) || 4400;

/**
 * 浏览器执行端点。
 *  - 默认 http://127.0.0.1:<PORT>/api/browser/exec（PORT 默认 4400）
 *  - 若设了 API_BASE（如脚本里常用的 http://127.0.0.1:4400），优先用 API_BASE，
 *    与 focus_login.ts / diag_login.ts 等历史脚本的 ${API}/api/browser/exec 保持一致。
 */
export const BROWSER_EXEC_URL = process.env.API_BASE
  ? `${process.env.API_BASE.replace(/\/$/, '')}/api/browser/exec`
  : `http://127.0.0.1:${PORT}/api/browser/exec`;

export type BrowserArgs = Record<string, any>;

export interface ExecResult {
  ok: boolean;
  data?: any;
  error?: string;
  [k: string]: any;
}

/** 把两种调用约定归一为 { platform, action, args }，缺 action 即抛错 */
function buildPayload(
  platform: string,
  actionOrBody: string | BrowserArgs,
  maybeArgs?: BrowserArgs,
): { platform: string; action: string; args: BrowserArgs } {
  if (!platform || typeof platform !== 'string') {
    throw new Error('[browser.ex] platform 必须传字符串');
  }
  if (typeof actionOrBody === 'string') {
    // 3 参写法：ex(platform, 'eval', { script })
    return {
      platform,
      action: actionOrBody,
      args: maybeArgs && typeof maybeArgs === 'object' ? maybeArgs : {},
    };
  }
  if (actionOrBody && typeof actionOrBody === 'object') {
    // 2 参写法：ex(platform, { action: 'eval', script })
    const { action, ...rest } = actionOrBody as BrowserArgs;
    if (typeof action !== 'string' || !action) {
      throw new Error(
        '[browser.ex] 第 2 参为对象时必须带 action 字段，收到: ' +
          JSON.stringify(actionOrBody).slice(0, 200),
      );
    }
    return { platform, action, args: rest };
  }
  throw new Error(
    '[browser.ex] 第 2 参必须是 action 字符串或 { action, ... } 对象，收到: ' +
      JSON.stringify(actionOrBody).slice(0, 200),
  );
}

/**
 * 平台优先的统一执行函数，兼容 2 参（对象）与 3 参（字符串 + args）两种写法。
 * 缺 action 直接抛错，避免「后端返回 400 缺少 action 但 .data 恒 undefined」的静默失败。
 */
export async function ex(
  platform: string,
  actionOrBody: string | BrowserArgs,
  maybeArgs?: BrowserArgs,
): Promise<ExecResult> {
  const { platform: p, action, args } = buildPayload(platform, actionOrBody, maybeArgs);
  const r = await fetch(BROWSER_EXEC_URL, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
    body: JSON.stringify({ platform: p, action, ...args }),
  });
  return (await r.json()) as ExecResult;
}

/**
 * 平台固定的闭包写法：const ex = makeEx('boss')，之后 ex('eval', { script }) 或 ex({ action: 'eval', script })。
 * 适合平台写死的脚本（collect_boss / focus_login 等）。
 */
export function makeEx(platform: string) {
  return (actionOrBody: string | BrowserArgs, maybeArgs?: BrowserArgs): Promise<ExecResult> =>
    ex(platform, actionOrBody, maybeArgs);
}

export default ex;
