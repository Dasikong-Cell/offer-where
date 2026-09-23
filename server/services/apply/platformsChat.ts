/**
 * 其余平台的聊天驱动实例（基于 genericChatDriver.ts 配置化工厂）。
 *
 * ⚠️ 重要：本文件内 7 个 Web IM 平台驱动均为「启发式基线」（calibrated:false）。
 * 各平台 IM 的真实 DOM class 必须真机校准 —— 跑 `tsx scripts/probe_chat.ts <platform>`
 * dump 出列表项 / 消息气泡的真实 class 与文本，再把实测选择器回填到对应 config 并置
 * calibrated:true，方可用于生产自动回复。校准前引擎不会误发（消息侧判定未知则跳过、不回），
 * 但也不会真正回复，直到选择器对齐。
 *
 * offerbiu（牛客/OfferBiu 邮箱直投通道）不在此列：其 HR 沟通走**邮件**而非 Web IM，
 * 由 offerbiu-email-direct-apply 流程处理，本自动回复引擎不驱动它（故意不登记）。
 *
 * 已登记平台（autoReplyRunner.DRIVERS）：boss / liepin / zhilian / job51 / nowcoder /
 * iguopin / yupao / chinahr / yingjiesheng。
 */

import { buildChatDriver, type ChatDriverConfig } from './genericChatDriver.js';
import type { ChatDriver } from './chatTypes.js';

/**
 * 通用启发式选择器（覆盖大多数 React/Vue 招聘 IM 的常见结构）。
 * 各平台在下面按需覆盖；未覆盖项沿用此处。
 */
const H = {
  listItemSelector: '[class*=conversation-item],[class*=chat-item],[class*=contact-item],[class*=session-item],[class*=dialog-item],.conversation-item,.chat-item',
  nameSelector: '[class*=name],[class*=title],[class*=nick],.name,.title,.nick',
  lastMsgSelector: '[class*=last],[class*=message],[class*=msg],[class*=preview],.last-msg,.msg-preview',
  messageSelector: '[class*=message-item],[class*=msg-item],[class*=bubble],[class*=chat-msg],.message-item,.msg-item,.bubble',
  inputSelector: '[class*=chat-input],[class*=editor],[contenteditable],textarea,.chat-input',
  sendSelector: 'button[class*=send],[class*=send-btn],.send-btn',
  resumeToolbarSelector: '[class*=resume],[class*=attach],[title*=简历],[aria-label*=简历]',
  entryTextRe: '消息|沟通|聊天|私信|IM',
};

function cfg(p: Partial<ChatDriverConfig> & { platform: string; chatUrl: string }): ChatDriverConfig {
  return {
    listItemSelector: H.listItemSelector,
    nameSelector: H.nameSelector,
    lastMsgSelector: H.lastMsgSelector,
    messageSelector: H.messageSelector,
    inputSelector: H.inputSelector,
    sendSelector: H.sendSelector,
    resumeToolbarSelector: H.resumeToolbarSelector,
    entryTextRe: H.entryTextRe,
    calibrated: false,
    ...p,
  } as ChatDriverConfig;
}

// ── 智联招聘 ──
export const zhilianChatDriver: ChatDriver = buildChatDriver(cfg({
  platform: 'zhilian',
  chatUrl: 'https://www.zhaopin.com/',
  // 智联 IM 多为首页浮层，入口按文本点
}));

// ── 前程无忧 51job ──
export const job51ChatDriver: ChatDriver = buildChatDriver(cfg({
  platform: 'job51',
  chatUrl: 'https://www.51job.com/',
}));

// ── 牛客网（IM 独立页 /im）──
export const nowcoderChatDriver: ChatDriver = buildChatDriver(cfg({
  platform: 'nowcoder',
  chatUrl: 'https://www.nowcoder.com/im',
  entryTextRe: '消息|私信|IM',
}));

// ── 国聘 ──
export const iguopinChatDriver: ChatDriver = buildChatDriver(cfg({
  platform: 'iguopin',
  chatUrl: 'https://www.iguopin.com/',
}));

// ── 鱼泡网（蓝领，Web IM）──
export const yupaoChatDriver: ChatDriver = buildChatDriver(cfg({
  platform: 'yupao',
  chatUrl: 'https://www.yupao.com/',
}));

// ── 中华英才网 ──
export const chinahrChatDriver: ChatDriver = buildChatDriver(cfg({
  platform: 'chinahr',
  chatUrl: 'https://www.chinahr.com/',
}));

// ── 应届生（yingjiesheng）──
export const yingjieshengChatDriver: ChatDriver = buildChatDriver(cfg({
  platform: 'yingjiesheng',
  chatUrl: 'https://www.yingjiesheng.com/',
}));

/** 全部 Web IM 平台驱动（用于批量登记；offerbiu 邮件通道不在此） */
export const PLATFORM_CHAT_DRIVERS: ChatDriver[] = [
  zhilianChatDriver,
  job51ChatDriver,
  nowcoderChatDriver,
  iguopinChatDriver,
  yupaoChatDriver,
  chinahrChatDriver,
  yingjieshengChatDriver,
];
