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
import { acceptResumeRequest, __setExForTest } from '../server/services/apply/bossChat.js';
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
  /window\.open\(b\.dataset\.prev/.test(readText('public/console.html')) &&
    /data-prev="'\+esc\(pv\)/.test(readText('public/console.html')),
  'window.open 发不出请求头 ⇒ 裸路径在鉴权开启时恒 401');
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
  //   本仓库踩过「断言被自己的注释满足」，这次是另一变体 —— 兜底分支里那句
  //   `console.warn('…用 fromSurface:false 兜底重试')` 的**日志文案**就含这个子串，
  //   所以只搜子串时，即使真参数被改回 fromSurface:true（会超时）断言照样绿。
  //   ⇒ 要求「captureScreenshot 的 send 调用里」出现该参数（`[^)]*` 保证不跨到下一次调用）。
  check('截图在常规路径失败时用 fromSurface:false 兜底',
    at >= 0 && /'Page\.captureScreenshot'[^)]*fromSurface:\s*false/.test(shotBlock) && /catch/.test(shotBlock),
    'BOSS 聊天页（投递后必然落到这里）上常规截图恒超时 ⇒ 证据截图系统性拿不到，' +
    '而「录屏回溯」面板会一直空着且看不出原因');
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
