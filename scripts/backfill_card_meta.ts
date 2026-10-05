/**
 * 回填校招卡片元数据（`jobs.grad_year` / `jobs.tags` / `jobs.deadline`）
 * ==========================================================================
 * 为什么需要：这三列是新增的（`deadline` 是既有列但全库为空），**存量岗位全是 NULL**。
 * 新采集的岗位会在入库时自动派生（见 `server/db.ts` 的 upsertJob），但已经躺在库里的
 * 那批不会自己长出来 —— 不回填的话，控制台「校招信息库」的届别下拉、快捷关注标签、
 * 截止状态下拉全是空的（那正是 2026-10-04 修掉的那类「静默失效控件」）。
 *
 * 三列各自的派生源**刻意不同**，理由写在下面的 `derive()` 里：
 *   · `grad_year` —— card_text → jd → position（届别在正文里也常写，实测多补 113 条）
 *   · `tags`      —— **只认 card_text**（正文里的措辞与卡片上的结构化字段不是一回事）
 *   · `deadline`  —— **只认 card_text**，且判据是结构性的（届别 token 之后紧邻的日期）
 *
 * 与 `upsertJob` 共用 `server/services/parseCardMeta.ts` —— **绝不各写一份**：
 * 两份规则一定会漂移，而漂移的表现是「新采集的岗位筛得到、老岗位筛不到」，
 * 这种差异没有任何地方会报错。
 *
 * 特点：
 *   · **纯数据库操作**：不启动浏览器、不访问任何网站，秒级跑完，可反复跑
 *   · **只填空值**：已有值的行不碰（不会用低置信度来源覆盖显式值）
 *   · **可预览**：`--dry-run` 只统计不写库
 *
 * 用法：
 *   node node_modules/tsx/dist/cli.mjs scripts/backfill_card_meta.ts --dry-run
 *   node node_modules/tsx/dist/cli.mjs scripts/backfill_card_meta.ts
 *   node node_modules/tsx/dist/cli.mjs scripts/backfill_card_meta.ts --source=offerbiu
 */
import * as db from '../server/db.js';
import { parseCardMeta, parseGradYear, serializeTags, CARD_TAG_DEFS } from '../server/services/parseCardMeta.js';

const arg = (name: string, def?: string) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

const DRY_RUN = flag('dry-run');
const SOURCE = arg('source');           // 不传 = 全部平台
const LIMIT = Math.max(0, Number(arg('limit', '0'))) || Infinity;

interface Row {
  id: string;
  source: string;
  company: string | null;
  position: string | null;
  card_text: string | null;
  jd: string | null;
  grad_year: string | null;
  tags: string | null;
  deadline: string | null;
}

/** 与 `upsertJob` 一致的派生口径（改动必须两边同时改） */
function derive(r: Row): { gradYear: string | null; tags: string | null; deadline: string | null; via: string } {
  const meta = r.card_text ? parseCardMeta(r.card_text) : null;
  // 两个兜底来源各解析一次（而不是在 via 里再算一遍：同一次运行里解析两次，
  // 将来改了规则只改一处就会出现「值来自 jd、via 却说 position」这种自相矛盾的报表）
  const jdGy = parseGradYear(r.jd);
  const posGy = parseGradYear(r.position);
  const gradYear = (meta ? meta.gradYear : null) ?? jdGy ?? posGy;
  const via = (meta && meta.gradYear) ? 'card_text' : (jdGy ? 'jd' : (posGy ? 'position' : '-'));
  // tags / deadline 只认 card_text —— 见文件头
  return {
    gradYear,
    tags: meta ? serializeTags(meta.tags) : null,
    deadline: meta ? meta.deadline : null,
    via,
  };
}

const rows = db.query<Row>(
  'SELECT id, source, company, position, card_text, jd, grad_year, tags, deadline FROM jobs'
  + (SOURCE ? ' WHERE source = ?' : ''),
  SOURCE ? [SOURCE] : [],
);

