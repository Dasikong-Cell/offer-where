/**
 * 可靠的注释剥离（供静态断言使用）
 * ==========================================================================
 * 为什么不用 `.replace(/\/\*[\s\S]*?\*\//g,'')`：
 *   那个朴素正则**不区分「注释」与「代码里的字符串」**，遇到下面这种就出错 ——
 *
 *   ```ts
 *   // 第一版只放行 /api/*，结果 GET / 直接 401
 *   app.get("/", (req,res)=>{ ...真实代码... });
 *   ```
 *
 *   注释里的 `/api/*` 含子串 `斜杠+星号`，被当成块注释起点，正则一路匹配到**后面某个**
 *   「星号+斜杠」的收尾符号，把中间的真实代码整段删掉 ⇒ 依赖它的断言**假阴性**
 *   （代码明明是对的却报失败）。
 *
 * ⚠️ 连本文件的这段说明文字都踩过同一个坑：正面写出那两个字符就会**提前结束本注释**，
 *    导致 esbuild 报 `Expected ";" but found ...`。故下文一律用文字描述，不写裸序列。
 *   本仓库 2026-09-30 实测踩到：`server/index.ts` 注释里的一句 `/api/*` 把 60 行后的
 *   `canInjectToken(...)` 调用吃掉了。
 *
 * 本实现是一个小状态机：识别 line / block 注释与 ' " ` 三种字符串字面量，
 * 只删注释、**原样保留字符串内容**，并在块注释处保留换行以维持行号。
 *
 * ⚠️ 已知边界（刻意不处理，够用且不引入更多复杂）：
 *   - **正则字面量**里的引号会被当成字符串起点（如 `/['"]/`）。
 *     本仓库的断言目标代码里没有这种写法；若将来出现，请给这里补上正则字面量状态。
 *   - 模板字符串里的 `${...}` 嵌套代码不单独解析（按整体字符串处理）。
 *     影响：模板里的注释不会被删（宁可多留，不可误删）。
 *
 * ⚠️ URL 例外（必读）：`.html` 里到处是 `https://example.com/x`，
 *   若把 `//` 一律当行注释，会把该行**后面所有真实内容**删掉。
 *   因此沿用原实现的启发式：**`//` 紧跟在 `:` 之后时不算注释**（协议分隔符）。
 *   方向性说明：判错时只会「少删」（保留本应删的注释），不会「多删」真实代码。
 */
export function stripComments(src: string): string {
  const s = String(src ?? '');
  const n = s.length;
  let out = '';
  let i = 0;
  let state: 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl' = 'code';

  while (i < n) {
    const c = s[i];
    const d = s[i + 1];

    if (state === 'code') {
      if (c === '/' && d === '*' ) { state = 'block'; i += 2; continue; }
      // `//` 前一个字符是 `:` ⇒ 视为 URL 的协议分隔符，保留（见文件头「URL 例外」）
      if (c === '/' && d === '/' && out[out.length - 1] !== ':') { state = 'line'; i += 2; continue; }
      if (c === "'") { state = 'sq'; out += c; i++; continue; }
      if (c === '"') { state = 'dq'; out += c; i++; continue; }
      if (c === '`') { state = 'tpl'; out += c; i++; continue; }
      out += c; i++; continue;
    }

    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; }
      i++; continue;
    }

    if (state === 'block') {
      if (c === '*' && d === '/') { state = 'code'; i += 2; continue; }
      if (c === '\n') out += c; // 保留换行，行号不漂
      i++; continue;
    }

    // 字符串字面量内部：原样保留，处理转义
    if (c === '\\') { out += c + (d ?? ''); i += 2; continue; }
    const closes =
      (state === 'sq' && c === "'") ||
      (state === 'dq' && c === '"') ||
      (state === 'tpl' && c === '`');
    if (closes) { state = 'code'; out += c; i++; continue; }
    out += c; i++; continue;
  }

  return out;
}

/**
 * 剥注释后按正则匹配，并返回**命中次数**。
 * 静态断言里请优先用「恰好命中 N 次」而不是「能匹配到」——
 * 「能匹配到」会被残留文本满足，本仓库已多次踩坑。
 */
export function countMatches(src: string, re: RegExp): number {
  const code = stripComments(src);
  const g = re.global ? re : new RegExp(re.source, re.flags + 'g');
  return (code.match(g) || []).length;
}

/** 剥注释后是否命中（只用于「必须存在」这类断言；计数类请用 countMatches） */
export function hasCode(src: string, re: RegExp): boolean {
  return re.test(stripComments(src));
}
