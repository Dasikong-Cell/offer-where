/**
 * 猎聘（Liepin）聊天操作模块（基于已登录的 liepin CDP 标签，端口见 data/browser/cdp.json）
 *
 * ✅ 选择器已于 2026-09-10 真机探针校准（scripts/probe_liepin_chat2.ts 实测 30 个会话）。
 * 猎聘 IM 是一个挂载在首页的浮层（非独立 URL），入口为页头的 .im-ui-basic-entry，
 * 点击后展开 .im-ui-contacts-wrap 会话列表；打开某会话进入 .im-ui-chat-modal-container 面板。
 *
 * 校准后的关键选择器：
 *   入口        .im-ui-basic-entry
 *   会话项      .im-ui-contact-list-item   （姓名 .im-ui-contact-title-name；末条 .im-ui-last-message）
 *   消息气泡    .im-ui-message-item-wrapper （真实消息含 .im-ui-txt-content；我方带 .im-ui-txt.send / .im-ui-message-item-send）
 *   输入框      textarea.im-ui-textare     （placeholder「请输入文字，按Enter键发送」）
 *   发送按钮    .im-ui-basic-send-btn      （文本「发送」）
 *   发简历      .im-ui-action-button.action-resume
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

/** 进猎聘 IM 聊天面板（首页点页头 .im-ui-basic-entry 入口） */
export async function openChat(): Promise<void> {
  await ex('navigate', { url: 'https://www.liepin.com/', waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3500);
  // 若面板未展开（入口非 active），点击展开
  await ex('eval', {
    script: `(()=>{
      const entry=document.querySelector('.im-ui-basic-entry');
      if(!entry) return 'NO_ENTRY';
      const active=entry.className && /\\bactive\\b/.test(entry.className);
      if(!active){ entry.click(); }
      return active?'already-open':'opened';
    })()`,
  });
  // 轮询等待会话列表加载完（列表加载较慢，最长 ~40s）
  for (let i = 0; i < 20; i++) {
    await sleep(2000);
    const r = await ex('eval', {
      script: `(()=>{const items=document.querySelectorAll('.im-ui-contact-list-item');return JSON.stringify({n:items.length, loading:!!document.querySelector('.im-ui-contacts-wrap.im-ui-list-loading')});})()`,
    });
    const d = JSON.parse((r.data as string) || '{"n":0}');
    if (d.n >= 1) break;
  }
  await sleep(1500);
}

export async function listConversations(): Promise<ConvSummary[]> {
  const r = await ex('eval', {
    script: `(()=>{
      const items=[].slice.call(document.querySelectorAll('.im-ui-contact-list-item'));
      if(!items.length) return JSON.stringify({items:[], note:'NO_LIST'});
      const out=[];
      for(const li of items){
        const name=((li.querySelector('.im-ui-contact-title-name')||{innerText:''}).innerText||'').trim();
        const msg=((li.querySelector('.im-ui-last-message')||li.querySelector('.im-ui-contact-item-message')||{innerText:''}).innerText||'').replace(/\\s+/g,' ').trim();
        const unread=/未读/.test(msg) || !!li.querySelector('[class*=unread]');
        out.push({name, raw:msg, unread});
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
    lastMsg: (c.raw || '').replace(/^\\[未读\\]/, '').trim().slice(0, 120),
    unread: !!c.unread,
    raw: c.raw || '',
  }));
}

export async function openConversation(key: string): Promise<boolean> {
  const parts = key.split('|');
  const idx = Number(parts[2] || '0');
  const name = parts[1] || '';
  const r = await ex('eval', {
    script: `(()=>{
      const items=[].slice.call(document.querySelectorAll('.im-ui-contact-list-item'));
      let target=items[${idx}];
      if(!target && ${JSON.stringify(name)}){ target=items.find(li=>(li.innerText||'').includes(${JSON.stringify(name)})); }
      if(!target) return 'NOT_FOUND';
      target.click();
      return 'opened';
    })()`,
  });
  // 等待聊天面板加载（消息列表出现）
  for (let i = 0; i < 12; i++) {
    await sleep(1500);
    const chk = await ex('eval', {
      script: `(()=>{return JSON.stringify({has:!!document.querySelector('.im-ui-message-list-wrapper')||!!document.querySelector('.im-ui-chat-list'), msgs:document.querySelectorAll('.im-ui-message-item-wrapper').length});})()`,
    });
    const d = JSON.parse((chk.data as string) || '{"has":false}');
    if (d.has || d.msgs >= 1) break;
  }
  await sleep(1000);
  return (r.data as string) === 'opened';
}

export async function readConversation(): Promise<{ messages: ParsedMessage[]; lastHr: string }> {
  const r = await ex('eval', {
    script: `(()=>{
      const WRAP='.im-ui-message-item-wrapper';
      const all=[].slice.call(document.querySelectorAll(WRAP));
      const msgs=[];
      for(const li of all){
        const cls=(li.className||'').toString();
        // 跳过系统提示 / 纯时间戳
        if(/system-tip/.test(cls) && !li.querySelector('.im-ui-txt-content')) continue;
        const txtEl=li.querySelector('.im-ui-txt-content')||li.querySelector('.im-ui-txt')||li;
        const txt=(txtEl.innerText||li.innerText||'').replace(/\\s+/g,' ').trim();
        if(!txt) continue;
        const isMine=!!li.querySelector('.im-ui-txt.send')||/send/.test(cls)||!!li.querySelector('.im-ui-message-item-send');
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
  // 1) 填入 textarea（React 受控：原生 setter + input 事件）
  await ex('eval', {
    script: `(()=>{
      const SELS=['textarea.im-ui-textare','textarea[placeholder*="请输入文字"]','.im-ui-chat-input textarea','textarea'];
      let el=null; for(const s of SELS){ el=document.querySelector(s); if(el) break; }
      if(!el) return 'NO_INPUT';
      el.focus();
      const setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
      setter.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input',{bubbles:true}));
      el.dispatchEvent(new Event('change',{bubbles:true}));
      return 'ok';
    })()`,
  });
  await sleep(800);
  // 2) 点发送按钮
  const r = await ex('eval', {
    script: `(()=>{
      const SELS=['.im-ui-basic-send-btn','button.im-ui-basic-send-btn'];
      for(const s of SELS){ const b=document.querySelector(s); if(b && /发送/.test(b.innerText||'') && !b.disabled){ b.click(); return 'sent'; } }
      // 兜底：任意文本含「发送」且未禁用的按钮
      const all=[].slice.call(document.querySelectorAll('button')).find(b=>/发送/.test(b.innerText||'')&&!b.disabled);
      if(all){ all.click(); return 'sent'; }
      return 'NO_BTN';
    })()`,
  });
  await sleep(2200);
  return (r.data as string) === 'sent';
}

/** 发简历（点聊天面板工具栏「发简历」按钮 .im-ui-action-button.action-resume） */
export async function sendResume(): Promise<boolean> {
  const r = await ex('eval', {
    script: `(()=>{
      const cand=document.querySelector('.im-ui-action-button.action-resume')
        || [].slice.call(document.querySelectorAll('.im-ui-action-button,[class*=action]')).find(x=>/(简历|附件|上传)/.test(x.innerText||x.getAttribute('title')||x.getAttribute('aria-label')||''));
      if(cand){ cand.click(); return 'clicked'; }
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
