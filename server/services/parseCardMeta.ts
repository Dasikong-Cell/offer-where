/**
 * 校招卡片元数据解析 —— 从列表页卡片摘要（`jobs.card_text`）里拆出**结构化**的
 * 「届别 / 快捷标签 / 投递截止日」。
 *
 * ## 为什么需要它
 * offerbiu 的校招卡片是一行被压平的文本，信息密度很高，但**全部是文本**：
 *
 * ```
 * 中国电子云 更新 9月11日 LLM算法工程师、多模态算法工程师 等 9 项 IT/互联网/游戏 央国企
 * 北京、武汉、南京、成都 等 1 项 2027 届 2026/11/30 秋招 免笔试 投递入口 加入投递
 * ```
 *
 * 于是「按届别筛」「按免笔试/央国企筛」只能退化成全文 `includes`。这正是 2026-10-04
 * 那批「静默失效控件」的同一类病根：**控件在、数据也在，但没被结构化 ⇒ 筛不出东西也不报错**。
 * 更糟的是 `includes` 会把**公司名/行业名**当成性质 —— 实测 `事业单位` 用子串匹配会命中
 * 「政府/事业单位/社会组织」（那是**行业大类**）⇒ 那 7 条会被错误地打上「事业单位」标签。
 * 所以这里一律按**空白切词后的 token 等值**判定，不做子串搜索。
 *
 * ## 关于「研究所」
 * offerbiu 的快捷关注里有「研究所」一项，但实测 **token 等值匹配 0 条** ——
 * 它并不是「企业性质」的取值，而是**公司名里的关键词**（`西安航天动力试验技术研究所`、
 * `中国电科第40、41研究所`、`中国电子信息产业集团第六研究所`）。本模块按 offerbiu 的
 * 真实语义实现：`研究所` ⟺ **公司名 token 含「研究所」**，并在 `hint` 里写明，
 * 免得用户以为它在筛性质。
 *
 * ## 设计取舍
 * - **纯函数、零依赖、零 IO** ⇒ 可单测（`tests/unit/cardMeta.test.ts`）。
 * - **宁可漏报，不可误报**：`tags` 是给人的「快捷关注」，多一个错标签会让人筛出一批
 *   根本不该出现的岗位，而且用户无从发现。所以每个标签都要求**结构证据**（token 等值 /
 *   公司名关键词），拿不准就不打。
 * - **与 `parsePostedAt.ts` 同构**：入库时解析（`upsertJob`）+ 存量回填脚本
 *   （`scripts/backfill_card_meta.ts`）两条路径共用本模块，绝不各写一份。
 * - **`deadline` 的锚点是结构性的，不是启发式**：实测 113/113，「届别 token」之后
 *   **恰好一个空白**就是「时间」列的值 —— 是日期就是截止日，是 `尽快投递`/`招满为止`
 *   就不是。于是它既不可能误取顶部的 `更新 9月11日`（没有年份），也不可能取到正文里的日期。
 */

/** 有效年份区间（挡掉 `0000`、`9999` 这类明显不是届别的数字） */
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

/** 卡片上「企业性质」这一列的已知取值。**只认这些 token**，见文件头「关于研究所」。 */
const NATURE_TOKENS = ['央国企', '民企', '外企', '合资', '事业单位', '政府机关', '其他'] as const;

/** 卡片上「批次」这一列的取值（`实习` 单独判，它要覆盖 `暑期实习`） */
const BATCH_TOKENS = ['秋招', '春招', '补录', '提前批', '暑期实习'] as const;

/**
 * 标签定义表 —— **唯一真相源**。
 * `ui: true` 的才会出现在控制台的「快捷关注」里；`ui: false` 的只落库备用
 * （例如「民企」占 539 条，但它不是求职者的**筛选意图**，摆出来只会挤占视觉）。
 *
 * ⚠️ 新增标签必须同时给出 `hint`：控制台把 hint 作为 `title` 挂在 chip 上。
 *    「研究所」这类语义与字面不一致的标签，没有 hint 就是在骗用户。
 */
export interface CardTagDef {
  /** 落库的标签值（就是中文词本身，便于直接读库排查） */
  key: string;
  label: string;
  /** 鼠标悬停说明。**必填** —— 语义与字面不一致时，它是唯一的解释入口。 */
  hint: string;
  /** 是否出现在控制台快捷关注条 */
  ui: boolean;
}

