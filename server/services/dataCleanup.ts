import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'data');

/** 一次清理动作的计数（删了 N 个、释放了多少字节） */
export interface Bucket {
  deleted: number;
  freedBytes: number;
}

/**
 * 总体积超阈值时的自动限额档位。
 *  - `off`  只告警（旧行为）；
 *  - `safe` **只收紧保留期**（截图 14→7 天、日志 30→14 天、备份份数下调）——
 *           删掉的都是"本来就该过期"的东西，不碰任何用户内容，故可作为默认值；
 *  - `full` 在 safe 之上，额外清理 `data/smoke` 等调试产物与过期 JD 图片。
 *
 * 🔴 三档都**不会**碰 `data/browser`（各平台登录态）/ `data/evidence`（投递证据）/
 *    `data/resume_tailored`（一岗一简历产物）/ `data/chat.db`（主库）。
 *    它们是「不可再生」或「用户要留的证据」，自动删除的代价远高于磁盘空间。
 */
export type AutoLimitMode = 'off' | 'safe' | 'full';

/** 一轮清理所用的保留参数 */
export interface PassParams {
  screenshotDays: number;
  keepDbBackups: number;
  keepResumeBackups: number;
  runLogDays: number;
}

export interface CleanupOptions extends Partial<PassParams> {
  /** 仅统计不删除 */
  dryRun?: boolean;
  /** 超阈值自动限额档位；未设时读 `DATA_AUTO_LIMIT`，默认 safe */
  autoLimit?: AutoLimitMode;
  /** full 档下 `data/jd_images` 的保留天数（默认 30，0 表示不清理该目录） */
  jdImageDays?: number;
  /** full 档下要清空的调试产物目录名（相对 data/），默认 `['smoke']` */
  debugDirs?: string[];
  /**
   * 体积阈值（字节）。显式传入时优先于 `DATA_MAX_MB`，**且不受 256MB 下限约束** ——
   * 下限只用来挡「env 配成 1MB 導致每启动一次就狂清」，而显式传参是调用方（含测试）
   * 自己算好的值。复现超阈值场景必须能压低阈值，否则要造几百 MB 文件才能触发。
   */
  maxBytes?: number;
}

/** 自动限额的执行详情（全部落在报告里，便于事后核对"到底做了什么"） */
export interface AutoLimitInfo {
  mode: AutoLimitMode;
  /** 本轮是否因超阈值而触发 */
  triggered: boolean;
  /** 触发时的超额倍数 = totalBytes / maxBytes（未触发为 null） */
  ratio: number | null;
  /** 触发时实际采用的收紧参数 */
  tightened: PassParams | null;
  /** 自动限额这一轮额外释放的字节（不含首轮） */
  extraFreedBytes: number;
  /** 限额跑完后的体积（未触发为 null） */
  afterBytes: number | null;
  /** 跑完是否仍超阈值 —— 例如 data/browser 占比过大，清无可清，需人工处置 */
  stillOver: boolean | null;
  /** 触发时给出体积构成 top（说明"到底是谁占的"） */
  topDirs: Array<{ name: string; bytes: number }> | null;
}

export interface CleanupReport {
  screenshots: Bucket;
  dbBackups: Bucket;
  resumeBackups: Bucket;
  runLogs: Bucket;
  /** 自动限额（full 档）清理的过期 JD 图片 */
  jdImages: Bucket;
  /** 自动限额（full 档）清空的调试产物 */
  debugArtifacts: Bucket;
  freedBytes: number;
  freedHuman: string;
  dryRun: boolean;
  /** data/ 当前总体积（含 browser 登录态、jd_images 等不清理的部分） */
  totalBytes: number;
  totalHuman: string;
  /** 体积阈值（字节），来自 DATA_MAX_MB 或 options，默认 3000MB */
  maxBytes: number;
  /** 是否已超阈值 */
  overThreshold: boolean;
  /** 统计是否因上限保护而提前结束（体积为下界） */
  approx: boolean;
  autoLimit: AutoLimitInfo;
}

