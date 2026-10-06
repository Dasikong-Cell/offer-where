/**
 * BOSS 直聘聊天操作模块（基于已养熟的 boss CDP 标签）
 *
 * 已验证的 DOM 结构（2026-09-08）：
 *  - 进聊天页：首页点页头「消息」链接 → /web/geek/chat?ka=header-message
 *  - 会话列表：.user-list-content ul li ；点 .friend-content 打开会话
 *  - 会话窗格：.chat-conversation
 *  - 输入框：DIV.chat-input（contenteditable）
 *  - 发送：BUTTON.btn-send（有内容才 enabled，Enter 亦可）
 *  - 发简历：.toolbar-btn-content（文本「发简历」）→ .upload-select-dialog
 *    → 选「发送在线简历」(select-one 含「发送在线简历」) → 简历发到会话
 *  - 在线简历已被本地 PDF 填充（简历中心「导入已有简历」），故发在线简历即发该 PDF
 */

const PORT = Number(process.env.PORT) || 4400;
const PLATFORM = 'boss';
const BASE = `http://127.0.0.1:${PORT}/api/browser/exec`;

import type { ChatDriver, ConvSummary, ParsedMessage } from './chatTypes.js';
import { acceptResumeRequestGeneric } from './resumeCard.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type ExFn = (action: string, extra?: any) => Promise<any>;
/** 测试钩子：桩函数替换底层 CDP 调用（仅测试用，生产代码不调用）。
 *  用于断言 acceptResumeRequest 等带副作用函数「恰好点击一次」，防回归。 */
let _exOverride: ExFn | null = null;
export function __setExForTest(fn: ExFn | null): void {
  _exOverride = fn;
}

async function realEx(action: string, extra: any = {}): Promise<any> {
  const r = await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: PLATFORM, action, ...extra }),
  });
  return r.json();
}
/** 统一入口：未注入桩时走真实 CDP；注入后走桩（测试断言副作用次数用）。 */
function ex(action: string, extra: any = {}): Promise<any> {
  return (_exOverride || realEx)(action, extra);
}

/** 进聊天页（重新导航 + 点消息，兼容标签被风控重置） */
export async function openChat(): Promise<void> {
  await ex('navigate', { url: 'https://www.zhipin.com/', waitUntil: 'domcontentloaded' });
  await sleep(5000);
  await ex('eval', {
    script: `(()=>{const a=[].slice.call(document.querySelectorAll('a')).find(x=>/消息/.test(x.innerText||'')&&/chat/.test(x.getAttribute('href')||''));if(a)a.click();return 'ok';})()`,
  });
  await sleep(5000);
  _curTab = 0;   // 新进聊天页时列表默认停在「全部」
}

/** 会话列表的三个页签。
 *
 * 🔴 为什么必须把「未读」也算上（2026-10-06 实测，用户报「自动回复没有真实进行」的根因）：
 * BOSS 的「全部」页签**只渲染最新 40 条**（实测 li 恒 40、scrollHeight 恒定 7842，
 * 连续滚动/跳到底都不会再加载），而自动投递每天会新建几十个「招呼」会话 —— 于是「全部」
 * 的第一页被今天的新会话占满，**更早的、真有 HR 回话的未读会话全部落在视野之外**。
 * 实测：全部 40 条全是今天的，未读页签里另有 21 个会话（昨天 ~ 09-20）从来没被引擎看到过。
 * ⇒ 只读「全部」的旧实现，在投递量大时必然「漏掉所有未读」，且表现为「跑了但什么都没回」。
 * 「新招呼」是 HR 主动发起的会话，同样需要纳入。 */
const CONV_TABS = ['全部', '未读', '新招呼'] as const;

/** 浏览器内：点某个会话页签。返回 'clicked:<label>' / 'not-found'。
 *  用纯字符串比较而不是拼正则，避免模板字符串里的转义地狱。 */
