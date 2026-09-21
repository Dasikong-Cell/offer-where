/**
 * 跨平台专用投递脚本：公共类型
 */

/**
 * 支持的投递平台。
 *
 * ⚠️ 新增一个平台必须**六处同步**（漏一处就会出现"界面能选、跑起来报不支持"的半注册）：
 *   ① 本文件（类型）           ② `data/browser/cdp.json`（端口映射）
 *   ③ `services/connection.ts:DELIVERY_PLATFORMS`   ④ `services/platformHealth.ts:PLATFORM_PAGE`（巡检）
 *   ⑤ `public/console.html:PLATFORMS`（控制台）      ⑥ `start_platforms.bat`（Chrome 实例）
 * 已有合约测试（contract_tests「平台注册完整性」）自动校验这六处一致，改完跑 `npm test` 即可。
 */
export type ApplyPlatform =
  | 'boss'          // BOSS直聘
  | 'zhilian'       // 智联招聘
  | 'job51'         // 前程无忧（51job）
  | 'nowcoder'      // 牛客网
  | 'liepin'        // 猎聘
  | 'offerbiu'      // 企业官网 / 微信推文聚合（邮箱通道）
  // ── 2026-09-21 新增登记（基础设施已就绪；采集/投递的 DOM 实现待各平台实机校准）──
  | 'easyzhipin'    // 易直聘（www.easyzhipin.com）
  | 'job58'         // 58同城招聘（jobs.58.com）
  | 'chinahr'       // 中华英才网（www.chinahr.com）
  | 'dianzhang'     // 店长直聘（www.dianzhangzhipin.com，BOSS 同集团）
  | 'yupao'         // 鱼泡直聘（www.yupao.com）
  | 'maimai'        // 脉脉高聘（maimai.cn）
  | 'ganji'         // 赶集招聘（www.ganji.com，58 同集团）
  | 'iguopin'       // 国聘（www.iguopin.com）
  | 'yingjiesheng'; // 应届生求职网（www.yingjiesheng.com）

/** 投递动作：一键/批量自动/关键词搜索投递/仅搜索收集/HR复聊/求职信 */
export type ApplyAction = 'hello' | 'auto' | 'keyword' | 'search' | 'again' | 'letter';

export type ApplyStatus =
  | 'applied'        // 已成功投递
  | 'skipped'        // 被去重/决策规则主动跳过（如「该 HR 已写过求职信」「AI 判定不打招呼」）
  | 'found'          // 仅搜索收集到岗位（search 动作）
  | 'need_login'     // 未登录，需先登录
  | 'need_captcha'   // 出现滑块/图形验证码，需在打开的浏览器里人工过一下后重试
  | 'rate_limited'   // 平台今日额度/频率到顶：本批应停止，不要连续重试（见 services/riskSignals.ts）
  | 'account_risk'   // 账号被平台标记异常：**不要重试**，需人工过验证 + 主动发消息后等待恢复
  | 'need_manual'    // 遇到非标准流程，需人工在浏览器完成
  | 'need_resume'    // 缺少在线简历，需先上传简历再投
  | 'unavailable'    // 岗位本身不可投（已下线/审核中/校招需单独简历/链接失效重定向）
  | 'preview'        // 仅预览：已走到投递入口但**未点击/未提交**（dry-run，无任何真实动作）
  | 'error';         // 脚本执行出错

export interface ApplyProfile {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  resume_path?: string | null;
  /** 学历（本科/硕士/博士）—— 官网「邮箱投递」拼标题用 */
  education?: string | null;
  /** 学校 */
  school?: string | null;
  /** 专业 */
  major?: string | null;
  /** 现居/意向城市 */
  city?: string | null;
  /** 技能关键词 */
  skills?: string | null;
  /** 意向岗位 */
  expectedPositions?: string | null;
}

export interface ApplyJobRef {
  id?: string;
  company?: string | null;
  position?: string | null;
  apply_url?: string | null;
}

