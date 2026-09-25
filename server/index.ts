import "./env.js"; // 必须最先加载：解析根目录 .env 注入 process.env，使 LLM_*/MAIL_*/CODEBUDDY_* 生效
import express from "express";
import { query, unstable_v2_createSession, unstable_v2_authenticate, PermissionResult, CanUseTool } from "@tencent-ai/agent-sdk";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import * as db from "./db.js";
import { fetchLatestCode, listRecentMails, testConnection } from "./services/mail.js";
import { execAction, listSessions, closeAll } from "./services/browser.js";
import { relaunchAll, checkAllHealth, isPortUp } from "./services/browserHealth.js";
import { detectChromePath } from "./services/localEnv.js";
import { DEFAULT_CDP_PORTS, readCdpOverrides } from "./services/platformPorts.js";
import { probePlatformConnections, DELIVERY_PLATFORMS } from "./services/connection.js";
import { parseResumeFile, structureResume } from "./services/resume.js";
import { matchResumeToJobAi } from "./services/apply/matchAi.js";
import { tailorResume } from "./services/apply/resumeTailor.js";
import { ensureTailoredResumePdf } from "./services/apply/tailoredResumePdf.js";
import { isAiEnabled, getAiConfig } from "./services/apply/aiClient.js";
import { decideGreet, decideGreetBatch, DEFAULT_EXCLUDE_KEYWORDS } from "./services/apply/greetDecision.js";
import {
  composeCoverLetter, markLetterSent, letterAlreadySent,
  getLetterTemplate, saveLetterTemplate, clearLetterTemplate, renderLetterTemplate, TEMPLATE_VARIABLES,
} from "./services/apply/coverLetter.js";
import { buildInterviewPrep, getInterviewPrep, clearInterviewPrep } from "./services/apply/interviewPrep.js";
import { resumeVersionStatus, setResumeVersion, getResumeVersion, RESUME_VERSION_LABELS } from "./services/apply/resumeVersion.js";
import { listSchedules, setSchedule, getSchedule, describeSchedule, evaluateSchedule, advanceSchedule } from "./services/apply/schedule.js";
import { getExchangeActions, setExchangeActions, runExchangeActions, summarizeExchange, EXCHANGE_LABELS } from "./services/apply/exchangeContact.js";
import { ensureChatResumePng, decideResumeChannel, sendChatResumeImage, CHAT_IMAGE_INPUTS } from "./services/apply/chatResumeImage.js";
import { locateJobById } from "./services/apply/jobLocate.js";
import { runApply, isSupported, SUPPORTED_PLATFORMS } from "./services/apply/index.js";
import { computeAbReport, backfillLegacyStrategy } from "./services/apply/applyAbTest.js";
import { checkResumeCompliance } from "./services/apply/resumeCompliance.js";
import { toApplyProfile, recordFrames } from "./services/apply/common.js";
import { startRecording, stopRecording } from "./services/apply/screencast.js";
import {
  runBatchApply, resolveDailyLimit, todayAppliedCount,
  readPlatformRiskBlock, clearPlatformRiskBlock,
} from "./services/apply/batch.js";
import { rememberCurrentForm } from "./services/apply/offerbiu.js";
import { scanOfferbiuEmails } from "./services/offerbiuEmailScan.js";
import { runAutoReply } from "./services/apply/autoReplyRunner.js";
import { startWatcher, stopWatcher, watcherStatus, setWatchConfig, bootstrapWatcher, watchEmitter } from "./services/apply/autoReplyWatcher.js";
import { startWatcher as startApplyWatch, stopWatcher as stopApplyWatch, watcherStatus as applyWatchStatus, setWatchConfig as setApplyWatchConfig, bootstrapWatcher as bootstrapApplyWatch, watchEmitter as applyWatchEmitter } from "./services/apply/autoApplyWatcher.js";
import { collectOfferbiu, collectOfferbiuByKeywords } from "./services/offerbiuCollect.js";
import { probePlatformApi } from "./services/platformApi/bossOpenApi.js";
import { probePlatformHealthCached, summarizeHealth } from "./services/platformHealth.js";
import { cleanupData } from "./services/dataCleanup.js";
import { buildAllowedOrigins, checkRequestOrigin } from "./services/requestGuard.js";
import { isPipeNoise } from "./services/safeOp.js";
import { getAuthToken, isAuthEnabled, isAuthorizedStrict } from "./services/authToken.js";
import { queueErrorAlert, alertStatus, sendTestAlert } from "./services/errorAlert.js";
import { listCities, cityCount, findCity, isCitySupported, DEFAULT_CITY } from "./services/cities.js";
import { locateByIp } from "./services/geo.js";
import { JOB_APPLY_AGENT_PROMPT } from "../shared/agentPrompt.js";

const execAsync = promisify(exec);

/** 默认端口：与全部投递/采集脚本、控制台的 4400 约定保持一致（避免「开箱即坏」） */
const DEFAULT_PORT = 4400;

/** 本机 API 基础地址（写入 Agent 提示词） */
const API_BASE = process.env.APP_PUBLIC_URL || `http://127.0.0.1:${process.env.PORT || DEFAULT_PORT}`;

// 待处理的权限请求
interface PendingPermission {
  resolve: (result: PermissionResult) => void;
  reject: (error: Error) => void;
  toolName: string;
  input: Record<string, unknown>;
  sessionId: string;
  timestamp: number;
}

const pendingPermissions = new Map<string, PendingPermission>();

// 权限请求超时时间（5分钟）
const PERMISSION_TIMEOUT = 5 * 60 * 1000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || DEFAULT_PORT);
/** 监听地址：默认仅本机回环；如需局域网/其它设备访问，显式设 HOST=0.0.0.0（会暴露到内网） */
const HOST = process.env.HOST || '127.0.0.1';

// ── 运行日志：错误落盘，便于事后排查（data/run_log/YYYY-MM-DD.log）──
const RUN_LOG_DIR = path.join(__dirname, '..', 'data', 'run_log');
try { if (!fs.existsSync(RUN_LOG_DIR)) fs.mkdirSync(RUN_LOG_DIR, { recursive: true }); } catch { /* 忽略 */ }
const RUN_LOG_MAX_BYTES = Math.max(1, Number(process.env.RUN_LOG_MAX_MB) || 20) * 1024 * 1024;
let inLogRun = false;

function logRun(level: 'INFO' | 'ERROR', msg: string): void {
  // 重入守卫：日志写入过程本身出错时不再递归记录（自激放大的第二道防线）
  if (inLogRun) return;
  inLogRun = true;
  try {
    const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
    // console 可能因管道断开而同步抛错 —— 不能让它把主流程带崩
    try { if (level === 'ERROR') console.error(line); else console.log(line); } catch { /* 忽略 */ }
    try {
      const file = path.join(RUN_LOG_DIR, new Date().toISOString().slice(0, 10) + '.log');
      // 单文件体积上限：任何未预料的日志风暴都不该把磁盘写满（实测曾写到 240MB）
      let size = 0;
      try { size = fs.statSync(file).size; } catch { /* 文件不存在 */ }
      if (size < RUN_LOG_MAX_BYTES) fs.appendFileSync(file, line + '\n');
    } catch { /* 落盘失败不影响主流程 */ }
    // 无人值守告警：ERROR 额外走邮件通道（去重 + 节流，见 services/errorAlert.ts）
    if (level === 'ERROR') { try { queueErrorAlert(msg); } catch { /* 告警失败不影响主流程 */ } }
  } finally {
    inLogRun = false;
  }
}

// ── 安全中间件：JSON 体积 + CORS 白名单 + 写请求来源校验 ──
// 目的：防止任意网页调用本机 API 触发真实投递/发信（DNS-rebinding / 恶意页面静默调用）。
// 局域网多人共用：把对方访问地址加入 EXTRA_ORIGINS（如 http://192.168.1.20:4400），并把 HOST 设为 0.0.0.0。
app.use(express.json({ limit: '15mb' }));

// ── 安全响应头（2026-09-25 加固）──
// 关键：控制台会触发**真实副作用**（投递/发信），必须防「被任意站点 iframe 套娃 + 诱导点击」（点击劫持）。
// 来源校验拦不住**同源 iframe 内**的点击 —— 只有 frame-ancestors / X-Frame-Options 能拦。
// 控制台为单文件内联 JS（无外链、无 eval），故 script-src 保留 'unsafe-inline'，其余收紧。
app.use((_req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self' blob: data:; " +
      "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'",
  );
  next();
});

const ALLOWED_ORIGINS = buildAllowedOrigins(
  PORT,
  String(process.env.EXTRA_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  // 仅对白名单来源回显 CORS 头；不回显时浏览器侧会自动拒绝读取
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  const verdict = checkRequestOrigin({
    method: req.method,
    origin,
    secFetchSite: req.headers['sec-fetch-site'] as string | undefined,
    allowed: ALLOWED_ORIGINS,
  });
  if (!verdict.ok) { res.status(403).json({ error: verdict.reason }); return; }
  next();
});

// ── 访问令牌（可选鉴权）：仅写方法校验 ──
// 默认 HOST=127.0.0.1（回环）时关闭 → 本机自用零影响；
// 一旦暴露到局域网（HOST=0.0.0.0）自动开启，或显式 REQUIRE_AUTH=1 强制开启。
const AUTH_ENABLED = isAuthEnabled(HOST);
if (AUTH_ENABLED) {
  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    if (isAuthorizedStrict(req)) return next();
    res.status(401).json({ error: '缺少或无效的访问令牌（请在请求头带 X-Auth-Token，令牌见 data/.auth_token）' });
  });
  logRun('INFO', `访问令牌鉴权已开启（令牌文件 data/.auth_token）`);
}

// ── 5xx 统一落日志 + 告警 ──
// 多数路由自己 try/catch 后直接返回 500 JSON，不会走到终末错误中间件；
// 这里在响应结束时兜底统计，保证「接口真的挂了」也能进 run_log 并触发邮件告警。
app.use((req, res, next) => {
  res.on('finish', () => {
    if (res.statusCode >= 500 && !(res as any).__errLogged) {
      (res as any).__errLogged = true;
      logRun('ERROR', `HTTP ${res.statusCode} ${req.method} ${req.originalUrl}`);
    }
  });
  next();
});

// 静态资源：浏览器截图
const SCREENSHOT_DIR = path.join(__dirname, '..', 'data', 'screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
app.use('/data/screenshots', express.static(SCREENSHOT_DIR));

// 静态资源：投递操作证据截图（对标 CareerBoom.ai「每次投递生成操作录屏」）
const EVIDENCE_DIR = path.join(__dirname, '..', 'data', 'evidence');
if (!fs.existsSync(EVIDENCE_DIR)) fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
app.use('/data/evidence', express.static(EVIDENCE_DIR));

// 静态资源：一岗一简历生成的定制简历 PDF/HTML（供前端预览与下载）
const TAILORED_DIR = path.join(__dirname, '..', 'data', 'resume_tailored');
if (!fs.existsSync(TAILORED_DIR)) fs.mkdirSync(TAILORED_DIR, { recursive: true });
app.use('/data/resume_tailored', express.static(TAILORED_DIR));

// 静态资源：投递控制台（单一入口 App，public/console.html）
const CONSOLE_DIR = path.join(__dirname, '..', 'public');
if (!fs.existsSync(CONSOLE_DIR)) fs.mkdirSync(CONSOLE_DIR, { recursive: true });
// 控制台统一走 `/`（那里按需注入访问令牌）；直接开 /console.html 会拿到未注入令牌的页面
app.get('/console.html', (_req, res) => { res.redirect('/'); });

app.use(express.static(CONSOLE_DIR));
app.get("/", (_req, res) => {
  const file = path.join(CONSOLE_DIR, 'console.html');
  if (!AUTH_ENABLED) { res.sendFile(file); return; }
  // 鉴权开启：把令牌注入页面（同源，外部站点读不到），控制台 fetch 自动携带
  try {
    const html = fs.readFileSync(file, 'utf8').replace(
      '</head>',
      `<script>window.__AUTH_TOKEN__=${JSON.stringify(getAuthToken())};</script></head>`,
    );
    res.type('html').send(html);
  } catch {
    res.sendFile(file);
  }
});

// 缓存可用模型列表
let cachedModels: Array<{ modelId: string; name: string; description?: string }> = [];
const defaultModel = "claude-sonnet-4";

// 健康检查
app.get("/api/ping", (_req, res) => {
  // 极轻探活：不触碰 DB / AI / 浏览器，供脚本与 watchdog 判断「进程是否已就绪」
  res.json({ ok: true, uptimeMs: Math.round(process.uptime() * 1000) });
});
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString(), ai: isAiEnabled() });
});

