/**
 * 并行检查各平台可用性：**连接 + 登录态 + 风控**
 * ==========================================================================
 * 判定逻辑已统一收敛到 `server/services/platformHealth.ts`（API `/api/platforms/health` 同源），
 * 本脚本只负责 CLI 输出与退出码，避免「CLI 一套规则、API 另一套规则」导致结论不一致。
 *
 * 三条判定铁律（详见 platformHealth 注释）：
 *   1. 先看 CDP 连不连得上 —— Chrome 没起时报「未登录」会把人带偏；
 *   2. **风控优先于登录态** —— 51job 被滑块拦时整页被替换，所有业务特征词都不命中；
 *   3. **anon 优先于 logged** —— 营销页的「简历优化」会误命中泛词「简历」。
 *
 * 运行：./node/node.exe node_modules/tsx/dist/cli.mjs scripts/check_logins.ts [platform...]
 * 退出码：0=全部可用 1=有未登录/被风控 2=有未知
 */
import { probePlatformHealth, type PlatformHealth } from '../server/services/platformHealth.js';

const targets = process.argv.slice(2).filter((a) => !a.startsWith('-'));

const ICON: Record<string, string> = {
  ok: '✅', 'not-logged-in': '❌', blocked: '🛑', offline: '🔌', unknown: '⚠️',
};
const LABEL: Record<string, string> = {
  ok: '可用', 'not-logged-in': '未登录', blocked: '被风控', offline: '未启动', unknown: '未知',
};

const list = await probePlatformHealth(targets.length ? targets : undefined, true);

console.log('\n══════ 平台可用性 ══════');
for (const h of list) {
  console.log(`\n${ICON[h.verdict] || '❔'} [${h.platform}] ${LABEL[h.verdict] || h.verdict}   ${h.endpoint}`);
  console.log(`   ${h.detail}`);
  if (h.matched.logged.length || h.matched.anon.length) {
    console.log(`   命中特征：已登录 ${JSON.stringify(h.matched.logged)} / 未登录 ${JSON.stringify(h.matched.anon)}`);
  }
  if (h.verdict !== 'ok') console.log(`   → ${h.action}`);
}

const ok = list.filter((h) => h.verdict === 'ok');
const needLogin = list.filter((h) => h.verdict === 'not-logged-in' || h.verdict === 'blocked');
const unknown = list.filter((h) => h.verdict === 'unknown' || h.verdict === 'offline');

console.log('\n══════ 汇总 ══════');
console.log(`可用 ${ok.length} ｜ 需人工处理 ${needLogin.length} ｜ 未知/未启动 ${unknown.length}（共 ${list.length}）`);
if (needLogin.length) {
  console.log('\n需人工处理：');
  for (const h of needLogin as PlatformHealth[]) {
    console.log(`  ${h.platform}：${h.verdict === 'blocked' ? '人工过一次滑块/短信验证' : `登录 → scripts/focus_login.ts ${h.platform}`}`);
  }
}
// 未登录与被风控都算「阻断」，返回 1；其余未知返回 2
process.exit(needLogin.length ? 1 : unknown.length ? 2 : 0);
