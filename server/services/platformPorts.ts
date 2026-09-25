/**
 * 平台 → CDP 端点：**唯一真相源**
 * ==========================================================================
 * 背景（2026-09-25 开箱实测暴露的 P0）：
 *   `data/browser/cdp.json` 是**运行时配置**，且 `data/` 整体被排除在分发包之外
 *   （有意为之：不带密钥/简历/登录态）。结果是**新机器上解压后投递功能完全不可用** ——
 *   因为投递执行路径 `browser.ts` 读不到该文件时返回 null，退化成 Playwright 自带
 *   Chromium（新机器没装 → 报「Chromium 浏览器未下载」，而接收方连 node/npx 都没有）。
 *
 *   更麻烦的是同一份端口表当时存在 4 套来源、兜底口径还不一致：
 *     - `browserHealth.ts`      有 9 端口兜底            ✅
 *     - `platformHealth.ts`     有兜底但只有 7 个平台，其余 `|| 9223` ❌（会把国聘/鱼泡等错配到 BOSS 端口）
 *     - `chatResumeImage.ts` / `tailoredResumePdf.ts`  硬编码 official/boss 两个 ✅（够用）
 *     - **`connection.ts` / `browser.ts`  完全没有兜底** ❌ ← 唯一真正干活的投递路径
 *
 * 本模块把端口表收敛为一份：
 *   - `DEFAULT_CDP_PORTS`：与 `start_all.bat` / `start_platforms.bat` 打开的端口保持一致
 *   - `resolveCdpEndpoint()`：**cdp.json 按 key 覆盖默认值**；两者都没有才返回 null
 *
 * ⚠️ 新增平台时同步点已从 6 处降为 **3 处**：
 *   ① `server/services/apply/types.ts`（ApplyPlatform 类型）
 *   ② 本文件 `DEFAULT_CDP_PORTS`（端口默认值）
 *   ③ `public/console.html` 的 PLATFORMS（前端下拉）
 *   （`connection.ts` / `browser.ts` / `platformHealth.ts` 已统一从本模块取；
 *     `start_all.bat` / `start_platforms.bat` 的端口也须与本表一致，合约测试会校验。）
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CDP_CONFIG_PATH = path.join(__dirname, '..', '..', 'data', 'browser', 'cdp.json');

/**
 * 各平台调试端口默认值。
 * 与 `start_all.bat`（9223–9227）和 `start_platforms.bat`（其余）打开的窗口一致。
 * `official` / `offerbiu` 共用 9227；`bosschat` 与 `boss` 共用 9223（复用同一窗口的聊天页）。
 */
export const DEFAULT_CDP_PORTS: Record<string, number> = {
  boss: 9223,
  bosschat: 9223,
  liepin: 9224,
  job51: 9225,
  zhilian: 9226,
  official: 9227,
  offerbiu: 9227,
  easyzhipin: 9228,
  job58: 9229,
  chinahr: 9230,
  dianzhang: 9231,
  yupao: 9232,
  maimai: 9233,
  ganji: 9234,
  iguopin: 9235,
  yingjiesheng: 9236,
  nowcoder: 9237,
};

/** 默认端点的 http 形式（供需要在 UI/日志里展示的调用方使用）。 */
export function defaultCdpEndpoint(key: string): string | null {
  const port = DEFAULT_CDP_PORTS[key];
  return port ? `http://127.0.0.1:${port}` : null;
}

/** 读取 cdp.json（每次调用重新读：允许运行中改端口而无需重启）。解析失败按「无覆盖」处理。 */
export function readCdpOverrides(): Record<string, string> {
  try {
    if (!fs.existsSync(CDP_CONFIG_PATH)) return {};
    const cfg = JSON.parse(fs.readFileSync(CDP_CONFIG_PATH, 'utf-8'));
    if (!cfg || typeof cfg !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(cfg)) {
      if (typeof v === 'string' && v.trim()) out[k] = v.trim();
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 解析某平台的 CDP 端点。
 * 优先级：`cdp.json` 的显式配置 > 内置默认端口 > `null`（未登记的平台）。
 *
 * 返回 `null` 是有意义的：调用方（`browser.ts`）会据此走 Playwright 自带 Chromium 的
 * 降级分支 —— 那是给**未登记平台**用的，不是给分发包缺配置用的。
 */
export function resolveCdpEndpoint(key: string): string | null {
  const override = readCdpOverrides()[key];
  if (override) return override;
  return defaultCdpEndpoint(key);
}
