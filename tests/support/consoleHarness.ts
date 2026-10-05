/**
 * `public/console.html` 的**行为级单测**基础设施：抠顶层函数 + 极简 DOM 桩 + 沙箱装载。
 *
 * 为什么需要行为级单测（而不是静态串匹配）：
 *   本项目反复栽在「**控件在，功能不生效**」这一类缺陷上 —— 页面看起来完全正常、点下去也不报错，
 *   只是永远筛不出东西。这类缺陷的源码**修前修后都"存在"**（`if(dl==='open' && ...)` 两版都能被
 *   `includes` 命中），静态断言天然抓不住。所以把页面里的顶层函数抠出来，在 `vm` 沙箱里真跑一遍。
 *
 * 为什么能抠：这些函数都是顶层声明，收尾的 `}` 一定**顶格**（函数体内部一律缩进）
 *   ⇒ 从 `function name(` 切到第一个 `\n}` 就是完整定义。抠不到会**断言失败**（不是默默返回空串），
 *   所以函数被改名 / 挪动 / 缩进变体时测试会红，不会恒绿。
 *
 * ⚠️ 三个必须知道的陷阱（都踩过）：
 *
 * 1) **`let` 声明不是 globalThis 的属性**。`vm.runInContext('let X = 1', ctx)` 之后，
 *    宿主写 `ctx.X = 2` 只会造一个**被词法绑定遮蔽**的属性 —— 页面代码读到的仍是词法里的 `1`，
 *    而宿主的断言读到 `2`：**两边各说各话，测试静默变成"什么都没测"**。
 *    所以状态一律通过 `setState()`（在沙箱里赋值）写入、用 `evalIn()`（在沙箱里求值）读取。
 *
 * 2) **跨 realm 的数组不能直接 deepEqual**。`assert.deepEqual` 是 `deepStrictEqual`，
 *    会比较原型 —— 沙箱里的 `Array` 与宿主的 `Array` 不是同一个构造函数，直接比必然失败
 *    （看起来像"逻辑错了"，其实是仪器问题）。一律用 `[...arr]` 摊成宿主数组再比。
 *
 * 3) **跨 realm 的 `Date`** 同理：注入的"现在"必须是**沙箱内**构造的 `Date`，
 *    否则 `instanceof` / `getFullYear` 一类判断跨 realm 失败、注入被静默忽略。
 *    用 `sandboxDate()` 造。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const HTML = fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf-8');

/** 按名字抠出一个顶层函数的源码。抠不到 ⇒ 直接失败（**不返回空串**）。 */
export function extractFn(name: string, html: string = HTML): string {
  const at = html.indexOf('function ' + name + '(');
  assert.ok(at >= 0, `console.html 里找不到顶层函数 ${name}()`);
  const end = html.indexOf('\n}', at);
  assert.ok(end > at, `${name}() 找不到顶格收尾的 }`);
  const src = html.slice(at, end + 2);
  assert.ok(src.includes('function ' + name + '('), `${name} 抠出的源码不对`);
  assert.ok(src.length > 60, `${name} 抠出的源码过短（${src.length}）—— 抠取逻辑可能已失效`);
  return src;
}

/** 抠出 `const NAME = [ ... \n];` 这样的一整块（`APPS_QUICK` / `PLATFORMS` 都是这种形状）。 */
export function extractConstArray(name: string, html: string = HTML): string {
  const at = html.indexOf('const ' + name + ' = [');
  assert.ok(at >= 0, `console.html 里找不到 const ${name} = [...]`);
  const end = html.indexOf('\n];', at);
  assert.ok(end > at, `${name} 找不到顶格收尾的 ];`);
  return html.slice(at, end + 3);
}

/** 抠出**一整行** `const NAME = ...;`（单行常量：`pfName` / `SOURCE_LABEL` / `JOBS_FILTER_SELECTS`）。 */
export function extractConstLine(name: string, html: string = HTML): string {
  const re = new RegExp('^const ' + name + ' = .*$', 'm');
  const m = re.exec(html);
  assert.ok(m, `console.html 里找不到行 \`const ${name} = ...\``);
  return m![0];
}

/**
 * 抠出「校招信息库」那一组**可变状态**的真实声明（`JOBS_CACHE` … `JOBS_FILTER_SELECTS` + `JOBS_FILTER_OFF`）。
 *
 * 刻意从页面里抠而不是在测试里重写一份：状态的名字与**类型**（`Set` 还是数组）一旦在页面里改了，
 * 测试重写的桩会继续按旧类型跑 —— 于是测试全绿而页面已经不对。抠不到就断言失败。
 */
export function extractJobsState(html: string = HTML): string {
  const at = html.indexOf('let JOBS_CACHE = [];');
  assert.ok(at >= 0, 'console.html 里找不到 `let JOBS_CACHE = [];`');
  const selAt = html.indexOf('const JOBS_FILTER_SELECTS = [', at);
  assert.ok(selAt > at, 'console.html 里找不到 `const JOBS_FILTER_SELECTS = [`');
  const selEnd = html.indexOf('\n', selAt);
  const offLine = 'let JOBS_FILTER_OFF = [];';
  const offAt = html.indexOf(offLine, selEnd);
  assert.ok(offAt > 0, `console.html 里找不到 \`${offLine}\``);
  return html.slice(at, selEnd + 1) + offLine;
}

