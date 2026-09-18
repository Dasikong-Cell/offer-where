/**
 * 简历「聊天图」通道（对标职得鸭的 HTML→PNG→聊天框发图）
 * ==========================================================================
 * 职得鸭的做法（`bossAuto.js:771`）：云端按 JD 返回简历 HTML → 渲染 → 对 `<body>` 截图成 PNG
 * → 塞进聊天框的 `input[type=file]` 当图片发给 HR → 用完即删。
 * 好处是**绕开平台简历附件系统**、四平台一套代码；代价是 HR 只收到一张图，**不可被 ATS 解析**。
 *
 * 我们的做法：**两条通道并存，按「有没有 HR 邮箱」自动分流** ——
 *   · 有招聘邮箱 → **PDF 邮件附件**（可解析、可留档、专业，本地文件可复用）
 *   · 无邮箱但平台内有聊天 → **PNG 聊天图**（覆盖平台内沟通场景）
 * 这就是「取它之长、不弃我之长」：单一通道永远覆盖不全，双通道才覆盖全。
 *
 * 复用点：简历 HTML 直接取 `tailoredResumePdf` 生成的 `<base>.html`（已含按 JD 定制内容），
 * 不重复实现定制逻辑；PNG 与 PDF 同一份 HTML，保证「邮件里收到什么、聊天里就发什么」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execCdpAction } from '../cdpDriver.js';
import { bexec, ApplyLogger, sleep } from './common.js';
import { ensureTailoredResumePdf, tailoredDir, type TailorPdfJob } from './tailoredResumePdf.js';

/** 各平台聊天框的「发送图片」文件输入选择器（按优先级尝试） */
export const CHAT_IMAGE_INPUTS: Record<string, string[]> = {
  boss: ['div[aria-label="发送图片"] input[type="file"]', 'input[type="file"][accept*="image"]', '.chat-input-wrap input[type="file"]'],
  liepin: ['input[type="file"][accept*="image"]', '.im-ui-upload input[type="file"]', '.chat-input-area input[type="file"]'],
  job51: ['input[type="file"][accept*="image"]'],
  zhilian: ['input[type="file"][accept*="image"]'],
};

/** 哪些平台支持在聊天里发图（沟通型平台） */
export const CHAT_IMAGE_PLATFORMS: readonly string[] = ['boss', 'liepin', 'zhilian'];

export type ResumeChannel = 'email' | 'chat' | 'platform';

export interface ChannelDecision {
  channel: ResumeChannel;
  reason: string;
}

/**
 * 简历通道决策（纯函数，便于单测）。
 * @param hasEmail 是否已取证到可用的 HR 邮箱
 */
export function decideResumeChannel(opts: { hasEmail: boolean; platform?: string }): ChannelDecision {
  const platform = String(opts.platform || '').toLowerCase();
  if (opts.hasEmail) {
    return { channel: 'email', reason: '已取证到 HR 邮箱 → 走 PDF 邮件附件（可被 ATS 解析、可留档）' };
  }
  if (CHAT_IMAGE_PLATFORMS.includes(platform)) {
    return { channel: 'chat', reason: '无 HR 邮箱，但该平台有聊天窗口 → 走 PNG 聊天图（HR 在对话里能直接看到）' };
  }
  return {
    channel: 'platform',
    reason: `${platform || '该平台'} 无 HR 邮箱且不支持聊天发图 → 只能在平台内一键投递（用平台在线简历）`,
  };
}

export interface ChatResumePngResult {
  ok: boolean;
  pngPath?: string;
  htmlPath?: string;
  cached?: boolean;
  bytes?: number;
  error?: string;
}