// ── 首跑自检：把「还差什么才能投出第一份简历」变成可读清单 ──────────────────────
// 背景（2026-09-25 开箱实测）：接收方解压后对着控制台无从下手 —— 浏览器窗口没开、
// 简历没上传、平台没登录，界面不会告诉他「下一步做什么」；更糟的是缺少
// data/browser/cdp.json 时投递会退化成 Playwright 自带 Chromium 并报
// 「Chromium 浏览器未下载」，而 README 从未提过这个文件。本接口把这类前置条件显式化。
// 注意：只做**快速**探测（端口 TCP 探活，不导航页面）—— 避免像 /api/platforms/health
// 那样串行跑 15 个平台要 12s。
app.get("/api/selfcheck", async (_req, res) => {
  type Item = { id: string; label: string; status: 'ok' | 'todo' | 'warn'; detail: string };
  const items: Item[] = [];

  // 1) Node 运行时（自带 = 接收方无需安装）
  const bundledNode = fs.existsSync(path.join(__dirname, '..', 'node', 'node.exe'));
  items.push({
    id: 'runtime', label: 'Node 运行时', status: 'ok',
    detail: bundledNode ? '使用包内自带 node（无需另装）' : `使用系统 node ${process.version}`,
  });

  // 2) Chrome（CDP 调试窗口的前提）
  const chrome = detectChromePath();
  items.push({
    id: 'chrome', label: 'Google Chrome', status: chrome ? 'ok' : 'todo',
    detail: chrome || '未检测到 Chrome。请安装后重新启动：https://www.google.com/chrome/',
  });

  // 3) 平台端口表（内置默认即可工作，cdp.json 仅作覆盖）
  const overrides = readCdpOverrides();
  const overrideCount = Object.keys(overrides).length;
  items.push({
    id: 'ports', label: '平台端口表', status: 'ok',
    detail: overrideCount
      ? `data/browser/cdp.json 覆盖了 ${overrideCount} 项`
      : `使用内置默认端口（${Object.keys(DEFAULT_CDP_PORTS).length} 项），无需手工配置`,
  });

  // 4) 调试窗口是否已打开（并行探活，全失败也只需 ~1.2s）
  // ⚠️ start_all.bat 只开 5 个核心平台窗口（BOSS/猎聘/51job/智联/官网），而这里统计的是
  //    全部已登记端口 —— 首跑用户看到「已打开 5/15」却不知道剩下 10 个怎么开，
  //    所以把补齐方式直接写进 detail，而不是只报一个比例。
  const ports = Array.from(new Set(Object.values(DEFAULT_CDP_PORTS))).sort((a, b) => a - b);
  const aliveFlags = await Promise.all(ports.map((p) => isPortUp(p, 1200)));
  const alive = ports.filter((_, i) => aliveFlags[i]);
  const winHint = '其余平台：双击 start_platforms.bat（默认再开 9 个，加 all 全开），或在控制台对应平台卡片点「打开窗口」';
  items.push({
    id: 'windows', label: '平台调试窗口', status: alive.length ? 'ok' : 'todo',
    detail: alive.length
      ? `已打开 ${alive.length}/${ports.length} 个（端口 ${alive.join(', ')}）`
        + (alive.length < ports.length ? `。${winHint}` : '（已全部打开）')
      : `尚未打开任何平台窗口。双击 start_all.bat（开 5 个核心平台）或 start_platforms.bat 后重试`,
  });

  // 5) 简历（未上传则投递与「一岗一简历」都无法工作）
  // ⚠️ 这里给的**路径必须与控制台实际菜单一致**：原文写「我的档案」，
  //    而左侧导航根本没有这个入口（真实位置是「简历 → 简历中心 → 上传简历」）
  //    —— 首跑用户照着找不到，等于没给指引。
  const resumePath = path.join(RES_DATA, 'resume_source.pdf');
  const hasResume = fs.existsSync(resumePath);
  items.push({
    id: 'resume', label: '简历', status: hasResume ? 'ok' : 'todo',
    detail: hasResume
      ? `已上传（${Math.round(fs.statSync(resumePath).size / 1024)} KB）`
      : '尚未上传。左侧「简历 → 简历中心」→「上传简历」选 PDF / Word（≤8MB）——未上传时投递与「一岗一简历」都不可用',
  });

  // 6) AI（可选，缺失只降级不阻塞）
  const aiOn = isAiEnabled();
  items.push({
    id: 'ai', label: 'AI 能力（可选）', status: aiOn ? 'ok' : 'warn',
    detail: aiOn
      ? '已启用：语义匹配 + AI 文案 + AI 自动复聊'
      : '未配置 LLM_*：将使用「规则匹配 + 模板文案」，功能完整可用，仅质量略降',
  });

  const todo = items.filter((i) => i.status === 'todo').length;
  res.json({ ok: todo === 0, todo, items, checkedAt: new Date().toISOString() });
});

// 投递漏斗 + 匹配度看板（对照职得鸭「数据洞察」补齐的可视化数据层）
app.get("/api/stats/funnel", (_req, res) => {
  try {
    const rows = db.query<{ source: string; status: string; c: number }>(
      "SELECT source, status, COUNT(*) c FROM jobs GROUP BY source, status"
    );
    const scored = db.query<{ c: number; avg: number }>(
      "SELECT COUNT(*) c, AVG(match_score) avg FROM jobs WHERE match_score IS NOT NULL"
    )[0] || { c: 0, avg: 0 };
    const buckets = db.query<{ b: string; c: number }>(
      `SELECT CASE WHEN match_score>=70 THEN 'high' WHEN match_score>=40 THEN 'mid' ELSE 'low' END b, COUNT(*) c
       FROM jobs WHERE match_score IS NOT NULL GROUP BY b`
    );
    const quarantined = (db.query<{ c: number }>("SELECT COUNT(*) c FROM jobs WHERE quarantine IS NOT NULL")[0] || { c: 0 }).c;
    // 匹配分「依据来源」三分拆分。
    // ⚠️ 2026-09-19 起**取消了职位名兜底打分**（此前无 JD 时用职位名匹配并封顶 70，
    //    实测「BOSS 246 个高分里 242 个是兜底」，按匹配度排序等于随机排序）。
    // 所以现在是三档：真 JD / 卡片摘要（不是 JD，曾伪装成 JD）/ 完全无 JD。
    // 只报一个笼统的「JD 覆盖率」会让数字虚高（首轮就报过 89%，真实只有 26%）。
    const basis = db.query<{ title_only: number; jd_based: number; card_only: number; image_jd: number }>(
      `SELECT SUM(CASE WHEN jd IS NULL OR TRIM(jd)='' THEN 1 ELSE 0 END) title_only,
              SUM(CASE WHEN jd IS NOT NULL AND TRIM(jd)<>'' THEN 1 ELSE 0 END) jd_based,
              SUM(CASE WHEN (jd IS NULL OR TRIM(jd)='') AND card_text IS NOT NULL AND TRIM(card_text)<>'' THEN 1 ELSE 0 END) card_only,
              SUM(CASE WHEN jd_source='image' THEN 1 ELSE 0 END) image_jd
       FROM jobs`
    )[0] || { title_only: 0, jd_based: 0, card_only: 0, image_jd: 0 };
    const highWithJd = (db.query<{ c: number }>(
      "SELECT COUNT(*) c FROM jobs WHERE match_score>=70 AND jd IS NOT NULL AND TRIM(jd)<>''"
    )[0] || { c: 0 }).c;
    // 跳过原因分布（我们比职得鸭多的一层）：每条被跳过的岗位都有可读理由，
    // 按「原因前缀」归并后，能直接看出是哪条规则在大量误杀。
    const skipRows = db.query<{ reason: string; c: number }>(
      `SELECT skip_reason reason, COUNT(*) c FROM jobs
       WHERE skip_reason IS NOT NULL AND TRIM(skip_reason) <> ''
       GROUP BY skip_reason ORDER BY c DESC LIMIT 40`
    );
    const skipByRule: Record<string, number> = {};
    for (const r of skipRows) {
      const key = String(r.reason).split(/[（(:：]/)[0].trim().slice(0, 20) || '其他';
      skipByRule[key] = (skipByRule[key] || 0) + r.c;
    }
    const skipTotal = (db.query<{ c: number }>(
      "SELECT COUNT(*) c FROM jobs WHERE skip_reason IS NOT NULL AND TRIM(skip_reason) <> ''"
    )[0] || { c: 0 }).c;
    // 求职信台账：已写过多少封（三重去重的①号依据）
    const lettersSent = (db.query<{ c: number }>("SELECT COUNT(*) c FROM cover_letters")[0] || { c: 0 }).c;
    // 已定位（公司背调/岗位定位）过的岗位数
    const located = (db.query<{ c: number }>(
      "SELECT COUNT(*) c FROM app_kv WHERE key LIKE 'located:%'"
    )[0] || { c: 0 }).c;
    const bySource: Record<string, any> = {};
    let total = 0, applied = 0, candidate = 0, unavailable = 0;
    for (const r of rows) {
      bySource[r.source] = bySource[r.source] || { source: r.source, candidate: 0, applied: 0, unavailable: 0, total: 0 };
      bySource[r.source][r.status] = (bySource[r.source][r.status] || 0) + r.c;
      bySource[r.source].total += r.c;
      total += r.c;
      if (r.status === 'applied') applied += r.c; else if (r.status === 'candidate') candidate += r.c; else if (r.status === 'unavailable') unavailable += r.c;
    }
    const bucketMap = { high: 0, mid: 0, low: 0 };
    for (const b of buckets) bucketMap[b.b as 'high' | 'mid' | 'low'] = b.c;
    res.json({
      total,
      byStatus: { applied, candidate, unavailable },
      appliedRate: total ? Math.round((applied / total) * 100) : 0,
      quarantined,
      bySource: Object.values(bySource).sort((a: any, b: any) => b.total - a.total),
      matchScore: {
        scored: scored.c,
        coverage: total ? Math.round((scored.c / total) * 100) : 0,
        avg: scored.avg ? Math.round(scored.avg) : 0,
        high: bucketMap.high, mid: bucketMap.mid, low: bucketMap.low,
        /** 无 JD 的岗位（现在明确不给分，不参与按分数排序） */
        titleOnly: basis.title_only,
        /** 基于真实 JD 的岗位数 */
        jdBased: basis.jd_based,
        /** 其中：虽有"看起来像 JD"的文本、实为列表卡片摘要的（不是岗位描述） */
        cardTextOnly: basis.card_only,
        /** JD 为长图的岗位（微信校招推文：JD 是图片，已抓取可查看，但无法文本匹配） */
        imageJd: basis.image_jd,
        /** 真 JD 覆盖率（jdBased / total）—— 这是唯一可信的覆盖率口径 */
        realJdRate: total ? Math.round((basis.jd_based / total) * 100) : 0,
        /** 高匹配里真正基于 JD 的数量（这才是可信的高匹配） */
        highWithJd,
      },
      /** 跳过原因：total 为被主动跳过的岗位数，byRule 为按规则归并的分布 */
      skipReasons: {
        total: skipTotal,
        byRule: Object.entries(skipByRule).map(([rule, count]) => ({ rule, count })).sort((a, b) => b.count - a.count),
        samples: skipRows.slice(0, 12).map((r) => ({ reason: r.reason, count: r.c })),
      },
      /** 求职信台账条数（三重去重①的依据） */
      lettersSent,
      /** 已定位/背调过的岗位数 */
      located,
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "统计失败" });
  }
});

/** 平台可用性巡检：连接 / 登录态 / 风控 三合一结论 + 处置建议。
 *  ?deep=1（默认）会导航各平台页面做权威判定（约 8s/平台）；deep=0 只测 CDP 连接。
 *  用途：投递/采集前先看一眼，避免「跑完 50 个投出 0 个却不知道为什么」。 */
app.get("/api/platforms/health", async (req, res) => {
  try {
    const deep = req.query.deep !== '0';
    const list = String(req.query.platforms || '').split(',').map((s) => s.trim()).filter(Boolean);
    // 全量 deep 巡检会真实导航 15 个平台页面（约 12.7s），而控制台每次刷新都会调它
    // —— 故走 45s TTL 缓存；定向 platforms= 调用不缓存（见 platformHealth 注释）。
    // ?refresh=1 跳过缓存，用于人工要求"现在重测"。
    const { list: health, cached, ageMs } = await probePlatformHealthCached(
      list.length ? list : undefined, deep, req.query.refresh === '1',
    );
    res.json({ deep, summary: summarizeHealth(health, deep), platforms: health, cached, ageMs });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || '巡检失败' });
  }
});

/** 平台 API 通道自检：CDP 端点 / 登录态（关键鉴权 Cookie）/ 两条通道开关。
 *  用途：会话掉线巡检、诊断「登在本机日常 Chrome 而非调试窗口」的经典问题。 */
app.get("/api/platform-api/probe", async (req, res) => {
  try {
    // ?deep=1 时额外做页面级权威登录判定（导航首页，较慢但准确；默认只用 Cookie 弱信号）
    res.json(await probePlatformApi(req.query.deep === '1'));
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "探测失败" });
  }
});

// AI 能力状态（自动回复话术是否走大模型）：enabled=已配置 LLM_*；model=当前模型
app.get("/api/ai-status", (_req, res) => {
  const cfg = getAiConfig();
  res.json({ enabled: cfg !== null, model: cfg?.model || null, baseUrl: cfg?.baseUrl || null });
});

// 登录方式类型
type LoginMethod = 'env' | 'cli' | 'none';

interface LoginStatusResponse {
  isLoggedIn: boolean;
  method?: LoginMethod;
  envConfigured?: boolean;
  cliConfigured?: boolean;
  error?: string;
  apiKey?: string; // 脱敏后的 API Key
  envVars?: {
    apiKey?: string;
    authToken?: string;
    internetEnv?: string;
    baseUrl?: string;
  };
}

// 检查 CodeBuddy CLI 登录状态
app.get("/api/check-login", async (req, res) => {
  const response: LoginStatusResponse = {
    isLoggedIn: false,
    envConfigured: false,
    cliConfigured: false,
    envVars: {},
  };
  
  // 1. 检查环境变量
  const apiKey = process.env.CODEBUDDY_API_KEY;
  const authToken = process.env.CODEBUDDY_AUTH_TOKEN;
  const internetEnv = process.env.CODEBUDDY_INTERNET_ENVIRONMENT;
  const baseUrl = process.env.CODEBUDDY_BASE_URL;
  
  if (apiKey || authToken) {
    response.envConfigured = true;
    // 脱敏显示
    if (apiKey) {
      response.envVars!.apiKey = apiKey.slice(0, 8) + '****' + apiKey.slice(-4);
      response.apiKey = response.envVars!.apiKey;
    }
    if (authToken) {
      response.envVars!.authToken = authToken.slice(0, 8) + '****' + authToken.slice(-4);
    }
    if (internetEnv) {
      response.envVars!.internetEnv = internetEnv;
    }
    if (baseUrl) {
      response.envVars!.baseUrl = baseUrl;
    }
  }
  
  // ⚠️ 必须加超时护栏。实测（2026-09-25 开箱）：**未配置凭据时 `unstable_v2_authenticate`
  // 会永久挂起且不抛错** —— 本接口 60s 零响应、后端日志一片空白，前端按钮永久卡在
  // 「检查中…」且 disabled。开发机已登录 CodeBuddy 所以从未暴露，但**分发给他人后接收方必然触发**。
  // 可用 AUTH_CHECK_TIMEOUT_MS 调整（默认 8000ms）。
  const AUTH_TIMEOUT_MS = Number(process.env.AUTH_CHECK_TIMEOUT_MS) || 8000;
  let authTimer: NodeJS.Timeout | undefined;
  try {
    let needsLogin = false;
    
    const result = await Promise.race([
      unstable_v2_authenticate({
        environment: 'external',
        onAuthUrl: async (authState) => {
          // 如果执行到这个回调，说明未登录
          needsLogin = true;
          console.log('[Check Login] 需要登录，认证 URL:', authState.authUrl);
          // 将认证 URL 返回给前端（如果需要）
          response.error = '未登录，请先登录 CodeBuddy CLI';
        }
      }),
      new Promise<never>((_, reject) => {
        authTimer = setTimeout(
          () => reject(new Error(
            `登录检查超时（${AUTH_TIMEOUT_MS}ms）：多半是未配置 CODEBUDDY_API_KEY / CODEBUDDY_AUTH_TOKEN`
          )),
          AUTH_TIMEOUT_MS
        );
      }),
    ]);
    
    // 如果没有触发 onAuthUrl 回调，说明已登录
    if (!needsLogin && result?.userinfo) {
      response.isLoggedIn = true;
      response.cliConfigured = true;
      
      // 判断登录方式
      if (response.envConfigured) {
        response.method = 'env';
      } else {
        response.method = 'cli';
      }
      
      console.log('[Check Login] 已登录用户:', result.userinfo.userName);
    } else if (!needsLogin) {
      // result 存在但没有 userinfo，仍然认为已登录
      response.isLoggedIn = true;
      response.cliConfigured = true;
      response.method = response.envConfigured ? 'env' : 'cli';
    }
  } catch (error: any) {
    console.error("[Check Login] SDK Error:", error);
    
    // 如果有环境变量配置，仍然认为是登录状态
    if (response.envConfigured) {
      response.isLoggedIn = true;
      response.method = 'env';
    } else {
      response.error = error?.message || String(error);
      response.method = 'none';
    }
  } finally {
    // 成功路径也要清掉定时器，避免每次请求都留下一个 8s 的悬挂 Timer
    if (authTimer) clearTimeout(authTimer);
  }
  
  res.json(response);
});

