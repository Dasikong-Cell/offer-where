/**
 * 岗位历史数据修复（测评问题清单 P1-1 / P2-1 / P2-4）
 * ==========================================================================
 * 修复 2026-09-19 测评发现的三类脏数据：
 *   ① position/company 被 BOSS 加密字体污染（如 `"Java\n-K"`）→ 用与写库口同一套 sanitizeJobText 清洗
 *   ② company 为空（BOSS 154 条）→ 用 apply_url ↔ applications.job_url 反查回填（无需爬页面）
 *   ③ 重复岗位 → 同「来源+公司+职位」组内只保留信息最全的一条
 *   ④ 空 apply_url 的 candidate 岗位 → 标记 unavailable（投不了，不该占候选席位）
 *
 * ⚠️ 安全设计：
 *   · **默认 dry-run**，只打印将要做的改动，不写库；加 `--apply` 才真正执行
 *   · `--apply` 时**自动备份** chat.db 到 data/chat.db.bak-<时间戳>
 *   · 不删除 status='applied' 且有直链的记录（那是投递历史事实，事实来源是 applications 表）
 *
 * 用法：
 *   ./node/node.exe node_modules/tsx/dist/cli.mjs scripts/fix_job_data.ts            # 预览
 *   ./node/node.exe node_modules/tsx/dist/cli.mjs scripts/fix_job_data.ts --apply    # 执行
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { sanitizeJobText, sanitizeSalary, sanitizePosition, sanitizeCompany } from '../server/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'chat.db');
const APPLY = process.argv.includes('--apply');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

interface Row { id: string; source: string; company: string | null; position: string | null; city: string | null; salary: string | null; apply_url: string | null; jd: string | null; status: string; created_at: string }

const rows = db.prepare('SELECT * FROM jobs').all() as Row[];
console.log(`模式：${APPLY ? '⚠️  APPLY（会写库）' : 'dry-run（只预览）'} ｜ 岗位总数 ${rows.length}\n`);

const changes: Array<{ id: string; kind: string; before: string; after: string }> = [];

// ── ① 文本字段清洗 ───────────────────────────────────────────
const sanitized: Array<{ id: string; patch: Partial<Row> }> = [];
for (const r of rows) {
  const patch: Partial<Row> = {};
  const co = sanitizeCompany(r.company);
  const pos = sanitizePosition(r.position);
  const city = sanitizeJobText(r.city, 30);
  const sal = sanitizeSalary(r.salary);   // 薪资用专用清洗（不能剥离自身）
  if (co !== r.company) patch.company = co as any;
  if (pos !== r.position) patch.position = pos as any;
  if (city !== r.city) patch.city = city as any;
  if (sal !== r.salary) patch.salary = sal as any;
  if (Object.keys(patch).length) {
    sanitized.push({ id: r.id, patch });
    for (const k of Object.keys(patch)) {
      changes.push({ id: r.id, kind: `清洗 ${k}`, before: JSON.stringify((r as any)[k]), after: JSON.stringify((patch as any)[k]) });
    }
  }
}
console.log(`① 文本字段清洗：${sanitized.length} 条记录需修（共 ${changes.length} 处字段）`);
for (const c of changes.slice(0, 6)) console.log(`     ${c.kind}：${c.before} → ${c.after}`);
if (changes.length > 6) console.log(`     …（其余 ${changes.length - 6} 处略）`);

// ── ② company 回填（apply_url ↔ applications.job_url）─────────
const fillable = db.prepare(`
  SELECT j.id, j.position, a.company AS co
  FROM jobs j JOIN applications a ON a.job_url = j.apply_url
  WHERE (j.company IS NULL OR TRIM(j.company) = '')
    AND a.company IS NOT NULL AND TRIM(a.company) <> ''
`).all() as Array<{ id: string; position: string | null; co: string }>;
console.log(`\n② company 回填：可按 apply_url 反查回填 ${fillable.length} 条`);
for (const f of fillable.slice(0, 5)) console.log(`     ${f.position || '(无职位)'} → 「${f.co}」`);
if (fillable.length > 5) console.log(`     …（其余 ${fillable.length - 5} 条略）`);

// ── ③ 重复岗位合并（安全规则：宁可漏删，不可误删）──────────────
//  · 绝不动 `status='applied'` 且有公司或职位的行 —— 那是投递历史，事实来源是 applications 表
//  · **不同 apply_url 的两行 = 两个不同岗位**（同公司同名岗位可能招多次），绝不合并
//  · 只清理三类：纯空壳（公司/职位/直链全空）、同一直链的重复、无直链且组内已有直链的残次行
const STATUS_RANK: Record<string, number> = { applied: 3, unavailable: 2, candidate: 1 };
const score = (r: Row) => (r.apply_url?.trim() ? 100 : 0) + (r.jd?.trim() ? 50 : 0) + (STATUS_RANK[r.status] || 0);
const isProtected = (r: Row) => r.status === 'applied' && Boolean(r.company?.trim() || r.position?.trim());

const toDelete = new Map<string, string>(); // id -> 原因
const addDel = (id: string, why: string) => { if (!toDelete.has(id)) toDelete.set(id, why); };

// 纯空壳：无任何信息价值（实测 35 条，投不了也搜不到）
const shells = rows.filter((r) => !r.company?.trim() && !r.position?.trim() && !r.apply_url?.trim());
for (const s of shells) addDel(s.id, '空壳记录（公司/职位/直链全空）');

// ⚠️ 关键顺序：重复组必须基于「清洗 + 公司回填**之后**的投影值」计算。
// 用清洗前的原始值算会漏掉「清洗后才变成同名」的一组（实测漏了 52 组：11 → 63）。
const backfillMap = new Map(fillable.map((f) => [f.id, sanitizeJobText(f.co, 60) || '']));
const projCompany = (r: Row): string => {
  const bf = backfillMap.get(r.id);
  return bf !== undefined ? bf : (sanitizeCompany(r.company) || '');
};
const projPosition = (r: Row): string => sanitizePosition(r.position) || '';

const grouped = new Map<string, Row[]>();
for (const r of rows) {
  const key = `${r.source}\u0000${projCompany(r)}\u0000${projPosition(r)}`;
  const arr = grouped.get(key);
  if (arr) arr.push(r); else grouped.set(key, [r]);
}
const dupGroups = [...grouped.values()].filter((g) => g.length > 1);

for (const group of dupGroups) {
  const byUrl = new Map<string, Row>();   // 每个不同直链保留一条
  const noUrl: Row[] = [];
  for (const r of group) {
    const u = r.apply_url?.trim();
    if (!u) { noUrl.push(r); continue; }
    const cur = byUrl.get(u);
    if (!cur) { byUrl.set(u, r); continue; }
    const [better, worse] = score(r) > score(cur) ? [r, cur] : [cur, r];
    byUrl.set(u, better);
    if (!isProtected(worse)) addDel(worse.id, `同一直链重复（保留 ${better.id.slice(0, 8)}）`);
  }

  if (byUrl.size) {
    // 组内已有带直链的记录 → 无直链的残次行清理（受保护的 applied 行除外）
    const keeper = [...byUrl.values()][0];
    for (const r of noUrl) if (!isProtected(r)) addDel(r.id, `无直链的同名重复（组内已有直链 ${keeper.id.slice(0, 8)}）`);
  } else {
    // 全组都无直链 → 只留分最高的一条（受保护的 applied 行全留）
    const ranked = [...noUrl].sort((a, b) => score(b) - score(a) || String(a.created_at).localeCompare(String(b.created_at)));
    let kept = 0;
    for (const r of ranked) {
      if (isProtected(r)) continue;
      if (kept++ === 0) continue;
      addDel(r.id, `无直链同名重复（保留 ${ranked[0].id.slice(0, 8)}）`);
    }
  }
}

// ── ⑤ 同一投递入口去重（跨「公司/职位」组）────────────────────
// ⚠️ **绝不能一刀切**：offerbiu 的 apply_url 常是「公司级投递入口」（如 career.huawei.com），
// 多个不同部门/岗位共用它 —— 那不是重复（实测 offerbiu 46 组全是这种）。
// 判据：组内 **position 是否唯一**。唯一才是「同一个岗位被采了多次」。
// 之所以单列一步：③ 的组键是「来源+公司+职位」，跨组同 URL 的重复它看不见；
// 且 ③ 为保投递历史把 applied 行全部豁免，而同 URL 同职位的重复行即使 applied 也应当合并
// （真实投递事实保存在 applications 表，不受影响）。
const MERGE_STATUS_RANK: Record<string, number> = { applied: 3, candidate: 2, unavailable: 1 };
const richness = (r: Row) =>
  (r.company?.trim() ? 8 : 0) + (r.jd?.trim() ? 4 : 0) + (r.salary?.trim() ? 2 : 0) + (r.city?.trim() ? 1 : 0);

const urlGroups = db.prepare(`
  SELECT source, apply_url, COUNT(*) n, COUNT(DISTINCT COALESCE(position,'')) posN
  FROM jobs WHERE apply_url IS NOT NULL AND TRIM(apply_url) <> ''
  GROUP BY source, apply_url HAVING COUNT(*) > 1
`).all() as Array<{ source: string; apply_url: string; n: number; posN: number }>;

interface MergePlan { delId: string; keepId: string; patch: Record<string, string>; why: string }
const mergePlans: MergePlan[] = [];
let skippedSharedEntry = 0;
for (const g of urlGroups) {
  if (g.posN > 1) { skippedSharedEntry++; continue; }  // 多个不同岗位共用同一入口 → 不是重复
  const group = db.prepare('SELECT * FROM jobs WHERE source = ? AND apply_url = ?').all(g.source, g.apply_url) as Row[];
  const keep = [...group].sort((a, b) =>
    richness(b) - richness(a) || String(a.created_at).localeCompare(String(b.created_at)))[0];
  // 状态取「最靠前」的：applied > candidate > unavailable（同一岗位只要投过就算 applied）
  const bestStatus = group.reduce((acc, r) =>
    (MERGE_STATUS_RANK[r.status] || 0) > (MERGE_STATUS_RANK[acc] || 0) ? r.status : acc, keep.status);
  const patch: Record<string, string> = {};
  if (bestStatus !== keep.status) patch.status = bestStatus;
  for (const r of group) {
    if (r.id === keep.id) continue;
    if (!keep.company?.trim() && r.company?.trim()) patch.company = r.company;
    if (!patch.jd && !keep.jd?.trim() && r.jd?.trim()) patch.jd = r.jd;
    if (!patch.salary && !keep.salary?.trim() && r.salary?.trim()) patch.salary = r.salary;
    if (!patch.city && !keep.city?.trim() && r.city?.trim()) patch.city = r.city;
    mergePlans.push({ delId: r.id, keepId: keep.id, patch, why: `同一投递入口重复（保留 ${keep.id.slice(0, 8)}）` });
  }
}
for (const m of mergePlans) addDel(m.delId, m.why);

console.log(`\n⑤ 同一投递入口去重：${urlGroups.length} 个 URL 组`);
console.log(`     跳过 ${skippedSharedEntry} 组（组内职位不同 = 多岗位共用公司投递入口，不是重复）`);
console.log(`     合并 ${mergePlans.length} 条重复行 → 保留 ${urlGroups.length - skippedSharedEntry} 条`);

const delList = [...toDelete.entries()].map(([id, why]) => ({ id, why }));
const protectedCount = dupGroups.length ? rows.filter((r) => isProtected(r)).length : 0;
console.log(`\n③ 重复/空壳清理：${dupGroups.length} 个同名组，计划删除 ${delList.length} 条`);
console.log(`     （受保护：${protectedCount} 条 status='applied' 且有公司/职位的记录不会被删）`);
console.log(`     其中空壳记录 ${shells.length} 条；不同直链的岗位视为不同岗位，不合并`);
for (const d of delList.slice(0, 5)) console.log(`     删 ${d.id.slice(0, 8)} — ${d.why}`);
if (delList.length > 5) console.log(`     …（其余 ${delList.length - 5} 条略）`);

// ── ④ 空 apply_url 的 candidate 标记 unavailable ──────────────
const deadCandidates = rows.filter((r) => r.status === 'candidate' && !r.apply_url?.trim());
console.log(`\n④ 空直链的候选岗位：${deadCandidates.length} 条 → 标记为 unavailable（投不了，不该占候选席位）`);
for (const d of deadCandidates) console.log(`     ${d.position || '(无职位)'}`);

// ── 执行 ────────────────────────────────────────────────────
if (!APPLY) {
  console.log('\n（dry-run 结束，未写库。加 --apply 执行）');
  process.exit(0);
}

if (!sanitized.length && !fillable.length && !delList.length && !deadCandidates.length) {
  console.log('\n没有需要修复的数据 ✅');
  process.exit(0);
}

const bak = `${DB_PATH}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
fs.copyFileSync(DB_PATH, bak);
console.log(`\n💾 已备份数据库 → ${path.relative(path.join(__dirname, '..'), bak)}`);

const run = db.transaction(() => {
  let n = 0;
  const setStmt = db.prepare("UPDATE jobs SET company=?, position=?, city=?, salary=?, updated_at=? WHERE id=?");
  const now = new Date().toISOString();
  for (const s of sanitized) {
    const r = rows.find((x) => x.id === s.id)!;
    setStmt.run(
      s.patch.company !== undefined ? s.patch.company : r.company,
      s.patch.position !== undefined ? s.patch.position : r.position,
      s.patch.city !== undefined ? s.patch.city : r.city,
      s.patch.salary !== undefined ? s.patch.salary : r.salary,
      now, s.id,
    );
    n++;
  }
  console.log(`   ① 清洗 ${n} 条`);

  let m = 0;
  const coStmt = db.prepare("UPDATE jobs SET company=?, updated_at=? WHERE id=?");
  for (const f of fillable) { coStmt.run(sanitizeCompany(f.co), now, f.id); m++; }
  console.log(`   ② company 回填 ${m} 条`);

  // ⑤ 同入口合并：先把「被删行独有的信息 + 最靠前的状态」并入保留行，再删除重复行
  // （顺序很重要：先合并再删除，否则会丢信息）
  let mg = 0;
  const mergeStmt = db.prepare(`UPDATE jobs SET
      company  = COALESCE(?, company),
      position = COALESCE(?, position),
      city     = COALESCE(?, city),
      salary   = COALESCE(?, salary),
      jd       = COALESCE(?, jd),
      status   = COALESCE(?, status),
      updated_at = ?
    WHERE id = ?`);
  for (const m of mergePlans) {
    mg += mergeStmt.run(
      m.patch.company ?? null, m.patch.position ?? null, m.patch.city ?? null,
      m.patch.salary ?? null, m.patch.jd ?? null, m.patch.status ?? null,
      now, m.keepId,
    ).changes;
  }
  console.log(`   ⑤ 同入口合并到保留行 ${mg} 条`);

  let d = 0;
  const delStmt = db.prepare('DELETE FROM jobs WHERE id=?');
  for (const t of delList) d += delStmt.run(t.id).changes;
  console.log(`   ③ 删除重复/空壳 ${d} 条`);

  let u = 0;
  const unStmt = db.prepare("UPDATE jobs SET status='unavailable', updated_at=? WHERE id=?");
  for (const c of deadCandidates) u += unStmt.run(now, c.id).changes;
  console.log(`   ④ 标记 unavailable ${u} 条`);
});
run();

console.log('\n══════ 修复后校验 ══════');
const q = (sql: string) => (db.prepare(sql).get() as any).c as number;
console.log(`  含换行的 position          ${q("SELECT COUNT(*) c FROM jobs WHERE position LIKE '%'||char(10)||'%'")}`);
console.log(`  company 为空的岗位          ${q("SELECT COUNT(*) c FROM jobs WHERE company IS NULL OR TRIM(company)=''")}`);
console.log(`  空 apply_url 的候选岗位      ${q("SELECT COUNT(*) c FROM jobs WHERE status='candidate' AND (apply_url IS NULL OR TRIM(apply_url)='')")}`);
// 真重复 = 同源 + 同直链 + **同职位**（同直链但职位不同，是「多岗位共用公司投递入口」，正常）
console.log(`  真重复（同直链+同职位）      ${q("SELECT COUNT(*) c FROM (SELECT 1 FROM jobs WHERE apply_url IS NOT NULL AND TRIM(apply_url)<>'' GROUP BY source,apply_url,COALESCE(position,'') HAVING COUNT(*)>1)")}`);
console.log(`  共用投递入口的多岗位（正常）  ${q("SELECT COUNT(*) c FROM (SELECT 1 FROM jobs WHERE apply_url IS NOT NULL AND TRIM(apply_url)<>'' GROUP BY source,apply_url HAVING COUNT(*)>1 AND COUNT(DISTINCT COALESCE(position,''))>1)")}`);
console.log(`  同名不同直链（不同岗位）      ${q("SELECT COUNT(*) c FROM (SELECT 1 FROM jobs GROUP BY source,COALESCE(company,''),COALESCE(position,'') HAVING COUNT(*)>1)")}`);
console.log(`  岗位总数                   ${q('SELECT COUNT(*) c FROM jobs')}`);
console.log(`\n如需回滚：把 ${path.basename(bak)} 覆盖回 data/chat.db`);
db.close();
