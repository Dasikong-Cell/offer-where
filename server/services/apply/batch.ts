/**
 * 跨平台「自动筛选 + 批量连投」编排器
 *
 * 流程：
 *   1) （可选）先从 Offerbiu 采集岗位入池
 *   2) 按关键词/城市/薪资/匹配分筛选岗位池
 *   3) 按匹配分降序，逐个调用专用投递脚本（runApply）
 *   4) 成功自动写投递记录 + 更新岗位状态
 *   5) 返回结构化汇总（成功/需人工/需验证码/失败/跳过）
 *
 * 事件流：
 *   传入 onEvent 回调后，运行过程会实时推送：
 *     start / progress / need_input（验证码或人工处理）/ result / done
 *   前端据此用弹窗提示用户「需要输入/操作」的时刻。
 *
 * 注意：
 * - 每个平台登录态由持久化上下文保留；遇到滑块返回 need_captcha，由用户在打开的浏览器中人工过一下后重跑即可。
 * - 受反 spam 约束，两次投递间默认间隔 intervalMs（默认 20s，可在请求中覆盖）。
 */
import { randomUUID } from 'crypto';
import * as db from '../../db.js';
import { runApply, isSupported, SUPPORTED_PLATFORMS, isWangshenUrl, classifyDelivery } from './index.js';
import { collectBossToDb } from './engine.js';
import { findCity } from '../cities.js';
import { toApplyProfile, tryScreenshot } from './common.js';
import { startRecording, stopRecording } from './screencast.js';
import { execAction } from '../browser.js';
import { matchResumeToJobAi } from './matchAi.js';
import { parseResumeFile } from '../resume.js';
import type { ApplyPlatform, ApplyResult } from './types.js';
import { tryAcquire, release } from './sessionLock.js';
import { decideGreet } from './greetDecision.js';

/** 每日投递上限默认值（按平台计）。可被 criteria.dailyLimit 或环境变量 APPLY_DAILY_LIMIT 覆盖，0=不限制。 */
export const DEFAULT_DAILY_LIMIT = 40;

/** 解析每日上限：请求参数 > 环境变量 > 默认 40 */
export function resolveDailyLimit(fromCriteria?: number): number {
  if (typeof fromCriteria === 'number' && Number.isFinite(fromCriteria)) return fromCriteria;
  const raw = String(process.env.APPLY_DAILY_LIMIT ?? '').trim();
  const n = Number(raw);
  return raw !== '' && Number.isFinite(n) ? n : DEFAULT_DAILY_LIMIT;
}

/**
 * 该平台「今天」已成功投递数（按本地日期 00:00 切分）。
 * 以 applications 表为唯一权威口径 —— 不引入额外计数器，重启/多进程/多脚本都一致，
 * 也不会出现"内存计数归零后重复投递"的问题。
 */
export function todayAppliedCount(platform?: string): number {
  try {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const rows = platform
      ? db.query<{ c: number }>(
          'SELECT COUNT(*) c FROM applications WHERE platform = ? AND created_at >= ?',
          [platform, start.toISOString()],
        )
      : db.query<{ c: number }>('SELECT COUNT(*) c FROM applications WHERE created_at >= ?', [start.toISOString()]);
    return rows[0]?.c ?? 0;
  } catch {
    return 0;
  }
}
// ============= 平台级风控封锁（命中 rate_limited / account_risk 后持久化） =============
// 命中后写入 app_kv，后续批次在有效期内**直接短路**，不再反复试探 —— 连续重试只会让风控升级
// （参考同类开源项目 boss_batch_push 的 PUSH_LIMIT 持久标志）。
const riskBlockKey = (p: string) => `risk:block:${p}`;

/** 读平台风控封锁状态；已过期返回 null（不主动清理，过期即失效） */
export function readPlatformRiskBlock(p: string): { until: number; reason: string; kind?: string } | null {
  try {
    const raw = db.kvGet(riskBlockKey(p));
    if (!raw) return null;
    const v = JSON.parse(raw) as { until: number; reason: string; kind?: string };
    return v && v.until > Date.now() ? v : null;
  } catch { return null; }
}

/** 写平台风控封锁：额度到顶 6 小时（通常隔日恢复）；账号级异常 12 小时（需人工处置） */
export function writePlatformRiskBlock(p: string, kind: string, reason: string): void {
  const minutes = kind === 'account_risk' ? 12 * 60 : 6 * 60;
  try { db.kvSet(riskBlockKey(p), JSON.stringify({ until: Date.now() + minutes * 60_000, reason, kind })); }
  catch { /* 写入失败不影响本批中止 */ }
}

/** 手动解封（控制台/运维用） */
export function clearPlatformRiskBlock(p: string): void {
  try { db.kvDelete(riskBlockKey(p)); } catch { /* 忽略 */ }
}

import { composeCoverLetter, markLetterSent } from './coverLetter.js';
import { runExchangeActions, getExchangeActions, summarizeExchange } from './exchangeContact.js';
import { ensureChatResumePng, sendChatResumeImage } from './chatResumeImage.js';
import { checkAndAdvance } from './schedule.js';
import { getResumeVersion } from './resumeVersion.js';
import { isClosingRelatedError, randomInt } from '../safeOp.js';
import { POSTED_WITHIN_LABELS, type PostedWithin } from '../parsePostedAt.js';
import { filterByPostedWindow } from '../postedFilter.js';

// 发布时间筛选的实现在 `../postedFilter.js`（纯模块，零重依赖，可单测）。
// 这里再导出一次，保持既有 API 面 —— 它此前是定义在本文件里的。
export { filterByPostedWindow };

export interface BatchCriteria {
  keywords?: string[];      // 任一命中即保留（岗位名/公司/JD）
  city?: string;            // 城市（岗位 city 或 JD 命中）
  minSalary?: number;       // 月薪下限（k）；岗位薪资上限低于它则排除
  maxSalary?: number;       // 月薪上限（k）；岗位薪资下限高于它则排除
  minScore?: number;        // 匹配分下限（0-100）；缺失时现场计算
  excludeApplied?: boolean; // 跳过已投递岗位（**默认 true**；显式传 false 才把已投岗位纳入候选）
  /** 打招呼前先做决策（默认 true）。命中硬规则/AI 判否 → 跳过并写入 skip_reason */
  greetDecision?: boolean;
  /** 投递成功后追加发送求职信（默认 false，因为会显著变慢并可能打扰 HR） */
  coverLetter?: boolean;
  /** 投递成功后发送「简历聊天图」（默认 false；有 HR 邮箱的岗位本来就走了 PDF 邮件通道，无需重复） */
  chatResume?: boolean;
  /**
   * 每日投递上限（按平台计，0/负数 = 不限制）。
   * 缺省取环境变量 `APPLY_DAILY_LIMIT`，再缺省 40。
   * 超限即提前收工并说明原因 —— 平台（尤其 BOSS）对骚扰式批量投递有账号级处罚，
   * 宁可少投也不能把号玩坏（参考同类开源项目的硬性频率表）。
   */
  dailyLimit?: number;
  /** 仅投递远程岗位（jobs.remote=1，对标 Resumly「远程岗位筛选」） */
  remoteOnly?: boolean;
  /**
   * 时间口径：只保留「发布时间在近 N 天内」的岗位（`'today'` / `'3d'` / `'7d'` / `'any'`）。
   * 缺省 / `'any'` = 不按时间筛，行为与加这个字段之前完全一致。
   * 判据是 `jobs.posted_at`（**平台口径**的发布时间），该列为空时的行为见 `postedFallback`。
   */
  postedWithin?: PostedWithin;
  /**
   * `posted_at` 为空时，是否退回 `created_at`（**我们入库的时间**）兜底，**默认 true**。
   *
   * 为什么需要这个开关 —— 各平台能给到发布时间的比例差异极大（实测存量 2344 条）：
   *   · offerbiu 100%（卡片上就写着「更新 9月2日」）
   *   · BOSS      13%（详情页有「更新时间」字段）
   *   · 其余 8 个平台 0%（卡片和详情页都没有这个字段）
   * 若**不允许**兜底，「只看今天」在这 8 个平台上会一条都筛不出来，用户会以为功能坏了；
   * 若**强制**兜底，又会把「岗位什么时候发布的」和「我们什么时候发现的」混为一谈。
   * ⇒ 默认兜底（有总比空着强），显式传 `false` 则要求必须是真实的平台发布时间。
   */
  postedFallback?: boolean;
}