export const CARD_TAG_DEFS: CardTagDef[] = [
  { key: '免笔试', label: '免笔试', hint: '卡片上的「要求」列写明免笔试（无需笔试环节）', ui: true },
  { key: '秋招', label: '秋招', hint: '卡片上的「批次」列为秋招', ui: true },
  { key: '春招', label: '春招', hint: '卡片上的「批次」列为春招', ui: true },
  { key: '实习', label: '实习', hint: '卡片上的「批次」列含实习（含暑期实习）', ui: true },
  { key: '央国企', label: '央国企', hint: '卡片上的「企业性质」列为央国企', ui: true },
  { key: '研究所', label: '研究所', hint: '公司名里含「研究所」（这是公司名关键词，不是企业性质）', ui: true },
  { key: '外企', label: '外企', hint: '卡片上的「企业性质」列为外企', ui: true },
  { key: '事业单位', label: '事业单位', hint: '卡片上的「企业性质」列为事业单位', ui: true },
  // 只落库、不上控制台：数量大且不是「筛选意图」，摆出来会挤掉真正有用的 chip。
  { key: '民企', label: '民企', hint: '卡片上的「企业性质」列为民企', ui: false },
  { key: '合资', label: '合资', hint: '卡片上的「企业性质」列为合资', ui: false },
  { key: '暑期实习', label: '暑期实习', hint: '卡片上的「批次」列为暑期实习', ui: false },
];

/** 控制台快捷关注条要渲染的标签（顺序即展示顺序，`CARD_TAG_DEFS` 的顺序即可用） */
export const CARD_UI_TAGS: CardTagDef[] = CARD_TAG_DEFS.filter((d) => d.ui);

/** 全部合法标签值（`normalizeTags` 的白名单；落库前必须过它，防止脏值进库） */
export const CARD_TAG_KEYS: string[] = CARD_TAG_DEFS.map((d) => d.key);

export interface CardMeta {
  /** 届别，4 位年份字符串（`'2027'`）；认不出来为 `null` */
  gradYear: string | null;
  /** 标签（已过白名单、已去重、顺序按 `CARD_TAG_DEFS`）；无标签为空数组 */
  tags: string[];
  /** 投递截止日 `YYYY-MM-DD`；卡片「时间」列写的是日期时才有，`尽快投递`/`招满为止` 为 `null` */
  deadline: string | null;
}

/** 空结果（每次新建对象，避免调用方误改共享常量） */
function empty(): CardMeta {
  return { gradYear: null, tags: [], deadline: null };
}

/**
 * 把卡片文本切成 token。
 *
 * ⚠️ 必须按**空白**切（含全角空格与换行）—— 卡片是 `join(' ')` 出来的，
 * 而中文词之间没有空格，所以「一个 token = 一个字段值」这个前提在本语料里成立
 * （实测 `2027 届` 这个词被空格断成两个 token，因此届别用正则而不是 token 对）。
 */
function tokensOf(text: string): string[] {
  return text.split(/[\s\u3000]+/).filter(Boolean);
}

/**
 * 去掉 token 尾部粘着的标点。
 *
 * 🔴 真实数据实测：`之江实验室 … 事业单位, 其他 杭州` —— 渲染时逗号被粘进了 token。
 * 不做这一步，「事业单位」这类**性质标签会漏掉**（该条真值确实是事业单位）。
 */
function stripTailPunct(tok: string): string {
  return tok.replace(/[,，;；、。·|｜]+$/g, '');
}

/**
 * 这个 token 是不是一个合法的「企业性质」值？
 *
 * 支持 `A/B` 形式的多值 token，但**要求每一段都是已知性质**：
 *   · `外企/合资`             → ✅ 两段都合法（实测 3 条，offerbiu 的「外企」筛选会算上它们）
 *   · `政府/事业单位/社会组织` → ❌ 这是**行业大类**；若按子串匹配会把它当成「事业单位」
 *                              （实测 7 条），等于把行业名当成企业性质 —— 必须整体拒绝
 */
