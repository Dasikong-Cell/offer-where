/**
 * 「投递表单字段标签 → 候选人档案键」映射单测。
 *
 * 为什么需要**行为级**单测，而不是再加几条静态合约断言：
 *   这张表的核心语义是「**顺序即优先级、命中即停**」。顺序错了不会报错、不会崩，
 *   只是**填得出值、值是错的**（比如把本人的手机号填进「紧急联系电话」）。
 *   静态扫描只能证明「某一行在另一行前面」——那是代理指标；真正要证明的是
 *   「喂 '紧急联系电话' 进去，拿回来的是紧急联系人电话」。
 *
 * 两处已实测的静默填错（就是下面 B 组的那两条）：
 *   · `紧急联系电话` 曾命中 `/电话/` ⇒ 填成**本人手机**；
 *   · `户籍所在地`   曾命中 `/所在/` ⇒ 填成**居住城市**。
 *
 * C 组是「字段可达性」：把 public/console.html 里 AF_SECTIONS 的每个字段标签
 *   原样喂进去，必须解析到它自己的键。这一条同时覆盖两个方向 ——
 *   标签解析不出来（界面上填了值、投递时永远填不上）、以及解析到**别的**键。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { profileValueForLabel } from '../../server/services/apply/offerbiu.js';

type Prof = Parameters<typeof profileValueForLabel>[1];
/** 造一个「只有这些键有值」的档案。类型上 ApplyProfile 全是可选键，构造器只做形状适配 */
const mk = (o: Record<string, string>): Prof => o as unknown as Prof;
const pick = (label: string, o: Record<string, string>) => profileValueForLabel(label, mk(o));

// ── A. 空值必须返回 undefined（不是空串）──────────────────────────────────
// 调用方是 `v ?? 下一优先级`。返回空串会**截断回退链**，
// 结果就是「明明档案里有值、表单里却是空的」，而且不报错。
test('A. 档案里没有这个键时返回 undefined（返回空串会截断调用方的 ?? 回退链）', () => {
  assert.equal(pick('性别', {}), undefined);
  assert.equal(pick('民族', { gender: '男' }), undefined);
  // 值是纯空白也当「没有」：表单里敲了个空格不该被当成有效值带过去
  assert.equal(pick('民族', { nation: '   ' }), undefined);
  // 空标签直接给 undefined，不能落进任何规则
  assert.equal(profileValueForLabel('', mk({ gender: '男' })), undefined);
});

// ── B. 顺序：具体规则必须早于宽泛规则 ───────────────────────────────────────
test('B1. 紧急联系电话 → 紧急联系人电话（不是本人手机）', () => {
  const p = { phone: '13800000000', emergencyPhone: '13911111111' };
  assert.equal(pick('紧急联系电话', p), '13911111111');
  assert.equal(pick('紧急联系电话（备用）', p), '13911111111');
  assert.equal(pick('紧急联系人手机号', p), '13911111111');
});

test('B2. 户籍所在地 → 户籍（不是现居城市）', () => {
  const p = { city: '北京', domicile: '山东省济南市' };
  assert.equal(pick('户籍所在地', p), '山东省济南市');
  assert.equal(pick('户籍所在城市', p), '山东省济南市');
});

test('B3. 紧急联系人 / 与本人关系 各自落到自己的键（都不能落到手机号）', () => {
  const p = { phone: '13800000000', emergencyContact: '张某某', emergencyRelation: '父亲' };
  assert.equal(pick('紧急联系人', p), '张某某');
  assert.equal(pick('紧急联系人姓名', p), '张某某');
  // 「与本人关系」通常不带「紧急」二字（标题已写了「紧急联系人」）
  assert.equal(pick('与本人关系', p), '父亲');
  assert.equal(pick('紧急联系人关系', p), '父亲');
});

test('B4. 「国家/国籍」不认单独的「地区」（否则「意向地区」会被填成国家）', () => {
  const p = { country: '中国', city: '北京' };
  assert.equal(pick('国家/地区', p), '中国');
  assert.equal(pick('国籍', p), '中国');
  assert.equal(pick('意向地区', p), undefined);
});

