/**
 * 「投递邮件标题」解析 —— 把招聘方写明的标题要求如实落实
 *
 * ## 为什么单独抽一个模块
 *
 * 起因（2026-10-10）：用**真库 14 条含「标题」字样的 JD** 压旧实现，**只有 1 条解析成功**。
 * 旧实现只认「标题格式」这四个字 + 只认 `+` 分隔符，于是另外 13 条全部**静默回落成默认标题**——
 * 招聘方白纸黑字写了格式，我们一条没照做，而且**不报错、日志里还写「已按格式」**。
 *
 * 真实语料里要求的写法五花八门（全部来自 `data/chat.db`）：
 *   · `邮件标题格式“学历+专业+学校+姓名”`
 *   · `邮件标题：学校名+专业+姓名`
 *   · `邮件标题格式：【Java全栈】 - 姓名 - 工作年限 - 最高学历院校`
 *   · `邮件标题：岗位+学校+名字`            （夹在括号里：`…com（邮件标题：岗位+学校+名字）`）
 *   · `邮件标题：【保育数据库实习申请】姓名＋学校＋专业。`   ← 全角「＋」
 *   · `邮件标题请注明：应聘岗位 - 姓名 - 学校 - 专业 - 毕业年份`
 *   · `请按“实习岗位名称+姓名+应聘部门+是否接受调剂”命名标题和简历名称`  ← 要求写在「标题」**之前**
 *   · `以“应聘岗位+姓名+学校+专业+学历”为标题`
 *   · `标题注明【Java技术合伙人-姓名】`
 *   · `标题名为姓名-应聘XXX岗位。`
 *   · `邮件主题及附件文件名格式： “院校+专业+姓名”`          ← 用「主题」而不是「标题」
 * 以及必须被排除的噪音：`点击标题查看往期文章精选`、`文案标题编辑`。
 *
 * ## 三条纪律
 *
 * 1. 🔴 **没解析出来 ≠ 可以悄悄用默认标题**。`planSubject()` 一定会把 `requirement`
 *    （JD 原文的要求片段）带出来，调用方必须把它显示给人看 —— 这正是「确定招聘方要求再投递」。
 * 2. 🔴 **不做「猜一个」**。凡是拼不成、或档案缺值的，进 `unresolved` 并令 `matched=false`。
 *    猜错的标题比默认标题更糟：默认标题至少诚实，猜错的会让人以为照做了。
 * 3. 🔴 **OCR 打散的 JD 要显式告警**。实测两条 JD（芯聚能 / 轾驱）的 `标题` 要求被 OCR
 *    拆到了相隔十几行的地方（`…ower.com` 与 `聘岗位”为标题` 各占一行），**这类文本上
 *    「抽不到要求」不等于「没有要求」** —— 必须回传 `degraded` 让人工看一眼。
 *    这与 `huangy@ieit.com` 退信是**同一个根因**：OCR 既读错域名，也读散要求。
 *
 * ## 实现要点：原位替换，而不是「切开再拼回去」
 *
 * 第一版实现把要求按分隔符切开、映射成值、再用分隔符 join 回去，结果把招聘方的
 * **括号、多分隔符混用**全弄丢了（`【保育数据库实习申请】姓名＋学校＋专业` 被拼成
 * `保育数据库实习申请+张三+…`）。现改为**扫描原文、只在占位词的位置就地替换值**，
 * 其余字符（分隔符、括号、空格、标点）**逐字节原样保留** —— 这也正是人工照做时的动作。
 */

import { jobPositionLabel } from './jobText.js';

export interface SubjectPart {
  kind: 'field' | 'literal' | 'unknown';
  /** 要求里的原始片段（已归一化全角符号） */
  text: string;
  /** `kind==='field'` 时的档案字段名 */
  field?: string;
  /** `kind==='field'` 时取到的值（空字符串表示档案里没填） */
  value?: string;
}

