/**
 * Offerbiu 官网自动投递脚本
 *
 * Offerbiu 是聚合型求职平台：从「校招信息库」采集到的岗位，其 apply_url 通常是
 * 企业自己的官方招聘站（career.xxx.com）。本脚本针对这类「企业官网」做自动投递：
 *   导航到官网 →（未登录）尝试邮箱验证码登录（验证码走 QQ 邮箱 IMAP 自动读取）
 *   → 找「投递 / 网申 / 申请职位」入口 → 上传附件简历 → 提交 → 校验。
 *
 * 企业官网结构差异极大，脚本为「尽力而为 + 人工兜底」：
 *   - 能识别到标准邮箱登录/投递入口则自动完成；
 *   - 识别不到（如企业用 OAuth/微信扫码/自建账号体系）则返回 need_manual，
 *     由用户在打开的浏览器中完成，登录态会被持久化，再次点击即可继续。
 *
 * 使用独立浏览器上下文键 'official'，避免污染 Offerbiu 采集用的上下文。
 */
import { ApplyLogger, bexec, pageText, tryScreenshot, sleep, pollEmailCode } from './common.js';
import type { ApplyInput, ApplyResult } from './types.js';

const CTX = 'official'; // 企业官网专用浏览器上下文

/** 从 URL 提取域名关键词，用于邮箱验证码邮件的主题匹配 */
function domainKeyword(url: string): string | undefined {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const core = host.split('.').slice(-2, -1)[0] || host;
    return core.length >= 2 ? core : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 尽力而为的邮箱验证码登录（适用于结构未知的企业官网）
 */
async function tryEmailLogin(input: ApplyInput, logs: ApplyLogger, subjectKeyword?: string): Promise<boolean> {
  // 1) 切换到邮箱/账号登录
  for (const t of ['邮箱登录', '账号登录', '密码登录']) {
    await bexec(CTX, 'click', { text: t, timeout: 3000 }, logs, `点击「${t}」`);
  }
  await sleep(800);

  // 2) 填邮箱
  let filled = false;
  for (const sel of ['input[name="email"]', '#email', 'input[placeholder*="邮箱"]', 'input[type="email"]', 'input[name="account"]']) {
    const r = await bexec(CTX, 'fill', { selector: sel, value: input.profile.email || '', timeout: 4000 }, logs, '填写邮箱');
    if (r.ok) { filled = true; break; }
  }
  if (!filled) {
    logs.step('邮箱登录', false, '未找到邮箱输入框，可能该官网使用微信/手机验证码登录');
    return false;
  }

  // 3) 发送验证码
  let sent = false;
  for (const t of ['获取验证码', '发送验证码', '获取邮件验证码']) {
    const r = await bexec(CTX, 'click', { text: t, timeout: 4000 }, logs, `点击「${t}」`);
    if (r.ok) { sent = true; break; }
  }
  if (!sent) {
    logs.step('邮箱登录', false, '未找到「发送验证码」按钮');
    return false;
  }

  // 4) 轮询验证码
  let code: string;
  try {
    code = await pollEmailCode({
      profile: input.profile,
      subjectKeyword,
      sinceMinutes: input.sinceMinutes || 10,
    });
  } catch (e: any) {
    logs.step('读取验证码', false, e.message);
    return false;
  }
  logs.step('读取验证码', true, `验证码=${code}`);

  // 5) 填验证码并提交
  for (const sel of ['input[placeholder*="验证码"]', '#code', 'input[name="code"]', 'input[name="captcha"]']) {
    await bexec(CTX, 'fill', { selector: sel, value: code, timeout: 4000 }, logs, '填写验证码');
  }
  for (const t of ['登录', '立即登录', '提交', '确认']) {
    await bexec(CTX, 'click', { text: t, timeout: 4000 }, logs, `点击「${t}」`);
  }
  await sleep(2500);
  return true;
}

export async function runOfferbiu(input: ApplyInput): Promise<ApplyResult> {
  const logs = new ApplyLogger();
  const platform = 'offerbiu';
  const resumePath = input.profile.resume_path || undefined;
  const jobUrl = input.jobUrl || input.job?.apply_url || undefined;
  const company = input.job?.company ?? null;
  const position = input.job?.position ?? null;

  if (!jobUrl) {
    return { platform, status: 'need_login', message: '该 Offerbiu 岗位缺少官网投递入口（apply_url）', logs: logs.logs, company, position };
  }

  const subject = domainKeyword(jobUrl);

  try {
    await bexec(CTX, 'navigate', { url: jobUrl, waitUntil: 'domcontentloaded' }, logs, '打开企业官网招聘页');
    await sleep(2500);
    let text = await pageText(CTX);

    // 检测是否需要登录
    const needLogin = /(登录|注册|账号|请先登录|登录后|sign in|log in)/i.test(text)
      && !/(投递成功|已投递|申请成功|网申完成)/.test(text);

    if (needLogin) {
      logs.step('登录态', false, '官网需登录，尝试邮箱验证码登录');
      // 先尝试点开登录入口
      for (const t of ['登录', '注册并登录', '账号登录']) {
        await bexec(CTX, 'click', { text: t, timeout: 3000 }, logs, `点击「${t}」`);
      }
      await sleep(1500);
      const ok = await tryEmailLogin(input, logs, subject);
      if (!ok) {
        const shot = await tryScreenshot(CTX);
        return { platform, status: 'need_manual', message: '官网登录方式非标准（可能需微信/手机验证），请在打开的浏览器中登录后再次点击「官网投递」', logs: logs.logs, company, position, screenshot: shot };
      }
      // 登录后回到投递页
      await bexec(CTX, 'navigate', { url: jobUrl, waitUntil: 'domcontentloaded' }, logs, '登录后重新打开官网');
      await sleep(2500);
    } else {
      logs.step('登录态', true, '已登录或无需登录');
    }

    // 找投递入口（官网可能是列表页，先尝试进入第一个投递项）
    let applied = false;
    for (const label of ['投递简历', '投递', '网申', '申请职位', '立即申请', '在线投递', '投个简历']) {
      const rr = await bexec(CTX, 'click', { text: label, timeout: 6000 }, logs, `点击「${label}」`);
      if (rr.ok) { applied = true; break; }
    }
    if (!applied) {
      const shot = await tryScreenshot(CTX);
      return { platform, status: 'need_manual', message: '未识别到官网「投递/网申」入口，请在打开的浏览器中手动完成投递', logs: logs.logs, company, position, screenshot: shot };
    }
    await sleep(2500);

    // 上传附件简历
    if (resumePath) {
      for (const sel of ['input[type=file]', '.resume-upload input', 'input[accept*="pdf"]', 'input[accept*="doc"]']) {
        const ur = await bexec(CTX, 'upload', { selector: sel, filePath: resumePath, timeout: 8000 }, logs, '上传简历附件');
        if (ur.ok) break;
      }
    }
    // 提交（二次确认弹窗）
    for (const label of ['确认投递', '提交', '确定', '保存并投递']) {
      await bexec(CTX, 'click', { text: label, timeout: 4000 }, logs, `点击「${label}」`);
    }
    await sleep(2000);

    text = await pageText(CTX);
    const shot = await tryScreenshot(CTX);
    const ok = /(投递成功|投递完成|已投递|网申成功|申请成功|简历已送达|提交成功)/.test(text);
    if (ok) {
      return { platform, status: 'applied', message: `已在官网向「${company || position || '该岗位'}」完成投递`, logs: logs.logs, company, position, screenshot: shot };
    }
    return { platform, status: 'need_manual', message: '已点击投递但未能确认成功，请检查打开的浏览器（可能需补填必填项）', logs: logs.logs, company, position, screenshot: shot };
  } catch (e: any) {
    const shot = await tryScreenshot(CTX).catch(() => undefined);
    return { platform, status: 'error', message: e?.message || String(e), logs: logs.logs, company, position, screenshot: shot };
  }
}
