/**
 * 跨平台专用投递脚本调度入口
 */
import { runBoss } from './boss.js';
import { runZhilian } from './zhilian.js';
import { runJob51 } from './job51.js';
import { runNowcoder } from './nowcoder.js';
import { runOfferbiu, runOfferbiuEmail } from './offerbiu.js';
import { runLiepin } from './liepin.js';
import { runIguopin } from './iguopin.js';
import { runYupao } from './yupao.js';
import { runEngine } from './engine.js';
import type { ApplyInput, ApplyPlatform, ApplyResult } from './types.js';

export const SUPPORTED_PLATFORMS: ApplyPlatform[] = [
  'boss', 'zhilian', 'job51', 'nowcoder', 'offerbiu', 'liepin',
  // 2026-09-21 接入：国聘（API 采集 + 详情页投递）、鱼泡直聘（列表/详情采集 + 聊一聊投递）
  'iguopin', 'yupao',
];

/**
 * **已登记但尚未接入投递实现**的平台。
 *
 * 含义：基础设施已就绪（独立 CDP 窗口/端口、`cdp.json` 映射、控制台下拉、平台巡检主页与登录特征），
 * 但还没有各自的采集器与投递 DOM 实现 —— 需要各自登录后用调试窗口实机探针校准选择器。
 *
 * 为什么不直接放进 SUPPORTED_PLATFORMS：那样批量投递会把它当"可投平台"选出来，
 * 跑一半才失败；这里显式区分，让失败信息说清楚「是待接入，不是不认识」。
 * 接入某个平台时：实现 `runXxx` → 从本数组移除 → 加入 SUPPORTED_PLATFORMS（并在 console 上标注）。
 */
export const PENDING_PLATFORMS: ApplyPlatform[] = [
  'easyzhipin', 'job58', 'chinahr', 'dianzhang', 'maimai', 'ganji', 'yingjiesheng',
];

/** 已登记（含待接入）的全部平台 —— 控制台下拉与巡检的口径 */
export const REGISTERED_PLATFORMS: ApplyPlatform[] = [...SUPPORTED_PLATFORMS, ...PENDING_PLATFORMS];

/** 是否为「已登记但投递实现待接入」的平台 */
export function isPendingPlatform(platform: string): boolean {
  return (PENDING_PLATFORMS as string[]).includes(platform);
}

/** 支持「全套」批量/搜索/复聊/求职信动作的平台（由统一引擎处理） */
const ENGINE_PLATFORMS = new Set(['zhilian', 'boss', 'job51', 'liepin']);

export function isSupported(platform: string): platform is ApplyPlatform {
  return (SUPPORTED_PLATFORMS as string[]).includes(platform);
}

/**
 * offerbiu 聚合岗位的 apply_url 多为外部官网/平台链接。
 * 按域名把「平台链接」路由到对应平台引擎（复用已登录持久会话一键投），
 * 纯企业官网 / 微信文章 / 问卷等则走 offerbiu.ts 通用官网投递。
 */
function platformFromUrl(url: string): ApplyPlatform | null {
  if (!url) return null;
  if (/51job\.com/.test(url)) return 'job51';
  if (/zhaopin\.com/.test(url)) return 'zhilian';
  if (/zhipin\.com/.test(url)) return 'boss';
  if (/nowcoder\.com/.test(url)) return 'nowcoder';
  return null;
}

export async function runApply(input: ApplyInput): Promise<ApplyResult> {
  const action = input.action || 'hello';
  // 非 hello 动作（auto/keyword/search/again/letter）走统一引擎
  if (action !== 'hello' && ENGINE_PLATFORMS.has(input.platform)) {
    return runEngine(input);
  }
  // offerbiu 官网投递：按 apply_url 域名路由（命中平台→引擎一键投；微信推文→邮箱投；否则通用官网投递）
  if (input.platform === 'offerbiu') {
    const url = input.jobUrl || input.job?.apply_url || '';
    const routed = platformFromUrl(url);
    if (routed) {
      return runEngine({ ...input, platform: routed });
    }
    // 微信招聘推文：没有可点的网申入口，只给 HR 邮箱 + 标题格式 → 走邮箱投递
    if (input.channel === 'email' || /mp\.weixin\.qq\.com/.test(url)) {
      return runOfferbiuEmail(input);
    }
    return runOfferbiu(input);
  }
  switch (input.platform) {
    case 'boss':
      return runBoss(input);
    case 'zhilian':
      return runZhilian(input);
    case 'job51':
      return runJob51(input);
    case 'liepin':
      return runLiepin(input);
    case 'nowcoder':
      return runNowcoder(input);
    case 'iguopin':
      return runIguopin(input);
    case 'yupao':
      return runYupao(input);
    default:
      // 已登记但投递实现待接入：给出可执行的下一步，而不是笼统的"不支持"
      if (isPendingPlatform(String(input.platform))) {
        return {
          platform: input.platform as ApplyPlatform,
          status: 'need_manual',
          message: `平台「${input.platform}」已登记（窗口/巡检/控制台就绪），但自动投递实现尚未接入。`
            + `请先在调试窗口登录该平台，再运行实机探针校准页面选择器；`
            + `当前可投平台：${SUPPORTED_PLATFORMS.join(' / ')}`,
          logs: [],
        };
      }
      return {
        platform: input.platform as ApplyPlatform,
        status: 'error',
        message: `不支持的平台：${input.platform}（支持：${SUPPORTED_PLATFORMS.join(' / ')}）`,
        logs: [],
      };
  }
}

export * from './types.js';
