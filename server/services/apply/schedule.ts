/**
 * 运行时间段调度（对标职得鸭 `TimeManager`：多时间段 + 中断续跑）
 * ─────────────────────────────────────────────────────────────
 * 为什么需要：固定节拍、7×24 不间断跑本身就是自动化特征。
 * 让人工配置「每天只在 9:00-11:30、14:00-17:00 跑」，风控面显著变小，
 * 观感也更像真人在作息内找工作。
 *
 * 设计取舍（与职得鸭不同的地方）：
 *   · **不在服务端长时间 sleep** —— `evaluate()` 只做纯计算并返回 `waitSeconds`，
 *     由调用方（批量投递循环 / 控制台）决定怎么等、且随时可被用户中断。
 *     （职得鸭是在函数内 `while` 分段 sleep，进程内不可控。）
 *   · `cursor` 持久化 → **中断后重启继续跑剩余时间段**，而不是从头再来。
 */
import { kvGetJson, kvSetJson } from '../../db.js';

export interface TimeSlot {
  /** "HH:MM"（24 小时制） */
  startTime: string;
  endTime: string;
}

export interface PlatformSchedule {
  platform: string;
  /** 是否启用时间段限制（false = 全天可跑） */
  enabled: boolean;
  slots: TimeSlot[];
  /** 已执行到第几段（中断续跑用） */
  cursor: number;
  updatedAt: string;
}

export const KNOWN_SCHEDULE_PLATFORMS = ['boss', 'liepin', 'job51', 'zhilian', 'offerbiu'] as const;

const scheduleKvKey = (platform: string) => `schedule:${platform}`;

const HHMM = /^\d{1,2}:\d{2}$/;

export function isValidSlot(s: any): s is TimeSlot {
  if (!s) return false;
  const a = String(s.startTime || '').trim();
  const b = String(s.endTime || '').trim();
  if (!HHMM.test(a) || !HHMM.test(b)) return false;
  return toMinutes(a) < toMinutes(b);
}

