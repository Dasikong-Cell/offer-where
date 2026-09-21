/**
 * 平台风控 / 额度信号的统一识别
 * ==========================================================================
 * 背景：平台（尤其 BOSS 直聘）对自动化投递有**账号级**处罚，且每日打招呼额度有限。
 * 同类开源项目（boss-auto-job 等）把平台信号分成几类并给出**不同处置**：
 *   · 账户异常（Code 36）→ **不要重试**，需人工过验证 + 主动发一条消息证明是真人，等 10–30 分钟
 *   · 临时封禁（Code 32）→ 同上，且等待更久
 *   · 限速（Code 1006）   → 等 10 秒 / 降低频率即可
 * 我们此前只有笼统的 `need_manual`，用户拿到后不知道该做什么，甚至连续重试把风控升级。
 *
 * 本模块把"页面信号 → 类别 → 可执行处置"这一步收敛成纯函数（可单测），
 * 供各平台投递脚本复用。
 */

export type RiskKind =
  | 'captcha'        // 出现验证码/滑块：人工过一次即可继续
  | 'rate_limited'   // 频率/额度到顶：停止并等待，不要连续重试
  | 'account_risk';  // 账号被标记异常：**不要重试**，需人工处置

export interface RiskSignal {
  kind: RiskKind;
  /** 命中的原文，用于留痕与排查 */
  matched: string;
  /** 给用户的**可执行**处置指引 */
  action: string;
}

/**
 * 识别规则，按**严重程度从高到低**排列（严重信号优先返回）。
 *
 * 注意：调用方传入的是页面可见文本，可能包含岗位 JD 正文，因此这里的措辞都取得比较具体，
 * 避免被 JD 里的普通词汇误触发。
 */
const RULES: Array<{ kind: RiskKind; re: RegExp; action: string }> = [
  {
    kind: 'account_risk',
    re: /(账号异常|账户异常|环境异常|登录异常|存在风险|安全风险|账号被限制|账户被限制|已被限制|暂时无法继续)/,
    action:
      '账号被平台标记异常：**不要再重试**（连续重试会让风控升级）。请到调试 Chrome 里手动完成安全校验，'
      + '并主动给任意 HR 发一条消息（平台需要确认是真人操作），等待 10–30 分钟后再跑。',
  },
  {
    kind: 'rate_limited',
    // 「今日沟通人数已达上限」是 BOSS 的**平台级每日额度**文案（同类开源项目 boss_batch_push 实测
    // BOSS 每日沟通上限为 100 次，命中后应整批停手并等次日恢复，而不是继续试探）。
    re: /(今日沟通人数已达上限|今日沟通(次数|人数)?已达上限|今日打招呼(次数)?已达上限|沟通人数已达上限|今日.{0,6}(次数|额度|人数).{0,6}(已达|用完|上限|耗尽)|(次数|额度|人数).{0,6}(已达上限|已用完|已耗尽)|操作过于频繁|请求过于频繁|操作频繁|发送过于频繁|请稍后再试|稍后重试)/,
    action:
      '该平台今日额度/频率已到顶（BOSS 每日沟通上限约 100 次）：本批已提前结束，'
      + '并会在 6 小时内自动跳过该平台。**不要连续重试**，建议明天再投；'
      + '长期看应把「每日投递上限」调低（平台对高频批量最敏感）。',
  },
  {
    kind: 'captcha',
    re: /(访问验证|滑动验证|安全验证|人机验证|请按住滑块|拖动到最右边|请完成验证|请按住滑块拖动)/,
    action: '在调试 Chrome 窗口里手动完成验证/滑块，然后重跑本批次（已投成功的不会重复投递）。',
  },
];

/**
 * 从页面文本中识别风控信号。
 * @param text 页面可见文本（document.body.innerText 之类）
 */
export function detectRiskSignal(text: string): RiskSignal | null {
  const t = String(text || '');
  if (!t.trim()) return null;
  for (const r of RULES) {
    const m = t.match(r.re);
    if (m) return { kind: r.kind, matched: m[0], action: r.action };
  }
  return null;
}

/** 该风控类别是否应当**中止整批**（继续投只会加重处罚） */
export function shouldAbortBatch(kind: RiskKind): boolean {
  return kind === 'account_risk' || kind === 'rate_limited';
}

/** 风控类别 → 投递状态（captcha 复用既有 need_captcha 语义，其余同名） */
export function riskStatusOf(kind: RiskKind): 'need_captcha' | 'rate_limited' | 'account_risk' {
  return kind === 'captcha' ? 'need_captcha' : kind;
}
