/**
 * 国聘（iguopin.com）投递
 * ==========================================================================
 * 结构（2026-09-21 实机探针 + JS bundle 路由确认）：
 *   · 岗位详情页：`https://www.iguopin.com/job/detail?id={job_id}`（采集器写入的 apply_url 就是这个）
 *   · 投递路由：`/job/apply`
 *   · 列表接口 `/api/jobs/v1/list` **匿名可调**（采集走 API，见 scripts/collect_iguopin.ts）
 *
 * 投递需要登录（未登录会被引导到 /login）。与前几个平台一样：
 * 平台通道的投递就是"点一下"，所以**必须实现 preview 分支**才能零风险自测。
 */
import { ApplyLogger, bexec, pageText, pageUrl, tryScreenshot, sleep } from './common.js';
import type { ApplyInput, ApplyResult } from './types.js';
import { detectRiskSignal, riskStatusOf } from '../riskSignals.js';

const HOME_URL = 'https://www.iguopin.com/';

/** 投递入口候选文案（国聘多为「投递简历 / 立即投递 / 申请职位」） */
const APPLY_LABELS = ['投递简历', '立即投递', '申请职位', '投个简历', '投递', '申请'];

function needsLogin(url: string, text: string): boolean {
  if (/\/login|\/user\/login/.test(url)) return true;
  return /(请登录|登录后查看|登录后投递|立即登录|注册\/登录)/.test(text);
}

export async function runIguopin(input: ApplyInput): Promise<ApplyResult> {
  const logs = new ApplyLogger();
  const platform = 'iguopin';
  const jobUrl = input.jobUrl || input.job?.apply_url || undefined;
  const company = input.job?.company ?? null;
  const position = input.job?.position ?? null;

  try {
    // 1) 打开详情页（无链接时回首页，仅用于登录态检查）
    await bexec(platform, 'navigate', { url: jobUrl || HOME_URL, waitUntil: 'domcontentloaded' }, logs, jobUrl ? '打开岗位详情页' : '打开国聘首页');
    await sleep(4000); // 国聘是异步渲染，需要等

    // 2) 风控信号优先
    {
      const text = await pageText(platform);
      const risk = detectRiskSignal(text);
      if (risk) {
        logs.step('风控检测', false, `${risk.kind}：命中「${risk.matched}」`);
        return { platform, status: riskStatusOf(risk.kind), message: `检测到平台风控信号「${risk.matched}」。${risk.action}`, logs: logs.logs, company, position, screenshot: await tryScreenshot(platform) };
      }
    }

    // 3) 登录态
    {
      const url = await pageUrl(platform);
      const text = await pageText(platform);
      if (needsLogin(url, text)) {
        logs.step('登录态', false, '未登录');
        return {
          platform, status: 'need_login', company, position,
          message: '国聘未登录：请在该平台的调试窗口里登录一次（扫码/手机号），然后重跑本批次',
          logs: logs.logs, screenshot: await tryScreenshot(platform),
        };
      }
      logs.step('登录态', true, '已登录');
    }

    if (!jobUrl) {
      return { platform, status: 'need_login', message: '已登录；请提供岗位详情链接以继续投递', logs: logs.logs, company, position, screenshot: await tryScreenshot(platform) };
    }

    // 4) 探测投递入口（预览/正式共用）
    const probe = await bexec(platform, 'eval', {
      script: `(function(){var T=${JSON.stringify(APPLY_LABELS)};var hit=[];
        var els=document.querySelectorAll('a,button,span,div');
        for(var i=0;i<els.length;i++){var e=els[i];var s=(e.innerText||'').trim();
          if(s&&T.indexOf(s)>=0&&e.offsetHeight>0&&hit.indexOf(s)<0)hit.push(s);}
        return JSON.stringify({hit:hit,title:document.title});})()`,
    }, logs, '探测投递入口（不点击）');
    let hit: string[] = [];
    try { hit = JSON.parse(String(probe.data || '{}')).hit || []; } catch { /* 忽略 */ }

    // 5) 预览模式：只报告，不点击
    if (input.preview === true) {
      const shot = await tryScreenshot(platform);
      logs.step('预览', hit.length > 0, hit.length ? `可投递入口：${hit.join(' / ')}` : '未探测到投递入口');
      return {
        platform, status: 'preview', company, position, screenshot: shot, logs: logs.logs,
        message: hit.length
          ? `预览：国聘岗位页正常，投递入口「${hit.join(' / ')}」可用；本次未点击，未产生任何真实投递`
          : '预览：国聘岗位页正常，但未探测到投递入口按钮（正式投递时可能需要人工介入）',
      };
    }

    // 6) 正式投递：逐个候选文案点击
    if (!hit.length) {
      const shot = await tryScreenshot(platform);
      return { platform, status: 'need_manual', company, position, screenshot: shot, logs: logs.logs, message: '未找到「投递/申请」按钮，可能页面结构变化或该岗位需在 APP 内投递' };
    }
    let clicked = false;
    for (const label of hit) {
      const r = await bexec(platform, 'click', { text: label, timeout: 8000 }, logs, `点击「${label}」`);
      if (r.ok) { clicked = true; break; }
    }
    await sleep(3000);
    const after = await pageText(platform);
    const shot = await tryScreenshot(platform);
    if (/已投递|投递成功|已申请|简历已投递/.test(after)) {
      return { platform, status: 'applied', company, position, screenshot: shot, logs: logs.logs, message: `已在国聘向「${company || position || '该岗位'}」投递简历` };
    }
    if (clicked) {
      return { platform, status: 'need_manual', company, position, screenshot: shot, logs: logs.logs, message: '已点击投递，但未能确认成功（国聘投递可能跳 APP 或需二次确认），请在调试窗口确认' };
    }
    return { platform, status: 'error', company, position, screenshot: shot, logs: logs.logs, message: '投递按钮点击失败' };
  } catch (e: any) {
    return { platform, status: 'error', message: e?.message || String(e), logs: logs.logs, company, position, screenshot: await tryScreenshot(platform) };
  }
}
