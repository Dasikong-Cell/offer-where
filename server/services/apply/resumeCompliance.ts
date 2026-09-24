/**
 * 简历合规检测（对标 LoopCV「简历合规检测 / ATS 体检」）
 * ─────────────────────────────────────────────────────────────
 * 不依赖 LLM、纯本地、可离线、结果可复现：把简历文本按 ATS（ applicant tracking
 * system）解析规则逐项体检，给出 0-100 总分 + 分级问题清单 + 整改建议。
 *
 * 为什么纯本地：ATS 解析是确定性规则（联系方式是否完整、章节是否齐全、篇幅、
 * 关键词命中率、量化经历占比、是否有 emoji/表格/图片等解析杀手）。这些规则
 * 不需要大模型，本地算反而更快、零成本、可复现，也避免"每次体检结论不一样"。
 *
 * 六维评分（合计 100）：
 *   联系方式完整性 15 ｜ 章节完整性 20 ｜ 篇幅 15 ｜ JD 关键词命中 25 ｜ 量化经历 10 ｜ 格式卫生 15
 */
import { buildResumeBlob } from './resumeTailor.js';

export type Severity = 'high' | 'medium' | 'low';

export interface ComplianceIssue {
  severity: Severity;
  rule: string;
  message: string;
  suggestion: string;
}

export interface ComplianceStats {
  charCount: number;
  hasPhone: boolean;
  hasEmail: boolean;
  sections: string[];
  missingSections: string[];
  keywordHit: number;
  keywordTotal: number;
  quantified: boolean;
  hasEmoji: boolean;
  hasTable: boolean;
  hasAllCaps: boolean;
}

export interface ComplianceReport {
  ok: boolean;
  score: number;
  grade: string;
  summary: string;
  issues: ComplianceIssue[];
  stats: ComplianceStats;
  /** 生成来源：'profile'（由档案构建）/ 'text'（外部传入文本） */
  source: 'profile' | 'text';
}

