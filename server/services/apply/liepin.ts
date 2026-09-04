/**
 * 猎聘（Liepin）专用投递脚本 —— 委托统一引擎
 * 支持全套动作：hello(一键聊一聊) / auto(批量) / keyword(关键词批量) / search(收集) / again(复聊) / letter(求职信)
 * 对齐职得鸭 liepinHello.js：列表 .job-list-box>div → JD .job-intro-container → .btn-main(聊一聊) → 一键完成。
 */
import { runEngine } from './engine.js';
import type { ApplyInput, ApplyResult } from './types.js';

export async function runLiepin(input: ApplyInput): Promise<ApplyResult> {
  return runEngine(input);
}
