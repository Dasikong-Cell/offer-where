/**
 * 统一容错与「关闭态」识别（技术债 D3，对标职得鸭 `PageHelper.safeOperation`）
 * ─────────────────────────────────────────────────────────────
 * 问题：投递/采集链路里到处散落 try/catch，且**页面关闭类错误被当成业务错误**上报，
 *   导致日志被 "Target closed" / "detached Frame" 之类噪声淹没，
 *   真正的业务失败反而看不见。
 *
 * 做法：
 *   1) `isClosingRelatedError(err)` —— 精确匹配关闭态错误（页面/会话被关、导航中断），
 *      这些应当**静默吞掉**（返回 fallback），不计入业务失败；
 *   2) `safeOp(label, fn, fallback)` —— 统一包装：关闭态静默、业务错误记一条日志后返回 fallback；
 *   3) `guard(name, fn)` —— 用于「出错必须继续跑」的循环体，返回 `{ok, value?, error?}` 而非抛出。
 */

/** 关闭态错误特征（页面被关 / 会话断开 / 导航中断）——这些不是业务失败 */
export const CLOSING_ERROR_PATTERNS: readonly string[] = [
  'Target closed',
  'Session closed',
  'detached Frame',
  'Attempted to use detached Frame',
  'navigating frame was detached',
  'Cannot find context with specified id',
  'Execution context was destroyed',
  'WebSocket is not open',
  'Connection closed',
  'Protocol error',
  'Target page, context or browser has been closed',
];

/** 是否属于「页面/会话已关闭」类错误（应静默处理，不作为业务失败） */
export function isClosingRelatedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String((err as any)?.message ?? err ?? '');
  if (!msg) return false;
  return CLOSING_ERROR_PATTERNS.some((p) => msg.includes(p));
}

/**
 * 是否是**输出管道断开**类噪声（stdout/stderr 被关闭，例如启动它的终端/父进程退出了）。
 *
 * ⚠️ 必须在进程级错误兜底里**优先于日志记录**判断：这类错误的特殊性在于
 *    「为了报告它而写日志」会再次写向已断开的管道 → 再抛同样的错误 → 自激无限循环。
 *    实测后果：单日写成 330 万行 / 240MB 日志，全部是同一句 EPIPE。
 *    它们也不是应用故障，静默丢弃是唯一正确处置。
 */
export function isPipeNoise(err: unknown): boolean {
  const code = String((err as any)?.code || '');
  if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'ERR_STREAM_WRITE_AFTER_END') return true;
  const msg = err instanceof Error ? err.message : String((err as any)?.message ?? err ?? '');
  return /EPIPE|broken pipe|write after end|stream destroyed/i.test(msg);
}

export interface SafeOpOptions {
  /** 静默模式：关闭态与业务错误都不打印（用于「预期可能失败」的探测） */
  silent?: boolean;
  /** 关闭态时打印的说明（默认不打印，因为这是正常停机路径） */
  onClosing?: (err: unknown) => void;
  /** 业务错误时的记录回调（默认 console.log 一行） */
  onError?: (err: unknown, label: string) => void;
}

/**
 * 安全执行一个操作：
 *   · 关闭态错误 → 静默返回 fallback（不污染日志）
 *   · 业务错误   → 记一行日志后返回 fallback（不中断调用方）
 */
export async function safeOp<T>(
  label: string,
  fn: () => Promise<T>,
  fallback: T,
  opts: SafeOpOptions = {},
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isClosingRelatedError(err)) {
      opts.onClosing?.(err);
      if (opts.onClosing === undefined && !opts.silent) {
        console.log(`[safeOp] 页面已关闭，中止「${label}」`);
      }
      return fallback;
    }
    if (opts.onError) opts.onError(err, label);
    else if (!opts.silent) console.log(`[safeOp]「${label}」失败：${(err as any)?.message || err}`);
    return fallback;
  }
}

export interface GuardResult<T> {
  ok: boolean;
  value?: T;
  /** 失败原因（关闭态为 'closed'，业务错误为原始 message） */
  error?: string;
  /** 是否因页面/会话关闭而失败 —— 调用方据此决定「终止循环」还是「继续下一个」 */
  closing: boolean;
}

/**
 * 循环体内的守护执行：**永不抛出**。
 * 调用方按 `closing` 决定是终止整批还是跳过当前项继续。
 */
export async function guard<T>(label: string, fn: () => Promise<T>, opts: SafeOpOptions = {}): Promise<GuardResult<T>> {
  try {
    return { ok: true, value: await fn(), closing: false };
  } catch (err) {
    const closing = isClosingRelatedError(err);
    const message = (err as any)?.message || String(err);
    if (!closing && !opts.silent) {
      if (opts.onError) opts.onError(err, label);
      else console.log(`[guard]「${label}」失败：${message}`);
    }
    return { ok: false, error: closing ? 'closed' : message, closing };
  }
}

/**
 * 拟人停顿：在区间内取随机毫秒。
 * 用途：把固定 `sleep(3000)` 换成 `sleepHuman(2000, 4500)`
 * —— 固定节拍本身就是自动化特征。
 */
export function sleepHuman(minMs = 800, maxMs = 2200): Promise<void> {
  const ms = Math.floor(minMs + Math.random() * Math.max(0, maxMs - minMs));
  return new Promise((r) => setTimeout(r, ms));
}

/** 随机整数 [min, max]（含端点）——用于「每轮目标数量随机化」 */
export function randomInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}
