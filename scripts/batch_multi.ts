/* 多平台「同时」批量投递
 * 用法: node scripts/batch_multi.ts <platforms,逗号分隔> [limit] [intervalMs]
 * 例:   node scripts/batch_multi.ts boss,job51,liepin,zhilian 50 10000
 *
 * 原理：为每个平台并发发起独立的 /api/apply/batch（stream 模式）。
 * 每个 platform 在 CDP 里有各自独立的 tab 会话（ensureSession 按 platform 建/复用 tab），
 * 因此多平台可真正并行；前提是 Chrome 启动时带节流禁用 flag（见 scripts/start_cdp_chrome.sh），
 * 否则非活动 tab 会被降频，导致 waitForSelector 超时。
 */
import { getProfile, saveProfile } from '../server/db.ts';
import fs from 'fs';

const ROOT = 'C:/Users/吉学静/WorkBuddy/2026-09-02-09-33-33/job-apply-agent';
const RESUME = ROOT + '/data/resume_source.pdf';

const platforms = (process.argv[2] || 'boss').split(',').map((s) => s.trim()).filter(Boolean);
const limit = Number(process.argv[3] || 50);
const intervalMs = Number(process.argv[4] || 10000);

async function runOne(platform: string) {
  const body = JSON.stringify({
    platform,
    source: platform,
    limit,
    intervalMs,
    criteria: { excludeApplied: true },
    stream: true,
  });
  const r = await fetch('http://127.0.0.1:4400/api/apply/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!r.body) return { platform, summary: null, error: `HTTP ${r.status}` };
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let summary: any = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dl = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (!dl) continue;
      try {
        const ev = JSON.parse(dl.slice(6));
        const ts = new Date().toISOString().slice(11, 19);
        if (ev.type === 'progress') console.log(`[${ts}][${platform}] ▶ ${ev.index + 1}/${ev.total} ${ev.company || ''} - ${ev.position || ''}`);
        else if (ev.type === 'result') console.log(`[${ts}][${platform}] ✓ ${ev.status} ${(ev.message || '').slice(0, 60)}`);
        else if (ev.type === 'need_input') console.log(`[${ts}][${platform}] ⚠ ${ev.inputType} ${(ev.message || '').slice(0, 80)}`);
        else if (ev.type === 'done') { summary = ev.summary; console.log(`[${ts}][${platform}] === DONE: ${ev.summary.message} ===`); }
      } catch { /* ignore */ }
    }
  }
  return { platform, summary };
}

async function main() {
  const profile = getProfile() as Record<string, unknown>;
  if (!profile.resume_path || !fs.existsSync(String(profile.resume_path))) {
    profile.resume_path = RESUME;
    saveProfile(profile);
    console.log('已补全 resume_path =', RESUME);
  }
  console.log(`>>> 并发投递平台: ${platforms.join(', ')} | limit=${limit} intervalMs=${intervalMs}`);
  const results = await Promise.allSettled(platforms.map((p) => runOne(p)));
  console.log('\n=== 汇总 ===');
  let totalApplied = 0;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      const { platform, summary, error } = r.value as any;
      if (summary) {
        totalApplied += summary.applied || 0;
        console.log(`${platform}: 成功 ${summary.applied}/${summary.total} 需人工 ${summary.needManual} 需验证码 ${summary.needCaptcha} 失败 ${summary.error} 跳过 ${summary.skipped}`);
      } else console.log(`${platform}: 无汇总 ${error || ''}`);
    } else {
      console.log(`${platforms[i]}: 请求失败 ${r.reason}`);
    }
  });
  console.log(`合计成功投递 ${totalApplied} 个岗位`);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
