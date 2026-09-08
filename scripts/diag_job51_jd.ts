/* 探 JD 详情页可点元素 + 登录态 */
async function ex(action: string, body: any) {
  const r = await fetch('http://127.0.0.1:4400/api/browser/exec', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: 'job51', action, ...body }),
  });
  return r.json();
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const URL = process.argv[2] || 'https://jobs.51job.com/kunming-xsq/172823593.html';

async function main() {
  await ex('navigate', { url: URL, waitUntil: 'domcontentloaded' });
  await sleep(4000);
  const info = await ex('eval', { script: `(() => {
    const vis = e => e && e.offsetParent !== null;
    const all = [...document.querySelectorAll('button,a,[class*=btn],[class*=apply],[class*=op]')].filter(vis);
    const applyEls = all.filter(e => /投|申请|聊|简历|立即/.test(e.innerText||'')).map(e => ({
      tag: e.tagName, cls: (e.className||'').toString().slice(0,60), text: (e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,30), href: (e.getAttribute&&e.getAttribute('href')||'').slice(0,60)
    }));
    const body = (document.body.innerText||'').replace(/\\s+/g,' ');
    const hit = /投递|申请职位|立即申请|在线简历/.test(body);
    return JSON.stringify({ applyEls: applyEls.slice(0,25), pageHasApplyWord: hit, bodyTail: body.slice(-300) });
  })()` });
  console.log(JSON.stringify(info.data, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