export interface BatchInput {
  platform?: ApplyPlatform | 'auto';  // 'auto'＝按岗位 apply_url 域名自动路由到对应平台脚本
  source?: string;                  // 仅投递该来源岗位（如 'offerbiu'）；留空=全部
  criteria?: BatchCriteria;
  collect?: 'offerbiu' | false;     // 投递前先采集 Offerbiu 岗位池
  realSend?: boolean;               // 官网(offerbiu)通道真实投递开关；缺省=false→仅预览不提交
  /**
   * 平台通道的**只读预览**（dry-run）：走完导航/下线检测/JD 抓取，探测到投递入口就返回，
   * **不点击、不产生任何真实投递**。用于零风险验证链路（登录态、选择器、岗位是否可投）。
   */
  preview?: boolean;
  autoRefill?: boolean;             // 候选池耗尽时自动重采 BOSS 岗位（默认 true）
  /**
   * 投前实时采集（2026-10-05 用户诉求：投的是平台**当下**的真实岗位，不是库里的陈旧数据）。
   * 开启后先上 BOSS 按「职位关键词/目标城市」实搜一轮入库，随后**只把这一轮平台上真实在招**的岗位当候选
   * （判据 updated_at >= 采集开始时刻；upsertJob 每次都会 touch updated_at）；
   * 实搜一个都没拿到（未登录 / 窗口没开 / 风控）才回落全库，并在 startMsg 里注明。仅 BOSS 支持。
   */
  liveCollect?: boolean;
  limit?: number;                   // 最多投递数（默认 10，上限 100）
  headless?: boolean;               // 默认非无头（便于人工过滑块）
  sinceMinutes?: number;            // 验证码邮件时间窗
  intervalMs?: number;              // 两次投递间隔（默认 20000）
  /** 模拟真人操作节奏（对标 CareerBoom.ai）：开启时做拟人抖动 + 偶发长间隔 + 点击前微停顿；默认 true。关闭则固定 intervalMs（测试/调试用） */
  humanize?: boolean;
  /**
   * 操作录屏（真·CDP screencast，对标 CareerBoom.ai）：每次投递前后自动开/停录制，
   * 帧序列归档到 `data/evidence/vid-*`，回看入口写入 `applications.video_path`。
   * 默认关闭（会多写盘）；只读页面、不改变投递行为，失败不影响投递结果。
   */
  record?: boolean;
  /** 拟人间隔随机区间 [min,max]（ms）；提供时覆盖 intervalMs 的 ±25% 抖动，直接在范围内均匀取间隔 */
  minIntervalMs?: number;
  maxIntervalMs?: number;
  /** 启用运行时间段限制（读取 app_kv 里该平台的 schedule 配置）；到点自动停 */
  useSchedule?: boolean;
}

export interface BatchItemResult {
  jobId: string;
  company: string | null;
  position: string | null;
  platform: string;
  status: string;
  message: string;
}

export interface BatchResult {
  total: number;
  applied: number;
  needManual: number;
  needCaptcha: number;
  error: number;
  skipped: number;
  /** 仅预览（dry-run）的岗位数：已探测到投递入口但**未点击**，不计入 applied */
  previewed?: number;
  /** 因平台风控/额度信号而中止（>0 说明本批被安全闸门提前终止，原因见 message 与 results） */
  riskStopped?: number;
  results: BatchItemResult[];
  message: string;
  /**
   * picked 为 0 时说明「为什么一个岗位都没投出去」（池空 / 全已投 / 时间窗 / 关键词不匹配 /
   * 被城市·薪资·匹配分滤掉）。
   * 🔴 2026-10-05：这份诊断原先只经 onEvent（SSE）推送，而控制台「开始投递」走的是普通 POST、
   *   **没有 onEvent** ⇒ 用户永远只看到「共 0 个岗位」，与写这段诊断的意图正好相反。
   *   现在它同时进响应 JSON，非 SSE 调用也拿得到。
   */
  reason?: string;
}

/** 实时事件（供 SSE / 弹窗提示使用） */
export type BatchEvent =
  | { type: 'start'; total: number; message: string }
  | { type: 'progress'; index: number; total: number; jobId: string; company: string | null; position: string | null; platform: string }
  | { type: 'need_input'; inputType: 'captcha' | 'manual'; platform: string; jobId: string; company: string | null; position: string | null; message: string }
  | { type: 'result'; index: number; jobId: string; status: string; message: string }
  | { type: 'done'; summary: BatchResult };

const PLATFORM_LABEL: Record<string, string> = {
  boss: 'BOSS直聘', zhilian: '智联招聘', job51: '前程无忧', nowcoder: '牛客网', offerbiu: '企业官网',
  liepin: '猎聘', iguopin: '国聘', yupao: '鱼泡直聘', wangshen: '网申(企业官网)',
};

/** 域名 → 投递平台（用于「按链接自动路由」模式） */
const PLATFORM_DOMAINS: Array<{ re: RegExp; platform: ApplyPlatform }> = [
  { re: /51job/i, platform: 'job51' },
  { re: /zhaopin/i, platform: 'zhilian' },
  { re: /zhipin/i, platform: 'boss' },
  { re: /nowcoder/i, platform: 'nowcoder' },
  { re: /offerbiu/i, platform: 'offerbiu' },
];

/** 从岗位投递链接推断应走的投递平台；无法识别（外部官网/微信文章等）返回 null */
export function platformFromUrl(url?: string | null): ApplyPlatform | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    for (const d of PLATFORM_DOMAINS)     if (d.re.test(host)) return d.platform;
  } catch { /* 非法 URL */ }
  return null;
}

/**
 * 批量「auto」模式的路由预览：不投递，只统计当前候选池里每个岗位会被分到哪个通道，
 * 让用户在开投前看到「会有哪些岗位自动走网申通道」。判定逻辑与 runBatchApply 的 'auto' 分支完全一致：
 *   platformFromUrl 命中聚合平台 → 该平台；否则 isWangshenUrl 命中 → 'wangshen'；其余 → auto 模式会跳过。
 */
export interface BatchRoutingPreview {
  /** 候选池总数（已排除下线/已投递） */
  total: number;
  /** 各通道岗位数（wangshen = 会自动走网申通道；其余聚合平台 = 对应引擎；skipped = auto 模式会跳过的外部链接） */
  byPlatform: Record<string, number>;
  /** 会被自动路由到网申通道的岗位清单（用户最关心的一栏） */
  wangshenJobs: { company: string | null; position: string | null; url: string | null; reason: string }[];
  /** auto 模式会因「无法自动路由」而跳过的外部链接数 */
  skippedExternal: number;
}

