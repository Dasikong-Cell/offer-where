const PORT = 4400;
const PLATFORM = process.env.CHAT_PLATFORM || 'boss';
const BASE = `http://127.0.0.1:${PORT}/api/browser/exec`;

async function ex(action: string, extra: any = {}) {
  const r = await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: PLATFORM, action, ...extra }),
  });
  return r.json();
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function cut(s: string, n = 80) {
  return (s || '').replace(/\s+/g, ' ').slice(0, n);
}

(async () => {
  console.log('=== 1) 进首页 ===');
  await ex('navigate', { url: 'https://www.zhipin.com/', waitUntil: 'domcontentloaded' });
  await sleep(5000);

  console.log('=== 2) 点页头"消息" ===');
  const clickMsg = await ex('eval', {
    script: `(() => {
      const links = [].slice.call(document.querySelectorAll('a'));
      const m = links.find(a => /消息/.test(a.innerText || '') && /chat/.test(a.getAttribute('href') || ''));
      if (m) { m.click(); return 'clicked: ' + (m.getAttribute('href')||''); }
      // fallback: any link containing 消息
      const m2 = links.find(a => (a.innerText||'').trim() === '消息');
      if (m2) { m2.click(); return 'clicked-fallback: ' + (m2.getAttribute('href')||''); }
      return 'NO_MSG_LINK';
    })()`,
  });
  console.log('clickMsg:', JSON.stringify(clickMsg).slice(0, 200));
  await sleep(6000);

  console.log('=== 3) 当前 URL ===');
  const url = await ex('eval', { script: 'location.href' });
  console.log('url:', JSON.stringify(url).slice(0, 200));

  console.log('=== 4) 会话列表 ===');
  const list = await ex('eval', {
    script: `(() => {
      const uls = document.querySelectorAll('.user-list-content ul');
      let t = null;
      for (const u of uls) { if (u.children.length > 0) { t = u; break; } }
      if (!t) return JSON.stringify({ count: 0, first: 'none' });
      const li = t.children[0];
      const info = li.querySelector('.user-info, a, .name, .title') || li;
      return JSON.stringify({ count: t.children.length, firstText: (li.innerText||'').replace(/\\s+/g,' ').slice(0,120), firstClasses: li.className });
    })()`,
  });
  console.log('list:', JSON.stringify(list).slice(0, 300));

  console.log('=== 5) 点开第一个会话 ===');
  const clicked = await ex('eval', {
    script: `(() => {
      const uls = document.querySelectorAll('.user-list-content ul');
      let t = null;
      for (const u of uls) { if (u.children.length > 0) { t = u; break; } }
      if (!t) return 'NO_LIST';
      const li = t.children[0];
      const target = li.querySelector('a') || li.querySelector('.user-info') || li;
      target.click();
      return 'clicked li0 -> ' + (li.innerText||'').replace(/\\s+/g,' ').slice(0,60);
    })()`,
  });
  console.log('clicked:', JSON.stringify(clicked).slice(0, 200));
  await sleep(10000);

  console.log('=== 6) 右侧会话窗格交互元素 ===');
  const pane = await ex('eval', {
    script: `(() => {
      const cut = (s,n)=>(s||'').replace(/\\s+/g,' ').slice(0,n||90);
      const conv = document.querySelector('.chat-conversation');
      if (!conv) return JSON.stringify({ conv: 'MISSING', body: cut(document.body.innerText,200) });
      const o = { convFound: true };
      o.inputs = [].slice.call(conv.querySelectorAll('textarea, input[type=text], [contenteditable]')).map(e => ({
        tag: e.tagName, ce: e.getAttribute('contenteditable')||'', cls: cut(e.className,70), ph: e.getAttribute('placeholder')||''
      }));
      o.btns = [].slice.call(conv.querySelectorAll('button, [class*=btn]')).filter(b => (b.innerText||'').trim()).map(b => ({
        txt: cut(b.innerText,16), cls: cut(b.className,55)
      }));
      const f = conv.querySelector('input[type=file]');
      o.file = f ? { accept: f.getAttribute('accept'), ka: f.getAttribute('ka'), cls: cut(f.className,40) } : 'none-in-conv';
      o.paneText = cut(conv.innerText, 200);
      return JSON.stringify(o);
    })()`,
  });
  console.log('pane:', JSON.stringify(pane).slice(0, 1500));
})().catch((e) => console.error('FATAL', e));