function clickTabSrc(label: string): string {
  return `(()=>{ const want=${JSON.stringify(label)};
    const els=document.querySelectorAll('div,span,li,a,button');
    for(const el of els){
      const t=(el.innerText||'').replace(/\\s+/g,'').trim();
      if(!(t===want || t.startsWith(want+'('))) continue;
      const r=el.getBoundingClientRect();
      if(r.width<=0||r.height<=0||r.height>60) continue;
      if(el.children.length>1) continue;
      el.click(); return 'clicked:'+t;
    }
    return 'not-found'; })()`;
}

/** 浏览器内：把**当前显示**的会话列表读成 [{name,company,lastMsg,unread,raw}]。
 *  ⚠️ lastMsg 必须优先取 `.last-msg-text`：旧实现从整行 innerText 里剥时间/姓名，
 *  会把「昨天 / 公司名 / 职位」混进 lastMsg，导致引擎拿它跟 DB 的 last_hr_message
 *  比对时**永远不相等**（自动回复的前置过滤 `!lastHr.startsWith(c.lastMsg)` 因此恒真）。
 *  ⚠️ 未读角标的 class 是 `.notice-badge`（带数字），旧实现里 `[class*=dot]` 之类并不匹配它。 */
function readListSrc(): string {
  return `(()=>{
    const uls=document.querySelectorAll('.user-list-content ul');
    let t=null; for(const u of uls){ if(u.children.length>0){ t=u; break; } }
    if(!t) return JSON.stringify([]);
    const ROLE=/(HR|人事经理|人力资源|人事专员|人事|招聘顾问|招聘经理|招聘|项目经理|技术总监|技术经理|研发经理|研发总监|总经理|总监|主管|负责人|商务经理|商务|行政|运营|CEO|创始人|合伙人|CTO|团队负责人|部门经理|区域经理)$/;
    const out=[];
    for(const li of t.children){
      const nameEl=li.querySelector('.name-text');
      const name=(nameEl?nameEl.innerText:'').trim();
      if(!name) continue;
      const titleBoxEl=li.querySelector('.title-box');
      const titleBox=(titleBoxEl?titleBoxEl.innerText:'').replace(/\\s+/g,' ').trim();
      // title-box = name + company + role；去掉 name 前缀，再去掉尾部角色词，余下即公司
      let rest=titleBox.replace(name,'').trim();
      let company=rest;
      for(let k=0;k<3;k++){
        const m=company.match(ROLE);
        if(m && m.index!==undefined && m.index>0){ company=company.slice(0,m.index).trim(); }
        else break;
      }
      const txt=(li.innerText||'').replace(/\\s+/g,' ').trim();
      const badgeEl=li.querySelector('.notice-badge,.unread-num,[class*=unread-count],.badge,[class*=unread],[class*=red-dot]');
      const badgeTxt=badgeEl?(badgeEl.textContent||'').trim():'';
      const unread=!!badgeEl && (/^\\d+$/.test(badgeTxt) || /notice-badge|unread|red-dot/.test(String(badgeEl.className||'')));
      const msgEl=li.querySelector('.last-msg-text');
      let lastMsg;
      if(msgEl && (msgEl.innerText||'').trim()){
        lastMsg=(msgEl.innerText||'').replace(/\\s+/g,' ').trim();
      }else{
        lastMsg=txt.replace(name,'')
          .replace(/^(\\d{1,2}:\\d{2}|昨天|星期[一二三四五六日]|\\d{1,2}月\\d{1,2}日)/,'')
          .replace(/\\[送达\\]|\\[已读\\]/g,'').replace(name,'').trim();
      }
      // 末条是否我方发的：BOSS 给我方消息挂 [送达]/[已读]，HR 的消息不带（实测覆盖全部/未读/新招呼三页签）。
      // 只用于引擎的廉价前置排除，权威判据仍是 readConversation().lastHr。
      const mine=/\\[送达\\]|\\[已读\\]/.test(txt);
      out.push({name, company, lastMsg:lastMsg.slice(0,120), unread, mine, raw:txt.slice(0,160)});
    }
    return JSON.stringify(out);
  })()`;
}

/** 当前会话列表**实际停留在哪个页签**（CONV_TABS 下标）。
 *  作用：openConversation / readTab 换页签前先看它，
 *  避免「每个会话都白点一次『全部』」（40 个会话 = 白等 28 秒）。 */
