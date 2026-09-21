/**
 * 鱼泡直聘（yupao.com）投递
 * ==========================================================================
 * 实机探针结论（2026-09-21）：
 *   · 详情页 `/zhaogong/{数字id}.html` 匿名可读
 *   · 投递入口 = 三个按钮：**发送简历 / 聊一聊 / 拨打电话**
 *   · 页面有「点击登录，立即与老板沟通」→ **投递必须登录**
 *
 * ⚠️ 岗位画像提醒：鱼泡是蓝领/建筑垂直平台，实测**昆明 33 个岗位全是打包工/包装工/店员/司机**，
 *    零技术岗。本模块可用，但对"软件工程"求职者基本用不上（采集器已正确过滤掉这些岗）。
 */
import { ApplyLogger, bexec, pageText, pageUrl, tryScreenshot, sleep } from './common.js';
import type { ApplyInput, ApplyResult } from './types.js';
import { detectRiskSignal, riskStatusOf } from '../riskSignals.js';

const HOME_URL = 'https://www.yupao.com/';

/** 投递入口候选：优先「聊一聊」（沟通型，等价于投递），其次「发送简历」 */
const CHAT_LABELS = ['聊一聊', '在线沟通', '沟通'];
const RESUME_LABELS = ['发送简历', '投递简历', '投个简历', '立即投递'];

function needsLogin(url: string, text: string): boolean {
  if (/\/login|passport|user\/login/.test(url)) return true;
  return /(点击登录|请登录|登录后|登录丨注册|登录\，)/.test(text);
}

const probeScript = (labels: string[]) => `(function(){
  var T=${JSON.stringify(labels)};var hit=[];
  var els=document.querySelectorAll('a,button,span,div');
  for(var i=0;i<els.length;i++){var e=els[i];var s=(e.innerText||'').trim();
    if(s&&T.indexOf(s)>=0&&e.offsetHeight>0&&hit.indexOf(s)<0)hit.push(s);}
  return JSON.stringify({hit:hit,title:document.title});})()`;

export async function runYupao(input: ApplyInput): Promise<ApplyResult> {
  const logs = new ApplyLogger();
  const platform = 'yupao';
  const jobUrl = input.jobUrl || input.job?.apply_url || undefined;
  const company = input.job?.company ?? null;
  const position = input.job?.position ?? null;

  try {
    await bexec(platform, 'navigate', { url: jobUrl || HOME_URL, waitUntil: 'domcontentloaded' }, logs, jobUrl ? '打开岗位详情页' : '打开鱼泡首页');
    await sleep(3000);

    // 风控信号
    {
      const text = await pageText(platform);
      const risk = detectRiskSignal(text);
      if (risk) {
        logs.step('风控检测', false, `${risk.kind}：命中「${risk.matched}」`);
        return { platform, status: riskStatusOf(risk.kind), message: `检测到平台风控信号「${risk.matched}」。${risk.action}`, logs: logs.logs, company, position, screenshot: await tryScreenshot(platform) };
      }
    }

    // 登录态
    {
      const url = await pageUrl(platform);
      const text = await pageText(platform);
      if (needsLogin(url, text)) {
        logs.step('登录态', false, '未登录');
        return {
          platform, status: 'need_login', company, position,
          message: '鱼泡直聘未登录：请在该平台的调试窗口里登录一次（扫码/手机号），然后重跑本批次',
          logs: logs.logs, screenshot: await tryScreenshot(platform),
        };
      }
      logs.step('登录态', true, '已登录');
    }

    if (!jobUrl) {
      return { platform, status: 'need_login', message: '已登录；请提供岗位详情链接以继续投递', logs: logs.logs, company, position, screenshot: await tryScreenshot(platform) };
    }

    // 探测两批入口
    const p1 = await bexec(platform, 'eval', { script: probeScript(CHAT_LABELS) }, logs, '探测「聊一聊」（不点击）');
    const p2 = await bexec(platform, 'eval', { script: probeScript(RESUME_LABELS) }, logs, '探测「发送简历」（不点击）');
    const parse = (v: unknown) => { try { return JSON.parse(String(v || '{}')).hit || []; } catch { return []; } };
    const chat: string[] = parse(p1.data);
    const resume: string[] = parse(p2.data);

    if (input.preview === true) {
      const shot = await tryScreenshot(platform);
      const found = [...chat, ...resume];
      logs.step('预览', found.length > 0, found.length ? `可投递入口：${found.join(' / ')}` : '未探测到投递入口');
      return {
        platform, status: 'preview', company, position, screenshot: shot, logs: logs.logs,
        message: found.length
          ? `预览：鱼泡岗位页正常，投递入口「${found.join(' / ')}」可用；本次未点击，未产生任何真实投递`
          : '预览：鱼泡岗位页正常，但未探测到投递入口按钮',
      };
    }

    // 正式投递：先「聊一聊」（沟通型），失败再试「发送简历」
    let acted = false;
    for (const label of [...chat, ...resume]) {
      const r = await bexec(platform, 'click', { text: label, timeout: 8000 }, logs, `点击「${label}」`);
      if (r.ok) { acted = true; break; }
    }
    await sleep(2500);

    // 若弹出「发送简历」二次确认，补点一次
    const resumeProbe = await bexec(platform, 'eval', { script: probeScript(RESUME_LABELS) }, logs, '检查是否需要补发简历');
    const again: string[] = parse(resumeProbe.data);
    if (acted && again.length) {
      for (const label of again) {
        const r = await bexec(platform, 'click', { text: label, timeout: 6000 }, logs, `补点「${label}」`);
        if (r.ok) break;
      }
      await sleep(2000);
    }

    const after = await pageText(platform);
    const shot = await tryScreenshot(platform);
    if (/(已发送|发送成功|已投递|投递成功|已沟通)/.test(after)) {
      return { platform, status: 'applied', company, position, screenshot: shot, logs: logs.logs, message: `已在鱼泡直聘向「${company || position || '该岗位'}」发起沟通并发送简历` };
    }
    if (acted) {
      return { platform, status: 'need_manual', company, position, screenshot: shot, logs: logs.logs, message: '已点击沟通/发送简历，但未能确认成功，请在调试窗口确认' };
    }
    return { platform, status: 'need_manual', company, position, screenshot: shot, logs: logs.logs, message: '未找到「聊一聊/发送简历」按钮，可能页面结构变化或需在 APP 内投递' };
  } catch (e: any) {
    return { platform, status: 'error', message: e?.message || String(e), logs: logs.logs, company, position, screenshot: await tryScreenshot(platform) };
  }
}
