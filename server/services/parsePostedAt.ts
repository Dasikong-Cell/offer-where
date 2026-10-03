/**
 * 发布时间解析 —— 把招聘网站列表页/卡片上的「发布时间」文案解析成日期。
 *
 * ## 为什么需要它
 * `jobs` 表此前只有 `created_at`，那是**我们入库的时间**，不是岗位发布的时间。
 * 于是「查当天新开的岗位」只能退化成「查当天采集到的岗位」：某个 9 月 1 日发布的岗位，
 * 我们 10 月 2 日才采集到，用户在「仅当日新增」里看到它，会以为它是新的 —— 而它已经挂了 31 天，
 * 简历多半石沉大海。这两件事必须分开。
 *
 * ## 设计取舍
 * - **纯函数、零依赖、零 IO** ⇒ 可单测（`tests/unit/postedAt.test.ts`）。
 * - **只做到「日」粒度**：各家平台给的最细就是「刚刚 / 今天 / 昨天 / N天前 / M月D日」。
 *   硬编造小时数只会让数据「看起来比实际精确」，下游再拿它做排序就会得出错误结论。
 * - **时区必须可注入**：GitHub Actions 跑在 UTC，用户在 UTC+8。若直接用 `new Date().getDate()`
 *   这类「运行时本地时区」方法，同一份文本在 CI 与本机会差一天，测试将**不可复现**。
 *   默认取运行时本地偏移（真实用户场景正确），测试显式传 480。
 * - **宁可漏报，不可误报**：招聘卡片里充满「3-5年经验」「5-9千」「2027届」这类数字串，
 *   它们与日期的字面形态高度相似。凡是可能把它们误判成日期的写法，一律不支持
 *   （例如裸的 `M-D` 仅在带明确日期上下文时才接受）。理由见 `MIN_DATE_...` 段落注释。
 */

/** 一天的毫秒数（只用于「天序号」换算，不涉及时区） */
const DAY_MS = 86_400_000;

/** 可筛选的时间口径。`any` = 不按发布时间筛。 */
export type PostedWithin = 'today' | '3d' | '7d' | 'any';

/**
 * 口径 → 天数上限（「近 N 天」含今天）。
 * `any` 为 `null`（不筛），与「0 天」区分开 —— 若用 0 表示不限，调用方极易写成 `if (days)` 而漏掉。
 */
export const POSTED_WITHIN_DAYS: Record<PostedWithin, number | null> = {
  today: 1,
  '3d': 3,
  '7d': 7,
  any: null,
};

export interface PostedAtOptions {
  /** 参考时刻（「今天」是哪天）。默认 `new Date()`。 */
  now?: Date;
  /** 时区偏移，分钟，**东为正**（东八区 = 480）。默认取运行时本地偏移。 */
  tzOffsetMinutes?: number;
}

export interface PostedAtHit {
  /** `YYYY-MM-DD`（当地日历）；无法判定为 `null` */
  date: string | null;
  /** 命中的原文片段，便于排查「这条为什么被判成今天」；未命中为 `null` */
  raw: string | null;
  /** 命中来源：相对词（今天/3天前） | 绝对日期（9月2日） | 未命中 */
  kind: 'relative' | 'absolute' | 'none';
}

/** 未命中的统一返回值（对象字面量每次新建，避免调用方误改共享常量） */
function miss(): PostedAtHit {
  return { date: null, raw: null, kind: 'none' };
}

function resolveTz(opts?: PostedAtOptions): number {
  if (typeof opts?.tzOffsetMinutes === 'number') return opts.tzOffsetMinutes;
  // getTimezoneOffset() 返回「UTC − 本地」（东八区 = -480），取负得到「本地 − UTC」
  return -new Date().getTimezoneOffset();
}

/**
 * 把真实时刻换算成「当地日历的天序号」（整数，可直接相减得到相差天数）。
 *
 * 手法：先把 UTC 毫秒平移到当地挂钟时间，再用 **UTC 方法**读出年月日。
 * 这样读出来的是「当地日历」，且结果与运行机的 `TZ` 环境变量无关。
 */
