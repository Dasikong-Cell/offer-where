/**
 * 「投递复盘」口径层 —— 把投递台账（applications）与岗位池（jobs）折算成
 * 复盘页要显示的那几个数字与四段行动清单。
 *
 * 🔴 为什么这些数字算在后端、而不是在 console.html 里算：
 *   它们**全是口径问题** —— 什么算「已投出」、什么算「本周」、几天算「没进展」。
 *   写在页面里就只能靠肉眼核对；写成纯函数就能喂一份固定台账 + 一个固定的 now，
 *   把口径钉进单测（tests/unit/reviewPlan.test.ts）。
 *   页面只做渲染，不再自己算一遍 —— 否则「后端算一套、页面算一套」迟早对不上。
 *
 * 🔴 纯函数、零 IO、零依赖：不 import db / express / DOM，也**绝不读 Date.now()**。
 *   「现在」一律由调用方传进来（`opts.now`）。否则同一份数据在 CI（UTC）与本机（UTC+8）
 *   会算出不同结果，测试只能写成「大概是这个数」——而「大概是」的断言等于没断言。
 */

/** 已投出去的状态。含 `rejected`：被拒说明简历确实投出去了，它在推进率的**分母**里。
 *  `skipped`（我们主动跳过）不在内 —— 它压根没投，进分母会把所有比率稀释低。 */
export const SENT_STATUSES: readonly string[] = [
  'applied', 'replied', 'written', 'interview', 'offer', 'rejected',
];

/** 推进到「笔试及以后」的状态 —— 推进率的**分子**。 */
export const ADVANCED_STATUSES: readonly string[] = ['written', 'interview', 'offer'];

/** 「有回复」：拿到非拒绝回应的条数（已拒绝单列，不算「有回复」）。 */
export const REPLIED_STATUSES: readonly string[] = ['replied', 'written', 'interview', 'offer'];

/**
 * 复盘用到的全部阈值（显式常量）。
 * 改口径只改这里 —— 不要在下面对比值里写魔法数字，否则「3 天」会散落成好几处各说各话。
 */
export const REVIEW_THRESHOLDS = {
  /** 「近期需要优先处理」窗口：`剩 N 天 ≤ priorityDays`（含今天）。 */
  priorityDays: 3,
  /** 「长时间没进展」：已投出满 N 个日历日仍未进入笔面。 */
  stalledDays: 7,
  /** 「近期」= 近 N 个日历日（含今天）：本周新增、近 7 天笔面安排都用它。 */
  weekDays: 7,
  /** 「回复率偏低」的判定门槛：已投出 ≥ lowReplyMinSent 且回复率 < lowReplyRate(%)。 */
  lowReplyMinSent: 20,
  lowReplyRate: 10,
} as const;

/** 允许被覆盖的阈值（单测用，避免测试里散落硬编码的 3/7/20）。 */
export type ReviewThresholds = {
  priorityDays: number;
  stalledDays: number;
  weekDays: number;
  lowReplyMinSent: number;
  lowReplyRate: number;
};

export interface ReviewAppInput {
  id?: string | null;
  company?: string | null;
  position?: string | null;
  platform?: string | null;
  status?: string | null;
  created_at?: string | null;
  written_at?: string | null;
  interview_at?: string | null;
  interview_round?: string | null;
  offer_at?: string | null;
  closed_at?: string | null;
}

export interface ReviewJobInput {
  id?: string | null;
  company?: string | null;
  position?: string | null;
  source?: string | null;
  apply_url?: string | null;
  deadline?: string | null;
  /** 被规则主动跳过的岗位（如「已投递过」）留痕在这里 —— 不该出现在「优先投」里。 */
  skip_reason?: string | null;
  status?: string | null;
}

export type PriorityKind = 'deadline' | 'flow';

export interface ReviewPriorityItem {
  kind: PriorityKind;
  id: string;
  company: string;
  position: string;
  platform: string;
  /** 该行动指向的时间点：deadline 为岗位截止日，flow 为笔面时间（YYYY-MM-DD[ HH:mm]）。 */
  at: string;
  /** 距今天数（0 = 今天）。只对 kind='deadline' 有意义（截止是「日」粒度）。 */
  daysLeft: number;
  /** 到点了吗（daysLeft === 0）。 */
  isToday: boolean;
}

