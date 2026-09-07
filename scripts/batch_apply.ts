/* 批量投递 50 个智联软件岗：先补 resume_path，再以 stream 模式调用 /api/apply/batch */
import { getProfile, saveProfile } from '../server/db.ts';
import fs from 'fs';

const ROOT = 'C:/Users/吉学静/WorkBuddy/2026-09-02-09-33-33/job-apply-agent';
const RESUME = ROOT + '/data/resume_source.pdf';

async function main() {
  const profile = getProfile() as Record<string, unknown>;
  console.log('BEFORE email=', profile.email, 'resume_path=', profile.resume_path);
  if (!profile.resume_path || !fs.existsSync(String(profile.resume_path))) {
    profile.resume_path = RESUME;
    saveProfile(profile);
    console.log('SET resume_path=', RESUME);
  }

  const body = JSON.stringify({
    platform: 'zhilian',
    source: 'zhilian',
    limit: 50,
    intervalMs: 10000,
    criteria: { excludeApplied: true },
    stream: true,
  });

  console.log('>>> 发起批量投递 /api/apply/batch limit=50 intervalMs=10000');
  const r = await fetch('http://127.0.0.1:4400/api/apply/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!r.body) { console.log('NO BODY', r.status); return; }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let done = false;
  while (!done) {
    const { value, done: d } = await reader.read();
    if (d) break;
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
          if (ev.type === 'progress') console.log(`[${ts}] ▶ ${ev.index + 1}/${ev.total} ${ev.company} - ${ev.position} (${ev.platform})`);
          else if (ev.type === 'result') console.log(`[${ts}] ✓ ${ev.status} ${ev.jobId} ${ev.message?.slice(0, 80)}`);
          else if (ev.type === 'need_input') console.log(`[${ts}] ⚠ need_input(${ev.inputType}) ${ev.company} ${ev.message?.slice(0, 100)}`);
          else if (ev.type === 'done') console.log(`[${ts}] === DONE: ${ev.summary.message} ===`);
          else console.log(`[${ts}] ${ev.type}:`, JSON.stringify(ev).slice(0, 160));
        } catch { /* ignore */ }
      }
    }
  }
  console.log('<<< 批量投递流结束');
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
