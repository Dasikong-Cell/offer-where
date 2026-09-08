/* 探查 51job 列表「投递」后弹出的简历选择弹窗真实 DOM
 * 用法: tsx scripts/diag_job51_modal.ts
 */
async function ex(action: string, body: any) {
  const r = await fetch('http://127.0.0.1:4400/api/browser/exec', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: 'job51', action, ...body }),
  });
  return r.json();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 点指定行的「投递」按钮（跳过已投）
const CLICK_ROW = (i: number) => `(() => {
  const rows = [...document.querySelectorAll('.joblist-item')];
  const r = rows[${i}];
  if (!r) return { ok: false, why: 'no-row' };
  const b = [...r.querySelectorAll('button,a')].find(x => /^(投递|立即投递|申请|已申请|已投递)$/.test((x.innerText||'').trim()));
  if (!b) return { ok: false, why: 'no-btn' };
  const label = (b.innerText||'').trim();
  if (/已申请|已投递/.test(label)) return { ok: false, why: 'already' };
  b.click();
  return { ok: true, label, txt: (r.innerText||'').replace(/\\s+/g,' ').slice(0,60) };
})()`;

const CLOSE_DLG = `(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', keyCode:27, which:27, bubbles:true })); return true; })()`;

const INSPECT = `(() => {
  const vis = e => e && e.offsetParent !== null && getComputedStyle(e).visibility !== 'hidden';
  const d = [...document.querySelectorAll('.el-dialog')].filter(vis).pop();
  if (!d) return { found: false };
  const t = (d.innerText||'').replace(/\\s+/g,' ');
  const isCampus = /应届生平台|校招网申|前往应届生/.test(t);
  const hasResume = /(附件简历|我的简历|上传的简历|选择需要同步发送|选择简历)/.test(t);
  return { found: true, isCampus, hasResume, text: t.slice(0,200) };
})()`;

const DUMP = `(() => {
  const vis = e => e && e.offsetParent !== null && getComputedStyle(e).visibility !== 'hidden';
  const d = [...document.querySelectorAll('.el-dialog')].filter(vis).pop();
  if (!d) return null;
  const items = [...d.querySelectorAll('.attachment_item, li, label, [class*=resume], [class*=item]')]
    .filter(e => /(附件简历|我的简历|上传的简历|杨欣宇|\\.pdf|简历)/.test(e.innerText||'') && (e.innerText||'').trim().length < 120)
    .map(e => (e.tagName||'') + '.' + (e.className||'') + ' | ' + (e.innerText||'').replace(/\\s+/g,' ').trim());
  const buttons = [...d.querySelectorAll('button, a.btn, [class*=btn]')].map(b => (b.innerText||'').trim() + ' /cls=' + (b.className||''));
  return JSON.stringify({ dlgClass: d.className, dlgHTMLhead: d.outerHTML.slice(0, 1600), resumeItems: items.slice(0,12), buttons: buttons.slice(0,14), dlgText: (d.innerText||'').replace(/\\s+/g,' ').slice(0,500) }, null, 2);
})()`;

// 在 JD 详情页点「投递/申请」主按钮
const CLICK_APPLY_JD = `(() => {
  const cands = [...document.querySelectorAll('button, a')].filter(b => /^(投递|立即投递|申请职位|申请|立即申请)$/.test((b.innerText||'').trim()));
  const b = cands[cands.length - 1];
  if (!b) return { ok: false, why: 'no-btn' };
  b.click();
  return { ok: true, label: (b.innerText||'').trim() };
})()`;

const JD_URL = process.argv[2] || 'https://jobs.51job.com/kunming-xsq/172823593.html';

const SEARCH_URL = (kw: string) => `https://we.51job.com/pc/search?keyword=${encodeURIComponent(kw)}&partner=`;
const KW = process.argv[2] || '项目经理';

async function main() {
  console.log('→ 搜索社招关键词:', KW, '(', SEARCH_URL(KW), ')');
  await ex('navigate', { url: SEARCH_URL(KW), waitUntil: 'domcontentloaded' });
  await sleep(5000);

  if (await ex('eval', { script: `(() => { const t = document.body.innerText||''; return /访问验证|滑动|请拖动/.test(t); })()` }).then(r => r.data)) {
    console.log('⚠ 命中滑块验证码，无法探查，请手动过验证码后重跑');
    return;
  }

  console.log('→ 逐行点「投递」，直到遇到简历选择弹窗');
  let dumped = false;
  for (let i = 0; i < 16 && !dumped; i++) {
    const c = await ex('eval', { script: CLICK_ROW(i) });
    const cd = c.data || {};
    if (!cd.ok) { if (cd.why !== 'already') console.log(`  行${i}: 跳过(${cd.why})`); continue; }
    console.log(`  行${i}: 点击「${cd.label}」 ${cd.txt}`);
    await sleep(3000);
    const insp = await ex('eval', { script: INSPECT });
    const id = insp.data || {};
    if (id.hasResume) {
      console.log(`  ✓ 行${i} 出现简历选择弹窗，抓取 DOM ...`);
      const dump = await ex('eval', { script: DUMP });
      console.log('=== 简历弹窗 DOM ===');
      console.log(typeof dump.data === 'string' ? dump.data : JSON.stringify(dump.data, null, 2));
      dumped = true;
    } else if (id.isCampus) {
      console.log(`  行${i}: 校招「立即前往」弹窗，Esc 关掉试下一行`);
      await ex('eval', { script: CLOSE_DLG });
      await sleep(1000);
    } else {
      console.log(`  行${i}: 其他弹窗(${(id.text || '').slice(0, 60)})，Esc 重试`);
      await ex('eval', { script: CLOSE_DLG });
      await sleep(1000);
    }
  }
  if (!dumped) console.log('未遇到简历选择弹窗（换关键词试试，如 Java 架构师 / 技术经理）');
}

main().catch((e) => { console.error('ERR', e); process.exit(1); });
