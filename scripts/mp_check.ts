/**
 * 小程序静态自检。
 *
 * 为什么需要它：小程序的错误大多是「配置里写了一个不存在的页面」
 * 「wxml 引用了 js 里没有的方法」「图片路径拼错」这类**静态可查**的问题，
 * 而在开发者工具里表现为白屏或点了没反应，排查成本高。
 * 本脚本把这些检查前移到命令行，作为门禁的一部分（npm run mp:check）。
 *
 * 检查项（全部基于本地文件，不联网、不调开发者工具）：
 *   1. app.json 合法性：pages 全部存在（.js/.wxml/.json 三件套 + .wxss 可选）
 *      且每个 page 必须在 pages 目录下，路径不带扩展名
 *   2. tabBar：每个 pagePath 必须在 pages 里；图标文件必须存在
 *   3. 路由跳转：所有 wx.navigateTo / wx.switchTab / wx.redirectTo / wx.reLaunch
 *      的 url 必须指向已注册页面；且 switchTab 只能指向 tabBar 页面
 *      （指错了微信会静默失败，这是最隐蔽的一类 bug）
 *   4. wxml 里 bindtap/bindinput/bindconfirm/bindlongpress/bindchange 绑定的方法
 *      必须在对应 js 的 Page({...}) 里定义
 *   5. wxml 里 {{}} 引用的顶层变量必须在 data 里声明（只做保守检查，避免误报）
 *   6. wxml 标签配对（复用 check_console_syntax 的思路）
 *   7. project.config.json 合法性 + urlCheck 必须为 false（否则局域网 http 全废）
 *   8. sitemap.json 合法性
 *   9. 图片资源引用存在性
 *  10. js 语法编译（用 vm.Script 编译，不 spawn 子进程 —— 沙箱内 spawnSync 会 EBUSY）
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MP = path.join(ROOT, 'miniprogram');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass++;
  } else {
    fail++;
    failures.push({ name, detail });
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(MP, rel), 'utf8'));
}

function exists(rel) {
  return fs.existsSync(path.join(MP, rel));
}

function readText(rel) {
  return fs.readFileSync(path.join(MP, rel), 'utf8');
}

/** 剥掉注释再匹配，避免断言被自己的注释满足（本仓库反复踩过的坑）。 */
function stripComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

console.log('小程序自检 (miniprogram)');
console.log('');

// ── 1. app.json ─────────────────────────────────────────────────────────────
let appJson;
try {
  appJson = readJson('app.json');
  check('app.json 可解析', true);
} catch (e) {
  check('app.json 可解析', false, String(e.message));
  appJson = null;
}

const pages = (appJson && appJson.pages) || [];
check('app.json 声明了 pages 且非空', pages.length > 0, `pages=${pages.length}`);

for (const p of pages) {
  if (p.startsWith('/')) {
    check(`页面路径不应以 / 开头：${p}`, false, 'app.json 里必须写不带前导斜杠的相对路径');
    continue;
  }
  if (path.extname(p)) {
    check(`页面路径不应带扩展名：${p}`, false, '应写 pages/index/index 而不是 pages/index/index.js');
    continue;
  }
  for (const ext of ['js', 'wxml', 'json']) {
    check(`${p}.${ext} 存在`, exists(`${p}.${ext}`));
  }
}

// ── 2. tabBar ───────────────────────────────────────────────────────────────
const tabList = (appJson && appJson.tabBar && appJson.tabBar.list) || [];
check('tabBar 声明了 list', tabList.length > 0, `list=${tabList.length}`);
check('tabBar 数量在 2..5 之间（微信硬限制）', tabList.length >= 2 && tabList.length <= 5, `当前 ${tabList.length}`);

const tabPaths = new Set();
for (const t of tabList) {
  tabPaths.add(t.pagePath);
  check(`tabBar pagePath 已注册：${t.pagePath}`, pages.includes(t.pagePath));
  for (const k of ['iconPath', 'selectedIconPath']) {
    if (t[k]) check(`tabBar 图标存在：${t[k]}`, exists(t[k]));
  }
  check(`tabBar 项有文字：${t.pagePath}`, !!t.text);
}

// ── 3. 路由跳转 ─────────────────────────────────────────────────────────────
const jsFiles = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full);
    else if (name.endsWith('.js')) jsFiles.push(full);
  }
})(MP);

const ROUTE_APIS = {
  navigateTo: false,
  redirectTo: false,
  reLaunch: false,
  switchTab: true,   // true = 只能指向 tabBar 页
};

