/**
 * 「校招信息库」元数据（届别 / 快捷标签 / 视图 / 重置）的**行为级**单测（B 批）。
 *
 * 为什么值得有这一层：B 批补的三列（`grad_year` / `tags` / `deadline`）与四个控件，
 * 缺了任何一处都不会抛错 ——
 *   · 数据没进库 ⇒ 下拉/ chip 恒空，只是"筛不出东西"；
 *   · 候选集只建一次 ⇒ 采集到的新平台/新城市**永远进不了下拉**，用户筛不到自己刚采回来的岗位；
 *   · 前端自己现解析 `card_text` ⇒ 卡片写着「免笔试」、筛选却筛不到它；
 *   · 重置顺手把视图也重置了 ⇒ 用户以为按钮把页面弄坏了。
 * 这些都是「界面完全正常、点了也不报错」的形态，静态串匹配抓不住。所以把 `public/console.html`
 * 里的顶层函数抠进 `vm` 沙箱真跑，按真值表断言**行为**。抠取与桩实现见 `../support/consoleHarness.ts`。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { CARD_UI_TAGS } from '../../server/services/parseCardMeta.js';
import {
  HTML, extractFn, extractConstArray, extractConstLine, extractJobsState,
  makeEl, makeSelect, evalIn, setState, fnOf, type StubEl,
} from '../support/consoleHarness.js';

/** 「校招信息库」用到的顶层函数（抠不到就断言失败，见 extractFn）。
 *  ⚠️ 新增一个被 renderJobs 调用的顶层函数时**必须**加进这里 —— 少了它沙箱里就是
 *     ReferenceError，整个 B 批单测一起红，而报错信息只指向「某个函数不存在」。 */
const FN_NAMES = [
  'esc', 'deadlineInfo', 'deadlineMatch', 'jobSrcName',
  'jobTags', 'jobHasTag', 'jobGrad', 'jobsCtlVal', 'jobsFiltered',
  'setJobsOptions', 'fillJobsFilters', 'jobsFilterAvailability', 'jobsAvailTags',
  'syncJobsTags', 'jobsSoonChipHtml', 'renderJobsChips', 'bindJobsRows', 'jobsApplyView',
  'renderJobsTable', 'renderJobsCards', 'renderJobs', 'jobsResetFilters', 'jobCardHtml',
  // 分页 / 排序 / 计数口径（renderJobs 依次调用它们 —— 顺序即管线：筛 → 排 → 分页）
  'jobsSorted', 'jobsPage', 'renderJobsPager',
];

/** 下拉用 `<select>` 桩（带浏览器语义），其余用普通元素桩。 */
const SELECTS = ['#jobsSource', '#jobsCity', '#jobsType', '#jobsGrad', '#jobsDeadline'];
const PLAINS = ['#jobsQ', '#jobsChips', '#jobsTbl tbody', '#jobsCards', '#jobsTableWrap', '#jobsCount', '#jobsStat'];

type Ctx = Record<string, any>;
interface Fixture { ctx: Ctx; el: Record<string, StubEl>; tabs: StubEl[] }

/** 建一个装着**真源码**的沙箱：真状态声明 + 真函数 + 只桩 `$` / `$$` 两个 DOM 入口。 */
function makeFixture(): Fixture {
  const el: Record<string, StubEl> = {};
  for (const s of PLAINS) el[s] = makeEl();
  for (const s of SELECTS) el[s] = makeSelect();
  const tabs = ['table', 'card'].map((v) => { const b = makeEl(); b.dataset.jobview = v; return b; });
  const ctx: Ctx = {
    el, tabs,
    $: (sel: string) => el[sel] || null,
    // 只实现本批用到的两种集合查询；其余返回空集（行级按钮绑定在单测里不模拟点击，真点击走 E2E）
    $$: (sel: string) => (String(sel).indexOf('[data-jobview]') >= 0 ? tabs : []),
  };
  vm.createContext(ctx);
  // 真源码：来源中文名（`manual` → 「手动录入」）、平台清单、日期判据
  vm.runInContext(extractConstArray('PLATFORMS'), ctx);
  vm.runInContext(extractConstLine('pfName'), ctx);
  vm.runInContext(extractConstLine('SOURCE_LABEL'), ctx);
  // 真源码：`JOBS_CACHE` / `JOBS_TAGS`(Set) / `JOBS_VIEW` / `JOBS_FILTER_DROPPED` / `JOBS_FILTER_SELECTS` …
  vm.runInContext(extractJobsState(), ctx);
  for (const f of FN_NAMES) vm.runInContext(extractFn(f), ctx);
  return { ctx, el, tabs };
}

/** 岗位样例。默认值刻意都填上，这样「某一维没数据」这类断言必须显式把该维清掉才成立。 */
const J = (o: Record<string, unknown> = {}) => ({
  id: 'j', company: '某公司', position: '某岗位', city: '北京', job_type: '技术岗',
  source: 'boss', status: 'candidate', jd: '', card_text: '', grad_year: null, tags: null,
  deadline: null, match_score: null, posted_at: null, ...o,
});

const idsOf = (list: any): string[] => [...list].map((x: any) => x.id);

/** 在沙箱里造一个 Set（避免把宿主 Set 递进另一个 realm，见 harness 头部陷阱 2）。 */
const sandboxSet = (ctx: Ctx, keys: string[]) => evalIn(ctx, `new Set(${JSON.stringify(keys)})`);
const setTags = (ctx: Ctx, keys: string[]) => vm.runInContext(`JOBS_TAGS = new Set(${JSON.stringify(keys)});`, ctx);
const tagList = (ctx: Ctx): string[] => [...evalIn<string[]>(ctx, 'Array.from(JOBS_TAGS)')];
const useDefs = (ctx: Ctx) => setState(ctx, 'JOBS_TAG_DEFS', CARD_UI_TAGS.map((d) => ({ ...d })));

