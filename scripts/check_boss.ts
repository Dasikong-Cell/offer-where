/* 只查 BOSS 登录态（避免导航 job51/liepin 打断正在跑的采集/投递） */
const B = 'http://127.0.0.1:4400/api/browser/exec';
const ex = (b: any) => fetch(B, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ platform: 'boss', ...b }),
}).then((r) => r.json());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await ex({ action: 'navigate', url: 'https://www.zhipin.com/', waitUntil: 'domcontentloaded' });
  await sleep(4500);
  const d = await ex({ action: 'eval', script: '(document.body.innerText||String()).replace(/\\s+/g," ").slice(0,300)' });
  const t: string = d.data || '';
  const logged = ['退出', '我的', '沟通', '简历', '牛人'].filter((k) => t.includes(k));
  const anon = ['登录/注册', '扫码登录', '验证码登录', '账号密码登录', '邮箱登录'].filter((k) => t.includes(k));
  console.log('BOSS 登录标记:', JSON.stringify(logged));
  console.log('BOSS 未登录标记:', JSON.stringify(anon));
  console.log('页面文本:', t.slice(0, 220));
})();
