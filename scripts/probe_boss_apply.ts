/**
 * BOSS 投递流程探针：逐步执行并打印每一步后的页面状态，
 * 用来定位「点沟通后到底跳到了哪里」。只读 + 有限点击，不发送任何消息。
 *
 * 用法:
 *   tsx scripts/probe_boss_apply.ts <jobUrl>
 */
const API = process.env.API_BASE || 'http://127.0.0.1:4400';
const PLATFORM = 'boss';

const jobUrl = process.argv[2];
if (!jobUrl) {
  console.error('用法: tsx scripts/probe_boss_apply.ts <岗位URL>');
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ex(action: string, args: Record<string, any> = {}) {
  const r = await fetch(`${API}/api/browser/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: PLATFORM, action, ...args }),
  });
  return r.json() as Promise<Record<string, any>>;
}

const STATE_SCRIPT = `
JSON.stringify({
  url: location.href,
  title: document.title,
  text: document.body ? (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 420) : '',
  buttons: Array.prototype.slice.call(document.querySelectorAll('button, a, [role="button"]'))
    .map(function(x){ return (x.innerText || x.textContent || '').trim(); })
    .filter(function(t){ return t && t.length < 20; })
    .slice(0, 30),
  dialogs: Array.prototype.slice.call(document.querySelectorAll('.dialog, [class*=dialog-wrap], [class*=dialog_container], [class*=modal]'))
    .filter(function(d){ var r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
    .map(function(d){ return (d.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 160); })
    .slice(0, 5),
})
`;

async function snap(label: string) {
  const r = await ex('eval', { script: STATE_SCRIPT });
  let d: any = r.data;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch { /* raw */ } }
  console.log(`\n----- ${label} -----`);
  if (typeof d !== 'object' || !d) {
    console.log('返回异常:', String(r.data).slice(0, 300));
    return null;
  }
  console.log(`URL  : ${d.url}`);
  console.log(`标题 : ${d.title}`);
  console.log(`正文 : ${(d.text || '(空)').slice(0, 400)}`);
  const btns: string[] = Array.from(new Set(d.buttons || []));
  console.log(`按钮 : ${btns.length ? btns.join(' | ') : '(无)'}`);
  if (d.dialogs && d.dialogs.length) {
    console.log(`弹窗 :`);
    d.dialogs.forEach((t: string, i: number) => console.log(`   [弹窗${i + 1}] ${t}`));
  }
  return d;
}

(async () => {
  console.log(`目标岗位: ${jobUrl}`);
  const nav = await ex('navigate', { url: jobUrl, waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log(`导航结果: ok=${nav.ok} title=${nav.title || ''}`);
  await sleep(4500);
  await snap('第 1 步：岗位详情页');

  // 尝试逐个点击候选按钮
  // 候选顺序必须与 server/services/apply/boss.ts 保持一致：
  // BOSS JD 页真实按钮是「继续沟通」，且绝不能包含「在线简历」「完善在线简历」「感兴趣」
  const candidates = ['继续沟通', '立即沟通', '沟一下', '沟通', '投个简历', '发简历', '投递简历', '投递'];
  let clicked = false;
  for (const label of candidates) {
    const r = await ex('click', { text: label, timeout: 5000 });
    console.log(`\n点击「${label}」: ok=${r.ok}${r.error ? ' error=' + r.error : ''}`);
    if (r.ok) {
      clicked = true;
      await sleep(3200);
      await snap(`点击「${label}」之后`);
      break;
    }
  }
  if (!clicked) console.log('\n⚠ 所有候选按钮均未命中');
  process.exit(0);
})();
