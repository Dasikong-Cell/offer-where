/**
 * 仓库级 PII 扫描（denylist 驱动）—— pre-push 的第 3 道门
 * ============================================================================
 * 为什么需要（2026-09-27 实测定位）：
 * pack.ps1 里**本来就有一份** PII 守卫，但它只扫「**会进分发包**的文件」
 * （$scanSet 来自 tar 成员表）。这就留下一个结构性盲区：git 跟踪、但**不进包**的
 * 文件（docs/、src/、大部分 scripts/）**永远扫不到**。
 *
 * 实证：c09b6e5 声称「strip resume-owner PII」，实际只把
 * docs/REFERENCE_gagajob.md **改名**为 docs/REFERENCE_competitor.md，
 * 第 30 行转录的「性别 + 出生年月 + 学校专业 + 籍贯到区 + 身高体重」**原样留着**，
 * 并随公开仓库继续可见（未认证即可抓取）。而那次打包检查是**全绿**的 ——
 * 因为这个文件压根不在包里。
 *
 * ⇒ 教训：「不发包」不等于「不公开」。凡是被 git 跟踪的东西（含 git 历史）都会
 *    被推送、被浏览、被抓取，必须与「随包内容」分开扫。
 *
 * ── 为什么文件列表由外部喂进来（--stdin），而不是自己 spawn git ──────────────
 * 本机实测（2026-09-27）：**node 创建的任何一个子进程都直接 EBUSY**
 * （spawnSync('git', …) / {shell:true} 全部 EBUSY），而 **shell 创建 node 是正常的**
 * —— 这正是 pre-push 里 tsc / console:check 能跑、而脚本内部再 spawn 会炸的原因
 * （同一个坑最早记在 scripts/check_console_syntax.ts 顶部）。
 * 于是把「枚举文件」交给调用方的 shell：
 *     git -c core.quotePath=false ls-files | tsx scripts/pii_guard.ts --stdin
 * 好处不只是绕开限制：**枚举权归调用方**，脚本本身不依赖 git 二进制，可离线单测。
 *
 * 判定数据来自 data/.pii_denylist.txt（data/ 既被 gitignore、也不进包），
 * 所以本文件**不会把它要找的字符串写进仓库**。文件不存在 ⇒ 跳过
 * （CI、或从没持有过那份简历的机器），与 pack.ps1 里那份守卫的姿态一致。
 *
 * 扫描范围 = 喂进来的**每个文件的内容**，二进制也算
 * （dist-app/offer-where.exe 这类产物同样可能把字符串烘进去），单文件上限 8MB。
 *
 * 输出只回报「命中的文件 + 第几个 deny 项（掩码形式）」，**不回显明文** ——
 * 免得 CI 日志本身变成新的泄露面。
 *
 * 运行：npm run pii:check
 * 退出码：有命中 1（fail-closed）；无命中或「denylist 不存在」0
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 仓库根（本文件在 scripts/ 下）。 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DENY_FILE = path.join(ROOT, 'data', '.pii_denylist.txt');
/** 单文件扫描上限：再大就不是「源码/文档误带」，而是别的问题了。 */
const MAX_BYTES = 8 * 1024 * 1024;
/** 最多逐条打印多少命中，避免一个高频词刷屏。 */
const MAX_PRINT = 20;

export interface DenyHit {
  rel: string;
  tokenIndex: number;
}

/** 逐行解析 denylist：跳过空行与 `#` 注释行，两端空白裁掉。 */
export function parseDenyList(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    if (!t || t.startsWith('#')) continue;
    out.push(t);
  }
  return out;
}

/**
 * 解析「文件列表」文本（一行一个相对路径）。
 * 只剥 `\r` 与空行 —— **不做 trim**：路径两端的空格是合法的，裁掉会指向另一个文件。
 */
export function parseFileList(text: string): string[] {
  return text.split('\n').map((s) => s.replace(/\r$/, '')).filter((s) => s.length > 0);
}

/**
 * 核心匹配：按 **UTF-8 字节** 比对，所以对中文 / emoji / 二进制内容一视同仁。
 * 用 Buffer.indexOf 而不是字符串包含：二进制文件（exe）读成 utf8 会因非法序列
 * 被替换成 U+FFFD，反而可能**错过**真实命中。
 */
export function findDenyHits(tokens: string[], items: { rel: string; buf: Buffer }[]): DenyHit[] {
  const needles = tokens.map((t) => Buffer.from(t, 'utf8'));
  const hits: DenyHit[] = [];
  for (const it of items) {
    for (let i = 0; i < needles.length; i++) {
      if (needles[i].length > 0 && it.buf.indexOf(needles[i]) >= 0) {
        hits.push({ rel: it.rel, tokenIndex: i });
      }
    }
  }
  return hits;
}

