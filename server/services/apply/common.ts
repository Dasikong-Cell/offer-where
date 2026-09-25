/**
 * 跨平台投递：公共助手
 * - 浏览器动作封装（复用 browser.execAction）
 * - 邮箱验证码轮询（复用 mail.fetchLatestCode）
 * - 日志/等待工具
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { execAction } from '../browser.js';
import { fetchLatestCode } from '../mail.js';
import type { ApplyLog, ApplyProfile } from './types.js';

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// 本项目 package.json 为 "type": "module"，tsx 下 __dirname 不会被注入。
// 统一用 import.meta.url 推导模块目录（server/services/apply/ → 项目根）。
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(MODULE_DIR, '..', '..', '..');
export const DATA_DIR = path.join(PROJECT_ROOT, 'data');

/**
 * 解析有效的简历附件路径。
 * 优先使用档案中配置的 resume_path；若该文件不存在，则回退到项目内置的
 * data/resume_source.pdf（即用户发来的默认简历）。
 * 这样即使档案里的路径失效（例如早期误指向已删除的桌面文件），投递仍能用默认简历上传附件。
 */
export function resolveResumePath(configured?: string | null): string | undefined {
  if (configured && fs.existsSync(configured)) return configured;
  const fallback = path.join(DATA_DIR, 'resume_source.pdf');
  if (fs.existsSync(fallback)) return fallback;
  return undefined;
}

/**
 * 把数据库里的档案（任意字段）规整成投递脚本用的 ApplyProfile。
 * 学历/学校/专业/城市/技能等要带上——企业官网「邮箱投递」常要求
 * 按「学历+专业+学校+姓名」这类格式拼邮件标题，缺了就只能退回占位词。
 */
export function toApplyProfile(p: Record<string, any> | undefined | null): ApplyProfile {
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  return {
    name: s(p?.name) ?? null,
    phone: s(p?.phone) ?? null,
    email: s(p?.email) ?? null,
    resume_path: s(p?.resume_path) ?? s(p?.resumePath) ?? null,
    education: s(p?.education) ?? null,
    school: s(p?.school) ?? null,
    major: s(p?.major) ?? null,
    city: s(p?.city) ?? null,
    skills: s(p?.skills) ?? null,
    expectedPositions: s(p?.expectedPositions) ?? null,
  };
}

export class ApplyLogger {
  logs: ApplyLog[] = [];
  step(step: string, ok: boolean, detail?: string) {
    this.logs.push({ step, ok, detail });
    return this.logs[this.logs.length - 1];
  }
}

/** 封装一次浏览器动作；失败不抛异常，写入日志并返回结果 */
export async function bexec(
  platform: string,
  action: string,
  args: Record<string, any> = {},
  logs?: ApplyLogger,
  label?: string,
) {
  const res = await execAction(platform, action, args);
  if (logs) logs.step(label || `${action} ${args.selector || args.url || ''}`, !!res.ok, res.error || (res.ok ? undefined : '动作失败'));
  return res;
}

/** 取页面可见文本（用简单 eval 取正文，首调即稳定，避免 text 动作在导航后首调偶发取空） */
export async function pageText(platform: string): Promise<string> {
  const res = await execAction(platform, 'eval', {
    script:
      "document.body ? (document.body.innerText || document.body.textContent || '').replace(/\\s+/g,' ').trim() : ''",
  });
  return (res.data as string) || '';
}

/** 取当前 URL */
export async function pageUrl(platform: string): Promise<string> {
  const res = await execAction(platform, 'html', { maxLength: 1 });
  return res.url || '';
}

/**
 * 截图并统一归档到 data/evidence/<appId>.png（操作录屏回溯，对标 CareerBoom.ai「每次投递生成操作录屏」）。
 * - 不传 appId：回退旧行为，返回 data/screenshots/<platform>-<ts>.png（兼容其它调用方）。
 * - 传 appId：把 CDP 写出的临时截图 rename 到按投递记录归档的证据目录，返回 /data/evidence/<appId>.png。
 * 任何失败都返回 undefined（截图只是可选审计证据，绝不应阻断「已投递」主流程）；失败时打印 warn 便于排查。
 */