function dayIndexOf(epochMs: number, tz: number): number {
  const d = new Date(epochMs + tz * 60_000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / DAY_MS;
}

/** 天序号 → `YYYY-MM-DD` */
function ymdOf(dayIndex: number): string {
  const d = new Date(dayIndex * DAY_MS);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** `YYYY-MM-DD` → 天序号；非法返回 `null` */
function indexOfYmd(ymd: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!isValidYmd(y, mo, d)) return null;
  return Date.UTC(y, mo - 1, d) / DAY_MS;
}

/** 校验年月日真实存在（挡掉 `2月30日`、`13月1日`） */
function isValidYmd(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || y < 2000 || y > 2100) return false;
  if (!Number.isInteger(m) || m < 1 || m > 12) return false;
  if (!Number.isInteger(d) || d < 1) return false;
  // 该月天数：下个月第 0 天 = 本月最后一天
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= daysInMonth;
}

/** 把「当地日历的年月日」落到天序号上 */
function localYmdToIndex(y: number, m: number, d: number): number | null {
  if (!isValidYmd(y, m, d)) return null;
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

/** 天序号 → 当地日历的年/月/日 */
function localPartsOf(dayIndex: number): { y: number; m: number; d: number } {
  const dt = new Date(dayIndex * DAY_MS);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

// ── 模式表 ──────────────────────────────────────────────────────────────────
//
// ⚠️ 下面每个正则都是**宽松匹配 + 严格校验**两步走：正则只负责「找出像日期的片段」，
//    真正的合法性（月份 1-12、日期存在、年份区间）交给 `isValidYmd`。
//    这样比在正则里堆死板的范围（如 `(0[1-9]|1[0-2])`）可读得多，也不会漏掉 `9` 这种不补零写法。

/**
 * 「字段名 + 日期」——**最高优先级**，也是最可信的一条。
 *
 * 真实数据实测（`_tools/_postedat_realdata_scan.mts`）：BOSS 的详情页文本里有
 * **80 例「更新时间2026-09-20」**。这种写法的语义、格式都毫无歧义，是这个语料里
 * **最强的发布日期证据**，却会被「全文解析」淹没在 `工作时间9-18` 之类的噪音里。
 * 所以单独提一条规则，并且只认 `发布时间|更新时间|刷新|上线|修改` 这几个前缀 ——
 * 刻意**不含「截止」**：「招聘截止时间：2026-12-31」说的是投递窗口关闭，
 * 拿它当发布时间会让「仅当日新增」筛出一批早已没戏的岗位。
 */
const RE_LABELED_DATE = /(?:发布|更新|刷新|上线|修改)(?:时间|日期|于)?\s*[：:]?\s*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/;

/** 同上，但日期是中文写法（`更新于9月2日`）。年份由 `inferYear` 推断。 */
const RE_LABELED_DATE_CN = /(?:发布|更新|刷新|上线|修改)(?:时间|日期|于)?\s*[：:]?\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/;

/** `2026年9月2日` / `2026-09-02` / `2026/9/2` / `2026.9.2`（带 `g`，供 `matchAll` 遍历全部候选） */
const RE_ABS_FULL_G = /(?<!\d)(\d{4})\s*[年\-/.]\s*(\d{1,2})\s*[月\-/.]\s*(\d{1,2})\s*日?/g;

/** `9月2日` / `9月2号`（带 `g`） */
const RE_ABS_CN_MD_G = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/g;

/**
 * 候选日期前面是不是「截止」语境。
 *
 * 🔴 真实库实测：BOSS 详情页里频繁出现 `招聘截止时间：2026-12-31`。
 * 把它当成发布时间，用户会在「只看今天」里看到一批**其实已经关闭投递**的岗位 ——
 * 比筛不出来更糟，因为它是在**主动误导**。
 * （注意：我们不从 JD 正文解析发布时间，所以正常路径不会遇到；但卡片摘要里也可能带截止日，
 *   多这一道守卫的成本是零，收益是「永远不会把截止日当发布日」。）
 */
function isDeadlineContext(text: string, at: number): boolean {
  // 窗口取 10 字符：`投递截止日期 2026-09-30` 里「截止」离日期有 5 个字，
  // 窗口取 6 会漏掉（这正是第一版写完立刻被自己的测试抓到的地方）。
  return /截止|到期|过期|结束/.test(text.slice(Math.max(0, at - 10), at));
}

/**
 * 短横线/斜杠的 `M-D`（不补零或补零皆可）。
 *
 * 🔴 这条是**误报重灾区**。第一版只挡了「年/月/千/万」，结果拿真实库一跑
 * （`_tools/_postedat_realdata_scan.mts`，1202 条 JD），抓出四类漏网误报：
 *   · `10-15k`            → 读成 10 月 15 日（薪资，后缀是 k）
 *   · `工作时间9-18`       → 读成 9 月 18 日（工作时间段）
 *   · `2-3个月`            → 读成 2 月 3 日（「个月」把「月」字挡住了，原守卫 `\s*[年月…]` 匹配不到）
 *   · `1-2轮` / `3-5人`    → 读成 1 月 2 日 / 3 月 5 日（轮次、人数）
 * 实测那批「命中」55 条里绝大多数是这些，**真命中的只有 `招聘截止时间：2026-12-31` 这一类（而且那是截止不是发布）**。
 *
 * 现为四层守卫：
 *   ① 左边界不是数字（`(?<!\d)`）—— 挡住 `2026-09-02` 从第 6 位切出来的碎片；
 *   ② 右边界不是数字；
 *   ③ 右侧不得跟量词（含「个」这个容易被漏掉的前缀字）：`3-5年`、`5-9千`、`2-3个月`、`1-2轮`；
 *   ④ **必须带日期上下文词**（见 `DATE_CONTEXT_RE`，在 `parsePostedAt` 里查前后各 10 字符）：
 *      `09-02更新` ✅ / 孤立一个 `9-18` ❌。
 * 代价是「9-2」这种极简写法在无上下文时会被漏掉 —— 但实测已经证明：
 * **在这个语料里，宁可漏掉一条真日期，也绝不能把「工作时间 9-18」当成发布日期。**
 */
const RE_ABS_MD_DASH = /(?<!\d)(\d{1,2})[-/](\d{1,2})(?!\d)(?!\s*个?\s*[年月日天周轮次人千万])/;

/**
 * 「这是个日期」的上下文词。仅对**歧义最大**的 `M-D` 格式强制要求（见上）。
 * 不要求绝对日期（`2026-09-02`、`9月2日`）带上下文 —— 它们本身已足够特征化，
 * 而要求上下文只会让「更新9月2日」之外的正常写法被无谓地漏掉。
 */
// ⚠️ 这里**不含「截止」**：它与下面 `isDeadlineContext`（把截止日排除掉）直接冲突，
//    两处守卫会在 `招聘截止时间：2026-12-31` 上互相打架 —— 一个说「截止是日期上下文，放行」，
//    另一个说「截止要排除」。结果是 `12-31` 被 ④ 号规则捡走、回退成 2025-12-31。
//    这个矛盾是写完测试立刻抓到的。语义以「排除截止」为准。
const DATE_CONTEXT_RE = /(发布|更新|刷新|上线|新增|投递|发表于|修改)/;

/** `RE_ABS_MD_DASH` 的带 `g` 版本，供 `matchAll` 遍历全部候选（`matchAll` 不会污染 `lastIndex`） */
const RE_ABS_MD_DASH_G = new RegExp(RE_ABS_MD_DASH.source, 'g');

/**
 * 取出与候选日期**紧邻**的那一段文字 —— 被标点/空白断开的不算。
 *
 * 🔴 为什么不能按字符数圈窗口：实测 `工作时间9-18，09-02更新` 里，`9-18` 的后 10 字符窗口
 * 恰好把隔壁的「更新」捞了进来，于是**「工作时间段」被当成了发布日期**。
 * 上下文必须按**标点断开**取，而不是按「附近 N 个字」取 —— 否则窗口开多大都是在赌。
 */
function tightBefore(s: string): string {
  // 取尾部被空白/标点围住的那个 token
  const m = /([^\s，,。；;、！!？?]+)\s*$/.exec(s);
  const t = m ? m[1] : '';
  // 紧邻 token **以数字开头**时不算上下文：那是另一个日期/数字（如 `9-18 09-02更新`
  // 里紧邻 `9-18` 的是 `09-02`），不是「更新/发布」这类连接词。
  return /^\d/.test(t) ? '' : t;
}

function tightAfter(s: string): string {
  const m = /^\s*([^\s，,。；;、！!？?]+)/.exec(s);
  const t = m ? m[1] : '';
  return /^\d/.test(t) ? '' : t;
}

/**
 * HR 活跃度文案的尾随词。
 *
 * 🔴 真实库实测（`_postedat_realdata_scan.mts`）：「刚刚活跃」「本周活跃」「3天前活跃」
 * 被相对词规则整批命中 —— **「HR 最近上过线」被当成了「岗位发布时间」**。
 * 两者在 BOSS 列表页长得几乎一样，含义却完全不同：前者是招聘方的在线概率，
 * 后者才是岗位新鲜度。拿活跃度当发布时间，会让「只看今天」筛出一堆挂了半个月的岗位。
 *
 * 注意：守卫不能只加在 `刚刚` 一条规则上 —— `(\d+天前)` 同样会被 `3天前活跃` 命中，
 * 所以放在**循环外层**对所有相对词统一生效。
 */
const ACTIVITY_TAIL_RE = /^\s*的?\s*(活跃|在线|登录|回复|看过|查看|沟通|访问|浏览)/;

/** 相对词表：命中即得到「相对今天的天偏移」 */
const RELATIVE_RULES: Array<{ re: RegExp; offset: 'fixed' | 'daysBefore' | 'weekStart'; fixed?: number }> = [
  // 「刚刚」「刚发布」—— 出现即是当天
  { re: /(刚刚|刚发布|刚更新|刚上线|刚才)/, offset: 'fixed', fixed: 0 },
  // 「N分钟前」「N小时前」—— 粒度为日，一律算当天
  { re: /(\d+)\s*(?:分钟|小时|分|钟头)\s*前/, offset: 'fixed', fixed: 0 },
  { re: /(今天|今日)/, offset: 'fixed', fixed: 0 },
  { re: /(昨天|昨日)/, offset: 'fixed', fixed: -1 },
  { re: /(前天)/, offset: 'fixed', fixed: -2 },
  { re: /(\d+)\s*天\s*前/, offset: 'daysBefore' },
  // 「本周」是个区间不是点；取本周一（`(dow+6)%7` 天前）作保守下界，
  // 于是「本周」筛出来的一定包含本周全部岗位，不会漏。
  { re: /(本周|这周|本星期)/, offset: 'weekStart' },
];

// ── 主解析 ──────────────────────────────────────────────────────────────────

/**
 * 从任意文本里解析发布时间。
 *
 * @example
 *   parsePostedAt('Java开发 15-25K 今天发布', { now, tzOffsetMinutes: 480 })
 *   → { date: '2026-10-02', raw: '今天', kind: 'relative' }
 *
 * @example
 *   parsePostedAt('更新9月2日 / 2027届 / 投递入口', { now, tzOffsetMinutes: 480 })
 *   → { date: '2026-09-02', raw: '9月2日', kind: 'absolute' }
 */
export function parsePostedAt(
  text: string | null | undefined,
  opts?: PostedAtOptions,
): PostedAtHit {
  if (!text) return miss();
  const tz = resolveTz(opts);
  const todayIdx = dayIndexOf((opts?.now ?? new Date()).getTime(), tz);

  // ── 最高优先：带字段名的日期（`更新时间2026-09-20`）──
  // 字段名本身就是最强的上下文，语义无歧义，因此不受下面那条「上下文守卫」约束。
  // 真实库实测：BOSS 详情页有 80 例这种写法，是这批数据里最可靠的发布时间来源。
  const labeled = matchLabeledDate(text, todayIdx);
  if (labeled) return labeled;

  // ── 次优先：相对词 ──
  // 相对词比绝对日期更可靠：卡片上既写「今天」又印着一个广告日期时，前者才是发布时间。
  for (const rule of RELATIVE_RULES) {
    const m = rule.re.exec(text);
    if (!m) continue;
    // 活跃度守卫：命中的片段后面紧跟「活跃/在线/…」⇒ 这是 HR 活跃度，不是发布时间。
    // 不能 `return null` —— 同一段文本后面可能还有真正的发布时间，继续试下一条规则。
    if (ACTIVITY_TAIL_RE.test(text.slice(m.index + m[0].length, m.index + m[0].length + 8))) continue;
    let idx: number | null = null;
    if (rule.offset === 'fixed') idx = todayIdx + (rule.fixed ?? 0);
    else if (rule.offset === 'daysBefore') idx = todayIdx - Number(m[1]);
    else {
      // 本地日历的星期几：0=周日。周一往回退 (dow+6)%7 天。
      const dow = new Date(todayIdx * DAY_MS).getUTCDay();
      idx = todayIdx - ((dow + 6) % 7);
    }
    return { date: ymdOf(idx), raw: m[1] ?? m[0], kind: 'relative' };
  }

  // ── 第三优先：绝对日期 ──
  // 两类都用 matchAll 遍历全部候选，而不是只取第一个匹配：
  // 文本里可能先出现一个「招聘截止时间：2026-12-31」（我们不要），后面才是有用的发布时间。
  const t = localPartsOf(todayIdx);

  // ① 带年份的完整日期
  for (const cand of text.matchAll(RE_ABS_FULL_G)) {
    if (isDeadlineContext(text, cand.index ?? 0)) continue;
    const idx = localYmdToIndex(Number(cand[1]), Number(cand[2]), Number(cand[3]));
    if (idx !== null) return { date: ymdOf(idx), raw: cand[0].trim(), kind: 'absolute' };
  }

  // ② 中文「M月D日」—— 不带年，需推断年份
  for (const cand of text.matchAll(RE_ABS_CN_MD_G)) {
    if (isDeadlineContext(text, cand.index ?? 0)) continue;
    const idx = inferYear(Number(cand[1]), Number(cand[2]), t.y, todayIdx);
    if (idx !== null) return { date: ymdOf(idx), raw: cand[0].trim(), kind: 'absolute' };
  }

  // ④ 短横线 M-D —— 歧义最大，必须带日期上下文词才认（见 RE_ABS_MD_DASH 注释）。
  // 用 matchAll 而不是 exec：文本里可能先出现一个「像日期但其实不是」的片段
  // （如「工作时间9-18 …… 9-02更新」），只取第一个匹配会直接漏掉后面的真日期。
  for (const cand of text.matchAll(RE_ABS_MD_DASH_G)) {
    const at = cand.index ?? 0;
    if (isDeadlineContext(text, at)) continue;
    // 按标点断开取紧邻片段（见 tightBefore 注释：按字符数圈窗口会把隔壁的词捞进来）
    const before = tightBefore(text.slice(Math.max(0, at - 12), at));
    const after = tightAfter(text.slice(at + cand[0].length, at + cand[0].length + 12));
    if (!DATE_CONTEXT_RE.test(before) && !DATE_CONTEXT_RE.test(after)) continue;
    const idx = inferYear(Number(cand[1]), Number(cand[2]), t.y, todayIdx);
    if (idx !== null) return { date: ymdOf(idx), raw: cand[0].trim(), kind: 'absolute' };
  }

  return miss();
}

/**
 * 匹配「字段名 + 日期」。
 *
 * 抽成独立函数，是为了让**详情页长文本**能只走这一条精确通道
 * （见 `postedAtFromLabeled`），而不必把整篇 JD 丢进全规则解析器 ——
 * 实测那样做的命中率只有 2%，且绝大多数是 `工作时间9-18`、公司成立日期、宣讲会时间这类噪声。
 */
function matchLabeledDate(text: string, todayIdx: number): PostedAtHit | null {
  let m = RE_LABELED_DATE.exec(text);
  if (m) {
    const idx = localYmdToIndex(Number(m[1]), Number(m[2]), Number(m[3]));
    if (idx !== null) return { date: ymdOf(idx), raw: m[0].trim(), kind: 'absolute' };
  }
  m = RE_LABELED_DATE_CN.exec(text);
  if (m) {
    const t = localPartsOf(todayIdx);
    const idx = inferYear(Number(m[1]), Number(m[2]), t.y, todayIdx);
    if (idx !== null) return { date: ymdOf(idx), raw: m[0].trim(), kind: 'absolute' };
  }
  return null;
}

/**
 * 「M月D日」不含年份时的年份推断。
 *
 * 规则：默认取当年；若推出来的日期**晚于**今天，则认为是去年。
 * 留 1 天容差（`> today + 1` 才回退）—— 招聘网站不会标未来日期，
 * 但「今天 9月1日、卡片写 9月2日」这种跨零点/预发布场景确实存在，容差能避免把它算成一年前。
 */
function inferYear(month: number, day: number, currentYear: number, todayIdx: number): number | null {
  const thisYear = localYmdToIndex(currentYear, month, day);
  if (thisYear === null) return null;
  if (thisYear > todayIdx + 1) {
    return localYmdToIndex(currentYear - 1, month, day);
  }
  return thisYear;
}

// ── 下游辅助 ────────────────────────────────────────────────────────────────

/**
 * 把任意时间戳（如 `created_at` 的 ISO 串）转成**当地日历**的 `YYYY-MM-DD`。
 *
 * 用于「发布时间缺失时退回入库时间」的兜底口径。必须走本函数而不是 `iso.slice(0, 10)`：
 * `created_at` 存的是 UTC ISO 串，直接截前 10 位会在 UTC+8 的 00:00–08:00 之间把
 * 「今天采的岗位」算成昨天，于是「仅当日新增」在清晨会莫名其妙地空掉。
 */
export function localDateOf(value: string | null | undefined, opts?: PostedAtOptions): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  if (Number.isFinite(t)) return ymdOf(dayIndexOf(t, resolveTz(opts)));
  // 已经是 `YYYY-MM-DD`（或带时间但不被 Date.parse 接受）时，退一步按前缀取
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * **只认「带字段名的日期」** —— 专供详情页正文这类长文本。
 *
 * 🔴 为什么长文本不能直接用 `parsePostedAt`：在 1202 条真实 JD 上实测，
 * 全文解析命中 2%，且剩下的几乎全是噪声 —— 「工作时间9-18」、「招聘截止时间」、
 * 公司成立日期、宣讲会时间。长文本里「像日期的数字」太多，靠守卫堵不干净。
 * 而带字段名的日期是另一回事：`更新时间2026-09-20`（真实库 80 例）语义明确、
 * 格式规整，不会和经验/薪资/工时混淆。⇒ **长文本只走这条精确通道，宁少不错。**
 */
export function postedAtFromLabeled(text: string | null | undefined, opts?: PostedAtOptions): string | null {
  if (!text) return null;
  const todayIdx = dayIndexOf((opts?.now ?? new Date()).getTime(), resolveTz(opts));
  return matchLabeledDate(text, todayIdx)?.date ?? null;
}

/**
 * 把任意来源的值收敛成 `YYYY-MM-DD` 或 `null`（入库前的最后一道收敛）。
 *
 * 采集层应当直接用 `parsePostedAt` 解析；本函数是为了**兜住两种常见情况**：
 *   ① 调用方图省事，直接把卡片原文传进来（`'更新9月2日'`）—— 也应该落成正确日期；
 *   ② 传进来的值根本认不出来 —— 返回 `null`，而不是存一段乱七八糟的文本。
 *      后者很关键：`posted_at` 存了 `'面议'` 这类脏值后，筛选端 `= '2026-10-02'`
 *      永远匹配不上，岗位会**静默消失**在「仅当日新增」里，且没有任何地方会报错。
 */
export function normalizePostedDate(value: unknown, opts?: PostedAtOptions): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const v = String(value).trim();
  if (!v) return null;
  // 已是标准形态：只校验合法性，不再丢进文本解析器
  // （否则 `'2026-10-02'` 会走「YYYY-MM-DD」分支并被重新推断年份，多一次无谓的不确定性）
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) {
    return isValidYmd(Number(m[1]), Number(m[2]), Number(m[3])) ? v : null;
  }
  return parsePostedAt(v, opts).date;
}

