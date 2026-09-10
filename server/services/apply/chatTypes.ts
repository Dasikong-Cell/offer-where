/**
 * HR 消息自动回复 —— 跨平台「聊天驱动」抽象
 *
 * 各招聘平台的 IM 聊天 DOM 差异很大（BOSS / 猎聘 / 智联…），但自动回复引擎
 * （server/services/apply/autoReply.ts 的意图识别 + 话术生成）是平台无关的。
 * 这里把「浏览器层面的聊天操作」收敛成一个统一接口 ChatDriver，
 * 让 runAutoReply 只依赖接口、不依赖具体平台。
 *
 * 新增平台自动回复 = 写一个实现 ChatDriver 的模块（如 bossChat.ts / liepinChat.ts），
 * 再到 autoReplyRunner.ts 的驱动表里登记即可，引擎零改动。
 */

export interface ConvSummary {
  /** 会话唯一键（含平台/HR名/公司，用于去重与再次打开） */
  key: string;
  name: string;
  company: string;
  lastMsg: string;
  unread: boolean;
  raw: string;
}

export interface ParsedMessage {
  side: 'hr' | 'me';
  text: string;
}

export interface ChatDriver {
  /** 平台标识（boss / liepin / zhilian ...） */
  platform: string;
  /** 进入对应平台的聊天/消息页（依赖该平台已登录的养熟 CDP 标签） */
  openChat(): Promise<void>;
  /** 列出当前所有会话（含未读标记） */
  listConversations(): Promise<ConvSummary[]>;
  /** 按 key 打开某个会话；返回是否打开成功 */
  openConversation(key: string): Promise<boolean>;
  /** 读取当前会话全部消息，区分 HR / 我，返回最新一条 HR 消息 */
  readConversation(): Promise<{ messages: ParsedMessage[]; lastHr: string }>;
  /** 在输入框输入并发送纯文本 */
  sendText(text: string): Promise<boolean>;
  /** 发送简历附件（在线简历 / 已导入的本地 PDF） */
  sendResume(): Promise<boolean>;
}