export interface ReviewScheduleItem {
  id: string;
  company: string;
  position: string;
  platform: string;
  kind: 'written' | 'interview';
  /** 面试轮次（一面/二面/HR面/终面）；笔试或未标注时为空串。 */
  round: string;
  /** 已排定的时间（`YYYY-MM-DD` 或 `YYYY-MM-DD HH:mm`）；「时间未定」时为 null。 */
  at: string | null;
  /** `false` = 状态已经走到笔面、但时间还没记（页面显示「时间未定」）。 */
  scheduled: boolean;
  /** 距今天数；未排定时为 null（**不是 0** —— 0 表示「今天」，两者不能混）。 */
  daysLeft: number | null;
}

export interface ReviewStalledItem {
  id: string;
  company: string;
  position: string;
  platform: string;
  status: string;
  /** 已投出多少天（reason='no-progress' 时有意义；'unscheduled-written' 时可能为 0）。 */
  days: number;
  /**
   * · `no-progress`         —— 投出去 ≥ stalledDays 天，始终没进入笔面
   * · `unscheduled-written` —— 状态已经是笔试/面试，但没记时间（复盘按时间排先后，没时间等于漏记）
   */
  reason: 'no-progress' | 'unscheduled-written';
}

export interface ReviewSuggestion {
  /** 稳定的机器码 —— 断言只认它，文案随便改。 */
  code: string;
  text: string;
}

export interface ReviewPlan {
  now: string;
  thresholds: ReviewThresholds;
  metrics: {
    total: number;
    sent: number;
    weekNew: number;
    replied: number;
    repliedRate: number;
    advanced: number;
    advanceRate: number;
    written: number;
    interview: number;
    offer: number;
    rejected: number;
    /** 近 weekDays 天内的笔面**场次**（同一家既笔试又面试算 2 场）。 */
    flowNext7: number;
    /** 状态已到笔面、但没记时间的条数 —— 这类会拉低复盘的可信度，单列出来。 */
    unscheduledFlow: number;
    /** 长期无进展的条数（≥ stalledDays 天没进入笔面）。 */
    stalled: number;
    /** 待投递且剩 N 天 ≤ priorityDays 的岗位数。 */
    deadlineSoon: number;
  };
  blocks: {
    priority: ReviewPriorityItem[];
    schedule: ReviewScheduleItem[];
    stalled: ReviewStalledItem[];
    nextWeek: ReviewSuggestion[];
    focus: string;
  };
}

// ============================ 时间工具 ============================

const pad2 = (n: number) => (n < 10 ? '0' + n : String(n));

/** 本地日历日 key（YYYY-MM-DD）。**必须走本地 getter**：用 toISOString 会在 UTC+8 差一天。 */
export function localDayKey(d: Date): string {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/** 两个「YYYY-MM-DD」相差几天（to - from）。两个日期都按**本地日历**构造，不受时区影响。 */
export function daysBetweenLocal(fromDay: string, toDay: string): number | null {
  const a = parseLocalDay(fromDay);
  const b = parseLocalDay(toDay);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function parseLocalDay(day: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, mo - 1, d);
  // 反查一次：2026-02-31 会被 Date 静默滚成 3 月 3 日，滚过的直接判非法。
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}

/**
 * 流程时间节点的**入库前规整**。
 *
 * · `null` / `undefined` / 空白   → `null`（前端清空输入框 = 撤销这个节点，不是存空串）
 * · `2026-10-08`                  → 原样（到「日」）
 * · `2026-10-08 10:30` / `T10:30` → 统一成 `2026-10-08 10:30`（空格分隔，秒/毫秒/时区裁掉）
 * · 其它（含 `2026-13-45`）        → `null`
 *
 * 🔴 为什么非法值返回 `null` 而不是原样存：
 *   这些值要参与「谁先谁后」的排序。一个 `2026-13-45` 混进去，排序结果会莫名其妙，
 *   而界面上还能显示出来、看起来「有值」—— 属于**静默错**。宁可当没填。
 * 🔴 为什么裁掉秒与时区：这是用户手填的流程时间（面试几点开始），精确到分钟已经足够；
 *   保留时区会让同一时刻出现两种写法，按字符串比大小就错了。
 */
export function normalizeFlowTime(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(s);
  if (!m) return null;
  const day = m[1] + '-' + m[2] + '-' + m[3];
  if (!parseLocalDay(day)) return null;
  if (m[4] === undefined || m[5] === undefined) return day;
  const hh = Number(m[4]), mi = Number(m[5]);
  if (hh > 23 || mi > 59) return day;         // 时刻非法就退化成「只到日」，不整条丢掉
  return day + ' ' + pad2(hh) + ':' + pad2(mi);
}

/** 从规整后的流程时间取「日」部分；没填则 null。 */
export function flowDay(v: unknown): string | null {
  const t = normalizeFlowTime(v);
  return t ? t.slice(0, 10) : null;
}

/**
 * 面试轮次规整：去空白、压到 12 字以内；空 → null。
 * 长度上限是防着把一整句话贴进来（卡片上那一行放不下，会把布局挤坏）。
 */
export function normalizeRound(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).replace(/[\s\u3000]+/g, ' ').trim();
  return s ? s.slice(0, 12) : null;
}

