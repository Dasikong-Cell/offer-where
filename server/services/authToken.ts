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
 *  - 校验：**仅写方法**（POST/PUT/PATCH/DELETE）要求 `X-Auth-Token`（或 `Authorization: Bearer`）。
 *    只读方法（GET/HEAD/OPTIONS）不校验（无副作用，保留探活便利）。
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
