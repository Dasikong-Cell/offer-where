/**
 * 发布时间解析单测。
 *
 * ⚠️ 每条用例都**显式传 `tzOffsetMinutes: 480`**（东八区），不依赖运行机时区。
 *    原因：GitHub Actions 跑在 UTC，本机在 UTC+8。若让解析器取「运行时本地时区」，
 *    同一份文本会在 CI 与本机算出差一天的日期 —— 测试会变成「在 CI 上红、在本机绿」的
 *    薛定谔状态，而那种失败几乎没人能快速归因。
 *
 * ⚠️ 断言的重点不在「能解析出日期」，而在**不该解析的地方必须解析不出来**：
 *    招聘卡片里「3-5年经验」「5-9千」「2027届」与日期的字面形态高度相似，
 *    一旦误判，用户的「只看今天」会混进一堆挂了半年的岗位，且**没有任何报错**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePostedAt,
  isWithinDays,
  localDateOf,
  parsePostedWithin,
  postedWithinDays,
  todayLocal,
  POSTED_WITHIN_DAYS,
} from '../../server/services/parsePostedAt.js';

const TZ = { tzOffsetMinutes: 480 } as const;

/** 固定参考时刻：东八区 2026-10-02 10:00（= UTC 02:00，同一天，避免跨零点歧义） */
const NOW = new Date('2026-10-02T02:00:00.000Z');

const at = (text: string, now: Date = NOW) => parsePostedAt(text, { ...TZ, now });
const day = (text: string, now: Date = NOW) => at(text, now).date;

// ── A. 相对时间 ────────────────────────────────────────────────────────────
const RELATIVE_CASES: Array<[string, string, string]> = [
  // [卡片文案, 期望日期, 用例说明]
  ['Java开发工程师 今天发布', '2026-10-02', '今天'],
  ['前端开发 今日更新', '2026-10-02', '今日'],
  ['刚刚发布 · 15-25K', '2026-10-02', '刚刚'],
  ['财务专员 30分钟前发布', '2026-10-02', 'N分钟前算当天'],
  ['运维工程师 3小时前', '2026-10-02', 'N小时前算当天'],
  ['销售代表 昨天发布', '2026-10-01', '昨天'],
  ['客服主管 昨日刷新', '2026-10-01', '昨日'],
  ['测试工程师 前天发布', '2026-09-30', '前天'],
  ['Java开发 3天前发布', '2026-09-29', 'N天前'],
  ['算法工程师 15天前发布', '2026-09-17', '两位数的 N 天前'],
  ['本周新品发布 招java', '2026-09-28', '本周 → 本周一（2026-10-02 是周五）'],
];
for (const [text, expect, why] of RELATIVE_CASES) {
  test(`相对时间 · ${why}：「${text}」→ ${expect}`, () => {
    assert.equal(day(text), expect);
  });
}

// ── B. 绝对日期 ────────────────────────────────────────────────────────────
const ABSOLUTE_CASES: Array<[string, string, string]> = [
  ['2026-09-02', '2026-09-02', 'ISO 串'],
  ['2026/9/2 发布', '2026-09-02', '斜杠 + 不补零'],
  ['2026.9.2', '2026-09-02', '点分隔'],
  ['2026年9月2日发布', '2026-09-02', '中文年月日'],
  ['更新9月2日 / 2027届 / 投递入口', '2026-09-02', 'offerbiu card_text 真实样本'],
  ['9月2日', '2026-09-02', '仅 M月D日'],
  ['9月2号更新', '2026-09-02', 'M月D号'],
  ['09-02 更新', '2026-09-02', '补零 M-D'],
];
for (const [text, expect, why] of ABSOLUTE_CASES) {
  test(`绝对日期 · ${why}：「${text}」→ ${expect}`, () => {
    assert.equal(day(text), expect);
  });
}

// ── C. 误报守卫（本文件最重要的部分）────────────────────────────────────────
const FALSE_POSITIVES: Array<[string, string]> = [
  ['Java开发工程师 3-5年经验 15-25K', '「3-5年」是经验年限，不是 3 月 5 日'],
  ['前端开发 1-3年 5-9千', '「5-9千」是薪资区间'],
  ['实习岗 2027届 本科', '「2027届」是届别'],
  ['薪资 9千-1.1万', '薪资区间带「万」'],
  ['本科 3-5年 招2人', '「招2人」不是日期'],
  ['无发布时间信息', '纯文本无日期'],
  ['2月30日发布', '2 月没有 30 日 → 非法日期必须落空'],
  ['13月1日', '月份越界'],
  ['', '空串'],
  // ── 以下五条是 `_tools/_postedat_realdata_scan.mts` 在**真实库 1202 条 JD 上**
  //    实测抓出来的误报，第一版守卫全部漏网。原样留作回归，别再退化。──────
  ['25年或者以前毕业 10-15k 初级', '薪资「10-15k」（曾被读成 10 月 15 日）'],
  ['工作时间9-18，午休2h，周末双休', '工作时间段「9-18」（曾被读成 9 月 18 日）'],
  ['短期2-3个月项目，400元/天', '「2-3个月」的「个月」挡住了「月」（曾被读成 2 月 3 日）'],
  ['面试方式：线上面试（1-2轮）', '面试轮次「1-2轮」（曾被读成 1 月 2 日）'],
  ['技术团队 3-5人 小团队', '团队人数「3-5人」'],
  // ── BOSS 的 HR 活跃度文案。实测真实库时整批被误判成发布时间，含义完全不同：
  //    「刚刚活跃」说的是 HR 上过线，「刚刚发布」说的才是岗位新鲜度。────────
  ['查昌寿 本周活跃', 'BOSS「本周活跃」'],
  ['刚刚活跃', 'BOSS「刚刚活跃」'],
  ['3天前活跃', 'BOSS「3天前活跃」（相对词规则同样会命中，守卫须统一生效）'],
  ['今日活跃 回复很快', 'BOSS「今日活跃」'],
  ['招聘截止时间：2026-12-31', '「截止时间」是投递窗口关闭，不是发布时间（真实库实测样本）'],
];

