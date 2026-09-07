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
import fs from 'node:fs';
import { ApplyLogger, bexec, pageText, tryScreenshot, sleep, pollEmailCode, resolveResumePath } from './common.js';
import { sendMail } from '../mail.js';
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

/** 邮箱正则 */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** 明显不是 HR 邮箱的地址 */
const EMAIL_BLACKLIST = /(no-?reply|donotreply|do-not-reply|bounce|postmaster|abuse|webmaster@)/i;

/** 标题格式占位符 → 档案字段 */
const SUBJECT_TOKENS: Array<[RegExp, (p: ApplyInput['profile'] & Record<string, any>, job?: ApplyInput['job']) => string]> = [
  [/学历|学位/, p => p.education || ''],
  [/专业/, p => p.major || ''],
  [/学校|院校|毕业院校/, p => p.school || ''],
  [/姓名|名字/, p => p.name || ''],
  [/电话|手机|联系方式/, p => p.phone || ''],
  [/岗位|职位|应聘岗位|意向岗位/, (_p, job) => job?.position || ''],
  [/城市|意向城市|地点/, p => p.city || ''],
  [/届|毕业年份|毕业届/, p => (p as any).graduationYear || ''],
];

/** 占位符词表：只有这些词才会被替换成档案值，遇到其它词说明格式串已经越界 */
const KNOWN_TOKEN_RE =
  /^(学历|学位|专业|学校|院校|毕业院校|姓名|名字|电话|手机|联系方式|岗位|职位|应聘岗位|意向岗位|城市|意向城市|地点|届|毕业年份|毕业届)$/;

