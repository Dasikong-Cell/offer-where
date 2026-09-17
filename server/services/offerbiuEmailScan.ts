/**
 * Offerbiu 招聘邮箱扫描。
 *
 * 背景（2026-09-16~17 真机实测结论）：offerbiu 的「投递入口」绝大多数企业官网**不提供邮箱登录**
 * （37 个官网站点实测 0 个；登录清一色是手机号/短信/微信扫码），因此 `runOfferbiu` 的表单通道
 * 很难无人值守跑通。但相当一部分岗位页面里写着**招聘邮箱**，走 `runOfferbiuEmail`（邮箱直投）
 * 无需登录即可全自动完成（实测 35/38 成功）。
 *
 * 本模块负责：遍历 offerbiu 岗位 → 打开其 apply_url → 抓取页面文本里的招聘邮箱 → 返回候选清单。
 * 供 API（/api/offerbiu/scan-emails）与命令行脚本共用。
 *
 * 2026-09-17 增强：
 *  - 导航校验：导航失败时 pageText 会返回「上一页」内容 → 会把别家邮箱串到本岗位。现比对注册域后跳过。
 *  - 并发：同一 9227 Chrome 内开多个标签（上下文键 official/official2/…）并行扫描，全池耗时约降为 1/N。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from '../db.js';
import { execCdpAction } from './cdpDriver.js';

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
/** 已知平台域名：其 apply_url 不是企业页面（会走对应平台引擎），扫描时跳过 */
export const PLATFORM_DOMAIN = /(zhipin\.com|zhaopin\.com|51job\.com|nowcoder\.com)/i;
/** 「像招聘邮箱」的前缀/关键词 */
const HR_LIKE = /(hr|job|zhaopin|recruit|campus|xyzp|zp|career|talent|apply|offer|resume)/i;
/** 常见企业/个人邮箱主机：前缀不显眼但确实是招聘联系方式（如 aerospaceservo@163.com、hhsyzhp@126.com） */
const COMMON_MAIL_HOST = /@(126|163|qq|gmail|outlook|hotmail|foxmail|sina|sohu|139|aliyun|yeah|21cn|vip)\.[a-z]/i;

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
  /** 并发标签数（1~5，默认 1）。同一 Chrome 内开多个标签并行扫描 */
  workers?: number;
  /** CDP 端点，默认取 cdp.json 的 official（http://127.0.0.1:9227） */
  endpoint?: string;
  onProgress?: (ev: ScanProgress) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 并发用的上下文键（同一个 9227 端点，各自独立标签页） */
const CTX_KEYS = ['official', 'official2', 'official3', 'official4', 'official5'];

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

/** 扫描单个岗位，命中则返回 EmailHit */
async function scanOne(
  ctx: string,
  ep: string,
  j: any,
  idx: number,
  total: number,
  settleMs: number,
  hrLikeOnly: boolean,
  onProgress?: (ev: ScanProgress) => void,
): Promise<EmailHit | null> {
  const company = j.company || '';
  onProgress?.({ type: 'progress', index: idx, total, company, message: `扫描 ${company || j.apply_url}` });
  try {
    const nav: any = await execCdpAction(ctx, 'navigate', { url: j.apply_url, timeout: 25000 }, ep).catch(() => undefined);
    // ⚠️ 导航失败/超时时页面文本仍是「上一页」内容，会串号（实测 通登资管→campus@hikvision.com）。
    const wantRoot = rootDomain(j.apply_url);
    const gotRoot = rootDomain(String(nav?.url || ''));
    if (wantRoot && gotRoot !== wantRoot) {
      onProgress?.({ type: 'progress', index: idx, total, company, message: `  跳过：未成功导航（期望 ${wantRoot}，实际 ${gotRoot || '空'}）` });
      return null;
    }
    await sleep(settleMs);
    const r: any = await execCdpAction(ctx, 'eval', { script: TEXT_SCRIPT }, ep).catch(() => undefined);
    let mails = extractEmails(String(r?.data || ''));
    // 保留「像招聘邮箱」的：前缀含 hr/job/campus… 或落在常见邮箱主机上
    if (hrLikeOnly) mails = mails.filter((m) => HR_LIKE.test(m) || COMMON_MAIL_HOST.test(m));
    if (mails.length) {
      onProgress?.({ type: 'progress', index: idx, total, company, message: `  ✓ 发现招聘邮箱 ${mails[0]}${mails.length > 1 ? `（另有 ${mails.length - 1} 个）` : ''}` });
      return { jobId: j.id, company, position: j.position || '', city: j.city, email: mails[0], applyUrl: j.apply_url };
    }
    onProgress?.({ type: 'progress', index: idx, total, company, message: '  未发现招聘邮箱（该岗位需人工/官网表单）' });
    return null;
  } catch (e: any) {
    onProgress?.({ type: 'progress', index: idx, total, company, message: `  扫描失败：${e?.message || e}` });
    return null;
  }
}

/** 扫描 offerbiu 岗位里的招聘邮箱 */
export async function scanOfferbiuEmails(opts: ScanOpts = {}): Promise<{ scanned: number; found: EmailHit[] }> {
  const limit = Math.max(1, Math.min(Number(opts.limit) || 20, 200));
  const offset = Math.max(0, Number(opts.offset) || 0);
  const settleMs = Math.max(800, Number(opts.settleMs) || 2400);
  const hrLikeOnly = opts.hrLikeOnly !== false;
  const workers = Math.max(1, Math.min(Number(opts.workers) || 1, CTX_KEYS.length));
  const ep = opts.endpoint || officialEndpoint();

  const jobs = db.listJobs({ source: 'offerbiu' }).filter((j: any) => j.apply_url && !PLATFORM_DOMAIN.test(j.apply_url));
  const slice = jobs.slice(offset, offset + limit);
  const found: EmailHit[] = [];

  if (workers === 1) {
    for (let i = 0; i < slice.length; i++) {
      const hit = await scanOne(CTX_KEYS[0], ep, slice[i], i, slice.length, settleMs, hrLikeOnly, opts.onProgress);
      if (hit) found.push(hit);
    }
    return { scanned: slice.length, found };
  }

  // 并发：把岗位轮流分给 N 个标签页
  const buckets: Array<Array<{ j: any; i: number }>> = Array.from({ length: workers }, () => []);
  slice.forEach((j, i) => buckets[i % workers].push({ j, i }));
  const results = await Promise.all(
    buckets.map((bucket, wi) =>
      (async () => {
        const out: EmailHit[] = [];
        for (const { j, i } of bucket) {
          const hit = await scanOne(CTX_KEYS[wi], ep, j, i, slice.length, settleMs, hrLikeOnly, opts.onProgress);
          if (hit) out.push(hit);
        }
        return out;
      })(),
    ),
  );
  for (const arr of results) found.push(...arr);
  return { scanned: slice.length, found };
}
