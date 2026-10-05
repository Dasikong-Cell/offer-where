/**
 * 校招卡片元数据解析器（`server/services/parseCardMeta.ts`）的真值表单测。
 *
 * 为什么这一层必须有测试：它决定 `jobs.grad_year` / `jobs.tags` / `jobs.deadline` 三列的**内容**，
 * 而这三列是控制台筛选器的**唯一数据源**。解析错了不会报错，只会让用户筛出的结果少一截 ——
 * 「筛选器工作正常，只是数据不对」，没有任何一处会红。
 *
 * 断言全部按**真实语料**写（样例取自 `jobs.card_text` 的实测值），不是构造出来的理想输入。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGradYear, parseCardDeadline, parseCardTags, parseCardMeta,
  normalizeGradYear, normalizeTagList, serializeTags, parseTags,
  CARD_TAG_DEFS, CARD_UI_TAGS, CARD_TAG_KEYS,
} from '../../server/services/parseCardMeta.js';

/** offerbiu 校招卡片的真实形态（字段顺序：公司 更新 月日 职位 等N项 行业 性质 城市 届别 时间 批次 要求 入口） */
const REAL_META = '航天八院802所 更新 9月2日 信息与通信工程、电子科学与技术、控制科学与工程 等 9 项 制造业 央国企 上海 2027 届 尽快投递 秋招 免笔试 投递入口 加入投递';
const REAL_DATED = '中国电子云 更新 9月11日 LLM算法工程师、多模态算法工程师 等 9 项 IT/互联网/游戏 央国企 北京、武汉、南京、成都 等 1 项 2027 届 2026/11/30 秋招 免笔试 投递入口 加入投递';

// ────────────────────────── 届别 ──────────────────────────
test('parseGradYear：只认「4 位年份 + 届」，职位名里的短写「27届」不算', () => {
  assert.equal(parseGradYear(REAL_META), '2027');
  assert.equal(parseGradYear('某公司 更新 9月1日 AI检测算法工程师27届 2027 届 尽快投递'), '2027',
    '同一段文本里既有短写又有完整写法时取完整写法（短写歧义太大，宁可不用）');
  assert.equal(parseGradYear('滴滴 更新 9月17日 27届秋招-产品助理 民企 北京 尽快投递'), null,
    '整行只有短写 ⇒ 返回 null，而不是猜成 2027');
  assert.equal(parseGradYear(''), null);
  assert.equal(parseGradYear(null), null);
  assert.equal(parseGradYear(undefined), null);
  assert.equal(parseGradYear('2027年校园招聘'), null, '「2027年」不是届别');
});

test('parseGradYear：多届时只取第一个年份（不拆成多值，避免为 1 条数据把筛选判据复杂化）', () => {
  assert.equal(parseGradYear('之江实验室 更新 5月23日 事业单位, 其他 杭州 2026/2027 届 尽快投递 春招'), '2027');
});

test('normalizeGradYear：任意形态都收敛成 4 位年份（下拉候选只能有一个形态）', () => {
  assert.equal(normalizeGradYear('2027届'), '2027');
  assert.equal(normalizeGradYear('2027 届'), '2027');
  assert.equal(normalizeGradYear('2027-2028'), '2027');
  assert.equal(normalizeGradYear(2027), '2027');
  assert.equal(normalizeGradYear(' 2026 '), '2026');
  assert.equal(normalizeGradYear('20277'), null, '5 位数不是年份（`(?<!\\d)(20\\d\\d)(?!\\d)` 的右边界）');
  assert.equal(normalizeGradYear('1997届'), null, '早于 2000 的年份不是届别');
  assert.equal(normalizeGradYear('应届生'), null);
  assert.equal(normalizeGradYear(''), null);
  assert.equal(normalizeGradYear(null), null);
});

// ────────────────────────── 截止日 ──────────────────────────
test('parseCardDeadline：「届别 token 之后紧邻的日期」才是截止日（结构性判据，实测 113/113）', () => {
  assert.equal(parseCardDeadline(REAL_DATED), '2026-11-30');
  assert.equal(parseCardDeadline('昊一源 更新 9月11日 图像算法工程师 民企 能源/化工/环保 深圳、武汉 2027 届 2026/11/01 秋招 需要笔试'),
    '2026-11-01');
  assert.equal(parseCardDeadline('航天科工二院-暑期实践 更新 5月23日 2027暑期实践团 事业单位 北京 2027 届 2026.05.31 暑期实习'),
    '2026-05-31', '点号分隔的日期同样认');
});