// 保存环境变量配置
app.post("/api/save-env-config", (req, res) => {
  const { apiKey, authToken, internetEnv, baseUrl } = req.body;
  
  if (!apiKey && !authToken) {
    return res.status(400).json({ error: '请至少配置 API Key 或 Auth Token' });
  }
  
  const configuredVars: string[] = [];
  
  // 设置环境变量（仅在当前进程有效）
  if (apiKey) {
    process.env.CODEBUDDY_API_KEY = apiKey;
    configuredVars.push('CODEBUDDY_API_KEY');
  }
  if (authToken) {
    process.env.CODEBUDDY_AUTH_TOKEN = authToken;
    configuredVars.push('CODEBUDDY_AUTH_TOKEN');
  }
  if (internetEnv) {
    process.env.CODEBUDDY_INTERNET_ENVIRONMENT = internetEnv;
    configuredVars.push('CODEBUDDY_INTERNET_ENVIRONMENT');
  }
  if (baseUrl) {
    process.env.CODEBUDDY_BASE_URL = baseUrl;
    configuredVars.push('CODEBUDDY_BASE_URL');
  }
  
  // 清除模型缓存，以便重新获取
  cachedModels = [];
  
  res.json({ 
    success: true, 
    message: `已设置: ${configuredVars.join(', ')}`,
    note: '环境变量仅在当前服务器进程有效，重启后需要重新设置'
  });
});

// 获取可用模型列表
app.get("/api/models", async (req, res) => {
  try {
    if (cachedModels.length === 0) {
      console.log("[Models] Creating session to fetch available models...");
      
      const session = await unstable_v2_createSession({ 
        cwd: process.cwd()
      });
      
      console.log("[Models] Session created, calling getAvailableModels()...");
      const models = await session.getAvailableModels();
      console.log("[Models] Got", models.length, "models");
      
      if (models && Array.isArray(models)) {
        cachedModels = models;
      }
    }
    
    res.json({ 
      models: cachedModels.length > 0 ? cachedModels : [
        { modelId: "claude-sonnet-4", name: "Claude Sonnet 4" }
      ],
      defaultModel 
    });
  } catch (error: any) {
    console.error("[Models] Error:", error);
    res.json({
      models: [
        { modelId: "claude-sonnet-4", name: "Claude Sonnet 4" },
        { modelId: "claude-opus-4", name: "Claude Opus 4" }
      ],
      defaultModel,
      error: error?.message || String(error)
    });
  }
});

// ============= 求职者档案 API =============

app.get("/api/profile", (req, res) => {
  try {
    res.json({ profile: db.getProfile() });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "获取档案失败" });
  }
});

app.put("/api/profile", (req, res) => {
  try {
    const incoming = req.body?.profile ?? req.body ?? {};
    const merged = { ...db.getProfile(), ...incoming, updatedAt: new Date().toISOString() };
    db.saveProfile(merged);
    res.json({ success: true, profile: merged });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "保存档案失败" });
  }
});

// ============= 邮箱验证码 API =============

// 读取最新验证码
app.get("/api/mail/code", async (req, res) => {
  try {
    const sinceMinutes = Number(req.query.sinceMinutes || 10);
    const subjectKeyword = req.query.subjectKeyword as string | undefined;
    const result = await fetchLatestCode({ sinceMinutes, subjectKeyword });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ ok: false, error: error?.message || "读取验证码失败" });
  }
});

// 最近邮件列表（排查用）
app.get("/api/mail/recent", async (req, res) => {
  try {
    const limit = Number(req.query.limit || 10);
    res.json(await listRecentMails(limit));
  } catch (error: any) {
    res.status(500).json({ ok: false, error: error?.message || "读取邮件失败" });
  }
});

// 获取邮箱配置（授权码脱敏）
app.get("/api/mail/config", (req, res) => {
  const cfg = db.getMailConfig();
  res.json({
    config: cfg
      ? {
          email: cfg.email,
          imapHost: cfg.imap_host,
          imapPort: cfg.imap_port,
          useSsl: cfg.use_ssl === 1,
          hasAuthCode: Boolean(cfg.auth_code),
        }
      : { email: '', imapHost: 'imap.qq.com', imapPort: 993, useSsl: true, hasAuthCode: false },
  });
});

// 保存邮箱配置
app.post("/api/mail/config", async (req, res) => {
  try {
    const { email, authCode, imapHost, imapPort, useSsl, test } = req.body || {};
    if (!email) return res.status(400).json({ success: false, error: "邮箱地址不能为空" });

    db.saveMailConfig({ email, authCode, imapHost, imapPort, useSsl });

    if (test === false) {
      return res.json({ success: true, message: "配置已保存" });
    }
    // 默认保存后立刻验证连通性
    const result = await testConnection({ email, authCode, imapHost, imapPort, useSsl });
    res.json(
      result.ok
        ? { success: true, message: `邮箱连接成功（${result.host}）`, test: result }
        : { success: true, saved: true, warning: result.error, test: result }
    );
  } catch (error: any) {
    res.status(500).json({ success: false, error: error?.message || "保存邮箱配置失败" });
  }
});

// 测试邮箱连接
app.post("/api/mail/test", async (req, res) => {
  try {
    const result = await testConnection(req.body || {});
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ ok: false, error: error?.message || "测试连接失败" });
  }
});

// ============= 浏览器自动化 API =============

app.post("/api/browser/exec", async (req, res) => {
  try {
    const { platform = 'default', action, ...args } = req.body || {};
    if (!action) return res.status(400).json({ ok: false, error: "缺少 action 参数" });
    res.json(await execAction(String(platform), String(action), args));
  } catch (error: any) {
    res.status(500).json({ ok: false, error: error?.message || "浏览器操作失败" });
  }
});

app.get("/api/browser/sessions", (req, res) => {
  res.json({ sessions: listSessions() });
});

// 各平台「浏览器连接」状态（CDP 端口是否可达）：供控制台「自动识别有连接的投递」
app.get("/api/browser/connections", async (req, res) => {
  try {
    res.json({ connections: await probePlatformConnections() });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "连接检测失败" });
  }
});

app.post("/api/browser/close-all", async (req, res) => {
  await closeAll();
  res.json({ success: true });
});

// 浏览器自愈：检测所有管理端口，下线的一键按原 profile 拉起（登录态保留）。
// 等价于把外部 ensure_chrome.sh 搬进服务进程，可经 API 触发，无需手动跑脚本。
app.post("/api/browser/ensure-all", async (req, res) => {
  try {
    const result = await relaunchAll();
    const up = Object.values(result).filter(Boolean).length;
    res.json({ ok: true, result, up, total: Object.keys(result).length });
  } catch (error: any) {
    res.status(500).json({ ok: false, error: error?.message || "浏览器拉起失败" });
  }
});

// 浏览器端口健康诊断（只读，不拉起）。
app.get("/api/browser/health", async (req, res) => {
  try {
    res.json({ ok: true, health: await checkAllHealth() });
  } catch (error: any) {
    res.status(500).json({ ok: false, error: error?.message || "健康检查失败" });
  }
});

// ============= 投递记录 API =============

app.get("/api/applications", (req, res) => {
  try {
    const { platform, status } = req.query;
    let list = db.listApplications();
    if (platform) list = list.filter(a => a.platform === platform);
    if (status) list = list.filter(a => a.status === status);
    res.json({ applications: list, total: list.length });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "获取投递记录失败" });
  }
});

app.post("/api/applications", (req, res) => {
  try {
    const { id, platform, company, position, salary, city, jobUrl, status, loginMethod, message } = req.body || {};
    if (!platform) return res.status(400).json({ error: "platform 不能为空" });

    const app_ = db.createApplication({
      id: id || uuidv4(),
      platform: String(platform),
      company: company ?? null,
      position: position ?? null,
      salary: salary ?? null,
      city: city ?? null,
      job_url: jobUrl ?? null,
      status: status || 'applied',
      login_method: loginMethod ?? null,
      message: message ?? null,
    });
    res.json({ application: app_ });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "创建投递记录失败" });
  }
});

app.patch("/api/applications/:id", (req, res) => {
  try {
    const { platform, company, position, salary, city, jobUrl, status, loginMethod, message } = req.body || {};
    const success = db.updateApplication(req.params.id, {
      platform, company, position, salary, city,
      job_url: jobUrl, status, login_method: loginMethod, message,
    });
    if (!success) return res.status(404).json({ error: "记录不存在" });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "更新投递记录失败" });
  }
});

app.delete("/api/applications/:id", (req, res) => {
  try {
    const success = db.deleteApplication(req.params.id);
    if (!success) return res.status(404).json({ error: "记录不存在" });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "删除投递记录失败" });
  }
});

// ============= 简历解析 =============

app.post("/api/resume/parse", async (req, res) => {
  try {
    const { filePath } = req.body || {};
    const profile = db.getProfile();
    const target = filePath || profile?.resume_path;
    if (!target) return res.status(400).json({ error: "未提供简历路径，请在「我的档案」中填写简历文件路径" });
    const struct = await parseResumeFile(target);
    // 解析出的技能同步回档案，便于投递时引用
    if (struct.skills.length && profile) {
      const prevSkills = (profile.skills as string) || '';
      const merged = Array.from(new Set([...prevSkills.split(/[,，、]/).map(s => s.trim()).filter(Boolean), ...struct.skills]))
        .filter(Boolean).join('，');
      db.saveProfile({ ...profile, skills: merged });
    }
    res.json({
      filePath: target,
      name: struct.name,
      phone: struct.phone,
      email: struct.email,
      skills: struct.skills,
      education: struct.education,
      experience: struct.experience,
      projects: struct.projects,
      rawTextLength: struct.rawText.length,
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "简历解析失败" });
  }
});

// ============= 岗位池（Offerbiu / 手动） =============

app.get("/api/jobs", (req, res) => {
  try {
    const { source, status } = req.query;
    const list = db.listJobs({ source: source as string, status: status as string });
    res.json({ jobs: list, total: list.length });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "获取岗位失败" });
  }
});

/** 已抓取 JD 长图的岗位列表（微信校招推文：JD 是图片，供人工查看真实岗位内容） */
app.get("/api/jobs/image-jd", (_req, res) => {
  try {
    const rows = db.query<{ id: string; company: string | null; position: string | null; jd_images: string | null }>(
      "SELECT id, company, position, jd_images FROM jobs WHERE jd_source='image' AND jd_images IS NOT NULL AND TRIM(jd_images)<>'' ORDER BY updated_at DESC LIMIT 500",
    );
    const items = rows.map((r) => {
      let image = '';
      try { image = (JSON.parse(r.jd_images || '[]') as Array<{ local?: string }>)[0]?.local || ''; } catch { /* ignore */ }
      return { id: r.id, company: r.company, position: r.position, image };
    }).filter((x) => x.image);
    res.json({ total: items.length, items });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "查询失败" });
  }
});

/** 远程岗位统计（对标 Resumly「远程岗位筛选」） */
app.get("/api/jobs/remote-stat", (_req, res) => {
  try {
    const rows = db.query<{ remote: number | null }>("SELECT remote FROM jobs");
    let remote = 0, nonRemote = 0, unknown = 0;
    for (const r of rows) {
      if (r.remote === 1) remote++;
      else if (r.remote === 0) nonRemote++;
      else unknown++;
    }
    res.json({ total: rows.length, remote, nonRemote, unknown });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "查询失败" });
  }
});

/** 存量岗位远程标记回填：对所有 remote 为 NULL 的岗位按文本重新识别 */
app.post("/api/jobs/backfill-remote", (_req, res) => {
  try {
    const r = db.backfillRemoteJobs();
    res.json({ ok: true, scanned: r.scanned, updated: r.updated });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "回填失败" });
  }
});

/** 微信图片JD 的 OCR 回填状态统计（按 ocr_status 分组 + 待处理量） */
app.get("/api/jobs/ocr-status", (_req, res) => {
  try {
    const rows = db.query<{ ocr_status: string | null; c: number }>(
      "SELECT COALESCE(ocr_status,'pending') ocr_status, COUNT(*) c FROM jobs WHERE jd_source='image' GROUP BY ocr_status",
    );
    const stat: Record<string, number> = { pending: 0, done: 0, failed: 0 };
    for (const r of rows) stat[r.ocr_status ?? 'pending'] = r.c;
    res.json({ ...stat, imageTotal: stat.pending + stat.done + stat.failed });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "查询失败" });
  }
});

