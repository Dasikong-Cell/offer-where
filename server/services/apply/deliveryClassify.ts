/**
 * 投递通道分类器（「按 apply_url 自动分流到对应投递通道」的单一真相源）
 *
 * 用户诉求（2026-09-30）：岗位池里凡是「需要网申」的（投递链接指向企业 ATS / 校招网申系统 /
 * 企业自建招聘子域），应当**自动**调用独立「网申」通道（wangshen，9238 窗口）去投递，
 * 而不是回落到 offerbiu 官网聚合通道或被人手粘链接。
 *
 * 这是行业通用模式：GitHub 上的 simonfong6/auto-apply、westonludeke/kernel-job-agent 等
 * 都是「按 apply_url 域名 / ATS 类型把岗位分流到对应投递器」—— 本项目用同一思路，
 * 把「企业官网/校招网申」从「回落 offerbiu」提升为「路由到 wangshen」。
 *
 * 判定优先级：
 *   1) 已知聚合平台（boss / 51job / 智联 / 牛客 / 猎聘 / 国聘 / 鱼泡 / 英才 / 应届生）→ 各自引擎一键投
 *   2) 微信招聘推文（mp.weixin.qq.com）→ HR 邮箱投递通道
 *   3) 网申型链接（企业 ATS / 校招网申系统 / 企业自建招聘子域）→ 独立「网申」通道（wangshen）
 *   4) 其余外部链接 → 通用官网投递（offerbiu：探测入口 → 填表 → 上传简历 → 提交）
 */
import type { ApplyPlatform } from './types.js';
import { domainToUnicode } from 'node:url';

/** 投递方式分类（用于日志 / 前端展示） */
export type DeliveryMethod = 'engine' | 'wangshen' | 'email' | 'official';

export interface DeliveryClassification {
  /** 应当走哪个投递平台 */
  platform: ApplyPlatform;
  /** 投递方式分类 */
  method: DeliveryMethod;
  /** 人类可读的判定理由（日志与前端展示用） */
  reason: string;
  /** 是否判定为「需要网申」（即应当走独立网申通道） */
  needsWangshen: boolean;
}

/**
 * 已知聚合招聘平台（按「注册域名」精确匹配，避免 company.zhaopin.com 这类企业自建子域被误判为智联）。
 * 这些平台有各自的专用投递引擎，命中即走对应引擎一键投。
 */
const AGGREGATOR_DOMAINS: Array<{ domain: string; platform: ApplyPlatform }> = [
  { domain: '51job.com', platform: 'job51' },
  { domain: 'zhaopin.com', platform: 'zhilian' },
  { domain: 'zhipin.com', platform: 'boss' },
  { domain: 'nowcoder.com', platform: 'nowcoder' },
  { domain: 'liepin.com', platform: 'liepin' },
  { domain: 'iguopin.com', platform: 'iguopin' },
  { domain: 'yupao.com', platform: 'yupao' },
  { domain: 'chinahr.com', platform: 'chinahr' },
  { domain: 'yingjiesheng.com', platform: 'yingjiesheng' },
];

/**
 * 国内外常见 ATS / 网申系统域名特征（命中即视为「需要网申」）。
 * 参考同类开源项目：Greenhouse / Lever / Workday / Ashby / Jobvite / SmartRecruiters（海外）；
 * 北森(Beisen) / Moka / 用友 / 大易 / 谷露 / 万宝盛华（国内）。
 */
const WANGSHEN_ATS_HOSTS: RegExp[] = [
  /greenhouse\.io$/, /\.greenhouse\.io$/,
  /lever\.co$/, /\.lever\.co$/,
  /workday\.com$/, /myworkday\.com$/, /\.myworkdayjobs\.com$/,
  /ashbyhq\.com$/, /\.ashbyhq\.com$/,
  /jobvite\.com$/, /\.jobvite\.com$/,
  /smartrecruiters\.com$/, /\.smartrecruiters\.com$/,
  /bamboohr\.com$/, /\.bamboohr\.com$/,
  /icims\.com$/, /\.icims\.com$/,
  /taleo\.net$/, /\.taleo\.net$/,
  /beisen\.cn$/, /\.beisen\.cn$/,                 // 北森
  /italent\.cn$/, /\.italent\.cn$/,              // 北森 iTalent
  /talentshow\.cn$/, /\.talentshow\.cn$/,
  /mokahr\.com$/, /\.mokahr\.com$/,              // Moka
  /moka\.ai$/,
  /yonyou\.com$/, /\.yonyou\.com$/,             // 用友
  /knx\.com\.cn$/,                              // 肯耐珂萨
  /dayee\.com$/, /\.dayee\.com$/,               // 大易
  /compass\.com\.cn$/,                          // 大易 Compass
  /pinss\.com$/, /\.pinss\.com$/,               // 聘信
  /gllue\.com$/, /\.gllue\.com$/,               // 谷露
  /manpower\.com\.cn$/,                         // 万宝盛华
  /click2asia\.com$/, /\.click2asia\.com$/,     // 科锐
];

