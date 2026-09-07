/* 诊断：51job 岗位详情页被 loginCheck 误判为未登录的原因 */
import { listJobs } from '../server/db.ts';
import { PLATFORMS } from '../server/services/apply/platforms.ts';

const B = 'http://127.0.0.1:4400/api/browser/exec';
const ex = (b: any) => fetch(B, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ platform: 'job51', ...b }),
}).then((r) => r.json());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const jobs = listJobs({ source: 'job51' }).filter((j) => j.status !== 'applied');
  if (!jobs.length) { console.log('无 job51 待投岗位'); return; }
  const job = jobs[0];
  console.log('测试岗位:', job.position, '|', job.apply_url);

  await ex({ action: 'navigate', url: job.apply_url, waitUntil: 'domcontentloaded' });
  await sleep(4500);
  const t = await ex({ action: 'eval', script: '(document.body.innerText||String()).replace(/\\s+/g," ").slice(0,600)' });
  const u = await ex({ action: 'eval', script: 'location.href' });
  const text: string = t.data || '';
  const url: string = u.data || '';

  const needLogin = PLATFORMS.job51.loginCheck(text, url);
  console.log('\nloginCheck 判定（true=认为未登录）:', needLogin);
  console.log('URL:', url);
  console.log('\n页面文本:', text.slice(0, 500));
  console.log('\n--- 命中检查 ---');
  ['退出登录', '我的简历', '我的求职', '个人中心', '消息中心'].forEach((k) => {
    if (text.includes(k)) console.log(`  已登录标记命中: ${k}`);
  });
  ['请登录', '账号登录', '登录并投递', '登录后投递', '扫码登录', '短信登录', '登录无忧', '登录后可'].forEach((k) => {
    if (text.includes(k)) console.log(`  未登录标记命中: ${k}`);
  });
})();