/** 触发微信图片JD 的 OCR 回填（后台 spawn 脚本，立即返回 pending 量，进度见运行日志/报告） */
app.post("/api/jobs/ocr-backfill", (req, res) => {
  try {
    const body = (req.body || {}) as { limit?: number; model?: string; retryFailed?: boolean };
    const args: string[] = [];
    if (body.limit) args.push("--limit", String(body.limit));
    if (body.model) args.push("--model", String(body.model));
    if (body.retryFailed) args.push("--retry-failed");
    const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/ocr_wechat_jd.ts", ...args], {
      cwd: path.join(__dirname, ".."),
      detached: false,
      stdio: "ignore",
    });
    child.on("error", (e) => console.error("[ocr-backfill] spawn 失败:", e.message));
    const pending = db.query<{ c: number }>(
      "SELECT COUNT(*) c FROM jobs WHERE jd_source='image' AND (jd IS NULL OR TRIM(jd)='') AND (ocr_status IS NULL OR ocr_status='pending')",
    )[0]?.c || 0;
    res.json({ ok: true, pending, started: true, note: "已在后台启动，稍后到「职位记录」查看识别结果，或 GET /api/jobs/ocr-status 看进度" });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "启动失败" });
  }
});

// ── 运行日志 / OCR 失败明细（供控制台「运行日志」视图，只读） ──
const OCR_FAILED_DIR = path.join(__dirname, "..", "data", "ocr_failed");

app.get("/api/logs/run", (req, res) => {
  try {
    const qRaw = String(req.query.q || "").trim();
    const q = qRaw.toLowerCase();
    const level = String(req.query.level || "").trim().toUpperCase();
    const limit = Math.min(2000, Number(req.query.limit) || 500);
    let dates: string[] = [];
    try {
      dates = fs.readdirSync(RUN_LOG_DIR).filter((f) => f.endsWith(".log")).map((f) => f.replace(/\.log$/, "")).sort().reverse();
    } catch { /* 尚无日志目录 */ }
    const date = String(req.query.date || "").trim() || dates[0] || "";
    const lines: Array<{ ts: string; level: string; msg: string }> = [];
    if (date) {
      const fp = path.join(RUN_LOG_DIR, date + ".log");
      if (fs.existsSync(fp)) {
        for (const ln of fs.readFileSync(fp, "utf-8").split("\n")) {
          const m = ln.match(/^\[([^\]]+)\]\s*\[([A-Z]+)\]\s*(.*)$/);
          if (!m) continue;
          const rec = { ts: m[1], level: m[2], msg: m[3] };
          if (level && rec.level !== level) continue;
          if (q && !(rec.msg.toLowerCase().includes(q) || rec.ts.toLowerCase().includes(q))) continue;
          lines.push(rec);
        }
      }
    }
    lines.reverse(); // 最新在前
    res.json({ dates, date, level, q: qRaw, total: lines.length, lines: lines.slice(0, limit) });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "读取运行日志失败" });
  }
});

app.get("/api/logs/ocr-failed", (req, res) => {
  try {
    const qRaw = String(req.query.q || "").trim();
    const q = qRaw.toLowerCase();
    let files: string[] = [];
    try {
      files = fs.readdirSync(OCR_FAILED_DIR).filter((f) => f.endsWith(".txt"));
    } catch { /* 尚无失败明细 */ }
    const MAX = 4000;
    const items: Array<{ jobId: string; company: string; position: string; chars: number; at: string; text: string; truncated: boolean }> = [];
    for (const f of files) {
      const jobId = f.replace(/\.txt$/, "");
      let text = "";
      let at = "";
      try {
        const fp = path.join(OCR_FAILED_DIR, f);
        text = fs.readFileSync(fp, "utf-8");
        at = new Date(fs.statSync(fp).mtimeMs).toISOString();
      } catch { continue; }
      let company = "";
      let position = "";
      try {
        const row = db.query<{ company: string; position: string }>("SELECT company, position FROM jobs WHERE id=?", [jobId])[0];
        company = row?.company || "";
        position = row?.position || "";
      } catch { /* 忽略 */ }
      if (q && !(`${company} ${position} ${text}`.toLowerCase().includes(q))) continue;
      items.push({ jobId, company, position, chars: text.length, at, text: text.slice(0, MAX), truncated: text.length > MAX });
    }
    items.sort((a, b) => (a.at < b.at ? 1 : -1));
    res.json({ total: items.length, q: qRaw, items });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "读取 OCR 失败明细失败" });
  }
});

app.get("/api/logs/summary", (req, res) => {
  try {
    const days = Math.min(14, Math.max(1, Number(req.query.days) || 1));
    let files: string[] = [];
    try {
      files = fs.readdirSync(RUN_LOG_DIR).filter((f) => f.endsWith(".log")).sort().reverse().slice(0, days);
    } catch { /* 尚无日志目录 */ }
    let total = 0;
    const errs: Array<{ ts: string; msg: string }> = [];
    for (const f of files) {
      try {
        for (const ln of fs.readFileSync(path.join(RUN_LOG_DIR, f), "utf-8").split("\n")) {
          const m = ln.match(/^\[([^\]]+)\]\s*\[([A-Z]+)\]\s*(.*)$/);
          if (!m) continue;
          total++;
          if (m[2] === "ERROR") errs.push({ ts: m[1], msg: m[3] });
        }
      } catch { /* 跳过单个文件 */ }
    }
    errs.sort((a, b) => (a.ts < b.ts ? 1 : -1));
    let ocrFailed = 0;
    try {
      ocrFailed = fs.readdirSync(OCR_FAILED_DIR).filter((f) => f.endsWith(".txt")).length;
    } catch { /* 忽略 */ }
    res.json({ days, files: files.length, total, errors: errs.length, lastError: errs[0] || null, ocrFailed, alert: alertStatus() });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "读取日志摘要失败" });
  }
});

// 主动发一封测试告警邮件，验证「运行异常 → 邮件提醒」链路是否打通
app.post("/api/logs/alert-test", async (_req, res) => {
  try {
    const r = await sendTestAlert();
    if (!r.ok) return res.status(400).json({ error: r.error || "发送失败", to: r.to || null });
    res.json({ ok: true, to: r.to, note: "测试告警已发送，请查收邮箱（含垃圾箱）" });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "发送测试告警失败" });
  }
});

app.post("/api/jobs", (req, res) => {
  try {
    const { id, source, company, position, city, jd, requirements, salary, applyUrl, deadline } = req.body || {};
    if (!company && !position) return res.status(400).json({ error: "company / position 至少填一个" });
    const job = db.upsertJob({
      id, source, company: company ?? null, position: position ?? null, city: city ?? null,
      jd: jd ?? null, requirements: requirements ?? null, salary: salary ?? null,
      apply_url: applyUrl ?? null, deadline: deadline ?? null,
    });
    res.json({ job });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "创建岗位失败" });
  }
});

app.patch("/api/jobs/:id", (req, res) => {
  try {
    const ok = db.updateJob(req.params.id, req.body || {});
    if (!ok) return res.status(404).json({ error: "岗位不存在" });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "更新岗位失败" });
  }
});

app.delete("/api/jobs/:id", (req, res) => {
  try {
    const ok = db.deleteJob(req.params.id);
    if (!ok) return res.status(404).json({ error: "岗位不存在" });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "删除岗位失败" });
  }
});

// 用简历对岗位池批量打分并排序
app.post("/api/jobs/match", async (req, res) => {
  try {
    const { filePath, source, status } = req.body || {};
    const profile = db.getProfile();
    const target = filePath || profile?.resume_path;
    if (!target) return res.status(400).json({ error: "未配置简历路径，无法匹配。请先在「我的档案」填写简历文件路径，或请求中带 filePath" });
    const struct = await parseResumeFile(target);
    const jobs = db.listJobs({ source: source as string, status: status as string });
    const ranked = await Promise.all(jobs.map(async (job) => {
      const r = await matchResumeToJobAi({ resumeBlob: struct.searchBlob, resumeSkills: struct.skills, jd: job.jd || '', requirements: job.requirements || '', position: job.position || '' });
      db.updateJob(job.id, { match_score: r.score, match_detail: JSON.stringify({ matched: r.matched, missing: r.missing, suggestions: r.suggestions }) });
      return { ...job, match_score: r.score, match_detail: { matched: r.matched, missing: r.missing, suggestions: r.suggestions } };
    }));
    ranked.sort((a, b) => (b.match_score ?? -1) - (a.match_score ?? -1));
    res.json({
      resumeName: struct.name,
      skills: struct.skills,
      total: ranked.length,
      jobs: ranked,
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "匹配失败" });
  }
});

/** 一岗一简历：按目标岗位 JD 定制简历片段（LLM 优先，失败回退本地规则）。
 *  入参：{ jobId } 取岗位池中的岗位；或直接传 { job: {position, company, jd, requirements} }。
 *  产出：定制「核心优势」+ 技能按岗位相关度重排 + 命中/待补分析 + Markdown。 */
app.post("/api/jobs/tailor", async (req, res) => {
  try {
    const profile = (db.getProfile() as Record<string, any>) || {};
    let job = req.body?.job;
    if (!job && req.body?.jobId) {
      const j = db.getJob(String(req.body.jobId));
      if (!j) return res.status(404).json({ error: "岗位不存在" });
      job = { id: j.id, company: j.company, position: j.position, jd: j.jd, requirements: j.requirements };
    }
    if (!job) return res.status(400).json({ error: "请提供 jobId 或 job 对象" });
    const result = await tailorResume(profile, job);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "定制失败" });
  }
});

// 从 Offerbiu 校招信息库采集岗位（需用户已在该浏览器上下文登录；采集结果入库为岗位池）
app.post("/api/offerbiu/collect", async (req, res) => {
  try {
    // pages：翻页数（实测 /companies/ 共 912 页 / 8201 条；默认只采第 1 页）
    const { limit = 50, pages = 1 } = req.body || {};
    const result = await collectOfferbiu(Number(limit) || 50, Number(pages) || 1);
    res.json({ collected: result.collected, jobs: result.jobs });
  } catch (error: any) {
    const status = /尚未登录/.test(error?.message || '') ? 401 : 500;
    res.status(status).json({ error: error?.message || '采集失败' });
  }
});

// 记录「当前官网页面」的表单字段到记忆（按域名）：人工补填后调用，下次同站自动填写
app.post("/api/offerbiu/remember-form", async (_req, res) => {
  try {
    const r = await rememberCurrentForm();
    res.json({ ok: true, site: r.site, saved: r.saved, fields: r.fields, logs: r.logs });
  } catch (error: any) {
    res.status(500).json({ ok: false, error: error?.message || '记录失败' });
  }
});

// 按关键词采集 offerbiu 岗位（利用列表页搜索框精准筛选：匿名也能拿到大量对口岗位）
app.post("/api/offerbiu/collect-keywords", async (req, res) => {
  try {
    const { keywords, pagesPerKeyword = 3, perKeyword = 27 } = req.body || {};
    const kws: string[] = Array.isArray(keywords)
      ? keywords.map((k: unknown) => String(k)).filter(Boolean)
      : String(keywords || '').split(/[,，、;；\s]+/).map((s) => s.trim()).filter(Boolean);
    if (!kws.length) return res.status(400).json({ error: 'keywords 不能为空' });
    const r = await collectOfferbiuByKeywords(kws, {
      pagesPerKeyword: Number(pagesPerKeyword) || 3,
      perKeyword: Number(perKeyword) || 27,
    });
    res.json({ collected: r.collected, perKeyword: r.perKeyword });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || '关键词采集失败' });
  }
});

// ============= Offerbiu 邮箱直投（无需登录；offerbiu 上真正可规模化的自动投递路径） =============

/** 扫描 offerbiu 岗位中的招聘邮箱（SSE 进度 + 末尾 found 事件） */
app.post("/api/offerbiu/scan-emails", async (req, res) => {
  const { limit, offset, hrLikeOnly, settleMs, workers } = req.body || {};
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (e: unknown) => { res.write(`data: ${JSON.stringify(e)}\n\n`); };
  try {
    const r = await scanOfferbiuEmails({
      limit: Number(limit) || 20,
      offset: Number(offset) || 0,
      hrLikeOnly: hrLikeOnly !== false,
      settleMs: settleMs ? Number(settleMs) : undefined,
      workers: workers ? Number(workers) : 1,
      onProgress: (ev) => send(ev),
    });
    send({ type: 'found', scanned: r.scanned, found: r.found });
    res.write('event: end\ndata: {}\n\n');
  } catch (error: any) {
    send({ type: 'error', message: error?.message || '扫描失败' });
  } finally {
    res.end();
  }
});

/** 一岗一简历：为指定岗位生成「按 JD 定制」的简历 PDF，返回路径与定制摘要。
 *  入参 { jobId } 或 { job }；force=true 强制重生成。
 *  产出文件在 data/resume_tailored/，可作为投递附件（email-apply 传 tailor:true 会自动调用本逻辑）。 */
app.post("/api/jobs/tailor-resume", async (req, res) => {
  try {
    const profile = (db.getProfile() as Record<string, any>) || {};
    let job = req.body?.job;
    if (!job && req.body?.jobId) {
      const j = db.getJob(String(req.body.jobId));
      if (!j) return res.status(404).json({ error: '岗位不存在' });
      job = { id: j.id, company: j.company, position: j.position, jd: j.jd, requirements: j.requirements };
    }
    if (!job) return res.status(400).json({ error: '请提供 jobId 或 job 对象' });
    const r = await ensureTailoredResumePdf(job, { profile, force: req.body?.force === true });
    if (!r.ok) return res.status(500).json(r);
    res.json({ ...r, url: `/data/resume_tailored/${path.basename(r.pdfPath!)}` });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || '定制简历生成失败' });
  }
});

/** 打招呼决策（对标职得鸭 /api/ai/checkAutoChat，但我们返回可读理由）
 *  入参：{ jobId } 或 { jobIds: [] }；apply=true 时把 skip_reason 落到 jobs 表。
 *  决策顺序：硬规则（已回复/已写过/已投过/不可投/隔离/排除词/城市/匹配度）→ AI → 兜底。 */
app.post("/api/jobs/greet-decision", async (req, res) => {
  try {
    const profile = (db.getProfile() as Record<string, any>) || {};
    const opts = {
      minScore: req.body?.minScore !== undefined ? Number(req.body.minScore) : undefined,
      useAi: req.body?.useAi !== false,
      excludeKeywords: Array.isArray(req.body?.excludeKeywords) ? req.body.excludeKeywords.map(String) : undefined,
    };
    const ids: string[] = Array.isArray(req.body?.jobIds) ? req.body.jobIds.map((x: unknown) => String(x))
      : req.body?.jobId ? [String(req.body.jobId)] : [];
    if (!ids.length) return res.status(400).json({ error: '请提供 jobId 或 jobIds' });

    const jobs = ids.map((id) => db.getJob(id)).filter(Boolean) as ReturnType<typeof db.getJob>[];
    const results = await decideGreetBatch(jobs as any[], profile, opts);

    if (req.body?.apply === true) {
      for (const { job, decision } of results) {
        db.updateJob(job!.id, { skip_reason: decision.greet ? null : decision.reason });
      }
    }
    res.json({
      total: results.length,
      greet: results.filter((r) => r.decision.greet).length,
      skip: results.filter((r) => !r.decision.greet).length,
      applied: req.body?.apply === true,
      results: results.map(({ job, decision }) => ({
        jobId: job!.id, company: job!.company, position: job!.position,
        greet: decision.greet, reason: decision.reason, source: decision.source,
        score: decision.score ?? null, evidence: decision.evidence || [],
      })),
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || '打招呼决策失败' });
  }
});