/** 从 `renderJobsChips()` 的产物里解析出每个 chip（本轮唯一的渲染契约，测它就是测用户看到的）。 */
function parseChips(html: string): Array<{ key: string; n: number; off: boolean; on: boolean; text: string }> {
  const re = /<button class="btn sm(?: primary)?"( disabled)? data-jtag="([^"]+)" title="([^"]*)">([^<]*)<\/button>/g;
  const out: Array<{ key: string; n: number; off: boolean; on: boolean; text: string }> = [];
  for (const m of html.matchAll(re)) {
    const text = m[4];
    const t = /^(.+?) (\d+)(.*)$/.exec(text);
    assert.ok(t, `chip 文案形状变了，解析器要跟着改：${JSON.stringify(text)}`);
    out.push({ key: m[2], n: Number(t![2]), off: !!m[1], on: !m[1] && t![3].indexOf('✓') >= 0, text });
  }
  return out;
}

/**
 * 解析「近 7 天截止」chip（与上面标签 chip 的解析器刻意分开：它是**另一个维度**，
 * 用 `data-jdl` 而不是 `data-jtag`。合并成一个解析器，将来改一个维度的文案就会连带误伤另一个）。
 */
function parseSoonChip(html: string): { n: number; off: boolean; on: boolean; text: string; why: string } {
  const m = /<button class="btn sm(?: primary)?"( disabled)? data-jdl="soon" title="([^"]*)">([^<]*)<\/button>/.exec(html);
  assert.ok(m, `没渲染出「近 7 天截止」chip —— 它必须无条件渲染：${html.slice(0, 160)}`);
  const text = m![3];
  // 只有两个捕获组：`(\d+)` 是第 1 组、尾巴是第 2 组（写成 t[2]/t[3] 会拿到 undefined）
  const t = /^近 7 天截止 (\d+)(.*)$/.exec(text);
  assert.ok(t, `chip 文案形状变了，解析器要跟着改：${JSON.stringify(text)}`);
  return { n: Number(t![1]), off: !!m![1], on: !m![1] && t![2].indexOf('✓') >= 0, text, why: m![2] };
}

/**
 * 「今天 + n 天」的截止日（本地日历，`YYYY-MM-DD`）。
 * ⚠️ 不用 `toISOString()`：它是 UTC，在 UTC+8 的清晨会整整差一天 —— 而「近 7 天」的边界
 *    恰好就差这一天，测试会在每天的某几个小时里随机红。
 */
function dueIn(n: number): string {
  const d = new Date();
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}

// ────────────────────────── jobTags / jobGrad / jobHasTag ──────────────────────────
test('jobTags：只做 JSON.parse —— 不在前端重做白名单、更不能用 split 顶替', () => {
  const { ctx } = makeFixture();
  const jobTags = fnOf(ctx, 'jobTags');
  for (const j of [null, undefined, {}, { tags: null }, { tags: '' }]) {
    assert.deepEqual([...jobTags(j)], [], String(j));
  }
  assert.deepEqual([...jobTags({ tags: '["免笔试","秋招"]' })], ['免笔试', '秋招']);
  // 坏值 / 非数组 JSON：返回 []，**不许抛**（库里存了脏值不该让整个列表页白屏）
  // ⚠️ 刻意**不**校验元素类型（`[1,2]` 会原样返回）：落库值由服务端 `serializeTags()` 保证是
  //    白名单内的字符串数组，前端每多加一道校验就是多一个会漂移的真相源。
  for (const bad of ['[这不是 JSON', '坏值', '{"a":1}', '"秋招"', '123']) {
    assert.deepEqual([...jobTags({ tags: bad })], [], bad);
  }
  // 🔴 反向：表外标签**原样返回**。前端若再抄一层白名单，库里清洗口径一变就是第二个真相源，
  //    而漂移的表现是「筛不到」，没有任何报错。
  assert.deepEqual([...jobTags({ tags: '["表外标签","秋招"]' })], ['表外标签', '秋招']);
  // 🔴 反向：绝不能用 split(',') 顶替 JSON.parse（那种写法会把 '["免笔试"' 当成标签）
  assert.notDeepEqual([...jobTags({ tags: '["免笔试","秋招"]' })], ['["免笔试"', '"秋招"]']);
});

test('jobGrad：届别列 → 字符串；缺列 / 空值 → 空串（「没有届别」全项目只有这一种表示）', () => {
  const { ctx } = makeFixture();
  const g = fnOf(ctx, 'jobGrad');
  assert.equal(g({ grad_year: '2027' }), '2027');
  assert.equal(g({ grad_year: ' 2026 ' }), '2026', '库里带空格也要收敛（否则下拉里会出现两个看着一样的选项）');
  assert.equal(g({ grad_year: 2027 }), '2027');
  for (const j of [{ grad_year: null }, { grad_year: undefined }, { grad_year: '' }, {}, null, undefined]) {
    assert.equal(g(j), '', String(j));
  }
});

test('jobHasTag：多标签里任一命中即真，且不许退化成子串搜索', () => {
  const { ctx } = makeFixture();
  const has = fnOf(ctx, 'jobHasTag');
  const j = { tags: '["免笔试","秋招"]' };
  assert.equal(has(j, '免笔试'), true);
  assert.equal(has(j, '秋招'), true);
  assert.equal(has(j, '央国企'), false);
  // 反向：`String(tags).indexOf(k) >= 0` 这种实现会让半截词也命中
  assert.equal(has(j, '免笔'), false);
  assert.equal(has(j, '免笔试","秋'), false);
  assert.equal(has({ tags: null }, '免笔试'), false);
  assert.equal(has(null, '免笔试'), false);
});

// ────────────────────────── jobsFiltered ──────────────────────────
test('jobsFiltered：源/城市/类型/届别 四维等值筛选（一维一档，互不干扰）', () => {
  const { ctx, el } = makeFixture();
  const F = fnOf(ctx, 'jobsFiltered');
  setState(ctx, 'JOBS_CACHE', [
    J({ id: 'a', source: 'boss', city: '北京', job_type: '技术岗', grad_year: '2027' }),
    J({ id: 'b', source: 'liepin', city: '上海', job_type: '设计岗', grad_year: '2026' }),
    J({ id: 'c', source: 'boss', city: '上海', job_type: '技术岗', grad_year: '2027' }),
  ]);
  assert.deepEqual(idsOf(F()), ['a', 'b', 'c'], '不筛 = 全量');
  el['#jobsSource'].forceValue('boss'); assert.deepEqual(idsOf(F()), ['a', 'c']);
  el['#jobsSource'].forceValue('');
  el['#jobsCity'].forceValue('上海'); assert.deepEqual(idsOf(F()), ['b', 'c']);
  el['#jobsCity'].forceValue('');
  el['#jobsType'].forceValue('设计岗'); assert.deepEqual(idsOf(F()), ['b']);
  el['#jobsType'].forceValue('');
  el['#jobsGrad'].forceValue('2026'); assert.deepEqual(idsOf(F()), ['b']);
  el['#jobsGrad'].forceValue('');
  // 多维是**与**：城市 + 类型同时生效
  el['#jobsCity'].forceValue('上海'); el['#jobsType'].forceValue('技术岗');
  assert.deepEqual(idsOf(F()), ['c']);
  // 三维同时生效（漏清一维就会误判成"筛选没生效"）
  el['#jobsGrad'].forceValue('2026');
  assert.deepEqual(idsOf(F()), [], 'c 是 2027 届，与届别条件冲突 ⇒ 空');
});