export async function tryScreenshot(platform: string, appId?: string): Promise<string | undefined> {
  const res = await execAction(platform, 'screenshot', { fullPage: false });
  if (!res.ok || !res.screenshot) {
    console.warn(`[tryScreenshot] 平台 ${platform} 截图未成功（res.ok=${res.ok}），跳过证据留存`);
    return undefined;
  }
  if (!appId) return res.screenshot; // 兼容旧调用
  // CDP 截图动作写到 data/screenshots/<platform>-<ts>.png，这里迁移到按投递记录归档的 evidence 目录
  const fileName = path.basename(res.screenshot); // <platform>-<ts>.png
  const src = path.join(DATA_DIR, 'screenshots', fileName);
  const destDir = path.join(DATA_DIR, 'evidence');
  try {
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    if (fs.existsSync(src)) fs.renameSync(src, path.join(destDir, `${appId}.png`));
    return `/data/evidence/${appId}.png`;
  } catch (e: any) {
    console.warn(`[tryScreenshot] 证据迁移失败，回退原路径：`, e?.message);
    return res.screenshot;
  }
}

/**
 * 过程抽帧录制（对标 CareerBoom.ai「每次投递生成操作录屏」）。
 *
 * ⚠️ 这是**抽帧序列**（连拍若干张，可当幻灯片回看操作过程），**不是视频**：
 *    真·录像需要 CDP 长连接 + `Page.startScreencast`，要改驱动模型（原「录屏回溯」名不副实即指此）。
 *    本实现刻意做成**独立、按需调用**，不进投递主流程 —— 不为此牺牲投递稳定性。
 *    本机若装了 ffmpeg，可自行把 frame-*.png 合成为 mp4。
 *
 * 复用既有 `tryScreenshot`（同一条已充分验证的截图路径），因此不引入任何新的 CDP 代码。
 */
export async function recordFrames(
  platform: string,
  opts: { seconds?: number; intervalMs?: number } = {},
): Promise<{ ok: boolean; recId?: string; dir?: string; frames: string[]; seconds?: number; intervalMs?: number; error?: string }> {
  const seconds = Math.max(2, Math.min(60, Number(opts.seconds) || 8));
  const intervalMs = Math.max(400, Math.min(5000, Number(opts.intervalMs) || 1200));
  const total = Math.max(2, Math.min(60, Math.floor((seconds * 1000) / intervalMs) + 1));
  const recId = `rec-${platform}-${Date.now()}`;
  const destDir = path.join(DATA_DIR, 'evidence', recId);
  const frames: string[] = [];
  try {
    for (let i = 0; i < total; i++) {
      const shot = await tryScreenshot(platform);
      if (shot) {
        const src = path.join(DATA_DIR, 'screenshots', path.basename(shot));
        const name = `frame-${String(i).padStart(3, '0')}.png`;
        if (fs.existsSync(src)) {
          if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
          try { fs.renameSync(src, path.join(destDir, name)); frames.push(`/data/evidence/${recId}/${name}`); } catch { /* 单帧失败只跳过该帧 */ }
        }
      }
      if (i < total - 1) await sleep(intervalMs);
    }
    return { ok: frames.length > 0, recId, dir: `/data/evidence/${recId}`, frames, seconds, intervalMs };
  } catch (e: any) {
    return { ok: false, recId, frames, error: e?.message || String(e) };
  }
}

/**
 * 轮询邮箱验证码
 * 在 sinceMinutes 时间窗内反复拉取，直到命中目标站点发来的验证码邮件。
 */