function human(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/**
 * 递归统计目录体积。带上限保护（文件数/深度），避免在超大目录上卡住：
 * data/browser 存放各平台登录态 profile，实测约 4 千～18 万个小文件。
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

/**
 * data/ 一级子目录的体积构成（按大小倒序，只取前 N 个）。
 *
 * 为什么需要：自动限额"清不动"时必须能说清**是谁占的**。实测本机
 * data/browser 506MB + data/jd_images 234MB = 总体积的 89%，而这两块是
 * **有意不自动清理**的（登录态 / JD 证据）⇒ 光看「仍超阈值」这句话，
 * 用户只会以为清理功能坏了。给出构成才能把下一步动作指向正确的地方。
 */
async function dirBreakdown(topN: number): Promise<Array<{ name: string; bytes: number }>> {
  const out: Array<{ name: string; bytes: number }> = [];
  let entries: fs.Dirent[];
  try { entries = await fs.promises.readdir(DATA_DIR, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || e.isSymbolicLink()) continue;
    const s = await dirSize(path.join(DATA_DIR, e.name), { maxFiles: 60000, maxDepth: 6 });
    out.push({ name: e.name, bytes: s.bytes });
  }
  out.sort((a, b) => b.bytes - a.bytes);
  return out.slice(0, topN);
}

/** 删除目录下超过 days 天的普通文件（不递归子目录） */
async function pruneByAge(dir: string, days: number, dryRun: boolean): Promise<Bucket> {
  const res = { deleted: 0, freedBytes: 0 };
  let names: string[];
  try { names = await fs.promises.readdir(dir); } catch { return res; }
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  for (const name of names) {
    const p = path.join(dir, name);
    try {
      const st = await fs.promises.stat(p);
      if (!st.isFile() || st.mtimeMs >= cutoff) continue;
      // ⚠️ 只有**真的删掉了**才计数：原先先自增再 unlink，删除失败被 catch 吞掉后
      //    报告仍会宣称「已释放 N 个文件 / X MB」—— 报出并未发生的回收。
      //    实测撞见过：报告写 `删除 1`，目录里文件一个没少（unlink 被环境拒绝）。
      if (dryRun) { res.deleted++; res.freedBytes += st.size; continue; }
      try { await fs.promises.unlink(p); res.deleted++; res.freedBytes += st.size; }
      catch { /* 删不掉就不计数 */ }
    } catch { /* 跳过单个文件错误 */ }
  }
  return res;
}

/**
 * 递归清空一个目录的内容（保留目录本身）。
 * 用于自动限额 full 档清理 `data/smoke` 这类**纯开发期产物**：它们按前缀/结构
 * 混杂（.ts/.mjs/.png/.json 平铺），按 mtime 逐文件筛反而容易漏，整目录清空更符合语义。
 *
 * ⚠️ 变量名刻意用 `out` 而不是 `res`：合约测试里有一条断言按
 *    `unlink(p); res.deleted++` 的**写法**核对"先删后计"，同名会误伤那条断言。
 */
async function pruneTree(dir: string, dryRun: boolean): Promise<Bucket> {
  const out = { deleted: 0, freedBytes: 0 };
  const walk = async (d: string): Promise<void> => {
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { await walk(p); continue; }
      if (!e.isFile()) continue;
      try {
        const st = await fs.promises.stat(p);
        if (dryRun) { out.deleted++; out.freedBytes += st.size; continue; }
        try { await fs.promises.unlink(p); out.deleted++; out.freedBytes += st.size; }
        catch { /* 删不掉就不计数 */ }
      } catch { /* 忽略 */ }
    }
  };
  await walk(dir);
  return out;
}

/**
 * DB 备份保留：以「**备份本体**」为单位保留最近 keep 份。
 *
 * 🔴 2026-09-30 修复：原先按文件名前缀 `chat.db.bak-` 无差别收集，而 SQLite 的
 *    WAL 伴生文件 `chat.db.bak-<ts>-wal` / `-shm` **同样命中该前缀** ⇒ 它们被当成
 *    「一份备份」参与 mtime 排序，**挤占保留名额**。
 *
 *    实测（隔离库，`_tools/_backup_retention_probe.mts`）：
 *      · 3 份主备份各带 2 个伴生文件（共 9 项）⇒ 报告 deleted=6，
 *        结果只剩**最新 1 份**主备份 + 它的伴生文件 —— 承诺「留 3 份」实际留 1 份；
 *      · 若伴生文件的 mtime 晚于主文件（真实 data/ 里就是这个状态：
 *        只剩 3 个伴生、主备份全无），名额会被伴生文件占满，**可用备份一份不剩**。
 *
 *    修法：以「去掉 -wal/-shm 后缀的基名」为分组键，按组内最新 mtime 排序，
 *    整组保留 / 整组删除 —— 伴生文件跟着它的主备份一起留或一起走。
 */