export interface ApplyInput {
  platform: ApplyPlatform;
  profile: ApplyProfile;
  job?: ApplyJobRef;
  jobUrl?: string;
  headless?: boolean;
  /** 验证码邮件时间窗口（分钟） */
  sinceMinutes?: number;
  /**
   * 表单自动填写存档：{ 字段名: 值 }，如 { "籍贯": "云南-昆明", "身高(cm)": "175" }
   * 用于自动补齐招聘站（智联等）简历里的必填项，字段名用页面上的中文标签。
   */
  autofill?: Record<string, string>;
  /** 投递动作，默认 'hello'（单岗位一键投递） */
  action?: ApplyAction;
  /** 搜索关键词（auto/keyword/search 使用） */
  keyword?: string;
  /** 批量自动最多翻页数（auto 使用，默认 5） */
  maxPages?: number;
  /** 批量自动总投递上限（安全阀，默认 9999；防止一次投太多） */
  maxApply?: number;
  /** HR 会话/消息组 ID（again 复聊使用） */
  hrGroupId?: string;
  /** 已有聊天记录（again 复聊时传给 AI 生成回复） */
  chatHistory?: string;
  /** JD 文本（letter/again 不重新抓取时直接传入） */
  jdText?: string;
  /** offerbiu 投递通道：auto=按链接自动判断；email=强制走「HR 邮箱投递」 */
  channel?: 'auto' | 'email';
  /**
   * 预取证的 HR 邮箱（扫描阶段已从岗位页提取并人工核验过）。
   * 提供后邮箱通道跳过「重新打开页面抽取邮箱」一步，直接用此地址投递——
   * 用于规避微信推文被限流/需验证导致正文加载不出、抽不到邮箱的场景。
   */
  email?: string;
  /**
   * 一岗一简历：本次投递使用的**定制简历附件路径**（覆盖档案里的 `resume_path`）。
   * 由 `services/apply/tailoredResumePdf.ensureTailoredResumePdf()` 按岗位 JD 生成。
   * 不传则沿用固定简历，行为与以前完全一致（向后兼容）。
   */
  resumeOverride?: string;
  /** 预览模式：只解析收件人/标题/正文并写入日志，不真正发信 */
  dryRun?: boolean;
  /** 真实投递开关（官网/offerbiu 通道专用）：只有显式 true 才真正提交；
   *  其余情况（含 dryRun 或 realSend 缺省）一律只做只读预览，防止批量误投 */
  realSend?: boolean;
  /**
   * **平台通道**（boss/zhilian/job51/liepin/nowcoder）的只读预览开关。
   *
   * 为什么需要单独一个开关：平台通道的"投递"就是点一下按钮，没有"提交表单"这一步可拦截，
   * 所以 `realSend` 对它无意义（历史实现里这些模块根本不读 dryRun/realSend，
   * 导致用户无法在不产生真实投递的情况下验证链路）。
   * 打开后：走完导航 → 读 JD → 探测投递入口按钮是否可点，**但不点击**，返回 status='preview'。
   * 参考同类开源项目（boss_batch_push）的 `mock` 模式。
   */
  preview?: boolean;
  /** 求职信生成模式：ai=LLM 按 JD 生成；custom=用自定义模板（支持 {职位名称} 等变量） */
  letterMode?: 'ai' | 'custom';
  /** 自定义模板内容（覆盖全局模板，仅 letterMode=custom 时生效） */
  letterTemplate?: string | null;
  /** HR 是否已回复（求职信三重去重的②号依据：已回复则不插播模板信） */
  hrReplied?: boolean;
  /** 投递成功后追加发送「简历聊天图」（无 HR 邮箱的岗位用来覆盖平台内聊天场景） */
  chatResume?: boolean;
  /** 猎聘：投递/复聊后执行的交换动作（sendResume / changePhone / changeWechat） */
  exchangeActions?: string[];
}

export interface ApplyLog {
  step: string;
  ok: boolean;
  detail?: string;
}

export interface ApplyResult {
  platform: ApplyPlatform;
  status: ApplyStatus;
  message: string;
  logs: ApplyLog[];
  company?: string | null;
  position?: string | null;
  screenshot?: string;
  /** search 动作收集到的岗位 */
  foundJobs?: { title: string; url: string; company?: string }[];
  /** 本轮实际投递成功数量（批量投递用） */
  appliedCount?: number;
  /**
   * dryRun 预览负载。两种形状二选一：
   * - 邮箱投递预览：{ to, subject, body, attachment? }
   * - 官网投递预览：{ jobUrl?, needLogin, entryHits, resumePath? }
   */
  preview?:
    | { to: string; subject: string; body: string; attachment?: string }
    | {
        jobUrl?: string;
        needLogin: boolean;
        entryHits: string[];
        resumePath?: string;
        /** 官网表单探测到的字段（含建议值）：人工补填一次后由服务端记忆复用 */
        formFields?: { label: string; type: string; value?: string }[];
      };
}
