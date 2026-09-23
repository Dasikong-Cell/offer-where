/**
 * 浏览器健康自检 + 自动拉起（in-process 自愈）
 * ==========================================================================
 * 背景（实测痛点，本会话已踩 3 次）：
 *   各平台调试 Chrome 窗口会**随机崩溃**（CDP 端口 ECONNREFUSED），
 *   而旧的恢复方式是外部脚本 `ensure_chrome.sh`（手动、带外）。
 *   窗口一旦在批量投递中途挂掉，整批岗位拿不到页面 → 大量 `need_manual` / 超时，
 *   且报错易被误读成「平台风控 / 链接失效」。
 *
 * GitHub 参考（dassi.ai CDP 博客 + microsoft/aspire 的 CDP reconnect 模式）：
 *   CDP 是一条「易在导航/崩溃后丢失句柄」的脆弱长连接。稳健做法不是依赖人工重启，
 *   而是**在服务内**持续探活，发现进程死亡即按原 `--user-data-dir` 重新拉起（登录态保留），
 *   再重连。本模块即把 `ensure_chrome.sh` 的能力搬进服务进程，让每次浏览器动作自愈。
 *
 * 设计：
 *   - 端口→profile 映射的唯一真相源 = `data/browser/browserLaunch.json`
 *     （与 cdp.json 的 platform→endpoint 解耦，按端口管理，天然支持多平台共用端点）
 *   - `ensureHealthy(endpoint)` 在每个浏览器动作前调用：端口活着就秒回；
 *     端口挂了就拉起对应 Chrome（沿用登录态），等到 /json/version 200 再放行动作。
 *   - 并发保护：同一端口同一时刻只拉起一次（inFlight Promise 去重）；
 *     拉起失败进入 cooldown，避免「每个动作都重拉一次」的雪崩。
 */
import http from 'http';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_ROOT = path.join(__dirname, '..', '..', 'data', 'browser');
const CONFIG_PATH = path.join(DATA_ROOT, 'browserLaunch.json');

interface LaunchSpec {
  port: number;
  profile: string;
  chromePath: string;
  flags: string[];
  waitMs: number;
  pollMs: number;
  cooldownMs: number;
}

let specs: Map<number, LaunchSpec> | null = null;

/** 读取 browserLaunch.json（带缓存）。缺失时用内置兜底映射，保证服务不依赖该文件也能跑。 */
function loadSpecs(): Map<number, LaunchSpec> {
  if (specs) return specs;
  const map = new Map<number, LaunchSpec>();
  const fallbackProfiles: Record<string, string> = {
    '9223': 'C:/chrome-cdp-profile',
    '9224': 'C:/chrome-cdp-profile-liepin',
    '9225': 'C:/chrome-cdp-profile-job51',
    '9226': 'C:/chrome-cdp-profile-zhilian',
    '9227': 'C:/chrome-cdp-profile-official',
    '9230': 'C:/chrome-cdp-profile-chinahr',
    '9232': 'C:/chrome-cdp-profile-yupao',
    '9233': 'C:/chrome-cdp-profile-maimai',
    '9237': 'C:/chrome-cdp-profile-nowcoder',
  };
  const chromePath = 'C:/Users/吉学静/AppData/Local/Google/Chrome/Application/chrome.exe';
  const flags = [
    '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-blink-features=AutomationControlled', '--disable-infobars',
    '--hide-crash-restore-bubble',
  ];
  let cfg: any = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) { console.warn('[browserHealth] browserLaunch.json 解析失败，用内置兜底:', (e as Error).message); }
  }
  // browserLaunch.json 为唯一真相源：文件存在且含 profiles 时以它为准，
  // 兜底映射仅在文件缺失/为空时使用（否则删除端口会被 fallback 合并加回，形同虚设）。
  const cfgProfiles = (cfg.profiles && typeof cfg.profiles === 'object') ? cfg.profiles : null;
  const profiles: Record<string, string> = (cfgProfiles && Object.keys(cfgProfiles).length)
    ? cfgProfiles
    : fallbackProfiles;
  const rl = cfg.relaunch || {};
  for (const [portStr, profile] of Object.entries(profiles)) {
    const port = Number(portStr);
    if (!Number.isFinite(port)) continue;
    map.set(port, {
      port,
      profile: String(profile),
      chromePath: cfg.chromePath || chromePath,
      flags: Array.isArray(cfg.flags) && cfg.flags.length ? cfg.flags : flags,
      waitMs: Number(rl.waitMs) || 12000,
      pollMs: Number(rl.pollMs) || 500,
      cooldownMs: Number(rl.cooldownMs) || 30000,
    });
  }
  specs = map;
  return map;
}

