/**
 * 岗位名「输出侧」清洗单测。
 *
 * 用例全部来自**实测库内数据**（2026-10-10 扫 `data/chat.db` 的 3200 行 jobs）：
 *  - 19 行为空、4 行含反斜杠、138 行 >40 字，最长 80 字；
 *  - >40 字的几乎全是 offerbiu 的「多岗位并列」串（`A、B、C 等 N 项 …`）。
 * 期望值不是「跑出来是什么就写什么」—— 每个都对照下面的语义逐条核对过：
 *  - 反斜杠是解析残留的**分隔符** ⇒ 换成 `/`，且吃掉两侧空白（`Java \ C#` 不该留空格）；
 *  - 零宽字符 ⇒ **删掉**（不是换空格，否则会凭空造词边界）；
 *  - 换行/制表 ⇒ 换空格（它们原本确实是词边界）后再折叠；
 *  - 截断 ⇒ 强分隔符（顿号/逗号/斜杠…）优先，切点不足一半则硬切；末尾不留下悬空分隔符。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobPositionLabel, POSITION_LABEL_MAX, POSITION_LABEL_FALLBACK } from '../../server/services/apply/jobText.js';

// ── 1. 反斜杠：库内 4 行的真实形态 ─────────────────────────────────────────
const BACKSLASH_CASES: Array<[string, string]> = [
  // `AI Agent 开发工程师\计算机`（库内原文，反斜杠前后无空格）
  ['AI Agent 算法工程师、AI Agent 开发工程师\\计算机', 'AI Agent 算法工程师、AI Agent 开发工程师/计算机'],
  // `软件工程师Java\C#（3-6个月长期出差）` —— `\C` 若不转义会被 JS 当成 `C`，这里写成 `\\C`
  ['软件工程师Java\\C#（3-6个月长期出差）', '软件工程师Java/C#（3-6个月长期出差）'],
  // `未明确 \车辆工程`：两侧留白要一起吃掉，不能产出 `未明确 /车辆工程`
  ['未明确 \\车辆工程', '未明确/车辆工程'],
  // 连续多个反斜杠合成的分隔符
  ['A\\\\B', 'A/B'],
];

test('反斜杠（解析残留的分隔符）⇒ / 且吃掉两侧空白', () => {
  for (const [input, expected] of BACKSLASH_CASES) {
    assert.equal(jobPositionLabel(input), expected, `输入 ${JSON.stringify(input)}`);
  }
});

// ── 2. 截断 ───────────────────────────────────────────────────────────────
// 80 字样本（库内最长）：强分隔符最后出现在第 2 个顿号 ⇒ 切在那里，
// 而不是把 `北京多模态算法工程师 等 9 项` 加进来凑到 40 再砍一半。
const SAMPLE_80 = '北京大模型算法工程师、北京智能体算法工程师、北京多模态算法工程师 等 9 项 民企 IT/互联网/游戏/电商 北京、深圳 2027 届 尽快投递 秋招 需要笔试';

test('超长「多岗位并列」串 ⇒ 切在强分隔符处，不劈开「等 N 项」', () => {
  assert.equal(jobPositionLabel(SAMPLE_80), '北京大模型算法工程师、北京智能体算法工程师…');
  // 41 字样本：最后一个空格落在 `等 2` 之后（切出来是 `… 等 2…`），
  // 强分隔符优先的规则正是为了避开这种劈法。
  assert.equal(
    jobPositionLabel('推理框架开发工程师、强化学习训练框架研发工程师、Golang后端工程师 等 2 项'),
    '推理框架开发工程师、强化学习训练框架研发工程师…',
  );
});

test('没有任何分隔符时才硬切，且末尾不留悬空分隔符', () => {
  const hard = 'Abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ'; // 46 字、无强分隔符、无空格
  assert.equal(jobPositionLabel(hard), 'Abcdefghijklmnopqrstuvwxyz0123456789ABCD…');
  // 长英文职位名：没有强分隔符，退而用空格切（否则会在单词中间断掉）
  assert.equal(
    jobPositionLabel('Senior Machine Learning Engineer (Recommendation Systems)'),
    'Senior Machine Learning Engineer…',
  );
});

test('长度不超过上限时逐字不变（不引入任何副作用）', () => {
  for (const s of [
    '前端开发（Vue3）',
    'Java（外包兴业银行-远程面试-项目稳定）',
    '一'.repeat(POSITION_LABEL_MAX),
  ]) {
    assert.equal(jobPositionLabel(s), s, `输入 ${JSON.stringify(s)}`);
  }
  assert.equal(POSITION_LABEL_MAX, 40, '上限须与 coverLetter 的 {职位名称} 既有口径一致');
  // 恰好超一个字 ⇒ 才进入截断分支
  assert.equal(jobPositionLabel('一'.repeat(POSITION_LABEL_MAX + 1)), '一'.repeat(POSITION_LABEL_MAX) + '…');
});

// ── 3. 空白与不可见字符 ───────────────────────────────────────────────────
const WHITESPACE_CASES: Array<[string, string]> = [
  ['  多  余   空白  ', '多 余 空白'],          // 折叠为单空格，但不吞词间空格（与 sanitizeJobText 同口径）
  ['Java\n开发', 'Java 开发'],                  // 换行 ⇒ 空格（原本是两个词）
  ['Java\t开发', 'Java 开发'],                  // 制表 ⇒ 空格
  ['Java\u200b开发', 'Java开发'],               // 零宽空格 ⇒ 删掉（换成空格会凭空造词边界）
  ['Java\ufeff开发', 'Java开发'],               // BOM ⇒ 删掉
];

test('空白折叠与不可见字符处理', () => {
  for (const [input, expected] of WHITESPACE_CASES) {
    assert.equal(jobPositionLabel(input), expected, `输入 ${JSON.stringify(input)}`);
  }
});

// ── 4. 空值兜底 ───────────────────────────────────────────────────────────
test('清洗后为空 ⇒ 默认「该岗位」；显式传 \'\' 时保持空', () => {
  for (const empty of ['', '   ', '\n\t', '\u0000\u0001', '\u200b', null, undefined]) {
    assert.equal(jobPositionLabel(empty), POSITION_LABEL_FALLBACK, `输入 ${JSON.stringify(empty)}`);
    // 🔴 邮件标题场景必须能关掉兜底：空 ⇒ 占位符「未解析」⇒ 走兜底标题；
    //    若注入「该岗位」，标题会变成 `应聘该岗位-张三-138…`，比空着更糟。
    assert.equal(jobPositionLabel(empty, ''), '', `输入 ${JSON.stringify(empty)}（fallback=''）`);
  }
  assert.equal(POSITION_LABEL_FALLBACK, '该岗位');
});

// ── 5. 幂等 + 不回写 ──────────────────────────────────────────────────────
test('幂等：清洗过的值再洗一次必须逐字相同', () => {
  const all = [...BACKSLASH_CASES.map(([i]) => i), ...WHITESPACE_CASES.map(([i]) => i), SAMPLE_80, '一'.repeat(60)];
  for (const raw of all) {
    const once = jobPositionLabel(raw);
    assert.equal(jobPositionLabel(once), once, `输入 ${JSON.stringify(raw)} ⇒ ${JSON.stringify(once)}`);
  }
});
