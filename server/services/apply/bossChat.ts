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
}

export async function listConversations(): Promise<ConvSummary[]> {
  const r = await ex('eval', {
    script: `(()=>{
      const uls=document.querySelectorAll('.user-list-content ul');
      let t=null; for(const u of uls){ if(u.children.length>0){ t=u; break; } }
      if(!t) return JSON.stringify([]);
      const ROLE=/(HR|人事经理|人力资源|人事专员|人事|招聘顾问|招聘经理|招聘|项目经理|技术总监|技术经理|研发经理|研发总监|总经理|总监|主管|负责人|商务经理|商务|行政|运营|CEO|创始人|合伙人|CTO|团队负责人|部门经理|区域经理)$/;
      const out=[];
      for(const li of t.children){
        const nameEl=li.querySelector('.name-text');
        const name=(nameEl?nameEl.innerText:'').trim();
        const titleBoxEl=li.querySelector('.title-box');
        const titleBox=(titleBoxEl?titleBoxEl.innerText:'').replace(/\\s+/g,' ').trim();
        // title-box = name + company + role；去掉 name 前缀，再去掉尾部角色词，余下即公司
        let rest=titleBox.replace(name,'').trim();
        // 反复去掉尾部角色词（如「人事经理」「HR」）
        let company=rest;
        for(let k=0;k<3;k++){
          const m=company.match(ROLE);
          if(m && m.index!==undefined && m.index>0){ company=company.slice(0,m.index).trim(); }
          else break;
        }
        const txt=(li.innerText||'').replace(/\\s+/g,' ').trim();
        // 未读红点 class 名不稳定（unread-num / red-dot / badge 等），多兜几类，且认数字角标
        const unreadBadge=li.querySelector('[class*=unread],[class*=red-dot],.badge,.unread-num,[class*=dot]');
        const unreadNum=li.querySelector('.unread-num,[class*=unread-count],[class*=badge]');
        const unread=!!unreadBadge||!!(unreadNum&&/\d/.test((unreadNum.textContent||'').trim()));
        const lastMsg=txt.replace(name,'').replace(/^\\d{1,2}:\\d{2}/,'').replace(/\\[送达\\]|\\[已读\\]/g,'').replace(name,'').trim().slice(0,120);
        out.push({name, company, lastMsg, unread, raw:txt.slice(0,160)});
      }
      return JSON.stringify(out);
    })()`,
  });
  const list: any[] = JSON.parse((r.data as string) || '[]');
  return list.map((c) => ({
    key: `boss|${c.name}|${c.company}`,
    name: c.name || '未知',
    company: c.company || '',
    lastMsg: c.lastMsg || '',
    unread: !!c.unread,
    raw: c.raw || '',
  }));
}

export async function openConversation(key: string): Promise<boolean> {
  const parts = key.split('|');
  const pName = parts[1] || '';
  const pCompany = parts[2] || '';
  // BOSS 会话列表是虚拟化列表：连续打开多个后只保留视口附近条目，更深的 li 会被回收出 DOM。
  // 故在 node 侧循环「查找目标 → 滚入视口并点击 → 校验切换」，找不到就滚动列表容器加载更多后重试。
  // 校验改用「窗格 HR 姓名」匹配（.chat-conversation .name-text），而非要求 li.message-item>0：
  //   这样系统/Bot 会话、消息加载慢的会话也能被正确判为「已打开」，再由引擎按 lastHr 决定跳过，
  //   彻底消除旧逻辑把「已打开但无真人消息」误判 EMPTY 导致的 open-failed（旧版实测 14→7 残留即此因）。
  for (let attempt = 0; attempt < 30; attempt++) {
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
      // 目标未渲染：滚动列表容器（.user-list-content 才是真正滚动容器）触发虚拟化加载更多
      await ex('eval', {
        script: `(()=>{ const el=document.querySelector('.user-list-content'); if(el){ try{ el.scrollTop += 500; }catch(e){} } window.scrollBy(0,300); return 'scrolled'; })()`,
      });
      await sleep(700);
    } else {
      return false; // NO_LIST
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
  openChat,
  listConversations,
  openConversation,
  readConversation,
  sendText,
  sendResume,
  acceptResumeRequest,
};
