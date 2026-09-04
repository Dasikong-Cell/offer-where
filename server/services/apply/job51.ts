/**
 * 前程无忧（51job）专用投递脚本
 * 流程：检测登录态 →（未登录）邮箱验证码登录（验证码走 QQ 邮箱 IMAP 自动读取）→
 *       打开岗位详情 → 申请职位 / 在线投递 → 选择/上传附件简历 → 提交 → 检测投递成功。
 *
 * 51job 投递常弹出「选择简历」弹窗，脚本会尝试选「附件简历 / 我的简历」后点「确定/投递」。
 * 状态驱动、可重复执行；滑块返回 need_captcha。
 */
import { ApplyLogger, bexec, pageText, tryScreenshot, sleep, loginViaEmailCode } from './common.js';
import type { ApplyInput, ApplyResult } from './types.js';

const LOGIN_URL = 'https://login.51job.com/login/login.php';
const HOME_URL = 'https://www.51job.com/';

function needsLogin(url: string, text: string): boolean {
  if (/login\.51job/.test(url)) return true;
  return /(登录|注册|账号密码登录|短信登录|请登录|立即登录)/.test(text);
}

export async function runJob51(input: ApplyInput): Promise<ApplyResult> {
  const logs = new ApplyLogger();
  const platform = 'job51';
  const resumePath = input.profile.resume_path || undefined;
  const jobUrl = input.jobUrl || input.job?.apply_url || undefined;
  const company = input.job?.company ?? null;
  const position = input.job?.position ?? null;

  try {
    if (jobUrl) {
      await bexec(platform, 'navigate', { url: jobUrl, waitUntil: 'domcontentloaded' }, logs, '打开岗位详情');
    } else {
      await bexec(platform, 'navigate', { url: HOME_URL, waitUntil: 'domcontentloaded' }, logs, '打开 51job 首页');
    }
    await sleep(2000);

    let text = await pageText(platform);
    let url = jobUrl || HOME_URL;

    if (needsLogin(url, text)) {
      logs.step('登录态', false, '未登录，执行邮箱验证码登录');
      const r = await loginViaEmailCode('job51', {
        loginUrl: LOGIN_URL,
        logs,
        profile: input.profile,
        sinceMinutes: input.sinceMinutes || 10,
        subjectKeyword: '51job',
        selectors: {
          emailTab: ['邮箱登录', '账号登录'],
          emailInput: ['#email', 'input[placeholder*="邮箱"]', 'input[name="email"]', 'input[name="loginName"]'],
          sendCodeBtn: ['获取验证码', '发送验证码'],
          codeInput: ['#code', 'input[placeholder*="验证码"]', 'input[name="code"]'],
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
      // 申请职位 / 在线投递
      let applied = false;
      for (const label of ['立即投递', '申请职位', '在线投递', '立即申请', '投个简历', '投递简历']) {
        const rr = await bexec(platform, 'click', { text: label, timeout: 6000 }, logs, `点击「${label}」`);
        if (rr.ok) { applied = true; break; }
      }
      if (!applied) {
        const shot = await tryScreenshot(platform);
        const isWechatH5 = /\/wechat\/|xym\.51job|m\.51job/.test(jobUrl);
        return {
          platform, status: 'need_manual', logs: logs.logs, company, position, screenshot: shot,
          message: isWechatH5
            ? '该岗位链接是 51job 微信端/移动端页面（Vue 单页应用，无桌面投递按钮），自动投递不可靠，请手动打开链接投递'
            : '未找到「申请职位/在线投递」按钮，可能页面结构变化或需先完善简历',
        };
      }
      await sleep(2500);

      // 选择简历弹窗：优先选「附件简历 / 我的简历」再确定
      for (const sel of ['附件简历', '我的简历', '上传的简历']) {
        await bexec(platform, 'click', { text: sel, timeout: 3000 }, logs, `选择简历「${sel}」`);
      }
      for (const sel of ['确定', '投递', '提交申请']) {
        await bexec(platform, 'click', { text: sel, timeout: 4000 }, logs, `点击「${sel}」`);
      }
      await sleep(2000);

      // 若仍要求上传附件
      if (resumePath) {
        for (const sel of ['input[type=file]', '.resume-upload input', 'input[accept*="pdf"]']) {
          const ur = await bexec(platform, 'upload', { selector: sel, filePath: resumePath, timeout: 8000 }, logs, '上传简历附件');
          if (ur.ok) {
            for (const lbl of ['确定', '保存', '提交']) {
              await bexec(platform, 'click', { text: lbl, timeout: 4000 }, logs, `点击「${lbl}」`);
            }
            break;
          }
        }
      }
      await sleep(2000);

      text = await pageText(platform);
      const shot = await tryScreenshot(platform);
      const ok = /(投递成功|申请成功|已投递|简历已送达|提交成功|投递完成)/.test(text);
      if (ok) {
        return { platform, status: 'applied', message: `已在 51job 向「${company || position || '该岗位'}」完成投递`, logs: logs.logs, company, position, screenshot: shot };
      }
      return { platform, status: 'need_manual', message: '已点击申请但未能确认投递成功，请检查打开的浏览器（可能需补填必填项/选择简历）', logs: logs.logs, company, position, screenshot: shot };
    }

    const shot = await tryScreenshot(platform);
    return { platform, status: 'need_login', message: '已登录；请提供岗位详情链接以继续投递', logs: logs.logs, company, position, screenshot: shot };
  } catch (e: any) {
    const shot = await tryScreenshot(platform).catch(() => undefined);
    return { platform, status: 'error', message: e?.message || String(e), logs: logs.logs, company, position, screenshot: shot };
  }
}