/** 生成/预览求职信（对标职得鸭 type2「AI写求职信」）
 *  入参：{ jobId, kind: 'hello'|'letter'|'reply', mode: 'ai'|'custom', chatHistory?, hrGroupId?, save? }
 *  save=true 时写入 cover_letters 台账（后续三重去重会挡住重复发送）。 */
app.post("/api/jobs/cover-letter", async (req, res) => {
  try {
    const profile = (db.getProfile() as Record<string, any>) || {};
    let job: any = req.body?.job;
    if (!job && req.body?.jobId) {
      const j = db.getJob(String(req.body.jobId));
      if (!j) return res.status(404).json({ error: '岗位不存在' });
      job = { id: j.id, company: j.company, position: j.position, jd: j.jd, requirements: j.requirements, city: j.city };
    }
    if (!job) return res.status(400).json({ error: '请提供 jobId 或 job 对象' });

    const r = await composeCoverLetter({
      platform: String(req.body?.platform || job.source || 'boss'),
      kind: req.body?.kind || 'letter',
      mode: req.body?.mode === 'custom' ? 'custom' : 'ai',
      job,
      jd: req.body?.jd || job.jd || null,
      chatHistory: req.body?.chatHistory || null,
      hrGroupId: req.body?.hrGroupId || null,
      hrReplied: req.body?.hrReplied === true,
      profile,
      templateContent: req.body?.templateContent || null,
    });

    if (r.ok && req.body?.save === true && !r.skipped) {
      markLetterSent({
        platform: String(req.body?.platform || job.source || 'boss'),
        job, hrGroupId: req.body?.hrGroupId || null,
        content: r.content, source: r.source,
      });
    }
    res.json(r);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || '求职信生成失败' });
  }
});

/** 自定义求职信模板（含可用变量清单）。GET 读取，POST 保存，DELETE 清空。 */
app.get("/api/cover-letter/template", (_req, res) => {
  res.json({ template: getLetterTemplate(), variables: TEMPLATE_VARIABLES });
});
app.post("/api/cover-letter/template", (req, res) => {
  try {
    const name = String(req.body?.name || '未命名模板');
    const content = String(req.body?.content || '');
    if (!content.trim()) return res.status(400).json({ error: '模板内容不能为空' });
    res.json({ ok: true, template: saveLetterTemplate(name, content), variables: TEMPLATE_VARIABLES });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || '模板保存失败' });
  }
});
app.delete("/api/cover-letter/template", (_req, res) => {
  clearLetterTemplate();
  res.json({ ok: true });
});

/** 投递效果 A/B 测试报告（对标 LoopCV）：按 strategy 聚合回复率/面试率，给出胜出策略 */
app.get("/api/apply/ab-report", (_req, res) => {
  try {
    const report = computeAbReport();
    res.json(report);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'A/B 报告生成失败' });
  }
});

/** 存量数据回填：给未打标的历史投递补 `legacy` 标签（仅运行一次；不改变 A/B 结论） */
app.post("/api/apply/ab-backfill", (_req, res) => {
  try {
    const n = backfillLegacyStrategy();
    res.json({ ok: true, backfilled: n });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || '回填失败' });
  }
});

/** 投递操作证据回溯清单：返回带 evidence_path 的投递（公司/职位/平台/证据路径/时间/策略），供前端「录屏回溯」面板展示 */
app.get("/api/apply/evidence", (_req, res) => {
  try {
    const rows = db.listApplications(1000).filter((a: any) => a.evidence_path || a.video_path);
    const items = rows.map((a: any) => ({
      id: a.id,
      platform: a.platform,
      company: a.company,
      position: a.position,
      evidence_path: a.evidence_path,
      video_path: a.video_path || null,
      strategy: a.strategy || null,
      status: a.status,
      created_at: a.created_at,
    }));
    res.json({ ok: true, total: items.length, items });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || '证据清单读取失败' });
  }
});

/** 近 N 天投递趋势（O3）：按日聚合 applications（键与 created_at 同为 UTC 日，避免跨时区错位） */
app.get("/api/stats/trend", (req, res) => {
  try {
    const days = Math.max(1, Math.min(30, Number(req.query.days) || 7));
    const rows = db.listApplications(5000) as any[];
    const keys: string[] = [];
    for (let i = days - 1; i >= 0; i--) keys.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
    const buckets = new Map<string, number>(keys.map((k) => [k, 0]));
    let counted = 0;
    for (const a of rows) {
      const k = String(a.created_at || '').slice(0, 10);
      if (buckets.has(k)) { buckets.set(k, (buckets.get(k) || 0) + 1); counted++; }
    }
    const items = [...buckets.entries()].map(([date, count]) => ({ date, count }));
    res.json({ ok: true, days, total: counted, max: Math.max(1, ...items.map((i) => i.count)), items });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || '趋势读取失败' });
  }
});

/** 手动开始操作录屏（真·CDP screencast）。批量投递请用 batch 的 `record` 开关自动录/停 */
app.post("/api/apply/record-video/start", async (req, res) => {
  try {
    const platform = String(req.body?.platform || '').trim();
    if (!isSupported(platform)) {
      return res.status(400).json({ error: `不支持的平台：${platform || '(空)'}（可录制：${SUPPORTED_PLATFORMS.join(' / ')}）` });
    }
    const r = await startRecording(platform, {
      dir: `evidence/vid-${platform}-${Date.now()}`,
      maxFrames: Number(req.body?.maxFrames) || 1500,
      maxSeconds: Number(req.body?.maxSeconds) || 240,
      quality: Number(req.body?.quality) || 55,
    });
    res.json(r);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || '启动录屏失败' });
  }
});

/** 停止操作录屏并归档（生成 play.html；本机有 ffmpeg 时另出 mp4） */
app.post("/api/apply/record-video/stop", async (req, res) => {
  try {
    const platform = String(req.body?.platform || '').trim();
    if (!platform) return res.status(400).json({ error: '缺少 platform' });
    const r = await stopRecording(platform);
    res.json(r);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || '停止录屏失败' });
  }
});

/** 过程抽帧录制（对标 CareerBoom.ai 录屏；本实现是**抽帧序列**而非视频，见 recordFrames 注释） */
app.get("/api/apply/record", async (req, res) => {
  try {
    const platform = String(req.query.platform || '').trim();
    if (!isSupported(platform)) {
      return res.status(400).json({ error: `不支持的平台：${platform || '(空)'}（可录制：${SUPPORTED_PLATFORMS.join(' / ')}）` });
    }
    const r = await recordFrames(platform, {
      seconds: Number(req.query.seconds) || 8,
      intervalMs: Number(req.query.intervalMs) || 1200,
    });
    res.json(r);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || '录制失败' });
  }
});

/** 简历合规检测（对标 LoopCV「简历合规检测 / ATS 体检」）：纯本地、可离线、结果可复现 */
app.post("/api/resume/compliance", (req, res) => {
  try {
    const profile = (db.getProfile() as Record<string, any>) || {};
    const report = checkResumeCompliance({
      profile: req.body?.useProfile === false ? null : profile,
      resumeText: req.body?.resumeText || null,
      jd: req.body?.jd || null,
    });
    res.json(report);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || '简历体检失败' });
  }
});

/** 模板试渲染：把变量替换后返回，方便前端所见即所得地预览 */
app.post("/api/cover-letter/render", (req, res) => {
  const tpl = String(req.body?.content || '');
  const vars = (req.body?.vars && typeof req.body.vars === 'object') ? req.body.vars : {};
  res.json({ rendered: renderLetterTemplate(tpl, vars) });
});

/** 面试攻略（对标职得鸭「面试鸭攻略」）。GET 读缓存，POST 生成（force 重算）。 */
app.get("/api/jobs/interview-prep", (req, res) => {
  const jobId = String(req.query.jobId || '');
  if (!jobId) return res.status(400).json({ error: '请提供 jobId' });
  const cached = getInterviewPrep(jobId);
  if (!cached) return res.status(404).json({ error: '尚无该岗位的面试攻略，请先生成', cached: false });
  res.json({ ...cached, cached: true });
});
app.post("/api/jobs/interview-prep", async (req, res) => {
  try {
    const jobId = String(req.body?.jobId || '');
    if (!jobId) return res.status(400).json({ error: '请提供 jobId' });
    const job = db.getJob(jobId);
    if (!job) return res.status(404).json({ error: '岗位不存在' });
    const profile = (db.getProfile() as Record<string, any>) || {};
    const r = await buildInterviewPrep(profile, job, { force: req.body?.force === true });
    if (req.body?.clear === true) clearInterviewPrep(jobId);
    res.json({ ...r, jobId, company: job.company, position: job.position, aiEnabled: isAiEnabled() });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || '面试攻略生成失败' });
  }
});

/** 简历版本（original / optimized / tailored）——对标职得鸭 resumeType 开关 */
app.get("/api/resume/version", (_req, res) => {
  res.json(resumeVersionStatus());
});
app.post("/api/resume/version", (req, res) => {
  const v = setResumeVersion(String(req.body?.version || 'original'));
  res.json({ ok: true, version: v, label: RESUME_VERSION_LABELS[v], status: resumeVersionStatus() });
});

// ============= 简历上传（落盘 + 自动解析） =============
const RES_DATA = path.dirname(TAILORED_DIR); // data/
const RES_META_PATH = path.join(RES_DATA, 'resume_meta.json');
function readResMeta() { try { return JSON.parse(fs.readFileSync(RES_META_PATH, 'utf-8')); } catch { return {}; } }
function writeResMeta(m: any) { fs.writeFileSync(RES_META_PATH, JSON.stringify(m, null, 2)); }
function resFileFor(version: string) {
  return version === 'optimized' ? path.join(RES_DATA, 'resume_optimized.pdf') : path.join(RES_DATA, 'resume_source.pdf');
}

app.post("/api/resume/upload", async (req, res) => {
  try {
    const { fileName, data, version } = req.body || {};
    const ver = version === 'optimized' ? 'optimized' : 'original';
    if (!data || typeof data !== 'string') return res.status(400).json({ error: '未收到文件数据' });
    let buf;
    try { buf = Buffer.from(data, 'base64'); } catch { return res.status(400).json({ error: '文件数据解码失败' }); }
    if (buf.length === 0) return res.status(400).json({ error: '文件为空' });
    if (buf.length > 8 * 1024 * 1024) return res.status(400).json({ error: '文件过大（上限 8MB）' });
    const isPdf = buf.slice(0, 4).toString('latin1') === '%PDF';
    const isDocx = buf.slice(0, 2).toString('latin1') === 'PK';
    if (!isPdf && !isDocx) return res.status(400).json({ error: '仅支持 PDF / Word(.docx) 简历' });
    const target = resFileFor(ver);
    if (fs.existsSync(target)) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      try { fs.renameSync(target, target + '.bak.' + ts); } catch {}
    }
    fs.writeFileSync(target, buf);
    const profile = db.getProfile();
    profile[ver === 'optimized' ? 'optimized_resume_path' : 'resume_path'] = target;
    db.saveProfile(profile);
    const meta = readResMeta();
    meta[ver] = { fileName: fileName || path.basename(target), size: buf.length, uploadedAt: new Date().toISOString() };
    writeResMeta(meta);
    let parsed = undefined, warning = undefined;
    // ⚠️ 2026-09-25 修复：此前只对 PDF 解析，.docx 即便能保存也**不参与匹配/定制**。
    //    而解析管线（resume.ts 的 extractResumeText）本就支持 PDF/DOCX/TXT（DOCX 走 mammoth）——
    //    限制纯粹来自这里，去掉即可让 Word 简历同样进入匹配与定制。
    try {
      const struct = await parseResumeFile(target);
      if (Array.isArray(struct.skills) && struct.skills.length) {
        const cur: any = db.getProfile();
        const prev: any = (cur.skills as any) || '';
        const merged = Array.from(new Set([
          ...prev.split(/[,，、]/).map((x: string) => String(x).trim()).filter(Boolean),
          ...struct.skills,
        ])).filter(Boolean).join('，');
        db.saveProfile(Object.assign({}, cur, { skills: merged }));
      }
      parsed = { name: struct.name, phone: struct.phone, email: struct.email, skills: (struct.skills || []).length, projects: (struct.projects || []).length, rawTextLength: (struct.rawText || '').length };
      if (struct.rawText.trim().length < 30) {
        warning = '简历已保存，但抽取到的文本极少（可能是扫描件/图片版）——匹配与定制效果会受限，建议上传文字版 PDF 或 DOCX。';
      }
    } catch (e: any) { warning = '简历已保存，但自动解析失败：' + (e && e.message ? e.message : e); }
    res.json({ ok: true, version: ver, path: target, meta: meta[ver], parsed, warning });
  } catch (error: any) {
    res.status(500).json({ error: (error && error.message) ? error.message : '简历上传失败' });
  }
});

app.get("/api/resume/current", (_req, res) => {
  const meta = readResMeta();
  const build = (ver: string) => {
    const target = resFileFor(ver);
    const m = meta[ver];
    return { exists: fs.existsSync(target), size: fs.existsSync(target) ? fs.statSync(target).size : 0, fileName: m && m.fileName, uploadedAt: m && m.uploadedAt, url: '/api/resume/file?version=' + ver };
  };
  res.json({ status: resumeVersionStatus(), original: build('original'), optimized: build('optimized') });
});