export async function previewBatchRouting(input: {
  platform?: ApplyPlatform | 'auto';
  source?: string;
}): Promise<BatchRoutingPreview> {
  const source = input.source || (input.platform && input.platform !== 'auto' ? input.platform : undefined);
  let jobs = db.listJobs({ source });
  jobs = jobs.filter((j) => j.status !== 'unavailable');
  // 与 runBatchApply 默认一致：排除已投递岗位
  jobs = jobs.filter((j) => j.status !== 'applied');
  const byPlatform: Record<string, number> = {};
  const wangshenJobs: BatchRoutingPreview['wangshenJobs'] = [];
  let skippedExternal = 0;
  for (const j of jobs) {
    const routed = platformFromUrl(j.apply_url);
    let platform: string;
    if (routed) platform = routed;
    else if (isWangshenUrl(j.apply_url)) platform = 'wangshen';
    else platform = 'skipped';
    byPlatform[platform] = (byPlatform[platform] || 0) + 1;
    if (platform === 'wangshen') {
      const cls = classifyDelivery(j.apply_url);
      wangshenJobs.push({ company: j.company ?? null, position: j.position ?? null, url: j.apply_url ?? null, reason: cls.reason });
    } else if (platform === 'skipped') {
      skippedExternal++;
    }
  }
  return { total: jobs.length, byPlatform, wangshenJobs, skippedExternal };
}

/** 候选池低于该数量时触发自动补充（仅 BOSS） */
const MIN_POOL = 3;

/** 岗位来源 → 投递平台（offerbiu/manual/official 等默认走官网投递脚本） */
function sourceToPlatform(source: string): ApplyPlatform {
  if ((SUPPORTED_PLATFORMS as string[]).includes(source)) return source as ApplyPlatform;
  return 'offerbiu';
}

/** 解析薪资字符串（如 "15-25K" / "20K"）→ 月薪范围(k) */
function parseSalary(salary: string | null): { min?: number; max?: number } {
  if (!salary) return {};
  const range = salary.replace(/[^\d.\-~/Kk]/g, ' ').match(/([\d.]+)\s*[-~]\s*([\d.]+)/);
  if (range) return { min: parseFloat(range[1]), max: parseFloat(range[2]) };
  const single = salary.match(/([\d.]+)\s*[Kk]/);
  if (single) return { min: parseFloat(single[1]), max: parseFloat(single[1]) };
  return {};
}

/** 「目标职位」关键词的核心词后缀（用于把「后端开发工程师」这类词展开成可匹配的核心词） */
const KW_SUFFIXES = ['高级', '中级', '初级', '资深', '实习', '开发工程师', '研发工程师', '工程师', '开发', '研发', '岗位', '专员', '经理', '主管', '实习生', '师', '岗'];
/** 过于宽泛、不适合单独作为匹配词的核心词（否则「开发」会命中所有岗位） */
const KW_GENERIC = new Set(['开发', '工程师', '研发', '岗位', '专员', '经理', '主管', '实习', '实习生', '师', '岗', '高级', '中级', '初级', '资深', '工作']);

/**
 * 把「目标职位」关键词展开为可匹配的核心词集合。
 * 例："后端开发工程师" → ["后端开发工程师","后端"]；"软件工程师" → ["软件工程师","软件"]。
 * 匹配时用「任一核心词被岗位文本包含」判定，避免因岗位标题写法不同
 * （java开发工程师 vs 后端开发工程师）把整池岗位误过滤成 0。
 */
function kwTokens(k: string): string[] {
  const out = new Set<string>([k]);
  let cur = k;
  for (let i = 0; i < 4; i++) {
    let changed = false;
    for (const sfx of KW_SUFFIXES) {
      if (cur.length > sfx.length && cur.endsWith(sfx)) { cur = cur.slice(0, -sfx.length); out.add(cur); changed = true; break; }
    }
    if (!changed) break;
  }
  return [...out].filter(t => t.length >= 2 && !KW_GENERIC.has(t));
}

/**
 * 回收某平台的多余标签页（**同域只留一个**）。
 *
 * 用户反馈「投递时一个点击事件占一个窗口」的兜底清扫：
 * 根因是会话失效后旧实现会新建标签，而 `closeTab` 又是空壳（从不回收）。
 * 主修复在 `cdpDriver.ensureSession`（优先接管已有标签），这里每完成一个岗位再扫一次。
 *
 * ⚠️ 必须带 `sameHostOnly`：一个 CDP 端点会承载多个平台（official/offerbiu 共用 9227），
 * 不加限制会把**别的平台**的标签一起关掉。
 */
async function reclaimTabs(
  platform: string, index: number, total: number, jobId: string,
  onEvent?: (ev: any) => void,
): Promise<void> {
  try {
    const r: any = await execAction(platform, 'closeExtraTabs', { sameHostOnly: true });
    const closed = Number(r?.data?.closed || 0);
    if (closed > 0) {
      onEvent?.({ type: 'progress', index, total, jobId, message: `已回收 ${closed} 个多余标签页（同域只留 1 个）` });
    }
  } catch { /* 回收失败不影响投递结果 */ }
}

/**
 * 拟人节流（对标 CareerBoom.ai「模拟真人操作节奏」—— 它靠这个把封号风险压到最低）：
 * 等间距请求本身就是强机器特征。这里在基础间隔上做双层抖动：
 *   1) 常规：±25% 均匀抖动（破等间距）
 *   2) 偶发「走神 / 喝口水」长间隔：约 8% 概率拉长到 1.8–2.6×（更像人会中途停顿）
 * 仅在 humanize 开启时生效；关闭则退化为固定 intervalMs（测试 / 调试用，节奏可复现）。
 *
 * range 的语义是「显式区间优先」：调用方给区间就是在表达硬约束（例如某平台的安全节奏），
 * 此时 8% 长间隔**不得**越过它 —— 2026-09-26 修：此前长间隔分支无条件覆盖 range，
 * 传 [3000,5000] 时仍有 8% 概率产出 1.8–2.6×base（base=20000 即 36–52s），
 * 等于把调用方的约束悄悄作废（当时只有合约测试在用 range，所以线上未暴露，但契约已被破坏）。
 */
export function humanizedGap(base: number, humanize: boolean, range?: [number, number]): number {
  if (!humanize || base <= 0) return base;
  const explicit = !!(range && range[0] > 0 && range[1] >= range[0]);
  let g: number;
  if (explicit) {
    g = randomInt(range![0], range![1]);
  } else {
    g = Math.round(base * (0.75 + randomInt(0, 50) / 100)); // ±25%
    // 8% 概率触发「长间隔」——真人不会永远匀速，偶尔会停顿更久（直接基于 base，1.8–2.6×，不叠加上面抖动）
    if (randomInt(0, 99) < 8) {
      g = Math.round(base * (1.8 + randomInt(0, 80) / 100)); // 1.8–2.6× base
    }
  }
  return Math.max(0, g);
}

/** 点击「投递」前的「读页面」微停顿（400–1600ms），仅真实投递时生效，节奏更像人 */
async function humanPreClickPause(humanize: boolean): Promise<void> {
  if (!humanize) return;
  const d = randomInt(400, 1600);
  await new Promise<void>((r) => setTimeout(r, d));
}

