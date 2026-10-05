/**
 * 「投递复盘」口径单测。
 *
 * 这个模块存在的意义**全在口径**：什么算「已投出」、几天算「没进展」、什么算「本周」。
 * 所以最有价值的用例不是「能算出个数」，而是下面这几组：
 *   · B 组 —— `written`（笔试）必须同时算进「已投出」与「已推进」，否则加了笔试阶段
 *            却让它从两个比率里漏掉（界面多一列、数字没变）。
 *   · C 组 —— 「剩 3 天」在内、「剩 4 天」在外、**已截止的在外**（已截止还提示「优先投」
 *            等于让人去投一个已经关了的岗）。
 *   · D 组 —— 「没进展」与「没记时间」是两种情况，reason 不能混。
 *   · F 组 —— `created_at`（UTC 时刻）与 `written_at`（手填日历日）**不是同一种时间**，
 *            一个要按本地时区折算、一个**不能再折算**。这条是老坑 `posted_at` 的另一面。
 *
 * ⚠️ 全部用例显式传 `now`，且所有日期都用**本地日历**构造（`new Date(y, m, d)`），
 *    不依赖运行机时区 —— CI 跑在 UTC，本机在 UTC+8，两边必须同结论。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReviewPlan,
  normalizeFlowTime,
  flowDay,
  instantDay,
  normalizeRound,
  daysBetweenLocal,
  localDayKey,
  REVIEW_THRESHOLDS,
  SENT_STATUSES,
  ADVANCED_STATUSES,
} from '../../server/services/reviewPlan.js';
import type { ReviewAppInput, ReviewJobInput } from '../../server/services/reviewPlan.js';

/** 本地 2026-10-08 10:00 —— 与运行机时区无关的「现在」。 */
const NOW = new Date(2026, 9, 8, 10, 0, 0);

const pad = (n: number) => (n < 10 ? '0' + n : String(n));

/** 相对今天 offset 天的**本地**日历日串（YYYY-MM-DD）。 */
function localDay(offset: number): string {
  const d = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + offset);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/** 本地「今天 + offset 天」的 hh 点，折成 ISO（UTC）串 —— 模拟 created_at 的真实形态。 */
function isoAt(offset: number, hh = 10): string {
  return new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + offset, hh, 0, 0).toISOString();
}

let seq = 0;
function app(o: Partial<ReviewAppInput> & { status: string }): ReviewAppInput {
  seq++;
  return {
    id: 'a' + seq, company: '某公司' + seq, position: 'Java开发', platform: 'boss',
    created_at: isoAt(-1), ...o,
  };
}

function plan(apps: ReviewAppInput[], jobs: ReviewJobInput[] = []) {
  return buildReviewPlan(apps, jobs, { now: NOW });
}

function job(o: Partial<ReviewJobInput> = {}): ReviewJobInput {
  seq++;
  return { id: 'j' + seq, company: '岗位' + seq, position: '后端', source: 'offerbiu', status: 'candidate', ...o };
}

// ── A. 时间工具 ─────────────────────────────────────────────────────────────
test('A1 normalizeFlowTime：只到日的原样、带时刻的裁掉秒/毫秒/时区', () => {
  assert.equal(normalizeFlowTime('2026-10-08'), '2026-10-08');
  assert.equal(normalizeFlowTime('2026-10-08 10:30'), '2026-10-08 10:30');
  assert.equal(normalizeFlowTime('2026-10-08T10:30'), '2026-10-08 10:30');
  assert.equal(normalizeFlowTime('2026-10-08 10:30:59'), '2026-10-08 10:30');
  assert.equal(normalizeFlowTime('2026-10-08 10:30:59.123Z'), '2026-10-08 10:30');
  assert.equal(normalizeFlowTime(' 2026-10-08 '), '2026-10-08', '首尾空白要裁掉');
});

