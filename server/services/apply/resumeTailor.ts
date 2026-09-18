/**
 * 一岗一简历（按 JD 定制简历）—— 对标「职得鸭」核心卖点之一
 * ==========================================================================
 * 输入：我的档案（结构化 profile）+ 目标岗位（JD / 任职要求 / 职位名）
 * 输出：一份**针对该岗位定制**的简历片段：
 *   · 按岗位相关度重排的技能列表（JD 命中的前置）
 *   · 定制「核心优势」文案（LLM 优先，失败回退本地模板）
 *   · 命中 / 缺失（gap）分析 + 匹配分
 *   · 可直接渲染或落盘的 Markdown
 *
 * 三条硬规则（防幻觉）：
 *   1. **绝不编造**简历中不存在的经历、数字、公司、证书 —— 提示词里明确禁止，回退模板也不产生新事实。
 *   2. LLM 只允许**改写与排序**已有事实（把 JD 需要的技能前置、把相关项目提到前面）。
 *   3. 未配置 LLM 或调用失败时，**本地启发式**照常产出，保证离线可用（与 matchAi 同款降级策略）。
 */
import { matchResumeToJob, type MatchResult } from '../match.js';
import { chatJSON } from './aiClient.js';

export interface TailorJob {
  id?: string;
  company?: string | null;
  position?: string | null;
  jd?: string | null;
  requirements?: string | null;
}

export interface TailoredResume {
  jobId?: string;
  company: string;
  position: string;
  /** JD 中识别出的技能关键词 */
  keywords: string[];
  /** 简历已具备的岗位关键词 */
  matched: string[];
  /** 岗位需要但简历未见（gap，供用户决定是否补经历） */
  missing: string[];
  /** 按岗位相关度重排后的技能（命中项前置） */
  orderedSkills: string[];
  /** 定制的核心优势 / 自我评价 */
  summary: string;
  /** 定制亮点（逐条对应岗位要求，全部源自简历既有事实） */
  highlights: string[];
  /** 匹配分（0-100） */
  matchScore: number;
  /** 生成来源 */
  source: 'llm' | 'heuristic';
  /** 可直接渲染 / 落盘的 Markdown */
  markdown: string;
}

/** 从档案里取简历可检索文本（与 backfill_match 同口径） */
export function buildResumeBlob(profile: Record<string, any>): string {
  const skills = parseSkills(profile);
  return [
    profile?.name, profile?.school, profile?.major, profile?.education,
    profile?.city, profile?.expectedPositions, skills.join(' '),
    profile?.experience, profile?.projects, profile?.selfEvaluation,
  ].filter(Boolean).map(String).join(' ');
}

/** 解析档案技能字段（支持 中文逗号/顿号/分号/斜杠/竖线 分隔） */
export function parseSkills(profile: Record<string, any>): string[] {
  const raw = String(profile?.skills ?? profile?.pfSkills ?? '');
  return Array.from(new Set(
    raw.split(/[,，、;；/|]+/).map((s) => s.trim()).filter(Boolean),
  ));
}

/** 本地：按 JD 相关度重排技能（命中项前置，其余保持原序） */
function orderSkillsByJd(skills: string[], matched: string[]): string[] {
  const hit = new Set(matched.map((s) => s.toLowerCase()));
  const front = skills.filter((s) => hit.has(s.toLowerCase()));
  const rest = skills.filter((s) => !hit.has(s.toLowerCase()));
  return [...front, ...rest];
}

/** 本地：拼一段「核心优势」——只做事实重组，不新增信息 */
function heuristicSummary(
  profile: Record<string, any>, job: TailorJob, matched: string[], missing: string[],
): string {
  const position = String(job.position || profile?.expectedPositions || '目标岗位').split(/[，,、]/)[0];
  const edu = [profile?.school, profile?.major, profile?.education].filter(Boolean).join(' · ');
  const m = matched.slice(0, 8);
  const parts: string[] = [];
  parts.push(`求职意向：${position}${job.company ? `（${job.company}）` : ''}。`);
  if (edu) parts.push(`${edu}。`);
  if (m.length) parts.push(`与岗位要求高度契合：具备 ${m.join('、')} 的实战经验，可快速上手岗位核心工作。`);
  if (missing.length) parts.push(`正在补强：${missing.slice(0, 5).join('、')}（学习/实践中）。`);
  return parts.join('');
}

/** 本地：亮点（把命中技能逐条转成可写进简历的要点） */
function heuristicHighlights(matched: string[], skills: string[]): string[] {
  const out: string[] = [];
  for (const s of matched.slice(0, 8)) out.push(`熟练掌握 ${s}，并有实际项目应用经验`);
  if (!out.length && skills.length) out.push(`掌握 ${skills.slice(0, 6).join('、')} 等技能`);
  return out;
}