test('jobsFiltered：截止状态档位走 deadlineMatch 的同一套判据（free text ≠ 未填）', () => {
  const { ctx, el } = makeFixture();
  const F = fnOf(ctx, 'jobsFiltered');
  setState(ctx, 'JOBS_CACHE', [
    J({ id: 'open', deadline: '2099-01-01' }),
    J({ id: 'expired', deadline: '2001-01-01' }),
    J({ id: 'none', deadline: null }),
    J({ id: 'freetext', deadline: '招满为止' }),
  ]);
  el['#jobsDeadline'].forceValue('none'); assert.deepEqual(idsOf(F()), ['none', 'freetext']);
  el['#jobsDeadline'].forceValue('open'); assert.deepEqual(idsOf(F()), ['open'], '没填截止的**不算**未截止');
  el['#jobsDeadline'].forceValue('expired'); assert.deepEqual(idsOf(F()), ['expired']);
  el['#jobsDeadline'].forceValue(''); assert.deepEqual(idsOf(F()), ['open', 'expired', 'none', 'freetext']);
});

test('jobsFiltered：skipGrad 只停用「届别」这一维（算别的届别条数时用）', () => {
  const { ctx, el } = makeFixture();
  const F = fnOf(ctx, 'jobsFiltered');
  setState(ctx, 'JOBS_CACHE', [J({ id: 'a', grad_year: '2027' }), J({ id: 'b', grad_year: '2027' }), J({ id: 'c', grad_year: '2026' })]);
  el['#jobsGrad'].forceValue('2027');
  assert.deepEqual(idsOf(F()), ['a', 'b']);
  assert.deepEqual(idsOf(F({ skipGrad: true })), ['a', 'b', 'c'], '其它维度照常生效，只放掉届别');
  el['#jobsCity'].forceValue('北京');
  assert.deepEqual(idsOf(F({ skipGrad: true })), ['a', 'b', 'c'], '城市仍在筛');
});

test('jobsFiltered：标签是**并集**语义，且 opt.tags 整体覆盖当前已选（不是叠加）', () => {
  const { ctx } = makeFixture();
  const F = fnOf(ctx, 'jobsFiltered');
  setState(ctx, 'JOBS_CACHE', [
    J({ id: 'a', tags: '["免笔试"]' }), J({ id: 'b', tags: '["秋招"]' }),
    J({ id: 'c', tags: '["央国企"]' }), J({ id: 'd', tags: '["免笔试","秋招"]' }),
  ]);
  assert.deepEqual(idsOf(F()), ['a', 'b', 'c', 'd'], '没选标签 = 不筛标签');
  setTags(ctx, ['免笔试']); assert.deepEqual(idsOf(F()), ['a', 'd']);
  setTags(ctx, ['免笔试', '秋招']); assert.deepEqual(idsOf(F()), ['a', 'b', 'd'], '多选是并集，不是交集');
  // opt.tags 覆盖 JOBS_TAGS（算 chip 条数时传「已选 ∪ 这个」）
  assert.deepEqual(idsOf(F({ tags: sandboxSet(ctx, ['央国企']) })), ['c']);
  assert.deepEqual(idsOf(F({ tags: sandboxSet(ctx, []) })), ['a', 'b', 'c', 'd'], '空集合 = 不筛标签');
});

test('jobsFiltered：标签与其它维度是「与」关系（并集只在标签内部）', () => {
  const { ctx, el } = makeFixture();
  const F = fnOf(ctx, 'jobsFiltered');
  setState(ctx, 'JOBS_CACHE', [
    J({ id: 'a', city: '北京', tags: '["免笔试"]' }),
    J({ id: 'b', city: '上海', tags: '["免笔试"]' }),
    J({ id: 'c', city: '北京', tags: '["秋招"]' }),
  ]);
  setTags(ctx, ['免笔试']);
  el['#jobsCity'].forceValue('北京');
  assert.deepEqual(idsOf(F()), ['a'], '标签并集 ∩ 城市 = 北京且有免笔笔试标签的那条');
});

test('jobsFiltered：关键词打全字段（含平台的**中文名**，且 null 不许变成 "null" 字符串）', () => {
  const { ctx, el } = makeFixture();
  const F = fnOf(ctx, 'jobsFiltered');
  setState(ctx, 'JOBS_CACHE', [
    J({ id: 'a', company: '中国电子云', position: 'LLM算法工程师' }),
    J({ id: 'b', company: '某公司', city: '武汉' }),
    J({ id: 'c', company: '某公司', source: 'manual', job_type: '产品岗' }),
    J({ id: 'd', company: '某公司', jd: '需要 Python 经验' }),
    J({ id: 'e', company: '某公司', card_text: '某司 2027 届 免笔试' }),
  ]);
  const q = (v: string) => { el['#jobsQ'].value = v; return idsOf(F()); };
  assert.deepEqual(q('中国电子'), ['a']);
  assert.deepEqual(q('llm算法'), ['a'], '大小写不敏感');
  assert.deepEqual(q('武汉'), ['b']);
  assert.deepEqual(q('python'), ['d'], 'JD 参与');
  assert.deepEqual(q('免笔试'), ['e'], '卡片摘要参与');
  // 🔴 `manual` 的中文名：q 打的是 `jobSrcName(source)`，不是裸 id
  assert.deepEqual(q('手动录入'), ['c'], '筛平台要按用户看到的中文名，不是英文 id');
  assert.deepEqual(q('manual'), [], '库里没有哪个字段会显示 manual');
  // 🔴 反向：null 字段不许被 String() 成 'null'（那会让搜 "null" 命中一大堆）
  el['#jobsQ'].value = '';
  evalIn(ctx, 'JOBS_CACHE = [{id:"z",company:"Z",position:null,city:null,job_type:null,source:"boss",jd:null,card_text:null}]');
  assert.deepEqual(q('null'), [], 'null 字段不许变成字符串 "null"');
  assert.deepEqual(q('boss'), ['z'], '平台列照常参与（BOSS直聘）');
});