test('parseCardDeadline：「尽快投递 / 招满为止 / 招满即止」不是日期 ⇒ null（实测 718 + 132 条）', () => {
  assert.equal(parseCardDeadline(REAL_META), null, '「尽快投递」后面没有日期');
  assert.equal(parseCardDeadline('西安航天动力试验技术研究所 更新 8月28日 事业单位 西安 2027 届 招满为止 秋招 免笔试'), null);
  assert.equal(parseCardDeadline('之江实验室 更新 5月23日 事业单位 杭州 2027 届 招满即止 暑期实习'), null);
  assert.equal(parseCardDeadline(''), null);
  assert.equal(parseCardDeadline(null), null);
});

test('parseCardDeadline：顶部的「更新 9月11日」**取不到**（没有年份，结构上就不可能命中）', () => {
  const noDeadline = '库犸科技 更新 9月11日 SLAM算法工程师 民企 IT/互联网/游戏/电商 深圳、香港 2027 届 尽快投递 秋招';
  assert.equal(parseCardDeadline(noDeadline), null);
  // 反过来：卡片里确实写了个日期但**不在届别之后** ⇒ 也不能当截止日
  assert.equal(parseCardDeadline('某公司 更新 9月11日 岗位要求 2026/11/30 前到岗 民企 北京 2027 届 尽快投递'), null,
    '日期在「要求」段而不是「时间」列 —— 拿了它就会把「到岗日」当截止日');
});

test('parseCardDeadline：非法日期返回 null（不许把 2月30日 写进库）', () => {
  assert.equal(parseCardDeadline('某公司 2027 届 2026/13/01 秋招'), null, '13 月');
  assert.equal(parseCardDeadline('某公司 2027 届 2026/02/30 秋招'), null, '2月30日不存在');
  assert.equal(parseCardDeadline('某公司 2027 届 1999/01/01 秋招'), null, '年份越界');
});

// ────────────────────────── 标签 ──────────────────────────
test('parseCardTags：真实卡片拆出「免笔试 / 秋招 / 央国企」', () => {
  assert.deepEqual(parseCardTags(REAL_META), ['免笔试', '秋招', '央国企']);
  assert.deepEqual(parseCardTags('重庆航天火箭电子技术有限公司 更新 9月2日 应用软件开发 制造业 央国企 重庆 2027 届 尽快投递 秋招 需要笔试'),
    ['秋招', '央国企'], '「需要笔试」不在白名单里 ⇒ 不打标（它是「免笔试」的补集，不是筛选意图）');
});

test('parseCardTags：企业性质按 **token 等值**判定，行业大类「政府/事业单位/社会组织」不能算作事业单位', () => {
  // 🔴 这是本模块存在的核心理由：子串匹配会把行业名当成企业性质
  assert.deepEqual(parseCardTags('中大咨询集团 更新 9月2日 博士顾问 政府/事业单位/社会组织 民企 北京、广州、香港 2027 届 尽快投递 秋招 需要笔试'),
    ['秋招', '民企'], '这一行的性质是民企；`政府/事业单位/社会组织` 是行业大类');
  // 同时含行业大类与独立性质 token 的行：性质确实有，必须打上
  assert.deepEqual(parseCardTags('天津先进技术研究院 更新 9月5日 人工智能 政府/事业单位/社会组织 事业单位 天津、长沙 2027 届 尽快投递 秋招'),
    ['秋招', '事业单位']);
});

