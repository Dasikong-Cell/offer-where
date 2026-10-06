/**
 * 控制台内联脚本的**作用域感知**静态检查（mini no-undef）。跑在 `npm run verify` 里。
 *
 * ── 为什么需要它（真实事故）────────────────────────────────────────────────
 * `public/console.html` 是一份 ~6000 行、215KB 的**单文件内联脚本**：没有打包器、
 * 没有类型检查、`console:check` 只查**语法**。于是「删掉一个局部变量、却还剩一处引用」
 * 这种错**语法完全合法**，只在运行时抛 ReferenceError。更阴的是它抛在 async 函数中间：
 * 函数前半段的赋值已经生效，后半段的十几个渲染调用**全部被跳过** ——
 * 页面点得动、已渲染的数字看着对、四道门禁 + `npm test` + `verify` 全绿，只是「有点空」。
 * 实测事故：`loadDashboard` 里残留 `apps.length`，导致漏斗图 / 即将截止 / AI 状态 /
 * 健康 / 趋势 / 自检 / 版本 / 向导 / 平台卡**整片不渲染**，而所有统计卡都是对的。
 *
 * ── 为什么不是「收集所有声明名再比对」──────────────────────────────────────
 * 第一版就是这么写的（把整份脚本的声明名收进一个集合），实测**抓不到上面那个 bug**：
 * `apps` 在另一个函数里被 `let apps=[]` 声明过，于是「这个名字存在」⇒ 判绿。
 * 必须**按作用域解析**：进函数压一层作用域、沿栈向上找，出函数弹栈。
 *
 * ── 为什么用 acorn 而不是 `vm.Script` ──────────────────────────────────────
 * `check_console_syntax.ts` 用 `vm.Script` 是因为要的是**语法**（V8 直接给）。
 * 本检查要的是 **AST**，`vm` 不提供；仓库里 `acorn` 已随 vite 安装，故显式声明为
 * devDependency（见 package.json）。两者都是**纯进程内**、不 spawn、不落盘 ——
 * 与 check_console_syntax.ts 头部记录的那条教训一致（受限环境里 spawnSync(node) 会 EBUSY）。
 *
 * ── 已知边界（刻意保守）────────────────────────────────────────────────────
 * 1) 只做到**函数粒度**的作用域，`let/const` 的块级作用域按函数级处理（偏宽松）。
 *    宽松只会**漏报**、不会误报；而误报会让人关掉这道门禁，那才是净损失。
 * 2) `with` / `eval` 动态引入的名字无法静态判定，本检查不做特殊处理。
 * 3) 白名单只放**真正由宿主环境提供**的名字（浏览器 / node 全局）。仓库自己的 helper
 *    必须靠声明发现 —— 往白名单里塞自家函数等于把检查关掉一半。
 * 4) 语法解析失败（acorn 与 V8 版本不一致）会**单独报**并计入失败，不与「未声明」混淆：
 *    仪器坏了和代码坏了是两件事，混在一起会让人修错地方。
 *
 * 运行：npm run console:scope
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(__dirname, '..', 'public', 'console.html');

/** 宿主环境提供的全局名（浏览器 + node）。**不要**往这里加仓库自己的函数。 */
const GLOBALS = new Set<string>([
  // 宿主对象
  'window', 'document', 'console', 'navigator', 'location', 'history', 'screen', 'frames', 'self', 'top', 'parent',
  'globalThis', 'undefined', 'NaN', 'Infinity', 'arguments', 'this',
  // 定时 / 调度
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame',
  'queueMicrotask', 'structuredClone', 'atob', 'btoa',
  // 交互 / 布局
  'alert', 'confirm', 'prompt', 'open', 'close', 'print', 'scroll', 'scrollTo', 'scrollBy', 'matchMedia',
  'getComputedStyle', 'getSelection', 'postMessage', 'addEventListener', 'removeEventListener', 'dispatchEvent',
  'innerWidth', 'innerHeight', 'scrollX', 'scrollY', 'pageXOffset', 'pageYOffset', 'devicePixelRatio',
  'visualViewport', 'name', 'status', 'origin', 'closed', 'length',
  // 网络 / 存储
  'fetch', 'Request', 'Response', 'Headers', 'AbortController', 'AbortSignal', 'FormData', 'FileList',
  'XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker', 'Blob', 'File', 'FileReader', 'URL', 'URLSearchParams',
  'localStorage', 'sessionStorage', 'indexedDB', 'caches', 'crypto', 'performance', 'Notification',
  // 二进制 / 集合
  'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array',
  'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
  'WeakRef', 'FinalizationRegistry', 'MessageChannel', 'BroadcastChannel', 'OffscreenCanvas', 'ImageData', 'Path2D',
  'DOMPoint', 'DOMRect', 'DOMMatrix', 'XMLSerializer', 'XPathResult', 'CSSStyleSheet', 'FontFace', 'AudioContext',
  'MediaRecorder', 'MediaStream', 'SpeechRecognition', 'SpeechSynthesis', 'SpeechSynthesisUtterance',
  'ReadableStream', 'WritableStream', 'TransformStream', 'CompressionStream', 'DecompressionStream',
  'IDBKeyRange', 'IDBDatabase', 'IDBTransaction', 'IDBObjectStore', 'IDBRequest', 'ServiceWorker', 'Cache', 'CacheStorage',
  // 语言内建
  'JSON', 'Math', 'Date', 'Number', 'String', 'Boolean', 'Symbol', 'BigInt', 'Array', 'Object', 'Function',
  'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError',
  'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'Intl', 'Iterator',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURI', 'decodeURI', 'encodeURIComponent', 'decodeURIComponent',
  'escape', 'unescape', 'eval', 'TextEncoder', 'TextDecoder', 'DOMParser',
  // DOM 类型与事件
  'Image', 'Audio', 'Option', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'TouchEvent', 'PointerEvent',
  'InputEvent', 'DragEvent', 'ClipboardEvent', 'PopStateEvent', 'HashChangeEvent', 'StorageEvent', 'MessageEvent',
  'ErrorEvent', 'ProgressEvent', 'MutationObserver', 'MutationRecord', 'IntersectionObserver', 'ResizeObserver',
  'Node', 'NodeList', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement',
  'HTMLCanvasElement', 'HTMLAnchorElement', 'DocumentFragment', 'CSS', 'EventTarget', 'Range', 'Selection',
  'ClipboardItem', 'MediaQueryList',
  // node 侧（本文件理论上用不到，但白名单留位免得误报）
  'process', 'require', 'module', 'exports', '__dirname', '__filename',
]);

