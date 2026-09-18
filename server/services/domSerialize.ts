/**
 * DOM 结构化提取（技术债 D1，对标职得鸭 `serializeClean`）
 * ─────────────────────────────────────────────────────────────
 * 为什么不用 `innerText`：
 *   innerText 把整块正文压成纯文本，**丢失「这段是岗位职责 / 这段是任职要求 / 这段是福利」的结构**。
 *   喂给 LLM 做匹配判定时，模型只能靠语序猜，容易把「福利」当成「要求」。
 *
 * 做法（与职得鸭一致）：递归序列化 DOM 为**保留标签与关键 class 的字符串**，
 *   并剥掉 svg / script / style / 图标类噪声节点。
 *   例：`<div class="job-sec-text">岗位职责：负责后端开发…</div>`
 *
 * 实测效果：BOSS 详情页 383 字 → 结构化后约 420 字，AI 可分辨 sec 段落归属。
 */

/** 注入页面的递归序列化函数源码（供 Runtime.evaluate 拼接使用）。 */
export const SERIALIZE_DOM_SRC = String.raw`
function __cleanClass(raw) {
  if (!raw || typeof raw !== 'string') return '';
  var out = [];
  var parts = raw.trim().split(/\s+/);
  for (var i = 0; i < parts.length && out.length < 3; i++) {
    var c = parts[i];
    if (!c) continue;
    // 过滤纯哈希/随机后缀类名（CSS Modules、styled-components 等噪声）
    if (/^[a-z]?[_-]?[A-Za-z0-9]{6,}$/.test(c) && /[0-9]/.test(c) && !/[-_]/.test(c)) continue;
    if (/^(css|sc|emotion)-/.test(c)) continue;
    out.push(c);
  }
  return out.join(' ');
}
function __serializeClean(node, depth) {
  if (depth > 14) return '';
  if (node.nodeType === 3) return node.textContent || '';
  if (node.nodeType !== 1) return '';
  var tag = (node.tagName || '').toLowerCase();
  if (tag === 'svg' || tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'iframe') return '';
  var kids = node.childNodes || [];
  var inner = '';
  for (var i = 0; i < kids.length; i++) inner += __serializeClean(kids[i], depth + 1);
  if (!inner.trim()) return '';
  var cls = __cleanClass(node.className && typeof node.className === 'string' ? node.className : '');
  var head = '<' + tag + (cls ? ' class="' + cls + '"' : '') + '>';
  return head + inner + '</' + tag + '>';
}
/** 折叠连续空白但保留换行（换行本身就是段落边界，不要压掉） */
function __tidyDoc(s) {
  return String(s || '').replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
`;

export interface SerializeEvalOptions {
  /** CSS 选择器（取第一个命中元素）；不传则序列化 document.body */
  selector?: string;
  /** 多个候选选择器，按顺序取第一个命中的（应对平台改版） */
  selectors?: string[];
  /** 截断上限（字符），默认 8000 */
  maxLen?: number;
}

/**
 * 生成可直接交给 CDP `eval` 的脚本：取目标元素 → 结构化序列化 → 截断。
 * 返回 `{ found: boolean, html: string }`。
 */
export function buildSerializeEval(opts: SerializeEvalOptions = {}): string {
  const maxLen = opts.maxLen ?? 8000;
  const sels = opts.selectors && opts.selectors.length ? opts.selectors : (opts.selector ? [opts.selector] : []);
  return `(function(){
    ${SERIALIZE_DOM_SRC}
    var sels = ${JSON.stringify(sels)};
    var el = null;
    for (var i = 0; i < sels.length; i++) {
      try { el = document.querySelector(sels[i]); } catch (e) { el = null; }
      if (el) break;
    }
    if (!el && sels.length) return JSON.stringify({ found: false, html: '' });
    if (!el) el = document.body;
    var out = __tidyDoc(__serializeClean(el, 0));
    return JSON.stringify({ found: true, html: out.slice(0, ${maxLen}) });
  })()`;
}

/** 生成「纯文本但保结构」的轻量版本：保留换行，去掉标签（用于超长 JD 的降级） */
export function buildStructuredTextEval(opts: SerializeEvalOptions = {}): string {
  const maxLen = opts.maxLen ?? 8000;
  const sels = opts.selectors && opts.selectors.length ? opts.selectors : (opts.selector ? [opts.selector] : []);
  return `(function(){
    var sels = ${JSON.stringify(sels)};
    var el = null;
    for (var i = 0; i < sels.length; i++) {
      try { el = document.querySelector(sels[i]); } catch (e) { el = null; }
      if (el) break;
    }
    if (!el) return JSON.stringify({ found: false, html: '' });
    var t = String(el.innerText || '');
    t = t.replace(/[ \\t\\u00a0]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim();
    return JSON.stringify({ found: true, html: t.slice(0, ${maxLen}) });
  })()`;
}

/**
 * 从序列化结果里解析出 `{ found, html }`；容错（CDP 可能返回字符串化的 JSON）。
 */
export function parseSerializeResult(raw: unknown): { found: boolean; html: string } {
  if (typeof raw === 'string') {
    try {
      const v = JSON.parse(raw);
      return { found: !!v.found, html: String(v.html || '') };
    } catch {
      return { found: false, html: '' };
    }
  }
  const anyRaw = raw as any;
  if (anyRaw && typeof anyRaw === 'object') {
    return { found: !!anyRaw.found, html: String(anyRaw.html || '') };
  }
  return { found: false, html: '' };
}

const BLOCK_TAGS = 'p|div|li|ul|ol|h1|h2|h3|h4|h5|h6|tr|td|section|article|br|hr';

/** 小标题判定阈值：一行不超过这么多字、且不以句读结尾 → 当小标题 */
const HEADING_MAX_LEN = 18;

/**
 * 序列化 HTML → **结构化纯文本**（保留段落边界，小标题加 `##` 前缀）。
 *
 * 为什么存纯文本而不是直接存 HTML：
 *   · `jobs.jd` 既要喂 LLM，也要在控制台展示、还要参与本地关键词匹配；
 *     直接存 HTML 标签会把展示和本地匹配都弄脏。
 *   · 本函数把 `<div class="job-sec-text">岗位职责<p>负责后端开发…</p></div>`
 *     变成 `## 岗位职责\n负责后端开发…` —— **结构信息保留了，噪声去掉了**。
 */
export function serializeToStructuredText(serializedHtml: string): string {
  let s = String(serializedHtml || '');
  // 块级标签 → 换行（先做，避免 <div>a</div><div>b</div> 粘成一行）
  s = s.replace(new RegExp(`</(?:${BLOCK_TAGS})>`, 'gi'), '\n');
  s = s.replace(new RegExp(`<(?:${BLOCK_TAGS})[^>]*>`, 'gi'), '\n');
  // 其余标签直接剥掉（内联标签不产生换行）
  s = s.replace(/<[^>]+>/g, '');
  // HTML 实体还原（顺序重要：&amp; 最后）
  s = s.replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/g, "'").replace(/&amp;/gi, '&');

  const lines = s
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((l) => l.length > 0);

  const out: string[] = [];
  for (const line of lines) {
    const isHeading =
      line.length <= HEADING_MAX_LEN &&
      !/[。；，！？：:.,;!?]$/.test(line) &&
      // 纯数字/符号行不当标题（如"1 / 5"）
      /[\u4e00-\u9fa5A-Za-z]/.test(line);
    const text = isHeading ? `## ${line}` : line;
    // 与上一行重复的标题不重复输出（平台常见双层嵌套）
    if (out.length && out[out.length - 1] === text) continue;
    out.push(text);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
