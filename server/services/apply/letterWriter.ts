/**
 * 求职信 / HR 复聊 文案生成
 * 优先调用配置的 AI 接口（职得鸭用的是其远程 /api/ai/letter、/api/ai/again）；
 * 未配置或调用失败时回退到模板文案，保证「全套」功能在不接 AI 时也能跑通。
 *
 * 接入真实 AI：设置环境变量 AI_LETTER_ENDPOINT（POST JSON {jd, chatHistory, company, position} → 返回文本）。
 */
import type { PlatformKey } from './platforms.js';

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

export async function writeLetter(req: LetterRequest): Promise<string> {
  const fallback = defaultGreeting(req);
  try {
    const text = await callLLM(req);
    return text && text.trim() ? text.trim() : fallback;
  } catch {
    return fallback;
  }
}

async function callLLM(req: LetterRequest): Promise<string | null> {
  const endpoint = process.env.AI_LETTER_ENDPOINT;
  if (!endpoint) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as any;
    return typeof data === 'string' ? data : data?.text || data?.content || null;
  } catch {
    return null;
  }
}
