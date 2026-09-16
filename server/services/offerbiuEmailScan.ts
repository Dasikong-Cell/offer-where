/**
 * Offerbiu 招聘邮箱扫描。
 *
 * 背景（2026-09-16 真机实测结论）：offerbiu 的「投递入口」绝大多数企业官网**不提供邮箱登录**
 * （37 个官网站点实测 0 个；登录清一色是手机号/短信/微信扫码），因此 `runOfferbiu` 的表单通道
 * 很难无人值守跑通。但相当一部分岗位页面里写着**招聘邮箱**，走 `runOfferbiuEmail`（邮箱直投）
 * 无需任何登录即可全自动完成（实测 6/6 成功）。
 *
 * 本模块负责：遍历 offerbiu 岗位 → 打开其 apply_url → 抓取页面文本里的招聘邮箱 → 返回候选清单。
 * 供 API（/api/offerbiu/scan-emails）与命令行脚本共用。
 */
import * as db from '../db.js';
import { execAction } from './browser.js';
import { pageText } from './apply/common.js';

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** 明显非招聘用途/噪音邮箱，排除 */
const BAD_MAIL = /(example\.|sentry|w3\.org|qcloud|tencent\.com$|noreply|no-reply)/i;
/** 已知平台域名：其 apply_url 不是企业页面（会走对应平台引擎），扫描时跳过 */
export const PLATFORM_DOMAIN = /(zhipin\.com|zhaopin\.com|51job\.com|nowcoder\.com)/i;
/** 「像招聘邮箱」的前缀/关键词（默认只收这类） */
const HR_LIKE = /(hr|job|zhaopin|recruit|campus|xyzp|zp|career|talent|apply|offer|resume)/i;

/** 从文本提取邮箱（去重、去噪、小写） */
export function extractEmails(text: string): string[] {
  const found = (text.match(EMAIL_RE) || []).filter((e) => !BAD_MAIL.test(e));
  return Array.from(new Set(found.map((e) => e.toLowerCase())));
}

export interface EmailHit {
  jobId: string;
  company: string;
  position: string;
  city?: string | null;
  email: string;
  applyUrl: string;
}

export interface ScanProgress {
  type: 'progress';
  index: number;
  total: number;
  company: string;
  message: string;
}

export interface ScanOpts {
  limit?: number;
  offset?: number;
  /** 仅保留「像招聘邮箱」的（默认 true）；false 时任何非噪音邮箱都收 */
  hrLikeOnly?: boolean;
  /** 每站停留毫秒（等 SPA 渲染），默认 2400 */
  settleMs?: number;
  onProgress?: (ev: ScanProgress) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 扫描 offerbiu 岗位里的招聘邮箱 */
export async function scanOfferbiuEmails(opts: ScanOpts = {}): Promise<{ scanned: number; found: EmailHit[] }> {
  const limit = Math.max(1, Math.min(Number(opts.limit) || 20, 100));
  const offset = Math.max(0, Number(opts.offset) || 0);
  const settleMs = Math.max(800, Number(opts.settleMs) || 2400);
  const hrLikeOnly = opts.hrLikeOnly !== false;

  const jobs = db.listJobs({ source: 'offerbiu' }).filter((j: any) => j.apply_url && !PLATFORM_DOMAIN.test(j.apply_url));
  const slice = jobs.slice(offset, offset + limit);
  const found: EmailHit[] = [];

  for (let i = 0; i < slice.length; i++) {
    const j: any = slice[i];
    const company = j.company || '';
    opts.onProgress?.({ type: 'progress', index: i, total: slice.length, company, message: `扫描 ${company || j.apply_url}` });
    try {
      await execAction('official', 'navigate', { url: j.apply_url, timeout: 25000 }).catch(() => undefined);
      await sleep(settleMs);
      const text = await pageText('official').catch(() => '');
      let mails = extractEmails(String(text || ''));
      if (hrLikeOnly) mails = mails.filter((m) => HR_LIKE.test(m));
      if (mails.length) {
        found.push({
          jobId: j.id,
          company,
          position: j.position || '',
          city: j.city,
          email: mails[0],
          applyUrl: j.apply_url,
        });
        opts.onProgress?.({ type: 'progress', index: i, total: slice.length, company, message: `  ✓ 发现招聘邮箱 ${mails[0]}${mails.length > 1 ? `（另有 ${mails.length - 1} 个）` : ''}` });
      } else {
        opts.onProgress?.({ type: 'progress', index: i, total: slice.length, company, message: '  未发现招聘邮箱（该岗位需人工/官网表单）' });
      }
    } catch (e: any) {
      opts.onProgress?.({ type: 'progress', index: i, total: slice.length, company, message: `  扫描失败：${e?.message || e}` });
    }
  }
  return { scanned: slice.length, found };
}
