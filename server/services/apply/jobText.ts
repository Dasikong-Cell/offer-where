/**
 * 岗位名「输出侧」清洗 —— 纯函数、零 IO、不读时钟。
 *
 * ── 为什么还需要一个清洗函数？`server/db.ts` 不是已经有 `sanitizePosition` 了吗 ──
 *
 * `sanitizePosition` 是**写库口的防御层**（`upsertJob` / 字段白名单处调用），它治的是
 * 「BOSS 加密字体把薪资数字吞掉」那一类污染（`Java\n-K`、`-K`、PUA 字形、列表页卡片尾巴）。
 * 它在**输出侧是完全不生效的**，因为：
 *   ① 它只在**写入**时跑 —— 库内**存量**行（本轮实测 3200 行）不经过它，读出来还是脏的；
 *   ② 它不处理**反斜杠** —— 实测库内 4 行含 `\`（如 `软件工程师Java\C#（3-6个月长期出差）`）；
 *   ③ 它**允许返回 null / 空串** —— 19 行为空，直接拼进对外文案就成了「贵单位「」岗位」；
 *   ④ 它的 80 字上限是**存储**上限，不是**展示/发信**上限 —— 82 行超过 40 字，最长 80 字，
 *      典型形态是 offerbiu 的「多岗位并列」串：
 *        `北京大模型算法工程师、北京智能体算法工程师、北京多模态算法工程师 等 9 项 民企
 *          IT/互联网/游戏/电商 北京、深圳 2027 届 尽快投递 秋招 需要笔试`
 *      这一整串会被拼进发给 HR 的正文句子 ——
 *        「我在招聘信息中看到贵单位「<上面那 80 个字>」岗位，非常感兴趣……」
 *      以及控制台的表格单元格 / `<option>` / 卡片标题。
 *
 * ⇒ 两者是**互补**关系，不是重复：写库口防新增脏值，输出口保证「发出去的那一行可读」。
 *    **本函数绝不回写数据库** —— 存量行原样保留，只在渲染 / 拼文案的那一刻收敛。
 *
 * ── 三条规则（对应 2026-10-10 的需求：去反斜杠、截断、空则「该岗位」）──
 *   1. 去反斜杠：`\` 是解析残留的**分隔符**（`Java\C#`、`未明确 \车辆工程`），换成 `/` 并吃掉两侧空白；
 *   2. 截断：超过 `POSITION_LABEL_MAX` 时**优先切在分隔符处** —— 硬切会把
 *      `Golang后端工程师` 砍成 `Golang后`，看起来像数据坏了；
 *   3. 空则兜底：清洗后为空返回 `fallback`（默认「该岗位」）。
 *
 * 🔴 `fallback` **必须可关**：邮件标题 / HR 指定的标题格式里，「空」是有语义的
 *    （空 ⇒ 占位符判为未解析 ⇒ 走兜底标题）。那里若注入「该岗位」，标题会变成
 *    `应聘该岗位-张三-138…` —— 比空着更糟。见 `subjectSpec.ts` 的两处调用（传 `''`）。
 */

/** 展示/发信用上限。与 `coverLetter.ts` 的 `{职位名称}` 既有口径（`.slice(0, 40)`）一致。 */
export const POSITION_LABEL_MAX = 40;

/** 清洗后为空时的默认兜底文案（与 `coverLetter.ts` 既有文案同词）。 */
export const POSITION_LABEL_FALLBACK = '该岗位';

/** 反斜杠连缀（含两侧空白）：`Java\C#` / `未明确 \车辆工程` / `A\\B` ⇒ `/` */
const BACKSLASH_SEP_RE = /\s*\\+\s*/g;

/**
 * 零宽字符 + BOM ⇒ **删掉**（不是换成空格）。
 * `Java\u200b开发` 里那个零宽空格是爬虫/复制残留，本意是「Java开发」；
 * 换成空格会凭空造出一个词边界（`Java 开发`），删掉才还原原意。
 */
const ZERO_WIDTH_RE = /[\u200B-\u200F\uFEFF]/g;

/**
 * 控制符 + 行/段分隔符 ⇒ 换成空格。
 * 换行/制表必须变空格：直接删掉会把两行粘成一个词（`Java\n开发` ⇒ `Java开发`），
 * 而它们原本确实是两个词；空格则会被下一步的空格折叠收干净。
 */
const LINE_CTRL_RE = /[\u0000-\u001F\u007F\u2028\u2029]/g;

/**
 * 截断切点分两档（先强后弱）：
 *  - **强分隔符**：顿号/逗号/斜杠/竖线/间隔号 —— 切在这里几乎不会切坏语义；
 *  - **弱分隔符**：空格 —— 只在完全没有强分隔符时才用（如长英文职位名）。
 * 之所以不把空格混进强档：`……Golang后端工程师 等 2 项` 的最后一个空格落在 `等 2` 之后，
 * 切出来是 `…… 等 2…`（把「等 N 项」劈成两半），而切在顿号处得到的是完整的一段。
 */
const CUT_STRONG = ['、', '，', ',', '/', '|', '·'];

/** 尾部残留的分隔符：截断后不该留下 `北京、…` 这种尾巴 */
const TRAILING_SEP_RE = /[\s、，,/|·]+$/;

/**
 * 把岗位名收敛成**一行可读标签**。幂等：`f(f(x)) === f(x)`。
 *
 * @param raw      原始值（可能是 null / undefined / 数字 / 超长脏串）
 * @param fallback 清洗后为空时的返回值。**传 `''`** 表示「空就是空」（标题类场景，见文件头注释）
 */
export function jobPositionLabel(raw: unknown, fallback: string = POSITION_LABEL_FALLBACK): string {
  if (raw === null || raw === undefined) return fallback;
  let s = String(raw);
  s = s.replace(BACKSLASH_SEP_RE, '/');
  s = s.replace(ZERO_WIDTH_RE, '');
  s = s.replace(LINE_CTRL_RE, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return fallback;
  if (s.length <= POSITION_LABEL_MAX) return s;

  const head = s.slice(0, POSITION_LABEL_MAX);
  // 强分隔符优先；都没有时才考虑空格。切点太靠前（不足一半）不如硬切 ——
  // 否则 `人工智能、智能科学与技术…` 会被切在第一个顿号上，只剩一个词。
  const min = POSITION_LABEL_MAX / 2;
  let cut = -1;
  for (const sep of CUT_STRONG) {
    const i = head.lastIndexOf(sep);
    if (i > cut) cut = i;
  }
  if (cut < min) {
    const sp = head.lastIndexOf(' ');
    cut = sp >= min ? sp : -1;
  }
  const body = cut >= min ? head.slice(0, cut) : head;
  return body.replace(TRAILING_SEP_RE, '') + '…';
}