export function toMinutes(hhmm: string): number {
  const [h, m] = String(hhmm).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function getSchedule(platform: string): PlatformSchedule {
  const fallback: PlatformSchedule = {
    platform,
    enabled: false,
    slots: [],
    cursor: 0,
    updatedAt: new Date(0).toISOString(),
  };
  const s = kvGetJson<PlatformSchedule | null>(scheduleKvKey(platform), null);
  if (!s || typeof s !== 'object') return fallback;
  return {
    platform,
    enabled: !!s.enabled,
    slots: Array.isArray(s.slots) ? s.slots.filter(isValidSlot) : [],
    cursor: Number.isFinite(s.cursor) ? Math.max(0, Number(s.cursor)) : 0,
    updatedAt: String(s.updatedAt || fallback.updatedAt),
  };
}

export interface SetSchedulePatch {
  enabled?: boolean;
  slots?: TimeSlot[];
  /** 传 true 把 cursor 归零（重新开始一轮） */
  reset?: boolean;
}

export function setSchedule(platform: string, patch: SetSchedulePatch): PlatformSchedule {
  const cur = getSchedule(platform);
  const slots = patch.slots !== undefined ? patch.slots.filter(isValidSlot) : cur.slots;
  const next: PlatformSchedule = {
    platform,
    enabled: patch.enabled !== undefined ? !!patch.enabled : cur.enabled,
    slots,
    cursor: patch.reset ? 0 : cur.cursor,
    updatedAt: new Date().toISOString(),
  };
  kvSetJson(scheduleKvKey(platform), next);
  return next;
}

/** 推进到下一时间段（到点自动关程序 / 手动结束后调用） */
export function advanceSchedule(platform: string): PlatformSchedule {
  const cur = getSchedule(platform);
  const next: PlatformSchedule = { ...cur, cursor: cur.cursor + 1, updatedAt: new Date().toISOString() };
  kvSetJson(scheduleKvKey(platform), next);
  return next;
}

export function listSchedules(): PlatformSchedule[] {
  return KNOWN_SCHEDULE_PLATFORMS.map((p) => getSchedule(p));
}

export type GateState = 'running' | 'waiting' | 'done';

export interface GateStatus {
  state: GateState;
  /** 一句话人话说明（可直接进日志/控制台） */
  message: string;
  /** 建议等待秒数（state === 'waiting' 时 > 0） */
  waitSeconds: number;
  /** 当前时间段结束还剩多少秒（state === 'running' 时有效） */
  remainingSeconds: number;
  /** 当前生效的时间段 */
  slot: TimeSlot | null;
  /** 总共还剩余几个时间段（含当前） */
  remainingSlots: number;
}

function nowMinutes(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * 纯计算：判断此刻是否允许运行。
 * **不会写库、不会 sleep** —— 调用方按 `waitSeconds` 自己决定等待方式。
 */
export function evaluateSchedule(platform: string, now: Date = new Date()): GateStatus {
  const s = getSchedule(platform);
  if (!s.enabled || s.slots.length === 0) {
    return { state: 'running', message: '未配置运行时间段，全天运行', waitSeconds: 0, remainingSeconds: 0, slot: null, remainingSlots: 0 };
  }
  const slots = [...s.slots].sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));
  let cur = Math.min(s.cursor, slots.length);
  const curMin = nowMinutes(now);

  // 跳过已经过期的时间段（只算不写库；写库由 advanceSchedule 在有副作用时调用）
  while (cur < slots.length && curMin > toMinutes(slots[cur].endTime)) cur++;
  if (cur >= slots.length) {
    return {
      state: 'done',
      message: `所有 ${slots.length} 个运行时间段已执行完毕，等待重置`,
      waitSeconds: 0,
      remainingSeconds: 0,
      slot: null,
      remainingSlots: 0,
    };
  }
  const slot = slots[cur];
  const startMin = toMinutes(slot.startTime);
  const endMin = toMinutes(slot.endTime);
  const remainingSlots = slots.length - cur;

  if (curMin < startMin) {
    const waitSeconds = (startMin - curMin) * 60 - now.getSeconds();
    return {
      state: 'waiting',
      message: `未到运行时间，等待 ${slot.startTime} 开始（还有 ${Math.max(0, Math.ceil(waitSeconds / 60))} 分钟）`,
      waitSeconds: Math.max(0, waitSeconds),
      remainingSeconds: 0,
      slot,
      remainingSlots,
    };
  }
  const remainingSeconds = Math.max(0, (endMin - curMin) * 60 - now.getSeconds());
  return {
    state: 'running',
    message: `运行中（${slot.startTime}–${slot.endTime}），本段还剩 ${Math.floor(remainingSeconds / 60)} 分 ${remainingSeconds % 60} 秒`,
    waitSeconds: 0,
    remainingSeconds,
    slot,
    remainingSlots,
  };
}

/**
 * 带 side-effect 的检查：时间段跑完会自动推进 cursor（实现「中断续跑」）。
 * 循环里应在**每处理完一个岗位**时调用一次。
 */
export function checkAndAdvance(platform: string, now: Date = new Date()): GateStatus {
  const st = evaluateSchedule(platform, now);
  if (st.state === 'done') {
    advanceSchedule(platform); // cursor 推到末尾，幂等
    return st;
  }
  if (st.state === 'running' && st.remainingSeconds <= 0) {
    advanceSchedule(platform);
    return evaluateSchedule(platform, now);
  }
  const s = getSchedule(platform);
  if (s.enabled && s.slots.length && st.slot && s.cursor !== Math.min(s.cursor, s.slots.length)) {
    // 过期段已在 evaluate 里跳过，这里把 cursor 同步过去，保证重启后不重跑旧段
    kvSetJson(scheduleKvKey(platform), { ...s, cursor: s.slots.length - st.remainingSlots, updatedAt: new Date().toISOString() });
  }
  return st;
}

/** 供 UI 展示：把配置说成人话 */
export function describeSchedule(platform: string): string {
  const s = getSchedule(platform);
  if (!s.enabled || !s.slots.length) return '全天运行（未启用时间段）';
  const list = [...s.slots].sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));
  const done = Math.min(s.cursor, list.length);
  return `${list.map((x) => `${x.startTime}-${x.endTime}`).join('、')}（已完成 ${done}/${list.length} 段）`;
}
