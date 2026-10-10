/**
 * 招聘邮箱扫描（**JD 正文优先** + 打开页面兜底），覆盖「微信推文 / 官网表单」类岗位。
 *
 * ── 为什么会有这个模块（2026-09-16~17 真机实测）──────────────────────
 * offerbiu 的「投递入口」绝大多数企业官网**不提供邮箱登录**（37 个官网站点实测 0 个；
 * 登录清一色是手机号/短信/微信扫码），因此表单通道很难无人值守跑通。
 * 但相当一部分岗位**正文里写着招聘邮箱**，走 `runOfferbiuEmail`（邮箱直投）无需登录即可
 * 全自动完成（实测 35/38 成功）⇒ 本模块负责把「哪些岗位有可用邮箱」扫出来。
 *
 * ── 2026-10-09 重构：旧实现的三处硬伤（均为真库实测数据，不是推测）────
 *  ① **只扫 `source:'offerbiu'`**。微信推文(292) + 纯官网表单(626) 确实都在 offerbiu 池内，
 *     但同类岗位也会从别的平台采进来 —— 实测「`jd` 里带邮箱」的 104 个岗位里 **chinahr 占 35**，
 *     旧过滤把它们整片漏掉。范围应当是「**apply_url 不在招聘平台自己域上**」，与 source 无关。
 *  ② **只会打开页面抓 `innerText`**。微信推文正文**全在图片里**：实测 `#js_content` 存在、
 *     `body.innerText` 仅 74~86 字、图片 12~16 张 ⇒ 这条路对推文**结构性失效**。
 *     而本仓库早有 `scripts/ocr_wechat_jd.ts` 把长图 OCR 成文本写进 `jobs.jd`
 *     （实测 `jd_source='image'` 220 条）——**邮箱其实早就躺在库里了**，只是没人去读。
 *  ③ 🔴 **跨公司隔离规则在托管域上把目标全杀**。规则是「企业自有域名邮箱 ≠ 岗位注册域 ⇒ 隔离」，
 *     而微信推文的注册域是 `qq.com`（`rootDomain('https://mp.weixin.qq.com/s/x') === 'qq.com'`）
 *     ⇒ 全池 102 个 JD 邮箱里 **89 个（87.3%）被判成「跨公司串号」**，真正的招聘邮箱一封都发不出去。
 *     更糟的是这个误判**不报错**：扫出来全是 ⚠ 标记，看日志只会以为「这批推文质量差」。
 *
 * ── 现在的做法 ─────────────────────────────────────────────────────
 *   • **JD 优先**：先从 `jobs.jd` 提邮箱（零网络成本、绕过图片正文、无 Chrome 也能跑）；
 *     JD 提不到才打开页面兜底（且推文类托管页**只走 JD** —— 打开也抓不到，纯浪费）。
 *   • **托管域停用域相等规则**（`SYNDICATION_DOMAIN`），换成两道更贴合的闸门：
 *       - **上下文证据**：邮箱周围要有「投递/简历/邮箱/hr…」字样（`evidence`）；没有则降为
 *         `low` 置信度并隔离，UI 默认不勾。
 *       - **共用邮箱检测**：同一邮箱出现在 **≥3 家不同公司** 下 ⇒ 必是页脚/平台样板，直接丢弃。
 *         实测 `ycjubao@58.com`（58/中华英才页脚的举报邮箱）横跨 35 个岗位、多家公司。
 *   • **平台域补全**：`iguopin / liepin / yingjiesheng / chinahr / 58` 都是「平台自己的页面」，
 *     要么已有专属引擎，要么它的 `jd` 就是平台页壳（上面那 35 条假命中正是这么来的）⇒ 排除。
 *
 * 供 API（`/api/offerbiu/scan-emails`）与命令行脚本共用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from '../db.js';
import { execCdpAction } from './cdpDriver.js';
import { buildSubjectPlan } from './apply/subjectSpec.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));

/** 取 offerbiu/official 的 CDP 端点（默认 9227） */
function officialEndpoint(): string {
  try {
    const p = path.join(__dir, '..', '..', 'data', 'browser', 'cdp.json');
    const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const ep = cfg?.official || cfg?.offerbiu;
    if (typeof ep === 'string' && ep.trim()) return ep.trim();
  } catch { /* ignore */ }
  return 'http://127.0.0.1:9227';
}

