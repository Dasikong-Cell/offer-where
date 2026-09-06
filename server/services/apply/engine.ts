/**
 * 统一「官网一键投递」引擎 —— 覆盖职得鸭全套投递功能
 *   hello   : 单岗位一键投递（打开 JD → 点 立即投递/立即沟通/聊一聊 → 确认）
 *   auto    : 按关键词(或默认列表)批量自动翻页投递
 *   keyword : 同 auto，但强制使用关键词搜索
 *   search  : 仅搜索收集岗位链接（不过滤、不投递），返回 foundJobs
 *   again   : 对 HR 会话复聊（发送回复）
 *   letter  : 打开岗位 → 发起沟通 → 发送求职信/招呼语
 *
 * 核心原则（对齐职得鸭）：一键完成，依赖账号已填好的在线简历，不碰表单/级联；
 * 用户选择「直接投不过滤」，故不做 AI 匹配门槛，凡是能点到的都一键投。
 */
import { ApplyLogger, bexec, pageText, tryScreenshot, sleep, loginViaEmailCode } from './common.js';
import { getPlatform, type PlatformCfg, type PlatformKey } from './platforms.js';
import { writeLetter } from './letterWriter.js';
import { runJob51, runJob51List } from './job51.js';
import type { ApplyInput, ApplyResult, ApplyPlatform } from './types.js';

async function currentUrl(platform: string): Promise<string> {
  const r = await bexec(platform, 'eval', { script: 'location.href' });
  return (r.data as string) || '';
}

function unsupported(platform: string): ApplyResult {
  return {
    platform: platform as ApplyPlatform,
    status: 'error',
    message: `不支持的平台：${platform}`,
    logs: [],
  };
}

/** 检测/处理登录态；已登录返回 true，未登录尝试邮箱验证码登录；失败返回 false */
async function ensureLoggedIn(
  platform: string,
  cfg: PlatformCfg,
  input: ApplyInput,
  logs: ApplyLogger,
): Promise<boolean> {
  const text = await pageText(platform);
  const url = await currentUrl(platform);
  if (!cfg.loginCheck(text, url)) {
    logs.step('登录态', true, '已登录');
    return true;
  }
  logs.step('登录态', false, '未登录，尝试邮箱验证码登录');
  if (!cfg.login) {
    return false;
  }
  const r = await loginViaEmailCode(platform, {
    loginUrl: cfg.login.loginUrl,
    logs,
    profile: input.profile,
    sinceMinutes: input.sinceMinutes || 10,
    subjectKeyword: cfg.login.subjectKeyword,
    selectors: cfg.login,
  });
  if (r.status === 'logged_in') {
    logs.step('登录', true, '邮箱验证码登录成功');
    await sleep(1500);
    return true;
  }
  if (r.status === 'need_captcha') {
    logs.step('登录', false, '出现滑块验证，请在打开的浏览器中人工完成后重试');
    return false;
  }
  return false;
}

type OneClickResult = { applied: boolean; needResume: boolean };