test('A2 normalizeFlowTime：空 / 非法一律 null（宁可当没填）', () => {
  for (const v of [null, undefined, '', '   ', '下周', '2026/10/08', '10-08', 0, {}]) {
    assert.equal(normalizeFlowTime(v), null, `${JSON.stringify(v)} 应判为没填`);
  }
  // 月份/日期越界必须是 null，不能落成「看起来有值」的串（排序会被它搅乱）
  assert.equal(normalizeFlowTime('2026-13-45'), null);
  assert.equal(normalizeFlowTime('2026-02-31'), null, '2 月 31 日会被 Date 静默滚成 3 月 3 日，必须拦下');
  // 时刻非法时退化成「只到日」，整条不丢
  assert.equal(normalizeFlowTime('2026-10-08 25:00'), '2026-10-08');
});

test('A3 flowDay / daysBetweenLocal：按本地日历算，不做时区折算', () => {
  assert.equal(flowDay('2026-10-08 23:59'), '2026-10-08');
  assert.equal(flowDay(''), null);
  assert.equal(daysBetweenLocal(localDay(0), localDay(0)), 0);
  assert.equal(daysBetweenLocal(localDay(0), localDay(3)), 3);
  assert.equal(daysBetweenLocal(localDay(0), localDay(-2)), -2);
  assert.equal(daysBetweenLocal('垃圾', localDay(0)), null);
  // 跨月/跨年（2026-10-08 向前 8 天 = 09-30）
  assert.equal(daysBetweenLocal(localDay(-8), localDay(0)), 8);
});

test('A4 instantDay：created_at 是「时刻」，必须折成本地日历日', () => {
  // 期望值由测试自己用本地 getter 独立算一遍 —— 直接 slice(0,10) 的实现会在 UTC+8 差一天
  for (const off of [0, -1, 5, -40]) {
    const iso = isoAt(off);
    const d = new Date(iso);
    const expect = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    assert.equal(instantDay(iso), expect, `${iso} 的本地日历日`);
    assert.equal(instantDay(iso), localDay(off));
  }
  // 老数据形态（空格分隔、无时区，本地语义）
  assert.equal(instantDay('2026-10-08 09:00:00'), '2026-10-08');
  // 纯日期串按「写的就是那天」处理，不拿它当 UTC 午夜去折算
  assert.equal(instantDay('2026-10-08'), '2026-10-08');
  assert.equal(instantDay(''), null);
  assert.equal(instantDay('不是日期'), null);
});

test('A5 localDayKey 用的是本地日历（不是 toISOString）', () => {
  const d = new Date(2026, 0, 1, 0, 30, 0);
  assert.equal(localDayKey(d), '2026-01-01');
});

test('A6 normalizeRound：去空白、限长、空转 null', () => {
  assert.equal(normalizeRound('  二面 '), '二面');
  assert.equal(normalizeRound('HR   面'), 'HR 面');
  assert.equal(normalizeRound(''), null);
  assert.equal(normalizeRound(null), null);
  assert.equal(normalizeRound('一二三四五六七八九十十一十二十三'), '一二三四五六七八九十十一', '超过 12 字要截断');
});

// ── B. 指标口径（含 written） ───────────────────────────────────────────────
test('B1 written 必须同时进「已投出」与「已推进」—— 阶段加列不能只是界面加一列', () => {
  const r = plan([app({ status: 'written' }), app({ status: 'applied' })]);
  assert.equal(r.metrics.written, 1);
  assert.equal(r.metrics.sent, 2, '笔试也是投出去了');
  assert.equal(r.metrics.advanced, 1, '笔试属于「推进到笔试及以后」');
  assert.equal(r.metrics.advanceRate, 50);
  assert.ok(ADVANCED_STATUSES.includes('written'), '笔试必须在「已推进」口径里');
});