app.get("/api/resume/file", (req, res) => {
  const ver = String(req.query.version) === 'optimized' ? 'optimized' : 'original';
  const target = resFileFor(ver);
  if (!fs.existsSync(target)) return res.status(404).json({ error: '简历文件不存在' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="' + path.basename(target) + '"');
  fs.createReadStream(target).pipe(res);
});

/** 运行时间段调度（对标职得鸭 TimeManager）。GET 全平台，POST 设置单平台。 */
app.get("/api/schedule", (_req, res) => {
  res.json({
    schedules: listSchedules().map((s) => ({ ...s, description: describeSchedule(s.platform), status: evaluateSchedule(s.platform) })),
  });
});
app.post("/api/schedule", (req, res) => {
  try {
    const platform = String(req.body?.platform || '');
    if (!platform) return res.status(400).json({ error: '请提供 platform' });
    const saved = setSchedule(platform, {
      enabled: req.body?.enabled,
      slots: Array.isArray(req.body?.slots) ? req.body.slots : undefined,
      reset: req.body?.reset === true,
    });
    res.json({ ok: true, schedule: saved, description: describeSchedule(platform), status: evaluateSchedule(platform) });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || '时间段保存失败' });
  }
});
app.post("/api/schedule/advance", (req, res) => {
  const platform = String(req.body?.platform || '');
  if (!platform) return res.status(400).json({ error: '请提供 platform' });
  res.json({ ok: true, schedule: advanceSchedule(platform) });
});

/** 猎聘「交换联系方式」配置与执行（发简历 / 换手机号 / 换微信号） */
app.get("/api/exchange/actions", (_req, res) => {
  res.json({ actions: getExchangeActions(), labels: EXCHANGE_LABELS, options: Object.entries(EXCHANGE_LABELS).map(([value, label]) => ({ value, label })) });
});
app.post("/api/exchange/actions", (req, res) => {
  res.json({ ok: true, actions: setExchangeActions(req.body?.actions) });
});
app.post("/api/exchange/run", async (req, res) => {
  try {
    const actions = Array.isArray(req.body?.actions) ? req.body.actions : getExchangeActions();
    const logs = new (await import("./services/apply/common.js")).ApplyLogger();
    const results = await runExchangeActions('liepin', actions, logs);
    res.json({ ok: results.every((r) => r.outcome !== 'failed'), summary: summarizeExchange(results), results, logs: logs.logs });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || '交换动作执行失败' });
  }
});

/** 简历「聊天图」通道：生成 PNG（可顺带发到当前聊天框）。
 *  入参 { jobId, send?: boolean }；返回 PNG 路径，可静态访问 /data/resume_tailored/<file>.png */
app.post("/api/jobs/chat-resume", async (req, res) => {
  try {
    const jobId = String(req.body?.jobId || '');
    if (!jobId) return res.status(400).json({ error: '请提供 jobId' });
    const job = db.getJob(jobId);
    if (!job) return res.status(404).json({ error: '岗位不存在' });
    const profile = (db.getProfile() as Record<string, any>) || {};
    const png = await ensureChatResumePng(
      { id: job.id, company: job.company, position: job.position, jd: job.jd, requirements: job.requirements },
      { profile, force: req.body?.force === true },
    );
    if (!png.ok) return res.status(500).json(png);
    let sent: { ok: boolean; detail: string } | null = null;
    if (req.body?.send === true) {
      sent = await sendChatResumeImage(job.source, png.pngPath!);
    }
    res.json({
      ...png, sent,
      url: `/data/resume_tailored/${path.basename(png.pngPath!)}`,
      note: 'PNG 聊天图用于「平台内聊天」场景；若该岗位有 HR 邮箱，建议改用 PDF 邮件通道（可被 ATS 解析）',
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || '聊天简历图生成失败' });
  }
});

/** 简历通道决策：给定岗位（是否已有 HR 邮箱），返回该走哪条通道以及理由 */
app.post("/api/resume/channel", (req, res) => {
  const platform = String(req.body?.platform || '');
  const hasEmail = req.body?.hasEmail === true;
  res.json({ ...decideResumeChannel({ hasEmail, platform }), chatImagePlatforms: Object.keys(CHAT_IMAGE_INPUTS) });
});

/** 岗位定位 / 公司背调（对标职得鸭 bossSearch.js，即前端所谓「AI公司背调」）
 *  入参 { jobId, platform? } —— BOSS 走「公司 → 在招职位 → 职位」两级定位，其他平台直达详情页。 */
app.post("/api/jobs/locate", async (req, res) => {
  try {
    const jobId = String(req.body?.jobId || '');
    if (!jobId) return res.status(400).json({ error: '请提供 jobId' });
    const r = await locateJobById(jobId, req.body?.platform ? String(req.body.platform) : undefined);
    res.json(r);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || '岗位定位失败' });
  }
});

/** 排除词表（打招呼决策的默认排除项，前端只读展示） */
app.get("/api/jobs/exclude-keywords", (_req, res) => {
  res.json({ keywords: DEFAULT_EXCLUDE_KEYWORDS });
});

/** 对指定岗位批量「邮箱直投」（channel=email + realSend，SSE 进度） */
app.post("/api/offerbiu/email-apply", async (req, res) => {
  const jobIds: string[] = Array.isArray(req.body?.jobIds) ? req.body.jobIds.map((x: unknown) => String(x)) : [];
  /** 一岗一简历开关：true 时先按各岗位 JD 生成定制 PDF，作为本次投递的附件 */
  const tailor = req.body?.tailor === true;
  /** 预取证邮箱映射（jobId -> 已核验 HR 邮箱）：提供后邮箱通道跳过页面重抽，规避微信限流 */
  const emails: Record<string, string> = req.body?.emails && typeof req.body.emails === 'object' ? req.body.emails : {};
  const intervalMs = Math.max(0, Number(req.body?.intervalMs ?? 8000));
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (e: unknown) => { res.write(`data: ${JSON.stringify(e)}\n\n`); };
  const profile = db.getProfile() as Record<string, unknown> | undefined;
  let ok = 0, fail = 0;
  try {
    if (!jobIds.length) {
      send({ type: 'error', message: '未选择任何岗位' });
      return;
    }
    if (!profile?.email) {
      send({ type: 'error', message: '档案未配置邮箱，无法发信。请先在「我的档案」填写邮箱与授权码' });
      return;
    }

    // 一岗一简历：投递前先按各岗位 JD 生成定制 PDF（串行，带内容哈希缓存，重复投递不会重算）
    const resumeOverrides: Record<string, string> = {};
    if (tailor) {
      send({ type: 'progress', index: 0, total: jobIds.length, message: '一岗一简历：正在按 JD 生成定制简历…' });
      let tailored = 0;
      for (const jid of jobIds) {
        const j = db.getJob(jid);
        if (!j) continue;
        const r = await ensureTailoredResumePdf(
          { id: j.id, company: j.company, position: j.position, jd: j.jd, requirements: j.requirements },
          { profile },
        ).catch((e: any) => ({ ok: false, error: e?.message } as any));
        if (r.ok && r.pdfPath) {
          resumeOverrides[j.id] = r.pdfPath;
          tailored++;
          send({ type: 'progress', index: tailored, total: jobIds.length, jobId: j.id, company: j.company, position: j.position, message: `定制简历已生成（匹配度 ${r.matchScore ?? '-'}，${r.cached ? '缓存命中' : '新生成'}）` });
        } else {
          send({ type: 'progress', index: tailored, total: jobIds.length, jobId: j.id, message: `定制简历生成失败，将回退固定简历：${r.error || '未知错误'}` });
        }
      }
      send({ type: 'progress', index: jobIds.length, total: jobIds.length, message: `一岗一简历就绪：${tailored}/${jobIds.length} 份定制简历` });
    }

    for (let i = 0; i < jobIds.length; i++) {
      const job = db.getJob(jobIds[i]);
      if (!job) { fail++; send({ type: 'result', jobId: jobIds[i], status: 'error', message: '岗位不存在' }); continue; }
      // 跨公司串号隔离：扫描阶段已标记的 quarantine 默认跳过，避免简历发错公司（force 可强制）
      if (job.quarantine && !req.body?.force) {
        fail++; send({ type: 'result', jobId: job.id, status: 'skipped', message: `已隔离（${job.quarantine}）；如需投递请勾选强制` });
        continue;
      }
      send({ type: 'progress', index: i, total: jobIds.length, jobId: job.id, company: job.company, position: job.position });
      try {
        const r = await runApply({
          platform: 'offerbiu',
          jobUrl: job.apply_url || undefined,
          job: { id: job.id, company: job.company, position: job.position, apply_url: job.apply_url },
          profile: toApplyProfile(profile),
          autofill: (profile.autofill as Record<string, string>) || undefined,
          channel: 'email',
          realSend: true,
          // 安全不变量：即便是"邮箱直投"这条会真实发信的路径，也要尊重「仅预览」——
          // 传了 preview:true 就只解析收件人/正文，不真正发信（dryRun 会拦下发送）。
          preview: req.body?.preview === true,
          dryRun: req.body?.preview === true,
          email: emails[job.id] || undefined,
          /** 一岗一简历：该岗位的定制 PDF（未生成成功则不传 → 回退固定简历） */
          resumeOverride: resumeOverrides[job.id],
        });
        if (r.status === 'applied') {
          ok++;
          try {
            db.createApplication({
              id: uuidv4(),
              platform: 'offerbiu',
              company: r.company || job.company || '',
              position: r.position || job.position || '',
              salary: job.salary || '',
              city: job.city || '',
              job_url: job.apply_url || '',
              status: 'applied',
              login_method: 'email',
              message: '邮箱直投（Offerbiu 招聘邮箱）',
            });
            db.updateJob(job.id, { status: 'applied' });
          } catch { /* 记录失败不阻断 */ }
        } else {
          fail++;
        }
        send({ type: 'result', jobId: job.id, status: r.status, company: r.company || job.company, message: r.message });
      } catch (e: any) {
        fail++;
        send({ type: 'result', jobId: job.id, status: 'error', company: job.company, message: e?.message || String(e) });
      }
      if (i < jobIds.length - 1 && intervalMs > 0) await new Promise((rr) => setTimeout(rr, intervalMs));
    }
    send({ type: 'done', ok, fail, total: jobIds.length });
    res.write('event: end\ndata: {}\n\n');
  } catch (error: any) {
    send({ type: 'error', message: error?.message || '邮箱直投失败' });
  } finally {
    res.end();
  }
});

// ============= 城市选择与定位 =============

/**
 * 城市列表（供控制台「目标城市」下拉）。
 * ?q=关键 模糊过滤；?platform=boss 会带上该城市在该平台是否可用（无码的平台返回 supported=false）。
 */
app.get("/api/cities", (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const platform = String(req.query.platform || "").trim();
    const cities = listCities(q).map((c) => ({
      name: c.name,
      province: c.province,
      boss: c.boss,
      pinyin: c.pinyin || null,
      supported: platform ? isCitySupported(platform, c.name) : true,
    }));
    res.json({ total: cityCount(), matched: cities.length, default: DEFAULT_CITY, cities });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "读取城市列表失败" });
  }
});

/**
 * 通过出口 IP 定位当前城市（控制台「📍定位」按钮）。
 * 只返回**建议值**，不直接改档案 —— 由前端确认后写入，避免静默覆盖用户设置。
 */
app.get("/api/geo/locate", async (_req, res) => {
  try {
    const loc = await locateByIp();
    const city = loc.city ? findCity(loc.city) : null;
    res.json({
      ...loc,
      /** 是否命中内置城市表（命中才能拿到各平台城市码） */
      inCityTable: Boolean(city),
      matchedName: city?.name || null,
      matchedProvince: city?.province || null,
      bossCode: city?.boss || null,
      supportedPlatforms: city ? DELIVERY_PLATFORMS.filter((p) => isCitySupported(p, city.name)) : [],
      note: loc.city
        ? (city ? `定位到「${city.name}」（${city.province}）` : `定位到「${loc.city}」，但不在内置城市表中，可手动填写`)
        : "定位失败（可能是网络受限）：请手动选择城市",
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "定位失败" });
  }
});

// ============= 跨平台批量连投（自动筛选 + 投递） =============

/**
 * 今日投递配额使用情况（只读）。
 * 平台对骚扰式批量投递有账号级处罚，所以把"今天还能投几份"显式暴露出来，
 * 而不是让用户投到被封号才发现。
 */
app.get("/api/apply/quota", (req, res) => {
  try {
    const platform = String(req.query.platform || "").trim();
    const limit = resolveDailyLimit();
    const used = todayAppliedCount(platform || undefined);
    // 平台级风控封锁（上一批命中额度到顶/账号异常后写入）：封锁期内批量投递会直接短路
    const block = platform ? readPlatformRiskBlock(platform) : null;
    res.json({
      platform: platform || null,
      used,
      limit,
      remaining: limit > 0 ? Math.max(0, limit - used) : null,
      unlimited: limit <= 0,
      blocked: Boolean(block),
      blockedUntil: block ? new Date(block.until).toISOString() : null,
      blockedMinutesLeft: block ? Math.max(1, Math.ceil((block.until - Date.now()) / 60_000)) : null,
      blockedReason: block?.reason || null,
      note: limit > 0
        ? `今日已投 ${used}/${limit}（${platform || "全部平台"}）；上限可用 APPLY_DAILY_LIMIT 环境变量或请求里的 dailyLimit 调整，0=不限制`
        : "未设每日上限（不推荐）",
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "查询配额失败" });
  }
});

/** 手动解除平台风控封锁（运维用；用户确认已在浏览器里人工处理好风控后调用） */
app.post("/api/apply/risk-unblock", (req, res) => {
  try {
    const platform = String(req.body?.platform || "").trim();
    if (!platform) return res.status(400).json({ error: "请提供 platform" });
    clearPlatformRiskBlock(platform);
    res.json({ ok: true, platform, message: `已解除「${platform}」的风控封锁（请确认已人工处理完平台验证，否则很快会再次触发）` });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || "解除封锁失败" });
  }
});