export async function pollEmailCode(opts: {
  profile: ApplyProfile;
  subjectKeyword?: string;
  sinceMinutes?: number;
  maxAttempts?: number;
  intervalMs?: number;
}): Promise<string> {
  const { profile, subjectKeyword, sinceMinutes = 10, maxAttempts = 15, intervalMs = 4000 } = opts;
  if (!profile.email) throw new Error('档案未配置邮箱，无法读取验证码');

  let lastErr = '';
  for (let i = 0; i < maxAttempts; i++) {
    const r = await fetchLatestCode({ sinceMinutes, subjectKeyword, config: { email: profile.email } });
    if (r.ok && r.code) return r.code;
    lastErr = r.error || '未找到验证码';
    await sleep(intervalMs);
  }
  throw new Error(`等待验证码超时：${lastErr}（确认站点已向 ${profile.email} 发送，且邮件已入收件箱）`);
}

/**
 * 通用「邮箱验证码登录」编排
 * @param selectors 各站点选择器映射（多种候选以数组给出，按顺序尝试）
 */
export async function loginViaEmailCode(platform: string, opts: {
  loginUrl: string;
  logs: ApplyLogger;
  profile: ApplyProfile;
  sinceMinutes?: number;
  subjectKeyword?: string;
  selectors: {
    emailTab?: string[];       // 切换到邮箱登录的按钮文本/选择器
    emailInput: string[];      // 邮箱输入框
    sendCodeBtn: string[];     // 发送验证码按钮
    codeInput: string[];       // 验证码输入框
    submitBtn: string[];       // 登录/确认按钮
    sliderHint?: string[];     // 出现则视为需要人工过滑块（文本片段）
  };
}): Promise<{ status: 'logged_in' | 'need_captcha' | 'error'; message: string }> {
  const { loginUrl, logs, profile, sinceMinutes = 10, subjectKeyword, selectors } = opts;

  await bexec(platform, 'navigate', { url: loginUrl, waitUntil: 'domcontentloaded' }, logs, '打开登录页');
  await sleep(1500);

  // 切换到邮箱登录（若有）
  if (selectors.emailTab?.length) {
    for (const sel of selectors.emailTab) {
      const r = await bexec(platform, 'click', { text: sel, timeout: 4000 }, logs, `点击「${sel}」`);
      if (r.ok) break;
    }
    await sleep(800);
  }

  // 填写邮箱
  for (const sel of selectors.emailInput) {
    const r = await bexec(platform, 'fill', { selector: sel, value: profile.email || '', timeout: 5000 }, logs, '填写邮箱');
    if (r.ok) break;
  }

  // 发送验证码
  let sent = false;
  for (const sel of selectors.sendCodeBtn) {
    const r = await bexec(platform, 'click', { text: sel, timeout: 5000 }, logs, `点击「${sel}」`);
    if (r.ok) { sent = true; break; }
  }
  if (!sent) return { status: 'error', message: '未找到「发送验证码」按钮' };

  // 等待验证码
  let code: string;
  try {
    code = await pollEmailCode({ profile, subjectKeyword, sinceMinutes });
  } catch (e: any) {
    return { status: 'error', message: '读取验证码失败：' + e.message };
  }
  logs.step('读取验证码', true, `验证码=${code}`);

  // 填写验证码
  for (const sel of selectors.codeInput) {
    const r = await bexec(platform, 'fill', { selector: sel, value: code, timeout: 5000 }, logs, '填写验证码');
    if (r.ok) break;
  }

  // 提交
  for (const sel of selectors.submitBtn) {
    const r = await bexec(platform, 'click', { text: sel, timeout: 5000 }, logs, `点击「${sel}」`);
    if (r.ok) break;
  }
  await sleep(2500);

  // 检测滑块/图形验证码
  if (selectors.sliderHint?.length) {
    const txt = await pageText(platform);
    if (selectors.sliderHint.some(h => txt.includes(h))) {
      return { status: 'need_captcha', message: '出现滑块/图形验证，请在打开的浏览器中人工完成后重试' };
    }
  }

  return { status: 'logged_in', message: '登录已提交' };
}
