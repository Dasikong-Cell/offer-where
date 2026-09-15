/* 批量投递 BOSS 岗位：调用后端 /api/apply/batch（platform=boss, source=boss）
 * 与 batch_apply.ts 同款流式消费，仅平台/来源/数量可配。
 *
 * 用法：
 *   tsx scripts/apply_boss.ts                默认投递 20 个，间隔 15s
 *   tsx scripts/apply_boss.ts --limit=20 --interval=15000
 *   tsx scripts/apply_boss.ts --limit=5 --interval=20000
 */
import { getProfile, saveProfile } from '../server/db.ts';
import fs from 'fs';

const ROOT = 'C:/Users/吉学静/WorkBuddy/2026-09-02-09-33-33/job-apply-agent';
const RESUME = ROOT + '/data/resume_source.pdf';

const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : 20;
const intervalArg = process.argv.find((a) => a.startsWith('--interval='));
const intervalMs = intervalArg ? Number(intervalArg.split('=')[1]) : 15000;

async function main() {
  const profile = getProfile() as Record<string, unknown>;
  console.log('profile email=', profile.email, 'resume_path=', profile.resume_path);
  if (!profile.resume_path || !fs.existsSync(String(profile.resume_path))) {
    profile.resume_path = RESUME;
    saveProfile(profile);
    console.log('SET resume_path=', RESUME);
  }

  // 目标职位 → 投递筛选关键词（与控制台「目标职位」一致）
  const posRaw = typeof profile.expectedPositions === 'string' ? profile.expectedPositions : '';
  const keywords = posRaw.split(/[,，、;；]+/).map((s: string) => s.trim()).filter(Boolean);
  console.log('目标职位 keywords=', keywords.length ? keywords.join(',') : '(不限)');

  const body = JSON.stringify({
    platform: 'boss',
    source: 'boss',
    limit,
    intervalMs,
    criteria: { excludeApplied: true, ...(keywords.length ? { keywords } : {}) },
    stream: true,
  });

  console.log(`>>> 发起 BOSS 批量投递 /api/apply/batch limit=${limit} intervalMs=${intervalMs}`);
  const r = await fetch('http://127.0.0.1:4400/api/apply/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!r.body) { console.log('NO BODY', r.status); return; }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (dataLine) {
        try {
          const ev = JSON.parse(dataLine.slice(6));
          const ts = new Date().toISOString().slice(11, 19);
          if (ev.type === 'start') console.log(`[${ts}] 开始：${ev.message}`);
          else if (ev.type === 'progress') console.log(`[${ts}] ▶ ${ev.index + 1}/${ev.total} ${ev.company} - ${ev.position} (${ev.platform})`);
          else if (ev.type === 'result') console.log(`[${ts}] ✓ ${ev.status} ${ev.message?.slice(0, 80)}`);
          else if (ev.type === 'need_input') console.log(`[${ts}] ⚠ need_input(${ev.inputType}) ${ev.company} ${ev.message?.slice(0, 100)}`);
          else if (ev.type === 'done') console.log(`[${ts}] === DONE: ${ev.summary.message} ===`);
          else console.log(`[${ts}] ${ev.type}:`, JSON.stringify(ev).slice(0, 160));
        } catch { /* ignore */ }
      }
    }
  }
  console.log('<<< BOSS 批量投递流结束');
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
