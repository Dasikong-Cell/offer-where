/**
 * 简历制作（D 批）：**结构化草稿 + 渲染**
 * ==========================================================================
 * 与既有「一岗一简历」的关系（🔴 别搞混，两条链路刻意分开）：
 *   · `resumeRender.ts` 的 `buildResumeHtml()` —— 输入是「原简历原文 + 按 JD 定制结果」，
 *     服务于一岗一简历的**投递附件**。本次**一行未动**：既有产物必须字节不变。
 *   · 本文件的 `renderResumeDoc()` —— 输入是用户在制作台里编辑的**结构化草稿**，
 *     服务于「从零/半从零做一份简历」。
 *   两者共用同一套版式语言（A4、自包含、无外链），但**不共用函数**：一份走原文、
 *   一份走结构，硬合在一起会让任一边改动都波及另一边的产物。
 *
 * 为什么草稿是「结构」而不是「富文本」：
 *   结构化的字段才能被后续的匹配 / 定制 / 自动填充复用；存一段 HTML 就又变成一个
 *   只能人看的死文本，且 XSS 面敞开（渲染时必然要 innerHTML）。
 */
import { RESUME_ACCENTS, DEFAULT_ACCENT_KEY, RESUME_VARIANTS, DEFAULT_VARIANT_KEY } from './resumeTheme.js';

const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export interface ResumeDocBasics {
  name: string;
  phone: string;
  email: string;
  city: string;
  /** 求职意向 / 一句话抬头 */
  headline: string;
}

export interface ResumeDocSection {
  title: string;
  items: string[];
}

export interface ResumeDoc {
  id: string;
  title: string;
  basics: ResumeDocBasics;
  /** 个人简介 / 核心优势（一段话） */
  summary: string;
  /** 亮点条目 */
  highlights: string[];
  skills: string[];
  sections: ResumeDocSection[];
  theme: { accent: string; variant: string };
  updatedAt: string;
}

/** 长度上限（超出即截断）：草稿会被渲染进 PDF，无限长会把排版撑爆。 */
const LIMITS = { title: 60, name: 30, phone: 30, email: 60, city: 30, headline: 60, summary: 1200, item: 400, skill: 40 };

const cut = (s: unknown, n: number): string => String(s ?? '').trim().slice(0, n);
const arr = (v: unknown, n: number, per: number): string[] =>
  (Array.isArray(v) ? v : []).map((x) => cut(x, per)).filter(Boolean).slice(0, n);

/** 草稿 id：只允许「字母数字 - _」，其它一律替换 —— 它会进 app_kv 的 key 与文件名。 */
export function safeDocId(raw: unknown): string {
  const s = String(raw ?? '').trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return s.slice(0, 40) || 'doc';
}

