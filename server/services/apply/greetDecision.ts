/**
 * 打招呼决策 + 跳过原因留痕（对标职得鸭 `POST /api/ai/checkAutoChat`）
 * ─────────────────────────────────────────────────────────────
 * 职得鸭的契约：AI 返回 `是 | 否 | 否-已写过 | 否-HR已回复`（只有分类，没有可读理由）。
 * 我们的改进：**每一次"不打招呼"都产出一句人类可读的 `skip_reason` 并落库**，
 * 于是「哪些规则在误杀」可以从漏斗数据里直接看出来 —— 这是它没有的能力。
 *
 * 决策顺序（先硬规则，命中即返回；最后才问 AI）：
 *   1  HR 已回复          → 不打扰真人对话
 *   2  已写过求职信        → 不重复
 *   3  已投递过该岗位      → 不重复
 *   4  岗位不可投          → 已下线/审核中/需单独简历
 *   5  跨公司串号隔离      → 简历可能发错公司
 *   6  命中排除词          → 外包/中介/劳务派遣等
 *   7  城市不符            → 与期望城市无关
 *   8  匹配度过低          → 低于阈值
 *   9  AI 判定             → 输出是/否 + 理由
 *  10  兜底               → 通过（未启用 AI 时不会静默全挂）
 */
import { chatJSON } from './aiClient.js';
import { buildResumeBlob, parseSkills } from './resumeTailor.js';
import { matchResumeToJob } from '../match.js';
import { getCoverLetter, coverLetterKey, query, type JobRow } from '../../db.js';

export interface GreetDecision {
  /** 是否发起打招呼 */
  greet: boolean;
  /** 人类可读理由（不打招呼时写入 jobs.skip_reason） */
  reason: string;
  /** 判定来源：硬规则 / AI / 兜底 */
  source: 'rule' | 'llm' | 'fallback';
  /** 本地匹配分（若算出） */
  score?: number | null;
  /** 命中的关键证据（便于排查） */
  evidence?: string[];
}

export interface GreetContext {
  platform: string;
  jobId?: string;
  company?: string | null;
  position?: string | null;
  city?: string | null;
  salary?: string | null;
  jd?: string | null;
  requirements?: string | null;
  /** 跨公司串号隔离原因（jobs.quarantine） */
  quarantine?: string | null;
  /** 岗位状态（unavailable 直接跳过） */
  status?: string | null;
  /** 档案（用于匹配计算与 AI 上下文） */
  profile?: Record<string, any> | null;
  /** 该 HR 是否已回复（复聊场景下传入） */
  hrReplied?: boolean;
  /** 该 HR 会话 ID（用于求职信去重） */
  hrGroupId?: string | null;
  /** 排除词（默认内置一组；传 [] 可关闭） */
  excludeKeywords?: string[];
  /** 期望城市（默认取 profile.city / profile.expectedCities） */
  expectedCities?: string[];
  /** 最低匹配分阈值（默认 40） */
  minScore?: number;
  /** 是否启用 AI 判定（默认 true，AI 未配置时自动降级） */
  useAi?: boolean;
}

/** 默认排除词：这类岗位投了也基本是无效沟通，且会污染投递记录 */
export const DEFAULT_EXCLUDE_KEYWORDS: readonly string[] = [
  '外包', '劳务派遣', '人力外派', '中介', '猎头', '招聘专员', '人力中介',
  '兼职', '日结', '小时工', '地推', '刷单', '网络推广', '无底薪',
];

function normCity(s?: string | null): string {
  return String(s || '').replace(/[市区县·\-\s]/g, '').trim();
}

/** 期望城市列表（兼容 profile 里几种不同写法） */
export function resolveExpectedCities(profile?: Record<string, any> | null): string[] {
  if (!profile) return [];
  const raw = [profile.city, profile.expectedCities, profile.expected_city, profile.expectCity]
    .filter(Boolean)
    .join(',');
  return raw.split(/[，,、;；\s|/]+/).map((s) => s.trim()).filter(Boolean);
}

/** 该岗位是否已有成功投递记录（按公司+岗位，兼容 company 为空的情况） */
function alreadyApplied(company?: string | null, position?: string | null): boolean {
  if (!position) return false;
  try {
    const rows = query<{ c: number }>(
      `SELECT COUNT(*) c FROM applications WHERE position = ? AND (? IS NULL OR ? = '' OR company = ?)`,
      [position, company || null, company || '', company || null],
    );
    return (rows[0]?.c || 0) > 0;
  } catch {
    return false;
  }
}

/**
 * 单岗位打招呼决策。**永不抛异常**，任何内部错误都退化为"通过"（不因判定失败而漏投）。
 */
