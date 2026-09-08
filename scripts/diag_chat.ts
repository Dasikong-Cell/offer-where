/**
 * BOSS 沟通页 DOM 诊断：先落首页建立会话，再进沟通页，dump 关键选择器数量与页面文本。
 * 目的：为自动回复(bossChat.ts)提供真实选择器，避免凭空猜 DOM。
 * 用法: tsx scripts/diag_chat.ts
 */
const API = 'http://127.0.0.1:4400/api/browser/exec';
const P = 'bosschat';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ex(action: string, args: Record<string, any> = {}) {
  try {
    const r = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: P, action, ...args }),
    });
    return await r.json();
  } catch (e: any) {
    return { ok: false, error: '请求失败: ' + (e?.message || String(e)) };
  }
}

const INSPECT = `(() => {
  var o = {};
  o.url = location.href;
  o.title = document.title;
  var c = function (s) { try { return document.querySelectorAll(s).length; } catch (e) { return -1; } };
  o.sel = {};
  var sels = ['[class*=chat-list]', '[class*=conversation]', '[class*=card-item]',
    '[class*=list-item]', '[class*=message]', '[class*=dialog]', '[class*=input]',
    'textarea', '[contenteditable]', 'input[type=file]', 'a[href*=chat]'];
  sels.forEach(function (s) { o.sel[s] = c(s); });
  o.txt = (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 400);
  return JSON.stringify(o);
})()`;

(async () => {
  console.log('>> 1) 先落首页');
  console.log(JSON.stringify(await ex('navigate', { url: 'https://www.zhipin.com/', waitUntil: 'domcontentloaded' })).slice(0, 220));
  await sleep(6000);

  console.log('>> 2) 进入沟通页');
  console.log(JSON.stringify(await ex('navigate', { url: 'https://www.zhipin.com/web/chat/index', waitUntil: 'domcontentloaded' })).slice(0, 220));
  await sleep(8000);

  console.log('>> 3) DOM 诊断');
  const info = await ex('eval', { script: INSPECT });
  console.log(JSON.stringify(info, null, 2).slice(0, 2500));
})();
