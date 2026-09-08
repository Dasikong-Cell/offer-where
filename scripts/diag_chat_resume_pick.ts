const PORT = 4400;
const PLATFORM = process.env.CHAT_PLATFORM || 'boss';
const BASE = `http://127.0.0.1:${PORT}/api/browser/exec`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function ex(action: string, extra: any = {}) {
  const r = await fetch(BASE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform: PLATFORM, action, ...extra }) });
  return r.json();
}
const cut = (s: string, n = 60) => (s || '').replace(/\s+/g, ' ').slice(0, n);

(async () => {
  await ex('navigate', { url: 'https://www.zhipin.com/', waitUntil: 'domcontentloaded' });
  await sleep(5000);
  await ex('eval', { script: `(()=>{const a=[].slice.call(document.querySelectorAll('a')).find(x=>/消息/.test(x.innerText||'')&&/chat/.test(x.getAttribute('href')||''));if(a)a.click();return 'ok';})()` });
  await sleep(5000);
  await ex('eval', { script: `(()=>{const uls=document.querySelectorAll('.user-list-content ul');let t=null;for(const u of uls){if(u.children.length>0){t=u;break}}if(!t)return 'NO_LIST';const fc=t.children[0].querySelector('.friend-content')||t.children[0];fc.click();return 'ok';})()` });
  await sleep(9000);
  await ex('eval', { script: `(()=>{const conv=document.querySelector('.chat-conversation');const bs=[].slice.call(conv.querySelectorAll('.toolbar-btn-content'));const b=bs.find(x=>/发简历/.test(x.innerText||''));if(b)b.click();return 'ok';})()` });
  await sleep(3500);

  // 全局查含简历关键词的可点击元素（含父链）
  const r = await ex('eval', { script: `(()=>{
    const all=[].slice.call(document.querySelectorAll('*'));
    const hits=all.filter(e=>{const t=(e.innerText||'').replace(/\\s+/g,' ');return /杨欣宇简历|附件简历|在线简历|发送简历|简历\\.pdf/.test(t)&&t.length<60;});
    const out=hits.slice(0,15).map(e=>{
      let p=e.parentElement, depth=0, btn=null;
      while(p&&depth<5){if(p.tagName==='BUTTON'||(p.getAttribute&&p.getAttribute('role')==='button')||/btn/.test(p.className||'')){btn={tag:p.tagName,cls:cut(p.className,40),txt:cut(p.innerText,16)};break;}p=p.parentElement;depth++;}
      return {tag:e.tagName,cls:cut(e.className,40),txt:cut(e.innerText,28),clickableParent:btn};
    });
    return JSON.stringify(out);
  })()` });
  console.log('RESUME_PICK:', JSON.stringify(r.data).slice(0, 2000));
})().catch((e) => console.error('FATAL', e));