/** 从简历文本抽取中文/英文 token（2-4 字中文词 + 英文单词），用于关键词重叠计算 */
function tokenize(text: string): string[] {
  const out: string[] = [];
  const cn = text.match(/[一-龥]{2,4}/g) || [];
  out.push(...cn);
  const en = text.toLowerCase().match(/[a-z][a-z0-9+#.]{1,}/g) || [];
  out.push(...en);
  return Array.from(new Set(out));
}

function hasPhone(t: string): boolean {
  return /1[3-9]\d{9}/.test(t) || /(\d{3,4}[-\s]?){2,3}\d{3,4}/.test(t);
}
function hasEmail(t: string): boolean {
  return /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(t);
}

const SECTION_RULES: Array<{ key: string; re: RegExp }> = [
  { key: '教育', re: /(教育背景|教育经历|学历|毕业院校|就读|大学|学院|专业)/ },
  { key: '工作/实习经历', re: /(工作经历|实习经历|项目经历|工作经验|工作描述|任职|职责|负责)/ },
  { key: '技能', re: /(技能|专业技能|掌握|熟悉|精通|能力)/ },
  { key: '项目', re: /(项目经历|项目经验|项目描述|参与项目|主导项目)/ },
];

const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
const TABLE_RE = /\|.*\|.*\|/; // 表格行（如 Markdown 表格）
const ALLCAPS_RE = /^[A-Z][A-Z\s]{5,}$/m; // 全大写标题（如 "EXPERIENCE" 连续大写）

export interface ComplianceInput {
  /** 由档案构建简历文本（与 resumeTailor 同口径） */
  profile?: Record<string, any> | null;
  /** 直接传入简历文本（优先于 profile） */
  resumeText?: string | null;
  /** 目标岗位 JD（可选；提供则计算关键词命中率） */
  jd?: string | null;
}

export function checkResumeCompliance(input: ComplianceInput): ComplianceReport {
  const resumeText = (input.resumeText && String(input.resumeText).trim())
    ? String(input.resumeText)
    : (input.profile ? buildResumeBlob(input.profile) : '');
  const source: 'profile' | 'text' = (input.resumeText && String(input.resumeText).trim()) ? 'text' : 'profile';

  if (!resumeText.trim()) {
    return {
      ok: false, score: 0, grade: '缺失', source,
      summary: '未检测到简历内容：请先在「我的档案」填写信息，或传入简历文本。',
      issues: [{ severity: 'high', rule: '内容', message: '简历为空', suggestion: '在「我的档案」补全姓名/学校/专业/技能/经历/项目后再体检。' }],
      stats: emptyStats(),
    };
  }

  const issues: ComplianceIssue[] = [];
  const t = resumeText;

  // 1) 联系方式完整性（15）
  const hp = hasPhone(t), he = hasEmail(t);
  let contactScore = 0;
  if (hp && he) contactScore = 15;
  else if (hp || he) { contactScore = 7; issues.push({ severity: 'medium', rule: '联系方式', message: !hp ? '缺少手机号' : '缺少邮箱', suggestion: 'ATS 与 HR 常通过电话/邮箱联系，建议补全「手机 + 邮箱」两项。' }); }
  else { contactScore = 0; issues.push({ severity: 'high', rule: '联系方式', message: '手机与邮箱均缺失', suggestion: '务必在简历顶部提供手机号与邮箱，否则 HR 无法联系你。' }); }

  // 2) 章节完整性（20）
  const sections: string[] = [], missing: string[] = [];
  for (const r of SECTION_RULES) {
    if (r.re.test(t)) sections.push(r.key); else missing.push(r.key);
  }
  const sectionScore = Math.min(20, sections.length * 5);
  if (missing.length) issues.push({
    severity: missing.length >= 3 ? 'high' : 'medium', rule: '章节结构',
    message: `缺少章节：${missing.join('、')}`,
    suggestion: 'ATS 按固定章节抓取，建议至少包含「教育背景 / 工作与实习经历 / 技能 / 项目经历」四个板块。',
  });

  // 3) 篇幅（15）
  const chars = t.replace(/\s/g, '').length;
  let lengthScore = 0, lengthMsg = '';
  if (chars < 300) { lengthScore = 5; lengthMsg = `内容偏短（约 ${chars} 字）`; }
  else if (chars <= 1500) { lengthScore = 15; }
  else { lengthScore = 10; lengthMsg = `内容偏长（约 ${chars} 字）`; }
  if (lengthMsg) issues.push({ severity: chars < 300 ? 'high' : 'low', rule: '篇幅', message: lengthMsg, suggestion: '建议控制在 1-2 页（约 600-1500 字）：过短信息不足，过长关键内容易被淹没。' });

  // 4) JD 关键词命中（25）
  let kwHit = 0, kwTotal = 0, kwScore = 10;
  if (input.jd && String(input.jd).trim()) {
    const jdTokens = tokenize(String(input.jd));
    kwTotal = Math.min(jdTokens.length, 60); // 取前 60 个 JD token 作为匹配目标，避免长 JD 稀释
    const resumeTokens = new Set(tokenize(t));
    kwHit = jdTokens.slice(0, 60).filter((tk) => resumeTokens.has(tk)).length;
    kwScore = kwTotal ? Math.min(25, Math.round((kwHit / kwTotal) * 25)) : 10;
    const pct = kwTotal ? Math.round((kwHit / kwTotal) * 100) : 0;
    if (pct < 40) issues.push({
      severity: 'medium', rule: '关键词匹配',
      message: `与 JD 关键词重合度偏低（${pct}%）`,
      suggestion: 'ATS 按 JD 关键词筛人：在简历中自然地嵌入岗位要求的核心技能/工具名词（不要堆砌），提升初筛通过率。',
    });
  } else {
    issues.push({ severity: 'low', rule: '关键词匹配', message: '未提供 JD，跳过关键词命中评估', suggestion: '在体检时附上目标岗位 JD，可评估与岗位的契合度并给出改投建议。' });
  }

  // 5) 量化经历（10）
  const quantified = /(\d+%|\d+\+?\s*(个|项|年|月|人|次|万|k|w|倍|万?元|万元)|增长|提升|降低|节约|负责\s*\d|主导\s*\d)/.test(t);
  const quantScore = quantified ? 10 : 4;
  if (!quantified) issues.push({ severity: 'medium', rule: '量化成果', message: '经历中缺少量化成果', suggestion: '用数字说话：如「负责 3 个模块」「性能提升 40%」「服务 2 万+ 用户」，比形容词更有说服力。' });

  // 6) 格式卫生（15）
  let fmtScore = 15;
  const hasEmoji = EMOJI_RE.test(t);
  const hasTable = TABLE_RE.test(t);
  const hasAllCaps = ALLCAPS_RE.test(t);
  if (hasEmoji) { fmtScore -= 5; issues.push({ severity: 'medium', rule: '格式卫生', message: '简历含 emoji/特殊符号', suggestion: 'ATS 解析 emoji 不稳定，且显得不专业，建议移除。' }); }
  if (hasTable) { fmtScore -= 5; issues.push({ severity: 'medium', rule: '格式卫生', message: '简历含表格（| 分隔）', suggestion: '部分 ATS 无法解析表格，关键信息可能丢失；改用纯文本列表呈现。' }); }
  if (hasAllCaps) { fmtScore -= 3; issues.push({ severity: 'low', rule: '格式卫生', message: '存在全大写标题', suggestion: '避免大段全大写标题，ATS 与阅读体验都不友好。' }); }
  fmtScore = Math.max(0, fmtScore);

  const score = Math.max(0, Math.min(100, contactScore + sectionScore + lengthScore + kwScore + quantScore + fmtScore));
  const grade = score >= 80 ? '优秀' : score >= 60 ? '良好' : score >= 40 ? '一般' : '偏弱';

  const summary = `简历合规体检得分 ${score}/100（${grade}）。联系方式${hp && he ? '完整' : '待补'}｜章节 ${sections.length}/4｜篇幅 ${chars} 字｜关键词命中 ${kwTotal ? kwHit + '/' + kwTotal : '未评估'}｜量化成果 ${quantified ? '有' : '缺'}｜格式 ${fmtScore < 15 ? '有风险' : '干净'}。`;

  return {
    ok: true, score, grade, summary, issues, source,
    stats: { charCount: chars, hasPhone: hp, hasEmail: he, sections, missingSections: missing, keywordHit: kwHit, keywordTotal: kwTotal, quantified, hasEmoji, hasTable, hasAllCaps },
  };
}

function emptyStats(): ComplianceStats {
  return { charCount: 0, hasPhone: false, hasEmail: false, sections: [], missingSections: ['教育', '工作/实习经历', '技能', '项目'], keywordHit: 0, keywordTotal: 0, quantified: false, hasEmoji: false, hasTable: false, hasAllCaps: false };
}