// ────────────────────────── setJobsOptions ──────────────────────────
test('setJobsOptions：重建选项并**保住已选值**（取值还在时 value 不变、不记账）', () => {
  const { ctx, el } = makeFixture();
  const setOpt = fnOf(ctx, 'setJobsOptions');
  const html = '<option value="">全部城市</option><option value="北京">北京</option><option value="上海">上海</option>';
  el['#jobsCity'].innerHTML = '<option value="">全部城市</option><option value="北京">北京</option>';
  el['#jobsCity'].forceValue('北京');
  vm.runInContext('JOBS_FILTER_DROPPED = [];', ctx);
  setOpt('#jobsCity', html, '北京', '城市');
  assert.equal(el['#jobsCity'].value, '北京');
  assert.ok(el['#jobsCity'].innerHTML.includes('上海'), '选项必须整体换成新的');
  assert.deepEqual([...evalIn<string[]>(ctx, 'JOBS_FILTER_DROPPED')], []);
});

test('setJobsOptions：取值已不存在 ⇒ 归空并记一笔（浏览器是**静默**归空的，不查就没人知道）', () => {
  const { ctx, el } = makeFixture();
  const setOpt = fnOf(ctx, 'setJobsOptions');
  el['#jobsCity'].forceValue('上海');
  vm.runInContext('JOBS_FILTER_DROPPED = [];', ctx);
  setOpt('#jobsCity', '<option value="">全部城市</option><option value="北京">北京</option>', '上海', '城市');
  assert.equal(el['#jobsCity'].value, '', '浏览器会把不存在的取值归空');
  assert.ok(el['#jobsCity'].silentResets >= 1, '桩必须真的模拟出「静默归空」，否则这条侦测逻辑永远不会触发');
  assert.deepEqual([...evalIn<string[]>(ctx, 'JOBS_FILTER_DROPPED')], ['城市'], '静默撤掉筛选条件必须记账');
});

test('setJobsOptions：控件不存在 ⇒ 静默返回（单测沙箱只摆被测函数要用的控件）', () => {
  const { ctx } = makeFixture();
  assert.doesNotThrow(() => fnOf(ctx, 'setJobsOptions')('#不存在的下拉', '<option value="x">x</option>', 'x', 'X'));
});

// ────────────────────────── fillJobsFilters ──────────────────────────
test('fillJobsFilters：候选**只取数据实测值**，绝不写死清单（写死就会造出点了 0 条的假选项）', () => {
  const { ctx, el } = makeFixture();
  setState(ctx, 'JOBS_CACHE', [J({ id: 'a', job_type: '技术岗' }), J({ id: 'b', job_type: '技术岗' })]);
  evalIn(ctx, 'fillJobsFilters()');
  const h = el['#jobsType'].innerHTML;
  assert.ok(h.includes('value="技术岗"'));
  // 🔴 反向：`JOB_TYPES` 里那 9 个没在数据里的类型，一个都不许出现
  for (const t of ['产品岗', '运营岗', '算法岗', '数据岗', '设计岗', '市场岗', '职能岗', '销售岗', '其他']) {
    assert.ok(!h.includes(t), `数据里没有「${t}」却出现在下拉里 ⇒ 选了必然 0 条`);
  }
  // 候选数 = 「全部类型」+ 数据里真实存在的 1 个（写死清单会让这个数字变大）
  assert.equal((h.match(/<option/g) || []).length, 2);
});

test('fillJobsFilters：**每轮整体重建**，数据里消失的取值必须从下拉里消失', () => {
  const { ctx, el } = makeFixture();
  setState(ctx, 'JOBS_CACHE', [J({ id: 'a', city: '北京' })]);
  evalIn(ctx, 'fillJobsFilters()');
  assert.ok(el['#jobsCity'].innerHTML.includes('北京'));
  setState(ctx, 'JOBS_CACHE', [J({ id: 'a', city: '广州' })]);
  evalIn(ctx, 'fillJobsFilters()');
  assert.ok(el['#jobsCity'].innerHTML.includes('广州'), '新采集到的城市必须立刻可选');
  assert.ok(!el['#jobsCity'].innerHTML.includes('北京'),
    '候选集是数据的函数 —— 旧写法（dataset.filled 只建一次）会让新取值永远进不了下拉，且不报错');
  assert.equal((el['#jobsCity'].innerHTML.match(/<option/g) || []).length, 2, '只剩「全部城市」+ 广州');
});

test('fillJobsFilters：届别候选带条数，且条数用 skipGrad 算（选中一届后其它届不被清零）', () => {
  const { ctx, el } = makeFixture();
  setState(ctx, 'JOBS_CACHE', [
    J({ id: 'a', grad_year: '2027' }), J({ id: 'b', grad_year: '2027' }),
    J({ id: 'c', grad_year: '2026' }), J({ id: 'd', grad_year: '2026' }),
  ]);
  evalIn(ctx, 'fillJobsFilters()');
  assert.ok(el['#jobsGrad'].innerHTML.includes('2027 届（2）'), el['#jobsGrad'].innerHTML);
  assert.ok(el['#jobsGrad'].innerHTML.includes('2026 届（2）'));
  // 🔴 反向：候选数 = 「全部届别」+ 数据里真实存在的 2 个届别。
  //    写死清单会凭空多出「2025 届（0）」这种点了 0 条的假档 —— 这正是要防的返祖。
  assert.equal((el['#jobsGrad'].innerHTML.match(/<option/g) || []).length, 3);
  assert.ok(!el['#jobsGrad'].innerHTML.includes('2025 届'));
  // 选中 2027 后再重建：2026 的条数必须还是 2（若用全量判据会变成 0，用户以为没别的届别了）
  el['#jobsGrad'].forceValue('2027');
  evalIn(ctx, 'fillJobsFilters()');
  assert.ok(el['#jobsGrad'].innerHTML.includes('2026 届（2）'), '条数必须排除「届别」这一维再算');
  assert.equal(el['#jobsGrad'].value, '2027', '同时还得保住已选值');
});