export async function decideGreet(ctx: GreetContext): Promise<GreetDecision> {
  const evidence: string[] = [];
  try {
    // ── 1. HR 已回复：不打扰真人对话
    if (ctx.hrReplied) {
      return { greet: false, reason: 'HR已回复，无需再打招呼', source: 'rule' };
    }

    // ── 2. 已写过求职信（台账 or 传参）
    const key = coverLetterKey(ctx.platform, ctx.company, ctx.position, ctx.hrGroupId);
    if (getCoverLetter(key)) {
      return { greet: false, reason: '已写过求职信，不重复发送', source: 'rule' };
    }

    // ── 3. 已投递过
    if (alreadyApplied(ctx.company, ctx.position)) {
      return { greet: false, reason: '已投递过该岗位', source: 'rule' };
    }

    // ── 4. 岗位不可投
    if (ctx.status === 'unavailable') {
      return { greet: false, reason: '岗位不可投（已下线/审核中/需单独简历）', source: 'rule' };
    }

    // ── 5. 跨公司串号隔离
    if (ctx.quarantine) {
      return { greet: false, reason: `跨公司串号隔离：${ctx.quarantine}`, source: 'rule' };
    }

    // ── 6. 排除词
    const excludes = ctx.excludeKeywords ?? DEFAULT_EXCLUDE_KEYWORDS;
    const hay = `${ctx.position || ''} ${ctx.company || ''}`.toLowerCase();
    const hit = excludes.filter((k) => k && hay.includes(String(k).toLowerCase()));
    if (hit.length) {
      return { greet: false, reason: `命中排除词：${hit.join('、')}`, source: 'rule', evidence: hit };
    }

    // ── 7. 城市不符（仅当双方都有城市信息时判定，避免误杀）
    const expected = (ctx.expectedCities && ctx.expectedCities.length ? ctx.expectedCities : resolveExpectedCities(ctx.profile));
    const jobCity = normCity(ctx.city);
    if (jobCity && expected.length) {
      const matchedCity = expected.some((c) => {
        const n = normCity(c);
        return n && (jobCity.includes(n) || n.includes(jobCity));
      });
      if (!matchedCity) {
        return { greet: false, reason: `城市不符（岗位「${ctx.city}」不在期望城市「${expected.join('/')}」）`, source: 'rule', evidence: expected };
      }
      evidence.push(`城市匹配：${ctx.city}`);
    }

    // ── 8. 匹配度过低
    let score: number | null = null;
    if (ctx.profile) {
      const blob = buildResumeBlob(ctx.profile);
      const skills = parseSkills(ctx.profile);
      const mr = matchResumeToJob(blob, skills, ctx.jd || '', ctx.requirements || undefined, ctx.position || undefined);
      score = mr.score;
      const min = ctx.minScore ?? 40;
      if (score < min) {
        return {
          greet: false,
          reason: `匹配度过低（${score} < ${min}）：命中 ${mr.matched.length} 项、缺 ${mr.missing.slice(0, 3).join('/') || '无'}`,
          source: 'rule',
          score,
          evidence: mr.missing.slice(0, 5),
        };
      }
      evidence.push(`匹配分 ${score}（命中 ${mr.matched.length} 项）`);
    }

    // ── 9. AI 判定（职得鸭的 checkAutoChat 对位能力）
    if (ctx.useAi !== false && ctx.profile && (ctx.jd || ctx.position)) {
      const blob = buildResumeBlob(ctx.profile).slice(0, 3000);
      const prompt = `请判断：这位求职者是否值得主动向该岗位打招呼。

【求职者简历要点】
${blob}

【目标岗位】${ctx.company || '（未提供公司）'} ｜ ${ctx.position || '（未提供职位）'}
${ctx.city ? `【工作地点】${ctx.city}` : ''}
【岗位 JD】
${String(ctx.jd || '（未提供 JD）').slice(0, 3000)}

判定标准：
- 硬性方向不符（如岗位要前端、简历全是后端）→ 否
- 明显低于要求（如要 5 年经验、简历无相关经历）→ 否
- 方向相符或高度相关 → 是
- 仅凭现有信息无法判断时倾向"是"（宁可打招呼）

只输出 JSON：{"greet": true|false, "reason": "不超过 30 字的中文理由"}`;
      const verdict = await chatJSON<{ greet: boolean; reason?: string }>(
        prompt,
        '你是求职投递策略助手。只输出 JSON，不要解释。judge 要基于简历与 JD 的真实内容，不得臆测简历里没有的经历。',
        { temperature: 0.2, timeoutMs: 25000 },
      );
      if (verdict && typeof verdict.greet === 'boolean') {
        return {
          greet: verdict.greet,
          reason: String(verdict.reason || (verdict.greet ? 'AI 判定符合打招呼条件' : 'AI 判定不符合打招呼条件')).slice(0, 120),
          source: 'llm',
          score,
          evidence,
        };
      }
    }

    // ── 10. 兜底：通过
    return { greet: true, reason: '通过（硬规则全部通过）', source: 'fallback', score, evidence };
  } catch (e: any) {
    // 判定服务本身出问题不应导致漏投 —— 退化为通过，并把异常写进证据便于排查
    return { greet: true, reason: '判定异常，默认通过', source: 'fallback', evidence: [`judge-error: ${e?.message || e}`] };
  }
}

/** 批量判定（给控制台/接口用），返回每个岗位的决策，不写库 */
export async function decideGreetBatch(
  jobs: JobRow[],
  profile: Record<string, any> | null,
  opts: { minScore?: number; useAi?: boolean; excludeKeywords?: string[] } = {},
): Promise<Array<{ job: JobRow; decision: GreetDecision }>> {
  const out: Array<{ job: JobRow; decision: GreetDecision }> = [];
  for (const j of jobs) {
    const decision = await decideGreet({
      platform: j.source,
      jobId: j.id,
      company: j.company,
      position: j.position,
      city: j.city,
      salary: j.salary,
      jd: j.jd,
      requirements: j.requirements,
      quarantine: j.quarantine,
      status: j.status,
      profile,
      minScore: opts.minScore,
      useAi: opts.useAi,
      excludeKeywords: opts.excludeKeywords,
    });
    out.push({ job: j, decision });
  }
  return out;
}