/** 读取页面纯文本（与 apply/common.ts 的 pageText 同逻辑，但支持显式端点） */
const TEXT_SCRIPT =
  "document.body ? (document.body.innerText || document.body.textContent || '').replace(/\\s+/g,' ').trim() : ''";

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** 明显非招聘用途/噪音邮箱，排除 */
const BAD_MAIL = /(example\.|sentry|w3\.org|qcloud|tencent\.com$|noreply|no-reply)/i;
/**
 * 🔴 已知**招聘平台自有域名**：这些 apply_url 是平台自己的页面，不是企业页面。
 *    排除理由有两层：① 其中多数已有专属投递引擎（zhipin/zhaopin/…），走邮箱反而是歪路；
 *    ② 它的 `jd` 是**平台页壳**而非企业正文 —— 实测 chinahr 35 个岗位的 `jd` 里唯一的邮箱
 *       是页脚的 `ycjubao@58.com`（举报邮箱），泛化扫描会凭空产出 35 条假命中。
 *    2026-10-09 补全：原清单只有 4 个域，漏了 iguopin/liepin/yingjiesheng/chinahr/58。
 */
export const PLATFORM_DOMAIN =
  /(zhipin\.com|zhaopin\.com|51job\.com|nowcoder\.com|iguopin\.com|liepin\.com|yingjiesheng\.com|chinahr\.com|58\.com|yupao\.com|shixiseng\.com)/i;
/**
 * **内容托管域**（推文 / 在线文档查看器）：页面只是「容器」，正文在图片里或客户端渲染里。
 *  ⇒ ① `innerText` 结构性抓不到正文（微信推文实测 74~86 字）；
 *     ② 「邮箱域 == 岗位注册域」这条判据**在这里不成立**（注册域属于托管商，如 `qq.com`）。
 *  命中这些域时只走 JD 正文，且改用上下文证据 + 共用邮箱检测把关。
 */
export const SYNDICATION_DOMAIN =
  /(mp\.weixin\.qq\.com|mp\.weixinbridge\.com|doc\.weixin\.qq\.com|docs\.qq\.com|alidocs\.dingtalk\.com|qr61\.cn)/i;
/** 「像招聘邮箱」的前缀/关键词 */
const HR_LIKE = /(hr|job|zhaopin|recruit|campus|xyzp|zp|career|talent|apply|offer|resume)/i;
/** 常见企业/个人邮箱主机：前缀不显眼但确实是招聘联系方式（如 aerospaceservo@163.com、hhsyzhp@126.com） */
const COMMON_MAIL_HOST = /@(126|163|qq|gmail|outlook|hotmail|foxmail|sina|sohu|139|aliyun|yeah|21cn|vip)\.[a-z]/i;
/** 占位/示例邮箱：模板与 OCR 噪声里的 `xxx@xxx.com` 之类，绝不是真实收件箱（实测真库存在） */
const PLACEHOLDER_MAIL = /^(?:x{2,}|test|your|abc|123|demo|sample|foo|bar|none|null)@|@(?:x{2,}|example|test|yourdomain|domain)\./i;
/** 明显不是招聘收件箱的职能邮箱：举报/客服/法务/无回复（实测 `ycjubao@58.com` 属此类） */
const NON_HR_MAIL = /(?:^|[._-])(?:noreply|no-reply|jubao|abuse|postmaster|webmaster|privacy|legal|kefu|feedback|customerservice)(?:[._-]|@)/i;
/** 通用前台邮箱（不是「没人看」，只是不确定是不是 HR ⇒ 标 generic 让人看见） */
const GENERIC_MAIL = /^(?:info|admin|office|master|mail)@/i;
/** 招聘上下文关键词（邮箱周围出现这些 ⇒ 它确实是本岗位的投递入口，而非文末互推/备案信息） */
const MAIL_CTX_CN = /(邮箱|邮件|简历|投递|应聘|申请|招聘|联系|咨询|人力|收件|发送至|发至)/;
/** `hr` 需按词边界匹配，否则会命中 URL 里的随机子串 */
const MAIL_CTX_HR = /(?:^|[^a-z])hr(?:[^a-z]|$)/i;

/** 邮箱种类（UI 用来提醒「这是个人邮箱/通用邮箱」） */
export type MailKind = 'corporate' | 'personal' | 'generic';
/** 命中来源：`jd` = 库内正文（含 OCR），`page` = 现打开页面抓的 */
export type HitOrigin = 'jd' | 'page';
/** 域相等规则的实际执行情况 */
export type DomainRule = 'enforced' | 'skipped-syndication' | 'skipped-no-root';
/**
 * 命中项的「需要人看一眼」标记（机器可读）。
 * ⚠️ 与 `quarantine` 的区别：`flags` 只影响 **UI 默认勾选状态**；
 *    `quarantine` 是**投递前的硬闸门**（不带 force 直接 skip），且落在 DB 列上。
 */