export interface SubjectPlan {
  /** JD 里「标题要求」的原文片段；`null` = 没抽到 */
  requirement: string | null;
  /** 最终标题（`matched=false` 时是尽力而为的结果，仅供人工参考） */
  subject: string;
  /** 是否**完全**按 JD 要求拼成（无未识别片段、无空值） */
  matched: boolean;
  parts: SubjectPart[];
  /** 未能解决的片段，逐条给人看 */
  unresolved: string[];
  /**
   * JD 里**看得出**有标题要求、但因为文本被打散/格式太野而没抽出来。
   * 调用方应提示人工确认，**不要**静默按默认标题发。
   */
  degraded?: boolean;
}

/** 拼标题用的最小档案形状（避免与 ApplyProfile 循环依赖） */
export interface SubjectProfile {
  name?: string | null;
  phone?: string | null;
  education?: string | null;
  school?: string | null;
  major?: string | null;
  city?: string | null;
  workYears?: string | null;
  graduationYear?: string | null;
  acceptAdjust?: string | null;
  [k: string]: unknown;
}

export interface SubjectJobRef {
  company?: string | null;
  position?: string | null;
}

// ── 归一化 ────────────────────────────────────────────────────────────────────

/** 全角 → 半角（分隔符专用）。实测 `＋`（U+FF0B）是漏解析的头号元凶之一 */
const FULLWIDTH: Record<string, string> = { '＋': '+', '－': '-', '／': '/', '｜': '|' };

