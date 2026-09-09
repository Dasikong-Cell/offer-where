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
import { parseResumeFile, structureResume } from "./services/resume.js";
import { matchResumeToJobAi } from "./services/apply/matchAi.js";
import { isAiEnabled } from "./services/apply/aiClient.js";
import { runApply, isSupported } from "./services/apply/index.js";
import { toApplyProfile } from "./services/apply/common.js";
import { runBatchApply } from "./services/apply/batch.js";
import { runAutoReply } from "./services/apply/autoReplyRunner.js";
import { collectOfferbiu } from "./services/offerbiuCollect.js";
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
      const r = await matchResumeToJobAi({ resumeBlob: struct.searchBlob, resumeSkills: struct.skills, jd: job.jd || '', requirements: job.requirements || '' });
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

// 从 Offerbiu 校招信息库采集岗位（需用户已在该浏览器上下文登录；采集结果入库为岗位池）
app.post("/api/offerbiu/collect", async (req, res) => {
  try {
    const { limit = 50 } = req.body || {};
    const result = await collectOfferbiu(Number(limit) || 50);
    res.json({ collected: result.collected, jobs: result.jobs });
  } catch (error: any) {
    const status = /尚未登录/.test(error?.message || '') ? 401 : 500;
    res.status(status).json({ error: error?.message || '采集失败' });
  }
});

// ============= 跨平台批量连投（自动筛选 + 投递） =============

app.post("/api/apply/batch", async (req, res) => {
  try {
    const {
      platform, source, criteria, collect, limit, headless, sinceMinutes, intervalMs, stream,
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
  const send = (ev: Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };

  try {
    await runAutoReply({ unreadOnly, limit, realSend, signal }, send);
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
