/**
 * 校招信息库 / 我的投递的「筛选控件」行为单测（A 批）。
 *
 * 为什么不是普通的静态断言：
 *   这次修的是「**控件在，功能不生效**」—— 页面看起来完全正常、点下去也不报错，
 *   只是永远筛不出东西。静态串匹配抓不住这类缺陷（`if(dl==='open' && ...)` 这行
 *   修前修后都"存在"）。所以这里把 console.html 里的**顶层函数**抠出来，
 *   在 `vm` 沙箱里真跑一遍，按真值表断言行为。
 *
 * 为什么能抠：这些函数都是顶层声明，收尾的 `}` 一定顶格（函数体内部一律缩进）
 *   ⇒ 从 `function name(` 切到第一个 `\n}` 就是完整定义。抠不到会**断言失败**
 *   （不是默默返回空串），所以函数被改名/挪走时本测试会红，不会恒绿。
 *
 * 抠取与沙箱装载的实现统一放在 `../support/consoleHarness.ts`（A / B 两批单测共用一份，
 *   否则页面的形状一变就要改两处）。跨 realm 的三个陷阱也记在那里。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  HTML, extractFn, extractConstArray, sandboxDate,
} from '../support/consoleHarness.js';

type El = { disabled: boolean; value: string; title: string; innerHTML: string; removeAttribute(k: string): void };

function makeEl(): El {
  const el: any = {
    disabled: false, value: '', title: '', innerHTML: '',
    removeAttribute(k: string) { el[k] = ''; },
  };
  return el as El;
}

type Ctx = {
  JOBS_CACHE: any[]; JOBS_POOL: any[]; __els: Record<string, El>;
  deadlineInfo: (dl: any, now?: any) => { text: string; cls: string; days: number | null };
  deadlineMatch: (k: string, days: number | null) => boolean;
  jobsFilterAvailability: () => string[];
  appsQuickReady: (k: string) => boolean;
  renderAppsQuick: () => void;
};

/** 一个只装了这几个函数所需的极小桩环境。 */
function makeCtx(): Ctx {
  const els: Record<string, El> = {
    '#jobsType': makeEl(), '#jobsDeadline': makeEl(), '#appsQuick': makeEl(),
  };
  const ctx: any = {
    JOBS_CACHE: [], JOBS_POOL: [], JOBS_FILTER_OFF: [], APPS_QUICK_K: 'all',
    $: (sel: string) => els[sel] || null,
    $$: () => [],
    esc: (s: any) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    __els: els,
  };
  vm.createContext(ctx);
  vm.runInContext(extractConstArray('APPS_QUICK'), ctx);
  for (const f of ['deadlineInfo', 'deadlineMatch', 'jobsFilterAvailability', 'appsQuickReady', 'renderAppsQuick']) {
    vm.runInContext(extractFn(f), ctx);
  }
  return ctx as Ctx;
}

/** ⚠️ 刻意选一个**远在过去**的日期（不是"今天"）：否则真实时钟恰好等于注入值时，
 *  「注入被忽略」这类变异体会**假装通过**，对照实验就白做了。 */
const NOW = (ctx: Ctx) => sandboxDate(ctx as any, 2001, 3, 15);

// ────────────────────────── deadlineInfo ──────────────────────────
test('deadlineInfo：没填 / 自由文本 ⇒ days 为 null（不是 0、不是负数）', () => {
  const ctx = makeCtx();
  const now = NOW(ctx);
  for (const v of [null, undefined, '', '   ', '招满为止', '长期有效']) {
    const r = ctx.deadlineInfo(v, now);
    assert.equal(r.days, null, `${JSON.stringify(v)} 应判为「没填」`);
    assert.equal(r.cls, 'b-mut', `${JSON.stringify(v)} 的中性色`);
  }
  assert.equal(ctx.deadlineInfo('', now).text, '招满为止');
});

test('deadlineInfo：今天 / 未来 / 过去 的倒计时文案', () => {
  const ctx = makeCtx();
  const now = NOW(ctx);
  assert.deepEqual(
    [ctx.deadlineInfo('2001-03-15', now), ctx.deadlineInfo('2001-03-18', now), ctx.deadlineInfo('2001-03-12', now)]
      .map((r) => [r.text, r.days]),
    [['今天截止', 0], ['剩 3 天', 3], ['已截止', -3]]);
});

test('deadlineInfo：注入的"现在"真的生效（跨 realm 保护没写错时不生效也不报错）', () => {
  const ctx = makeCtx();
  const now = NOW(ctx);
  assert.equal(ctx.deadlineInfo('2001-03-15', now).days, 0, '注入 2001-03-15 时「今天截止」= 0');
  assert.equal(ctx.deadlineInfo('2001-03-18', now).days, 3);
  // 不注入就走真实时钟：只断言它是个数字，不依赖运行当天的日期（否则这个测试会随时间腐烂）
  assert.equal(typeof ctx.deadlineInfo('2099-01-01').days, 'number');
});