/** 在 JD 页点击投递/沟通按钮并确认 */
async function oneClickApply(platform: string, cfg: PlatformCfg, logs: ApplyLogger): Promise<OneClickResult> {
  const r = await bexec(platform, 'eval', { script: cfg.applyScript }, logs, `点击「${cfg.chatBased ? '沟通' : '投递'}」按钮`);
  await sleep(2500);
  // 非沟通型平台常弹出「选择简历 / 确认投递」弹窗，补点确认
  if (!cfg.chatBased) {
    // 先关掉可能出现的「我知道了 / 去完善 / 稍后再说」提示遮罩，避免挡住确认按钮
    for (const hint of ['我知道了', '去完善', '稍后再说', '关闭']) {
      await bexec(platform, 'click', { text: hint, timeout: 1500 });
    }
    await sleep(800);

    if (platform === 'job51') {
      // 校招/校园岗位需要单独的校招简历，账号仅有普通简历，点击「立即投递」通常无反应或跳简历中心；
      // 提前识别并跳过。注意：页面导航栏常驻「校园招聘」链接，必须用岗位标题(document.title)判断是否校招，
      // 不能用正文，否则会误杀普通岗位。
      const titleRes = await bexec(platform, 'eval', { script: 'document.title' });
      if (/校招|校园招聘/i.test(String(titleRes.data || ''))) {
        logs.step('岗位类型', false, '校招/校园岗位，账号无对应简历，跳过');
        return { applied: false, needResume: false };
      }
      // 51job 投递弹窗存在两种形态，统一用「先确认→选简历→再确认」顺序覆盖两者：
      //  A) 请选择需要投递的简历 →「立即申请」→ 选择附件简历 →「发送」
      //  B) 选择简历 → 选「附件简历/我的简历」→「确定/投递」
      // 先点「立即申请」开附件对话框（A 用；B 无此按钮则自动忽略，click 找不到返回 false 不中断），
      // 再选简历/附件，最后依次点「发送/确定/投递/提交申请」（缺的自动忽略）。
      await sleep(1500);
      await bexec(platform, 'click', { text: '立即申请', timeout: 6000 }, logs, '确认在线简历');
      await sleep(1000);
      for (const sel of ['resume_source', '附件简历', '我的简历', '上传的简历']) {
        await bexec(platform, 'click', { text: sel, timeout: 4000 }, logs, `选择简历「${sel}」`);
      }
      await sleep(800);
      for (const c of ['发送', '确定', '投递', '提交申请']) {
        await bexec(platform, 'click', { text: c, timeout: 4000 }, logs, `确认「${c}」`);
      }
      await sleep(2000);

      // 流程走完后，再判定是否真的被引导到简历中心（账号缺在线简历）
      const afterUrl = await currentUrl(platform);
      const afterText = await pageText(platform);
      const confirmed = new RegExp(cfg.confirmRegex).test(afterText);
      if (!confirmed && /(resume\/center|resumeid|\/resume)/.test(afterUrl)) {
        logs.step('简历校验', false, '账号缺少可用在线简历，已被引导至简历中心');
        return { applied: false, needResume: true };
      }
    } else {
      // 先关掉可能出现的「我知道了 / 去完善 / 稍后再说」提示遮罩，避免挡住确认按钮
      for (const hint of ['我知道了', '去完善', '稍后再说', '关闭']) {
        await bexec(platform, 'click', { text: hint, timeout: 1500 });
      }
      await sleep(800);
      // 以「立即申请」为首选确认（智联/其它平台的简历选择对话框），其余为兜底
      for (const lbl of ['立即申请', '确定', '提交申请', '保存并投递', '保存']) {
        await bexec(platform, 'click', { text: lbl, timeout: 2500 }, logs, `确认弹窗「${lbl}」`);
      }
      await sleep(2000);

      // 非 job51 平台：点「投递」若被重定向到简历中心，需人工先建简历
      const afterUrl = await currentUrl(platform);
      const afterText = await pageText(platform);
      const resumeWall =
        /(resume\/center|resumeid|\/resume)/.test(afterUrl) ||
        /请先创建在线简历|您还没有在线简历|完善在线简历|简历完整度不足|请先完善简历/.test(afterText);
      if (resumeWall) {
        logs.step('简历校验', false, '账号缺少可用在线简历，已被引导至简历中心');
        return { applied: false, needResume: true };
      }
    }
  }
  const text = await pageText(platform);
  const clicked = r.data === true;
  const confirmed = new RegExp(cfg.confirmRegex).test(text);
  if (cfg.chatBased) {
    // 沟通型（BOSS/猎聘）：发起沟通即视为成功，页面无「投递成功」文案
    logs.step('投递结果', clicked, clicked ? '已发起沟通' : '未成功发起沟通');
    return { applied: clicked, needResume: false };
  }
  // 非沟通型（智联/51job）：以页面出现「投递成功/已投递」文案为准，避免误报
  logs.step('投递结果', confirmed, confirmed ? '页面显示投递成功' : (clicked ? '已点击但页面未确认，请人工核对' : '未命中投递按钮'));
  return { applied: confirmed, needResume: false };
}