export function listManagedPorts(): number[] {
  return Array.from(loadSpecs().keys()).sort((a, b) => a - b);
}

function endpointToPort(endpoint: string): number {
  try { return Number(new URL(endpoint).port) || 0; } catch { return 0; }
}

/** 端口是否存活（探 /json/version）。短超时，down 时快速返回 false 以触发拉起。 */
export function isPortUp(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/json/version`, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function waitForPort(port: number, waitMs: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  return new Promise((resolve) => {
    const tick = async () => {
      if (await isPortUp(port, 1000)) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(tick, pollMs);
    };
    tick();
  });
}

/** 按原 profile 重新拉起 Chrome（detached，登录态保留）。返回是否成功起端口。 */
async function relaunch(spec: LaunchSpec): Promise<boolean> {
  try {
    const args = [
      `--remote-debugging-port=${spec.port}`,
      `--user-data-dir=${spec.profile}`,
      ...spec.flags,
      'about:blank',
    ];
    console.log(`[browserHealth] 拉起 Chrome（${spec.port}）profile=${spec.profile}`);
    const child = spawn(spec.chromePath, args, { detached: true, stdio: 'ignore' });
    child.on('error', (e) => console.warn(`[browserHealth] 启动 Chrome 失败（${spec.port}）：${e.message}`));
    // 与父进程解耦：父进程退出不影响这个调试窗口，调试窗口退出也不拖死服务。
    if (typeof child.unref === 'function') child.unref();
    return await waitForPort(spec.port, spec.waitMs, spec.pollMs);
  } catch (e: any) {
    console.warn(`[browserHealth] relaunch 异常（${spec.port}）：${e?.message || e}`);
    return false;
  }
}

// 并发去重 + 冷却，避免「每个动作都重拉一次」雪崩。
const inFlight = new Map<number, Promise<boolean>>();
const lastAttemptAt = new Map<number, number>();

/**
 * 确保某端点的调试 Chrome 在线。
 *  - 端口在管理清单中且活着 → 直接返回 true（几乎零开销）
 *  - 端口在管理清单中但挂了 → 拉起（并发去重 + 冷却），成功返回 true
 *  - 端口不在清单（如默认 9222 / 未知端点）→ 只探活、不拉起（无 profile 不敢乱起）
 * 幂等、对正常在线路径无副作用。
 */
export async function ensureHealthy(endpoint: string): Promise<boolean> {
  const port = endpointToPort(endpoint);
  if (!port) return false;
  const spec = loadSpecs().get(port);
  if (!spec) return isPortUp(port); // 非托管端口：仅返回当前存活状态
  if (await isPortUp(port)) return true;

  const now = Date.now();
  const last = lastAttemptAt.get(port) || 0;
  if (now - last < spec.cooldownMs) {
    // 冷却期内：直接判定不可用，避免高频重试（让上层动作快速失败并明确报错）
    return false;
  }
  if (inFlight.has(port)) return inFlight.get(port)!;
  const p = (async () => {
    lastAttemptAt.set(port, Date.now());
    const ok = await relaunch(spec);
    if (!ok) console.warn(`[browserHealth] 端口 ${port} 拉起失败`);
    return ok;
  })();
  inFlight.set(port, p);
  try { return await p; } finally { inFlight.delete(port); }
}

/** 拉起所有「管理清单内、当前下线」的端口。返回 { 端口: 是否成功 }。 */
export async function relaunchAll(): Promise<Record<number, boolean>> {
  const out: Record<number, boolean> = {};
  for (const port of listManagedPorts()) {
    out[port] = await ensureHealthy(`http://127.0.0.1:${port}`);
  }
  return out;
}

/** 诊断：返回所有管理端口的存活情况。 */
export async function checkAllHealth(): Promise<Record<number, boolean>> {
  const out: Record<number, boolean> = {};
  for (const port of listManagedPorts()) out[port] = await isPortUp(port);
  return out;
}

/** 通过 CDP 关闭某调试 Chrome（用于清理/测试）。返回是否成功下发 Browser.close。 */
export async function closeBrowser(port: number): Promise<boolean> {
  try {
    const ver: any = await new Promise((res, rej) => {
      http.get(`http://127.0.0.1:${port}/json/version`, { timeout: 2000 }, (r) => {
        let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => { try { res(JSON.parse(d)); } catch { rej(new Error('bad')); } });
      }).on('error', rej);
    });
    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise<void>((res, rej) => {
      ws.on('open', () => res());
      ws.on('error', rej);
    });
    ws.send(JSON.stringify({ id: 1, method: 'Browser.close', params: {} }));
    await new Promise((r) => setTimeout(r, 800));
    try { ws.close(); } catch { /* ignore */ }
    return true;
  } catch {
    return false;
  }
}
