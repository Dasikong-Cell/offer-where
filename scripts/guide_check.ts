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
 *   8. 事实性陈述不得比事实知道得更多（三处会出网的内容 + 磁盘保留天数与源码对账）
 *   9. 装到朋友机器后这一页仍可达：public/ 随包分发、后端静态挂载 /guide/、控制台侧栏有入口
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './lib/stripComments.js';
// 直接调用服务端真正在用的判据，而不是在这里再抄一份放行规则 ——
// 抄一份的典型后果是「静态检查说放行了、运行时其实没放行」，两份一起绿。
import { isGuideAsset } from '../server/services/authToken.js';

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

// ── 8. 面向朋友的「事实性陈述」不得比事实知道得更多（2026-09-30 补）──────────
// 背景：这份说明书的每一句都是在替产品做承诺，而它是朋友**唯一**的依据。
// 原先隐私条目只写了「不经过任何服务器」—— 而事实上确有三处内容会离开本机：
//   ① 投出去的简历/打招呼内容（当然要发给招聘网站，否则投不了）
//   ② 用户**主动点击**时的更新检查
//   ③ 用户**自己配置**了大模型网关后才启用的 AI 匹配/文案
// 少写这三条 ⇒ 朋友对「数据在不在自己手里」形成错误预期。而这一条恰恰是本项目
// 已经确立的分发模型（各自本地安装、各用各的数据）赖以成立的前提。
//
// 同族缺陷本项目已犯过一次：控制台提示「请执行 npx playwright install chromium」，
// 而包内 node/ 只有 node.exe、根本没有 npx ⇒ 给的指引在受众机器上跑不了。
// 所以下面同时钉住「不许依赖包里没有的工具」。
{
  const PRIVACY = [
    ['投出去的内容会发给招聘网站', '招聘网站本身'],
    ['更新检查只在你点击时发生', '只在你点它的时候'],
    ['AI 要自己配网关才启用（默认没有这一步）', '大模型网关'],
  ];
  const mdSrc = fs.readFileSync(DOC_MD, 'utf8');
  for (const [label, needle] of PRIVACY) {
    check(`隐私说明写清了「${label}」`, html.includes(needle), `网页缺少「${needle}」`);
    check(`md 版隐私说明同一处也写清了（两版不许只改一份）`, mdSrc.includes(needle),
      `md 缺少「${needle}」`);
  }

  // 清理天数必须与代码默认值一致 —— 写死一份必然漂移，所以从源码读真值再对账
  const dcSrc = fs.readFileSync(path.join(ROOT, 'server', 'services', 'dataCleanup.ts'), 'utf8');
  const shotDays = /screenshotDays\s*\?\?\s*(\d+)/.exec(dcSrc)?.[1];
  const logDays = /runLogDays\s*\?\?\s*(\d+)/.exec(dcSrc)?.[1];
  check('从 dataCleanup.ts 解析出清理保留天数', !!shotDays && !!logDays,
    `截图=${shotDays} 天，日志=${logDays} 天`);
  check('说明页写的截图保留天数与代码一致',
    html.includes(`留 <strong>${shotDays} 天</strong>`) && mdSrc.includes(`留 **${shotDays} 天**`),
    `代码=${shotDays} 天`);
  check('说明页写的运行日志保留天数与代码一致',
    html.includes(`留 <strong>${logDays} 天</strong>`) && mdSrc.includes(`留 **${logDays} 天**`),
    `代码=${logDays} 天`);
  // 「data/browser 不要手动删」是这条里唯一会造成实际损失的一句（删了要全部重新扫码）
  check('说明了 data\\browser 是登录态、不要手动删',
    /data\\browser/.test(html) || html.includes('data\\browser'), '缺这条 ⇒ 有人会把它当缓存删掉');

  // 🔴 受众指引不得依赖包里没有的工具。包内 node/ 只有 node.exe（无 npm/npx），
  //    任何写成 `npm run xxx` 的指引在朋友机器上都跑不了 —— 而它看起来完全合理。
  check('受众指引不依赖 npm/npx（包内只有 node.exe）',
    !/\bnpm\b|\bnpx\b/.test(html) && !/\bnpm\b|\bnpx\b/.test(mdSrc),
    '包内无 npm ⇒ 这类指引在朋友机器上跑不了（本项目已犯过一次同类缺陷）');
}

