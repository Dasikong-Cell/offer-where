/**
 * 跨平台「请求附件简历」结构化卡片处理（点「同意」把简历发出去）。
 *
 * 为什么抽成通用模块（2026-09-23 复盘）：
 * 之前 acceptResumeRequest + 卡片检测只写在 bossChat.ts 里，liepin 等其它平台只能走工具栏
 * 「发简历」——而很多平台（同 BOSS）的简历请求是**结构化卡片**，必须点卡片「同意」才算处理，
 * 走工具栏是另一条路径、卡片会一直挂待处理（BOSS 已实测）。抽出通用实现后，任何平台 driver 仅需：
 *   ① 在 readConversation 的 eval 脚本里嵌 detectResumeRequestClause() 并回传 resumeRequest；
 *   ② 把 acceptResumeRequest 指向 acceptResumeRequestGeneric(ex)（ex 为该平台的 CDP 调用入口）；
 * 引擎零改动（runAutoReply 已按 resumeRequest 标志 + 能力存在性路由，无 platform==='boss' 硬 gate）。
 *
 * ⚠️ 真实副作用：点下去会向 HR 发简历；driver 只在真实发送模式调用。
 * ⚠️ 一次调用只点一次，绝不轮内重试（幂等优先，跨轮重试更安全，详见 bossChat 注释的 3 连发事故）。
 *
 * 设计要点：
 * - 卡片容器用「跨平台通用选择器 + 各平台特例」叠加（BOSS .message-card-wrap / 顶部 .respond-popover 等）。
 * - 命中条件 = 含「简历」类关键词 AND 含「确认/请求」类关键词，缩小误触面（避免点到「是否接受面试」之类卡片）。
 * - 禁用态判据三处一致：class「disabled」/ 原生 disabled / pointer-events:none（SPAN 无 disabled 属性！）。
 */

/** 底层 CDP 调用入口（与 bossChat/liepinChat 的 ex 同签名：POST /api/browser/exec） */
export type ExFn = (action: string, extra?: any) => Promise<any>;

