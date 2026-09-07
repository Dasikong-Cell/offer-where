/* 统计各平台岗位存量：总数 / 未投递(candidate) / 已投递 */
import { listJobs } from '../server/db.ts';

const SOURCES = ['zhilian', 'job51', 'liepin', 'boss', 'offerbiu'];
for (const s of SOURCES) {
  const all = listJobs({ source: s });
  const cand = all.filter((j) => j.status !== 'applied');
  const applied = all.filter((j) => j.status === 'applied');
  if (all.length) console.log(`${s}: 总 ${all.length} | 待投 ${cand.length} | 已投 ${applied.length}`);
}
