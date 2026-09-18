/**
 * 一岗一简历 —— 定制 PDF 生成（把「按 JD 定制」真正接到投递链路上）
 * ==========================================================================
 * 之前的状态：`tailorResume()` 只挂在 `/api/jobs/tailor` 上，**投递时用的仍是固定 PDF** ——
 * 等于「一岗一简历」做了引擎没接线。本模块补上出稿这一环：
 *
 *   profile + 原简历 + 岗位 JD
 *     → tailorResume()   （定制核心优势 / 技能重排 / 命中缺失）
 *     → buildResumeHtml()（自包含 A4 HTML）
 *     → cdpDriver.htmlToPdf（借平台调试 Chrome 排版，**临时标签页**，不打扰主标签）
 *     → data/resume_tailored/<company>-<hash>.pdf  ← 投递时作为附件
 *
 * 缓存：文件名带「岗位+JD+定制内容」的短哈希 → 同岗位重复投递不会重复生成；
 *       改了 JD/档案会自动生成新文件（哈希变了）。`force: true` 可强制重生成。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as db from '../../db.js';
import { execCdpAction } from '../cdpDriver.js';
import { parseResumeFile, type ResumeStruct } from '../resume.js';
import { tailorResume } from './resumeTailor.js';
import { buildResumeHtml } from './resumeRender.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dir, '..', '..', '..', 'data', 'resume_tailored');

/** 用哪个浏览器排版：official(9227) 平时最闲；失败会回退 boss(9223) */
function endpointOf(key: string, fallbackPort: number): string {
  try {
    const p = path.join(__dir, '..', '..', '..', 'data', 'browser', 'cdp.json');
    const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const ep = cfg?.[key];
    if (typeof ep === 'string' && ep.trim()) return ep.trim();
  } catch { /* 用默认 */ }
  return `http://127.0.0.1:${fallbackPort}`;
}
const PDF_TARGETS: Array<[string, number]> = [['official', 9227], ['boss', 9223]];

export interface TailorPdfJob {
  id?: string;
  company?: string | null;
  position?: string | null;
  jd?: string | null;
  requirements?: string | null;
}

export interface TailorPdfResult {
  ok: boolean;
  /** 生成的 PDF 绝对路径（投递时作为附件） */
  pdfPath?: string;
  htmlPath?: string;
  cached?: boolean;
  /** 定制摘要，供前端展示 */
  summary?: string;
  highlights?: string[];
  orderedSkills?: string[];
  matchScore?: number;
  source?: string;
  error?: string;
}

/** 简历解析结果缓存（按路径+mtime），避免批量生成时反复解析 PDF */
let structCache: { key: string; struct: ResumeStruct } | null = null;
async function getStruct(resumePath: string): Promise<ResumeStruct> {
  const st = fs.statSync(resumePath);
  const key = `${resumePath}|${st.size}|${st.mtimeMs}`;
  if (structCache && structCache.key === key) return structCache.struct;
  const struct = await parseResumeFile(resumePath);
  structCache = { key, struct };
  return struct;
}