app.post("/api/apply/batch", async (req, res) => {
  try {
    const {
      platform, source, criteria, collect, limit, headless, sinceMinutes, intervalMs, stream, realSend, preview,
    } = req.body || {};

    if (platform && platform !== 'auto' && !isSupported(platform)) {
      return res.status(400).json({ error: `不支持的平台：${platform}（支持：boss / zhilian / job51 / nowcoder / offerbiu，或 auto 自动路由）` });
    }

    // 修复：引擎是按 source 过滤岗位库的（db.listJobs({source})），不是按 platform。
    // 只传 platform 时会拿其它平台的岗位去投（例如选 nowcoder 却投了 boss 的岗位），
    // 因此 source 未显式指定时，让它跟随 platform。
    const effectiveSource = source ?? (platform && platform !== 'auto' ? platform : undefined);

    const input = {
      platform,
      source: effectiveSource,
      criteria,
      collect: (collect === 'offerbiu' ? 'offerbiu' : false) as false | 'offerbiu',
      realSend: realSend === true,
      // 平台通道只读预览（dry-run）：零真实投递地验证链路
      preview: preview === true,
      limit: limit ? Number(limit) : 10,
      headless: headless === true,
      sinceMinutes: sinceMinutes ? Number(sinceMinutes) : 10,
      intervalMs: intervalMs != null ? Number(intervalMs) : 20000,
    };

    // 流式模式：用 SSE 实时推送进度与「需要输入」事件，便于前端弹窗提示
    if (stream === true) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      const send = (e: unknown) => { res.write(`data: ${JSON.stringify(e)}\n\n`); };
      req.on('close', () => { /* 客户端断开：事件循环会继续跑完，只停止推送 */ });
      try {
        await runBatchApply(input, (e) => send(e));
        res.write('event: end\ndata: {}\n\n');
      } catch (error: any) {
        send({ type: 'error', message: error?.message || '批量投递失败' });
      } finally {
        res.end();
      }
      return;
    }

    const result = await runBatchApply(input);
    res.json(result);
  } catch (error: any) {
    console.error('[batch] 未捕获异常:', error?.stack || error);
    res.status(500).json({ error: error?.message || '批量投递失败' });
  }
});

// ============= 跨平台专用投递（BOSS / 智联） =============

// ============= BOSS HR 消息自动回复（SSE 流式，控制台可视化） =============

let autoReplyController: AbortController | null = null;

app.get("/api/auto-reply/run", async (req, res) => {
  const q = req.query || {};
  const unreadOnly = q.unreadOnly !== '0' && q.unreadOnly !== 'false';
  const limit = Number(q.limit || 0) || 0;
  const realSend = q.realSend === '1' || q.realSend === 'true';
  const platform = typeof q.platform === 'string' && ['boss', 'liepin'].includes(q.platform) ? q.platform : 'boss';
  // useAi：是否用大模型生成话术。默认 true（API 已配置时自动启用，未配置自动回退规则）。
  // 传 useAi=0/false 可强制走规则模板。
  const useAi = q.useAi !== '0' && q.useAi !== 'false';
  // name：只处理指定 HR 名，支持逗号分隔或多个同名参数（与 CLI --name 对齐）。
  const names: string[] = [];
  const rawName = q.name;
  if (typeof rawName === 'string' && rawName.trim()) {
    names.push(...rawName.split(',').map((s) => s.trim()).filter(Boolean));
  } else if (Array.isArray(rawName)) {
    names.push(...rawName.map((s) => String(s).trim()).filter(Boolean));
  }

  if (autoReplyController) {
    return res.status(409).json({ error: '自动回复正在运行，请先停止' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  autoReplyController = new AbortController();
  const signal = autoReplyController.signal;

  // signAi：是否在回复中署名 AI 身份（如「【懒懒】」）。默认由 profile.signAi 决定（缺省 true）；
  // 仅在显式传 signAi=0/false 时强制不署名（CLI / 调试用）。
  const opts: Record<string, unknown> = { unreadOnly, limit, realSend, signal, useAi, names };
  if (q.signAi === '0' || q.signAi === 'false') opts.signAi = false;
  const send = (ev: Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };

  try {
    await runAutoReply(platform as any, opts as any, send);
  } catch (e: unknown) {
    send({ type: 'error', message: String((e as Error)?.message || e) });
  } finally {
    autoReplyController = null;
    send({ type: 'end' });
    res.end();
  }
});

app.post("/api/auto-reply/stop", (_req, res) => {
  if (autoReplyController) {
    autoReplyController.abort();
    autoReplyController = null;
  }
  res.json({ ok: true });
});

// ============= 自动回复常驻监视器（按时效自动跟进 HR 消息） =============
app.post("/api/auto-reply/watch/start", (_req, res) => {
  startWatcher();
  res.json({ ok: true, status: watcherStatus() });
});
app.post("/api/auto-reply/watch/stop", (_req, res) => {
  stopWatcher();
  res.json({ ok: true, status: watcherStatus() });
});
app.post("/api/auto-reply/watch/config", (req, res) => {
  const body = req.body || {};
  const patch: Record<string, unknown> = {};
  for (const k of ['enabled', 'platforms', 'intervalSec', 'realSend', 'useAi', 'throttleSec', 'maxPerRun', 'hrCooldownSec'] as const) {
    if (body[k] !== undefined) patch[k] = body[k];
  }
  setWatchConfig(patch as any);
  res.json({ ok: true, status: watcherStatus() });
});
app.get("/api/auto-reply/watch/status", (_req, res) => {
  res.json(watcherStatus());
});
// 监视器实时日志（SSE）：订阅 watchEmitter 的 tick 事件推给控制台
app.get("/api/auto-reply/watch", (_req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (ev: Record<string, unknown>) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  send({ type: 'status', ...watcherStatus() });
  const onTick = (payload: unknown) => send({ type: 'tick', ...(payload as Record<string, unknown>) });
  watchEmitter.on('tick', onTick);
  const keep = setInterval(() => res.write(': ping\n\n'), 15000);
  const close = () => {
    clearInterval(keep);
    watchEmitter.off('tick', onTick);
    res.end();
  };
  _req.on('close', close);
});

// ============= 批量投递常驻监视器（后台自动连投，受会话锁约束不与自动回复互抢） =============
app.post("/api/auto-apply/watch/start", (_req, res) => {
  startApplyWatch();
  res.json({ ok: true, status: applyWatchStatus() });
});
app.post("/api/auto-apply/watch/stop", (_req, res) => {
  stopApplyWatch();
  res.json({ ok: true, status: applyWatchStatus() });
});
app.post("/api/auto-apply/watch/config", (req, res) => {
  const body = req.body || {};
  const patch: Record<string, unknown> = {};
  for (const k of ['enabled', 'platforms', 'keyword', 'limit', 'intervalSec', 'intervalMs'] as const) {
    if (body[k] !== undefined) patch[k] = body[k];
  }
  setApplyWatchConfig(patch as any);
  res.json({ ok: true, status: applyWatchStatus() });
});
app.get("/api/auto-apply/watch/status", (_req, res) => {
  res.json(applyWatchStatus());
});
app.get("/api/auto-apply/watch", (_req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (ev: Record<string, unknown>) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  send({ type: 'status', ...applyWatchStatus() });
  const onTick = (payload: unknown) => send({ type: 'tick', ...(payload as Record<string, unknown>) });
  applyWatchEmitter.on('tick', onTick);
  const keep = setInterval(() => res.write(': ping\n\n'), 15000);
  const close = () => {
    clearInterval(keep);
    applyWatchEmitter.off('tick', onTick);
    res.end();
  };
  _req.on('close', close);
});

app.post("/api/apply", async (req, res) => {
  try {
    const { platform, jobId, jobUrl, headless, sinceMinutes, action, keyword, maxPages, maxApply, hrGroupId, chatHistory, jdText, channel, preview } = req.body || {};
    if (!isSupported(platform)) {
      return res.status(400).json({ error: `不支持的平台：${platform}（可直接投递：${SUPPORTED_PLATFORMS.join(' / ')}）` });
    }
    const profile = db.getProfile() as Record<string, unknown> | undefined;
    if (!profile?.email) {
      return res.status(400).json({ error: '档案未配置邮箱，无法读取登录验证码。请先在「我的档案」填写邮箱与授权码' });
    }
    let job: any = null;
    if (jobId) job = db.getJob(jobId);
    const targetUrl = jobUrl || job?.apply_url || undefined;

    const result = await runApply({
      platform,
      jobUrl: targetUrl,
      job: job ? { id: job.id, company: job.company, position: job.position, apply_url: job.apply_url } : undefined,
      // 带上学历/学校/专业/城市/技能：官网邮箱投递常要求按「学历+专业+学校+姓名」拼标题
      profile: toApplyProfile(profile),
      autofill: (profile.autofill as Record<string, string>) || undefined,
      headless: headless === true, // 默认非无头(false)，便于人工过滑块；传 true 才无头
      sinceMinutes: sinceMinutes ? Number(sinceMinutes) : 10,
      action: action || 'hello',
      keyword: keyword ? String(keyword) : undefined,
      maxPages: maxPages ? Number(maxPages) : undefined,
      maxApply: maxApply ? Number(maxApply) : undefined,
      hrGroupId: hrGroupId ? String(hrGroupId) : undefined,
      chatHistory: chatHistory ? String(chatHistory) : undefined,
      jdText: jdText ? String(jdText) : undefined,
      channel: channel === 'email' ? 'email' : 'auto',
      // ⚠️ 2026-09-21 修复：此前单岗接口**没有透传 preview** —— 传了 preview:true 也会走真实点击路径。
      //    实测踩到：本想做"零副作用预览"，结果真的点了国聘的「申请职位」按钮。
      //    预览是安全不变量，任何调用 runApply 的入口都必须透传。
      preview: preview === true,
      // preview 同时也是 offerbiu 官网/邮箱通道的 dry-run 信号（保持"仅预览"语义一致）
      dryRun: req.body?.dryRun === true || preview === true,
      realSend: req.body?.realSend === true,
    });

    // 投递成功 -> 写投递记录 + 更新岗位状态
    if (result.status === 'applied' && (jobId || job)) {
      const PLATFORM_LABEL: Record<string, string> = {
        boss: 'BOSS直聘', zhilian: '智联招聘', job51: '前程无忧', liepin: '猎聘', nowcoder: '牛客网', offerbiu: '企业官网(Offerbiu)',
      };
      try {
        db.createApplication({
          id: uuidv4(),
          platform,
          company: result.company || job?.company || '',
          position: result.position || job?.position || '',
          salary: job?.salary || '',
          city: job?.city || '',
          job_url: targetUrl || '',
          status: 'applied',
          login_method: 'email',
          message: `由专用投递脚本完成（${PLATFORM_LABEL[platform] || platform}）；匹配分 ${job?.match_score ?? '—'}`,
        });
        if (jobId) db.updateJob(jobId, { status: 'applied' });
      } catch { /* 记录失败不阻断主流程 */ }
    }

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error?.message || '投递失败' });
  }
});

// ============= 会话 API =============

// 获取所有会话（包含消息数量）
app.get("/api/sessions", (req, res) => {
  try {
    const sessions = db.getAllSessions();
    const sessionsWithMessages = sessions.map(session => {
      const messages = db.getMessagesBySession(session.id);
      return {
        ...session,
        messageCount: messages.length
      };
    });
    res.json({ sessions: sessionsWithMessages });
  } catch (error: any) {
    console.error("[Sessions] Error:", error);
    res.status(500).json({ error: error?.message || "获取会话失败" });
  }
});

// 获取单个会话及其消息
app.get("/api/sessions/:sessionId", (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = db.getSession(sessionId);
    
    if (!session) {
      return res.status(404).json({ error: "会话不存在" });
    }
    
    const messages = db.getMessagesBySession(sessionId);
    
    // 解析 tool_calls JSON
    const parsedMessages = messages.map(msg => ({
      ...msg,
      tool_calls: msg.tool_calls ? JSON.parse(msg.tool_calls) : null
    }));
    
    res.json({ session, messages: parsedMessages });
  } catch (error: any) {
    console.error("[Session] Error:", error);
    res.status(500).json({ error: error?.message || "获取会话失败" });
  }
});

// 创建新会话
app.post("/api/sessions", (req, res) => {
  try {
    const { model = defaultModel, title = "新对话" } = req.body;
    const now = new Date().toISOString();
    
    const session = db.createSession({
      id: uuidv4(),
      title,
      model,
      sdk_session_id: null,
      created_at: now,
      updated_at: now
    });
    
    res.json({ session });
  } catch (error: any) {
    console.error("[Create Session] Error:", error);
    res.status(500).json({ error: error?.message || "创建会话失败" });
  }
});

// 更新会话
app.patch("/api/sessions/:sessionId", (req, res) => {
  try {
    const { sessionId } = req.params;
    const { title, model } = req.body;
    
    const success = db.updateSession(sessionId, { title, model });
    
    if (!success) {
      return res.status(404).json({ error: "会话不存在" });
    }
    
    res.json({ success: true });
  } catch (error: any) {
    console.error("[Update Session] Error:", error);
    res.status(500).json({ error: error?.message || "更新会话失败" });
  }
});

// 删除会话
app.delete("/api/sessions/:sessionId", (req, res) => {
  try {
    const { sessionId } = req.params;
    const success = db.deleteSession(sessionId);
    
    if (!success) {
      return res.status(404).json({ error: "会话不存在" });
    }
    
    res.json({ success: true });
  } catch (error: any) {
    console.error("[Delete Session] Error:", error);
    res.status(500).json({ error: error?.message || "删除会话失败" });
  }
});

// ============= 聊天 API =============

// 权限响应 API
app.post("/api/permission-response", (req, res) => {
  const { requestId, behavior, message } = req.body;
  
  console.log(`[Permission] Response received: requestId=${requestId}, behavior=${behavior}`);
  
  const pending = pendingPermissions.get(requestId);
  if (!pending) {
    console.log(`[Permission] Request not found: ${requestId}`);
    return res.status(404).json({ error: "权限请求不存在或已超时" });
  }
  
  // 清除请求
  pendingPermissions.delete(requestId);
  
  if (behavior === 'allow') {
    pending.resolve({
      behavior: 'allow',
      updatedInput: pending.input
    });
  } else {
    pending.resolve({
      behavior: 'deny',
      message: message || '用户拒绝了此操作'
    });
  }
  
  res.json({ success: true });
});

