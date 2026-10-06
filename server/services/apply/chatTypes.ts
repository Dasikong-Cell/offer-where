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
  /**
   * 列表级提示：**末条是我方发的**（HR 还没回）。
   *
   * 用途：给引擎一个**廉价的前置判断**。打开一个会话要 3~6s（切页签 + 等渲染 + 读消息），
   * 而「末条是我发的招呼」这类会话打开后必然是 no-hr —— 自动投递每天新建几十个招呼会话，
   * 全量列表里它们占大头。没有这个标志，引擎每轮都要为此白开上百个会话。
   *
   * ⚠️ 非权威：真正判据始终是 `readConversation().lastHr`。本字段只在 unreadOnly 下做**排除**，
   *    且**没有该字段/为 false 时一律保留**（失败方向是「多开一次」，不是「漏回一条」）。
   */
  lastMine?: boolean;
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
  /**
   * 读取当前会话全部消息，区分 HR / 我，返回最新一条 HR 消息与 HR 发布的职位。
   * `resumeRequest`：是否存在**待处理**的平台结构化「请求附件简历」卡片
   * （如 BOSS 的 `我想要一份您的附件简历，您是否同意 / 拒绝 / 同意`、猎聘等同类卡片）——
   * 这类请求必须走卡片上的「同意」按钮，走工具栏「发简历」是另一条路径，卡片会一直挂着。
   * 检测为跨平台通用实现（resumeCard.ts 的 detectResumeRequestClause），凡实现了
   * acceptResumeRequest 的平台都应在 readConversation 里回传此标志。
   */
  readConversation(): Promise<{
    messages: ParsedMessage[];
    lastHr: string;
    position?: string | null;
    resumeRequest?: boolean;
  }>;
  /** 在输入框输入并发送纯文本 */
  sendText(text: string): Promise<boolean>;
  /** 发送简历附件（在线简历 / 已导入的本地 PDF） */
  sendResume(): Promise<boolean>;
  /**
   * 可选能力：处理平台上「请求附件简历」的结构化卡片（点「同意」把简历发出去）。
   * 返回 true = 已成功同意；未实现该能力的平台可省略此方法（引擎会跳过）。
   * ⚠️ 该操作**有真实副作用**（会向 HR 发出简历），只在真实发送模式下调用。
   */
  acceptResumeRequest?(): Promise<boolean>;

  /**
   * 真机校准状态：`false`/缺省 = 启发式基线（选择器未对齐 ⇒ 引擎不会误发，但也不会真正回复）。
   * `true` = 已用本地探针 `probe_chat.ts` 把实测选择器回填过，可用于生产。
   *
   * ⚠️ 与 `autoReplySupported` 是**两回事**，别混：
   *   `calibrated=false`      —— 功能会尝试，只是可能找不到会话；
   *   `autoReplySupported=false` —— 结构性不可用，引擎直接跳过。
   */
  calibrated?: boolean;
  /**
   * 架构上是否支持本引擎自动回复：`false` = 该平台没有可导航的 Web IM 收件箱
   * （如 51job / 鱼泡 / 中华英才的 HR 沟通走 App），即使登录也无法驱动。
   *
   * 🔴 控制台下拉与 `GET /api/auto-reply/run` 的准入都必须以本字段（配合 DRIVERS）为准，
   * **不得再各写一份硬编码平台清单** —— 曾因此把已校准的 zhilian 也挡在门外，
   * 且非法平台被**静默降级成 boss**（用户以为在回复 A 平台，实际在 B 平台操作）。
   */
  autoReplySupported?: boolean;
  /** `autoReplySupported=false` 时给用户看的说明（会出现在错误提示与下拉标注里） */
  disabledReason?: string;
}