console.log('══════ 校招卡片元数据回填 ══════');
console.log(`扫描 ${rows.length} 条${SOURCE ? `（来源 ${SOURCE}）` : ''}${DRY_RUN ? ' [dry-run 不写库]' : ''}`);
console.log('只填空值：已有 grad_year / tags / deadline 的行对应列不动。\n');

const stat = new Map<string, { total: number; gy: number; tg: number; dl: number; viaJd: number }>();
const bump = (src: string) => {
  let s = stat.get(src);
  if (!s) { s = { total: 0, gy: 0, tg: 0, dl: 0, viaJd: 0 }; stat.set(src, s); }
  return s;
};
const tagHits = new Map<string, number>();
let written = 0;
const samples: string[] = [];

for (const r of rows) {
  const s = bump(r.source);
  s.total++;

  const d = derive(r);
  if (d.gradYear) tagHits.set('届别', (tagHits.get('届别') || 0) + 1);
  if (d.gradYear && d.via !== 'card_text') s.viaJd++;
  for (const tg of (d.tags ? JSON.parse(d.tags) as string[] : [])) {
    tagHits.set(tg, (tagHits.get(tg) || 0) + 1);
  }

  const patch: Partial<Pick<Row, 'grad_year' | 'tags' | 'deadline'>> = {};
  const has = (v: string | null) => !!(v && String(v).trim());
  if (!has(r.grad_year) && d.gradYear) patch.grad_year = d.gradYear;
  if (!has(r.tags) && d.tags) patch.tags = d.tags;
  if (!has(r.deadline) && d.deadline) patch.deadline = d.deadline;

  if (patch.grad_year) s.gy++;
  if (patch.tags) s.tg++;
  if (patch.deadline) s.dl++;

  if (!Object.keys(patch).length) continue;
  if (written >= LIMIT) continue;

  if (samples.length < 8) {
    samples.push(`[${r.source}] ${r.company || '–'} → 届别 ${patch.grad_year || '–'}（${d.via}）标签 ${patch.tags || '–'} 截止 ${patch.deadline || '–'}`);
  }
  if (!DRY_RUN) {
    db.updateJob(r.id, patch);
    written++;
  }
}

const pad = (s: string | number, w: number) => String(s).padEnd(w, ' ');
console.log(pad('来源', 16) + pad('扫描', 8) + pad('补届别', 9) + pad('补标签', 9) + pad('补截止日', 10) + '其中届别来自 jd/position');
console.log('-'.repeat(78));
let T = 0, G = 0, G2 = 0, D = 0, V = 0;
for (const [src, s] of [...stat.entries()].sort((a, b) => b[1].total - a[1].total)) {
  T += s.total; G += s.gy; G2 += s.tg; D += s.dl; V += s.viaJd;
  console.log(pad(src, 16) + pad(s.total, 8) + pad(s.gy, 9) + pad(s.tg, 9) + pad(s.dl, 10) + s.viaJd);
}
console.log('-'.repeat(78));
console.log(pad('合计', 16) + pad(T, 8) + pad(G, 9) + pad(G2, 9) + pad(D, 10) + V);
const pct = (n: number) => (T ? Math.round(n / T * 100) : 0);
console.log(`\n覆盖率：届别 ${pct(G)}%（${G}/${T}）  标签 ${pct(G2)}%（${G2}/${T}）  截止日 ${pct(D)}%（${D}/${T}）`);
console.log('说明：只有 offerbiu 的卡片摘要（card_text）带这些元数据，其它平台的结构化标签由各自采集器负责。');

console.log('\n标签分布（按 parseCardMeta 的白名单）：');
for (const def of CARD_TAG_DEFS) {
  const n = tagHits.get(def.key) || 0;
  if (n) console.log('  ' + pad(def.key, 10) + pad(n, 8) + (def.ui ? '(控制台快捷关注)' : '(仅落库)'));
}

if (samples.length) {
  console.log('\n样本：');
  for (const s of samples) console.log('  ' + s);
}
if (DRY_RUN) {
  console.log('\n（dry-run：未写库。去掉 --dry-run 即执行）');
} else {
  console.log(`\n已写库 ${written} 条。`);
}