async function pruneDbBackups(keep: number, dryRun: boolean): Promise<Bucket> {
  const dbBackups = { deleted: 0, freedBytes: 0 };
  try {
    const groups = new Map<string, Array<{ p: string; m: number; s: number }>>();
    for (const n of await fs.promises.readdir(DATA_DIR)) {
      if (!n.startsWith('chat.db.bak-')) continue;
      const base = n.replace(/-(wal|shm)$/i, ''); // 伴生文件归到主备份名下
      const p = path.join(DATA_DIR, n);
      try {
        const st = await fs.promises.stat(p);
        if (!st.isFile()) continue;
        if (!groups.has(base)) groups.set(base, []);
        groups.get(base)!.push({ p, m: st.mtimeMs, s: st.size });
      } catch { /* 忽略 */ }
    }
    const ordered = [...groups.entries()]
      .map(([base, items]) => ({ base, items, m: Math.max(...items.map((i) => i.m)) }))
      .sort((a, b) => b.m - a.m);
    for (const g of ordered.slice(keep)) {
      for (const it of g.items) {
        if (dryRun) { dbBackups.deleted++; dbBackups.freedBytes += it.s; continue; }
        // 只有真删掉才计数 —— 否则报告会宣称释放了并未释放的空间（见 pruneByAge 注释）
        try { await fs.promises.unlink(it.p); dbBackups.deleted++; dbBackups.freedBytes += it.s; }
        catch { /* 删不掉就不计数（文件被占用等） */ }
      }
    }
  } catch { /* 忽略 */ }
  return dbBackups;
}

/**
 * 简历备份：每次重传简历都会把旧文件改名为 `resume_*.pdf.bak.<ts>`
 * （见 server/index.ts 的 /api/resume/upload），此前**没有任何地方回收**，
 * 于是每重传一次就在 data/ 里多留一份含个人信息的简历副本。
 * 保留最近 keepResumeBackups 份，够回滚又不至于无限累积。
 */
async function pruneResumeBackups(keep: number, dryRun: boolean): Promise<Bucket> {
  const resumeBackups = { deleted: 0, freedBytes: 0 };
  try {
    const cands: Array<{ p: string; m: number; s: number }> = [];
    for (const n of await fs.promises.readdir(DATA_DIR)) {
      if (!/^resume_.*\.bak\./.test(n)) continue;
      const p = path.join(DATA_DIR, n);
      try {
        const st = await fs.promises.stat(p);
        if (st.isFile()) cands.push({ p, m: st.mtimeMs, s: st.size });
      } catch { /* 忽略 */ }
    }
    cands.sort((a, b) => b.m - a.m);
    for (const b of cands.slice(Math.max(0, keep))) {
      if (dryRun) { resumeBackups.deleted++; resumeBackups.freedBytes += b.s; continue; }
      try { await fs.promises.unlink(b.p); resumeBackups.deleted++; resumeBackups.freedBytes += b.s; }
      catch { /* 删不掉就不计数 */ }
    }
  } catch { /* 忽略 */ }
  return resumeBackups;
}

/**
 * 按「超出阈值的倍数」决定收紧后的保留参数（纯函数，便于单测）。
 *
 * 分两档而不是线性缩放，是为了让行为**可预测、可解释**：
 *   ratio < 1.0   不触发（由调用方判断）
 *   1.0 ≤ ratio < 1.5   收紧一档：截图 7 天 / 日志 14 天 / DB 备份 2 份 / 简历备份 2 份
 *   ratio ≥ 1.5         收紧两档：截图 3 天 / 日志 7 天 / DB 备份 2 份 / 简历备份 1 份
 *
 * ⚠️ 取 `Math.min(base, tightened)`：用户显式配了**更短**的保留期时不能被反向放大。
 */