// ── 抽取内联脚本（与 check_console_syntax.ts 同口径：跳过带 src 的外链与 module 块）──
const html = fs.readFileSync(HTML, 'utf-8');
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
const blocks: { code: string; startLine: number }[] = [];
let mm: RegExpExecArray | null;
while ((mm = re.exec(html)) !== null) {
  const tag = mm[0].slice(0, mm[0].indexOf('>') + 1);
  if (/type\s*=\s*["']?module/i.test(tag)) continue;
  if (!mm[1].trim()) continue;
  blocks.push({ code: mm[1], startLine: html.slice(0, mm.index).split('\n').length });
}

const isFn = (t: string) =>
  t === 'FunctionDeclaration' || t === 'FunctionExpression' || t === 'ArrowFunctionExpression';
const isClass = (t: string) => t === 'ClassDeclaration' || t === 'ClassExpression';
const SKIP_KEYS = new Set(['type', 'start', 'end', 'loc', 'range']);

/** 把绑定模式（Identifier / 解构 / 默认值 / rest）里的名字收进 names，并记下这些节点本身。 */
function addPatternNames(pat: any, names: Set<string>, declNodes: Set<any>): void {
  if (!pat) return;
  switch (pat.type) {
    case 'Identifier': names.add(pat.name); declNodes.add(pat); break;
    case 'ObjectPattern':
      for (const p of pat.properties) {
        if (p.type === 'RestElement') addPatternNames(p.argument, names, declNodes);
        else { if (p.computed) addPatternNames(p.key, names, declNodes); addPatternNames(p.value, names, declNodes); }
      }
      break;
    case 'ArrayPattern': for (const el of pat.elements) addPatternNames(el, names, declNodes); break;
    case 'AssignmentPattern': addPatternNames(pat.left, names, declNodes); break;
    case 'RestElement': addPatternNames(pat.argument, names, declNodes); break;
    default: break; // `a.b = ...` 不声明新名字
  }
}

/**
 * 收集**一层**作用域里声明的全部名字。
 * 🔴 关键：遇到嵌套函数/类就**只取其名字**再停 —— 它的内部声明属于它自己那层。
 *    不做这一步，`apps`（在别的函数里 `let` 过）就会被当成「已声明」，正是第一版漏掉事故的原因。
 */
function scopeNames(root: any, rootIsFn: boolean, declNodes: Set<any>): Set<string> {
  const names = new Set<string>();
  // 🔴 具名函数表达式 `(function f(){ ... f() ... })()` 的名字**只在自己体内可见**
  //    （函数声明才绑定到外层）。漏了这一条会把自调用的 IIFE 误报成未声明。
  if (rootIsFn && root.type === 'FunctionExpression' && root.id) {
    names.add(root.id.name); declNodes.add(root.id);
  }
  const visit = (n: any, isRoot: boolean): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const x of n) visit(x, false); return; }
    if (typeof n.type !== 'string') {
      for (const k of Object.keys(n)) if (!SKIP_KEYS.has(k)) visit(n[k], false);
      return;
    }
    // 嵌套函数 / 类：只收它绑定的名字（函数声明、类声明会绑定到本层），不再往里走
    if (!isRoot && (isFn(n.type) || isClass(n.type))) {
      if ((n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') && n.id) {
        names.add(n.id.name); declNodes.add(n.id);
      }
      return;
    }
    if (isRoot && rootIsFn && n.params) for (const p of n.params) addPatternNames(p, names, declNodes);
    if (n.type === 'VariableDeclarator') addPatternNames(n.id, names, declNodes);
    if ((n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') && n.id) {
      names.add(n.id.name); declNodes.add(n.id);
    }
    if (n.type === 'CatchClause') addPatternNames(n.param, names, declNodes);
    if (n.type === 'ImportDefaultSpecifier' || n.type === 'ImportSpecifier' || n.type === 'ImportNamespaceSpecifier') {
      if (n.local) { names.add(n.local.name); declNodes.add(n.local); }
    }
    for (const k of Object.keys(n)) if (!SKIP_KEYS.has(k)) visit(n[k], false);
  };
  visit(root, true);
  return names;
}

interface Hit { name: string; line: number; fn: string }
const undeclared: Hit[] = [];
const declNodes = new Set<any>();
const scopeStack: Set<string>[] = [];
const resolve = (name: string): boolean => {
  for (let i = scopeStack.length - 1; i >= 0; i--) if (scopeStack[i].has(name)) return true;
  return GLOBALS.has(name);
};

function walk(node: any, parent: any, parentKey: string | null, fn: string): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) walk(n, parent, parentKey, fn); return; }
  if (typeof node.type !== 'string') {
    for (const k of Object.keys(node)) if (!SKIP_KEYS.has(k)) walk(node[k], node, k, fn);
    return;
  }

  const enterFn = isFn(node.type);
  let pushed = false;
  let curFn = fn;
  if (enterFn) {
    curFn = (node.id && node.id.name) || fn || '(anonymous)';
    scopeStack.push(scopeNames(node, true, declNodes));
    pushed = true;
  }

  if (node.type === 'Identifier') {
    const skip =
      declNodes.has(node)
      || (parent && parent.type === 'MemberExpression' && parentKey === 'property' && !parent.computed)
      || (parent && (parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition')
        && parentKey === 'key' && !parent.computed)
      || (parent && (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement')
        && parentKey === 'label')
      || (parent && parent.type === 'MetaProperty')
      || (parent && parent.type === 'ExportSpecifier' && parentKey === 'exported')
      || (parent && parent.type === 'ImportSpecifier' && parentKey === 'imported');
    if (!skip && !resolve(node.name)) {
      undeclared.push({ name: node.name, line: node.loc ? node.loc.start.line : 0, fn: curFn });
    }
  }

  for (const k of Object.keys(node)) if (!SKIP_KEYS.has(k)) walk(node[k], node, k, curFn);
  if (pushed) scopeStack.pop();
}

let parseFailed = 0;
let declaredTotal = 0;
let useSites = 0;
for (const b of blocks) {
  let ast: any;
  try {
    ast = acorn.parse(b.code, { ecmaVersion: 2024, locations: true, allowAwaitOutsideFunction: true });
  } catch (e: any) {
    parseFailed++;
    console.log(`❌ 内联脚本解析失败（起始约 HTML 第 ${b.startLine} 行）：${e?.message}`);
    continue;
  }
  declNodes.clear();
  scopeStack.length = 0;
  // 顶层（Program）作为最外层作用域：函数声明、顶层 let/const/var 都在这里绑定
  const top = scopeNames(ast, false, declNodes);
  declaredTotal += top.size;
  scopeStack.push(top);
  const before = undeclared.length;
  walk(ast, null, null, '(top-level)');
  scopeStack.pop();
  // 行号回填成**真实 HTML 行号**（块内第 1 行 = <script> 所在行的剩余部分）
  for (let i = before; i < undeclared.length; i++) undeclared[i].line += b.startLine - 1;
  useSites += countIdentifiers(ast);
}

/** 粗略统计 Identifier 节点数：只为暴露「扫描量异常」这个仪器故障信号。 */
function countIdentifiers(ast: any): number {
  let n = 0;
  const go = (x: any): void => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { for (const y of x) go(y); return; }
    if (typeof x.type === 'string' && x.type === 'Identifier') n++;
    for (const k of Object.keys(x)) if (!SKIP_KEYS.has(k)) go(x[k]);
  };
  go(ast);
  return n;
}

