/**
 * BOSS 沟通页：定位左侧会话列表 → 点开首个会话 → dump 消息输入框与消息结构。
 * 用法: CHAT_PLATFORM=boss tsx scripts/diag_chat_list.ts
 */
const API = 'http://127.0.0.1:4400/api/browser/exec';
const P = process.env.CHAT_PLATFORM || 'boss';
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

/** 列出所有 class 含 chat 的元素，用来认出左侧列表容器 */
const LIST_CHAT = `(() => {
  var o = [];
  [].slice.call(document.querySelectorAll('[class*=chat]')).forEach(function (e) {
    if (o.length >= 35) return;
    o.push(e.tagName + ' | ' + String(e.className || '').slice(0, 60) +
      ' | kids=' + e.children.length +
      ' | txt=' + (e.innerText || '').replace(/\\s+/g, ' ').slice(0, 45));
  });
  return JSON.stringify(o);
})()`;

/** 点开第一个会话项 */
const CLICK_FIRST = `(() => {
  var sels = ['[class*=chat-user-list] [class*=item]', '[class*=chat-list] [class*=item]',
    '[class*=chat-item]', '[class*=list-item]', '[class*=conversation-item]', '[class*=user-item]'];
  for (var i = 0; i < sels.length; i++) {
    var el = document.querySelector(sels[i]);
    if (el) {
      el.click();
      return JSON.stringify({ sel: sels[i], txt: (el.innerText || '').replace(/\\s+/g, ' ').slice(0, 90) });
    }
  }
  return JSON.stringify({ sel: null });
})()`;

/** 会话打开后：输入框 / 发送按钮 / 消息气泡 / 文件输入 */
const AFTER_OPEN = `(() => {
  var o = {};
  var cut = function (s, n) { return (s || '').replace(/\\s+/g, ' ').slice(0, n || 300); };
  o.url = location.href;

  var boxes = [].slice.call(document.querySelectorAll('textarea, [contenteditable], [role=textbox], input[type=text]'));
  o.inputs = boxes.slice(0, 10).map(function (e) {
    return e.tagName + ' ce=' + (e.getAttribute('contenteditable') || '') +
      ' class=' + cut(e.className, 80) + ' ph=' + (e.getAttribute('placeholder') || '');
  });

  var btns = [].slice.call(document.querySelectorAll('button, [class*=btn], a'))
    .filter(function (b) { return /发送|发送简历|附件|文件|简历/.test(b.innerText || ''); });
  o.buttons = btns.slice(0, 12).map(function (b) {
    return b.tagName + ' | ' + cut(b.innerText, 24) + ' | class=' + cut(b.className, 70);
  });

  var fi = document.querySelector('input[type=file]');
  o.fileInput = fi ? cut(fi.outerHTML, 300) : '(none)';

  o.bodyTail = cut(document.body.innerText, 500);
  return JSON.stringify(o);
})()`;

(async () => {
  console.log('platform=' + P);
  await ex('navigate', { url: 'https://www.zhipin.com/', waitUntil: 'domcontentloaded' });
  await sleep(6000);
  await ex('click', { text: '消息' });
  await sleep(9000);

  const list = await ex('eval', { script: LIST_CHAT });
  console.log('----- chat* 元素清单 -----');
  (JSON.parse(list.data || '[]') as string[]).forEach((s) => console.log('  ' + s));

  const clicked = await ex('eval', { script: CLICK_FIRST });
  console.log('\n----- 点开首个会话 -----');
  console.log('  ' + (clicked.data || clicked.error || ''));
  await sleep(7000);

  const after = await ex('eval', { script: AFTER_OPEN });
  const d = typeof after.data === 'string' ? JSON.parse(after.data) : after.data;
  console.log('\n----- 会话打开后 -----');
  if (!d) { console.log(JSON.stringify(after).slice(0, 400)); return; }
  for (const k of Object.keys(d)) {
    console.log('\n[' + k + ']');
    console.log(Array.isArray(d[k]) ? JSON.stringify(d[k], null, 1).slice(0, 1200) : String(d[k]).slice(0, 800));
  }
})();