/**
 * 把 `created_at`（后端写的 ISO **UTC** 串，或老数据的 `YYYY-MM-DD HH:mm:ss`）折成**本地**日历日。
 *
 * 🔴 与 flowDay 的区别是本质的，不能互相替换：
 *   · `created_at` 是一个**时刻**（带 Z），要按本地时区折算成日历日 ——
 *     直接 `slice(0,10)` 会在 UTC+8 的 00:00–08:00 差一天（那时 UTC 还是昨天）。
 *   · `written_at` 是一个**用户手填的日历日**，字符串本身就是答案，**不能再做时区换算**
 *     （换一次就变成「填的 10 号显示成 9 号」）。
 *   这正是 posted_at / created_at 那条老教训的另一面。
 */
export function instantDay(v: unknown): string | null {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  // 纯日期串（老数据 / 手填）写的就是「本地日历日」，不能再当 UTC 午夜去折算 ——
  // `Date.parse('2026-10-04')` 按规范是 UTC 00:00，在 UTC-5 会折成 10-03。
  const bare = /^(\d{4}-\d{2}-\d{2})$/.exec(s);
  if (bare) return parseLocalDay(bare[1]) ? bare[1] : null;
  const t = Date.parse(s.replace(' ', 'T'));
  if (!Number.isFinite(t)) return null;
  return localDayKey(new Date(t));
}

// ============================ 主计算 ============================

export interface BuildReviewOptions {
  /** 「现在」。必传 —— 本模块不读时钟（见文件头）。 */
  now: Date | string;
  /** 覆盖阈值（单测用）。 */
  thresholds?: Partial<ReviewThresholds>;
}

function asStr(v: unknown): string {
  return v == null ? '' : String(v).trim();
}

/**
 * 算出复盘页要的全部数字与四段清单。
 *
 * `apps` 传投递台账全量；`jobs` 传岗位池（内部只取 `status='candidate'` 且未被跳过的）。
 */