// ── 9. 分发到朋友机器之后，这一页还打不打得开（2026-09-30 补）────────────────
// 分发模型是「朋友各装一份、各用各的数据」：朋友手上除了安装包什么都没有。
// 所以在上面「这一页本身写得对不对」之外，还得钉住三件事：
//   ① 这一页真的随包发出去（pack.ps1 把 public 整目录收进 $dirs，并被 $must 钉住）
//   ② 装好之后在软件里点得到（后端把 public/ 当静态目录 ⇒ GET /guide/ 命中它）
//   ③ 说明书自己也告诉了读者「以后在哪儿看」——否则他只有返回聊天记录找链接这一条路
// 这一节只判 ②③（产品内可达性）；① 的打包侧断言在 scripts/contract_tests.ts，
// 两侧各自独立读源码，避免「改一处同时移动指针和靶子」。
{
  // ② 后端确实把 public/ 作为静态目录挂载。
  // ⚠️ 必须剥注释：server/index.ts 的注释里成段讨论过这个目录与 /guide/ 的关系，
  //    不剥的话断言会被自己的说明文字满足（本仓库的经典假阴性）。
  const srv = stripComments(fs.readFileSync(path.join(ROOT, 'server', 'index.ts'), 'utf8'));
  const consoleDirOk = /CONSOLE_DIR\s*=\s*path\.join\([^)]*'public'\s*\)/.test(srv);
  check('后端把 public/ 定为静态目录（CONSOLE_DIR）', consoleDirOk,
    '找不到 CONSOLE_DIR = path.join(..., \'public\') ⇒ /guide/ 无从命中');
  // 必须写成**不带 options** 的裸调用：serve-static 的默认 index 才会把
  // `GET /guide/`（目录请求）解析到 index.html。加个 { index:false } 就只剩
  // `/guide/index.html` 能开，而侧栏链接写的正是 `/guide/` —— 会 404。
  // ⚠️ 实际写法是 `app.use(express.static(CONSOLE_DIR));` —— 右括号有两个，
  //    第一版要求 `CONSOLE_DIR)` 紧跟 `;`，于是**断言自己**红了（不是代码错）。
  check('express.static(CONSOLE_DIR) 是裸调用（目录请求才会落到 index.html）',
    /express\.static\(CONSOLE_DIR\)\s*\)*\s*;/.test(srv),
    '带 options 时若关掉 index，侧栏那个 /guide/ 会 404 —— 静态断言看不出，只有真请求才知道');

  // ②b 鉴权打开时这一页还得能匿名打开 —— 否则侧栏入口在 LAN 模式下直接 401。
  //     这里**调用服务端真正在用的那个函数**，而不是再抄一份规则：
  //     抄一份的后果是「测试说放行了、运行时没放行」，两者一起绿。
  //     实际判据与理由见 server/services/authToken.ts 的 isGuideAsset。
  check('鉴权开启时 /guide/ 匿名放行（目录请求）', isGuideAsset('GET', '/guide/'));
  check('鉴权开启时 /guide/index.html 匿名放行', isGuideAsset('GET', '/guide/index.html'));
  check('鉴权开启时说明页配图匿名放行（裂图是静默的，没人会来报）',
    isGuideAsset('GET', '/guide/img/d-home.png'));
  check('只读放行不外溢到写方法', !isGuideAsset('POST', '/guide/') && !isGuideAsset('DELETE', '/guide/'));
  check('说明页子树里的数据文件仍然发不出去（按扩展名挡住）',
    !isGuideAsset('GET', '/guide/data.csv') && !isGuideAsset('GET', '/guide/../.env'),
    '前缀判断挡不住路径穿越 —— 真正的边界是扩展名白名单');
  check('放行面没有扩大到 public/ 的其它文件',
    !isGuideAsset('GET', '/console.html') && !isGuideAsset('GET', '/app.ico'),
    '那些由 CONSOLE_ASSETS 精确匹配负责，不是这一条');
  // 规则定得再对，中间件没调用也等于没有 —— 这是「单一真相源」缺的那一半。
  // ⚠️ 精确到**调用参数**，不匹配函数名：本文件的注释里就会写到这个名字。
  check('后端鉴权中间件确实调用了 isGuideAsset',
    /isGuideAsset\(m,\s*String\(req\.path \|\| ''\)\)/.test(srv),
    'authToken 里定义得再对，index.ts 不调用也等于没放行');

  // ③ 页面与 md 都告诉读者「装好后在哪儿打开这一页」。
  // 用完整词组而不是「说明」这类泛词，否则随便一处残留文本就满足了。
  const NAV_HINT = '左侧栏最下面';
  const mdSrc2 = fs.readFileSync(DOC_MD, 'utf8');
  check('网页写明了装好后从哪儿打开这一页', html.includes(NAV_HINT), `缺少「${NAV_HINT}」`);
  check('md 版同一处也写了（两版不许只改一份）', mdSrc2.includes(NAV_HINT));
  // 便携 zip 用户没有侧栏可点 —— 他们的路径是解压目录里的文件，指错了等于没指。
  // 两版都要有：只改一份正是这一节要防的事。
  check('网页写明了 zip 用户看哪份文件',
    html.includes('public\\guide\\index.html'), '缺少解压目录下的实际路径');
  check('md 版也写明了 zip 用户的文件路径',
    mdSrc2.includes('public\\guide\\index.html'), '两版不许只改一份');

  // ② 的入口本身：控制台侧栏要有链接，且**必须不在 #nav 里**。
  // 理由不是审美：#nav 里每个 <a> 都被 `$$('#nav a')` 统一绑到 navigate(a.dataset.view)，
  // 一个没有 data-view 的锚点会被当成「切到 undefined 视图」—— 点了不跳转，还可能把
  // 当前视图清掉。这条在页面上看起来完全正常，静态断言之外只有真点一次才发现。
  const con = fs.readFileSync(CONSOLE, 'utf8');
  const asideBlock = /<aside class="side"[\s\S]*?<\/aside>/.exec(con)?.[0] ?? '';
  const navBlock = /<nav\b[\s\S]*?<\/nav>/.exec(con)?.[0] ?? '';
  const GUIDE_LINK = /<a[^>]+href="\/guide\/"/;
  check('控制台侧栏能解析出 <aside> 与 <nav>（解析失败会让本节静默空转）',
    asideBlock.length > 0 && navBlock.length > 0,
    `aside=${asideBlock.length} 字符，nav=${navBlock.length} 字符`);
  const afterNav = asideBlock.slice(asideBlock.indexOf('</nav>'));
  check('控制台侧栏底部有「使用说明」入口（指向 /guide/）', GUIDE_LINK.test(afterNav),
    '朋友装完只有一个入口能找到说明书，少了它就只能回去翻聊天记录');
  check('该入口不在 #nav 列表里（放进去会被 navigate(undefined) 吃掉）',
    !GUIDE_LINK.test(navBlock),
    '#nav 的 <a> 统一绑到 navigate(a.dataset.view) ⇒ 没有 data-view 的链接点了不跳转');
  // 上面那条排除的理由本身也得成立，否则它变成一条没有依据的禁令。
  check('#nav 的点击绑定仍是 navigate(a.dataset.view)（上述排除的依据）',
    /\$\$\('#nav a'\)\.forEach\(a=>a\.addEventListener\('click',\s*\(\)=>navigate\(a\.dataset\.view\)\)\)/.test(con),
    '若绑定改成只挑 [data-view]，那条「不许放进 nav」就该重新评估而不是继续挂着');
}

// ── 结果 ────────────────────────────────────────────────────────────────────
console.log('');
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail > 0) {
  console.log(`  ✗ 失败 ${fail}`);
  process.exit(1);
}
console.log('  ✓ guide 页面自检通过');
