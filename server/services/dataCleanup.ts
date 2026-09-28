import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'data');

export interface CleanupOptions {
  /** 截图保留天数（默认 14） */
  screenshotDays?: number;
  /** 数据库备份保留份数（默认 3） */
  keepDbBackups?: number;
  /** 运行日志保留天数（默认 30） */
  runLogDays?: number;
  /** 仅统计不删除 */
  dryRun?: boolean;
}

export interface CleanupReport {
  screenshots: { deleted: number; freedBytes: number };
  dbBackups: { deleted: number; freedBytes: number };
  runLogs: { deleted: number; freedBytes: number };
  freedBytes: number;
  freedHuman: string;
  dryRun: boolean;
  /** data/ 当前总体积（含 browser 登录态、jd_images 等不清理的部分） */
  totalBytes: number;
  totalHuman: string;
  /** 体积阈值（字节），来自 DATA_MAX_MB，默认 3000MB */
  maxBytes: number;
  /** 是否已超阈值 —— 调用方据此告警（分发给他人后磁盘可能被静默吃满） */
  overThreshold: boolean;
  /** 统计是否因上限保护而提前结束（体积为下界） */
  approx: boolean;
}

function human(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/**
 * 递归统计目录体积。带上限保护（文件数/深度），避免在超大目录上卡住：
 * data/browser 存放各平台登录态 profile，实测约 18 万个小文件，全量遍历要数秒。
 *
 * ⚠️ 2026-09-28 由同步改为异步：本函数原先用 `readdirSync` + `statSync` 逐项遍历，
 *    而 `cleanupData` 函数体内一个 `await` 都没有，于是它在 `app.listen` 回调里**同步**
 *    跑完，把事件循环占住。实测本机 data/ = 847MB / 5,443 文件时占用 **19.9 秒**：
 *    这段时间里端口已经 LISTENING、启动横幅也已打印，但**任何请求都得不到响应**
 *    （连接堆在 accept 队列里，客户端超时后留下 CLOSE_WAIT）。健康探测脚本会据此
 *    误判「进程起来了但服务是坏的」。改异步后阻塞降到毫秒级。
 *
 * 另外两处一并收紧：
 *  1. 用 `withFileTypes` 拿条目类型，省掉**每个文件一次 stat**（Windows 上是大头）。
 *  2. **不跟随目录符号链接**（Windows 上的 junction 可成环）。原先跟随 + 只有深度上限，
 *     在含 junction 的 Chrome profile 上会造成层层展开的指数级爆炸，那才是「越用越慢」的隐患。
 */
async function dirSize(dir: string, opts: { maxFiles?: number; maxDepth?: number } = {}): Promise<{ bytes: number; files: number; truncated: boolean }> {
  const maxFiles = opts.maxFiles ?? 250000;
  const maxDepth = opts.maxDepth ?? 8;
  let bytes = 0, files = 0, truncated = false;
  const walk = async (d: string, depth: number): Promise<void> => {
    if (truncated) return;
    if (depth > maxDepth) { truncated = true; return; }
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files >= maxFiles) { truncated = true; return; }
      if (e.isSymbolicLink()) continue; // 不跟随：防 junction 成环 + 指数展开
      const p = path.join(d, e.name);
      if (e.isDirectory()) { await walk(p, depth + 1); continue; }
      if (!e.isFile()) continue;
      try { bytes += (await fs.promises.stat(p)).size; files++; } catch { /* 单个文件失败不影响整体 */ }
    }
  };
  await walk(dir, 0);
  return { bytes, files, truncated };
}

/** 删除目录下超过 days 天的普通文件（不递归子目录） */
async function pruneByAge(dir: string, days: number, dryRun: boolean): Promise<{ deleted: number; freedBytes: number }> {
  const res = { deleted: 0, freedBytes: 0 };
  let names: string[];
  try { names = await fs.promises.readdir(dir); } catch { return res; }
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  for (const name of names) {
    const p = path.join(dir, name);
    try {
      const st = await fs.promises.stat(p);
      if (!st.isFile() || st.mtimeMs >= cutoff) continue;
      res.deleted++;
      res.freedBytes += st.size;
      if (!dryRun) await fs.promises.unlink(p);
    } catch { /* 跳过单个文件错误 */ }
  }
  return res;
}

/**
 * 数据目录清理：过期截图 / 超量 DB 备份 / 过期运行日志。
 * 默认**不触碰** `data/browser`（登录态 profile）与 `data/jd_images`（图片 JD 证据）。
 */
export async function cleanupData(opts: CleanupOptions = {}): Promise<CleanupReport> {
  const screenshotDays = opts.screenshotDays ?? 14;
  const keepDbBackups = opts.keepDbBackups ?? 3;
  const runLogDays = opts.runLogDays ?? 30;
  const dryRun = opts.dryRun ?? false;

  const screenshots = await pruneByAge(path.join(DATA_DIR, 'screenshots'), screenshotDays, dryRun);
  const runLogs = await pruneByAge(path.join(DATA_DIR, 'run_log'), runLogDays, dryRun);

  // DB 备份：按 mtime 倒序，仅保留最近 keepDbBackups 份
  const dbBackups = { deleted: 0, freedBytes: 0 };
  try {
    const baks: Array<{ p: string; m: number; s: number }> = [];
    for (const n of await fs.promises.readdir(DATA_DIR)) {
      if (!n.startsWith('chat.db.bak-')) continue;
      const p = path.join(DATA_DIR, n);
      try { const st = await fs.promises.stat(p); if (st.isFile()) baks.push({ p, m: st.mtimeMs, s: st.size }); } catch { /* 忽略 */ }
    }
    baks.sort((a, b) => b.m - a.m);
    for (const b of baks.slice(keepDbBackups)) {
      dbBackups.deleted++;
      dbBackups.freedBytes += b.s;
      if (!dryRun) { try { await fs.promises.unlink(b.p); } catch { /* 忽略 */ } }
    }
  } catch { /* 忽略 */ }

  const freedBytes = screenshots.freedBytes + dbBackups.freedBytes + runLogs.freedBytes;
  // O2：data/ 总量统计 + 阈值告警（阈值可经 DATA_MAX_MB 调整，默认 3000MB）
  const maxBytes = Math.max(256, Number(process.env.DATA_MAX_MB) || 3000) * 1024 * 1024;
  const size = await dirSize(DATA_DIR);
  const overThreshold = size.bytes > maxBytes;
  const report: CleanupReport = {
    screenshots, dbBackups, runLogs, freedBytes, freedHuman: human(freedBytes), dryRun,
    totalBytes: size.bytes,
    totalHuman: human(size.bytes) + (size.truncated ? '（下界，统计已截断）' : ''),
    maxBytes,
    overThreshold,
    approx: size.truncated,
  };
  if (freedBytes > 0) {
    console.log(`[cleanup] ${dryRun ? '(dry-run) ' : ''}释放 ${report.freedHuman}｜截图 ${screenshots.deleted} 个 / DB备份 ${dbBackups.deleted} 个 / 日志 ${runLogs.deleted} 个`);
  }
  console.log(`[cleanup] data/ 当前 ${report.totalHuman}（阈值 ${human(maxBytes)}）`);
  return report;
}