test('B2 已投出含 rejected（简历确实投了）、不含 skipped（压根没投）', () => {
  const r = plan([
    app({ status: 'applied' }), app({ status: 'rejected' }),
    app({ status: 'skipped' }), app({ status: 'candidate' }),
  ]);
  assert.equal(r.metrics.total, 4);
  assert.equal(r.metrics.sent, 2);
  assert.equal(r.metrics.rejected, 1);
  assert.ok(SENT_STATUSES.includes('rejected'));
  assert.ok(!SENT_STATUSES.includes('skipped'));
  assert.ok(!SENT_STATUSES.includes('candidate'));
});

test('B3 已拒绝不算「有回复」（它是负面结果，单列），但留在分母里', () => {
  const r = plan([app({ status: 'replied' }), app({ status: 'rejected' }), app({ status: 'rejected' }), app({ status: 'offer' })]);
  assert.equal(r.metrics.sent, 4);
  assert.equal(r.metrics.replied, 2, '只有 replied + offer 算有回复');
  assert.equal(r.metrics.repliedRate, 50);
  assert.equal(r.metrics.offer, 1);
});

test('B4 一条记录都没有时比率是 0，不是 NaN / Infinity', () => {
  const r = plan([]);
  assert.equal(r.metrics.sent, 0);
  assert.equal(r.metrics.repliedRate, 0);
  assert.equal(r.metrics.advanceRate, 0);
  assert.ok(Number.isFinite(r.metrics.advanceRate));
  assert.equal(r.blocks.nextWeek[0].code, 'no-sent');
});

test('B5 阈值随 opts 走（不写死 3 / 7 / 20）', () => {
  const r = buildReviewPlan([], [], { now: NOW, thresholds: { priorityDays: 1, stalledDays: 2 } });
  assert.equal(r.thresholds.priorityDays, 1);
  assert.equal(r.thresholds.stalledDays, 2);
  assert.equal(REVIEW_THRESHOLDS.priorityDays, 3, '默认值不该被改掉');
});

test('B6 now 非法要明确报错，而不是悄悄当成今天', () => {
  assert.throws(() => buildReviewPlan([], [], { now: '不是时间' }), /now/);
});

// ── C. 「近期需要优先处理」窗口 ─────────────────────────────────────────────
test('C1 截止窗口：今天到「剩 priorityDays 天」在内，已截止与更远的不在内', () => {
  const jobs = [
    job({ deadline: localDay(0) }),                 // 今天截止 ✅
    job({ deadline: localDay(3) }),                 // 剩 3 天 ✅
    job({ deadline: localDay(4) }),                 // 剩 4 天 ❌
    job({ deadline: localDay(-1) }),                // 已截止 ❌
    job({ deadline: '' }),                          // 招满为止 ❌
    job({ deadline: '不是日期' }),                    // 解析不出来 ❌
  ];
  const r = plan([app({ status: 'applied' })], jobs);
  assert.equal(r.metrics.deadlineSoon, 2);
  assert.deepEqual(r.blocks.priority.map((p) => p.daysLeft), [0, 3], '按紧急度升序');
  assert.equal(r.blocks.priority[0].isToday, true);
  assert.equal(r.blocks.priority[1].isToday, false);
});

test('C2 已投递 / 已失效 / 被规则跳过的岗位不得进「优先投」', () => {
  const jobs = [
    job({ deadline: localDay(1), status: 'candidate' }),           // ✅
    job({ deadline: localDay(1), status: 'applied' }),             // 已投过
    job({ deadline: localDay(1), status: 'unavailable' }),         // 已失效
    job({ deadline: localDay(1), skip_reason: '已投递过该公司该职位' }), // 被跳过的
  ];
  const r = plan([], jobs);
  assert.equal(r.metrics.deadlineSoon, 1);
  assert.equal(r.blocks.priority.length, 1);
});