/** 建一份空草稿。基本信息从档案带出来 —— 用户不该再手打一遍自己的名字。 */
export function newDoc(id: string, profile: Record<string, any> = {}): ResumeDoc {
  const p = profile || {};
  return {
    id: safeDocId(id),
    title: '我的简历',
    basics: {
      name: cut(p.name, LIMITS.name),
      phone: cut(p.phone, LIMITS.phone),
      email: cut(p.email, LIMITS.email),
      city: cut(p.expectedCity || p.city, LIMITS.city),
      headline: cut(p.expectedPositions, LIMITS.headline),
    },
    summary: '',
    highlights: [],
    skills: [],
    sections: [],
    theme: { accent: DEFAULT_ACCENT_KEY, variant: DEFAULT_VARIANT_KEY },
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 入站规整 —— 🔴 必须有这一层：草稿直接来自 `req.body`，
 *   ① 字符串化并截断（不然一段 10 万字的文本会被写进库、再渲染进 PDF）；
 *   ② 数组只认真数组（`{0:'a'}` 这类对象会被 `Array.isArray` 挡掉）；
 *   ③ 主题色**只认白名单 key**，不认任意颜色串 —— 放任任意串等于把 CSS 注入面开给用户。
 */
export function sanitizeDoc(input: any, base?: ResumeDoc): ResumeDoc {
  const src = (input && typeof input === 'object') ? input : {};
  const b = src.basics && typeof src.basics === 'object' ? src.basics : {};
  const t = src.theme && typeof src.theme === 'object' ? src.theme : {};
  const accent = RESUME_ACCENTS.some((a) => a.key === t.accent) ? String(t.accent) : (base?.theme?.accent || DEFAULT_ACCENT_KEY);
  // 版式同理走白名单：老草稿没有 variant 字段 ⇒ 落回 base 或默认（渲染结果与升级前一致）
  const variant = RESUME_VARIANTS.some((v) => v.key === t.variant)
    ? String(t.variant)
    : (base?.theme?.variant || DEFAULT_VARIANT_KEY);
  return {
    id: safeDocId(src.id ?? base?.id ?? 'doc'),
    title: cut(src.title ?? base?.title, LIMITS.title) || '我的简历',
    basics: {
      name: cut(b.name ?? base?.basics?.name, LIMITS.name),
      phone: cut(b.phone ?? base?.basics?.phone, LIMITS.phone),
      email: cut(b.email ?? base?.basics?.email, LIMITS.email),
      city: cut(b.city ?? base?.basics?.city, LIMITS.city),
      headline: cut(b.headline ?? base?.basics?.headline, LIMITS.headline),
    },
    summary: cut(src.summary ?? base?.summary, LIMITS.summary),
    highlights: arr(src.highlights ?? base?.highlights, 12, LIMITS.item),
    skills: arr(src.skills ?? base?.skills, 60, LIMITS.skill),
    sections: (Array.isArray(src.sections) ? src.sections : (base?.sections || [])).slice(0, 20).map((s: any) => ({
      title: cut(s?.title, 30),
      items: arr(s?.items, 40, LIMITS.item),
    })).filter((s: ResumeDocSection) => s.title || s.items.length),
    theme: { accent, variant },
    updatedAt: new Date().toISOString(),
  };
}

/** 取主题色；key 不在白名单时退回默认（调用方拿到的永远是合法颜色）。 */
export function accentColor(key: string): string {
  const hit = RESUME_ACCENTS.find((a) => a.key === key);
  return hit ? hit.color : RESUME_ACCENTS.find((a) => a.key === DEFAULT_ACCENT_KEY)!.color;
}

/**
 * 页眉 / 标题的版式 CSS，按原顺序三段拼装：header → .name/.headline/.contact → h2。
 * 🔴 `std` 分支必须与首个上线版**逐字节一致**：老草稿没有 variant 字段时会落到这里，
 *    升级不该让用户已导出过的样式变样。只有新增 variant 时才允许加分支，不许「顺手优化」std。
 */
function layoutCss(accent: string, variant: string): { header: string; who: string; h2: string; badgeTag: string } {
  switch (variant) {
    case 'line':
      return {
        header: `
  header { border-bottom: none; padding-bottom: 4px; margin-bottom: 13px; }`,
        who: `
  .name { font-size: 25px; font-weight: 700; letter-spacing: 1px; color: #111827;
          display: inline-block; border-bottom: 2px solid ${accent}; padding-bottom: 4px; }
  .headline { font-size: 12.5px; color: ${accent}; margin-top: 6px; font-weight: 600; }
  .contact { font-size: 11.6px; color: #4b5563; margin-top: 5px; }`,
        h2: `
  h2 { font-size: 13px; color: #111827; margin: 15px 0 6px; line-height: 1.25;
       border-bottom: 1.5px solid ${accent}; padding-bottom: 3px; }`,
        badgeTag: '',
      };
    case 'arc':
      return {
        header: `
  header { background: ${accent}; margin: -26px -34px 15px; padding: 24px 34px 18px;
           border-bottom: none; border-radius: 0 0 26px 26px; }`,
        who: `
  .name { font-size: 25px; font-weight: 700; letter-spacing: 1px; color: #ffffff; }
  .headline { font-size: 12.5px; color: rgba(255,255,255,.85); margin-top: 3px; font-weight: 600; }
  .contact { font-size: 11.6px; color: rgba(255,255,255,.92); margin-top: 5px; }`,
        h2: `
  h2 { font-size: 13px; color: ${accent}; margin: 15px 0 6px; line-height: 1.25;
       border-bottom: 2px solid ${accent}26; padding-bottom: 3px; }`,
        badgeTag: '',
      };
    case 'badge':
      return {
        header: `
  header { display: flex; align-items: center; gap: 13px;
           border-bottom: 1px solid ${accent}40; padding-bottom: 11px; margin-bottom: 13px; }
  .badge { flex: none; width: 46px; height: 46px; border-radius: 11px; background: ${accent};
           color: #ffffff; font-size: 21px; font-weight: 700;
           display: flex; align-items: center; justify-content: center; }
  .htext { min-width: 0; }`,
        who: `
  .name { font-size: 25px; font-weight: 700; letter-spacing: 1px; color: #111827; }
  .headline { font-size: 12.5px; color: ${accent}; margin-top: 3px; font-weight: 600; }
  .contact { font-size: 11.6px; color: #4b5563; margin-top: 5px; }`,
        h2: `
  h2 { font-size: 13px; color: #111827; margin: 15px 0 6px; line-height: 1.25;
       border-bottom: 1px solid ${accent}33; padding-bottom: 3px; }`,
        badgeTag: 'badge',
      };
    default: // std —— 首个上线版式，三段与原始字符串逐字节相同
      return {
        header: `
  header { border-bottom: 2.5px solid ${accent}; padding-bottom: 9px; margin-bottom: 13px; }`,
        who: `
  .name { font-size: 25px; font-weight: 700; letter-spacing: 1px; color: #111827; }
  .headline { font-size: 12.5px; color: ${accent}; margin-top: 3px; font-weight: 600; }
  .contact { font-size: 11.6px; color: #4b5563; margin-top: 5px; }`,
        h2: `
  h2 { font-size: 13px; color: ${accent}; margin: 15px 0 6px; padding-left: 8px;
       border-left: 3.5px solid ${accent}; line-height: 1.25; }`,
        badgeTag: '',
      };
  }
}

/**
 * 渲染成**自包含**的 A4 HTML（内联样式、无外链、无脚本）。
 * `theme.accent` 只影响配色，不影响结构 —— 换色不该让内容重排。
 */
export function renderResumeDoc(doc: ResumeDoc): string {
  const d = sanitizeDoc(doc);
  const accent = accentColor(d.theme.accent);
  const lay = layoutCss(accent, d.theme.variant);
  const name = d.basics.name || '求职者';
  const contact = [d.basics.phone, d.basics.email, d.basics.city].filter(Boolean).map(esc).join(' ｜ ');

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<title>${esc(name)} - ${esc(d.title)}</title>
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  body { font-family: "Microsoft YaHei", "PingFang SC", "Helvetica Neue", Arial, sans-serif;
         color: #1f2937; margin: 0; padding: 26px 34px; font-size: 12.2px; line-height: 1.62; }${lay.header}${lay.who}${lay.h2}
  p { margin: 3px 0; }
  ul { margin: 3px 0 3px 0; padding-left: 19px; }
  li { margin: 2.5px 0; }
  .hl li { margin: 3.5px 0; }
  .skills { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 4px; }
  .tag { background: ${accent}14; color: ${accent}; border: 1px solid ${accent}33;
         border-radius: 3px; padding: 1.5px 7px; font-size: 11.4px; }
  .summary { background: #f8fafc; border-left: 3px solid #94a3b8; padding: 8px 11px; margin-top: 4px; }
  .empty { color: #9ca3af; }
</style></head>
<body>
  <header>${lay.badgeTag === 'badge' ? `<div class="badge">${esc(name.slice(0, 1))}</div><div class="htext">` : ''}
    <div class="name">${esc(name)}</div>
    ${d.basics.headline ? `<div class="headline">${esc(d.basics.headline)}</div>` : ''}
    ${contact ? `<div class="contact">${contact}</div>` : ''}
  ${lay.badgeTag === 'badge' ? '</div>' : ''}</header>

  ${d.summary ? `<h2>个人简介</h2><div class="summary"><p>${esc(d.summary)}</p></div>` : ''}
  ${d.highlights.length ? `<h2>核心优势</h2><ul class="hl">${d.highlights.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>` : ''}
  ${d.skills.length ? `<h2>专业技能</h2><div class="skills">${d.skills.map((s) => `<span class="tag">${esc(s)}</span>`).join('')}</div>` : ''}
  ${d.sections.map((s) => `<h2>${esc(s.title)}</h2>${
    s.items.length ? `<ul>${s.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '<p class="empty">（空）</p>'
  }`).join('\n  ')}
  ${!d.summary && !d.highlights.length && !d.skills.length && !d.sections.length
    ? '<p class="empty">这份草稿还是空的 —— 在左侧填写内容，这里会实时更新。</p>' : ''}
</body></html>`;
}
