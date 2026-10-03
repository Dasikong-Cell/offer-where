/**
 * 一次性配对码 —— 「同网段陌生人」的准入闸门
 * ==========================================================================
 * 背景（2026-09-30 评估留下的已知边界）：
 *   `HOST=0.0.0.0`（`start_lan.bat`）时鉴权会自动开启，但**控制台页面会把令牌注入给
 *   任何来自私有网段的请求**（`requestGuard.canInjectToken`）。原因是"能不能注入"只能
 *   按**对方地址**判断，而同一 Wi-Fi 下用户自己的手机和隔壁同事的笔记本都是
 *   `192.168.x.x` —— 地址这一维根本区分不了。
 *
 *   ⇒ 结果：同网段任何设备打开 `http://<你的内网IP>:4400` 都能拿到令牌，
 *     而令牌能调**有真实副作用**的接口（批量投递、发信）。原先的对策只是一句
 *     文档里的约定「仅限可信 Wi-Fi」，那不是防线，那是免责声明。
 *
 * 方案：引入一个**带外信道** —— 服务端在本机窗口打印一个 6 位配对码，
 *   局域网设备首次打开控制台时看到配对页，输入该码后才拿到设备凭证。
 *   攻击者能扫到你的 IP，但看不到你屏幕上的 6 位数字。
 *
 *   1. 回环地址（本机自用）**完全不受影响** —— 直接注入令牌，不弹配对页。
 *   2. 局域网设备：未配对 ⇒ 配对页；已配对 ⇒ 正常注入令牌。
 *   3. 配对码**一次性**：配对成功立即轮换（旧码作废）并重新打印。
 *      要加第二台设备就再看一眼服务端窗口 —— 与"配对新设备"的直觉一致。
 *   4. 失败尝试限速：单 IP 5 次 / 5 分钟，全局 30 次 / 5 分钟（防换 IP 分散爆破）。
 *      6 位数字有 100 万种，5 次/5 分钟 ⇒ 期望爆破时间以**年**计。
 *   5. `PAIRING=off` 可关掉（退回"地址即信任"的旧行为）—— 给完全自控的网络留出口。
 *
 * 设备凭证：cookie `ow_pair` = `<deviceId>.<HMAC(authToken, deviceId)>`，
 *   在册设备存 `data/.paired_devices.json`。用 HMAC 而不是随机串，是为了让
 *   「凭证真伪」可离线校验（不必每次读文件），而「是否在册」才需要读文件 ——
 *   这样撤销一台设备 = 从文件里删一行，不需要轮换密钥、不会踢掉其它设备。
 *
 * ⚠️ 与「令牌」的关系：配对凭证**不是**令牌，它只回答"这个浏览器允许被注入令牌吗"。
 *   所有真正的接口鉴权仍然只看 `X-Auth-Token`（`authToken.ts`），一行没改。
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { getAuthToken, safeEqual } from './authToken.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const CODE_PATH = path.join(DATA_DIR, '.pair_code');
const DEVICES_PATH = path.join(DATA_DIR, '.paired_devices.json');

/** 设备凭证 cookie 名 */
export const PAIR_COOKIE = 'ow_pair';
/** 设备凭证有效期（秒）—— 用户自己的设备，长期有效；撤销靠"忘记设备"而不是过期 */
export const PAIR_MAX_AGE_SEC = 365 * 24 * 3600;

// ── 开关 ────────────────────────────────────────────────────────────────────
/**
 * 是否启用配对闸门。默认**开**。
 * 只在鉴权开启（`AUTH_ENABLED`）时有意义：回环地址下鉴权本来就不开，
 * `GET /` 直接发页面，谈不上配对。
 */
export function isPairingEnabled(): boolean {
  const f = String(process.env.PAIRING || '').trim().toLowerCase();
  if (f === 'off' || f === '0' || f === 'false') return false;
  return true;
}

// ── 配对码 ──────────────────────────────────────────────────────────────────
let cachedCode: string | null = null;

/** 当前配对码（不存在或已被改坏则生成） */
export function getPairCode(): string {
  if (cachedCode) return cachedCode;
  try {
    const c = String(fs.readFileSync(CODE_PATH, 'utf8')).trim();
    if (/^\d{6}$/.test(c)) { cachedCode = c; return c; }
  } catch { /* 文件不存在 ⇒ 下面生成 */ }
  return rotatePairCode();
}

/**
 * 轮换配对码（配对成功后调用）。旧码立即作废。
 * 用 `crypto.randomInt` 而不是 `Math.random` —— 后者可预测，等于没有码。
 */
export function rotatePairCode(): string {
  const c = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  cachedCode = c;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CODE_PATH, c, { mode: 0o600 });
  } catch { /* 写不了就只在内存里有效 */ }
  return c;
}

// ── 已配对设备 ──────────────────────────────────────────────────────────────
let devices: Set<string> | null = null;

function loadDevices(): Set<string> {
  if (devices) return devices;
  devices = new Set<string>();
  try {
    const arr = JSON.parse(fs.readFileSync(DEVICES_PATH, 'utf8'));
    if (Array.isArray(arr)) for (const d of arr) if (typeof d === 'string' && d) devices.add(d);
  } catch { /* 不存在或损坏 ⇒ 空表（用户重新配对即可） */ }
  return devices;
}