export type MailFlag = 'cross-company' | 'low-context' | 'ocr-derived' | 'short-local';

/** 一个候选邮箱 + 它的上下文证据 */
export interface MailCandidate {
  email: string;
  /** 周围出现「投递/简历/邮箱/hr…」⇒ 它确实是招聘联系方式 */
  evidence: boolean;
  /** 证据片段（压缩空白、截断），供人工复核 —— 发信不可撤回，必须让人看见「为什么是它」 */
  around: string;
}

/** 取注册域（近似）：用于校验「确实导航到了目标站点」。多级后缀如 com.cn / co.uk 取 3 段。 */
export function rootDomain(u: string): string {
  try {
    const h = new URL(u).hostname.toLowerCase().replace(/^www\./, '');
    const parts = h.split('.');
    if (parts.length <= 2) return h;
    const last2 = parts.slice(-2).join('.');
    if (/^(com|net|org|gov|edu|co|ac)\.(cn|uk|jp|hk|tw)$/.test(last2)) return parts.slice(-3).join('.');
    return last2;
  } catch {
    return '';
  }
}

/** 取邮箱域（小写）。不合法/为空返回 '' */
export function domainOf(email: string): string {
  const i = String(email || '').lastIndexOf('@');
  return i > 0 ? String(email).slice(i + 1).toLowerCase() : '';
}

/** apply_url 是否属于「招聘平台自己的页面」（⇒ 不该用邮箱通道） */
export function isPlatformUrl(u: string): boolean {
  return PLATFORM_DOMAIN.test(String(u || ''));
}

/** apply_url 是否落在内容托管域（推文/在线文档）⇒ 只走 JD 正文 */
export function isSyndicationUrl(u: string): boolean {
  return SYNDICATION_DOMAIN.test(String(u || ''));
}

/**
 * 是否属于「邮箱直投扫描的候选岗位」：有 `apply_url` 且**不在招聘平台自有域上**。
 * 单独抽成导出函数是为了**可测**：合约里能用合成 URL 直接验判据，
 * 而不必依赖「库里恰好有平台页岗位」这种环境事实。
 */
export function isEmailScanCandidateUrl(u: string): boolean {
  return !!u && !isPlatformUrl(u);
}

const hasMailContext = (s: string): boolean => MAIL_CTX_CN.test(s) || MAIL_CTX_HR.test(s);

/**
 * 从文本提取邮箱候选（去重、去噪、去占位符、小写），并**逐条带上上下文证据**。
 *
 * 为什么不能只返回 `string[]`：微信推文文末常有「往期推荐 / 其他单位招聘」互推段，
 * 那些段落里的邮箱也带「投递邮箱」字样 ⇒ 单看邮箱本身无法判断归属。把 ±60 字上下文
 * 一起交给人工（和 UI）复核，是「发信不可撤回」这件事唯一现实的防线。
 */
export function extractMailCandidates(text: string): MailCandidate[] {
  const s = String(text || '');
  const lower = s.toLowerCase();
  const found = s.match(EMAIL_RE) || [];
  const out: MailCandidate[] = [];
  const seen = new Set<string>();
  for (const raw of found) {
    const email = raw.toLowerCase();
    if (seen.has(email)) continue;
    if (BAD_MAIL.test(email) || PLACEHOLDER_MAIL.test(email) || NON_HR_MAIL.test(email)) continue;
    seen.add(email);
    const i = lower.indexOf(email);
    const around = i < 0 ? '' : s.slice(Math.max(0, i - 60), i + email.length + 60).replace(/\s+/g, ' ').trim();
    out.push({ email, evidence: hasMailContext(around), around: around.slice(0, 110) });
  }
  return out;
}

/** 从文本提取邮箱（去重、去噪、小写）。保留旧签名 —— 外部自检脚本按此调用。 */
export function extractEmails(text: string): string[] {
  return extractMailCandidates(text).map((c) => c.email);
}

/** 邮箱种类 */
export function mailKindOf(email: string): MailKind {
  if (COMMON_MAIL_HOST.test(email)) return 'personal';
  if (GENERIC_MAIL.test(email)) return 'generic';
  return 'corporate';
}

export interface MailVerdict {
  /** 需要人工确认（存在时默认跳过投递，需 force 才发）。受 DB `jobs.quarantine` 列承载。 */
  quarantine?: string;
  /** 域相等规则的实际执行情况（`skipped-*` 是**有意跳过**，不是漏判） */
  domainRule: DomainRule;
}

