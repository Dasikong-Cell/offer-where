/**
 * 真实投递测试运行器：对已登录平台调用 /api/apply/batch（SSE 流式），
 * 只投 candidate（excludeApplied）状态的岗位，逐个平台顺序执行并打印事件。
 *
 * 用法:
 *   tsx scripts/run_delivery_test.ts liepin 3 zhilian 5
 *   （每对 "平台 数量"，未指定则默认全投 candidate）
 */
const API = 'http://127.0.0.1:4400';

async function deliveryOne(platform: string, limit: number, intervalMs: number): Promise<void> {
  console.log(`\n########## 投递 ${platform} (limit=${limit}, excludeApplied) ##########`);
  const r = await fetch(`${API}/api/apply/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      platform,
      source: platform,
      limit,
      intervalMs,
      criteria: { excludeApplied: true },
      stream: true,
    }),
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
      if (!dataLine) continue;
      try {
        const ev = JSON.parse(dataLine.slice(6));
        const ts = new Date().toISOString().slice(11, 19);
        if (ev.type === 'progress') console.log(`[${ts}] ▶ ${ev.index + 1}/${ev.total} ${ev.company} - ${ev.position} (${ev.platform})`);
        else if (ev.type === 'result') console.log(`[${ts}] ${ev.status === 'ok' ? '✓' : ev.status === 'skipped' ? '⊘' : '✗'} ${ev.status} ${ev.message || ''}`);
        else if (ev.type === 'need_input') console.log(`[${ts}] ⚠ need_input(${ev.inputType}) ${ev.message || ''}`);
        else if (ev.type === 'done') console.log(`[${ts}] === DONE: ${JSON.stringify(ev.summary)} ===`);
        else if (ev.type === 'error') console.log(`[${ts}] ✗ ERROR ${ev.message || ''}`);
        else console.log(`[${ts}] ${ev.type}`);
      } catch { /* ignore */ }
    }
  }
  console.log(`########## ${platform} 投递结束 ##########`);
}

(async () => {
  const args = process.argv.slice(2);
  const plans: Array<[string, number]> = [];
  for (let i = 0; i < args.length; i += 2) {
    plans.push([args[i], Number(args[i + 1]) || 0]);
  }
  if (!plans.length) {
    console.error('用法: tsx scripts/run_delivery_test.ts <platform> <limit> [...]');
    process.exit(1);
  }
  for (const [platform, limit] of plans) {
    await deliveryOne(platform, limit, 8000);
  }
  console.log('\n[全部投递测试结束]');
  process.exit(0);
})();
