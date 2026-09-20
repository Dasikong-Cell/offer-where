/**
 * 校验 public/console.html 内联脚本的语法。
 *
 * 为什么需要：生产控制台是一份 ~3000 行的单文件 HTML，内联 JS 里大量使用**嵌套模板字面量**
 * （`renderEmailHits` 这类渲染函数），手改极易漏掉一个反引号或 `${}` 括号，
 * 而浏览器只在运行时才报错、且报错位置偏移大、极难定位。
 * 本脚本用 `node --check` 在提交前静态拦下这类错误。
 *
 * 运行：./node/node.exe node_modules/tsx/dist/cli.mjs scripts/check_console_syntax.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(__dirname, '..', 'public', 'console.html');

const html = fs.readFileSync(HTML, 'utf-8');
// 只取内联脚本（跳过带 src 的外链）
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consolesyn-'));

let m: RegExpExecArray | null;
let i = 0;
let bad = 0;

while ((m = re.exec(html)) !== null) {
  i++;
  const code = m[1];
  if (!code.trim()) continue;
  const f = path.join(tmpDir, `chunk_${i}.mjs`);
  fs.writeFileSync(f, code);
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    console.log(`script #${i}: OK (${code.length} chars)`);
  } catch (e: any) {
    bad++;
    const line = String(e?.stderr || e?.message || e);
    // node --check 的行号是「抽出片段内」的位置，需回填到 HTML 大致行号
    const off = html.slice(0, m.index).split('\n').length;
    console.log(`script #${i}: SYNTAX ERROR (HTML 约第 ${off} 行起)`);
    console.log(line.slice(0, 1200));
  }
}

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

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
console.log(failed ? `\n❌ ${bad} 个内联脚本语法错误，${unbal} 类标签不平衡` : `\n✅ 全部 ${i} 个内联脚本语法正确，静态 HTML 标签配对平衡`);
process.exit(failed ? 1 : 0);
