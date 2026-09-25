/**
 * 投递效果 A/B 测试（对标 LoopCV「投递效果 A/B 测试」）
 * ─────────────────────────────────────────────────────────────
 * 思路：每次真实投递时在 applications 打上 strategy 标签（如 `letter|tailored` =
 * 发了求职信 + 用一岗一简历；`no_letter|original` = 没发求职信 + 用原始简历）。
 * 这里按 strategy 聚合「回复率 / 面试率」，找出胜出策略。
 *
 * 回复判定：同一平台+公司+岗位的 HR 会话（hr_conversations）出现 last_replied_at → 视为已回复。
 * 面试判定：会话 stage 进入 interview/interviewed（由自动回复链路标记）。
 *
 * 注意：这是**事后归因**——样本量小/未做随机分流时只能当参考，不能当因果结论。
 * 报告里会如实标注样本量，避免误导。
 */
import { query, updateApplication } from '../../db.js';

const norm = (s?: string | null) => (s || '').replace(/\s+/g, '').toLowerCase();

function parseConvKey(key: string): { platform: string; hr: string; company: string; position: string } {
  const p = String(key).split('|');
  return { platform: p[0] || '', hr: p[1] || '', company: p[2] || '', position: p[3] || '' };
}

export interface StrategyStat {
  strategy: string;
  /** A/B 主变量：是否带求职信（letter / no_letter / legacy 历史未打标） */
  letter: string;
  /** 简历版本：original / optimized / tailored / unknown */
  resumeVersion: string;
  applications: number;
  replied: number;
  replyRate: number;
  interviewed: number;
  interviewRate: number;
}

export interface AbReport {
  ok: boolean;
  total: number;
  strategies: StrategyStat[];
  /**
   * 核心 A/B 对比：带求职信 vs 不带。
   * ⚠️ 2026-09-25：`legacy`（历史未打标）**不再混入对照组** —— 那批数据策略未知，
   * 混进「不带求职信」会把两组差异稀释到看不出来（实测对照组 840 条里一条显式 no_letter 都没有）。
   * 被排除的条数见 `legacyExcluded`。
   */
  letterVsNoLetter: {
    has: { applications: number; replyRate: number; interviewRate: number };
    no: { applications: number; replyRate: number; interviewRate: number };
    winner: 'letter' | 'no_letter' | 'inconclusive';
    note: string;
    /** 因未打标而被排除出对照的历史投递条数 */
    legacyExcluded: number;
  };
  note: string;
}

/** 存量数据回填：给未打标的历史投递一个 `legacy` 标签，避免它们污染 A/B 分组 */
export function backfillLegacyStrategy(): number {
  const rows = query<{ id: string }>(
    "SELECT id FROM applications WHERE status='applied' AND (strategy IS NULL OR strategy='')",
  );
  for (const r of rows) updateApplication(r.id, { strategy: 'legacy' });
  return rows.length;
}