/**
 * 判定一个邮箱的**归属**是否可信（纯函数，无 IO）。
 *
 * 🔴 关键分支：**托管域（微信推文）上「邮箱域 == 岗位注册域」这条判据必须停用**。
 *    推文的注册域属于托管商（`mp.weixin.qq.com` → `qq.com`），拿它跟企业自有域名邮箱比，
 *    等于要求「招聘邮箱必须以 qq.com 结尾」—— 实测会把 89/102（87.3%）的真实招聘邮箱
 *    全判成跨公司串号。停用之后由两道更贴合的闸门接手：
 *      ① 上下文证据（`evidence`）：没有「投递/简历/邮箱」字样的降为 low 置信度；
 *      ② 共用邮箱检测（`detectSharedMailboxes`）：跨多家公司出现的样板邮箱直接丢弃。
 *    `domainRule` 字段把「有意跳过」显式记录出来 —— 否则后人（和破坏性对照）无法区分
 *    「这里漏判了」与「这里按设计跳过了」。
 *
 * ⚠️ 本函数**只回答「这个邮箱属于这家公司吗」**。像「邮箱来自 OCR，字符可能被截断」
 *    这类**证据链质量**问题不放这里 —— 那是 `buildHit` 的 `flags`，不该写进
 *    `jobs.quarantine`（那一列在别处还承担「投递前必须人工放行」的硬闸门语义，
 *    把 OCR 提示塞进去会把两件事混成一件）。
 */
export function judgeMailbox(
  email: string,
  applyUrl: string,
  opts: { syndication?: boolean; evidence?: boolean } = {},
): MailVerdict {
  const emailDomain = domainOf(email);
  const siteRoot = rootDomain(applyUrl || '');
  const syndication = opts.syndication === true || isSyndicationUrl(applyUrl);

  if (syndication) {
    return opts.evidence === true
      ? { domainRule: 'skipped-syndication' }
      : {
        domainRule: 'skipped-syndication',
        quarantine: 'low-context: 该邮箱周围没有「投递/简历/邮箱」等上下文（可能是文末互推或 OCR 串行）',
      };
  }
  if (!siteRoot) return { domainRule: 'skipped-no-root' };
  const corporate =
    !COMMON_MAIL_HOST.test(email) && !/^(?:hr|zhaopin|recruit|campus|job|career|talent|apply|offer|resume)[.-]/i.test(email);
  if (corporate && emailDomain && emailDomain !== siteRoot) {
    return { domainRule: 'enforced', quarantine: `cross-company: 邮箱域 ${emailDomain} ≠ 岗位域 ${siteRoot}` };
  }
  return { domainRule: 'enforced' };
}

/**
 * 邮箱用户名短得可疑（`s@iflytek.com`）。
 * 实测来源：OCR 把「campus@iflytek.com」这类地址的前几个字符吞掉，只剩尾字母。
 * 这类地址**可能仍能投递**，但更可能是一个陌生人的邮箱 ⇒ 只降级（默认不勾），不硬拦。
 */
export function suspiciousShortLocal(email: string): boolean {
  const local = String(email || '').split('@')[0] || '';
  if (local.length > 2) return false;
  return !/^(?:hr|zp|jx|cn|go|hi|me|it|ai|we|ad|vc|js|job)$/i.test(local);
}

/**
 * 同一邮箱出现在多少家**不同公司**下（纯函数）。
 * ≥ `SHARED_MAILBOX_MIN_COMPANIES` 家 ⇒ 判定为平台页脚/样板邮箱，扫描时直接丢弃。
 *
 * 阈值取 3 而不是 2：同一家公司在多个岗位重复挂同一个 HR 邮箱是**正常**的
 *（实测「红树林基金会」两个岗位共用 `yinyuzhu@mcf.org.cn`），按邮箱去重会把它们误杀；
 * 按**不同公司名**计数才是「这个邮箱不属于某一家」的正确信号。
 */
export const SHARED_MAILBOX_MIN_COMPANIES = 3;

export function detectSharedMailboxes(
  entries: Array<{ email: string; company?: string | null }>,
): Map<string, string[]> {
  const idx = new Map<string, Set<string>>();
  for (const e of entries) {
    const key = String(e.email || '').toLowerCase();
    if (!key) continue;
    const company = String(e.company || '').trim() || '(未知公司)';
    if (!idx.has(key)) idx.set(key, new Set());
    idx.get(key)!.add(company);
  }
  const out = new Map<string, string[]>();
  for (const [email, companies] of idx) {
    if (companies.size >= SHARED_MAILBOX_MIN_COMPANIES) out.set(email, [...companies]);
  }
  return out;
}

