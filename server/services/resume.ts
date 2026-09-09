/**
 * 简历解析服务
 * - 支持 PDF / DOCX / TXT 抽取文本
 * - 启发式结构化：姓名、手机、邮箱、教育、技能、工作/实习经历、项目
 * 纯本地运行，不依赖外部 API。
 */
import fs from 'fs';
import path from 'path';
import { SKILLS } from './skillsDict';

export interface ResumeStruct {
  rawText: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  education: string[];
  skills: string[];
  experience: string[];
  projects: string[];
  /** 用于匹配的归一化文本（姓名/手机/邮箱已脱敏，仅保留技能与经历关键词） */
  searchBlob: string;
}

const PHONE_RE = /(?:(?:\+?86[-\s]?)?1[3-9]\d{9})/;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** 抽取简历纯文本（按扩展名选择解析器） */
export async function extractResumeText(filePath: string): Promise<string> {
  if (!fs.existsSync(filePath)) throw new Error(`简历文件不存在：${filePath}`);
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') {
    const mod: any = await import('pdf-parse');
    const buf = fs.readFileSync(filePath);
    // pdf-parse v2.x 暴露 PDFParse 类（new PDFParse({data}).getText()）；
    // 经典 v1.x 暴露默认可调用函数（pdfParse(buffer)）。两者 API 不同，需兼容。
    if (typeof mod.PDFParse === 'function') {
      const parser = new mod.PDFParse({ data: buf });
      const r: any = await parser.getText();
      return (r?.text || '') as string;
    }
    const pdfParse = mod.default || mod;
    const result = await pdfParse(buf);
    return (result?.text || '') as string;
  }
  if (ext === '.docx') {
    const mod: any = await import('mammoth');
    const mammoth = mod.default || mod;
    const result = await mammoth.extractRawText({ path: filePath });
    return (result?.value || '') as string;
  }
  if (ext === '.txt') {
    return fs.readFileSync(filePath, 'utf-8');
  }
  throw new Error(`不支持的简历格式：${ext}（支持 pdf / docx / txt）`);
}

/** 将简历文本结构化 */
export function structureResume(text: string): ResumeStruct {
  const rawText = (text || '').replace(/\r\n/g, '\n').trim();
  const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);

  const phoneMatch = rawText.match(PHONE_RE);
  const emailMatch = rawText.match(EMAIL_RE);

  // 姓名：取顶部一个短行（2-4 个汉字或 2-3 个英文单词，且不含手机/邮箱/关键词）
  let name: string | null = null;
  const stopwords = ['简历', '求职', '电话', '手机', '邮箱', '邮箱', '教育', '经历', '项目', '技能', '实习', '工作', '男', '女', '出生于'];
  for (const line of lines.slice(0, 12)) {
    if (line.length >= 2 && line.length <= 12 && !/\d/.test(line) && !EMAIL_RE.test(line)
        && !stopwords.some(w => line.includes(w))) {
      // 中文姓名或英文名
      if (/^[一-龥·]{2,4}$/.test(line) || /^[A-Za-z]+(\s[A-Za-z]+){0,2}$/.test(line)) {
        name = line;
        break;
      }
    }
  }

  // 技能：命中词典（大小写不敏感，做词边界近似）
  const lower = rawText.toLowerCase();
  const skills = SKILLS.filter(s => {
    const t = s.toLowerCase();
    // 避免 "go" 误命中 "google"/"目标"；对短词做边界判定
    if (t === 'go' || t === 'c#' || t === 'sql' || t === 'ux' || t === 'cv' || t === 'pr') {
      const re = new RegExp(`(^|[^a-z])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i');
      return re.test(lower);
    }
    return lower.includes(t);
  });

  // 分块：按常见小标题切分
  const blockOf = (keywords: string[]) => {
    const out: string[] = [];
    let capturing = false;
    for (const line of lines) {
      if (keywords.some(k => line.includes(k)) && line.length <= 12) {
        capturing = true;
        continue;
      }
      // 遇到下一个小标题则停止
      if (capturing && /^(教育|工作|实习|项目|技能|获奖|自我|个人|校园|社会|专业|语言|证书|简介|概览|背景)/.test(line) && line.length <= 12 && !keywords.some(k => line.includes(k))) {
        capturing = false;
      }
      if (capturing && line.length > 1) out.push(line);
    }
    return out.slice(0, 60);
  };

  const education = blockOf(['教育背景', '教育经历', '教育', '学历']);
  const experience = blockOf(['工作经历', '实习经历', '工作经验', '工作', '实习', '实践']);
  const projects = blockOf(['项目', 'project', 'Project']);

  const searchBlob = [
    name || '',
    skills.join(' '),
    education.join(' '),
    experience.join(' '),
    projects.join(' '),
  ].join(' ').toLowerCase();

  return {
    rawText,
    name,
    phone: phoneMatch ? phoneMatch[0] : null,
    email: emailMatch ? emailMatch[0] : null,
    education,
    skills,
    experience,
    projects,
    searchBlob,
  };
}

/** 一步：文件 -> 结构化 */
export async function parseResumeFile(filePath: string): Promise<ResumeStruct> {
  const text = await extractResumeText(filePath);
  return structureResume(text);
}