test('fillJobsFilters：drop 记账 + `#jobsDeadline` 的档位是业务口径、不由数据重建', () => {
  const { ctx, el } = makeFixture();
  el['#jobsDeadline'].innerHTML = '<option value="">全部截止状态</option>'
    + '<option value="open">未截止</option><option value="soon">7 天内截止</option>'
    + '<option value="expired">已截止</option><option value="none">未填截止</option>';
  const before = el['#jobsDeadline'].innerHTML;
  el['#jobsCity'].forceValue('上海');
  setState(ctx, 'JOBS_CACHE', [J({ id: 'a', city: '北京' })]);
  evalIn(ctx, 'fillJobsFilters()');
  assert.deepEqual([...evalIn<string[]>(ctx, 'JOBS_FILTER_DROPPED')], ['城市']);
  assert.equal(el['#jobsCity'].value, '');
  assert.equal(el['#jobsDeadline'].innerHTML, before, '截止档位写死在 HTML 里，不该被数据重建');
});

test('fillJobsFilters：每轮开头清空 dropped 记账（否则上一轮的提示会永远挂着）', () => {
  const { ctx, el } = makeFixture();
  el['#jobsCity'].forceValue('上海');
  setState(ctx, 'JOBS_CACHE', [J({ id: 'a', city: '北京' })]);
  evalIn(ctx, 'fillJobsFilters()');
  assert.deepEqual([...evalIn<string[]>(ctx, 'JOBS_FILTER_DROPPED')], ['城市']);
  evalIn(ctx, 'fillJobsFilters()');
  assert.deepEqual([...evalIn<string[]>(ctx, 'JOBS_FILTER_DROPPED')], [], '这一轮已经没有"被撤掉的旧值"了');
});

// ────────────────────────── jobsFilterAvailability ──────────────────────────
test('jobsFilterAvailability：某一列全空 ⇒ 禁用该下拉并写清原因（不留恒空的假控件）', () => {
  const { ctx, el } = makeFixture();
  const avail = fnOf(ctx, 'jobsFilterAvailability');
  setState(ctx, 'JOBS_CACHE', [J({ id: 'a', job_type: '', grad_year: null, deadline: '' }), J({ id: 'b', job_type: null, grad_year: null, deadline: null })]);
  assert.deepEqual([...avail()], ['岗位类型', '届别', '截止状态']);
  for (const s of ['#jobsType', '#jobsGrad', '#jobsDeadline']) {
    assert.equal(el[s].disabled, true, s);
    assert.match(el[s].title, /只会得到 0 条/, s);
  }
});

test('jobsFilterAvailability：有真实数据就解禁并清掉 title；自由文本截止**不算**数据', () => {
  const { ctx, el } = makeFixture();
  const avail = fnOf(ctx, 'jobsFilterAvailability');
  setState(ctx, 'JOBS_CACHE', [J({ id: 'a', grad_year: '2027', deadline: '2026-11-30' })]);
  assert.deepEqual([...avail()], []);
  for (const s of ['#jobsType', '#jobsGrad', '#jobsDeadline']) {
    assert.equal(el[s].disabled, false, s);
    assert.equal(el[s].title, '', `${s} 解禁后 title 必须清掉（否则悬停仍说"已禁用"—— 自相矛盾）`);
  }
  // 只有自由文本截止：只判「非空」会误判成可用，但那三档一个都筛不出来
  setState(ctx, 'JOBS_CACHE', [J({ id: 'a', grad_year: '2027', deadline: '招满为止' })]);
  assert.deepEqual([...avail()], ['截止状态']);
  assert.equal(el['#jobsDeadline'].disabled, true);
  assert.equal(el['#jobsType'].disabled, false, '类型有真实值，应保持可用');
  assert.equal(el['#jobsGrad'].disabled, false, '届别有真实值，应保持可用');
});

test('jobsFilterAvailability：幂等（可重复调用，不累加原因、不把已禁用的悄悄解禁）', () => {
  const { ctx } = makeFixture();
  const avail = fnOf(ctx, 'jobsFilterAvailability');
  setState(ctx, 'JOBS_CACHE', []);
  assert.deepEqual([...avail()], ['岗位类型', '届别', '截止状态']);
  assert.deepEqual([...avail()], ['岗位类型', '届别', '截止状态']);
  setState(ctx, 'JOBS_CACHE', [J({ id: 'a', grad_year: '2027', deadline: '2099-01-01' })]);
  assert.deepEqual([...avail()], []);
});

// ────────────────────────── jobsAvailTags / syncJobsTags ──────────────────────────
test('jobsAvailTags：只认「数据里真的存在」的标签，且顺序沿用服务端定义表', () => {
  const { ctx } = makeFixture();
  useDefs(ctx);
  setState(ctx, 'JOBS_CACHE', [
    J({ id: 'a', tags: '["央国企"]' }), J({ id: 'b', tags: '["免笔试"]' }), J({ id: 'c', tags: null }),
  ]);
  const keys = [...fnOf(ctx, 'jobsAvailTags')()].map((d: any) => d.key);
  assert.deepEqual(keys, ['免笔试', '央国企'], '顺序 = CARD_UI_TAGS 的顺序，不是数据出现顺序');
});

test('syncJobsTags：数据里没有的已选标签必须撤回（否则用户卡在空结果上还找不到它）', () => {
  const { ctx } = makeFixture();
  useDefs(ctx);
  setState(ctx, 'JOBS_CACHE', [J({ id: 'a', tags: '["免笔试"]' })]);
  setTags(ctx, ['免笔试', '秋招', '研究所']);
  fnOf(ctx, 'syncJobsTags')();
  assert.deepEqual(tagList(ctx), ['免笔试'], '有效的保留、失效的撤回');
  // 一个都不剩时也不能留空转的状态
  setState(ctx, 'JOBS_CACHE', [J({ id: 'a', tags: null })]);
  fnOf(ctx, 'syncJobsTags')();
  assert.deepEqual(tagList(ctx), []);
});

