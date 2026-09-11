/**
 * HR 消息自动回复 —— 可调用运行器（供后端 API 与命令行脚本共用）
 *
 * 流程：进聊天页 → 列会话 → 逐一打开 → 读最新 HR 消息 → 意图识别 → 生成回复
 * →（预览模式仅生成 / 真实模式发送文本或简历）→ 落库去重。
 *
 * 平台无关的意图识别 + 话术生成在 autoReply.ts；平台相关的浏览器操作收敛到
 * ChatDriver（bossChat.ts / liepinChat.ts ...）。本运行器只依赖 ChatDriver 接口，
 * 新增平台 = 在 DRIVERS 表登记一个 driver，引擎零改动。
 *
 * emit 回调把每一步变成事件，便于后端用 SSE 推给控制台实时展示。
 */

import type { ApplyPlatform } from './types.js';
import type { ChatDriver } from './chatTypes.js';
import { bossChatDriver } from './bossChat.js';
import { liepinChatDriver } from './liepinChat.js';
import { decide, composeReplyWithAi } from './autoReply.js';
import { getConversation, upsertConversation, getProfile } from '../../db.js';

/** 支持自动回复的平台 → 对应聊天驱动 */
const DRIVERS: Partial<Record<ApplyPlatform, ChatDriver>> = {
  boss: bossChatDriver,
  liepin: liepinChatDriver,
};

export function getChatDriver(platform: ApplyPlatform): ChatDriver | null {
  return DRIVERS[platform] || null;
}

export interface ReplyEvent {
  type:
    | 'start'
    | 'list'
    | 'conv'
    | 'skipped'
    | 'intent'
    | 'dry'
    | 'send-resume'
    | 'send-text'
    | 'sent'
    | 'aborted'
    | 'done'
    | 'error';
  [k: string]: unknown;
}

export interface RunAutoReplyOpts {
  /** 只处理未读会话（默认 true） */
  unreadOnly?: boolean;
  /** 处理上限，0 = 全部 */
  limit?: number;
  /** 是否真实发送（false = 仅预览生成回复） */
  realSend?: boolean;
  /** 只处理指定 HR 名（命令行用） */
  names?: string[];
  /** 是否用大模型生成话术（默认 true；未配置 LLM_* 时自动回退规则） */
  useAi?: boolean;
  /** 停止信号 */
  signal?: AbortSignal;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runAutoReply(
  platform: ApplyPlatform,
  opts: RunAutoReplyOpts,
  emit: (ev: ReplyEvent) => void,
): Promise<{ sent: number; skipped: number }> {
  const { unreadOnly = true, limit = 0, realSend = false, names = [], signal, useAi = true } = opts;

  const driver = getChatDriver(platform);
  if (!driver) {
    emit({ type: 'error', message: `平台 ${platform} 暂不支持自动回复（目前仅 boss / liepin）` });
    return { sent: 0, skipped: 0 };
  }

  emit({ type: 'start', platform, unreadOnly, limit, realSend });

  // 进对应平台聊天页（依赖该平台已登录的养熟标签）
  await driver.openChat();
  if (signal?.aborted) return { sent: 0, skipped: 0 };

  const convs = await driver.listConversations();
  let targets = unreadOnly ? convs.filter((c) => c.unread) : convs;
  if (names.length) targets = targets.filter((c) => names.includes(c.name));
  const limited = limit > 0 ? targets.slice(0, limit) : targets;
  emit({
    type: 'list',
    platform,
    total: convs.length,
    unread: convs.filter((c) => c.unread).length,
    will: limited.length,
  });
  if (convs.length === 0) {
    emit({ type: 'skipped', reason: 'empty-list', platform });
  }

  let sent = 0;
  let skipped = 0;

  for (const c of limited) {
    if (signal?.aborted) {
      emit({ type: 'aborted' });
      break;
    }
    emit({ type: 'conv', name: c.name, company: c.company, lastMsg: c.lastMsg });

    const ok = await driver.openConversation(c.key);
    if (!ok) {
      emit({ type: 'skipped', reason: 'open-failed', name: c.name });
      skipped++;
      continue;
    }
    const read = await driver.readConversation();
    const lastHr = read.lastHr;
    const history = read.messages || [];
    if (!lastHr) {
      emit({ type: 'skipped', reason: 'no-hr', name: c.name });
      skipped++;
      continue;
    }
    const conv = getConversation(c.key);
    if (conv && conv.last_hr_message === lastHr) {
      emit({ type: 'skipped', reason: 'processed', name: c.name });
      skipped++;
      continue;
    }
    const round = conv ? (conv.round || 0) + 1 : 1;
    // 求职者档案（用于填充话术，如姓名/电话/学历；来自全局 profile 表）
    const profRow = getProfile() as Record<string, unknown> | undefined;
    const profile = profRow
      ? {
          name: (profRow.name as string) || null,
          phone: (profRow.phone as string) || null,
          education: (profRow.education as string) || null,
          major: (profRow.major as string) || null,
        }
      : undefined;
    const decision = decide(lastHr, { hrName: c.name, company: c.company, round, profile });

    // 话术生成：默认优先大模型（useAi + 已配置 LLM_*），否则回退规则模板
    let reply = decision.reply;
    let aiSource: 'ai' | 'rule' = 'rule';
    if (useAi && decision.shouldReply && decision.reply) {
      const r = await composeReplyWithAi(decision.intent, { hrName: c.name, company: c.company, round, profile }, lastHr, history);
      reply = r.text;
      aiSource = r.source;
    }
    emit({
      type: 'intent',
      name: c.name,
      platform,
      intent: decision.intent,
      reply,
      ai: aiSource,
      round,
      stop: decision.stopReason || '',
    });

    if (!realSend) {
      emit({ type: 'dry', name: c.name, reply, ai: aiSource });
      continue;
    }

    let done = false;
    if (decision.intent === 'ask_resume') {
      const r = await driver.sendResume();
      emit({ type: 'send-resume', name: c.name, ok: r });
      done = done || r;
    }
    if (reply) {
      const s = await driver.sendText(reply);
      emit({ type: 'send-text', name: c.name, ok: s, ai: aiSource });
      done = done || s;
    }

    if (done) {
      upsertConversation({
        conv_key: c.key,
        platform,
        hr_name: c.name,
        company: c.company,
        stage: decision.stopReason ? 'done' : 'active',
        last_hr_message: lastHr,
        last_reply: reply,
        last_hr_message_at: new Date().toISOString(),
        last_replied_at: new Date().toISOString(),
        round,
      });
      sent++;
      emit({ type: 'sent', name: c.name, ai: aiSource });
    } else {
      emit({ type: 'skipped', reason: 'send-failed', name: c.name });
      skipped++;
    }
    await sleep(500);
  }

  emit({ type: 'done', platform, sent, skipped });
  return { sent, skipped };
}