const safeName = (s: string): string =>
  String(s || 'resume').replace(/[\\/:*?"<>|\s]+/g, '_').replace(/_+/g, '_').slice(0, 40) || 'resume';

/**
 * 确保某岗位的定制简历 PDF 存在（不存在则生成）。
 * @param job     岗位（含 JD 才能定制出差异）
 * @param options profile 可显式传入；force 强制重生成；platform 指定排版用的浏览器键
 */
export async function ensureTailoredResumePdf(
  job: TailorPdfJob,
  options: { profile?: Record<string, any>; force?: boolean } = {},
): Promise<TailorPdfResult> {
  const profile = options.profile || (db.getProfile() as Record<string, any>) || {};
  const resumePath = String(profile.resume_path || profile.resumePath || '');
  if (!resumePath || !fs.existsSync(resumePath)) {
    return { ok: false, error: `档案未配置可用的简历文件（resume_path=${resumePath || '空'}）` };
  }

  let struct: ResumeStruct;
  try {
    struct = await getStruct(resumePath);
  } catch (e: any) {
    return { ok: false, error: `简历解析失败：${e?.message || e}` };
  }

  // ⚠️ 缓存键只能用**输入**，绝不能包含 LLM 生成的文案 ——
  // LLM 每次输出都有细微差异（temperature>0），把输出纳入键会导致**永远缓存不命中**、
  // 每次投递都重复调用 LLM 并重渲染 PDF（实测踩到：二次调用 cached=false）。
  const st2 = fs.statSync(resumePath);
  const hashSrc = [
    job.id || '', job.company || '', job.position || '', job.jd || '', job.requirements || '',
    resumePath, String(st2.size), String(st2.mtimeMs),
    String(profile.updatedAt || ''),
  ].join('\u0001');
  const hash = crypto.createHash('sha1').update(hashSrc).digest('hex').slice(0, 10);

  const base = `${safeName(job.company || 'company')}-${safeName(job.position || 'job')}-${hash}`;
  const pdfPath = path.join(OUT_DIR, `${base}.pdf`);
  const htmlPath = path.join(OUT_DIR, `${base}.html`);
  const metaPath = path.join(OUT_DIR, `${base}.json`);

  // 命中缓存：连 LLM 都不用调（定制文案已随 sidecar 落盘）
  if (!options.force && fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 1024) {
    let meta: any = {};
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch { /* 无 sidecar 也不影响 */ }
    return {
      ok: true, pdfPath, htmlPath, cached: true,
      summary: meta.summary, highlights: meta.highlights,
      orderedSkills: meta.orderedSkills, matchScore: meta.matchScore, source: meta.source,
    };
  }

  const tailored = await tailorResume(profile, job);

  // 1) 渲染 HTML（自包含）
  const html = buildResumeHtml({
    profile,
    struct: struct as any,
    tailored: {
      company: String(job.company || ''),
      position: String(job.position || ''),
      summary: tailored.summary,
      highlights: tailored.highlights,
      orderedSkills: tailored.orderedSkills,
    },
  });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(htmlPath, html, 'utf-8');
  // sidecar：把本次定制结果随文件落盘，命中缓存时可直接读回（无需再调 LLM）
  const meta = {
    generatedAt: new Date().toISOString(),
    jobId: job.id, company: job.company, position: job.position,
    summary: tailored.summary, highlights: tailored.highlights,
    orderedSkills: tailored.orderedSkills, matchScore: tailored.matchScore, source: tailored.source,
  };
  try { fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8'); } catch { /* 忽略 */ }

  // 2) 借 Chrome 排版成 PDF（依次尝试可用端点）
  const fileUrl = pathToFileURL(htmlPath).href;
  let lastErr = '';
  for (const [key, port] of PDF_TARGETS) {
    const ep = endpointOf(key, port);
    const r: any = await execCdpAction(key, 'htmlToPdf', { fileUrl, outPath: pdfPath }, ep).catch((e: any) => ({ ok: false, error: e?.message }));
    if (r?.ok && fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 1024) {
      return {
        ok: true, pdfPath, htmlPath, cached: false,
        summary: tailored.summary, highlights: tailored.highlights,
        orderedSkills: tailored.orderedSkills, matchScore: tailored.matchScore, source: tailored.source,
      };
    }
    lastErr = r?.error || '未知错误';
  }
  return { ok: false, htmlPath, error: `PDF 渲染失败（已尝试 ${PDF_TARGETS.map(([k]) => k).join('/')}）：${lastErr}` };
}

/** 批量生成（串行，避免同时开多个临时标签） */
export async function ensureTailoredResumePdfBatch(
  jobs: TailorPdfJob[],
  options: { profile?: Record<string, any>; force?: boolean } = {},
): Promise<Array<{ jobId?: string; result: TailorPdfResult }>> {
  const out: Array<{ jobId?: string; result: TailorPdfResult }> = [];
  for (const j of jobs) out.push({ jobId: j.id, result: await ensureTailoredResumePdf(j, options) });
  return out;
}

export function tailoredDir(): string {
  return OUT_DIR;
}