export interface EmailHit {
  jobId: string;
  company: string;
  position: string;
  city?: string | null;
  email: string;
  applyUrl: string;
  /** 命中来源：库内正文（含 OCR）/ 现打开页面 */
  origin: HitOrigin;
  /**
   * 置信度：`high` = 无任何 flag（可直接投）；`low` = 有 flag（**UI 默认不勾**，人工核对后再勾）。
   * 之所以做成「无 flag 才 high」而不是各维度加权：发信不可撤回，宁可让用户多点几次，
   * 也不要让一条「凑巧没被规则拦住」的地址自动发出去。
   */
  confidence: 'high' | 'low';
  /** 邮箱种类（个人邮箱/通用前台邮箱需要人看一眼） */
  mailKind: MailKind;
  /** 证据片段（±60 字）—— 人工复核的依据 */
  context: string;
  /** 邮箱来自 OCR 文本（`jd_source='image'`）⇒ 字符可能是长图识别产物，可能被截断/串行 */
  ocrDerived: boolean;
  /** 需要人看一眼的标记（决定 UI 是否默认勾选） */
  flags: MailFlag[];
  /** 同一邮箱还被另外 N 个岗位引用（已折叠，避免给同一个收件箱重复投递） */
  foldedJobs: number;
  /**
   * JD 原文里写的「邮件标题要求」片段（`邮件标题格式：学历+专业+学校+姓名` → `学历+专业+学校+姓名`）。
   *
   * 2026-10-10 加：起因是**用真库 14 条含「标题」的 JD 压旧解析器只成功 1 条** ——
   * 招聘方白纸黑字写了格式，我们 13 条全用了默认标题，而且不报错。
   * 这个字段的意义就是让用户在**点投递之前**看见招聘方到底要求什么。
   */
  subjectRequirement?: string | null;
  /** 我们会用的标题（按上面的要求拼；拼不出则是诚实的默认标题） */
  subjectPreview?: string;
  /** 看得见有要求、但文本被打散（多为 OCR 产物）⇒ 必须人工核对，别当「没要求」 */
  subjectDegraded?: boolean;
  /** 需人工确认的原因；存在时默认跳过投递，**需 force 才发**（落在 DB `jobs.quarantine` 列上） */
  quarantine?: string;
}

/** 岗位池覆盖统计：让 UI 能说清「为什么只扫出这么点」 */
export interface EmailPoolStats {
  /** 候选池（非平台域岗位，按 apply_url 去重） */
  total: number;
  /** 其中推文/在线文档托管页 */
  syndication: number;
  /** `jd` 正文非空（含 OCR 结果）—— 「JD 优先」这条路的可提池 */
  withJd: number;
  /** `jd` 正文含 `@`（粗筛；实际可用邮箱见 found） */
  jdWithAt: number;
  /** 其中「有 JD 正文但没跑过 OCR」的推文条数（提示用户先跑 ocr_wechat_jd.ts） */
  syndicationNoJd: number;
}

export interface ScanProgress {
  type: 'progress';
  index: number;
  total: number;
  company: string;
  message: string;
}

export type EmailScanScope = 'all' | 'wechat' | 'site';