// ────────────────────────── deadlineMatch（本次修的核心） ──────────────────────────
test('deadlineMatch：`open`（未截止）**必须排除**「没填截止」—— 这就是那个静默失效的 bug', () => {
  const ctx = makeCtx();
  assert.equal(ctx.deadlineMatch('open', null), false,
    '没填截止的岗位不是「未截止」；曾经写成 days === null || days >= 0 ⇒ 等于全量');
  assert.equal(ctx.deadlineMatch('open', 0), true);
  assert.equal(ctx.deadlineMatch('open', 30), true);
  assert.equal(ctx.deadlineMatch('open', -1), false);
});

test('deadlineMatch：四档真值表（含边界）', () => {
  const ctx = makeCtx();
  const cases: Array<[string, number | null, boolean]> = [
    ['none', null, true], ['none', 0, false], ['none', 5, false], ['none', -3, false],
    ['expired', -3, true], ['expired', -1, true], ['expired', 0, false], ['expired', null, false],
    ['open', null, false], ['open', 0, true], ['open', 30, true], ['open', -1, false],
    ['soon', 0, true], ['soon', 7, true], ['soon', 3, true],
    ['soon', 8, false], ['soon', -1, false], ['soon', null, false],
  ];
  for (const [k, days, want] of cases) {
    assert.equal(ctx.deadlineMatch(k, days), want, `deadlineMatch(${k}, ${days})`);
  }
  assert.equal(ctx.deadlineMatch('', 5), true, '空档位 = 不筛');
  assert.equal(ctx.deadlineMatch('怪档位', 5), true, '未知档位不过滤（不该出现，但不能把数据吞掉）');
});

test('deadlineMatch：四档**不丢数据**且「未填截止」不与其他档重叠', () => {
  const ctx = makeCtx();
  const keys = ['none', 'expired', 'open', 'soon'];
  for (const days of [null, -3, 0, 3, 100]) {
    const hit = keys.filter((k) => ctx.deadlineMatch(k, days));
    assert.ok(hit.length >= 1, `days=${days} 没有任何一档能选到它 ⇒ 数据会被整个吞掉`);
    if (hit.includes('none')) assert.deepEqual(hit, ['none'], `days=${days} 的「未填截止」与其他档重叠：${hit}`);
  }
  for (const days of [0, 3, 7]) {
    assert.ok(ctx.deadlineMatch('open', days) && ctx.deadlineMatch('soon', days), `days=${days} 应同时在 open 与 soon`);
  }
});

// ────────────────────────── jobsFilterAvailability ──────────────────────────
test('jobsFilterAvailability：某一列全空 ⇒ 禁用该下拉并给出原因（不留恒空的假控件）', () => {
  const ctx = makeCtx();
  ctx.JOBS_CACHE = [{ job_type: '', deadline: '' }, { job_type: null, deadline: null }];
  assert.deepEqual(Array.from(ctx.jobsFilterAvailability()), ['岗位类型', '截止状态']);
  assert.equal(ctx.__els['#jobsType'].disabled, true);
  assert.equal(ctx.__els['#jobsDeadline'].disabled, true);
  assert.match(ctx.__els['#jobsType'].title, /只会得到 0 条/);
});

test('jobsFilterAvailability：有数据就解禁；判据与筛选器同一套（自由文本不算截止数据）', () => {
  const ctx = makeCtx();
  ctx.JOBS_CACHE = [{ job_type: '技术岗', deadline: '2026-11-30' }];
  ctx.jobsFilterAvailability();
  assert.equal(ctx.__els['#jobsType'].disabled, false);
  assert.equal(ctx.__els['#jobsDeadline'].disabled, false);

  // 「招满为止」这类自由文本：只判「非空」会误判成可用，但那几档其实一个都筛不出来
  ctx.JOBS_CACHE = [{ job_type: '技术岗', deadline: '招满为止' }];
  ctx.jobsFilterAvailability();
  assert.equal(ctx.__els['#jobsType'].disabled, false, '类型有真实值，应保持可用');
  assert.equal(ctx.__els['#jobsDeadline'].disabled, true,
    '截止是自由文本 ⇒ 「未截止 / 已截止 / 7 天内」都筛不出东西，必须禁用');
});

