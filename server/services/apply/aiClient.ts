/**
 * 统一的 OpenAI 兼容 LLM 客户端
 * ─────────────────────────────────────────────────────────────
 * 对标「职得鸭」的 AI 能力（智能匹配 / 文案撰写）所需的底层大模型调用。
 * 兼容任意 OpenAI 兼容网关：OpenAI、DeepSeek、SiliconFlow、通义、智谱、Groq、
 * 以及本地 Ollama（http://127.0.0.1:11434/v1）等。
 *
 * 配置（环境变量，三者齐备才启用 AI；否则所有方法返回 null，调用方必须回退）：
 *   LLM_BASE_URL : 网关地址，如 https://api.openai.com/v1 或 http://127.0.0.1:11434/v1
 *   LLM_API_KEY  : 可选（本地 Ollama 不需要）
 *   LLM_MODEL    : 模型名，如 gpt-4o-mini / deepseek-chat / qwen2.5:7b
 *
 * 设计原则：所有方法「软失败」——网络/配置问题一律返回 null，绝不让上层投递链路崩溃。
 */

export interface AiClientConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
}

/** 读取并校验 AI 配置；未配置或不全则返回 null */
export function getAiConfig(): AiClientConfig | null {
  const baseUrl = (process.env.LLM_BASE_URL || '').trim().replace(/\/$/, '');
  const model = (process.env.LLM_MODEL || '').trim();
  if (!baseUrl || !model) return null;
  return { baseUrl, apiKey: (process.env.LLM_API_KEY || '').trim() || undefined, model };
}

/** 是否启用了 AI（供 UI 提示） */
export function isAiEnabled(): boolean {
  return getAiConfig() !== null;
}

/** 纯文本补全 */
export async function chatText(
  prompt: string,
  system?: string,
  opts?: { temperature?: number; timeoutMs?: number },
): Promise<string | null> {
  const cfg = getAiConfig();
  if (!cfg) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? 30000);
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: opts?.temperature ?? 0.7,
        messages: [
          ...(system ? [{ role: 'system' as const, content: system }] : []),
          { role: 'user' as const, content: prompt },
        ],
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as any;
    const txt: unknown = data?.choices?.[0]?.message?.content;
    return typeof txt === 'string' ? txt.trim() : null;
  } catch {
    return null;
  }
}

/** JSON 结构化补全（自动剥离 ```json``` 包裹、截取首尾花括号） */
export async function chatJSON<T = any>(
  prompt: string,
  system?: string,
  opts?: { temperature?: number; timeoutMs?: number },
): Promise<T | null> {
  const text = await chatText(
    prompt,
    system || '你是一个严谨的 JSON 输出器。只输出 JSON，不要任何额外解释、不要代码块标记。',
    { temperature: opts?.temperature ?? 0.2, timeoutMs: opts?.timeoutMs },
  );
  if (!text) return null;
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim();
  }
  const s = cleaned.indexOf('{');
  const e = cleaned.lastIndexOf('}');
  if (s >= 0 && e > s) cleaned = cleaned.slice(s, e + 1);
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}
