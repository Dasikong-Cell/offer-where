/**
 * 回填岗位发布时间（`jobs.posted_at`）
 * ==========================================================================
 * 为什么需要：`posted_at` 是新增列，**存量岗位全是 NULL**。新采集的岗位会在入库时
 * 自动解析（见 `server/db.ts` 的 upsertJob），但已经躺在库里的那批不会自己长出来 ——
 * 不回填的话，「只看今天」对这些老岗位只能走 `created_at` 兜底，
 * 而 `created_at` 是「我们什么时候采集到的」，不是「岗位什么时候发布的」。
 *
 * 取两种来源，优先级从高到低（与 upsertJob 一致）：
 *   ① `card_text` —— 列表页卡片摘要，**全文解析**。实测 offerbiu 963/963 全部可解析
 *      （卡片上是规整的「更新 9月2日」）。
 *   ② `jd` —— 详情页正文，**只认带字段名的日期**（`更新时间2026-09-20`，实测真实库 80 例）。
 *      ⚠️ 这里**绝不**对 JD 做全文解析：1202 条真实 JD 上实测命中仅 2%，
 *      且剩下的几乎全是噪声（`工作时间9-18`、公司成立日期、宣讲会时间）。
 *
 * 特点：
 *   · **纯数据库操作**：不启动浏览器、不访问任何网站，秒级跑完，可反复跑
 *   · **只填空值**：已有 `posted_at` 的行不碰（不会用低置信度来源覆盖显式值）
 *   · **可预览**：`--dry-run` 只统计不写库
 *
 * 用法：
 *   ./node/node.exe node_modules/tsx/dist/cli.mjs scripts/backfill_posted_at.ts --dry-run
 *   ./node/node.exe node_modules/tsx/dist/cli.mjs scripts/backfill_posted_at.ts
 *   ./node/node.exe node_modules/tsx/dist/cli.mjs scripts/backfill_posted_at.ts --source=offerbiu
 */
import * as db from '../server/db.js';
import { parsePostedAt, postedAtFromLabeled, todayLocal } from '../server/services/parsePostedAt.js';

const arg = (name: string, def?: string) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

const DRY_RUN = flag('dry-run');
const SOURCE = arg('source');           // 不传 = 全部平台
const LIMIT = Math.max(0, Number(arg('limit', '0'))) || Infinity;

interface Row { id: string; source: string; card_text: string | null; jd: string | null }

const where = ["(posted_at IS NULL OR TRIM(posted_at) = '')"];
const params: unknown[] = [];
if (SOURCE) { where.push('source = ?'); params.push(SOURCE); }

const rows = db.query<Row>(
  `SELECT id, source, card_text, jd FROM jobs WHERE ${where.join(' AND ')}`,
  params,
);

console.log('══════ 发布时间回填 ══════');
console.log(`今天（当地）：${todayLocal()}`);
console.log(`待处理：${rows.length} 条${SOURCE ? `（来源 ${SOURCE}）` : ''}${DRY_RUN ? ' [dry-run 不写库]' : ''}\n`);

// 按来源统计三种结果：卡片命中 / 详情页字段命中 / 仍无
const stat = new Map<string, { total: number; byCard: number; byJd: number; miss: number }>();
const bump = (src: string) => {
  let s = stat.get(src);
  if (!s) { s = { total: 0, byCard: 0, byJd: 0, miss: 0 }; stat.set(src, s); }
  return s;
};

let written = 0;
const samples: string[] = [];

for (const r of rows) {
  const s = bump(r.source);
  s.total++;
  if (written >= LIMIT) { s.miss++; continue; }

  let date: string | null = null;
  let via = '';
  if (r.card_text && r.card_text.trim()) {
    date = parsePostedAt(r.card_text).date;
    if (date) via = 'card_text';
  }
  if (!date && r.jd && r.jd.trim()) {
    date = postedAtFromLabeled(r.jd);
    if (date) via = 'jd:字段名';
  }

  if (!date) { s.miss++; continue; }
  if (via === 'card_text') s.byCard++; else s.byJd++;

  if (samples.length < 8) {
    samples.push(`[${r.source}] → ${date}（${via}）`);
  }
  if (!DRY_RUN) {
    db.updateJob(r.id, { posted_at: date });
    written++;
  }
}

const pad = (s: string | number, w: number) => String(s).padEnd(w, ' ');
console.log(pad('来源', 16) + pad('待回填', 9) + pad('卡片命中', 10) + pad('详情页命中', 12) + '仍无发布时间');
console.log('-'.repeat(66));
let T = 0, C = 0, J = 0, M = 0;
for (const [src, s] of [...stat.entries()].sort((a, b) => b[1].total - a[1].total)) {
  T += s.total; C += s.byCard; J += s.byJd; M += s.miss;
  console.log(pad(src, 16) + pad(s.total, 9) + pad(s.byCard, 10) + pad(s.byJd, 12) + s.miss);
}
console.log('-'.repeat(66));
console.log(pad('合计', 16) + pad(T, 9) + pad(C, 10) + pad(J, 12) + M);
console.log(`\n覆盖率：${T ? Math.round((C + J) / T * 100) : 0}%（${C + J}/${T}）`);
console.log('「仍无发布时间」的岗位不是错误 —— 平台没给就是没给，筛选时会退回 created_at 兜底。');

if (samples.length) {
  console.log('\n样本：');
  for (const s of samples) console.log('  ' + s);
}
if (DRY_RUN) {
  console.log('\n（dry-run：未写库。去掉 --dry-run 即执行）');
} else {
  console.log(`\n已写库 ${written} 条。`);
}