// ── 区分力自检 ──────────────────────────────────────────────────────────────
// 🔴 自检用例的选择本身就是一道陷阱，这里踩过：
//    第一版只喂了一个「哪儿都没声明」的名字。这种用例对**弱实现**同样通过 ——
//    我最初那版把所有声明名收进一个全局集合、完全不看作用域，它照样抓到那个名字，
//    于是「自检 ✅ + 源码 ✅」双双绿着，却根本抓不到本次真实事故
//    （`apps` 在别的函数里 `let` 过 ⇒ 被当成已声明 ⇒ 漏报）。
//    ⇒ 自检必须包含「**在兄弟函数里声明过、但在本函数里越界使用**」这一条：
//      只有真正按作用域解析的实现才抓得到它。
let selfTestOk = false;
let selfTestDetail = '';
{
  const probeSrc = [
    'function __pNowhere(){ return __probe_missing_name__; }',                 // ② 哪儿都没声明
    'function __pOwner(){ const __probe_sibling_name__ = 1; return __probe_sibling_name__; }', // ③ 合法自用
    'function __pBorrower(){ return __probe_sibling_name__; }',                // ④ 越界借用（关键用例）
    'function __pClean(){ const v = 1; return v + 1; }',                       // ⑤ 干净函数
  ].join('\n');
  const probe = acorn.parse(probeSrc, { ecmaVersion: 2024, locations: true }) as any;
  declNodes.clear();
  scopeStack.length = 0;
  scopeStack.push(scopeNames(probe, false, declNodes));
  const before = undeclared.length;
  walk(probe, null, null, '(top-level)');
  scopeStack.pop();
  const hits = undeclared.slice(before);
  const gotNowhere = hits.some((h) => h.name === '__probe_missing_name__' && h.fn === '__pNowhere');
  const gotSibling = hits.some((h) => h.name === '__probe_sibling_name__' && h.fn === '__pBorrower');
  const ownerSilent = !hits.some((h) => h.fn === '__pOwner');
  const cleanSilent = !hits.some((h) => h.fn === '__pClean');
  selfTestOk = gotNowhere && gotSibling && ownerSilent && cleanSilent;
  selfTestDetail = `无声明名=${gotNowhere ? '抓到' : '漏'} 跨函数越界=${gotSibling ? '抓到' : '漏'} 合法自用=${ownerSilent ? '不误报' : '误报'} 干净函数=${cleanSilent ? '不误报' : '误报'}`;
  undeclared.length = before; // 自检产物不能混进正式清单
}