/** 单岗位一键投递 */
async function runOneClick(input: ApplyInput): Promise<ApplyResult> {
  const platform = input.platform;
  const cfg = getPlatform(platform);
  if (!cfg) return unsupported(platform);
  const logs = new ApplyLogger();
  const jobUrl = input.jobUrl || input.job?.apply_url;
  const company = input.job?.company ?? null;
  const position = input.job?.position ?? null;

  try {
    if (jobUrl) {
      await bexec(platform, 'navigate', { url: jobUrl, waitUntil: 'domcontentloaded' }, logs, '打开岗位详情');
    } else {
      await bexec(platform, 'navigate', { url: cfg.homeUrl, waitUntil: 'domcontentloaded' }, logs, '打开首页');
    }
    await sleep(2000);

    const logged = await ensureLoggedIn(platform, cfg, input, logs);
    if (!logged) {
      const shot = await tryScreenshot(platform);
      return { platform, status: 'need_login', message: '未登录，请在打开的浏览器中登录后重试', logs: logs.logs, company, position, screenshot: shot };
    }
    if (!jobUrl) {
      const shot = await tryScreenshot(platform);
      return { platform, status: 'need_manual', message: '已登录；请提供岗位详情链接（jobUrl）以继续一键投递', logs: logs.logs, company, position, screenshot: shot };
    }

    // 登录后重新打开岗位，确保投递态正确
    await bexec(platform, 'navigate', { url: jobUrl, waitUntil: 'domcontentloaded' }, logs, '登录后重新打开岗位');
    await sleep(2500);

    const oc = await oneClickApply(platform, cfg, logs);
    const shot = await tryScreenshot(platform);
    if (oc.applied) {
      return { platform, status: 'applied', message: `已在${cfg.label}向「${company || position || '该岗位'}」完成投递`, logs: logs.logs, company, position, screenshot: shot };
    }
    if (oc.needResume) {
      return { platform, status: 'need_resume', message: `前程无忧账号缺少可用在线简历，已被引导至简历中心。请先在 51job「简历中心 → 在线简历」创建/完善一份在线简历并设为默认，再重试。`, logs: logs.logs, company, position, screenshot: shot };
    }
    return { platform, status: 'need_manual', message: '已点击但未能确认成功，请检查打开的浏览器（可能需补填必填项或遇滑块）', logs: logs.logs, company, position, screenshot: shot };
  } catch (e: any) {
    const shot = await tryScreenshot(platform).catch(() => undefined);
    return { platform, status: 'error', message: e?.message || String(e), logs: logs.logs, company, position, screenshot: shot };
  }
}