// ── C. 命中即停：不回退到更宽的规则 ────────────────────────────────────────
// 注意区分两件事：
//   ① **显式兜底** —— 写在 pick 里的 `a || b`，比如「期望城市」为空时用现居城市。
//      个人中心那个输入框本来就是 `expectedCity || city` 的语义，所以这是产品定义，可审。
//   ② **意外回退** —— 规则顺序失守，具体标签命中了宽泛规则。这才是静默填错的来源。
//      本组证明「具体标签不会掉进宽泛规则」，即 ② 不会发生。
test('C1. 「期望城市」为空时兜底到现居城市（这是写在 pick 里的显式兜底，不是顺序失守）', () => {
  const p = { city: '北京', expectedCity: '' };
  assert.equal(pick('期望城市', p), '北京');
});

test('C2. 但「面试城市」不许兜底到现居城市（面试安排是具体信息，猜不得 ⇒ 留空）', () => {
  // 若「面试城市」掉进了宽泛的 `/城市|所在地|地点/` 规则，这里就会返回「北京」
  assert.equal(pick('面试城市', mk({ city: '北京', interviewCity: '' })), undefined);
  assert.equal(pick('面试城市', mk({ city: '北京', interviewCity: '上海' })), '上海');
  assert.equal(pick('可面试城市', mk({ city: '北京', interviewCity: '上海' })), '上海');
});

test('C3. 命中后不回退：期望城市有值就用期望城市', () => {
  assert.equal(pick('期望城市', mk({ city: '北京', expectedCity: '上海' })), '上海');
});

// ── D. 标签先规整再匹配 ────────────────────────────────────────────────────
// 探测出来的标签常带空格 / 全角空格（`工作 城市`、`紧急 联系电话`），
// 不规整就会漏判 —— 表现为「这一格又没填上」。
test('D. 标签里的半角 / 全角空格先剥掉再匹配', () => {
  assert.equal(pick('工作 城市', mk({ expectWorkCity: '苏州' })), '苏州');
  assert.equal(pick('紧急 联系电话', mk({ emergencyPhone: '13911111111' })), '13911111111');
  assert.equal(pick('姓\u3000名', mk({ name: '张三' })), '张三');
});

// ── E. 字段可达性：AF_SECTIONS 的每一格都要真的解析得到 ────────────────────
// 这条不是「再抄一遍规则表」，而是把界面上真实存在的标签喂进真实解析器：
// 任何一格解析不出来（或解析到别人身上）都会在这里红。
test('E. public/console.html 里 AF_SECTIONS 的每个字段标签都能解析到它自己的键', () => {
  const html = fs.readFileSync(new URL('../../public/console.html', import.meta.url), 'utf8');
  // ⚠️ 必须先剥 HTML 注释：注释里举例写一句 {k:'xxx',label:'…'} 会被当成真字段
  const noComment = html.replace(/<!--[\s\S]*?-->/g, '');
  const m = noComment.match(/const AF_SECTIONS = \[([\s\S]*?)\n\];/);
  assert.ok(m, 'AF_SECTIONS 没找到 —— 正则坏了（否则这条会恒绿）');
  const fields = [...m![1].matchAll(/\{k:'([A-Za-z0-9_]+)', label:'([^']+)'/g)]
    .map((x) => ({ k: x[1], label: x[2] }));
  // 反向护栏：解析出的字段数太少说明正则失配，不能让「零用例」冒充全绿
  assert.ok(fields.length >= 50, `只解析到 ${fields.length} 个字段，正则疑似失配`);

  const MARK = '唯一标记值';
  const bad: string[] = [];
  for (const { k, label } of fields) {
    // 造一个「只有这一格有值」的档案：解析结果要么是它自己，要么是 undefined。
    // 若解析到了别人的键，那个键是空的 ⇒ 拿到 undefined ⇒ 记为「不可达」。
    const got = pick(label, { [k]: MARK });
    if (got !== MARK) bad.push(`${label} → ${k}（实际 ${got === undefined ? '解析不到' : JSON.stringify(got)}）`);
  }
  assert.equal(bad.length, 0, `以下字段不可达：\n  ${bad.join('\n  ')}`);
});