/**
 * 企业自建「招聘 / 网申 / 校招」子域特征（命中即视为「需要网申」）。
 * 形如 careers.company.com / jobs.company.com / zhaopin.company.com / campus.company.com /
 * join.company.com / recruit.company.com / apply.company.com / talent.company.com 等；
 * 也覆盖中文子域（招聘.company.com / 网申.company.com / 校招.company.com）。
 */
const WANGSHEN_SUBDOMAIN_PREFIX: RegExp[] = [
  /^(career|careers|job|jobs|zhaopin|campus|join|talent|talents|recruit|recruiting|recruitment|apply|hr|hrs|graduate|grad|campus-recruit|school|staff|hire|hiring)\./i,
];
const WANGSHEN_SUBDOMAIN_CN: RegExp[] = [
  /招聘/, /网申/, /校招/, /校园招聘/, /招贤纳士/, /人才招聘/,
];

/** 从完整 URL 或裸 host 中稳定提取 hostname（小写、去 www. 前缀） */
function hostOf(input?: string | null): string | null {
  if (!input) return null;
  const s = String(input).trim().toLowerCase();
  if (/^https?:\/\//i.test(s)) {
    try {
      let host = new URL(s).hostname.toLowerCase().replace(/^www\./, '');
      // IDN（中文子域，如 招聘.alibaba.com）→ punycode（xn--...），需还原回 Unicode 才能命中中文子域特征
      if (host.includes('xn--')) host = domainToUnicode(host).toLowerCase().replace(/^www\./, '');
      return host;
    } catch { return null; }
  }
  // 裸 host（不带协议）：直接清理 www. 前缀
  return s.replace(/^www\./, '');
}

/** 是否为已知聚合平台（按注册域名精确匹配）；是则返回对应平台，否则 null */
export function aggregatorPlatformOf(input?: string | null): ApplyPlatform | null {
  const host = hostOf(input);
  if (!host) return null;
  for (const a of AGGREGATOR_DOMAINS) {
    if (host === a.domain || host.endsWith('.' + a.domain)) return a.platform;
  }
  return null;
}

/** 内部：给定 host，判定网申类型（'ats' = 命中 ATS 域名，'subdomain' = 命中企业自建招聘子域，null = 非网申） */
function matchWangshen(host: string): 'ats' | 'subdomain' | null {
  if (aggregatorPlatformOf(host)) return null; // 已知聚合平台不算网申
  if (WANGSHEN_ATS_HOSTS.some((r) => r.test(host))) return 'ats';
  if (WANGSHEN_SUBDOMAIN_PREFIX.some((r) => r.test(host))) return 'subdomain';
  if (WANGSHEN_SUBDOMAIN_CN.some((r) => r.test(host))) return 'subdomain';
  return null;
}

/** 是否判定为「需要网申」（企业 ATS / 校招网申系统 / 企业自建招聘子域） */
export function isWangshenUrl(url?: string | null): boolean {
  const host = hostOf(url);
  return host ? matchWangshen(host) !== null : false;
}

/**
 * 投递通道分类：给定岗位投递链接，返回应当走的平台与方式。
 * 这是「遇到需要网申的就自动调用网申功能」的核心判定，被 runApply 与 runBatchApply 共用。
 */
export function classifyDelivery(url?: string | null): DeliveryClassification {
  const host = hostOf(url);
  if (!host) {
    return { platform: 'offerbiu', method: 'official', reason: '链接为空，回落通用官网投递', needsWangshen: false };
  }
  const agg = aggregatorPlatformOf(host);
  if (agg) {
    return { platform: agg, method: 'engine', reason: `已知聚合平台（${agg}），走专用引擎一键投`, needsWangshen: false };
  }
  if (host === 'mp.weixin.qq.com' || host.endsWith('.mp.weixin.qq.com')) {
    return { platform: 'offerbiu', method: 'email', reason: '微信招聘推文，走 HR 邮箱投递', needsWangshen: false };
  }
  const w = matchWangshen(host);
  if (w) {
    const reason = w === 'ats' ? '命中 ATS/网申系统域名，走独立网申通道' : '命中企业自建招聘/校招子域，走独立网申通道';
    return { platform: 'wangshen', method: 'wangshen', reason, needsWangshen: true };
  }
  return { platform: 'offerbiu', method: 'official', reason: '外部官网链接，回落通用官网投递', needsWangshen: false };
}
