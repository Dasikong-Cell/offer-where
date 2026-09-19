import "./env.js"; // 必须最先加载：解析根目录 .env 注入 process.env，使 LLM_*/MAIL_*/CODEBUDDY_* 生效
import express from "express";
import { query, unstable_v2_createSession, unstable_v2_authenticate, PermissionResult, CanUseTool } from "@tencent-ai/agent-sdk";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import { promisify } from "util";
import * as db from "./db.js";
import { fetchLatestCode, listRecentMails, testConnection } from "./services/mail.js";
import { execAction, listSessions, closeAll } from "./services/browser.js";
import { probePlatformConnections } from "./services/connection.js";
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
import { runApply, isSupported } from "./services/apply/index.js";
import { toApplyProfile } from "./services/apply/common.js";
import { runBatchApply } from "./services/apply/batch.js";
import { rememberCurrentForm } from "./services/apply/offerbiu.js";
import { scanOfferbiuEmails } from "./services/offerbiuEmailScan.js";
import { runAutoReply } from "./services/apply/autoReplyRunner.js";
import { startWatcher, stopWatcher, watcherStatus, setWatchConfig, bootstrapWatcher, watchEmitter } from "./services/apply/autoReplyWatcher.js";
import { startWatcher as startApplyWatch, stopWatcher as stopApplyWatch, watcherStatus as applyWatchStatus, setWatchConfig as setApplyWatchConfig, bootstrapWatcher as bootstrapApplyWatch, watchEmitter as applyWatchEmitter } from "./services/apply/autoApplyWatcher.js";
import { collectOfferbiu, collectOfferbiuByKeywords } from "./services/offerbiuCollect.js";
import { probePlatformApi } from "./services/platformApi/bossOpenApi.js";
import { probePlatformHealth, summarizeHealth } from "./services/platformHealth.js";
import { JOB_APPLY_AGENT_PROMPT } from "../shared/agentPrompt.js";

const execAsync = promisify(exec);

/** 本机 API 基础地址（写入 Agent 提示词） */
const API_BASE = process.env.APP_PUBLIC_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;

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
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '10mb' }));

// CORS：允许控制台页面从任意来源（文件预览/其它端口）直连本机 API
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

// 静态资源：浏览器截图
const SCREENSHOT_DIR = path.join(__dirname, '..', 'data', 'screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
app.use('/data/screenshots', express.static(SCREENSHOT_DIR));

// 静态资源：一岗一简历生成的定制简历 PDF/HTML（供前端预览与下载）
const TAILORED_DIR = path.join(__dirname, '..', 'data', 'resume_tailored');
if (!fs.existsSync(TAILORED_DIR)) fs.mkdirSync(TAILORED_DIR, { recursive: true });
app.use('/data/resume_tailored', express.static(TAILORED_DIR));

// 静态资源：投递控制台（单一入口 App，public/console.html）
const CONSOLE_DIR = path.join(__dirname, '..', 'public');
if (!fs.existsSync(CONSOLE_DIR)) fs.mkdirSync(CONSOLE_DIR, { recursive: true });
app.use(express.static(CONSOLE_DIR));
app.get("/", (_req, res) => { res.sendFile(path.join(CONSOLE_DIR, 'console.html')); });

// 缓存可用模型列表
let cachedModels: Array<{ modelId: string; name: string; description?: string }> = [];
const defaultModel = "claude-sonnet-4";

// 健康检查
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString(), ai: isAiEnabled() });
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
    const basis = db.query<{ title_only: number; jd_based: number; card_only: number }>(
      `SELECT SUM(CASE WHEN jd IS NULL OR TRIM(jd)='' THEN 1 ELSE 0 END) title_only,
              SUM(CASE WHEN jd IS NOT NULL AND TRIM(jd)<>'' THEN 1 ELSE 0 END) jd_based,
              SUM(CASE WHEN (jd IS NULL OR TRIM(jd)='') AND card_text IS NOT NULL AND TRIM(card_text)<>'' THEN 1 ELSE 0 END) card_only
       FROM jobs`
    )[0] || { title_only: 0, jd_based: 0, card_only: 0 };
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
    const health = await probePlatformHealth(list.length ? list : undefined, deep);
    res.json({ deep, summary: summarizeHealth(health, deep), platforms: health });
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
  
  // 2. 使用 unstable_v2_authenticate 检查登录状态（更可靠）
  try {
    let needsLogin = false;
    
    const result = await unstable_v2_authenticate({
      environment: 'external',
      onAuthUrl: async (authState) => {
        // 如果执行到这个回调，说明未登录
        needsLogin = true;
        console.log('[Check Login] 需要登录，认证 URL:', authState.authUrl);
        // 将认证 URL 返回给前端（如果需要）
        response.error = '未登录，请先登录 CodeBuddy CLI';
      }
    });
    
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

// ============= 跨平台批量连投（自动筛选 + 投递） =============

app.post("/api/apply/batch", async (req, res) => {
  try {
    const {
      platform, source, criteria, collect, limit, headless, sinceMinutes, intervalMs, stream, realSend,
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
    const { platform, jobId, jobUrl, headless, sinceMinutes, action, keyword, maxPages, maxApply, hrGroupId, chatHistory, jdText, channel } = req.body || {};
    if (!isSupported(platform)) {
      return res.status(400).json({ error: `不支持的平台：${platform}（支持：boss / zhilian / job51 / nowcoder / offerbiu / liepin）` });
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
      dryRun: req.body?.dryRun === true,
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

// 启动服务器
const server = app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║                                            ║
║     ◉ 简历投递 Agent · API 服务器已启动     ║
║                                            ║
║     地址: http://localhost:${PORT}            ║
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
