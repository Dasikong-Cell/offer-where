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

/**
 * 控制台**前端自身**的资源 —— 必须匿名可达，否则连页面都打不开。
 *
 * 第一版只放行了 /api/*，结果 `GET /` 直接 401：控制台白屏，而 curl 测 /api/*
 * 全部「符合预期」，完全看不出来 —— 是**真浏览器**跑一次才暴露的。
 *
 * 为什么安全：这里全是控制台的 HTML 与图标（`public/` 下的东西），不含任何个人信息。
 * 且控制台**页面本身不带令牌**（令牌由服务端在 `/` 路由注入进 HTML），
 * 把它们挡在门外等于「把钥匙锁在屋里」。
 *
 * ⚠️ 刻意**不使用** `express.static` 的实际目录做来源，而是显式列清单 ——
 * 因为 `public/` 哪天多放了一个含数据的文件（比如导出的 CSV），
 * 显式清单不会自动把它带出去，而按目录放行会。
 */
const CONSOLE_ASSETS = new Set([
  '/',
  '/console.html',
  '/manifest.webmanifest',
  '/sw.js',
  '/app.ico',
  '/favicon.ico',
  '/apple-touch-icon.png',
  '/pwa-192.png',
  '/pwa-512.png',
  '/pwa-maskable-512.png',
]);

/** 是否是控制台前端自身资源（只有读方法、无副作用） */
export function isConsoleAsset(method: string, pathname: string): boolean {
  const m = String(method || '').toUpperCase();
  if (m !== 'GET' && m !== 'HEAD') return false;
  return CONSOLE_ASSETS.has(String(pathname || ''));
}

/**
 * 配对相关路径 —— **必须匿名可达**（2026-10-01 加入一次性配对码时新增）。
 * ==========================================================================
 * 为什么必须放行：配对页 `/pair` 与「用配对码换设备凭证」的 `POST /api/pair`
 * **本身就是取得授权的手段**，挡在门后就是死循环 —— 要令牌才能拿令牌。
 * （本项目已经踩过一次同形状的坑：第一版只放行 `/api/*`，`GET /` 直接 401，
 *  控制台白屏而 curl 测 `/api/*` 全部「符合预期」。）
 *
 * 为什么放行它们是安全的：
 *  - `GET /pair` 只是一个表单页面，不含任何数据；
 *  - `POST /api/pair` 要**同时**满足「配对码正确」才发凭证，而配对码是
 *    6 位数字 + **一次性** + 失败限速（单 IP 5 次 / 全局 30 次，每 5 分钟）——
 *    爆破不成立；且它唯一能换到的东西是"被允许注入令牌"的资格本身。
 *
 * ⚠️ 这是**显式清单**，不是前缀放行。不要往这里加别的东西。
 */
export const PAIR_PAGE_PATHS = ['/pair', '/pair.html'];
export const PAIR_ANON_POST_PATHS = ['/api/pair'];
/** 仅**回环**可读的配对元信息（当前配对码）—— 这里放行，再由路由自己判回环 */
export const PAIR_LOOPBACK_ONLY_PATHS = ['/api/pair/code'];

export function isPairAnonRequest(method: string, pathname: string): boolean {
  const m = String(method || '').toUpperCase();
  const p = String(pathname || '');
  const isRead = m === 'GET' || m === 'HEAD';
  if (isRead && PAIR_PAGE_PATHS.includes(p)) return true;
  if (isRead && PAIR_LOOPBACK_ONLY_PATHS.includes(p)) return true;
  if (m === 'POST' && PAIR_ANON_POST_PATHS.includes(p)) return true;
  return false;
}

/**
 * 使用说明页（`public/guide/`）的匿名放行 —— 与 CONSOLE_ASSETS 并列，但判据不同。
 *
 * 为什么必须单独有一条（2026-09-30）：控制台侧栏底部加了「使用说明 / 常见问题」入口，
 * 指向 `/guide/`。而上面那张表是**精确匹配**，`/guide/` 不在里面 ⇒ 鉴权一开
 * （`start_lan.bat` 的 HOST=0.0.0.0，或任何人手动 REQUIRE_AUTH=1）侧栏那个链接直接 401。
 * 这与本项目已经踩过的那次是同一个坑：第一版只放行 `/api/*`，`GET /` 401、控制台白屏，
 * 而 curl 测 `/api/*` 全部「符合预期」—— 只有真浏览器跑一次才暴露。
 *
 * 为什么不是把 `/guide/` 加进 CONSOLE_ASSETS：那一页除 index.html 外还有 9 个配图
 * （`img/*.png` + 图标），逐个列会随「下次多截一张图」静默失效 —— 表现是裂图，
 * 而收件人只会觉得「这说明书做得糙」，不会来报 bug。
 *
 * 为什么也不是「放行整个 `/guide/` 子树」：那等于让任何人把导出物丢进 `public/guide/`
 * 就自动公开。所以这里用**双条件**：必须在该子树内，**且**扩展名属于文档类白名单。
 * 新增截图自动可用；而 `.csv` / `.json` / `.pdf` 这类数据文件即使被放进这个目录也发不出去
 * （只读 ≠ 无隐私，这条判据和 PUBLIC_READ_GET_PATHS 的白名单理由是同一条）。
 * 目录请求本身没有扩展名（`/guide`、`/guide/`），单独放行 —— 那正是落到 index.html 的请求。
 */