test('parseCardTags：A/B 形式的多值性质（外企/合资）整体接受，但要求每一段都是已知性质', () => {
  // ⚠️ 期望值的顺序恒为 `CARD_TAG_DEFS` 的顺序，**不是原文出现顺序**。
  //    `合资` 在定义表里排在 `外企` 之后 ⇒ `外企/合资` 得到 `['外企','合资']`。
  assert.deepEqual(parseCardTags('某外企 更新 9月1日 岗位 外企/合资 上海 2027 届 尽快投递'), ['外企', '合资']);
  assert.deepEqual(parseCardTags('某公司 更新 9月1日 岗位 民企/外企 上海 2027 届 尽快投递'), ['外企', '民企'],
    '顺序按 CARD_TAG_DEFS，不按原文出现顺序');
  assert.deepEqual(parseCardTags('某公司 更新 9月1日 岗位 政府/事业单位/社会组织 上海 2027 届 尽快投递'), [],
    '只要有一段不是已知性质，整个 token 都不是性质 —— 否则行业大类会被当成性质');
});

test('parseCardTags：token 尾部粘着的标点要剥掉（实测 `事业单位,` 这种写法）', () => {
  assert.deepEqual(parseCardTags('之江实验室 更新 5月23日 测试运维 事业单位, 其他 杭州 2026/2027 届 尽快投递 春招 免笔试'),
    ['免笔试', '春招', '事业单位']);
});

test('parseCardTags：「研究所」是**公司名关键词**，不是企业性质（token 等值实测 0 条）', () => {
  // 顺序恒按 `CARD_TAG_DEFS`：免笔试(0) → 秋招(1) → … → 研究所(5) → … → 事业单位(7)
  assert.deepEqual(parseCardTags('西安航天动力试验技术研究所 更新 8月28日 试验测控技术岗 事业单位 西安 2027 届 招满为止 秋招 免笔试'),
    ['免笔试', '秋招', '研究所', '事业单位'], '公司名含研究所 ⇒ 打标；性质是事业单位 ⇒ 也打标');
  assert.deepEqual(parseCardTags('之江实验室 更新 5月23日 聚焦算力 学术科研/研究所/实验室/技术服务/检测认证 事业单位 杭州 2027 届 招满即止 暑期实习'),
    ['实习', '事业单位', '暑期实习'], '「研究所」出现在**行业大类**里 ⇒ 不算公司名，不打标');
  assert.deepEqual(parseCardTags('某公司 更新 9月1日 研究所算法工程师 民企 北京 2027 届 秋招'), ['秋招', '民企'],
    '「研究所」只出现在职位名里 ⇒ 不打标（只看公司名那一段）');
});

test('parseCardTags：`暑期实习` 同时得到「实习」与「暑期实习」（包含关系是有意的）', () => {
  // `民企` 是**独立的性质 token**，同一张卡片上确实同时是民企 ⇒ 必须一起出现。
  // 顺序恒按 `CARD_TAG_DEFS`：免笔试(0) → 实习(3) → 民企(8) → 暑期实习(10)
  assert.deepEqual(parseCardTags('某公司 更新 9月1日 岗位 民企 北京 2027 届 尽快投递 暑期实习 免笔试'), ['免笔试', '实习', '民企', '暑期实习']);
  assert.deepEqual(parseCardTags('某公司 更新 9月1日 岗位 民企 北京 2027 届 尽快投递 秋招'), ['秋招', '民企']);
});

test('parseCardTags：标签顺序恒为 CARD_TAG_DEFS 的顺序（同一份数据在不同调用里不能渲染出不同顺序）', () => {
  const t1 = parseCardTags(REAL_DATED);
  const t2 = parseCardTags(REAL_DATED);
  assert.deepEqual(t1, t2);
  // 与定义表的相对顺序一致
  const idx = (k: string) => CARD_TAG_DEFS.findIndex((d) => d.key === k);
  for (let i = 1; i < t1.length; i++) {
    assert.ok(idx(t1[i - 1]) < idx(t1[i]), `${t1[i - 1]} 应排在 ${t1[i]} 之前`);
  }
});

test('parseCardTags：空/纯自由文本 ⇒ 不打任何标签（宁缺勿滥）', () => {
  for (const v of ['', '   ', null, undefined, '某公司 更新 9月1日 岗位']) {
    assert.deepEqual(parseCardTags(v as any), []);
  }
});

