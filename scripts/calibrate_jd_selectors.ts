/**
 * 探测各平台「岗位详情页」的 JD 选择器（用于校准 backfill_jd.ts）
 * 用法：./node/node.exe node_modules/tsx/dist/cli.mjs scripts/calibrate_jd_selectors.ts [platform]
 *   platform 可省略（默认全部），或其一：job51 / zhilian / liepin / boss
 * 说明：会逐平台导航到该平台「第一个缺 JD 的岗位」详情页并打印候选选择器的文本长度，
 *      便于把命中的选择器写回 backfill_jd.ts 的 JD_SELECTOR。（只读，不改数据）
 */
import * as db from '../server/db.js';
import { ex } from './lib/browser.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 候选选择器（宽松集合，命中即为可用） */
const CANDS: Record<string, string[]> = {
  boss: ['.job-sec-text', '.job-detail-section', '[class*=job-sec]', '.job-detail'],
  job51: ['.bmsg.job_msg', '.job_msg', '.job-detail-section', '[class*=job_msg]', '.tCompany_main', '[class*=job-detail]'],
  zhilian: ['[class*=describtion]', '[class*=job-description]', '.describtion__detail-content', '[class*=detail-content]', '[class*=job-detail]'],
  liepin: ['[class*=job-intro-container]', '.paragraph', '[class*=job-detail]', '[class*=intro]', '[class*=content]'],
};

const only = process.argv[2];
const platforms = (only ? [only] : Object.keys(CANDS));

for (const p of platforms) {
  const job: any = db.listJobs({ source: p })
    .find((j: any) => (!j.jd || !String(j.jd).trim()) && j.apply_url);
  if (!job) { console.log(`=== ${p}：没有「缺 JD 且有直链」的岗位，跳过 ===`); continue; }
  const sels = CANDS[p];
  try {
    const nav: any = await ex(p, { action: 'navigate', url: job.apply_url, waitUntil: 'domcontentloaded' });
    await sleep(5000);
    const script = `(${JSON.stringify(sels)}).map(s => {
      const e = document.querySelector(s);
      return s + ' => ' + (e ? ('len=' + ((e.innerText||'').length) + ' | ' + (e.innerText||'').replace(/\\s+/g,' ').slice(0,55)) : 'null');
    })`;
    const r: any = await ex(p, { action: 'eval', script });
    console.log(`\n=== ${p} (nav.ok=${nav?.ok})  ${job.company || ''} — ${job.position || ''}`);
    console.log(`    ${job.apply_url}`);
    for (const line of (r?.data || [])) console.log('    ' + line);
  } catch (e: any) {
    console.log(`\n=== ${p} 探测失败: ${e?.message || e}`);
  }
}
