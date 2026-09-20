/**
 * 合约测试（离线可跑：不碰真实浏览器 / 不联网 / 不发信）
 * ==========================================================================
 * 覆盖两块此前**没有自动化护栏**的核心链路：
 *   A. 请求来源守卫 —— 本机 API 的安全边界（防「任意网页静默调用」触发真实投递/发信）
 *   B. 自动回复引擎合约 —— 登录态预检拦截 / 预览不发 / 真实发送 / 去重 / 单轮上限 /
 *      职位相关性过滤 / 平台占用让路
 *
 * 设计：用注入的 `probe` 桩 + `registerChatDriver` 注册 mock 驱动，摆脱对真实 CDP 窗口
 *       与登录态的依赖 —— 因此可在 CI（无 Chrome、无账号）中稳定运行。
 *
 * 运行：tsx scripts/contract_tests.ts
 */
import '../server/env.js';
import { runAutoReply, registerChatDriver } from '../server/services/apply/autoReplyRunner.js';
import { tryAcquire, release } from '../server/services/apply/sessionLock.js';
import { checkRequestOrigin, buildAllowedOrigins } from '../server/services/requestGuard.js';
import { getConversation, exec } from '../server/db.js';
import type { ChatDriver, ConvSummary } from '../server/services/apply/chatTypes.js';