let _curTab = 0;

/** 等会话列表容器就绪。
 *
 * 🔴 为什么不能只 sleep（2026-10-06 真机实测，用户报「列表出来了但一条都没回复」的第二个根因）：
 * 点任一页签后，BOSS 会把 `.user-list-content` **整个从 DOM 卸掉**再异步重建；
 * 这段空窗期里所有「找 li」的脚本只能拿到 NO_LIST。
 * 实测：listConversations 收尾点回「全部」后只 sleep 700ms，容器**仍不存在**
 * （`{"hasBox":false,"ulCount":0}`）⇒ 紧接着的 openConversation 一律 NO_LIST 秒失败，
 * 表现就是「会话都列出来了、点开全部失败（open-failed）」，用户看到的是「跑了但一条都没回」。
 * ⇒ 这不是「找不到会话」，是**列表还没回来**，必须等。
 * 返回是否在超时内等到容器。 */
async function waitListBox(timeoutMs = 6000): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    const r = await ex('eval', {
      script: `(()=>{ const c=document.querySelector('.user-list-content'); if(!c) return 'no'; return c.querySelectorAll('ul').length ? 'yes' : 'no'; })()`,
    });
    if (String(r.data) === 'yes') return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(350);
  }
}

/** 切到第 idx 个页签；返回是否真的切成功。
 *  页签不存在时（如「未读」为 0 —— BOSS 根本不渲染该页签）clickTabSrc 返回 'not-found'，
 *  此时不更新 `_curTab`（列表其实没动），调用方据此跳过。 */
async function gotoConvTab(idx: number): Promise<boolean> {
  const c = await ex('eval', { script: clickTabSrc(CONV_TABS[idx]) });
  if (!String(c.data || '').startsWith('clicked')) return false;
  _curTab = idx;
  await sleep(idx === 0 ? 700 : 1400);   // 过滤页签会重新拉列表，多等一会儿
  await waitListBox();                   // 再等容器重建完 —— 上面那点 sleep 不够（见 waitListBox 注释）
  return true;
}

/** 读第 idx 个页签的会话列表。页签点不到（不存在）返回 null。 */
async function readTab(idx: number): Promise<any[] | null> {
  if (_curTab !== idx && !(await gotoConvTab(idx))) return null;
  const r = await ex('eval', { script: readListSrc() });
  return JSON.parse((r.data as string) || '[]');
}

/** 读**当前显示**的列表（不切页签）。 */
async function readListNow(): Promise<any[]> {
  const r = await ex('eval', { script: readListSrc() });
  return JSON.parse((r.data as string) || '[]');
}

/** 「全部」页签滚动收集的步长（× clientHeight）与步数上限。
 *  实测基线（2026-10-06）：clientHeight=274 / scrollHeight=7842；每步 548px 时
 *  40 行的窗口与新位置**始终重叠**（不会跳过行），全量约 93~100 个会话、12 步走完 ⇒ 上限 18 步留余量。 */
const CONV_SCROLL_STEP = 2;
const CONV_SCROLL_MAX = 18;

/**
 * 读「全部」页签的**全量**会话（滚动收集）。
 *
 * 🔴 为什么必须滚动（2026-10-06 真机实测，用户报「一轮之后又没反应了」的根因）：
 * 「全部」是**虚拟化列表** —— 一次只渲染 40 行，但**滚到底就是完整历史**。
 * 实测：滚到 50% / 100% 时那 40 行**整批换掉**（与滚动前重名 0/40），能翻到「昨天」「10月04日」的会话；
 * 滚动收集去重后共 93 个不同会话。
 * ⚠️ 此前只看「行数恒 40」就判定「全部无分页」，是**错的** —— 行数恒定正是虚拟化的特征。
 *
 * 非做不可的原因：`openConversation` 打开会话会把它标记为已读 ⇒ **从「未读」页签消失**。
 * 若列表只以「未读」为来源，则「跑过一轮（哪怕只是预览）之后，被打开却没回成的会话就永远回不了」。
 * 现在「全部」能滚出全量 ⇒ 列表来源是可持续的。
 */