// ────────────────────────── renderJobsChips ──────────────────────────
test('renderJobsChips：chip 上的数字 = **点下去会得到的条数**（已选 ∪ 自己，不是只按自己算）', () => {
  const { ctx, el } = makeFixture();
  useDefs(ctx);
  setState(ctx, 'JOBS_CACHE', [
    J({ id: 'a', tags: '["免笔试"]' }), J({ id: 'b', tags: '["秋招"]' }),
    J({ id: 'c', tags: '["央国企"]' }), J({ id: 'd', tags: '["免笔试","秋招"]' }),
  ]);
  setTags(ctx, ['免笔试']);
  evalIn(ctx, 'renderJobsChips()');
  const chips = parseChips(el['#jobsChips'].innerHTML);
  assert.deepEqual(chips.map((c) => c.key), ['免笔试', '秋招', '央国企'], '只渲染数据里有的');
  // 已选「免笔试」之后，点「秋招」会得到 {a,b,d} = 3；若只按「秋招」算会显示 2，点下去却多一条
  assert.equal(chips.find((c) => c.key === '秋招')!.n, 3);
  assert.equal(evalIn<number>(ctx, 'jobsFiltered({tags: new Set(["秋招"])}).length'), 2,
    '按自己算只有 2 —— 两者的差值正是这条断言存在的意义');
  // 生成式核对：每个 chip 的数字都必须等于契约值（以后加 chip 也自动被覆盖）
  for (const c of chips) {
    const want = evalIn<number>(ctx, `jobsFiltered({tags: new Set([...JOBS_TAGS, ${JSON.stringify(c.key)}])}).length`);
    assert.equal(c.n, want, `chip「${c.key}」上的数字必须 = 点下去会得到的条数`);
  }
});

test('renderJobsChips：当前条件下必然 0 条 ⇒ 禁用并写明原因；但**已选中的永不禁用**', () => {
  const { ctx, el } = makeFixture();
  useDefs(ctx);
  setState(ctx, 'JOBS_CACHE', [
    J({ id: 'a', city: '北京', tags: '["免笔试"]' }),
    J({ id: 'b', city: '上海', tags: '["秋招"]' }),
  ]);
  el['#jobsCity'].forceValue('北京');
  evalIn(ctx, 'renderJobsChips()');
  let chips = parseChips(el['#jobsChips'].innerHTML);
  const autumn = () => chips.find((c) => c.key === '秋招')!;
  assert.equal(autumn().n, 0);
  assert.equal(autumn().off, true, '数据里有「秋招」但当前城市筛不到 ⇒ 必须禁用');
  assert.match(autumn().text, /当前筛选下 0 条/, '禁用原因必须写在按钮上，不能只靠 tooltip');
  assert.equal(chips.find((c) => c.key === '免笔试')!.off, false);
  // 用户先选了「秋招」（当时数据里确实有），随后城市筛选让它变 0 条 ⇒ 不能禁用（否则无法取消）
  setTags(ctx, ['秋招']);
  evalIn(ctx, 'renderJobsChips()');
  chips = parseChips(el['#jobsChips'].innerHTML);
  assert.equal(autumn().off, false, '已选中的 chip 永不禁用 —— 禁用等于把用户锁死在空结果上');
  assert.match(autumn().text, /✓/, '已选态要有标记');
});

test('renderJobsChips：无标签时**两种原因分别写明**（后端没下发 vs 数据里没有）', () => {
  const { ctx, el } = makeFixture();
  setState(ctx, 'JOBS_CACHE', [J({ id: 'a', tags: null })]);
  setState(ctx, 'JOBS_TAG_DEFS', []);
  evalIn(ctx, 'renderJobsChips()');
  const noDefs = el['#jobsChips'].innerHTML;
  assert.match(noDefs, /tagDefs|未下发/, '后端没下发定义 ⇒ 指向接口字段，并说明"重启后端"');
  useDefs(ctx);
  evalIn(ctx, 'renderJobsChips()');
  const noData = el['#jobsChips'].innerHTML;
  assert.match(noData, /暂无快捷标签/);
  assert.match(noData, /backfill_card_meta/, '数据里没有 ⇒ 给出补齐脚本');
  assert.notEqual(noDefs, noData, '两种原因完全不同，不许共用一句话');
});

// ────────────────────────── 「近 7 天截止」chip（E 批） ──────────────────────────
test('近 7 天截止 chip：判据**就是 deadlineMatch 的 soon 档**（不另写一份日期比较）', () => {
  const { ctx } = makeFixture();
  const dm = fnOf(ctx, 'deadlineMatch');
  // 真值表：已过 / 今天 / 第 7 天（含）/ 第 8 天 / 没填 / 未填 ≠ 未截止
  for (const [days, want] of [[-1, false], [0, true], [3, true], [7, true], [8, false], [null, false]] as Array<[number | null, boolean]>) {
    assert.equal(dm('soon', days), want, `days=${days}`);
  }
  // 🔴 反向：chip 的条数**必须**走同一个判据 —— 另写一份 `new Date(...)` 比较就是第二个口径，
  //    漂移的表现是「chip 显示 3 条、点下去 0 条」，全程无报错。
  setState(ctx, 'JOBS_CACHE', [
    J({ id: 'today', deadline: dueIn(0) }), J({ id: 'd7', deadline: dueIn(7) }),
    J({ id: 'd8', deadline: dueIn(8) }), J({ id: 'past', deadline: dueIn(-1) }),
    J({ id: 'none', deadline: null }), J({ id: 'freetext', deadline: '招满为止' }),
  ]);
  // ⚠️ `[...x]` 不能省：沙箱里的数组是**另一个 realm** 的 Array，直接 deepEqual 会因原型不同而失败
  const got = [...evalIn<any[]>(ctx, `jobsFiltered({dl:'soon'})`)].map((j: any) => j.id).sort();
  assert.deepEqual(got, ['d7', 'today'], '只放「0..7 天内」；自由文本与没填都不算');
});

test('近 7 天截止 chip：数字 = **点下去会得到的条数**（不受下拉当前档位影响）', () => {
  const { ctx, el } = makeFixture();
  setState(ctx, 'JOBS_CACHE', [
    J({ id: 'a', deadline: dueIn(2) }), J({ id: 'b', deadline: dueIn(9) }),
    J({ id: 'c', deadline: null }), J({ id: 'd', deadline: '招满为止' }),
  ]);
  el['#jobsDeadline'].forceValue('expired');      // 下拉此刻停在「已截止」
  evalIn(ctx, 'renderJobsChips()');
  const chip = parseSoonChip(el['#jobsChips'].innerHTML);
  assert.equal(chip.n, 1, '下拉在 expired，chip 数字仍必须按「点下去之后的 soon」算');
  assert.equal(evalIn<number>(ctx, `jobsFiltered({dl:'soon'}).length`), 1, 'chip 与筛选器同源');
});

