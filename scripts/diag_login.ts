/**
 * 各平台登录态 / 页面可达性诊断
 *
 * 判定策略（按可靠性排序）：
 *   1) 页面出现档案姓名（如「杨欣宇」）→ 100% 已登录
 *   2) 导航到「必须登录才能看」的受保护页，若被重定向到登录域 → 未登录
 *   3) 页面同时含登录浮层关键词（发送验证码/密码登录/登录或注册）→ 未登录
 *
 * 用法:
 *   tsx scripts/diag_login.ts            # 全部平台
 *   tsx scripts/diag_login.ts boss       # 只测某个平台
 */
const API = process.env.API_BASE || 'http://127.0.0.1:4400';
const NAME = process.env.DIAG_NAME || '杨欣宇';

const PLATFORMS: Array<{
  key: string; label: string; home: string; protectedUrl: string; loginHint: RegExp;
}> = [
  {
    key: 'boss', label: 'BOSS直聘', home: 'https://www.zhipin.com/',
    protectedUrl: 'https://www.zhipin.com/web/geek/card',
    loginHint: /(login|passport)/i,
  },
  {
    key: 'liepin', label: '猎聘', home: 'https://www.liepin.com/',
    protectedUrl: 'https://www.liepin.com/person/resume/',
    loginHint: /(login|passport| \/ user)/i,
  },
  {
    key: 'job51', label: '51job', home: 'https://www.51job.com/',
    protectedUrl: 'https://we.51job.com/pc/my/myjob',
    loginHint: /(login\.51job|login|passport)/i,
  },
  {
    key: 'zhilian', label: '智联招聘', home: 'https://www.zhaopin.com/',
    protectedUrl: 'https://i.zhaopin.com/',
    loginHint: /(login|passport|passport\.zhaopin)/i,
  },
];

// 登录浮层关键词：命中即视为未登录（即便页面其它地方有「职位推荐」等词）
const LOGIN_WALL: RegExp[] = [
  /登录\/注册/, /请登录/, /立即登录/, /账号登录/, /扫码登录/, /短信登录/,
  /密码登录/, /发送验证码/, /获取验证码/, /登录并投递/, /登录后投递/,
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ex(platform: string, action: string, args: Record<string, any> = {}) {
  const r = await fetch(`${API}/api/browser/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform, action, ...args }),
  });
  return r.json() as Promise<Record<string, any>>;
}

async function pageText(platform: string): Promise<string> {
  const r = await ex(platform, 'eval', {
    script: 'document.body ? (document.body.innerText || document.body.textContent || "").replace(/\\s+/g," ").trim() : ""',
  });
  return String(r.data || '');
}

async function readWithRetry(platform: string, waitMs = 4000): Promise<string> {
  let text = await pageText(platform);
  if (!text) { await sleep(waitMs); text = await pageText(platform); }
  return text;
}

async function diag(p: (typeof PLATFORMS)[number]) {
  console.log(`\n===== ${p.label} (${p.key}) =====`);

  // ---- 步骤 1：首页是否直接显示姓名 ----
  const nav = await ex(p.key, 'navigate', { url: p.home, waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log(`首页导航: ok=${nav.ok}  title=${nav.title || ''}`);
  if (!nav.ok) {
    console.log(`  ✖ 导航失败: ${nav.error || JSON.stringify(nav).slice(0, 200)}`);
    return;
  }
  await sleep(4500);
  let text = await readWithRetry(p.key);
  console.log(`正文长度: ${text.length}`);
  console.log(`正文片段: ${text.slice(0, 180)}`);

  if (text.includes(NAME)) {
    console.log(`  ✔ 已登录（首页直接显示姓名 ${NAME}）`);
    return true;
  }
  const wall = LOGIN_WALL.filter((re) => re.test(text));
  if (wall.length) {
    console.log(`  ✖ 未登录（首页出现登录浮层关键词: ${wall.map((r) => r.source).join(' / ')}）`);
    return false;
  }
  console.log(`  ? 首页无法判定，改用受保护页继续判断…`);

  // ---- 步骤 2：受保护页是否被重定向到登录页 ----
  const nav2 = await ex(p.key, 'navigate', { url: p.protectedUrl, waitUntil: 'domcontentloaded', timeout: 30000 });
  const finalUrl = String(nav2.url || '');
  console.log(`受保护页: ${p.protectedUrl}`);
  console.log(`落地 URL: ${finalUrl}`);
  await sleep(4000);
  const text2 = await readWithRetry(p.key);
  console.log(`落地正文片段: ${text2.slice(0, 180)}`);

  const redirected = p.loginHint.test(finalUrl);
  if (redirected) {
    console.log(`  ✖ 未登录（被重定向到登录页: ${finalUrl}）`);
    return false;
  }
  if (text2.includes(NAME)) {
    console.log(`  ✔ 已登录（受保护页显示姓名 ${NAME}）`);
    return true;
  }
  const wall2 = LOGIN_WALL.filter((re) => re.test(text2));
  if (wall2.length) {
    console.log(`  ✖ 未登录（受保护页出现登录浮层: ${wall2.map((r) => r.source).join(' / ')}）`);
    return false;
  }
  console.log(`  ✔ 已登录（受保护页正常渲染，无登录墙）`);
  return true;
}

(async () => {
  const only = process.argv[2];
  const list = only ? PLATFORMS.filter((p) => p.key === only) : PLATFORMS;
  if (!list.length) {
    console.error(`未知平台: ${only}（可用: ${PLATFORMS.map((p) => p.key).join(' / ')}）`);
    process.exit(1);
  }
  const out: Record<string, boolean | undefined> = {};
  for (const p of list) {
    try {
      out[p.key] = await diag(p);
    } catch (e: any) {
      console.log(`  ✖ 诊断异常: ${e?.message || e}`);
      out[p.key] = undefined;
    }
  }
  console.log('\n===== 汇总 =====');
  for (const [k, v] of Object.entries(out)) {
    console.log(`${k}: ${v === true ? '已登录' : v === false ? '未登录' : '未知'}`);
  }
  process.exit(0);
})();