/** 极简元素桩。`innerHTML` / `textContent` / `style.display` / `classList` / `dataset` 都在。 */
export interface StubEl {
  disabled: boolean;
  title: string;
  textContent: string;
  innerHTML: string;
  value: string;
  style: { display: string };
  dataset: Record<string, string>;
  classList: { toggle(cls: string, on?: boolean): void; contains(cls: string): boolean };
  /** 累计「赋 value 被静默归空」的次数 —— 只对 `<select>` 桩有意义（见 makeSelect） */
  silentResets: number;
  removeAttribute(k: string): void;
  addEventListener(): void;
  /** 模拟「用户当时在**存在的**选项里选中了它」—— 绕过选项校验（当时该选项确实在） */
  forceValue(v: string): void;
}

/** 普通元素桩（`input` / `div` / `span` / `tbody`）：`value` 就是个普通可写属性。 */
export function makeEl(): StubEl {
  const el: any = {
    disabled: false, title: '', textContent: '', value: '', style: { display: '' }, dataset: {},
    innerHTML: '', _cls: new Set<string>(), silentResets: 0,
  };
  el.forceValue = (v: string) => { el.value = String(v); };
  el.removeAttribute = (k: string) => { el[k] = ''; };
  el.addEventListener = () => { /* 单测里不模拟事件；真点击由 E2E 覆盖 */ };
  el.classList = {
    toggle(cls: string, on?: boolean) {
      if (on === undefined) { el._cls.has(cls) ? el._cls.delete(cls) : el._cls.add(cls); }
      else if (on) { el._cls.add(cls); } else { el._cls.delete(cls); }
    },
    contains: (c: string) => el._cls.has(c),
  };
  return el as StubEl;
}

/**
 * `<select>` 桩 —— **带浏览器语义的 `value`**。
 *
 * 🔴 `value` 必须**真的校验选项集**：给 `<select>` 赋一个不存在的 value 时，浏览器会把
 *    `selectedIndex` 归 -1、`value` 变 `''` —— 这正是 `setJobsOptions()` 要侦测的那个
 *    「筛选条件静默消失」。若桩写成朴素可写属性（永远赋值成功），那条侦测逻辑就**永远不会触发**，
 *    测试会"全绿地"漏掉整个缺陷。`silentResets` 计数器让「确实被归空过」可断言。
 *
 * ⚠️ `esc()` 会把 `"` 转成 `&quot;`，所以选项 value 里永不含裸引号，正则可放心用。
 */
export function makeSelect(html = ''): StubEl {
  const el = makeEl();
  const st: any = el;
  let opts = new Set<string>();
  const parse = (h: string) => [...h.matchAll(/value="([^"]*)"/g)].map((m) => m[1]);
  let cur = '';
  Object.defineProperty(st, 'innerHTML', {
    get() { return st._html; },
    set(h: string) {
      st._html = String(h);
      opts = new Set(parse(st._html));
      cur = opts.size ? parse(st._html)[0] : '';   // 浏览器：innerHTML 换掉后回到第一项
    },
  });
  Object.defineProperty(st, 'value', {
    get() { return cur; },
    set(v: unknown) {
      const w = (v == null) ? '' : String(v);
      if (w === '' || opts.has(w)) { cur = w; }
      else { cur = ''; st.silentResets++; }
    },
  });
  st.forceValue = (v: string) => { cur = String(v); };
  st.innerHTML = html;                             // 初始化 _html / opts / cur（空串也要走一遍）
  return el;
}

/** 在沙箱里求值（读取沙箱内的词法绑定，见文件头陷阱 1）。 */
export function evalIn<T = any>(ctx: object, code: string): T {
  return vm.runInContext(code, ctx) as T;
}

/** 往沙箱里写状态（写的是**沙箱内**的词法绑定，不是宿主属性）。 */
export function setState(ctx: object, name: string, value: unknown): void {
  vm.runInContext(`${name} = ${JSON.stringify(value)};`, ctx);
}

/** 取沙箱里的顶层函数，供宿主带参调用（返回值若是数组，记得 `[...]` 摊平，见陷阱 2）。 */
export function fnOf(ctx: object, name: string): (...args: any[]) => any {
  const f = vm.runInContext(name, ctx);
  assert.equal(typeof f, 'function', `沙箱里没有函数 ${name}()`);
  return f as (...args: any[]) => any;
}

/** 在**沙箱内**构造 `Date`（见文件头陷阱 3）。 */
export function sandboxDate(ctx: object, y: number, m: number, d: number): any {
  return vm.runInContext(`new Date(${y}, ${m - 1}, ${d})`, ctx);
}