/** 注入桩用（测试断言副作用次数，生产代码不调用） */
export function makeExOverride(): { set: (fn: ExFn | null) => void; get: () => ExFn | null } {
  let _o: ExFn | null = null;
  return { set: (fn) => { _o = fn; }, get: () => _o };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 卡片容器选择器：跨平台通用 + 各平台特例叠加 */
const CARD_CONTAINER =
  '.message-card-wrap,[class*=message-card-wrap],[class*=message-card],[class*=resume-request],' +
  '[class*=resumeRequest],[class*=respond-popover],[class*=sys-card],[class*=chat-card],.respond-popover';

/** 简历请求关键词：命中其一 + 请求关键词 → 视为「请求附件简历」卡片 */
const RESUME_KW = ['附件简历', '发简历', '发送简历', '简历'];
/** 请求/确认类关键词：含其一即视为需要确认的请求（与简历关键词组合缩小误触面） */
const REQUEST_KW = ['是否同意', '是否发送', '同意吗', '拒绝', '同意'];
/** 肯定按钮（点这个） */
const AFFIRM = ['同意', '是', '确认', '发送', '好的', '确定', '接受'];

/**
 * 浏览器内共享内核：定义 btnDisabled + findResumeCards()。
 * findResumeCards 扫描候选卡片容器，返回 [{wrap, activeAgree, allAffirmDisabled}]。
 *  - activeAgree=true：存在可点的「同意」按钮（卡片待处理）；
 *  - allAffirmDisabled=true：肯定按钮全部禁用（已发送态，防重复点）。
 * 命中条件：容器文本含「简历」类关键词 AND 含「确认/请求」类关键词。
 */
export const CORE = `const btnDisabled=function(b){
  const cls=String(b.className||'');
  if(/(^|\\\\s)disabled(\\\\s|$)/.test(cls)) return true;
  if(b.disabled===true) return true;
  try{ if(getComputedStyle(b).pointerEvents==='none') return true; }catch(e){}
  return false;
};
const __RESUME_KW=${JSON.stringify(RESUME_KW)};
const __REQUEST_KW=${JSON.stringify(REQUEST_KW)};
const __AFFIRM=${JSON.stringify(AFFIRM)};
const __CARD_CONTAINER=${JSON.stringify(CARD_CONTAINER)};
function findResumeCards(){
  const norm=function(s){return (s||'').replace(/\\s+/g,'');};
  const containers=[].slice.call(document.querySelectorAll(__CARD_CONTAINER));
  const out=[];
  for(const w of containers){
    const wt=norm(w.innerText);
    const hasResume=__RESUME_KW.some(function(k){return wt.indexOf(k)>=0;});
    const hasReq=__REQUEST_KW.some(function(k){return wt.indexOf(k)>=0;})||/(同意|拒绝)/.test(wt);
    if(!hasResume||!hasReq) continue;
    const btns=[].slice.call(w.querySelectorAll('button,.card-btn,[class*=btn],span'));
    const affirmBtns=btns.filter(function(b){return __AFFIRM.some(function(a){return new RegExp('^'+a).test((b.innerText||'').trim());});});
    const active=affirmBtns.filter(function(b){return !btnDisabled(b);});
    out.push({wrap:w, activeAgree:active.length>0, allAffirmDisabled:affirmBtns.length>0&&affirmBtns.every(function(b){return btnDisabled(b);})});
  }
  return out;
}`;

/**
 * 返回一段可嵌入 readConversation eval 的 JS 表达式（求值结果为 boolean）。
 * 用法：在页面 eval 脚本里 `const resumeRequest = (${detectResumeRequestClause()});`
 */
export function detectResumeRequestClause(): string {
  return `(()=>{ ${CORE} return findResumeCards().some(function(c){return c.activeAgree;}); })()`;
}

/** 点「同意」脚本：返回 'CARD'/'POPOVER'（已点）|'ALREADY'（已发送态）|'NOT_FOUND'（无卡片）。
 *  ⚠️ 必须含 .click()（合约测试用它识别「这是点按脚本」）；CHECK 脚本不得含。 */
export const ACCEPT_CLICK_SCRIPT = `(()=>{
  ${CORE}
  const cards=findResumeCards();
  for(const c of cards){
    if(c.allAffirmDisabled) return 'ALREADY';
    if(c.activeAgree){
      const btns=[].slice.call(c.wrap.querySelectorAll('button,.card-btn,[class*=btn],span'));
      const active=btns.filter(function(b){return __AFFIRM.some(function(a){return new RegExp('^'+a).test((b.innerText||'').trim());})&&!btnDisabled(b);});
      if(active.length){ active[0].click(); return 'CARD'; }
    }
  }
  const pop=document.querySelector('.respond-popover');
  if(pop&&(pop.innerText||'').indexOf('附件简历')>=0){
    const b=pop.querySelector('.btn-agree')||[].slice.call(pop.querySelectorAll('button,.btn')).find(function(e){return /^同意/.test((e.innerText||'').trim());});
    if(b&&!btnDisabled(b)){ b.click(); return 'POPOVER'; }
  }
  return 'NOT_FOUND';
})()`;

/** 复核脚本：返回 true = 仍存在待处理（可点）的「同意」按钮（未处理完）；false = 已全部禁用/处理。
 *  ⚠️ 不得含 .click()。 */
export const CHECK_SCRIPT = `(()=>{
  ${CORE}
  const cards=findResumeCards();
  for(const c of cards){ if(c.activeAgree) return true; }
  const pop=document.querySelector('.respond-popover');
  if(pop&&(pop.innerText||'').indexOf('附件简历')>=0){
    const b=pop.querySelector('.btn-agree');
    if(b&&!btnDisabled(b)) return true;
  }
  return false;
})()`;

/**
 * 通用「同意简历请求卡片」实现（跨平台）。
 * 一次调用只点一次；已发送态（ALREADY）早返回；点击后复核按钮是否禁用（=已处理）。
 * @param ex 该平台的 CDP 调用入口（bossChat/liepinChat 的 ex，可注入桩用于测试）
 */
export async function acceptResumeRequestGeneric(ex: ExFn): Promise<boolean> {
  const c = await ex('eval', { script: ACCEPT_CLICK_SCRIPT });
  const hit = String((c && c.data) ?? '');
  // 已发送态：按钮已禁用，无需再点（防重复发送 —— 3 连发事故的纵深防线）
  if (hit === 'ALREADY') return true;
  // 无卡片 / 无会话：未处理
  if (hit === 'NOT_FOUND' || hit === 'NO_CONV') return false;
  // 点下去了，等平台处理完再复核按钮是否变成禁用态（=已处理）
  await sleep(2500);
  const chk = await ex('eval', { script: CHECK_SCRIPT });
  // CHECK 返回 true = 仍有可点的「同意」按钮（未处理完）；false = 已全部禁用/处理完
  return (chk && chk.data) === false;
}
