/**
 * 并行检查各平台登录态（各 platform 用独立 tab，互不干扰）
 * ==========================================================================
 * 2026-09-19 重写。旧版有三个问题（实测踩到）：
 *   ① **只打印标记数组、不给结论** —— 用户得自己猜「登录标记=[简历]」算不算登录；
 *   ② **标记词与实际页面不符** —— 猎聘真实未登录页出现的是「登录/注册」「密码登录」「获取验证码」，
 *      旧 anon 标记写的是「请登录/账号登录/登录猎聘」→ 一个都不命中，于是「未登录标记=[]」；
 *   ③ **logged 标记含泛词** —— 旧 liepin logged 里有「简历」，而未登录首页有「简历优化」→ 命中 →
 *      把**未登录误报成已登录**（实测：页面明明有登录框，却报「登录标记=[简历]」）。
 *
 * 现规则（决定性差异）：**anon 优先**。命中 anon 一律判未登录；否则命中 logged 才算已登录；
 * 都不命中判「未知」（不猜测，并提示需人工确认）。退出码 0=全部已登录，1=有未登录，2=有未知。
 *
 * 运行：./node/node.exe node_modules/tsx/dist/cli.mjs scripts/check_logins.ts [platform...]
 */
import { ex } from './lib/browser.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface LoginCfg {
  home: string;
  /** 已登录特征词（必须是**只有登录后**才出现的词，禁止用「简历/我的」这类泛词） */
  logged: string[];
  /** 未登录特征词（登录框/注册入口的原文） */
  anon: string[];
}

const CFG: Record<string, LoginCfg> = {
  boss: {
    home: 'https://www.zhipin.com/',
    // 未登录时页头是「登录/注册」，登录后才把「消息/简历」入口加进页头导航（实测 2026-09-19）
    logged: ['消息', '简历', '退出登录', '个人中心'],
    // BOSS 未登录首页顶部/弹层会出现登录方式选择（命中即判未登录，优先级高于 logged）
    anon: ['扫码登录', '验证码登录', '账号密码登录', '手机号登录', '登录/注册', '立即登录'],
  },
  job51: {
    home: 'https://www.51job.com/',
    logged: ['我的求职', '我的简历', '在线简历', '个人中心', '退出登录', '简历快推'],
    anon: ['请登录', '账号登录', '登录并投递', '扫码登录', '短信登录', '登录/注册'],
  },
  liepin: {
    home: 'https://www.liepin.com/',
    // ⚠️ 不能用「简历」——未登录首页有「简历优化」会误命中
    logged: ['退出登录', '我的猎聘', '个人中心', '实名认证', '我的简历'],
    anon: ['登录/注册', '密码登录', '获取验证码', '登录猎聘', '立即登录'],
  },
  zhilian: {
    home: 'https://www.zhaopin.com/',
    logged: ['退出登录', '我的智联', '个人中心', '我的简历'],
    anon: ['登录/注册', '密码登录', '立即登录', '微信登录', '扫码登录', '获取验证码'],
  },
};

type Verdict = 'logged-in' | 'not-logged-in' | 'unknown';

async function check(p: string): Promise<{ platform: string; verdict: Verdict; logged: string[]; anon: string[]; text: string }> {
  const c = CFG[p];
  try {
    await ex(p, { action: 'navigate', url: c.home, waitUntil: 'domcontentloaded' });
    await sleep(4500);
    const d = await ex(p, { action: 'eval', script: '(document.body.innerText||String()).replace(/\\s+/g," ").slice(0,1200)' });
    const t: string = String(d.data || '');
    const logged = c.logged.filter((k) => t.includes(k));
    const anon = c.anon.filter((k) => t.includes(k));
    // anon 优先：未登录页会同时出现营销文案，但登录框只在未登录时出现
    const verdict: Verdict = anon.length ? 'not-logged-in' : logged.length ? 'logged-in' : 'unknown';
    return { platform: p, verdict, logged, anon, text: t };
  } catch (e: any) {
    return { platform: p, verdict: 'unknown', logged: [], anon: [], text: `检查失败：${e?.message || e}` };
  }
}

const targets = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const list = targets.length ? targets : Object.keys(CFG);

const results = await Promise.all(list.map((p) => check(p)));

const ICON: Record<Verdict, string> = { 'logged-in': '✅', 'not-logged-in': '❌', unknown: '⚠️' };
const LABEL: Record<Verdict, string> = { 'logged-in': '已登录', 'not-logged-in': '未登录', unknown: '未知（需人工确认）' };

console.log('\n══════ 平台登录态 ══════');
for (const r of results) {
  console.log(`\n${ICON[r.verdict]} [${r.platform}] ${LABEL[r.verdict]}`);
  console.log(`   已登录标记: ${JSON.stringify(r.logged)}   未登录标记: ${JSON.stringify(r.anon)}`);
  console.log(`   页面片段: ${r.text.slice(0, 180)}`);
}

const notLogged = results.filter((r) => r.verdict === 'not-logged-in');
const unknown = results.filter((r) => r.verdict === 'unknown');
console.log('\n══════ 汇总 ══════');
console.log(`已登录 ${results.filter((r) => r.verdict === 'logged-in').length} / 未登录 ${notLogged.length} / 未知 ${unknown.length}`);
if (notLogged.length) {
  console.log('\n需人工登录（用 focus_login.ts 把登录页置顶）：');
  for (const r of notLogged) console.log(`  ${r.platform} → ./node/node.exe node_modules/tsx/dist/cli.mjs scripts/focus_login.ts ${r.platform}`);
}
process.exit(notLogged.length ? 1 : unknown.length ? 2 : 0);
