/**
 * 独立「网申」平台：直接向企业官网招聘系统 / 校招网申系统投递。
 *
 * 复用 offerbiu.ts 的官网投递引擎 `runOfficialApply`，但使用**独立浏览器上下文 'wangshen'**
 * （对应独立 CDP 端口 9238），与 offerbiu 官网通道（'official' / 9227）彻底隔离：
 *   - 登录态不互相污染；
 *   - 表单记忆按域名独立；
 *   - 朋友各装一份时，「网申」是一个清晰可识别的独立入口（控制台「网申」Tab），
 *     而不是被埋在「offerbiu 邮箱聚合」里用不了。
 *
 * 投递流程完全继承自官网引擎：导航 → 只读预览（dryRun/未 realSend）→ 邮箱登录 →
 * 找投递/网申入口 → 填表 → 上传简历 → 提交 → 校验。
 */
import { runOfficialApply } from './offerbiu.js';
import type { ApplyInput, ApplyResult } from './types.js';

/** 网申专用浏览器上下文键（与 offerbiu 的 'official' 区分，端口 9238） */
export const WANGSHEN_CTX = 'wangshen';

export async function runWangshen(input: ApplyInput): Promise<ApplyResult> {
  return runOfficialApply(input, WANGSHEN_CTX);
}
