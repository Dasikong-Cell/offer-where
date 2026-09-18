/**
 * 求职信（对标职得鸭 type2「AI写求职信」）
 * ─────────────────────────────────────────────────────────────
 * 三种模式：
 *   · ai       —— LLM 按 JD + 简历生成个性化求职信（默认）
 *   · custom   —— 用用户自定义模板，支持变量替换（{职位名称} / {公司名称} …）
 *   · letter   —— 招呼语（短，首轮开口用）
 *
 * **三重去重**（比职得鸭更严，且本地可查）：
 *   ① 台账去重：`cover_letters` 里同一「平台+HR/公司+岗位」已写过 → 跳过
 *   ② 会话去重：HR 已回复 → 不再发模板信（不插播机器人话术）
 *   ③ 岗位去重：该岗位 jobs.skip_reason 已标"已写过求职信" → 跳过
 *
 * 防幻觉硬规则（与 resumeTailor 一致）：不得编造简历里没有的经历、学校、公司、数字。
 */
import { chatText } from './aiClient.js';
import {
  getCoverLetter, saveCoverLetter, coverLetterKey,
  kvGet, kvSet, getJob, updateJob, type JobRow,
} from '../../db.js';

export type LetterKind = 'hello' | 'letter' | 'reply';
export type LetterMode = 'ai' | 'custom';

export interface LetterTemplate {
  name: string;
  content: string;
  updatedAt: string;
}

const TEMPLATE_KV = 'letter:template';

/** 自定义求职信模板（全局一份，与职得鸭一致：「配置自定义求职信」） */
export function getLetterTemplate(): LetterTemplate | null {
  const raw = kvGet(TEMPLATE_KV);
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as LetterTemplate;
    if (!t || typeof t.content !== 'string') return null;
    return t;
  } catch {
    return null;
  }
}

export function saveLetterTemplate(name: string, content: string): LetterTemplate {
  const t: LetterTemplate = { name: name || '未命名模板', content: content || '', updatedAt: new Date().toISOString() };
  kvSet(TEMPLATE_KV, JSON.stringify(t));
  return t;
}

export function clearLetterTemplate(): void {
  kvSet(TEMPLATE_KV, JSON.stringify({ name: '', content: '', updatedAt: new Date().toISOString() }));
}

/** 模板支持的变量（与职得鸭文案一致：「可以使用 {职位名称}、{公司名称} 等变量」） */
export const TEMPLATE_VARIABLES: ReadonlyArray<{ key: string; desc: string }> = [
  { key: '{职位名称}', desc: '目标岗位名称' },
  { key: '{公司名称}', desc: '目标公司名称' },
  { key: '{工作地点}', desc: '岗位所在城市' },
  { key: '{我的姓名}', desc: '档案里的姓名' },
  { key: '{期望岗位}', desc: '档案里的意向岗位' },
  { key: '{最高学历}', desc: '档案里的学历' },
  { key: '{毕业院校}', desc: '档案里的学校' },
];

