/**
 * 前程无忧（51job）专用投递脚本
 * 流程：检测登录态 →（未登录）邮箱验证码登录（验证码走 QQ 邮箱 IMAP 自动读取）→
 *       打开岗位详情 → 申请职位 / 在线投递 → 选择/上传附件简历 → 提交 → 检测投递成功。
 *
 * 51job 投递常弹出「选择简历」弹窗，脚本会尝试选「附件简历 / 我的简历」后点「确定/投递」。
 * 状态驱动、可重复执行；滑块返回 need_captcha。
 */
import { ApplyLogger, bexec, pageText, pageUrl, tryScreenshot, sleep, loginViaEmailCode, resolveResumePath } from './common.js';
import { getPlatform } from './platforms.js';
import type { ApplyInput, ApplyResult } from './types.js';

const LOGIN_URL = 'https://login.51job.com/login/login.php';
const HOME_URL = 'https://www.51job.com/';

function needsLogin(url: string, text: string): boolean {
  if (/login\.51job/.test(url)) return true;
  // 已登录强指标：这些元素只有登录后的 51job 才有（JD 页顶部「在线简历 <用户名>」、
  // 「我的投递」「职位推荐」等），命中即判定已登录。
  // 背景：原正则 /(登录|注册|...)/ 过于宽泛——页面任何角落出现「登录/注册」
  // （例如页脚的「企业注册」「免费注册」）都会把已登录用户误判为未登录，
  // 结果 51job 每单都跑去走验证码登录、报「未找到『发送验证码』按钮」，一个都投不出去。
  if (/(在线简历|我的投递|职位推荐|退出登录|我的简历|我的求职|个人中心|消息中心)/.test(text)) return false;
  return /(请登录|账号登录|账号密码登录|短信登录|扫码登录|立即登录|登录并投递|登录后投递|登录后可|登录无忧)/.test(text);
}

/** 检测 51job 的「访问验证」滑块验证码页（阿里云滑动验证） */
async function detectCaptcha(platform: string): Promise<boolean> {
  const r = await bexec(platform, 'eval', {
    script:
      '({title:document.title, t:(document.body?(document.body.innerText||"").replace(/\\s+/g," ").trim():"")})',
  });
  const d = (r.data as any) || {};
  const title = String(d.title || '');
  const text = String(d.t || '');
  return (
    /滑动验证页面/.test(title) ||
    /(访问验证|请按住滑块|拖动到最右边|aliyunCaptcha|nc-container|滑动验证)/.test(text)
  );
}

/**
 * 51job 简历选择弹窗的通用处理（列表直投 runJob51List 与单岗位 runJob51 共用）
 * 弹窗结构：.el-dialog.attachment_resume_dialog（或普通 .el-dialog），内含 .attachment_item 简历项，
 * 每项带 .radio 单选；底部确认键文案为 发送/确定/立即申请/提交。
 * 注意：必须用 eval 点选 radio，不能靠文本点「附件简历」（文本点不中 radio，导致弹窗未确认）。
 */
const PICK_RESUME = `(() => {
  const vis = e => e && e.offsetParent !== null;
  const d = [...document.querySelectorAll('.el-dialog.attachment_resume_dialog')].pop()
         || [...document.querySelectorAll('.el-dialog')].filter(vis).pop();
  if (!d) return { ok: false, why: 'no-dialog' };
  const items = [...d.querySelectorAll('.attachment_item')];
  if (!items.length) return { ok: true, picked: null };
  const it = items.find(x => /杨欣宇/.test(x.innerText || '')) || items[0];
  (it.querySelector('.radio') || it.querySelector('input[type=radio]') || it).click();
  return { ok: true, picked: (it.innerText || '').replace(/\\s+/g, ' ').trim() };
})()`;

const SEND = `(() => {
  const vis = e => e && e.offsetParent !== null;
  const d = [...document.querySelectorAll('.el-dialog.attachment_resume_dialog')].pop()
         || [...document.querySelectorAll('.el-dialog')].filter(vis).pop();
  if (!d) return { ok: false, why: 'no-dialog' };
  const b = [...d.querySelectorAll('button')]
    .find(x => /发送|确定|立即申请|提交|投递/.test((x.innerText || '').trim()));
  if (!b) return { ok: false, why: 'no-send-btn' };
  b.click();
  return { ok: true };
})()`;

// 弹窗没关掉会挡住下一次点击，用 Esc 兜底关闭（Element UI 默认 closeOnPressEscape）
const CLOSE_DLG = `(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, which: 27, bubbles: true }));
  return true;
})()`;