export async function runBatchApply(
  input: BatchInput,
  onEvent?: (e: BatchEvent) => void,
): Promise<BatchResult> {
  const profile = db.getProfile() as Record<string, unknown>;
  if (!profile?.email) {
    throw new Error('档案未配置邮箱，无法读取登录验证码。请先在「我的档案」填写邮箱与授权码');
  }
  const resumePath = (profile.resume_path as string) || (profile.resumePath as string);
  if (!resumePath) {
    throw new Error('档案未配置简历路径，无法确定投递附件。请在「我的档案」填写简历文件绝对路径');
  }

  // 会话独占锁：同一平台同一时刻只允许一个投递/回复占用浏览器，避免与自动回复监视器互抢同一 CDP 标签
  // （否则监视器后台 navigate 聊天页会把投递的职位页冲掉，表现就是「只投了一两份就被监视器抢走」）。
  const lockKey = String(input.platform || input.source || 'unknown');
  const lockHolder = 'apply';
  if (!tryAcquire(lockKey, lockHolder)) {
    throw new Error(`平台 ${lockKey} 正被自动回复监视器占用，请先停止「自动回复监视」再投递，或稍候自动重试`);
  }

  try {

  // 1) 可选：先采集 Offerbiu 岗位
  if (input.collect === 'offerbiu') {
    const { collectOfferbiu } = await import('../offerbiuCollect.js');
    const c = await collectOfferbiu(Number(input.limit) || 50);
    console.log(`[Batch] Offerbiu 采集 ${c.collected} 个岗位`);
  }

  // 2) 取岗位
  // ── 投前实时采集（2026-10-05 用户诉求：投的是平台**当下**的真实岗位，不是库里的陈旧数据）────
  // 只吃库 ⇒ 池子里全是前几天采的低分/已评估岗（实测 264 个全 <42 分、高分早已投完）⇒ 永远 0 候选。
  // 开启后先上 BOSS 按筛选条件实搜一轮，再只把「这一轮平台上真实在招」的岗位当候选；
  // 实搜一个都没入库（未登录 / 窗口没开 / 风控）才回落全库，回落原因会写进 startMsg。
  let liveCollected = -1;            // -1 = 本轮未启用实时采集
  let liveFreshUsed = false;
  const liveCollectStart = new Date(Date.now() - 5000).toISOString();
  if (input.liveCollect && (input.source === 'boss' || input.platform === 'boss'
    || input.platform === 'auto' || !input.platform)) {
    const cityHit = input.criteria?.city ? findCity(input.criteria.city) : null;
    console.log(`[Batch] 实时采集：上 BOSS 搜索真实岗位（关键词 ${input.criteria?.keywords?.join('、') || '默认意向'}，城市 ${cityHit?.name || '全国'}）…`);
    liveCollected = await collectBossToDb(
      Math.max(20, Math.min(100, (Number(input.limit) || 10) * 4)),
      { keywords: input.criteria?.keywords, cityCode: cityHit?.boss, cityName: cityHit?.name ?? null },
    );
    console.log(`[Batch] 实时采集完成：${liveCollected} 个岗位入库`);
  }
  let jobs = db.listJobs({ source: input.source });
  if (liveCollected >= 0) {
    // 新鲜度判据：upsertJob 每次都会 touch updated_at ⇒ 「这一轮平台上真实在招」= updated_at ≥ 采集开始
    const fresh = jobs.filter(j => String((j as any).updated_at || '') >= liveCollectStart);
    if (fresh.length > 0) { jobs = fresh; liveFreshUsed = true; }
  }
  // 永远排除「已下线/不可投」岗位：批量连投的岗位池会被投递消耗，已确认关闭的岗位
  // 若仍留在候选会反复被选中重试（浪费 CDP 调用、刷 need_manual）。
  jobs = jobs.filter(j => j.status !== 'unavailable');
  // ⚠️ 2026-09-25：**默认开启**（显式传 `false` 才关闭）。
  //    此前为「不传就不过滤」，导致直连 API / 脚本漏传时，已投(status='applied')的高分岗位
  //    仍留在候选池里按分数排最前，每轮被选中→判「已投递过」→跳过，**真实可投候选永远轮不到**
  //    （实测连续 5 轮零投递，全是重复选中同一批已投岗位）。
  if (input.criteria?.excludeApplied !== false) jobs = jobs.filter(j => j.status !== 'applied');

  // 2.5) 岗位池自动补充：候选不足时按档案目标职位重新采集 BOSS 岗位，避免「共 0 个岗位」
  // 仅 BOSS 支持服务端采集；其余平台需先人工登录，此处不触发。
  const refillPlatform = input.platform && input.platform !== 'auto' ? input.platform : (input.source as ApplyPlatform) || 'boss';
  if (jobs.length < MIN_POOL && input.autoRefill !== false && (refillPlatform === 'boss' || input.source === 'boss')) {
    try {
      const added = await collectBossToDb(MIN_POOL * 4);
      if (added > 0) {
        jobs = db.listJobs({ source: input.source }).filter(j => j.status !== 'unavailable');
        if (input.criteria?.excludeApplied !== false) jobs = jobs.filter(j => j.status !== 'applied');
        console.log(`[Batch] 自动补充后候选池 ${jobs.length} 个`);
      }
    } catch (e: any) {
      console.warn('[Batch] 岗位池自动补充失败（已忽略，继续用现有岗位）：', e?.message);
    }
  }

  // 3) 按需解析简历，并以 AI（无 AI 时回退规则）补全缺失的匹配分
  const needScore = input.criteria?.minScore != null;
  let struct: Awaited<ReturnType<typeof parseResumeFile>> | null = null;
  const scoreMap = new Map<string, number>();
  if (needScore) {
    try { struct = await parseResumeFile(resumePath); }
    catch (e: any) { console.warn('[Batch] 简历解析失败，按已存匹配分过滤：', e?.message); }
  }
  if (struct) {
    for (const j of jobs) {
      // 无 JD 文本（实时采集的列表页快照多属此类）⇒ 没有可依据的内容，打了也是 0 分垃圾数据。
      // 2026-10-05 实测：40/43 个新鲜岗被「AI 对空 JD 打出的 0 分」+ 45 分闸门全灭。
      // 这里直接跳过且**不写库**，把「未评分」留给过滤阶段按「无 JD 放行」处理。
      if (!((j.jd || '').trim() || (j.requirements || '').trim())) continue;
      // `<=0` 也算「未评分」：老库 match_score 列默认 0，未算分的岗位会落成 0（同 greetDecision 的注释）
      if (j.match_score == null || j.match_score <= 0) {
        // AI 语义匹配；失败时 matchResumeToJobAi 内部回退规则匹配。
        // 单条打分异常（偶发 AI 响应异常）绝不能拖垮整批：try/catch 兜底为「不评分」。
        // 🔴 打分失败时该岗位**会被放行**，不是被分数闸门拦下 —— 过滤条件是
        //    hasJdText && score != null && score < minScore，打分失败 ⇒ score 为 undefined
        //    ⇒ score != null 不成立 ⇒ 不拦。这与「无 JD 文本放行」是同一取舍：
        //    分数缺失时宁可投出去，也不让一次 AI 抖动把岗位判死。
        //    （旧注释写「若设了 minScore 则自然被分数闸门过滤掉」，与代码相反 —— 2026-10-10 更正。）
        try {
          const r = await matchResumeToJobAi({
            resumeBlob: struct.searchBlob,
            resumeSkills: struct.skills,
            jd: j.jd || '',
            requirements: j.requirements || '',
            position: j.position || '',
          });
          scoreMap.set(j.id, r.score);
          db.updateJob(j.id, { match_score: r.score });
        } catch (e: any) {
          console.warn(`[Batch] 岗位 ${j.id} 匹配分计算失败（已跳过，不影响其余岗位）：${e?.message}`);
        }
      } else {
        scoreMap.set(j.id, j.match_score as number);
      }
    }
  }

  // 4) 过滤
  const kw = (input.criteria?.keywords || []).map(k => String(k).toLowerCase()).filter(Boolean);
  const city = input.criteria?.city?.trim().toLowerCase();
  const blobOf = (j: any) =>
    `${j.company || ''} ${j.position || ''} ${j.jd || ''} ${j.requirements || ''}`.toLowerCase();

  // 发布时间筛选（postedWithin）—— 判据是**平台口径**的 posted_at，不是我们的入库时间。
  // 三个计数分开记：用户据此判断「要不要开兜底」「是不是该换个平台采」。
  // 不记数的话，用户只会看到「筛出来 0 条」，无从知道是「今天真没有」还是「这些平台没给发布时间」。
  // 发布时间筛选走独立的纯函数（见 filterByPostedWindow 注释：抽出来才能单测）
  const posted = filterByPostedWindow(jobs, input.criteria?.postedWithin, {
    fallback: input.criteria?.postedFallback,
  });

  // 先做与关键词无关的过滤（城市 / 薪资 / 匹配分）
  // 分项计数：用户据此知道「被哪条条件卡了多少个」，不会再去瞎改无关的框（见下方 0 候选诊断）。
  const drop = { city: 0, remote: 0, salary: 0, score: 0, kw: 0 };
  const baseFiltered = posted.jobs.filter(j => {
    const blob = blobOf(j);
    if (city && !((j.city || '').toLowerCase().includes(city) || blob.includes(city))) { drop.city++; return false; }
    // 远程岗位筛选（对标 Resumly）：remoteOnly 时只保留 jobs.remote=1
    if (input.criteria?.remoteOnly && j.remote !== 1) { drop.remote++; return false; }
    if (input.criteria?.minSalary != null || input.criteria?.maxSalary != null) {
      const s = parseSalary(j.salary);
      if (input.criteria!.minSalary != null && s.max != null && s.max < input.criteria!.minSalary) { drop.salary++; return false; }
      if (input.criteria!.maxSalary != null && s.min != null && s.min > input.criteria!.maxSalary) { drop.salary++; return false; }
    }
    if (needScore && struct) {
      const score = scoreMap.get(j.id);
      // 无 JD 文本的岗位没有可信分数（打分阶段已跳过）⇒ 放行而不是按 0 分误杀；
      // 与「无界面分时不启用匹配度闸门、宁可打招呼」的既有语义一致（见下方排序处注释）。
      const hasJdText = Boolean((j.jd || '').trim() || (j.requirements || '').trim());
      if (hasJdText && score != null && score < (input.criteria!.minScore as number)) { drop.score++; return false; }
    }
    return true;
  });

  // 关键词匹配：用「核心词」判定，避免「目标职位=后端开发工程师」被标题为
  // 「java开发工程师」的岗位整池误杀（原实现是严格全词 substring 匹配）。
  const kwMatch = (j: any) => kw.some(k => kwTokens(k).some(t => blobOf(j).includes(t)));
  // 关键词过滤也计入分项诊断：否则「关键词卡死整池」时 0 候选原因里看不到它
  // （2026-10-05 实测：BOSS 按「全栈」搜回的岗位标题/JD 里 0 个含「全栈」，库内再按全栈过滤=全灭且无声）。
  const filtered = kw.length
    ? baseFiltered.filter(j => { const ok = kwMatch(j); if (!ok) drop.kw++; return ok; })
    : baseFiltered;

  if (posted.days != null) {
    const parts = [`发布时间窗口 ${input.criteria?.postedWithin}（≤${posted.days} 天）`];
    if (posted.viaFallback) parts.push(`${posted.viaFallback} 条靠入库时间兜底`);
    if (posted.outOfRange) parts.push(`${posted.outOfRange} 条超出窗口`);
    if (posted.missing) parts.push(`${posted.missing} 条因缺发布时间被排除`);
    console.log(`[Batch] ${parts.join('，')}`);
  }

  // 5) 排序：**未评估过的岗位优先，再按匹配分降序**。
  // ⚠️ 2026-09-30 修「边投递边找」卡死：此前纯按分降序，而被打招呼闸门判「匹配度过低」的岗位
  //    状态仍是 candidate（只多了 skip_reason），于是它们每轮都被重新挑中、又每轮被同样理由跳过；
  //    新采集的岗位（无 match_score，排序里 -1 垫底）永远轮不到 ⇒ 批量表现为「持续在跑、一个也投不出去」。
  //    把「已带 skip_reason 的岗」排到最后，池子就会前进：先消化真正待评估的新岗（产品语义：
  //    无界面分时不启用匹配度闸门、宁可打招呼），全部评估完才轮到旧岗。
  filtered.sort((a, b) => {
    const aSkipped = a.skip_reason ? 1 : 0;
    const bSkipped = b.skip_reason ? 1 : 0;
    if (aSkipped !== bSkipped) return aSkipped - bSkipped;
    return (b.match_score ?? -1) - (a.match_score ?? -1);
  });

  const limit = Math.max(1, Math.min(Number(input.limit) || 10, 100));
  const picked = filtered.slice(0, limit);
  const intervalMs = Math.max(0, Number(input.intervalMs ?? 20000));
  // 模拟真人节奏（对标 CareerBoom.ai）：默认开启；关闭则固定 intervalMs（节奏可复现，便于调试）
  const humanize = input.humanize !== false;
  const intervalRange: [number, number] | undefined =
    (input.minIntervalMs && input.maxIntervalMs && input.maxIntervalMs >= input.minIntervalMs)
      ? [Number(input.minIntervalMs), Number(input.maxIntervalMs)]
      : undefined;
  const dailyLimit = resolveDailyLimit(input.criteria?.dailyLimit);
  const quotaPlatform = input.platform && input.platform !== 'auto' ? input.platform : '';
  const quotaNote = dailyLimit > 0
    ? `｜今日已投 ${todayAppliedCount(quotaPlatform || undefined)}/${dailyLimit}`
    : '｜未设每日上限';

  // 起始事件：total=0 时明确告知「为什么没有岗位」，不让用户对着「共 0 个岗位」干瞪眼。
  let startMsg: string;
  if (picked.length > 0) {
    startMsg = `开始批量投递，共 ${picked.length} 个岗位${quotaNote}`;
  } else if (jobs.length === 0) {
    startMsg = `未找到可投岗位：该来源岗位库为空，请先采集岗位后再投`;
  } else if (jobs.filter(j => j.status !== 'applied').length === 0) {
    startMsg = `未找到可投岗位：该来源 ${jobs.length} 个岗位都已投递过（已按「跳过已投」过滤），请采集新岗位后再投`;
  } else if (posted.days != null && posted.jobs.length === 0) {
    // 🔴 这条分支必须**单独存在**。否则会落到下面那句「被筛选条件（城市/薪资/匹配分）过滤掉了」，
    //    用户就会去调城市和薪资 —— 而真正的原因是「库里压根没有这个时间窗内的岗位」，
    //    跟城市薪资毫无关系。实测（2026-10-03）：库里最新采集是 3 天前，选「今天」必然 0 条，
    //    这**不是 bug**，但看起来极像 bug。
    const lbl = POSTED_WITHIN_LABELS.find((l) => l.value === input.criteria?.postedWithin)?.label
      ?? String(input.criteria?.postedWithin ?? '');
    const why = posted.missing > 0
      ? `（另有 ${posted.missing} 个岗位平台没给发布时间，而你关掉了「缺发布时间按采集时间算」）`
      : posted.outOfRange > 0
        ? `（${posted.outOfRange} 个未投岗位的发布时间都早于这个窗口）`
        : '';
    startMsg = `未找到可投岗位：库中没有「${lbl}」发布的岗位${why}。`
      + `刷新时间来自各招聘平台，得先采集才会有新数据 —— 建议先跑一轮采集，或把「发布时间」放宽 / 勾上「缺发布时间按采集时间算」。`;
  } else if (kw.length && baseFiltered.length > 0 && baseFiltered.filter(kwMatch).length === 0) {
    startMsg = `未找到可投岗位：${baseFiltered.length} 个未投岗位没有一个匹配「目标职位」（${kw.join('、')}）。可在「我的档案」放宽/清空目标职位，或采集更多岗位后再投`;
  } else {
    // 0 候选诊断「具体版」：点名哪条条件卡了多少个，命中匹配分闸门时明确告诉用户调最低匹配分
    const drops: string[] = [];
      if (drop.score > 0) drops.push(`匹配分<${input.criteria!.minScore} 的 ${drop.score} 个`);
      if (drop.kw > 0) drops.push(`不含关键词「${kw.join('、')}」的 ${drop.kw} 个`);
      if (drop.city > 0) drops.push(`城市不符「${input.criteria?.city || ''}」的 ${drop.city} 个`);
    if (drop.salary > 0) drops.push(`薪资不符的 ${drop.salary} 个`);
    if (drop.remote > 0) drops.push(`非远程的 ${drop.remote} 个`);
    const detail = drops.length ? `（${drops.join('、')}）` : '';
    startMsg = `未找到可投岗位：其余未投岗位被筛选条件（城市/薪资/匹配分）过滤掉了${detail}`
      + (drop.score > 0 ? '；BOSS 待投岗多为未评分/低分（高分已被前几日投完）—— 想先验证链路就把「最低匹配分」调到 0（放开匹配分闸门），上限别用 0（不限制易触发账号风控）' : '；请检查城市/薪资/远程等条件是否过窄');
  }
  // 实时采集结果要让用户看得见：采到几个、本批是不是只投新鲜岗（否则「为什么 0 个」又说不清）
  if (liveCollected >= 0) {
    startMsg += liveFreshUsed
      ? `｜已实时从 BOSS 采集 ${liveCollected} 个在招岗位，本批只投这些新鲜岗位`
      : `｜实时采集到 ${liveCollected} 个但均与库内重复/未拿到新岗位，已回落全库筛选`;
  }
  onEvent?.({ type: 'start', total: picked.length, message: startMsg });

  // 6) 逐个投递
  const results: BatchItemResult[] = [];
  let applied = 0, needManual = 0, needCaptcha = 0, error = 0, skipped = 0, previewed = 0, riskStopped = 0;

  for (let i = 0; i < picked.length; i++) {
    const job = picked[i];
    // 平台解析：'auto' 模式按 apply_url 域名路由；否则用指定的或按来源推断
    let platform: ApplyPlatform;
    if (input.platform === 'auto') {
      const routed = platformFromUrl(job.apply_url);
      if (routed) {
        platform = routed;
      } else if (isWangshenUrl(job.apply_url)) {
        // 网申型链接（企业 ATS / 校招网申系统 / 企业自建招聘子域）：自动走独立「网申」通道投递
        // （用户诉求：遇到需要网申的岗位就自动调用网申功能，而不是回落到官网聚合或被跳过）
        platform = 'wangshen';
      } else {
        skipped++;
        results.push({
          jobId: job.id, company: job.company, position: job.position, platform: 'auto',
          status: 'skipped',
          message: `外部官网/微信文章链接，无法自动路由到已知平台或网申通道（${job.apply_url}），请手动投递`,
        });
        onEvent?.({ type: 'result', index: i, jobId: job.id, status: 'skipped', message: '外部链接，已跳过（请手动投递）' });
        continue;
      }
    } else {
      platform = input.platform || sourceToPlatform(job.source);
    }
    if (!isSupported(platform)) {
      skipped++;
      results.push({ jobId: job.id, company: job.company, position: job.position, platform, status: 'skipped', message: `不支持的平台：${platform}` });
      continue;
    }

    // ── 平台级风控封锁闸门（优先级最高，先于一切投递动作）──
    // 上一批若命中「额度到顶 / 账号异常」，这里直接短路：连续重试只会让风控升级。
    // （platform 已被上面的 auto 分支收窄为具体平台，无需再判 auto）
    {
      const blk = readPlatformRiskBlock(platform);
      if (blk) {
        riskStopped++;
        const mins = Math.max(1, Math.ceil((blk.until - Date.now()) / 60_000));
        const msg = `平台「${platform}」处于风控封锁期（约剩 ${mins} 分钟）：${blk.reason}；本批不投递。解封前请先在调试 Chrome 里人工处理。`;
        results.push({ jobId: job.id, company: job.company, position: job.position, platform, status: 'rate_limited', message: msg });
        onEvent?.({ type: 'result', index: i, jobId: job.id, status: 'rate_limited', message: msg });
        break;
      }
    }

    // ── 每日配额闸门 ──
    // 平台（尤其 BOSS）对骚扰式批量投递有**账号级**处罚，且每日打招呼额度有限。
    // 超限即提前收工并说明原因，绝不"闷头投到底"——这是账号安全线与"投得多"之间的取舍。
    if (dailyLimit > 0) {
      const used = todayAppliedCount(platform);
      if (used >= dailyLimit) {
        skipped++;
        const msg = `已达今日投递上限（${platform} ${used}/${dailyLimit}），本批提前结束以免触发平台风控；明日自动恢复，或在控制台调高「每日上限」`;
        results.push({ jobId: job.id, company: job.company, position: job.position, platform, status: 'skipped', message: msg });
        onEvent?.({ type: 'result', index: i, jobId: job.id, status: 'skipped', message: msg });
        // 指定平台：后面必然同样超限 → 直接收工；auto 模式：换下一个岗位看其它平台是否还有额度
        if (input.platform !== 'auto') break;
        continue;
      }
    }

    // 运行时间段闸门：到点即停（对标同类产品 TimeManager，但**不在服务端长 sleep**）。
    // 每处理一个岗位检查一次，用户可随时中断；cursor 已落库，下次启动继续剩余时间段。
    if (input.useSchedule) {
      const gate = checkAndAdvance(platform);
      if (gate.state === 'done') {
        onEvent?.({ type: 'result', index: i, jobId: job.id, status: 'skipped', message: `运行时间段已全部执行完毕：${gate.message}` });
        break;
      }
      if (gate.state === 'waiting') {
        // 不在服务端空转等待：把状态告知调用方后结束本批，等用户/定时器在时间段内重跑
        onEvent?.({ type: 'result', index: i, jobId: job.id, status: 'skipped', message: `${gate.message}（本批提前结束，避免在非运行时间段内消耗风控额度）` });
        break;
      }
      onEvent?.({
        type: 'progress', index: i, total: picked.length, jobId: job.id,
        company: job.company, position: job.position, platform,
        message: gate.message,
      } as any);
    }

    // 打招呼决策（对标同类产品 checkAutoChat）：命中硬规则或 AI 判否 → 跳过并留痕 skip_reason。
    // 这是「规则误杀可见」的数据来源：每一次不投都能回答"为什么不投"。
    if (input.criteria?.greetDecision !== false) {
      const decision = await decideGreet({
        platform,
        jobId: job.id,
        company: job.company,
        position: job.position,
        city: job.city,
        salary: job.salary,
        jd: job.jd,
        requirements: job.requirements,
        quarantine: job.quarantine,
        status: job.status,
        profile,
        minScore: input.criteria?.minScore,
        // 闸门以界面展示的匹配分为准（jobs.match_score）。不传这个，
        // 闸门就会用本地规则分另算一套，导致「界面 88 分却判匹配度过低跳过」。
        storedScore: job.match_score ?? null,
      });
      if (!decision.greet) {
        skipped++;
        try { db.updateJob(job.id, { skip_reason: decision.reason }); } catch { /* 留痕失败不阻断 */ }
        // 「已投递过该岗位」是由 applications 表判定（按公司+职位），而 excludeApplied 过滤的是
        // jobs.status —— 库内存在"同一公司+职位的重复行"时，未被标记的那行会**每批都被选中又跳过**，
        // 白白消耗配额与风控额度（实测「多益网络」连续两批被选中）。
        // 既然 applications 已证明投过，就把该行也标记为 applied，让下一批的 excludeApplied 直接滤掉。
        if (decision.reason.includes('已投递过')) {
          try { db.updateJob(job.id, { status: 'applied' }); } catch { /* 忽略 */ }
        }
        results.push({
          jobId: job.id, company: job.company, position: job.position, platform,
          status: 'skipped', message: `跳过：${decision.reason}`,
        });
        onEvent?.({ type: 'result', index: i, jobId: job.id, status: 'skipped', message: `跳过：${decision.reason}` });
        continue;
      }
      // 通过则清掉上一次的跳过原因，避免旧标记残留造成"看起来一直被跳过"
      try { db.updateJob(job.id, { skip_reason: null }); } catch { /* 忽略 */ }
    }

    if (i > 0 && intervalMs > 0) {
      // 拟人节流（对标 CareerBoom.ai「模拟真人操作节奏」）：固定等间距是强机器特征，
      // 用 humanizedGap 做双层抖动（±25% 常规 + 偶发 1.8–2.6× 长间隔），节奏更像人、降封号风险。
      const gap = humanizedGap(intervalMs, humanize, intervalRange);
      if (gap > intervalMs * 1.5) {
        console.log(`[batch] 拟人长间隔休息 ${gap}ms（模拟真人中途停顿，降风控识别）`);
      }
      await new Promise<void>((r) => setTimeout(r, gap));
    }
    onEvent?.({
      type: 'progress', index: i, total: picked.length, jobId: job.id,
      company: job.company, position: job.position, platform,
    });
    // 点击「投递」前的「读页面」微停顿（仅真实投递时）：模拟真人在点按钮前扫一眼岗位，
    // 与上面的间隔抖动共同构成「不像机器人」的节奏（对标 CareerBoom.ai）。预览模式跳过以保持快速。
    if (humanize && input.preview !== true) {
      await humanPreClickPause(humanize);
    }
    // 操作录屏（可选，对标 CareerBoom.ai）：真·CDP screencast，投递前后自动开/停。
    // 只读页面、只发 Page 域命令，不改变投递行为；失败只影响「有没有录像」。
    let recPath: string | undefined;
    if (input.record === true) {
      const started = await startRecording(platform, {
        dir: `evidence/vid-${platform}-${Date.now()}`,
        maxFrames: 1500,
        maxSeconds: 240,
      });
      if (!started.ok) console.warn(`[batch] 录屏启动失败（不影响投递）：${started.error}`);
    }
    let res: ApplyResult;
    try {
      res = await runApply({
        platform,
        profile: { ...toApplyProfile(profile), resume_path: resumePath },
        job: { id: job.id, company: job.company, position: job.position, apply_url: job.apply_url },
        jobUrl: job.apply_url || undefined,
        autofill: (profile.autofill as Record<string, string>) || undefined,
        headless: input.headless !== false ? false : true,
        realSend: input.realSend === true,
        // 双通道闸门一致性：realSend 非 true 时同时置 dryRun，
        // 否则官网通道(读 realSend)会预览、而邮箱通道(读 dryRun)仍会真实发信 —— 「仅预览」形同虚设。
        dryRun: input.realSend !== true || input.preview === true,
        // 平台通道（boss/zhilian/job51/liepin/nowcoder）读这个：投递=点一下按钮，没有可拦截的提交步骤，
        // 所以必须显式传 preview 才安全（它们不读 dryRun —— dryRun 在批量里缺省就是 true，会误伤正常投递）。
        preview: input.preview === true,
        sinceMinutes: input.sinceMinutes ? Number(input.sinceMinutes) : 10,
      });
    } catch (e: any) {
      // 标签/会话被关闭属于「正常收尾噪声」（对标同类产品 isClosingRelatedError）：
      // 用户手关窗口、超时回收、页面 detach 都会抛 Target closed / detached Frame。
      // 这类不算投递失败，计入 skipped 并写明原因，否则会污染失败率、把排查带偏到「平台风控」。
      if (isClosingRelatedError(e)) {
        skipped++;
        const closingMsg = `浏览器会话已关闭（${e?.message || String(e)}）`;
        results.push({ jobId: job.id, company: job.company, position: job.position, platform, status: 'skipped', message: closingMsg });
        onEvent?.({ type: 'result', index: i, jobId: job.id, status: 'skipped', message: closingMsg });
        await reclaimTabs(platform, i, picked.length, job.id, onEvent);
        continue;
      }
      error++;
      results.push({ jobId: job.id, company: job.company, position: job.position, platform, status: 'error', message: e?.message || String(e) });
      onEvent?.({ type: 'result', index: i, jobId: job.id, status: 'error', message: e?.message || String(e) });
      await reclaimTabs(platform, i, picked.length, job.id, onEvent);
      continue;
    } finally {
      // 录屏收尾：异常分支（continue）也会先走这里，保证不漏 stop
      if (input.record === true) {
        try {
          const rec = await stopRecording(platform);
          if (rec.ok && rec.frames) {
            recPath = rec.video || rec.player || rec.dir;
            console.log(`[batch] 录屏完成：${rec.frames} 帧 / ${rec.seconds}s → ${recPath}`);
          } else if (rec.error) {
            console.warn(`[batch] 停止录屏异常（不影响投递）：${rec.error}`);
          }
        } catch (e: any) { console.warn('[batch] 停录异常（不影响投递）：', e?.message); }
      }
    }

    // 完成一个岗位后收拾标签页：同域只留一个，避免「一个点击事件占一个窗口」越堆越多。
    // 主修复在 cdpDriver.ensureSession 的「优先接管已有标签」（会话失效不再新建）；
    // 这里是兜底清扫，顺带把历史泄漏的标签收敛掉。
    await reclaimTabs(platform, i, picked.length, job.id, onEvent);

    if (res.status === 'applied') {
      applied++;
      const appId = randomUUID();
      try {
        db.createApplication({
          id: appId,
          platform,
          company: res.company || job.company || '',
          position: res.position || job.position || '',
          salary: job.salary || '',
          city: job.city || '',
          job_url: job.apply_url || '',
          status: 'applied',
          // 网申走企业官网表单提交（非邮箱），与单岗接口（server/index.ts）口径一致；其余记邮箱投递
          login_method: platform === 'wangshen' ? 'website' : 'email',
          message: `由批量连投完成（${PLATFORM_LABEL[platform] || platform}）；匹配分 ${job.match_score ?? '—'}`,
        });
        db.updateJob(job.id, { status: 'applied' });
      } catch { /* 记录失败不阻断主流程 */ }

      // ── 投递成功后的「追加动作」（对标同类产品 AI写求职信 / 交换联系方式 / 发简历图）
      // 全部为可选，且**任何一步失败都不影响"已投递"这个既成事实**，只记日志。
      const extras: string[] = [];
      // 是否真正发出求职信（用于 A/B 策略打标，见下方 strategy 计算）
      let letterSentThisJob = false;
      try {
        if (input.criteria?.coverLetter) {
          const letter = await composeCoverLetter({
            platform, kind: 'letter', mode: 'ai',
            job: { id: job.id, company: job.company, position: job.position, city: job.city },
            jd: job.jd, profile,
          });
          if (letter.skipped) {
            extras.push(`求职信跳过（${letter.skipReason}）`);
          } else {
            const boxSels = ['.chat-input', 'textarea[placeholder*="沟通"]', 'div[contenteditable="true"]'];
            let sent = false;
            for (const sel of boxSels) {
              const r = await execAction(platform, 'fill', { selector: sel, value: letter.content, timeout: 5000 });
              if (r.ok) { sent = true; break; }
            }
            if (sent) {
              for (const t of ['发送', 'Send']) {
                if ((await execAction(platform, 'click', { text: t, timeout: 4000 })).ok) break;
              }
              markLetterSent({ platform, job: { id: job.id, company: job.company, position: job.position }, content: letter.content, source: letter.source });
              letterSentThisJob = true;
              extras.push(`求职信已发送（${letter.source}，${letter.content.length} 字）`);
            } else {
              extras.push('求职信已生成但未找到聊天输入框');
            }
          }
        }

        if (platform === 'liepin') {
          const exActions = getExchangeActions();
          if (exActions.length) {
            const exResults = await runExchangeActions('liepin', exActions);
            extras.push(`交换联系方式：${summarizeExchange(exResults)}`);
          }
        }

        // 简历聊天图：只在该岗位**没有 HR 邮箱**时才补（有邮箱的已走 PDF 邮件通道，不必重复发图）
        if (input.criteria?.chatResume) {
          const hasEmail = !!(job as any).hr_email;
          const channel = hasEmail ? 'email' : 'chat';
          if (channel === 'chat') {
            const png = await ensureChatResumePng(
              { id: job.id, company: job.company, position: job.position, jd: job.jd, requirements: job.requirements },
              { profile: profile as Record<string, any> },
            );
            if (png.ok && png.pngPath) {
              const sent = await sendChatResumeImage(platform, png.pngPath);
              extras.push(sent.ok ? `简历聊天图已发送（${png.cached ? '缓存' : '新生成'}）` : `简历聊天图未发送：${sent.detail}`);
            } else {
              extras.push(`简历聊天图生成失败：${png.error}`);
            }
          } else {
            extras.push('该岗位有 HR 邮箱，简历图通道跳过（已由 PDF 邮件通道覆盖）');
          }
        }
      } catch (e: any) {
        extras.push(`追加动作异常：${e?.message || e}`);
      }

      // ── A/B 策略打标 + 操作录屏回溯（对标 LoopCV / CareerBoom）──
      // strategy = 「是否带求职信」+「用了哪版简历」，如 `letter|tailored` / `no_letter|original`。
      // evidence_path = 投递瞬间对平台页截图，存 data/evidence，可审计「当时点了什么」、降低封号风险。
      try {
        const letter = (input.criteria?.coverLetter && letterSentThisJob) ? 'letter' : 'no_letter';
        const rv = getResumeVersion();
        const strategy = `${letter}|${rv}`;
        let evidencePath: string | undefined;
        try { evidencePath = await tryScreenshot(platform, appId); } catch (e: any) { console.warn('[batch] 投递后截图失败，不影响已投递：', e?.message); }
        db.updateApplication(appId, {
          strategy,
          evidence_path: evidencePath || null,
          video_path: recPath || null,
        });
        if (evidencePath) extras.push(`已留存操作证据截图`);
      } catch { /* 打标/截图失败不阻断主流程 */ }

      if (extras.length) {
        const last = results[results.length - 1];
        if (last && last.jobId === job.id) last.message = `${last.message}；${extras.join('；')}`;
        onEvent?.({ type: 'result', index: i, jobId: job.id, status: 'applied', message: extras.join('；') });
      }
    } else if (res.status === 'need_captcha') {
      needCaptcha++;
      onEvent?.({
        type: 'need_input', inputType: 'captcha', platform, jobId: job.id,
        company: job.company, position: job.position, message: res.message,
      });
    } else if (res.status === 'need_manual') {
      needManual++;
      onEvent?.({
        type: 'need_input', inputType: 'manual', platform, jobId: job.id,
        company: job.company, position: job.position, message: res.message,
      });
    } else if (res.status === 'unavailable') {
      // 岗位本身不可投（已下线 / 校招需单独简历 / 链接失效重定向），
      // 不是脚本错误，计入 skipped，避免污染失败数；并把状态落库，
      // 这样下次批量连投不会再把它选出来反复重试。
      skipped++;
      try { db.updateJob(job.id, { status: 'unavailable' }); } catch { /* 落库失败不阻断主流程 */ }
      results.push({
        jobId: job.id,
        company: res.company || job.company,
        position: res.position || job.position,
        platform,
        status: res.status,
        message: res.message,
      });
      onEvent?.({ type: 'result', index: i, jobId: job.id, status: res.status, message: res.message });
      continue;
    } else if (res.status === 'preview') {
      // 仅预览：已探测到投递入口但**未点击**。不计入 applied、不写 applications、不改岗位状态。
      previewed++;
      results.push({
        jobId: job.id, company: res.company || job.company, position: res.position || job.position,
        platform, status: res.status, message: res.message,
      });
      onEvent?.({ type: 'result', index: i, jobId: job.id, status: res.status, message: res.message });
      continue;
    } else if (res.status === 'rate_limited' || res.status === 'account_risk') {
      // 平台级风控信号：**立即中止整批**（继续投只会加重处罚），并落持久封锁标志供后续批次短路。
      // 这类**不能**计入 error —— 它不是脚本故障，而是"应当停手"的正常安全响应。
      riskStopped++;
      writePlatformRiskBlock(platform, res.status, res.message);
      results.push({
        jobId: job.id, company: res.company || job.company, position: res.position || job.position,
        platform, status: res.status, message: res.message,
      });
      onEvent?.({ type: 'result', index: i, jobId: job.id, status: res.status, message: res.message });
      break;
    } else if (res.status === 'need_login' || res.status === 'need_resume') {
      // 需要人工/环境介入（未登录、缺在线简历）：归入「需人工」而不是「失败」，
      // 否则会把环境问题算成投递故障，污染失败率与告警。
      needManual++;
      onEvent?.({
        type: 'need_input', inputType: 'manual', platform, jobId: job.id,
        company: job.company, position: job.position, message: res.message,
      });
    } else { error++; }

    results.push({
      jobId: job.id,
      company: res.company || job.company,
      position: res.position || job.position,
      platform,
      status: res.status,
      message: res.message,
    });
    onEvent?.({ type: 'result', index: i, jobId: job.id, status: res.status, message: res.message });
  }

  // 全部没投出去时，把跳过原因归类汇总进 message —— 否则用户只看到
  // 「成功 0、跳过 N」，完全不知道是筛选、匹配度还是登录态的问题（曾因此误判"投不出去"）。
  const reasonTop = (() => {
    if ((applied > 0 && riskStopped === 0) || !results.length) return '';
    const tally = new Map<string, number>();
    for (const r of results) {
      if (r.status === 'applied' || r.status === 'preview') continue;
      // 归一化：取「：」前的规则名（如「匹配度过低」「城市不符」「命中排除词」）
      const label = String(r.message || '').replace(/^跳过：/, '').split(/[（(：:]/)[0].trim() || '其他';
      tally.set(label, (tally.get(label) || 0) + 1);
    }
    const top = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    return top.length ? `｜未投递原因：${top.map(([k, v]) => `${k}×${v}`).join('、')}` : '';
  })();

  const summary: BatchResult = {
    total: picked.length,
    // 0 候选时把「为什么」一并带出（见 BatchResult.reason：非 SSE 调用也拿得到）
    ...(picked.length === 0 ? { reason: startMsg } : {}),
    applied, needManual, needCaptcha, error, skipped, previewed, riskStopped,
    results,
    message: `批量投递完成：共 ${picked.length} 个岗位，成功 ${applied}、需人工 ${needManual}、需验证码 ${needCaptcha}、失败 ${error}、跳过 ${skipped}`
      + (previewed ? `、仅预览 ${previewed}` : '')
      + (riskStopped ? `、风控中止 ${riskStopped}` : '')
      + reasonTop,
  };
  onEvent?.({ type: 'done', summary });
  return summary;
  } finally {
    release(lockKey, lockHolder);
  }
}