for (const file of jsFiles) {
  const rel = path.relative(MP, file).split(path.sep).join('/');
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  for (const api of Object.keys(ROUTE_APIS)) {
    const re = new RegExp(`wx\\.${api}\\s*\\(\\s*\\{[^}]*url\\s*:\\s*['"\`]([^'"\`]+)['"\`]`, 'g');
    let m;
    while ((m = re.exec(src))) {
      const url = m[1];
      const norm = url.replace(/^\//, '').split('?')[0];
      check(`${rel} 的 ${api} 目标已注册：${url}`, pages.includes(norm));
      if (ROUTE_APIS[api]) {
        check(`${rel} 的 switchTab 目标是 tabBar 页：${url}`, tabPaths.has(norm),
          'switchTab 只能跳 tabBar 页面，否则微信静默失败');
      }
    }
  }
}

// ── 4/5/6. wxml ─────────────────────────────────────────────────────────────
const WXML_EVENTS = ['bindtap', 'bindinput', 'bindconfirm', 'bindlongpress', 'bindchange', 'bindsubmit', 'bindscroll'];
const CONTAINERS = ['view', 'scroll-view', 'block', 'text', 'button', 'input', 'svg', 'navigator'];

for (const p of pages) {
  const wxmlRel = `${p}.wxml`;
  const jsRel = `${p}.js`;
  if (!exists(wxmlRel) || !exists(jsRel)) continue;

  const wxml = stripComments(readText(wxmlRel));
  const js = readText(jsRel);

  // 4. 事件绑定的方法必须在 js 里存在
  for (const ev of WXML_EVENTS) {
    const re = new RegExp(`${ev}\\s*=\\s*["']([A-Za-z_$][\\w$]*)["']`, 'g');
    let m;
    while ((m = re.exec(wxml))) {
      const fn = m[1];
      // 方法在 Page({...}) 对象里以 `name(` 或 `name:` 形式出现
      const hasFn = new RegExp(`(^|[\\s,{])${fn}\\s*[:(]`, 'm').test(js);
      check(`${wxmlRel} 事件 ${ev} 的方法 ${fn} 已定义`, hasFn);
    }
  }

  // 5. {{}} 里的**根标识符**必须在 data 里声明。
  //
  // 这里必须精确到「根标识符」，否则全是误报 —— 踩过的坑：
  //   - {{funnel.matchScore.avg}} 里 matchScore/avg 是**属性名**，不是变量
  //   - {{status === 'ready' ? 'badge-ok' : ''}} 里 ready/badge/ok 是**字符串字面量**
  //   - {{item.key ? 'active' : ''}} 里 active 同样是字面量
  // 判定规则：一个标识符是「根」当且仅当它前面不是 `.`（属性访问）
  //   且它不在字符串字面量里。
  const dataBlock = extractDataKeys(js);
  const tplRe = /\{\{([\s\S]*?)\}\}/g;
  let tm;
  const reported = new Set();
  while ((tm = tplRe.exec(wxml))) {
    const expr = tm[1];
    for (const root of collectRootIdentifiers(expr)) {
      if (['true', 'false', 'null', 'undefined'].includes(root)) continue;
      // wx:for 的隐式变量与 wx:for-item / wx:for-index 自定义名
      if (root === 'item' || root === 'index') continue;
      if (reported.has(root)) continue;
      reported.add(root);
      check(`${wxmlRel} 模板变量 ${root} 在 data 中声明`, dataBlock.has(root),
        `出现在 {{${expr.trim()}}}`);
    }
  }

  // 6. 标签配对
  const stack = [];
  const tagRe = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g;
  let tmk;
  while ((tmk = tagRe.exec(wxml))) {
    const [, closing, tag, attrs, selfClose] = tmk;
    if (!CONTAINERS.includes(tag)) continue;
    if (selfClose === '/') continue;
    if (closing === '/') {
      const top = stack.pop();
      if (top !== tag) {
        check(`${wxmlRel} 标签配对 <${tag}>`, false, `期望闭合 <${top || '(无)'}>，实际闭合 <${tag}>`);
        break;
      }
    } else {
      stack.push(tag);
    }
  }
  if (stack.length) {
    check(`${wxmlRel} 标签全部闭合`, false, `未闭合：${stack.join(', ')}`);
  } else {
    check(`${wxmlRel} 标签全部闭合`, true);
  }

  // 9. 图片资源
  const imgRe = /(?:src|iconPath)\s*=\s*["'](\/?[^"'{}]+\.(?:png|jpg|jpeg|gif|svg|webp))["']/g;
  let im;
  while ((im = imgRe.exec(wxml))) {
    const src = im[1].replace(/^\//, '');
    // app.json 里的 iconPath 已单独检查；这里检查 wxml 内的相对路径
    check(`${wxmlRel} 图片存在：${src}`, exists(src));
  }
}

/**
 * 从一个 {{}} 表达式里取出「根标识符」。
 *
 * 做法：先把字符串字面量挖掉（换成等长空格，保持位置无关），
 * 再用正则找标识符，排除紧跟在 `.` 后面的（属性名）和 `wx:`/`bind` 之类。
 *
 * 例：`item.key ? 'active' : ''` → {item}（active 是字面量，key 是属性）
 *     `funnel.matchScore.avg`     → {funnel}
 *     `a > 0 && b.length`         → {a, b}
 */
function collectRootIdentifiers(expr) {
  // 挖掉单引号/双引号字符串（小程序模板里不会有转义换行，简单处理即可）
  const blanked = expr.replace(/'[^']*'/g, (s) => ' '.repeat(s.length))
    .replace(/"[^"]*"/g, (s) => ' '.repeat(s.length));

  const out = new Set();
  const re = /(\.)?\s*([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(blanked))) {
    const isProperty = !!m[1];
    if (isProperty) continue;
    out.add(m[2]);
  }
  return out;
}

/** 从 Page({ data: {...} }) 里抽出 data 的顶层键名（用括号配对，不引 parser）。 */
function extractDataKeys(js) {
  const keys = new Set();
  const src = stripComments(js);
  const idx = src.indexOf('data');
  if (idx < 0) return keys;
  const braceStart = src.indexOf('{', idx);
  if (braceStart < 0) return keys;

  let depth = 0;
  let i = braceStart;
  let end = -1;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) return keys;

  const body = src.slice(braceStart + 1, end);
  // 顶层键：行首（或逗号后）的 identifier，后跟 :
  const re = /(?:^|,)\s*([A-Za-z_$][\w$]*)\s*:/g;
  let m;
  while ((m = re.exec(body))) keys.add(m[1]);
  return keys;
}

// ── 7. project.config.json ──────────────────────────────────────────────────
try {
  const pc = readJson('project.config.json');
  check('project.config.json 可解析', true);
  check('project.config.json 有 appid', !!pc.appid, `appid=${pc.appid}`);
  check('compileType 为 miniprogram', pc.compileType === 'miniprogram', `当前 ${pc.compileType}`);
  check('setting.urlCheck === false（局域网 http 必需）', pc.setting && pc.setting.urlCheck === false,
    '未关域名校验时，小程序无法访问 http://局域网IP 的后端');
} catch (e) {
  check('project.config.json 可解析', false, String(e.message));
}

// ── 8. sitemap.json ─────────────────────────────────────────────────────────
try {
  const sm = readJson('sitemap.json');
  check('sitemap.json 可解析', true);
  check('sitemap.json 有 rules', Array.isArray(sm.rules), '');
} catch (e) {
  check('sitemap.json 可解析', false, String(e.message));
}

// ── 10. js 语法编译（vm.Script，不 spawn）───────────────────────────────────
for (const file of jsFiles) {
  const rel = path.relative(MP, file).split(path.sep).join('/');
  const code = fs.readFileSync(file, 'utf8');
  try {
    // 小程序 js 用的是 CommonJS，module/require/wx/Page/App 都是注入的全局
    new vm.Script(code, { filename: rel });
    check(`${rel} 语法正确`, true);
  } catch (e) {
    check(`${rel} 语法正确`, false, String(e.message));
  }
}

// ── 11. 请求层与后端契约 ────────────────────────────────────────────────────
const reqSrc = exists('utils/request.js') ? readText('utils/request.js') : '';
check('request.js 携带 X-Auth-Token', reqSrc.includes("'X-Auth-Token'"), '');
check('request.js 与后端 SIDE_EFFECT_GET_PATHS 对齐（含 auto-reply/run）',
  reqSrc.includes('/api/auto-reply/run'));
check('request.js 识别 401 并引导到连接页', reqSrc.includes('401') && reqSrc.includes(CONNECT_REL()));
check('config.js 提供 normalizeBaseUrl', readText('utils/config.js').includes('function normalizeBaseUrl'));

function CONNECT_REL() {
  return '/pages/connect/connect';
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log('');
console.log(`小程序自检：通过 ${pass} / 共 ${pass + fail}`);
if (fail) {
  console.log('');
  console.log('失败项：');
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f.name}${f.detail ? ` — ${f.detail}` : ''}`));
  process.exit(1);
}