async function readAllTab(): Promise<any[]> {
  // 先归零：上一轮可能把列表停在半路
  await ex('eval', { script: `(()=>{ const c=document.querySelector('.user-list-content'); if(c) c.scrollTop=0; return 'ok'; })()` });
  await sleep(900);
  const seen = new Map<string, any>();
  const add = (list: any[]): number => {
    let fresh = 0;
    for (const c of list) {
      const k = `boss|${c.name || '未知'}|${c.company || ''}`;
      const prev = seen.get(k);
      if (!prev) fresh++;
      if (!prev || (c.unread && !prev.unread)) seen.set(k, c);
    }
    return fresh;
  };
  add(await readListNow());
  let idle = 0;
  for (let i = 0; i < CONV_SCROLL_MAX && idle < 2; i++) {
    await ex('eval', {
      script: `(()=>{ const c=document.querySelector('.user-list-content'); if(!c) return 'no'; c.scrollTop += c.clientHeight * ${CONV_SCROLL_STEP}; return 'ok'; })()`,
    });
    await sleep(1100);
    idle = add(await readListNow()) > 0 ? 0 : idle + 1;
  }
  await ex('eval', { script: `(()=>{ const c=document.querySelector('.user-list-content'); if(c) c.scrollTop=0; return 'ok'; })()` });
  return Array.from(seen.values());
}

export async function listConversations(): Promise<ConvSummary[]> {
  const merged = new Map<string, any>();
  const add = (list: any[]) => {
    for (const c of list) {
      const key = `boss|${c.name || '未知'}|${c.company || ''}`;
      const prev = merged.get(key);
      if (!prev || (c.unread && !prev.unread)) merged.set(key, c);
    }
  };

  // ① 「全部」= 可持续的**全量**来源（虚拟化列表，滚动收集；见 readAllTab 注释）
  if (_curTab !== 0) await gotoConvTab(0);
  add(await readAllTab());

  // ② 「未读」「新招呼」= 未读态与最热两份的补充（未读那份的未读标记更可信）
  for (let i = 1; i < CONV_TABS.length; i++) {
    const list = await readTab(i);
    if (list) add(list);
  }

  // 收尾把列表切回「全部」：openConversation 靠 `_curTab` 决定是否要切页签，这里必须归位
  await gotoConvTab(0);
  return Array.from(merged.values()).map((c) => ({
    key: `boss|${c.name}|${c.company}`,
    name: c.name || '未知',
    company: c.company || '',
    lastMsg: c.lastMsg || '',
    unread: !!c.unread,
    lastMine: !!c.mine,
    raw: c.raw || '',
  }));
}