test('C3 已排定的笔面若就在这几天，也算「必须优先处理」，且与截止项混排', () => {
  const apps = [
    app({ status: 'interview', interview_at: localDay(1) + ' 14:00', interview_round: '一面' }),
    app({ status: 'written', written_at: localDay(2) + ' 09:00' }),
  ];
  const jobs = [job({ deadline: localDay(0) })];
  const r = plan(apps, jobs);
  assert.equal(r.blocks.priority.length, 3, '1 个截止 + 2 场笔面');
  assert.deepEqual(r.blocks.priority.map((p) => p.kind), ['deadline', 'flow', 'flow']);
  assert.deepEqual(r.blocks.priority.map((p) => p.daysLeft), [0, 1, 2]);
  // 已过期的笔面不再提示（补记历史不该天天弹在「优先处理」里）
  const past = plan([app({ status: 'interview', interview_at: localDay(-2) + ' 14:00' })], []);
  assert.equal(past.blocks.priority.length, 0);
});

// ── D. 「长时间没进展」与「没记时间」是两回事 ───────────────────────────────
test('D1 no-progress：已投出满 stalledDays 天没进笔面的才算', () => {
  const apps = [
    app({ status: 'applied', created_at: isoAt(-7) }),      // ✅
    app({ status: 'applied', created_at: isoAt(-6) }),      // 差一天 ❌
    app({ status: 'replied', created_at: isoAt(-30) }),     // ✅ 有回复但没安排笔面，同样卡着
    app({ status: 'offer', created_at: isoAt(-60) }),       // 已到 Offer，不算卡住
    app({ status: 'rejected', created_at: isoAt(-60) }),    // 已结束，不算卡住
  ];
  const r = plan(apps);
  assert.equal(r.metrics.stalled, 2);
  assert.ok(r.blocks.stalled.every((s) => s.reason === 'no-progress'));
  assert.equal(r.blocks.stalled[0].days, 30, '拖最久的排最前');
});

test('D2 unscheduled-written：状态已到笔试/面试却没记时间的单列，且不并进 no-progress', () => {
  const apps = [
    app({ status: 'written', written_at: '' }),                       // ✅ 笔试没时间
    app({ status: 'interview', interview_at: null }),                 // ✅ 面试没时间
    app({ status: 'written', written_at: localDay(2) + ' 09:00' }),   // 有时间，不算
    app({ status: 'applied', created_at: isoAt(-1) }),                // 刚投，不算
  ];
  const r = plan(apps);
  assert.equal(r.metrics.unscheduledFlow, 2);
  assert.equal(r.metrics.stalled, 0, '「没记时间」不是「没进展」，两者不能互相充数');
  const reasons = r.blocks.stalled.map((s) => s.reason).sort();
  assert.deepEqual(reasons, ['unscheduled-written', 'unscheduled-written']);
});

test('D3 两类 stalled 会同时出现在同一张清单里，且各自带自己的 reason', () => {
  const r = plan([
    app({ status: 'applied', created_at: isoAt(-10) }),
    app({ status: 'written', written_at: '' }),
  ]);
  const byReason: Record<string, number> = {};
  for (const s of r.blocks.stalled) byReason[s.reason] = (byReason[s.reason] || 0) + 1;
  assert.deepEqual(byReason, { 'no-progress': 1, 'unscheduled-written': 1 });
  assert.equal(r.metrics.stalled, 1, 'metrics.stalled 只是 no-progress 那部分');
  assert.equal(r.metrics.unscheduledFlow, 1);
});

