/**
 * 浏览器窗口农场 持久保活 watchdog（独立进程，不依赖后端重启）
 * ==========================================================================
 * 痛点：本环境 Windows 调试 Chrome 实例不稳定，约每小时整批崩溃（CDP 端口全 DOWN），
 *       导致任何批量投递因 ECONNREFUSED 整批失败。
 *
 * 作用：常驻进程，每 INTERVAL_MS（默认 30s）探活一次所有托管端口；
 *       发现下线即按 browserLaunch.json 的 profile 重拉 Chrome（登录态保留）。
 *       与后端（重启后）的 ensureHealthy 互补：
 *         - watchdog 负责「空闲期」保活（无批量在跑时窗口也会崩，需有人兜底）
 *         - 后端 ensureHealthy 负责「动作前」即时自愈（批量中途崩溃不中断）
 *       两者独立进程、各自探活，不会重复拉起（ensureHealthy 先 isPortUp 再决定）。
 *
 * 用法：node/node.exe node_modules/tsx/dist/cli.mjs scripts/browser_watchdog.ts
 * 环境变量：WATCHDOG_INTERVAL_MS=30000  日志：data/browser/watchdog.log
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { checkAllHealth, relaunchAll, listManagedPorts } from '../server/services/browserHealth.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOG_PATH = path.join(__dirname, '..', 'data', 'browser', 'watchdog.log');
const INTERVAL_MS = Number(process.env.WATCHDOG_INTERVAL_MS) || 30_000;

function ts() {
  return new Date().toISOString();
}
// 只写文件日志，绝不碰 stdout/stderr —— 后台 task 会关闭 stdout 管道，console.log 会抛 EPIPE 把进程拖死。
function log(msg: string) {
  const line = `[${ts()}] ${msg}`;
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, line + '\n');
  } catch { /* ignore */ }
}

// ── 单实例锁：防止重复 watchdog 并发（两个进程同拉一个端口 → 双开 Chrome / 端口冲突）。
// 锁文件存 PID；启动时若旧 PID 仍存活则本进程直接退出；被强杀留下的陈旧锁用「探活失败」自动接管。
const LOCK_PATH = path.join(__dirname, '..', 'data', 'browser', 'watchdog.lock');
function acquireLock(): boolean {
  try {
    if (fs.existsSync(LOCK_PATH)) {
      const old = Number(String(fs.readFileSync(LOCK_PATH, 'utf8')).trim());
      if (old && old !== process.pid) {
        try { process.kill(old, 0); return false; } catch { /* 进程已死 → 陈旧锁，接管 */ }
      }
    }
    fs.writeFileSync(LOCK_PATH, String(process.pid));
    return true;
  } catch { return true; }
}
function releaseLock() {
  try {
    if (Number(String(fs.readFileSync(LOCK_PATH, 'utf8')).trim()) === process.pid) fs.unlinkSync(LOCK_PATH);
  } catch { /* ignore */ }
}
if (!acquireLock()) {
  log(`watchdog 已有实例在运行（锁 ${LOCK_PATH}），本进程退出`);
  process.exit(0);
}
process.on('exit', releaseLock);

let running = false;

async function tick() {
  if (running) return; // 防重入（上轮未结束时跳过本轮）
  running = true;
  try {
    const health = await checkAllHealth();
    const ports = listManagedPorts();
    const down = ports.filter((p) => !health[p]);
    if (down.length === 0) {
      log(`OK all ${ports.length} windows up`);
      return;
    }
    log(`DOWN ${down.length}/${ports.length}: ${down.join(',')} -> relaunch`);
    const res = await relaunchAll();
    const stillDown = down.filter((p) => !res[p]);
    if (stillDown.length === 0) {
      log(`recovered: all ${ports.length} windows up`);
    } else {
      log(`relaunch done; still down: ${stillDown.join(',')} (will retry next tick)`);
    }
  } catch (e: any) {
    log(`tick error: ${e?.message || e}`);
  } finally {
    running = false;
  }
}

log(`watchdog START: monitoring ${listManagedPorts().length} ports, interval=${INTERVAL_MS}ms, log=${LOG_PATH}`);
tick(); // 立即跑一次（首轮恢复）
const timer = setInterval(tick, INTERVAL_MS);

// 不让未捕获异常把进程带走
process.on('uncaughtException', (e) => log(`uncaughtException: ${(e as Error)?.message || e}`));
process.on('unhandledRejection', (e) => log(`unhandledRejection: ${String(e)}`));
process.on('SIGINT', () => { clearInterval(timer); log('watchdog STOP (SIGINT)'); process.exit(0); });
process.on('SIGTERM', () => { clearInterval(timer); log('watchdog STOP (SIGTERM)'); process.exit(0); });