function persistDevices(): void {
  const arr = [...loadDevices()];
  // 异步落盘：配对是低频动作，不能让它阻塞请求；失败也不影响本次配对的即时生效
  fs.promises.mkdir(DATA_DIR, { recursive: true })
    .then(() => fs.promises.writeFile(DEVICES_PATH, JSON.stringify(arr), { mode: 0o600 }))
    .catch(() => { /* 落盘失败：重启后需重新配对，不影响当下 */ });
}

/** 已配对设备数 */
export function pairedDeviceCount(): number {
  return loadDevices().size;
}

/** 解除全部配对（返回被解除的数量）—— 换 Wi-Fi / 卖机器时用 */
export function unpairAll(): number {
  const n = loadDevices().size;
  devices = new Set<string>();
  persistDevices();
  return n;
}

// ── 设备凭证 ────────────────────────────────────────────────────────────────
function deviceSig(deviceId: string): string {
  return crypto.createHmac('sha256', getAuthToken()).update(deviceId).digest('hex').slice(0, 32);
}

function makeDeviceCookie(deviceId: string): string {
  return `${deviceId}.${deviceSig(deviceId)}`;
}

/** 从请求头里读一个 cookie（不引 cookie-parser：只此一处需要） */
export function readCookie(req: any, name: string): string {
  const raw = String((req && req.headers && req.headers.cookie) || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    if (part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return part.slice(i + 1).trim(); }
    }
  }
  return '';
}

/** 该请求来自一台**已配对**的设备吗 */
export function isPairedRequest(req: any): boolean {
  const raw = readCookie(req, PAIR_COOKIE);
  if (!raw) return false;
  const dot = raw.indexOf('.');
  if (dot <= 0) return false;
  const deviceId = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  // 先验签（常量时间），再看是否在册 —— 验签失败就没必要读文件
  if (!safeEqual(sig, deviceSig(deviceId))) return false;
  return loadDevices().has(deviceId);
}

// ── 失败限速 ────────────────────────────────────────────────────────────────
const FAIL_WINDOW_MS = 5 * 60 * 1000;
const MAX_FAIL_PER_IP = 5;
const MAX_FAIL_GLOBAL = 30;
const GLOBAL_KEY = '__global__';
const fails = new Map<string, number[]>();

function recentFails(key: string): number[] {
  const arr = (fails.get(key) || []).filter((t) => Date.now() - t < FAIL_WINDOW_MS);
  if (arr.length) fails.set(key, arr); else fails.delete(key);
  return arr;
}

function noteFail(key: string): void {
  const arr = fails.get(key) || [];
  arr.push(Date.now());
  fails.set(key, arr);
}

/**
 * 是否被限速。返回 0 = 放行；> 0 = 需等待的秒数。
 * 同时看单 IP 与全局：局域网内换 IP 不难（改静态 IP / 多网卡），只按 IP 限会被绕开；
 * 只按全局限又会被一个坏客户端拖住所有人 —— 两者都要。
 */
export function pairingRetryAfterSec(ip: string): number {
  if (recentFails(ip).length >= MAX_FAIL_PER_IP) return Math.ceil(FAIL_WINDOW_MS / 1000);
  if (recentFails(GLOBAL_KEY).length >= MAX_FAIL_GLOBAL) return Math.ceil(FAIL_WINDOW_MS / 1000);
  return 0;
}

// ── 配对 ────────────────────────────────────────────────────────────────────
export type PairResult =
  | { ok: true; cookie: string; maxAgeSec: number; deviceId: string }
  | { ok: false; reason: string; retryAfterSec: number };

/** 用配对码换设备凭证。码**一次性**：成功后立即轮换。 */
export function pairWithCode(req: any, rawCode: unknown): PairResult {
  const ip = String((req && req.socket && req.socket.remoteAddress) || '');
  const wait = pairingRetryAfterSec(ip);
  if (wait > 0) {
    return { ok: false, reason: `尝试过于频繁，请 ${Math.ceil(wait / 60)} 分钟后再试`, retryAfterSec: wait };
  }

  const code = String(rawCode ?? '').trim();
  if (!/^\d{6}$/.test(code)) {
    noteFail(ip); noteFail(GLOBAL_KEY);
    return { ok: false, reason: '配对码应为 6 位数字', retryAfterSec: 0 };
  }
  if (!safeEqual(code, getPairCode())) {
    noteFail(ip); noteFail(GLOBAL_KEY);
    return { ok: false, reason: '配对码不正确（请核对服务端窗口里显示的那 6 位数字）', retryAfterSec: 0 };
  }

  const deviceId = crypto.randomBytes(16).toString('hex');
  loadDevices().add(deviceId);
  persistDevices();
  const next = rotatePairCode();               // 一次性：用过即换
  fails.delete(ip); fails.delete(GLOBAL_KEY);  // 成功后清掉自己的失败记录
  console.log(`[pair] 新设备已配对（当前在册 ${loadDevices().size} 台）｜新的配对码：${next}`);
  return { ok: true, cookie: makeDeviceCookie(deviceId), maxAgeSec: PAIR_MAX_AGE_SEC, deviceId };
}

/** 设备凭证 cookie 的 Set-Cookie 值（HttpOnly：前端不需要读它，令牌是注入的） */
export function buildPairSetCookie(value: string, maxAgeSec: number): string {
  // 不设 Secure：局域网访问就是 http（设了浏览器会直接丢弃这个 cookie，配对永远不生效）。
  // SameSite=Lax：同源导航会带上，跨站请求不带 —— 与本服务的来源策略一致。
  return `${PAIR_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Lax`;
}
