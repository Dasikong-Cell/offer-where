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
import { acceptResumeRequest, openConversation, __setExForTest } from '../server/services/apply/bossChat.js';
import { acceptResumeRequestGeneric, detectResumeRequestClause } from '../server/services/apply/resumeCard.js';
import { liepinChatDriver, __setExForTest as __setExForTestLiepin } from '../server/services/apply/liepinChat.js';
import {
  zhilianChatDriver, job51ChatDriver, nowcoderChatDriver, iguopinChatDriver,
  yupaoChatDriver, chinahrChatDriver, yingjieshengChatDriver,
} from '../server/services/apply/platformsChat.js';
import { guardFabricatedLocation } from '../server/services/apply/autoReply.js';
import { tryAcquire, release } from '../server/services/apply/sessionLock.js';
import { checkRequestOrigin, buildAllowedOrigins, canInjectToken, lanOriginsFromIps } from '../server/services/requestGuard.js';
import { extractToken, safeEqual, isAuthEnabled, SIDE_EFFECT_GET_PATHS, PUBLIC_READ_GET_PATHS, isPublicReadGet, isConsoleAsset } from '../server/services/authToken.js';
import { getConversation, upsertConversation, exec, getJob, upsertJob, kvSet, detectRemote } from '../server/db.js';
import { checkResumeCompliance } from '../server/services/apply/resumeCompliance.js';
import { computeAbReport } from '../server/services/apply/applyAbTest.js';
import { decideGreet, isExcludeHit, alreadyApplied } from '../server/services/apply/greetDecision.js';
import { detectRiskSignal, shouldAbortBatch, riskStatusOf } from '../server/services/riskSignals.js';
import { isPipeNoise, isClosingRelatedError } from '../server/services/safeOp.js';
import { SUPPORTED_PLATFORMS, PENDING_PLATFORMS, REGISTERED_PLATFORMS, classifyDelivery, isWangshenUrl, aggregatorPlatformOf } from '../server/services/apply/index.js';
import { PLATFORM_PAGE } from '../server/services/platformHealth.js';
import { DELIVERY_PLATFORMS } from '../server/services/connection.js';
import { DEFAULT_CDP_PORTS } from '../server/services/platformPorts.js';
import { FALLBACK_PORT_PROFILES } from '../server/services/browserHealth.js';
import { CN_CITIES } from '../server/services/cityData.js';
import {
  DEFAULT_CITY, listCities, cityCount, allCities, cityMatches, findCity,
} from '../server/services/cities.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_DAILY_LIMIT, resolveDailyLimit, todayAppliedCount,
  readPlatformRiskBlock, writePlatformRiskBlock, clearPlatformRiskBlock,
  humanizedGap,
} from '../server/services/apply/batch.js';
import type { ChatDriver, ConvSummary } from '../server/services/apply/chatTypes.js';
import { parseDenyList, parseFileList, findDenyHits, maskToken } from './pii_guard.js';
import { collectBatFiles, inspectBatFile } from './bat_encoding.js';
// 🔴 剥注释必须用状态机版：那个「斜杠+星号 … 星号+斜杠」的朴素正则不区分
//    「注释」与「代码里的字符串」，本仓库实测被 `server/index.ts` 注释里的一句 `/api/*`
//    误导，删掉 60 行后 3968 字符的真实代码 ⇒ 静态断言**假阴性**。
import { stripComments, countMatches } from './lib/stripComments.js';

let pass = 0, fail = 0;
const fails: string[] = [];
// 模块级项目根 + 文本读取助手：所有把「仓库相对路径」当入参的断言都依赖它，
// 必须在顶层定义（原第 1448 行的局部定义让 A2 段的顶层调用取不到它 → 崩溃）。
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const readText = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
function check(name: string, ok: boolean, detail = '') {
  ok ? pass++ : fail++;
  if (!ok) fails.push(name);
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`);
}

// ── 「因环境缺失而整段跳过」的断言必须**计数并在汇总行写明** ────────────────────
// 背景（2026-09-27）：CI 上没有 data/browser/cdp.json（data/ 不入库），有 16 条端口断言
// 被跳过，而汇总行只印「通过 295 / 共 295」—— 看日志的人会以为覆盖了 295 条，
// 实则是「295 条可跑的全过 + 16 条没跑」。**绿得比实际更绿**是本项目反复踩的坑，
// 所以跳过的条数必须出现在汇总行里，谁看日志都能立刻知道分母是完整的还是缩水的。
let skipped = 0;
const skipReasons = new Map<string, number>();
function skip(n: number, reason: string) {
  if (n <= 0) return;
  skipped += n;
  skipReasons.set(reason, (skipReasons.get(reason) || 0) + n);
}

// ── selftest.ts 自己的「跳过会计」也要诚实（2026-09-28）──────────────────────────
// 实测缺陷（不是推测）：CI 上真有 7 条断言没执行，汇总行却只印「跳过 6 项」。
//   · A 块把条数写死成一个常数 ⇒ 谁往块里加一条断言，分母就静默缩水；
//   · 「LLM 未生效」分支只 console.log 不计入 skip ⇒ 连写死的数都对不上。
// 查出来的办法：**同一棵树在两地跑**，本地 58 / CI「51 通过 + 6 跳过」= 57，差 1。
// 与上面 cdp 那段是同一个坑（绿得比实际更绿），只是这次踩在 selftest.ts 里。
{
  const CT_ROOT = fileURLToPath(new URL('..', import.meta.url));
  const src = fs.readFileSync(path.join(CT_ROOT, 'scripts/selftest.ts'), 'utf8');
  // 先剥注释再匹配：本块自己的说明文字里就带着这些字样，不剥会被「自己的注释」满足。
  const code = stripComments(src);
  const hardcoded = /skip\s*\+=\s*\d/.test(code);
  check(
    'selftest: 跳过条数由数组长度决定（不写死常数，加断言不会让分母静默缩水）',
    /skipCheck\(\s*resumeChecks\.length\s*,/.test(code) && !hardcoded,
    hardcoded ? '仍有写死的 skip += <数字>' : '按 resumeChecks.length 计数',
  );
  check(
    'selftest: 「LLM 未生效」这类跳过也必须计数（不能只打印）',
    /跳过防幻觉校验[^\n]*\n\s*skipCheck\(\s*1\s*,/.test(code),
    '只 console.log 不计 skip ⇒ 汇总行的「跳过 N 项」必然少报',
  );
  check(
    'selftest: 汇总行把每条跳过原因都列出来，而不是写死一句固定话术',
    /跳过 \$\{skip\} 项：\$\{skipReasons\.join\(/.test(code),
  );
}

const RUN_TAG = 'ct-' + Date.now().toString(36);

// ═══════════════════════════════════════════════════════════
console.log('\n══════ A. 请求来源守卫（本机 API 安全边界） ══════');
const allowed = buildAllowedOrigins(4400);
check('OPTIONS 预检放行（中间件短路）', checkRequestOrigin({ method: 'OPTIONS', origin: 'http://evil.com', allowed }).ok);
check('GET 本机脚本/直接导航放行（无 Origin、无跨站标记）', checkRequestOrigin({ method: 'GET', allowed }).ok);
check('GET 直接导航放行（Sec-Fetch-Site: none）', checkRequestOrigin({ method: 'GET', secFetchSite: 'none', allowed }).ok);
check('GET + 白名单 Origin 放行（Vite 开发前端）', checkRequestOrigin({ method: 'GET', origin: 'http://127.0.0.1:4400', allowed }).ok);
{
  const r = checkRequestOrigin({ method: 'GET', origin: 'http://evil.com', allowed });
  check('GET + 非白名单 Origin 拒绝（防恶意页 fetch）', !r.ok && r.reason.includes('来源'), r.ok ? '被放行(危险!)' : r.reason);
}
{
  const r = checkRequestOrigin({ method: 'GET', secFetchSite: 'cross-site', allowed });
  check('GET + 跨站无 Origin 拒绝（防 <img> 触发带副作用的 GET）', !r.ok && r.reason.includes('跨站'), r.ok ? '被放行(危险!)' : r.reason);
}
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
{
  // 局域网自动白名单（2026-09-29 手机端）：HOST 非回环时服务端用 lanOriginsFromIps
  // 把本机网卡地址并入白名单，免去手填 EXTRA_ORIGINS。
  // 关键：手机浏览器的**同源写请求**也会带 Origin: http://<局域网IP>:<端口>，
  // 不并入就会被判 403 —— 症状是「手机能打开、一保存/投递就失败」。
  const lan = lanOriginsFromIps(4400, ['192.168.1.20', ' 10.0.0.7 ', '']);
  check('lanOriginsFromIps 生成局域网来源并跳过空值',
    lan.length === 2 && lan.includes('http://192.168.1.20:4400') && lan.includes('http://10.0.0.7:4400'),
    `实际=${JSON.stringify(lan)}`);
  const allowedLan = buildAllowedOrigins(4400, lan);
  check('局域网自动并入后，手机同源写请求放行',
    checkRequestOrigin({ method: 'POST', origin: 'http://192.168.1.20:4400', allowed: allowedLan }).ok,
    '漏并白名单 ⇒ 手机端「能打开、一保存就 403」');
}
{
  // 🔴 令牌注入范围（2026-09-30 修的严重漏洞）
  // 修前：鉴权开启时 `GET /` **无条件**把令牌写进 HTML。实测匿名 GET / 拿到完整 48 位令牌，
  //       再用它 GET /api/resume/file 拿到 348KB 简历 ⇒ 公网暴露时鉴权被完全绕过。
  // 因为是「公开分发 + 可暴露到公网」的产品，这条必须有合约测试钉住，否则会被改回去。
  check('本机直连（回环 + 无转发头）允许注入令牌',
    canInjectToken({ remoteAddress: '127.0.0.1', headers: {} }) === true);
  check('IPv6 回环允许注入',
    canInjectToken({ remoteAddress: '::1', headers: {} }) === true);
  check('IPv6 映射的 IPv4 回环允许注入',
    canInjectToken({ remoteAddress: '::ffff:127.0.0.1', headers: {} }) === true);

  check('局域网手机（私有网段 + 无转发头）允许注入',
    canInjectToken({ remoteAddress: '192.168.1.20', headers: {} }) === true,
    '手机 PWA 走局域网，禁掉会让用户每次手填令牌');
  check('10/8 私有段允许注入',
    canInjectToken({ remoteAddress: '10.0.0.7', headers: {} }) === true);
  check('172.16/12 私有段允许注入',
    canInjectToken({ remoteAddress: '172.20.3.4', headers: {} }) === true);

  check('🔴 公网 IP 一律不注入',
    canInjectToken({ remoteAddress: '203.0.113.9', headers: {} }) === false);
  check('🔴 带 X-Forwarded-For（反代/隧道）不注入 —— 这正是公网暴露那条路径',
    canInjectToken({ remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.9' } }) === false,
    '漏这条 ⇒ 隧道把请求从回环送进来，又会把令牌注入给任何人');
  check('🔴 带 X-Real-IP 不注入',
    canInjectToken({ remoteAddress: '127.0.0.1', headers: { 'x-real-ip': '203.0.113.9' } }) === false);
  check('🔴 带 Forwarded 不注入',
    canInjectToken({ remoteAddress: '127.0.0.1', headers: { Forwarded: 'for=203.0.113.9' } }) === false);
  check('🔴 带 X-Forwarded-Host 不注入',
    canInjectToken({ remoteAddress: '127.0.0.1', headers: { 'x-forwarded-host': 'abc.example.com' } }) === false);
  check('空 remoteAddress 不注入（拿不到来源就不给令牌）',
    canInjectToken({ remoteAddress: '', headers: {} }) === false);
}
{
  // 服务端必须**真的调用** canInjectToken（静态断言防「函数写了没接线」）
  // ⚠️ 这条曾因注释剥离器缺陷**假阴性**：`server/index.ts` 注释里的一句 `/api/*`
  //    让朴素正则删掉 3968 字符真实代码（含这里的调用点），代码正确却报失败。
  const idx = fs.readFileSync(path.join(fileURLToPath(new URL('..', import.meta.url)), 'server', 'index.ts'), 'utf8');
  const idxCode = stripComments(idx);
  check('server/index.ts 在注入令牌前调用 canInjectToken 判定',
    /canInjectToken\s*\(\s*\{[^}]*remoteAddress/.test(idxCode),
    '只定义不调用 ⇒ 漏洞照旧');
  // 「恰好 1 次」而不是「有过」：注入点必须唯一。出现 2 处意味着有第二条注入路径没人审计。
  check('令牌注入判定点恰好 1 处（不允许多出一条未审计的注入路径）',
    countMatches(idxCode, /canInjectToken\s*\(/g) === 1,
    `实际 ${countMatches(idxCode, /canInjectToken\s*\(/g)} 处`);

  // 控制台必须有手填令牌的兜底：否则经反代的用户拿到「静默 401 且无法修复」的页面
  const html = fs.readFileSync(path.join(fileURLToPath(new URL('..', import.meta.url)), 'public', 'console.html'), 'utf8');
  const htmlCode = stripComments(html);
  check('控制台支持从 localStorage 读取令牌（反代场景的兜底）',
    /localStorage\.getItem\(\s*AUTH_TOKEN_STORE\s*\)/.test(htmlCode),
    '没有兜底 ⇒ 公网用户无令牌可填，页面全 401');
  check('控制台在 401 时提示补令牌',
    /res\.status\s*===\s*401/.test(htmlCode) && /promptForToken\s*\(/.test(htmlCode));
  check('控制台令牌改用 let（可在填完后更新）',
    /let\s+AUTH_TOKEN\s*=/.test(htmlCode));
}
{
  // 移动端可用性：控制台必须有抽屉导航（原先手机上 .side{display:none} ⇒ 没有任何导航入口）
  const html = fs.readFileSync(path.join(fileURLToPath(new URL('..', import.meta.url)), 'public', 'console.html'), 'utf8');
  check('控制台含移动端抽屉导航（汉堡 + 遮罩 + 展开类）',
    html.includes('id="menuBtn"') && html.includes('id="navBackdrop"') && /\.side\.open\s*\{/.test(html),
    '缺任一 ⇒ 手机上无法切换视图（原实现直接隐藏侧栏）');
}
{
  // ── 自动回复平台清单必须「单一真相源」（2026-10-03 用户反馈：「平台下拉只有两项」） ──
  // 🔴 原实现前后端**各写一份硬编码**：控制台下拉只列 boss/liepin；后端 `GET /api/auto-reply/run`
  //    也只放行这两个，并把其它平台**静默降级成 boss** —— 用户以为在回复智联，实际在 BOSS 上操作
  //    （有真实副作用的静默降级，最难发现）；同时已真机校准的 zhilian 被白白挡在门外。
  //    这组断言把「两处硬编码」的形态钉死。
  const ROOT = fileURLToPath(new URL('..', import.meta.url));
  const idxCode = stripComments(fs.readFileSync(path.join(ROOT, 'server', 'index.ts'), 'utf8'));
  const htmlCode = stripComments(fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8'));
  const runnerSrc = fs.readFileSync(path.join(ROOT, 'server', 'services', 'apply', 'autoReplyRunner.ts'), 'utf8');

  check('自动回复 run 准入不再硬编码平台白名单',
    !/\['boss'\s*,\s*'liepin'\]\s*\.includes/.test(idxCode),
    "不得出现 ['boss','liepin'].includes(...) —— 它把未列入的平台静默降级成 boss");
  check('自动回复 run 准入改用 isAutoReplyPlatform（唯一一处）',
    countMatches(idxCode, /isAutoReplyPlatform\s*\(/g) === 1,
    `实际 ${countMatches(idxCode, /isAutoReplyPlatform\s*\(/g)} 处`);
  check('控制台平台下拉不再硬编码选项（改为读接口）',
    !htmlCode.includes(`$('#replyPlatform').innerHTML = '<option value="boss">`),
    '旧写法：直接 innerHTML 塞死两项');
  check('控制台确实调用了平台清单接口',
    htmlCode.includes('/api/auto-reply/platforms'),
    '下拉数据必须来自 GET /api/auto-reply/platforms');
  check('平台清单由 autoReplyRunner 统一导出（单一真相源）',
    /export function listAutoReplyPlatforms\s*\(/.test(runnerSrc) &&
    /export function isAutoReplyPlatform\s*\(/.test(runnerSrc),
    '两端都应只读这里，而不是各写一份');
}
{
  // ── 「邮箱直投」面板（offerbiu）三段必须真能用 ──
  // 2026-10-03 用户截图：① 「keywords 不能为空」 ③ 「❌ undefined」。
  // 根因是三个独立缺陷：① 采集按钮发空 body；② ③ 不传 jobIds；③ 前端读 `ev.msg` 而后端 SSE
  // 文案字段是 `message`。另外 `quarantine`/`force` 在 console.html 里各 0 处 ——
  // 换前端时把「跨公司串号」隔离交互整个弄丢了（后端闸门还在，用户却点不到）。
  const R = fileURLToPath(new URL('..', import.meta.url));
  const mail = stripComments(fs.readFileSync(path.join(R, 'public', 'console.html'), 'utf8'));

  check('邮箱直投不再读取不存在的 ev.msg',
    !/\bev\.msg\b/.test(mail),
    '后端 SSE 的文案字段是 message；读 msg 只会得到 undefined（旧实现显示「❌ undefined」）');
  check('邮箱直投采集按钮发送真实 keywords（不再发空 body）',
    /collect-keywords'[\s\S]{0,300}?keywords:\s*kws/.test(mail),
    "旧实现发 body:'{}' ⇒ 后端 400「keywords 不能为空」");
  check('邮箱直投提交时带上 jobIds 与 emails 映射',
    /email-apply'[\s\S]{0,300}?jobIds\b/.test(mail) && /\bemails\s*[,}]/.test(mail),
    '不传 jobIds ⇒ 后端回 error「未选择任何岗位」；emails 是规避微信限流的预取证邮箱');
  check('邮箱直投保留「跨公司串号」隔离交互（隔离项默认不勾 + 强制开关）',
    // ⚠️ 必须锚在 `<input id="emailForce">` **元素**上，不能只写 includes('emailForce')：
    //    JS 里还有 `$('#emailForce').checked`，只测字符串存在 ⇒ 把复选框整个删掉断言照样绿
    //    （2026-10-03 破坏对照当场抓出这条假区分力）。
    /<input[^>]*\bid="emailForce"/.test(mail) && /q\?'':' checked'/.test(mail),
    'quarantine/force 曾被整个丢失 —— 后端闸门还在，但用户无法区分也无法强制');
  check('邮箱直投隔离项默认不勾选（安全底线，不得一键全选）',
    /q\?'':' checked'/.test(mail),
    '退化成恒 checked ⇒ 用户一不留神就把简历发给错误公司（不可撤回）');
  check('邮箱直投强制开关确实透传 force',
    /\$\('#emailForce'\)\.checked/.test(mail),
    '只在 UI 画开关、不把值发出去 ⇒ 闸门形同虚设');
  check('换行常量 NL 只在顶层定义一次（多面板共用）',
    countMatches(mail, /const NL\s*=/g) === 1 && /^const NL\s*=/m.test(mail),
    '曾写在 #replyRun 处理器体内 ⇒ 邮箱直投一调用就 ReferenceError，而 console:check 只查语法查不出');
}

// ═══════════════════════════════════════════════════════════
console.log('\n══════ A1.4 注释剥离器（静态断言的地基，2026-09-30） ══════');
{
  // 为什么单独给它一块测试：**这个函数错了，别人的绿就是假的**。
  // 朴素正则（「斜杠+星号 … 星号+斜杠」）不区分「注释」与「字符串字面量」，
  // 实测被 server/index.ts 注释里的一句 `/api/*` 误导，删掉 3968 字符真实代码 ⇒
  // 上面那条 canInjectToken 断言代码明明正确却报失败（假阴性），排查了半天。
  // 反向的坑同样存在：剥不干净 ⇒ 断言被自己的注释满足（假阳性）。
  // 这两个方向都要钉住，否则「全绿」本身不可信。

  // ① 原始 bug：注释里出现 斜杠+星号 不得吞掉后面的真实代码
  // ⚠️ 这个用例的第一版**没牙**：我只写了注释 + 后续代码，但没在后面放「星号+斜杠」的
  //    收尾符号 ⇒ 朴素正则找不到配对的收尾，于是什么都不删，用例照样绿。
  //    真实文件里之所以中招，正是因为**后面还有别的块注释**（那个收尾符号被借用了）。
  //    ⇒ 必须把「后面还有一个块注释」也写进来，才复现得了。
  const trap = [
    '// 第一版只放行 /api/* ，结果 GET / 直接 401',
    'app.get("/", (req, res) => { return canInjectToken(req); });',
    '/* 下面是另一段逻辑 */',
    'const other = 1;',
  ].join('\n');
  check('注释里的「斜杠+星号」不会吞掉后续真实代码（原始假阴性 bug）',
    /canInjectToken\s*\(/.test(stripComments(trap)) && /const other/.test(stripComments(trap)),
    '朴素正则会把两行真实代码一起删掉（后面那个块注释的收尾符号被借用了）');

  // ② URL 的 // 必须保留（console.html 里全是 https://）
  check('URL 的 // 不被当成行注释',
    stripComments('const u = "https://example.com/a"; const k = 1;').includes('const k = 1;') &&
    stripComments('see https://example.com/x then const z=1;').includes('const z=1;'));

  // ③ 字符串里的注释符号必须保留，真注释必须删掉
  check('字符串内的注释符号保留、真注释删除',
    stripComments('const a = "http://x/*y"; // 真注释').includes('http://x/*y') &&
    !stripComments('const b = 1; // 真注释').includes('真注释') &&
    !stripComments('const c = 1; /* 真注释 */ const d = 2;').includes('真注释'));

  // ④ 块注释删除后保留换行 ⇒ 报错行号不漂
  check('块注释删除后行号不漂（保留换行）',
    stripComments('a\n/* x\ny\n*/b').split('\n').length === 4,
    `实际 ${stripComments('a\n/* x\ny\n*/b').split('\n').length} 行`);

  // ⑤ countMatches 是「恰好 N 次」的载体 —— 裸 includes 会被残留文本满足
  check('countMatches 按完整词组精确计数（裸子串会多数）',
    countMatches('<p>仅预览</p><p>仅预览（不真正投递）</p>', /仅预览（不真正投递）/g) === 1 &&
    countMatches('<p>仅预览</p><p>仅预览（不真正投递）</p>', /仅预览/g) === 2);

  // ⑥ 实文件不塌陷：剥离后长度若骤降，说明「剥多了」，所有下游断言都在骗人
  const mpSrc = fs.readFileSync(path.join(fileURLToPath(new URL('..', import.meta.url)), 'public', 'console.html'), 'utf8');
  check('console.html 剥离注释后正文未塌陷（<60% 视为剥多了）',
    stripComments(mpSrc).length > mpSrc.length * 0.6,
    `${stripComments(mpSrc).length} / ${mpSrc.length}`);
}
{
  // 门禁脚本自身必须用可靠剥离器（否则门禁自己也可能是假绿/假红）
  const ROOT = fileURLToPath(new URL('..', import.meta.url));
  // ⚠️ 这条检查**刻意不调用 stripComments**：它要守的就是 stripComments 本身，
  //    若依赖它，「剥离器坏了」会连累这条也报错，而报出的却是
  //    「contract_tests.ts 用了朴素正则」——**误导维护者去改一个没坏的文件**。
  //    （实测踩过：破坏 stripper 后这条跟着红，信息指向完全错误的地方。）
  // ⇒ 直接扫原文。为了不让本文件自己的**说明文字**命中（自指假阳性），
  //   ① 上面相关注释一律用文字描述，不写裸序列；
  //   ② 针脚拆成两段拼接，源码里没有连续形态。
  const NEEDLE = '[\\s\\S]*?' + '\\*' + '\\/';
  for (const f of ['scripts/contract_tests.ts', 'scripts/mp_check.ts', 'scripts/guide_check.ts']) {
    const raw = fs.readFileSync(path.join(ROOT, f), 'utf8');
    check(`${f} 不使用朴素正则剥块注释（改用 scripts/lib/stripComments.ts）`,
      !raw.includes(NEEDLE),
      '朴素正则不分「注释」与「字符串字面量」⇒ 门禁假阴性（代码对却报失败）或假阳性（注释满足断言）');
  }
  // 单一真相源：剥离器只有一份实现，且门禁确实在用它（不是又抄了一份）
  const lib = fs.readFileSync(path.join(ROOT, 'scripts/lib/stripComments.ts'), 'utf8');
  check('剥注释实现单一真相源（只有 lib/stripComments.ts 导出它）',
    /export\s+function\s+stripComments\s*\(/.test(lib));
  check('contract_tests 真的 import 该实现（没有本地另抄一份）',
    /import\s*\{[^}]*\bstripComments\b[^}]*\}\s*from\s*['"]\.\/lib\/stripComments\.js['"]/.test(
      fs.readFileSync(path.join(ROOT, 'scripts/contract_tests.ts'), 'utf8')),
    '另抄一份 ⇒ 两处必然漂移，且改一处不会让另一处生效');
  check('mp_check 也 import 同一实现（不各自维护一份）',
    /import\s*\{[^}]*\bstripComments\b[^}]*\}\s*from\s*['"]\.\/lib\/stripComments\.js['"]/.test(
      fs.readFileSync(path.join(ROOT, 'scripts/mp_check.ts'), 'utf8')));
}

// ═══════════════════════════════════════════════════════════
console.log('\n══════ A1.45 反向隧道（公网暴露的护栏，2026-09-30） ══════');
{
  // 静态部分：钉住「不能少的几行」。行为部分由 `npm run relay:e2e` 真跑整条链路
  // （那个会 spawn 子进程，刻意不进本文件 —— 本文件要能在无 Chrome、无网络的 CI 里稳定跑）。
  const ROOT = fileURLToPath(new URL('..', import.meta.url));
  const read = (f: string) => stripComments(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  // ⚠️ 必须剥注释：这两个文件的注释里正面写着 x-forwarded-for / 令牌 这些词，
  //    不剥的话断言会被**自己的说明文字**满足 —— 本仓库反复踩的坑。
  const relay = read('relay/relay.mjs');
  const client = read('relay/client.mjs');

  check('隧道中继与客户端都在仓库里（不是只存在于某台机器上）',
    relay.length > 500 && client.length > 500);

  // ── 安全不变量 ①：转发头必须补齐 ──
  check('🔴 中继转发前补齐转发头（不靠 nginx 配置正确）',
    /ensureForwardingHeaders\s*\(/.test(relay) && countMatches(relay, /ensureForwardingHeaders\s*\(/g) >= 2,
    '缺这条 ⇒ 公网请求被后端当成「本机直连」⇒ 令牌注入到公网可读的页面');
  check('🔴 隧道客户端无条件设置 x-forwarded-for',
    /headers\[\s*['"]x-forwarded-for['"]\s*\]\s*=/.test(client),
    '缺这条 ⇒ 同上的令牌泄露（实测：停用两层补头后隧道真的吐出了完整 48 位令牌）');
  check('🔴 隧道客户端无条件设置 x-real-ip',
    /headers\[\s*['"]x-real-ip['"]\s*\]\s*=/.test(client));

  // ── 安全不变量 ②：后端未开鉴权时拒绝启动 ──
  check('🔴 客户端探测后端鉴权状态，未开启（非 401/403）就拒绝启动',
    /probe\.status\s*!==\s*401\s*&&\s*probe\.status\s*!==\s*403/.test(client) &&
    /--allow-no-auth/.test(client),
    '默认 HOST=127.0.0.1 时鉴权是关的；忘了设 REQUIRE_AUTH=1 就把不可撤销的投递能力挂上公网');
  check('客户端在拒绝启动前把「怎么修」打印出来（不是只说一句失败）',
    /REQUIRE_AUTH=1/.test(client) && /EXTRA_ORIGINS/.test(client),
    '只说失败 ⇒ 用户不知道要加哪两个环境变量');

  // ── 安全不变量 ③：密钥卫生 ──
  check('🔴 中继用常量时间比较隧道密钥（防时序侧信道）',
    /timingSafeEqual/.test(relay) && /timingSafeStrEq\s*\(/.test(relay));
  check('客户端拒绝从命令行接收密钥（argv 会进进程列表 / 日志）',
    /process\.argv\.includes\(\s*['"]--secret['"]\s*\)/.test(client),
    'argv 里的密钥等于公开');
  // ⚠️ 这条前两版都太钝，值得记下来：
  //    ① 版禁「console 里出现 TUNNEL_SECRET」→ 把「打印密钥**文件路径**」（有用的报错）误判；
  //    ② 版加负向断言排除 _FILE → 又被**示例文案**里的 `TUNNEL_SECRET=xxx` 误判。
  //    ⇒ 真正要禁的不是「提到变量名」，而是「把**值**送进 console」这一形态。
  //      变量名出现在帮助文案里是好事（用户需要知道要设哪个变量）。
  check('客户端不把密钥**值**送进日志（提到变量名的帮助文案不算）',
    !/console\.(log|error)\([^)]*\$\{TUNNEL_SECRET\}/.test(client) &&
    !/console\.(log|error)\([^)]*,\s*TUNNEL_SECRET\s*[,)]/.test(client) &&
    !/\+\s*TUNNEL_SECRET\b/.test(client),
    '`${TUNNEL_SECRET}` / 作为实参 / 字符串拼接 —— 任一形态都会把密钥写进日志');
  // 🔴 更隐蔽的一条：连中继的 URL 上挂着 ?secret=<密钥>。
  //    若日志里打 url.toString() / url.href，密钥就跟着进日志了。
  check('🔴 客户端打印中继地址时不带查询串（?secret= 不能进日志）',
    /\$\{url\.origin\}/.test(client) &&
    !/console\.(log|error)?[^;]*url\.(toString|href)/.test(client) &&
    !/log\([^)]*url\.searchParams/.test(client),
    'url.toString() 会带上 ?secret=<密钥>');
  check('中继不记录 URL / 请求体（明文不过日志）',
    !/console\.(log|error)\([^)]*req\.url/.test(relay) &&
    !/console\.(log|error)\([^)]*bodyB64/.test(relay),
    '中继能看到明文（TLS 在本机终止）⇒ 记日志等于把简历内容写进磁盘');

  // ── 协议卫生：逐跳首部必须剥掉 ──
  check('两端都剥逐跳首部（RFC 7230 §6.1）',
    /HOP_BY_HOP/.test(relay) && /HOP_BY_HOP/.test(client) &&
    /'transfer-encoding'/.test(relay) && /'transfer-encoding'/.test(client),
    '转发 transfer-encoding / connection ⇒ 响应体错乱或连接挂住');

  // ── 可用性：几条「会让人查半天」的兜底 ──
  check('中继在隧道未连接时返回 502 + 可读原因（不是挂住）',
    /隧道未连接/.test(relay) && /502/.test(relay));
  check('客户端断线指数退避重连（不是狂重连打爆中继）',
    /backoff/.test(client) && /BACKOFF_MAX/.test(client));
  check('客户端对响应体也有上限（防单条隧道请求把内存吃光）',
    /MAX_BODY/.test(client) && /res\.on\(\s*['"]data['"]/.test(client));

  // ── 端到端自检脚本必须存在（这是唯一能证明链路真的通的东西）──
  check('存在反向隧道端到端自检脚本（真 spawn 两端跑一遍）',
    fs.existsSync(path.join(ROOT, 'scripts/relay_e2e.ts')),
    '静态断言证明不了「链路真的通、且真的不泄露令牌」');
  const e2e = read('scripts/relay_e2e.ts');
  check('端到端自检用**真实的** canInjectToken 判定（不是自己重写一份）',
    /import\s*\{[^}]*canInjectToken[^}]*\}\s*from\s*['"][^'"]*requestGuard\.js['"]/.test(e2e),
    '自己重写一份 ⇒ 测的是测试自己的逻辑，线上那份改坏了也照样绿');
  check('端到端自检含「本机直连仍注入令牌」的反向对照',
    /TOKEN:/.test(e2e) && /NO-TOKEN/.test(e2e),
    '只测「不注入」的话，把注入功能整个删掉也是绿的 —— 过度纠正照样过');

  // ── 文档必须存在且和代码对得上（本仓库「文档漂移」是复发型故障）──
  const docPath = path.join(ROOT, 'relay/README.md');
  check('存在 tunnel 部署说明 relay/README.md', fs.existsSync(docPath));
  if (fs.existsSync(docPath)) {
    const doc = fs.readFileSync(docPath, 'utf8');
    // 说明里承诺的三个环境变量，必须真的是代码里认的那几个
    check('文档写的后端环境变量与实际代码一致（REQUIRE_AUTH / EXTRA_ORIGINS / HOST）',
      doc.includes('REQUIRE_AUTH=1') && doc.includes('EXTRA_ORIGINS') &&
      /isAuthEnabled/.test(read('server/services/authToken.ts')) &&
      /EXTRA_ORIGINS/.test(read('server/index.ts')),
      '文档说一个、代码认一个 ⇒ 用户照着做还是 403');
    // ⚠️ 中继侧要查的是**小写** `headers.host` —— Node 会把头部名归一化成小写，
    //    第一版这里写了大写 `Host` 于是恒为 false（断言自己错了，不是文档错了）。
    check('文档点明了 nginx 必须保留 Host 头（否则中继选不到隧道）',
      /proxy_set_header\s+Host/.test(doc) &&
      /headers\.host\b|headers\[\s*['"]host['"]\s*\]/.test(relay),
      '中继靠 Host 首段选隧道，Host 被改写 ⇒ 全部 502');
    // 最要紧的一条：文档必须把「朋友自用是负收益」说在显眼处，
    // 否则用户会照着把后端挂上公网，只为让朋友用他们本来能自己装的东西。
    check('文档明确写了「朋友自用 = 负收益，应各自本地安装」',
      doc.includes('负收益') && /各自本地安装|本地安装/.test(doc),
      '这条不写清 ⇒ 用户会为一个不需要的场景承担公网暴露风险');
  }
}

// ═══════════════════════════════════════════════════════════
console.log('\n══════ A1.5 PWA（手机「添加到主屏幕」= 独立窗口 App） ══════');
{
  const ROOT = fileURLToPath(new URL('..', import.meta.url));
  const pub = (f: string) => path.join(ROOT, 'public', f);

  // ── manifest 本体 ──
  // ⚠️ 不能用 require() 读 .webmanifest（Node 会当 .js 解析并报 SyntaxError），
  //    必须 readFileSync + JSON.parse。
  const mfRaw = fs.readFileSync(pub('manifest.webmanifest'), 'utf8');
  let mf: any = null;
  try { mf = JSON.parse(mfRaw); } catch (e: any) {
    check('manifest.webmanifest 是合法 JSON', false, e?.message || '解析失败');
  }
  if (mf) {
    check('manifest.webmanifest 是合法 JSON', true);
    check('manifest 声明 name / short_name / display:standalone',
      !!mf.name && !!mf.short_name && mf.display === 'standalone',
      `name=${mf.name} short=${mf.short_name} display=${mf.display}`);
    // start_url/scope 必须是根：控制台视图靠 #hash 切换，指到子路径会让「装完点开」落到空白
    check('manifest start_url 与 scope 均为 /',
      mf.start_url === '/' && mf.scope === '/',
      `start_url=${mf.start_url} scope=${mf.scope}`);
    // theme_color 必须与 CSS 的 --brand 一致，否则安卓状态栏和界面是两种橙
    const con = fs.readFileSync(pub('console.html'), 'utf8');
    const brand = (con.match(/--brand:\s*(#[0-9a-fA-F]{3,8})/) || [])[1];
    check('manifest theme_color 与控制台 --brand 一致',
      !!brand && String(mf.theme_color).toLowerCase() === brand.toLowerCase(),
      `manifest=${mf.theme_color} --brand=${brand}`);
  }

  // ── 图标：Chromium 不接受 .ico 作 maskable；iOS 的 apple-touch-icon 也只吃 PNG ──
  const iconList: any[] = Array.isArray(mf?.icons) ? mf.icons : [];
  const iconSizes = iconList.map((i) => String(i.sizes));
  check('manifest 图标含 192x192 与 512x512',
    iconSizes.includes('192x192') && iconSizes.includes('512x512'),
    `实际=${JSON.stringify(iconSizes)}`);
  check('manifest 图标含 maskable 用途（安卓自适应图标）',
    iconList.some((i) => String(i.purpose || '').includes('maskable')),
    '缺 maskable ⇒ 安卓主屏上图标被套白底圆框');
  // 图标必须真的存在，否则安装时会静默降级成字母占位图
  const missingIcons = iconList
    .map((i) => String(i.src || ''))
    .filter((src) => !fs.existsSync(path.join(ROOT, 'public', src.replace(/^\//, ''))));
  check(`manifest 引用的图标文件都存在（共 ${iconList.length} 个）`,
    missingIcons.length === 0, missingIcons.length ? `缺失=${missingIcons.join(',')}` : '全部存在');
  check('apple-touch-icon.png 存在（iOS 添加到主屏幕用）',
    fs.existsSync(pub('apple-touch-icon.png')));

  // ── 控制台接线 ──
  const con = fs.readFileSync(pub('console.html'), 'utf8');
  check('控制台 <head> 链接 manifest',
    /<link[^>]+rel=["']manifest["'][^>]*>/.test(con));
  check('控制台声明 theme-color（安卓状态栏取色）',
    /<meta[^>]+name=["']theme-color["']/.test(con));
  check('控制台引用 apple-touch-icon', con.includes('rel="apple-touch-icon"'));
  check('控制台注册 Service Worker（注册失败不得抛错）',
    con.includes("serviceWorker' in navigator") && con.includes('register('),
    '缺存在性判断 ⇒ 局域网 http 下直接抛 TypeError');
  check('控制台含「添加到主屏幕」引导条（安装按钮 + 永久关闭）',
    con.includes('id="pwaBar"') && con.includes('id="pwaInstallBtn"') && con.includes('id="pwaCloseBtn"'),
    '缺任一 ⇒ 手机用户不知道可以装成 App');

  // ── 布局陷阱（2026-09-29 真机验收踩到，必须钉住） ──
  // 引导条若不放在 .main 内部，它是 flex 容器的兄弟节点 ⇒ 挤进文档流把整页推下去，
  // 且 sticky 的包含块变成 body，偏移永不生效；两个 sticky 相叠时手机上点「安装」会被
  // 下面的 .topbar 拦截（Playwright 报 "intercepts pointer events"）。
  const mainIdx = con.indexOf('<div class="main">');
  const barIdx = con.indexOf('id="pwaBar"');
  const topbarIdx = con.indexOf('<div class="topbar">');
  check('引导条位于 .main 内部且在 .topbar 之前',
    mainIdx > -1 && barIdx > mainIdx && barIdx < topbarIdx,
    `main=${mainIdx} bar=${barIdx} topbar=${topbarIdx}`);
  check('引导条不使用 position:sticky（避免与 .topbar 的 sticky 叠加被拦截点击）',
    !/\.pwa-bar\{[^}]*position:\s*sticky/.test(con),
    '两个 sticky 叠加 ⇒ 后者的偏移盖住前者，手机上点不到「安装」');
  check('引导条图标显式约束 CSS 宽高（不靠 HTML 属性）',
    /\.pwa-bar-ico\{[^}]*width:34px[^}]*height:34px/.test(con),
    '只写 width/height 属性时，某些浏览器会把 192px 原图铺满整条');

  // ── Service Worker：安全上下文 + 不缓存 API ──
  const sw = fs.readFileSync(pub('sw.js'), 'utf8');
  check('sw.js 含 fetch 处理器（PWA 可安装性的硬性要求）',
    /addEventListener\(\s*['"]fetch['"]/.test(sw));
  check('sw.js 明确不拦截 /api/（双端共享同一份数据，缓存住就会看到旧记录）',
    sw.includes("startsWith('/api/')"),
    '缺此判断 ⇒ 未来一旦加缓存，手机端数据会滞后于桌面端');
  // sw.js 的 activate 里有一段「清理历史缓存」的兜底代码（caches.delete），
  // 所以只禁「写入型」API：open/put/add/addAll。出现即说明有人加了缓存策略。
  check('sw.js 不写入任何缓存（本项目刻意零预缓存）',
    !/caches\.(open|put)|cache\.(add|addAll|put)/.test(sw),
    '出现即说明有人给 SW 加了缓存策略，需重新评估「改了页面不生效」风险');

  // ── 服务端托管：MIME 与缓存头 ──
  const srv = fs.readFileSync(path.join(ROOT, 'server', 'index.ts'), 'utf8');
  check('服务端为 .webmanifest 指定 application/manifest+json',
    srv.includes('application/manifest+json'),
    'MIME 退化成 octet-stream 时 Chrome 会整个忽略 manifest');
  check('服务端给 sw.js 设 no-cache + Service-Worker-Allowed',
    srv.includes('Service-Worker-Allowed') && /no-cache/.test(srv),
    '不加 no-cache ⇒ 改了 sw.js 用户手机上可能一整天跑旧版');
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
// ── 带副作用的 GET 也要令牌（2026-09-29 补的缺口）────────────────────────────
// 缺口形状：鉴权原本只拦写方法，而 `GET /api/auto-reply/run?realSend=1` 会真的发消息。
// GET 是简单请求（无 CORS 预检）、curl 直连也不带 Origin ⇒ requestGuard 看不见它
// ⇒ 非回环暴露时，任何能连到端口的人都能无令牌触发不可撤销的副作用。
const idxSrc = readText('server/index.ts');
check('带副作用的 GET 也要令牌（不是只拦写方法）',
  SIDE_EFFECT_GET_PATHS.length > 0 && SIDE_EFFECT_GET_PATHS.includes('/api/auto-reply/run') &&
    /isPublicReadGet\(/.test(idxSrc),
  '只拦写方法 ⇒ ?realSend=1 这类 GET 无需令牌即可替用户发消息');
check('该清单来自单一真相源（服务端 import，不在 index.ts 里另抄一份）',
  /import \{[^}]*SIDE_EFFECT_GET_PATHS[^}]*\} from "\.\/services\/authToken\.js"/.test(idxSrc) &&
    !/const SIDE_EFFECT_GET_PATHS\s*=/.test(idxSrc),
  '两处各写一份 ⇒ 以后加新路由只改一处，另一处静默漏掉');

// ── 只读 ≠ 无隐私：GET 默认要令牌，只有白名单放行（2026-09-30 修正）──────────
// 缺口形状（实测）：HOST=0.0.0.0 时鉴权虽开，但原策略是「GET 全放行 + 副作用 GET 黑名单」，
// 于是裸 curl 不带任何令牌就能拿到：
//   /api/resume/file?version=original → 200，整份简历 PDF
//   /api/profile                      → 200，name / phone / email
//   /api/jobs                         → 200，1000 条职位
//   /api/applications                 → 200，500 条投递
// 「GET 无副作用」被错当成「GET 可公开」，而真正该问的是「泄露出去伤不伤用户」。
// 另外黑名单会随新增路由静默失效；白名单的失败方向才安全（新接口默认受保护）。
check('匿名放行的 GET 是白名单且极简（只探活/元信息）',
  PUBLIC_READ_GET_PATHS.length > 0 && PUBLIC_READ_GET_PATHS.length <= 5 &&
    PUBLIC_READ_GET_PATHS.includes('/api/ping') &&
    PUBLIC_READ_GET_PATHS.includes('/api/lan'),
  '白名单被放大 = 又回到「凭 GET 就能读」的老路');
check('含个人信息的 GET 一律不在匿名白名单里',
  ['/api/profile', '/api/resume/file', '/api/resume/current', '/api/jobs',
   '/api/applications', '/api/sessions', '/api/mail/config', '/api/mail/recent']
    .every((p) => !PUBLIC_READ_GET_PATHS.includes(p)),
  '这些接口读的是姓名/手机/邮箱/简历/求职记录 —— 匿名可读即等同把 PII 贴在局域网上');
check('副作用 GET 优先于白名单（误加进白名单也仍要令牌）',
  SIDE_EFFECT_GET_PATHS.every((p) => !isPublicReadGet('GET', p)),
  '两道清单打架时必须 fail-closed');
check('只读 GET 默认不放行（反面：任意路径不该被当成公开）',
  !isPublicReadGet('GET', '/api/whatever-new-endpoint') &&
    !isPublicReadGet('POST', '/api/ping') &&
    !isPublicReadGet('DELETE', '/api/ping'),
  '新路由必须默认受保护；POST 打 /api/ping 也不该走白名单');
check('放行判定只认路径的 path 部分（不含 query，防绕过）',
  isPublicReadGet('GET', '/api/ping') && !isPublicReadGet('GET', '/api/ping/../profile'),
  '带 query 或路径穿越都不能被当白名单命中');
check('服务端中间件调用白名单判定（不是又抄一份 if 链）',
  /isPublicReadGet\(m,\s*String\(req\.path \|\| ''\)\)/.test(idxSrc) &&
    !/const readOnly = \(m === 'GET'/.test(idxSrc),
  '残留旧的 readOnly 判断 ⇒ 新策略没真正生效');
// 控制台自身资源必须放行，否则 `GET /` 直接 401 —— 控制台连页面都打不开。
// 这条是**真浏览器**跑出来的：curl 测 /api/* 全「符合预期」，完全看不出。
// 放行它是安全的：全是 public/ 下的 HTML/图标/SW（不含个人信息），
// 而控制台页面本身不带令牌（令牌是服务端注入进 HTML 的），挡住就是「把钥匙锁在屋里」。
check('控制台自身资源匿名可达（含 `/`、app.ico、manifest、sw.js）',
  /isConsoleAsset\(m,\s*String\(req\.path \|\| ''\)\)/.test(idxSrc) &&
    ['/', '/app.ico', '/manifest.webmanifest', '/sw.js'].every((p) => isConsoleAsset('GET', p)),
  '只放行 /api/* 而挡住 `GET /` ⇒ 控制台白屏；curl 测接口全绿，看不出来');
check('控制台资源白名单不含数据目录（别顺手把 /data/ 放进来）',
  !isConsoleAsset('GET', '/data/evidence/x.png') &&
    !isConsoleAsset('GET', '/data/screenshots/x.png') &&
    !isConsoleAsset('GET', '/data/resume_tailored/x.pdf'),
  '把 data/ 放进这份清单 ⇒ 证据截图与简历全部裸奔，刚堵的缺口又开了');
check('控制台资源白名单只放行读方法',
  isConsoleAsset('GET', '/') && !isConsoleAsset('POST', '/') && !isConsoleAsset('DELETE', '/'),
  '把写方法也放行 ⇒ 匿名可改控制台状态');
check('CORS Allow-Headers 含 X-Auth-Token 与 Authorization',
  /Access-Control-Allow-Headers',\s*'[^']*X-Auth-Token/.test(idxSrc) &&
    /Access-Control-Allow-Headers',\s*'[^']*Authorization/.test(idxSrc),
  '预检不放行这两个头 ⇒ 跨源带令牌的请求被浏览器拒发（只列 Content-Type 就会这样）');

// ── 静态资源签名：收紧鉴权时最容易踩的回归（2026-09-30）─────────────────────
// 形状：把「GET 默认要令牌」收严之后，控制台里 `<img src="/data/evidence/x.png">`、
// `<a href>`、`window.open('/api/resume/file?...')` 全变 401 ——
// 这些浏览器取资源的方式**发不出自定义请求头**，只认请求头必然挂；
// 而 `onerror` 还会把裂图隐藏掉，用户看到的是「证据没了 / 简历打不开」而不是报错，更难查。
// 解法是把授权放进 URL（HMAC 签名，绑定路径 + 有时效），而不是把目录整体放开。
check('静态资源走 URL 签名（不是靠放开目录）',
  /isAuthorizedStaticRes\(req\)/.test(idxSrc) &&
    /export function isAuthorizedStaticRes/.test(readText('server/services/authToken.ts')),
  '把 /data/evidence 等目录整体放行 ⇒ 刚堵上的隐私缺口换个门又开了');
check('签名绑定路径（拿 A 的签名读不了 B）',
  /staticSig\(exp, pathname\)/.test(readText('server/services/authToken.ts')) &&
    /update\(`\$\{exp\}\|\$\{pathname\}`\)/.test(readText('server/services/authToken.ts')),
  '签名不含路径 ⇒ 一个签名可以读任意静态文件，等于没有鉴权');
check('签名有时效且会校验过期',
  /STATIC_TTL_MS/.test(readText('server/services/authToken.ts')) &&
    /Date\.now\(\) > exp/.test(readText('server/services/authToken.ts')),
  '永不过期的签名 = 长期有效凭据，一旦链接被转发就等同泄露');
check('签名可替代请求头的路径清单是显式白名单（含 /api/resume/file）',
  /SIGNED_PATH_PREFIXES/.test(readText('server/services/authToken.ts')) &&
    /'\/api\/resume\/file'/.test(readText('server/services/authToken.ts')),
  '漏了 /api/resume/file ⇒ 控制台「预览简历」按钮恒 401');
check('控制台简历预览用后端签发的 previewUrl（不是自己拼裸路径）',
  /openLink\(b\.dataset\.prev/.test(readText('public/console.html')) && !/window\.open\(/.test(readText('public/console.html')) &&
    /data-prev="'\+esc\(pv\)/.test(readText('public/console.html')),
  '桌面壳（Tauri）拦截 window.open ⇒ 预览必须走统一出口 openLink()；签名 previewUrl 照旧不可省');
// 全站「点开」收敛到唯一出口（2026-10-06 D6）：桌面壳静默吞掉「开新窗口」的两种写法，
// 且 wry 默认禁 msPdfOOUI ⇒ 外壳内嵌 PDF 查看器不可靠、不能拿 iframe 兜底。
// 任一处漏改 = 用户看到「点了没反应」，而三道门禁全绿。
{
  const cHtml = readText('public/console.html');
  check('控制台不再出现 target 的新窗口链接（桌面壳开不了新窗口，点击被静默吞掉）',
    (cHtml.match(/target="_blank"/g) || []).length === 0,
    '命中 ' + (cHtml.match(/target="_blank"/g) || []).length + ' 处');
  check('控制台不再直接调用 window.open（同上）',
    (cHtml.match(/window\.open\(/g) || []).length === 0);
  check('统一「点开」出口齐备：openLink + pdf.js 预览 + 可复制地址面板 + 委托监听',
    /function openLink\(/.test(cHtml) && /function openPdfPreview\(/.test(cHtml)
    && /function openLinkPanel\(/.test(cHtml)
    && /\[data-open-link\],\[data-open-dir\],\[data-open-video\]/.test(cHtml),
    '缺出口 ⇒ 改过的链接又会退化成「点了没反应」');
  // 🔴 $$ vs $：$ 只返回**单个**元素，对它调 .forEach 直接 TypeError，
  //    而这类绑定都写在 try/异步流程里 ⇒ 整块静默失效：按钮点了毫无反应，三道门禁却全绿。
  //    实测（2026-10-06 D6）：一次编辑脚本把 $$('[data-prev]') 写成了 $(...) ⇒ 简历「预览」全废。
  check('预览按钮的绑定用 $$ 而不是 $（$ 只取第一个元素，.forEach 必然 TypeError 且静默失效）',
    /\$\$\('\[data-prev\]'\)\.forEach/.test(cHtml) && !/(^|[^$])\$\('\[data-prev\]'\)/.test(cHtml),
    '写成 $(...) ⇒ 一个版本按钮都绑不上，页面不报错、点了没反应');
  check('没有任何地方对 $() 的结果调 forEach/map/filter（$ 是 querySelector，返回单元素）',
    !/(^|[^$])\$\('[^']*'\)\s*\.(forEach|map|filter)/.test(cHtml),
    '$ 选多元素必 TypeError')
  check('反向护栏：确有一批链接已改走 data-open-*（防正则写错 ⇒ 上面两条恒绿）',
    (cHtml.match(/data-open-(link|dir|video)=/g) || []).length >= 8,
    '命中 ' + (cHtml.match(/data-open-(link|dir|video)=/g) || []).length + ' 处');
  check('vendored pdf.js 随包存在（否则页内 PDF 预览必失败）',
    fs.existsSync(path.join(ROOT, 'public/vendor/pdfjs/pdf.min.mjs'))
    && fs.existsSync(path.join(ROOT, 'public/vendor/pdfjs/pdf.worker.min.mjs'))
    && fs.statSync(path.join(ROOT, 'public/vendor/pdfjs/pdf.worker.min.mjs')).size > 500000);
}
// 控制台那条裸 fetch 必须带上令牌，否则「鉴权一开，自动回复就用不了」
// （而它走的是 GET，正是这次要收紧的对象）。
check('控制台调 /api/auto-reply/run 时带上令牌头',
  /fetch\(url,\s*\{headers:\s*authHeaders\(\)\}\)/.test(readText('public/console.html')),
  '裸 fetch 不带 X-Auth-Token ⇒ 鉴权开启后自动回复恒 401，用户会以为是登录态坏了');

// ═══════════════════════════════════════════════════════════
console.log('\n══════ A3. 回复话术的「事实边界」兜底（防编造个人信息） ══════');
// 背景（2026-09-23 实测）：模型被直接问「你现在人在哪个城市」时，
// 会把「期望城市」当现居地写出来（如「我目前在昆明这边」）。
// 这是发给真实 HR、发出去就撤不回的消息，故 prompt 之外再加一道机械校验。
{
  const r1 = guardFabricatedLocation('我目前在昆明这边，面试的话具体时间再聊', '昆明、深圳');
  check('命中「我目前在+城市」→ 替换为安全话术', r1.stripped && !/我目前在/.test(r1.text));
  check('替换话术保留期望城市', r1.text.includes('昆明'));
  check('命中「我人在+城市」', guardFabricatedLocation('我人在深圳，可以现场面试', '昆明、深圳').stripped);
  check('未在期望城市里的城市同样拦截（防臆测）', guardFabricatedLocation('我目前在北京', '昆明、深圳').stripped);
  check('无期望城市时也给出安全话术', guardFabricatedLocation('我在昆明', null).text.includes('沟通'));
  // 防误伤：正常表达不得被改写
  check('不误伤「我在找工作状态」', !guardFabricatedLocation('我在找工作状态，可以尽快到岗', '昆明').stripped);
  check('不误伤「我目前不在本地」', !guardFabricatedLocation('我目前不在本地，面试安排再沟通', '昆明').stripped);
  check('不误伤普通回复', !guardFabricatedLocation('您好，我对这个岗位很感兴趣', '昆明').stripped);
}

// ═══════════════════════════════════════════════════════════
console.log('\n══════ B. 自动回复引擎合约（mock 驱动，无需真实浏览器） ══════');

interface MockCalls {
  openChat: number; openConversation: number; sendText: number; sendResume: number;
  acceptResume: number; texts: string[];
}

function makeDriver(
  convs: ConvSummary[],
  hrMsg: string,
  position: string | null,
  opts?: { resumeRequest?: boolean; acceptOk?: boolean },
) {
  const calls: MockCalls = { openChat: 0, openConversation: 0, sendText: 0, sendResume: 0, acceptResume: 0, texts: [] };
  const driver: ChatDriver = {
    platform: 'boss',
    async openChat() { calls.openChat++; },
    async listConversations() { return convs.map((c) => ({ ...c })); },
    async openConversation() { calls.openConversation++; return true; },
    async readConversation() {
      return { messages: [{ side: 'hr' as const, text: hrMsg }], lastHr: hrMsg, position, resumeRequest: !!opts?.resumeRequest };
    },
    async sendText(t: string) { calls.sendText++; calls.texts.push(t); return true; },
    async sendResume() { calls.sendResume++; return true; },
    async acceptResumeRequest() { calls.acceptResume++; return opts?.acceptOk !== false; },
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

// B1 未注册平台（offerbiu 走邮件通道，本引擎故意不登记；其余 9 平台均已登记）
{
  fresh();
  const { evs, emit } = collect();
  const r = await runAutoReply('offerbiu', { probe: okProbe }, emit);
  check('未注册平台 → 报错且不动浏览器', r.sent === 0 && evs.some((e) => e.type === 'error' && String(e.message).includes('不支持该平台')));
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

// B10 BOSS 会话列表「页签并集」+「发送记账」（2026-10-06 用户报「自动回复没有真实进行」的根因）
//   起因：BOSS 有 28 条未读 HR 消息，引擎跑了却「什么都没回」。取证后是两条独立成因，各配断言 ——
//   ① 列表侧：旧实现只读「全部」页签，而 BOSS「全部」**固定只渲染最新 40 条、无分页**
//      （实测 li 恒 40、scrollHeight 恒定 7842，滚动/跳到底都不加载）。自动投递每天新建几十个
//      招呼会话 ⇒「全部」被今天的新会话占满，更早的、真有 HR 回话的未读会话（实测 21 个）
//      **从未进入过引擎视野** ⇒ 表现为「跑了但什么都没回」。
//   ② 记账侧：`done = done || r || s` 把「发简历成功」也算成「回了一条文本」⇒ last_reply 被写成
//      根本没送出去的文本、last_replied_at 被写成本轮时间 —— 名存实亡，且之后的 hr-cooldown
//      会把本该有的重试一并挡掉。
{
  const bcSrc = readText('server/services/apply/bossChat.ts').replace(/\r\n/g, '\n');
  const slice = (from: string, to: string) => {
    const a = bcSrc.indexOf(from);
    if (a < 0) return '';
    const b = bcSrc.indexOf(to, a + from.length);
    return b < 0 ? '' : bcSrc.slice(a, b);
  };
  const listFn = slice('export async function listConversations', 'export async function openConversation');
  const openFn = slice('export async function openConversation', 'export async function readConversation');
  const readListFn = slice('function readListSrc', 'async function readTab');

  // ①-a 三个页签（少读一个就漏一类会话）
  const tabsDecl = stripComments(bcSrc).match(/const CONV_TABS = \[([^\]]*)\] as const;/);
  const tabs = tabsDecl ? (tabsDecl[1].match(/'[^']+'/g) || []).join(',') : '';
  check('BOSS 会话列表读 全部+未读+新招呼 三个页签（少一个就漏一类会话）',
    tabs === "'全部','未读','新招呼'", tabs || 'NOT-FOUND');

  // ①-b 反向护栏：必须真的「遍历页签」，而不是只读一个（否则回退成旧 bug）
  {
    const c = stripComments(listFn);
    check('listConversations 遍历 CONV_TABS 逐个 readTab（不是只读「全部」）',
      listFn.length > 200 && /CONV_TABS\.length/.test(c) && /readTab\(i\)/.test(c),
      `len=${listFn.length}`);
  }

  // ①-c 反向护栏：openConversation 找不到目标时必须**轮转页签**。
  // 只靠滚动是不够的 ——「全部」滚到底也不加载更多，非当前页签的会话永远打不开。
  {
    const c = stripComments(openFn);
    check('openConversation 找不到目标时轮转页签（triedTabs + gotoConvTab），只滚不换页签必然漏会话',
      openFn.length > 300 && /triedTabs/.test(c) && /gotoConvTab\(next\)/.test(c) && /CONV_TABS\.length/.test(c),
      `len=${openFn.length}`);
  }

  // ①-d lastMsg 必须取结构化节点 `.last-msg-text`：旧实现从整行 innerText 剥时间/姓名，
  //     会把「昨天」「公司名」混进去 ⇒ 与 DB 的 last_hr_message 恒不相等 ⇒ unreadOnly 前置过滤形同虚设。
  {
    const c = stripComments(readListFn);
    check('会话列表末条消息取 .last-msg-text（不是从整行 innerText 剥）',
      readListFn.length > 300 && /querySelector\('\.last-msg-text'\)/.test(c), `len=${readListFn.length}`);
    // ①-e 未读角标认 `.notice-badge`（实测带数字的就是它；旧代码写的 [class*=dot] 之类并不匹配）
    check('未读判定认 .notice-badge 角标（实测带数字的角标类名）',
      /\.notice-badge/.test(c), `len=${readListFn.length}`);
  }

  // ①-f 「全部」页签要切两次：开头归一化（`_curTab !== 0` 时先回「全部」再滚动收集）
  //     + 收尾归位（openConversation 靠 `_curTab` 判断要不要切页签，留在过滤页签会错判）。
  //     ⚠️ 判据必须钉**次数**：只写 `/gotoConvTab\(0\)/` 的话，开头那一处就能满足它 ——
  //     破坏性对照实测**漏红**（M8 删掉收尾那处，断言照样绿）。
  {
    const n = (stripComments(listFn).match(/await gotoConvTab\(0\)/g) || []).length;
    check('listConversations 切回「全部」共两处（开头归一化 + 收尾归位）',
      n >= 2, `gotoConvTab(0) 出现 ${n} 次`);
  }

  // ①-g 🔴 NO_LIST ≠「找不到这个会话」（2026-10-06 真机实测的**第二个**根因）
  //   点任一页签后，BOSS 会把 `.user-list-content` 整个从 DOM 卸掉再异步重建；空窗期里
  //   「找 li」的脚本只能得到 NO_LIST。实测 listConversations 收尾点回「全部」后仅 sleep 700ms，
  //   容器仍不存在（{"hasBox":false,"ulCount":0}）⇒ 旧实现 `else return false` 让**每个目标**
  //   都秒失败 ⇒ 引擎全报 open-failed，用户看到「会话都列出来了、一条都没回复」。
  //   判据：① gotoConvTab 点完页签要**等容器重建**，不能只 sleep；② openConversation 的
  //   NO_LIST 分支要有**有界重试**；③ 行为级证明（下面用 ex 桩，比静态断言强得多）。
  {
    const tabFn = slice('async function gotoConvTab', 'export async function listConversations');
    check('gotoConvTab 点完页签等列表容器重建（waitListBox），不能只 sleep',
      tabFn.length > 200 && /waitListBox\(/.test(stripComments(tabFn)), `len=${tabFn.length}`);
    // 注意：这里必须钉**自增**而不是 `/noListTries/` —— 只写变量名的话，
    // `let noListTries = 0;` 这一行声明就能满足断言 ⇒ 破坏性对照实测**漏红**（M9 抓到过）。
    check('openConversation 对 NO_LIST 做有界重试（不是首次即 return false）',
      /\+\+noListTries/.test(stripComments(openFn)) && /waitListBox/.test(stripComments(bcSrc)),
      `len=${openFn.length}`);
  }

  // ①-h 行为级证明：把底层 CDP 换成桩 —— 前 3 次「找 li」返回 NO_LIST，第 4 次返回 opened。
  //     旧实现在**第一次** NO_LIST 就 return false ⇒ 这条必然红。静态断言证明不了这个，
  //     只有真跑一遍才能证明「空窗期确实会重试」。
  {
    let findCalls = 0;
    __setExForTest(async (_action: string, extra?: { script?: string }) => {
      const script = String(extra?.script || '');
      if (script.includes('NO_LIST')) {
        findCalls++;
        return { data: findCalls <= 3 ? 'NO_LIST' : 'opened' };
      }
      if (script.includes('.chat-conversation')) return { data: 'HR-N' };   // 窗格姓名校验
      return { data: '' };
    });
    let ok = false;
    try {
      ok = await openConversation('boss|HR-N|N公司');
    } finally {
      __setExForTest(null);
    }
    check('openConversation 行为级：列表重建空窗期（连续 NO_LIST）必须继续等，最终点开成功',
      ok === true && findCalls >= 4, `ok=${ok} findCalls=${findCalls}`);
  }

  // ②-a 记账：只发简历成功、文本发送失败 ⇒ last_reply 绝不能被写成那条没送出去的文本
  {
    fresh();
    const key = `${RUN_TAG}-b10-resume-only`;
    upsertConversation({
      conv_key: key, platform: 'boss', hr_name: 'HR-A', company: 'A公司',
      last_hr_message: '旧消息', last_reply: 'PREV-REPLY',
    });
    const calls = { sendText: 0, sendResume: 0 };
    const driver: ChatDriver = {
      platform: 'boss',
      async openChat() { /* noop */ },
      async listConversations() { return [{ key, name: 'HR-A', company: 'A公司', lastMsg: '请发一份简历', unread: true, raw: '' }]; },
      async openConversation() { return true; },
      async readConversation() {
        return { messages: [{ side: 'hr' as const, text: '请发一份简历' }], lastHr: '请发一份简历', position: null, resumeRequest: false };
      },
      async sendText() { calls.sendText++; return false; },   // ← 文本发送失败
      async sendResume() { calls.sendResume++; return true; },
    };
    registerChatDriver('boss', driver);
    const { evs, emit } = collect();
    await runAutoReply('boss', { probe: okProbe, useAi: false, realSend: true, throttleSec: 1, hrCooldownSec: 0 }, emit);
    const row = getConversation(key);
    check('B10 发简历成功但文本发送失败 → last_reply 保持旧值（不写没送出去的文本）',
      calls.sendResume === 1 && calls.sendText >= 1 && String(row?.last_reply || '') === 'PREV-REPLY',
      `sendResume=${calls.sendResume} sendText=${calls.sendText} last_reply=${JSON.stringify(row?.last_reply)}`);
    check('B10 发简历成功 → 计入 sent（确实对外发了东西）',
      evs.some((e) => e.type === 'send-resume' && e.ok === true) && evs.some((e) => e.type === 'sent'),
      evs.map((e) => e.type).join(','));
  }

  // ②-b 记账：同意「请求附件简历」卡片成功、文本发送失败 ⇒ 仍须记账。
  //     否则下一轮读到 resumeRequest=false + intent=ask_resume ⇒ 走工具栏 sendResume
  //     ⇒ **向同一个 HR 重复发一份简历**（3 连发事故那条路径）。
  {
    fresh();
    const key = `${RUN_TAG}-b10-card-only`;
    upsertConversation({
      conv_key: key, platform: 'boss', hr_name: 'HR-B', company: 'B公司',
      last_hr_message: '更早的消息', last_reply: 'PREV-REPLY',
    });
    const calls = { sendText: 0, sendResume: 0, accept: 0 };
    const driver: ChatDriver = {
      platform: 'boss',
      async openChat() { /* noop */ },
      async listConversations() { return [{ key, name: 'HR-B', company: 'B公司', lastMsg: '请发一份简历', unread: true, raw: '' }]; },
      async openConversation() { return true; },
      async readConversation() {
        return { messages: [{ side: 'hr' as const, text: '请发一份简历' }], lastHr: '请发一份简历', position: null, resumeRequest: true };
      },
      async sendText() { calls.sendText++; return false; },
      async sendResume() { calls.sendResume++; return true; },
      async acceptResumeRequest() { calls.accept++; return true; },
    };
    registerChatDriver('boss', driver);
    const { emit } = collect();
    await runAutoReply('boss', { probe: okProbe, useAi: false, realSend: true, throttleSec: 1, hrCooldownSec: 0 }, emit);
    const row = getConversation(key);
    check('B10 卡片同意成功但文本失败 → 仍记账（last_hr_message 落库，防下一轮重复发简历）',
      calls.accept === 1 && calls.sendResume === 0 && String(row?.last_hr_message || '') === '请发一份简历',
      `accept=${calls.accept} sendResume=${calls.sendResume} last_hr_message=${JSON.stringify(row?.last_hr_message)}`);
    check('B10 卡片同意成功但文本失败 → last_reply 保持旧值',
      String(row?.last_reply || '') === 'PREV-REPLY', JSON.stringify(row?.last_reply));
  }

  // ②-c 正向：文本真发送成功 ⇒ last_reply 必须写成**实际发出的那条**（防把 sentText 逻辑写反）
  {
    fresh();
    const key = `${RUN_TAG}-b10-text-ok`;
    upsertConversation({
      conv_key: key, platform: 'boss', hr_name: 'HR-C', company: 'C公司',
      last_hr_message: '旧消息', last_reply: 'PREV-REPLY',
    });
    const texts: string[] = [];
    const driver: ChatDriver = {
      platform: 'boss',
      async openChat() { /* noop */ },
      async listConversations() { return [{ key, name: 'HR-C', company: 'C公司', lastMsg: '你好', unread: true, raw: '' }]; },
      async openConversation() { return true; },
      async readConversation() {
        return { messages: [{ side: 'hr' as const, text: '你好' }], lastHr: '你好', position: null, resumeRequest: false };
      },
      async sendText(t: string) { texts.push(t); return true; },
      async sendResume() { return true; },
    };
    registerChatDriver('boss', driver);
    const { emit } = collect();
    await runAutoReply('boss', { probe: okProbe, useAi: false, realSend: true, throttleSec: 1, hrCooldownSec: 0 }, emit);
    const row = getConversation(key);
    check('B10 文本真发送成功 → last_reply 写成实际发出的那条',
      texts.length === 1 && texts[0].length > 0 && String(row?.last_reply || '') === texts[0],
      `sent=${texts.length} last_reply=${JSON.stringify(row?.last_reply || '').slice(0, 60)}`);
  }

  // ①-i 🔴「全部」是**虚拟化列表**：一次只渲染 40 行，但**滚到底就是完整历史**。
  //     实测（2026-10-06）：滚到 50% / 100% 时那 40 行**整批换掉**（与滚动前重名 0/40），
  //     滚动收集去重后共 93 个不同会话。
  //     ⚠️ 此前只看「行数恒 40」就判定「全部无分页」是**错的** —— 行数恒定正是虚拟化的特征。
  //     非做不可：openConversation 打开会话 = 标记已读 ⇒ 从「未读」页签消失；若列表只以「未读」
  //     为来源，「跑过一轮（哪怕只是预览）之后，被打开却没回成的会话就永远回不了」。
  {
    const allFn = slice('async function readAllTab', 'export async function listConversations');
    check('listConversations 走「全部」滚动全量收集（readAllTab），不是只读一次 40 行',
      listFn.length > 200 && /readAllTab\(/.test(stripComments(listFn)), `len=${listFn.length}`);
    check('readAllTab 真的滚动收集（scrollTop 递增 + 去重 + 步数上限）',
      allFn.length > 400
      && /scrollTop \+= c\.clientHeight/.test(stripComments(allFn))
      && /CONV_SCROLL_MAX/.test(stripComments(allFn))
      && /seen\.get\(k\)/.test(stripComments(allFn)),
      `len=${allFn.length}`);
    check('readListSrc 算出「末条是我方发的」标记（[送达]/[已读]）供引擎廉价前置排除',
      readListFn.includes('[送达') && /\bmine=/.test(stripComments(readListFn)),
      `len=${readListFn.length}`);
  }

  // ③ 行为级：末条是我方发的会话（lastMine）**不打开也不计入**，未标的照常打开。
  //    这一对是**正反双测**：只有反向（防「一律排除」把功能整个弄死）才能真正证明它没误伤。
  {
    fresh();
    const mineKey = `${RUN_TAG}-b10-mine`;
    // ⚠️ 这里**必须计数**而不是 `throw`：破坏性对照会把 `if (c.lastMine) return false;` 删掉，
    //    若用 throw 桩，变异体会让整个合约脚本崩在异常上（没有汇总行 ⇒ 仪器变 NOT-FOUND），
    //    而不是干净地翻红。原则：**变异点不得影响可运行性**，断言才测得到自己。
    let openedMine = 0;
    const driverMine: ChatDriver = {
      platform: 'boss',
      async openChat() { /* noop */ },
      async listConversations() {
        return [
          { key: mineKey, name: 'HR-M', company: 'M公司', lastMsg: 'BOSS您好，我叫…', unread: true, raw: '', lastMine: true },
        ];
      },
      async openConversation() { openedMine++; return true; },
      async readConversation() { return { messages: [], lastHr: '', position: null }; },
      async sendText() { return true; },
      async sendResume() { return true; },
    };
    registerChatDriver('boss', driverMine);
    const { evs: evsM, emit: emitM } = collect();
    const rM = await runAutoReply('boss', { probe: okProbe, useAi: false, realSend: false }, emitM);
    check('unreadOnly：末条是我方发的（lastMine）不打开也不计入（省掉上百次白开窗）',
      rM.sent === 0
      && openedMine === 0
      && evsM.filter((e) => e.type === 'conv').length === 0
      && (evsM.find((e) => e.type === 'list') || {}).will === 0,
      `will=${(evsM.find((e) => e.type === 'list') || {}).will} openConversation=${openedMine} conv=${evsM.filter((e) => e.type === 'conv').length}`);

    fresh();
    const notMineKey = `${RUN_TAG}-b10-notmine`;
    let openedNotMine = 0;
    const driverNotMine: ChatDriver = {
      platform: 'boss',
      async openChat() { /* noop */ },
      async listConversations() {
        // 仅 unread=true，**不带** lastMine ⇒ 必须照常处理（防「一律排除」的过度纠正）
        return [{ key: notMineKey, name: 'HR-N2', company: 'N2公司', lastMsg: '你好，方便聊聊吗', unread: true, raw: '' }];
      },
      async openConversation() { openedNotMine++; return true; },
      async readConversation() {
        return { messages: [{ side: 'hr' as const, text: '你好，方便聊聊吗' }], lastHr: '你好，方便聊聊吗', position: null };
      },
      async sendText() { return true; },
      async sendResume() { return true; },
    };
    registerChatDriver('boss', driverNotMine);
    const { evs: evsN, emit: emitN } = collect();
    await runAutoReply('boss', { probe: okProbe, useAi: false, realSend: false }, emitN);
    check('对照：未标 lastMine 的未读会话照常打开（防「一律排除」把功能弄死）',
      openedNotMine === 1 && evsN.filter((e) => e.type === 'conv').length === 1,
      `openConversation=${openedNotMine} conv=${evsN.filter((e) => e.type === 'conv').length}`);
  }
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

// D3b 「为什么 0 个岗位」必须对非 SSE 调用可见 + 配额横幅与真闸门同源
// 🔴 2026-10-05 实测事故：BOSS 待投池 245 个非空（/api/apply/classify-batch 可证），
//   却因「匹配分闸门默认 40」被全部滤掉、返回 total 0；而**原因**只经 onEvent(SSE) 推送，
//   控制台的「开始投递」却是普通 POST（无 onEvent）⇒ 用户只看到「共 0 个岗位」干瞪眼。
//   同时 /api/apply/quota 固定用默认上限 40、不读 dailyLimit，把上限改成 41 后横幅仍显示
//   40/40 ⇒ 「显示能投几份」与「实际能不能投」永远对不上。
{
  const batchCode = stripComments(readText('server/services/apply/batch.ts'));
  const idxQuota = stripComments(readText('server/index.ts'));
  const htmlQuota = stripComments(readText('public/console.html'));

  // ① 0 候选的原因进响应 JSON，而不是只走 SSE
  check('0 候选的原因进响应 JSON（非 SSE 调用也拿得到）',
    /\.\.\.\(picked\.length === 0 \? \{ reason: startMsg \} : \{\}\),/.test(batchCode)
    && /reason\?: string;/.test(batchCode),
    'BatchResult 缺 reason 字段，或 summary 没把 startMsg 带出来');

  // ② quota 端点必须吃请求里的 dailyLimit（与 runBatchApply 的闸门同一份解析）
  check('配额横幅与真闸门同源（quota 端点吃 dailyLimit）',
    /const rawLimit = String\(\(req\.query as any\)\?\.dailyLimit \?\? ""\)\.trim\(\);/.test(idxQuota)
    && /resolveDailyLimit\(rawLimit === "" \? undefined : Number\(rawLimit\)\)/.test(idxQuota),
    'quota 端点仍固定用默认上限，没读 req.query.dailyLimit');

  // ③ 前端必须把输入框里的上限送上去，且改完上限立刻重算横幅
  check('前端把上限送进 quota 且改值即刷新横幅',
    /qs\.push\('dailyLimit=' \+ encodeURIComponent\(dl\)\)/.test(htmlQuota)
    && /\['#batchDailyLimit', '#batchPlatform', '#batchSource'\]/.test(htmlQuota)
    && /addEventListener\(el\.tagName === 'SELECT' \? 'change' : 'input', loadQuota\)/.test(htmlQuota),
    'loadQuota 没带 dailyLimit，或上限/平台/来源变化后横幅不刷新');

  // ④ SSE 那条路不能被顺手删掉：实时进度面板同样要拿得到原因
  check('诊断不能只经 SSE 推送（onEvent 与响应体双路）',
    /onEvent\?\.\(\{ type: 'start', total: picked\.length, message: startMsg \}\);/.test(batchCode),
    "start 事件丢了，实时进度面板拿不到原因");
}

// D3c 0 候选诊断必须「具体」：点名哪条条件卡了多少个，命中匹配分闸门要明说调最低匹配分
// 🔴 2026-10-05 跟进 D3b：上轮只让「原因」可见，但诊断仍笼统说「被筛选条件过滤」，
//    用户据此把「每日投递上限」误改成 0（以为那是匹配分），真正的「最低匹配分=40」仍把池子全灭。
//    故诊断必须带分项计数，且命中匹配分闸门时**明确点名「最低匹配分」**，用户才不会改错框。
{
  const d3c = stripComments(readText('server/services/apply/batch.ts'));

  // ⑤ baseFiltered 必须按条件分项计数（city/remote/salary/score/kw），否则无法告诉用户各卡了多少
  check('0 候选诊断按条件分项计数（city/remote/salary/score/kw）',
    /const drop = \{ city: 0, remote: 0, salary: 0, score: 0, kw: 0 \};/.test(d3c)
    && /drop\.score\+\+; return false;/.test(d3c)
    && /drop\.city\+\+; return false;/.test(d3c)
    && /drop\.salary\+\+; return false;/.test(d3c)
    && /drop\.remote\+\+; return false;/.test(d3c),
    'baseFiltered 没按 city/remote/salary/score 分项计数，诊断无法点名具体条件');

  // ⑥ 命中匹配分闸门时，必须点名「最低匹配分」并给出放行动作（调到 0），且提示上限别用 0
  check('命中匹配分闸门时点名「最低匹配分」并指路（调到 0）',
    /未找到可投岗位：其余未投岗位被筛选条件（城市\/薪资\/匹配分）过滤掉了/.test(d3c)
    && /把「最低匹配分」调到 0/.test(d3c)
    && /上限别用 0/.test(d3c),
    '「被筛选条件过滤」分支没带分项计数 / 没点名最低匹配分 / 没提示上限别用 0');
}

// D3d 投前实时采集（2026-10-05 用户诉求）：投的是平台当下的真实岗位，不是库里的陈旧数据
// 背景：只吃库 ⇒ 池子全是前几天采的低分/已评估岗（实测 264 个全 <42 分），高分早已投完 ⇒ 永远 0 候选。
//   liveCollect 开启后先上 BOSS 按关键词/城市实搜一轮，只把「这一轮平台上真实在招」的岗位当候选。
{
  const d3dB = stripComments(readText('server/services/apply/batch.ts'));
  const d3dE = stripComments(readText('server/services/apply/engine.ts'));
  const d3dI = stripComments(readText('server/index.ts'));
  const d3dH = stripComments(readText('public/console.html'));

  // ⑦ 开关四层贯通：前端勾选 → 路由透传 → BatchInput → 采集调用（漏一层 = 点了没反应）
  check('投前实时采集开关四层贯通（前端/路由/BatchInput/采集调用）',
    /liveCollect: \$\('#batchLiveCollect'\)\.checked/.test(d3dH)
    && /liveCollect: liveCollect === true/.test(d3dI)
    && /liveCollect\?: boolean/.test(d3dB)
    && /input\.liveCollect &&/.test(d3dB)
    && /collectBossToDb\(/.test(d3dB),
    'liveCollect 没贯通：前端勾了但路由/BatchInput/采集调用少一层 ⇒ 点了没反应');

  // ⑧ 实搜必须带筛选条件的关键词/城市（否则「实时」搜回来的与用户要的无关）
  check('实时采集把关键词/城市透传给 BOSS 搜索（含城市名回写，防城市筛全灭）',
    /keywords: input\.criteria\?\.keywords/.test(d3dB)
    && /cityCode: cityHit\?\.boss/.test(d3dB)
    && /opts\?\.keywords\?\.length \? opts\.keywords/.test(d3dE)
    && /city=\$\{opts\?\.cityCode \?\? 100010000\}/.test(d3dE)
    && /city: opts\?\.cityName \?\? null/.test(d3dE),
    '实搜没带关键词/城市（或城市名没回写 city 列 ⇒ 城市筛把新鲜岗全灭）');

  // ⑨ 只投「这一轮平台上真实在招」的岗位（updated_at 新鲜度判定），实搜失败才回落全库且要说清
  check('实时采集只投本轮在招岗（updated_at 新鲜度）+ 失败回落要在诊断里注明',
    /updated_at/.test(d3dB) && /liveCollectStart/.test(d3dB) && /liveFreshUsed/.test(d3dB)
    && /已实时从 BOSS 采集/.test(d3dB)
    && /已回落全库筛选/.test(d3dB),
    '新鲜度判定/回落说明缺失 ⇒ 用户又看不出投的是新岗还是陈旧池');
}

// D3e 实时采集岗位的闸门公平性（2026-10-05 实测：40/43 新鲜岗被「空 JD 打出的 0 分」误杀，
// 且关键词过滤把整池卡死时诊断无声 ⇒ 用户无从知道该清/改关键词）
{
  const d3eB = stripComments(readText('server/services/apply/batch.ts'));

  // ⑩ 无 JD 文本 ⇒ 打分阶段直接跳过且不写 0 分（空 JD 打出的分数只能是垃圾，还会污染库）
  check('实时采集无 JD 岗：打分阶段跳过、不写 0 分污染库',
    /j\.requirements \|\| ''\)\.trim\(\)\)\) continue;/.test(d3eB),
    '空 JD 仍被打分并写 0 分 ⇒ 配合匹配分闸门把整批新鲜岗全灭（2026-10-05 实测 40/43）');

  // ⑪ 无 JD 文本 ⇒ 分数闸门放行（没有可信分数，按 0 分杀是误杀）
  check('实时采集无 JD 岗：分数闸门对无 JD 岗放行',
    /const hasJdText = Boolean\(\(j\.jd/.test(d3eB)
    && /hasJdText && score != null && score </.test(d3eB),
    '无 JD 岗被当 0 分误杀 ⇒ 实时采集的列表页快照永远进不了候选');

  // ⑫ 关键词过滤计入分项诊断（否则「关键词卡死整池」无声无息）
  check('关键词过滤有分项计数并在 0 候选诊断中点名',
    /drop\.kw\+\+/.test(d3eB) && /不含关键词「/.test(d3eB),
    '关键词把整池滤空时诊断不显示 ⇒ 用户不知道该清/改关键词');
}

// D4a 自动回复：停止响应性 + SSE 字段对齐（2026-10-05 用户实测「停止不了」「只会发问号」）
{
  const d4aR = stripComments(readText('server/services/apply/autoReplyRunner.ts'));
  const d4aH = stripComments(readText('public/console.html'));

  // ⑬ 停止检查必须覆盖到「发送前」（否则点完停止还会向 HR 发出真实消息 —— 有副作用的硬闸门）
  check('自动回复停止：关键步后都检查 abort，发送前是硬闸门',
    /const hitStop = /.test(d4aR)
    && /if \(hitStop\(\)\) break;\s*if \(reply\) \{/.test(d4aR)
    && /if \(hitStop\(\)\) break;\s*if \(decision\.intent === 'ask_resume'/.test(d4aR)
    && /if \(hitStop\(\)\) break;\s*const read = await driver\.readConversation\(\);/.test(d4aR),
    'abort 只在会话开头查一次 ⇒ 点停止后当前会话照走完、真实发送模式下还会发出一条消息');

  // ⑭ conv 事件人名字段：后端发 name，前端只读 ev.hr ⇒ 恒显示「?」
  check('自动回复日志：conv 行读后端真实字段（name），不再恒显示问号',
    /ev\.name\|\|ev\.hr\|\|'\?'/.test(d4aH),
    '字段错位 ⇒ HR 名永远显示「?」，用户以为发出去的是问号');

  // ⑮ 「（预览）/（真实发送）」标签用后端 start 事件回传的 realSend（本地变量与实际模式可能脱节）
  check('自动回复日志：开始行用后端回传的 realSend，不用本地变量猜',
    /ev\.realSend\?'真实发送':'预览'/.test(d4aH),
    '本地 realSend 与服务端实际模式脱节 ⇒ 明明真实发送却标「预览」（或反之），用户被误导');
}

// D5a 投递证据回溯：截图/录像点击放大改页内 lightbox（2026-10-05 用户实测「点击无法放大」：
// 桌面壳里 <a target="_blank"> 开不了新窗口 ⇒ 点缩略图毫无反应）
{
  const lbH = stripComments(readText('public/console.html'));
  const fnBody = (src: string, name: string) => {
    const m = src.match(new RegExp('(?:async )?function ' + name + '\\([^)]*\\)\\{([\\s\\S]*?)\\n\\}'));
    return m ? m[1] : '';
  };

  // ⑯ lightbox 三件套齐（DOM / CSS / 打开+关闭+Esc），防「只加了层没接线」
  check('证据回溯：页内放大层 lightbox 三件套齐全（DOM/样式/开关+Esc）',
    /id="lightbox"/.test(lbH)
    && /\.lightbox\.open\{display:flex\}/.test(lbH)
    && /function openLightbox\(/.test(lbH)
    && /function closeLightbox\(\)\{/.test(lbH)
    && /\$\('#lightboxClose'\)\.addEventListener\('click'/.test(lbH)
    && /if\(e\.key==='Escape'\) closeLightbox\(\)/.test(lbH),
    'target=_blank 在桌面壳里开不了新窗口 ⇒ 点缩略图毫无反应；放大必须页内做');

  // ⑰ 证据渲染不再依赖新窗口：缩略图 img 带 data-ev（cursor:zoom-in）、录像链接走 data-vid 委托
  const evFn = fnBody(lbH, 'loadEvidence');
  check('证据回溯：缩略图与录像链接不再依赖 target=_blank（data 属性 + 委托到 lightbox）',
    evFn.length > 400
    && evFn.indexOf('target="_blank"') < 0
    && /data-ev="'\+esc\(a\.evidence_path\)\+'"/.test(evFn)
    && evFn.indexOf('cursor:zoom-in') >= 0
    && evFn.indexOf("e.target.closest('img[data-ev]')") >= 0
    && evFn.indexOf("e.target.closest('a[data-vid]')") >= 0
    && evFn.indexOf('openEvidenceVideo(') >= 0,
    `evFn.length=${evFn.length}`);
}

// D5b 投递列表「真实投递验证」徽章（2026-10-05 用户要求：在投递列表加验证徽章）
{
  const lbH = stripComments(readText('public/console.html'));
  const fnBody = (src: string, name: string) => {
    const m = src.match(new RegExp('(?:async )?function ' + name + '\\([^)]*\\)\\{([\\s\\S]*?)\\n\\}'));
    return m ? m[1] : '';
  };
  const cardFn = fnBody(lbH, 'appCardHtml');
  const tblFn = fnBody(lbH, 'renderAppsTable');
  const bindFn = fnBody(lbH, 'bindAppActions');

  // ⑱ 验证徽章函数：evidence_path → 绿色「✅ 已验证真实投递」+ data-ev（可点开物证）；否则「未留证」
  check('投递列表：验证徽章函数存在（有证据=已验证可点开，无证据=未留证）',
    /function appVerifiedBadge\(/.test(lbH)
    && /b-ok[^>]*>✅ 已验证真实投递/.test(lbH)
    && /data-ev="'\+esc\(a\.evidence_path\)/.test(lbH)
    && /未留证/.test(lbH),
    'evidence_path 是真实投递最强物证；徽章是唯一肉眼可辨的入口');

  // ⑲ 看板卡片 + 表格行都渲染徽章；bindAppActions 委托 data-ev 打开物证 lightbox
  check('投递列表：看板卡片与表格行都渲染验证徽章，且点击委托打开物证',
    cardFn.indexOf('appVerifiedBadge(a)') >= 0
    && tblFn.indexOf('appVerifiedBadge(a)') >= 0
    && /\[data-ev\]/.test(bindFn) && bindFn.indexOf('openLightbox(') >= 0,
    '两处渲染器漏一处 ⇒ 看板/表格对不上；不委托 ⇒ 点徽章没反应');
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
  // ⚠️ data/ 是被 gitignore 的**运行时目录**：CI 全新检出必然没有 data/browser/cdp.json。
  // 此前这里直接 readFileSync —— 缺文件即抛未捕获 ENOENT，**整个合约测试进程被打断、CI 恒红**
  // （已在干净 worktree 里实测复现）。现在缺文件只跳过「cdp 端口表」相关断言；
  // 其余 5 处同步点都在仓库内的**被跟踪文件**里，照常校验。
  const cdpPath = path.join(ROOT, 'data/browser/cdp.json');
  let cdp: Record<string, string> = {};
  let hasCdp = false;
  try { cdp = JSON.parse(fs.readFileSync(cdpPath, 'utf8')) as Record<string, string>; hasCdp = true; } catch { hasCdp = false; }
  if (!hasCdp) console.log('  ⏭️  无 data/browser/cdp.json（仅本地运行才有）：跳过 cdp 端口表校验（含启动脚本端口比对），其余同步点照常校验');
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

  // ── 内置默认端口必须覆盖全部已登记平台（2026-09-25 开箱 P0 的回归防线）──────────
  // 历史事故：`data/browser/cdp.json` 是**运行时配置**且 `data/` 不随分发包走，
  // 而 `connection.ts` / `browser.ts` 缺文件时返回 null → **接收方机器上投递完全不可用**
  // （退化成 Playwright 自带 Chromium：未登录 + 未下载，报「Chromium 浏览器未下载」）。
  // 现在端口表收敛到 platformPorts.ts 并带内置兜底，本段确保**新增平台时不会漏配默认端口**。
  for (const p of REGISTERED_PLATFORMS) {
    const def = DEFAULT_CDP_PORTS[p];
    check(`内置默认端口存在：${p}`, typeof def === 'number' && def > 0,
      typeof def === 'number' ? `:${def}`
        : '未登记在 platformPorts.DEFAULT_CDP_PORTS —— 分发包缺 cdp.json 时该平台将不可投递');
    if (typeof def === 'number' && def > 0) {
      check(`start_platforms.bat 端口表含默认端口：${p}`, launcher.includes(`:${def}:`), `期望 :${def}:`);
      if (hasCdp) {
        const cdpPort = String(cdp[p] || '').split(':').pop() || '';
        check(`内置端口与 cdp.json 一致：${p}`, cdpPort === String(def), `cdp.json=${cdpPort} default=${def}`);
      } else skip(1, '无 data/browser/cdp.json');
    }
  }

  for (const p of REGISTERED_PLATFORMS) {
    const missing: string[] = [];
    if (hasCdp && !/^http:\/\/127\.0\.0\.1:\d+$/.test(String(cdp[p] || ''))) missing.push('cdp.json');
    if (!PLATFORM_PAGE[p]?.home) missing.push('platformHealth.PLATFORM_PAGE');
    if (!consoleHtml.includes(`{id:'${p}'`)) missing.push('console.html PLATFORMS');
    // 启动脚本按**端口**校验：允许多个平台共用同一窗口（如 offerbiu 与 official 共用 9227）
    if (hasCdp) {
      const port = String(cdp[p] || '').split(':').pop() || '';
      if (!port || !launcher.includes(`:${port}:`)) missing.push('start_platforms.bat 端口表');
    }
    if (!DELIVERY_PLATFORMS.includes(p)) missing.push('connection.DELIVERY_PLATFORMS');
    check(`平台注册多处同步：${p}`, missing.length === 0, missing.length ? `缺 ${missing.join(' / ')}` : '齐全');
  }

  // 端口唯一性：两个平台共用一个调试端口会导致「登录态串号」
  if (hasCdp) {
    const ports = REGISTERED_PLATFORMS.map((p) => cdp[p]).filter(Boolean);
    check('各平台 CDP 端口互不冲突', new Set(ports).size === ports.length, `${ports.length} 个端口 / ${new Set(ports).size} 个唯一值`);
  } else skip(1, '无 data/browser/cdp.json');

  // ── 兜底拉起表必须覆盖每一个已登记端口（2026-09-25 开箱 N7 的回归防线）──────────
  // 分发包不含 data/ ⇒ 接收方首跑时 `browserLaunch.json` 不存在 ⇒ 走 FALLBACK_PORT_PROFILES。
  // 该表里没有的端口，`ensureHealthy()` 只探活、不拉起，于是控制台「打开窗口」按钮**静默失效**
  // （前端 .catch(()=>{}) 吞错，用户看到的是「点了没反应」）。
  // 实测漏的就是两个**可投**平台：国聘 9235 / 应届生 9236（而不可投的脉脉 9233 反而在表里）。
  {
    const registeredPorts = Array.from(new Set(Object.values(DEFAULT_CDP_PORTS))).sort((a, b) => a - b);
    const fallbackPorts = Object.keys(FALLBACK_PORT_PROFILES).map(Number);
    const missingPorts = registeredPorts.filter((p) => !fallbackPorts.includes(p));
    check('兜底拉起表覆盖全部已登记端口', missingPorts.length === 0,
      missingPorts.length
        ? `漏 ${missingPorts.join(', ')} —— 这些平台的「打开窗口」按钮在接收方机器上将静默失效`
        : `${registeredPorts.length} 个端口全部可拉起`);
    // 可投平台优先保证：哪怕将来为了压资源给「待接入」平台做减法，也不能减到它们头上
    const missingSup = SUPPORTED_PLATFORMS
      .map((p) => ({ p, port: DEFAULT_CDP_PORTS[p] }))
      .filter((x) => !fallbackPorts.includes(x.port));
    check('兜底拉起表覆盖全部「可投」平台端口', missingSup.length === 0,
      missingSup.length ? `漏 ${missingSup.map((x) => `${x.p}:${x.port}`).join(', ')}` : `${SUPPORTED_PLATFORMS.length} 个可投平台全部可拉起`);
  }
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

// ═══════════════════════════════════════════════════════════
console.log('\n══════ F2. 网申自动路由分类器（遇到需要网申的就自动走 wangshen） ══════');
// 用户诉求（2026-09-30）：岗位池里凡是「需要网申」的（投递链接指向企业 ATS / 校招网申系统 /
// 企业自建招聘子域），应当**自动**调用独立「网申」通道（wangshen）投递，而不是回落 offerbiu 或被跳过。
// 这是「按 apply_url 自动分流到对应投递通道」的判定，被 runApply 与 runBatchApply('auto') 共用。
{
  // 已知聚合平台 → 各自引擎，且**不算网申**
  const aggregators: Array<[string, string]> = [
    ['https://www.zhipin.com/job_detail/abc.html', 'boss'],
    ['https://we.51job.com/pc/search?keyword=x', 'job51'],
    ['https://www.zhaopin.com/jobs?kw=x', 'zhilian'],
    ['https://www.nowcoder.com/jobs/abc', 'nowcoder'],
    ['https://www.liepin.com/zhaopin/abc', 'liepin'],
    ['https://www.iguopin.com/job/abc', 'iguopin'],
    ['https://www.yupao.com/job/abc', 'yupao'],
    ['https://www.chinahr.com/job/abc', 'chinahr'],
    ['https://www.yingjiesheng.com/job/abc', 'yingjiesheng'],
  ];
  let aggOk = true;
  for (const [url, p] of aggregators) {
    const c = classifyDelivery(url);
    if (c.platform !== p || c.needsWangshen) { aggOk = false; console.log(`   ⚠️ ${url} → ${c.platform}(wangshen=${c.needsWangshen})，期望 ${p}`); }
  }
  check('已知聚合平台链接全部路由到各自引擎且不算网申', aggOk);

  // 企业自建子域（zhaopin.company.com 这类）不应被误判为智联，而应判网申
  check('zhaopin.company.com 不被误判为智联聚合平台', aggregatorPlatformOf('https://zhaopin.example.com/jobs/1') === null);
  check('zhaopin.company.com 被判定为需要网申', isWangshenUrl('https://zhaopin.example.com/jobs/1'));

  // ATS / 网申系统域名 → wangshen
  const ats: string[] = [
    'https://boards.greenhouse.io/company/jobs/1',
    'https://jobs.lever.co/company/abc',
    'https://company.wd1.myworkdayjobs.com/External',
    'https://jobs.ashbyhq.com/company/abc',
    'https://company.italent.cn/recruit/abc',
    'https://talent.mokahr.com/position/abc',
  ];
  let atsOk = true;
  for (const url of ats) {
    const c = classifyDelivery(url);
    if (c.platform !== 'wangshen' || !c.needsWangshen) { atsOk = false; console.log(`   ⚠️ ${url} → ${c.platform}(wangshen=${c.needsWangshen})，期望 wangshen`); }
  }
  check('国内外 ATS/网申系统域名全部路由到 wangshen', atsOk);

  // 企业自建招聘/校招子域 → wangshen
  const subs: string[] = [
    'https://careers.google.com/jobs/1',
    'https://jobs.apple.com/position/1',
    'https://campus.tencent.com/apply/1',
    'https://join.bytedance.com/position/1',
    'https://recruit.baidu.com/job/1',
    'https://招聘.alibaba.com/social/1',
    'https://校招.huawei.com/apply/1',
  ];
  let subOk = true;
  for (const url of subs) {
    const c = classifyDelivery(url);
    if (c.platform !== 'wangshen' || !c.needsWangshen) { subOk = false; console.log(`   ⚠️ ${url} → ${c.platform}(wangshen=${c.needsWangshen})，期望 wangshen`); }
  }
  check('企业自建招聘/校招子域（含中文子域）全部路由到 wangshen', subOk);

  // 微信推文 → 邮箱通道（不算网申）
  const wx = classifyDelivery('https://mp.weixin.qq.com/s/abc123');
  check('微信招聘推文走邮箱通道且不算网申', wx.method === 'email' && !wx.needsWangshen && wx.platform === 'offerbiu');

  // 普通公司官网/新闻页 → 回落通用官网投递（不算网申，不误投）
  const generic = classifyDelivery('https://www.example-company.com/about/culture');
  check('普通公司官网链接回落通用官网投递且不算网申', generic.platform === 'offerbiu' && generic.method === 'official' && !generic.needsWangshen);

  // 空链接 → 回落，不抛错
  check('空链接不抛错且回落通用官网投递', classifyDelivery('').platform === 'offerbiu' && classifyDelivery(null).platform === 'offerbiu');

  // classifyDelivery 与 isWangshenUrl 结论一致（单点真相）
  const consistent = ['https://jobs.lever.co/x/y', 'https://www.zhipin.com/x', 'https://www.example.com/x']
    .every((u) => classifyDelivery(u).needsWangshen === isWangshenUrl(u));
  check('classifyDelivery.needsWangshen 与 isWangshenUrl 结论一致', consistent);
}

// ═══════════════════════════════════════════════════════════
console.log('\n══════ F3. 监视器「边投递边找」（0 投递时主动搜索采集） ══════');
// 背景（2026-09-30 实测）：被打招呼质量闸门拦下的低分岗**状态仍是 candidate**，不会被消耗 ⇒ 候选池
// 永远降不到 runBatchApply 内部 autoRefill 的 MIN_POOL=3 阈值以下 ⇒ 监视器会永久 0 投递、且永不搜索
// （实测：43 个剩余候选分全 <40，每轮「applied=0 skipped=10」死循环）。
// 故在 watcher 层补：本轮「0 投递 + 有跳过」时主动 collectBossToDb 实时搜索采集新岗位。
{
  const w = stripComments(readText('server/services/apply/autoApplyWatcher.ts'));
  check(
    '监视器引入 BOSS 采集器 collectBossToDb',
    /import\s*\{[^}]*collectBossToDb[^}]*\}\s*from\s*['"]\.\/engine\.js['"]/.test(w),
    '没引入 collectBossToDb ⇒ 「找」无从谈起',
  );
  check(
    '监视器在「本轮 0 投递」时主动调用 collectBossToDb 搜索采集（而非只依赖池<3的 autoRefill）',
    /applied\s*===\s*0[\s\S]{0,300}collectBossToDb\s*\(/.test(w),
    '0 投递时不主动搜索 ⇒ 低分岗占池导致永久卡死',
  );
  check(
    '监视器支持可选的匹配分闸门(minScore，默认关)并透传给每轮投递',
    /minScore\s*:\s*config\.minScore/.test(w) && /minScore\s*:\s*0/.test(w),
    'minScore 需默认 0（未配 AI 时开 >0 会把岗位全误杀）',
  );
  // 闭合「边投递边找」的第二半：批量必须让池子前进 —— 已带 skip_reason 的岗位排到最后，
  // 否则它们每轮被反复挑中、新岗永远轮不到（实测 43 个低分岗占池，每轮 applied=0 skipped=10 死循环）。
  const b = stripComments(readText('server/services/apply/batch.ts'));
  check(
    '批量投递把「已带 skip_reason 的岗位」排到最后（未评估/新岗优先，池子才会前进）',
    /filtered\.sort\(\(a,\s*b\)\s*=>\s*\{[\s\S]{0,220}skip_reason[\s\S]{0,220}match_score/.test(b),
    '缺这条 ⇒ 「边投递边找」卡在每轮投同一批、全部跳过',
  );
  // 真凶（2026-09-30）：老库 jobs.match_score 列默认值是 0，新采集岗落成 0；打招呼闸门把 0 当「评了 0 分」
  // ⇒ 每个新岗都被判「匹配度过低（界面匹配分 0 < 40）」跳过 ⇒ 「边投递边找」永远 0 投递。
  const g = stripComments(readText('server/services/apply/greetDecision.ts'));
  check(
    '打招呼闸门把「0 分」视为未评分（只有 >0 才启用匹配度闸门）',
    /storedScore\s*>\s*0/.test(g),
    'score=0 被当有效分 ⇒ 新采集岗位全被「匹配度过低」误杀',
  );
  check(
    '批量算分把「0 分」也当作未评分（match_score<=0 也去算分）',
    /match_score\s*==\s*null\s*\|\|\s*j\.match_score\s*<=\s*0/.test(b),
    '0 分不进算分分支 ⇒ 开 minScore 时旧 0 分岗仍被误杀',
  );
  const d = stripComments(readText('server/db.ts'));
  check(
    'upsertJob 显式写 match_score（未评分落 NULL，不落老库默认的 0）',
    /INSERT INTO jobs \([^)]*match_score[^)]*\)/.test(d) && /match_score:\s*job\.match_score\s*\?\?\s*null/.test(d),
    '不显式写 NULL ⇒ 新岗 match_score=0 ⇒ 被闸门误杀',
  );
}

// ═══════════════════════════════════════════════════════════
console.log('\n══════ G. 简历请求卡片「同意」（有真实副作用，预览必须不点） ══════');
// 背景（2026-09-23）：BOSS 的「我想要一份您的附件简历，您是否同意」是**平台结构化卡片**，
// 必须点卡片上的「同意」；走工具栏「发简历」是另一条路径 —— 卡片会一直挂着待处理（实机已验证）。
// 核心不变量：**预览模式绝不能点击** —— 点下去会把简历真实发给 HR，预览必须保持零副作用。

// G1 真实发送 + 有卡片 → 点「同意」，且不再重复走工具栏发简历
{
  fresh();
  const conv = mkConv(21, 'G公司');
  const { driver, calls } = makeDriver([conv], '我想要一份您的附件简历，您是否同意 拒绝 同意', 'Java开发', { resumeRequest: true });
  registerChatDriver('boss', driver);
  const { evs, emit } = collect();
  const r = await runAutoReply('boss', {
    probe: okProbe, useAi: false, realSend: true, throttleSec: 1, hrCooldownSec: 0, targetPositions: ['Java开发'],
  }, emit);
  check('G1 有卡片 → 调用 acceptResumeRequest', calls.acceptResume === 1, `acceptResume=${calls.acceptResume}`);
  check('G1 发出 accept-resume(ok=true) 事件', evs.some((e) => e.type === 'accept-resume' && e.ok === true));
  check('G1 已同意卡片 → 不再重复走工具栏发简历', calls.sendResume === 0, `sendResume=${calls.sendResume}`);
  check('G1 仍会发话术告知 HR', calls.sendText === 1 && r.sent === 1, `sendText=${calls.sendText} sent=${r.sent}`);
  check('G1 会话已落库', !!getConversation(conv.key));
}

// G2 预览模式 + 有卡片 → 绝不点击（点了就真的发出去了）
{
  fresh();
  const conv = mkConv(22, 'H公司');
  const { driver, calls } = makeDriver([conv], '我想要一份您的附件简历，您是否同意 拒绝 同意', 'Java开发', { resumeRequest: true });
  registerChatDriver('boss', driver);
  const { evs, emit } = collect();
  await runAutoReply('boss', {
    probe: okProbe, useAi: false, realSend: false, throttleSec: 1, hrCooldownSec: 0, targetPositions: ['Java开发'],
  }, emit);
  check('G2 预览 → 绝不调用 acceptResumeRequest', calls.acceptResume === 0, `acceptResume=${calls.acceptResume}`);
  check('G2 预览 → 绝不调用 sendResume', calls.sendResume === 0, `sendResume=${calls.sendResume}`);
  check('G2 预览 → 只发 accept-resume-preview 提示事件', evs.some((e) => e.type === 'accept-resume-preview'));
  check('G2 预览 → 未写库', !getConversation(conv.key));
}

// G3 无卡片 → 完全不受影响（回归保护）
{
  fresh();
  const conv = mkConv(23, 'I公司');
  const { driver, calls } = makeDriver([conv], '你好，方便聊聊吗', 'Java开发');
  registerChatDriver('boss', driver);
  const { evs, emit } = collect();
  await runAutoReply('boss', {
    probe: okProbe, useAi: false, realSend: true, throttleSec: 1, hrCooldownSec: 0, targetPositions: ['Java开发'],
  }, emit);
  check('G3 无卡片 → 不调用 acceptResumeRequest', calls.acceptResume === 0, `acceptResume=${calls.acceptResume}`);
  check('G3 无卡片 → 无任何 accept-resume 事件', !evs.some((e) => e.type === 'accept-resume' || e.type === 'accept-resume-preview'));
}

// G4 冷却期内仍处理卡片（HR 的简历请求不该被"刚回复过"挡住）
{
  fresh();
  const conv = mkConv(24, 'J公司');
  // 先把该会话置为「刚回复过」→ 进入 hrCooldownSec 冷却（默认 3600s）
  upsertConversation({
    conv_key: conv.key, platform: 'boss', hr_name: conv.name, company: conv.company,
    position: 'Java开发', stage: 'active', last_hr_message: '旧的HR消息', last_reply: '旧回复',
    last_hr_message_at: new Date().toISOString(), last_replied_at: new Date().toISOString(),
    round: 1, ai_name: '懒懒', ai_source: 'ai',
  });
  const { driver, calls } = makeDriver([conv], '我想要一份您的附件简历，您是否同意 拒绝 同意', 'Java开发', { resumeRequest: true });
  registerChatDriver('boss', driver);
  const { evs, emit } = collect();
  // 不传 hrCooldownSec → 走默认冷却；命中冷却后应仍为卡片开例外
  await runAutoReply('boss', {
    probe: okProbe, useAi: false, realSend: true, throttleSec: 1, targetPositions: ['Java开发'],
  }, emit);
  check('G4 冷却期内 → 仍同意简历请求卡片', calls.acceptResume === 1, `acceptResume=${calls.acceptResume}`);
  check('G4 事件带 via=cooldown-bypass', evs.some((e) => e.type === 'accept-resume' && e.via === 'cooldown-bypass'));
  check('G4 冷却例外 → 不重复发话术', calls.sendText === 0, `sendText=${calls.sendText}`);
  check('G4 仍标记 hr-cooldown 跳过', evs.some((e) => e.type === 'skipped' && e.reason === 'hr-cooldown'));
}

// G5 直接对 bossChat.acceptResumeRequest 做「副作用次数」护栏（2026-09-23 回归）
// 此前 G1–G4 都 mock 掉 driver，测不到 bossChat.ts 内部「重试循环连点 3 次」这类 bug。
// 这里注入桩 ex，断言：① 一次调用**恰好点击一次**（CLICK 脚本只发一遍，杜绝 3 连发）；
//          ② 已发送态（CLICK 返回 ALREADY）**零点击**（纵深防线，重复调用不重发）。
{
  type FakeState = { clickResult: string; checkResult: any };
  let st: FakeState = { clickResult: 'CARD', checkResult: false };
  let calls = { click: 0, otherEval: 0 };
  const fakeEx = async (action: string, extra: any = {}) => {
    if (action === 'eval') {
      const s = String(extra.script || '');
      if (s.includes('.click()')) { calls.click++; return { data: st.clickResult }; } // 仅 CLICK 脚本含 .click()
      calls.otherEval++;
      return { data: st.checkResult };
    }
    return { data: null };
  };
  const runGuard = async () => {
    calls = { click: 0, otherEval: 0 };
    __setExForTest(fakeEx);
    try {
      const r = await acceptResumeRequest();
      return r;
    } finally {
      __setExForTest(null);
    }
  };

  // G5a 正常成功路径：CLICK=CARD（点了）→ CHECK=按钮已禁用(false)=已处理
  st = { clickResult: 'CARD', checkResult: false };
  const rA = await runGuard();
  check('G5a 正常路径 → 返回已处理(true)', rA === true, `r=${rA}`);
  check('G5a ⚠️ 一次调用恰好点击一次（防 3 连发回归）', calls.click === 1, `click=${calls.click}`);
  check('G5a 点击后复核一次(CHECK)', calls.otherEval === 1, `otherEval=${calls.otherEval}`);

  // G5b 已发送态：CLICK=ALREADY（同意按钮已禁用）→ 直接视为已处理，且不进入 2.5s 等待/CHECK（早返回）
  st = { clickResult: 'ALREADY', checkResult: false };
  const rB = await runGuard();
  check('G5b 已发送态 → 返回已处理(true)', rB === true, `r=${rB}`);
  check('G5b ⚠️ 已发送态早返回（无 CHECK、未浪费等待）', calls.click === 1 && calls.otherEval === 0, `click=${calls.click} otherEval=${calls.otherEval}`);

  // G5c 无卡片：CLICK=NOT_FOUND → 未处理(false)，同样只探测一次、无后续 CHECK
  st = { clickResult: 'NOT_FOUND', checkResult: false };
  const rC = await runGuard();
  check('G5c 无卡片 → 返回未处理(false)', rC === false, `r=${rC}`);
  check('G5c 无卡片仅探测一次', calls.click === 1 && calls.otherEval === 0, `click=${calls.click} otherEval=${calls.otherEval}`);
}

// G6 路由铁律（2026-09-23 用户明确）：结构化卡片存在时，即便 acceptResumeRequest 点击**失败**，
// 也**绝不回退工具栏 sendResume**（工具栏是另一条路径，卡片会一直挂着待处理）。点击失败就让
// 卡片保持待处理态，下一轮重新检测再点（跨轮重试更安全）。
{
  fresh();
  const conv = mkConv(25, 'K公司');
  // resumeRequest=true（卡片在）+ acceptOk=false（这次没点成）
  const { driver, calls } = makeDriver([conv], '请把简历发我看看', 'Java开发', { resumeRequest: true, acceptOk: false });
  registerChatDriver('boss', driver);
  const { evs, emit } = collect();
  await runAutoReply('boss', {
    probe: okProbe, useAi: false, realSend: true, throttleSec: 1, hrCooldownSec: 0, targetPositions: ['Java开发'],
  }, emit);
  check('G6 卡片在 → 仍尝试 acceptResumeRequest 一次', calls.acceptResume === 1, `acceptResume=${calls.acceptResume}`);
  check('G6 ⚠️ 卡片在（即便点击失败）绝不回退工具栏 sendResume', calls.sendResume === 0, `sendResume=${calls.sendResume}`);
  check('G6 上报 accept-resume(ok=false) 表示点击未成功', evs.some((e) => e.type === 'accept-resume' && e.ok === false));
}

// G7 对照：无结构化卡片的纯文本简历请求（如「请把简历发我」）→ 走工具栏 sendResume，不点卡片
{
  fresh();
  const conv = mkConv(26, 'L公司');
  const { driver, calls } = makeDriver([conv], '请把简历发我看看', 'Java开发'); // resumeRequest 默认 false
  registerChatDriver('boss', driver);
  const { evs, emit } = collect();
  await runAutoReply('boss', {
    probe: okProbe, useAi: false, realSend: true, throttleSec: 1, hrCooldownSec: 0, targetPositions: ['Java开发'],
  }, emit);
  check('G7 无卡片纯文本请求 → 走工具栏 sendResume', calls.sendResume === 1, `sendResume=${calls.sendResume}`);
  check('G7 无卡片 → 不调用 acceptResumeRequest（没有卡片可点）', calls.acceptResume === 0, `acceptResume=${calls.acceptResume}`);
}

// G8 通用 acceptResumeRequestGeneric 平台无关语义（2026-09-23 跨平台化回归）
// 证明「点卡片同意」逻辑不绑定 BOSS：直接用通用函数 + 桩 ex 即可断言副作用次数与早返回。
{
  let st: { clickResult: string; checkResult: any } = { clickResult: 'CARD', checkResult: false };
  let calls = { click: 0, otherEval: 0 };
  const fakeEx = async (action: string, extra: any = {}) => {
    if (action === 'eval') {
      const s = String(extra.script || '');
      if (s.includes('.click()')) { calls.click++; return { data: st.clickResult }; } // 仅 CLICK 脚本含 .click()
      calls.otherEval++;
      return { data: st.checkResult };
    }
    return { data: null };
  };
  const runGuard = async () => {
    calls = { click: 0, otherEval: 0 };
    return acceptResumeRequestGeneric(fakeEx);
  };

  st = { clickResult: 'CARD', checkResult: false };
  const rA = await runGuard();
  check('G8a 通用正常路径 → 已处理(true)', rA === true, `r=${rA}`);
  check('G8a ⚠️ 通用实现一次调用恰好点击一次（防 3 连发）', calls.click === 1, `click=${calls.click}`);
  check('G8a 点击后复核一次(CHECK)', calls.otherEval === 1, `otherEval=${calls.otherEval}`);

  st = { clickResult: 'ALREADY', checkResult: false };
  const rB = await runGuard();
  check('G8b 通用已发送态 → 已处理(true)', rB === true, `r=${rB}`);
  check('G8b ⚠️ 已发送态早返回（无 CHECK、未浪费等待）', calls.click === 1 && calls.otherEval === 0, `click=${calls.click} otherEval=${calls.otherEval}`);

  st = { clickResult: 'NOT_FOUND', checkResult: false };
  const rC = await runGuard();
  check('G8c 通用无卡片 → 未处理(false)', rC === false, `r=${rC}`);
  check('G8c 无卡片仅探测一次', calls.click === 1 && calls.otherEval === 0, `click=${calls.click} otherEval=${calls.otherEval}`);
}

// G9 liepin 接入通用卡片处理（2026-09-23 跨平台化）
// 证明 liepinChatDriver 已暴露 acceptResumeRequest 且走通用实现（经注入 ex 验证）；
// 以及「未实现该能力的平台」被引擎优雅跳过（走工具栏，不报错）。
{
  check('G9 liepinChatDriver 暴露 acceptResumeRequest 能力', typeof liepinChatDriver.acceptResumeRequest === 'function');
  let st: { clickResult: string; checkResult: any } = { clickResult: 'CARD', checkResult: false };
  let calls = { click: 0, otherEval: 0 };
  const fakeEx = async (action: string, extra: any = {}) => {
    if (action === 'eval') {
      const s = String(extra.script || '');
      if (s.includes('.click()')) { calls.click++; return { data: st.clickResult }; }
      calls.otherEval++;
      return { data: st.checkResult };
    }
    return { data: null };
  };
  __setExForTestLiepin(fakeEx);
  try {
    const r = await liepinChatDriver.acceptResumeRequest!();
    check('G9 liepin acceptResumeRequest 走通用实现 → 已处理(true)', r === true, `r=${r}`);
    check('G9 liepin 一次调用恰好点击一次', calls.click === 1, `click=${calls.click}`);
    check('G9 liepin 点击后复核一次', calls.otherEval === 1, `otherEval=${calls.otherEval}`);
  } finally {
    __setExForTestLiepin(null);
  }

  // 能力存在性路由：未实现 acceptResumeRequest 的平台（如尚未接入聊天驱动的智联/51job）应被跳过，
  // 纯文本简历请求回落工具栏 sendResume，不抛错。
  fresh();
  const c2 = { sendResume: 0 };
  const noCardDriver: ChatDriver = {
    platform: 'zhilian',
    openChat: async () => {},
    listConversations: async () => [{ key: `${RUN_TAG}-g9-zhilian`, name: 'HR', company: '', lastMsg: '请把简历发我看看', unread: true, raw: '' }],
    openConversation: async () => true,
    readConversation: async () => ({ messages: [{ side: 'hr', text: '请把简历发我看看' }], lastHr: '请把简历发我看看', position: 'Java开发', resumeRequest: false }),
    sendText: async () => true,
    sendResume: async () => { c2.sendResume++; return true; },
  };
  registerChatDriver('zhilian', noCardDriver);
  const { evs, emit } = collect();
  await runAutoReply('zhilian', { probe: okProbe, useAi: false, realSend: true, throttleSec: 1, hrCooldownSec: 0, targetPositions: ['Java开发'] }, emit);
  check('G9 无 acceptResumeRequest 的平台 → 引擎跳过（绝不调用）', (noCardDriver as any).acceptResumeRequest === undefined);
  check('G9 无卡片纯文本请求 → 走工具栏 sendResume', c2.sendResume === 1, `sendResume=${c2.sendResume}`);
}

// G10 跨平台化验收（2026-09-23 续）：其余 7 个 Web IM 平台经 genericChatDriver 工厂生成，
// 必须全部暴露 acceptResumeRequest 且走通用实现（一次点击 / 已发送态早返回 / 无卡片早返回）。
{
  // 恢复被 G9 临时覆盖的 zhilian 真实驱动
  registerChatDriver('zhilian', zhilianChatDriver);
  type TestableDriver = ChatDriver & { __setExForTest: (fn: any) => void };
  const drivers: TestableDriver[] = [
    zhilianChatDriver, job51ChatDriver, nowcoderChatDriver, iguopinChatDriver,
    yupaoChatDriver, chinahrChatDriver, yingjieshengChatDriver,
  ] as TestableDriver[];
  for (const d of drivers) {
    check(`G10 ${d.platform} 暴露 acceptResumeRequest 能力`, typeof d.acceptResumeRequest === 'function');
    let st: { clickResult: string; checkResult: any } = { clickResult: 'CARD', checkResult: false };
    let calls = { click: 0, otherEval: 0 };
    const fakeEx = async (action: string, extra: any = {}) => {
      if (action === 'eval') {
        const s = String(extra.script || '');
        if (s.includes('.click()')) { calls.click++; return { data: st.clickResult }; } // 仅 CLICK 脚本含 .click()
        calls.otherEval++;
        return { data: st.checkResult };
      }
      return { data: null };
    };
    d.__setExForTest(fakeEx);
    try {
      const r = await d.acceptResumeRequest!();
      check(`G10 ${d.platform} 走通用实现 → 已处理(true)`, r === true, `r=${r}`);
      check(`G10 ${d.platform} ⚠️ 一次调用恰好点击一次（防 3 连发）`, calls.click === 1, `click=${calls.click}`);
      check(`G10 ${d.platform} 点击后复核一次`, calls.otherEval === 1, `otherEval=${calls.otherEval}`);
    } finally {
      d.__setExForTest(null);
    }
  }
}

// G11 引擎入口守卫：未登记聊天驱动的平台（如 offerbiu 邮件通道）应明确报错并退出，
// 绝不静默空跑（否则会出现「跑了 N 个、发了 0 条」而无任何提示的诡异现象）。
{
  const { evs, emit } = collect();
  const res = await runAutoReply('offerbiu', { probe: okProbe, useAi: false, realSend: true, throttleSec: 1 }, emit);
  check('G11 未登记平台 → 引擎报错（非静默空跑）', evs.some((e) => e.type === 'error'), `errs=${evs.filter((e) => e.type === 'error').length}`);
  check('G11 未登记平台 → 零发送零跳过', res.sent === 0 && res.skipped === 0, `sent=${res.sent} skipped=${res.skipped}`);
}

// H. 对标增强模块合约（LoopCV / Resumly / CareerBoom 四项新能力）
//    纯本地、离线、零浏览器依赖：锁定「远程识别」「简历合规体检」「A/B 报告」的确定性行为。
{
  // H1 远程岗位识别（对标 Resumly）：命中远程表述→1，否则→0
  check('H1 远程识别命中「远程办公」', detectRemote('本岗位支持远程办公') === 1, `v=${detectRemote('本岗位支持远程办公')}`);
  check('H1 远程识别命中英文 remote', detectRemote('remote position available') === 1);
  check('H1 非远程表述→0（驻场/现场）', detectRemote('需要驻场开发，现场办公') === 0);

  // H2 简历合规体检（对标 LoopCV）：空简历 → ok:false 且给整改建议
  const empty = checkResumeCompliance({ resumeText: '' });
  check('H2 空简历 → ok:false', empty.ok === false, `score=${empty.score}`);
  check('H2 空简历 → 含整改建议', empty.issues.length > 0);

  // H3 完整简历 → 分数落在 [0,100] 且 grade 合法；量化经历被识别
  const good = checkResumeCompliance({
    resumeText:
      '张三 13800138000 z@x.com 教育背景 软件工程专业本科 工作经历 负责3个项目业绩提升40% 技能 熟悉Java 项目经历 服务2万+用户',
  });
  check('H3 完整简历 → ok:true', good.ok === true, `score=${good.score}`);
  check('H3 分数落在 [0,100]', good.score >= 0 && good.score <= 100, `score=${good.score}`);
  check('H3 grade 合法', ['优秀', '良好', '一般', '偏弱', '缺失'].includes(good.grade), `grade=${good.grade}`);
  check('H3 识别量化经历', good.stats.quantified === true);
  check('H3 识别联系方式完整', good.stats.hasPhone && good.stats.hasEmail);

  // H4 含 emoji/表格/全大写 → 格式卫生扣分
  const dirty = checkResumeCompliance({ resumeText: '张三 13800138000 a@b.com 教育背景 软件工程 🚀 工作经历 | 列1 | 列2 | EXPERIENCE 技能 Java' });
  check('H4 emoji/表格/全大写被标记', dirty.issues.some((i) => i.rule === '格式卫生'), `issues=${dirty.issues.length}`);

  // H8 已投判定口径（2026-09-25 修复「跨公司/跨平台误判已投」）：
// 旧实现无平台维度、且 company 为空时退化为「只比 position」→ 同名职位在任意公司/平台都被判已投。
{
  const pos = 'CT-ALREADY-' + RUN_TAG;
  const ins = "INSERT INTO applications (id, platform, company, position, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)";
  const now = new Date().toISOString();
  exec(ins, ['ct-ap-blank-' + RUN_TAG, 'boss', '', pos, 'applied', now, now]);
  exec(ins, ['ct-ap-co-' + RUN_TAG, 'boss', '测试公司A', pos, 'applied', now, now]);
  try {
    check('H8 同平台+同公司 → 判为已投', alreadyApplied('boss', '测试公司A', pos));
    check('H8 company 为空的历史行不再误伤其它公司', !alreadyApplied('boss', '测试公司B', pos));
    check('H8 平台不同 → 不判为已投（跨平台同名不算同一岗位）', !alreadyApplied('zhilian', '测试公司A', pos));
    check('H8 岗位不同 → 不判为已投', !alreadyApplied('boss', '测试公司A', pos + '-不存在'));
  } finally {
    exec("DELETE FROM applications WHERE position = ?", [pos]);
  }
}

// H5 A/B 报告（对标 LoopCV）：结构正确、total>=0、strategies 为数组
  const ab = computeAbReport();
  check('H5 A/B 报告结构正确', ab && typeof ab.total === 'number' && Array.isArray(ab.strategies), `total=${ab?.total}`);
  check('H5 A/B 报告 total>=0', (ab?.total ?? -1) >= 0);
  // F5：legacy（历史未打标）不参与对照；三分必须完备（每行恰好落入一个桶）
  check('H5 A/B 对照排除 legacy 且条数可读', typeof ab?.letterVsNoLetter?.legacyExcluded === 'number', `legacyExcluded=${ab?.letterVsNoLetter?.legacyExcluded}`);
  check('H5 A/B 三分完备（letter + no_letter + legacy = total）',
    (ab?.letterVsNoLetter?.has.applications ?? -1) + (ab?.letterVsNoLetter?.no.applications ?? -1) + (ab?.letterVsNoLetter?.legacyExcluded ?? -1) === ab?.total,
    `has=${ab?.letterVsNoLetter?.has.applications} no=${ab?.letterVsNoLetter?.no.applications} legacy=${ab?.letterVsNoLetter?.legacyExcluded} total=${ab?.total}`);
}

// H6 模拟真人节奏（对标 CareerBoom.ai）：humanize 关闭时退化为固定间隔（调试可复现），
// 开启时双层抖动且永不出现负间隔 / 不会比基础间隔慢到离谱（<= 2.6× 兜底）。
{
  // 关闭 → 必须等于 base（无抖动），否则调试时节奏不可复现
  check('H6 humanize=false → 固定间隔(=base)', humanizedGap(20000, false) === 20000, `g=${humanizedGap(20000, false)}`);
  // 开启 → 在 [0.75×, 2.6×] 内，且多次采样不全相等（即确实在抖动）
  const base = 20000;
  let minG = Infinity, maxG = -Infinity; const seen = new Set<number>();
  for (let k = 0; k < 200; k++) {
    const g = humanizedGap(base, true);
    minG = Math.min(minG, g); maxG = Math.max(maxG, g); seen.add(g);
    if (g < 0) { check('H6 间隔不为负', false, `g=${g}`); break; }
  }
  check('H6 humanize=true → 间隔 >= 0.75×base', minG >= Math.floor(base * 0.75), `min=${minG}`);
  check('H6 humanize=true → 间隔 <= 2.6×base（含偶发长间隔兜底）', maxG <= Math.ceil(base * 2.6), `max=${maxG}`);
  check('H6 humanize=true → 确实在抖动（多次采样不全相等）', seen.size > 1, `distinct=${seen.size}`);
  // 显式区间优先：传 [min,max] 时落在区间内
  // 显式区间优先：传 [min,max] 时落在区间内。
  // ⚠️ 2026-09-26 修：原来只采样 1 次 → 实现里那条「8% 概率长间隔」有 8% 概率越过区间，
  // 于是这条用例以 8% 的几率随机变红（同一份代码时而全绿时而红，最容易被当成"噪声"放过去）。
  // 随机性必须靠采样量压掉：200 次采样下旧实现的失败概率 = 1 - 0.92^200 ≈ 100%。
  let outOfRange = 0; let sampleG = 0;
  for (let k = 0; k < 200; k++) {
    sampleG = humanizedGap(base, true, [3000, 5000]);
    if (sampleG < 3000 || sampleG > 5000) outOfRange++;
  }
  check('H6 显式区间优先（落 [min,max]）', outOfRange === 0,
    `200 次采样中越界 ${outOfRange} 次，末次 g=${sampleG}`);
}

// ── H7 段：自动回复「架构不支持」平台标记（51job/鱼泡/中华英才 无可用 Web IM）──
{
  const cfgOf = (d: ChatDriver) => (d as unknown as { config?: { autoReplySupported?: boolean; disabledReason?: string } }).config;
  check('H7 job51 标记不支持自动回复', cfgOf(job51ChatDriver)?.autoReplySupported === false, cfgOf(job51ChatDriver)?.disabledReason || '');
  check('H7 yupao 标记不支持自动回复', cfgOf(yupaoChatDriver)?.autoReplySupported === false, cfgOf(yupaoChatDriver)?.disabledReason || '');
  check('H7 chinahr 标记不支持自动回复', cfgOf(chinahrChatDriver)?.autoReplySupported === false, cfgOf(chinahrChatDriver)?.disabledReason || '');
  check('H7 zhilian 仍支持自动回复', cfgOf(zhilianChatDriver)?.autoReplySupported !== false);
  check('H7 待登录平台(nowcoder/iguopin/yingjiesheng)仍标记支持',
    cfgOf(nowcoderChatDriver)?.autoReplySupported !== false &&
    cfgOf(iguopinChatDriver)?.autoReplySupported !== false &&
    cfgOf(yingjieshengChatDriver)?.autoReplySupported !== false);
}

// ── 版本标识 + 检查更新（对齐「商城软件」差距表 2026-09-26：包无版本标识 / 无更新机制）──
{
  const ROOT = fileURLToPath(new URL('..', import.meta.url));
  const src = fs.readFileSync(path.join(ROOT, 'server/index.ts'), 'utf8');
  check('版本接口 /api/version 已注册', src.includes('app.get("/api/version"'),
    '缺它则用户无法自证自己跑的是哪一版，报障无从谈起');
  check('更新检查接口 /api/update-check 已注册', src.includes('app.get("/api/update-check"'),
    '缺它则没有任何新版本提示渠道');
  // 安全边界：更新检查只许「提示 + 给链接」，绝不能自动下载/安装
  check('更新检查不含自动下载/安装动作', !/autoInstall|autoDownload|installer/i.test(src),
    '单机绿色包的更新 = 重新解压，不许有自动写盘行为');
  const con = fs.readFileSync(path.join(ROOT, 'public/console.html'), 'utf8');
  check('控制台常显版本并接更新检查', con.includes('async function loadVersion') && con.includes('async function checkUpdate'),
    '自检卡应有版本行与「检查更新」按钮');
  // 首跑图形化向导（2026-09-26 对齐差距表「配置：图形化向导」行）：
  // 自检卡只「报告缺什么」，向导才提供「每步可以点」的动作。
  check('首跑图形化向导已接入控制台', con.includes('async function renderWizard') && con.includes('data-wz="windows"') && con.includes('data-wz="resume"'),
    '向导应把 selfcheck 的 todo 项渲染成带动作按钮的步骤');
  check('向导动作走真实接口（ensure-all）', con.includes('/api/browser/ensure-all'),
    '「拉起窗口」必须调用已存在的后端自愈接口，不许是装饰性按钮');
  // 应用图标（2026-09-26 用户要求换图标）：桌面快捷方式与浏览器标签页共用 public/app.ico
  const icoPath = path.join(ROOT, 'public', 'app.ico');
  const icoOk = fs.existsSync(icoPath)
    && con.includes('rel="icon" href="/app.ico"')
    && fs.readFileSync(path.join(ROOT, 'create_desktop_shortcut.bat'), 'utf8').includes('IconLocation');
  check('应用图标已生成且被快捷方式/控制台引用', icoOk,
    '缺 favicon 浏览器标签显默认地球；快捷方式不设 IconLocation 显通用 bat 图标');

  // ⚠️ ICO 必须真的含多档尺寸（2026-09-26 实测踩坑）：
  // 曾经用 PIL 的 save(format='ICO', sizes=[...], append_images=[...])，它的 _save 里
  // `if size[0] > width: continue` 取的是「基准图」尺寸 —— 按小到大传就把大档位全静默跳过，
  // 产出只有 16x16 一帧的 ICO（文件正常、能显示，但 32/48/256px 全是 16px 放大 ⇒ 永远糊）。
  // 四道门（tsc/selftest/合约/冒烟）当时全绿，因为没人解回来看过帧数。
  // 所以这里直接解析 ICONDIR，把「帧数」变成机械断言。
  const icoSizes: number[] = [];
  if (fs.existsSync(icoPath)) {
    const buf = fs.readFileSync(icoPath);
    const count = buf.readUInt16LE(4);              // 3-4 字节是 idCount
    for (let i = 0; i < count; i++) {
      const w = buf.readUInt8(6 + i * 16);          // 0 表示 256
      icoSizes.push(w === 0 ? 256 : w);
    }
  }
  check('图标是多尺寸 ICO（含 256 档）',
    icoSizes.length >= 4 && Math.max(...icoSizes) === 256,
    `实际帧=${JSON.stringify(icoSizes)}；单帧 ICO 会让 Windows 在大尺寸下放大 16px 而发虚`);

  // 图标生成器必须走自己的 ICO 封装（内部有「写完回读断言帧数」），
  // 而不是回到 PIL 的 ICO 保存路径 —— 那个静默跳档的坑正是这么来的。
  const iconGen = fs.readFileSync(path.join(ROOT, 'scripts', 'make_icon.py'), 'utf8');
  check('图标生成器使用带断言的 ICO 封装',
    fs.existsSync(path.join(ROOT, 'scripts', 'ico_pack.py')) && iconGen.includes('write_ico'),
    'scripts/ico_pack.py 会在写完后回读 ICONDIR 校验帧数，避免再次静默只剩一帧');

  // ── 品牌标记必须只有一个真相源（2026-09-26 用户反馈「图标换了」）─────────────
  // 症状：用户看着控制台侧边栏的橙底鸭子问「图标换了」。查下来侧边栏从没变过
  // （.brand .logo 停在 09-19 的 bf974a3），变的是 public/app.ico —— 今天换过一次。
  // 根因不是「图标变了」，是**产品里本来就有两套品牌标记**：favicon、桌面快捷方式、
  // Windows 应用图标都指向 app.ico，而侧边栏把图形写死成 🦆 emoji + 橙色渐变底。
  // 写死的标记不会跟随 app.ico 更新 ⇒ 换一次图标就露一次馅。
  // 这里把「侧边栏必须引用 app.ico」变成机械断言，而不是靠人记得。
  const brandBlock = (con.match(/<div class="brand">[\s\S]{0,400}?<\/div>/) || [''])[0];
  check('控制台侧边栏品牌标记引用 app.ico（不是写死的图形）',
    brandBlock.includes('class="logo"') && /class="logo"\s*>\s*<img[^>]+src="\/app\.ico"/.test(brandBlock),
    '侧边栏若写死 emoji / 自绘图形，换 app.ico 时不会跟随 ⇒ 一个产品两套图标');
  // U+1F986 写成码点，免得本文件自己也变成一个 emoji 字面量。
  // 只扫 brandBlock（品牌标记本身），不扫整份文件：CSS 注释里写一句「原为那只 emoji」
  // 是合理且有用的，扫全文会让断言对注释过敏（第一版就是这么写的，会自己把自己判失败）。
  check('控制台侧边栏不再写死 emoji 品牌标记',
    !brandBlock.includes(String.fromCodePoint(0x1f986)),
    '写死的 emoji 品牌标记不会跟随 app.ico 更新 —— 本次「两套图标」就是这么来的');
}

// ── 打包脚本必须纯 ASCII（2026-09-26）──────────────────────────────────────
// Windows PowerShell 5.1 读「无 BOM 的 .ps1」按 ANSI/GBK 解码：中文字节会被解成
// 乱码，某些组合还会吞掉引号/换行，导致脚本在别人机器上直接解析失败，而本机
// （代码页不同）却完全正常。这个约束此前只写在注释里，结果 pack.ps1 里积了 316 个
// 非 ASCII 字节（注释里的横线装饰），甚至我自己又新加了一个 emoji。
//
// 注意这里**枚举**而不是硬编码文件名：pack_smoke.ps1 不随包分发，在包里硬编码它会让
// 这条用例因文件不存在而崩；枚举写法在「仓库」与「解压后的包」两种环境下都成立，
// 也让将来新增的 *.ps1 自动纳入检查。
{
  const ROOT = fileURLToPath(new URL('..', import.meta.url));
  const psDirs = [ROOT, path.join(ROOT, 'scripts')];
  const targets: string[] = [];
  for (const d of psDirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (f.endsWith('.ps1')) targets.push(path.join(d, f));
    }
  }
  // 前置自检只在源码树里有意义：分发包里 pack.ps1 / pack_smoke.ps1 都不存在（不发包），
  // 枚举结果为空是正常的，不能因此判失败。
  if (fs.existsSync(path.join(ROOT, 'pack.ps1'))) {
    check('发现待检查的 .ps1 打包脚本', targets.length > 0, '没有 .ps1 说明枚举写错了（本仓库至少有 pack.ps1）');
  }
  for (const p of targets) {
    const bad = [...fs.readFileSync(p)].filter(b => b > 127).length;
    const rel = path.relative(ROOT, p).replace(/\\/g, '/');
    check(`${rel} 保持纯 ASCII`, bad === 0,
      `发现 ${bad} 个非 ASCII 字节；PS 5.1 会按 GBK 解码无 BOM 脚本，交付方可能解析失败`);
  }
}

// ── 启动器必须纯 ASCII 且无 BOM（2026-09-29）────────────────────────────────
// 与上面 .ps1 那条同源，但触发机制完全不同，所以必须单独钉：
// **cmd.exe 按字节偏移重读批处理文件**。chcp 65001 生效时，文件里任意一个多字节
// 字符都会让这个偏移错位 —— 后果是 cmd **执行注释行的碎片**，并且**静默跳过真正的
// 命令行**。注意「跳过」是安静的：脚本照样跑完、照样打 Done、退出码 0。
//
// 2026-09-29 实机事故（start_cdp.bat，中文全在 REM 注释里，约 1 KB）三连症：
//   ① 中文注释碎片被当命令执行（`'ebdriver' is not recognized`、`'EM' ...` —— 正是 REM 的尾巴）
//   ② if/else 两个**互斥**分支同时打印（`[OK] BOSS already running on 9223` 与
//      `[OK] BOSS window ready on 9223`）—— 只有解析器错位才可能都执行
//   ③ 四个 `call :launch_platform ...` 整行被跳过 ⇒ 只有 BOSS(9223) 起来，9224-9227 全空
//      （用户看到 `[WARN] port 9224..9227 not ready`，而无从知道是脚本自己把它吃了）
// 全仓同一时刻有 11 个启动器中招（apply_*.bat / 打包.bat / create_desktop_shortcut.bat /
// setenv.bat / start_all.bat / start_server.bat / rerun_liepin.bat …）。
// 注意 start_server.bat 只有**一行**中文 echo，且关键启动命令就在它下一行 —— 这次是
// 侥幸跑通的，中文量越小越不容易撞上，所以「小量中文」不能当作安全的理由。
//
// UTF-8 BOM 等价致命：它是 `@echo off` 之前的 3 个额外字节，偏移从一开始就是错的。
// 编辑器/写文件工具常会「顺手」加上，本仓库就真的被加过一轮（11 个文件全中）。
//
// 中文若确实要送达用户，走 install_first_run.bat 已验证的路子：
// `powershell -EncodedCommand <base64(UTF-16LE)>` —— .bat 本体保持纯 ASCII，
// 中文由 PowerShell 解码后显示（pre-push 的交叉引用守卫会解码该载荷）。
//
// 这里刻意写成**两条聚合断言**（而不是像 .ps1 那样每文件一条）：启动器有 13 个，
// 每文件两条会把汇总分母抬到 430+ 并淹没其它断言；聚合后失败信息仍然点名到具体文件。
//
// 判定逻辑**不在这里重写**，而是 import scripts/bat_encoding.ts —— 同一份规则同时
// 供 `bat:check` / `bat:fix` 命令行使用。否则「门禁认为安全」与「修理工认为安全」
// 会各有一套，迟早漂移（本仓库已经栽过「同一份清单写两处」的跟头）。
{
  const ROOT = fileURLToPath(new URL('..', import.meta.url));
  const batTargets = collectBatFiles(ROOT);
  // 分发包里启动器集合与源码树不同 ⇒ 前置自检只要求「枚举到东西」。
  check('发现待检查的 .bat/.cmd 启动器', batTargets.length > 0,
    '一个都没枚举到说明遍历写错了（本仓库根目录至少有 start_all.bat / start_server.bat）');

  const rel = (p: string) => path.relative(ROOT, p).replace(/\\/g, '/');
  const bomFiles: string[] = [];
  const nonAscii: string[] = [];
  for (const p of batTargets) {
    const r = inspectBatFile(p);
    if (r.bom) bomFiles.push(rel(p));
    if (r.nonAscii > 0) nonAscii.push(`${rel(p)}(${r.nonAscii})`);
  }
  check(`.bat/.cmd 无 BOM（共 ${batTargets.length} 个）`, bomFiles.length === 0,
    `BOM 是 @echo off 之前的 3 个额外字节，cmd 的字节偏移从一开始就错位。中招：${bomFiles.join(', ')}`);
  check(`.bat/.cmd 保持纯 ASCII（共 ${batTargets.length} 个）`, nonAscii.length === 0,
    `chcp 65001 下多字节字符会让 cmd 的字节偏移错位，既执行注释碎片又**静默跳过命令行**` +
    `（2026-09-29 start_cdp.bat：四个 call :launch_platform 被吃掉，端口 9224-9227 全空）。` +
    `中招：${nonAscii.join(', ')}。修法：中文改英文，或走 powershell -EncodedCommand`);
}

// ── 两条投递通道都必须落证据截图（2026-09-29）────────────────────────────────
// 背景：第③关「真实投递」端到端验收跑通后，回读 `/api/apply/evidence` 发现
// **只有 5 条记录，且全部停在 2026-09-24** —— 本次刚投的两家一家都没有。
// 追下去发现：`evidence_path` 全程只有 batch.ts 一处写入（批量通道），
// 单岗通道 `/api/apply` 建了投递记录却从不写证据 ⇒ 控制台「录屏回溯」面板
// 对「在岗位卡片上点投递」这条主路径**永远是空的**，而门禁看不出来
// （闸 7 当时只断言「证据条目 > 0」，5 条旧记录就能让它恒绿 —— 空过断言）。
//
// 匹配前**先剥注释**：否则上面这段说明文字自己就能满足 includes 判断
// （本仓库在 release.yml 上踩过同一件事）。
{
  const ROOT = fileURLToPath(new URL('..', import.meta.url));
  const strip = (s: string) => s.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const idxLive = strip(fs.readFileSync(path.join(ROOT, 'server', 'index.ts'), 'utf8'));
  const batchLive = strip(fs.readFileSync(path.join(ROOT, 'server', 'services', 'apply', 'batch.ts'), 'utf8'));

  const at = idxLive.indexOf("result.status === 'applied' && (jobId || job)");
  const applyBlock = at >= 0 ? idxLive.slice(at, at + 2000) : '';
  check('/api/apply 单岗投递成功后落证据截图',
    at >= 0 && /tryScreenshot\(/.test(applyBlock) && /updateApplication\(appId,/.test(applyBlock) && /evidence_path/.test(applyBlock),
    '单岗通道不写 evidence_path ⇒ 控制台「录屏回溯」对「点岗位卡片投递」这条主路径永远空（实测全库仅 5 条、停在 2026-09-24）');
  check('批量投递（batch.ts）同样落证据截图',
    /tryScreenshot\(/.test(batchLive) && /evidence_path/.test(batchLive),
    '两条通道里只有一条写证据 ⇒ 用户会发现「有些投递有回溯、有些没有」，且无法解释原因');
}

// ── 证据截图必须能在 BOSS 聊天页拿到（2026-09-29）────────────────────────────
// 背景：修完「单岗投递不写 evidence_path」后，实测发现证据**还是拿不到** ——
//   `Page.captureScreenshot` 在 BOSS 聊天页恒超时。同一会话同一页面的三向对照：
//     默认(未指定)       -> 超时 >12s
//     fromSurface:true   -> 超时 >12s
//     fromSurface:false  -> 成功 1284ms
//   而 BOSS 投递完成后页面正好停在 /web/geek/chat ⇒ 证据截图会系统性失败。
//   空白页截图 54ms 成功，证明**机制本身是好的**，问题只在窗口表面合成这条路径。
//
// 🔴 2026-10-05 续：上面那次修复**只对了一半** —— fromSurface:false 不再超时，但后台窗口
//   被合成器节流时回的是**纯白帧**。实测 data/evidence 203 张里 190 张全白
//   （体积 3.2–7.2KB；真实页面 143–306KB），全部集中在 BOSS、且全部落在加了兜底之后。
//   「返回了数据」≠「图里有内容」—— 验收截图修复必须看像素，不能只看 res.ok。
//
// 顺带修掉一句**在猜原因**的报错：原超时文案写「疑似页面上下文被反爬销毁」，
//   实测与反爬无关（同页面 fromSurface:false 就成功）⇒ 会把排查带向错误方向。
//   报错只应陈述「检查过什么/等了多久」。
{
  const ROOT = fileURLToPath(new URL('..', import.meta.url));
  const strip = (s: string) => s.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const cdpLive = strip(fs.readFileSync(path.join(ROOT, 'server', 'services', 'cdpDriver.ts'), 'utf8'));

  const at = cdpLive.indexOf("case 'screenshot':");
  const shotBlock = at >= 0 ? cdpLive.slice(at, at + 1500) : '';
  // 🔴 匹配要**精确到调用参数**，不能只搜 `fromSurface:false` 这个子串：
  //   本仓库踩过「断言被自己的注释满足」，这次是另一变体 —— 重试梯子的**日志文案**就含
  //   这个子串，所以只搜子串时，即使真参数被删掉断言照样绿。
  //   ⇒ 要求「captureScreenshot 的 send 调用里」出现该参数（`[^)]*` 保证不跨到下一次调用）。
  check('截图有空白帧自检与逐级重试（bringToFront 弹窗放最后一级）',
    at >= 0
    && /'Page\.captureScreenshot'[^)]*fromSurface:\s*false/.test(shotBlock)
    && /isBlank/.test(shotBlock)
    && /setWebLifecycleState/.test(shotBlock)
    && /Page\.bringToFront/.test(shotBlock)
    && /catch/.test(shotBlock),
    '后台/被遮挡窗口被合成器节流 ⇒ fromSurface:false「立即成功」但回的是**纯白帧** ' +
    '（实测 evidence 190/203 张全白，09-24 超时时代的 5 张反而全有内容）；' +
    '只验「返回了数据」不验「图里有内容」⇒ 把「超时」修成了「白图」，录屏回溯全是白卡片且看不出原因');
  check('CDP 超时报错不猜测原因（不写「疑似反爬」）',
    !/疑似页面上下文被反爬销毁/.test(cdpLive),
    '实测超时与反爬无关（同页面 fromSurface:false 1.28s 成功）；猜的原因会把排查带向错误方向。' +
    '报错只应陈述等了多久、没等到什么');
}

// ── C10 段：控制台发出的浏览器动作名必须在驱动里真实存在（2026-09-26）─────────
// 背景：控制台有两处按钮发送 action:'focus'（平台卡片「打开窗口」、批量结果里的
// 「打开该平台调试窗口」），而 **CDP 驱动根本没有 focus 动作**（它叫 bringToFront）。
// 于是每次点击都落到 default 分支返回 {ok:false}，而前端 `.catch(()=>{})` 把错误吞掉。
// 窗口之所以还能开，纯粹是 execCdpAction 开头 `ensureHealthy()` 的副作用把它拉了起来
// ——「靠副作用蒙对」。实测证据：action:'focus' 与瞎写的 '__nope__' 返回**一字不差**的
// 错误（{"ok":false,"error":"CDP 驱动不支持的动作：focus"}）。
// 用户已决定「不默认开满 15 窗口，点击哪个平台开哪个平台」⇒ 这条按钮成了开平台的主入口，
// 不能再靠运气。此处机械校验「控制台写的每个动作名，驱动里都有对应 case」。
{
  const ROOT = fileURLToPath(new URL('..', import.meta.url));
  const consoleHtml = fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8');
  const cdpSrc = fs.readFileSync(path.join(ROOT, 'server', 'services', 'cdpDriver.ts'), 'utf8');
  const pwSrc = fs.readFileSync(path.join(ROOT, 'server', 'services', 'browser.ts'), 'utf8');

  // 只匹配「浏览器动作」的调用点形态：{platform: …, action: 'xxx'}
  // 先剔掉**整行注释**（缩进后的 //）：否则将来有人在注释里写
  // `// 原为 {platform:p, action:'focus'}` 会造成假失败。只剔整行，
  // 不剔行内 `//`——那会把 `http://` 之后的整行切掉。
  const liveSource = consoleHtml
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
  const emitted = new Set<string>();
  for (const m of liveSource.matchAll(/platform\s*:\s*[^,}]+,?\s*action\s*:\s*'([A-Za-z][A-Za-z0-9_-]*)'/g)) {
    emitted.add(m[1]);
  }
  check('解析到控制台发出的浏览器动作（护栏自身有效性）', emitted.size > 0,
    `解析到 ${emitted.size} 个；=0 说明写法变了、护栏会静默失效（匹配 {platform:…, action:'x'}）`);

  for (const a of [...emitted].sort()) {
    const inCdp = new RegExp(`case '${a}'\\s*:`).test(cdpSrc);
    check(`控制台动作 '${a}' 在 CDP 驱动里有实现`, inCdp,
      inCdp ? '' : 'CDP 驱动无此 case → 点击必落到 default 返回 {ok:false}（窗口可能仍因 ensureHealthy 副作用打开，但响应是错的）');
  }
}

// ── C9 段：全国城市表 + 控制台城市搜索口径 ──────────────────────────────
// 背景：控制台「目标城市」曾是一个 373 项的原生 <select> —— 打开时浏览器会滚到当前选中项，
// 于是只看得见末尾那一段，用户合理反馈「怎么只有广东和云南」。数据本来就是全国 373 城，
// 坏的是呈现方式。改成可搜索选择器后有两处新风险，这里各加一道机械护栏：
//   ① 城市表被改坏（漏省 / 重名 / 拼音丢字段）→ 搜索有城市永远搜不到
//   ② 服务端与服务端**各写一份**过滤规则 → 慢慢漂移（改了 server 忘了 client）
{
  const provinces = new Set(CN_CITIES.map((r) => r[1]));
  check('城市表覆盖全国（≥370 城）', CN_CITIES.length >= 370, `实际 ${CN_CITIES.length}`);
  check('覆盖 34 个省级行政区', provinces.size === 34, `实际 ${provinces.size}：${[...provinces].sort().join('/')}`);
  const names = CN_CITIES.map((r) => r[0]);
  check('城市名无重复', new Set(names).size === names.length,
    `重复：${names.filter((n, i) => names.indexOf(n) !== i).join('/') || '无'}`);
  const badPinyin = CN_CITIES.filter((r) => !/^[a-z]+$/.test(String(r[3] || '')));
  check('每城都有可用拼音（小写 a-z）', badPinyin.length === 0,
    badPinyin.slice(0, 5).map((r) => r[0] + '=' + r[3]).join(','));
  const badAbbr = CN_CITIES.filter((r) => !/^[a-z]+$/.test(String(r[4] || '')));
  check('每城都有拼音首字母（搜索用）', badAbbr.length === 0,
    badAbbr.slice(0, 5).map((r) => r[0] + '=' + r[4]).join(','));
  check('DEFAULT_CITY 在城市表内', names.includes(DEFAULT_CITY), DEFAULT_CITY);
  check('listCities() 无参返回全量', listCities().length === cityCount(), `${listCities().length}/${cityCount()}`);

  // 五条搜索路径各来一条，否则「全国城市」名义上有了、实际还是搜不到
  const hit = (q: string) => listCities(q).map((c) => c.name);
  check('按城市名搜：昆明', hit('昆明').includes('昆明'));
  check('按省份搜：云南 → 只出云南城市', hit('云南').length >= 15 && hit('云南').every((n) => names.includes(n) && findCity(n)?.province === '云南'),
    `命中 ${hit('云南').length} 个`);
  check('按省份搜不会退化成全量', hit('云南').length < cityCount());
  check('按全拼搜：kunming → 昆明', hit('kunming').includes('昆明'));
  check('按首字母搜：km → 昆明', hit('km').includes('昆明'));
  check('按首字母搜：bj → 北京', hit('bj').includes('北京'));
  check('按 BOSS 城市码搜：101290100 → 昆明', hit('101290100').includes('昆明'));
  check('多音字/ü 已正确处理', hit('lvliang').includes('吕梁') && hit('danzhou').includes('儋州') && hit('xianggang').includes('香港'),
    '吕梁→lvliang、儋州→danzhou、香港→xianggang');

  // 服务端口径 vs 控制台本地副本 —— 逐城市、逐关键词比对，防两边漂移
  const ROOT9 = fileURLToPath(new URL('..', import.meta.url));
  const html = fs.readFileSync(path.join(ROOT9, 'public', 'console.html'), 'utf-8');
  const fnSrc = (html.match(/function cityMatch\(c, k\)\{[\s\S]*?\n\}/) || [])[0];
  check('控制台存在本地过滤副本 cityMatch()', !!fnSrc, '未找到时下面的口径比对无法进行');
  if (fnSrc) {
    const clientMatch = new Function('return (' + fnSrc + ')')() as (c: any, k: string) => boolean;
    const kws = ['', '昆明', '云南', 'kunming', 'km', 'bj', 'sh', '101290100', 'lvliang', 'danzhou', 'hai', 'z'];
    const rows = allCities();
    const drift: string[] = [];
    for (const k of kws) {
      for (const c of rows) {
        const a = cityMatches(c, k);
        const b = clientMatch(c, k);
        if (a !== b && drift.length < 5) drift.push(`${c.name}/${k}: server=${a} client=${b}`);
      }
    }
    check('服务端 cityMatches 与控制台 cityMatch 口径一致', drift.length === 0, drift.join(' | '));
  }

  // 选择器的接线不变量：取值只认 #batchCity（batch 提交读的就是它），且不再有原生下拉
  check('控制台 #batchCity 仍是 hidden input（batch 提交读它）',
    /<input[^>]*type="hidden"[^>]*id="batchCity"/.test(html) || /<input[^>]*id="batchCity"[^>]*type="hidden"/.test(html));
  check('控制台已无原生 <select id="batchCity">（否则又退回「滚动找城市」）', !/<select[^>]*id="batchCity"/.test(html));
  check('控制台初始化已切到 initCityPicker()', /initCityPicker\(\)/.test(html) && !/fillCitySelect\(\)/.test(html));
  // 搜索框必须是「纯搜索框」：选中值另有常显位置（#batchCityNow）。
  // 曾经让输入框兼顾「显示选中值」，并用「文字===选中值 ⇒ 当作空关键词」的隐式判断兜，
  // 结果用户搜自己已选的城市时列表毫无反应（截图实证）—— 隐藏模式，必须有机械护栏挡住回退。
  check('控制台有选中值常显位 #batchCityNow（输入框是纯搜索框）', /id="batchCityNow"/.test(html),
    '缺它则只能把选中值回显进搜索框，必然再造出「输入文字却不搜索」的隐藏模式');
  check('搜索框不再预填/回显选中值（cityQuery 无回显分支）',
    /function cityQuery\(\)/.test(html) && !/v === CITY_SEL\s*\)\s*return ''/.test(html),
    'cityQuery 里若出现「等于 CITY_SEL 就按空处理」，就是那个隐藏模式回来了');
}

// ── PII 守卫：范围必须覆盖「git 跟踪但**不进包**」的文件（2026-09-27）──────────
// 起因：pack.ps1 里那份 PII 守卫只扫「会进分发包的文件」（$scanSet 来自 tar 成员表），
// 于是 git 跟踪但不进包的 docs/ 成了**永久盲区**。实测后果：c09b6e5 号称清理 PII，
// 实际只把 docs/REFERENCE_gagajob.md 改名为 REFERENCE_competitor.md，第 30 行转录的
// 「学校 + 出生年月 + 籍贯到区」原样留着并继续公开可见——而那次打包检查是**全绿**的。
// 这里把四件事变成机械断言：①匹配器真的会命中（正/反/二进制各一次）；②输出不泄露明文；
// ③pre-push 必须真的调用它，且走 stdin 喂列表；④它不能被排除出发货集。
{
  const ROOT = fileURLToPath(new URL('..', import.meta.url));

  // ① 匹配器。用中日韩字符，顺带证明是按 UTF-8 字节比对的（而非字符串包含）。
  const token = '张某某';
  const hit = findDenyHits([token], [{ rel: 'a.ts', buf: Buffer.from(`前缀${token}后缀`, 'utf8') }]);
  const miss = findDenyHits([token], [{ rel: 'b.ts', buf: Buffer.from('完全无关的内容', 'utf8') }]);
  check('PII 守卫命中含 deny 项的文件', hit.length === 1 && hit[0].rel === 'a.ts');
  check('PII 守卫不误报无关文件', miss.length === 0);
  // 二进制里烘进的字符串同样是泄露（exe / zip 都算），必须能命中
  const bin = findDenyHits([token], [{
    rel: 'x.exe',
    buf: Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(token, 'utf8'), Buffer.from([0])]),
  }]);
  check('PII 守卫在二进制内容里同样能命中', bin.length === 1);

  // ② 输出掩码：CI 日志本身不能变成新的泄露面
  const masked = maskToken(token);
  check('PII 守卫的命中输出不含明文', !masked.includes(token) && masked.includes(`len=${token.length}`));

  // ③ 词表 / 文件列表解析
  check('PII 词表解析跳过空行与 # 注释', parseDenyList('# 说明\n\n  张某某  \n').join('|') === '张某某');
  // 只剥 \r，**不 trim** —— 路径两端的空格是合法的，裁掉会指向另一个文件
  check('PII 文件列表解析保留路径两端空格',
    parseFileList('a b.ts\r\nc.ts\n\n').join('|') === 'a b.ts|c.ts');

  // ④ 接线：pre-push 必须真的调它（否则守卫只是个没人跑的文件）
  const hook = path.join(ROOT, '.githooks', 'pre-push');
  if (fs.existsSync(hook)) {
    const src = fs.readFileSync(hook, 'utf8');
    check('pre-push 钩子调用了 PII 守卫', src.includes('scripts/pii_guard.ts'),
      '钩子是发布前唯一的闸门；守卫不接进去等于没有');
    // 必须走管道喂文件列表：实测本环境下 node 内 spawn 任何子进程都 EBUSY
    // （同一个坑见 scripts/check_console_syntax.ts 顶部），所以枚举权交给 shell。
    check('pre-push 通过 stdin 喂文件列表给 PII 守卫',
      /ls-files\s*\|\s*"\$NODE"/.test(src) && src.includes('--stdin'),
      'node 内 spawn 会 EBUSY ⇒ 必须由 shell 管道喂 git ls-files');
  }

  // ⑤ 守卫不能被排除出发货集：随包的 contract_tests.ts 会 import 它
  //    （分发包里 pack.ps1 不存在，所以这条只在源码树里判）
  const packPath = path.join(ROOT, 'pack.ps1');
  if (fs.existsSync(packPath)) {
    const dropBlock = (fs.readFileSync(packPath, 'utf8').match(/\$scriptDrop = @\(([\s\S]*?)\n\)/) || ['', ''])[1];
    check('pii_guard.ts 未被列入 $scriptDrop（contract_tests 会 import 它）',
      dropBlock.length > 0 && !dropBlock.includes('pii_guard.ts'),
      '一进 $scriptDrop，包内 npm test 就会在 import 处崩');
  }
}

// ── 原生外壳 provenance：sourceHash 必须与「检出环境」无关（2026-09-27）──────────
// 起因：pack.ps1 的守卫对 src-tauri/ 的**磁盘字节**求哈希，而 git 在 Windows runner 上
// 以 core.autocrlf=true 检出 —— 8 个文本文件被写成 CRLF、二进制(.ico) 保持原样。于是
// 「同一份提交」在 CI 上算出与本地不同的哈希，守卫拒绝打包一棵完全正确的树：
//   run 36331333538  stamped f057d715… / current 4747e9e2…（而本地同提交全绿）
// 离线复现确认：把 CRLF 变体哈希出来正好得到 4747e9e2，且 CI 报 modified 的文件恰好是那 8 个
// 文本文件（icon.ico 不在其中）。修法两条：①哈希前把 CRLF 归一化为 LF；②改用 ordinal
// 排序（Sort-Object 是文化敏感的，同一份文件集在 zh-CN / en-US 下可能排出不同顺序）。
//
// 这里做三件事：
//   ① 章里必须**写明**规则（换行 + 排序），否则换语言复算无从下手；
//   ② 用 TS **独立实现**该规则从当前 src-tauri/ 复算，逐文件 + 聚合两级断言 —— 两个 .ps1
//      里的实现只要与文档漂移，这条就红；
//   ③ 模拟一次「CRLF 检出」（git 只转文本、不动二进制）再复算，断言哈希不变 —— 这是那条
//      CI 失败的直接回归测试。
{
  const ROOT = fileURLToPath(new URL('..', import.meta.url));
  const infoPath = path.join(ROOT, 'dist-app', 'BUILD_INFO.json');
  if (fs.existsSync(infoPath)) {
    const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    const rule = String(info.hashRule || '');
    check('BUILD_INFO.hashRule 写明 CRLF 归一化', /CRLF normalized to LF/.test(rule),
      '不写明就等于规则只活在代码里，换实现复算必然各说各话');
    check('BUILD_INFO.hashRule 写明 ORDINAL 排序', /ORDINAL/.test(rule),
      '文化敏感排序会让同一份提交在不同 locale 上盖章不一致');

    const srcRoot = path.join(ROOT, 'src-tauri');
    const exclude: string[] = info.excludeDirNames || [];
    const rels: string[] = [];
    (function walk(dir: string) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (!exclude.includes(e.name)) walk(full); continue; }
        rels.push(path.relative(ROOT, full).split(path.sep).join('/'));
      }
    })(srcRoot);
    // 默认 sort 即 UTF-16 码元序（ASCII 下等价 ordinal）——与 PS 的 StringComparer.Ordinal 对齐
    rels.sort();

    const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
    // 28591/latin1 往返是**逐字节**忠实的；用 utf8 解码会把二进制里的非法序列变成 U+FFFD 再
    // 哈希回去，等于算了个错的值
    const normalize = (b: Buffer) => Buffer.from(b.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
    // git 的文本判定用 NUL 字节：没有 NUL 才做 autocrlf 转换。用同一判据模拟检出。
    const toCrlf = (b: Buffer) => Buffer.from(b.toString('latin1').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'), 'latin1');

    const aggregate = (bytesOf: (rel: string) => Buffer) => {
      let text = '';
      for (const rel of rels) text += rel + '\n' + sha(normalize(bytesOf(rel))) + '\n';
      return sha(Buffer.from(text, 'utf8'));
    };
    const raw = new Map(rels.map((r) => [r, fs.readFileSync(path.join(ROOT, r))]));

    check('参与哈希的文件数与章一致', rels.length === info.sourceCount,
      `disk=${rels.length} stamp=${info.sourceCount}`);

    const stampMap = new Map<string, string>((info.sourceFiles || []).map((e: any) => [String(e.path), String(e.sha256).toLowerCase()]));
    const mismatched = rels.filter((r) => stampMap.get(r) !== sha(normalize(raw.get(r)!)));
    // 逐文件比对比只比聚合更强：聚合是同一组文件的哈希，逐文件还能指出是哪一个漂了
    check('逐文件 sha256（CRLF 归一化后）与章一致', mismatched.length === 0,
      mismatched.length ? mismatched.join(', ') : `${rels.length} 个文件全部一致`);

    check('聚合 sourceHash 可用文档规则复现', aggregate((r) => raw.get(r)!) === String(info.sourceHash).toLowerCase(),
      'TS 独立实现与 PS 侧盖章结果一致；若不等，说明两边对同一份规则的理解已经分叉');

    // ③ 回归测试：模拟 CRLF 检出（文本转、二进制不转）后哈希必须不变
    const crlfBytes = (r: string) => (raw.get(r)!.includes(0) ? raw.get(r)! : toCrlf(raw.get(r)!));
    const crlfChanged = rels.filter((r) => crlfBytes(r) !== raw.get(r));
    check('CRLF 检出后哈希不变（CI 误杀的直接回归）', aggregate(crlfBytes) === String(info.sourceHash).toLowerCase(),
      `模拟转换了 ${crlfChanged.length} 个文件（应等于文本文件数，二进制不动）`);
    check('模拟检出不误转二进制文件', !crlfChanged.includes('src-tauri/icons/icon.ico'),
      'git 不做二进制转换；若这里也转，模拟本身就不忠实');

    // ④ 接线：规则在两份 .ps1 里各有一份实现（无法从章里执行），必须逐字一致 —— 否则
    //    「哪一份对」就成了未定义行为，且失败信息还会互相矛盾
    const appPs = path.join(ROOT, 'build_app.ps1');
    const packPs = path.join(ROOT, 'pack.ps1');
    if (fs.existsSync(appPs) && fs.existsSync(packPs)) {
      const a = fs.readFileSync(appPs, 'utf8');
      const b = fs.readFileSync(packPs, 'utf8');
      const grab = (src: string, name: string) =>
        ((src.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n\\}')) || [''])[0])
          .split('\n')
          .map((l) => l.trim())
          // 只比**代码**：整行注释与空行不计（两侧各写各的说明文字是允许的，
          // 但可执行部分只要有一处不同，「以哪份为准」就没有答案了）
          .filter((l) => l && !l.startsWith('#'))
          .join('\n');
      for (const fn of ['Get-FileSha256Norm', 'Sort-EntriesByPathOrdinal']) {
        const fa = grab(a, fn), fb = grab(b, fn);
        check(`两份 .ps1 的 ${fn} 实现（代码部分）逐字一致`, fa.length > 0 && fa === fb,
          '算法有两份拷贝，「以哪份为准」不该是个问题 —— 不一致即视为回归');
      }
      check('build_app.ps1 用归一化哈希给源文件盖章', /sha256 = \(Get-FileSha256Norm/.test(a));
      check('pack.ps1 用归一化哈希复算源文件', /sha256 = \(Get-FileSha256Norm/.test(b));
      check('pack.ps1 已不再用文化敏感的 Sort-Object 排源文件', !/\$curSrc \| Sort-Object path/.test(b),
        'Sort-Object 依 locale 排序 ⇒ 同一提交在 zh-CN / en-US 上盖章不同');
      check('pack.ps1 漂移信息带字节级提示', /Get-DriftHint/.test(b),
        'CI 日志只说「哪些文件不同」，诊断出换行符问题花了一小时 —— 提示要能直接指向原因');
    }
  }
}

// ═══════════════════════════════════════════════════════════
console.log('\n══════ H. 首跑安装链路（解压后弹出安装按钮） ══════');
// 背景（2026-09-28）：用户问「解压后自动弹安装按钮、点一下就能用」到底能不能做到。核查时
// 发现两处**四道门禁全绿也拦不住**的缺陷，都属于"打包/落位"类不变量 —— 只有跑 200 秒的
// pack.ps1 才会暴露。所以在这里用纯文本 + 文件系统断言复刻同一套判据，让 npm test 秒级拦住；
// pack.ps1 里保留同一套守卫（发布时兜底），两侧互相独立，避免"改一处同时移动指针和靶子"。
//   ① install_first_run.bat 是这条链路的**唯一实现**，却没被 $must 钉住，只靠
//      「根目录 .bat 全收 − $dropScripts」侥幸进包 ⇒ 被拉黑/改名后包仍过全部门禁，
//      而收件人的安装按钮不会出现。
//   ② create_desktop_shortcut.bat 判的是根目录 `%PKG%offer-where.exe`，而外壳在包里位于
//      `dist-app\offer-where.exe` ⇒ 条件**恒假**，桌面入口永远退回 start_all.bat：
//      用户点完「安装」拿到的仍是黑框 + Chrome --app，原生外壳一次都没被用上。
{
  const pack = readText('pack.ps1');

  // ── ① $must 必须钉住首跑安装脚本 ──────────────────────────────────
  const mustStart = pack.indexOf('$must = @(');
  const mustBlock = pack.slice(mustStart, pack.indexOf('\n)', mustStart));
  check('pack.ps1 的 $must 钉住 install_first_run.bat', mustBlock.includes('"install_first_run.bat"'),
    '$must 只钉文件存在性；漏钉它 ⇒ 拉黑/改名后四道门禁全绿，收件人却没有安装按钮');
  check('pack.ps1 的 $must 钉住 create_desktop_shortcut.bat',
    mustBlock.includes('"create_desktop_shortcut.bat"'));

  // ── ①b $must 必须钉住「给朋友的说明书」（2026-09-30）────────────────
  // 分发模型是「朋友各装一份、各用各的数据」，所以朋友装机后**没有**任何外部文档可看：
  // Release 说明只在下载时看一次，而 public/guide/ 那一页才是他后面回头查
  // 「哪个勾选框才是真正的仅预览」「怎么彻底删掉」的地方。
  // 它进包目前只是「public 被整目录收进 $dirs」的副产品 ⇒ 哪天 public 改成按文件枚举
  // （server/ 与 shared/ 就是这么做的），说明书会从产物里静默消失，而四道门禁全绿：
  // 包里少一个 .html，构造上没有任何断言会变红。
  check('pack.ps1 的 $must 钉住使用说明页 public/guide/index.html',
    mustBlock.includes('"public/guide/index.html"'),
    '漏钉 ⇒ 说明页可以从产物里消失，而 npm test / verify / pack 一个都不会红');
  // $must 断言的是**归档列表**，所以还得独立确认 public 真的进了成员表 —— 否则这条
  // 要到 5 分钟后的打包最后一步才报错，而不是在这里秒级拦住。
  // ⚠️ 不许写成 dirsBlock.includes('public')：那会被 `public/guide/...` 这类**任意**
  //    含 public 的文本满足（本仓库「静态断言被文本满足」的经典坑），
  //    `$splitDirs = @("server","shared")` 里也没有，但注释里随便提一句就有了。
  const dirsStart = pack.indexOf('$dirs  = @(');
  const dirsBlock = pack.slice(dirsStart, pack.indexOf(')', dirsStart));
  const dirsList = [...dirsBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  check('pack.ps1 的 $dirs 整目录包含 public（说明页才有机会进包）',
    dirsList.includes('public'), `实际：${dirsList.join(', ')}`);
  // 源码树里真得有这一页。少了它，上面两条会变成「钉住一个不存在的东西」。
  check('待打包的说明页确实存在于源码树',
    fs.existsSync(path.join(ROOT, 'public', 'guide', 'index.html')));

  // ── ② 桌面入口必须指向包里真实存在的落位（dist-app/）─────────────
  // ⚠️ 只判**代码行**：这个文件的 REM 注释里为了说明缺陷，本身就写着那个错误路径
  // （`%PKG%offer-where.exe`）—— 拿整份文本判会把我自己的说明文字当成违规。
  const shortcut = readText('create_desktop_shortcut.bat');
  const shortcutCode = shortcut.split(/\r?\n/)
    .filter((l) => !/^\s*(REM|::)/i.test(l)).join('\n');
  check('桌面入口优先指向 dist-app 下的原生外壳', shortcutCode.includes('dist-app\\offer-where.exe'),
    '判根目录 offer-where.exe 时条件恒假 ⇒ 静默退回 start_all.bat（黑框 + Chrome --app）');
  check('桌面入口的代码行不再判断不存在的根目录外壳', !shortcutCode.includes('%PKG%offer-where.exe'),
    '该路径在开发树与分发包里都不存在（pack.ps1 只发 dist-app 下那三个文件）');
  check('dist-app 下的外壳确实在仓库里（否则入口又指向空气）',
    fs.existsSync(path.join(ROOT, 'dist-app', 'offer-where.exe')));

  // ── ③ 根启动器交叉引用：%~dp0 / %PKG% / %ROOT%，含 base64 载荷 ────
  // 三种"包根"写法都要扫：%ROOT% 是 setenv.bat 里 `set "ROOT=%~dp0"` 定义的，被
  // start_server.bat 用来定位 node_modules\tsx\dist\cli.mjs —— 只扫前两种会漏掉它。
  const dropStart = pack.indexOf('$dropScripts = @(');
  const dropBlock = pack.slice(dropStart, pack.indexOf('\n)', dropStart));
  const droppedNames = new Set([...dropBlock.matchAll(/'([A-Za-z0-9_.\-]+\.(?:bat|sh|ps1))'/g)].map((m) => m[1]));
  const rootLaunchers = fs.readdirSync(ROOT)
    .filter((n) => /\.(bat|sh|ps1)$/.test(n) && !droppedNames.has(n))
    // 非 ASCII 名的根脚本不进包（无论它是否在 drop 列表里）：归档必须 0 个非 ASCII 条目名，
    // 这是既有不变量。曾经的 legacy 打包器 `打包.bat` 就是这类 —— 它的名字在 pack.ps1 里是
    // 用码点拼出来的（`[char]0x6253 + [char]0x5305`），所以上面的字面量解析找不到它。
    .filter((n) => !/[^\x00-\x7F]/.test(n));
  check('根启动器清单可解析（防止 drop 列表规则改动后这条静默空转）', rootLaunchers.length >= 5,
    `${rootLaunchers.length} 个：${rootLaunchers.join(', ')}`);

  const FILE_EXT = /\.(bat|cmd|exe|ps1|sh|mjs|cjs|ts|js|json|dll|ico)$/;
  const rootRefRe = /(?:%~dp0|%PKG%|%ROOT%)([^\s"'&|<>]+)/g;
  const quotedRefRe = /["']([A-Za-z0-9_.\-\\/]+\.(?:bat|cmd|exe|ps1|sh|mjs|cjs|ts|js|json|dll|ico))["']/g;
  const decodePayloads = (text: string) => {
    const out: string[] = [];
    for (const m of text.matchAll(/-EncodedCommand\s+([A-Za-z0-9+/=]{40,})/g)) {
      try { out.push(Buffer.from(m[1], 'base64').toString('utf16le')); } catch { /* 该载荷跳过 */ }
    }
    return out;
  };
  const dangling: string[] = [];
  const pinnedByPack: string[] = [];
  let payloadsSeen = 0;
  // 与 pack.ps1 的守卫用**同一套**规则：注释行先剥离。注释永不执行，不该被当成引用 ——
  // 一份「记录历史缺陷」的注释会让两侧给出不同结论。实测差距：pack.ps1 的守卫曾因此报
  // offer-where.exe 而这里侥幸通过（那个路径后面跟着一个反引号，正则截断后不匹配文件后缀）。
  // 同一规则两种行为，迟早有一个在骗人。
  const stripComments = (t: string, ext: string) => {
    if (!/^(bat|cmd|ps1|sh)$/.test(ext)) return t;
    const pat = /^(bat|cmd)$/.test(ext) ? /^\s*(?:@?rem\b|::)/i : /^\s*#/;
    return t.split(/\r?\n/).filter((l) => !pat.test(l)).join('\n');
  };
  for (const ln of rootLaunchers) {
    const ext = ln.split('.').pop()!.toLowerCase();
    const text = stripComments(readText(ln), ext);
    const payloads = decodePayloads(readText(ln)).map((p) => stripComments(p, 'ps1'));
    payloadsSeen += payloads.length;
    for (const body of [text, ...payloads]) {
      for (const m of body.matchAll(rootRefRe)) {
        const norm = m[1].replace(/\\/g, '/').replace(/\/+$/, '');
        if (!FILE_EXT.test(norm)) continue;                     // 目录引用（%~dp0data）跳过
        if (fs.existsSync(path.join(ROOT, norm))) continue;
        // ⚠️「源码树里没有」≠「包里没有」。node/ 被 gitignore —— CI 上是到打包前那一步
        // 「准备自带 Node 运行时」才用 runner 的 node 顶上，而那一步在 `npm test` **之后**；
        // node_modules/ 由 npm ci 生成。第一版在这里只判存在性 ⇒ CI 报
        // `setenv.bat -> node/node.exe` 而本机全绿（同一个判据在两种环境给出相反结论）。
        // 真正要问的是「打包会不会带上它」，而这个问题由 pack.ps1 的 $must 回答 —— 用它，
        // 本机与 CI 才会得到同一个结论。
        if (mustBlock.includes(`"${norm}"`)) { pinnedByPack.push(norm); continue; }
        dangling.push(`${ln} -> ${norm}`);
      }
      // 引号里的裸文件名只在**解码后的载荷**里生效（纯文本里 echo 的说明文字会误报）
      if (body !== text) {
        for (const m of body.matchAll(quotedRefRe)) {
          if (!fs.existsSync(path.join(ROOT, m[1].replace(/\\/g, '/')))) dangling.push(`${ln} -> ${m[1]} (payload)`);
        }
      }
    }
  }
  check('根启动器引用的文件全部实际存在（含 base64 载荷内）', dangling.length === 0,
    dangling.length ? dangling.join(', ') : `${rootLaunchers.length} 个启动器、${payloadsSeen} 个编码载荷，0 处悬空`
      + (pinnedByPack.length
        ? `（其中 ${new Set(pinnedByPack).size} 处靠 $must 兜底：${[...new Set(pinnedByPack)].join(', ')} —— 它们不在源码树里但一定在包里）`
        : '（源码树齐全，0 处需要 $must 兜底）'));
  // 靠 $must 兜底只应该是「生成目录」那一类。若某个**随源码树分发**的文件也走到这条路，
  // 说明本机源码树缺文件而打包靠 pin 掩盖了它 —— 那才是该报的错。
  check('靠 $must 兜底的引用只出现在生成目录（node/ node_modules/）内',
    pinnedByPack.every((p) => /^(node|node_modules)\//.test(p)),
    pinnedByPack.length ? `${new Set(pinnedByPack).size} 处：${[...new Set(pinnedByPack)].join(', ')}` : '0 处');
  check('install_first_run.bat 的 -EncodedCommand 载荷可解码（守卫不能只是"看起来在扫"）',
    decodePayloads(readText('install_first_run.bat')).length === 1);

  // ── ④ 首跑标记「data\.installed」三处写法必须一致 ───────────────
  // 三处是**同一规则的三个独立实现**（bat / 编码载荷 / Rust），任一漂移都会造成
  // "已经装过了还反复弹"或"永远不弹"。
  // 用 includes 而不是正则：字面量里含反斜杠（`data\.installed`），走正则容易被转义层级坑到
  // —— 第一版就是这么写成"匹配 data.installed"而误报失败的。
  const MARKER = 'data\\.installed';   // 这串字符本身就是 data\.installed
  check('start_all.bat 用 data\\.installed 做首跑判定', readText('start_all.bat').includes(MARKER));
  check('install_first_run.bat（解码后）写的是同一个标记',
    decodePayloads(readText('install_first_run.bat')).join('\n').includes(MARKER));
  const libRs = fs.existsSync(path.join(ROOT, 'src-tauri', 'src', 'lib.rs'))
    ? readText('src-tauri/src/lib.rs') : '';
  check('lib.rs 判的是同一个标记（.installed）', libRs.includes('.installed'),
    '外壳与 bat 必须判同一处，否则双击 exe 与双击 bat 的行为会分叉');

  // ── ⑤ 自解压安装包（OfferWhere-Setup.exe）的布局契约 ────────────────
  // 布局：`[stub PE][payload zip][footer: magic(8) + u64 offset + u64 length]`。
  // footer 的 magic 与尺寸只在 **C 源码**里定义一次，make_sfx.ps1 构建时**读它**再写 ——
  // 这样两边不可能漂移。若哪天有人在 make_sfx.ps1 里重新写死一份，产物就会变成
  // 「看着正常、双击只报『尾部标记缺失』」的 exe，且只有真跑一次才会暴露 ⇒ 这里钉住：
  // ① C 源的取值自洽；② 构建脚本确实是从 C 源读的，不是自带副本。
  const sfxC = readText('tools/sfx/offerwhere_sfx.c');
  const magicM = /FOOTER_MAGIC\[8\]\s*=\s*\{([^}]*)\}/.exec(sfxC);
  const magicChars = magicM ? [...magicM[1].matchAll(/'([^']*)'/g)].map((m) => m[1]).join('') : '';
  const footerSize = Number((/#define\s+FOOTER_SIZE\s+(\d+)/.exec(sfxC) || [])[1] || 0);
  check('stub 源码里的 FOOTER_MAGIC 可解析且为 8 字节', magicChars.length === 8,
    `解析到 magic="${magicChars}"（8 是 C 侧 memcmp 的硬编码长度，必须一致）`);
  check('stub 的 FOOTER_SIZE = magic + 两个 uint64(16)', footerSize === magicChars.length + 16,
    `FOOTER_SIZE=${footerSize}，magic=${magicChars.length}，期望 ${magicChars.length + 16}`);
  const mkSfx = readText('make_sfx.ps1');
  check('make_sfx.ps1 从 stub 源码读取 footer 契约（不自带第二份副本）',
    mkSfx.includes('FOOTER_MAGIC') && mkSfx.includes('FOOTER_SIZE'),
    '自带副本时，改一边就能产出打不开的自解压包，且四道门禁全绿');
  check('stub 源码保持纯 ASCII（中文 UI 必须是 \\uXXXX 转义）',
    !/[^\x00-\x7F]/.test(sfxC),
    '非 ASCII 字节会让编译结果依赖编译机的输入字符集，换个工具链就变乱码');
  check('.gitignore 忽略 tools/sfx/build/（编译产物入库会白占远端体积）',
    readText('.gitignore').includes('tools/sfx/build/'));
  // 无人值守开关：这是能对自解压包做端到端验证的前提（否则 MessageBox 会挡住自动化）。
  check('stub 支持 --extract-only 无人值守分支', sfxC.includes('--extract-only'),
    '没有它就只能靠人手点对话框来验收，等于没验收');

  // ── ⑤b 安装位置必须由**用户**决定（2026-09-28） ──────────────────────
  // 之前只有一句「安装位置：%LOCALAPPDATA%\OfferWhere」加 OK/Cancel —— 等于替用户
  // 拍板装到哪，与其他软件的安装流程不一样。改成真对话框（路径输入框 + 浏览按钮）。
  //
  // ⚠️ 先剥 C 注释再匹配。这一段新代码的注释里**恰好**写着 IFileDialog /
  // SHBrowseForFolderW / cmd_path 这些名字（说明它为什么这么做），
  // 不剥注释的话断言会被自己的说明文字满足 —— 与 §⑥ 那条同一个坑。
  const stripC = (s: string) => stripComments(s);
  const sfxCode = stripC(sfxC);
  check('stub 用真对话框问安装位置（路径可改），不是只能点确定的 MessageBox',
    sfxCode.includes('DialogBoxIndirectParamW') && sfxCode.includes('ask_install_dir'),
    '只弹一句「将安装到 X」的 MessageBox，用户无从更改');
  check('对话框里有「浏览」按钮', /#define\s+IDC_BROWSE\s+1002/.test(sfxCode),
    '没有浏览按钮就只能手打路径');
  check('「浏览」走系统标准文件夹选择器（IFileDialog）',
    sfxCode.includes('CLSCTX_INPROC_SERVER') && sfxCode.includes('FOS_PICKFOLDERS'),
    '自己糊一个目录列表既不标准也不可靠');
  // ⚠️ 这条的**第一版没牙**：只断言源码里出现过 SHBrowseForFolderW。
  // 阳性对照（删掉「IFileDialog 失败后改走老选择器」那一行）当场证明它照样全绿 ——
  // 因为函数体里那个 SHBrowseForFolderW(&bi) 还在，符号在 ≠ 这条退路还通。
  // ⇒ 必须断言**可达性**：IFileDialog 没给出路径时，确实还会去调老选择器。
  check('标准选择器没给出路径时，确实回退到 SHBrowseForFolderW（浏览不是死按钮）',
    sfxCode.includes('SHBrowseForFolderW(&bi)') &&
      /if \(!ok\) ok = pick_folder_legacy\(owner, out, cap\);/.test(sfxCode),
    'COM 初始化失败时按钮会毫无反应');
  // cdit 必须等于实际 item 数：多一个少一个，Windows 要么丢控件要么越界读，
  // 而且**两种都只在真弹窗时才暴露**，编译期完全看不出来。
  // （这一条故意用**未剥注释**的源码：定位 cdit 就靠它行尾那行注释。）
  const cditM = /tmpl_word\(p,\s*(\d+)\);\s*\/\* cdit/.exec(sfxC);
  const itemCount = (sfxCode.match(/tmpl_item\(p,\s*base,/g) || []).length;
  check('对话框模板的 cdit 等于实际 item 数',
    !!cditM && Number(cditM[1]) === itemCount,
    `cdit=${cditM ? cditM[1] : '未解析到'}，实际 item=${itemCount}`);
  check('无人值守分支不弹对话框（否则自测会挂住）',
    /if\s*\(SILENT\)\s*\{[\s\S]{0,900}?\}\s*else\s+if\s*\(!ask_install_dir\(/.test(sfxCode),
    '自测靠 --extract-only 跑通；静默模式下弹窗会让它永远等下去');
  // 这条防的是一次真实踩坑：用户把安装目录选成盘根（D:\）时，`-C "D:\"` 里的
  // 尾反斜杠会**转义掉闭合引号**，tar 收到的是垃圾参数 ⇒ 解压失败且理由莫名其妙。
  check('送进命令行的目标路径经过 cmd_path() 规范化（尾反斜杠会毁掉 -C "<dir>"）',
    sfxCode.includes('static void cmd_path(') &&
      /-C \\"%ls\\"", sysRoot, tmpZip, cmdRoot\)/.test(sfxCode),
    'tail backslash escapes the closing quote of the CreateProcess argument');
  check('release.yml 的 gcc 链接了 ole32（文件夹选择器要 COM）',
    /gcc\.Source[^\n]*-lshell32 -lole32/.test(readText('.github/workflows/release.yml')),
    '少了 -lole32 ⇒ undefined reference to CoInitializeEx，且只在发布时才炸');
  check('DEVELOPMENT.md 的本地编译配方同样带 -lole32',
    readText('DEVELOPMENT.md').includes('-lshell32 -lole32'));

  // ── ⑤b NSIS 安装器（2026-09-28 起取代自解压包成为唯一主推下载）──────────
  // 不变量分三类，每一类都对应一个「换掉就会安静地坏」的东西：
  //   架构   内嵌那一个已压好的 payload.zip（SetCompress off）+ 系统 tar 解压。
  //          实测：内嵌 362MB 只要 3 秒（再压一遍要几分钟、收益约 0）；成本 +117KB。
  //          Tauri 自带的 NSIS 打包器走不通 —— 它是逐文件生成 File 指令，12.45 万文件。
  //   体验   安装位置必须由用户决定（MUI_PAGE_DIRECTORY）、按用户安装不弹 UAC、
  //          有开始菜单/桌面入口与控制面板卸载项。这条是用户 2026-09-28 的明确要求。
  //   陷阱   ① NSIS 的 File 只认反斜杠：正斜杠绝对路径会被当成一个文件名，报
  //          "no files found"（两种斜杠都实测过）。
  //          ② makensis 只打印版本然后退出（那是 /VERSION），构建时不能带 flag。
  //          ③ SetAutoClose 只能写在 Section/Function 内，写顶层直接编译失败。
  //          ④ MessageBox 的返回分支必须与文本同一行，否则 `Invalid command: "IDNO"`。
  const readAscii = (rel: string) => fs.readFileSync(path.join(ROOT, rel));
  const stripSemi = (s: string) => s.split(/\r?\n/).filter((l) => !/^\s*;/.test(l)).join('\n');

  const nsiRaw = readText('installer/offerwhere.nsi');
  const nsi = stripSemi(nsiRaw);
  check('installer/offerwhere.nsi 存在', nsiRaw.length > 1000, '主推下载的构建脚本没有入库？');
  // 中文界面走 NSIS 自带的 SimpChinese 语言文件，而不是把中文写进脚本 —— 一旦脚本里有
  // 非 ASCII 字节，构建就开始取决于编译机的代码页（.ps1 取证脚本正是这样翻过车）。
  const nsiBytes = readAscii('installer/offerwhere.nsi');
  let nsiNonAscii = 0;
  for (const b of nsiBytes) if (b > 127) nsiNonAscii++;
  check('installer/offerwhere.nsi 是纯 ASCII（中文只在语言文件里）', nsiNonAscii === 0,
    `${nsiNonAscii} 个非 ASCII 字节 ⇒ 构建结果取决于编译机代码页`);
  check('安装器用 SimpChinese 语言文件提供中文界面',
    nsi.includes('MUI_LANGUAGE "SimpChinese"'), '不引入语言文件，界面会退回英文');

  const compressAt = nsi.indexOf('SetCompress off');
  const fileAt = nsi.indexOf('File /oname=$PLUGINSDIR\\payload.zip');
  check('payload 以「不压缩」方式内嵌（它本来就是 zip）',
    compressAt > -1 && fileAt > compressAt,
    'SetCompress off 必须在 File 之前；少了它会把已压好的 zip 再压一遍，几分钟换 ~0%');
  check('解压交给系统自带的 tar.exe（与自解压包同一条已验证路径）',
    nsi.includes('nsExec::ExecToStack') && nsi.includes('${TAR_EXE}" -xf "$PLUGINSDIR\\payload.zip" -C "$INSTDIR"'),
    '自己实现 zip 解压 = 多一份要维护、要验证的代码');
  check('解压后立刻删掉暂存的 362MB（别让它躺到进程退出）',
    /Delete "\$PLUGINSDIR\\payload\.zip"/.test(nsi),
    '不删则 %TEMP% 会同时存在 362MB 的 zip 与 1.3GB 的解压树');

  check('安装位置由用户决定：有目录页', nsi.includes('MUI_PAGE_DIRECTORY'),
    '没有目录页就等于替用户决定装在哪（2026-09-28 用户的明确要求）');
  check('按用户安装、不需要管理员（RequestExecutionLevel user）',
    nsi.includes('RequestExecutionLevel user'),
    '改成 admin 会弹 UAC，而默认落点 %LOCALAPPDATA% 本来就不需要提权');
  check('装了卸载器和「应用和功能」里的条目',
    nsi.includes('WriteUninstaller') && nsi.includes('Uninstall\\OfferWhere'),
    '没有卸载项就不是「真安装包」，只是把解压包装了个壳');
  // 桌面入口的落位必须与 create_desktop_shortcut.bat 一致。判包根目录的
  // `offer-where.exe` 是**已经发过一次**的缺陷（那个文件在哪都不存在 ⇒ 静默退化成 .bat）。
  const icoShortcut = 'dist-app\\offer-where.exe';
  check('快捷方式指向 dist-app 下的原生外壳，并回退到 start_all.bat',
    nsi.includes(`!define ENTRY_EXE  "${icoShortcut}"`) && nsi.includes('!define ENTRY_BAT  "start_all.bat"'),
    '落位写错 ⇒ 快捷方式指向不存在的文件');
  check('快捷方式图标用包内 public\\app.ico（唯一真相源）',
    nsi.includes('!define ICON_REL   "public\\app.ico"'), '写死别的图标 ⇒ 一个产品两套品牌标记');
  // 桌面快捷方式从「无条件创建」改成「可选」（2026-09-29 用户要求：桌面是用户的地盘）。
  // 判据不是「源码里出现了组件页」——那样把两条 CreateShortCut 都留在主 Section 里也能过。
  // 真正要看的是**位置**：桌面那条必须在自己的 Section 里，开始菜单那条留在主 Section 里。
  const mainSecAt = nsi.indexOf('Section "$(STR_SEC_CORE)" SEC_MAIN');
  const deskSecAt = nsi.indexOf('Section "$(STR_SEC_DESKTOP)" SEC_DESKTOP');
  const smCutAt = nsi.indexOf('CreateShortCut "$SMPROGRAMS');
  const dtCutAt = nsi.indexOf('CreateShortCut "$DESKTOP');
  check('桌面快捷方式是独立的可选组件（不再无条件创建）',
    nsi.includes('MUI_PAGE_COMPONENTS') && mainSecAt > -1 && deskSecAt > mainSecAt &&
      dtCutAt > deskSecAt,
    '桌面图标落在用户的桌面而不是安装目录 ⇒ 该由用户决定（与「安装位置自己选」同一个道理）');
  check('开始菜单项留在主 Section（不跟着桌面勾选项一起消失）',
    /SectionIn RO/.test(nsi) && smCutAt > mainSecAt && smCutAt < deskSecAt,
    '把开始菜单也做成可选 ⇒ 取消勾选的人会失去唯一入口（已端到端验证：/NODESKTOP 下开始菜单仍建）');
  // 中文不能进 nsi（前面已断言它纯 ASCII），只能进独立的 .nsh。
  // BOM 是否必需取决于 makensis 版本（3.11 实测带不带都能正确解码），保留它是为了把这份
  // 不确定性去掉 —— 断言它存在，免得有人当「多余字节」清理掉。
  const nshBytes = fs.readFileSync(path.join(ROOT, 'installer/ui_strings.nsh'));
  check('自建中文串放在独立 .nsh 里，且带 UTF-8 BOM',
    nshBytes[0] === 0xef && nshBytes[1] === 0xbb && nshBytes[2] === 0xbf &&
      nshBytes.includes(Buffer.from('在桌面上创建快捷方式', 'utf8')),
    'BOM 被清掉 ⇒ 脚本编码变成一次取决于编译器版本的赌注');
  check('该 .nsh 在 MUI_LANGUAGE 之后引入（LangString 需要 ${LANG_SIMPCHINESE}）',
    nsi.indexOf('MUI_LANGUAGE "SimpChinese"') > -1 &&
      nsi.indexOf('MUI_LANGUAGE "SimpChinese"') < nsi.indexOf('ui_strings.nsh'),
    '引在语言文件之前 ⇒ 语言常量还不存在，字符串静默变空');
  // ${SEC_DESKTOP} 这个常量要到 Section 被解析时才存在。
  check('.onInit 定义在 Section 之后（${SEC_DESKTOP} 那时才存在）',
    nsi.indexOf('Function .onInit') > deskSecAt,
    '写早了 ⇒ unknown variable/constant，而报错却指向 SectionSetFlags 的用法，看着像参数写错');
  check('静默安装也有办法不建桌面图标（/NODESKTOP）',
    nsi.includes('/NODESKTOP') && nsi.includes('SectionSetFlags ${SEC_DESKTOP} 0'),
    '无人值守装不了勾选框 ⇒ 不给开关就等于强制每个 /S 都在桌面放图标');
  // 安装器自己那一个文件是用户**最先**看到的东西（下载栏 / 资源管理器 / SmartScreen 提示），
  // 而它此前带的是 NSIS 的默认图标 —— 产品第一印象是别人的 logo。
  // 这条是拿一份「图标必须出现在所有位置」的发布清单逐条对出来的（2026-09-28）：
  // exe / 窗口 / 托盘 / favicon / 页内都覆盖了，唯独 NSIS 向导漏了。
  check('安装器自己带应用图标（Icon / UninstallIcon / MUI_ICON / MUI_UNICON 四处同源）',
    nsi.includes('Icon          "${ICON_FILE}"') &&
      nsi.includes('UninstallIcon "${ICON_FILE}"') &&
      nsi.includes('!define MUI_ICON   "${ICON_FILE}"') &&
      nsi.includes('!define MUI_UNICON "${ICON_FILE}"'),
    '不设这些 ⇒ 向导标题栏与 setup.exe 文件图标都是 NSIS 默认的，而快捷方式用的是我们的');
  // 卸载器图标的指令叫 `UninstallIcon`，**没有 `UnIcon` 这个东西**。
  // 写错时 makensis 只说 `Invalid command: "UnIcon"` —— 读起来像手误，实际是名字根本不存在。
  check('卸载器图标用 UninstallIcon 而不是不存在的 UnIcon',
    !/^\s*UnIcon\b/m.test(nsi),
    'UnIcon 不存在；报错长得像手误，会让人反复改同一个字');
  // 默认路径从本文件推导，而不是从调用方的 cwd —— 否则在别的目录跑 makensis 就找不到图标。
  check('ICON_FILE 默认从 ${__FILEDIR__} 推导（与调用方 cwd 无关）',
    nsi.includes('!define ICON_FILE "${__FILEDIR__}\\..\\public\\app.ico"'),
    '锚在 cwd ⇒ 换个目录构建就静默退回 NSIS 默认图标');
  check('构建前先确认图标文件存在（否则 makensis 只会报一个难懂的图标错）',
    readText('make_nsis.ps1').includes('the installer icon is missing'),
    '把「图标被挪走」的报错留给编译器 ⇒ 现场看到的是 NSIS 的 icon 语法报错');
  check('自测把 exe 里**实际嵌入**的图标与源 .ico 逐像素比对',
    readText('make_nsis.ps1').includes('ExtractAssociatedIcon') &&
      readText('make_nsis.ps1').includes('the setup exe icon does not match public\\app.ico'),
    '只断言 .nsi 里写了 Icon ⇒ 写着但编译器用了默认图标也全绿，而那正是漏了这么久的形态');
  check('System.Drawing 加载不到时算检查失败（不许静默跳过）',
    readText('make_nsis.ps1').includes('System.Drawing could not be loaded, so the setup exe icon was NOT verified'),
    '加载不到就当没这回事 ⇒ 这道门在部分机器上恒真，和 PII 那次「runner 上恒印 SKIPPED」同类');
  check('卸载默认保留用户数据（data/ 不能被默认删掉）',
    nsi.includes('MB_DEFBUTTON2') && nsi.includes('$KeepData "1"') &&
      nsi.includes('IfFileExists "$INSTDIR\\data" 0 un_wipe'),
    '默认删 data/ ⇒ 用户点一下卸载就丢掉简历与投递记录');
  // 首跑那个「安装」对话框存在的原因是：旧自解压包**只解压、从不碰外壳**，所以首跑必须
  // 补建桌面入口。它做的事只有两件 —— 跑 create_desktop_shortcut.bat /silent、写这个标记。
  // 安装器已经把两件事都做完了（开始菜单 + 桌面 + 卸载项），不写标记就会让用户为同一件事
  // 被问第二次：刚在向导里点过「安装」，首跑又被要求点一次「安装」。
  check('安装器写 data\\.installed，不再重复弹首跑「安装」对话框',
    /FileOpen \$\d+ "\$INSTDIR\\data\\\.installed" w/.test(nsi),
    '不写这个标记 ⇒ NSIS 装完首跑仍弹「安装」，而那件事安装器刚刚才做完');
  check('安装器写的标记与 start_all.bat / lib.rs 是同一个文件',
    nsi.includes('$INSTDIR\\data\\.installed') && readText('start_all.bat').includes('.installed'),
    '两个写入约定 ⇒ 首跑判定只认其中一个，另一个永远不生效');
  check('自测会验证首跑标记落位（否则「不再弹窗」只是注释里的一句话）',
    readText('make_nsis.ps1').includes('first-run mark') &&
      readText('make_nsis.ps1').includes('data\\.installed is missing'),
    '装完却缺标记是本改动唯一会安静坏掉的方式，必须在真跑一次安装后核对');
  // 「Uninstall.exe 在磁盘上」只证明文件写出来了；「应用和功能」读的是注册表。
  // 而且静默安装会写 HKCU —— 在**已经装过**的机器上跑 -SelfTest 会把那台机器的卸载项
  // 改指向临时目录，在**没装过**的机器上会留下一个指向已删目录的新条目。两件事都是
  // 2026-09-28 拍下真实向导界面时才发现的（目录页被预填成上一次自测的临时路径）。
  check('自测核对注册表里的卸载项（「应用和功能」读的是它，不是文件是否存在）',
    readText('make_nsis.ps1').includes('uninstall entry is not registered') &&
      readText('make_nsis.ps1').includes('regUninstString'),
    '只查 Uninstall.exe ⇒ 注册项写错也全绿，用户却在「应用和功能」里找不到它');
  check('自测核对 InstallDir 被记住（下次安装的目录页靠它预填）',
    readText('make_nsis.ps1').includes('InstallDir was not remembered'),
    'InstallDirRegKey 写错 ⇒ 用户装第二遍时看到的是别人/上次的路径');
  check('自测跑完把注册表还原（否则每跑一次就多一个假「已安装」条目）',
    readText('make_nsis.ps1').includes('Restore-RegSnapshot $regApp $regAppBefore') &&
      readText('make_nsis.ps1').includes('Restore-RegSnapshot $regUninst $regUninstBefore'),
    '自测会损坏它测量的那台机器 ⇒ 人就不敢再跑它了');
  // AddSize 与 File 会同向叠加：File 已经按「写入的文件大小」算过一笔（即暂存 zip ~370MB），
  // 所以 AddSize 只能补**差额**。把「安装后占用」整个塞给 AddSize ⇒ 目录页显示 1.7GB 而
  // 实际只要 1.1GB，足以把空间够用的用户吓退。
  check('AddSize 只补差额，不与 File 重复计 payload',
    nsi.includes('AddSize ${PAGE_KB}') && !nsi.includes('AddSize ${INSTALLED_KB}'),
    'File 已经把暂存 zip 的大小算进所需空间 ⇒ AddSize 再算一遍全额 = 翻倍');
  check('EstimatedSize 用的是安装后实际占用，不是差额',
    /WriteRegDWORD HKCU "\$\{UNINST_KEY\}" "EstimatedSize" \$\{INSTALLED_KB\}/.test(nsi),
    '两者混用 ⇒ 要么页面吓人，要么「应用和功能」把体积报小');
  // 卸载器此前**一次都没被跑过**，而它是「真安装包」的另一半，也是能动用户简历的那一半。
  // 发布说明里写着「卸载会默认保留你的 data\」—— 这句话必须有机器在核。
  check('自测真跑一次静默卸载（不是只看 Uninstall.exe 在不在）',
    readText('make_nsis.ps1').includes('silent uninstall (desktop shortcut before: '),
    '只断言文件存在 ⇒ 卸载逻辑写错也全绿');
  check('自测核对「静默卸载不许删 data\\」这条承诺',
    readText('make_nsis.ps1').includes('a silent uninstall DELETED data\\'),
    'MB_DEFBUTTON1 会让无人的那条路径开始删用户数据，而没人会看到');
  check('自测核对卸载器注销了自己（否则卸载完还留在「应用和功能」里）',
    readText('make_nsis.ps1').includes('the uninstaller left its registry entry'),
    '卸载项不删 ⇒ 用户卸载后还看得见一个点不动的条目');
  // 安装器在**安装目录之外**还动了两样东西：桌面快捷方式与开始菜单项。自测只看 $dest 的话
  // 完全看不到它们 —— 事实上这台机器上就曾留下过两个指向已删临时目录的桌面快捷方式。
  check('自测把桌面/开始菜单入口也纳入快照与还原',
    readText('make_nsis.ps1').includes('$entryBefore') &&
      readText('make_nsis.ps1').includes('cleaned up'),
    '安装器建这些是功能；自测留下它们是污染，而在 $dest 里怎么找都找不到');
  // NSIS 的 MessageBox 是**行终止**指令：返回分支写到下一行会被当成命令，
  // 构建直接死在 `Invalid command: "IDNO"`（本次真踩，读那行错报完全看不出是换行问题）。
  check('卸载确认框的返回分支与文本同一行（NSIS 指令以换行结束）',
    /MessageBox MB_YESNO\|MB_DEFBUTTON2 "[^"\n]*"( \/SD IDNO)? IDNO [A-Za-z0-9_]+/.test(nsi),
    '分支换行写 ⇒ Invalid command: "IDNO"，报错原文完全看不出是换行问题');
  // 2026-09-28 用 A/B 探针隔离出来的约束（u3.nsi，6 组，120 s 观察窗口，各自只差一个变量）：
  //   ① `IfSilent` 让无人值守卸载不再挂在没人看得见的模态框上。实测同一棵树：
  //      有 IfSilent -> 进程 0.1 s 返回、树 0.5 s 内删净；没有 -> 7.3 s 返回、22.0 s 才落定。
  //      **两种都删得掉** —— 这是「卡住」，不是「失败」。
  //      （此处曾断言「un.onInit 里的 MessageBox 会让整个卸载器变空操作」，长窗口重跑**推翻**了它。）
  //      `/SD IDNO` 则是给「非静默但无人应答」的默认应答；它在文本**之后**，放进 mode 段会
  //      编译失败（Usage: MessageBox）。
  //   ② 卸载器不许用 Rename 搬 data\ —— Rename **不能跨卷**。装机到 D:、$LOCALAPPDATA 在 C:
  //      时它会失败并落到「全删」分支，于是「保留数据」静默变成「删光数据」。实测（120 s 窗口）：
  //      Rename 版 data KEPT=False，枚举版 data KEPT=True。
  //      而「装到哪个盘」正是我们自己交给用户选的功能。
  //      改用枚举：删 $INSTDIR 下除 data\ 之外的一切，布局与卷都无关。
  // 跨卷那条**只能**靠探针发现：默认自测目录在 %TEMP%，与 $LOCALAPPDATA 同卷。
  check('静默卸载绕过 MessageBox（不让无人值守的卸载挂在没人看得见的模态框上）',
    /IfSilent [A-Za-z0-9_]+\s+MessageBox MB_YESNO\|MB_DEFBUTTON2/.test(nsi),
    '不加 IfSilent ⇒ /S 会先卡在隐藏的确认框上（实测 7.3 s 才返回、22 s 才删净），发布说明却承诺它能无人值守');
  check('卸载器注释里不许再出现「MessageBox 让卸载器变空操作」这个被推翻的结论',
    !nsiRaw.includes('turns the WHOLE uninstaller into a no-op'),
    '长窗口重跑已推翻该假设；把错的根因留在代码里，下一个读它的人会去修一个不存在的 bug');
  check('确认框带 /SD 默认应答，且 /SD 在文本之后而非 mode 段里',
    /MessageBox MB_YESNO\|MB_DEFBUTTON2 "[^"\n]*" \/SD IDNO IDNO [A-Za-z0-9_]+/.test(nsi),
    '把 /SD 塞进 MB_YESNO|MB_DEFBUTTON2 一段会编译失败：Usage: MessageBox');
  check('卸载器不用 Rename 搬 data\\（Rename 不能跨卷 ⇒ 「保留」静默变成「全删」）',
    !/\bRename\b/.test(nsi),
    'Rename 跨卷必失败：装在别的盘时那条「保留数据」的分支会去删数据');
  check('卸载器改为枚举删除，显式跳过 data\\',
    // 2026-09-30：这段枚举抽成了共享宏 WIPE_INSTDIR_KEEP_DATA（安装器与卸载器共用一份），
    // 所以锚点跟着挪到宏体。三条缺一不可 —— 少了 FindFirst 就没有枚举，少了 data 跳过
    // 就会连用户数据一起删。
    nsi.includes('FindFirst $Fh $Fn "$INSTDIR\\*.*"') &&
      nsi.includes('StrCmp $Fn "data" wd_keep_next') &&
      nsi.includes('FindClose $Fh'),
    '只 RMDir /r 整个 $INSTDIR 会把要保留的 data\\ 一起删掉');
  check('自测报出这次跑的卷关系（同卷则跨卷那条路根本没被走过）',
    readText('make_nsis.ps1').includes('cross-volume path NOT exercised'),
    '默认自测目录与 $LOCALAPPDATA 同卷 ⇒ 绿了也不代表跨卷可用，报告必须说清楚');
  check('自测的残留检查覆盖整轮（含卸载器自复制的 ~nsu*.tmp）',
    readText('make_nsis.ps1').includes('$tmpBeforeUn') &&
      readText('make_nsis.ps1').includes('uninstall cue') &&
      readText('make_nsis.ps1').includes('NSIS self-copy'),
    '只在安装前取一次快照 ⇒ 卸载器留下的 ~nsu*.tmp 永远不在判据里，报告照样写「0 个新暂存目录」');
  check('自测断言卸载后除了 data\\ 什么都不剩（不只看 start_all.bat）',
    readText('make_nsis.ps1').includes('the uninstaller kept entries it should have removed'),
    '只看一个文件 ⇒ 留下 12 万文件也算过；data\\ 之外每多一样都是漏删');
  // NSIS 卸载器的**进程退出 ≠ 卸载完成**：它先把自己复制到 %TEMP%\~nsu.tmp 再重启。
  // 2026-09-28 就是这样：断言在「进程返回」后立刻跑，报出 24 个残留顶层项 + 「卸载器留了树」，
  // 一分钟后同一棵树是 0 个文件；而且我们自己的清理还在和它抢同一棵树（最后死在 index.js
  // access denied）。判据必须是**终态**，且要有超时兜底（真不干活就等超时再失败）。
  check('自测等卸载器真正结束（进程返回 ≠ 卸载完成）',
    readText('make_nsis.ps1').includes('the uninstaller returns before it finishes') &&
      /while \(\$settleSec -lt \$settleBudget -and \(Test-Path -LiteralPath \$entryBat\)\)/.test(readText('make_nsis.ps1')),
    'WaitForExit 一返回就断言 ⇒ 会稳定报出「卸载器留了树」，而那棵树几秒后就没了');
  check('自测的清理对「被卸载器占着的树」重试（并发删同一棵树 = access denied）',
    readText('make_nsis.ps1').includes('Retry the transient lock'),
    '首次即抛 ⇒ 一次偶发锁把整轮自测打成 THREW，真正的结论反而看不到');

  const mkNsis = readText('make_nsis.ps1');
  // 正则里的 `\\` 匹配的是**一个**反斜杠。写成 `\\\\` 会去匹配两个，然后恒假 ——
  // 那种"断言永远不响"比没有断言更坏，因为它长得像一道门。
  check('make_nsis.ps1 把路径规范化成反斜杠（NSIS 的 File 不认正斜杠）',
    /\$Zip = \$Zip\.Replace\('\/', '\\'\)/.test(mkNsis) &&
      /\$Out = \$Out\.Replace\('\/', '\\'\)/.test(mkNsis),
    '正斜杠绝对路径会被 NSIS File 当成一个文件名 ⇒ no files found');
  check('make_nsis.ps1 断言 payload 真的被内嵌（退出码 0 不等于产物能用）',
    mkNsis.includes('the payload was NOT embedded'),
    'Tauri 那条路就产过一个 3.5MB 的「安装器」而一切看起来正常');
  check('make_nsis.ps1 捕获 makensis 输出（原生 stderr 不会被调用方的重定向合并）',
    /\$mkOut = & \$Makensis \$defs \$nsi 2>&1/.test(mkNsis),
    '不捕获则编译错误只剩一行空白，本次就是这样丢掉 `Invalid command: "IDNO"` 的');
  check('make_nsis.ps1 不假设 runner 上有 makensis',
    mkNsis.includes('makensis not found'), 'Server 2025 镜像没有 NSIS，而 windows-latest 会漂移');
  // pack.ps1 写的 version.json 是 {commit, builtAt, dirty} —— **没有 version 键**。
  // 读一个永远不存在的键等于「安静的兜底」，而它落到 DisplayVersion 上就是「0.0.0」，
  // 在「应用和功能」里看起来像个正常版本号。兜底必须读真实存在的字段。
  check('make_nsis.ps1 的版本兜底读 version.json 里真实存在的字段',
    mkNsis.includes('$stamp.builtAt') && !mkNsis.includes('ConvertFrom-Json).version'),
    'version.json 只有 {dirty, commit, builtAt}；读不存在的键 ⇒ 本地构建被标成 0.0.0');
  // 「读了哪个字段」还不够，还得是「读了哪个文件」。version.json 由 pack.ps1 写在**仓库根**，
  // 而 zip 落在 $PACK_ZIP_DIR ⇒ 把查找锚在 (Split-Path -Parent $Zip) 时，Test-Path 恒假、
  // 这段兜底**一次都没生效过**；而上面那条只查字段名的断言照样通过。断「字段」也要断「锚点」。
  check('make_nsis.ps1 到仓库根去找 version.json（zip 旁边没有这个文件）',
    mkNsis.includes("Join-Path $root 'version.json'"),
    'pack.ps1 把 version.json 写在 $root、zip 落在 $PACK_ZIP_DIR ⇒ 锚在 zip 旁边等于永远读不到');
  const packDrop = readText('pack.ps1').slice(
    readText('pack.ps1').indexOf('$dropScripts = @('),
    readText('pack.ps1').indexOf('\n)', readText('pack.ps1').indexOf('$dropScripts = @(')),
  );
  check('pack.ps1 的 $dropScripts 排除 make_nsis.ps1（收件人不造安装包）',
    packDrop.includes("'make_nsis.ps1'"),
    '它依赖未分发的 installer\\ 与 makensis；留在包里只会让引用守卫报无关的悬空');

  // 本块自带剥注释函数：下面 ⑥ 里的 stripHash 在本块之后才用 const 声明，
  // 提前引用会撞进 TDZ 直接抛 ReferenceError（写断言时先撞了一次）。
  const stripYamlComments = (s: string) => s.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
  const relYml = stripYamlComments(readText('.github/workflows/release.yml'));
  check('release.yml 构建 NSIS 安装包并真跑一次静默安装',
    relYml.includes('./make_nsis.ps1') && relYml.includes('-SelfTest'),
    '-SelfTest 是唯一能证明「下载一个文件、双击就能装」的检查；纯结构校验证明不了');
  check('release.yml 不再构建自解压包（它已不是发布资产）',
    !relYml.includes('make_sfx.ps1') && !relYml.includes('--extract-only'),
    '两条下载路径做同一件事 ⇒ 用户要选，而选错的那个必然过时');
  check('release.yml 仍从源码编译外壳（防止 tools/sfx/ 腐化）',
    relYml.includes('tools/sfx/offerwhere_sfx.c'),
    '搬出发布链路后又没人编译的源码，会安静地烂掉');
  check('发布说明写清了无人值守装法（/S /D=）',
    relYml.includes('/S /D=D:\\OfferWhere'),
    'DS 的 /D= 必须末位且不带引号；写错则静默装到默认位置');
  // 发布说明是用户下载时看到的第一段字（本仓库的明确约定）。安装器多了一页、多了个开关，
  // 而说明没跟上 ⇒ 用户第一次见到那个勾选框时没有任何解释。
  check('发布说明同步了「桌面图标可选」与 /NODESKTOP（改了安装器就要改说明）',
    relYml.includes('选择组件') && relYml.includes('/NODESKTOP'),
    '安装器已多出「选择组件」一页，说明不写 ⇒ 用户不知道那个勾选框是干什么的');

  // ── ⑤-c 覆盖安装不得删用户数据（2026-09-30 修复的机械护栏）────────────────
  // 背景：老用户升级 = 拿新安装包**覆盖**已存在的 $INSTDIR，而 $INSTDIR\data 里是用户的
  // 简历、采集的 JD 与投递历史。两条错误分支原来都写 `RMDir /r "$INSTDIR"` ——
  // 首次安装时这是对的（把半成品目录清干净），但升级时它变成了「删用户数据」。
  // 触发条件很平常：**开着 OfferWhere 双击新版安装包**。tar 无法替换被锁的
  // node\node.exe，退出码 1（Can't unlink already-existing object: Permission denied），
  // 随后命中删除分支。真跑实测 + 破坏性对照见 _tools/_nsi_verify.py 与 _nsi_control.py
  // （回退这两处写法时 A1/A2/A3 三条核心断言确实打红）。
  const nsiMainStart = nsi.indexOf('Section "$(STR_SEC_CORE)" SEC_MAIN');
  const nsiMainEnd = nsi.indexOf('SectionEnd', nsiMainStart);
  const nsiMain = nsiMainStart >= 0 && nsiMainEnd > nsiMainStart ? nsi.slice(nsiMainStart, nsiMainEnd) : '';
  check('安装段不裸删整个安装目录（$INSTDIR\\data 就在它下面）',
    nsiMain.length > 0 && !/RMDir\s+\/r\s+"\$INSTDIR"/i.test(nsiMain),
    '一条 `RMDir /r "$INSTDIR"` 就把用户的简历与投递历史一起删了；安装失败不是丢数据的理由');
  check('「保留 data 的清理」只有一份实现（安装器与卸载器共用）',
    (nsi.match(/!macro WIPE_INSTDIR_KEEP_DATA/g) || []).length === 1 &&
      nsi.includes('Function WipeInstallDirKeepData') &&
      nsi.includes('Function un.WipeInstallDirKeepData') &&
      (nsi.match(/!insertmacro WIPE_INSTDIR_KEEP_DATA/g) || []).length === 2,
    '两份手维护的副本正是本项目踩过的坑（ResolveEntry 的注释就是为此写的）');
  check('安装段两条错误分支都走「保留 data」的清理',
    (nsiMain.match(/Call WipeInstallDirKeepData/g) || []).length === 2,
    '解压失败 / 缺入口点各有一处清理；漏一处等于只修了一半');
  check('卸载器的保留数据分支复用同一实现',
    /Call un\.WipeInstallDirKeepData/.test(nsi),
    '用户勾了「保留我的数据」却把它删掉 —— 这类回归最容易在改安装器时被带出来');
  // ── ⑤-d 升级守卫：程序还在跑就别开始装（2026-09-30）────────────────────────
  // 升级 = 覆盖一个已存在的 $INSTDIR。程序还在跑时 tar 无法替换被锁的文件，
  // 必然失败 —— 用户白跑一趟。守卫把它变成「先说清楚，再让你重试」。
  const nsiGuardAt = nsiMain.indexOf('Call IsInstallDirLocked');
  const nsiTarAt = nsiMain.indexOf('nsExec::ExecToStack');
  check('升级前先查安装目录是否被占用，且发生在解压之前',
    nsiGuardAt >= 0 && nsiTarAt >= 0 && nsiGuardAt < nsiTarAt,
    '不查 ⇒ 程序在跑时 tar 必然失败，用户白跑一次；查晚了则半棵树已经解开');
  check('占用检测看的是自己的文件，不是全机同名进程',
    nsi.includes('Function IsInstallDirLocked') &&
      nsi.includes('FileOpen $R1 "$INSTDIR\\${ENTRY_EXE}" "a"') &&
      !/tasklist/i.test(nsi),
    'tasklist 会误报机器上无关的 node.exe，把好好的安装拦下来 —— 误报比漏报更伤，人会开始无视弹窗');
  check('占用检测先确认文件存在（FileOpen 会创建不存在的文件）',
    (nsi.match(/IfFileExists "\$INSTDIR[^"\n]*" 0 ild_next/g) || []).length === 2,
    '实测（_tools/_lock_probe.py）：FileOpen "a" 对不存在的路径会直接创建它 ⇒ 首次安装会被凭空造出空文件');
  check('守卫弹窗带 /SD IDCANCEL（静默部署要早失败，而不是卡死）',
    /MessageBox MB_ICONEXCLAMATION\|MB_RETRYCANCEL[^\n]*\/SD IDCANCEL IDRETRY/.test(nsi),
    '没有 /SD ⇒ 静默安装挂在没人能点的 Retry 上；有了它则非 0 退出，且 $INSTDIR 一个字节都不动');

  check('安装器的中止弹窗都带 /SD（无人值守不挂在对话框上）',
    (nsi.match(/MB_ICONSTOP "[^"]*"\s*\/SD IDOK/g) || []).length === 3,
    'MessageBox 不理会 /S：静默部署撞上错误会永远等一个没人能点的按钮，比失败更糟');

  // ── ⑤-b makensis 候选路径清单：两处必须一致（2026-09-29 事故的机械护栏）────────
  // 事故形状：release.yml 装完 NSIS 后**只用 `Get-Command makensis` 复查** —— choco 改的是
  // 注册表里的 PATH，不会刷新已在运行的 PowerShell 会话（$env:PATH 是启动时快照）⇒ 查不到
  // ⇒ 抛错。而 NSIS 其实已经装好了（`Deployed to 'C:\Program Files (x86)\NSIS'`），
  // 抛出的句子却写成 "no makensis on this runner"，把「PATH 里没有」说成「机器上没有」，
  // 排查方向直接跑偏。真正的病根是**同一条清单被写了两份，其中一份更弱**。
  // 修法：两份取齐 + 本断言钉住 —— 否则下次谁再补一个安装位置而只改一边，
  // 症状（构建红）完全指不到「清单漂移」这个原因上。
  const makensisPaths = (src: string) => {
    const hits = src.match(/'([^'\r\n]*makensis\.exe)'/gi) || [];
    return [...new Set(hits.map((h) => h.slice(1, -1).replace(/\//g, '\\').toLowerCase()))].sort();
  };
  const mkPathsRel = makensisPaths(relYml);
  const mkPathsNsis = makensisPaths(readText('make_nsis.ps1'));
  check('makensis 候选路径清单在 release.yml 与 make_nsis.ps1 之间一致',
    mkPathsRel.length >= 3 && JSON.stringify(mkPathsRel) === JSON.stringify(mkPathsNsis),
    `两处清单漂移 ⇒ 一边装得到、另一边找不到：release.yml=[${mkPathsRel.join(' | ')}] make_nsis.ps1=[${mkPathsNsis.join(' | ')}]`);
  check('release.yml 装完 NSIS 后重新扫路径（不靠 PATH 快照）',
    /choco install nsis/.test(relYml) && /function Find-Makensis/.test(relYml) &&
      /choco install nsis[\s\S]{0,400}?Find-Makensis/.test(relYml),
    'choco 改的是注册表 PATH，已运行的会话看不到 ⇒ 装成功却复查不到');

  // ── ⑥ PII 护栏必须在「构建发布产物的那条流水线」上真的跑起来 ──────────
  // 事故形状（2026-09-27 读 runner 自己的日志才发现）：denylist 住在 data/ 下，
  // 而 data/ 被 gitignore ⇒ runner 上永远不存在 ⇒ pack.ps1 打印一行平静的
  // "PII check: SKIPPED" 然后照常打包发布。于是「保护产物的那道门」恰好在
  // 「构建公开产物的那台机器上」静默失效，而日志上它与「检查通过」无法区分 ——
  // 与本项目 12.5 那条「绿得比实际更绿」是同一个失败模式。
  // 修法：workflow 从仓库 secret 落盘 denylist + 置 REQUIRE_PII_SCAN=1；
  // 两个消费者都必须把「缺 denylist」当致命错误。以下把这条链路钉住。
  //
  // ⚠️ 必须**先剥注释再匹配**。第一版这里直接用 includes()，阳性对照当场证明它没牙：
  // 上面这段说明文字里就写着 REQUIRE_PII_SCAN=1，所以把真正的 YAML 行改掉之后断言照样通过
  // —— 断言被自己的注释满足了。与 pack.ps1 那条「引用守卫抓到自己的注释」是同一个坑。
  const stripHash = (s: string) => s.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
  const stripSlash = (s: string) => s.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');

  const packCode = stripHash(readText('pack.ps1'));
  check('pack.ps1 认 REQUIRE_PII_SCAN 并在缺 denylist 时拒绝打包',
    packCode.includes('$env:REQUIRE_PII_SCAN') &&
      /REQUIRE_PII_SCAN[^\n]*\n(?:[^\n]*\n){0,6}[^\n]*exit 1/.test(packCode),
    '没有这条，发布流水线会安静地发出未经 PII 扫描的包');
  const guardCode = stripSlash(readText('scripts/pii_guard.ts'));
  check('scripts/pii_guard.ts 认 REQUIRE_PII_SCAN（跳过路径改为 fail-closed）',
    /process\.env\.REQUIRE_PII_SCAN\s*===\s*'1'/.test(guardCode),
    'pre-push 的第 3 道门同样会在无 denylist 的机器上静默放行');
  for (const wf of ['release.yml', 'ci.yml']) {
    const y = stripHash(readText(`.github/workflows/${wf}`));
    check(`${wf}: 从仓库 secret 落盘 PII denylist`,
      y.includes('secrets.PII_DENYLIST') && y.includes('pii_denylist.txt'),
      '不落盘则护栏在 runner 上恒为跳过');
    // 开关必须来自**仓库 variable**：若它与 secret 同源，删掉 secret 就等于同时关掉了开关，
    // 于是「未扫描的包」又变成静默可发的（这正是这道门原本失效的方式）。
    check(`${wf}: 开关来自仓库 variable（不跟随 secret 消失）`,
      y.includes('vars.REQUIRE_PII_SCAN'),
      '开关与 secret 同源 ⇒ 删掉 secret 就静默退回「跳过扫描」');
    check(`${wf}: 缺 secret 时**提前硬失败**（不是只警告）`,
      /PII_DENYLIST secret is not set[^\n]*\n(?:[^\n]*\n){0,3}[^\n]*exit 1/.test(y),
      '只警告不失败 ⇒ 仍能在无人察觉的情况下发出未扫描的包');
  }
  check('ci.yml: PR 事件不强制（fork 拿不到 secret，强制会把陌生人的 CI 打红）',
    /github\.event_name == 'pull_request' && '0' \|\| vars\.REQUIRE_PII_SCAN/.test(
      stripHash(readText('.github/workflows/ci.yml')),
    ),
    '缺这条会让来自 fork 的 PR 恒红，而 PR 产物本来也不对外发布');
  check('denylist 永不入库（data/ 被 gitignore）',
    readText('.gitignore').split(/\r?\n/).some((l) => l.trim() === 'data/'),
    'denylist 里就是它要防的那些字符串，入库等于二次泄露');
}

// ══════ 启动期可用性：磁盘清理必须「真异步」（2026-09-28） ══════
// 背景（实测）：cleanupData 曾声明为 async，但**函数体内一个 await 都没有**，里面全是
// readdirSync / statSync / unlinkSync，而且被**直接写在 app.listen 回调里** ⇒ 整段同步 I/O
// 跑在事件循环上，把它占死到底。本机 data/ = 847MB / 5,351 文件时占用 **19,893 ms**；
// 这段时间里日志已经打了「API 服务器已启动」、端口也已经 LISTENING，但**任何请求都得不到响应**
// （客户端超时后服务端留下一排 CLOSE_WAIT）。看起来像「服务坏了」，其实是「在忙」。
// 空 data/ 的 CI 冒烟里它只要几毫秒 ⇒ **门禁天然看不见**，所以必须靠断言钉住。
{
  const CT_ROOT2 = fileURLToPath(new URL('..', import.meta.url));
  const rawSrc = fs.readFileSync(path.join(CT_ROOT2, 'server/services/dataCleanup.ts'), 'utf8');
  // 先剥注释再断言：说明文字里就写着 readdirSync / statSync / withFileTypes，
  // 不剥注释会让断言被「自己的注释」满足（既有教训）。
  const cleanupSrc = rawSrc
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  // 注意：dirSize / pruneByAge 定义在 cleanupData **之前**，所以整文件扫描，
  // 不能只截 cleanupData 的函数体（否则漏掉真正干活的那两个辅助函数）。
  const fromDecl = cleanupSrc.slice(cleanupSrc.indexOf('export async function cleanupData'));
  const cleanupBody = fromDecl.slice(0, fromDecl.indexOf('\n}') + 2);
  check('cleanupData 真的 await（不能是「假 async」）',
    /\bawait\s/.test(cleanupBody),
    '函数体内 0 个 await ⇒ 整段同步 I/O 跑在事件循环上，服务表现为「已启动但不可服务」');
  check('清理模块不用同步 fs（*Sync 会占住事件循环）',
    !/\bfs\.\w*Sync\(/.test(cleanupSrc),
    '启动路径上的 readdirSync/statSync/unlinkSync 会把可用性推迟到遍历结束');
  check('目录遍历用 withFileTypes（省掉逐文件 stat）',
    /withFileTypes\s*:\s*true/.test(cleanupSrc),
    '否则每个文件一次 stat —— Windows 上这是主要开销');
  check('目录遍历不跟随符号链接（Windows junction 会成环）',
    /isSymbolicLink\(\)/.test(cleanupSrc),
    '跟随 + 只有深度上限 ⇒ 含 junction 的 Chrome profile 会指数级展开');
}

// ── 动态 UPDATE 的列名白名单（P0 列名注入回归）────────────────────────────────
// 背景（实测 2026-09-30）：`PATCH /api/jobs/:id` 曾把 `req.body` 整包转发给 updateJob，
// 而 updateJob 用 `for (const key of Object.keys(updates)) fields.push(\`${key} = ?\`)`
// —— **列名位置直接取自对象键**。实测载荷（隔离库 _tools/_inject_probe.mjs）：
//   { "company = 'X', position = ?, city = ?, salary = ? --": "P" }
// 拼出 `UPDATE jobs SET company = 'X', position = ?, city = ?, salary = ? -- = ?, updated_at = ? WHERE id = ?`，
// `--` 把 `WHERE id = ?` 注释掉 ⇒ **三条互不相同的岗位被全部改写**，接口还静默 200。
//
// ⚠️ 本段断言的目标字符串（`Object.keys(updates)` / `req.body`）**在我写的修复说明注释里就有**，
//    所以必须走 countMatches（内部先 stripComments）—— 否则断言会被「自己的注释」满足。
{
  const CT_ROOT3 = fileURLToPath(new URL('..', import.meta.url));
  const dbSrc = fs.readFileSync(path.join(CT_ROOT3, 'server/db.ts'), 'utf8');
  const idxSrc = fs.readFileSync(path.join(CT_ROOT3, 'server/index.ts'), 'utf8');
  const clSrc = fs.readFileSync(path.join(CT_ROOT3, 'server/services/dataCleanup.ts'), 'utf8');

  const nLoop = countMatches(dbSrc, /for\s*\(const\s+key\s+of\s+Object\.keys\(updates\)/g);
  check('db.ts 不再「按对象键循环拼列名」（列名注入的根因）', nLoop === 0,
    `实际 ${nLoop} 处 ⇒ 键名会直接进 SQL 文本`);

  const nHelper = countMatches(dbSrc, /collectUpdateFields\s*\(/g);
  check('两个动态 UPDATE 都改走白名单助手（定义 1 + 调用 2）', nHelper === 3,
    `实际 ${nHelper} 处`);

  check('jobs 可更新列清单已导出（路由复用同一真相源，不各写一份）',
    countMatches(dbSrc, /export const JOB_UPDATABLE\b/g) === 1,
    `实际 ${countMatches(dbSrc, /export const JOB_UPDATABLE\b/g)} 处`);

  const nForward = countMatches(idxSrc, /db\.updateJob\(\s*req\.params\.id\s*,\s*req\.body/g);
  check('PATCH /api/jobs/:id 不再把 req.body 整包转发给 updateJob', nForward === 0,
    `实际 ${nForward} 处 ⇒ 任意键名都能到达 SQL 构造`);

  check('该路由按白名单显式挑字段',
    countMatches(idxSrc, /for\s*\(const\s+k\s+of\s+db\.JOB_UPDATABLE\)/g) === 1,
    `实际 ${countMatches(idxSrc, /for\s*\(const\s+k\s+of\s+db\.JOB_UPDATABLE\)/g)} 处`);

  // ── DB 备份保留：以「备份本体」为单位 ──
  // 原实现按前缀 `chat.db.bak-` 无差别收集 ⇒ SQLite 的 `-wal`/`-shm` 伴生文件同样命中，
  // 被当成「一份备份」参与 mtime 排序、挤占 keepDbBackups 名额。
  // 实测（_tools/_backup_retention_probe.mts）：3 份主备份各带 2 个伴生时 deleted=6、
  // 只剩最新 1 份 —— 承诺「留 3 份」实际留 1 份；名额被伴生占满时**可用备份一份不剩**。
  // ⚠️ 目标文本是 `n.replace(/-(wal|shm)$/i, '')` —— 正则里的圆括号**必须转义**，
  //    否则 `(wal|shm)` 会被当成「分组 + 或」而不是字面量 `(wal|shm)`，恒 0 命中。
  //    这种「恒 0 命中」的断言在破坏性对照里也只会显示为红 —— 看着像有区分力，实则没有。
  //    已用 node 实测确认命中 1 次后再落笔。
  const nStrip = countMatches(clSrc, /\.replace\(\/-\(wal\|shm\)\$\/i/g);
  check('DB 备份按「备份本体」分组（-wal/-shm 不再占保留名额）', nStrip === 1,
    `实际 ${nStrip} 处基名归一化`);
  check('DB 备份保留按组整组保留/整组删除',
    countMatches(clSrc, /groups\.get\(base\)/g) >= 1 && /\bgroups\b/.test(stripComments(clSrc)),
    '没有分组 ⇒ 伴生文件会被拆散，留下「主备份已删、只剩伴生」的孤儿');

  // ── 简历备份纳入清理（原先无人回收，每重传一次多留一份含 PII 的副本）──
  const nResume = countMatches(clSrc, /keepResumeBackups/g);
  check('简历备份（resume_*.pdf.bak.<ts>）纳入清理并计入报告', nResume >= 3,
    `实际 ${nResume} 处（期望 ≥3：选项 + 默认值 + 保留计算）`);

  // ── 删除失败不得谎报释放量 ──
  // 原先一律「先 deleted++ 再 unlink」，unlink 抛错被 catch 吞掉 ⇒ 报告宣称「已释放 N 个」，
  // 目录里一个都没少。实测撞见过（报告 `删除 1`、目录里 4 项一个没动）。
  //
  // ⚠️ 判据升级（2026-10-01）：原来写死「三处各命中 1」。自动限额新增了删除点
  //    （pruneTree 清调试产物）⇒ 数量一变断言就误红，而**误报比漏报更危险**
  //    （人一旦觉得"这条总是红的"，整份报告都不看了）。改成核对**性质**：
  //    每一处 `deleted++` 要么紧跟 `unlink`（先删后计），要么在 dryRun 的「只统计」分支里
  //    （那个分支本来就不删）。新增删除点不会误红，而「先计后删」仍会被抓出来。
  const nUnlinkThenInc = countMatches(clSrc, /unlink\([^)]*\);\s*\w+\.deleted\+\+/g);
  const nIncTotal = countMatches(clSrc, /\.deleted\+\+/g);
  const nDryRunInc = countMatches(clSrc, /if\s*\(dryRun\)\s*\{[^}]*\.deleted\+\+/g);
  check('清理计数发生在 unlink 之后（删除失败不谎报释放量）',
    nUnlinkThenInc >= 3 && nIncTotal === nUnlinkThenInc + nDryRunInc,
    `unlink 后计数 ${nUnlinkThenInc} / 自增总数 ${nIncTotal} / dryRun 分支 ${nDryRunInc}（应满足 总数 = unlink后 + dryRun）⇒ 出现「先计后删」即为不满足`);

  // ── 超阈值自动限额（2026-10-01）────────────────────────────────────────────
  // 背景：原先 data/ 超阈值只打印一行告警，分发给他人后磁盘会被「截图 + 日志 + 备份 +
  // 简历副本」这些**本来就有保留策略的东西**静默吃满，而终端一关那行字就没了。
  // 改为按档位自动限额，但**必须**保证它只动"可再生"的东西 —— 下面三条就是这条底线。
  const nModeType = countMatches(clSrc, /export type AutoLimitMode = 'off' \| 'safe' \| 'full'/g);
  check('自动限额档位可配（off / safe / full）',
    nModeType === 1 && /DATA_AUTO_LIMIT/.test(stripComments(clSrc)),
    '档位决定"敢删到什么程度"；没有 env 开关就等于写死行为，用户无法按自己的容忍度调整');

  // 🔴 底线：自动限额**永远**不许碰登录态 / 投递证据 / 一岗一简历产物。
  //    这些要么不可再生（登录态删了要把 8 个平台重新登一遍），要么正是用户要留的证据。
  //
  // ⚠️ 反向断言（"不出现"）最大的风险是**恒 0 命中** ⇒ 恒绿。所以判据要覆盖全部两条入口：
  //    ① 直接写死目录的 prune 调用；② 通过 `debugDirs` 默认值传进去的。
  //    只查 ① 的话，把 `debugDirs ?? ['smoke', 'browser']` 一改就静默失效（实测过）。
  //    这条有区分力由 `_tools/_pairing_control.py` 的第 8 条破坏对照证明。
  const nProtectedTouch = countMatches(
    clSrc,
    /prune(?:ByAge|Tree|DbBackups|ResumeBackups)\(\s*path\.join\(DATA_DIR,\s*'(browser|evidence|resume_tailored)'/g,
  );
  const nProtectedDefault = countMatches(clSrc, /debugDirs \?\? \[[^\]]*'(browser|evidence|resume_tailored)'/g);
  check('自动限额不碰 browser / evidence / resume_tailored',
    nProtectedTouch === 0 && nProtectedDefault === 0,
    `直接清理目标 ${nProtectedTouch} 处 / debugDirs 默认值 ${nProtectedDefault} 处 ⇒ 自动限额把不可再生的数据（登录态）或用户证据列进了清理目标`);

  check('收紧参数是导出的纯函数（可单测、不依赖文件系统）',
    countMatches(clSrc, /export function tightenParams\b/g) === 1,
    '否则"超 1.5 倍时收紧几档"只能靠跑真目录来验，成本高到没人会验');

  // 「清完仍然超」必须说清是**谁**占的 —— 否则用户看到的只有「仍超阈值」，
  // 会以为清理功能坏了（实测本机 browser 506MB + jd_images 234MB 占 89%，而这两块
  // 是**有意不自动清理**的）。
  // ⚠️ 用「赋值语句」而不是「出现过 stillOver/topDirs」做判据：后者只要某个字段名还在
  //    任何一处出现就绿，把真正干活的那行删掉都不会红（存在性 ≠ 区分力）。
  check('清理后仍超阈值时必须给出体积构成',
    countMatches(clSrc, /autoLimit\.topDirs = await dirBreakdown\(\d+\);/g) === 1
    && countMatches(clSrc, /autoLimit\.stillOver = overThreshold;/g) === 1,
    `topDirs 赋值 ${countMatches(clSrc, /autoLimit\.topDirs = await dirBreakdown\(\d+\);/g)} 处 / stillOver 赋值 ${countMatches(clSrc, /autoLimit\.stillOver = overThreshold;/g)} 处（各应为 1）`);
}

// ══════ 一次性配对码（同网段陌生人的准入闸门，2026-10-01） ══════
// 背景：`HOST=0.0.0.0` 时鉴权会自动开启，而控制台**把令牌注入给任何来自私有网段的请求**
// —— `canInjectToken` 只能按对方地址判断，而同一 Wi-Fi 下用户自己的手机与别人的笔记本
// 都是 192.168.x.x，地址这一维区分不了。于是"仅限可信 Wi-Fi"只是一句免责声明，
// 不是防线：同网段任何设备打开控制台就能拿到令牌，而令牌能触发真实投递。
// 配对码补上那条**带外信道**（码打在你屏幕上，别人看不到）。
//
// ⚠️ 这些断言的共同点是「**性质**」而不是「数字」：区分力来自
//    随机源是否可预测 / 码是否一次性 / 限速是否两道 / 凭证是否可验签。
//    行为正确性另由 `_tools/_pairing_probe.mjs`（21 条，真起两个后端）覆盖。
{
  const CT_ROOT4 = fileURLToPath(new URL('..', import.meta.url));
  const pairSrc = fs.readFileSync(path.join(CT_ROOT4, 'server/services/pairing.ts'), 'utf8');
  const authSrc4 = fs.readFileSync(path.join(CT_ROOT4, 'server/services/authToken.ts'), 'utf8');
  const idxSrc4 = fs.readFileSync(path.join(CT_ROOT4, 'server/index.ts'), 'utf8');

  check('配对码用密码学随机（Math.random 是可预测的，等于没码）',
    countMatches(pairSrc, /crypto\.randomInt\(/g) >= 1 && countMatches(pairSrc, /Math\.random\(/g) === 0,
    `randomInt ${countMatches(pairSrc, /crypto\.randomInt\(/g)} / Math.random ${countMatches(pairSrc, /Math\.random\(/g)}`);

  // ⚠️ 判据用**整条赋值语句**而不是 `rotatePairCode()` 的出现次数：后者在
  //    `getPairCode()` 里也调用一次，阈值定成 ≥2 时，把配对成功后的那次轮换删掉
  //    仍然绿（实测踩到第二条"假区分力"）。
  check('配对码是一次性的（配对成功后立即轮换）',
    countMatches(pairSrc, /const next = rotatePairCode\(\);/g) === 1,
    `实际 ${countMatches(pairSrc, /const next = rotatePairCode\(\);/g)} 处 ⇒ 不轮换的话旧码可被无限复用，"一次性"名存实亡`);

  check('配对失败有速率限制，且单 IP 与全局两道',
    countMatches(pairSrc, /recentFails\(ip\)\.length >= MAX_FAIL_PER_IP/g) === 1
    && countMatches(pairSrc, /recentFails\(GLOBAL_KEY\)\.length >= MAX_FAIL_GLOBAL/g) === 1,
    '只按单 IP 限可被"改静态 IP / 多网卡"绕开；只按全局限会被一个坏客户端拖住所有人');

  check('设备凭证用 HMAC 验签（不是"随机串在册即认"）',
    countMatches(pairSrc, /createHmac\('sha256'/g) >= 1 && countMatches(pairSrc, /safeEqual\(/g) >= 2,
    '裸随机串无法离线判真伪；HMAC 把"验签"与"是否在册"分开，撤销一台设备不必轮换密钥、也不踢掉其它设备');

  // ⚠️ 判据必须精确到「`/` 路由那一行条件」，不能只查 `isLoopbackIp(` 是否存在：
  //    同一个文件里的 `/api/pair/code` 路由**也**用 `isLoopbackIp(req.socket?.remoteAddress …)`。
  //    只查函数名的话，把 `/` 路由里的回环豁免删掉，断言仍然绿（实测踩到）—— 典型的"假区分力"。
  check('🔴 回环地址免配对（本机自用零打扰）',
    countMatches(idxSrc4, /PAIRING_ENABLED && !isLoopbackIp\(req\.socket\?\.remoteAddress \|\| ''\) && !isPairedRequest\(req\)/g) === 1,
    '少了这一步，用户在自己电脑上打开控制台也要输配对码 —— 为了安全把正常使用也堵上');

  check('🔴 配对页 HTML 里绝不出现令牌注入',
    !fs.readFileSync(path.join(CT_ROOT4, 'public/pair.html'), 'utf8').includes('__AUTH_TOKEN__'),
    '配对页若带令牌，等于把闸门本身当成钥匙发给每一个敲门的人');

  check('匿名放行的配对路径是**显式清单**（不是前缀放行）',
    countMatches(authSrc4, /PAIR_PAGE_PATHS = \['\/pair', '\/pair\.html'\]/g) === 1
    && countMatches(authSrc4, /PAIR_ANON_POST_PATHS = \['\/api\/pair'\]/g) === 1,
    '改成 startsWith 放行整个前缀，等于任何人往那个目录丢个文件就自动公开');

  check('配对闸门可关（PAIRING=off 回退到"地址即信任"的旧行为）',
    countMatches(pairSrc, /process\.env\.PAIRING/g) === 1,
    '没有开关的安全机制在用户自己完全可控的网络里会变成纯粹的负担，最后被整体关掉');
}

// ═══════════════════════════════════════════════════════════════════════════
// 发布时间（posted_at）—— 「只投今天新开的岗位」
//
// 这组断言的核心不是「有没有这个字段」，而是**别把两件事搞混**：
//   posted_at —— 岗位什么时候发布的（平台口径）
//   created_at —— 我们什么时候采集到的
// 任何一处退回 created_at，功能就名存实亡，而且**不会报任何错**：
// 用户只会在「只看今天」里看到一批挂了半个月的岗位，根本不会怀疑是筛选坏了。
// ═══════════════════════════════════════════════════════════════════════════
{
  const RT = fileURLToPath(new URL('..', import.meta.url));
  const readT = (p: string) => fs.readFileSync(path.join(RT, p), 'utf8');
  const dbT = readT('server/db.ts');
  const pfT = readT('server/services/postedFilter.ts');
  const btT = readT('server/services/apply/batch.ts');
  const cT = readT('public/console.html');
  // ⚠️ HTML **不能**用 countMatches：stripComments 是给 JS/TS 写的，它不认 `<!-- -->`，
  //    `console.html` 里描述本功能的注释含 `postedWithin` 等词，会去「满足」断言
  //    （本仓库已多次踩到"自己的注释满足断言"）。故 HTML 一律按原始串计数。
  const nth = (s: string, needle: string) => s.split(needle).length - 1;

  check('jobs 建表含 posted_at 列',
    countMatches(dbT, /^\s*posted_at TEXT,$/gm) === 1,
    `实际 ${countMatches(dbT, /^\s*posted_at TEXT,$/gm)} 处`);

  // CREATE TABLE IF NOT EXISTS 对**已存在的表**完全不起作用 ⇒ 老用户只能靠这段迁移。
  // 而新装用户永远发现不了它坏了（新库一次就建对），所以必须单独钉住。
  check('🔴 老库自动补 posted_at 列（用户库是老的，CREATE TABLE IF NOT EXISTS 帮不上忙）',
    countMatches(dbT, /if \(!jc5\.some\(\(c\) => c\.name === 'posted_at'\)\) \{/g) === 1
    && countMatches(dbT, /ALTER TABLE jobs ADD COLUMN posted_at TEXT/g) === 1,
    '缺这段，升级后的老库会直接报 no such column: posted_at');

  check('posted_at 进了列白名单（防「列名来自对象键」注入）',
    countMatches(dbT, /'jd_source', 'ocr_status', 'posted_at', 'remote', 'status',/g) === 1);

  check('upsertJob 从 card_text 自动解析（已有采集器零改动获得发布时间）',
    countMatches(dbT, /const guess = parsePostedAt\(job\.card_text\)\.date;/g) === 1);

  // 这条是「刻意不做」的反向断言。实测 1202 条真实 JD：全文解析命中仅 2%，
  // 且剩下的几乎全是「工作时间9-18」「公司成立日期」「宣讲会时间」这类噪声。
  check('🔴 jd 只走「带字段名」精确通道，不做全文解析',
    countMatches(dbT, /const guess = postedAtFromLabeled\(job\.jd\);/g) === 1
    && countMatches(dbT, /parsePostedAt\(job\.jd\)/g) === 0,
    '把 jd 丢进全规则解析器，会把「工作时间9-18」当成 9 月 18 日发布');

  check('筛选实现放在独立纯模块（batch.ts 会拉起整个浏览器栈，没法单测）',
    countMatches(pfT, /export function filterByPostedWindow/g) === 1
    && countMatches(btT, /import \{ filterByPostedWindow \} from '\.\.\/postedFilter\.js';/g) === 1);

  check('🔴 posted_at 不再做时区换算（它已经是当地日历日期）',
    countMatches(pfT, /\.exec\(String\(j\.posted_at\)\)/g) === 1
    && countMatches(pfT, /localDateOf\(j\.posted_at/g) === 0,
    '再做一次换算，会让 UTC-5 这类时区的 2026-09-02 变成 09-01 —— 凭空差一天且不报错');

  check('🔴 created_at 必须换本地日历（直接截前 10 位会在 UTC+8 的清晨把今天筛空）',
    countMatches(pfT, /effective = localDateOf\(j\.created_at, o\);/g) === 1);

  check('选了发布时间窗但筛出 0 条时给出专门的诊断',
    countMatches(btT, /posted\.days != null && posted\.jobs\.length === 0/g) === 1,
    '否则会落到「被筛选条件（城市/薪资/匹配分）过滤掉了」那句，把用户引去调城市和薪资 —— '
    + '而真正的原因是库里没有这个时间窗内的岗位（实测 2026-10-03 选「今天」必然 0 条，看起来极像 bug）');

  check('控制台有发布时间下拉并透传',
    nth(cT, 'id="batchPostedWithin"') === 1
    && nth(cT, "postedWithin: $('#batchPostedWithin').value || 'any',") === 1);

  check('控制台有「缺发布时间按采集时间算」开关并透传',
    nth(cT, 'id="batchPostedFallback"') === 1
    && nth(cT, "postedFallback: $('#batchPostedFallback').checked,") === 1);

  check('控制台把「仅预览」与「官网通道真实提交」分开（双通道闸门）',
    nth(cT, 'id="batchRealSend"') === 1
    && nth(cT, "realSend: $('#batchRealSend').checked,") === 1,
    '此前 UI 没有 realSend 入口，官网通道恒为预览 —— 用户以为在真投，其实只填了表');
}

/* ===== 岗位台（校招信息库 / 添加岗位 / 我的投递） =====
   这批断言刻意**锚在 console.html 的具体元素上**，而不是只 `includes` 一个字符串。
   理由：「面板 → 端点」这类功能最危险的失效形态是**后端闸门还在、前端入口没了** ——
   此时门禁全绿（后端断言只测后端），用户点了没反应也不报错。
   而只 `includes('jaCompany')` 同样会因 JS 里出现的同名字符串恒绿，
   所以每条都要求「元素 id」与「真实端点调用」同时**恰好命中 1 次**。 */
{
  const cH = fs.readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
  // ⚠️ HTML 注释里也写着 `<a>` / `data-view` 这类字样，会去「满足」下面第一条断言 ⇒ 先剥注释再匹配。
  //    （stripComments 不认 HTML 的 <!-- -->，所以这里单独剥一遍。）
  const cHtml = cH.replace(/<!--[\s\S]*?-->/g, '');
  const n1 = (hay: string, needle: string) => hay.split(needle).length - 1;

  check('侧栏分两组：求职工作台 / 投递执行',
    n1(cHtml, '<div class="grp">求职工作台</div>') === 1
    && n1(cHtml, '<div class="grp">投递执行</div>') === 1);

  check('三个新导航项都在侧栏（各恰好 1 次）',
    n1(cHtml, 'data-view="jobs"') === 1
    && n1(cHtml, 'data-view="jobsadd"') === 1
    && n1(cHtml, 'data-view="apps"') === 1);

  check('#nav 里每个导航项都带 data-view（没有的会被当成「切到 undefined 视图」）',
    (() => {
      const nav = (cHtml.match(/<nav class="nav" id="nav">([\s\S]*?)<\/nav>/) || [])[1] || '';
      const as = nav.match(/<a\b[^>]*>/g) || [];
      return as.length >= 10 && as.every((a) => /\bdata-view="/.test(a));
    })());

  check('三个新视图容器存在',
    n1(cHtml, 'id="view-jobs"') === 1
    && n1(cHtml, 'id="view-jobsadd"') === 1
    && n1(cHtml, 'id="view-apps"') === 1);

  check('VIEW_META 补齐三项（缺一项 navigate 里就直接 TypeError，整页白屏）',
    n1(cH, "jobs:{t:'校招信息库'") === 1
    && n1(cH, "jobsadd:{t:'添加岗位'") === 1
    && n1(cH, "apps:{t:'我的投递'") === 1);

  check('添加岗位：表单元素齐全（公司/岗位/城市/类型/链接/截止/JD）',
    ['jaCompany', 'jaPosition', 'jaCity', 'jaType', 'jaUrl', 'jaDeadline', 'jaJd']
      .every((id) => n1(cHtml, 'id="' + id + '"') === 1));

  check('添加岗位：保存真的打到 POST /api/jobs（不是只画了个按钮）',
    n1(cH, "api('/api/jobs', { method:'POST', body: JSON.stringify(body) })") === 1,
    '前端入口在、端点调用没了 ⇒ 点了没有任何反应，且不报任何错');

  check('添加岗位：岗位类型以 jobType 提交（后端不认直传的 job_type）',
    n1(cH, "jobType: $('#jaType').value || null,") === 1);

  check('校招信息库：loadJobs 真的向 /api/jobs 取数并渲染进 jobsTbl',
    // ⚠️ 这里**不能**用 `n1(cH, "api('/api/jobs')") === 1`：showJob（职位记录面板在用）里
    //    也有同一句 ⇒ 计数恒为 2 而失败。改成在 loadJobs 的**函数体内**找调用 ——
    //    既不受别处同名调用影响，也不会因为将来多一处调用而假红。
    (() => {
      const body = (cH.match(/async function loadJobs\(\)\{([\s\S]*?)\n\}/) || [])[1] || '';
      return body.length > 0 && /api\('\/api\/jobs'\)/.test(body);
    })()
    && n1(cHtml, 'id="jobsTbl"') === 1
    // 详情/删除的绑定已抽成 bindJobsRows(scope)：表格与卡片**共用一份**删除逻辑
    // （两处各写一遍必然漂移成「一处确认、一处不确认」）。断言随之钉住
    // 「绑定函数在」+「两个容器都调了它」+「选择器仍取 [data-jv]」。
    && n1(cH, 'function bindJobsRows(scope){') === 1
    && n1(cH, "$$(scope+' [data-jv]')") === 1
    && n1(cH, "bindJobsRows('#jobsTbl');") === 1
    && n1(cH, "bindJobsRows('#jobsCards');") === 1);

  check('校招信息库：截止倒计时按本地日历构造（不是截字符串前 10 位）',
    n1(cH, 'function deadlineInfo(dl, now){') === 1
    && n1(cH, 'new Date(Number(m[1]), Number(m[2])-1, Number(m[3]))') === 1);

  check('我的投递：状态流转真的打 PATCH /api/applications/:id',
    n1(cHtml, 'id="appsTbl"') === 1
    && n1(cH, "bindAppActions('#appsBoardCols');") === 1
    && n1(cH, "bindAppActions('#appsTbl');") === 1
    && n1(cH, "api('/api/applications/'+encodeURIComponent(s.dataset.appst), { method:'PATCH', body: JSON.stringify({ status: s.value }) })") === 1);
}

// ── 对齐 offerbiu 的六页：总览 / 我的投递看板 / AI 匹配 / 简历优化 / 投递复盘 / 个人中心 ──
// 这一节的断言全部**锚到元素或锚到整条语句**：前端「换皮」时后端闸门还在、UI 入口没了，
// 门禁却照样全绿 —— 所以「面板 → 端点」类功能必须证明「控件在」且「真打这个端点」。
{
  const pH = fs.readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
  const pHtml = pH.replace(/<!--[\s\S]*?-->/g, '');   // ⚠️ stripComments 不认 HTML 的 <!-- -->
  const cnt = (hay: string, needle: string) => hay.split(needle).length - 1;
  const navMatch = pHtml.match(/<nav class="nav" id="nav">([\s\S]*?)<\/nav>/);
  const navHtml = navMatch ? navMatch[1] : '';
  const sectionOf = (id: string) => {
    const m = pHtml.match(new RegExp(`<section class="view[^"]*" id="${id}">([\\s\\S]*?)</section>`));
    return m ? m[1] : '';
  };
  const jsBody = (name: string) => {
    const m = pH.match(new RegExp(`(?:async )?function ${name}\\(([\\s\\S]*?)\\n\\}`));
    return m ? m[1] : '';
  };

  // ---- 侧栏：前段完全按 offerbiu 的顺序，末尾另起「投递执行」组 ----
  const OB_ORDER = ['dashboard', 'apps', 'jobs', 'jobsadd', 'resume', 'resumemake', 'autofill', 'match', 'optimize', 'review', 'profile'];
  check('侧栏前 11 项按 offerbiu 顺序排（总览 → … → 个人中心），且恰好分两组',
    navHtml.length > 0
    && OB_ORDER.every((v, i) => {
      const a = navHtml.indexOf(`data-view="${v}"`);
      const next = i + 1 < OB_ORDER.length ? navHtml.indexOf(`data-view="${OB_ORDER[i + 1]}"`) : Number.MAX_SAFE_INTEGER;
      return a >= 0 && a < next;
    })
    && cnt(navHtml, 'class="grp"') === 2, '');
  check('本项目的投递执行组排在 offerbiu 组之后（不能机械照搬、把自家入口删了）',
    ['deliver', 'records', 'logs', 'advanced', 'enhance'].every((v) => {
      const i = navHtml.indexOf(`data-view="${v}"`);
      return i > navHtml.indexOf('data-view="profile"');
    }), '');
  check('不设「会员中心 / 免费福利」（本地免费工具放这两个入口就是假的）',
    !/会员中心|免费福利/.test(pHtml), '');

  // ---- 总览页 ----
  const dash = sectionOf('view-dashboard');
  check('总览页：4 张统计卡 + 本周投递趋势 + 3 天内截止 齐备',
    dash.length > 0
    && ['dTotal', 'dApplied', 'dInterview', 'dOffer', 'trendChart', 'soonList', 'ovMatch', 'ovAddJob']
      .every((id) => cnt(pHtml, `id="${id}"`) === 1), '');
  check('总览页：「已投递」写的是纯数字（取自投递台账，不再混进 appliedRate 百分比）',
    cnt(pH, "dApplied').textContent = acApplied") === 1
    && cnt(pH, 'appliedRate') === 0, '');
  check('总览页：趋势图真的调 GET /api/stats/trend',
    cnt(pH, "api('/api/stats/trend?days=7')") >= 1, '');
  check('总览页：3 天内截止清单真读 /api/jobs，且用 deadlineInfo 的本地日历判据',
    /api\('\/api\/jobs'\)/.test(jsBody('renderSoon')) && /deadlineInfo\(/.test(jsBody('renderSoon')), '');
  check('总览页：hero 两个按钮接的是真视图（AI 匹配 / 添加岗位）',
    cnt(pH, "btnOvMatch) btnOvMatch.addEventListener('click', ()=>navigate('match'))") === 1
    && cnt(pH, "btnOvAddJob) btnOvAddJob.addEventListener('click', ()=>navigate('jobsadd'))") === 1, '');

  // ---- A 批：三个「静默失效」的筛选控件（2026-10-04 功能对齐检测发现）----
  // 背景：`jobs.job_type` 与 `jobs.deadline` 在真实库里是 **0 / 2506**（招聘平台不提供），
  // 于是「全部类型」「全部截止状态」「3 天内截止」三类控件**恒空**，而且页面看着完全正常、
  // 点了也不报错 —— 「控件在 ≠ 功能生效」。判据升级：靠某一列筛/数的功能，
  // 验收必须先问「这一列的覆盖率是多少」。
  // ⚠️ 以下计数一律先剥注释：本批的注释里**引用**了反例串（`days === null || days >= 0`），
  //    不剥注释会让 `=== 0` 那类断言被注释满足或弄红。
  {
    const pCode = stripComments(pHtml);
    const jobsSection = sectionOf('view-jobs');
    const jobsAddSection = sectionOf('view-jobsadd');

    // 反向护栏：先证明「还有足量内联脚本可扫」。否则提取逻辑一旦失效，
    // 下面所有 `=== 0` 断言都会**恒绿**（该抓的没抓到，还看着一切正常）。
    check('A 批断言自检：剥注释后仍扫到足量内联脚本（防「扫描量为 0 ⇒ ==0 恒绿」）',
      pCode.length > 150000 && cnt(pCode, 'function renderJobs(){') === 1,
      `pCode.length=${pCode.length}`);

    check('校招信息库：类型筛选候选**只取数据实测值**（不再并写死的 JOB_TYPES 清单）',
      cnt(pCode, "const ts = Array.from(new Set(JOBS_CACHE.map(j=>String(j.job_type==null?'':j.job_type).trim()).filter(Boolean))).sort();") === 1
      && cnt(pCode, '.concat(JOB_TYPES)') === 0,
      '写死清单在数据为空时会凭空造出 10 个筛不出东西的选项');

    check('校招信息库：两个筛选下拉仍在（**禁用 ≠ 删除**，数据补上后必须能自动解禁）',
      cnt(jobsSection, 'id="jobsType"') === 1 && cnt(jobsSection, 'id="jobsDeadline"') === 1
      && cnt(jobsSection, 'value="open"') === 1 && cnt(jobsSection, 'value="soon"') === 1
      && cnt(jobsSection, 'value="expired"') === 1 && cnt(jobsSection, 'value="none"') === 1, '');

    check('校招信息库：某一列全空 ⇒ 禁用该下拉 + 给出原因；有数据时解禁并清掉 title',
      cnt(pCode, 'function jobsFilterAvailability(){') === 1
      && cnt(pCode, 'el.disabled = true;') === 1
      && cnt(pCode, "el.removeAttribute('title');") === 1
      && cnt(pCode, 'jobsFilterAvailability();') === 1,
      '函数 / 禁用 / 解禁 / 调用点，四处缺一不可');

    check('校招信息库 / 我的投递：「有截止数据」的判据共用同一套（自由文本截止日不算「有数据」）',
      cnt(pCode, "has: j=> deadlineInfo(j.deadline).days !== null") === 1
      && cnt(pCode, "if(k === 'soon')      return JOBS_POOL.some(j=> deadlineInfo(j.deadline).days !== null);") === 1,
      '两处若各写一套（一处非空、一处可解析），会出现「下拉可用但筛出来是空的」');

    check('校招信息库：「截止状态」的唯一判据是 deadlineMatch，且「未截止」排除「没填」',
      cnt(pCode, 'function deadlineMatch(key, days){') === 1
      && cnt(pCode, "if(key === 'open')    return days !== null && days >= 0;") === 1
      && cnt(pCode, 'days === null || days >= 0') === 0,
      '「没填截止」有独立档位，不能算进「未截止」——曾因此让这一档等于全量');

    check('校招信息库：表格筛选走同一个判据（不许两处各写一套）',
      cnt(pCode, 'if(dl && !deadlineMatch(dl, deadlineInfo(j.deadline).days)) return false;') === 1
      && cnt(pCode, "if(dl==='open'") === 0, '');

    check('校招信息库：被禁用的筛选器在说明行里写明原因（不能只让它变灰）',
      cnt(pCode, 'JOBS_FILTER_OFF.length') === 1
      && /筛选已禁用：岗位库里没有任何记录带这一项/.test(pCode), '');

    check('添加岗位：写明「岗位类型 / 截止日期」正是那两个筛选器的数据来源（给用户上架入口）',
      cnt(jobsAddSection, 'id="jaDeadline"') === 1
      && /两个筛选器的数据来源/.test(jobsAddSection), '');

    check('总览「3 天内截止」：区分「没有要截止的」与「根本没有截止数据」（后者显示 — 而不是 0）',
      cnt(pCode, 'const dated = jobs.filter(j=>deadlineInfo(j.deadline).days !== null).length;') === 1
      && cnt(pCode, "if(tag) tag.textContent = dated ? (soon.length + ' 个') : '—';") === 1
      && cnt(pCode, "if(tag) tag.textContent = soon.length + ' 个';") === 0, '');

    check('我的投递：池侧快筛项在无数据时被禁用，并写明「（无数据）」（不留点了没反应的按钮）',
      cnt(pCode, 'function appsQuickReady(k){') === 1
      && cnt(pCode, "if(k === 'soon')      return JOBS_POOL.some(j=> deadlineInfo(j.deadline).days !== null);") === 1
      && cnt(pCode, "(off ? ' disabled' : '')") === 1
      && cnt(pCode, "(off ? '（无数据）' : '')") === 1, '');

    check('我的投递：快筛条每次整体重建 + 失效档位自动退回「全部」（岗位池刷新后状态要跟着变）',
      cnt(pCode, 'function renderAppsQuick(){') === 1
      && cnt(pCode, 'renderAppsQuick();') === 1
      && cnt(pCode, "if(!appsQuickReady(APPS_QUICK_K)) APPS_QUICK_K = 'all';") === 1
      && cnt(pCode, 'qk.dataset.filled') === 0,
      '用 dataset.filled 只建一次 ⇒ 刷新后会留下「明明有数据却是灰的」');
  }

  // ---- B 批：校招信息库补齐（届别 + 快捷标签 + 重置筛选 + 卡片视图）----
  // 背景：A 批把「控件在 ≠ 功能生效」变成可验收的不变量，但当时**数据是空的**。
  // B 批把数据补上（`grad_year` / `tags` / `deadline` 三列 + 存量回填），
  // 顺带证明 A 批那套「无数据禁用 ⇒ 有数据自动解禁」真的会解禁。
  // ⚠️ 计数前一律先剥注释：本批注释里**引用**了被禁用的写法（`dataset.filled`、
  //    `(off ? ' disabled' : '')`），不剥会被自己的注释满足 ⇒ 假绿。
  {
    const pCode = stripComments(pHtml);
    const jobsSection = sectionOf('view-jobs');
    const dbSrc = fs.readFileSync(new URL('../server/db.ts', import.meta.url), 'utf8');
    const idxSrc = fs.readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8');
    const metaSrc = fs.readFileSync(new URL('../server/services/parseCardMeta.ts', import.meta.url), 'utf8');
    const bfSrc = fs.readFileSync(new URL('../scripts/backfill_card_meta.ts', import.meta.url), 'utf8');
    /** 抠出一个顶层函数的函数体（A 批同款手法）。抠不到返回空串 ⇒ 下面的 `>= 0` / `=== 0` 会红。 */
    const fnBody = (src: string, name: string) => {
      const m = src.match(new RegExp('(?:async )?function ' + name + '\\([^)]*\\)\\{([\\s\\S]*?)\\n\\}'));
      return m ? m[1] : '';
    };

    // 反向护栏：先证明「新结构的函数确实被扫到」。否则本块里的 `=== 0` 类断言会恒绿。
    check('B 批断言自检：本批新增的函数/元素都在（防「扫描量为 0 ⇒ 整段恒绿」）',
      cnt(pCode, 'function jobsFiltered(opt){') === 1
      && cnt(pCode, 'function jobsAvailTags(){') === 1
      && cnt(pCode, 'function renderJobsChips(){') === 1
      && cnt(pCode, 'function jobsResetFilters(){') === 1
      && cnt(pCode, 'function renderJobsTable(list){') === 1
      && cnt(pCode, 'function renderJobsCards(list){') === 1
      && cnt(pCode, 'function jobsApplyView(){') === 1
      && cnt(jobsSection, 'id="jobsGrad"') === 1, `pCode.length=${pCode.length}`);
    check('B 批断言自检：抠函数体的正则确有产出（防「fnBody 恒空 ⇒ 下面几条恒绿」）',
      fnBody(pCode, 'jobsResetFilters').length > 40 && fnBody(pCode, 'fillJobsFilters').length > 800,
      `reset=${fnBody(pCode, 'jobsResetFilters').length} fill=${fnBody(pCode, 'fillJobsFilters').length}`);

    // ① 届别
    check('校招信息库：届别下拉的候选**只取数据实测值**，并带条数（只有一个届时用户才明白为什么）',
      cnt(pCode, "const gs = Array.from(new Set(JOBS_CACHE.map(j=>jobGrad(j)).filter(Boolean))).sort().reverse();") === 1
      && cnt(pCode, 'rest.filter(j=>jobGrad(j) === g).length') === 1
      && cnt(pCode, 'jobGrad(j)') >= 3,
      '写死届别清单会造出筛不出东西的选项；不带条数则「只有一个可选值」看着像个坏了下拉');
    check('届别入库前被收敛成「4 位年份」单一形态（否则下拉会出现两个看着一样的选项，各筛一部分）',
      cnt(metaSrc, 'export function normalizeGradYear(') === 1
      && cnt(dbSrc, "if (k === 'grad_year') return normalizeGradYear(v);") === 1
      && cnt(dbSrc, 'cleaned.grad_year = normalizeGradYear(job.grad_year);') === 1,
      '库里混进 2027届 / 2027 届 时，用户完全无法察觉');

    // ② 标签
    check('快捷标签：「数据里真的有这个标签」只判一处（渲染哪些 与 撤回哪些 必须同源）',
      cnt(pCode, 'function jobsAvailTags(){') === 1
      && cnt(pCode, 'JOBS_CACHE.some(j=>jobHasTag(j, d.key))') === 1
      && cnt(pCode, 'const avail = jobsAvailTags();') === 1
      && cnt(pCode, 'new Set(jobsAvailTags().map(d=>d.key))') === 1, '');
    check('快捷标签：chip 上的数字 = **点下去会得到的条数**（多选时唯一自洽的口径）',
      cnt(pCode, 'jobsFiltered({ tags: new Set([...JOBS_TAGS, d.key]) }).length') === 1,
      '只跳过标签这一维的话，选中「秋招」后「免笔试」显示的是总条数，点下去却少一截 —— 数字与结果对不上比没数字更糟');
    check('快捷标签：当前筛选下 0 条的 chip 被禁用并写明原因；**已选中的永不禁用**',
      // ⚠️ E 批后 `const off = !on && n === 0;` 在**两个**函数里各有一份（标签 chip 与
      //    「近 7 天截止」chip，语义相同但分属两个维度）⇒ 全文件计数会是 2。
      //    这里要钉的是**标签 chip** 那一份 ⇒ 必须限定在 renderJobsChips 的函数体内。
      cnt(fnBody(pCode, 'renderJobsChips'), 'const off = !on && n === 0;') === 1
      && cnt(pCode, "const dis = off ? ' disabled' : '';") === 1
      && cnt(pCode, '（当前筛选下 0 条）') === 1,
      '禁用已选中的 chip = 用户无法取消它 = 被锁死在空结果上');
    check('快捷标签：一条数据都没有时说明原因，且区分「后端没下发定义」与「数据里没有标签」',
      cnt(pCode, '当前后端未下发标签定义（GET /api/jobs 的 tagDefs 字段）') === 1
      && cnt(pCode, '暂无快捷标签：岗位库里没有任何一条记录带标签') === 1, '');
    check('快捷标签：定义由服务端下发（前端不另抄一份 —— 抄了就是第二个真相源）',
      cnt(idxSrc, 'tagDefs: CARD_UI_TAGS });') === 1
      && cnt(pCode, 'JOBS_TAG_DEFS = (r && r.tagDefs) || [];') === 1
      && cnt(pCode, 'const JOBS_TAG_ORDER') === 0
      && cnt(pCode, "'免笔试','秋招','春招'") === 0,
      '前端再抄一份标签表：改一边漏一边时会渲染出后端不认识的标签，点下去恒 0 条且不报错');
    check('后端：标签取值受白名单约束（库里不可能有表外标签，前端才能只做 JSON.parse）',
      cnt(metaSrc, 'export const CARD_TAG_KEYS') === 1
      && cnt(metaSrc, '(CARD_TAG_KEYS as string[]).includes(k)') === 1
      && cnt(pCode, 'JSON.parse(String(j.tags))') === 1
      // ⚠️ 不能写 `cnt(pCode, 'catch(e){ return []; }') === 1`：别处（JD 长图 JSON 解析）
      //    也有一份一模一样的兜底 ⇒ 那条断言测的是**别人家的代码**，这里删了它照样绿。
      && fnBody(pCode, 'jobTags').indexOf('return [];') >= 0,
      '前端刻意不重做归一化，靠的就是后端这层白名单；解析失败必须返回 [] 而不是让整页白屏');
    check('「研究所」不是企业性质取值，而是公司名关键词（语义与字面不一致 ⇒ 写进 hint）',
      cnt(metaSrc, '公司名里含「研究所」') === 1
      && cnt(metaSrc, "head.includes('研究所')") === 1
      && cnt(metaSrc, 'isNatureToken') >= 3,
      '子串匹配会把它算成企业性质；实测 token 等值 0 条、公司名关键词 39 条');

    // ③ 重置筛选
    check('校招信息库：重置筛选把搜索框 + 全部下拉 + 快捷标签一起清掉（控件清单只声明一处）',
      cnt(pCode, "const JOBS_FILTER_SELECTS = ['#jobsSource','#jobsCity','#jobsType','#jobsGrad','#jobsDeadline'];") === 1
      && cnt(pCode, 'JOBS_FILTER_SELECTS.forEach(sel=>{') === 2
      && cnt(pCode, 'JOBS_TAGS.clear();') === 1
      && cnt(pCode, "const q = $('#jobsQ'); if(q) q.value = '';") === 1
      && cnt(pCode, "JOBS_FILTER_SELECTS.filter(sel=> sel !== '#jobsDeadline')") === 1,
      '重置与事件绑定各抄一份清单 ⇒ 将来加下拉只会加进一份，表现是「重置后某个下拉还留着上次的值」');
    check('校招信息库：重置**不动视图**（视图是「我怎么看」不是「我筛什么」）',
      cnt(fnBody(pCode, 'jobsResetFilters'), 'JOBS_VIEW') === 0
      && cnt(fnBody(pCode, 'jobsResetFilters'), 'jobsApplyView') === 0, '');

    // ④ 双视图
    check('校招信息库：表格/卡片双视图齐备（两个容器 + 两个切档按钮 + 网格类）',
      cnt(jobsSection, 'id="jobsTableWrap"') === 1
      && cnt(jobsSection, 'id="jobsCards"') === 1
      && cnt(jobsSection, 'id="jobsViewTabs"') === 1
      && cnt(jobsSection, 'data-jobview="table"') === 1
      && cnt(jobsSection, 'data-jobview="card"') === 1
      && cnt(jobsSection, 'class="kcg"') === 1, '');
    check('校招信息库：两块容器**互斥显示**，切视图走同一个渲染入口（不留「隐藏的那半是旧的」）',
      cnt(fnBody(pCode, 'jobsApplyView'), "JOBS_VIEW === 'card'") === 2
      && cnt(pCode, "if(JOBS_VIEW === 'card') renderJobsCards(list); else renderJobsTable(list);") === 1
      && cnt(pCode, 'JOBS_VIEW = b.dataset.jobview;') === 1,
      '两个视图各渲染一次的话，每次按键建两遍 DOM，且隐藏的那个会与可见的不同步');
    check('校招信息库：卡片视图复用「我的投递」的**同一份**卡片渲染器（两处各写一份必然漂移）',
      cnt(pCode, 'function jobCardHtml(j, actions){') === 1
      && cnt(pCode, 'jobCardHtml(x)') === 1
      && fnBody(pCode, 'renderJobsCards').indexOf('jobCardHtml(') >= 0
      && fnBody(pCode, 'jobCardHtml').indexOf('const tg = jobTags(j);') >= 0,
      '卡片只读库里的 grad_year / tags 列：自行解析 card_text 会出现「卡片写着免笔试、筛选却筛不到它」');
    check('卡片样式选择器覆盖**两个**容器（只写 .kb 的话卡片视图没有边框/淘汰线，且不报错）',
      cnt(pCode, '.kb .kcard, .kcg .kcard{') === 1
      && cnt(pCode, '.kb .kcard .m, .kcg .kcard .m{') === 1
      && cnt(pCode, '.kb .kcard .tn, .kcg .kcard .tn{') === 1
      && cnt(pCode, '.kb .kcard .tn.warn, .kcg .kcard .tn.warn{') === 1, '');

    // ⑤ 判据唯一化 + 候选不再是「只建一次」
    check('校招信息库：表格 / 卡片 / chip 计数 / 届别计数**共用同一个**筛选判据',
      cnt(pCode, 'function jobsFiltered(opt){') === 1
      && cnt(pCode, 'const list = jobsFiltered();') === 1
      && cnt(pCode, 'jobsFiltered({ skipGrad: true })') === 1
      && cnt(pCode, 'jobsFiltered({ tags: new Set([...JOBS_TAGS, d.key]) })') === 1
      && cnt(pCode, 'const list = all.filter(') === 0,
      '各写一套的话，chip 上显示 12 条、点下去出来 7 条，谁都不知道该信哪个');
    check('校招信息库：下拉候选不再「只建一次」（采集到新平台/新城市后下拉必须跟着变）',
      // ⚠️ 不能写 `cnt(pCode, 'dataset.filled') === 0`：**另外 4 个页面**（职位记录 / 简历 /
      //    复盘 / 高级）还有 13 处既有用法，A 批只删掉了 renderAppsQuick 里的那一处。
      //    断言必须钉在**本页这个函数**里，否则测的是别人家的代码。
      fnBody(pCode, 'fillJobsFilters').indexOf('dataset.filled') < 0
      && cnt(pCode, 'function setJobsOptions(sel, html, want, label){') === 1
      && cnt(pCode, 'JOBS_FILTER_DROPPED.push(label);') === 1
      && cnt(pCode, 'JOBS_FILTER_DROPPED.length') === 1,
      '只建一次 ⇒ 新出现的取值永远进不了下拉，用户筛不到自己刚采回来的岗位，且不报错');
    check('校招信息库：重建候选时**保住用户已选的值**，取值消失了必须显式记一笔',
      cnt(fnBody(pCode, 'fillJobsFilters'), 'keep[sel] = jobsCtlVal(sel);') === 1
      && cnt(fnBody(pCode, 'fillJobsFilters'), 'setJobsOptions(') === 4
      && cnt(pCode, "if(w && el.value !== w){ el.value = ''; JOBS_FILTER_DROPPED.push(label); }") === 1, '');

    // ⑥ 数据层
    check('jobs 表用 PRAGMA 判定后 ALTER 加列（CREATE TABLE IF NOT EXISTS 对已存在的表完全无用）',
      cnt(dbSrc, "addJobCol('grad_year');") === 1
      && cnt(dbSrc, "addJobCol('tags');") === 1
      && cnt(dbSrc, 'ALTER TABLE jobs ADD COLUMN ${name} TEXT') === 1, '');
    check('grad_year / tags 在**四处**写入链路上同步（漏一处 ⇒ 列存在但永远写不进去）',
      cnt(dbSrc, "'grad_year', 'tags',") === 1
      && cnt(dbSrc, "'grad_year', 'tags'] as const;") === 1
      && cnt(dbSrc, 'grad_year, tags, match_score') === 1
      && cnt(dbSrc, '@posted_at, @grad_year, @tags, @match_score') === 1
      && cnt(dbSrc, "'grad_year' | 'tags'") === 1
      && cnt(dbSrc, 'grad_year: job.grad_year ?? null,') === 1,
      '列清单 / 白名单 / upsertJob 的 UPDATABLE / INSERT / 绑定参数 / PATCH 的 Pick，任何一处漏掉都是「列在、值永远为空」');
    check('届别/标签/截止日的派生口径只有一份（upsertJob 与回填脚本共用 parseCardMeta）',
      cnt(dbSrc, "from './services/parseCardMeta.js'") === 1
      && cnt(bfSrc, "from '../server/services/parseCardMeta.js'") === 1
      // ⚠️ 三个 needle 都给到**整行**：`parseCardMeta(job.card_text)` 这种短串在注释里
      //    也会出现（本批的注释就在解释这段逻辑），计数会凭空多 1 而让断言红在错的地方。
      && cnt(dbSrc, 'const gy = (job.card_text ? parseCardMeta(job.card_text).gradYear : null)') === 1
      && cnt(dbSrc, 'const tg = job.card_text ? serializeTags(parseCardMeta(job.card_text).tags) : null;') === 1
      && cnt(bfSrc, 'const meta = r.card_text ? parseCardMeta(r.card_text) : null;') === 1
      && cnt(bfSrc, 'const jdGy = parseGradYear(r.jd);') === 1
      // 两份文件都不许再出现自己的「20xx 届」正则（那才是真正的第二份解析规则）
      && cnt(dbSrc, '/20\\d\\d\\s*届/') === 0
      && cnt(bfSrc, '/20\\d\\d\\s*届/') === 0,
      '两份规则必然漂移，而漂移的表现是「新采集的筛得到、老岗位筛不到」，不会有任何报错');
    check('tags / deadline 刻意**只认 card_text**（正文里的「无需笔试」与卡片字段不是一回事）',
      cnt(dbSrc, 'const tg = job.card_text ? serializeTags(parseCardMeta(job.card_text).tags) : null;') === 1
      && cnt(dbSrc, 'if (job.deadline === undefined && job.card_text) {') === 1
      && cnt(dbSrc, 'parseCardMeta(job.jd).tags') === 0, '');
    check('回填脚本可预览、只填空值（不许用低置信度来源覆盖显式值）',
      cnt(bfSrc, 'const has = (v: string | null) => !!(v && String(v).trim());') === 1
      && cnt(bfSrc, "const DRY_RUN = flag('dry-run');") === 1
      && cnt(bfSrc, 'if (!has(r.grad_year) && d.gradYear) patch.grad_year = d.gradYear;') === 1
      && cnt(bfSrc, 'if (!has(r.tags) && d.tags) patch.tags = d.tags;') === 1
      && cnt(bfSrc, 'if (!has(r.deadline) && d.deadline) patch.deadline = d.deadline;') === 1, '');
  }

  // ---- C 批：个人中心汇总（三源：岗位库 / 磁盘台账 / 本机 localStorage） ----
  // ⚠️ 三源必须分开显示，合并显示 = 用户以为「历史只存在自己这台机器上」。
  {
    const pCode = stripComments(pHtml);
    const dbSrc = fs.readFileSync(new URL('../server/db.ts', import.meta.url), 'utf8');
    // 🔴 server/index.ts 是 **CRLF**（db.ts / console.html 是 LF，本仓库 EOL 本就不统一）。
    //    跨行 needle 里写死 `\n` 在 CRLF 文件上**静默不匹配**（不报错、断言直接红在错的地方）——
    //    本批写 `'[limit]\n    );'` 时实测就中了。这里统一归一成 `\n` 再断言。
    const iSrc = stripComments(fs.readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8'))
      .replace(/\r\n/g, '\n');
    const fnBody = (src: string, name: string) => {
      const m = src.match(new RegExp('(?:async )?function ' + name + '\\([^)]*\\)\\{([\\s\\S]*?)\\n\\}'));
      return m ? m[1] : '';
    };
    /** 抠出「端点 A 到端点 B 之间」的那段源码 —— 用来断言某个 handler 内部没干坏事。 */
    const between = (src: string, a: string, b: string) => {
      const i = src.indexOf(a), j = src.indexOf(b);
      return i >= 0 && j > i ? src.slice(i, j) : '';
    };

    // 反向护栏：先证明扫到了东西，否则下面所有 `=== 0` / `< 0` 类断言都会恒绿。
    check('C 批断言自检：新增的三个端点与两个函数都在（防「扫描量 0 ⇒ 整段恒绿」）',
      cnt(iSrc, 'app.get("/api/stats/summary"') === 1
      && cnt(iSrc, 'app.get("/api/stats/match-history"') === 1
      && cnt(iSrc, 'app.get("/api/resume/tailored-history"') === 1
      && cnt(pCode, 'async function loadProfileStats(p){') === 1
      && cnt(pCode, 'async function loadProfileHistory(){') === 1
      && fnBody(pCode, 'loadProfile').length > 200
      && fnBody(pCode, 'loadProfileStats').length > 600,
      `loadProfile=${fnBody(pCode, 'loadProfile').length} stats=${fnBody(pCode, 'loadProfileStats').length}`);

    check('个人中心「数据概览」不再为数个数拉全量（改走 /api/stats/summary 的 SQL 聚合）',
      cnt(pCode, "api('/api/stats/summary')") === 1
      // 🔴 判据必须是「loadProfile 函数体内不再出现全量拉取」：只查「文件里有 /api/stats/summary」
      //    会恒绿（别处也能用到这个端点），证明不了老的全量拉取被去掉了。
      && fnBody(pCode, 'loadProfile').indexOf("/api/jobs'") < 0
      && fnBody(pCode, 'loadProfile').indexOf("/api/applications'") < 0,
      '原来为 5 个数字拉 2500+ 条岗位 + 全量投递记录，岗位池越大页面越慢');
    check('/api/stats/summary 只做 SQL 聚合（handler 内不许出现 listJobs / listApplications 全量捞取）',
      between(iSrc, 'app.get("/api/stats/summary"', 'app.get("/api/stats/match-history"').length > 300
      && between(iSrc, 'app.get("/api/stats/summary"', 'app.get("/api/stats/match-history"').indexOf('db.listJobs') < 0
      && between(iSrc, 'app.get("/api/stats/summary"', 'app.get("/api/stats/match-history"').indexOf('db.listApplications') < 0,
      '在应用层捞全表再 .length，等于把「只回计数」做成了「回全量」，端点就白开了');
    check('matched_at 在**五处**同步（CREATE / ALTER / 白名单 / JobRow / updateJob 的 Pick）',
      cnt(dbSrc, '    matched_at TEXT,') === 1
      && cnt(dbSrc, "addJobCol('matched_at');") === 1
      && cnt(dbSrc, "'grad_year', 'tags', 'matched_at',") === 1
      && cnt(dbSrc, 'matched_at: string | null;') === 1
      && cnt(dbSrc, "'grad_year' | 'tags' | 'matched_at'") === 1,
      // 这条是本批实测踩出来的：前四处都改了、只漏 updateJob 那份**硬编码的 Pick 类型**，
      // 报错是 TS2353「matched_at does not exist in type Partial<Pick<JobRow, ...>>」——
      // 它绝不告诉你「你漏了列同步清单里的第五处」。
      '漏 updateJob 的 Pick ⇒ 编译期才炸，且报错只说类型不匹配、不说是列同步问题');
    check('两个匹配入口都写 matched_at（只改一处 ⇒ 那一路的历史没有时刻、排序错乱且不报错）',
      cnt(iSrc, 'matched_at: new Date().toISOString()') === 2, '');
    check('匹配历史**服务端为准**：读库而非 localStorage；老数据标 atUnknown、不伪装成精确时刻',
      // ⚠️ 第一版这里锚的是 ORDER BY 那一行，结果和「limit 参数绑定」那条断言共用同一个 needle
      //    ⇒ 改 LIMIT 会把**两条**一起弄红（对照跑出来才发现）。改成锚「读的是 jobs 表」这一行，
      //    两条断言才各自独立。
      cnt(iSrc, '+ "FROM jobs WHERE match_score IS NOT NULL "') === 1
      && cnt(iSrc, 'atUnknown: !r.matched_at,') === 1
      && cnt(pCode, "api('/api/stats/match-history?limit=8')") === 1,
      '分数本来就在库里；用它当真相源后 localStorage 退化为「没有岗位行」那类的补位');
    check('match-history 的 limit 走参数绑定且被夹取（拼进 SQL 的必须是整数，不能是原始 query 串）',
      cnt(iSrc, 'Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 1), 200) : 30') === 1
      && cnt(iSrc, '"ORDER BY COALESCE(matched_at, updated_at) DESC LIMIT ?",') === 1
      && cnt(iSrc, '[limit]\n    );') === 1, '');
    check('简历优化历史只回 basename 拼的静态 URL（回绝对路径等于把服务端目录结构泄漏出去）',
      cnt(iSrc, "url: `/data/resume_tailored/${base}.pdf`,") === 1
      && cnt(iSrc, "hasPdf: fs.existsSync(path.join(TAILORED_DIR, base + '.pdf')),") === 1
      && cnt(iSrc, '/data/resume_tailored/${path.basename(') >= 1,
      '产物可能已被清理策略删掉 ⇒ 先 existsSync 再给链接，不给死链');
    check('历史区把「已入库」与「仅本机」分开显示（混着显示 ⇒ 用户以为历史只存在本机）',
      cnt(pCode, 'matchHistoryList().filter(function(r){ return !(r && r.job && r.job.id); })') === 1
      && cnt(pCode, '只存在这台浏览器') === 1, '');
  }

  // ---- E 批：「近 7 天截止」快捷 chip ----
  // ⚠️ 三条不变量：判据复用 deadlineMatch 的 soon 档 / 状态写在 #jobsDeadline / 不进 tagDefs。
  {
    const pCode = stripComments(pHtml);
    const metaSrc = fs.readFileSync(new URL('../server/services/parseCardMeta.ts', import.meta.url), 'utf8');
    const fnBody = (src: string, name: string) => {
      const m = src.match(new RegExp('(?:async )?function ' + name + '\\([^)]*\\)\\{([\\s\\S]*?)\\n\\}'));
      return m ? m[1] : '';
    };

    check('E 批断言自检：截止 chip 的两个函数都在（防「扫描量 0 ⇒ 整段恒绿」）',
      cnt(pCode, 'function jobsSoonChipHtml(){') === 1
      && fnBody(pCode, 'jobsSoonChipHtml').length > 500
      && fnBody(pCode, 'renderJobsChips').length > 900,
      `soon=${fnBody(pCode, 'jobsSoonChipHtml').length} chips=${fnBody(pCode, 'renderJobsChips').length}`);
    check('截止 chip 的**判据就是 deadlineMatch 的 soon 档**（不许另写一份日期比较）',
      cnt(pCode, "const n = jobsFiltered({ dl:'soon' }).length;") === 1
      && cnt(pCode, "const dl = (o.dl !== undefined) ? o.dl : jobsCtlVal('#jobsDeadline');") === 1
      && cnt(pCode, "if(key === 'soon')    return days !== null && days >= 0 && days <= 7;") === 1,
      '另写一份就是第二个「几天内」口径，漂移的表现是「chip 显示 3 条、点下去 0 条」且无报错');
    check('截止 chip 的**状态写在 #jobsDeadline 上**（不另设变量 ⇒ 重置筛选天然清掉它）',
      cnt(pCode, "const on = jobsCtlVal('#jobsDeadline') === 'soon';") === 1
      // 🔴 反向：出现 `let JOBS_SOON` 之类的第二份状态，重置就会「清了下拉、chip 还亮着」
      && cnt(pCode, 'JOBS_SOON') === 0
      && cnt(fnBody(pCode, 'jobsSoonChipHtml'), 'JOBS_SOON') === 0, '');
    check('截止 chip **不进 tagDefs**（那是卡片标签维度，服务端才是真相源）',
      cnt(pCode, 'data-jdl="soon"') === 1
      && cnt(pCode, '$$(\'#jobsChips [data-jdl]\')') === 1
      // 服务端下发的标签定义里不许出现「截止」这类非卡片标签的 key
      && cnt(metaSrc, "key: 'soon'") === 0,
      '混进去会让服务端背上它不该管的口径，且前端改文案时两边必然漂移');
    check('截止 chip **无条件渲染**（旧写法在「没有标签」时早退，会把它一起吞掉）',
      cnt(pCode, "let html = '<span class=\"note small\" style=\"align-self:center\">快捷关注</span>' + jobsSoonChipHtml();") === 1
      && fnBody(pCode, 'renderJobsChips').indexOf('if(!avail.length){\n    //') < 0
      && fnBody(pCode, 'renderJobsChips').indexOf('jobsSoonChipHtml()') >= 0, '');
    check('截止 chip 已选中时**永不禁用**（禁用 = 把用户锁死在 0 条上）',
      cnt(pCode, "const dis = ((off || !hasData) && !on) ? ' disabled' : '';") === 1, '');
  }

  // ---- 我的投递：看板视图 ----
  check('我的投递：看板 / 表格双视图 + 搜索 + 快速筛选 + 导出 + 添加 齐备',
    ['appsBoardCols', 'appsViewTabs', 'appsQuick', 'appsTableWrap', 'appsQ', 'appsExport', 'appsAddJob', 'appsRefresh']
      .every((id) => cnt(pHtml, `id="${id}"`) === 1), '');
  check('我的投递：看板列由 APP_STAGES 驱动（本项目的真实状态口径），不列永远为空的列',
    cnt(pH, 'const APP_STAGES = [') === 1 && cnt(pH, 'APP_STAGES.map(') === 1
    && cnt(pH, "key:'candidate', label:'待投递', from:'job'") === 1, '');
  check('我的投递：删掉了已不存在的筛选元素引用（appsPlatform / appsStatus 引用数为 0）',
    cnt(pH, 'appsPlatform') === 0 && cnt(pH, 'appsStatus') === 0, '');
  check('我的投递：导出真的产出 CSV 文件（Blob + 下载）',
    /function exportAppsCsv\(/.test(pH) && cnt(pH, "'text/csv;charset=utf-8'") === 1, '');
  check('我的投递：状态流转仍然真的打 PATCH（看板卡片与表格两条路径共用同一绑定）',
    /function bindAppActions\(/.test(pH)
    && cnt(pH, "bindAppActions('#appsBoardCols');") === 1
    && cnt(pH, "bindAppActions('#appsTbl');") === 1, '');

  // ---- 四个新页面：元素齐备 且 真打端点 ----
  check('AI 匹配页：元素齐备',
    ['mtResume', 'mtResumeNote', 'mtSrcTabs', 'mtJob', 'mtPasteJd', 'mtRun', 'mtResult', 'mtHistory', 'mtHistoryBody']
      .every((id) => cnt(pHtml, `id="${id}"`) === 1), '');
  check('AI 匹配页：真的打 POST /api/jobs/match-one（单岗位，避免全量打分的慢与贵）',
    cnt(pH, "api('/api/jobs/match-one', { method:'POST', body: JSON.stringify(body) })") === 1, '');
  check('简历优化页：全量优化与出一岗一简历分别打两个真端点',
    cnt(pH, "api('/api/jobs/tailor', { method:'POST', body: JSON.stringify({ jobId: id }) })") === 1
    && cnt(pH, "api('/api/jobs/tailor-resume', { method:'POST', body: JSON.stringify({ jobId: id }) })") === 1, '');
  check('投递复盘页：统计卡 + 本周节奏 + 阶段分布 + 明细 齐备',
    ['rvStats', 'rvChart', 'rvChartNote', 'rvStages', 'rvList', 'rvCount']
      .every((id) => cnt(pHtml, `id="${id}"`) === 1), '');

  // ---- 投递流程时间节点 + 复盘行动区块（对标 offerbiu 卡片节点行与 /review/）----
  // 这一节钉的全是**跨文件一致性**：同一条信息在前后端各写一份，改一处漏一处**不报任何错**。
  {
    const dbSrc = fs.readFileSync(new URL('../server/db.ts', import.meta.url), 'utf8');
    const idxSrc = fs.readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8');
    const revSrc = fs.readFileSync(new URL('../server/services/reviewPlan.ts', import.meta.url), 'utf8');
    // ⚠️ 计数前一律先剥注释。console.html 里就有一条注释顺带写了「长时间没进展」，
    //    不剥的话「区块在不在」那条断言会被**注释满足**（恒绿），页面上少一块也没人知道。
    const pCode = stripComments(pHtml);
    const revCode = stripComments(revSrc);

    // ① 阶段名单：下拉（APP_STATUS）与看板列（APP_STAGES）必须同集合。
    //    「待投递」是从 jobs 表来的虚拟列，**只许它**多出来 —— 多出别的就是半注册：
    //    看板里冒出一列却改不进去，或下拉能选、看板上没有那一列。
    const appStatusKeys = (() => {
      const m = /const APP_STATUS = \{([^}]*)\}/.exec(pCode);
      return m ? [...m[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map((x) => x[1]).sort() : [];
    })();
    const stageKeys = (() => {
      const m = /const APP_STAGES = \[([\s\S]*?)\n\];/.exec(pCode);
      return m ? [...m[1].matchAll(/key:'([a-z]+)'/g)].map((x) => x[1]).sort() : [];
    })();
    const stageOnly = stageKeys.filter((k) => appStatusKeys.indexOf(k) < 0);
    const statusOnly = appStatusKeys.filter((k) => stageKeys.indexOf(k) < 0);
    check('阶段名单：APP_STATUS（下拉/分布）与 APP_STAGES（看板列）同集合，只许「待投递」多出来',
      appStatusKeys.length >= 7 && stageOnly.length === 1 && stageOnly[0] === 'candidate' && statusOnly.length === 0,
      `下拉=${appStatusKeys.join(',')} | 看板多出=${stageOnly.join(',')} | 下拉多出=${statusOnly.join(',')}`);

    check('「笔试」阶段四处都登记了（中文名 / 看板列 / 快速筛选 / 后端可写列）',
      appStatusKeys.indexOf('written') >= 0
      && stageKeys.indexOf('written') >= 0
      && cnt(pCode, "{ k:'written'") === 1
      && cnt(dbSrc, "'written_at', 'interview_at', 'interview_round', 'offer_at', 'closed_at',") === 1,
      `状态表=${appStatusKeys.indexOf('written') >= 0} 看板=${stageKeys.indexOf('written') >= 0}`);

    // ② 五个时间节点列：迁移 / PATCH 透传 / 类型声明 三处逐一登记。
    //    漏一处的后果都**不报错**：漏迁移 ⇒ 列不存在、写入静默丢；漏 PATCH ⇒ 界面填了存不进去。
    const APP_FLOW_COLS = ['written_at', 'interview_at', 'interview_round', 'offer_at', 'closed_at'];
    const missingCols = APP_FLOW_COLS.filter((c) =>
      cnt(dbSrc, `addAppCol('${c}')`) !== 1
      || cnt(idxSrc, `pickTime('${c}'`) !== 1
      || cnt(dbSrc, `${c}?: string | null;`) !== 1);
    check('流程时间节点五列：迁移 / PATCH 透传 / 类型声明 三处同名单',
      APP_FLOW_COLS.length === 5 && missingCols.length === 0, `漏：${missingCols.join('、')}`);

    // ③ 「面试轮次」不是时间：必须与那四列**分开规整**。
    //    若把轮次并进时间列一起 normalizeFlowTime，「一面」「二面」会被判非法清成 NULL
    //    —— 界面显示「已保存」，轮次却没了。
    check('流程时间节点：四个时间列走 normalizeFlowTime，「面试轮次」走 normalizeRound（轮次不是时间）',
      cnt(dbSrc, "'written_at', 'interview_at', 'offer_at', 'closed_at',") === 1
      && cnt(dbSrc, "if (key === 'interview_round') return normalizeRound(value);") === 1);

    // ④ 规整必须挂在 **db 层**：写入口不止 PATCH 一个（还有批量投递与脚本），
    //    放在路由里做，别的路径就会漏 —— 然后库里混进 `2026-13-45` 而谁都不报错。
    check('流程时间节点的规整在 db 层统一执行（放路由里 ⇒ 批量投递/脚本路径漏掉）',
      cnt(dbSrc, 'APPLICATION_UPDATABLE_COLUMNS, normalizeApplicationField,') === 1);

    // ⑤ 复盘口径只留后端一份
    check('投递复盘：页面不再自算回复率/推进率，一律取 /api/stats/review（两套口径必然对不上）',
      cnt(pCode, "await api('/api/stats/review')") === 1
      && cnt(pCode, 'function pct(n, d)') === 0
      && cnt(pCode, 'const replied = (cnt.replied||0)') === 0,
      `取端点=${cnt(pCode, "await api('/api/stats/review')")} 旧自算残留=${cnt(pCode, 'function pct(n, d)')}`);

    check('投递复盘：4 个指标 + 4 段行动区块都在（区块整块由后端给，页面只拼中文）',
      cnt(pCode, 'id="rvActions"') === 1
      && cnt(pCode, '近期需要优先处理') === 1
      && cnt(pCode, '近期笔面安排') === 2      // 指标卡标题 + 区块标题各一次
      && cnt(pCode, '长时间没进展') === 1
      && cnt(pCode, '下周行动建议') === 1
      && cnt(pCode, '复盘重点') === 1,
      `优先=${cnt(pCode, '近期需要优先处理')} 笔面=${cnt(pCode, '近期笔面安排')} 没进展=${cnt(pCode, '长时间没进展')} 建议=${cnt(pCode, '下周行动建议')}`);

    // ⑥ 后端复盘端点 + 「口径层不读时钟」这个设计不变量
    check('后端：/api/stats/review 恰一处，且 now 在路由里只取一次（口径可注入才钉得住）',
      cnt(idxSrc, 'app.get("/api/stats/review"') === 1
      && cnt(idxSrc, 'buildReviewPlan(apps, jobs, { now: new Date() })') === 1,
      `端点=${cnt(idxSrc, 'app.get("/api/stats/review"')} 调用=${cnt(idxSrc, 'buildReviewPlan(apps, jobs, { now: new Date() })')}`);

    check('reviewPlan 是不读时钟的纯模块：源码里 0 处 Date.now() / new Date()',
      cnt(revCode, 'Date.now()') === 0 && cnt(revCode, 'new Date()') === 0,
      `Date.now=${cnt(revCode, 'Date.now()')} new Date=${cnt(revCode, 'new Date()')}`);

    check('「已推进」口径必须含 written（笔试也是推进；漏了 ⇒ 加了阶段但数字不变）',
      cnt(revSrc, "export const ADVANCED_STATUSES: readonly string[] = ['written', 'interview', 'offer'];") === 1
      && cnt(revSrc, 'export const SENT_STATUSES: readonly string[] = [') === 1);

    // ⑦ 前端「改时间」：真的 PATCH 到真端点，且格式不对时**拒绝提交**
    check('前端：改时间走 PATCH /api/applications/:id；格式不对拒绝提交（否则被后端静默清空）',
      cnt(pCode, "api('/api/applications/'+encodeURIComponent(card.dataset.appid), { method:'PATCH'") === 1
      && cnt(pCode, 'const FLOW_TIME_SHAPE = /^\\d{4}-\\d{2}-\\d{2}(\\s\\d{2}:\\d{2})?$/;') === 1,
      `PATCH=${cnt(pCode, "api('/api/applications/'+encodeURIComponent(card.dataset.appid), { method:'PATCH'")} 形状校验=${cnt(pCode, 'const FLOW_TIME_SHAPE =')}`);
  }

  check('个人中心：表单元素齐备，且保存走 PUT /api/profile（后端**只**注册了 PUT）',
    ['pfNameInput', 'pfPhoneInput', 'pfEmailInput', 'pfExpectInput', 'pfCityInput', 'pfResumeInput', 'pfSave', 'pfStats']
      .every((id) => cnt(pHtml, `id="${id}"`) === 1)
    && cnt(pH, "api('/api/profile', { method: 'PUT', body: JSON.stringify({ profile: profile }) })") === 1, '');
    // D 批把这一页做成了真页面，原断言「仍是诚实占位」的**名字已与实际相反**
  //   （过时断言比没有断言更坏：后人照着名字以为这页没实现）。改成钉真控件。
  check('简历制作已是真页面：不再是占位页（占位页不该有这些控件）',
    cnt(pHtml, 'id="view-resumemake"') === 1 && cnt(pHtml, 'id="rmPreview"') === 1 && cnt(pHtml, 'id="rmDocSel"') === 1
    && !/id="rmTemplate"/.test(pHtml), '');

  // ---- 自动填充：不再是占位页，「网申」面板整块搬进来了 ----
  const afSec = sectionOf('view-autofill');
  check('自动填充页不再是占位页：网申面板整块在里面（搬一半 ⇒ 页面看着有、点了没反应）',
    afSec.length > 0
    && ['wangshenUrls', 'wangshenPreview', 'wangshenApply', 'wangshenRemember', 'wangshenBar', 'wangshenOut']
      .every((id) => cnt(afSec, `id="${id}"`) === 1), '');
  check('自动填充页：整页只此一份网申面板（两处各留一套 ⇒ $$ 命中两个、$ 只取第一个）',
    cnt(pHtml, 'id="wangshenUrls"') === 1 && cnt(pHtml, 'id="wangshenPreview"') === 1
    && cnt(pHtml, 'id="wangshenApply"') === 1 && cnt(pHtml, 'id="wangshenRemember"') === 1
    && cnt(pHtml, 'id="tab-wangshen"') === 0, '');
  check('网申不再挂在「投递中心」的 tab 上（同一功能不留两个入口）',
    cnt(pHtml, 'data-tab="wangshen"') === 0
    && cnt(pH, "['batch','reply','email']") === 1
    && cnt(pH, "'batch','reply','email','wangshen'") === 0, '');
  // 表单记忆卡：端点刻意是 POST 而不是 GET（非回环部署时只有写方法走令牌鉴权，
  //   做成 GET 等于给同网段开了个读候选人表单内容的口子）。
  check('自动填充页：表单记忆卡在，且两条端点都走 POST',
    cnt(afSec, 'id="fmList"') === 1 && cnt(afSec, 'id="fmRefresh"') === 1
    && cnt(pH, "api('/api/offerbiu/form-memory/list', {method:'POST', body:'{}'})") === 1
    && cnt(pH, "api('/api/offerbiu/form-memory/delete', {method:'POST', body:JSON.stringify({site})})") === 1, '');
  const dbSrc = stripComments(fs.readFileSync(path.join(ROOT, 'server', 'db.ts'), 'utf8'));
  const idxSrc2 = stripComments(fs.readFileSync(path.join(ROOT, 'server', 'index.ts'), 'utf8'));
  check('后端：表单记忆列表只回标签与条数、不回值（界面上不摊 PII）',
    cnt(dbSrc, 'export function listFormMemory(): FormMemoryBrief[] {') === 1
    && cnt(dbSrc, 'return { site: r.site, labels, count: labels.length, updatedAt: r.updated_at };') === 1
    && cnt(dbSrc, 'export function deleteFormMemory(site: string): number {') === 1, '');
  check('后端：两条表单记忆路由都在（前端有按钮、后端没路由 ⇒ 点了没反应且不报错）',
    cnt(idxSrc2, 'app.post("/api/offerbiu/form-memory/list"') === 1
    && cnt(idxSrc2, 'app.post("/api/offerbiu/form-memory/delete"') === 1
    && cnt(idxSrc2, 'db.deleteFormMemory(site)') === 1, '');
  // ---- 自动填充信息（对标 offerbiu 的「结构化简历信息」）----
  // 这一组防的是**静默无效**：界面上填了值、投递表单里永远填不上，而且不报错。
  // 字段表在前端（AF_SECTIONS）、规则表在后端（offerbiu.ts 的 PROFILE_LABEL_RULES），
  // 两张表分居两个文件 ⇒ 只靠人盯必然漂移。这里把它们机械对上。
  const afBlockM = pH.match(/const AF_SECTIONS = \[([\s\S]*?)\n\];/);
  const afBlock = afBlockM ? afBlockM[1] : '';
  const afFields = [...afBlock.matchAll(/\{k:'([A-Za-z0-9_]+)', label:'([^']+)'/g)].map((m) => ({ k: m[1], label: m[2] }));
  const afKeySet = new Set(afFields.map((f) => f.k));
  check('自动填充信息：AF_SECTIONS 数据表解析正常（字段数 ≥ 50。正则失配时下面几条会一起恒绿）',
    afBlock.length > 0 && afFields.length >= 50, `解析到 ${afFields.length} 个字段`);
  check('自动填充信息：字段键与字段标签都不重复（键重复 ⇒ id 撞车改一半；标签重复 ⇒ 用户不知道该填哪个）',
    afFields.length >= 50 && afKeySet.size === afFields.length
    && new Set(afFields.map((f) => f.label)).size === afFields.length, '');

  const obSrc = stripComments(fs.readFileSync(path.join(ROOT, 'server', 'services', 'apply', 'offerbiu.ts'), 'utf8'));
  // 规则表里 pick 到的档案键（`a || b` 兜底写法会把两个键都算进来，正是我们想要的）
  const ruleKeys = new Set([...obSrc.matchAll(/asText\(p\.([A-Za-z0-9_]+)\)/g)].map((m) => m[1]));
  // 「个人中心 → 候选人档案」负责的键（#view-profile 的表单）。这 5 个刻意不在自动填充页重复。
  // resume_path 不在这里：它不是投递表单的字段标签，规则表也不认它。
  const CENTER_KEYS = ['name', 'phone', 'email', 'expectedPositions', 'expectedCity'];
  const deadRules = [...ruleKeys].filter((k) => !afKeySet.has(k) && CENTER_KEYS.indexOf(k) < 0).sort();
  const orphanFields = afFields.map((f) => f.k).filter((k) => !ruleKeys.has(k)).sort();
  check('自动填充信息：规则表里的每个档案键都能在某处被设置（否则是「死规则」：界面没入口、永远取到空）',
    ruleKeys.size >= 40 && deadRules.length === 0, `没人能设置的键：${deadRules.join('、')}`);
  check('自动填充信息：字段表里的每个键在规则表里都有规则（否则界面上填了也到不了表单，不报错）',
    orphanFields.length === 0, `没有规则的键：${orphanFields.join('、')}`);
  check('自动填充信息：两侧扫描都有产出（防「正则写错 ⇒ 上面两条恒绿」）',
    ruleKeys.size >= 40 && afFields.length >= 50, `rules=${ruleKeys.size} fields=${afFields.length}`);

  // 顺序即优先级：具体规则必须排在宽泛规则之前。静态位置只是**代理指标** ——
  // 真正的证明是「喂标签进去看解析结果」，在 tests/unit/autofillProfile.test.ts 里。
  const posOf = (needle: string) => obSrc.indexOf(needle);
  const posEmergencyPhone = posOf('asText(p.emergencyPhone)');
  const posPhone = posOf('asText(p.phone)');
  const posDomicile = posOf('asText(p.domicile)');
  const posCity = posOf('asText(p.city)');
  const posRelation = posOf('asText(p.emergencyRelation)');
  const posEmergencyFallback = posOf('{ re: /紧急/,');
  check('自动填充信息：具体规则排在宽泛规则之前（顺序反 ⇒ 填得出值但值是错的，不报错）',
    posEmergencyPhone >= 0 && posPhone >= 0 && posEmergencyPhone < posPhone
    && posDomicile >= 0 && posCity >= 0 && posDomicile < posCity
    && posRelation >= 0 && posEmergencyFallback >= 0 && posRelation < posEmergencyFallback,
    `紧急电话@${posEmergencyPhone} 电话@${posPhone} 户籍@${posDomicile} 城市@${posCity} 关系@${posRelation} 紧急兜底@${posEmergencyFallback}`);
  const unitSrc = fs.readFileSync(path.join(ROOT, 'tests', 'unit', 'autofillProfile.test.ts'), 'utf8');
  check('自动填充信息：顺序这件事有**行为级**证明（静态扫描只能证明「那行在上面」，证明不了解析结果）',
    cnt(unitSrc, "pick('紧急联系电话'") >= 1 && cnt(unitSrc, "pick('户籍所在地'") >= 1
    && cnt(unitSrc, "pick('面试城市'") >= 1, '');

  check('自动填充页：自动填充信息卡在，53 格是**数据驱动**渲染（不手写 53 段 HTML ⇒ 标签不配对是常态）',
    cnt(afSec, 'id="afForm"') === 1 && cnt(afSec, 'id="afSave"') === 1 && cnt(afSec, 'id="afReload"') === 1
    && cnt(pH, 'host.innerHTML = AF_SECTIONS.map(sec=>{') === 1
    && cnt(pH, 'document.getElementById(afFieldId(f.k))') === 1, '');
  check('自动填充页：navigate 同时初始化两块（少一个 ⇒ 进页面只看到静态占位，像「加载慢」）',
    cnt(pH, "if(view==='autofill'){ loadFormMemory(); loadAutofillInfo(); }") === 1, '');
  check('自动填充信息：保存走 PUT /api/profile（后端只注册了 PUT，POST/PATCH 会 404）',
    cnt(pH, "await api('/api/profile', {method:'PUT', body:JSON.stringify({profile:patch})});") === 1, '');
  check('自动填充信息：没渲染成功就不许保存（否则 53 个键全提交空串，浅合并直接抹掉用户已存的值）',
    cnt(pH, "host.dataset.afLoaded = '1';") === 1
    && cnt(pH, "if(host.dataset) host.dataset.afLoaded = '';") === 1
    && cnt(pH, "afLoaded !== '1'") === 1, '');
  check('自动填充信息：不在自动填充页重复个人中心那 5 个键（两处各留一份 ⇒ 谁后保存谁赢）',
    CENTER_KEYS.every((k) => !afKeySet.has(k))
    && CENTER_KEYS.every((k) => {
      const m = pH.match(/const profile = \{([\s\S]*?)\n  \};/);
      return m ? cnt(m[1], k + ':') === 1 : false;
    }), '');

  // ⚠️ D 批把「简历制作」从占位页做成了真页面 ⇒ 原来那条 `data-goto= >= 6` 会变红。
  //    那是**断言的前提变了**（占位页少了一个），不是实现坏了：改成钉住现在仅存的入口，
  //    并用「副标题不许再写尚未实现」钉住那类会与实际相反、且没人会报错的过时文案。
  check('跨页快捷入口（个人中心）统一走 data-goto 绑定',
    cnt(pH, "$$('[data-goto]').forEach(b=>b.addEventListener('click', ()=>navigate(b.dataset.goto)));") === 1
    && cnt(pHtml, 'data-goto=') >= 4, '');
  check('简历制作已实现 ⇒ 顶栏副标题不许还写着「尚未实现」（过时文案没人会报错）',
    cnt(pH, "resumemake:{t:'简历制作', s:'结构化草稿 · 实时预览 · 出 HTML/PDF'},") === 1
    && cnt(pH, '本页尚未实现') === 0, '');
  // ---- 简历制作（D 批）：真页面 + 8 条端点 + 两级出稿 ----
  {
    const rmSec = sectionOf('view-resumemake');
    const rmIds = ['rmDocSel', 'rmNew', 'rmDel', 'rmTitle', 'rmSave', 'rmMsg', 'rmName', 'rmPhone', 'rmEmail',
      'rmCity', 'rmHeadline', 'rmSummary', 'rmHighlights', 'rmSkills', 'rmSections', 'rmPreview', 'rmAccent',
      'rmHtml', 'rmPdf', 'rmPdfWhy'];
    check('D 批断言自检：简历制作的骨架与三个函数确实被扫到（防「section 为空 ⇒ 整段恒绿」）',
      rmSec.length > 500 && cnt(pH, 'function rmDocFromForm()') === 1
      && cnt(pH, 'function rmFillForm(d)') === 1 && cnt(pH, 'async function rmPreview()') === 1,
      'rmSec=' + rmSec.length);
    check('简历制作：三栏骨架的控件齐备（左编辑 / 中预览 / 右出稿），且整页只此一份',
      rmSec.length > 0
      && rmIds.every((id) => cnt(rmSec, 'id="' + id + '"') === 1 && cnt(pHtml, 'id="' + id + '"') === 1),
      rmSec.length ? rmIds.filter((id) => cnt(pHtml, 'id="' + id + '"') !== 1).join(',') : 'section 未找到');

    check('简历制作：后端 8 条路由都在（前端有按钮、后端没路由 ⇒ 点了没反应且不报错）',
      ['app.get("/api/resume/capabilities"', 'app.get("/api/resume/docs"', 'app.get("/api/resume/docs/:id"',
        'app.put("/api/resume/docs/:id"', 'app.post("/api/resume/docs"', 'app.delete("/api/resume/docs/:id"',
        'app.post("/api/resume/docs/:id/html"', 'app.post("/api/resume/docs/:id/pdf"']
        .every((r) => cnt(idxSrc2, r) === 1), '');
    check('简历制作：前端动词与后端注册一致（保存 PUT / 删除 DELETE / 新建·出稿 POST）',
      cnt(pH, "{ method:'PUT', body: JSON.stringify(rmDocFromForm()) }") === 1
      // ⚠️ 只写 `{ method:'DELETE' }` 会命中「删除投递」那条（同一串在文件里有两份）
      //    ⇒ 改了简历这边、投递那边也一起红，两条断言就不再独立。
      && cnt(pH, "api('/api/resume/docs/' + encodeURIComponent(RM_DOC.id), { method:'DELETE' });") === 1
      && cnt(pH, "api('/api/resume/docs', { method:'POST', body: JSON.stringify({ title }) })") === 1, '');

    // HTML 级**永远可用**的前提是不落盘、不依赖浏览器；PDF 级必须落盘（CDP 要一个文件路径）。
    // 两者混在一起 ⇒ HTML 也会在浏览器不在线时失败，且 data/ 堆一地中间产物。
    check('简历制作：HTML 级不落盘（后端直接回字符串 + 前端 Blob 下载）',
      cnt(idxSrc2, 'res.json({ ok: true, id: doc.id, title: doc.title, html: renderResumeDoc(doc) });') === 1
      && cnt(pH, "const blob = new Blob([r.html || ''], { type: 'text/html;charset=utf-8' });") === 1
      && cnt(pH, "a.download = (rmVal('#rmTitle') || '简历') + '.html';") === 1, '');
    check('简历制作：PDF 依赖的浏览器不在线时返回 503（不是 500），前端据此置灰并写明原因',
      cnt(idxSrc2, 'res.status(503).json({ ok: false, error: r.error, needPlatforms: PDF_VIA_PLATFORMS });') === 1
      && cnt(pH, 'const up = RM_PDF_VIA.filter((p)=> connected[p] && connected[p].connected);') === 1
      && cnt(pH, 'const ok = RM_PDF_VIA.length === 0 || up.length > 0;') === 1
      && cnt(pH, 'btn.disabled = !ok;') === 1, '');

    const tpSrc = stripComments(fs.readFileSync(path.join(ROOT, 'server', 'services', 'apply', 'tailoredResumePdf.ts'), 'utf8')).replace(/\r\n/g, '\n');
    check('简历制作：PDF 与「一岗一简历」共用同一条通路 printHtmlToPdf（不另写一套排版）',
      cnt(idxSrc2, 'const r = await printHtmlToPdf(htmlPath, pdfPath);') === 1
      && cnt(tpSrc, 'export async function printHtmlToPdf(') === 1
      && cnt(tpSrc, 'export const PDF_VIA_PLATFORMS = PDF_TARGETS.map(([k]) => k);') === 1, '');

    const atSrc = fs.readFileSync(path.join(ROOT, 'server', 'services', 'authToken.ts'), 'utf8').replace(/\r\n/g, '\n');
    // ⚠️ dataCleanup 里那条是**注释**（说明「任何档位都不碰」的清单）⇒ 剥了注释就数不到，
    //    这里刻意读原文：它虽然不是代码，但正是这条注释在替后人挡住「新目录忘了加保护」。
    const dcRaw = fs.readFileSync(path.join(ROOT, 'server', 'services', 'dataCleanup.ts'), 'utf8').replace(/\r\n/g, '\n');
    check('简历制作：data/resume_doc 三处注册齐了（静态挂载 / 局域网签名前缀 / 清理保护清单）',
      cnt(idxSrc2, "app.use('/data/resume_doc', express.static(RESUME_DOC_DIR));") === 1
      && cnt(atSrc, "'/data/resume_doc/',") === 1
      && cnt(dcRaw, 'data/resume_doc') === 1, '');

    check('简历制作：草稿存 app_kv 的 resumedoc: 前缀，且不碰简历版本位',
      cnt(idxSrc2, "const DOC_PREFIX = 'resumedoc:';") === 1
      && cnt(idxSrc2, 'const docKey = (id: string) => DOC_PREFIX + safeDocId(id);') === 1
      && (() => {
        const a = idxSrc2.indexOf('const DOC_PREFIX');
        const b = idxSrc2.indexOf('app.post("/api/resume/parse"');
        // 🔴 版本位是「投递时带哪份简历」的开关；草稿混进去 ⇒ 一份草稿会被当成可投递件
        return a > 0 && b > a && cnt(idxSrc2.slice(a, b), 'resume:version') === 0;
      })(), '');

    const rdSrc = stripComments(fs.readFileSync(path.join(ROOT, 'server', 'services', 'apply', 'resumeDoc.ts'), 'utf8')).replace(/\r\n/g, '\n');
    check('简历制作：配色/版式白名单单一真相源（前后端都从 resumeTheme.js 取，前端不另抄 hex）',
      cnt(rdSrc, "import { RESUME_ACCENTS, DEFAULT_ACCENT_KEY, RESUME_VARIANTS, DEFAULT_VARIANT_KEY } from './resumeTheme.js';") === 1
      && cnt(pH, 'RM_ACCENTS = (c && c.accents) || [];') === 1
      && cnt(pH, '#1d4ed8') === 0
      && cnt(pH, 'RM_VARIANTS = (c && c.variants) || [];') === 1, '');
    // 版式模板（variant）也是白名单：后端从 capabilities 下发，前端据 RM_VARIANTS 渲染色段按钮。
    check('简历制作：版式模板走白名单（后端 capabilities 下发 variants，前端据 RM_VARIANTS 渲染分段按钮）',
      cnt(idxSrc2, 'variants: RESUME_VARIANTS') === 1
      && cnt(pH, 'RM_VARIANTS.map') === 1
      && cnt(pH, 'function rmSetVariant') === 1, '');
    // 新布局：左编辑流（rm-edit）+ 右 sticky 外观与预览（rm-side）；不再是三栏裸表单。
    check('简历制作：新版式是两栏（左 rm-edit 编辑流 / 右 rm-side sticky 外观+预览）',
      cnt(pH, 'class="rm-edit"') === 1 && cnt(pH, 'class="rm-side"') === 1, '');
    // 经历/栏目是卡片流，可增删条目/板块，不再只有高级文本框。
    check('简历制作：经历/栏目是卡片流（#rmSectionCards + rmRenderSectionCards + 结构性增删）',
      cnt(pH, 'id="rmSectionCards"') === 1
      && cnt(pH, 'function rmRenderSectionCards') === 1
      && cnt(pH, 'function rmSectionCardAct') === 1, '');
    // 🔴 真事故（探针跑出来的）：`safeDocId(req.body?.id) || <默认 id>` —— safeDocId
    //    对空输入返回 'doc'、**永不为假** ⇒ 兜底分支永远走不到，每份新草稿 id 都恒为
    //    'doc' ⇒ 建第二份必然 409。这类 bug 静态看代码很像对的，只能靠先判空再规整。
    check("简历制作：新建草稿的 id 不能恒为同一个（safeDocId 空输入返回 doc，兜底分支写错就永远走不到）",
      cnt(idxSrc2, "const rawId = String(req.body?.id ?? '').trim();") === 1
      && cnt(idxSrc2, "const id = rawId ? safeDocId(rawId) : ('d' + Date.now().toString(36));") === 1
      && cnt(idxSrc2, "safeDocId(req.body?.id) ||") === 0, '');
  }

  check('初始化走 navigate(\'dashboard\')：顶栏标题的唯一真相源是 VIEW_META，别让静态标题留在页面上',
    /navigate\('dashboard'\);\s*$/.test(pH.slice(0, pH.lastIndexOf('</script>')).slice(-80)), '');
}

// ── 静态护栏：JS 引用的 DOM id 必须真实存在 ──────────────────────────────
// 背景（真实事故）：改「我的投递」HTML 时删了刷新按钮，JS 里
//   `$('#appsRefresh').addEventListener(...)` 却留着 —— 该行在**脚本顶层**，
//   对 null 调 addEventListener 直接抛 TypeError ⇒ 它**之后的全部脚本**
//   （含 #logTabs 绑定与整个 init 块）都不执行 ⇒ 控制台整页空白。
//   而 typecheck / console:check / 原有 606 条合约**全绿**。
// 判据：把「脚本里 $('#'+id) 的引用集」与「文件里出现过的 id 定义集」机械比对。
// ⚠️ 必须排除 `$('#pane-'+t)` 这类前缀拼接，否则会把 `pane-` 当成缺失 id（纯误报）。
{
  const dH = fs.readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
  // ⚠️ HTML 的 <!-- --> 注释同样会「定义」一个 id（stripComments 不认这种写法）⇒ 定义集也先剥
  const dHc = dH.replace(/<!--[\s\S]*?-->/g, '');
  const dScriptsRaw = [...dH.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  // 🔴 必须先剥注释再扫引用。注释里举例写一句 `$('#x')`（讲「删了元素记得删引用」），
  //    会被当成「引用了不存在的 #x」⇒ 断言**假红**。
  //    「文本把断言弄绿」与「文本把断言弄红」是同一件事的两面：匹配前一律先剥注释。
  const dScripts = stripComments(dScriptsRaw);
  const dDefined = new Set<string>();
  // 静态 HTML 里的 id="..." 与脚本 innerHTML 模板里的 id="..." 都算定义
  for (const m of dHc.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)) dDefined.add(m[1]);
  // 动态创建：xxx.id = 'yyy'
  for (const m of dScripts.matchAll(/\.id\s*=\s*['"]([A-Za-z0-9_-]+)['"]/g)) dDefined.add(m[1]);
  const dRefs = new Set<string>();
  for (const m of dScripts.matchAll(/\$\$?\(\s*['"]#([A-Za-z0-9_-]+)/g)) {
    if (dScripts[(m.index ?? 0) + m[0].length] === '+' || m[1].endsWith('-')) continue;
    dRefs.add(m[1]);
  }
  for (const m of dScripts.matchAll(/getElementById\(\s*['"]([A-Za-z0-9_-]+)['"]/g)) dRefs.add(m[1]);
  const dMissing = [...dRefs].filter((id) => !dDefined.has(id)).sort();
  check('console.html：JS 引用的每个 #id 都有对应元素（缺失 ⇒ 顶层 TypeError，整页空白）',
    dMissing.length === 0, `缺失：${dMissing.join('、')}`);
  // 仪器自检：证明「剥注释」真的生效 —— 否则上面那条会被注释里的举例弄成假红
  check('console.html：剥注释这一步真的生效（注释里举例写的引用不算引用）',
    !/\$\('#zzz'\)/.test(stripComments("// 举例：$('#zzz') 是早先删掉的元素\nconst a = 1;")),
    '剥注释没生效 ⇒ 上面那条会被注释里的举例弄成假红');
  // 反向护栏：正则一旦写错，dRefs 会是空集，上面那条就**恒绿**了 —— 所以要求扫到足够多的量
  check('console.html：上面的 id 扫描确有产出（防「正则写错 ⇒ 恒绿」）',
    dRefs.size >= 200 && dDefined.size >= 200, `refs=${dRefs.size} defined=${dDefined.size}`);

  // ---- 同一个页面里 id 不能重复：重复时 $() 只取第一个、$$() 取到两个，
  //      于是「改一个、另一个纹丝不动」，而且**不报任何错**。
  //      本轮把「网申」面板从投递中心整块搬到自动填充，正是最容易留下重复 id 的改动。----
  const dStatic = dHc.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  const dIdCount: Record<string, number> = {};
  for (const m of dStatic.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)) dIdCount[m[1]] = (dIdCount[m[1]] || 0) + 1;
  const dDup = Object.keys(dIdCount).filter((k) => dIdCount[k] > 1).sort();
  check('console.html：静态标签里没有重复 id（重复 ⇒ $() 只取第一个，改一半还不报错）',
    dDup.length === 0, `重复：${dDup.map((k) => k + 'x' + dIdCount[k]).join('、')}`);
  check('console.html：重复 id 扫描确有产出（防「正则写错 ⇒ 恒绿」）',
    Object.keys(dIdCount).length >= 150, `静态 id 数=${Object.keys(dIdCount).length}`);
}


// ── 自动回复「持续跟进」（常驻监视器）接线 ────────────────────────────────────
// 背景：后端 autoReplyWatcher.ts + /api/auto-reply/watch 五个端点早就写完了，而且真跑过
// （data/auto_reply_watch.log 355 轮 tick、相邻间隔中位数正好 180s、跨 5 天），
// 但**前端零调用方** + 配置默认 enabled:false ⇒ 用户只能手敲 curl 才能开，
// 界面上根本开不了 = 功能不存在。三层判据：控件锚元素 / 真打端点 / 安全默认。
{
  const wHtml = fs.readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
  const wCode = stripComments(wHtml);
  const WATCH_IDS = ['watchInterval', 'watchMaxPerRun', 'watchThrottle', 'watchHrCooldown',
    'watchPlatforms', 'watchRealSend', 'watchStart', 'watchStop', 'watchSaveCfg', 'watchState', 'watchLog'];
  // ⚠️ 必须锚到**元素**：只测 includes('watchStart') 会被 JS 里的 $('#watchStart') 满足，
  //    把整个 <button> 删掉断言照样绿（2026-10-03 emailForce 那条假区分力就是这么来的）。
  const anchor = (id: string) => new RegExp('<[a-z]+[^>]*\\bid="' + id + '"', 'i').test(wHtml);
  const wMiss = WATCH_IDS.filter((id) => !anchor(id));
  check('持续跟进：11 个控件都锚到真实元素（只测 includes 会被 JS 里的 #id 引用满足）',
    wMiss.length === 0, `缺元素：${wMiss.join('、')}`);
  check('持续跟进：控件锚元素扫描确有区分力（防「正则写错 ⇒ 恒绿」）',
    anchor('replyOut') && !anchor('watchNotExistXyz'),
    '同一正则对真实 id 必须命中、对不存在的 id 必须不命中');

  const WATCH_APIS = ['/api/auto-reply/watch/status', '/api/auto-reply/watch/config',
    '/api/auto-reply/watch/start', '/api/auto-reply/watch/stop'];
  const wMissApi = WATCH_APIS.filter((u) => !wCode.includes(u));
  check('持续跟进：前端真的打了 watch 四端点（后端有路由、前端不打 ⇒ 点了没反应且不报错）',
    wMissApi.length === 0, `未调用：${wMissApi.join('、')}`);

  // 🔴 安全底线：真发送开关**不得预勾选** —— 否则一点「开启」就自动向 HR 发真消息（不可撤回）
  const rsTag = wHtml.match(/<input[^>]*\bid="watchRealSend"[^>]*>/i);
  check('持续跟进：真发送开关不得预勾选（默认只预览，绝不自动外发）',
    !!rsTag && !/\bchecked\b/i.test(rsTag[0]),
    '预勾选 ⇒ 开启监视器即自动给 HR 发真消息；这是本功能唯一一道「不可撤回」闸门');

  // SSE 格式与单次运行不同：watcher 发 {type:'tick',kind,ev}，真实事件在 ev 子对象里
  check('持续跟进：SSE 按 tick/kind/ev 解析（照抄 #replyRun 的直发格式 ⇒ 一条都显示不出来）',
    /['"]tick['"]/.test(wCode) && /\bkind\b/.test(wCode) && /\bev\.ev\b/.test(wCode),
    'watcher 发的是 tick 包裹体；直发 {type:sent} 那套在这里取不到任何东西');

  // startWatcher() 内部先 loadConfig()（读盘覆盖内存）再置 enabled=true
  // ⇒ 必须「先 POST config 落盘、再 start」，否则面板上改的参数会被磁盘旧值静默覆盖
  check('持续跟进：开启时先落盘参数再启动（反了 ⇒ 改完参数点开启会静默沿用旧值）',
    /watch\/config'[\s\S]{0,500}?watch\/start'/.test(wCode),
    'startWatcher 内部 loadConfig 会覆盖内存 config；顺序反了不报错、但参数白改');
}

// ── 防复发护栏：HTML 注释里不得出现「块注释起始」token ────────────────────────
// 2026-10-06 事故：卡片注释里写了 `/api/auto-reply/watch` 紧跟一个星号，
// 而 scripts/lib/stripComments.ts **不认 HTML 的 <!-- -->** ⇒ 把它当成块注释开始，
// 一路剥到 3100 行之后 JS 注释结尾处的「星号加斜杠」⇒ 静默吃掉 email 面板与 lightbox 整段 DOM。
// 两条既有断言（emailForce / lightbox）当场变红，而**总行数完全不变**
// （该库用空行替换被剥内容）⇒ 只看行数会漏诊。这类「注释把 DOM 吃了」必须机械拦住。
{
  const hRaw = fs.readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
  const hOPN = String.fromCharCode(47, 42);   // 不直接写字面量：写出来会截断本文件自己的注释
  const hComments = hRaw.match(/<!--[\s\S]*?-->/g) || [];
  const hDanger = hComments.filter((c) => c.includes(hOPN));
  check('console.html：HTML 注释里不得出现块注释起始 token（stripComments 不认 <!-- -->）',
    hDanger.length === 0,
    `危险注释 ${hDanger.length} 处：${hDanger.map((c) => c.replace(/\s+/g, ' ').slice(0, 70)).join(' | ')}`);
  check('console.html：上面的 HTML 注释扫描确有产出（防「正则写错 ⇒ 恒绿」）',
    hComments.length >= 20, `HTML 注释数=${hComments.length}`);
}

console.log(`\n══════ 合约测试汇总 ══════`);
console.log(`通过 ${pass} / 共 ${pass + fail}${skipped > 0
  ? `（跳过 ${skipped} 项：${[...skipReasons.entries()].map(([r, n]) => `${r} × ${n}`).join('；')} —— 这些断言本次未执行，不在分母内）`
  : ''}`);

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