function isNatureToken(tok: string): boolean {
  const t = stripTailPunct(tok);
  if (!t) return false;
  const parts = t.split('/').map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((p) => (NATURE_TOKENS as readonly string[]).includes(p));
}

/** 把 `A/B` 形式的性质 token 拆成各自的值（供打标签） */
function natureValues(tok: string): string[] {
  return stripTailPunct(tok).split('/').map((s) => s.trim()).filter(Boolean);
}

/** `2017` 这个年份是否落在合理区间 */
function isValidYear(y: number): boolean {
  return Number.isInteger(y) && y >= MIN_YEAR && y <= MAX_YEAR;
}

/**
 * 从任意文本里取**届别**（4 位年份 + 「届」）。
 *
 * 只认 `20\d\d` 完整写法：卡片里 `27届秋招-产品助理` 这类**职位名里的短写**（实测 3 条）
 * 也在同一段文本里另有完整的 `2027 届` 字段，取短写只会引入歧义。宁少不错。
 *
 * 一行里出现多个届别（`2026/2027 届`，实测 1 条）时**只取第一个**：
 * 该列的语义是「这份招聘面向哪一届」，多届时 offerbiu 本身也没把它拆开；
 * 拆成多值会让前端筛选从「等值」变成「包含」，为 1 条数据把判据复杂化不划算。
 */
export function parseGradYear(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = /(?<!\d)(20\d\d)\s*届/.exec(text);
  if (!m) return null;
  return isValidYear(Number(m[1])) ? m[1] : null;
}

/**
 * 从卡片文本里取**投递截止日**。
 *
 * ## 判据是结构性的（实测 113/113）
 * 卡片「时间」列的取值**紧跟在届别 token 之后，恰好一个空白**：
 *   `… 2027 届 2026/11/30 秋招 免笔试 …`   ← 截止日
 *   `… 2027 届 尽快投递 秋招 免笔试 …`      ← 没有固定截止日
 * 距离实测恒为 1（min = max = 1），所以这条规则不依赖「猜上下文窗口」：
 * - 顶部的 `更新 9月11日` 没有年份，天然不命中；
 * - JD/正文里的日期不在届别之后，也取不到；
 * - `尽快投递` / `招满为止` / `招满即止` / `招满即停` 后面没有日期，返回 `null`。
 *
 * ⚠️ 语义确认（不是猜的）：`_tools/_offerbiu_tour.md` 的表格表头是
 *    `公司/岗位 | 行业 | 地点 | 届别 | 时间 | 要求`，同一列上 `尽快投递` 与 `2026/10/28`
 *    交替出现，而 offerbiu 的快捷关注里有「近7天截止」⇒ 这一列就是**投递截止时间**。
 *    另有 `我的投递` 卡片把它渲染成 `截止 10/04`，同一字段两处口径一致。
 */
export function parseCardDeadline(cardText: string | null | undefined): string | null {
  if (!cardText) return null;
  const m = /(?<!\d)20\d\d\s*届[\s\u3000]+(?<!\d)(20\d\d)\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{1,2})(?!\d)/.exec(cardText);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!isValidYear(y) || mo < 1 || mo > 12 || d < 1) return null;
  // 该月天数：下个月第 0 天 = 本月最后一天（挡掉 2月30日）
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d > daysInMonth) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * 从卡片文本里取**标签**。
 *
 * 全部按 token 判定（见文件头），三处证据来源各自独立：
 *   ① `免笔试` —— 要求列 token 等值；
 *   ② 批次（`秋招`/`春招`/`暑期实习`/`补录`/`提前批`）—— token 等值，`实习` 另外用包含
 *      （这样 `暑期实习` 同时得到「实习」与「暑期实习」两个标签，符合直觉）；
 *   ③ 企业性质 —— `isNatureToken` 通过后按 token 打标；
 *   ④ `研究所` —— **公司名 token 含「研究所」**（首 token 及含「研究所」的 token 都算，
 *      但要求它出现在第一个空白之前，即公司名那一段，避免把职位名里的「研究所」算进来）。
 */
