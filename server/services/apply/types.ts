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
  | 'error';         // 脚本执行出错

export interface ApplyProfile {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  resume_path?: string | null;
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
}