const GUIDE_ROOT = '/guide/';
const GUIDE_EXT = new Set(['.html', '.htm', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico', '.css']);
export function isGuideAsset(method: string, pathname: string): boolean {
  const m = String(method || '').toUpperCase();
  if (m !== 'GET' && m !== 'HEAD') return false;
  const p = String(pathname || '');
  if (p === '/guide' || p === '/guide/') return true;      // 目录请求 → express.static 落到 index.html
  if (!p.startsWith(GUIDE_ROOT)) return false;
  // 只按**最外层**扩展名判：`/guide/../.env` 的 extname 是 `.env`，不在白名单 ⇒ 挡住。
  // 这是这一条里唯一真正的边界防线（前缀判断本身挡不住路径穿越）。
  return GUIDE_EXT.has(path.extname(p).toLowerCase());
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

/**
 * 静态资源的短时签名 —— 解决「浏览器取图片发不出请求头」。
 * ==========================================================================
 * 问题：`<img src="/data/evidence/x.png">`、`<a href=... target="_blank">`、
 * `window.open(...)` 都**无法附加 `X-Auth-Token`**。鉴权一收紧，控制台里
 * 证据截图与录制帧就全变 401 ⇒ 裂图（还被 `onerror` 隐藏，用户只看到「证据没了」）。
 *
 * 方案：把「授权」放进 URL —— `?t=<exp>.<sig>`，其中
 *   sig = HMAC_SHA256(token, "<exp>|<path>")
 * 这样：
 *   - 签名**绑定具体路径** ⇒ 拿到 A 图的链接不能用来读 B 图（防横向扩散）；
 *   - 有**有效期**（默认 1 小时）⇒ 链接被复制出去也不会长期有效；
 *   - 密钥就是 `data/.auth_token` ⇒ 不引入新的密钥管理。
 *
 * 为什么不用「把 static 目录整体放行」：那些目录里就是投递证据截图与简历，
 * 恰恰是最该挡住的东西；放行等于把刚堵上的隐私缺口换个门再开一次。
 */
/**
 * 允许用 URL 签名替代请求头的路径（**精确前缀**，不要放宽成通配）。
 *  - `/data/evidence/`、`/data/screenshots/`、`/data/resume_tailored/`：控制台用 `<img src>` 渲染
 *  - `/api/resume/file`：控制台用 `window.open` 在新标签页预览简历 PDF
 * 这些是**下载/展示型**端点，不是 JSON API；把授权放进 URL 是它们唯一的可行做法。
 */
const SIGNED_PATH_PREFIXES = [
  '/data/evidence/',
  '/data/screenshots/',
  '/data/resume_tailored/',
  '/api/resume/file',
];
const STATIC_TTL_MS = 60 * 60 * 1000; // 1 小时

function staticSig(exp: number, pathname: string): string {
  return crypto.createHmac('sha256', getAuthToken()).update(`${exp}|${pathname}`).digest('hex');
}

/**
 * 为某个路径生成带签名的 URL。
 * 注意 `pathname` 必须**不含** query（`/api/resume/file?version=original` 会先被拆开，
 * 只对 path 部分签名），否则签出来的串与校验时用的 `req.path` 对不上。
 */
export function signStaticPath(rawPath: string, ttlMs: number = STATIC_TTL_MS): string {
  const s = String(rawPath || '');
  if (!s) return s;
  const q = s.indexOf('?');
  const pathname = q >= 0 ? s.slice(0, q) : s;
  const query = q >= 0 ? s.slice(q + 1) : '';
  const exp = Date.now() + Math.max(1000, ttlMs);
  const sig = `${exp}.${staticSig(exp, pathname)}`;
  return query ? `${pathname}?${query}&t=${sig}` : `${pathname}?t=${sig}`;
}

/** 校验静态资源的签名（路径必须命中白名单前缀，签名必须匹配且未过期） */
export function isAuthorizedStaticRes(req: any): boolean {
  const m = String((req && req.method) || '').toUpperCase();
  if (m !== 'GET' && m !== 'HEAD') return false;
  const p = String((req && req.path) || '');
  // 目录前缀（以 / 结尾）用 startsWith；具体端点（如 /api/resume/file）用相等或带子路径
  const allowed = SIGNED_PATH_PREFIXES.some((prefix) =>
    prefix.endsWith('/') ? p.startsWith(prefix) : (p === prefix || p.startsWith(prefix + '/')),
  );
  if (!allowed) return false;

  const raw = String((req && req.query && req.query.t) || '');
  const dot = raw.indexOf('.');
  if (dot <= 0) return false;
  const exp = Number(raw.slice(0, dot));
  const sig = raw.slice(dot + 1);
  if (!Number.isFinite(exp) || exp <= 0) return false;
  if (Date.now() > exp) return false;
  return safeEqual(sig, staticSig(exp, p));
}