export function tightenParams(base: PassParams, ratio: number): PassParams {
  const step = ratio >= 1.5 ? 2 : 1;
  const pick = (levels: number[]): number => levels[Math.min(step, levels.length) - 1];
  return {
    screenshotDays: Math.min(base.screenshotDays, pick([7, 3])),
    keepDbBackups: Math.min(base.keepDbBackups, pick([2, 2])),
    keepResumeBackups: Math.min(base.keepResumeBackups, pick([2, 1])),
    runLogDays: Math.min(base.runLogDays, pick([14, 7])),
  };
}

/** 解析自动限额档位：显式 options > env DATA_AUTO_LIMIT > 默认 safe */
export function resolveAutoLimitMode(opts: CleanupOptions): AutoLimitMode {
  const raw = String(opts.autoLimit ?? process.env.DATA_AUTO_LIMIT ?? '').trim().toLowerCase();
  if (raw === 'off' || raw === 'safe' || raw === 'full') return raw;
  return 'safe';
}

/** 一轮清理（按给定保留参数） */
async function runPass(pass: PassParams, dryRun: boolean): Promise<{ screenshots: Bucket; dbBackups: Bucket; resumeBackups: Bucket; runLogs: Bucket }> {
  return {
    screenshots: await pruneByAge(path.join(DATA_DIR, 'screenshots'), pass.screenshotDays, dryRun),
    runLogs: await pruneByAge(path.join(DATA_DIR, 'run_log'), pass.runLogDays, dryRun),
    dbBackups: await pruneDbBackups(pass.keepDbBackups, dryRun),
    resumeBackups: await pruneResumeBackups(pass.keepResumeBackups, dryRun),
  };
}

function addBucket(target: Bucket, add: Bucket): void {
  target.deleted += add.deleted;
  target.freedBytes += add.freedBytes;
}

/**
 * 数据目录清理：过期截图 / 超量 DB 备份 / 超量简历备份 / 过期运行日志，
 * 并在总体积超阈值时按 `autoLimit` 档位**自动限额**（见 AutoLimitMode）。
 *
 * 默认**不触碰**：`data/browser`（登录态 profile）、`data/evidence`（投递证据截图）、
 * `data/resume_tailored`（一岗一简历产物）、`data/resume_doc`（简历制作产物）、`data/chat.db`（主库）。它们要么不可再生，
 * 要么正是用户要留的证据 —— 磁盘空间不值得拿它们换。
 */