export function normalizeSubjectText(s: string): string {
  return String(s || '')
    .replace(/[＋－／｜]/g, c => FULLWIDTH[c] ?? c)
    .replace(/\u3000/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** 要求里的分隔符（归一化之后） */
const SEP_RE = /[+\-、/|]/;

// ── 占位词 → 档案字段 ─────────────────────────────────────────────────────────
//
// 🔴 **顺序即优先级，且必须是「锚定串首」的正则**（原位替换是逐字符推进的，
//    规则只在当前位置匹配）。长的、具体的标签必须排在短的、宽泛的前面：
//    · `最高学历院校` 必须排在 `学历` 之前（实测该片段两个字面量都含，排反了填成学历）；
//    · `实习岗位名称` 必须排在 `岗位` 之前（否则会替换出「实习<岗位名>名称」）。

const FIELD_RULES: Array<{
  re: RegExp;
  field: string;
  get: (p: SubjectProfile, job?: SubjectJobRef) => string;
}> = [
  { re: /^最高学历院校|^毕业院校|^学校名称|^院校名称|^学校名|^院校名|^院校|^学校/, field: '学校', get: p => str(p.school) },
  { re: /^所学专业|^专业名称|^专业/, field: '专业', get: p => str(p.major) },
  { re: /^最高学历|^学历|^学位/, field: '学历', get: p => str(p.education) },
  { re: /^姓名|^名字/, field: '姓名', get: p => str(p.name) },
  { re: /^联系电话|^手机号码|^手机号|^联系方式|^手机|^电话/, field: '电话', get: p => str(p.phone) },
  {
    // 🔴 `应聘XXX岗位` 里的 `XXX` 是**岗位本身的占位符**，必须整段吃掉替换成岗位名 ——
    //    只吃 `岗位` 会留下 `应聘XXX后端开发工程师`（实测 `浙江嘉兴数字城市` 一条）。
    re: /^实习岗位名称|^应聘[^，。+\-、/|]{0,6}?岗位|^应聘职位|^意向岗位|^期望岗位|^岗位名称|^岗位|^职位/,
    field: '岗位',
    get: (_p, job) => jobPositionLabel(job?.position, ''),
  },
  { re: /^意向城市|^期望城市|^城市|^地点/, field: '城市', get: p => str(p.city) },
  { re: /^工作年限|^工作经验|^年限/, field: '工作年限', get: p => str(p.workYears) },
  { re: /^是否接受调剂|^接受调剂|^调剂/, field: '是否接受调剂', get: p => str(p.acceptAdjust) },
  { re: /^毕业年份|^毕业时间|^毕业届|^届/, field: '毕业届', get: p => str(p.graduationYear) },
];

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

/** 片段**整段**就是一个字段标签（`院校` 是、`院校及专业` 不是） */
function wholeSegmentRule(seg: string) {
  return (
    FIELD_RULES.find(r => {
      const m = seg.match(r.re);
      return !!m && m[0].length === seg.length;
    }) || null
  );
}

/**
 * 片段能否被解析成标题。
 *
 * 🔴 不能只测「有没有分隔符」：实测 `以院校及专业为标题` 的方案里一个分隔符都没有，
 *    靠的是「及」这个词把两个字段连起来（见 `splitSubjectSegments` 的 `splitInner`）。
 *    只测分隔符会把这条真要求漏掉。
 */
function isParsableSpec(raw: string): boolean {
  const n = normalizeSubjectText(raw);
  if (SEP_RE.test(n)) return true;
  if (splitSubjectSegments(n).length > 1) return true;
  return !!wholeSegmentRule(n);
}

/**
 * 把一条要求切成「片段」——**仅用于判断可解析性与诊断**，
 * 真正拼标题走的是 `planSubject` 的原位替换（那样才能保留分隔符与括号原样）。
 *
 * 两处特殊处理，都是真语料逼出来的：
 *   · `【X】Y` → 拆成「字面前缀 `【X】`」+「`Y` 继续判字段」（`【保育数据库实习申请】姓名＋…`）；
 *   · `院校及专业` → 用「及/和/与」拆，**且要求每段都能整段命中字段规则**
 *     （`应聘部门` 拆不出来就不拆，免得把不认识的词当字段）。
 */
export function splitSubjectSegments(spec: string): string[] {
  const n = normalizeSubjectText(spec);
  const out: string[] = [];
  for (const seg of n.split(SEP_RE)) {
    const t = seg.trim();
    if (!t) continue;
    const m = t.match(/^[【\[「『]([^】\]」』]{1,30})[】\]」』]\s*(.*)$/);
    if (m) {
      out.push(`【${m[1]}】`);
      if (m[2] && m[2].trim()) out.push(...splitInner(m[2].trim()));
    } else {
      out.push(...splitInner(t));
    }
  }
  return out;

  function splitInner(t: string): string[] {
    if (wholeSegmentRule(t)) return [t];
    const parts = t.split(/[及和与]/).map(x => x.trim()).filter(Boolean);
    if (parts.length > 1 && parts.every(p => !!wholeSegmentRule(p))) return parts;
    return [t];
  }
}

// ── 要求原文提取 ──────────────────────────────────────────────────────────────

/** 与「标题/主题」同现即判为噪音的场景（否则「点击标题查看往期文章」会被当成要求） */
const NOISE_RE = /往期|文章|文案|视频|新闻|栏目|阅读原文|封面|写留言|公众号/;

/** 要求片段的终止符（读到这些就停） */
const TERMINATOR_RE = /[\n。；;）)】\]，,]/;

/**
 * 锚点附近的上下文 —— **刻意取窄**。
 *
 * 🔴 噪音判定只看锚点自己，不看几十字开外。起因：窗口取 ±35 时，
 *    `邮件主题及附件文件名格式： “院校+专业+姓名” 识别二维码 关注航空工业 点击标题查看往期文章精选`
 *    里的**真要求**被后面那段公众号页脚一起框进来，NOISE_RE 命中「往期/文章」
 *    就把真要求整条丢掉了 —— 误报比漏报危险，这里是误**杀**。
 *    取「前 30 / 后 14」既能认出 `邮件主题` 这种前缀，又框不进页脚。
 */
