/**
 * 「给朋友的使用说明」网页（public/guide/）静态自检。
 *
 * 为什么需要它：这份页面的唯一价值是「一个链接发过去，朋友照着能装能用」。
 * 它坏掉的方式全是**静态可查**的：
 *   - 图片路径拼错 → 手机上看到裂图，发链接的人不会知道
 *   - 关键段落被删掉 → 用户照着做卡住（历史上这份说明已出现过 5 处与实际界面不符的指引）
 *   - 平台数量/能力标签与 console.html 的 PLATFORMS 不一致 → 用户对着「待接入」的平台白折腾
 *   - 引用了 CDN/外链资源 → 朋友网络环境打不开
 * 这些都是「页面看着没错、实际是错的」，必须前移到命令行。
 *
 * 检查项（全部本地文件，不联网）：
 *   1. public/guide/index.html 与配图存在
 *   2. HTML 里引用的每个本地图片都存在（不许裂图）
 *   3. 不引用任何外部 CDN / http(s) 资源（只允许指向 GitHub 的普通链接）
 *   4. 手机端基础要素：viewport、响应式、无固定宽度
 *   5. 关键内容与小节标题齐备（章节序号 + 关键指引语句）
 *   6. 平台数量与能力标签和 console.html 的 PLATFORMS 逐项一致（单一真相源对账）
 *   7. 与 docs/使用说明-给朋友.md 的存在性对齐（两份都存在，避免只改一份）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GUIDE = path.join(ROOT, 'public', 'guide');
const INDEX = path.join(GUIDE, 'index.html');
const CONSOLE = path.join(ROOT, 'public', 'console.html');
const DOC_MD = path.join(ROOT, 'docs', '使用说明-给朋友.md');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) pass++;
  else {
    fail++;
    failures.push({ name, detail });
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

console.log('使用说明网页自检 (public/guide)');
console.log('');

// ── 1. 文件存在 ─────────────────────────────────────────────────────────────
check('public/guide/index.html 存在', fs.existsSync(INDEX));
const html = fs.existsSync(INDEX) ? fs.readFileSync(INDEX, 'utf8') : '';

// ── 2. 图片引用全部存在（防裂图）─────────────────────────────────────────────
const imgRefs = [...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]);
check('页面至少引用 4 张配图（图文并茂）', imgRefs.length >= 4, `实际 ${imgRefs.length} 张`);

const missing = [];
for (const ref of imgRefs) {
  if (/^(https?:)?\/\//.test(ref) || ref.startsWith('data:')) continue; // 外链/内联另行检查
  const abs = path.join(GUIDE, ref);
  if (!fs.existsSync(abs)) missing.push(ref);
}
check('所有本地图片都存在（无裂图）', missing.length === 0, missing.join(', '));

// 图标也要单独确认（hero 用的那张）
check('guide 目录自带 pwa-192.png（页面自包含）', fs.existsSync(path.join(GUIDE, 'pwa-192.png')));

// ── 3. 不依赖外部资源 ───────────────────────────────────────────────────────
// <script src> / <link href> / <img src> 一律不许指向外部域；
// <a href> 允许（那是给用户点的 GitHub 链接，不是加载资源）。
const extLoaders = [];
for (const m of html.matchAll(/<(script|img|link)[^>]*?(?:src|href)="(https?:)?\/\/[^"]+"/g)) {
  extLoaders.push(m[0].slice(0, 90));
}
check('页面不加载任何外部 CDN 资源（离线也能打开）', extLoaders.length === 0, extLoaders.join('\n      '));

// ── 4. 手机端基础要素 ───────────────────────────────────────────────────────
check('含 viewport meta（手机自适应）', /name="viewport"[^>]*width=device-width/.test(html));
check('含响应式断点（@media）', /@media\s*\(/.test(html));
// 禁止在 body/主容器上写死像素宽度（手机上必然横向滚动）。
// 注意：只查 `width:`，`max-width:` 是允许的（那正是响应式的写法）。
const hardWidths = [...html.matchAll(/\.(wrap|hero|dl|body)\s*\{([^}]*)\}/g)]
  .filter((m) => /(^|;)\s*width:\s*\d{3,}px/.test(m[2]))
  .map((m) => '.' + m[1]);
check('主容器没有写死宽度（会撑出横向滚动）', hardWidths.length === 0, hardWidths.join(', '));

// ── 5. 关键内容齐备 ─────────────────────────────────────────────────────────
const mustHave = [
  ['标题', 'OfferWhere 使用说明'],
  ['下载按钮指向 Releases', /releases\/latest/],
  ['第 1 节', '开始之前'],
  ['第 2 节', '安装'],
  ['第 3 节', '第一次启动'],
  ['第 4 节（登录）', '扫码登录'],
  ['第 5 节（简历）', '在线简历'],
  ['第 6 节（投递）', '开始投递'],
  ['开箱自检说明', '开箱自检'],
  ['SmartScreen 处理法', '仍要运行'],
  ['模拟真人节奏提醒', '模拟真人节奏'],
  ['风险提示', '会不会封我的号'],
  ['隐私说明', '我的简历和数据会被别人看到吗'],
  ['卸载说明', '想彻底删掉'],
];
const miss = [];
for (const [label, needle] of mustHave) {
  const ok = needle instanceof RegExp ? needle.test(html) : html.includes(needle);
  if (!ok) miss.push(label);
}
check(`关键内容齐备（${mustHave.length} 项）`, miss.length === 0, `缺少: ${miss.join(', ')}`);

// 「仅预览」必须**按完整文案出现至少 2 处**（勾选框表格 + 强烈建议段落）。
// ⚠️ 只写 includes('仅预览') 会被残留文本满足 —— 本仓库已多次踩「静态断言被文本满足」的坑，
//    所以这里要求完整词组，并钉住出现次数下限。
const PREVIEW = '仅预览（不真正投递）';
const previewCount = html.split(PREVIEW).length - 1;
check(
  `「${PREVIEW}」完整文案出现 ≥2 处（勾选框 + 推荐段落都不能少）`,
  previewCount >= 2,
  `实际 ${previewCount} 处`
);
// 「第一次用请务必勾上它」是核心操作指引，必须原样在
check('含「第一次用请务必勾上它」这句核心指引', html.includes('第一次用请务必勾上它'));

// ── 6. 平台数量/标签与 console.html 对账（单一真相源）───────────────────────
const consoleSrc = fs.readFileSync(CONSOLE, 'utf8');
const tiers = [...consoleSrc.matchAll(/tier:'(full|apply|pending)'/g)].map((m) => m[1]);
const nFull = tiers.filter((t) => t === 'full').length;
const nApply = tiers.filter((t) => t === 'apply').length;
const nPending = tiers.filter((t) => t === 'pending').length;
const total = tiers.length;

check('从 console.html 解析出平台能力标签', total > 0, `full=${nFull} apply=${nApply} pending=${nPending}`);
check('说明页写的平台总数与实际一致', html.includes(`一共登记了 <strong>${total} 个平台</strong>`),
  `实际 ${total}，页面应写「一共登记了 ${total} 个平台」`);
check('说明页写的「全套」数量与实际一致',
  new RegExp(`全套</td><td>${nFull}</td>`).test(html), `实际 ${nFull}`);
check('说明页写的「可投递」数量与实际一致',
  new RegExp(`可投递</td><td>${nApply}</td>`).test(html), `实际 ${nApply}`);
check('说明页写的「待接入」数量与实际一致',
  new RegExp(`待接入</td><td>${nPending}</td>`).test(html), `实际 ${nPending}`);

// 「待接入」不因被排到第一列就丢掉，四套平台名要在页面里出现
const names = ['BOSS直聘', '猎聘', '前程无忧', '智联招聘'];
check('4 个「全套」平台名都在页面里', names.every((n) => html.includes(n)), names.join(', '));

// ── 7. 与 docs 版说明共存 ───────────────────────────────────────────────────
check('docs/使用说明-给朋友.md 仍存在（两版同步）', fs.existsSync(DOC_MD));

// ── 结果 ────────────────────────────────────────────────────────────────────
console.log('');
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail > 0) {
  console.log(`  ✗ 失败 ${fail}`);
  process.exit(1);
}
console.log('  ✓ guide 页面自检通过');
