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
import { decide, composeReplyWithAi, isPositionRelated, parsePositions } from './autoReply.js';
import { getConversation, upsertConversation, getProfile, listJobs } from '../../db.js';
import { tryAcquire, release } from './sessionLock.js';

/** 默认 AI 助手名（标记「这是 AI 回复」用） */
const DEFAULT_AI_NAME = '懒懒';

/**
 * 根据公司名从岗位库推断「HR 发布的职位」。
 * 我们投递时记录了公司+岗位，故按公司反查最可靠；查不到（HR 主动找来、库里无对应岗位）返回 null。
 */
function resolveHrPosition(company: string | null, platform: string): string | null {
  if (!company) return null;
  const jobs = listJobs({ source: platform });
  const norm = (s: string) => (s || '').replace(/\s+/g, '').toLowerCase();
  const nc = norm(company);
  if (!nc) return null;
  const hit = jobs.find((j) => {
    const jc = norm(j.company || '');
    if (!jc) return false;
    return jc.includes(nc) || nc.includes(jc);
  });
  return hit?.position || null;
}

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
  /** AI 助手名（标记「这是 AI 回复」用，默认「懒懒」） */
  aiName?: string;
  /** 是否在回复中署名 AI 身份（如「【懒懒】」，默认 true） */
  signAi?: boolean;
  /** 目标职位（逗号分隔）；非空时 HR 发布的职位不相关则不回复 */
  targetPositions?: string[];
  /** 两次发送之间的最小间隔（秒），防风控；默认 45 */
  throttleSec?: number;
  /** 单轮最多发送条数，0 = 不限制；默认 20 */
  maxPerRun?: number;
  /** 同一 HR 两次自动回复的最小冷却（秒）；其对话 last_replied_at 在冷却内则跳过；默认 3600 */
  hrCooldownSec?: number;
  /** 停止信号 */
  signal?: AbortSignal;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runAutoReply(
  platform: ApplyPlatform,
  opts: RunAutoReplyOpts,
  emit: (ev: ReplyEvent) => void,
): Promise<{ sent: number; skipped: number }> {
  const {
    unreadOnly = true,
    limit = 0,
    realSend = false,
    names = [],
    signal,
    useAi = true,
    throttleSec = 45,
    maxPerRun = 20,
    hrCooldownSec = 3600,
  } = opts;

  // 档案中的 AI 身份与职位偏好（CLI 未显式传时从全局 profile 取）
  const profRow = getProfile() as Record<string, unknown> | undefined;
  const aiName: string =
    opts.aiName || (profRow && typeof profRow.aiName === 'string' && profRow.aiName.trim() ? profRow.aiName.trim() : DEFAULT_AI_NAME);
  const signAi: boolean =
    opts.signAi !== undefined ? opts.signAi : (profRow && typeof profRow.signAi === 'boolean' ? profRow.signAi : true);
  const targets: string[] =
    opts.targetPositions && opts.targetPositions.length
      ? opts.targetPositions
      : parsePositions(profRow?.expectedPositions);

  const driver = getChatDriver(platform);
  if (!driver) {
    emit({ type: 'error', message: `平台 ${platform} 暂不支持自动回复（目前仅 boss / liepin）` });
    return { sent: 0, skipped: 0 };
  }

  emit({ type: 'start', platform, unreadOnly, limit, realSend });

  // 会话独占锁：同一平台同一时刻只允许「投递」或「回复」之一占用浏览器，
  // 避免与批量投递 / 后台投递监视器互抢同一 CDP 标签（否则页面互相冲掉、重复投/漏投）。
  const lockHolder = 'reply';
  if (!tryAcquire(platform, lockHolder)) {
    emit({ type: 'error', message: `平台 ${platform} 正被其他自动化（投递）占用，本次自动回复跳过，待其释放后下一轮再试` });
    return { sent: 0, skipped: 0 };
  }

  try {
  // 进对应平台聊天页（依赖该平台已登录的养熟标签）
  await driver.openChat();
  if (signal?.aborted) return { sent: 0, skipped: 0 };

  const convs = await driver.listConversations();
  // 2026-09-14：检测加固。
  // 旧逻辑只认「未读标记」——未读红点 class 名对不上、或会话已读但 HR 新消息没回，都会被漏掉。
  // 现改为：unreadOnly 时，凡满足以下任一即纳入处理：
  //   1) 列表项本身标记为未读；
  //   2) DB 里从未处理过该会话（新会话，宁可多查）；
  //   3) 列表末条 lastMsg 与 DB 已记录的「最后 HR 消息 / 我的回复」都不一致 —— 说明有新的 HR 活动。
  // 由于 readConversation 之后还有 last_hr_message 精确去重（已回过的同一条不再回），
  // 放宽此处前置过滤不会造成重复回复，只会让「漏检的未读 / 已读未回」被及时补上。
  let convTargets = unreadOnly
    ? convs.filter((c) => {
        if (c.unread) return true;
        const rec = getConversation(c.key);
        if (!rec) return true;
        const lastHr = String(rec.last_hr_message || '');
        const lastReply = String(rec.last_reply || '');
        return (
          !!c.lastMsg &&
          !lastHr.startsWith(c.lastMsg) &&
          !lastReply.startsWith(c.lastMsg)
        );
      })
    : convs;
  if (names.length) convTargets = convTargets.filter((c) => names.includes(c.name));
  const limited = limit > 0 ? convTargets.slice(0, limit) : convTargets;
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

    // 节流：同一 HR 在冷却期内（默认 1h）不重复自动回复，避免被平台判营销/骚扰
    if (hrCooldownSec > 0) {
      const early = getConversation(c.key);
      const lastReplied = early ? early.last_replied_at : undefined;
      if (lastReplied) {
        const sinceMs = Date.now() - new Date(String(lastReplied)).getTime();
        if (sinceMs < hrCooldownSec * 1000) {
          emit({ type: 'skipped', reason: 'hr-cooldown', name: c.name, sec: Math.round(sinceMs / 1000) });
          skipped++;
          continue;
        }
      }
    }

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
    // 去重双保险：若读到的 HR 末条与「我方已记录的回复」完全相同，说明我方回复被误判为 HR 末条
    // （DOM 角色识别失败），视为已处理直接跳过——否则监视器每轮都会把这条「伪 HR 消息」当新活动
    // 重复发送，造成「一直重复一句话」。
    if (conv && conv.last_reply && lastHr && conv.last_reply.trim() === lastHr.trim()) {
      emit({ type: 'skipped', reason: 'processed', name: c.name });
      skipped++;
      continue;
    }
    if (conv && conv.last_hr_message === lastHr) {
      emit({ type: 'skipped', reason: 'processed', name: c.name });
      skipped++;
      continue;
    }
    const round = conv ? (conv.round || 0) + 1 : 1;
    // HR 发布的职位：优先用聊天窗头部真实职位（.position-name，最准），缺失时按公司反查岗位库
    const hrPosition = (read.position && read.position.trim()) || resolveHrPosition(c.company, platform);
    // 职位相关性过滤：设了目标职位且 HR 发布的职位不相关 → 不回复（避免乱回无关岗位）
    if (targets.length && !isPositionRelated(hrPosition, targets)) {
      emit({ type: 'skipped', reason: 'position-unrelated', name: c.name, position: hrPosition, hrMsg: lastHr.slice(0, 60) });
      skipped++;
      continue;
    }
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
    const decision = decide(lastHr, { hrName: c.name, company: c.company, position: hrPosition, round, profile });

    // 话术生成：默认优先大模型（useAi + 已配置 LLM_*），否则回退规则模板
    let reply = decision.reply;
    let aiSource: 'ai' | 'rule' = 'rule';
    if (useAi && decision.shouldReply && decision.reply) {
      const r = await composeReplyWithAi(decision.intent, { hrName: c.name, company: c.company, position: hrPosition, round, profile }, lastHr, history, { aiName, sign: signAi });
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
      aiName,
      round,
      stop: decision.stopReason || '',
    });

    if (!realSend) {
      emit({ type: 'dry', name: c.name, reply, ai: aiSource, aiName });
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
      emit({ type: 'send-text', name: c.name, ok: s, ai: aiSource, aiName });
      done = done || s;
    }

    if (done) {
      upsertConversation({
        conv_key: c.key,
        platform,
        hr_name: c.name,
        company: c.company,
        position: hrPosition,
        stage: decision.stopReason ? 'done' : 'active',
        last_hr_message: lastHr,
        last_reply: reply,
        last_hr_message_at: new Date().toISOString(),
        last_replied_at: new Date().toISOString(),
        round,
        ai_name: aiName,
        ai_source: aiSource,
      });
      sent++;
      emit({ type: 'sent', name: c.name, ai: aiSource, aiName });
      // 每轮上限：达到即收尾，避免单轮刷太多触发风控
      if (maxPerRun > 0 && sent >= maxPerRun) {
        emit({ type: 'done', platform, sent, skipped, reason: 'cap-reached' });
        return { sent, skipped };
      }
    } else {
      emit({ type: 'skipped', reason: 'send-failed', name: c.name });
      skipped++;
    }
    // 发送间隔节流：上一条真实发送后至少等 throttleSec 秒再处理下一条
    await sleep(Math.max(1, throttleSec) * 1000);
  }

  emit({ type: 'done', platform, sent, skipped });
  return { sent, skipped };
  } finally {
    release(platform, lockHolder);
  }
}
