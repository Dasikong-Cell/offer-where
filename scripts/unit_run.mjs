/**
 * 最小单测驱动：把 `tests/` 下所有 `*.test.ts` 交给 **Node 内置 test runner** 跑。
 *
 * ⚠️ 上面那句刻意**不**写成 glob 字面量 —— 在块注释里写出「星号 + 斜杠」会把注释
 *    提前闭合，报成 `SyntaxError: Unexpected token '*'`（看起来很莫名其妙）。
 *
 * 为什么需要这个 12 行的文件，而不是直接 `node --test`：
 *   Node 自带的 `--test` 只自动发现 `*.test.{js,mjs,cjs}`，**不认 `.ts`**；
 *   而 npm 在 Windows 上用 cmd 执行 script，glob 不会被 shell 展开
 *   （在 bash 里能跑、在 npm 里就失败 —— 典型的"本机能跑 CI 红"）。
 *   所以自己收集文件再显式传给 `--test`，两边行为一致。
 *
 * 用 Node 内置 test runner 而不是 jest/vitest：本项目已有 500+ 条 `check()` 式断言，
 * 单测的增量价值在"能独立跑、失败能定位到单条"，不在花哨的 reporter。
 * 引一个大依赖进来，收益（断言多几个）远小于代价（安装体积、配置漂移）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TESTS_DIR = path.join(ROOT, 'tests');

function collect(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { collect(p, out); continue; }
    if (/\.test\.ts$/.test(e.name)) out.push(p);
  }
}

const files = [];
collect(TESTS_DIR, files);
files.sort();

if (!files.length) {
  console.error(`未找到任何 ${path.relative(ROOT, TESTS_DIR)}/**/*.test.ts`);
  process.exit(1);
}

console.log(`单测：${files.length} 个文件（${files.map((f) => path.relative(ROOT, f)).join(', ')}）`);
console.log('');

const child = spawn(process.execPath, ['--import', 'tsx', '--test', ...files], {
  cwd: ROOT,
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 1));
