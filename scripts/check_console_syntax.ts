/**
 * 校验 public/console.html 内联脚本的语法。
 *
 * 为什么需要：生产控制台是一份 ~3000 行的单文件 HTML，内联 JS 里大量使用**嵌套模板字面量**
 * （`renderEmailHits` 这类渲染函数），手改极易漏掉一个反引号或 `${}` 括号，
 * 而浏览器只在运行时才报错、且报错位置偏移大、极难定位。
 * 本脚本在提交前静态拦下这类错误。
 *
 * ── 为什么用 `vm.Script` 而不是 `node --check`（2026-09-25 改）───────────────
 * 原实现把每个内联块写成临时 `.mjs`，再 `execFileSync(node --check <file>)`。问题：
 *   1) 需要**再起一个 node 子进程**。在受限环境里这会在进程创建处直接失败
 *      （实测沙箱内 spawnSync(node) 一律 EBUSY）→ 门禁**假失败**，把「环境不允许」
 *      误报成「内联脚本语法错误」，于是本机 `npm run verify` 不可用、pre-push 钩子失效；
 *   2) 写临时文件本身是多余的 I/O，还会在异常退出时留垃圾；
 *   3) `--check` 的报错行号是**抽出的片段内**行号，得靠人再换算。
 * `vm.Script` 是同一个 V8 解析器、**纯进程内**：不 spawn、不落盘、结果等价，
 * 还能拿到片段内行号并**直接回填成 HTML 的真实行号**。
 * 唯一差异：`vm.Script` 按**经典脚本**解析（`node --check *.mjs` 按 ES 模块解析）。
 * 内联 `<script>` 本来就是经典脚本，二者等价；若将来引入 `type="module"` 的内联块，
 * 下方会显式提示其未被解析，而不是默默放行。
 *
 * 运行：./node/node.exe node_modules/tsx/dist/cli.mjs scripts/check_console_syntax.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(__dirname, '..', 'public', 'console.html');

const html = fs.readFileSync(HTML, 'utf-8');
// 只取内联脚本（跳过带 src 的外链）
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;

let m: RegExpExecArray | null;
let i = 0;
let bad = 0;
let skipped = 0;

while ((m = re.exec(html)) !== null) {
  i++;
  const code = m[1];
  if (!code.trim()) continue;

  // 片段第 1 行 = 开标签所在行的剩余部分 → 回填公式见下方 htmlLine
  const tagLine = html.slice(0, m.index).split('\n').length;
  const tag = m[0].slice(0, m[0].indexOf('>') + 1);
  if (/type\s*=\s*["']?module/i.test(tag)) {
    skipped++;
    console.log(`script #${i}: SKIPPED (type="module"：本检查器只解析经典脚本，请另加校验)`);
    continue;
  }

  try {
    // 只编译不执行：语法错误在此抛出，脚本内容不会运行
    new vm.Script(code, { filename: 'console-inline.js' });
    console.log(`script #${i}: OK (${code.length} chars)`);
  } catch (e: any) {
    bad++;
    const raw = String(e?.stack || e?.message || e);
    const lm = raw.match(/console-inline\.js:(\d+)/);
    const where = lm ? `HTML 第 ${tagLine + Number(lm[1]) - 1} 行` : `起始约 HTML 第 ${tagLine} 行`;
    console.log(`script #${i}: SYNTAX ERROR（${where}）`);
    console.log(raw.split('\n').slice(0, 8).join('\n').slice(0, 1200));
  }
}

// ── 结构平衡校验（仅静态 HTML，即第一个 <script> 之前） ──
// 背景：曾因 <select id="recStatus"> 漏写 </select>，其后所有视图被解析进 select 内部、
// 简历中心整个不渲染；而本脚本只查 JS 语法、verify 与 58 项回归全绿，问题静默存在很久，
// 最终靠截图才发现。容器类标签在静态 HTML 中不应出现在 JS 字符串里，可安全做配对计数。
const scriptAt = html.search(/<script/i);
const staticHtml = scriptAt === -1 ? html : html.slice(0, scriptAt);
const CONTAINERS = ['select', 'option', 'textarea', 'section', 'table', 'thead', 'tbody', 'tr', 'th', 'td'];
let unbal = 0;
for (const tag of CONTAINERS) {
  const open = (staticHtml.match(new RegExp(`<${tag}\\b`, 'gi')) || []).length;
  const close = (staticHtml.match(new RegExp(`</${tag}>`, 'gi')) || []).length;
  if (open !== close) {
    unbal++;
    console.log(`❌ 结构不平衡：<${tag}> ${open} 个，</${tag}> ${close} 个`);
  }
}
if (!unbal) console.log('✅ 静态 HTML 容器标签配对平衡');

const failed = bad + unbal;
const skipNote = skipped ? `，${skipped} 个 module 块已跳过` : '';
console.log(failed
  ? `\n❌ ${bad} 个内联脚本语法错误，${unbal} 类标签不平衡`
  : `\n✅ 全部 ${i} 个内联脚本语法正确，静态 HTML 标签配对平衡${skipNote}`);
process.exit(failed ? 1 : 0);