export async function openConversation(key: string): Promise<boolean> {
  const parts = key.split('|');
  const pName = parts[1] || '';
  const pCompany = parts[2] || '';
  // BOSS 会话列表是虚拟化列表：连续打开多个后只保留视口附近条目，更深的 li 会被回收出 DOM。
  // 故在 node 侧循环「查找目标 → 滚入视口并点击 → 校验切换」，找不到就滚动列表容器后重试。
  // 校验改用「窗格 HR 姓名」匹配（.chat-conversation .name-text），而非要求 li.message-item>0：
  //   这样系统/Bot 会话、消息加载慢的会话也能被正确判为「已打开」，再由引擎按 lastHr 决定跳过，
  //   彻底消除旧逻辑把「已打开但无真人消息」误判 EMPTY 导致的 open-failed（旧版实测 14→7 残留即此因）。
  //
  // 🔴 页签轮转（2026-10-06，用户报「自动回复没有真实进行」的根因修复之一）：
  //   listConversations 现在读的是「全部 + 未读 + 新招呼」三页签的**并集**，但「点开」只能在
  //   **当前显示**的那一份列表里点。目标若来自「未读」页签而当前停在「全部」，
  //   则**无论怎么滚动都找不到**（实测「全部」恒 40 条，滚动/跳到底都不加载更多）。
  //   故 NOT_FOUND 时除滚一滚当前页签外，还要**轮转页签**重找；三个页签都找过才判「真不在」。
  const triedTabs = new Set<number>([_curTab]);
  let scrollTries = 0;
  let noListTries = 0;
  for (let attempt = 0; attempt < 60; attempt++) {
    const r = await ex('eval', {
      script: `(()=>{
        const uls=document.querySelectorAll('.user-list-content ul');
        let t=null; for(const u of uls){ if(u.children.length>0){ t=u; break; } }
        if(!t) return 'NO_LIST';
        const pName=${JSON.stringify(pName)};
        const pCompany=${JSON.stringify(pCompany)};
        let fallback=null;
        for(const li of t.children){
          const name=(li.querySelector('.name-text')||{innerText:''}).innerText.trim();
          const txt=(li.innerText||'').replace(/\\s+/g,' ');
          if(name===pName && (!pCompany || txt.includes(pCompany))){
            const fc=li.querySelector('.friend-content')||li; fc.scrollIntoView({block:'center'}); fc.click(); return 'opened';
          }
          if(name===pName && !fallback) fallback=li;
        }
        if(fallback){ const fc=fallback.querySelector('.friend-content')||fallback; fc.scrollIntoView({block:'center'}); fc.click(); return 'opened'; }
        return 'NOT_FOUND';
      })()`,
    });
    if ((r.data as string) === 'opened') {
      // 校验：窗格已切换到目标 HR（按姓名）。允许包含关系容错（列表名与窗格名可能略有差异）。
      let ok = false;
      for (let v = 0; v < 4; v++) {
        await sleep(1200);
        const vv = await ex('eval', {
          script: `(()=>{ const c=document.querySelector('.chat-conversation'); if(!c) return ''; const n=(c.querySelector('.name-text')||{innerText:''}).innerText.trim(); return n; })()`,
        });
        const openedName = (vv.data as string) || '';
        if (openedName && (openedName === pName || openedName.includes(pName) || pName.includes(openedName))) { ok = true; break; }
      }
      if (ok) return true;
      // 窗格姓名不匹配（可能切到别的会话 / 切换慢 / 系统会话名不同），继续下一轮重试
    } else if ((r.data as string) === 'NOT_FOUND') {
      // ① 先在当前页签内滚一滚（.user-list-content 才是真正的滚动容器，虚拟化列表会回收视口外的 li）
      if (scrollTries < 1) {
        scrollTries++;
        await ex('eval', {
          script: `(()=>{ const el=document.querySelector('.user-list-content'); if(el){ try{ el.scrollTop += 500; }catch(e){} } window.scrollBy(0,300); return 'scrolled'; })()`,
        });
        await sleep(700);
        continue;
      }
      // ② 当前页签确实没有 ⇒ 切到「还没试过的」下一个页签重找；三个页签全试完才收手
      scrollTries = 0;
      let next = -1;
      for (let k = 1; k <= CONV_TABS.length; k++) {
        const cand = (_curTab + k) % CONV_TABS.length;
        if (!triedTabs.has(cand)) { next = cand; break; }
      }
      if (next < 0) return false;   // 三个页签都找过了 ⇒ 目标确实不在会话列表里
      triedTabs.add(next);
      await gotoConvTab(next);      // 页签不存在（如无未读）时列表不动，下一轮继续轮转
    } else {
      // NO_LIST：列表容器正处在「卸掉 → 重建」的空窗期（见 waitListBox 注释），
      // **不是**「这个会话不存在」。旧实现直接 `return false` ⇒ 每个目标都秒失败、
      // 引擎全报 open-failed。这里给它一段**有界**的等待：列表回来就继续找，超时才认失败。
      if (++noListTries > 12) return false;   // ≈ 12 × 400ms ≈ 5s 仍没列表 ⇒ 真异常
      await sleep(400);
    }
  }
  return false;
}

/**
 * 读取当前会话所有消息，区分 HR / 我。
 *
 * 已校准的真实 DOM（2026-09-08 探查）：
 *  - 消息节点：li.message-item
 *  - item-myself = 我（求职者）；item-friend = HR（对方）
 *  - 真实 HR 文本在 .text 子节点内
 *  - 系统推送卡片（PK 情况 / 职位推荐等）同样是 item-friend，但内含 .articles-center，
 *    不是真人发的消息，必须跳过，否则会被误当成「HR 说了话」而触发自动回复
 */