test('活跃度守卫只跳过那一条规则，后面真正的发布时间仍能找到', () => {
  assert.equal(day('刚刚活跃 09-02更新'), '2026-09-02');
  assert.equal(day('本周活跃 Java开发 今天发布'), '2026-10-02');
});
for (const [text, why] of FALSE_POSITIVES) {
  test(`误报守卫 · ${why}：「${text}」→ null`, () => {
    assert.equal(day(text), null, `不该把「${text}」解析成日期`);
    assert.equal(at(text).kind, 'none');
  });
}

test('短横线格式必须带日期上下文词才认（收紧后的正向面）', () => {
  // 收紧守卫不能把真日期一起收掉 —— 否则「防误报」就变成了「什么都不认」
  assert.equal(day('09-02更新'), '2026-09-02', '后缀「更新」');
  assert.equal(day('更新 09-02'), '2026-09-02', '前缀「更新」');
  assert.equal(day('刷新9-2'), '2026-09-02', '前缀「刷新」');
});

test('量词守卫在「上下文词紧邻」时不可替代（上下文守卫兜不住的那一类）', () => {
  // 破坏性对照（`_tools/_postedat_control.py` 的 A 组）发现：摘掉量词守卫后，
  // 「3-5年」「2-3个月」这些用例**仍然全绿** —— 因为它们不紧邻上下文词，
  // 已经被上下文守卫挡住了 ⇒ 量词守卫看起来"没有区分力"。
  // 但那是**纵深防御**，不是冗余：下面这两条里「更新/刷新」紧邻日期，
  // 上下文守卫会放行，此时**只有量词守卫拦得住**。
  assert.equal(day('更新2-3个月'), null, '紧邻「更新」的「2-3个月」仍是量词');
  assert.equal(day('刷新1-2轮面试'), null, '紧邻「刷新」的「1-2轮」仍是量词');
});

test('上下文里先出现"像日期的噪音"时，仍能找到后面真正带上下文的日期', () => {
  // 这条专门盯 `matchAll` 的遍历：若只取第一个匹配，就会在「9-18」上判负然后直接放弃
  assert.equal(day('工作时间9-18，09-02更新'), '2026-09-02');
});

test('误报守卫 · null / undefined 输入不抛错', () => {
  assert.equal(parsePostedAt(null).date, null);
  assert.equal(parsePostedAt(undefined).date, null);
  assert.deepEqual(parsePostedAt(null), { date: null, raw: null, kind: 'none' });
});

// ── D. 跨年推断 ────────────────────────────────────────────────────────────
test('跨年 · 1 月看到「9月2日」应回退到去年', () => {
  const jan = new Date('2026-01-05T02:00:00.000Z');
  assert.equal(day('更新9月2日', jan), '2025-09-02');
});

test('跨年 · 明天（容差 1 天）不回退，仍取当年', () => {
  const sep1 = new Date('2026-09-01T02:00:00.000Z');
  assert.equal(day('9月2日', sep1), '2026-09-02');
});

test('跨年 · 后天超出容差，回退到去年', () => {
  const sep1 = new Date('2026-09-01T02:00:00.000Z');
  assert.equal(day('9月3日', sep1), '2025-09-03');
});

test('跨年 · 带四位年时不推断，原样保留', () => {
  const jan = new Date('2026-01-05T02:00:00.000Z');
  assert.equal(day('2026年9月2日发布', jan), '2026-09-02');
});

// ── E. raw / kind 字段（供排查与留痕）──────────────────────────────────────
test('raw 保留命中原文，便于回答「为什么判成今天」', () => {
  assert.equal(at('Java开发 今天发布 15-25K').raw, '今天');
  // 加了「字段名」规则后，raw 会把「更新」一起带上 —— 信息更完整，排查时更好认
  assert.equal(at('更新9月2日 / 2027届').raw, '更新9月2日');
});

