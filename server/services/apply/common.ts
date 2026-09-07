/**
 * 跨平台投递：公共助手
 * - 浏览器动作封装（复用 browser.execAction）
 * - 邮箱验证码轮询（复用 mail.fetchLatestCode）
 * - 日志/等待工具
 */
import fs from 'fs';
import path from 'path';
import { execAction } from '../browser.js';
import { fetchLatestCode } from '../mail.js';
import type { ApplyLog, ApplyProfile } from './types.js';

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * 解析有效的简历附件路径。
 * 优先使用档案中配置的 resume_path；若该文件不存在，则回退到项目内置的
 * data/resume_source.pdf（即用户发来的默认简历）。
 * 这样即使档案里的路径失效（例如早期误指向已删除的桌面文件），投递仍能用默认简历上传附件。
 */
export function resolveResumePath(configured?: string | null): string | undefined {
  if (configured && fs.existsSync(configured)) return configured;
  const fallback = path.resolve(__dirname, '../../../data/resume_source.pdf');
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

/** 截图（失败忽略） */
export async function tryScreenshot(platform: string): Promise<string | undefined> {
  const res = await execAction(platform, 'screenshot', { fullPage: false });
  return res.ok ? res.screenshot : undefined;
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