export function computeAbReport(): AbReport {
  const apps = query<{ id: string; platform: string; company: string | null; position: string | null; strategy: string | null }>(
    "SELECT id, platform, company, position, strategy FROM applications WHERE status='applied'",
  );
  const convs = query<{ conv_key: string; stage: string; last_replied_at: string | null }>(
    "SELECT conv_key, stage, last_replied_at FROM hr_conversations",
  );
  const convIndex = new Map<string, typeof convs[number]>();
  for (const c of convs) {
    const k = parseConvKey(c.conv_key);
    const key = `${k.platform}|${k.company}|${k.position}`;
    // 同一平台+公司+岗位可能有多段会话（不同 HR），取「已回复」优先
    const exist = convIndex.get(key);
    if (!exist || (c.last_replied_at && !exist.last_replied_at)) convIndex.set(key, c);
  }

  const matchConv = (platform: string, company?: string | null, position?: string | null) =>
    convIndex.get(`${norm(platform)}|${norm(company)}|${norm(position)}`);

  const groups = new Map<string, StrategyStat>();
  let repliedTotal = 0, interviewedTotal = 0;

  for (const a of apps) {
    const raw = String(a.strategy || 'legacy');
    const [letterPart, rvPart] = raw.split('|');
    // 三分：letter / no_letter / legacy（历史未打标）。
    // ⚠️ 2026-09-25：legacy 不再并入对照组 —— 那 800 多条策略未知，混进「不带求职信」
    //    会把真实差异稀释到看不出来（实测对照组 840 条里没有一条是显式的 no_letter）。
    const letter: string = letterPart === 'letter' ? 'letter'
      : (letterPart === 'no_letter' ? 'no_letter' : 'legacy');
    const resumeVersion = rvPart || 'unknown';
    const key = raw;
    if (!groups.has(key)) {
      groups.set(key, { strategy: raw, letter, resumeVersion, applications: 0, replied: 0, replyRate: 0, interviewed: 0, interviewRate: 0 });
    }
    const g = groups.get(key)!;
    g.applications++;
    const conv = matchConv(a.platform, a.company, a.position);
    if (conv?.last_replied_at) { g.replied++; repliedTotal++; }
    if (conv && /interview/i.test(conv.stage || '')) { g.interviewed++; interviewedTotal++; }
  }

  const strategies = [...groups.values()].map((g) => ({
    ...g,
    replyRate: g.applications ? Math.round((g.replied / g.applications) * 100) : 0,
    interviewRate: g.applications ? Math.round((g.interviewed / g.applications) * 100) : 0,
  })).sort((a, b) => b.applications - a.applications);

  // 核心 A/B：带求职信 vs 不带
  const has = strategies.filter((s) => s.letter === 'letter');
  const no = strategies.filter((s) => s.letter === 'no_letter');
  const agg = (arr: StrategyStat[]) => {
    const applications = arr.reduce((s, x) => s + x.applications, 0);
    const replied = arr.reduce((s, x) => s + x.replied, 0);
    const interviewed = arr.reduce((s, x) => s + x.interviewed, 0);
    return {
      applications,
      replyRate: applications ? Math.round((replied / applications) * 100) : 0,
      interviewRate: applications ? Math.round((interviewed / applications) * 100) : 0,
    };
  };
  // 对照组只保留**显式**打标的两臂；legacy 仅计入总量，不参与对照
  const h = agg(has), n = agg(no);
  const legacyExcluded = strategies.filter((s) => s.letter === 'legacy').reduce((s, x) => s + x.applications, 0);
  let winner: 'letter' | 'no_letter' | 'inconclusive' = 'inconclusive';
  let abNote: string;
  if (!h.applications || !n.applications) {
    abNote = `对照组样本不足：${!h.applications ? '「带求职信」' : '「不带求职信」'}一组尚无投递`
      + (legacyExcluded ? `（另有 ${legacyExcluded} 条历史投递未打标，已排除出对照以保证结论干净）` : '')
      + '。继续投递即可积累。';
  } else if (h.applications >= 5 && n.applications >= 5 && Math.abs(h.replyRate - n.replyRate) >= 10) {
    // 两组都至少 5 样本、且回复率差 ≥ 10 个百分点才给结论
    winner = h.replyRate > n.replyRate ? 'letter' : 'no_letter';
    abNote = `「${winner === 'letter' ? '带求职信' : '不带求职信'}」回复率更高（${winner === 'letter' ? h.replyRate : n.replyRate}% vs ${winner === 'letter' ? n.replyRate : h.replyRate}%）`;
  } else {
    abNote = '样本不足或差异不显著（两组各需 ≥5 且回复率差 ≥10pp 才下结论），建议继续积累数据。'
      + (legacyExcluded ? `（历史未打标 ${legacyExcluded} 条未计入对照）` : '');
  }
  const letterVsNoLetter: AbReport['letterVsNoLetter'] = { has: h, no: n, winner, note: abNote, legacyExcluded };

  const total = apps.length;
  const note = (total < 10
    ? `当前样本量较小（${total} 次投递），结论仅供参考；建议持续投递以积累统计显著性。`
    : `已基于 ${total} 次投递做策略归因（回复 ${repliedTotal}、面试 ${interviewedTotal}）。`)
    + (legacyExcluded ? ` 其中 ${legacyExcluded} 条为历史未打标数据：仅计入总量，**不参与 A/B 对照**。` : '');

  return { ok: true, total, strategies, letterVsNoLetter, note };
}