test('近 7 天截止 chip：状态**写在 #jobsDeadline 上** ⇒ 重置筛选天然把它清掉（不许有第二份状态）', () => {
  const { ctx, el } = makeFixture();
  setState(ctx, 'JOBS_CACHE', [J({ id: 'a', deadline: dueIn(2) })]);
  el['#jobsDeadline'].forceValue('soon');
  evalIn(ctx, 'renderJobsChips()');
  assert.equal(parseSoonChip(el['#jobsChips'].innerHTML).on, true, '下拉是 soon ⇒ chip 呈已选态');
  assert.match(parseSoonChip(el['#jobsChips'].innerHTML).text, /✓/);
  // 🔴 反向的意义：若 chip 另设一个 `JOBS_SOON_ON` 变量，`jobsResetFilters()` 只清下拉
  //    ⇒ 界面上「重置了」而 chip 还亮着、列表其实还在筛。这类缺陷没有任何报错。
  evalIn(ctx, 'jobsResetFilters()');
  assert.equal(el['#jobsDeadline'].value, '');
  evalIn(ctx, 'renderJobsChips()');
  assert.equal(parseSoonChip(el['#jobsChips'].innerHTML).on, false, '重置后 chip 必须回到未选态');
});

test('近 7 天截止 chip：库里没有可解析的截止日 ⇒ 禁用并写明原因（与「截止状态」下拉同判据）', () => {
  const { ctx, el } = makeFixture();
  setState(ctx, 'JOBS_CACHE', [J({ id: 'a', deadline: null }), J({ id: 'b', deadline: '招满为止' })]);
  evalIn(ctx, 'renderJobsChips()');
  const off = parseSoonChip(el['#jobsChips'].innerHTML);
  assert.equal(off.off, true, '一条可解析的截止日都没有 ⇒ 点了必然 0 条，必须禁用');
  assert.equal(off.n, 0);
  assert.match(off.why, /可解析的截止日期/, '原因写进 tooltip');
  // 反向：有数据就解禁（证明禁用判据是「数据里有没有」，不是写死的）
  setState(ctx, 'JOBS_CACHE', [J({ id: 'a', deadline: dueIn(1) })]);
  evalIn(ctx, 'renderJobsChips()');
  assert.equal(parseSoonChip(el['#jobsChips'].innerHTML).off, false);
});

test('近 7 天截止 chip：已选中的**永不禁用**（禁用 = 把用户锁死在空结果上）', () => {
  const { ctx, el } = makeFixture();
  setState(ctx, 'JOBS_CACHE', [
    J({ id: 'a', city: '北京', deadline: dueIn(2) }),
    J({ id: 'b', city: '上海', deadline: dueIn(3) }),
  ]);
  // 让「近 7 天」在当前城市下必然 0 条：选了 soon 之后再把城市切到没有 soon 岗位的地方
  el['#jobsDeadline'].forceValue('soon');
  el['#jobsCity'].forceValue('上海');
  evalIn(ctx, 'renderJobsChips()');
  assert.equal(parseSoonChip(el['#jobsChips'].innerHTML).n, 1, '先确认这个组合是 1 条');
  el['#jobsCity'].forceValue('广州');       // 现在「soon ∩ 广州」= 0 条，但 chip 仍被选中
  evalIn(ctx, 'renderJobsChips()');
  const chip = parseSoonChip(el['#jobsChips'].innerHTML);
  assert.equal(chip.n, 0);
  assert.equal(chip.on, true, '仍是已选态');
  assert.equal(chip.off, false, '禁用了就点不掉 —— 等于把自己锁死在 0 条上');
});

test('renderJobsChips：截止 chip **无条件渲染**（标签一条都没有时也要在，不被早退分支吞掉）', () => {
  const { ctx, el } = makeFixture();
  setState(ctx, 'JOBS_TAG_DEFS', []);            // 后端没下发标签定义
  setState(ctx, 'JOBS_CACHE', [J({ id: 'a', deadline: dueIn(2) })]);
  evalIn(ctx, 'renderJobsChips()');
  // 🔴 旧写法在「没有标签」时直接 return —— 那种早退会把截止 chip 一起吞掉
  assert.doesNotThrow(() => parseSoonChip(el['#jobsChips'].innerHTML), '无标签时也必须能解析到截止 chip');
  assert.equal(parseSoonChip(el['#jobsChips'].innerHTML).n, 1);
  assert.match(el['#jobsChips'].innerHTML, /未下发|tagDefs/, '同时仍要说明标签为什么没有');
});

// ────────────────────────── jobsResetFilters / jobsApplyView / renderJobs ──────────────────────────
test('jobsResetFilters：清掉搜索框 + 全部下拉 + 快捷标签，但**不动视图**', () => {
  const { ctx, el } = makeFixture();
  useDefs(ctx);
  setState(ctx, 'JOBS_CACHE', [J({ id: 'a', city: '北京', tags: '["免笔试"]' })]);
  el['#jobsQ'].value = '北京';
  el['#jobsCity'].forceValue('北京');
  setTags(ctx, ['免笔试']);
  setState(ctx, 'JOBS_VIEW', 'card');
  evalIn(ctx, 'renderJobs()');
  assert.equal(el['#jobsCards'].style.display, '', '先确认确实停在卡片视图');
  assert.equal(el['#jobsTableWrap'].style.display, 'none');

  evalIn(ctx, 'jobsResetFilters()');
  assert.equal(el['#jobsQ'].value, '');
  for (const s of SELECTS) assert.equal(el[s].value, '', s);
  assert.deepEqual(tagList(ctx), []);
  assert.equal(evalIn<string>(ctx, 'JOBS_VIEW'), 'card', '视图是「我怎么看」不是「我筛什么」，重置不许顺手改');
  assert.equal(el['#jobsCards'].style.display, '', '重置后仍停在卡片视图');
});

test('jobsResetFilters：重置的是 `JOBS_FILTER_SELECTS` 里的**每一个**（清单只允许有这一处）', () => {
  const { ctx, el } = makeFixture();
  setState(ctx, 'JOBS_CACHE', [J({ id: 'a' })]);
  for (const s of SELECTS) el[s].forceValue('x');    // 全部置成非空（forceValue 绕过选项校验）
  evalIn(ctx, 'jobsResetFilters()');
  for (const s of SELECTS) assert.equal(el[s].value, '', `${s} 没被重置`);
  // 清单本身要覆盖页面上真实存在的筛选控件（新增下拉忘了并进来 ⇒ 重置后它留着上次的值）
  const list = [...evalIn<string[]>(ctx, 'JOBS_FILTER_SELECTS')];
  assert.deepEqual(list, SELECTS, `重置清单与页面控件已漂移：${list.join(',')}`);
  for (const s of list) {
    const id = s.slice(1);
    assert.ok(HTML.includes(`id="${id}"`), `JOBS_FILTER_SELECTS 里的 ${s} 在 console.html 里不存在`);
  }
});