// 发送消息并获取流式响应
app.post("/api/chat", async (req, res) => {
  const { sessionId, message, model, systemPrompt, cwd, permissionMode } = req.body;
  
  // 请求日志
  console.log(`\n[Chat] ========== 新请求 ==========`);
  console.log(`[Chat] SessionId: ${sessionId}`);
  console.log(`[Chat] Model: ${model}`);
  console.log(`[Chat] Message: ${message?.slice(0, 100)}${message?.length > 100 ? '...' : ''}`);
  console.log(`[Chat] CWD: ${cwd || 'default'}`);

  if (!message) {
    console.log(`[Chat] 错误: 消息为空`);
    return res.status(400).json({ error: "消息不能为空" });
  }

  // 获取或创建会话
  let session = sessionId ? db.getSession(sessionId) : null;
  const now = new Date().toISOString();
  
  if (!session) {
    // 创建新会话
    console.log(`[Chat] 创建新会话`);
    session = db.createSession({
      id: sessionId || uuidv4(),
      title: message.slice(0, 30) + (message.length > 30 ? '...' : ''),
      model: model || defaultModel,
      sdk_session_id: null,  // 稍后从 SDK 获取
      created_at: now,
      updated_at: now
    });
  } else {
    console.log(`[Chat] 使用现有会话, SDK Session: ${session.sdk_session_id || 'none'}`);
  }

  const selectedModel = model || session.model;
  
  // 获取 SDK session ID（用于恢复对话）
  const sdkSessionId = session.sdk_session_id;

  // 创建用户消息 ID 和助手消息 ID
  const userMessageId = uuidv4();
  const assistantMessageId = uuidv4();

  // 保存用户消息到数据库
  try {
    db.createMessage({
      id: userMessageId,
      session_id: session.id,
      role: 'user',
      content: message,
      model: null,
      created_at: now,
      tool_calls: null
    });
    console.log(`[Chat] 用户消息已保存: ${userMessageId}`);
  } catch (dbError: any) {
    console.error(`[Chat] 保存用户消息失败:`, dbError);
    return res.status(500).json({ error: "保存消息失败", detail: dbError?.message });
  }

  // 设置 SSE 头
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // 默认系统提示词：简历自动投递 Agent，附带本机能力地址
  const defaultSystemPrompt = `${JOB_APPLY_AGENT_PROMPT}\n\n【本机能力地址】所有能力 API 的 baseURL = ${API_BASE}（例如 ${API_BASE}/api/browser/exec）。`;
  const finalSystemPrompt = systemPrompt
    ? `${systemPrompt}\n\n【本机能力地址】所有能力 API 的 baseURL = ${API_BASE}。`
    : defaultSystemPrompt;

  // 工作目录：优先使用请求中的 cwd，否则使用当前目录
  const workingDir = cwd || process.cwd();

  try {
    console.log(`[Chat] 调用 SDK query...`);
    console.log(`[Chat] - Model: ${selectedModel}`);
    console.log(`[Chat] - Resume: ${sdkSessionId || 'none'}`);
    console.log(`[Chat] - CWD: ${workingDir}`);
    console.log(`[Chat] - PermissionMode: ${permissionMode || 'default'}`);
    
    // 创建 canUseTool 回调
    const canUseTool: CanUseTool = async (toolName, input, options) => {
      console.log(`[Permission] Tool request: ${toolName}`);
      console.log(`[Permission] Input:`, JSON.stringify(input, null, 2));
      
      // bypassPermissions 模式直接放行
      if (permissionMode === 'bypassPermissions') {
        console.log(`[Permission] Bypassing permissions for ${toolName}`);
        return { behavior: 'allow', updatedInput: input };
      }
      
      // 创建权限请求
      const requestId = uuidv4();
      const permissionRequest = {
        requestId,
        toolUseId: options.toolUseID,
        toolName,
        input,
        sessionId: session.id,
        timestamp: Date.now()
      };
      
      // 发送权限请求到前端
      res.write(`data: ${JSON.stringify({ 
        type: "permission_request", 
        ...permissionRequest
      })}\n\n`);
      
      // 创建 Promise 等待用户响应
      return new Promise<PermissionResult>((resolve, reject) => {
        const pending: PendingPermission = {
          resolve,
          reject,
          toolName,
          input,
          sessionId: session.id,
          timestamp: Date.now()
        };
        
        pendingPermissions.set(requestId, pending);
        
        // 设置超时
        setTimeout(() => {
          if (pendingPermissions.has(requestId)) {
            pendingPermissions.delete(requestId);
            console.log(`[Permission] Request timeout: ${requestId}`);
            resolve({
              behavior: 'deny',
              message: '权限请求超时'
            });
          }
        }, PERMISSION_TIMEOUT);
      });
    };
    
    // 使用 Query API 发送消息
    // 如果有 sdk_session_id，使用 resume 恢复对话上下文
    const stream = query({
      prompt: message,
      options: {
        cwd: workingDir,
        model: selectedModel,
        maxTurns: Number(req.body?.maxTurns) || 150,
        systemPrompt: finalSystemPrompt,
        permissionMode: permissionMode || 'default',
        canUseTool,
        ...(sdkSessionId ? { resume: sdkSessionId } : {})  // 使用 resume 恢复对话
      }
    });

    let fullResponse = "";
    let toolCalls: Array<{ 
      id: string; 
      name: string; 
      input?: Record<string, unknown>;
      status: string; 
      result?: string;
      isError?: boolean;
    }> = [];
    let newSdkSessionId: string | null = null;  // 用于存储 SDK 返回的 session_id

    // 发送会话ID和消息ID
    res.write(`data: ${JSON.stringify({ 
      type: "init", 
      sessionId: session.id, 
      userMessageId, 
      assistantMessageId,
      model: selectedModel 
    })}\n\n`);

    // 当前正在执行的工具 ID（用于匹配 tool_result）
    let currentToolId: string | null = null;

    // 处理流式响应
    for await (const msg of stream) {
      console.log("[Stream] Message type:", msg.type, msg);
      
      // 处理 system 消息，获取 SDK 的 session_id
      if (msg.type === "system" && (msg as any).subtype === "init") {
        newSdkSessionId = (msg as any).session_id;
        console.log(`[Stream] Got SDK session_id: ${newSdkSessionId}`);
        
        // 保存 SDK session_id 到数据库（如果是新的）
        if (newSdkSessionId && newSdkSessionId !== sdkSessionId) {
          db.updateSession(session.id, { sdk_session_id: newSdkSessionId });
          console.log(`[Stream] Saved SDK session_id to database`);
        }
      } else if (msg.type === "assistant") {
        const content = msg.message.content;

        if (typeof content === "string") {
          fullResponse += content;
          res.write(`data: ${JSON.stringify({ type: "text", content })}\n\n`);
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text") {
              fullResponse += block.text;
              res.write(`data: ${JSON.stringify({ type: "text", content: block.text })}\n\n`);
            } else if (block.type === "tool_use") {
              currentToolId = block.id || uuidv4();
              const toolInput = (block as any).input || {};
              console.log(`[Stream] Tool use: id=${currentToolId}, name=${block.name}`);
              console.log(`[Stream] Tool input:`, JSON.stringify(toolInput, null, 2));
              
              const toolCall = { 
                id: currentToolId, 
                name: block.name, 
                input: toolInput,
                status: "running" 
              };
              toolCalls.push(toolCall);
              res.write(`data: ${JSON.stringify({ 
                type: "tool", 
                id: toolCall.id,
                name: toolCall.name,
                input: toolCall.input,
                status: toolCall.status
              })}\n\n`);
            }
          }
        }
      } else if ((msg as any).type === "tool_result") {
        // 处理工具结果（独立的消息类型）
        const msgAny = msg as any;
        const toolId = msgAny.tool_use_id || currentToolId;
        const isError = msgAny.is_error || false;
        const content = msgAny.content;
        
        console.log(`[Stream] Tool result: tool_use_id=${toolId}, is_error=${isError}`);
        console.log(`[Stream] Tool result content type:`, typeof content);
        console.log(`[Stream] Tool result content:`, typeof content === 'string' ? content.slice(0, 500) : JSON.stringify(content, null, 2)?.slice(0, 500));
        
        const tool = toolCalls.find(t => t.id === toolId) || toolCalls[toolCalls.length - 1];
        if (tool) {
          tool.status = isError ? "error" : "completed";
          tool.isError = isError;
          tool.result = typeof content === 'string' 
            ? content 
            : JSON.stringify(content);
          res.write(`data: ${JSON.stringify({ 
            type: "tool_result", 
            toolId: tool.id, 
            content: tool.result,
            isError: isError
          })}\n\n`);
        }
        currentToolId = null;
      } else if (msg.type === "result") {
        // 完成时确保所有工具都标记为完成
        toolCalls.forEach(tool => {
          if (tool.status === "running") {
            tool.status = "completed";
            res.write(`data: ${JSON.stringify({ type: "tool_result", toolId: tool.id, content: tool.result || "已完成" })}\n\n`);
          }
        });
        res.write(`data: ${JSON.stringify({ type: "done", duration: (msg as any).duration_ms, cost: (msg as any).total_cost_usd })}\n\n`);
      }
    }

    // 保存助手消息到数据库
    db.createMessage({
      id: assistantMessageId,
      session_id: session.id,
      role: 'assistant',
      content: fullResponse,
      model: selectedModel,
      created_at: new Date().toISOString(),
      tool_calls: toolCalls.length > 0 ? JSON.stringify(toolCalls) : null
    });

    // 更新会话标题（如果是第一条消息）
    const messages = db.getMessagesBySession(session.id);
    if (messages.length <= 2) {
      db.updateSession(session.id, { 
        title: message.slice(0, 30) + (message.length > 30 ? '...' : ''),
        model: selectedModel
      });
    }

    console.log(`[Chat] 请求完成 ✓`);
    res.end();
  } catch (error: any) {
    console.error(`\n[Chat] ========== 错误 ==========`);
    console.error(`[Chat] Error Name:`, error?.name);
    console.error(`[Chat] Error Message:`, error?.message);
    console.error(`[Chat] Error Code:`, error?.code);
    console.error(`[Chat] Error Stack:`, error?.stack);
    console.error(`[Chat] Full Error:`, JSON.stringify(error, null, 2));
    
    const errorMessage = error?.message || "处理请求时发生错误";
    res.write(`data: ${JSON.stringify({ type: "error", message: errorMessage })}\n\n`);
    res.end();
  }
});

// Express 终末错误中间件：未捕获的路由异常统一返回 500 JSON 并落日志，避免连接悬挂
app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  const code = Number(err?.status || err?.statusCode) || 500;
  // 只有真正的服务端故障（5xx）才落 ERROR + 触发告警；4xx 参数错误属客户端问题，不打扰
  if (code >= 500) {
    (res as any).__errLogged = true; // 已记录，避免 finish 兜底重复记一条
    logRun('ERROR', `express error: ${err?.stack || err}`);
  }
  if (res.headersSent) return next(err);
  if (code >= 400 && code < 500) return res.status(code).json({ error: String(err?.message || '请求错误') });
  res.status(500).json({ error: '服务器内部错误' });
});

// 启动服务器
const server = app.listen(PORT, HOST, () => {
  // 真实冷启动耗时：从「进程创建」算起（含 tsx 转译 + ESM 依赖加载），比模块体内的计时准确
  logRun('INFO', `API 服务器已启动 http://${HOST}:${PORT}｜数据库 SQLite(data/chat.db)｜冷启动 ${Math.round(process.uptime() * 1000)}ms`);
  console.log(`
╔════════════════════════════════════════════╗
║                                            ║
║     ◉ 简历投递 Agent · API 服务器已启动     ║
║                                            ║
║     地址: http://${HOST}:${PORT}            ║
║     数据库: SQLite (data/chat.db)          ║
║     能力: 浏览器自动化 / 邮箱验证码 / 档案  ║
║                                            ║
╚════════════════════════════════════════════╝
  `);
  // 若配置启用自动回复监视器，则恢复常驻轮询（不立即跑，等首个间隔，避免启动即操作浏览器）
  try {
    bootstrapWatcher();
    bootstrapApplyWatch();
  } catch (e) {
    console.error('[watch] bootstrap failed:', e);
  }
  // 非阻塞：释放过期磁盘占用（截图超期、DB 备份仅留最近若干份）
  // O2：顺带检查 data/ 总体积是否超阈值（分发给他人后，磁盘可能被静默吃满）
  cleanupData({})
    .then((rep: any) => {
      if (rep && rep.overThreshold) {
        logRun('ERROR', `data/ 已达 ${rep.totalHuman}，超过阈值 ${Math.round((rep.maxBytes || 0) / 1024 / 1024)}MB —— 建议清理（npm run data:cleanup；或用 DATA_MAX_MB 调整阈值）`);
      }
    })
    .catch((e) => logRun('ERROR', `cleanupData 启动清理异常: ${e}`));
});

// 启动期错误（典型：端口被占用）——必须显式处理，否则落到 uncaughtException，
// 用户只能在日志/告警里看到一句 EADDRINUSE 栈，不知道「已有实例在跑」。
server.on('error', (err: any) => {
  try {
    if (err?.code === 'EADDRINUSE') {
      logRun('ERROR', `端口 ${PORT} 已被占用：请先关闭正在运行的实例，或设置 PORT 换端口`);
      try {
        console.error(`\n[启动失败] 端口 ${PORT} 已被占用。请先关闭已运行的实例，或用 PORT=4401 换端口后重试。\n`);
      } catch { /* stdout 管道可能已断开，忽略 */ }
      process.exit(1);
    }
    logRun('ERROR', `listen error: ${err?.stack || err}`);
    try { console.error(`[启动失败] ${err?.message || err}`); } catch { /* ignore */ }
    process.exit(1);
  } catch {
    process.exit(1);
  }
});

// 退出时关闭所有浏览器，避免残留进程
const shutdown = async () => {
  try {
    await closeAll();
  } catch {
    /* 忽略 */
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// 全局异常兜底：不因单个未捕获异常而静默退出（否则用户端表现为「控制台突然打不开、投递莫名中断」）
// ⚠️ 2026-09-21 修复「日志自我放大」：实测单日写出 330 万行 / 240MB，内容全是
//    `uncaughtException: Error: EPIPE: broken pipe, write`。链路是：
//      stdout 管道断开（启动它的终端/父进程被关）→ console.* 抛 EPIPE → uncaughtException →
//      logRun 又去 console.error → 又 EPIPE → 再 uncaughtException …… 无限循环 + 同步 append 狂写盘。
//    因此：管道类噪声错误**绝不落日志、绝不告警**（它们不是应用故障，且写日志本身会再触发它）。
process.on('uncaughtException', (err) => {
  if (isPipeNoise(err)) return; // 静默丢弃，打破自激循环
  logRun('ERROR', `uncaughtException: ${(err as any)?.stack || err}`);
});
process.on('unhandledRejection', (reason) => {
  if (isPipeNoise(reason)) return;
  const r: any = reason;
  logRun('ERROR', `unhandledRejection: ${r?.stack || r}`);
});
