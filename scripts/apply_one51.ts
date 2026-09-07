/* 单投一个 51job 岗位并打印引擎完整步骤日志，定位「发送验证码」报错来源 */
import { listJobs } from '../server/db.ts';

(async () => {
  const jobs = listJobs({ source: 'job51' }).filter((j) => j.status !== 'applied');
  if (!jobs.length) { console.log('无 job51 待投岗位'); return; }
  const job = jobs[0];
  console.log('测试岗位:', job.position?.slice(0, 40), '|', job.apply_url);

  const r = await fetch('http://127.0.0.1:4400/api/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: 'job51', jobId: job.id, jobUrl: job.apply_url }),
  });
  const d: any = await r.json();
  console.log('\nSTATUS:', d.status);
  console.log('MESSAGE:', d.message);
  console.log('\n--- 步骤日志 ---');
  (d.logs || []).forEach((l: any, i: number) => {
    console.log(`${i + 1}. [${l.ok ? 'OK ' : 'FAIL'}] ${l.step} :: ${(l.detail || l.message || '').slice(0, 120)}`);
  });
})();
