/**
 * Offerbiu 邮箱直投「一轮」编排脚本（scan -> persist -> deliver）。
 * 复用后端已有 SSE 端点：/api/offerbiu/scan-emails 与 /api/offerbiu/email-apply，
 * 因此投递/发信/写「已发送」的全部逻辑与控制台完全一致，不重复实现。
 *
 * 流程：
 *  1) 分页扫描全部 offerbiu 岗位（limit=200/页，workers=4 并发），聚合 found 命中；
 *  2) 落盘 data/offerbiu_round_candidates.json（防止中途断网要重扫）；
 *  3) 过滤掉已投递（jobs.status='applied'）的岗位；
 *  4) 分批（每批 50）调用 email-apply 真实投递，落盘 data/offerbiu_round_results.json。
 *
 * 用法：tsx scripts/offerbiu_email_round.ts [--scan-only] [--skip-scan] [--batch=50] [--interval=8000]
 *   --scan-only  只扫描并落盘候选，不投递（先看全池邮箱规模，再决定是否投递）。
 *   --skip-scan  直接读已有 candidates.json 进入投递阶段（断点续投）。
 *   --candidates=<path>  指定候选 JSON（覆盖默认 candidates 文件，用于只投人工筛选过的子集）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dir, '..');
const DATA = path.join(ROOT, 'data');
const CAND = path.join(DATA, 'offerbiu_round_candidates.json');
const RES = path.join(DATA, 'offerbiu_round_results.json');
const BASE = 'http://127.0.0.1:4400';

const args = process.argv.slice(2);
const skipScan = args.includes('--skip-scan');
const scanOnly = args.includes('--scan-only');
const candPath = args.find((a) => a.startsWith('--candidates='))?.split('=')[1] ?? CAND;
const batchSize = Number(args.find((a) => a.startsWith('--batch='))?.split('=')[1] ?? 50);
const intervalMs = Number(args.find((a) => a.startsWith('--interval='))?.split('=')[1] ?? 8000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function postSSE(pathname: string, body: any): Promise<any[]> {
  const resp = await fetch(BASE + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok || !resp.body) throw new Error(`SSE ${pathname} -> ${resp.status}`);
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events: any[] = [];
  let found: any = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const m = chunk.match(/^data: (.*)$/m);
      if (m) {
        try {
          const ev = JSON.parse(m[1]);
          events.push(ev);
          if (ev.type === 'found') found = ev;
          else if (ev.type === 'progress' || ev.type === 'result') {
            const tag = ev.type === 'found' ? '' : `[${ev.type}] ${ev.company || ev.message || ''}`;
            if (tag) process.stdout.write(tag.slice(0, 120) + '\n');
          }
        } catch { /* ignore */ }
      }
    }
  }
  // 返回全部事件：扫描时取 type==='found' 的 found；投递时直接遍历 result/done。
  return events;
}

/** 从事件数组里取扫描命中清单（type==='found'.found） */
function extractFound(events: any[]): any[] {
  const f = events.find((e) => e?.type === 'found');
  return f?.found ?? [];
}

async function getAppliedOfferbiuIds(): Promise<Set<string>> {
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(path.join(DATA, 'chat.db'), { readonly: true });
  const rows = db
    .prepare("select id from jobs where source='offerbiu' and status='applied'")
    .all() as { id: string }[];
  db.close();
  return new Set(rows.map((r) => r.id));
}

async function main() {
  let candidates: any[] = [];

  if (!skipScan) {
    console.log('=== PHASE 1: 扫描全池（分页 + 并发）===');
    const offsets = [0, 200, 400, 600, 800];
    const seen = new Set<string>();
    for (const offset of offsets) {
      console.log(`-- scan offset=${offset} --`);
      const evs = await postSSE('/api/offerbiu/scan-emails', {
        limit: 200,
        offset,
        workers: 4,
        settleMs: 1200,
        hrLikeOnly: true,
      });
      const found = extractFound(evs);
      for (const h of found as any[]) {
        if (!seen.has(h.jobId)) {
          seen.add(h.jobId);
          candidates.push(h);
        }
      }
      console.log(`   本页命中 ${found.length}，累计 ${candidates.length}`);
      await sleep(300);
    }
    fs.writeFileSync(CAND, JSON.stringify(candidates, null, 2), 'utf-8');
    console.log(`✓ 候选落盘 ${CAND}（共 ${candidates.length} 个邮箱命中）`);
  } else {
    candidates = JSON.parse(fs.readFileSync(candPath, 'utf-8'));
    console.log(`=== 跳过扫描，读候选 ${candidates.length} 个（${candPath}）===`);
  }

  const applied = await getAppliedOfferbiuIds();
  const todo = candidates.filter((h) => !applied.has(h.jobId));
  console.log(`已投递过滤：候选 ${candidates.length} -> 待投 ${todo.length}（已投 ${candidates.length - todo.length}）`);

  if (scanOnly) {
    console.log(`\n=== 仅扫描模式：已落盘候选 ${candidates.length} 个（待投 ${todo.length}），不投递。===`);
    return;
  }

  const results: any[] = [];
  let ok = 0, fail = 0;
  // 把候选里的已核验邮箱映射成 jobId -> email，投递时直接传给后端，跳过微信重抽
  const emailMap: Record<string, string> = {};
  for (const h of todo) if (h.email) emailMap[h.jobId] = h.email;
  for (let i = 0; i < todo.length; i += batchSize) {
    const batch = todo.slice(i, i + batchSize);
    const ids = batch.map((h) => h.jobId);
    console.log(`\n=== PHASE 2: 投递批次 ${Math.floor(i / batchSize) + 1} (${ids.length} 个) ===`);
    const evs = await postSSE('/api/offerbiu/email-apply', {
      jobIds: ids,
      emails: emailMap,
      intervalMs,
    });
    for (const ev of evs) {
      if (ev.type === 'result') {
        results.push(ev);
        if (ev.status === 'applied') ok++;
        else fail++;
        console.log(`   [${ev.status}] ${ev.company || ''} ${ev.message || ''}`);
      }
    }
    fs.writeFileSync(RES, JSON.stringify({ ok, fail, total: todo.length, results }, null, 2), 'utf-8');
  }

  console.log(`\n=== 本轮完成：成功 ${ok}，失败 ${fail}，共 ${todo.length} ===`);
  console.log(`结果落盘 ${RES}`);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
