/**
 * 中华英才网（chinahr.com）投递
 * ==========================================================================
 * 结构（2026-09-21 实机探针）：
 *   · 详情页 `https://www.chinahr.com/detail/{hexid}` 匿名可读
 *   · 投递入口按钮文案：**直接投递 / 投简历 / 申请职位 / 立即投递**（点击后该按钮变为「取消投递」=已投）
 *   · 未登录时导航栏显示「登录|注册」；登录后变为用户名 + 退出登录
 *
 * ⚠️ 中华英才网 Web 端**无 URL 搜索**，采集只能拿平台推荐列表（量小、多为非技术/外地岗）；
 *    本模块投递逻辑本身完整可用，是否投得出取决于窗口里是否登录 + 是否有匹配的技术岗。
 */
import { ApplyLogger, bexec, pageText, pageUrl, tryScreenshot, sleep } from './common.js';
import type { ApplyInput, ApplyResult } from './types.js';
import { detectRiskSignal, riskStatusOf } from '../riskSignals.js';

const HOME_URL = 'https://www.chinahr.com/';

/** 投递入口候选文案 */
const APPLY_LABELS = ['直接投递', '投简历', '申请职位', '立即投递', '投递简历'];

function needsLogin(url: string, text: string): boolean {
  if (/\/login|\/passport/.test(url)) return true;
  return /(登录\|注册|请登录|账号登录|立即登录|登录后即可投递)/.test(text);
}

export async function runChinahr(input: ApplyInput): Promise<ApplyResult> {
  const logs = new ApplyLogger();
  const platform = 'chinahr';
  const jobUrl = input.jobUrl || input.job?.apply_url || undefined;
  const company = input.job?.company ?? null;
  const position = input.job?.position ?? null;

  try {
    await bexec(platform, 'navigate', { url: jobUrl || HOME_URL, waitUntil: 'domcontentloaded' }, logs, jobUrl ? '打开岗位详情页' : '打开中华英才网首页');
    await sleep(4000);

    {
      const text = await pageText(platform);
      const risk = detectRiskSignal(text);
      if (risk) {
        logs.step('风控检测', false, `${risk.kind}：命中「${risk.matched}」`);
        return { platform, status: riskStatusOf(risk.kind), message: `检测到平台风控信号「${risk.matched}」。${risk.action}`, logs: logs.logs, company, position, screenshot: await tryScreenshot(platform) };
      }
    }

    {
      const url = await pageUrl(platform);
      const text = await pageText(platform);
      if (needsLogin(url, text)) {
        logs.step('登录态', false, '未登录');
        return {
          platform, status: 'need_login', company, position,
          message: '中华英才网未登录：请在该平台的调试窗口里登录一次（手机号/扫码），然后重跑本批次',
          logs: logs.logs, screenshot: await tryScreenshot(platform),
        };
      }
      logs.step('登录态', true, '已登录');
    }

    if (!jobUrl) {
      return { platform, status: 'need_login', message: '已登录；请提供岗位详情链接以继续投递', logs: logs.logs, company, position, screenshot: await tryScreenshot(platform) };
    }

    const probe = await bexec(platform, 'eval', {
      script: `(function(){var T=${JSON.stringify(APPLY_LABELS)};var hit=[];
        var els=document.querySelectorAll('a,button,span,div');
        for(var i=0;i<els.length;i++){var e=els[i];var s=(e.innerText||'').trim();
          if(s&&T.indexOf(s)>=0&&e.offsetHeight>0&&hit.indexOf(s)<0)hit.push(s);}
        return JSON.stringify({hit:hit,title:document.title});})()`,
    }, logs, '探测投递入口（不点击）');
    let hit: string[] = [];
    try { hit = JSON.parse(String(probe.data || '{}')).hit || []; } catch { /* 忽略 */ }

    if (input.preview === true) {
      const shot = await tryScreenshot(platform);
      logs.step('预览', hit.length > 0, hit.length ? `可投递入口：${hit.join(' / ')}` : '未探测到投递入口');
      return {
        platform, status: 'preview', company, position, screenshot: shot, logs: logs.logs,
        message: hit.length
          ? `预览：中华英才网岗位页正常，投递入口「${hit.join(' / ')}」可用；本次未点击，未产生任何真实投递`
          : '预览：中华英才网岗位页正常，但未探测到投递入口按钮',
      };
    }

    if (!hit.length) {
      const shot = await tryScreenshot(platform);
      return { platform, status: 'need_manual', company, position, screenshot: shot, logs: logs.logs, message: '未找到「直接投递/投简历」按钮，可能页面结构变化或该岗位需在 APP 内投递' };
    }
    let clicked = false;
    for (const label of hit) {
      const r = await bexec(platform, 'click', { text: label, timeout: 8000 }, logs, `点击「${label}」`);
      if (r.ok) { clicked = true; break; }
    }
    await sleep(3000);
    const after = await pageText(platform);
    const shot = await tryScreenshot(platform);
    // 命中「取消投递」= 已投；或「已投递/投递成功/已申请」
    if (/已投递|投递成功|已申请|简历已投递|取消投递/.test(after)) {
      return { platform, status: 'applied', company, position, screenshot: shot, logs: logs.logs, message: `已在中华英才网向「${company || position || '该岗位'}」投递简历` };
    }
    if (clicked) {
      return { platform, status: 'need_manual', company, position, screenshot: shot, logs: logs.logs, message: '已点击投递，但未能确认成功（中华英才网可能跳 APP 或需二次确认），请在调试窗口确认' };
    }
    return { platform, status: 'error', company, position, screenshot: shot, logs: logs.logs, message: '投递按钮点击失败' };
  } catch (e: any) {
    return { platform, status: 'error', message: e?.message || String(e), logs: logs.logs, company, position, screenshot: await tryScreenshot(platform) };
  }
}
