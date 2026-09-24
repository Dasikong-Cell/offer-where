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

// ── 智联招聘 ──（2026-09-24 真机校准：落点 i.zhaopin.com/im，登录态稳）
export const zhilianChatDriver: ChatDriver = buildChatDriver(cfg({
  platform: 'zhilian',
  chatUrl: 'https://i.zhaopin.com/im',       // 直接进 IM（首页会带 refcode 跳转到此）
  listItemSelector: '.im-session-item',
  nameSelector: '.im-session-item__name',
  companySelector: '.im-session-item__company',
  lastMsgSelector: '.im-session-item__job',  // 列表项的职位/预览行
  messageSelector: '.im-message__bubble',     // 气泡（己方带 --me）
  textSelector: '.im-msg-text',               // 气泡内文本元素
  mineClassRe: 'im-message__bubble--me',      // 己方气泡标记
  hrElse: true,                               // 非己方即 HR（智联 HR 气泡无专属 class）
  systemSelector: '.im-message__time,.im-message__receipt', // 时间戳/回执非真人消息
  inputSelector: 'textarea.im-sender__input',
  sendSelector: '.im-sender__send-btn',
  sendBtnTextRe: '发送',
  calibrated: true,
}));

// ── 前程无忧 51job ──（2026-09-24 校准阻塞：首页已登录，但直跳 i.51job.com 个人中心返回 403 反爬，
//   顶栏无「消息」入口；51job 求职侧 IM 在「我的投递→聊一聊」深链，无独立消息中心 URL 可导航。
//   解决：需人工在浏览器养熟 profile 并定位真实聊天收件箱 URL，再回填 chatUrl/entrySelector。）
export const job51ChatDriver: ChatDriver = buildChatDriver(cfg({
  platform: 'job51',
  chatUrl: 'https://www.51job.com/',
}));

// ── 牛客网（IM 独立页 /im）──（2026-09-24 校准阻塞：profile 未登录，/im 返回 404「页面找不到了」。
//   解决：先在该 profile 登录牛客，再跑探针。）
export const nowcoderChatDriver: ChatDriver = buildChatDriver(cfg({
  platform: 'nowcoder',
  chatUrl: 'https://www.nowcoder.com/im',
  entryTextRe: '消息|私信|IM',
}));

// ── 国聘 ──（2026-09-24 校准阻塞：profile 未登录（页显「登录/注册」）。
//   仅发现 /chat/?a=kefu（客服）非 HR 聊天。解决：先在该 profile 登录国聘，再跑探针。）
export const iguopinChatDriver: ChatDriver = buildChatDriver(cfg({
  platform: 'iguopin',
  chatUrl: 'https://www.iguopin.com/',
}));

// ── 鱼泡网（蓝领，Web IM）──（2026-09-24 校准阻塞：profile 已登录，但顶栏仅 首页/职位/公司/校园/意外险/下载APP/我要招聘，
//   全站无「消息/沟通」入口——鱼泡为蓝领直聘平台，HR 沟通走 APP 而非 Web IM，Web 侧无可驱动的会话列表。
//   建议：本平台自动回复暂不启用（保持 calibrated:false，引擎不会误发，只是不回）。）
export const yupaoChatDriver: ChatDriver = buildChatDriver(cfg({
  platform: 'yupao',
  chatUrl: 'https://www.yupao.com/',
}));

// ── 中华英才网 ──（2026-09-24 校准阻塞：profile 已登录，但点开「杨欣宇」下拉仅 我的简历/退出，全站无「消息」入口，
//   新华英才（58 系）求职侧无独立 Web HR 聊天收件箱。解决：确认是否真有 Web IM，否则同鱼泡处理。）
export const chinahrChatDriver: ChatDriver = buildChatDriver(cfg({
  platform: 'chinahr',
  chatUrl: 'https://www.chinahr.com/',
}));

// ── 应届生（yingjiesheng）──（2026-09-24 校准阻塞：profile 未登录（页显「登录/注册」）。
//   解决：先在该 profile 登录应届生，再跑探针。）
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
