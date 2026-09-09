/**
 * BOSS HR 消息自动回复 —— 可调用运行器（供后端 API 与命令行脚本共用）
 *
 * 流程与 server/services/apply/autoReply.ts 的纯逻辑、server/services/apply/bossChat.ts 的
 * 浏览器操作组合：进聊天页 → 列会话 → 逐一打开 → 读最新 HR 消息 → 意图识别 → 生成回复
 * →（预览模式仅生成 / 真实模式发送文本或简历）→ 落库去重。
 *
 * emit 回调把每一步变成事件，便于后端用 SSE 推给控制台实时展示。
 */

import {
  openChat,
  listConversations,
  openConversation,
  readConversation,
  sendText,
  sendResume,
} from './bossChat.js';
import { decide } from './autoReply.js';
import { getConversation, upsertConversation } from '../../db.js';

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
  /** 停止信号 */
  signal?: AbortSignal;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runAutoReply(
  opts: RunAutoReplyOpts,
  emit: (ev: ReplyEvent) => void,
): Promise<{ sent: number; skipped: number }> {
  const { unreadOnly = true, limit = 0, realSend = false, names = [], signal } = opts;

  emit({ type: 'start', unreadOnly, limit, realSend });

  // 进 BOSS 聊天页（依赖 boss 端口已登录的养熟标签）
  await openChat();
  if (signal?.aborted) return { sent: 0, skipped: 0 };

  const convs = await listConversations();
  let targets = unreadOnly ? convs.filter((c) => c.unread) : convs;
  if (names.length) targets = targets.filter((c) => names.includes(c.name));
  const limited = limit > 0 ? targets.slice(0, limit) : targets;
  emit({
    type: 'list',
    total: convs.length,
    unread: convs.filter((c) => c.unread).length,
    will: limited.length,
  });

  let sent = 0;
  let skipped = 0;

  for (const c of limited) {
    if (signal?.aborted) {
      emit({ type: 'aborted' });
      break;
    }
    emit({ type: 'conv', name: c.name, company: c.company, lastMsg: c.lastMsg });

    const ok = await openConversation(c.key);
    if (!ok) {
      emit({ type: 'skipped', reason: 'open-failed', name: c.name });
      skipped++;
      continue;
    }
    const { lastHr } = await readConversation();
    if (!lastHr) {
      emit({ type: 'skipped', reason: 'no-hr', name: c.name });
      skipped++;
      continue;
    }
    const db = getConversation(c.key);
    if (db && db.last_hr_message === lastHr) {
      emit({ type: 'skipped', reason: 'processed', name: c.name });
      skipped++;
      continue;
    }
    const round = db ? (db.round || 0) + 1 : 1;
    const decision = decide(lastHr, { hrName: c.name, company: c.company, round });
    emit({
      type: 'intent',
      name: c.name,
      intent: decision.intent,
      reply: decision.reply,
      round,
      stop: decision.stopReason || '',
    });

    if (!realSend) {
      emit({ type: 'dry', name: c.name, reply: decision.reply });
      continue;
    }

    let done = false;
    if (decision.intent === 'ask_resume') {
      const r = await sendResume();
      emit({ type: 'send-resume', name: c.name, ok: r });
      done = done || r;
    }
    if (decision.reply) {
      const s = await sendText(decision.reply);
      emit({ type: 'send-text', name: c.name, ok: s });
      done = done || s;
    }

    if (done) {
      upsertConversation({
        conv_key: c.key,
        platform: 'boss',
        hr_name: c.name,
        company: c.company,
        stage: decision.stopReason ? 'done' : 'active',
        last_hr_message: lastHr,
        last_reply: decision.reply,
        last_hr_message_at: new Date().toISOString(),
        last_replied_at: new Date().toISOString(),
        round,
      });
      sent++;
      emit({ type: 'sent', name: c.name });
    } else {
      emit({ type: 'skipped', reason: 'send-failed', name: c.name });
      skipped++;
    }
    await sleep(500);
  }

  emit({ type: 'done', sent, skipped });
  return { sent, skipped };
}
