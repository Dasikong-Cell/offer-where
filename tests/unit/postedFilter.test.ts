/**
 * 「发布时间窗口」筛选单测。
 *
 * 这个功能存在的**全部意义**就是区分两件事：
 *   · `posted_at` —— 岗位什么时候发布的（平台口径）
 *   · `created_at` —— 我们什么时候采集到的
 * 所以最重要的用例不是「能筛出来」，而是 **B 组**：一条昨天发布、今天才被我们采到的岗位，
 * 必须被 `today` 口径**排除**。如果哪天有人把它改回「按入库时间筛」，B 组会立刻翻红。
 *
 * ⚠️ 全部用例显式传 `tzOffsetMinutes`，不依赖运行机时区（CI 在 UTC，本机在 UTC+8）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterByPostedWindow } from '../../server/services/postedFilter.js';

/** 东八区 2026-10-02 10:00 */
const NOW = new Date('2026-10-02T02:00:00.000Z');
const TZ = 480;
const J = (posted_at: string | null, created_at: string) => ({ posted_at, created_at });
const opt = () => ({ now: NOW, tzOffsetMinutes: TZ });

// ── A. 不筛 ────────────────────────────────────────────────────────────────
test('口径 any / 不认识 ⇒ 原样返回，计数全 0', () => {
  const jobs = [J('2020-01-01', '2020-01-01T00:00:00.000Z'), J(null, '2020-01-01T00:00:00.000Z')];
  for (const v of ['any', undefined, null, '', '垃圾口径', 7]) {
    const r = filterByPostedWindow(jobs, v, opt());
    assert.equal(r.jobs.length, 2, `口径 ${JSON.stringify(v)} 不该筛掉任何岗位`);
    assert.equal(r.days, null);
    assert.equal(r.missing + r.outOfRange + r.viaFallback, 0, '不筛时不该有计数');
  }
});

// ── B. 本功能的核心：发布时间 ≠ 入库时间 ───────────────────────────────────
test('today：昨天发布、今天才采到的岗位必须被排除', () => {
  const r = filterByPostedWindow([
    J('2026-10-02', '2020-01-01T00:00:00.000Z'), // 今天发布（虽然很久以前就采到了）
    J('2026-10-01', '2026-10-02T01:00:00.000Z'), // 昨天发布（虽然今天才采到）← 必须排除
  ], 'today', opt());
  assert.equal(r.jobs.length, 1, '若按 created_at 筛，这条就会被错误保留');
  assert.equal(r.jobs[0].posted_at, '2026-10-02');
  assert.equal(r.outOfRange, 1);
  assert.equal(r.viaFallback, 0, '有 posted_at 时不该走兜底');
});

test('近 3 天：今天/昨天/前天在内，第 4 天在外', () => {
  const mk = (d: string) => J(d, '2020-01-01T00:00:00.000Z');
  const r = filterByPostedWindow(
    [mk('2026-10-02'), mk('2026-10-01'), mk('2026-09-30'), mk('2026-09-29')],
    '3d', opt(),
  );
  assert.equal(r.jobs.length, 3);
  assert.equal(r.outOfRange, 1);
});

// ── C. 兜底口径 ────────────────────────────────────────────────────────────
test('posted_at 缺失 ⇒ 默认退回 created_at，并单独计数', () => {
  const r = filterByPostedWindow([
    J(null, '2026-10-02T01:00:00.000Z'), // 今天采的
    J(null, '2026-09-01T01:00:00.000Z'), // 一个月前采的
  ], 'today', opt());
  assert.equal(r.jobs.length, 1);
  assert.equal(r.viaFallback, 1, '兜底进来的要单独计数 —— 用户据此判断该不该信这个窗口');
  assert.equal(r.outOfRange, 1);
});

test('fallback:false ⇒ 缺发布时间的直接排除，计入 missing（而不是 outOfRange）', () => {
  const r = filterByPostedWindow(
    [J(null, '2026-10-02T01:00:00.000Z')],
    'today',
    { fallback: false, now: NOW, tzOffsetMinutes: TZ },
  );
  assert.equal(r.jobs.length, 0);
  assert.equal(r.missing, 1, '「没有发布时间」与「发布时间太久」是两回事，不能混在一个计数里');
  assert.equal(r.viaFallback, 0);
});

// ── D. 两条时区规则（错了不报错，只是悄悄差一天）────────────────────────────
test('created_at 是 UTC 时间戳 ⇒ 必须换本地日历', () => {
  // 2026-10-01T17:00Z 在东八区是 10-02 01:00 ⇒ 属于「今天」
  const r = filterByPostedWindow(
    [J(null, '2026-10-01T17:00:00.000Z')], 'today', opt(),
  );
  assert.equal(r.jobs.length, 1, '直接截前 10 位会算成 10-01，把今天刚采的岗位误排除');
});

test('posted_at 已是当地日历 ⇒ 不得再做时区换算', () => {
  // UTC-5 当地此刻是 2026-10-01 21:00
  const r = filterByPostedWindow(
    [J('2026-10-01', '2020-01-01T00:00:00.000Z')], 'today',
    { now: NOW, tzOffsetMinutes: -300 },
  );
  assert.equal(r.jobs.length, 1, '对 posted_at 做时区换算会变成 09-30，被误排除');
  assert.equal(r.viaFallback, 0);
});

// ── E. 计数自洽（性质断言，不写死具体条数）────────────────────────────────
test('通过数 + 排除数 = 总数，且各类计数互斥', () => {
  const jobs = [
    J('2026-10-02', '2026-10-02T01:00:00.000Z'), // 通过（用 posted_at）
    J(null, '2026-10-01T17:00:00.000Z'),         // 通过（兜底）
    J('2026-09-20', '2026-10-02T01:00:00.000Z'), // 超出窗口
    J(null, '2026-08-01T01:00:00.000Z'),         // 兜底但超窗
  ];
  const r = filterByPostedWindow(jobs, 'today', opt());
  assert.equal(r.jobs.length, 2);
  assert.equal(r.viaFallback, 1);
  assert.equal(r.outOfRange, 2);
  assert.equal(r.missing, 0);
  assert.equal(
    r.jobs.length + r.outOfRange + r.missing, jobs.length,
    '三类结果必须穷尽且不重叠 —— 数量不许写死，要核对这个性质',
  );
});

test('空列表不炸', () => {
  const r = filterByPostedWindow([], 'today', opt());
  assert.deepEqual(r, { jobs: [], days: 1, missing: 0, outOfRange: 0, viaFallback: 0 });
});