// ── E. 笔面清单 ─────────────────────────────────────────────────────────────
test('E1 已排定的按时间升序在前，未排定的排最后且 daysLeft 是 null（不是 0）', () => {
  const apps = [
    app({ status: 'interview', interview_at: localDay(5) + ' 10:00', interview_round: '二面' }),
    app({ status: 'written', written_at: localDay(1) + ' 09:00' }),
    app({ status: 'interview', interview_at: '' }),                    // 时间未定
    app({ status: 'written', written_at: '2026-10-08 25:00' }),        // 时刻非法 ⇒ 退化成只到日
  ];
  const r = plan(apps);
  const s = r.blocks.schedule;
  assert.equal(s.length, 4);
  const last = s[s.length - 1];
  assert.equal(last.scheduled, false, '未排定的挤不到前面，只能排在最后');
  assert.equal(last.daysLeft, null, '未排定必须是 null —— 0 表示「今天」，混了就会天天报「今天有面试」');
  assert.equal(last.at, null);
  const scheduled = s.filter((x) => x.scheduled);
  // 都按 `YYYY-MM-DD[ HH:mm]` 字符串升序 ⇒ 只到日的那条排在当天带时刻的前面
  assert.deepEqual(scheduled.map((x) => x.at), [localDay(0), localDay(1) + ' 09:00', localDay(5) + ' 10:00']);
  assert.equal(scheduled[2].round, '二面');
  assert.equal(scheduled[1].round, '', '笔试没有轮次，空串而不是 null');
  assert.equal(scheduled[0].kind, 'written');
});

test('E2 时间字段有值就一定显示（先填时间后改状态不能被吞），状态只用于判「该不该有时间」', () => {
  const r = plan([
    app({ status: 'offer', offer_at: localDay(1) }),                      // Offer 不是「笔面安排」
    app({ status: 'applied', interview_at: localDay(1) + ' 10:00' }),     // 先填了面试时间、状态还没改 ⇒ 要显示
    app({ status: 'interview' }),                                         // 状态到了却没时间 ⇒ 时间未定
  ]);
  assert.equal(r.blocks.schedule.length, 2);
  assert.equal(r.blocks.schedule.filter((s) => s.scheduled).length, 1);
  assert.equal(r.blocks.schedule.filter((s) => !s.scheduled).length, 1);
  assert.equal(r.metrics.flowNext7, 1);
  assert.equal(r.metrics.unscheduledFlow, 1);
});

// ── F. 「本周」窗口与 created_at / written_at 的不同时间语义 ────────────────
test('F1 weekNew：近 weekDays 个本地日历日（含今天）；跨日的 UTC 串要按本地日算', () => {
  const r = plan([
    app({ status: 'applied', created_at: isoAt(0) }),
    app({ status: 'applied', created_at: isoAt(-6) }),   // 第 7 个日历日，在内
    app({ status: 'applied', created_at: isoAt(-7) }),   // 第 8 个，在外
    app({ status: 'applied', created_at: '' }),
  ]);
  assert.equal(r.metrics.weekNew, 2);
});

test('F2 本地日界的 created_at 仍算「今天」（直接 slice(0,10) 会在 UTC+8 算成昨天）', () => {
  // 本地 00:30 与 23:30 都必须落回同一个本地日
  const early = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), 0, 30, 0).toISOString();
  const late = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), 23, 30, 0).toISOString();
  assert.equal(instantDay(early), localDay(0));
  assert.equal(instantDay(late), localDay(0));
  const r = plan([app({ status: 'applied', created_at: early }), app({ status: 'applied', created_at: late })]);
  assert.equal(r.metrics.weekNew, 2);
});

test('F3 flowNext7 数的是「场次」而不是「条记录」，且只向前看', () => {
  const r = plan([
    app({ status: 'written', written_at: localDay(1) + ' 09:00', interview_at: localDay(3) + ' 14:00' }),
    app({ status: 'interview', interview_at: localDay(6) + ' 10:00' }),
    app({ status: 'interview', interview_at: localDay(7) + ' 10:00' }),     // 第 8 天，超出窗口
    app({ status: 'interview', interview_at: localDay(-1) + ' 10:00' }),    // 已过去，不算「安排」
  ]);
  assert.equal(r.blocks.schedule.length, 5, '1 条既有笔试又有面试 ⇒ 出 2 条笔面');
  assert.equal(r.metrics.flowNext7, 3, '第 1/3/6 天这三场在近 7 天内');
});