/**
 * 日期是否落在「近 `days` 天」内（含今天，`days` 为天数的**上限**）。
 *
 * `isWithinDays('2026-10-02', 1)` 表示「就在今天」；`3` 表示今天/昨天/前天。
 * 未来日期（差值 < 0）**算在窗口内**：宁可多给用户看一条，也不要因为解析出的极小日期偏差而漏掉刚发布的岗位。
 */
export function isWithinDays(
  date: string | null | undefined,
  days: number,
  opts?: PostedAtOptions,
): boolean {
  if (!date) return false;
  const idx = indexOfYmd(date);
  if (idx === null) return false;
  const todayIdx = dayIndexOf((opts?.now ?? new Date()).getTime(), resolveTz(opts));
  return todayIdx - idx < days;
}

/** 把外部传入的口径（可能来自前端 / 老记录）收敛成合法值；不认识的一律 `null`（= 调用方应视为不筛） */
export function parsePostedWithin(value: unknown): PostedWithin | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (v === 'today' || v === '3d' || v === '7d' || v === 'any') return v;
  return null;
}

/** 口径 → 天数（不筛返回 `null`）；内部先过一遍 `parsePostedWithin`，脏值当「不筛」 */
export function postedWithinDays(value: unknown): number | null {
  const v = parsePostedWithin(value);
  return v ? POSTED_WITHIN_DAYS[v] : null;
}

/** 供 UI 下拉与文档复用的一份清单（顺序即展示顺序） */
export const POSTED_WITHIN_LABELS: Array<{ value: PostedWithin; label: string }> = [
  { value: 'any', label: '不限' },
  { value: 'today', label: '今天' },
  { value: '3d', label: '近 3 天' },
  { value: '7d', label: '近 7 天' },
];

/** 今天的当地日期（`YYYY-MM-DD`）。便于调用方把「今天」写进筛选条件而不必自己算时区。 */
export function todayLocal(opts?: PostedAtOptions): string {
  return ymdOf(dayIndexOf((opts?.now ?? new Date()).getTime(), resolveTz(opts)));
}
