/**
 * BOSS 直聘 专用投递脚本
 * 流程：检测登录态 →（未登录）邮箱验证码登录（验证码走 QQ 邮箱 IMAP 自动读取）→
 *       打开岗位详情 → 立即沟通 / 投简历 → 发送招呼语 → 检测投递成功。
 *
 * 说明：BOSS 的投递本质是「发起沟通并发送简历」，且常有人机校验（滑块/短信）。
 * 脚本状态驱动、可重复执行：登录态由持久化上下文保留，遇到滑块返回 need_captcha，
 * 用户在打开的浏览器里人工过一下后再次调用即可继续。
 */
import { ApplyLogger, bexec, pageText, pageUrl, tryScreenshot, sleep, loginViaEmailCode, resolveResumePath } from './common.js';
import type { ApplyInput, ApplyResult } from './types.js';

const LOGIN_URL = 'https://www.zhipin.com/web/user/?ka=header-login';
const HOME_URL = 'https://www.zhipin.com/';

function needsLogin(url: string, text: string): boolean {
  if (/web\/user|login\.zhipin|passport\.zhipin/.test(url)) return true;
  return /(邮箱登录|短信登录|账号密码登录|扫码登录|验证码登录)/.test(text);
}

export async function runBoss(input: ApplyInput): Promise<ApplyResult> {
  const logs = new ApplyLogger();
  const platform = 'boss';
  const resumePath = resolveResumePath(input.profile.resume_path);
  const jobUrl = input.jobUrl || input.job?.apply_url || undefined;
  const company = input.job?.company ?? null;
  const position = input.job?.position ?? null;

  try {
    // 1) 打开岗位详情页（若未给链接则先回首页）
    if (jobUrl) {
      await bexec(platform, 'navigate', { url: jobUrl, waitUntil: 'domcontentloaded' }, logs, '打开岗位详情');
    } else {
      await bexec(platform, 'navigate', { url: HOME_URL, waitUntil: 'domcontentloaded' }, logs, '打开 BOSS 首页');
    }
    await sleep(2000);

    let text = await pageText(platform);
    let url = jobUrl || HOME_URL;

    // 2) 登录态检测
    if (needsLogin(url, text)) {
      logs.step('登录态', false, '未登录，执行邮箱验证码登录');
      const r = await loginBoss(input, logs);
      if (r.status === 'need_captcha') {
        const shot = await tryScreenshot(platform);
        return { platform, status: 'need_captcha', message: r.message, logs: logs.logs, company, position, screenshot: shot };
      }
      if (r.status === 'error') {
        const shot = await tryScreenshot(platform);
        return { platform, status: 'error', message: r.message, logs: logs.logs, company, position, screenshot: shot };
      }
      // 登录后回到岗位页
      if (jobUrl) {
        await bexec(platform, 'navigate', { url: jobUrl, waitUntil: 'domcontentloaded' }, logs, '登录后重新打开岗位');
        await sleep(2000);
      }
    } else {
      logs.step('登录态', true, '已登录');
    }

    // 3) 发起沟通 / 投递
    if (jobUrl) {
      // 立即沟通（BOSS 投递入口）
      let chatted = false;
      const labels = ['立即沟通', '投个简历', '在线简历', '投递', '沟通一下', '感兴趣', '发简历', '投递简历'];
      for (const label of labels) {
        const rr = await bexec(platform, 'click', { text: label, timeout: 10000 }, logs, `点击「${label}」`);
        if (rr.ok) { chatted = true; break; }
      }
      if (!chatted) {
        const shot = await tryScreenshot(platform);
        const page = await pageText(platform);
        const url = await pageUrl(platform);
        const html = await bexec(platform, 'html', { maxLength: 4000 }, logs, '抓取页面HTML片段');
        logs.step('诊断', false, `url=${url}; 页面文本前500字=${page.slice(0, 500)}; html片段=${(html.html || '').slice(0, 500)}`);
        return { platform, status: 'need_manual', message: '未找到「立即沟通/投简历」按钮，可能页面结构变化或需先完善在线简历', logs: logs.logs, company, position, screenshot: shot };
      }
      await sleep(2500);

      // 3.5) 点击后检测页面状态：可能进入聊天，也可能被引导到「完善在线简历 / 开通 VIP」页
      const postClickUrl = await pageUrl(platform);
      const postClickText = await pageText(platform);
      const guidedToResume = /cv\.zhipin\.com\/edit-resume|linkFrom=boss|完善简历|在线简历|开通会员|尊享会员/.test(postClickUrl + ' ' + postClickText.slice(0, 300));
      const inChat = /web\/im|chat\.zhipin|web\/geek\/chat|\.chat-conversation|聊天/.test(postClickUrl + ' ' + postClickText.slice(0, 300));

      // 情况 A：进入「完善在线简历 / VIP」引导页（未进入聊天）—— 直接尝试发送附件简历，不走完善在线简历
      if (guidedToResume && !inChat) {
        logs.step('投递引导', false, `点击后进入简历完善/VIP 引导页：${postClickUrl}，尝试直接发送附件简历`);
        const sent = await uploadResumeAttachment(platform, resumePath, logs);
        await sleep(2500);
        const afterText = await pageText(platform);
        const afterUrl = await pageUrl(platform);
        const shot = await tryScreenshot(platform);
        if (sent && (/(已发送|发送成功|简历已送达|沟通中|投递成功|附件已|已发送给您)/.test(afterText) || /web\/im|chat/.test(afterUrl))) {
          return { platform, status: 'applied', message: `已在引导页通过附件简历向「${company || position || '该岗位'}」发起沟通`, logs: logs.logs, company, position, screenshot: shot };
        }
        if (sent) {
          return { platform, status: 'need_manual', message: '已在引导页上传附件简历，但未能确认沟通是否建立，请在调试 Chrome 中确认是否成功发送', logs: logs.logs, company, position, screenshot: shot };
        }
        return { platform, status: 'need_manual', message: 'BOSS 要求先完善在线简历或开通 VIP 才能投递。可在调试 Chrome 内点「上传附件简历」手动发送，或完善在线简历后再试', logs: logs.logs, company, position, screenshot: shot };
      }

      // 情况 B：已进入聊天（或岗位页可直接沟通）—— 发送招呼语 + 附件简历
      // 在聊天框发送招呼语（BOSS 需主动发消息才会建立沟通）
      const greeting = `您好，我对「${position || '该岗位'}」很感兴趣，这是我的简历，期待进一步沟通。`;
      for (const sel of ['.chat-input', '#chat-input', 'textarea[placeholder*="沟通"]', 'div[contenteditable="true"]']) {
        const fr = await bexec(platform, 'fill', { selector: sel, value: greeting, timeout: 5000 }, logs, '填写招呼语');
        if (fr.ok) break;
      }
      for (const sel of ['发送', 'button:has-text("发送")', '.send-btn']) {
        const sr = await bexec(platform, 'click', { text: '发送', timeout: 5000 }, logs, '发送招呼语');
        if (sr.ok) break;
      }

      // 上传附件简历（固定使用默认简历 PDF，无需完善在线简历）
      await uploadResumeAttachment(platform, resumePath, logs);
      await sleep(2000);

      text = await pageText(platform);
      const shot = await tryScreenshot(platform);
      const ok = /(已发送|发送成功|简历已送达|沟通中|在线简历已|附件已|已发送给您)/.test(text) || /沟通/.test(text);
      if (ok) {
        return { platform, status: 'applied', message: `已在 BOSS 向「${company || position || '该岗位'}」发起沟通并发送附件简历`, logs: logs.logs, company, position, screenshot: shot };
      }
      return { platform, status: 'need_manual', message: '已点击沟通并发送附件简历，但未能确认投递成功，请检查打开的浏览器', logs: logs.logs, company, position, screenshot: shot };
    }

    // 未给岗位链接：仅完成登录即返回，等待用户补充岗位
    const shot = await tryScreenshot(platform);
    return { platform, status: 'need_login', message: '已登录；请提供岗位详情链接以继续投递', logs: logs.logs, company, position, screenshot: shot };
  } catch (e: any) {
    const shot = await tryScreenshot(platform).catch(() => undefined);
    return { platform, status: 'error', message: e?.message || String(e), logs: logs.logs, company, position, screenshot: shot };
  }
}

