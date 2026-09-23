/**
 * 合约测试（离线可跑：不碰真实浏览器 / 不联网 / 不发信）
 * ==========================================================================
 * 覆盖两块此前**没有自动化护栏**的核心链路：
 *   A. 请求来源守卫 —— 本机 API 的安全边界（防「任意网页静默调用」触发真实投递/发信）
 *   B. 自动回复引擎合约 —— 登录态预检拦截 / 预览不发 / 真实发送 / 去重 / 单轮上限 /
 *      职位相关性过滤 / 平台占用让路
 *   C. 投递闸门与数据写入回归 —— 闸门以界面匹配分为准（防「界面 88 分却判匹配度过低」）、
 *      upsertJob 部分更新不得抹掉未传字段（防投递补 JD 时清空 company/position/apply_url）
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
import { extractToken, safeEqual, isAuthEnabled } from '../server/services/authToken.js';
import { getConversation, exec, getJob, upsertJob, kvSet } from '../server/db.js';
import { decideGreet, isExcludeHit } from '../server/services/apply/greetDecision.js';
import { detectRiskSignal, shouldAbortBatch, riskStatusOf } from '../server/services/riskSignals.js';
import { isPipeNoise, isClosingRelatedError } from '../server/services/safeOp.js';
import { SUPPORTED_PLATFORMS, PENDING_PLATFORMS, REGISTERED_PLATFORMS } from '../server/services/apply/index.js';
import { PLATFORM_PAGE } from '../server/services/platformHealth.js';
import { DELIVERY_PLATFORMS } from '../server/services/connection.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_DAILY_LIMIT, resolveDailyLimit, todayAppliedCount,
  readPlatformRiskBlock, writePlatformRiskBlock, clearPlatformRiskBlock,
} from '../server/services/apply/batch.js';
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
console.log('\n══════ A2. 访问令牌鉴权（分发 / 局域网暴露时的写接口闸门） ══════');
check('回环监听默认不启用鉴权（本机自用零影响）', !isAuthEnabled('127.0.0.1') && !isAuthEnabled('localhost'));
check('非回环监听自动启用鉴权', isAuthEnabled('0.0.0.0') && isAuthEnabled('192.168.1.20'));
{
  const old = process.env.REQUIRE_AUTH;
  process.env.REQUIRE_AUTH = '1';
  check('REQUIRE_AUTH=1 强制启用', isAuthEnabled('127.0.0.1'));
  process.env.REQUIRE_AUTH = '0';
  check('REQUIRE_AUTH=0 强制关闭', !isAuthEnabled('0.0.0.0'));
  if (old === undefined) delete process.env.REQUIRE_AUTH; else process.env.REQUIRE_AUTH = old;
}
check('提取 X-Auth-Token 头', extractToken({ headers: { 'x-auth-token': 'abc' } }) === 'abc');
check('提取 Authorization: Bearer', extractToken({ headers: { authorization: 'Bearer xyz' } }) === 'xyz');
check('空请求头得到空令牌', extractToken({ headers: {} }) === '');
check('常量时间比较：相等为真', safeEqual('tok123', 'tok123'));
check('常量时间比较：不等为假', !safeEqual('tok123', 'tok124') && !safeEqual('tok123', 'tok1234'));

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

// ═══════════════════════════════════════════════════════════
console.log('\n══════ C. 投递闸门 / 数据写入回归 ══════');

// C1 upsertJob 是「部分更新」语义：投递流程补 JD 时只传 {id, jd, requirements}，
//    绝不能因此把 company/position/apply_url 抹成 NULL（曾实测抹掉 11 条已投岗位）。
{
  const id = `${RUN_TAG}-upsert`;
  upsertJob({ id, source: 'boss', company: '测试公司A', position: '软件工程师', apply_url: 'https://example.com/job/1', city: '昆明' });
  upsertJob({ id, jd: '岗位职责：负责后端服务开发与维护。任职要求：熟悉 Java。', requirements: '' });
  const after = getJob(id);
  check('upsertJob 部分更新保留 company', after?.company === '测试公司A', String(after?.company));
  check('upsertJob 部分更新保留 position', after?.position === '软件工程师', String(after?.position));
  check('upsertJob 部分更新保留 apply_url', after?.apply_url === 'https://example.com/job/1', String(after?.apply_url));
  check('upsertJob 部分更新保留 city', after?.city === '昆明', String(after?.city));
  check('upsertJob 部分更新保留 source（不被默认 manual 覆写）', after?.source === 'boss', String(after?.source));
  check('upsertJob 部分更新确实写入 jd', String(after?.jd || '').includes('后端服务开发'));
  exec('DELETE FROM jobs WHERE id = ?', [id]);
}

// C2 匹配度闸门必须以**界面展示的匹配分**（jobs.match_score）为准。
//    此前闸门只认本地规则分：同一岗位界面 88 分、闸门算出 27 分 → 全被判「匹配度过低」跳过，
//    用户看到的是「投递在跑、却一个都投不出去」。
{
  const profile = { name: '测试求职者', city: '昆明', skills: 'Java,MySQL,Spring Boot' };
  const base = {
    company: '测试公司B', position: '软件工程师', city: '昆明',
    jd: '岗位职责：工作认真负责、有责任心、学习能力强、沟通表达良好。任职要求：具备团队协作精神。',
    profile, useAi: false,
  };

  const hi = await decideGreet({ ...base, storedScore: 80, minScore: 40 });
  check('界面分 80 ≥ 40 → 放行（不再被规则分误杀）', hi.greet === true, hi.reason);

  const lo = await decideGreet({ ...base, storedScore: 20, minScore: 40 });
  check('界面分 20 < 40 → 仍拦截', lo.greet === false, lo.reason);
  check('拦截理由标明分数来源为「界面匹配分」', lo.greet === false && String(lo.reason).includes('界面匹配分'), lo.reason);

  const none = await decideGreet({ ...base, storedScore: null, minScore: 40 });
  check('无界面分且规则分无信息量 → 不给结论、放行', none.greet === true, none.reason);
}

// ═══════════════════════════════════════════════════════════
console.log('\n══════ D. 投递安全闸门（风控信号 / 每日上限 / 排除词语境） ══════');

// D1 平台风控信号识别：不同类别 → 不同处置，且必须能中止整批
{
  const cap = detectRiskSignal('抱歉，今日沟通人数已达上限，请明天再试');
  check('BOSS 每日额度文案 → rate_limited', cap?.kind === 'rate_limited', cap?.kind || 'null');
  check('rate_limited → 中止整批', shouldAbortBatch('rate_limited'));

  const cap2 = detectRiskSignal('访问验证：请按住滑块，拖动到最右边');
  check('滑块/验证码 → captcha 且不中止整批', cap2?.kind === 'captcha' && !shouldAbortBatch('captcha'), cap2?.kind || 'null');
  check('captcha 复用既有状态 need_captcha', riskStatusOf('captcha') === 'need_captcha');

  const risk = detectRiskSignal('您的账号异常，请完成安全校验后重试');
  check('账号异常 → account_risk 且中止整批', risk?.kind === 'account_risk' && shouldAbortBatch('account_risk'), risk?.kind || 'null');
  check('account_risk 带可执行处置指引', /人工|手动|不要再重试/.test(risk?.action || ''));

  // 严重度优先：同时出现账号异常与验证码时，返回更严重的 account_risk
  check('多信号并存 → 取最严重（account_risk）', detectRiskSignal('账号异常 访问验证')?.kind === 'account_risk');

  // 负例：普通 JD 文本不得误触发（否则会白停一批）
  check('普通 JD 文本 → 不误报', detectRiskSignal('岗位职责：负责后端开发，要求沟通能力强、学习能力好') === null);
}

// D2 排除词的否定 / 名词化语境豁免（裸 includes 会误杀真实岗位）
{
  check('排除词：裸命中', isExcludeHit('该岗位为外包性质', '外包'));
  check('排除词：否定语境「不是外包」豁免', !isExcludeHit('本岗位不是外包，签正式合同', '外包'));
  check('排除词：否定语境「非外包」豁免', !isExcludeHit('非外包岗位，直签', '外包'));
  check('排除词：名词化「外包管理系统」豁免', !isExcludeHit('负责外包管理系统开发', '外包'));
  check('排除词：名词化「销售系统」豁免', !isExcludeHit('招聘销售系统开发工程师', '销售'));
  check('排除词：一处否定但另一处真命中 → 仍命中', isExcludeHit('不是外包，但有外包团队管理', '外包'));
  check('排除词：标点截断后不误豁免', isExcludeHit('外包，系统集成商', '外包'));
}

// D3 每日投递上限解析（请求参数 > 环境变量 > 默认 40；0 = 不限制）
{
  const saved = process.env.APPLY_DAILY_LIMIT;
  delete process.env.APPLY_DAILY_LIMIT;
  check('每日上限默认 40', DEFAULT_DAILY_LIMIT === 40 && resolveDailyLimit() === 40);
  process.env.APPLY_DAILY_LIMIT = '12';
  check('每日上限：环境变量可覆盖', resolveDailyLimit() === 12, String(resolveDailyLimit()));
  check('每日上限：请求参数优先于环境变量', resolveDailyLimit(75) === 75);
  if (saved === undefined) delete process.env.APPLY_DAILY_LIMIT; else process.env.APPLY_DAILY_LIMIT = saved;
  check('每日上限：0 表示不限制', resolveDailyLimit(0) === 0);
  check('今日已投数可读且非负', todayAppliedCount() >= 0);
}

// D4 平台风控封锁持久化（命中后短路后续批次，避免连续重试升级风控）
{
  const p = `${RUN_TAG}-plat`;
  check('封锁：初始为空', readPlatformRiskBlock(p) === null);
  writePlatformRiskBlock(p, 'rate_limited', '今日沟通人数已达上限');
  const blk = readPlatformRiskBlock(p);
  check('封锁：写入后可读到', !!blk && blk.reason.includes('上限'), blk?.reason || 'null');
  check('封锁：带未来解封时间', !!blk && blk.until > Date.now());
  clearPlatformRiskBlock(p);
  check('封锁：手动解封后失效', readPlatformRiskBlock(p) === null);

  // 过期即失效：写入一个过去的 until，应读不到（不必真等 6 小时）
  kvSet(`risk:block:${p}`, JSON.stringify({ until: Date.now() - 1000, reason: '过期' }));
  check('封锁：过期自动失效', readPlatformRiskBlock(p) === null);
  clearPlatformRiskBlock(p);
}

// D5 日志自激防护：管道类噪声必须被识别出来
//    （否则「为报告错误而写日志 → 再次写向已断开的管道 → 再抛同样的错」会无限放大，
//      实测单日写成 330 万行 / 240MB，全是同一句 EPIPE）
{
  check('EPIPE（管道断开）识别为管道噪声', isPipeNoise({ code: 'EPIPE' }));
  check('ERR_STREAM_DESTROYED 识别为管道噪声', isPipeNoise({ code: 'ERR_STREAM_DESTROYED' }));
  check('broken pipe 文案识别为管道噪声', isPipeNoise(new Error('Error: EPIPE: broken pipe, write')));
  check('真实业务错误不误判为管道噪声', !isPipeNoise(new Error('SQLITE_ERROR: no such table')) && !isPipeNoise('boom'));
  check('关闭态错误识别不受影响（回归）', isClosingRelatedError(new Error('Target closed')));
}

// ═══════════════════════════════════════════════════════════
console.log('\n══════ E. 平台注册完整性（新增平台必须「多处同步」） ══════');
// 背景：新增一个平台要同步 6 处，漏一处就会「界面能选、跑起来报不支持」的半注册。
// 这条测试把它变成机械校验 —— 以后加平台，改完跑一次 npm test 就知道漏没漏。
{
  const ROOT = fileURLToPath(new URL('..', import.meta.url));
  const cdp = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/browser/cdp.json'), 'utf8')) as Record<string, string>;
  const consoleHtml = fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8');
  const launcher = fs.readFileSync(path.join(ROOT, 'start_platforms.bat'), 'utf8');

  check('REGISTERED = SUPPORTED ∪ PENDING（无重复）',
    REGISTERED_PLATFORMS.length === SUPPORTED_PLATFORMS.length + PENDING_PLATFORMS.length
    && new Set(REGISTERED_PLATFORMS).size === REGISTERED_PLATFORMS.length,
    `registered=${REGISTERED_PLATFORMS.length} supported=${SUPPORTED_PLATFORMS.length} pending=${PENDING_PLATFORMS.length}`);
  check('SUPPORTED 与 PENDING 互不重叠（已实现的不能仍在待接入里）',
    !SUPPORTED_PLATFORMS.some((p) => PENDING_PLATFORMS.includes(p)));
  check('控制台下拉覆盖全部已登记平台', DELIVERY_PLATFORMS.length === REGISTERED_PLATFORMS.length,
    `console/connection=${DELIVERY_PLATFORMS.length} registered=${REGISTERED_PLATFORMS.length}`);

  for (const p of REGISTERED_PLATFORMS) {
    const missing: string[] = [];
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(String(cdp[p] || ''))) missing.push('cdp.json');
    if (!PLATFORM_PAGE[p]?.home) missing.push('platformHealth.PLATFORM_PAGE');
    if (!consoleHtml.includes(`{id:'${p}'`)) missing.push('console.html PLATFORMS');
    // 启动脚本按**端口**校验：允许多个平台共用同一窗口（如 offerbiu 与 official 共用 9227）
    const port = String(cdp[p] || '').split(':').pop() || '';
    if (!port || !launcher.includes(`:${port}:`)) missing.push('start_platforms.bat 端口表');
    if (!DELIVERY_PLATFORMS.includes(p)) missing.push('connection.DELIVERY_PLATFORMS');
    check(`平台注册多处同步：${p}`, missing.length === 0, missing.length ? `缺 ${missing.join(' / ')}` : '齐全');
  }

  // 端口唯一性：两个平台共用一个调试端口会导致「登录态串号」
  const ports = REGISTERED_PLATFORMS.map((p) => cdp[p]).filter(Boolean);
  check('各平台 CDP 端口互不冲突', new Set(ports).size === ports.length, `${ports.length} 个端口 / ${new Set(ports).size} 个唯一值`);
}

// ═══════════════════════════════════════════════════════════
console.log('\n══════ F. 安全不变量：preview 必须透传 ══════');
// 血泪：2026-09-21 单岗接口 /api/apply 没有透传 preview，本想"零副作用预览"，
// 结果真的点了国聘的「申请职位」按钮。这条测试机械校验：**每个 runApply 调用点都必须带 preview**。
{
  const ROOT = fileURLToPath(new URL('..', import.meta.url));
  const files = ['server/index.ts', 'server/services/apply/batch.ts'];
  let sites = 0, missing = 0;
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      if (!/runApply\s*\(\s*\{?/.test(line)) return;
      sites++;
      // 调用点参数可能跨多行：取其后 40 行内是否出现 preview
      const block = lines.slice(i, i + 40).join('\n');
      // 截到该次调用的结束（第一个顶格 "});" 或 "});"）以防跨到下一个调用
      const endIdx = block.search(/\n\s{0,10}\}\);/);
      const scoped = endIdx > 0 ? block.slice(0, endIdx) : block;
      if (!/preview\s*:/.test(scoped)) {
        missing++;
        console.log(`   ⚠️ ${f}:${i + 1} 的 runApply 调用未透传 preview`);
      }
    });
  }
  check(`runApply 调用点全部透传 preview（共 ${sites} 处）`, sites > 0 && missing === 0, missing ? `${missing} 处缺失` : '全部透传');
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