test('带字段名的日期优先级最高（真实库 BOSS 详情页 80 例的来源）', () => {
  assert.equal(day('更新时间2026-09-20'), '2026-09-20');
  assert.equal(day('发布时间：2026-09-20'), '2026-09-20');
  assert.equal(day('更新于9月2日'), '2026-09-02');
  assert.equal(at('更新时间2026-09-20').raw, '更新时间2026-09-20');
});

test('「截止时间」不得被当成发布时间', () => {
  // 真实库实测样本：BOSS 详情页频繁出现「招聘截止时间：2026-12-31」。
  // 把它当发布时间，用户会在「只看今天」里看到一批**其实已经关闭投递**的岗位 —— 比筛不出来更糟。
  assert.equal(day('招聘截止时间：2026-12-31'), null);
  assert.equal(day('投递截止日期 2026-09-30'), null);
  // 但同一段文本里若还有真正的发布时间，必须能找到它（不能被截止日挡在前面就放弃）
  assert.equal(day('招聘截止时间：2026-12-31 更新时间：2026-09-20'), '2026-09-20');
});

test('kind 区分相对词与绝对日期', () => {
  assert.equal(at('昨天发布').kind, 'relative');
  assert.equal(at('9月2日').kind, 'absolute');
});

// ── F. 时区正确性 ──────────────────────────────────────────────────────────
test('localDateOf 不截字符串前缀：UTC 17:00 在东八区已是次日', () => {
  assert.equal(localDateOf('2026-10-01T17:00:00.000Z', TZ), '2026-10-02');
  // 同一时刻在 UTC 下仍是当天 —— 证明差异来自时区参数而非实现写死
  assert.equal(localDateOf('2026-10-01T17:00:00.000Z', { tzOffsetMinutes: 0 }), '2026-10-01');
});

test('localDateOf 对脏输入返回 null 而不猜', () => {
  assert.equal(localDateOf(null, TZ), null);
  assert.equal(localDateOf('', TZ), null);
  assert.equal(localDateOf('不是时间', TZ), null);
});

test('todayLocal 跟随 now 与时区', () => {
  assert.equal(todayLocal({ ...TZ, now: NOW }), '2026-10-02');
  // UTC 02:00 = 东八区 10:00（同天）；同一时刻在东九区 = 11:00（仍同天）
  assert.equal(todayLocal({ tzOffsetMinutes: 0, now: new Date('2026-10-01T23:30:00.000Z') }), '2026-10-01');
  assert.equal(todayLocal({ tzOffsetMinutes: 480, now: new Date('2026-10-01T23:30:00.000Z') }), '2026-10-02');
});

// ── G. isWithinDays 边界 ───────────────────────────────────────────────────
test('isWithinDays：今天口径只认当天', () => {
  assert.equal(isWithinDays('2026-10-02', 1, { ...TZ, now: NOW }), true);
  assert.equal(isWithinDays('2026-10-01', 1, { ...TZ, now: NOW }), false);
});

test('isWithinDays：近 3 天含今天/昨天/前天，不含第 4 天', () => {
  assert.equal(isWithinDays('2026-10-02', 3, { ...TZ, now: NOW }), true);
  assert.equal(isWithinDays('2026-10-01', 3, { ...TZ, now: NOW }), true);
  assert.equal(isWithinDays('2026-09-30', 3, { ...TZ, now: NOW }), true);
  assert.equal(isWithinDays('2026-09-29', 3, { ...TZ, now: NOW }), false);
});

test('isWithinDays：近 7 天的边界是第 7 天（差 7 天不算）', () => {
  assert.equal(isWithinDays('2026-09-26', 7, { ...TZ, now: NOW }), true);
  assert.equal(isWithinDays('2026-09-25', 7, { ...TZ, now: NOW }), false);
});

test('isWithinDays：null / 非法日期返回 false', () => {
  assert.equal(isWithinDays(null, 7, { ...TZ, now: NOW }), false);
  assert.equal(isWithinDays('', 7, { ...TZ, now: NOW }), false);
  assert.equal(isWithinDays('2026-13-01', 7, { ...TZ, now: NOW }), false);
});

// ── H. 口径归一化 ──────────────────────────────────────────────────────────
test('parsePostedWithin 收敛脏值', () => {
  assert.equal(parsePostedWithin('today'), 'today');
  assert.equal(parsePostedWithin(' TODAY '), 'today');
  assert.equal(parsePostedWithin('3d'), '3d');
  assert.equal(parsePostedWithin('any'), 'any');
  assert.equal(parsePostedWithin('30d'), null, '不认识的口径必须落 null，而不是静默当 today');
  assert.equal(parsePostedWithin(undefined), null);
  assert.equal(parsePostedWithin(7), null);
});

test('postedWithinDays：any 是「不筛」而非 0 天', () => {
  assert.equal(postedWithinDays('today'), 1);
  assert.equal(postedWithinDays('3d'), 3);
  assert.equal(postedWithinDays('7d'), 7);
  assert.equal(postedWithinDays('any'), null);
  assert.equal(postedWithinDays('乱写的'), null);
  assert.equal(POSTED_WITHIN_DAYS.any, null);
});