/**
 * 上传附件简历（PDF）。BOSS 聊天页 / 简历完善页均有「上传附件简历」入口，
 * 对应隐藏 file input 为 input[ka=user-resume-upload-file]（accept 含 pdf）。
 * 优先直接对 file input 写入文件；若 file input 尚未出现，则先点按钮唤起再上传。
 */
async function uploadResumeAttachment(platform: string, resumePath: string | undefined, logs: ApplyLogger): Promise<boolean> {
  if (!resumePath) {
    logs.step('简历附件', false, '未配置简历路径，跳过附件上传');
    return false;
  }
  const selectors = [
    'input[ka=user-resume-upload-file]',
    'input[accept*="pdf"]',
    'input[type=file]',
    '.resume-upload input',
  ];
  // 1) 先尝试直接对 file input 写文件（最精准，不依赖先点按钮）
  for (const sel of selectors) {
    const ur = await bexec(platform, 'upload', { selector: sel, filePath: resumePath, timeout: 8000 }, logs, '上传简历附件');
    if (ur.ok) {
      logs.step('简历附件', true, `已上传附件简历：${resumePath}`);
      return true;
    }
  }
  // 2) file input 未出现：先点「上传附件简历」按钮唤起，再上传
  for (const label of ['上传附件简历', '发送附件简历', '上传简历', '附件简历']) {
    const cr = await bexec(platform, 'click', { text: label, timeout: 4000 }, logs, `点击「${label}」`);
    if (cr.ok) break;
  }
  await sleep(1500);
  for (const sel of selectors) {
    const ur = await bexec(platform, 'upload', { selector: sel, filePath: resumePath, timeout: 10000 }, logs, '上传简历附件');
    if (ur.ok) {
      logs.step('简历附件', true, `已上传附件简历：${resumePath}`);
      return true;
    }
  }
  logs.step('简历附件', false, '未找到上传附件简历入口');
  return false;
}

/** BOSS 邮箱验证码登录 */
async function loginBoss(input: ApplyInput, logs: ApplyLogger) {
  const profile = input.profile;
  return loginViaEmailCode('boss', {
    loginUrl: LOGIN_URL,
    logs,
    profile,
    sinceMinutes: input.sinceMinutes || 10,
    subjectKeyword: 'BOSS',
    selectors: {
      emailTab: ['邮箱登录'],
      emailInput: ['#email', 'input[placeholder*="邮箱"]', 'input[name="email"]'],
      sendCodeBtn: ['获取验证码', '发送验证码'],
      codeInput: ['#code', 'input[placeholder*="验证码"]', 'input[name="code"]'],
      submitBtn: ['登录', '立即登录', '确认'],
      sliderHint: ['请拖动', '滑动验证', '拖动滑块'],
    },
  });
}