/** 轮询等待简历弹窗出现（最多 waitMs） */
const WAIT_DLG = (waitMs: number) => `(() => {
  const deadline = Date.now() + ${waitMs};
  const tick = () => {
    const vis = e => e && e.offsetParent !== null;
    const d = [...document.querySelectorAll('.el-dialog.attachment_resume_dialog')].pop()
           || [...document.querySelectorAll('.el-dialog')].filter(vis).pop();
    if (d && /(附件简历|我的简历|选择需要同步发送|选择简历|杨欣宇|\\.pdf)/.test(d.innerText || '')) return true;
    if (Date.now() > deadline) return 'timeout';
    return new Promise(r => setTimeout(r, 300)).then(tick);
  };
  return tick();
})()`;

/**
 * 列表页直投（51job 首选路径）
 *
 * 直接 goto JD 详情页会触发 51job 的阿里云滑块风控，而搜索列表页每行自带「投递」按钮：
 * 点按钮 → 弹「选择需要同步发送的附件简历」→ 勾选简历 → 点「发送」，行按钮变「已申请」即成功。
 * 全程不跳 JD 页，天然绕开滑块，且速度快一个量级。
 */
export async function runJob51List(input: ApplyInput, keyword: string, maxApply: number): Promise<ApplyResult> {
  const logs = new ApplyLogger();
  const platform = 'job51';
  const cfg = getPlatform('job51');
  let applied = 0;
  let skipped = 0;
  const done: string[] = [];

  const rowScript = (i: number, stage: 'click' | 'verify') => `
(() => {
  const rows = [...document.querySelectorAll('.joblist-item')];
  const r = rows[${i}];
  if (!r) return { ok: false, why: 'no-row' };
  const txt = (r.innerText || '').replace(/\\s+/g, ' ');
  const btns = [...r.querySelectorAll('button,a')]
    .filter(b => /^(投递|立即投递|申请|已申请|已投递)$/.test((b.innerText || '').trim()));
  const b = btns[btns.length - 1];
  if (!b) return { ok: false, why: 'no-btn', title: txt.slice(0, 40) };
  const label = (b.innerText || '').trim();
  if (${stage === 'click'}) {
    if (/已申请|已投递/.test(label)) return { ok: false, why: 'already', title: txt.slice(0, 40) };
    // 校招岗位需单独校招简历，账号没有，直接跳过
    if (/校招|校园招聘/.test(txt.slice(0, 60))) return { ok: false, why: 'campus', title: txt.slice(0, 40) };
    b.click();
    return { ok: true, title: txt.slice(0, 40) };
  }
  return { ok: /已申请|已投递/.test(label), label, title: txt.slice(0, 40) };
})()`;

  // 勾选附件简历 / 发送 / 关闭弹窗 均复用模块级 PICK_RESUME / SEND / CLOSE_DLG

  try {
    const searchUrl = cfg ? cfg.searchUrl(keyword) : `https://we.51job.com/pc/search?keyword=${encodeURIComponent(keyword)}&partner=`;
    await bexec(platform, 'navigate', { url: searchUrl, waitUntil: 'domcontentloaded' }, logs, `搜索「${keyword}」`);
    await sleep(4500);

    if (await detectCaptcha(platform)) {
      const shot = await tryScreenshot(platform);
      return {
        platform, status: 'need_captcha',
        message: '51job 弹出「访问验证」滑块验证码，已暂停。请在打开的浏览器中手动完成滑块验证后重新运行本批次。',
        logs: logs.logs, screenshot: shot,
      };
    }

    const nRes = await bexec(platform, 'eval', { script: `[...document.querySelectorAll('.joblist-item')].length` }, logs, '读取列表');
    const n = Number(nRes.data) || 0;
    logs.step('列表岗位', true, `共 ${n} 条`);
    if (!n) {
      const shot = await tryScreenshot(platform);
      return { platform, status: 'need_manual', message: '搜索列表未渲染出岗位（可能未登录或页面结构变化）', logs: logs.logs, screenshot: shot };
    }

    for (let i = 0; i < n && applied < maxApply; i++) {
      const c = await bexec(platform, 'eval', { script: rowScript(i, 'click') }, logs, `第${i + 1}个岗位`);
      const cd = (c.data || {}) as any;
      if (!cd.ok) {
        skipped++;
        if (cd.why === 'campus') logs.step('岗位类型', false, `校招岗位，跳过：${cd.title || ''}`);
        continue;
      }
      await sleep(1800);

      const pick = await bexec(platform, 'eval', { script: PICK_RESUME }, logs, '勾选附件简历');
      const pd = (pick.data || {}) as any;
      if (pd.picked) logs.step('附件简历', true, pd.picked);
      await sleep(800);

      await bexec(platform, 'eval', { script: SEND }, logs, '点击「发送」');
      await sleep(2500);

      const v = await bexec(platform, 'eval', { script: rowScript(i, 'verify') }, logs, '校验投递结果');
      const vd = (v.data || {}) as any;
      if (vd.ok) {
        applied++;
        done.push(String(vd.title || `第${i + 1}个岗位`));
        logs.step('投递结果', true, `已申请：${vd.title || ''}`);
      } else {
        skipped++;
        logs.step('投递结果', false, `未成功（按钮=${vd.label || '?'}）：${vd.title || ''}`);
        await bexec(platform, 'eval', { script: CLOSE_DLG }, logs, '关闭残留弹窗');
      }
      // 节奏控制：投递过快会拉高 51job 风控评分
      await sleep(2500);
    }

    const shot = await tryScreenshot(platform).catch(() => undefined);
    if (applied > 0) {
      return {
        platform, status: 'applied', logs: logs.logs, screenshot: shot,
        message: `已在 51job 完成 ${applied} 个岗位投递${done.length ? `：${done.slice(0, 5).join('、')}` : ''}`,
        appliedCount: applied,
      };
    }
    return {
      platform, status: 'need_manual', logs: logs.logs, screenshot: shot,
      message: `未成功投递（跳过 ${skipped} 个）。若提示滑块请在浏览器中手动通过后重跑。`,
      appliedCount: 0,
    };
  } catch (e: any) {
    const shot = await tryScreenshot(platform).catch(() => undefined);
    return { platform, status: 'error', message: e?.message || String(e), logs: logs.logs, screenshot: shot };
  }
}