// ────────────────────────── parseCardMeta 组合 ──────────────────────────
test('parseCardMeta：一次给出三样，与三个单项函数逐字段一致（组合不许有第二套逻辑）', () => {
  for (const t of [REAL_META, REAL_DATED, '某公司 更新 9月1日 岗位 政府/事业单位/社会组织 民企 北京 2026/2027 届 2026.05.31 暑期实习']) {
    const m = parseCardMeta(t);
    assert.equal(m.gradYear, parseGradYear(t));
    assert.deepEqual(m.tags, parseCardTags(t));
    assert.equal(m.deadline, parseCardDeadline(t));
  }
  assert.deepEqual(parseCardMeta(null), { gradYear: null, tags: [], deadline: null });
  assert.deepEqual(parseCardMeta('  '), { gradYear: null, tags: [], deadline: null });
});

// ────────────────────────── 标签的收敛 / 序列化 ──────────────────────────
test('normalizeTagList：过白名单 + 去重 + 按定义表排序（库里不可能出现表外标签）', () => {
  assert.deepEqual(normalizeTagList(['秋招', '免笔试']), ['免笔试', '秋招'], '顺序恒按定义表');
  assert.deepEqual(normalizeTagList(['秋招', '秋招']), ['秋招']);
  assert.deepEqual(normalizeTagList(['不存在的标签', '秋招']), ['秋招'], '表外标签被丢掉');
  assert.deepEqual(normalizeTagList('免笔试,秋招'), ['免笔试', '秋招'], '逗号串也接受');
  assert.deepEqual(normalizeTagList('["免笔试","秋招"]'), ['免笔试', '秋招'], 'JSON 串是正常形态');
  assert.deepEqual(normalizeTagList('["免笔试","表外"]'), ['免笔试']);
  assert.deepEqual(normalizeTagList('[这不是 JSON'), [], '坏 JSON 不能退化成「把 [ 也当标签」');
  assert.deepEqual(normalizeTagList([]), []);
  assert.deepEqual(normalizeTagList(null), []);
  assert.deepEqual(normalizeTagList(undefined), []);
});

test('serializeTags / parseTags：往返一致，且空集合统一落 null（全项目只认一种「没有标签」）', () => {
  const round = (v: unknown) => parseTags(serializeTags(v));
  assert.deepEqual(round(['秋招', '免笔试']), ['免笔试', '秋招']);
  assert.equal(serializeTags([]), null);
  assert.equal(serializeTags(['表外']), null);
  assert.equal(serializeTags(null), null);
  assert.deepEqual(parseTags(''), []);
  assert.deepEqual(parseTags(null), []);
  assert.deepEqual(parseTags('坏值'), [], '脏值不许抛出（否则整个列表页白屏）');
  // 序列化结果必须是 JSON 数组 —— 前端只做 JSON.parse，这一条是那个约定的地基
  for (const v of [['秋招'], ['秋招', '央国企'], ['暑期实习', '实习', '免笔试']]) {
    const s = serializeTags(v)!;
    assert.ok(s.startsWith('[') && s.endsWith(']'), s);
    assert.ok(Array.isArray(JSON.parse(s)), s);
  }
});

// ────────────────────────── 定义表自身的完整性 ──────────────────────────
test('CARD_TAG_DEFS：key 唯一、hint 必填且够具体（语义与字面不一致时 hint 是唯一解释入口）', () => {
  const keys = CARD_TAG_DEFS.map((d) => d.key);
  assert.equal(new Set(keys).size, keys.length, 'key 不能重复');
  assert.deepEqual(CARD_TAG_KEYS, keys, 'CARD_TAG_KEYS 必须与 CARD_TAG_DEFS 同序同集合');
  for (const d of CARD_TAG_DEFS) {
    assert.ok(d.label && d.label.length > 0, `${d.key} 缺 label`);
    assert.ok(d.hint && d.hint.length >= 8, `${d.key} 的 hint 太短，等于没有解释`);
  }
  const inst = CARD_TAG_DEFS.find((d) => d.key === '研究所')!;
  assert.match(inst.hint, /公司名/, '「研究所」的语义与字面不一致，hint 必须点明它是公司名关键词');
  assert.ok(CARD_UI_TAGS.length >= 4 && CARD_UI_TAGS.every((d) => d.ui));
  assert.ok(CARD_UI_TAGS.length < CARD_TAG_DEFS.length, '「民企」这类只落库、不上控制台（不是筛选意图）');
});
