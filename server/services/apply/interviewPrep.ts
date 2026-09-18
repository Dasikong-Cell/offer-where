/**
 * 面试攻略（对标职得鸭「面试鸭攻略」/ `INTERVIEW_BOT`）
 * ─────────────────────────────────────────────────────────────
 * 输入：目标岗位（JD/公司/职位） + 本人档案（真实经历）
 * 输出：结构化 Markdown 攻略 —— 岗位快照 / 考察重点 / 高概率面试题+答题要点 /
 *      反问面试官的问题 / 自我介绍要点。
 *
 * **防幻觉硬规则**（这是这一类功能最容易翻车的地方）：
 *   1. 公司信息只允许来自 JD 正文；JD 没提的一律写「JD 未提及，建议自行查证」，
 *      **绝不允许编造公司规模、融资、业务线、口碑**。
 *   2. 答题要点只允许引用简历里真实存在的经历；没有可讲的点就显式写
 *      「简历未体现相关经历，建议补充真实经历后再谈」。
 *   3. 不预测"面试必过/一定考这道题"。
 *
 * 结果按 jobId 缓存在 app_kv，`force` 可重算。
 */
import { chatText } from './aiClient.js';
import { kvGetJson, kvSetJson, kvDelete, type JobRow } from '../../db.js';
import { buildResumeBlob } from './resumeTailor.js';

export interface InterviewPrep {
  jobId: string;
  company: string | null;
  position: string | null;
  content: string;
  source: 'llm' | 'fallback';
  createdAt: string;
}

const kvKey = (jobId: string) => `interview:${jobId}`;

export function getInterviewPrep(jobId: string): InterviewPrep | null {
  return kvGetJson<InterviewPrep | null>(kvKey(jobId), null);
}

export function clearInterviewPrep(jobId: string): void {
  kvDelete(kvKey(jobId));
}

const SYSTEM = `你是资深技术面试辅导老师。你为求职者输出「面试攻略」。

必须遵守：
1. 【公司信息】只能使用 JD 正文里出现的内容。JD 未提及的公司规模/融资/业务/口碑，
   一律写"JD 未提及，建议面试前自行查证"，**严禁编造**。
2. 【答题要点】只能引用简历里真实存在的项目/实习/技能。若简历没有对应经历，
   写"简历未体现相关经历，建议补充真实经历后再谈"，**严禁虚构经历或数字**。
3. 不使用"一定能过""必考"这类保证性表述。
4. 输出 Markdown，用二级标题分节；每条内容简短、可执行；全文 600-1000 字。`;

function buildPrompt(job: Partial<JobRow>, resumeBlob: string): string {
  return `请为下面这个岗位生成面试攻略。

【目标公司】${job.company || '（未提供）'}
【目标岗位】${job.position || '（未提供）'}
【工作地点】${job.city || '（未提供）'}
【岗位 JD】
${String(job.jd || '（未提供 JD；请基于职位名给出通用但克制的准备建议，并明确说明信息不足）').slice(0, 4000)}

【求职者简历要点】（只能引用这里的事实）
${resumeBlob.slice(0, 3000) || '（档案未填写）'}

请严格按以下 Markdown 结构输出：

## 岗位快照
- 用 3-5 条概括这个岗位在做什么、看重什么（只依据 JD）

## 考察重点
- 列出 3-6 个该岗位大概率会考察的能力项，每项一句话说明

## 高概率面试题（含答题要点）
- 列 6-10 题；每题下面给 1-3 条答题要点，要点必须能对应到简历里的真实经历
- 若简历没有可讲的经历，明确写出来

## 建议向面试官提问
- 3-5 个能体现你认真研究过岗位的问题

## 60 秒自我介绍要点
- 给出一段可直接照读的要点提纲（不要写成完整作文）`;
}

/** 无 LLM 时的兜底：给结构化清单 + 明确标注"未启用 AI" */
function fallbackPrep(job: Partial<JobRow>, resumeBlob: string): string {
  const pos = job.position || '该岗位';
  const com = job.company || '该公司';
  return [
    `## 岗位快照`,
    `- 目标：${com} ｜ ${pos}${job.city ? ` ｜ ${job.city}` : ''}`,
    `- ${job.jd ? 'JD 已采集，见岗位详情（建议逐条对照准备）' : 'JD 未采集，建议先在岗位页截图留存'}`,
    ``,
    `## 考察重点`,
    `- JD 逐条对照：把每条要求映射到自己的一段真实经历（有则写，无则如实承认）`,
    `- 项目复盘：选 1-2 个与岗位最相关的项目，准备"背景-我的角色-难点-结果"四段式`,
    `- 技术细节：对简历上写过的技术，准备好被追问底层原理`,
    ``,
    `## 高概率面试题（含答题要点）`,
    `- 请介绍一下你自己 → 用简历里的真实经历串成 60 秒`,
    `- 为什么应聘这个岗位 → 说明方向匹配点，不要空夸公司`,
    `- 讲一个你解决过的难题 → 用真实项目，突出你的判断与取舍`,
    `- 你的弱点是什么 → 说真实短板 + 正在采取的具体改进`,
    `- 有其他 offer 吗 → 如实但简短回答`,
    ``,
    `## 建议向面试官提问`,
    `- 这个岗位入职后前三个月的核心目标是什么？`,
    `- 团队目前的技术栈/协作方式是怎样？`,
    `- 这个岗位的成长路径如何？`,
    ``,
    `## 60 秒自我介绍要点`,
    resumeBlob
      ? `- 从简历要点中挑 3 条最能对上 JD 的（技能 / 项目 / 实习），按"我是谁 → 我会什么 → 我想做什么"排列`
      : `- 档案未填写，请先在「我的档案」补充经历后再生成`,
    ``,
    `> 未启用 AI，以上为通用清单。配置 LLM 后可生成针对该 JD 的个性化攻略。`,
  ].join('\n');
}

export interface BuildPrepResult {
  ok: boolean;
  content: string;
  source: 'llm' | 'fallback';
  cached: boolean;
  error?: string;
}

export async function buildInterviewPrep(
  profile: Record<string, any> | null,
  job: Partial<JobRow>,
  opts: { force?: boolean } = {},
): Promise<BuildPrepResult> {
  const jobId = String(job.id || '');
  if (jobId && !opts.force) {
    const cached = getInterviewPrep(jobId);
    if (cached && cached.content) {
      return { ok: true, content: cached.content, source: cached.source, cached: true };
    }
  }

  const resumeBlob = profile ? buildResumeBlob(profile) : '';
  let content = '';
  let source: 'llm' | 'fallback' = 'fallback';

  const ai = await chatText(buildPrompt(job, resumeBlob), SYSTEM, { temperature: 0.5, timeoutMs: 60000 });
  if (ai && ai.trim().length > 80) {
    content = ai.trim();
    source = 'llm';
  } else {
    content = fallbackPrep(job, resumeBlob);
    source = 'fallback';
  }

  const prep: InterviewPrep = {
    jobId,
    company: job.company ?? null,
    position: job.position ?? null,
    content,
    source,
    createdAt: new Date().toISOString(),
  };
  if (jobId) kvSetJson(kvKey(jobId), prep);

  return { ok: true, content, source, cached: false };
}
