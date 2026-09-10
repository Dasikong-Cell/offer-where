/**
 * 猎聘 IM 全结构探针（耐心版）：
 *  1) 进首页 → 点 .im-ui-basic-entry 打开 IM 面板
 *  2) 轮询等待 .im-ui-contact-list-item 出现（列表加载完）
 *  3) 打开首个会话 → dump 消息主面板（输入框 / 发送按钮 / 气泡）
 * 只读，不发送。
 */
const API = 'http://127.0.0.1:4400';
const BASE = `${API}/api/browser/exec`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ex(action: string, extra: Record<string, any> = {}): Promise<any> {
  const r = await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: 'liepin', action, ...extra }),
  });
  return r.json();
}

const waitList = `(()=>{
  for(let i=0;i<40;i++){
    const items=document.querySelectorAll('.im-ui-contact-list-item');
    if(items.length && !document.querySelector('.im-ui-contacts-wrap.im-ui-list-loading')) return JSON.stringify({ready:true, count:items.length});
    // 也接受：有 item 但仍在 loading（loading 可能误标）
    if(items.length>=1) return JSON.stringify({ready:true, count:items.length});
  }
  return JSON.stringify({ready:false, spin:!!document.querySelector('.ant-im-spin-spinning')});
})()`;

(async () => {
  await ex('navigate', { url: 'https://www.liepin.com/', waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3500);
  await ex('eval', { script: `(()=>{const el=document.querySelector('.im-ui-basic-entry');if(el)el.click();})()` });

  // 轮询等待列表
  let ready = false;
  let count = 0;
  for (let i = 0; i < 20; i++) {
    await sleep(2000);
    const r = await ex('eval', { script: waitList });
    const d = JSON.parse(r.data || '{"ready":false}');
    if (d.ready) { ready = true; count = d.count; break; }
  }
  console.log('[列表状态] ready=', ready, 'count=', count);

  if (!ready) {
    const spin = await ex('eval', { script: `JSON.stringify({spin:!!document.querySelector('.ant-im-spin-spinning'), wrap:(document.querySelector('.im-ui-contacts-wrap')||{}).className||''})` });
    console.log('[列表未就绪]', spin.data);
    process.exit(0);
  }

  // dump 会话项结构
  const listDump = await ex('eval', {
    script: `(()=>{
      const items=[].slice.call(document.querySelectorAll('.im-ui-contact-list-item')).slice(0,3);
      return JSON.stringify(items.map(li=>({
        cls:(li.className||'').toString().slice(0,70),
        name:((li.querySelector('.im-ui-contact-title-name')||{innerText:''}).innerText||'').trim(),
        msg:((li.querySelector('.im-ui-last-message')||li.querySelector('.im-ui-contact-item-message')||{innerText:''}).innerText||'').replace(/\\s+/g,' ').trim().slice(0,60),
        unread:!!li.querySelector('.im-ui-basic-entry-unread-count,[class*=unread]')
      })));
    })()`,
  });
  console.log('[会话项]', listDump.data);

  // 打开首个会话
  const open = await ex('eval', { script: `(()=>{const li=document.querySelector('.im-ui-contact-list-item');if(!li)return 'NO_ITEM';li.click();return 'opened';})()` });
  console.log('[打开首个会话]', open.data);
  await sleep(5000);

  const pane = await ex('eval', {
    script: `(()=>{
      // 消息面板：常见 class
      const PANE=document.querySelector('[class*=chat-main],[class*=message-panel],[class*=conversation-main],[class*=im-chat],[class*=chat-content]');
      const bubbles=[].slice.call(document.querySelectorAll('[class*=message-item],[class*=msg-item],[class*=bubble],[class*=im-msg]')).slice(0,4).map(b=>({cls:(b.className||'').toString().slice(0,50), side:/mine|self|right|outgoing|my-/i.test(b.className||'')?'me':'hr', txt:(b.innerText||'').replace(/\\s+/g,' ').trim().slice(0,50)}));
      const inputs=['.im-chat-input','textarea','div[contenteditable=true]','[class*=chat-input]','[class*=im-input]'].map(s=>{const el=document.querySelector(s);return el?{s,ph:el.getAttribute('placeholder')||'',cls:(el.className||'').toString().slice(0,50),tag:el.tagName}:null;}).filter(Boolean);
      const sendBtns=[].slice.call(document.querySelectorAll('button')).filter(b=>/发送|发消息|聊一聊|send/i.test(b.innerText||'')).slice(0,6).map(b=>({txt:b.innerText.trim(),cls:(b.className||'').toString().slice(0,60),disabled:b.disabled}));
      const imClasses=[...new Set([].slice.call(document.querySelectorAll('[class]')).map(e=>(e.className||'').toString()).filter(c=>/im-ui|im-chat|chat/.test(c)))].slice(0,40);
      return JSON.stringify({paneCls:PANE?(PANE.className||'').toString().slice(0,70):null, bubbleCount:bubbles.length, bubbles, inputs, sendBtns, imClasses});
    })()`,
  });
  console.log('[消息面板]', pane.data);
  console.log('\n[probe done]');
  process.exit(0);
})();