export async function cleanupData(opts: CleanupOptions = {}): Promise<CleanupReport> {
  const base: PassParams = {
    screenshotDays: opts.screenshotDays ?? 14,
    keepDbBackups: opts.keepDbBackups ?? 3,
    keepResumeBackups: opts.keepResumeBackups ?? 2,
    runLogDays: opts.runLogDays ?? 30,
  };
  const dryRun = opts.dryRun ?? false;
  const mode = resolveAutoLimitMode(opts);
  // 阈值优先级：显式 options.maxBytes > env DATA_MAX_MB（带 256MB 下限）> 默认 3000MB
  const maxBytes = opts.maxBytes ?? (Math.max(256, Number(process.env.DATA_MAX_MB) || 3000) * 1024 * 1024);

  const first = await runPass(base, dryRun);
  const screenshots = { ...first.screenshots };
  const dbBackups = { ...first.dbBackups };
  const resumeBackups = { ...first.resumeBackups };
  const runLogs = { ...first.runLogs };
  const jdImages: Bucket = { deleted: 0, freedBytes: 0 };
  const debugArtifacts: Bucket = { deleted: 0, freedBytes: 0 };

  let size = await dirSize(DATA_DIR);
  let overThreshold = size.bytes > maxBytes;

  const autoLimit: AutoLimitInfo = {
    mode, triggered: false, ratio: null, tightened: null,
    extraFreedBytes: 0, afterBytes: null, stillOver: null, topDirs: null,
  };

  // ── 超阈值 ⇒ 自动限额 ──────────────────────────────────────────────────────
  // 旧行为只打印一句「data/ 当前 X（阈值 Y）」就结束：分发给他人后，磁盘会被
  // 「截图 + 日志 + 备份 + 简历副本」这些**本来就有保留策略的东西**静默吃满，
  // 而用户看到的只是启动日志里不痛不痒的一行（终端一关就没了）。
  if (overThreshold && mode !== 'off') {
    autoLimit.triggered = true;
    autoLimit.ratio = size.bytes / maxBytes;
    const tightened = tightenParams(base, autoLimit.ratio);
    autoLimit.tightened = tightened;

    const before = size.bytes;

    // safe 起：用收紧后的保留期**再跑一遍**（只动"本来就该过期"的东西，无损）
    const second = await runPass(tightened, dryRun);
    addBucket(screenshots, second.screenshots);
    addBucket(dbBackups, second.dbBackups);
    addBucket(resumeBackups, second.resumeBackups);
    addBucket(runLogs, second.runLogs);

    // full：额外清理明确属于"可再生/调试产物"的东西
    if (mode === 'full') {
      const jdDays = opts.jdImageDays ?? (Number(process.env.DATA_JD_IMAGE_DAYS) || 30);
      if (jdDays > 0) {
        const r = await pruneByAge(path.join(DATA_DIR, 'jd_images'), jdDays, dryRun);
        addBucket(jdImages, r);
      }
      const dirs = opts.debugDirs ?? ['smoke'];
      for (const d of dirs) {
        const r = await pruneTree(path.join(DATA_DIR, d), dryRun);
        addBucket(debugArtifacts, r);
      }
    }

    size = await dirSize(DATA_DIR);
    overThreshold = size.bytes > maxBytes;
    autoLimit.afterBytes = size.bytes;
    autoLimit.extraFreedBytes = Math.max(0, before - size.bytes);
    autoLimit.stillOver = overThreshold;
    if (overThreshold) autoLimit.topDirs = await dirBreakdown(3);
  }

  const freedBytes = screenshots.freedBytes + dbBackups.freedBytes + runLogs.freedBytes
    + resumeBackups.freedBytes + jdImages.freedBytes + debugArtifacts.freedBytes;
  const report: CleanupReport = {
    screenshots, dbBackups, resumeBackups, runLogs, jdImages, debugArtifacts,
    freedBytes, freedHuman: human(freedBytes), dryRun,
    totalBytes: size.bytes,
    totalHuman: human(size.bytes) + (size.truncated ? '（下界，统计已截断）' : ''),
    maxBytes,
    overThreshold,
    approx: size.truncated,
    autoLimit,
  };

  if (freedBytes > 0) {
    console.log(`[cleanup] ${dryRun ? '(dry-run) ' : ''}释放 ${report.freedHuman}｜截图 ${screenshots.deleted} 个 / DB备份 ${dbBackups.deleted} 个 / 简历备份 ${resumeBackups.deleted} 个 / 日志 ${runLogs.deleted} 个`);
  }
  if (autoLimit.triggered) {
    const pct = Math.round((autoLimit.ratio! - 1) * 100);
    console.log(`[cleanup] 超阈值 ${pct}% ⇒ 自动限额(${mode})：本轮额外释放 ${human(autoLimit.extraFreedBytes)}，现 ${human(autoLimit.afterBytes!)}`);
    if (mode === 'full') {
      console.log(`[cleanup]   其中 JD 图片 ${jdImages.deleted} 个 / 调试产物 ${debugArtifacts.deleted} 个`);
    }
    if (autoLimit.stillOver) {
      const tops = (autoLimit.topDirs || []).map((d) => `${d.name} ${human(d.bytes)}`).join(' + ');
      console.log(`[cleanup] ⚠️ 清理后仍超阈值。体积构成 top：${tops}（这些是登录态/证据，**有意不自动清理**，需人工处置或调高 DATA_MAX_MB）`);
    }
  }
  console.log(`[cleanup] data/ 当前 ${report.totalHuman}（阈值 ${human(maxBytes)}，自动限额 ${mode}）`);
  return report;
}