test('jobsFilterAvailability：幂等（不会把已禁用的悄悄解禁，也不会重复累加原因）', () => {
  const ctx = makeCtx();
  ctx.JOBS_CACHE = [];
  assert.deepEqual(Array.from(ctx.jobsFilterAvailability()), ['岗位类型', '截止状态']);
  assert.deepEqual(Array.from(ctx.jobsFilterAvailability()), ['岗位类型', '截止状态']);
  assert.equal(ctx.__els['#jobsType'].disabled, true);
  // 恢复数据后必须解开，并把 title 清掉（否则悬停仍说「已禁用」—— 自相矛盾）
  ctx.JOBS_CACHE = [{ job_type: '设计岗', deadline: '2026-12-31' }];
  assert.deepEqual(Array.from(ctx.jobsFilterAvailability()), []);
  assert.equal(ctx.__els['#jobsType'].disabled, false);
  assert.equal(ctx.__els['#jobsType'].title, '');
});

// ────────────────────────── appsQuickReady ──────────────────────────
test('appsQuickReady：池侧快筛项按候选池的真实覆盖判定', () => {
  const ctx = makeCtx();
  ctx.JOBS_POOL = [{ deadline: '', match_score: null }, { deadline: null }];
  assert.equal(ctx.appsQuickReady('soon'), false);
  assert.equal(ctx.appsQuickReady('highmatch'), false);
  assert.equal(ctx.appsQuickReady('all'), true, '台账侧筛选项不受岗位池影响');

  ctx.JOBS_POOL = [{ deadline: '招满为止', match_score: '' }];
  assert.equal(ctx.appsQuickReady('soon'), false, '自由文本截止日不算');
  assert.equal(ctx.appsQuickReady('highmatch'), false, '空串匹配分不算');

  ctx.JOBS_POOL = [{ deadline: '2026-10-06', match_score: 0 }];
  assert.equal(ctx.appsQuickReady('soon'), true);
  assert.equal(ctx.appsQuickReady('highmatch'), true, '0 分是**有效值**，不能当成「没有分」');
});

// ────────────────────────── renderAppsQuick（真渲一遍按钮串） ──────────────────────────
test('renderAppsQuick：无数据的池侧按钮被 disabled 且标签写明「无数据」', () => {
  const ctx = makeCtx();
  ctx.JOBS_POOL = [{ deadline: null, match_score: null }];
  ctx.renderAppsQuick();
  const html = ctx.__els['#appsQuick'].innerHTML;

  assert.match(html, /data-appq="soon"[^>]*\bdisabled\b/, '「3 天内截止」应被禁用');
  assert.match(html, /data-appq="highmatch"[^>]*\bdisabled\b/, '「高匹配度」应被禁用');
  assert.match(html, /待投递 · 3 天内截止（无数据）/, '禁用按钮的标签必须自解释，不能只靠 tooltip');
  assert.match(html, /data-appq="all"/, '台账侧按钮照常在');
  assert.doesNotMatch(html, /data-appq="all"[^>]*\bdisabled\b/, '「全部」不该被禁用');
  assert.equal((html.match(/data-appq=/g) || []).length, 11, '快筛项共 11 个，不能被吞掉');
});

test('renderAppsQuick：有数据时按钮可用；当前档失效会自动退回「全部」', () => {
  const ctx = makeCtx();
  ctx.JOBS_POOL = [{ deadline: '2026-10-06', match_score: 88 }];
  ctx.renderAppsQuick();
  const html = ctx.__els['#appsQuick'].innerHTML;
  assert.doesNotMatch(html, /\bdisabled\b/, '有数据时一个都不该禁用');
  assert.doesNotMatch(html, /（无数据）/, '有数据时不该出现「无数据」字样');

  // 用户先选了「3 天内截止」，随后岗位池刷新成没有截止日的数据 ⇒ 不能停在空结果上
  const ctx2 = makeCtx();
  (ctx2 as any).APPS_QUICK_K = 'soon';
  ctx2.JOBS_POOL = [{ deadline: null }];
  ctx2.renderAppsQuick();
  assert.equal((ctx2 as any).APPS_QUICK_K, 'all', '失效档位必须自动退回「全部」');
});

// ────────────────────────── 静态：JOB_TYPES 与表单同源 ──────────────────────────
test('JOB_TYPES 与「添加岗位」表单 #jaType 的 option 集合一致（两处各写一套必然走样）', () => {
  const jsM = HTML.match(/const JOB_TYPES = \[([^\]]*)\];/);
  assert.ok(jsM, 'console.html 里找不到 const JOB_TYPES = [...]');
  const js = jsM![1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);

  const htmlM = HTML.match(/<select id="jaType">([\s\S]*?)<\/select>/);
  assert.ok(htmlM, 'console.html 里找不到 <select id="jaType">');
  const opts = [...htmlM![1].matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1].trim());

  assert.deepEqual(opts.filter((x) => x !== '不限'), js);
  assert.equal(opts[0], '不限', '#jaType 第一项应是「不限」（空值 = 不填）');
});
