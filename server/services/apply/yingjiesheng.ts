/**
 * 应届生求职网（yingjiesheng.com）投递
 * ==========================================================================
 * 结构（2026-09-21 实机探针）：
 *   · 单岗详情页 `https://q.yingjiesheng.com/jobdetail/{id}.html` 匿名可读
 *   · 投递入口按钮：**立即申请 / 先聊聊 / 投简历**（点击「立即申请」即投递，等同「先聊聊」沟通型）
 *   · ⚠️ 频道/分类页 `/jobs/k_{id}/` 才是搜索结果页（含多职位卡）；采集器已把每卡的
 *     `jobdetail/{id}.html` 作为 apply_url 写入，故投递直接打开单岗页，无需在频道页里定位卡片。
 *   · 未登录点击投递可能弹出登录浮层（短信/验证码登录），故点击后检测登录态浮层。
 */
import { ApplyLogger, bexec, pageText, pageUrl, tryScreenshot, sleep } from './common.js';
import type { ApplyInput, ApplyResult } from './types.js';
import { detectRiskSignal, riskStatusOf } from '../riskSignals.js';

const HOME_URL = 'https://www.yingjiesheng.com/';

/** 投递入口候选文案（「立即申请」主投，「先聊聊」沟通型投递） */
const APPLY_LABELS = ['立即申请', '先聊聊', '投简历', '申请职位', '在线投递'];

function needsLogin(url: string, text: string): boolean {
  if (/\/login|\/passport|login\.html/.test(url)) return true;
  // 仅当页面正文明确提示「需登录才能投递」才判未登录，避免被导航栏常驻「登录」链接误伤
  return /(请登录后(再)?投递|登录后(即可)?投递|未登录无法投递|请先登录)/.test(text);
}

export async function runYingjiesheng(input: ApplyInput): Promise<ApplyResult> {
  const logs = new ApplyLogger();
  const platform = 'yingjiesheng';
  const jobUrl = input.jobUrl || input.job?.apply_url || undefined;
  const company = input.job?.company ?? null;
  const position = input.job?.position ?? null;

  try {
    await bexec(platform, 'navigate', { url: jobUrl || HOME_URL, waitUntil: 'domcontentloaded' }, logs, jobUrl ? '打开岗位详情页' : '打开应届生求职网首页');
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
          message: '应届生求职网未登录：请在该平台的调试窗口里登录一次（手机号/扫码），然后重跑本批次',
          logs: logs.logs, screenshot: await tryScreenshot(platform),
        };
      }
      logs.step('登录态', true, '已登录（或无需登录即可投递）');
    }

    if (!jobUrl) {
      return { platform, status: 'need_login', message: '请提供岗位详情链接以继续投递', logs: logs.logs, company, position, screenshot: await tryScreenshot(platform) };
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
          ? `预览：应届生求职网岗位页正常，投递入口「${hit.join(' / ')}」可用；本次未点击，未产生任何真实投递`
          : '预览：应届生求职网岗位页正常，但未探测到投递入口按钮（正式投递时可能需要人工介入）',
      };
    }

    if (!hit.length) {
      const shot = await tryScreenshot(platform);
      return { platform, status: 'need_manual', company, position, screenshot: shot, logs: logs.logs, message: '未找到「立即申请/先聊聊」按钮，可能页面结构变化或该岗位需在 APP 内投递' };
    }
    let clicked = false;
    for (const label of hit) {
      const r = await bexec(platform, 'click', { text: label, timeout: 8000 }, logs, `点击「${label}」`);
      if (r.ok) { clicked = true; break; }
    }
    await sleep(3000);
    const after = await pageText(platform);
    const shot = await tryScreenshot(platform);
    // 点击后若出现登录浮层 → 实际未投，需登录
    if (/(短信登录|验证码登录|扫码登录|注册并登录|登录后即可)/.test(after)) {
      return { platform, status: 'need_login', company, position, screenshot: shot, logs: logs.logs, message: '点击投递后弹出登录浮层：请先在调试窗口登录应届生求职网，再重跑本批次' };
    }
    if (/已投递|投递成功|已申请|简历已投递|已发送|投递完成/.test(after)) {
      return { platform, status: 'applied', company, position, screenshot: shot, logs: logs.logs, message: `已在应届生求职网向「${company || position || '该岗位'}」投递简历` };
    }
    if (clicked) {
      return { platform, status: 'need_manual', company, position, screenshot: shot, logs: logs.logs, message: '已点击投递，但未能确认成功（可能跳 APP 或需二次确认），请在调试窗口确认' };
    }
    return { platform, status: 'error', company, position, screenshot: shot, logs: logs.logs, message: '投递按钮点击失败' };
  } catch (e: any) {
    return { platform, status: 'error', message: e?.message || String(e), logs: logs.logs, company, position, screenshot: await tryScreenshot(platform) };
  }
}