console.log(`内联脚本 ${blocks.length} 块 · 顶层声明 ${declaredTotal} 个 · Identifier 使用点约 ${useSites} 处 · 全局白名单 ${GLOBALS.size} 个`);
if (!selfTestOk) {
  console.log(`❌ 自检失败（${selfTestDetail}）⇒ 检查器没有区分力，下面所有「✅」都不可信`);
} else {
  console.log(`✅ 自检：${selfTestDetail}（含「跨函数越界使用」这条 —— 弱实现过不了它）`);
}

if (!undeclared.length) {
  console.log('✅ 未发现未声明的标识符');
} else {
  const byName = new Map<string, Hit[]>();
  for (const h of undeclared) {
    if (!byName.has(h.name)) byName.set(h.name, []);
    byName.get(h.name)!.push(h);
  }
  console.log(`❌ 未声明的标识符 ${byName.size} 个（运行时必抛 ReferenceError，且会带走 async 函数后半段）：`);
  for (const [name, list] of [...byName.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const fns = [...new Set(list.map((x) => x.fn))].slice(0, 5).join(', ');
    console.log(`  - ${name}  ×${list.length}  约 HTML 第 ${list.slice(0, 6).map((x) => x.line).join(', ')} 行  位于 ${fns}`);
  }
}

const failed = parseFailed + (selfTestOk ? 0 : 1) + (undeclared.length ? 1 : 0);
console.log(failed
  ? `\n❌ 控制台作用域检查未通过（未声明 ${undeclared.length} 处 / 解析失败 ${parseFailed} 块 / 自检 ${selfTestOk ? '通过' : '失败'}）`
  : '\n✅ 控制台作用域检查通过');
process.exit(failed ? 1 : 0);
