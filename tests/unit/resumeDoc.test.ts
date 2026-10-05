/**
 * 简历制作（D 批）的纯函数单测：`server/services/apply/resumeDoc.ts` + `resumeTheme.ts`。
 *
 * 为什么这一层必须有测试（不是靠静态断言）：
 *   ① `sanitizeDoc` 是**唯一的入站闸口** —— 草稿直接来自 `req.body`，而 `theme.accent`
 *      会被拼进 CSS。放行任意串就是给用户一个注入面；这条只能靠真跑一遍来证明。
 *   ② 渲染结果要进 PDF。若哪天渲染出 `<script>` 或外链，产物会在别人机器上打开时
 *      静默变化（外链失效 / 脚本执行），而生成那一步不会报任何错。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  safeDocId, newDoc, sanitizeDoc, accentColor, renderResumeDoc,
} from '../../server/services/apply/resumeDoc.js';
import { RESUME_ACCENTS, DEFAULT_ACCENT_KEY, RESUME_VARIANTS, DEFAULT_VARIANT_KEY } from '../../server/services/apply/resumeTheme.js';

// ────────────────────────── safeDocId ──────────────────────────
test('safeDocId：只放行 [a-zA-Z0-9_-]（它会进 app_kv 的 key 与文件名）', () => {
  assert.equal(safeDocId('abc'), 'abc');
  assert.equal(safeDocId('my doc'), 'my-doc');
  // 🔴 前导连字符必须一并去掉：这个串既进 app_kv 的 key 也进文件名，
  //    以 `-` 开头在命令行语境下会被当 flag；所以结果不是 '-etc-passwd' 而是 'etc-passwd'。
  assert.equal(safeDocId('../../etc/passwd'), 'etc-passwd', '路径分隔符必须被替换掉');
  assert.equal(safeDocId('a/b\\c'), 'a-b-c');
  assert.equal(safeDocId(''), 'doc');
  assert.equal(safeDocId(null), 'doc');
  assert.equal(safeDocId(undefined), 'doc');
  assert.equal(safeDocId('   '), 'doc');
  assert.equal(safeDocId('-x-'), 'x', '首尾连字符要去掉');
  assert.equal(safeDocId('x'.repeat(200)).length, 40, '超长要截断');
});

// ────────────────────────── sanitizeDoc ──────────────────────────
test('sanitizeDoc：主题色**只认白名单**（放行任意串 = CSS 注入面）', () => {
  for (const bad of ['red', '#ff0000', 'blue;} body{display:none', '', null, undefined, 123, {}]) {
    assert.equal(sanitizeDoc({ theme: { accent: bad } }).theme.accent, DEFAULT_ACCENT_KEY, String(bad));
  }
  assert.equal(sanitizeDoc({ theme: { accent: 'teal' } }).theme.accent, 'teal', '白名单内的要放行');
  // 🔴 反向：这份白名单必须与渲染器共用同一份常量，否则「能存进去但渲染不出来」
  for (const a of RESUME_ACCENTS) {
    assert.equal(sanitizeDoc({ theme: { accent: a.key } }).theme.accent, a.key);
    assert.equal(accentColor(a.key), a.color);
  }
});

// 🔴 版式模板（variant）同样是**白名单**：它会选 `layoutCss()` 的分支，
//    放行任意串 = 渲染成不存在的模板（switch 落到 default 或错版式 ⇒ 布局错乱，且不报错）。
test('sanitizeDoc：版式模板**只认白名单**（放行任意串 = 渲染成不存在的模板）', () => {
  for (const bad of ['unknown', 'garbage', 'std;} body{x', '', null, undefined, 123, {}]) {
    assert.equal(sanitizeDoc({ theme: { variant: bad } }).theme.variant, DEFAULT_VARIANT_KEY, String(bad));
  }
  for (const v of RESUME_VARIANTS) {
    assert.equal(sanitizeDoc({ theme: { variant: v.key } }).theme.variant, v.key, v.key);
  }
});

// 🔴 主题色有**两道**防线：`sanitizeDoc` 拦入站、`accentColor` 拦调用方。
//    两道都要有各自的断言 —— 只测前面那条，等于把「第二道被删了也没人知道」写进代码。
test('accentColor：第二道防线 —— 绕过 sanitizeDoc 直接塞任意串，也必须退回默认色', () => {
  const def = RESUME_ACCENTS.find((a) => a.key === DEFAULT_ACCENT_KEY)!.color;
  for (const bad of ['red', '#ff0000', 'blue;} body{display:none', '', null, undefined, 123, {}]) {
    assert.equal(accentColor(bad as any), def, String(bad));
  }
  assert.equal(accentColor('teal'), RESUME_ACCENTS.find((a) => a.key === 'teal')!.color);
});

test('sanitizeDoc：任意主题色都渲染不出注入内容（拼进 CSS 的只有白名单里的十六进制）', () => {
  const html = renderResumeDoc(sanitizeDoc({
    basics: { name: 'x' }, theme: { accent: 'blue;} body{display:none /*' },
  }));
  assert.ok(!/display:\s*none/.test(html), '注入的声明不许出现在产物里');
  assert.ok(/#1d4ed8/.test(html), '非法值必须退回默认色');
});

test('sanitizeDoc：超长一律截断（不截断会把 PDF 排版撑爆）', () => {
  const d = sanitizeDoc({
    title: 'T'.repeat(500),
    basics: { name: 'N'.repeat(500), phone: 'P'.repeat(500), email: 'E'.repeat(500) },
    summary: 'S'.repeat(5000),
    skills: Array.from({ length: 500 }, (_, i) => 'k' + i),
    highlights: Array.from({ length: 99 }, () => 'h'),
    sections: Array.from({ length: 99 }, () => ({ title: 's'.repeat(80), items: ['i'.repeat(900)] })),
  });
  assert.ok(d.title.length <= 60);
  assert.ok(d.basics.name.length <= 30);
  assert.ok(d.summary.length <= 1200);
  assert.ok(d.skills.length <= 60, '技能条数要封顶');
  assert.ok(d.highlights.length <= 12);
  assert.ok(d.sections.length <= 20);
  assert.ok(d.sections[0].items[0].length <= 400);
  assert.ok(d.sections[0].title.length <= 30);
});

test('sanitizeDoc：数组只认真数组（`{0:"a"}` / 字符串 / null 都要被挡掉）', () => {
  for (const bad of [{ 0: 'a', length: 1 }, 'a,b', 'null', 42, null, undefined]) {
    assert.deepEqual(sanitizeDoc({ skills: bad }).skills, [], String(bad));
    assert.deepEqual(sanitizeDoc({ highlights: bad }).highlights, [], String(bad));
  }
  assert.deepEqual(sanitizeDoc({ skills: ['Java', '', '  ', 'Spring'] }).skills, ['Java', 'Spring'], '空项要滤掉');
});

test('sanitizeDoc：base 只作兜底，传入的字段优先（保存时以表单为准）', () => {
  const base = sanitizeDoc({ id: 'a', title: '旧标题', basics: { name: '旧名' }, theme: { accent: 'teal' } });
  const merged = sanitizeDoc({ title: '新标题' }, base);
  assert.equal(merged.title, '新标题');
  assert.equal(merged.basics.name, '旧名', '没传的字段沿用 base');
  assert.equal(merged.theme.accent, 'teal', '没传的主题沿用 base');
});

// ────────────────────────── newDoc ──────────────────────────
test('newDoc：基本信息从档案带出来，默认色 = 既有版式的强调色', () => {
  const d = newDoc('d1', { name: '张三', phone: '138', email: 'a@b.c', expectedCity: '昆明', expectedPositions: 'Java 后端' });
  assert.equal(d.id, 'd1');
  assert.equal(d.basics.name, '张三');
  assert.equal(d.basics.city, '昆明');
  assert.equal(d.basics.headline, 'Java 后端');
  assert.deepEqual(d.sections, []);
  assert.equal(d.theme.accent, DEFAULT_ACCENT_KEY);
  // 🔴 与「一岗一简历」的既有版式保持同一张脸 —— 换条路径不该换颜色
  assert.equal(accentColor(d.theme.accent), '#1d4ed8');
  assert.equal(newDoc('d2', {}).basics.name, '', '档案为空也不能写死占位名');
});

// ────────────────────────── renderResumeDoc ──────────────────────────
const doc = (o: Record<string, unknown> = {}) => sanitizeDoc({
  id: 'd', title: '我的简历',
  basics: { name: '张三', phone: '13800000000', email: 'z@s.com', city: '昆明', headline: 'Java 后端' },
  summary: '一段简介', highlights: ['优势一'], skills: ['Java'],
  sections: [{ title: '项目经历', items: ['电商后台重构'] }],
  ...o,
});

test('renderResumeDoc：产物**自包含** —— 无外链、无脚本（进 PDF 后会静默变样）', () => {
  const html = renderResumeDoc(doc());
  assert.ok(!/<script/i.test(html), '不许有脚本');
  assert.ok(!/https?:\/\//i.test(html.replace(/<html[^>]*>/i, '')), '不许有外链（lang 之外的 http 串都不许出现）');
  assert.ok(!/<link\b/i.test(html), '不许引外部样式');
  assert.ok(html.indexOf('<!DOCTYPE html>') === 0);
  assert.ok(/@page\s*\{[^}]*size:\s*A4/.test(html), '必须是 A4');
});

test('renderResumeDoc：内容全部转义（草稿是用户输入，渲染成 HTML 就是 XSS 面）', () => {
  const html = renderResumeDoc(doc({ basics: { name: '<img src=x onerror=alert(1)>' } }));
  assert.ok(!/<img/i.test(html));
  assert.ok(html.indexOf('&lt;img') >= 0, '尖括号必须转义');
  const h2 = renderResumeDoc(doc({ sections: [{ title: '</style><script>x</script>', items: ['a'] }] }));
  assert.ok(!/<script/i.test(h2), '栏目名里闭合标签也不许漏出去');
});

test('renderResumeDoc：空草稿给出说明而不是空白页（空页会被当成「功能坏了」）', () => {
  const html = renderResumeDoc(doc({
    summary: '', highlights: [], skills: [], sections: [],
    basics: { name: '', phone: '', email: '', city: '', headline: '' },
  }));
  assert.match(html, /还是空的/);
  assert.match(html, /求职者/, '连名字都没有时用中性兜底，不写死某个名字');
});

test('renderResumeDoc：换配色只改颜色、不改内容（结构不受主题影响）', () => {
  const a = renderResumeDoc(doc({ theme: { accent: 'blue' } }));
  const b = renderResumeDoc(doc({ theme: { accent: 'teal' } }));
  assert.notEqual(a, b);
  assert.ok(b.indexOf('#0f766e') >= 0);
  const strip = (s: string) => s.replace(/#[0-9a-f]{6,8}/gi, '#C').replace(/[\s]+/g, ' ');
  assert.equal(strip(a), strip(b), '把颜色统一替换掉之后两份应完全一致 ⇒ 主题只影响颜色');
});

test('renderResumeDoc：换版式只改外观、不改内容（结构不受模板影响）', () => {
  const std = renderResumeDoc(doc({ theme: { variant: 'std' } }));
  const badge = renderResumeDoc(doc({ theme: { variant: 'badge' } }));
  assert.notEqual(std, badge, '两种版式产物不该逐字节相同');
  // 🔴 内容必须两份都在：换皮不能丢内容（前端「换皮」静默丢功能是老事故）。
  for (const needle of ['张三', '我的简历', '项目经历', '电商后台重构']) {
    assert.ok(std.indexOf(needle) >= 0, 'std 缺内容：' + needle);
    assert.ok(badge.indexOf(needle) >= 0, 'badge 缺内容：' + needle);
  }
  // 外观区分点：badge 版式用 .badge 包裹首字，std 没有；这才能证明 variant 端到端生效。
  assert.ok(badge.indexOf('class="badge"') >= 0);
  assert.ok(std.indexOf('class="badge"') < 0);
});
