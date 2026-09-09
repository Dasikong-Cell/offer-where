/**
 * AI 智能匹配（对标职得鸭「智能匹配」）
 * ─────────────────────────────────────────────────────────────
 * 优先用 LLM 对「简历 vs JD」做语义评估，输出匹配分(0-100) + 命中/缺失/建议；
 * 未配置 LLM 或调用失败时，自动回退到本地规则匹配 matchResumeToJob（离线可跑）。
 *
 * 这样无论是否接入 AI，/api/jobs/match 与批量连投的 minScore 过滤始终可用。
 */
import { matchResumeToJob, type MatchResult } from '../match.js';
import { chatJSON } from './aiClient.js';

export interface JobMatchInput {
  resumeBlob: string;
  resumeSkills: string[];
  jd: string;
  requirements?: string;
}

const SYSTEM = `你是资深 HR 与技术招聘专家。请根据候选人简历与目标岗位 JD，给出客观匹配评估。
只输出 JSON，格式：{ "score": <0-100 整数>, "matched": [<命中要点>], "missing": [<缺失要点>], "suggestions": [<针对缺失的可执行建议>] }。`;

/**
 * AI 语义匹配；失败时回退规则匹配。
 */
export async function matchResumeToJobAi(input: JobMatchInput): Promise<MatchResult> {
  const { resumeBlob, resumeSkills, jd, requirements } = input;
  const jdText = `${jd || ''}\n${requirements || ''}`.trim();

  // JD 过短无法语义评估 → 直接规则匹配
  if (!jdText || jdText.length < 10) {
    return matchResumeToJob(resumeBlob, resumeSkills, jd, requirements);
  }

  const prompt = `【候选人简历】
${resumeBlob || '(无)'}
技能：${(resumeSkills || []).join('、') || '(无)'}

【目标岗位 JD】
${jdText}

请评估匹配度：score 为 0-100 整数（技能契合为主、项目/经验相关度为辅）。`;

  try {
    const r = await chatJSON<{
      score?: number;
      matched?: string[];
      missing?: string[];
      suggestions?: string[];
    }>(prompt, SYSTEM, { temperature: 0.2, timeoutMs: 30000 });

    if (r && typeof r.score === 'number' && !Number.isNaN(r.score)) {
      const score = Math.max(0, Math.min(100, Math.round(r.score)));
      return {
        score,
        matched: Array.isArray(r.matched) ? r.matched.map(String).slice(0, 20) : [],
        missing: Array.isArray(r.missing) ? r.missing.map(String).slice(0, 20) : [],
        suggestions: Array.isArray(r.suggestions) ? r.suggestions.map(String).slice(0, 10) : [],
      };
    }
  } catch {
    /* 忽略，走回退 */
  }

  // 回退：本地规则匹配
  return matchResumeToJob(resumeBlob, resumeSkills, jd, requirements);
}