/** 用哪个浏览器排版：official(9227) 平时最闲；失败回退 boss(9223) */
function endpoints(): Array<[string, string]> {
  let base: Record<string, string> = {};
  try {
    const p = path.join(tailoredDir(), '..', 'browser', 'cdp.json');
    base = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch { /* 用默认 */ }
  const pick = (k: string, port: number) => (typeof base[k] === 'string' && base[k].trim() ? base[k].trim() : `http://127.0.0.1:${port}`);
  return [['official', pick('official', 9227)], ['boss', pick('boss', 9223)]];
}

const pngPathFor = (htmlPath: string): string => htmlPath.replace(/\.html$/i, '.png');

/**
 * 确保某岗位的「聊天用简历长图」存在。
 * 依赖 `ensureTailoredResumePdf` 先产出 HTML（复用同一份定制内容与缓存）。
 */
export async function ensureChatResumePng(
  job: TailorPdfJob & { id?: string },
  options: { profile?: Record<string, any>; force?: boolean } = {},
): Promise<ChatResumePngResult> {
  // 1) 先拿到定制 HTML（内部有缓存，重复调用不会重复调 LLM）
  const pdf = await ensureTailoredResumePdf(job, options);
  if (!pdf.ok || !pdf.htmlPath) {
    return { ok: false, error: pdf.error || '定制简历 HTML 生成失败' };
  }
  const htmlPath = pdf.htmlPath;
  const pngPath = pngPathFor(htmlPath);

  if (!options.force && fs.existsSync(pngPath) && fs.statSync(pngPath).size > 4096) {
    return { ok: true, pngPath, htmlPath, cached: true, bytes: fs.statSync(pngPath).size };
  }
  if (!fs.existsSync(htmlPath)) {
    return { ok: false, htmlPath, error: `定制 HTML 不存在：${htmlPath}` };
  }

  const fileUrl = new URL(`file:///${htmlPath.replace(/\\/g, '/')}`).href;
  let lastErr = '';
  for (const [key, ep] of endpoints()) {
    const r: any = await execCdpAction(
      key,
      'htmlToImage',
      { fileUrl, outPath: pngPath, width: 1000, scale: 2, maxHeight: 16000 },
      ep,
    ).catch((e: any) => ({ ok: false, error: e?.message }));
    if (r?.ok && fs.existsSync(pngPath) && fs.statSync(pngPath).size > 4096) {
      return { ok: true, pngPath, htmlPath, cached: false, bytes: fs.statSync(pngPath).size };
    }
    lastErr = r?.error || '未知错误';
  }
  return { ok: false, htmlPath, error: `PNG 渲染失败（已尝试 ${endpoints().map(([k]) => k).join('/')}）：${lastErr}` };
}

export interface SendChatImageResult {
  ok: boolean;
  detail: string;
}

/**
 * 把简历图上传到当前已打开的聊天框。
 * **必须在 HR 会话页已打开、输入框可见的状态下调用**（由调用方负责导航到会话页）。
 */
export async function sendChatResumeImage(
  platform: string,
  pngPath: string,
  logs: ApplyLogger = new ApplyLogger(),
): Promise<SendChatImageResult> {
  const selectors = CHAT_IMAGE_INPUTS[platform];
  if (!selectors || !selectors.length) {
    return { ok: false, detail: `${platform} 未配置聊天发图选择器（该平台可能不支持）` };
  }
  if (!fs.existsSync(pngPath)) {
    return { ok: false, detail: `简历图不存在：${pngPath}` };
  }

  const sizeMb = fs.statSync(pngPath).size / 1024 / 1024;
  if (sizeMb > 10) {
    return { ok: false, detail: `简历图 ${sizeMb.toFixed(1)}MB 超过平台常见的 10MB 上限，已放弃发送` };
  }

  for (const selector of selectors) {
    const r = await bexec(platform, 'upload', { selector, filePath: pngPath, timeout: 8000 }, logs, `上传简历图（${selector}）`);
    if (r.ok) {
      await sleep(1500);
      return { ok: true, detail: `已上传简历图 ${path.basename(pngPath)}（${sizeMb.toFixed(2)}MB）` };
    }
  }
  return { ok: false, detail: `未找到聊天发图入口（尝试过 ${selectors.length} 个选择器）` };
}

/**
 * 一次到位：确保 PNG 存在并发送到当前聊天框。
 * 失败只记录不抛错 —— 简历图是"锦上添花"，不该让整次投递失败。
 */
export async function sendChatResume(
  platform: string,
  job: TailorPdfJob & { id?: string },
  logs: ApplyLogger = new ApplyLogger(),
  options: { profile?: Record<string, any>; force?: boolean } = {},
): Promise<{ ok: boolean; detail: string; pngPath?: string }> {
  const png = await ensureChatResumePng(job, options);
  if (!png.ok || !png.pngPath) {
    logs.step('聊天简历图生成失败', false, png.error);
    return { ok: false, detail: png.error || '生成失败' };
  }
  logs.step('聊天简历图就绪', true, `${png.cached ? '命中缓存' : '新生成'} ${path.basename(png.pngPath)}`);
  const sent = await sendChatResumeImage(platform, png.pngPath, logs);
  logs.step('发送聊天简历图', sent.ok, sent.detail);
  return { ok: sent.ok, detail: sent.detail, pngPath: png.pngPath };
}