export async function readConversation(): Promise<{
  messages: ParsedMessage[];
  lastHr: string;
  position?: string | null;
  resumeRequest?: boolean;
}> {
  const r = await ex('eval', {
    script: `(()=>{
      const conv=document.querySelector('.chat-conversation');
      if(!conv) return JSON.stringify({msgs:[]});
      // HR 发布的职位：聊天窗头部「.position-name」或「.chat-position-content」（已校准 2026-09-11）
      let pos=null;
      const pe=conv.querySelector('.position-name')||conv.querySelector('.chat-position-content');
      if(pe){ let t=(pe.innerText||'').replace(/\\s+/g,' ').trim(); t=t.replace(/\\s*(查看职位|\\d+-\\d+K|昆明|\\d+K).*$/,'').trim(); pos=t||null; }
      const items=[].slice.call(conv.querySelectorAll('li.message-item'));
      const msgs=[];
      for(const li of items){
        const cls=(li.className||'').toString();
        // 系统推送卡片（PK/职位推荐/活动）：非真人消息，跳过
        if(li.querySelector('.articles-center,.articles,.tip,[class*=system-tip],[class*=system-card]')) continue;
        const isMine=/item-myself/.test(cls);
        const textEl=li.querySelector('.text');
        const txt=(textEl?textEl.innerText:(li.innerText||'')).replace(/\\s+/g,' ').trim();
        if(!txt) continue;
        msgs.push({side: isMine?'me':'hr', text:txt});
      }
      // 「请求附件简历」卡片（BOSS 结构化请求，2026-09-23 校准）：
      //   DIV.message-dialog-both.message-card-wrap.boss-green > DIV.message-card-buttons > SPAN.card-btn「拒绝 / 同意」
      // 必须点卡片上的「同意」；走工具栏「发简历」是另一条路径 —— 卡片会一直挂着待处理（实测已验证）。
      // 注意：禁用态是 class「card-btn disabled」（SPAN 没有 disabled 属性，不能用 .disabled 判断！），
      //    已处理过的卡片按钮会变成 class disabled + pointer-events:none。
      // 判据：卡片文本含「附件简历 + 是否同意」，且存在未禁用的「同意」按钮。
      const btnDisabled=function(b){
        const cls=String(b.className||'');
        if(/(^|\\s)disabled(\\s|$)/.test(cls)) return true;
        if(b.disabled===true) return true;
        try{ if(getComputedStyle(b).pointerEvents==='none') return true; }catch(e){}
        return false;
      };
      let resumeRequest=false;
      const wraps=[].slice.call(conv.querySelectorAll('.message-card-wrap,[class*=message-card-wrap]'));
      for(const w of wraps){
        const wt=(w.innerText||'').replace(/\\s+/g,'');
        if(wt.indexOf('附件简历')<0||wt.indexOf('是否同意')<0) continue;
        const btns=[].slice.call(w.querySelectorAll('.card-btn,button'));
        const agree=btns.filter(function(b){return /^同意/.test((b.innerText||'').trim())&&!btnDisabled(b);});
        if(agree.length){ resumeRequest=true; break; }
      }
      return JSON.stringify({msgs, pos, resumeRequest});
    })()`,
  });
  const d = JSON.parse((r.data as string) || '{"msgs":[]}');
  const messages: ParsedMessage[] = d.msgs || [];
  const hrs = messages.filter((m: ParsedMessage) => m.side === 'hr');
  return {
    messages,
    lastHr: hrs.length ? hrs[hrs.length - 1].text : '',
    position: d.pos || null,
    resumeRequest: !!d.resumeRequest,
  };
}

