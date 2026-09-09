/**
 * 求职信 / HR 复聊 文案生成（对标职得鸭「文案撰写」）
 * ─────────────────────────────────────────────────────────────
 * 优先级：
 *   1) 本地 LLM（aiClient，读 LLM_BASE_URL/LLM_MODEL）—— 按 JD/公司/岗位生成个性化内容
 *   2) 远程 AI 文案端点 AI_LETTER_ENDPOINT（兼容早期「职得鸭远程 /api/ai/letter」约定）
 *   3) 模板文案兜底 —— 保证「全套」功能在不接 AI 时也能跑通
 */
import type { PlatformKey } from './platforms.js';
import { chatText } from './aiClient.js';

export interface LetterRequest {
  platform: PlatformKey;
  jd?: string;
  chatHistory?: string;
  company?: string | null;
  position?: string | null;
}

function defaultGreeting(req: LetterRequest): string {
  const pos = req.position || '该岗位';
  const com = req.company || '贵公司';
  if (req.chatHistory) {
    return `您好，感谢您的回复。我对${com}「${pos}」依然非常感兴趣，我的专业与实习/项目经历与该岗位匹配度较高，方便的话希望能进一步沟通，盼复，谢谢！`;
  }
  return `您好，我对${com}的「${pos}」很感兴趣，专业对口、相关实习/项目经历匹配，简历已附上，期待进一步沟通，谢谢！`;
}

const SYSTEM = `你是求职文案助手，擅长为招聘平台（BOSS直聘/猎聘等）写自然、简洁、不套路的招呼语与复聊回复。
要求：口语化、1-3 句、不堆砌关键词、不编造简历中没有的经历；像真人求职者在和 HR 聊天。`;

function buildPrompt(req: LetterRequest): string {
  const com = req.company || '贵公司';
  const pos = req.position || '该岗位';
  const jd = (req.jd || '').trim();
  if (req.chatHistory) {
    return `【HR 与我的历史聊天】
${req.chatHistory}

【目标公司与岗位】${com} ｜ ${pos}
${jd ? `【岗位 JD】\n${jd}\n` : ''}
请写一句话回复 HR（承接上文、表达诚意、可自然引出简历/沟通），不要标题、不要引号。`;
  }
  return `【目标公司与岗位】${com} ｜ ${pos}
${jd ? `【岗位 JD】\n${jd}\n` : ''}
请写一句发给 HR 的初次招呼语（表达兴趣 + 简要匹配点，引导对方看简历/进一步沟通），不要标题、不要引号。`;
}

export async function writeLetter(req: LetterRequest): Promise<string> {
  const fallback = defaultGreeting(req);

  // 1) 本地 LLM（主路径）
  const prompt = buildPrompt(req);
  const ai = await chatText(prompt, SYSTEM, { temperature: 0.8, timeoutMs: 25000 });
  if (ai && ai.trim()) return ai.trim().replace(/^["'「]|["'」]$/g, '');

  // 2) 远程 AI 文案端点（兼容早期职得鸭远程约定）
  try {
    const endpoint = process.env.AI_LETTER_ENDPOINT;
    if (endpoint) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const data = (await res.json().catch(() => null)) as any;
        const text = typeof data === 'string' ? data : data?.text || data?.content;
        if (text && String(text).trim()) return String(text).trim();
      }
    }
  } catch {
    /* 忽略，走兜底 */
  }

  // 3) 模板兜底
  return fallback;
}
