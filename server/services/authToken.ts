/**
 * 本地访问令牌（可选鉴权，供「分发给他人 / 暴露到局域网」时启用）
 * ==========================================================================
 * 背景：本服务的写接口会触发**真实副作用**（批量投递、邮箱发信、删除记录）。
 * `requestGuard.ts` 已拦住「浏览器里的恶意网页」，但**拦不住同机其它进程**——
 * 一旦把服务暴露到局域网（HOST=0.0.0.0），任何人访问 http://<内网IP>:4400 都能投递。
 *
 * 策略（对「本机自用」零影响）：
 *  - 开关：`REQUIRE_AUTH=1` 强制开、`=0` 强制关；未设时**仅当监听地址非回环**才自动开。
 *    → 默认 HOST=127.0.0.1 时鉴权关闭，控制台/脚本行为完全不变。
 *  - 令牌：`data/.auth_token`（首次启动自动生成 48 位 hex；data/ 已 gitignore）。
 *  - 校验：写方法（POST/PUT/PATCH/DELETE）要求 `X-Auth-Token`（或 `Authorization: Bearer`）；
 *    **外加 `SIDE_EFFECT_GET_PATHS` 里那些"带真实副作用的 GET"**（2026-09-29 补）。
 *    其余只读 GET/HEAD/OPTIONS 不校验（无副作用，保留探活便利）。
 *  - 分发：控制台由服务端把令牌注入页面（同源，外部站点读不到）；
 *    同机脚本用 `scripts/lib/apiAuth.ts` 从同一文件读取。
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_PATH = path.join(__dirname, '..', '..', 'data', '.auth_token');

let cached: string | null = null;

/** 读取（不存在则生成并落盘）访问令牌 */
export function getAuthToken(): string {
  if (cached) return cached;
  try {
    if (fs.existsSync(TOKEN_PATH)) {
      const t = String(fs.readFileSync(TOKEN_PATH, 'utf8')).trim();
      if (t) { cached = t; return t; }
    }
    const t = crypto.randomBytes(24).toString('hex');
    fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
    fs.writeFileSync(TOKEN_PATH, t, { mode: 0o600 });
    cached = t;
    return t;
  } catch {
    // 文件系统不可写时退化为「进程内随机令牌」，至少本次运行有鉴权
    cached = cached || crypto.randomBytes(24).toString('hex');
    return cached;
  }
}

/**
 * 带真实副作用的 GET —— 鉴权开启时**同样要求令牌**。
 *
 * 为什么要单独列：GET 是「简单请求」，不触发 CORS 预检，curl 直连也不带 `Origin`，
 * requestGuard（那个只挡浏览器里的跨站页面）根本看不见它。而 `?realSend=1` 这种
 * 参数一旦被外人触发，就是"替你给 HR 发消息"——不可撤销。
 *
 * 判据是「这个 GET 会不会改变外部世界」，不是「它叫什么」：
 *  - `/api/auto-reply/run`：`realSend=1` 真的发消息 / 发信。
 *  - `/api/apply/record`：驱动浏览器抽帧存证（外部可观测的动作）。
 *  - **不**含 `/api/auto-apply/watch`：它只订阅事件推 SSE，不启动任何东西
 *    （顺带避开 EventSource 无法自定义请求头这个问题）。
 *
 * 新增带副作用的 GET 时必须同步这里；合约测试会钉住这份清单非空且被服务端引用。
 */
export const SIDE_EFFECT_GET_PATHS = ['/api/auto-reply/run', '/api/apply/record'];

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

/** 是否启用鉴权：显式 env 优先；否则「非回环监听」即自动启用 */
export function isAuthEnabled(host: string): boolean {
  const flag = String(process.env.REQUIRE_AUTH || '').trim();
  if (flag === '1') return true;
  if (flag === '0') return false;
  return !LOOPBACK.has(String(host || '').toLowerCase());
}

/** 从请求头提取令牌（同时支持 X-Auth-Token 与 Authorization: Bearer） */
export function extractToken(req: any): string {
  const h = (req && req.headers) || {};
  const x = String(h['x-auth-token'] || '').trim();
  if (x) return x;
  const auth = String(h['authorization'] || '');
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

/** 请求是否携带正确令牌 */
export function isAuthorized(req: any): boolean {
  const t = extractToken(req);
  return !!t && t === getAuthToken();
}

/** 常量时间比较（防时序侧信道）；长度不同直接 false */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch { return false; }
}

/** 请求是否携带正确令牌（常量时间比较版本） */
export function isAuthorizedStrict(req: any): boolean {
  return safeEqual(extractToken(req), getAuthToken());
}
