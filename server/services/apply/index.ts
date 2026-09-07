/**
 * 跨平台专用投递脚本调度入口
 */
import { runBoss } from './boss.js';
import { runZhilian } from './zhilian.js';
import { runJob51 } from './job51.js';
import { runNowcoder } from './nowcoder.js';
import { runOfferbiu, runOfferbiuEmail } from './offerbiu.js';
import { runLiepin } from './liepin.js';
import { runEngine } from './engine.js';
import type { ApplyInput, ApplyPlatform, ApplyResult } from './types.js';

export const SUPPORTED_PLATFORMS: ApplyPlatform[] = ['boss', 'zhilian', 'job51', 'nowcoder', 'offerbiu', 'liepin'];

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
    default:
      return {
        platform: input.platform as ApplyPlatform,
        status: 'error',
        message: `不支持的平台：${input.platform}（支持：${SUPPORTED_PLATFORMS.join(' / ')}）`,
        logs: [],
      };
  }
}

export * from './types.js';
