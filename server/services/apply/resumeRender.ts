/**
 * 定制简历 HTML 渲染（一岗一简历的「出稿」环节）
 * ==========================================================================
 * 输入：我的档案 + 原简历解析结构 + `tailorResume()` 的定制结果
 * 输出：一份**自包含**的 A4 HTML（内联样式，无外链），交给 cdpDriver 的 `htmlToPdf`
 *       用 Chrome 排版成 PDF，作为邮件附件 / 上传件。
 *
 * 设计要点：
 *  1. **只放面向 HR 的内容**：不含「匹配度 73/100」「待补 2 项」这类**内部**分析 ——
 *     把内部打分印在给 HR 的简历上是不专业的。
 *  2. **信息零丢失**：定制部分（核心优势 + 技能重排）之外，原简历正文**完整保留**，
 *     只把原文里那个「专业技能」段落替换成重排后的版本（否则会重复出现两次）。
 *  3. 渲染原文本时按行做启发式分行（小标题 / 项目符号 / 正文），保证可读性。
 */

export interface RenderInput {
  profile: Record<string, any>;
  /** 原简历解析结果（education/experience/projects/skills 为按行切分的数组） */
  struct: {
    rawText: string;
    name?: string | null;
    phone?: string | null;
    email?: string | null;
    education?: string[];
    experience?: string[];
    projects?: string[];
    skills?: string[];
  };
  tailored: {
    company: string;
    position: string;
    summary: string;
    highlights: string[];
    orderedSkills: string[];
  };
}

const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** 看起来像「小标题」的行：短、无句末标点、含常见栏目标签 */
const SECTION_RE = /^(个人|基本|联系|求职|意向|教育|学历|工作|实习|实践|项目|技能|专业|证书|荣誉|获奖|自我|评价|校园|社会|语言|培训|科研|论文|专利|概览|简介|SUMMARY|SKILL|EXPERIENCE|EDUCATION|PROJECT)/i;
const isSectionHeader = (line: string): boolean =>
  line.length <= 14 && SECTION_RE.test(line) && !/[。；;]$/.test(line);

/** 技能类栏目（我们会用重排版本替换它，避免重复） */
const SKILL_SECTION_RE = /^(专业技能|技能|技术栈|技能特长|SKILLS?)/i;

interface Block { header: string; lines: string[] }

/** 把简历纯文本切成「小标题 + 内容行」的块 */
export function splitResumeBlocks(rawText: string): Block[] {
  const lines = String(rawText || '').replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
  const blocks: Block[] = [];
  let cur: Block | null = null;
  for (const line of lines) {
    const m = line.match(/^[·•\-*•]\s*(.+)$/);
    if (isSectionHeader(line)) {
      cur = { header: line, lines: [] };
      blocks.push(cur);
      continue;
    }
    if (!cur) { cur = { header: '', lines: [] }; blocks.push(cur); }
    cur.lines.push(m ? `• ${m[1]}` : line);
  }
  return blocks;
}

function renderBlock(b: Block): string {
  const body = b.lines.map((l) =>
    /^•\s/.test(l)
      ? `<li>${esc(l.slice(2))}</li>`
      : `<p>${esc(l)}</p>`,
  ).join('');
  // 把连续的 li 包进 ul（简单起见：只要块里有 li 就整体包一层 ul）
  const hasLi = b.lines.some((l) => /^•\s/.test(l));
  const inner = hasLi
    ? b.lines.map((l) => (/^•\s/.test(l) ? `<li>${esc(l.slice(2))}</li>` : `</ul><p>${esc(l)}</p><ul>`)).join('')
    : body;
  const fixed = hasLi ? `<ul>${inner}</ul>` : body;
  return `${b.header ? `<h2>${esc(b.header)}</h2>` : ''}${fixed}`;
}

/** 生成自包含的 A4 简历 HTML */
export function buildResumeHtml({ profile, struct, tailored }: RenderInput): string {
  const name = struct.name || profile.name || '求职者';
  const contact = [
    struct.phone || profile.phone,
    struct.email || profile.email,
    profile.expectedCity || profile.city,
  ].filter(Boolean).map(esc).join(' ｜ ');

  const blocks = splitResumeBlocks(struct.rawText);
  // 丢掉原文的技能段（下面用「按岗位相关度重排」的版本替代）
  const kept = blocks.filter((b) => !(b.header && SKILL_SECTION_RE.test(b.header)));
  // 丢掉原文最顶部的姓名/联系方式块（我们用统一的 header 渲染）
  const bodyBlocks = kept.filter((b) => !(b.header === '' && b.lines.length <= 3 && !b.lines[0]?.length));

  const skills = (tailored.orderedSkills || []).slice(0, 40);

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<title>${esc(name)} - ${esc(tailored.position)}</title>
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  body { font-family: "Microsoft YaHei", "PingFang SC", "Helvetica Neue", Arial, sans-serif;
         color: #1f2937; margin: 0; padding: 26px 34px; font-size: 12.2px; line-height: 1.62; }
  header { border-bottom: 2.5px solid #1d4ed8; padding-bottom: 9px; margin-bottom: 13px; }
  .name { font-size: 25px; font-weight: 700; letter-spacing: 1px; color: #111827; }
  .headline { font-size: 12.5px; color: #1d4ed8; margin-top: 3px; font-weight: 600; }
  .contact { font-size: 11.6px; color: #4b5563; margin-top: 5px; }
  h2 { font-size: 13px; color: #1d4ed8; margin: 15px 0 6px; padding-left: 8px;
       border-left: 3.5px solid #1d4ed8; line-height: 1.25; }
  p { margin: 3px 0; }
  ul { margin: 3px 0 3px 0; padding-left: 19px; }
  li { margin: 2.5px 0; }
  .hl li { margin: 3.5px 0; }
  .skills { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 4px; }
  .tag { background: #eef2ff; color: #3730a3; border: 1px solid #c7d2fe;
         border-radius: 3px; padding: 1.5px 7px; font-size: 11.4px; }
  .summary { background: #f8fafc; border-left: 3px solid #94a3b8; padding: 8px 11px; margin-top: 4px; }
  .target { font-size: 11.6px; color: #6b7280; margin-top: 4px; }
</style></head>
<body>
  <header>
    <div class="name">${esc(name)}</div>
    <div class="headline">${esc(tailored.position)}${tailored.company ? ` · 应聘 ${esc(tailored.company)}` : ''}</div>
    ${contact ? `<div class="contact">${contact}</div>` : ''}
  </header>

  <h2>核心优势</h2>
  <div class="summary"><p>${esc(tailored.summary)}</p></div>
  ${tailored.highlights?.length ? `<ul class="hl">${tailored.highlights.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>` : ''}

  ${skills.length ? `<h2>专业技能</h2><div class="skills">${skills.map((s) => `<span class="tag">${esc(s)}</span>`).join('')}</div>` : ''}

  ${bodyBlocks.map(renderBlock).filter(Boolean).join('\n  ')}
</body></html>`;
}
