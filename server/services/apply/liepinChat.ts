/**
 * 猎聘（Liepin）聊天操作模块（基于已登录的 liepin CDP 标签，端口见 data/browser/cdp.json）
 *
 * ⚠️ 选择器说明：本模块的选择器为依据猎聘 IM 通用结构与 platforms.ts 中 hr 配置
 * （chatInputSel / sendSel）做出的「最佳推断」，尚未在真机逐项校准
 * （本开发环境无法启动图形浏览器逐窗探针）。逻辑骨架与 BOSS 版完全一致，
 * 真机首次运行若列表/消息解析为空，请按 server logs 的 [LiepinChat] 提示校准选择器。
 *
 * 已知可靠的入口思路（对齐 BOSS）：进首页 → 点页头「消息/聊天」→ 进 IM 页。
 */

import type { ChatDriver, ConvSummary, ParsedMessage } from './chatTypes.js';

const PORT = Number(process.env.PORT) || 4400;
const PLATFORM = 'liepin';
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

/** 进猎聘 IM 聊天页（首页点页头「消息/聊天」链接） */
export async function openChat(): Promise<void> {
  await ex('navigate', { url: 'https://www.liepin.com/', waitUntil: 'domcontentloaded' });
  await sleep(4000);
  await ex('eval', {
    script: `(()=>{
      const a=[].slice.call(document.querySelectorAll('a,span,div')).find(x=>/(消息|聊天|简信|私信|站内信)/.test(x.innerText||'')&&(x.getAttribute('href')||'').includes('liepin'));
      if(a){a.click();return 'clicked';}
      // 退而求其次：任何含「消息」的可点元素
      const b=[].slice.call(document.querySelectorAll('a,button')).find(x=>/消息/.test(x.innerText||''));
      if(b){b.click();return 'clicked-fallback';}
      return 'NO_ENTRY';
    })()`,
  });
  await sleep(4500);
}

export async function listConversations(): Promise<ConvSummary[]> {
  const r = await ex('eval', {
    script: `(()=>{
      // 候选容器：猎聘 IM 会话列表常见 class 形态（推断，需真机校准）
      const CONTAINERS = [
        '.im-conversation-list', '.conversation-list', '[class*="conversation-list"]',
        '[class*="chat-list"]', '[class*="session-list"]', '[class*="dialog-list"]',
      ];
      let list=null;
      for(const sel of CONTAINERS){ const el=document.querySelector(sel); if(el && el.children.length){ list=el; break; } }
      if(!list){
        // 整个页面兜底：找所有「带姓名 + 末条消息」的列表项
        const guess=[].slice.call(document.querySelectorAll('[class*="conversation"],[class*="session"],[class*="dialog"],[class*="chat-item"]'));
        if(guess.length){ list={children:guess}; }
      }
      if(!list || !list.children || !list.children.length){
        console.warn('[LiepinChat] 未找到会话列表容器，请校准选择器');
        return JSON.stringify({items:[], note:'NO_LIST'});
      }
      const out=[];
      for(const li of list.children){
        const name=(li.querySelector('.name,.nickname,[class*="name"],[class*="title"]')||{innerText:''}).innerText.trim()
          || (li.innerText||'').replace(/\\s+/g,' ').trim().slice(0,20);
        const txt=(li.innerText||'').replace(/\\s+/g,' ').trim();
        const unread=!!li.querySelector('[class*=unread],[class*=red-dot],.badge,[class*=dot],[class*=num]');
        out.push({name, raw:txt, unread});
      }
      return JSON.stringify({items:out});
    })()`,
  });
  const d = JSON.parse((r.data as string) || '{"items":[]}');
  const items: any[] = d.items || [];
  return items.map((c, i) => ({
    key: `liepin|${c.name}|${i}`,
    name: c.name || '未知',
    company: '',
    lastMsg: (c.raw || '').replace(c.name || '', '').trim().slice(0, 120),
    unread: !!c.unread,
    raw: c.raw || '',
  }));
}