/**
 * 把 deny 项转成可安全打印的标签：**只暴露长度、首字符与哈希前缀**。
 * 首字符保留是有意的 —— 定位问题时能立刻分辨「是姓名那项还是手机号那项」，
 * 而单个字符不足以还原任何一条完整信息。
 */
export function maskToken(t: string): string {
  const h = crypto.createHash('sha256').update(t, 'utf8').digest('hex').slice(0, 8);
  return `deny#${h} (len=${t.length}, starts ${JSON.stringify(t.slice(0, 1))})`;
}

/** 同步读干 stdin（fd 0）。调用方是 shell 管道时可用；无输入则返回空串。 */
export function readStdin(): string {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function failClosed(msg: string, hint: string): number {
  console.log('❌ PII guard: ' + msg);
  if (process.env.PII_GUARD_ALLOW_SKIP === '1') {
    console.log('   PII_GUARD_ALLOW_SKIP=1 已设置 → 按跳过处理（请自行确认这不是假跳过）。');
    return 0;
  }
  console.log('   ' + hint);
  return 1;
}

function main(): number {
  if (!fs.existsSync(DENY_FILE)) {
    console.log('PII guard: SKIPPED (data/.pii_denylist.txt not present)');
    return 0;
  }
  const tokens = parseDenyList(fs.readFileSync(DENY_FILE, 'utf8'));
  if (!tokens.length) {
    console.log('PII guard: SKIPPED (data/.pii_denylist.txt has no usable tokens)');
    return 0;
  }

  // 文件列表必须由调用方给出：本环境下 node 自己 spawn 一律 EBUSY（见文件头）。
  const files = parseFileList(readStdin());
  if (!files.length) {
    return failClosed(
      '没收到文件列表，本次**未做校验**（stdin 为空）。',
      '用法：git -c core.quotePath=false ls-files | tsx scripts/pii_guard.ts --stdin',
    );
  }

  const items: { rel: string; buf: Buffer }[] = [];
  let skippedBig = 0;
  let unreadable = 0;
  for (const rel of files) {
    // 绝对路径直接丢弃：本脚本只认「仓库内相对路径」，避免调用方误传时扫到仓库外。
    if (path.isAbsolute(rel)) {
      unreadable++;
      continue;
    }
    const full = path.join(ROOT, rel);
    let st: fs.Stats;
    try {
      st = fs.statSync(full);
    } catch {
      unreadable++;   // 已跟踪但盘上没了（如 .d.ts 被清掉）——不算命中，也不该崩
      continue;
    }
    if (!st.isFile()) continue;
    if (st.size > MAX_BYTES) {
      skippedBig++;
      continue;
    }
    try {
      items.push({ rel, buf: fs.readFileSync(full) });
    } catch {
      unreadable++;
    }
  }

  const notes: string[] = [];
  if (skippedBig) notes.push(`跳过 ${skippedBig} 个 >${MAX_BYTES / 1048576}MB 的文件`);
  if (unreadable) notes.push(`${unreadable} 个不可读/被忽略`);
  const note = notes.length ? '（' + notes.join('；') + '）' : '';

  const hits = findDenyHits(tokens, items);
  if (hits.length) {
    console.log(`❌ PII guard: ${hits.length} 处命中（扫了 ${items.length} 个文件 / ${tokens.length} 个 deny 项）${note}`);
    for (const h of hits.slice(0, MAX_PRINT)) {
      console.log(`   - ${h.rel}  <- ${maskToken(tokens[h.tokenIndex])}`);
    }
    if (hits.length > MAX_PRINT) console.log(`   ... 另有 ${hits.length - MAX_PRINT} 处未列出`);
    console.log('   修法：把具体值换成占位符（如 "Zhang San" / "13800138000"）。');
    console.log('   注意：改写历史也救不回已推送的提交 —— 先确认命中的文件是否已经在远端。');
    return 1;
  }

  console.log(`✅ PII guard: ${items.length} 个文件 × ${tokens.length} 个 deny 项，0 命中${note}`);
  return 0;
}

// 仅在被直接执行时跑 main —— 合约测试会 import 上面的纯函数，不能被副作用带跑。
const invokedDirectly = (() => {
  const a = process.argv[1];
  if (!a) return false;
  try {
    return pathToFileURL(path.resolve(a)).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (invokedDirectly) process.exit(main());
