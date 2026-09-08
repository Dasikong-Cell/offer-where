/**
 * BOSS 沟通页 DOM 诊断（点击入口版）
 * 直接 goto /web/chat/index 会被风控（先 bticket 登录重定向，后 about:blank 清空），
 * 这里改为从首页点击页头「消息」链接，模拟真人操作路径。
 * 用法: tsx scripts/diag_chat_click.ts
 */
const API = 'http://127.0.0.1:4400/api/browser/exec';
const P = process.env.CHAT_PLATFORM || 'bosschat';
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
  console.log(`platform=${P}`);
  console.log('>> 1) 落首页');
  console.log(JSON.stringify(await ex('navigate', { url: 'https://www.zhipin.com/', waitUntil: 'domcontentloaded' })).slice(0, 200));
  await sleep(6000);

  console.log('>> 2) 点击页头「消息」');
  console.log(JSON.stringify(await ex('click', { text: '消息' })).slice(0, 250));
  await sleep(9000);

  console.log('>> 3) DOM 诊断');
  const info = await ex('eval', { script: INSPECT });
  console.log(JSON.stringify(info, null, 2).slice(0, 2500));
})();
