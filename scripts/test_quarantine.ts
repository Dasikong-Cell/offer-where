/**
 * 端到端自检：offerbiu 邮箱直投的「跨公司串号隔离」闸门。
 *
 * 流程：造一个带 quarantine 标记、且 apply_url 指向无效域的合成岗位 →
 *   ① 不带 force 调 /api/offerbiu/email-apply → 期望收到 status='skipped'（未发信）
 *   ② 带 force=true 再调 → 期望不再被 skip（进入执行，因无效域而失败，但证明闸门可被强制放行）
 * 结束后删除合成岗位，不触碰任何真实数据。
 *
 * 运行：./node/node.exe node_modules/tsx/dist/cli.mjs scripts/test_quarantine.ts
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, '..', 'data', 'chat.db'));
const API = process.env.API_BASE || 'http://127.0.0.1:4400';

const id = 'qtest-' + randomUUID().slice(0, 8);
const now = new Date().toISOString();

db.prepare(`INSERT INTO jobs (id, source, company, position, city, jd, apply_url, quarantine, status, created_at, updated_at)
  VALUES (?, 'offerbiu', ?, ?, ?, ?, ?, ?, 'candidate', ?, ?)`)
  .run(id, 'QUARANTINE_TEST_CO', '隔离闸门自检岗', '测试', 'test', 'https://example.invalid/nope',
    'cross-company: 邮箱域 test-a.com ≠ 岗位域 test-b.com', now, now);
console.log('create job:', id);

/** 调 email-apply 并把 SSE 事件收齐 */
async function callApply(force: boolean) {
  const res = await fetch(`${API}/api/offerbiu/email-apply`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobIds: [id], intervalMs: 0, force }),
  });
  const text = await res.text();
  const events: any[] = [];
  for (const block of text.split('\n\n')) {
    for (const line of block.split('\n')) {
      if (line.startsWith('data: ')) { try { events.push(JSON.parse(line.slice(6))); } catch { /* ignore */ } }
    }
  }
  return events;
}

try {
  const noForce = await callApply(false);
  const skipped = noForce.find((e) => e.type === 'result' && e.status === 'skipped');
  console.log('[no-force] result:', JSON.stringify(noForce.filter((e) => e.type === 'result' || e.type === 'done')));

  const withForce = await callApply(true);
  const skippedForced = withForce.find((e) => e.type === 'result' && e.status === 'skipped');
  console.log('[force]    result:', JSON.stringify(withForce.filter((e) => e.type === 'result' || e.type === 'done')));

  const pass1 = !!skipped;
  const pass2 = !skippedForced;
  console.log('\n=== 自检结论 ===');
  console.log(`① 无 force → 被 skip：${pass1 ? 'PASS' : 'FAIL'} (${skipped?.message || '无 skipped 事件'})`);
  console.log(`② 带 force → 放行（不再 skip）：${pass2 ? 'PASS' : 'FAIL'}`);
  console.log(`总体：${pass1 && pass2 ? 'PASS ✅' : 'FAIL ❌'}`);
} finally {
  const n = db.prepare('DELETE FROM jobs WHERE id = ?').run(id).changes;
  console.log('cleanup deleted =', n);
  db.close();
}