export async function runJob51(input: ApplyInput): Promise<ApplyResult> {
  const logs = new ApplyLogger();
  const platform = 'job51';
  const resumePath = resolveResumePath(input.profile.resume_path);
  if (!input.profile.resume_path) {
    logs.step('简历附件', false, `档案未配置 resume_path，使用内置默认简历：${resumePath || '(未找到)'}`);
  } else if (resumePath !== input.profile.resume_path) {
    logs.step('简历附件', false, `配置的 resume_path 不可用，已回退默认简历：${resumePath || '(未找到)'}`);
  }
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

      // 51job 反爬：JD 页可能被「访问验证」滑块拦截（阿里云滑动验证）。
      // 命中时不应继续投递，需暂停让用户手动过滑块，避免反复重试反而加剧风险评分。
      if (await detectCaptcha(platform)) {
        const shot = await tryScreenshot(platform);
        return {
          platform, status: 'need_captcha',
          message: '51job 弹出「访问验证」滑块验证码，已暂停自动投递。请在打开的浏览器中手动完成滑块验证（按住滑块拖到最右），通过后重新运行本次投递即可继续。',
          logs: logs.logs, company, position, screenshot: shot,
        };
      }

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
        if (await detectCaptcha(platform)) {
          const shot = await tryScreenshot(platform);
          return {
            platform, status: 'need_captcha',
            message: '51job 弹出「访问验证」滑块验证码，已暂停自动投递。请在打开的浏览器中手动完成滑块验证（按住滑块拖到最右），通过后重新运行本次投递即可继续。',
            logs: logs.logs, company, position, screenshot: shot,
          };
        }
      }
    } else {
      logs.step('登录态', true, '已登录');
    }

    if (jobUrl) {
      // 用平台专用 applyScript 点主投递按钮（锚定正则，兼容「投递/立即投递/立即申请/申请职位」等变体，
      // 并自动关掉「我知道了」提示）。job51 走 CDP 真实 Chrome，eval 同样可用。
      // 部分 JD 页按钮异步渲染，先等 1 秒再试，最多重试 3 次。
      const applyScript = getPlatform('job51')?.applyScript;
      let applied = false;
      let lastApplyData: any = null;
      for (let attempt = 0; attempt < 3 && !applied; attempt++) {
        if (attempt > 0) {
          await sleep(1000);
          logs.step('重试投递按钮', false, `第 ${attempt + 1} 次查找`);
        }
        if (applyScript) {
          const r = await bexec(platform, 'eval', { script: applyScript }, logs, '点击主投递按钮');
          lastApplyData = r.data;
          applied = r.ok && (r.data === 'main' || r.data === true);
          if (applied) break;
        }
        // 兜底：通用文本点击。扩展文案覆盖常见变体。
        for (const label of ['投递', '立即投递', '申请', '立即申请', '申请职位', '投递简历', '申请该职位', '一键投递', '投简历', '确认投递', '提交申请', '我要投递']) {
          const rr = await bexec(platform, 'click', { text: label, timeout: 4000 }, logs, `点击「${label}」`);
          if (rr.ok) { applied = true; break; }
        }
        if (applied) break;
        // 滚动到底部再试一次（有些按钮在首屏下方异步加载）
        await bexec(platform, 'eval', { script: 'window.scrollTo(0, document.body.scrollHeight); true;' }, logs, '滚动页面');
      }
      if (!applied) {
        const shot = await tryScreenshot(platform);
        const isWechatH5 = /\/wechat\/|xym\.51job|m\.51job/.test(jobUrl);
        const curUrl = await pageUrl(platform).catch(() => jobUrl);
        const html = await bexec(platform, 'html', { maxLength: 6000 }, logs, '抓取页面HTML片段').catch(() => ({ html: '' }));
        const htmlPreview = (html.html || '').slice(0, 500).replace(/\s+/g, ' ');
        logs.step('诊断', false, `url=${curUrl}; applyData=${JSON.stringify(lastApplyData)}; html片段=${htmlPreview}`);
        return {
          platform, status: 'need_manual', logs: logs.logs, company, position, screenshot: shot,
          message: isWechatH5
            ? '该岗位链接是 51job 微信端/移动端页面（Vue 单页应用，无桌面投递按钮），自动投递不可靠，请手动打开链接投递'
            : `未找到「投递/申请职位」按钮，可能页面结构变化或需先登录。url=${curUrl}`,
        };
      }
      await sleep(2500);

      // 岗位已下线/审核中：51job 会直接跳到「当前职位审核中或已下线」页，不弹投递框
      const preText = await pageText(platform);
      if (/(当前职位审核中或已下线|职位已下线|该职位已失效|职位已关闭|该职位不存在|该职位可能已)/.test(preText)) {
        const shot = await tryScreenshot(platform).catch(() => undefined);
        return { platform, status: 'unavailable', message: '该岗位已下线/审核中，无法投递', logs: logs.logs, company, position, screenshot: shot };
      }

      // —— 简历选择弹窗（51job 要求选附件简历时弹出）——
      // 用模块级 PICK_RESUME/SEND（eval 点 radio，比文本点可靠），最多重试 3 次。
      // 无弹窗（默认用在线简历直接投递）的岗位，点完即成功，下面校验会命中。
      let confirmed = false;
      for (let attempt = 0; attempt < 3 && !confirmed; attempt++) {
        await bexec(platform, 'eval', { script: WAIT_DLG(4000) }, logs, '等待简历弹窗');
        const pick = await bexec(platform, 'eval', { script: PICK_RESUME }, logs, '勾选附件简历');
        const pd = (pick.data || {}) as any;
        if (pd.picked) logs.step('附件简历', true, pd.picked);
        else if (pd.why === 'no-dialog') logs.step('简历弹窗', false, '未出现（可能已用默认在线简历直接投递）');
        await sleep(800);
        await bexec(platform, 'eval', { script: SEND }, logs, '点击「发送/确定」');
        await sleep(2500);
        const t2 = await pageText(platform);
        if (/(投递成功|申请成功|已投递|简历已送达|提交成功|投递完成|申请已提交|投递申请已提交|申请已发出|已向该公司投递|申请职位成功)/.test(t2)) {
          confirmed = true;
          text = t2;
        } else {
          await bexec(platform, 'eval', { script: CLOSE_DLG }, logs, '关闭残留弹窗');
          await sleep(800);
        }
      }

      // 极少数 JD 强制要求上传附件（选完简历后仍提示传 PDF）
      if (!confirmed && resumePath) {
        for (const sel of ['input[type=file]', '.resume-upload input', 'input[accept*="pdf"]']) {
          const ur = await bexec(platform, 'upload', { selector: sel, filePath: resumePath, timeout: 3500 }, logs, '上传简历附件');
          if (ur.ok) {
            await bexec(platform, 'eval', { script: SEND }, logs, '点击「发送/确定」');
            await sleep(2500);
            const t3 = await pageText(platform);
            if (/(投递成功|申请成功|已投递|简历已送达|提交成功|投递完成|申请已提交|投递申请已提交|申请已发出|已向该公司投递|申请职位成功)/.test(t3)) { confirmed = true; text = t3; }
            break;
          }
        }
      }
      await sleep(1500);

      text = await pageText(platform);
      const afterUrl = await pageUrl(platform);
      logs.step('投递后URL', true, afterUrl);
      logs.step('投递后页面文本', true, text.slice(0, 200));
      const shot = await tryScreenshot(platform);
      if (confirmed) {
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
