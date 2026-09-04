/**
 * 牛客网（Nowcoder）专用投递脚本
 * 流程：检测登录态 →（未登录）邮箱验证码登录（验证码走 QQ 邮箱 IMAP 自动读取）→
 *       打开岗位详情 → 投递 / 投简历 → 上传附件 → 检测投递成功。
 *
 * 牛客岗位部分直接内投、部分外链到企业官网；脚本优先内投，未找到内投入口时提示人工。
 * 状态驱动、可重复执行；滑块返回 need_captcha。
 */
import { ApplyLogger, bexec, pageText, tryScreenshot, sleep, loginViaEmailCode } from './common.js';
import type { ApplyInput, ApplyResult } from './types.js';

const LOGIN_URL = 'https://www.nowcoder.com/login';
const HOME_URL = 'https://www.nowcoder.com/';

function needsLogin(url: string, text: string): boolean {
  if (/nowcoder\.com\/(login|register)/.test(url)) return true;
  return /(登录|注册|立即登录|扫码登录|账号密码)/.test(text);
}

export async function runNowcoder(input: ApplyInput): Promise<ApplyResult> {
  const logs = new ApplyLogger();
  const platform = 'nowcoder';
  const resumePath = input.profile.resume_path || undefined;
  const jobUrl = input.jobUrl || input.job?.apply_url || undefined;
  const company = input.job?.company ?? null;
  const position = input.job?.position ?? null;

  try {
    if (jobUrl) {
      await bexec(platform, 'navigate', { url: jobUrl, waitUntil: 'domcontentloaded' }, logs, '打开岗位详情');
    } else {
      await bexec(platform, 'navigate', { url: HOME_URL, waitUntil: 'domcontentloaded' }, logs, '打开牛客首页');
    }
    await sleep(2000);

    let text = await pageText(platform);
    let url = jobUrl || HOME_URL;

    if (needsLogin(url, text)) {
      logs.step('登录态', false, '未登录，执行邮箱验证码登录');
      const r = await loginViaEmailCode('nowcoder', {
        loginUrl: LOGIN_URL,
        logs,
        profile: input.profile,
        sinceMinutes: input.sinceMinutes || 10,
        subjectKeyword: '牛客',
        selectors: {
          emailTab: ['邮箱登录', '账号密码'],
          emailInput: ['input[name="email"]', '#email', 'input[placeholder*="邮箱"]', 'input[name="account"]'],
          sendCodeBtn: ['获取验证码', '发送验证码', '获取短信验证码'],
          codeInput: ['input[placeholder*="验证码"]', '#code', 'input[name="code"]'],
          submitBtn: ['登录', '立即登录', '确认'],
          sliderHint: ['请拖动', '滑动验证', '拖动滑块'],
        },
      });
      if (r.status === 'need_captcha') {
        const shot = await tryScreenshot(platform);
        return { platform, status: 'need_captcha', message: r.message, logs: logs.logs, company, position, screenshot: shot };
      }
      if (r.status === 'error') {
        const shot = await tryScreenshot(platform);
        return { platform, status: 'error', message: r.message, logs: logs.logs, company, position, screenshot: shot };
      }
      if (jobUrl) {
        await bexec(platform, 'navigate', { url: jobUrl, waitUntil: 'domcontentloaded' }, logs, '登录后重新打开岗位');
        await sleep(2000);
      }
    } else {
      logs.step('登录态', true, '已登录');
    }

    if (jobUrl) {
      // 内投入口
      let applied = false;
      for (const label of ['投递', '立即投递', '投简历', '申请职位', '在线投递']) {
        const rr = await bexec(platform, 'click', { text: label, timeout: 6000 }, logs, `点击「${label}」`);
        if (rr.ok) { applied = true; break; }
      }
      if (!applied) {
        const shot = await tryScreenshot(platform);
        return { platform, status: 'need_manual', message: '未找到「投递/投简历」按钮，该岗位可能外链企业官网，请用「官网投递」入口', logs: logs.logs, company, position, screenshot: shot };
      }
      await sleep(2500);

      // 上传附件简历
      if (resumePath) {
        for (const sel of ['input[type=file]', '.resume-upload input', 'input[accept*="pdf"]']) {
          const ur = await bexec(platform, 'upload', { selector: sel, filePath: resumePath, timeout: 8000 }, logs, '上传简历附件');
          if (ur.ok) break;
        }
      }
      // 提交（弹窗二次确认）
      for (const label of ['确认投递', '提交', '确定', '发送']) {
        await bexec(platform, 'click', { text: label, timeout: 4000 }, logs, `点击「${label}」`);
      }
      await sleep(2000);

      text = await pageText(platform);
      const shot = await tryScreenshot(platform);
      const ok = /(投递成功|投递完成|已投递|简历已送达|申请成功|提交成功)/.test(text);
      if (ok) {
        return { platform, status: 'applied', message: `已在牛客向「${company || position || '该岗位'}」完成投递`, logs: logs.logs, company, position, screenshot: shot };
      }
      return { platform, status: 'need_manual', message: '已点击投递但未能确认成功，请检查打开的浏览器（可能需补填必填项）', logs: logs.logs, company, position, screenshot: shot };
    }

    const shot = await tryScreenshot(platform);
    return { platform, status: 'need_login', message: '已登录；请提供岗位详情链接以继续投递', logs: logs.logs, company, position, screenshot: shot };
  } catch (e: any) {
    const shot = await tryScreenshot(platform).catch(() => undefined);
    return { platform, status: 'error', message: e?.message || String(e), logs: logs.logs, company, position, screenshot: shot };
  }
}