let pass = 0, fail = 0;
const fails: string[] = [];
function check(name: string, ok: boolean, detail = '') {
  ok ? pass++ : fail++;
  if (!ok) fails.push(name);
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`);
}

const RUN_TAG = 'ct-' + Date.now().toString(36);

// ═══════════════════════════════════════════════════════════
console.log('\n══════ A. 请求来源守卫（本机 API 安全边界） ══════');
const allowed = buildAllowedOrigins(4400);
check('GET 任意来源放行（只读无副作用）', checkRequestOrigin({ method: 'GET', origin: 'http://evil.com', allowed }).ok);
check('OPTIONS 预检放行', checkRequestOrigin({ method: 'OPTIONS', origin: 'http://evil.com', allowed }).ok);
check('写请求 + 白名单来源放行', checkRequestOrigin({ method: 'POST', origin: 'http://127.0.0.1:4400', allowed }).ok);
{
  const r = checkRequestOrigin({ method: 'POST', origin: 'http://evil.com', allowed });
  check('写请求 + 非白名单来源拒绝', !r.ok && r.reason.includes('来源'), r.ok ? '被放行(危险!)' : r.reason);
}
{
  const r = checkRequestOrigin({ method: 'POST', secFetchSite: 'cross-site', allowed });
  check('写请求 + 跨站无 Origin 拒绝', !r.ok && r.reason.includes('跨站'), r.ok ? '被放行(危险!)' : r.reason);
}
check('写请求 + 无 Origin 本机脚本放行', checkRequestOrigin({ method: 'POST', allowed }).ok);
{
  const ext = buildAllowedOrigins(4400, ['http://192.168.1.20:4400/']);
  check('EXTRA_ORIGINS 追加生效且去尾斜杠', ext.has('http://192.168.1.20:4400'));
  check('EXTRA_ORIGINS 来源放行（局域网共用）', checkRequestOrigin({ method: 'POST', origin: 'http://192.168.1.20:4400', allowed: ext }).ok);
}

// ═══════════════════════════════════════════════════════════
console.log('\n══════ B. 自动回复引擎合约（mock 驱动，无需真实浏览器） ══════');

interface MockCalls { openChat: number; openConversation: number; sendText: number; sendResume: number; texts: string[]; }

function makeDriver(convs: ConvSummary[], hrMsg: string, position: string | null) {
  const calls: MockCalls = { openChat: 0, openConversation: 0, sendText: 0, sendResume: 0, texts: [] };
  const driver: ChatDriver = {
    platform: 'boss',
    async openChat() { calls.openChat++; },
    async listConversations() { return convs.map((c) => ({ ...c })); },
    async openConversation() { calls.openConversation++; return true; },
    async readConversation() {
      return { messages: [{ side: 'hr' as const, text: hrMsg }], lastHr: hrMsg, position };
    },
    async sendText(t: string) { calls.sendText++; calls.texts.push(t); return true; },
    async sendResume() { calls.sendResume++; return true; },
  };
  return { driver, calls };
}
function mkConv(i: number, company: string): ConvSummary {
  return { key: `${RUN_TAG}-${i}`, name: `HR${i}`, company, lastMsg: '您好', unread: true, raw: '' };
}
function collect() {
  const evs: any[] = [];
  return { evs, emit: (e: any) => evs.push(e) };
}
const okProbe = async () => ({ verdict: 'ok' });
const fresh = () => { release('boss', 'reply'); release('boss', 'apply'); };

// B1 未注册平台
{
  fresh();
  const { evs, emit } = collect();
  const r = await runAutoReply('zhilian', { probe: okProbe }, emit);
  check('未注册平台 → 报错且不动浏览器', r.sent === 0 && evs.some((e) => e.type === 'error' && String(e.message).includes('暂不支持')));
}

// B2 登录态 offline → 拦截
{
  fresh();
  const { driver, calls } = makeDriver([mkConv(1, 'A公司')], '你好', '算法工程师');
  registerChatDriver('boss', driver);
  const { evs, emit } = collect();
  const r = await runAutoReply('boss', { probe: async () => ({ verdict: 'offline', detail: 'CDP 无响应', action: '请启动 Chrome' }) }, emit);
  check('登录态 offline → 拦截并报错', r.sent === 0 && evs.some((e) => e.type === 'error' && String(e.message).includes('登录态异常')));
  check('登录态 offline → openChat 未被调用（未空跑）', calls.openChat === 0, `openChat=${calls.openChat}`);
}

// B3 登录态 blocked → 拦截
{
  fresh();
  const { driver, calls } = makeDriver([mkConv(2, 'B公司')], '你好', null);
  registerChatDriver('boss', driver);
  const { evs, emit } = collect();
  await runAutoReply('boss', { probe: async () => ({ verdict: 'blocked', detail: '风控页', action: '人工过验证' }) }, emit);
  check('登录态 blocked → 拦截且未开跑', calls.openChat === 0 && evs.some((e) => e.type === 'error'));
}

// B4 unknown → 放行
{
  fresh();
  const { driver, calls } = makeDriver([mkConv(3, 'C公司')], '你好，方便聊聊吗', null);
  registerChatDriver('boss', driver);
  const { evs, emit } = collect();
  await runAutoReply('boss', { probe: async () => ({ verdict: 'unknown' }), useAi: false, realSend: false }, emit);
  check('登录态 unknown → 放行（继续列会话）', calls.openChat === 1 && evs.some((e) => e.type === 'list'));
}

// B5 预览模式不发消息
{
  fresh();
  const { driver, calls } = makeDriver([mkConv(4, 'D公司'), mkConv(5, 'E公司')], '你好，方便聊聊吗', null);
  registerChatDriver('boss', driver);
  const { evs, emit } = collect();
  const r = await runAutoReply('boss', { probe: okProbe, useAi: false, realSend: false }, emit);
  check('预览模式 → 不发任何消息', calls.sendText === 0 && calls.sendResume === 0, `sendText=${calls.sendText}`);
  check('预览模式 → emit dry 事件×2', evs.filter((e) => e.type === 'dry').length === 2);
  check('预览模式 → sent=0', r.sent === 0);
}

// B6 真实发送 + 去重
{
  fresh();
  const convs = [mkConv(6, 'F公司'), mkConv(7, 'G公司')];
  const { driver, calls } = makeDriver(convs, '你好，请发一份简历', null);
  registerChatDriver('boss', driver);
  const { evs, emit } = collect();
  const r = await runAutoReply('boss', { probe: okProbe, useAi: false, realSend: true, throttleSec: 1, hrCooldownSec: 0 }, emit);
  check('真实发送 → 每条会话各发一次', calls.sendText === 2 && r.sent === 2, `sendText=${calls.sendText} sent=${r.sent}`);
  check('真实发送 → 落库 last_hr_message', String(getConversation(convs[0].key)?.last_hr_message || '').includes('简历'));

  fresh();
  const second = collect();
  const r2 = await runAutoReply('boss', { probe: okProbe, useAi: false, realSend: true, throttleSec: 1, hrCooldownSec: 0 }, second.emit);
  check('同一 HR 消息重复 → 全部跳过(processed)', r2.sent === 0 && second.evs.filter((e) => e.type === 'skipped' && e.reason === 'processed').length === 2, `sent=${r2.sent}`);
}

// B7 单轮上限
{
  fresh();
  const { driver, calls } = makeDriver([mkConv(8, 'H公司'), mkConv(9, 'I公司'), mkConv(10, 'J公司')], '在吗', null);
  registerChatDriver('boss', driver);
  const { evs, emit } = collect();
  await runAutoReply('boss', { probe: okProbe, useAi: false, realSend: true, throttleSec: 1, hrCooldownSec: 0, maxPerRun: 1 }, emit);
  check('单轮上限 maxPerRun=1 → 只发 1 条', calls.sendText === 1, `sendText=${calls.sendText}`);
  check('单轮上限 → done reason=cap-reached', evs.some((e) => e.type === 'done' && e.reason === 'cap-reached'));
}

// B8 职位相关性过滤
{
  fresh();
  const { driver, calls } = makeDriver([mkConv(11, 'K公司')], '你好', '销售代表');
  registerChatDriver('boss', driver);
  const { evs, emit } = collect();
  await runAutoReply('boss', { probe: okProbe, useAi: false, realSend: true, throttleSec: 1, hrCooldownSec: 0, targetPositions: ['算法工程师'] }, emit);
  check('HR 职位不相关 → 跳过(position-unrelated)', calls.sendText === 0 && evs.some((e) => e.type === 'skipped' && e.reason === 'position-unrelated'));
}

// B9 平台被投递占用 → 自动回复让路
{
  fresh();
  const { driver, calls } = makeDriver([mkConv(12, 'L公司')], '你好', null);
  registerChatDriver('boss', driver);
  tryAcquire('boss', 'apply');
  const { evs, emit } = collect();
  const r = await runAutoReply('boss', { probe: okProbe }, emit);
  check('平台被投递占用 → 自动回复让路', r.sent === 0 && calls.openChat === 0 && evs.some((e) => e.type === 'error' && String(e.message).includes('占用')));
  release('boss', 'apply');
}

console.log(`\n══════ 合约测试汇总 ══════`);
console.log(`通过 ${pass} / 共 ${pass + fail}`);

// 清理：删除本次测试写入的会话行（conv_key 以 RUN_TAG 开头），避免污染真实库
// 注意必须用 exec（DELETE 不返回结果集，用 query 会抛错导致清理静默失效）
try { exec(`DELETE FROM hr_conversations WHERE conv_key LIKE ?`, [`${RUN_TAG}%`]); }
catch (e: any) { console.log('⚠️ 测试数据清理失败：' + (e?.message || e)); }

if (fail) {
  console.log('失败项：\n - ' + fails.join('\n - '));
  process.exitCode = 1;
} else {
  console.log('✅ 全部通过');
}
