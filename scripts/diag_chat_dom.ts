/**
 * BOSS 沟通页深入 DOM 诊断：dump 会话项、消息项、输入框、文件输入的真实结构。
 * 前置：必须从首页点击「消息」进入（/web/geek/chat?ka=header-message），
 *      直接 goto /web/chat/index 会被风控。
 * 用法: CHAT_PLATFORM=boss tsx scripts/diag_chat_dom.ts
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

const DUMP = `(() => {
  var o = {};
  o.url = location.href;
  var cut = function (s, n) { return (s || '').replace(/\\s+/g, ' ').slice(0, n || 600); };

  // 1) 会话列表容器
  var conv = document.querySelector('[class*=conversation]');
  o.convOuter = conv ? cut(conv.outerHTML, 900) : '(none)';

  // 2) 会话项：容器内所有可作为「项」的子孙（取前 3 个的结构）
  if (conv) {
    var kids = [].slice.call(conv.children).slice(0, 2);
    o.convChildren = kids.map(function (k) { return cut(k.outerHTML, 700); });
    o.convChildCount = conv.children.length;
  }

  // 3) 消息项
  var msgs = [].slice.call(document.querySelectorAll('[class*=message]'));
  o.msgCount = msgs.length;
  o.msgSample = msgs.slice(0, 2).map(function (m) { return cut(m.outerHTML, 500); });

  // 4) 输入框：找所有可编辑/文本输入类元素
  var boxes = [].slice.call(document.querySelectorAll('input, textarea, [contenteditable], [role=textbox]'));
  o.inputs = boxes.slice(0, 12).map(function (e) {
    return e.tagName + ' type=' + (e.getAttribute('type') || '') +
      ' ce=' + (e.getAttribute('contenteditable') || '') +
      ' class=' + cut(e.className, 90) +
      ' ph=' + (e.getAttribute('placeholder') || '');
  });

  // 5) 文件输入
  var fi = document.querySelector('input[type=file]');
  o.fileInput = fi ? cut(fi.outerHTML, 400) : '(none)';

  // 6) 可能存在的发送按钮
  var btns = [].slice.call(document.querySelectorAll('button, [class*=btn], [class*=send]'))
    .filter(function (b) { return /发送|发简历|附件|文件/.test(b.innerText || '') || /send|file|attach/i.test(b.className || ''); });
  o.buttons = btns.slice(0, 10).map(function (b) {
    return b.tagName + ' | ' + cut(b.innerText, 30) + ' | class=' + cut(b.className, 80);
  });

  // 7) 未读数量
  var m = (document.body.innerText || '').match(/未读\\((\\d+)\\)/);
  o.unread = m ? m[1] : '(none)';

  return JSON.stringify(o);
})()`;

(async () => {
  console.log('platform=' + P);
  console.log('>> 落首页');
  await ex('navigate', { url: 'https://www.zhipin.com/', waitUntil: 'domcontentloaded' });
  await sleep(6000);
  console.log('>> 点击「消息」');
  console.log(JSON.stringify(await ex('click', { text: '消息' })).slice(0, 200));
  await sleep(9000);

  const d = await ex('eval', { script: DUMP });
  const data = typeof d.data === 'string' ? JSON.parse(d.data) : d.data;
  if (!data) { console.log('诊断失败:', JSON.stringify(d).slice(0, 400)); return; }
  for (const k of Object.keys(data)) {
    console.log('\n----- ' + k + ' -----');
    console.log(Array.isArray(data[k]) ? JSON.stringify(data[k], null, 1).slice(0, 1800) : String(data[k]).slice(0, 1800));
  }
})();
