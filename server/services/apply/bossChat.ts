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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ex(action: string, extra: any = {}): Promise<any> {
  const r = await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: PLATFORM, action, ...extra }),
  });
  return r.json();
}

export interface ConvSummary {
  key: string;
  name: string;
  company: string;
  lastMsg: string;
  unread: boolean;
  raw: string;
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
        const unread=!!li.querySelector('[class*=unread],[class*=red-dot],.badge,[class*=dot]');
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
  const r = await ex('eval', {
    script: `(()=>{
      const uls=document.querySelectorAll('.user-list-content ul');
      let t=null; for(const u of uls){ if(u.children.length>0){ t=u; break; } }
      if(!t) return 'NO_LIST';
      const parts=${JSON.stringify(key)}.split('|');
      const pName=parts[1]||'';
      const pCompany=parts[2]||'';
      // 优先：name 与 company 同时命中（避免同名 HR 开错会话）
      let fallback=null;
      for(const li of t.children){
        const name=(li.querySelector('.name-text')||{innerText:''}).innerText.trim();
        const txt=(li.innerText||'').replace(/\\s+/g,' ');
        if(name===pName && (!pCompany || txt.includes(pCompany))){
          const fc=li.querySelector('.friend-content')||li; fc.click(); return 'opened';
        }
        if(name===pName && !fallback) fallback=li; // 仅 name 命中作兜底
      }
      if(fallback){ const fc=fallback.querySelector('.friend-content')||fallback; fc.click(); return 'opened'; }
      return 'NOT_FOUND';
    })()`,
  });
  await sleep(8000);
  return (r.data as string) === 'opened';
}

export interface ParsedMessage {
  side: 'hr' | 'me';
  text: string;
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
export async function readConversation(): Promise<{ messages: ParsedMessage[]; lastHr: string }> {
  const r = await ex('eval', {
    script: `(()=>{
      const conv=document.querySelector('.chat-conversation');
      if(!conv) return JSON.stringify({msgs:[]});
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
      return JSON.stringify({msgs});
    })()`,
  });
  const d = JSON.parse((r.data as string) || '{"msgs":[]}');
  const messages: ParsedMessage[] = d.msgs || [];
  const hrs = messages.filter((m: ParsedMessage) => m.side === 'hr');
  return { messages, lastHr: hrs.length ? hrs[hrs.length - 1].text : '' };
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
  await typeMessage(text);
  const r = await ex('eval', {
    script: `(()=>{
      const btn=[].slice.call(document.querySelectorAll('button')).find(b=>/发送/.test(b.innerText||'')&&/btn-send/.test(b.className||''));
      if(!btn) return 'NO_BTN';
      if(btn.disabled || /disabled/.test(btn.className||'')) return 'DISABLED';
      btn.click(); return 'sent';
    })()`,
  });
  await sleep(2500);
  return (r.data as string) === 'sent';
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
