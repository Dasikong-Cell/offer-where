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
}

function human(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/** 删除目录下超过 days 天的普通文件（不递归子目录） */
function pruneByAge(dir: string, days: number, dryRun: boolean): { deleted: number; freedBytes: number } {
  const res = { deleted: 0, freedBytes: 0 };
  if (!fs.existsSync(dir)) return res;
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    try {
      const st = fs.statSync(p);
      if (!st.isFile() || st.mtimeMs >= cutoff) continue;
      res.deleted++;
      res.freedBytes += st.size;
      if (!dryRun) fs.unlinkSync(p);
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

  const screenshots = pruneByAge(path.join(DATA_DIR, 'screenshots'), screenshotDays, dryRun);
  const runLogs = pruneByAge(path.join(DATA_DIR, 'run_log'), runLogDays, dryRun);

  // DB 备份：按 mtime 倒序，仅保留最近 keepDbBackups 份
  const dbBackups = { deleted: 0, freedBytes: 0 };
  try {
    if (fs.existsSync(DATA_DIR)) {
      const baks: Array<{ p: string; m: number; s: number }> = [];
      for (const n of fs.readdirSync(DATA_DIR)) {
        if (!n.startsWith('chat.db.bak-')) continue;
        const p = path.join(DATA_DIR, n);
        try { const st = fs.statSync(p); if (st.isFile()) baks.push({ p, m: st.mtimeMs, s: st.size }); } catch { /* 忽略 */ }
      }
      baks.sort((a, b) => b.m - a.m);
      for (const b of baks.slice(keepDbBackups)) {
        dbBackups.deleted++;
        dbBackups.freedBytes += b.s;
        if (!dryRun) fs.unlinkSync(b.p);
      }
    }
  } catch { /* 忽略 */ }

  const freedBytes = screenshots.freedBytes + dbBackups.freedBytes + runLogs.freedBytes;
  const report: CleanupReport = { screenshots, dbBackups, runLogs, freedBytes, freedHuman: human(freedBytes), dryRun };
  if (freedBytes > 0) {
    console.log(`[cleanup] ${dryRun ? '(dry-run) ' : ''}释放 ${report.freedHuman}｜截图 ${screenshots.deleted} 个 / DB备份 ${dbBackups.deleted} 个 / 日志 ${runLogs.deleted} 个`);
  }
  return report;
}
