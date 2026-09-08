/* 复现 job51 单岗位投递弹窗（两步）：导航 JD → 点投递 → 抓第一步弹窗 → 点立即申请 → 抓第二步弹窗 */
async function ex(action: string, body: any) {
  const r = await fetch('http://127.0.0.1:4400/api/browser/exec', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: 'job51', action, ...body }),
  });
  return r.json();
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const JD = process.argv[2] || 'https://jobs.51job.com/kunming/172478298.html';

const APPLY = `(() => {
  const byText = (re) => [...document.querySelectorAll('a,button')].find(e => re.test((e.textContent||'').trim()));
  const main = byText(/^(投递|立即投递|立即申请|申请职位|投个简历|申请)$/) || byText(/投递简历/);
  if (main && !main.disabled) { main.click(); return true; }
  return false;
})()`;

const DUMP = `(() => {
  const vis = e => e && e.offsetParent !== null && getComputedStyle(e).visibility !== 'hidden';
  // 任何可能的弹窗容器
  const cands = [...document.querySelectorAll('.el-dialog, .el-dialog__wrapper, [role=dialog], div[class*=dialog], div[class*=Dialog], div[class*=modal], div[class*=Modal], div[class*=overlay]')].filter(vis);
  const d = cands[cands.length - 1];
  const body = (document.body.innerText||'').replace(/\\s+/g,' ');
  if (!d) {
    // 退化：找含「简历/立即申请/发送」的可见元素
    const any = [...document.querySelectorAll('*')].find(e => vis(e) && /(选择需要投递的简历|选择简历|附件简历|请选择|立即申请|发送简历)/.test(e.innerText||'') && (e.innerText||'').length < 200);
    return JSON.stringify({ found:false, anyText: any ? (any.innerText||'').replace(/\\s+/g,' ').slice(0,200) : null, bodyAround: body.slice(0,500) });
  }
  const items = [...d.querySelectorAll('.attachment_item, li, label, [class*=resume], [class*=item], [class*=radio], input[type=radio]')]
    .filter(e => /(附件简历|我的简历|上传的简历|杨欣宇|\\.pdf|简历|radio)/.test(e.innerText||'') && (e.innerText||'').trim().length < 140)
    .map(e => (e.tagName||'') + '.' + (e.className||'').toString().slice(0,40) + ' | ' + (e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,60));
  const buttons = [...d.querySelectorAll('button, a.btn, [class*=btn]')].map(b => (b.innerText||'').trim() + ' /cls=' + (b.className||'').toString().slice(0,40));
  return JSON.stringify({ found:true, dlgClass:(d.className||'').toString(), items:items.slice(0,14), buttons:buttons.slice(0,14), text:(d.innerText||'').replace(/\\s+/g,' ').slice(0,500) }, null, 2);
})()`;

async function main() {
  await ex('navigate', { url: JD, waitUntil: 'domcontentloaded' });
  await sleep(5000);
  console.log('→ 点投递');
  console.log('apply click:', JSON.stringify((await ex('eval', { script: APPLY })).data));
  await sleep(6000);
  console.log('=== 第一步弹窗 ===');
  console.log((await ex('eval', { script: DUMP })).data);
  // 点「立即申请」
  const send1 = await ex('eval', { script: `(() => { const cands=[...document.querySelectorAll('.el-dialog,[role=dialog],div[class*=dialog],div[class*=Dialog],div[class*=modal]')].filter(e=>e.offsetParent!==null); const d=cands[cands.length-1]; if(!d) return false; const b=[...d.querySelectorAll('button')].find(x=>/立即申请|确定|投递|发送|提交/.test((x.innerText||'').trim())); if(!b) return 'no-btn'; b.click(); return true; })()` });
  console.log('点立即申请:', JSON.stringify(send1.data));
  await sleep(6000);
  console.log('=== 第二步弹窗 ===');
  console.log((await ex('eval', { script: DUMP })).data);
}
main().catch((e) => { console.error(e); process.exit(1); });
