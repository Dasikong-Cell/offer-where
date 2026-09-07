/* 并行检查各平台登录态（各 platform 用独立 tab，互不干扰） */
const B = 'http://127.0.0.1:4400/api/browser/exec';
const ex = (platform: string, b: any) => fetch(B, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ platform, ...b }),
}).then((r) => r.json());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CFG: Record<string, { home: string; logged: string[]; anon: string[] }> = {
  boss: { home: 'https://www.zhipin.com/', logged: ['退出', '我的', '沟通', '简历', '牛人'], anon: ['扫码登录', '验证码登录', '账号密码登录', '邮箱登录'] },
  job51: { home: 'https://www.51job.com/', logged: ['退出登录', '我的简历', '我的求职', '个人中心', '消息中心'], anon: ['请登录', '账号登录', '登录并投递', '扫码登录', '短信登录'] },
  liepin: { home: 'https://www.liepin.com/', logged: ['退出', '我的', '简历', '沟通', '消息'], anon: ['请登录', '登录猎聘', '账号登录'] },
};

async function check(p: string) {
  const c = CFG[p];
  try {
    await ex(p, { action: 'navigate', url: c.home, waitUntil: 'domcontentloaded' });
    await sleep(4500);
    const d = await ex(p, { action: 'eval', script: '(document.body.innerText||String()).replace(/\\s+/g," ").slice(0,400)' });
    const t: string = d.data || '';
    const hasLogged = c.logged.filter((k) => t.includes(k));
    const hasAnon = c.anon.filter((k) => t.includes(k));
    console.log(`\n[${p}] 登录标记=${JSON.stringify(hasLogged)} 未登录标记=${JSON.stringify(hasAnon)}`);
    console.log(`  页面文本: ${t.slice(0, 200)}`);
  } catch (e: any) {
    console.log(`\n[${p}] 检查失败: ${e?.message}`);
  }
}

(async () => { await Promise.all([check('boss'), check('job51'), check('liepin')]); })();
