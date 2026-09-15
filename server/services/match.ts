/**
 * 岗位匹配引擎（纯本地，离线可跑）
 * 输入：简历结构化结果 / 简历文本 + 岗位 JD + 要求
 * 输出：匹配分(0-100)、命中关键词、缺失关键词、改写建议
 */
import { SKILLS } from './skillsDict';

export interface MatchResult {
  score: number;
  matched: string[];
  missing: string[];
  suggestions: string[];
}

/**
 * 计算简历与岗位的匹配度
 * @param resumeBlob 简历归一化文本（来自 ResumeStruct.searchBlob）
 * @param resumeSkills 简历技能列表
 * @param jd 岗位 JD 文本
 * @param requirements 岗位要求（可选）
 */
export function matchResumeToJob(
  resumeBlob: string,
  resumeSkills: string[],
  jd: string,
  requirements?: string,
  title?: string
): MatchResult {
  const jdText = `${jd || ''}\n${requirements || ''}`.trim();
  const blob = `${(resumeBlob || '').toLowerCase()} ${(resumeSkills || []).join(' ').toLowerCase()}`;

  // 主匹配信号用 JD；BOSS 等平台采集的岗位常只有职位名、没有 JD 正文，
  // 此时降级用「职位名」做粗略匹配，避免直接 0 分（否则整池无法排序/过滤）。
  const usedTitle = jdText.length < 10 && !!title && String(title).trim().length >= 2;
  const corpus = usedTitle ? String(title).trim() : jdText;
  if (!corpus) {
    return { score: 0, matched: [], missing: [], suggestions: ['岗位 JD 与职位名为空，无法匹配'] };
  }
  const corpusLower = corpus.toLowerCase();

  // 1) 从 corpus 提取技能关键词
  const jdSkills = SKILLS.filter(s => {
    const t = s.toLowerCase().trim();
    if (!t) return false;
    if (['go', 'c#', 'sql', 'ux', 'cv', 'pr'].includes(t)) {
      const re = new RegExp(`(^|[^a-z])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i');
      return re.test(corpusLower);
    }
    return corpusLower.includes(t);
  });

  // 2) 命中 / 缺失
  const matched = jdSkills.filter(s => blob.includes(s.toLowerCase()));
  const missing = jdSkills.filter(s => !blob.includes(s.toLowerCase()));

  // 3) 额外：corpus 中出现但不在词典里的关键短语（如具体框架），看简历是否包含
  const phrases = extractJdPhrases(corpus);
  const phraseHits = phrases.filter(p => blob.includes(p.toLowerCase()));
  const phraseTotal = phrases.length;

  // 4) 打分：技能重叠为主，短语重叠为辅
  const skillTotal = jdSkills.length || 1;
  const skillRatio = matched.length / skillTotal;
  const phraseRatio = phraseTotal ? phraseHits.length / phraseTotal : 0;
  let score = Math.round((skillRatio * 0.8 + phraseRatio * 0.2) * 100);

  // 若 corpus 里没有任何已知技能词，退化为短语重叠
  if (jdSkills.length === 0) {
    score = Math.round((phraseTotal ? phraseRatio : 0) * 100);
  }
  score = Math.max(0, Math.min(100, score));

  // 职位名兜底匹配的精度弱于真实 JD，封顶 70，确保「有 JD 的岗位」始终排在「仅职位名」之上
  if (usedTitle) score = Math.min(score, 70);

  // 5) 建议：针对缺失技能给出补充提示（最多 8 条）
  const suggestions = missing.slice(0, 8).map(m => `简历中未见「${m.trim()}」，建议在相关经历中显性补充或针对性学习后再投递`);
  if (usedTitle) {
    suggestions.unshift('岗位 JD 为空，已基于职位名做粗略匹配（补全 JD 后重算精度更高）');
  }

  return { score, matched, missing, suggestions };
}

/** 提取 JD 中可能的技术短语（2-6 字，含中文/字母/数字/·），用于兜底命中 */
function extractJdPhrases(jd: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const re = /[A-Za-z][A-Za-z0-9.+#]{1,5}|[一-龥]{2,6}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(jd)) !== null) {
    const w = m[0].trim();
    if (w.length < 2) continue;
    // 过滤纯停用词
    if (['岗位职责', '任职要求', '福利待遇', '工作经验', '学历要求', '岗位职责：', '职位描述'].includes(w)) continue;
    if (!seen.has(w)) { seen.add(w); out.push(w); }
  }
  return out.slice(0, 120);
}