export interface ScanOpts {
  limit?: number;
  offset?: number;
  /**
   * 求职者档案（可选）。给了才能在扫描结果里**预览最终邮件标题**（`subjectPreview`）。
   *
   * 不给也照样扫 —— 那时只回 `subjectRequirement`（招聘方要求的原文）。
   * 刻意**不拿空档案凑一个标题**：空档案拼出来的会是 `学历+专业+学校+姓名` 这种
   * 残留占位词，让人误以为那就是要发的标题。宁可不显示。
   */
  profile?: import('./apply/subjectSpec.js').SubjectProfile;
  /** 仅保留「像招聘邮箱」的（默认 true）。判定放宽为「前缀像 HR **或** 常见邮箱主机 **或** 有上下文证据」*/
  hrLikeOnly?: boolean;
  /** 每站停留毫秒（等 SPA 渲染），默认 2400 */
  settleMs?: number;
  /** 并发标签数（1~5，默认 1）。同一 Chrome 内开多个标签并行扫描 */
  workers?: number;
  /** CDP 端点，默认取 cdp.json 的 official（http://127.0.0.1:9227） */
  endpoint?: string;
  /** 岗位范围：`all` 全部 / `wechat` 仅推文托管页 / `site` 仅官网表单 */
  scope?: EmailScanScope;
  /** 只处理 `jd` 正文非空的岗位 */
  hasJdOnly?: boolean;
  /** 只用 `jd` 正文提邮箱，**不开浏览器**（零网络成本，无 Chrome 也能跑） */
  jdOnly?: boolean;
  /** 可选 source 白名单（如 `offerbiu`）；不传即全平台 */
  source?: string;
  onProgress?: (ev: ScanProgress) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 并发用的上下文键（同一个 9227 端点，各自独立标签页） */
const CTX_KEYS = ['official', 'official2', 'official3', 'official4', 'official5'];

/**
 * 邮箱直投候选岗位：有 `apply_url` 且**不是招聘平台自己的页面**，按 apply_url 去重。
 *
 * 🔴 不再写死 `source:'offerbiu'`：微信推文(292) 与纯官网表单(626) 固然都在 offerbiu 池内，
 *    但同类岗位也会从别的平台采进来（实测 chinahr 有 35 个岗位的 jd 带邮箱）。
 *    「同一个 apply_url 被多个岗位引用」时只扫一次 —— 否则同一篇推文会被重复扫 N 遍。
 */
export function listEmailScanCandidates(opts: { scope?: EmailScanScope; source?: string } = {}): any[] {
  const scope: EmailScanScope = opts.scope === 'wechat' || opts.scope === 'site' ? opts.scope : 'all';
  const rows = db.listJobs(opts.source ? { source: opts.source } : {}) as any[];
  const seen = new Set<string>();
  const out: any[] = [];
  for (const j of rows) {
    const url = j?.apply_url;
    if (!isEmailScanCandidateUrl(url)) continue;
    const synd = isSyndicationUrl(url);
    if (scope === 'wechat' && !synd) continue;
    if (scope === 'site' && synd) continue;
    const key = String(url).trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(j);
  }
  return out;
}

/** 按范围算岗位池统计（纯读库，无网络） */
export function emailPoolStats(scope: EmailScanScope = 'all', source?: string): EmailPoolStats {
  const jobs = listEmailScanCandidates({ scope, source });
  let syndication = 0;
  let withJd = 0;
  let jdWithAt = 0;
  let syndicationNoJd = 0;
  for (const j of jobs) {
    const synd = isSyndicationUrl(j.apply_url);
    if (synd) syndication++;
    const jd = String(j.jd || '');
    if (jd.trim()) {
      withJd++;
      if (jd.includes('@')) jdWithAt++;
    } else if (synd) {
      syndicationNoJd++;
    }
  }
  return { total: jobs.length, syndication, withJd, jdWithAt, syndicationNoJd };
}

/** 扫描时的共享上下文 */
interface ScanCtx {
  ep: string;
  settleMs: number;
  hrLikeOnly: boolean;
  jdOnly: boolean;
  /** 共用邮箱表（email → 命中过的公司名列表） */
  shared: Map<string, string[]>;
  /** 求职者档案；缺省则不生成 `subjectPreview`（见 `ScanOpts.profile` 的说明） */
  profile?: import('./apply/subjectSpec.js').SubjectProfile;
}

/**
 * 「像招聘邮箱」的保留判定。
 * 放宽为「前缀像 HR **或** 落在常见邮箱主机 **或** 有上下文证据」——
 * 只用前缀一条会把 `zhanghua@haocang.com`（人名做前缀的真实 HR 邮箱）整片丢掉。
 */
function keepCandidates(cands: MailCandidate[], ctx: ScanCtx): MailCandidate[] {
  const usable = cands.filter((c) => !ctx.shared.has(c.email));
  if (!ctx.hrLikeOnly) return usable;
  return usable.filter((c) => HR_LIKE.test(c.email) || COMMON_MAIL_HOST.test(c.email) || c.evidence);
}

/** 把「选中的候选邮箱」落成 EmailHit，并同步 jobs.quarantine */
function buildHit(
  j: any,
  cand: MailCandidate,
  origin: HitOrigin,
  altCount: number,
  onProgress: ((ev: ScanProgress) => void) | undefined,
  idx: number,
  total: number,
  company: string,
  profile?: import('./apply/subjectSpec.js').SubjectProfile,
): EmailHit {
  const verdict = judgeMailbox(cand.email, j.apply_url, {
    syndication: isSyndicationUrl(j.apply_url),
    evidence: cand.evidence,
  });
  if (verdict.quarantine) db.updateJob(j.id, { quarantine: verdict.quarantine });
  else db.updateJob(j.id, { quarantine: null });

  const ocrDerived = origin === 'jd' && String(j.jd_source || '') === 'image';
  const flags: MailFlag[] = [];
  if (verdict.quarantine) flags.push(verdict.quarantine.startsWith('cross-company') ? 'cross-company' : 'low-context');
  if (ocrDerived) flags.push('ocr-derived');
  if (suspiciousShortLocal(cand.email)) flags.push('short-local');

  // 「招聘方要求的邮件标题」——扫描阶段就算出来，好在**投递之前**给人看。
  // 但**不进 flags**：拼不出标题不该拦投递（那是「邮件内容不够贴合」，不是「发错人」），
  // 所以它只影响展示与日志，不影响 confidence/默认勾选。
  const subjectPlan = buildSubjectPlan(String(j.jd || ''), profile || {}, { position: j.position, company });

  onProgress?.({
    type: 'progress', index: idx, total, company,
    message: `  ✓ ${origin === 'jd' ? 'JD 正文' : '页面'}发现招聘邮箱 ${cand.email}`
      + (altCount > 1 ? `（另有 ${altCount - 1} 个）` : '')
      + (flags.length ? ` ⚠ 待人工确认（${flags.join(' / ')}）` : '')
      + `；标题：${subjectPlan.requirement ? `按 JD 要求「${subjectPlan.requirement}」` : (subjectPlan.degraded ? 'JD 有要求但被 OCR 打散，待人工核对' : 'JD 未写要求')}`,
  });
  return {
    jobId: j.id, company, position: j.position || '', city: j.city,
    email: cand.email, applyUrl: j.apply_url,
    origin, confidence: flags.length ? 'low' : 'high', mailKind: mailKindOf(cand.email),
    context: cand.around, ocrDerived, flags, foldedJobs: 0,
    subjectRequirement: subjectPlan.requirement,
    // 只有拿到档案才回 preview —— 空档案拼出来的是残留占位词，会让人误以为那就是要发的标题
    ...(profile ? { subjectPreview: subjectPlan.subject } : {}),
    ...(subjectPlan.degraded ? { subjectDegraded: true } : {}),
    ...(verdict.quarantine ? { quarantine: verdict.quarantine } : {}),
  };
}

/** 扫描单个岗位：JD 优先 → 页面兜底（托管域只走 JD） */
async function scanOne(
  ctxKey: string,
  j: any,
  idx: number,
  total: number,
  o: ScanCtx,
  onProgress?: (ev: ScanProgress) => void,
): Promise<EmailHit | null> {
  const company = j.company || '';
  const syndication = isSyndicationUrl(j.apply_url);
  onProgress?.({
    type: 'progress', index: idx, total, company,
    message: `扫描 ${company || j.apply_url}${syndication ? '（推文/在线文档托管页）' : ''}`,
  });

  try {
    // ① JD 优先：邮箱已在库里（含 OCR 结果）⇒ 零网络成本，也不用开浏览器。
    const raw = extractMailCandidates(String(j.jd || ''));
    const jdCands = keepCandidates(raw, o);
    if (jdCands.length) {
      const best = jdCands.find((c) => c.evidence) || jdCands[0];
      return buildHit(j, best, 'jd', jdCands.length, onProgress, idx, total, company, o.profile);
    }
    if (raw.length) {
      const sharedHit = raw.find((c) => o.shared.has(c.email));
      onProgress?.({
        type: 'progress', index: idx, total, company,
        message: sharedHit
          ? `  JD 里 ${raw.length} 个邮箱均被过滤（含平台样板邮箱 ${sharedHit.email}，横跨多家公司）`
          : `  JD 里 ${raw.length} 个邮箱均被过滤（占位/非招聘/不像招聘邮箱）`,
      });
    }

    if (o.jdOnly || syndication) {
      onProgress?.({
        type: 'progress', index: idx, total, company,
        message: syndication
          ? '  库内 JD 无可用邮箱 —— 推文正文在图片里，请先跑 scripts/ocr_wechat_jd.ts'
          : '  库内 JD 无可用邮箱（已按「只用 JD」跳过打开页面）',
      });
      return null;
    }

    // ② 页面兜底：导航 → 校验注册域（防串号）→ 抓正文
    const nav: any = await execCdpAction(ctxKey, 'navigate', { url: j.apply_url, timeout: 25000 }, o.ep).catch(() => undefined);
    // ⚠️ 导航失败/超时时页面文本仍是「上一页」内容，会串号（实测 通登资管→campus@hikvision.com）。
    const wantRoot = rootDomain(j.apply_url);
    const gotRoot = rootDomain(String(nav?.url || ''));
    if (wantRoot && gotRoot !== wantRoot) {
      onProgress?.({ type: 'progress', index: idx, total, company, message: `  跳过：未成功导航（期望 ${wantRoot}，实际 ${gotRoot || '空'}）` });
      return null;
    }
    await sleep(o.settleMs);
    const r: any = await execCdpAction(ctxKey, 'eval', { script: TEXT_SCRIPT }, o.ep).catch(() => undefined);
    const pageCands = keepCandidates(extractMailCandidates(String(r?.data || '')), o);
    if (pageCands.length) {
      const best = pageCands.find((c) => c.evidence) || pageCands[0];
      return buildHit(j, best, 'page', pageCands.length, onProgress, idx, total, company, o.profile);
    }
    onProgress?.({ type: 'progress', index: idx, total, company, message: '  未发现招聘邮箱（该岗位需人工/官网表单）' });
    return null;
  } catch (e: any) {
    onProgress?.({ type: 'progress', index: idx, total, company, message: `  扫描失败：${e?.message || e}` });
    return null;
  }
}

/** 扫描结果 */
export interface ScanResult {
  scanned: number;
  found: EmailHit[];
  pool: EmailPoolStats;
  /** 被「共用邮箱」闸门丢弃的邮箱数（email → 命中公司数） */
  sharedDropped: Array<{ email: string; companies: number }>;
}

/**
 * 扫描「微信推文 / 官网表单」类岗位的招聘邮箱。
 *
 * 名字保留 `scanOfferbiuEmails` 是为了不破坏既有调用方，但它**已不再限定 offerbiu**：
 * 范围由 `scope` / `source` 决定，默认覆盖所有「apply_url 不在平台自有域上」的岗位。
 */
export async function scanOfferbiuEmails(opts: ScanOpts = {}): Promise<ScanResult> {
  const limit = Math.max(1, Math.min(Number(opts.limit) || 20, 5000));
  const offset = Math.max(0, Number(opts.offset) || 0);
  const settleMs = Math.max(800, Number(opts.settleMs) || 2400);
  const hrLikeOnly = opts.hrLikeOnly !== false;
  const workers = Math.max(1, Math.min(Number(opts.workers) || 1, CTX_KEYS.length));
  const scope: EmailScanScope = opts.scope === 'wechat' || opts.scope === 'site' ? opts.scope : 'all';
  const source = opts.source ? String(opts.source) : undefined;

  // 共用邮箱预扫：必须看**全池**（不能只看本次 slice）—— 平台页脚邮箱的价值就在于
  // 它横跨多家公司，只看一小片窗口是发现不了的。
  const all = listEmailScanCandidates({ scope, source });
  const mailIndex: Array<{ email: string; company: string }> = [];
  for (const j of all) {
    for (const c of extractMailCandidates(String(j.jd || ''))) mailIndex.push({ email: c.email, company: j.company || '' });
  }
  const shared = detectSharedMailboxes(mailIndex);

  const pool = emailPoolStats(scope, source);
  const jobs = opts.hasJdOnly === true ? all.filter((j) => String(j.jd || '').trim()) : all;
  const slice = jobs.slice(offset, offset + limit);

  const ctx: ScanCtx = { ep: opts.endpoint || officialEndpoint(), settleMs, hrLikeOnly, jdOnly: opts.jdOnly === true, shared };
  const found: EmailHit[] = [];
  // 同一邮箱被多个岗位引用（同一家公司一次挂多个岗）⇒ **折叠成一条**：否则一次投递会给
  // 同一个收件箱连发 N 封几乎一样的简历（实测「红树林基金会」两个岗位共用同一邮箱）。
  const byMail = new Map<string, EmailHit>();
  const collect = (hit: EmailHit | null) => {
    if (!hit) return;
    const prev = byMail.get(hit.email);
    if (prev) { prev.foldedJobs++; return; }
    byMail.set(hit.email, hit);
    found.push(hit);
  };
  const sharedDropped = [...shared.entries()].map(([email, companies]) => ({ email, companies: companies.length }));
  sharedDropped.sort((a, b) => b.companies - a.companies);

  if (workers === 1) {
    for (let i = 0; i < slice.length; i++) {
      collect(await scanOne(CTX_KEYS[0], slice[i], i, slice.length, ctx, opts.onProgress));
    }
    return { scanned: slice.length, found, pool, sharedDropped };
  }

  // 并发：把岗位轮流分给 N 个标签页
  const buckets: Array<Array<{ j: any; i: number }>> = Array.from({ length: workers }, () => []);
  slice.forEach((j, i) => buckets[i % workers].push({ j, i }));
  const results = await Promise.all(
    buckets.map((bucket, wi) =>
      (async () => {
        const out: EmailHit[] = [];
        for (const { j, i } of bucket) {
          const hit = await scanOne(CTX_KEYS[wi], j, i, slice.length, ctx, opts.onProgress);
          if (hit) out.push(hit);
        }
        return out;
      })(),
    ),
  );
  for (const arr of results) arr.forEach(collect);
  return { scanned: slice.length, found, pool, sharedDropped };
}
