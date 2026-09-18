/**
 * 数据库体检报告（只读，不改任何数据）
 * ==========================================================================
 * 输出：表结构与行数、岗位池按来源/状态分布、投递记录分布、匹配分覆盖、
 *      HR 会话（AI 标记）分布、数据质量检查（重复岗位 / 空 JD / 空 apply_url / 隔离数）。
 *
 * 运行：./node/node.exe node_modules/tsx/dist/cli.mjs scripts/db_report.ts
 */
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '..', 'data', 'chat.db');
const db = new Database(dbPath, { readonly: true });

const table = (rows: any[], cols: string[]) => {
  if (!rows.length) return '  (空)';
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (vals: string[]) => '  ' + vals.map((v, i) => v.padEnd(w[i])).join('  ');
  return [line(cols), '  ' + w.map((n) => '─'.repeat(n)).join('  '), ...rows.map((r) => line(cols.map((c) => String(r[c] ?? ''))))].join('\n');
};

console.log('══════ 1. 表与行数 ══════');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
const counts = tables.map((t) => ({ table: t.name, rows: (db.prepare(`SELECT COUNT(*) c FROM "${t.name}"`).get() as any).c }));
console.log(table(counts.sort((a, b) => b.rows - a.rows), ['table', 'rows']));

console.log('\n══════ 2. 岗位池：来源 × 状态 ══════');
console.log(table(
  db.prepare("SELECT source, status, COUNT(*) n FROM jobs GROUP BY source, status ORDER BY source, status").all() as any[],
  ['source', 'status', 'n'],
));

console.log('\n══════ 3. 投递记录：平台分布 ══════');
console.log(table(
  db.prepare("SELECT platform, status, COUNT(*) n FROM applications GROUP BY platform, status ORDER BY n DESC").all() as any[],
  ['platform', 'status', 'n'],
));
const appTotal = (db.prepare('SELECT COUNT(*) c FROM applications').get() as any).c;
const appDays = db.prepare("SELECT substr(created_at,1,10) d, COUNT(*) n FROM applications GROUP BY d ORDER BY d DESC LIMIT 7").all() as any[];
console.log(`\n  近 7 天投递：\n${table(appDays, ['d', 'n'])}`);

console.log('\n══════ 4. 匹配分覆盖 ══════');
const ms = db.prepare(`SELECT
  SUM(CASE WHEN match_score IS NOT NULL THEN 1 ELSE 0 END) scored,
  COUNT(*) total, ROUND(AVG(match_score),1) avg,
  SUM(CASE WHEN match_score>=70 THEN 1 ELSE 0 END) high,
  SUM(CASE WHEN match_score>=40 AND match_score<70 THEN 1 ELSE 0 END) mid,
  SUM(CASE WHEN match_score IS NOT NULL AND match_score<40 THEN 1 ELSE 0 END) low
  FROM jobs`).get() as any;
console.log(`  已评分 ${ms.scored}/${ms.total}（覆盖 ${Math.round((ms.scored / ms.total) * 100)}%）｜ 均值 ${ms.avg} ｜ 高${ms.high} 中${ms.mid} 低${ms.low}`);

console.log('\n══════ 5. HR 会话（自动回复） ══════');
console.log(table(
  db.prepare("SELECT platform, stage, COUNT(*) n FROM hr_conversations GROUP BY platform, stage ORDER BY n DESC LIMIT 15").all() as any[],
  ['platform', 'stage', 'n'],
));
console.log('\n  回复来源（ai_source）：');
console.log(table(db.prepare("SELECT COALESCE(ai_source,'(null)') ai_source, COUNT(*) n FROM hr_conversations GROUP BY ai_source").all() as any[], ['ai_source', 'n']));

console.log('\n══════ 6. 数据质量检查 ══════');
const q = {
  '重复岗位(同源+公司+职位)': (db.prepare("SELECT COUNT(*) c FROM (SELECT 1 FROM jobs GROUP BY source,company,position HAVING COUNT(*)>1)").get() as any).c,
  '空 JD 的岗位': (db.prepare("SELECT COUNT(*) c FROM jobs WHERE jd IS NULL OR TRIM(jd)=''").get() as any).c,
  '空 apply_url 的岗位': (db.prepare("SELECT COUNT(*) c FROM jobs WHERE apply_url IS NULL OR TRIM(apply_url)=''").get() as any).c,
  '已投但无投递记录': (db.prepare("SELECT COUNT(*) c FROM jobs j WHERE j.status='applied' AND NOT EXISTS(SELECT 1 FROM applications a WHERE a.company=j.company AND a.position=j.position)").get() as any).c,
  '已隔离岗位(quarantine)': (db.prepare("SELECT COUNT(*) c FROM jobs WHERE quarantine IS NOT NULL").get() as any).c,
  'applications 无 job_url': (db.prepare("SELECT COUNT(*) c FROM applications WHERE job_url IS NULL OR TRIM(job_url)=''").get() as any).c,
  '岗位仍为 candidate': (db.prepare("SELECT COUNT(*) c FROM jobs WHERE status='candidate'").get() as any).c,
  'DB 文件大小(MB)': Number((fs.statSync(dbPath).size / 1048576).toFixed(1)),
  'WAL 文件(MB)': Number(((fs.existsSync(dbPath + '-wal') ? fs.statSync(dbPath + '-wal').size : 0) / 1048576).toFixed(1)),
};
for (const [k, v] of Object.entries(q)) console.log(`  ${k.padEnd(28)} ${v}`);

console.log('\n══════ 7. 岗位池 JD 长度分布（投递质量相关） ══════');
console.log(table(
  db.prepare(`SELECT CASE
    WHEN jd IS NULL OR TRIM(jd)='' THEN '无JD'
    WHEN LENGTH(jd)<50 THEN '极短(<50)'
    WHEN LENGTH(jd)<200 THEN '短(50-200)'
    ELSE '正常(>=200)' END bucket, COUNT(*) n
    FROM jobs GROUP BY bucket ORDER BY n DESC`).all() as any[],
  ['bucket', 'n'],
));

db.close();
