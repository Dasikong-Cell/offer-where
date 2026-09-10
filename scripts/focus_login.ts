/**
 * 把某平台的登录页聚焦到该平台自己的调试 Chrome 窗口最前台，并关掉其他干扰标签页。
 *
 * 背景：投递用的是「每平台一个独立 Chrome 进程」的调试浏览器
 *      （BOSS 9223 / 猎聘 9224 / 51job 9225 / 智联 9226 / official 9227，
 *       端口映射见 data/browser/cdp.json），
 *      它的登录态与用户日常用的普通 Chrome 完全隔离。用户常在"自己那个 Chrome"里登录，
 *      导致投递浏览器始终匿名，投递时要么找不到按钮、要么被引导去登录。
 *      本脚本让目标平台窗口的屏幕上只剩一个登录页并置顶，用户一眼就能认出该在哪操作。
 *
 * 用法（需要先启动后端 4400 与对应 Chrome 窗口）:
 *   tsx scripts/focus_login.ts boss
 *   tsx scripts/focus_login.ts job51
 *   tsx scripts/focus_login.ts liepin https://www.liepin.com/
 */
import fs from 'fs';
import path from 'path';

const platform = process.argv[2];
const urlArg = process.argv[3];

const API = process.env.API_BASE || 'http://127.0.0.1:4400';
const CDP_CONFIG = path.resolve('data/browser/cdp.json');

/** 各平台的登录页（不带参数时按平台自动选择） */
const LOGIN_URL: Record<string, string> = {
  boss: 'https://www.zhipin.com/web/user/?ka=header-login',
  liepin: 'https://www.liepin.com/',
  job51: 'https://www.51job.com/',
  zhilian: 'https://www.zhaopin.com/',
  official: 'https://www.zhipin.com/',
};

if (!platform) {
  console.error('用法: tsx scripts/focus_login.ts <platform> [url]');
  console.error(`可用平台: ${Object.keys(LOGIN_URL).join(' / ')}`);
  process.exit(1);
}
if (!LOGIN_URL[platform]) {
  console.error(`未知平台: ${platform}（可用: ${Object.keys(LOGIN_URL).join(' / ')}）`);
  process.exit(1);
}

/** 从 cdp.json 读取该平台的调试端口；读不到就回退到 9222。 */
function endpointFor(key: string): string {
  try {
    if (fs.existsSync(CDP_CONFIG)) {
      const cfg = JSON.parse(fs.readFileSync(CDP_CONFIG, 'utf-8'));
      if (typeof cfg?.[key] === 'string' && cfg[key].trim()) return cfg[key].trim();
    }
  } catch { /* 配置损坏时走默认 */ }
  return process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222';
}

const CDP = endpointFor(platform);
const url = urlArg || LOGIN_URL[platform];
const host = new URL(url).host.replace(/^www\./, '');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ex(action: string, args: Record<string, any> = {}) {
  const r = await fetch(`${API}/api/browser/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform, action, ...args }),
  });
  return r.json() as Promise<Record<string, any>>;
}

async function listTargets(): Promise<any[]> {
  try {
    const r = await fetch(`${CDP}/json/list`);
    return (await r.json()) as any[];
  } catch {
    return [];
  }
}
async function closeTarget(id: string) {
  try { await fetch(`${CDP}/json/close/${id}`); } catch { /* 忽略 */ }
}
async function activate(id: string) {
  try { await fetch(`${CDP}/json/activate/${id}`); } catch { /* 忽略 */ }
}

(async () => {
  console.log(`[${platform}] 调试端口 ${CDP}`);
  console.log(`导航到登录页: ${url}`);

  const nav = await ex('navigate', { url, waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log(`  导航结果: ok=${nav.ok}${nav.error ? ' error=' + nav.error : ''}`);
  if (!nav.ok) {
    console.log(`\n⚠ 无法导航。请确认：\n  1) 后端 4400 已启动\n  2) 端口 ${CDP} 对应的 Chrome 调试窗口已启动（双击桌面「投递Agent」）`);
    process.exit(1);
  }
  await sleep(3500);

  // 找到该域名标签：优先复用已存在的，否则保留当前导航后的标签
  let target: any | undefined;
  for (let i = 0; i < 10; i++) {
    const pages = (await listTargets()).filter((t) => t.type === 'page');
    target = pages.find((t) => (t.url || '').includes(host));
    if (target) break;
    await sleep(1000);
  }

  if (!target) {
    console.log(`  ⚠ 未检测到 ${host} 标签页，跳过清理（不误关其它标签）`);
  } else {
    const pages = (await listTargets()).filter((t) => t.type === 'page');
    const others = pages.filter((t) => t.id !== target.id);
    if (others.length) {
      console.log(`  清理干扰标签: ${others.length} 个`);
      for (const t of others) await closeTarget(t.id);
      await sleep(700);
    }
    await activate(target.id);
    await sleep(500);
    try { await ex('bringToFront'); } catch { /* 忽略 */ }
    console.log(`  已置顶: ${target.url}`);
  }

  const remain = (await listTargets()).filter((t) => t.type === 'page');
  console.log(`\n端口 ${CDP} 的 Chrome 窗口当前仅剩 ${remain.length} 个标签:`);
  for (const t of remain) console.log(`  - ${t.url}`);
  console.log(`\n请在弹出的这个 Chrome 窗口里完成【${platform}】登录，登录后再重新投递即可。`);
  process.exit(0);
})();
