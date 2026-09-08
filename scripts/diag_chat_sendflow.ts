const PORT = 4400;
const PLATFORM = process.env.CHAT_PLATFORM || 'boss';
const BASE = `http://127.0.0.1:${PORT}/api/browser/exec`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function ex(action: string, extra: any = {}) {
  const r = await fetch(BASE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform: PLATFORM, action, ...extra }) });
  return r.json();
}
function J(o: any) { return JSON.stringify(o); }

(async () => {
  console.log('1) 进首页 + 点消息');
  await ex('navigate', { url: 'https://www.zhipin.com/', waitUntil: 'domcontentloaded' });
  await sleep(5000);
  await ex('eval', { script: `(()=>{const a=[].slice.call(document.querySelectorAll('a')).find(x=>/消息/.test(x.innerText||'')&&/chat/.test(x.getAttribute('href')||''));if(a)a.click();return 'ok';})()` });
  await sleep(5000);

  console.log('2) 开第一个会话');
  await ex('eval', { script: `(()=>{const uls=document.querySelectorAll('.user-list-content ul');let t=null;for(const u of uls){if(u.children.length>0){t=u;break}}if(!t)return 'NO_LIST';const fc=t.children[0].querySelector('.friend-content')||t.children[0];fc.click();return 'ok';})()` });
  await sleep(9000);

  console.log('3) 点聊天内发简历按钮');
  await ex('eval', { script: `(()=>{const conv=document.querySelector('.chat-conversation');if(!conv)return 'NO_CONV';const bs=[].slice.call(conv.querySelectorAll('.toolbar-btn-content'));const b=bs.find(x=>/发简历/.test(x.innerText||''));if(!b)return 'NO_BTN';b.click();return 'clicked';})()` });
  await sleep(3500);

  console.log('4) 查发简历浮层（聊天区内）');
  const r = await ex('eval', { script: `(()=>{const cut=(s,n)=>(s||'').replace(/\\s+/g,' ').slice(0,n||60);const conv=document.querySelector('.chat-conversation');if(!conv)return JSON.stringify({conv:false});const all=[].slice.call(conv.querySelectorAll('*'));const items=all.filter(e=>{const t=(e.innerText||'').replace(/\\s+/g,' ');return /在线简历|附件简历|杨欣宇简历|发送简历|选择简历/.test(t)&&t.length<50;});const sendBtns=[].slice.call(conv.querySelectorAll('button,.btn-sure,.btn-send,[class*=btn]')).filter(b=>(b.innerText||'').trim()&&/发送|确定|选这份|使用/.test(b.innerText));return JSON.stringify({conv:true,resumeItems:items.slice(0,12).map(e=>({cls:cut(e.className,40),txt:cut(e.innerText,30)})),sendBtns:sendBtns.slice(0,8).map(b=>({cls:cut(b.className,40),txt:cut(b.innerText,18)}))});})()` });
  console.log('  ', J(r.data).slice(0, 1500));

  console.log('5) 找附件简历项（只查不点）');
  const r2 = await ex('eval', { script: `(()=>{const cut=(s,n)=>(s||'').replace(/\\s+/g,' ').slice(0,n||70);const conv=document.querySelector('.chat-conversation');const all=[].slice.call(conv?conv.querySelectorAll('*'):[]);const att=all.filter(e=>{const t=(e.innerText||'').replace(/\\s+/g,' ');return /附件简历/.test(t)&&t.length<40;});return JSON.stringify(att.slice(0,6).map(e=>({tag:e.tagName,cls:cut(e.className,45),txt:cut(e.innerText,30),clickable:!!e.onclick||e.getAttribute('role')==='button'})));})()` });
  console.log('  ', J(r2.data).slice(0, 800));
})().catch((e) => console.error('FATAL', e));