/** 解析「邮件标题格式：学历+专业+学校+姓名」这类说明 */
function parseSubjectSpec(text: string): { tokens: string[]; sep: string } | null {
  const m = text.match(/标题格式[」》"'“”\s:：]*([^\n。；;，,]{2,60})/);
  if (!m) return null;
  // 只取「中文词(+中文词)+」这条链，避免把后面正文（如「内推举荐 鼓励通过导师…」）一起吃进来
  const chain = m[1].match(/[\u4e00-\u9fa5A-Za-z]{2,8}(?:\+[\u4e00-\u9fa5A-Za-z]{2,8})+/);
  const sepMatch = m[1].match(/([+\-、\/|])/);
  const spec = (chain ? chain[0] : m[1]).trim();
  const sep = sepMatch ? sepMatch[1] : '+';
  const raw = spec.split(/[+\-、\/|]/).map(s => s.trim()).filter(Boolean);
  // 从第一个已知占位符起，遇到未知词立即截断
  const tokens: string[] = [];
  for (const t of raw) {
    if (!KNOWN_TOKEN_RE.test(t)) break;
    tokens.push(t);
  }
  return tokens.length ? { tokens, sep } : null;
}

/** 按岗位要求拼邮件标题 */
function buildSubject(
  text: string,
  profile: ApplyInput['profile'] & Record<string, any>,
  job?: ApplyInput['job'],
): { subject: string; matched: boolean } {
  const spec = parseSubjectSpec(text);
  if (!spec) {
    const name = profile.name || '应聘者';
    const pos = job?.position || '';
    return { subject: pos ? `应聘${pos}-${name}-${profile.phone || ''}` : `应聘简历-${name}`, matched: false };
  }
  const parts = spec.tokens.map(tok => {
    const hit = SUBJECT_TOKENS.find(([re]) => re.test(tok));
    return hit ? (hit[1](profile, job) || tok) : tok;
  });
  const subject = parts.join(spec.sep);
  // 档案缺字段时会残留「学历/专业/学校/姓名」这类占位词，这种标题发了等于没发，回退默认标题
  if (parts.some(p => KNOWN_TOKEN_RE.test(p))) {
    const name = profile.name || '应聘者';
    const pos = job?.position || '';
    return { subject: pos ? `应聘${pos}-${name}` : `应聘简历-${name}`, matched: false };
  }
  return { subject, matched: true };
}

/**
 * 微信推文 / 纯官网「邮箱投递」通道
 *
 * 很多单位（尤其军工/院所）在招聘推文里只给 HR 邮箱 + 标题格式，没有可点的网申入口。
 * 这类岗位自动投递的唯一可行路径就是发邮件：解析出邮箱 → 按其格式拼标题 → 附简历 PDF 发出。
 */
export async function runOfferbiuEmail(input: ApplyInput): Promise<ApplyResult> {
  const logs = new ApplyLogger();
  const platform = 'offerbiu';
  const jobUrl = input.jobUrl || input.job?.apply_url || undefined;
  const company = input.job?.company ?? null;
  const position = input.job?.position ?? null;
  const resumePath = resolveResumePath(input.profile.resume_path);

  if (!jobUrl) {
    return { platform, status: 'need_login', message: '该岗位缺少投递入口链接', logs: logs.logs, company, position };
  }

  try {
    await bexec(CTX, 'navigate', { url: jobUrl, waitUntil: 'domcontentloaded' }, logs, '打开招聘推文');
    await sleep(3000);
    let text = await pageText(CTX);
    // 微信推文懒加载/风控常导致首屏拿不到正文，正文过短就再等一轮重取
    if (text.length < 300) {
      logs.step('页面解析', false, `正文仅 ${text.length} 字，等待重试`);
      await bexec(CTX, 'eval', { script: 'window.scrollTo(0, document.body.scrollHeight)' }, logs, '滚动加载');
      await sleep(5000);
      text = await pageText(CTX);
    }
    logs.step('页面解析', true, `正文 ${text.length} 字`);
    if (text.length < 300) {
      return {
        platform, status: 'need_manual', logs: logs.logs, company, position,
        message: '推文正文未能加载（微信可能要求验证或需登录），请在打开的浏览器中手动查看投递方式',
      };
    }

    // 1) 收集邮箱：优先取「邮箱/简历/投递/hr/联系」上下文附近的
    const all = Array.from(new Set(text.match(EMAIL_RE) || []));
    const selfMail = (input.profile.email || '').toLowerCase();
    const candidates = all.filter(e => !EMAIL_BLACKLIST.test(e) && e.toLowerCase() !== selfMail);
    if (!candidates.length) {
      return {
        platform, status: 'need_manual', logs: logs.logs, company, position,
        message: '推文中未找到可用的 HR 邮箱（可能只提供二维码/网申链接），请在打开的浏览器中手动投递',
      };
    }
    const scored = candidates.map(e => {
      const i = text.indexOf(e);
      const around = text.slice(Math.max(0, i - 80), i + e.length + 80);
      let score = 0;
      if (/邮箱|简历|投递|应聘/.test(around)) score += 5;
      if (/hr|HR|招聘|人力/.test(around)) score += 3;
      if (/联系|联系方式/.test(around)) score += 2;
      return { email: e, score };
    }).sort((a, b) => b.score - a.score);
    const to = scored[0].email;
    logs.step('提取邮箱', true, `${to}（候选 ${candidates.length} 个：${candidates.join(', ')}）`);

    // 2) 按推文给的「标题格式」拼标题
    const { subject, matched } = buildSubject(text, input.profile as any, input.job);
    logs.step('邮件标题', true, matched ? `按推文指定格式：${subject}` : `未识别到指定格式，使用默认：${subject}`);

    // 3) 正文
    const p = input.profile as any;
    const lines = [
      '您好！',
      '',
      `我在招聘信息中看到贵单位${position ? `「${position}」` : ''}岗位，非常感兴趣，特此投递简历，恳请查阅。`,
      '',
      '【基本信息】',
      `姓名：${p.name || ''}`,
      `学历：${p.education || ''}`,
      `学校：${p.school || ''}`,
      `专业：${p.major || ''}`,
      `电话：${p.phone || ''}`,
      `邮箱：${p.email || ''}`,
      `意向城市：${p.city || ''}`,
      p.skills ? `技能：${p.skills}` : '',
      '',
      '简历详见附件（PDF）。如需补充材料请随时联系，期待您的回复，谢谢！',
      '',
      p.name || '',
    ].filter(l => l !== undefined);
    const body = lines.filter(l => l !== '' || true).join('\n');

    // 4) 预览模式：只把解析结果写进日志，不真正发信，返回结构化预览供前端确认
    const attachments = resumePath && fs.existsSync(resumePath) ? [resumePath] : [];
    if (input.dryRun) {
      logs.step('预览（未发送）', true, `收件人=${to}；标题=${subject}；附件=${attachments[0] || '无'}`);
      logs.step('预览正文', true, body.slice(0, 300));
      return {
        platform, status: 'need_manual', logs: logs.logs, company, position,
        preview: { to, subject, body, attachment: attachments[0] },
        message: `预览完成（未发送）：将发往 ${to}，标题「${subject}」`,
      };
    }

    // 5) 发送
    const res = await sendMail({
      to,
      subject,
      text: body,
      attachments: attachments.length ? attachments : undefined,
      fromName: p.name || undefined,
    });
    if (!res.ok) {
      logs.step('发送邮件', false, res.error || '未知错误');
      return {
        platform, status: 'error', logs: logs.logs, company, position,
        message: `邮件发送失败：${res.error}`,
      };
    }
    logs.step('发送邮件', true, `已发送至 ${to}${resumePath ? '（含简历附件）' : '（无附件）'}`);
    return {
      platform, status: 'applied', logs: logs.logs, company, position,
      message: `已通过邮箱向「${company || to}」投递简历：${to}（标题：${subject}）`,
    };
  } catch (e: any) {
    return { platform, status: 'error', message: e?.message || String(e), logs: logs.logs, company, position };
  }
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