function nearAnchor(text: string, i: number, len: number, back = 30, fwd = 14): string {
  return text.slice(Math.max(0, i - back), i + len + fwd);
}

/** 锚点后的「散文」起点：遇到就把尾巴切掉（`【X】请将简历…`） */
const PROSE_CUT_RE = /请|需|须|简历|发送|投递|注意|备注|命名|注明|邮件|格式|标题|主题/;

/** 去掉片段的引导语与包裹标点：`格式：`、`请注明：`、`名为`、`“…”` */
export function stripLeadSegment(s: string): string {
  let t = String(s || '');
  const PUNCT = /^[\s:：,，、*·\-–—"'“”‘’（）()\[\]]+/;
  const LEAD_WORD =
    /^(格式|请注明|注明|请标明|标明|请写|写明|名为|名称为|要求为|要求|需注明|须注明|命名|为|是|写|填|填写|如下|及|和|与)+/;
  for (let i = 0; i < 3; i++) {
    const before = t;
    t = t.replace(PUNCT, '').replace(LEAD_WORD, '').replace(PUNCT, '');
    if (t === before) break;
  }
  // 片段里若出现引号/方括号，从第一个引号起截（把 `及附件文件名格式： “院校+专业+姓名”` 的前缀丢掉）
  const q = t.match(/["“「『【][\s\S]*$/);
  if (q) t = q[0];
  return t.replace(/[\s"'“”‘’]+$/, '').trim();
}

/** 锚点词：招聘方写「标题」也写「主题」 */
const ANCHOR_RE = /标题|主题/g;

/**
 * 从 JD 原文里抽出「标题要求」片段。
 *
 * 三路并行取候选，按可信度打分：
 *   ① 引号式（30）：要求被 `“”`/`「」`/`【】` 明确括起来，且 35 字内出现「标题/主题」
 *   ② 后置式（20）：以「标题/主题」为锚往后读（覆盖 `邮件标题：X` / `标题名为X`）
 *   ③ 前置式（25）：`以 X 为标题` / `按 X 命名标题`（要求写在锚点**之前**）
 *
 * @returns 要求原文；没抽到时返回 `null`（**不代表 JD 没写要求**，见 `looksDegraded`）
 */
export function extractSubjectRequirement(text: string): string | null {
  if (!text) return null;
  const cands: Array<{ raw: string; score: number }> = [];

  // ① 引号式
  const QUOTED = /["“「『【]([^"”」』】\n]{2,60})["”」』】]/g;
  for (const q of text.matchAll(QUOTED)) {
    const i = q.index!;
    const ctx = nearAnchor(text, i, q[0].length);
    if (!/标题|主题/.test(ctx) || NOISE_RE.test(ctx)) continue;
    const bracketed = /^[【\[]/.test(q[0]);
    // 🔴 `【】` 有两种用法，必须分开处理：
    //    (a) 只包住**字面前缀**（`【Java全栈】 - 姓名 - …`）⇒ 要求延伸到了本行剩余部分，要接上；
    //    (b) 包住**整个要求**（`【Java技术合伙人-姓名】`）⇒ 后面是散文，接上就被污染。
    //    判据：括号内部**含分隔符**就是 (b)。
    const innerHasSep = SEP_RE.test(normalizeSubjectText(q[1]));
    let raw: string;
    if (bracketed && !innerHasSep) {
      let tail = text.slice(i + q[0].length).split(TERMINATOR_RE)[0];
      const cut = tail.search(PROSE_CUT_RE);
      if (cut >= 0) tail = tail.slice(0, cut);
      raw = q[0] + tail;
    } else if (bracketed) {
      raw = q[0];
    } else {
      raw = q[1]; // 引号只是包裹符，取内层；`【】` 是格式的一部分，必须留着
    }
    if (!SEP_RE.test(normalizeSubjectText(raw))) continue;
    cands.push({ raw: raw.trim(), score: 30 });
  }

  // ② 后置式
  for (const m of text.matchAll(ANCHOR_RE)) {
    const i = m.index!;
    const afterRaw = text.slice(i + m[0].length, i + 100).split(TERMINATOR_RE)[0];
    const ctx = nearAnchor(text, i, m[0].length);
    if (NOISE_RE.test(ctx)) continue;
    const raw = stripLeadSegment(afterRaw);
    if (!raw || !SEP_RE.test(normalizeSubjectText(raw))) continue;
    cands.push({ raw, score: 20 });
  }

  // ③ 前置式
  const PRE = /(?:以|按|请按|按照|须以|需以|请注明|注明)\s*([^，。\n”"』」】]{2,60}?)\s*(?:命名|作为|为|叫做|写明)\s*[（(]?\s*(?:标题|主题)/g;
  for (const m of text.matchAll(PRE)) {
    const ctx = nearAnchor(text, m.index!, m[0].length);
    if (NOISE_RE.test(ctx)) continue;
    const raw = stripLeadSegment(m[1]);
    // 前置式形态更自由：没有分隔符时，整段是一个字段、或能用「及/和/与」拆成字段，也认
    if (!raw) continue;
    if (!isParsableSpec(raw)) continue;
    cands.push({ raw, score: 25 });
  }

  const valid = cands.filter(c => c.raw);
  if (!valid.length) return null;
  valid.sort((a, b) => b.score - a.score || b.raw.length - a.raw.length);
  return valid[0].raw;
}

/**
 * 「这一段确实是在写标题要求」的措辞特征。
 *
 * 🔴 刻意**不看上下文窗口里的噪音词**：OCR 打散的 JD 里，要求行与公众号页脚
 *    （`公众号 · 轻驱科技`）往往就隔一个换行，用「±25 字内不许出现公众号」这种判据
 *    会把真要求一起挡掉（实测 `轾驱科技` 就中招）。改成只看**锚点自身紧邻的措辞**，
 *    这样才能把「`为标题`」与「`文案标题编辑`」「`点击标题查看往期`」区分开。
 */
const REQUIREMENT_PHRASE_RE =
  /(?:标题|主题)[^，。\n“”]{0,12}?(?:格式|要求|请注明|注明|命名|标明)|(?:为|作为|命名为|叫做|叫作)\s*(?:邮件)?(?:标题|主题)|(?:邮件)?(?:标题|主题)\s*[：:]\s*\S/;

/**
 * JD 里**看起来**写了标题要求，但没抽出来 —— OCR 打散、或写法太野。
 *
 * 实测（芯聚能 / 轾驱）：要求被 OCR 拆到了相隔十几行的位置
 * （`…ower.com` 与 `聘岗位”为标题` 各占一行），任何基于邻近性的解析都救不回来。
 * **「抽不到」不等于「没有」** ⇒ 交给人工看一眼，不静默发默认标题。
 */
export function looksDegraded(text: string): boolean {
  if (!text) return false;
  return REQUIREMENT_PHRASE_RE.test(text);
}

// ── 原位替换 ──────────────────────────────────────────────────────────────────

/**
 * 没被替换掉的连续片段里，像「没填上的占位词」的（`应聘部门`、`应聘XXX岗位`）。
 * 🔴 中文那一支必须排在前面：`应聘XXX岗位` 整体才是占位词，只报 `XXX` 会让人看不懂。
 */
const PLACEHOLDER_RE =
  /[\u4e00-\u9fa5A-Za-z]{1,8}(?:部门|年限|名称|年份|时间|情况|要求|说明|岗位|专业|学校|学历|姓名|电话|城市|届)|[A-Za-z]{1,4}(?:XXX|××|XX|xx)[A-Za-z]{0,4}/;

/** 把一条要求 + 档案拼成标题计划（原位替换） */
export function planSubject(
  requirement: string | null,
  profile: SubjectProfile,
  job?: SubjectJobRef,
  opts?: { degraded?: boolean },
): SubjectPlan {
  const base = { requirement, degraded: opts?.degraded || undefined };
  if (!requirement) {
    return { ...base, subject: defaultSubject(profile, job), matched: false, parts: [], unresolved: [] };
  }

  const n = normalizeSubjectText(requirement);
  const parts: SubjectPart[] = [];
  const unresolved: string[] = [];
  const skippedRuns: string[] = [];
  let out = '';
  let run = '';
  let i = 0;

  while (i < n.length) {
    const rest = n.slice(i);
    const rule = FIELD_RULES.find(r => r.re.test(rest));
    if (!rule) {
      // 🔴 跳过的字符**必须原样写回 `out`** —— 分隔符、括号、空格都靠这条保留。
      //    （第一版漏了这句，结果 `学校名+专业+姓名` 拼成 `某某大学计算机科学与技术张三`。）
      out += n[i];
      run += n[i];
      i++;
      continue;
    }
    if (run) {
      skippedRuns.push(run);
      run = '';
    }
    const matched = rest.match(rule.re)![0];
    const value = rule.get(profile, job);
    if (value) {
      out += value;
      parts.push({ kind: 'field', text: matched, field: rule.field, value });
    } else {
      // 🔴 档案缺值：**原样留下占位词**并记未解决项，绝不静默留空（留空会拼出 `A+ +B`）
      out += matched;
      parts.push({ kind: 'field', text: matched, field: rule.field, value: '' });
      unresolved.push(`档案缺「${rule.field}」（要求里的「${matched}」）`);
    }
    i += matched.length;
  }
  if (run) skippedRuns.push(run);

  // 没被替换掉的片段里若还有占位词（`应聘部门`），说明这条要求我们拼不全
  for (const r of skippedRuns) {
    const hit = r.match(PLACEHOLDER_RE);
    if (hit) {
      parts.push({ kind: 'unknown', text: hit[0] });
      unresolved.push(`要求里有无从取值的片段「${hit[0]}」`);
    }
  }

  const seen = new Set<string>();
  const dedup = unresolved.filter(u => (seen.has(u) ? false : (seen.add(u), true)));

  return {
    ...base,
    subject: out.trim() || defaultSubject(profile, job),
    matched: dedup.length === 0,
    parts,
    unresolved: dedup,
  };
}

/** 兜底标题：JD 没写要求、或要求拼不出来时用。**必须诚实、不含猜测** */
export function defaultSubject(profile: SubjectProfile, job?: SubjectJobRef): string {
  const name = str(profile.name) || '应聘者';
  const pos = jobPositionLabel(job?.position, '');
  const phone = str(profile.phone);
  if (pos) return phone ? `应聘${pos}-${name}-${phone}` : `应聘${pos}-${name}`;
  return `应聘简历-${name}`;
}

/** 一遍到位：从 JD 原文直接得到标题计划 */
export function buildSubjectPlan(
  text: string,
  profile: SubjectProfile,
  job?: SubjectJobRef,
): SubjectPlan {
  const requirement = extractSubjectRequirement(text);
  return planSubject(requirement, profile, job, { degraded: !requirement && looksDegraded(text) });
}

/** 给人看的一句话说明（日志 / 面板共用） */
export function describeSubjectPlan(plan: SubjectPlan): string {
  if (!plan.requirement) {
    return plan.degraded
      ? `JD 里像是写了标题要求，但文本被打散（多为 OCR 产物），未能解析 —— 请人工核对后确认标题：${plan.subject}`
      : `JD 未写标题要求，用默认标题：${plan.subject}`;
  }
  if (plan.matched) return `按 JD 要求「${plan.requirement}」拼成：${plan.subject}`;
  return `JD 要求「${plan.requirement}」，但未能完全照做（${plan.unresolved.join('；')}），暂用：${plan.subject}`;
}