export async function openConversation(key: string): Promise<boolean> {
  const idx = Number((key.split('|')[2] || '0'));
  const name = (key.split('|')[1] || '');
  const r = await ex('eval', {
    script: `(()=>{
      const CONTAINERS = [
        '.im-conversation-list', '.conversation-list', '[class*="conversation-list"]',
        '[class*="chat-list"]', '[class*="session-list"]', '[class*="dialog-list"]',
      ];
      let list=null;
      for(const sel of CONTAINERS){ const el=document.querySelector(sel); if(el && el.children.length){ list=el; break; } }
      if(!list){ const g=[].slice.call(document.querySelectorAll('[class*="conversation"],[class*="session"],[class*="dialog"],[class*="chat-item"]')); if(g.length) list={children:g}; }
      if(!list||!list.children||!list.children.length) return 'NO_LIST';
      const idx=${idx};
      const items=[].slice.call(list.children);
      let target=null;
      if(items[idx]) target=items[idx];
      else { const byName=items.find(li=>(li.innerText||'').includes(${JSON.stringify(name)})); if(byName) target=byName; }
      if(!target) return 'NOT_FOUND';
      const clickable=target.querySelector('[class*=item],[class*=row],a')||target;
      clickable.click(); return 'opened';
    })()`,
  });
  await sleep(3500);
  return (r.data as string) === 'opened';
}

export async function readConversation(): Promise<{ messages: ParsedMessage[]; lastHr: string }> {
  const r = await ex('eval', {
    script: `(()=>{
      const PANE = document.querySelector('.im-chat-main,.chat-main,[class*="chat-main"],[class*="message-panel"],[class*="conversation-main"]');
      if(!PANE){ console.warn('[LiepinChat] 未找到消息主面板'); return JSON.stringify({msgs:[],note:'NO_PANE'}); }
      const ITEMS=[].slice.call(PANE.querySelectorAll('[class*="message-item"],[class*="msg-item"],[class*="bubble-item"],li'));
      const msgs=[];
      for(const li of ITEMS){
        const cls=(li.className||'').toString();
        const isMine=/mine|self|right|outgoing|my-/i.test(cls);
        const txt=(li.innerText||'').replace(/\\s+/g,' ').trim();
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

export async function sendText(text: string): Promise<boolean> {
  await ex('eval', {
    script: `(()=>{
      const SELS=['.im-chat-input','textarea[placeholder*="沟通"]','textarea[placeholder*="输入"]','div[contenteditable="true"]','[class*="chat-input"]'];
      let el=null; for(const s of SELS){ el=document.querySelector(s); if(el) break; }
      if(!el) return 'NO_INPUT';
      el.focus();
      if(el.isContentEditable){ el.innerHTML=''; document.execCommand('insertText', false, ${JSON.stringify(text)}); }
      else { const setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set; setter.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input',{bubbles:true})); }
      el.dispatchEvent(new InputEvent('input',{bubbles:true}));
      return 'ok';
    })()`,
  });
  await sleep(600);
  const r = await ex('eval', {
    script: `(()=>{
      const SELS=['.im-send-btn','button.send','[class*="send-btn"]','[class*="send"]'];
      for(const s of SELS){ const b=document.querySelector(s); if(b && /发送/.test(b.innerText||'') && !b.disabled){ b.click(); return 'sent'; } }
      // 兜底：任意文本含「发送」的按钮
      const all=[].slice.call(document.querySelectorAll('button')).find(b=>/发送/.test(b.innerText||'')&&!b.disabled);
      if(all){ all.click(); return 'sent'; }
      return 'NO_BTN';
    })()`,
  });
  await sleep(2200);
  return (r.data as string) === 'sent';
}

/** 发简历（猎聘 IM 附件/发简历按钮，最佳推断；失败则上层仍会发文本） */
export async function sendResume(): Promise<boolean> {
  const r = await ex('eval', {
    script: `(()=>{
      // 猎聘 IM 工具栏的「发简历 / 附件」按钮（图标或文字），class 推断
      const cand=[].slice.call(document.querySelectorAll('[class*="toolbar"] [class*="btn"],button,[class*="icon"]')).find(x=>/(发简历|简历|附件|上传)/.test(x.innerText||x.getAttribute('title')||''));
      if(cand){ cand.click(); return 'clicked'; }
      // 退而求其次：聊天框附近的 input[type=file]（直接触发文件选择需前端带路径，这里仅点击触发）
      const file=document.querySelector('input[type=file]'); if(file){ file.click(); return 'file-clicked'; }
      return 'NO_BTN';
    })()`,
  });
  await sleep(2500);
  return (r.data as string) === 'clicked' || (r.data as string) === 'file-clicked';
}

/** 猎聘平台 ChatDriver 实现 */
export const liepinChatDriver: ChatDriver = {
  platform: PLATFORM,
  openChat,
  listConversations,
  openConversation,
  readConversation,
  sendText,
  sendResume,
};
