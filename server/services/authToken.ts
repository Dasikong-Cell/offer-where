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
 *  - 校验：**默认全部要求令牌**（含 GET），只有 `PUBLIC_READ_GET_PATHS` 里
 *    那些"确无隐私、无副作用"的探活/元信息 GET 放行；
 *    `SIDE_EFFECT_GET_PATHS`（带真实副作用的 GET）永远不会被放行（防御性保留）。
 *  - 分发：控制台由服务端把令牌注入页面（同源，外部站点读不到）；
 *    同机脚本用 `scripts/lib/apiAuth.ts` 从同一文件读取。
 *
 * 🔴 为什么从「黑名单副作用 GET」改成「白名单公开 GET」（2026-09-30 修正）：
 *    原策略是「GET 全部放行，只把 2 个带副作用的 GET 记进黑名单」。这个方向选错了 ——
 *    它默认了"GET 没有副作用 = GET 可以公开"，但**只读 ≠ 无隐私**。
 *    实测（HOST=0.0.0.0 + REQUIRE_AUTH 自动开的情况下，裸 curl 不带任何令牌）：
 *      GET /api/resume/file?version=original → 200，348354 字节，就是本人的简历 PDF
 *      GET /api/profile                      → 200，含 name / phone / email
 *      GET /api/jobs                         → 200，1000 条职位
 *      GET /api/applications                 → 200，500 条投递记录
 *    ⇒ 同一 Wi-Fi 下任何人都能拿走全部个人信息，令牌形同虚设。
 *    黑名单的另一个问题是**它随新增路由而失效**：每加一个 GET 接口都要记得补，
 *    忘了就静默漏一个。白名单则相反 —— 新接口默认受保护，忘了补只是"多要一次令牌"，
 *    失败方向是安全的。
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

/**
 * 无需令牌即可访问的 GET —— **白名单，保持极简**。
 *
 * 判据是「这个响应泄露出去会不会伤到用户」，而不是「它是不是 GET」：
 *  - 探活/版本/能力声明类：不含任何个人信息，且手机端在**填令牌之前**要靠它判断连通性
 *    （`pages/connect/connect.js` 先打 `/api/ping`，再补 `/api/version`、`/api/lan`）。
 *  - `/api/lan` 会回内网 IP 列表。这是有意的：小程序就是靠它拿到「点一下填入」的候选地址；
 *    同网段的人本来也能自己 `ipconfig` / 扫到这台机器，算不上新增暴露面。
 *
 * 🔴 明确**不放行**（它们看着"只读"，实则含个人信息）：
 *  - `/api/profile`     姓名/手机/邮箱/简历路径
 *  - `/api/resume/*`    简历本体与元数据
 *  - `/api/jobs`、`/api/applications`、`/api/sessions`、`/api/logs/*`  求职全量记录
 *  - `/api/mail/config`、`/api/mail/recent`                           邮箱配置与邮件
 *
 * 新增路由时**不要往这里加**，除非它能通过上面那条判据；合约测试会钉住这份清单。
 */
export const PUBLIC_READ_GET_PATHS = ['/api/ping', '/api/version', '/api/lan'];

/** 该 GET 是否允许匿名访问（白名单命中且不在副作用清单里） */
export function isPublicReadGet(method: string, pathname: string): boolean {
  const m = String(method || '').toUpperCase();
  if (m !== 'GET' && m !== 'HEAD') return false;
  const p = String(pathname || '');
  // 副作用清单优先：即使将来有人误把它加进白名单，这里也挡住
  if (SIDE_EFFECT_GET_PATHS.includes(p)) return false;
  return PUBLIC_READ_GET_PATHS.includes(p);
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