/**
 * 同意平台「请求附件简历」卡片（2026-09-23 抽出跨平台通用实现，见 resumeCard.ts）。
 *
 * ⚠️ 有真实副作用：点下去会把在线简历发给 HR，引擎只在真实发送模式下调用。
 * ⚠️ **一次调用只点一次**（不做轮内重试）—— 通用实现内已含 ALREADY 已发送态守卫与复核，
 *    详见 resumeCard.ts 与 3 连发事故复盘。
 * 双路径兜底：① 会话流卡片里的「同意」；② 顶部提示条 `.respond-popover .btn-agree`。
 */
export async function acceptResumeRequest(): Promise<boolean> {
  return acceptResumeRequestGeneric(ex);
}

/** 在输入框输入文本（contenteditable + Vue v-model 兼容） */
export async function typeMessage(text: string): Promise<void> {
  await ex('eval', {
    script: `(()=>{
      const el=document.querySelector('.chat-input');
      if(!el) return 'NO_INPUT';
      el.focus();
      el.innerHTML='';
      document.execCommand('insertText', false, ${JSON.stringify(text)});
      el.dispatchEvent(new InputEvent('input',{bubbles:true}));
      return 'ok';
    })()`,
  });
  await sleep(600);
}

export async function sendText(text: string): Promise<boolean> {
  // 填文本（最多重试 3 次，确保 contenteditable 真的填进去了）
  for (let i = 0; i < 3; i++) {
    await typeMessage(text);
    const chk = await ex('eval', {
      script: `(()=>{ const el=document.querySelector('.chat-input'); const t=el?(el.innerText||el.textContent||'').trim():''; return t.length; })()`,
    });
    if ((chk.data as number) > 0) break;
    await sleep(600);
  }
  // 点击发送（按钮须 enabled，disabled 时等待重试，最多 3 次）
  for (let i = 0; i < 3; i++) {
    const r = await ex('eval', {
      script: `(()=>{
        const btn=[].slice.call(document.querySelectorAll('button')).find(b=>/发送/.test(b.innerText||'')&&/btn-send/.test(b.className||''));
        if(!btn) return 'NO_BTN';
        if(btn.disabled || /disabled/.test(btn.className||'')) return 'DISABLED';
        btn.click(); return 'sent';
      })()`,
    });
    if ((r.data as string) === 'sent') {
      await sleep(2500);
      return true;
    }
    await sleep(1200);
  }
  return false;
}

/** 发简历（发在线简历 = 已导入的本地 PDF） */
export async function sendResume(): Promise<boolean> {
  // 点发简历
  const c1 = await ex('eval', {
    script: `(()=>{const conv=document.querySelector('.chat-conversation');const bs=[].slice.call(conv.querySelectorAll('.toolbar-btn-content'));const b=bs.find(x=>/发简历/.test(x.innerText||''));if(!b)return 'NO_BTN';b.click();return 'ok';})()`,
  });
  await sleep(3000);
  if ((c1.data as string) !== 'ok') return false;
  // 对话框内选「发送在线简历」并发送
  const c2 = await ex('eval', {
    script: `(()=>{
      const dlg=document.querySelector('.upload-select-dialog');
      if(!dlg) return 'NO_DLG';
      // 优先点「发送在线简历」这一项
      const one=[].slice.call(dlg.querySelectorAll('.select-one,[class*=select]')).find(e=>/发送在线简历/.test(e.innerText||''));
      if(one){ one.click(); return 'picked'; }
      // 否则点对话框内发送/确定
      const send=[].slice.call(dlg.querySelectorAll('button,[class*=btn]')).find(b=>/发送|确定|选这份/.test(b.innerText||''));
      if(send){ send.click(); return 'sent'; }
      return 'NO_SEND';
    })()`,
  });
  await sleep(3500);
  return (c2.data as string) === 'picked' || (c2.data as string) === 'sent';
}

/** BOSS 平台 ChatDriver 实现（供自动回复引擎统一调度） */
export const bossChatDriver: ChatDriver = {
  platform: PLATFORM,
  // 已真机校准 + 有可导航的 Web IM ⇒ 控制台下拉会正常列出、引擎可直接跑。
  calibrated: true,
  openChat,
  listConversations,
  openConversation,
  readConversation,
  sendText,
  sendResume,
  acceptResumeRequest,
};