/** 变量替换；未提供的变量替换为空串（避免把 `{公司名称}` 原样发给 HR） */
export function renderLetterTemplate(tpl: string, vars: Record<string, string | null | undefined>): string {
  let out = String(tpl || '');
  for (const [k, v] of Object.entries(vars)) {
    const key = k.startsWith('{') ? k : `{${k}}`;
    out = out.split(key).join(String(v ?? ''));
  }
  // 兜底：清掉模板里没用上的未知变量占位符，避免泄露 `{xxx}` 字样
  out = out.replace(/\{[^{}\n]{1,12}\}/g, '');
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function varsOf(profile: Record<string, any> | null | undefined, job?: Partial<JobRow> | null): Record<string, string> {
  const p = profile || {};
  return {
    '{职位名称}': String(job?.position || p.expectedPositions || '').slice(0, 40),
    '{公司名称}': String(job?.company || '').slice(0, 40),
    '{工作地点}': String(job?.city || p.city || '').slice(0, 20),
    '{我的姓名}': String(p.name || '').slice(0, 20),
    '{期望岗位}': String(p.expectedPositions || '').slice(0, 40),
    '{最高学历}': String(p.education || '').slice(0, 10),
    '{毕业院校}': String(p.school || '').slice(0, 30),
  };
}

const SYSTEM_LETTER = `你是求职文案助手，为招聘平台（BOSS直聘/猎聘/51job/智联）写"发给 HR 的求职信"。

硬性规则（违反则本次输出作废）：
1. 只能使用【求职者简历要点】里**真实存在**的经历、技能、学校、公司；一律不得编造，不得虚构数字。
2. 不要写"贵司是行业龙头"这类无法验证的空话；不要复述整段 JD。
3. 不要标题、不要 emoji、不要 markdown 记号、不要引号包裹。
4. 求职信（letter）：4-6 句、180-260 字；开头说明应聘岗位，中段用 2-3 个简历里的真实匹配点，结尾表达沟通意愿。
5. 招呼语（hello）：1-2 句、40-70 字，口语化，像真人打招呼。
6. 复聊（reply）：1 句话承接上文，语气自然，不要重复已经说过的内容。`;

export interface ComposeInput {
  platform: string;
  kind?: LetterKind;
  mode?: LetterMode;
  job?: Partial<JobRow> | null;
  jd?: string | null;
  /** 复聊时的历史聊天记录 */
  chatHistory?: string | null;
  hrGroupId?: string | null;
  /** HR 是否已回复（三重去重②） */
  hrReplied?: boolean;
  profile?: Record<string, any> | null;
  /** 自定义模板内容（覆盖全局模板） */
  templateContent?: string | null;
}

export interface ComposeResult {
  ok: boolean;
  content: string;
  source: 'llm' | 'custom' | 'fallback';
  /** 是否因去重而跳过（true 时 content 为空） */
  skipped: boolean;
  skipReason?: string;
  dedupeKey: string;
}

/** 本地兜底文案（AI 未配置 / 调用失败时使用；保证链路不空转） */
function fallbackContent(input: ComposeInput): string {
  const com = input.job?.company || '贵公司';
  const pos = input.job?.position || '该岗位';
  if (input.kind === 'reply') {
    return `您好，感谢回复！我对${com}「${pos}」仍然很感兴趣，方便的话希望能再沟通一下，谢谢！`;
  }
  if (input.kind === 'hello') {
    return `您好，我对${com}的「${pos}」很感兴趣，简历已投，期待和您进一步沟通，谢谢！`;
  }
  return `您好，我应聘${com}的「${pos}」岗位。我的专业方向与岗位要求一致，有相关的项目与实习经历，简历已附，期待有机会详谈，谢谢！`;
}

/**
 * 生成求职信。返回 `skipped: true` 表示因去重被跳过（调用方不应发送、不应计费）。
 */
export async function composeCoverLetter(input: ComposeInput): Promise<ComposeResult> {
  const kind: LetterKind = input.kind || 'letter';
  const dedupeKey = coverLetterKey(input.platform, input.job?.company, input.job?.position, input.hrGroupId);

  // ── 三重去重（仅对「求职信」生效；招呼语/复聊本就该可重复）
  if (kind === 'letter') {
    if (input.hrReplied) {
      return { ok: false, content: '', source: 'fallback', skipped: true, skipReason: 'HR已回复，不插播模板求职信', dedupeKey };
    }
    const existing = getCoverLetter(dedupeKey);
    if (existing) {
      return { ok: false, content: '', source: 'fallback', skipped: true, skipReason: `该岗位/HR 已写过求职信（${existing.created_at.slice(0, 10)}）`, dedupeKey };
    }
    if (input.job?.id) {
      const row = getJob(String(input.job.id));
      if (row?.skip_reason && row.skip_reason.includes('已写过求职信')) {
        return { ok: false, content: '', source: 'fallback', skipped: true, skipReason: '岗位记录已标记「已写过求职信」', dedupeKey };
      }
    }
  }

  // ── 自定义模板模式
  if (input.mode === 'custom') {
    const tpl = input.templateContent ?? getLetterTemplate()?.content ?? '';
    if (tpl.trim()) {
      const rendered = renderLetterTemplate(tpl, varsOf(input.profile, input.job));
      if (rendered) return { ok: true, content: rendered, source: 'custom', skipped: false, dedupeKey };
    }
    // 模板为空 → 落回 AI/兜底，不静默发空信
  }

  // ── AI 生成
  const p = input.profile || {};
  const resumePoints = [p.summary, p.skills, p.experience, p.projects, p.education, p.school, p.major]
    .filter(Boolean).join('\n').slice(0, 3000);
  const com = input.job?.company || '（未提供公司）';
  const pos = input.job?.position || '（未提供岗位）';

  const prompt =
    kind === 'reply'
      ? `【HR 与我的聊天记录】\n${String(input.chatHistory || '').slice(0, 2000)}\n\n【目标】${com} ｜ ${pos}\n【简历要点】\n${resumePoints || '（档案未填写）'}\n\n请写一句回复 HR 的话。`
      : kind === 'hello'
        ? `【目标】${com} ｜ ${pos}\n【岗位 JD】\n${String(input.jd || '（未提供）').slice(0, 2500)}\n【简历要点】\n${resumePoints || '（档案未填写）'}\n\n请写一句给 HR 的招呼语。`
        : `【目标】${com} ｜ ${pos}\n【岗位 JD】\n${String(input.jd || '（未提供）').slice(0, 3000)}\n【简历要点】\n${resumePoints || '（档案未填写）'}\n\n请写一封发给 HR 的求职信。`;

  const ai = await chatText(prompt, SYSTEM_LETTER, { temperature: kind === 'letter' ? 0.7 : 0.85, timeoutMs: 30000 });
  if (ai && ai.trim()) {
    const content = ai.trim().replace(/^["'「『]|["'」』]$/g, '').replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim();
    if (content) return { ok: true, content, source: 'llm', skipped: false, dedupeKey };
  }

  return { ok: true, content: fallbackContent(input), source: 'fallback', skipped: false, dedupeKey };
}

/** 记录「已发送求职信」到台账（供三重去重①），并把 skip_reason 标到岗位行 */
export function markLetterSent(input: {
  platform: string; job?: Partial<JobRow> | null; hrGroupId?: string | null;
  content: string; source?: string;
}): void {
  const key = coverLetterKey(input.platform, input.job?.company, input.job?.position, input.hrGroupId);
  saveCoverLetter({
    dedupe_key: key,
    platform: input.platform,
    company: input.job?.company ?? null,
    position: input.job?.position ?? null,
    job_id: input.job?.id ? String(input.job.id) : null,
    content: input.content,
    source: input.source || 'llm',
  });
  if (input.job?.id) {
    try { updateJob(String(input.job.id), { skip_reason: '已写过求职信' }); } catch { /* 忽略 */ }
  }
}

/** 该岗位/HR 是否已写过求职信（控制台预检用） */
export function letterAlreadySent(platform: string, company?: string | null, position?: string | null, hrGroupId?: string | null): boolean {
  return !!getCoverLetter(coverLetterKey(platform, company, position, hrGroupId));
}
