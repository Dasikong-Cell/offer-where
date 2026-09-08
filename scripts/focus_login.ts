/**
 * 把某平台的登录页聚焦到调试 Chrome 的最前台，并关掉其他干扰标签页。
 *
 * 背景：投递用的是独立的调试 Chrome（--user-data-dir=C:/chrome-cdp-profile，
 * 端口 9222），它的登录态与用户日常用的普通 Chrome 完全隔离。用户常在"自己
 * 那个 Chrome"里登录，导致投递浏览器始终匿名。本脚本让调试 Chrome 的屏幕上
 * 只剩一个登录页并置顶，用户一眼就能认出该在哪个窗口操作。
 *
 * 用法:
 *   tsx scripts/focus_login.ts boss   https://www.zhipin.com/
 *   tsx scripts/focus_login.ts liepin https://www.liepin.com/
 */
const CDP = process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222';
const API = process.env.API_BASE || 'http://127.0.0.1:4400';

const platform = process.argv[2];
const url = process.argv[3];

if (!platform || !url) {
  console.error('用法: tsx scripts/focus_login.ts <platform> <url>');
  console.error('例:   tsx scripts/focus_login.ts boss https://www.zhipin.com/');
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ex(action: string, args: Record<string, any> = {}) {
  const r = await fetch(`${API}/api/browser/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform, action, ...args }),
  });
  return r.json();
}

async function listTargets(): Promise<any[]> {
  const r = await fetch(`${CDP}/json/list`);
  return (await r.json()) as any[];
}

async function closeTarget(id: string) {
  try {
    await fetch(`${CDP}/json/close/${id}`);
  } catch {
    /* 忽略关闭失败 */
  }
}

(async () => {
  const host = new URL(url).host.replace(/^www\./, '');
  console.log(`[${platform}] 导航到 ${url}`);
  const nav = await ex('navigate', { url, waitUntil: 'domcontentloaded' });
  if (!nav.ok) console.log(`  导航返回: ${JSON.stringify(nav).slice(0, 200)}`);
  await sleep(3500);

  const targets = await listTargets();
  const pages = targets.filter((t) => t.type === 'page');
  // 我们的标签：URL 命中目标域名；找不到就退化为"不关闭任何标签"
  const mine = pages.find((t) => (t.url || '').includes(host));

  if (!mine) {
    console.log(`  未找到 ${host} 的标签页，跳过清理（不误关用户标签）`);
  } else {
    const others = pages.filter((t) => t.id !== mine.id);
    console.log(`  清理干扰标签: ${others.length} 个`);
    for (const t of others) await closeTarget(t.id);
    await sleep(800);
  }

  const front = await ex('bringToFront');
  console.log(`  置顶: ${front.ok ? 'OK' : JSON.stringify(front).slice(0, 160)}`);

  const after = await listTargets();
  const remain = after.filter((t) => t.type === 'page');
  console.log(`\n当前调试 Chrome 仅剩 ${remain.length} 个标签:`);
  for (const t of remain) console.log(`  - ${t.url}`);
  console.log(`\n请在弹出的这个 Chrome 窗口里完成登录。`);
})();
