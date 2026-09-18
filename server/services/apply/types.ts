/**
 * 跨平台专用投递脚本：公共类型
 */

export type ApplyPlatform = 'boss' | 'zhilian' | 'job51' | 'nowcoder' | 'offerbiu' | 'liepin';

/** 投递动作：一键/批量自动/关键词搜索投递/仅搜索收集/HR复聊/求职信 */
export type ApplyAction = 'hello' | 'auto' | 'keyword' | 'search' | 'again' | 'letter';

export type ApplyStatus =
  | 'applied'        // 已成功投递
  | 'found'          // 仅搜索收集到岗位（search 动作）
  | 'need_login'     // 未登录，需先登录
  | 'need_captcha'   // 出现滑块/图形验证码，需在打开的浏览器里人工过一下后重试
  | 'need_manual'    // 遇到非标准流程，需人工在浏览器完成
  | 'need_resume'    // 缺少在线简历，需先上传简历再投
  | 'unavailable'    // 岗位本身不可投（已下线/审核中/校招需单独简历/链接失效重定向）
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
  /** 预览模式：只解析收件人/标题/正文并写入日志，不真正发信 */
  dryRun?: boolean;
  /** 真实投递开关（官网/offerbiu 通道专用）：只有显式 true 才真正提交；
   *  其余情况（含 dryRun 或 realSend 缺省）一律只做只读预览，防止批量误投 */
  realSend?: boolean;
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