/** 渲染定制简历的 Markdown 片段 */
function renderMarkdown(r: Omit<TailoredResume, 'markdown'>): string {
  const L: string[] = [];
  L.push(`# ${r.position}${r.company ? ` · ${r.company}` : ''}（定制简历）`);
  L.push('');
  L.push(`> 匹配度 **${r.matchScore}** / 100 ｜ 关键要求命中 ${r.matched.length} 项，待补 ${r.missing.length} 项 ｜ 生成方式：${r.source === 'llm' ? 'AI 定制' : '本地规则'}`);
  L.push('');
  L.push('## 求职意向');
  L.push(`${r.position}${r.company ? ` — ${r.company}` : ''}`);
  L.push('');
  L.push('## 核心优势');
  L.push(r.summary);
  if (r.highlights.length) {
    L.push('');
    for (const h of r.highlights) L.push(`- ${h}`);
  }
  if (r.orderedSkills.length) {
    L.push('');
    L.push('## 技能（按岗位相关度排序）');
    L.push(r.orderedSkills.join('、'));
  }
  L.push('');
  L.push('## 岗位匹配分析');
  if (r.matched.length) L.push(`- ✅ 命中（${r.matched.length}）：${r.matched.join('、')}`);
  if (r.missing.length) L.push(`- ⚠️ 待补（${r.missing.length}）：${r.missing.join('、')}`);
  return L.join('\n');
}

const SYSTEM = `你是资深简历顾问。请依据候选人的**真实档案**与目标岗位 JD，生成针对该岗位的定制简历文案。
硬性要求：
1) 严禁编造简历中不存在的经历、公司、项目、数字、证书；只能对已有事实做「重排、强调、改写」。
2) 技能排序以「与 JD 相关度」为准，JD 明确要求的技能优先。
3) 语言精炼、面向招聘方，不使用夸张形容词堆砌。
只输出 JSON：{ "summary": "<核心优势 2-4 句>", "highlights": ["<要点>", ...], "orderedSkills": ["<技能>", ...] }`;

/**
 * 生成「一岗一简历」。
 * LLM 优先；未配置 / 失败 → 本地启发式（离线可用，绝不影响投递链路）。
 */
export async function tailorResume(
  profile: Record<string, any>,
  job: TailorJob,
): Promise<TailoredResume> {
  const skills = parseSkills(profile);
  const resumeBlob = buildResumeBlob(profile);

  // 本地匹配（既提供 gap 分析，也作为 LLM 失败的完整兜底）
  const m: MatchResult = matchResumeToJob(
    resumeBlob, skills, String(job.jd || ''), job.requirements || undefined, job.position || undefined,
  );

  const orderedSkills = orderSkillsByJd(skills, m.matched);
  const base: Omit<TailoredResume, 'markdown'> = {
    jobId: job.id,
    company: String(job.company || ''),
    position: String(job.position || ''),
    keywords: [...m.matched, ...m.missing],
    matched: m.matched,
    missing: m.missing,
    orderedSkills,
    summary: heuristicSummary(profile, job, m.matched, m.missing),
    highlights: heuristicHighlights(m.matched, skills),
    matchScore: m.score,
    source: 'heuristic',
  };

  // LLM 定制（只在有足够 JD 信息时才值得调用）
  const jdText = `${job.jd || ''}\n${job.requirements || ''}`.trim();
  if (jdText.length >= 20) {
    const prompt = `【候选人真实档案】
姓名：${profile?.name || '(未填)'}
学历：${[profile?.school, profile?.major, profile?.education].filter(Boolean).join(' · ') || '(未填)'}
技能：${skills.join('、') || '(未填)'}
期望职位：${profile?.expectedPositions || '(未填)'}
${profile?.experience ? `经历：${String(profile.experience).slice(0, 600)}` : ''}

【目标岗位】
职位：${job.position || ''}${job.company ? ` @ ${job.company}` : ''}
JD/要求：
${jdText.slice(0, 2000)}

请生成定制文案（严禁编造）。`;

    const r = await chatJSON<{ summary?: string; highlights?: string[]; orderedSkills?: string[] }>(
      prompt, SYSTEM, { temperature: 0.3, timeoutMs: 40000 },
    );

    if (r && (r.summary || (r.highlights && r.highlights.length))) {
      if (typeof r.summary === 'string' && r.summary.trim()) base.summary = r.summary.trim();
      if (Array.isArray(r.highlights) && r.highlights.length) {
        base.highlights = r.highlights.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 10);
      }
      if (Array.isArray(r.orderedSkills) && r.orderedSkills.length) {
        // 只接受「简历里真实存在的技能」，防止 LLM 凭空加技能
        const known = new Map(skills.map((s) => [s.toLowerCase(), s]));
        const safe = r.orderedSkills.map(String).map((s) => known.get(s.trim().toLowerCase())).filter(Boolean) as string[];
        if (safe.length) {
          const rest = skills.filter((s) => !safe.some((x) => x.toLowerCase() === s.toLowerCase()));
          base.orderedSkills = [...safe, ...rest];
        }
      }
      base.source = 'llm';
    }
  }

  return { ...base, markdown: renderMarkdown(base) };
}

/** 批量定制（供「投递前逐岗生成」用；串行以避免打爆 LLM 限流） */
export async function tailorResumeBatch(
  profile: Record<string, any>,
  jobs: TailorJob[],
): Promise<TailoredResume[]> {
  const out: TailoredResume[] = [];
  for (const j of jobs) out.push(await tailorResume(profile, j));
  return out;
}