export function buildReviewPlan(
  apps: readonly ReviewAppInput[],
  jobs: readonly ReviewJobInput[],
  opts: BuildReviewOptions,
): ReviewPlan {
  const rawNow = opts.now instanceof Date ? opts.now : new Date(String(opts.now));
  if (!Number.isFinite(rawNow.getTime())) throw new Error('buildReviewPlan: now 不是一个合法时间');
  const now = rawNow;
  const today = localDayKey(now);
  const th: ReviewThresholds = { ...REVIEW_THRESHOLDS, ...(opts.thresholds || {}) };

  const list = Array.isArray(apps) ? apps : [];
  const jobList = Array.isArray(jobs) ? jobs : [];

  // ---- 状态计数 ----
  let sent = 0, weekly = 0, replied = 0, advanced = 0;
  let written = 0, interview = 0, offer = 0, rejected = 0;
  for (const a of list) {
    if (!a) continue;                                  // 脏行（null）不该把整页打挂
    const st = asStr(a.status);
    if (SENT_STATUSES.indexOf(st) >= 0) sent++;
    if (ADVANCED_STATUSES.indexOf(st) >= 0) advanced++;
    if (REPLIED_STATUSES.indexOf(st) >= 0) replied++;
    if (st === 'written') written++;
    else if (st === 'interview') interview++;
    else if (st === 'offer') offer++;
    else if (st === 'rejected') rejected++;

    const cd = instantDay(a.created_at);
    if (cd) {
      const d = daysBetweenLocal(cd, today);
      // 「近 weekDays 天」= 今天往前数 weekDays 个日历日（含今天）：
      // daysBetween 为 0（今天）… weekDays-1（最早那天）。
      if (d != null && d >= 0 && d < th.weekDays) weekly++;
    }
  }

  // ---- 笔面场次：一趟扫出「已排定」与「未记时间」 ----
  const schedule: ReviewScheduleItem[] = [];
  let unscheduledFlow = 0;
  const pushFlow = (a: ReviewAppInput, kind: 'written' | 'interview') => {
    const at = normalizeFlowTime(kind === 'written' ? a.written_at : a.interview_at);
    const base = {
      id: asStr(a.id),
      company: asStr(a.company) || '–',
      position: asStr(a.position) || '–',
      platform: asStr(a.platform),
      kind,
      round: kind === 'interview' ? (normalizeRound(a.interview_round) || '') : '',
    };
    if (!at) {
      // 状态已经到笔面却没有时间 ⇒ 单列「时间未定」。daysLeft 用 null（不是 0）。
      unscheduledFlow++;
      schedule.push({ ...base, at: null, scheduled: false, daysLeft: null });
      return;
    }
    const d = daysBetweenLocal(today, flowDay(at) as string);
    schedule.push({ ...base, at, scheduled: true, daysLeft: d });
  };
  for (const a of list) {
    if (!a) continue;                                  // 脏行（null）不该把整页打挂
    const st = asStr(a.status);
    // ① 时间字段有值 ⇒ **一定**显示。
    //    不能反过来「先看状态再看时间」：用户常常先补面试时间、过一会儿才去改状态，
    //    按状态过滤会把刚填好的安排直接吞掉（界面看起来像没保存成功）。
    if (normalizeFlowTime(a.written_at)) pushFlow(a, 'written');
    if (normalizeFlowTime(a.interview_at)) pushFlow(a, 'interview');
    // ② 状态已经走到笔试/面试、却没有对应时间 ⇒ 记成「时间未定」，提醒去补。
    if (st === 'written' && !normalizeFlowTime(a.written_at)) pushFlow(a, 'written');
    if (st === 'interview' && !normalizeFlowTime(a.interview_at)) pushFlow(a, 'interview');
  }
  // 已排定的按时间升序（越近越靠前）；未排定的排最后，且稳定按公司名，避免每次刷新顺序乱跳。
  schedule.sort((x, y) => {
    if (x.at && y.at) return x.at.localeCompare(y.at) || x.company.localeCompare(y.company);
    if (x.at) return -1;
    if (y.at) return 1;
    return x.company.localeCompare(y.company);
  });

  // ---- 近 7 天笔面场次（含今天，向前看） ----
  let flowNext7 = 0;
  for (const s of schedule) {
    if (s.daysLeft != null && s.daysLeft >= 0 && s.daysLeft < th.weekDays) flowNext7++;
  }

  // ---- 长期没进展 ----
  const stalledItems: ReviewStalledItem[] = [];
  for (const a of list) {
    if (!a) continue;
    const st = asStr(a.status);
    if (st === 'applied' || st === 'replied') {
      const cd = instantDay(a.created_at);
      const d = cd ? daysBetweenLocal(cd, today) : null;
      if (d != null && d >= th.stalledDays) {
        stalledItems.push({
          id: asStr(a.id), company: asStr(a.company) || '–', position: asStr(a.position) || '–',
          platform: asStr(a.platform), status: st, days: d, reason: 'no-progress',
        });
      }
    } else if (st === 'written' || st === 'interview') {
      const at = normalizeFlowTime(st === 'written' ? a.written_at : a.interview_at);
      if (!at) {
        const cd = instantDay(a.created_at);
        const d = cd ? daysBetweenLocal(cd, today) : 0;
        stalledItems.push({
          id: asStr(a.id), company: asStr(a.company) || '–', position: asStr(a.position) || '–',
          platform: asStr(a.platform), status: st, days: Math.max(0, d || 0), reason: 'unscheduled-written',
        });
      }
    }
  }
  // 拖得越久越靠前；同为「未记时间」的按公司名稳定排序。
  stalledItems.sort((x, y) => (y.days - x.days) || x.company.localeCompare(y.company));
  const stalledNoProgress = stalledItems.filter((s) => s.reason === 'no-progress').length;

  // ---- 待投递且临近截止（岗位池） ----
  const priority: ReviewPriorityItem[] = [];
  for (const j of jobList) {
    if (!j) continue;
    const st = asStr(j.status) || 'candidate';
    if (st !== 'candidate') continue;                 // 已投 / 已失效的不算「待投递」
    if (asStr(j.skip_reason)) continue;               // 被规则跳过的（如已投递过）不该出现在这里
    const day = flowDay(j.deadline);
    if (!day) continue;                               // 没填截止日 = 「招满为止」，不构成时间压力
    const d = daysBetweenLocal(today, day);
    if (d == null || d < 0 || d > th.priorityDays) continue;
    priority.push({
      kind: 'deadline', id: asStr(j.id), company: asStr(j.company) || '–',
      position: asStr(j.position) || '–', platform: asStr(j.source), at: day,
      daysLeft: d, isToday: d === 0,
    });
  }
  // ---- 已排定的笔面若就在这几天，也属于「必须优先处理」 ----
  for (const s of schedule) {
    if (s.daysLeft == null || s.daysLeft < 0 || s.daysLeft > th.priorityDays) continue;
    priority.push({
      kind: 'flow', id: s.id, company: s.company, position: s.position, platform: s.platform,
      at: s.at as string, daysLeft: s.daysLeft, isToday: s.daysLeft === 0,
    });
  }
  priority.sort((x, y) => (x.daysLeft - y.daysLeft) || x.company.localeCompare(y.company));

  const metrics = {
    total: list.length,
    sent,
    weekNew: weekly,
    replied,
    repliedRate: sent ? Math.round((replied / sent) * 100) : 0,
    advanced,
    advanceRate: sent ? Math.round((advanced / sent) * 100) : 0,
    written, interview, offer, rejected,
    flowNext7,
    unscheduledFlow,
    stalled: stalledNoProgress,
    deadlineSoon: priority.filter((p) => p.kind === 'deadline').length,
  };

  // ---- 下周行动建议（规则显式、顺序固定、有 code 可断言） ----
  const nextWeek: ReviewSuggestion[] = [];
  if (sent === 0) {
    nextWeek.push({
      code: 'no-sent',
      text: list.length
        ? '台账里有 ' + list.length + ' 条记录，但还没有一条是真投出去的 —— 先去「投递中心」跑一轮。'
        : '还没有任何投递记录 —— 从「校招信息库」挑岗位，或到「投递中心」跑一轮真投。',
    });
  }
  if (metrics.deadlineSoon > 0) {
    nextWeek.push({
      code: 'deadline-soon',
      text: metrics.deadlineSoon + ' 个岗位 ' + th.priorityDays + ' 天内截止 —— 先把这批投掉，其它都可以往后放。',
    });
  }
  if (flowNext7 > 0) {
    nextWeek.push({
      code: 'flow-next-7',
      text: '近 ' + th.weekDays + ' 天有 ' + flowNext7 + ' 场笔面 —— 优先准备这几家，投递量可以暂时降下来。',
    });
  }
  if (unscheduledFlow > 0) {
    nextWeek.push({
      code: 'unscheduled-flow',
      text: unscheduledFlow + ' 条已经进入笔试/面试但没记时间 —— 先在「我的投递」里补上，否则复盘算不出先后。',
    });
  }
  if (stalledNoProgress > 0) {
    nextWeek.push({
      code: 'stalled-applied',
      text: stalledNoProgress + ' 条投出去 ' + th.stalledDays + ' 天以上没动静 —— 与其继续等，不如换一批岗位、或改一版简历。',
    });
  }
  if (sent >= th.lowReplyMinSent && metrics.repliedRate < th.lowReplyRate) {
    nextWeek.push({
      code: 'low-reply-rate',
      text: '已投出 ' + sent + ' 份，回复率只有 ' + metrics.repliedRate + '% —— 先把简历与 JD 的匹配度提上去，别急着加量。',
    });
  }
  if (!nextWeek.length) {
    nextWeek.push({ code: 'steady', text: '没有需要紧急处理的项 —— 保持当前节奏即可。' });
  }

  // ---- 复盘重点：只说一件最该先做的事（顺序 = 上表的顺序） ----
  const focusMap: Record<string, string> = {
    'deadline-soon': '先清掉临近截止的岗位 —— 这是唯一**过了就没了**的事。',
    'flow-next-7': '优先准备近期的笔面，投递可以暂缓。',
    'unscheduled-flow': '先把没记时间的笔面补上 —— 时间不全，复盘的数字都不可信。',
    'stalled-applied': '有一批投了很久没动静 —— 问题更可能在简历/JD 匹配，不在投递量。',
    'no-sent': '还没有真投出去 —— 当务之急是跑通一轮投递。',
    'low-reply-rate': '回复率偏低 —— 先调简历，再加量。',
    steady: '节奏正常，保持当前投递量即可。',
  };
  const firstActionable = nextWeek.find((s) => s.code !== 'low-reply-rate') || nextWeek[0];
  const focus = focusMap[firstActionable.code] || '保持当前节奏即可。';

  return {
    now: now.toISOString(),
    thresholds: th,
    metrics,
    blocks: { priority, schedule, stalled: stalledItems, nextWeek, focus },
  };
}