/** 批量/搜索：收集当前页岗位并逐个一键投递 */
async function batchApply(input: ApplyInput, keyword: string, logs: ApplyLogger): Promise<ApplyResult> {
  const platform = input.platform;
  const cfg = getPlatform(platform);
  if (!cfg) return unsupported(platform);
  const maxPages = input.maxPages || 5;
  const maxApply = input.maxApply && input.maxApply > 0 ? input.maxApply : 9999;
  let applied = 0;
  let skipped = 0;
  let needResume = false;

  try {
    // 51job 首选「列表页直投」：直接 goto JD 详情页会触发阿里云滑块风控，
    // 而搜索列表每行自带「投递」按钮，行内弹窗选简历→发送即可，不跳 JD 页。
    if (platform === 'job51') {
      const r51 = await runJob51List(input, keyword, maxApply);
      (r51.logs || []).forEach(l => logs.logs.push(l));
      return r51;
    }

    await bexec(platform, 'navigate', { url: cfg.searchUrl(keyword), waitUntil: 'domcontentloaded' }, logs, keyword ? `搜索「${keyword}」` : '打开职位列表');
    await sleep(3500);

    const logged = await ensureLoggedIn(platform, cfg, input, logs);
    if (!logged) {
      const shot = await tryScreenshot(platform);
      return { platform, status: 'need_login', message: '未登录，请在打开的浏览器中登录后重试', logs: logs.logs, screenshot: shot };
    }

    for (let p = 0; p < maxPages; p++) {
      const listRes = await bexec(platform, 'eval', { script: cfg.collectListScript || cfg.collectLinksScript }, logs, `第${p + 1}页收集入口`);
      const listLinks: string[] = Array.isArray(listRes.data) ? listRes.data : [];
      logs.step(`第${p + 1}页`, true, `收集到 ${listLinks.length} 个入口`);
      if (!listLinks.length) break;

      // 智联等配了 collectListScript：entry 是公司/聚合页，需再进一层收岗位（两级采集）；
      // 其余平台：entry 直接就是 JD 链接，直接打开投递，不再二次导航收集。
      const twoLevel = !!cfg.collectListScript;

      for (const entry of listLinks) {
        if (applied + skipped >= maxApply) break;
        let targets: string[] = [entry];

        if (twoLevel) {
          await bexec(platform, 'navigate', { url: entry, waitUntil: 'domcontentloaded' }, logs, '打开公司页');
          await sleep(3000);
          const jobRes = await bexec(platform, 'eval', { script: cfg.collectLinksScript }, logs, '收集岗位链接');
          const jobs: string[] = Array.isArray(jobRes.data) ? jobRes.data : [];
          targets = jobs.length ? jobs : [entry];
          logs.step('岗位', true, `本入口 ${targets.length} 个岗位`);
        }
        for (const href of targets) {
          if (applied + skipped >= maxApply) break;
          await bexec(platform, 'navigate', { url: href, waitUntil: 'domcontentloaded' }, logs, '打开岗位');
          await sleep(2500);
          let oc: OneClickResult;
          if (platform === 'job51') {
            // job51 单岗位投递改用已验证专用的 runJob51（覆盖「选择简历 → 附件 → 提交」全流程），
            // 比通用 oneClickApply 更稳。
            // 校招/校园岗位需单独校招简历，账号无则跳过；注意：页面导航栏常驻「校园招聘」链接，
            // 不能拿正文判断，必须用「岗位标题(document.title)」是否含「校招」来识别，否则会误杀普通岗位。
            const titleRes = await bexec(platform, 'eval', { script: 'document.title' });
            const isCampus = /校招|校园招聘/i.test(String(titleRes.data || ''));
            if (isCampus) {
              logs.step('岗位类型', false, '校招/校园岗位，账号无对应简历，跳过');
              oc = { applied: false, needResume: false };
            } else {
              const rj = await runJob51({ ...input, action: 'hello', jobUrl: href });
              (rj.logs || []).forEach((l) => logs.logs.push(l));
              if (rj.status === 'applied') oc = { applied: true, needResume: false };
              else if (rj.status === 'need_login') oc = { applied: false, needResume: true };
              else if (rj.status === 'need_captcha') {
                // 51job 反爬滑块：立即暂停整批，交给用户在浏览器手动过滑块后重跑，
                // 避免反复试探反而把账号风险评分拉满。
                return {
                  platform, status: 'need_captcha',
                  message: rj.message || '51job 弹出「访问验证」滑块，请在浏览器手动完成后重新运行本批次。',
                  logs: logs.logs, screenshot: rj.screenshot,
                };
              } else oc = { applied: false, needResume: false };
            }
          } else {
            oc = await oneClickApply(platform, cfg, logs);
          }
          if (oc.applied) applied++;
          else if (oc.needResume) { skipped++; needResume = true; } // 单个岗位缺简历不中断整批，继续下一个
          else skipped++;
          // 岗位间留白，降低触发 51job 风控滑块的频率
          await sleep(3000);
        }
        if (applied + skipped >= maxApply) break;
      }

      // 翻页
      const nextR = await bexec(platform, 'click', { text: '下一页', timeout: 4000 }, logs, `翻到第${p + 2}页`);
      if (!nextR.ok) break;
      await sleep(3000);
    }

    if (needResume && applied === 0) {
      return { platform, status: 'need_resume', message: `前程无忧账号缺少可用在线简历，已被引导至简历中心，无法投递。请先在 51job「简历中心 → 在线简历」创建/完善一份在线简历并设为默认，再重试。`, logs: logs.logs };
    }
    const status = applied > 0 ? 'applied' : 'need_manual';
    return { platform, status, message: `批量投递完成：成功 ${applied}，跳过 ${skipped}`, logs: logs.logs };
  } catch (e: any) {
    const shot = await tryScreenshot(platform).catch(() => undefined);
    return { platform, status: 'error', message: e?.message || String(e), logs: logs.logs, screenshot: shot };
  }
}

