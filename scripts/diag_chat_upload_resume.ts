const PORT = 4400;
const PLATFORM = process.env.CHAT_PLATFORM || 'boss';
const BASE = `http://127.0.0.1:${PORT}/api/browser/exec`;
const FILE = 'D:/Desktop/杨欣宇简历.pdf';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function ex(action: string, extra: any = {}) {
  const r: any = await fetch(BASE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform: PLATFORM, action, ...extra }) });
  return r.json();
}

(async () => {
  await ex('navigate', { url: 'https://www.zhipin.com/', waitUntil: 'domcontentloaded' });
  await sleep(5000);
  await ex('eval', { script: `(()=>{const a=[].slice.call(document.querySelectorAll('a')).find(x=>/消息/.test(x.innerText||'')&&/chat/.test(x.getAttribute('href')||''));if(a)a.click();return 'ok';})()` });
  await sleep(5000);
  await ex('eval', { script: `(()=>{const uls=document.querySelectorAll('.user-list-content ul');let t=null;for(const u of uls){if(u.children.length>0){t=u;break}}if(!t)return 'NO_LIST';const fc=t.children[0].querySelector('.friend-content')||t.children[0];fc.click();return 'ok';})()` });
  await sleep(9000);

  // 发简历
  const r1 = await ex('eval', { script: `(()=>{const conv=document.querySelector('.chat-conversation');const bs=[].slice.call(conv.querySelectorAll('.toolbar-btn-content'));const b=bs.find(x=>/发简历/.test(x.innerText||''));if(!b)return 'NO_BTN';b.click();return 'ok';})()` });
  console.log('click 发简历:', r1.data);
  await sleep(3000);

  // 点对话框 上传附件简历
  const r2 = await ex('eval', { script: `(()=>{const all=[].slice.call(document.querySelectorAll('*'));const b=all.find(e=>/上传附件简历/.test(e.innerText||'')&&/btn-file/.test(e.className||''));if(!b)return 'NO_BTN';b.click();return 'clicked';})()` });
  console.log('click 上传附件简历:', r2.data);
  await sleep(2000);

  // 查 body file input (accept pdf)
  const r3 = await ex('eval', { script: `(()=>{const fis=[].slice.call(document.querySelectorAll('input[type=file]'));return JSON.stringify(fis.map(f=>({ka:f.getAttribute('ka'),accept:(f.getAttribute('accept')||'').slice(0,40),vis:f.offsetParent!==null})));})()` });
  console.log('file inputs:', JSON.stringify(r3.data).slice(0, 500));

  // upload 到全局 ka=user-resume-upload-file
  const r4 = await ex('upload', { selector: "input[type=file][ka=user-resume-upload-file]", filePath: FILE });
  console.log('upload:', JSON.stringify(r4).slice(0, 200));
  await sleep(9000);

  // 查对话框状态
  const r5 = await ex('eval', { script: `(()=>{const dlg=document.querySelector('.upload-select-dialog');const t=(dlg?dlg.innerText:document.body.innerText).replace(/\\s+/g,' ');const o={hasName:/杨欣宇简历/.test(t),hasPdf:/简历\\.pdf/.test(t),noAttached:/没有附件简历/.test(t),sendBtn:!!([].slice.call(document.querySelectorAll('button,[class*=btn]')).find(b=>/发送/.test(b.innerText||''))),snip:(t.match(/.{0,45}简历\\.pdf.{0,15}/g)||[]).slice(0,3)};return JSON.stringify(o)})()` });
  console.log('dialog after upload:', JSON.stringify(r5.data).slice(0, 600));
})().catch((e) => console.error('FATAL', e));
