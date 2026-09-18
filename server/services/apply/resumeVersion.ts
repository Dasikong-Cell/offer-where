/**
 * 简历版本切换（对标职得鸭 `resumeType: original | optimized`）
 * ─────────────────────────────────────────────────────────────
 * 职得鸭的两种底稿：原始简历 / AI 优化后的简历，且**每个 AI 接口都带上这个参数**。
 * 我们多一档：
 *   · original  —— 用户上传的原始简历（profile.resume_path）
 *   · optimized —— 用户确认过的一份优化稿（profile.optimized_resume_path）
 *   · tailored  —— 按目标 JD 现场定制（我们独有的「一岗一简历」，走 tailoredResumePdf）
 *
 * 这样「用哪份简历投」是一个显式开关，而不是散落在各处的隐式默认值。
 */
import { kvGet, kvSet, getProfile } from '../../db.js';
import { resolveResumePath } from './common.js';

export type ResumeVersion = 'original' | 'optimized' | 'tailored';

const KV_KEY = 'resume:version';
const VALID: readonly ResumeVersion[] = ['original', 'optimized', 'tailored'];

export const RESUME_VERSION_LABELS: Record<ResumeVersion, string> = {
  original: '原始简历',
  optimized: '优化后的简历',
  tailored: '一岗一简历（按 JD 定制）',
};

export function getResumeVersion(): ResumeVersion {
  const raw = String(kvGet(KV_KEY) || '').trim() as ResumeVersion;
  return VALID.includes(raw) ? raw : 'original';
}

export function setResumeVersion(v: string): ResumeVersion {
  const next = (VALID.includes(v as ResumeVersion) ? v : 'original') as ResumeVersion;
  kvSet(KV_KEY, next);
  return next;
}

/**
 * 按版本解析出「实际要用的简历文件路径」。
 * @param tailoredPath tailored 版本下本次生成好的定制简历路径（未生成则逐级回退）
 */
export function resolveResumeForVersion(
  profile: Record<string, any> | null | undefined,
  version: ResumeVersion = getResumeVersion(),
  tailoredPath?: string | null,
): string | undefined {
  const p = profile || getProfile() as Record<string, any>;

  if (version === 'tailored') {
    if (tailoredPath) {
      // 由调用方保证文件存在（tailoredResumePdf 内部已校验）
      return String(tailoredPath);
    }
    // 定制稿没生成出来 → 退回用户确认过的优化稿，再退回原始稿
    const opt = resolveResumePath(p?.optimized_resume_path as string | undefined);
    if (opt) return opt;
    return resolveResumePath(p?.resume_path as string | undefined);
  }

  if (version === 'optimized') {
    const opt = resolveResumePath(p?.optimized_resume_path as string | undefined);
    if (opt) return opt;
    // 没配优化稿就诚实回退到原始稿（而不是报错中断整批投递）
    return resolveResumePath(p?.resume_path as string | undefined);
  }

  return resolveResumePath(p?.resume_path as string | undefined);
}

/** 是否已配置「优化稿」文件（UI 用来提示用户去上传/生成） */
export function hasOptimizedResume(profile?: Record<string, any> | null): boolean {
  const p = profile || (getProfile() as Record<string, any>);
  return !!resolveResumePath(p?.optimized_resume_path as string | undefined);
}

export function describeResumeVersion(v: ResumeVersion = getResumeVersion()): string {
  const label = RESUME_VERSION_LABELS[v] || v;
  if (v === 'original') return `${label}（使用档案里上传的原始文件）`;
  if (v === 'optimized') return `${label}（未配置优化稿时自动回退原始简历）`;
  return `${label}（按目标 JD 现场生成 PDF；生成失败回退优化稿 → 原始简历）`;
}

/** 一次性拿到「版本 + 标签 + 是否可用」的完整状态（供 UI/接口） */
export function resumeVersionStatus(profile?: Record<string, any> | null) {
  const version = getResumeVersion();
  const p = profile || (getProfile() as Record<string, any>);
  return {
    version,
    label: RESUME_VERSION_LABELS[version],
    description: describeResumeVersion(version),
    hasOriginal: !!resolveResumePath(p?.resume_path as string | undefined),
    hasOptimized: hasOptimizedResume(p),
    options: VALID.map((v) => ({ value: v, label: RESUME_VERSION_LABELS[v] })),
  };
}
