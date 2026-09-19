/**
 * 把「列表页卡片摘要」从 jobs.jd 迁出到 jobs.card_text（阶段 0.1 止损）
 * ============================================================
 * 背景：offerbiu 采集器曾把列表页卡片 innerText 整批写进 jd，
 *   形如「中大咨询集团 更新 9月2日 博士顾问… 2027届 尽快投递 秋招 需要笔试 投递入口」
 * 它有 80~120 字、能通过所有"JD 非空"检查，却导致：
 *   · 「JD 覆盖率 89%」是虚高数字（真实只有 26%）
 *   · 匹配分由卡片摘要算出 → 无意义
 *   · 求职信 / 定制简历 / 面试攻略拿到它只会产出垃圾
 *
 * 本脚本：jd → card_text，jd 置空，并把由假 JD 算出的 match_score/match_detail 一并清零
 * （留着就是脏数据，会让漏斗继续虚高）。
 *
 * 用法：
 *   tsx scripts/fix_card_jd.ts              # dry-run，只预览
 *   tsx scripts/fix_card_jd.ts --apply      # 执行（自动备份 DB）
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { isCardSummaryJd } from '../server/db.js';

const DB_PATH = path.resolve('data/chat.db');
const APPLY = process.argv.includes('--apply');

const db = new Database(DB_PATH);

const rows = db.prepare(`
  SELECT id, source, company, position, jd
  FROM jobs
  WHERE jd IS NOT NULL AND TRIM(jd) <> ''
  ORDER BY source, company
`).all() as Array<{ id: string; source: string; company: string | null; position: string | null; jd: string }>;

const hits = rows.filter((r) => isCardSummaryJd(r.jd));

console.log('══════ 卡片摘要迁移（jd → card_text）══════');
console.log(`  扫描岗位            ${rows.length}`);
console.log(`  判定为卡片摘要      ${hits.length}`);
console.log(`  模式                ${APPLY ? '执行（--apply）' : '预览（dry-run，加 --apply 才写库）'}`);
console.log();

const bySource: Record<string, number> = {};
for (const h of hits) bySource[h.source] = (bySource[h.source] || 0) + 1;
console.log('  按来源分布：');
Object.entries(bySource).sort((a, b) => b[1] - a[1])
  .forEach(([s, n]) => console.log(`    ${s.padEnd(10)} ${n}`));

console.log('\n  样例（前 5 条）：');
for (const h of hits.slice(0, 5)) {
  console.log(`    [${h.source}] ${h.company || '?'} · ${(h.position || '?').slice(0, 24)}`);
  console.log(`      jd → ${h.jd.slice(0, 80).replace(/\s+/g, ' ')}…`);
}

if (!APPLY) {
  console.log('\n  ⚠️ 这是预览。确认无误后加 --apply 执行（会先自动备份 data/chat.db）。');
  db.close();
  process.exit(0);
}

// ---- 执行：先备份 ----
const bak = `${DB_PATH}.bak-${Date.now()}`;
fs.copyFileSync(DB_PATH, bak);
console.log(`\n  已备份 → ${path.basename(bak)}`);

const now = new Date().toISOString();
const upd = db.prepare(`
  UPDATE jobs
  SET card_text = ?, jd = NULL, match_score = NULL, match_detail = NULL, updated_at = ?
  WHERE id = ?
`);
let n = 0;
const tx = db.transaction((list: typeof hits) => {
  for (const h of list) { upd.run(h.jd, now, h.id); n++; }
});
tx(hits);

// 第二步：清零「无 JD 岗位」的陈旧匹配分。
// 2026-09-19 起取消了职位名兜底打分，但历史库里还留着由兜底算出的分数
// （实测 high 209 里有 38 个属于无 JD 岗位）—— 留着会让看板继续虚高。
const stale = db.prepare(`
  SELECT id, match_score FROM jobs
  WHERE match_score IS NOT NULL AND (jd IS NULL OR TRIM(jd)='')
`).all() as Array<{ id: string; match_score: number }>;
const clearStmt = db.prepare("UPDATE jobs SET match_score = NULL, match_detail = NULL, updated_at = ? WHERE id = ?");
const tx2 = db.transaction((list: typeof stale) => {
  for (const s of list) clearStmt.run(now, s.id);
});
tx2(stale);

console.log(`\n══════ 执行结果 ══════`);
console.log(`  已迁移 ${n} 条（jd → card_text，并清空由假 JD 算出的匹配分）`);
console.log(`  已清零 ${stale.length} 条无 JD 岗位的陈旧匹配分（此前由"职位名兜底"算出，该兜底已取消）`);

const q = (sql: string) => (db.prepare(sql).get() as any).c;
console.log('\n  执行后核对：');
console.log(`    card_text 非空        ${q("SELECT COUNT(*) c FROM jobs WHERE card_text IS NOT NULL AND TRIM(card_text)<>''")}`);
console.log(`    jd 非空               ${q("SELECT COUNT(*) c FROM jobs WHERE jd IS NOT NULL AND TRIM(jd)<>''")}`);
console.log(`    jd 里仍是卡片摘要     ${hits.length ? (db.prepare("SELECT COUNT(*) c FROM jobs WHERE jd IS NOT NULL AND (jd LIKE '%投递入口%' OR jd LIKE '%尽快投递%' OR jd LIKE '%更新 %月%日%')").get() as any).c : 0}`);
console.log(`    有匹配分的岗位        ${q('SELECT COUNT(*) c FROM jobs WHERE match_score IS NOT NULL')}`);
console.log(`    岗位总数              ${q('SELECT COUNT(*) c FROM jobs')}`);

db.close();