/** search：仅收集岗位，不投递 */
async function runSearch(input: ApplyInput): Promise<ApplyResult> {
  const platform = input.platform;
  const cfg = getPlatform(platform);
  if (!cfg) return unsupported(platform);
  const logs = new ApplyLogger();
  const kw = input.keyword || '';

  try {
    await bexec(platform, 'navigate', { url: cfg.searchUrl(kw), waitUntil: 'domcontentloaded' }, logs, kw ? `搜索「${kw}」` : '打开职位列表');
    await sleep(3500);

    const logged = await ensureLoggedIn(platform, cfg, input, logs);
    if (!logged) {
      const shot = await tryScreenshot(platform);
      return { platform, status: 'need_login', message: '未登录，请在打开的浏览器中登录后重试', logs: logs.logs, screenshot: shot };
    }

    const linksRes = await bexec(platform, 'eval', { script: cfg.collectLinksScript }, logs, '收集岗位链接');
    const links: string[] = Array.isArray(linksRes.data) ? linksRes.data : [];

    const titlesRes = await bexec(
      platform,
      'eval',
      {
        script: `(() => Array.from(document.querySelectorAll('a')).map(a => ({ h: a.href, t: (a.innerText || '').replace(/\\s+/g, ' ').trim() })).filter(x => x.h && /job|job_detail|jobs\\.51job|liepin\\.com\\/job/.test(x.h) && x.t).map(x => x.t))()`,
      },
      logs,
      '收集岗位标题',
    );
    const titles: string[] = Array.isArray(titlesRes.data) ? titlesRes.data : [];

    const foundJobs = links.map((url, i) => ({ title: titles[i] || '职位', url }));
    return { platform, status: 'found', message: `在${cfg.label}收集到 ${foundJobs.length} 个岗位`, logs: logs.logs, foundJobs };
  } catch (e: any) {
    const shot = await tryScreenshot(platform).catch(() => undefined);
    return { platform, status: 'error', message: e?.message || String(e), logs: logs.logs, screenshot: shot };
  }
}

/** again：对 HR 会话复聊（发送回复） */
async function runAgain(input: ApplyInput): Promise<ApplyResult> {
  const platform = input.platform;
  const cfg = getPlatform(platform);
  if (!cfg) return unsupported(platform);
  const logs = new ApplyLogger();

  if (!cfg.chatBased || !cfg.hr) {
    return { platform, status: 'need_manual', message: `${cfg?.label || platform} 非沟通型平台，不支持复聊`, logs: logs.logs };
  }
  const target = input.hrGroupId || input.jobUrl || input.job?.apply_url;
  if (!target) {
    return { platform, status: 'need_manual', message: '请提供 HR 会话链接(hrGroupId)或岗位链接', logs: logs.logs };
  }

  try {
    await bexec(platform, 'navigate', { url: target, waitUntil: 'domcontentloaded' }, logs, '打开 HR 会话');
    await sleep(2500);
    const logged = await ensureLoggedIn(platform, cfg, input, logs);
    if (!logged) {
      const shot = await tryScreenshot(platform);
      return { platform, status: 'need_login', message: '未登录，请先登录', logs: logs.logs, screenshot: shot };
    }

    const msg = await writeLetter({
      platform: cfg.key,
      jd: input.jdText,
      chatHistory: input.chatHistory,
      company: input.job?.company,
      position: input.job?.position,
    });

    let sent = false;
    for (const sel of cfg.hr.chatInputSel) {
      const r = await bexec(platform, 'fill', { selector: sel, value: msg, timeout: 5000 }, logs, '填写回复');
      if (r.ok) { sent = true; break; }
    }
    if (!sent) {
      const shot = await tryScreenshot(platform);
      return { platform, status: 'need_manual', message: '未找到聊天输入框', logs: logs.logs, screenshot: shot };
    }
    for (const s of cfg.hr.sendSel) {
      const r = await bexec(platform, 'click', { text: s, timeout: 5000 }, logs, `点击「${s}」` );
      if (r.ok) break;
    }
    await sleep(2000);
    const shot = await tryScreenshot(platform);
    return { platform, status: 'applied', message: `已向 HR 发送复聊消息`, logs: logs.logs, screenshot: shot };
  } catch (e: any) {
    const shot = await tryScreenshot(platform).catch(() => undefined);
    return { platform, status: 'error', message: e?.message || String(e), logs: logs.logs, screenshot: shot };
  }
}