test('jobsApplyView：表格 / 卡片两块容器**互斥显示** + tab 的 active 跟随', () => {
  const { ctx, el, tabs } = makeFixture();
  const tab = (v: string) => tabs.find((t) => t.dataset.jobview === v)!;
  setState(ctx, 'JOBS_VIEW', 'table');
  evalIn(ctx, 'jobsApplyView()');
  assert.equal(el['#jobsTableWrap'].style.display, '');
  assert.equal(el['#jobsCards'].style.display, 'none');
  assert.equal(tab('table').classList.contains('active'), true);
  assert.equal(tab('card').classList.contains('active'), false);

  setState(ctx, 'JOBS_VIEW', 'card');
  evalIn(ctx, 'jobsApplyView()');
  assert.equal(el['#jobsTableWrap'].style.display, 'none');
  assert.equal(el['#jobsCards'].style.display, '');
  assert.equal(tab('card').classList.contains('active'), true);
});

test('renderJobs：只渲染**当前可见**的视图（隐藏那块保持原样）+ 计数与说明行', () => {
  const { ctx, el } = makeFixture();
  useDefs(ctx);
  setState(ctx, 'JOBS_CACHE', [J({ id: 'a', city: '北京' }), J({ id: 'b', city: '上海' })]);
  el['#jobsTbl tbody'].innerHTML = '<tr><td>SENTINEL</td></tr>';
  setState(ctx, 'JOBS_VIEW', 'card');
  evalIn(ctx, 'renderJobs()');
  assert.equal(el['#jobsTbl tbody'].innerHTML, '<tr><td>SENTINEL</td></tr>',
    '不可见的表格视图不该被重建（两个都渲染 = 每次按键建两遍 DOM，且两块可能不同步）');
  assert.ok(el['#jobsCards'].innerHTML.includes('某公司'));
  assert.equal(el['#jobsCount'].textContent, '2 个岗位');

  el['#jobsCity'].forceValue('北京');
  evalIn(ctx, 'renderJobs()');
  assert.equal(el['#jobsCount'].textContent, '1 / 2 个', '筛选生效后计数要变成「筛出 / 全部」');
  assert.match(el['#jobsStat'].textContent, /当前筛出 1 个/);
});

test('renderJobs：说明行讲清「为什么被禁用」与「为什么条件被重置」（静默失效最伤人的地方）', () => {
  const { ctx, el } = makeFixture();
  setState(ctx, 'JOBS_CACHE', [J({ id: 'a', city: '北京', job_type: '技术岗' })]);
  evalIn(ctx, 'renderJobs()');
  assert.match(el['#jobsStat'].textContent, /筛选已禁用/);
  assert.match(el['#jobsStat'].textContent, /届别/, '要说清是哪几项被禁用了');

  // 用户先前选的档位在刷新后消失 ⇒ 必须说明「是我们撤掉的」，否则他以为筛选还在生效
  el['#jobsCity'].forceValue('上海');
  evalIn(ctx, 'renderJobs()');
  assert.match(el['#jobsStat'].textContent, /已重置为「全部」/);
  assert.match(el['#jobsStat'].textContent, /城市/);
});

test('renderJobsTable：届别列有值出徽章、无值出占位；空态的 colspan 与表头列数一致', () => {
  const { ctx, el } = makeFixture();
  setState(ctx, 'JOBS_CACHE', [J({ id: 'a', grad_year: '2027' }), J({ id: 'b', grad_year: null })]);
  evalIn(ctx, 'renderJobsTable(JOBS_CACHE)');
  const h = el['#jobsTbl tbody'].innerHTML;
  assert.ok(h.includes('2027 届'));
  assert.equal((h.match(/<tr>/g) || []).length, 2);
  evalIn(ctx, 'renderJobsTable([])');
  const empty = el['#jobsTbl tbody'].innerHTML;
  // 🔴 列数变了却忘了改 colspan ⇒ 空态那行错位（而且只在"没数据"时才看得见）
  const thead = /<table[^>]*id="jobsTbl"[\s\S]*?<thead>([\s\S]*?)<\/thead>/.exec(HTML);
  assert.ok(thead, 'console.html 里找不到 #jobsTbl 的 thead');
  const thCount = [...thead![1].matchAll(/<th[\s>]/g)].length;
  const cs = /colspan="(\d+)"/.exec(empty);
  assert.ok(cs, `空态没有 colspan：${empty}`);
  assert.equal(Number(cs![1]), thCount, `空态 colspan=${cs![1]} 与表头 ${thCount} 列不一致`);
});

// ────────────────────────── jobCardHtml（卡片视图的徽章口径） ──────────────────────────
test('jobCardHtml：届别 / 标签徽章**只读库里的列**，绝不重新解析 card_text', () => {
  const { ctx } = makeFixture();
  const card = fnOf(ctx, 'jobCardHtml');
  const j = J({ id: 'a', card_text: '某司 更新 9月1日 岗位 民企 北京 2027 届 尽快投递 秋招 免笔试', grad_year: null, tags: null });
  const h = String(card(j, ''));
  for (const s of ['2027 届', '秋招', '免笔试']) {
    assert.ok(!h.includes(s), `卡片自行解析 card_text 会出现「${s}」—— 筛选器读的是列，两边必然对不上`);
  }
  const h2 = String(card(J({ id: 'b', grad_year: '2027', tags: '["免笔试","秋招"]' }), ''));
  assert.ok(h2.includes('2027 届'));
  assert.ok(h2.includes('badge b-info">免笔试'));
  assert.ok(h2.includes('badge b-info">秋招'));
});

test('jobCardHtml：标签徽章最多 4 个（卡片是概览不是全量）+ actions 可选', () => {
  const { ctx } = makeFixture();
  const card = fnOf(ctx, 'jobCardHtml');
  const h = String(card(J({ id: 'a', tags: '["免笔试","秋招","春招","实习","央国企"]' })));
  for (const s of ['免笔试', '秋招', '春招', '实习']) assert.ok(h.includes(s), s);
  assert.ok(!h.includes('央国企'), '第 5 个标签不出徽章');
  assert.ok(!h.includes('data-jv='), '不传 actions 就不该有操作按钮');
  const h2 = String(card(J({ id: 'a' }), '<button data-jv="a">详情</button>'));
  assert.ok(h2.includes('data-jv="a"'), '传了 actions 就要原样放进去');
});
