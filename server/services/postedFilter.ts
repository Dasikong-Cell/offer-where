/**
 * 按「发布时间窗口」筛岗位 —— 纯函数、零副作用、可单测。
 *
 * ## 为什么单独一个模块，而不是塞进 `batch.ts`
 * `batch.ts` 会拉起 `apply/engine` → `browser`/`cdpDriver` 一整条重依赖链
 * （playwright、CDP 驱动、better-sqlite3…）。单测 import 它，等于为了验证一个十几行的
 * 筛选函数把整个浏览器栈拖进来 —— 慢、脆、还可能因为环境缺依赖而红。
 * 本模块**只依赖 `parsePostedAt`**（那个模块零依赖），于是单测可以秒跑。
 *
 * ## 两条「写错了也不会报错」的规则
 * 这两条是时区处理的经典陷阱：错了没有任何异常，只是日期**悄悄差一天**。
 *   ① `posted_at` 存的已经是**当地日历日期**（`YYYY-MM-DD`）⇒ 直接取用。
 *      再做一次时区换算，会让 UTC-5 这类时区的 `2026-09-02` 变成 09-01。
 *   ② `created_at` 是 UTC ISO 时间戳 ⇒ **必须**换成本地日历。
 *      直接截前 10 位，会在 UTC+8 的 00:00–08:00 之间把「今天刚采的岗位」算成昨天 ——
 *      症状是「清晨打开『只看今天』，明明是刚采的却一条都没有」，极难联想到时区。
 */
import { isWithinDays, localDateOf, postedWithinDays } from './parsePostedAt.js';

export interface PostedWindowResult<T> {
  /** 落在窗口内的岗位 */
  jobs: T[];
  /** 生效的窗口天数；`null` = 没筛（口径是 `any` 或值不认识） */
  days: number | null;
  /** 缺发布时间、且已显式关掉兜底 ⇒ 被排除的条数 */
  missing: number;
  /** 有日期但不在窗口内 ⇒ 被排除的条数 */
  outOfRange: number;
  /** 靠 `created_at` 兜底、且落在窗口内的条数 */
  viaFallback: number;
}

/**
 * @param jobs          候选岗位（只用到 `posted_at` / `created_at`）
 * @param postedWithin  口径（`'today'` / `'3d'` / `'7d'` / `'any'`）；不认识的值按「不筛」处理
 * @param opts.fallback `posted_at` 为空时是否退回 `created_at`，**默认 true**
 * @param opts.now / opts.tzOffsetMinutes  测试用注入点（见 `parsePostedAt.ts` 的时区说明）
 */
export function filterByPostedWindow<T extends { posted_at?: string | null; created_at: string }>(
  jobs: T[],
  postedWithin: unknown,
  opts?: { fallback?: boolean; now?: Date; tzOffsetMinutes?: number },
): PostedWindowResult<T> {
  const days = postedWithinDays(postedWithin);
  // 口径不认识 / 就是 'any' ⇒ 原样返回。行为与「加这个字段之前」完全一致，
  // 这样老调用方（不传 postedWithin）零感知。
  if (days == null) return { jobs, days: null, missing: 0, outOfRange: 0, viaFallback: 0 };

  const fallback = opts?.fallback !== false; // 默认兜底
  const o = { now: opts?.now, tzOffsetMinutes: opts?.tzOffsetMinutes };
  const out: T[] = [];
  let missing = 0;
  let outOfRange = 0;
  let viaFallback = 0;

  for (const j of jobs) {
    // ① posted_at：当地日历日期，直接取前 10 位
    let effective = j.posted_at ? (/^\d{4}-\d{2}-\d{2}/.exec(String(j.posted_at))?.[0] ?? null) : null;
    let usedFallback = false;
    if (!effective) {
      if (!fallback) { missing++; continue; }
      // ② created_at：UTC 时间戳 ⇒ 换本地日历
      effective = localDateOf(j.created_at, o);
      usedFallback = true;
    }
    if (!effective || !isWithinDays(effective, days, o)) { outOfRange++; continue; }
    if (usedFallback) viaFallback++;
    out.push(j);
  }

  return { jobs: out, days, missing, outOfRange, viaFallback };
}