export function parseCardTags(cardText: string | null | undefined): string[] {
  if (!cardText) return [];
  const toks = tokensOf(cardText);
  const out = new Set<string>();
  const bump = (key: string) => {
    if ((CARD_TAG_KEYS as string[]).includes(key)) out.add(key);
  };

  for (const raw of toks) {
    const t = stripTailPunct(raw);
    if (t === '免笔试') bump('免笔试');
    if ((BATCH_TOKENS as readonly string[]).includes(t)) { bump(t); }
    if (/实习/.test(t)) bump('实习');
    if (isNatureToken(t)) for (const v of natureValues(t)) bump(v);
  }

  // 公司名 = 卡片开头的第一段（`中国中化|装备公司` 这种带竖线的也在这里）。
  // 只在首段里找「研究所」，避免职位名（`… 等 9 项` 之前的一大串）里的同名词造成误报。
  const head = stripTailPunct(toks[0] || '');
  if (head.includes('研究所')) bump('研究所');

  // 顺序固定为 CARD_TAG_DEFS 的顺序 —— 否则 Set 的插入序会让同一份数据在不同调用里
  // 渲染出不同的 chip 顺序（前端按数组顺序显示）。
  return CARD_TAG_DEFS.map((d) => d.key).filter((k) => out.has(k));
}

/**
 * 一次解析出卡片上的全部结构化元数据。
 *
 * @example
 *   parseCardMeta('中国电子云 更新 9月11日 … 2027 届 2026/11/30 秋招 免笔试 投递入口')
 *   → { gradYear: '2027', tags: ['免笔试','秋招','央国企'], deadline: '2026-11-30' }
 */
export function parseCardMeta(cardText: string | null | undefined): CardMeta {
  if (!cardText || !String(cardText).trim()) return empty();
  const s = String(cardText);
  return {
    gradYear: parseGradYear(s),
    tags: parseCardTags(s),
    deadline: parseCardDeadline(s),
  };
}

// ── 入库前的收敛（白名单 / 归一化） ─────────────────────────────────────────

/**
 * 把任意来源的值收敛成合法届别（4 位年份字符串）或 `null`。
 *
 * 为什么要收敛而不是原样存：`grad_year` 会被前端当作**筛选下拉的候选值**。
 * 一旦库里混进 `'2027届'`、`'2027 届'`、`'2027/2028'`，下拉里就会出现三个看着一样的选项，
 * 每个只筛出一部分 —— 用户完全无法察觉。**下拉的候选值必须只有一个形态。**
 */
export function normalizeGradYear(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const v = String(value).trim();
  if (!v) return null;
  const m = /(?<!\d)(20\d\d)(?!\d)/.exec(v);
  if (!m) return null;
  return isValidYear(Number(m[1])) ? m[1] : null;
}

/** 把任意来源的值收敛成合法标签数组（过白名单、去重、按 `CARD_TAG_DEFS` 排序） */
export function normalizeTagList(value: unknown): string[] {
  let raw: unknown[] = [];
  if (value === null || value === undefined) raw = [];
  else if (Array.isArray(value)) raw = value;
  else if (typeof value === 'string') {
    const s = value.trim();
    if (!s) raw = [];
    else if (s.startsWith('[')) {
      // JSON 数组串：解析失败**不要**退回「当成分隔符串」—— 那会把 `[` 也当成一个标签。
      try {
        const parsed = JSON.parse(s);
        raw = Array.isArray(parsed) ? parsed : [parsed];
      } catch { raw = []; }
    } else raw = s.split(/[,，\s]+/);
  } else raw = [value];

  const set = new Set<string>();
  for (const r of raw) {
    const k = String(r == null ? '' : r).trim();
    if ((CARD_TAG_KEYS as string[]).includes(k)) set.add(k);
  }
  return CARD_TAG_DEFS.map((d) => d.key).filter((k) => set.has(k));
}

/** 标签数组 → 落库字符串（JSON）；空数组 → `null`（全项目只认一种「没有标签」） */
export function serializeTags(tags: unknown): string | null {
  const list = normalizeTagList(tags);
  return list.length ? JSON.stringify(list) : null;
}

/**
 * 落库字符串 → 标签数组。
 * 解析失败返回 `[]` 而**不是抛出** —— 库里的脏值不该让整个列表页白屏。
 */
export function parseTags(value: string | null | undefined): string[] {
  if (!value) return [];
  return normalizeTagList(value);
}
