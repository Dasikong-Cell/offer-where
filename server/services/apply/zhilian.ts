/**
 * 智联招聘（Zhaopin）专用投递脚本 —— 委托统一引擎
 *
 * 对齐职得鸭 zhilianHello.js 的一键投递思路：打开 JD → 点「立即投递」(.summary-planes__action
 * button.a-button) → 一键完成，依赖账号已填好的在线简历，**不碰任何表单/级联**（校招向导的籍贯
 * 级联商业工具也跳过）。用户选择「直接投不过滤」，故不做 AI 匹配门槛。
 *
 * 支持全套动作：hello(一键) / auto(批量) / keyword(关键词批量) / search(收集) / again / letter。
 */
import { runEngine } from './engine.js';
import type { ApplyInput, ApplyResult } from './types.js';

export async function runZhilian(input: ApplyInput): Promise<ApplyResult> {
  return runEngine(input);
}