/** letter：打开岗位 → 发起沟通 → 发送求职信/招呼语 */
async function runLetter(input: ApplyInput): Promise<ApplyResult> {
  const platform = input.platform;
  const cfg = getPlatform(platform);
  if (!cfg) return unsupported(platform);
  const logs = new ApplyLogger();
  const jobUrl = input.jobUrl || input.job?.apply_url;
  const company = input.job?.company ?? null;
  const position = input.job?.position ?? null;

  if (!jobUrl) {
    return { platform, status: 'need_manual', message: '请提供岗位链接以发送求职信', logs: logs.logs, company, position };
  }
  try {
    await bexec(platform, 'navigate', { url: jobUrl, waitUntil: 'domcontentloaded' }, logs, '打开岗位详情');
    await sleep(2500);
    const logged = await ensureLoggedIn(platform, cfg, input, logs);
    if (!logged) {
      const shot = await tryScreenshot(platform);
      return { platform, status: 'need_login', message: '未登录，请先登录', logs: logs.logs, company, position, screenshot: shot };
    }
    await bexec(platform, 'navigate', { url: jobUrl, waitUntil: 'domcontentloaded' }, logs, '登录后重新打开岗位');
    await sleep(2500);

    // 沟通型平台：先点开沟通框
    if (cfg.chatBased) {
      await bexec(platform, 'eval', { script: cfg.applyScript }, logs, '发起沟通');
      await sleep(2500);
    }

    const msg = await writeLetter({
      platform: cfg.key,
      jd: input.jdText,
      company,
      position,
    });

    const boxSels = cfg.chatBased && cfg.hr ? cfg.hr.chatInputSel : ['.chat-input', 'textarea[placeholder*="沟通"]', 'div[contenteditable="true"]'];
    let sent = false;
    for (const sel of boxSels) {
      const r = await bexec(platform, 'fill', { selector: sel, value: msg, timeout: 5000 }, logs, '填写求职信');
      if (r.ok) { sent = true; break; }
    }
    if (!sent) {
      // 非沟通型平台：一键投递（简历即求职信）
      const oc = await oneClickApply(platform, cfg, logs);
      const shot = await tryScreenshot(platform);
      if (oc.needResume) return { platform, status: 'need_resume', message: `前程无忧账号缺少可用在线简历，已被引导至简历中心。请先在 51job「简历中心 → 在线简历」创建/完善一份在线简历并设为默认，再重试。`, logs: logs.logs, company, position, screenshot: shot };
      return { platform, status: oc.applied ? 'applied' : 'need_manual', message: oc.applied ? '已一键投递（简历已送达）' : '未找到沟通/投递入口', logs: logs.logs, company, position, screenshot: shot };
    }
    const sendSels = cfg.chatBased && cfg.hr ? cfg.hr.sendSel : ['发送'];
    for (const s of sendSels) {
      const r = await bexec(platform, 'click', { text: s, timeout: 5000 }, logs, `点击「${s}」`);
      if (r.ok) break;
    }
    await sleep(2000);
    const shot = await tryScreenshot(platform);
    return { platform, status: 'applied', message: `已向「${company || position || '该岗位'}」发送求职信/招呼语`, logs: logs.logs, company, position, screenshot: shot };
  } catch (e: any) {
    const shot = await tryScreenshot(platform).catch(() => undefined);
    return { platform, status: 'error', message: e?.message || String(e), logs: logs.logs, company, position, screenshot: shot };
  }
}

export async function runEngine(input: ApplyInput): Promise<ApplyResult> {
  switch (input.action || 'hello') {
    case 'auto':
      return batchApply(input, input.keyword || '', new ApplyLogger());
    case 'keyword':
      return batchApply(input, input.keyword || '', new ApplyLogger());
    case 'search':
      return runSearch(input);
    case 'again':
      return runAgain(input);
    case 'letter':
      return runLetter(input);
    case 'hello':
    default:
      return runOneClick(input);
  }
}

export type { PlatformKey };