test('F4 written_at 不会被当成 UTC 时刻再折一次（填 10 号就该显示 10 号）', () => {
  const r = plan([app({ status: 'written', written_at: '2026-10-10 09:00' })]);
  const s = r.blocks.schedule[0];
  assert.equal(s.at, '2026-10-10 09:00');
  assert.equal(s.daysLeft, daysBetweenLocal(localDay(0), '2026-10-10'));
});

// ── G. 行动建议与复盘重点 ───────────────────────────────────────────────────
test('G1 建议按固定顺序生成，且用 code 而不是文案断言', () => {
  const jobs = [job({ deadline: localDay(1) })];
  const r = plan([
    app({ status: 'written', written_at: localDay(2) + ' 09:00' }),  // 触发 flow-next-7
    app({ status: 'applied', created_at: isoAt(-20) }),              // 触发 stalled-applied
    app({ status: 'interview', interview_at: '' }),                  // 触发 unscheduled-flow
  ], jobs);
  assert.deepEqual(r.blocks.nextWeek.map((s) => s.code), [
    'deadline-soon', 'flow-next-7', 'unscheduled-flow', 'stalled-applied',
  ]);
  assert.ok(r.blocks.nextWeek.every((s) => s.text && s.text.length > 5), '文案不能为空');
});

test('G2 没有紧急项时给一条 steady，而不是空数组（页面不会显示一片空白）', () => {
  const r = plan([app({ status: 'applied', created_at: isoAt(0) })]);
  assert.deepEqual(r.blocks.nextWeek.map((s) => s.code), ['steady']);
  assert.ok(r.blocks.focus.length > 0);
});

test('G3 回复率偏低要在「投够量」之后才提示（避免 2 投 0 回复就下结论）', () => {
  const few = plan([app({ status: 'applied' }), app({ status: 'applied' })]);
  assert.ok(!few.blocks.nextWeek.some((s) => s.code === 'low-reply-rate'));
  const many = Array.from({ length: 25 }, () => app({ status: 'applied' }));
  const r = plan(many);
  assert.ok(r.blocks.nextWeek.some((s) => s.code === 'low-reply-rate'));
  assert.equal(r.metrics.repliedRate, 0);
});

test('G4 复盘重点只讲一件事，且优先讲「错过就没了」的那件', () => {
  const r = plan(
    [app({ status: 'applied', created_at: isoAt(-30) }), app({ status: 'written', written_at: '' })],
    [job({ deadline: localDay(0) })],
  );
  assert.ok(r.blocks.focus.indexOf('截止') >= 0, '有临近截止时，重点必须是它');
});

test('G5 全空输入不抛异常，所有块都是可用形状', () => {
  const r = buildReviewPlan([], [], { now: NOW });
  assert.deepEqual(r.blocks.priority, []);
  assert.deepEqual(r.blocks.schedule, []);
  assert.deepEqual(r.blocks.stalled, []);
  assert.ok(r.blocks.nextWeek.length > 0);
  assert.equal(typeof r.blocks.focus, 'string');
  assert.equal(r.metrics.total, 0);
});

// ── H. 容错：脏数据不许把整页打挂 ───────────────────────────────────────────
test('H1 缺字段 / 类型不对的行不抛异常，按「没填」处理', () => {
  const dirty = [
    { status: 'applied' } as ReviewAppInput,
    { status: null } as unknown as ReviewAppInput,
    {} as ReviewAppInput,
    null as unknown as ReviewAppInput,
  ];
  const r = buildReviewPlan(dirty, [null as unknown as ReviewJobInput], { now: NOW });
  assert.equal(r.metrics.total, 4);
  assert.equal(r.metrics.sent, 1);
  assert.equal(r.metrics.weekNew, 0, 'created_at 缺失 ⇒ 不计入本周，也不崩');
  assert.equal(r.blocks.schedule.length, 0);
});
