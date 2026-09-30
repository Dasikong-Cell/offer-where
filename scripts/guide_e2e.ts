/**
 * 「装到朋友机器之后，这一页还打得开吗」—— 浏览器级实测。
 *
 * 为什么必须真起后端 + 真开浏览器（静态自检证明不了的那部分）：
 *   ① `GET /guide/` 到底 200 还是 401 —— 取决于鉴权中间件的匿名白名单，
 *      而 curl **能带 X-Auth-Token**，所以「curl 全绿」恰恰证明不了浏览器里点得开。
 *      本项目已经被这一类坑坑过一次：第一版白名单只放行 /api/*，`GET /` 直接 401、
 *      控制台白屏，而 curl 测 /api/* 全部「符合预期」。
 *   ② 侧栏那个入口能不能**点中** —— 层叠/命中测试是静态断言看不见的（同类坑：
 *      PWA 引导条压住 topbar，三道门禁全绿，靠 Playwright 真点击才抓到）。
 *   ③ 手机宽度下入口在抽屉里，得先点汉堡才够得着 —— 而「手机上看控制台」
 *      正是说明书第七节推荐的做法。
 *
 * 判据（11 条）：
 *   A 匿名 HTTP：/guide/ 200 且是 HTML；配图 200；`/guide/../.env` 非 200；
 *     对照：`/api/profile` 无令牌必须 401（证明鉴权真的开着，否则上面几条是空转）
 *   B 桌面 1440：侧栏入口可见 → 点击 → 新窗口打开 /guide/ → 标题/正文渲染 → 配图真的加载
 *   C 手机 390：点汉堡 → 抽屉里的入口可点 → 打开同一页
 *
 * ⚠️ 刻意**不进** `npm test`：它会 spawn 一个后端子进程 + 一个浏览器，
 *    而 `npm test` 是纯静态快跑。入口是 `npm run guide:e2e`。
 *    收尾一律放 finally：中断时不留孤儿进程占端口。
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 4416;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN_PATH = path.join(ROOT, 'data', '.auth_token');

let pass = 0;
let fail = 0;
const check = (name, ok, hint = '') => {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${hint ? '  — ' + hint : ''}`); }
};

if (!fs.existsSync(TOKEN_PATH)) {
  console.log('缺少 data/.auth_token —— 先启动一次后端再跑本脚本。');
  process.exit(2);
}
const TOKEN = fs.readFileSync(TOKEN_PATH, 'utf8').trim();

console.log('使用说明页「装到别人机器后还能不能用」实测');
console.log('');
console.log(`  起后端 PORT=${PORT} HOST=0.0.0.0 REQUIRE_AUTH=1（复刻 start_lan.bat 的鉴权状态）`);

const srv = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'server/index.ts'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: '0.0.0.0', REQUIRE_AUTH: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
srv.stdout.on('data', (d) => { log += d; });
srv.stderr.on('data', (d) => { log += d; });

let browser = null;
try {
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${BASE}/api/ping`)).ok) { ready = true; break; } } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ready) {
    console.log('后端未就绪：');
    console.log(log.slice(-1200));
    process.exitCode = 2;
  } else {
    // ── A. 匿名 HTTP（不带任何令牌）────────────────────────────────────────
    console.log('\n── A. 匿名 HTTP（不带令牌，模拟浏览器取资源）──');
    const guide = await fetch(`${BASE}/guide/`, { redirect: 'manual' });
    const guideBody = await guide.text().catch(() => '');
    check('GET /guide/ 匿名 200', guide.status === 200, `实际 ${guide.status}`);
    check('返回的是 HTML（不是 JSON 错误体）',
      /text\/html/.test(guide.headers.get('content-type') || ''), guide.headers.get('content-type') || '(空)');
    check('返回的确实是说明书正文', guideBody.includes('OfferWhere 使用说明'));
    const img = await fetch(`${BASE}/guide/img/d-home.png`);
    check('GET /guide/img/*.png 匿名 200（否则手机上会裂图）', img.status === 200, `实际 ${img.status}`);
    // 负向：子树里的数据文件不许被这条放行规则带出去
    const evil = await fetch(`${BASE}/guide/../.env`);
    check('.env 走 /guide/ 前缀绕不出来', evil.status !== 200, `实际 ${evil.status}`);
    // 对照组：没有它，上面几条全 200 也可能只是因为**鉴权根本没开**
    const bare = await fetch(`${BASE}/api/profile`, { headers: { 'X-Auth-Token': '' } , redirect: 'manual' });
    check('对照组：无令牌 GET /api/profile 必须 401（证明鉴权真的开着）', bare.status === 401, `实际 ${bare.status}`);

    browser = await chromium.launch();

    // ── B. 桌面：侧栏入口点得中，点开就是这一页 ──────────────────────────
    console.log('\n── B. 桌面 1440×900 ──');
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);

    const link = page.locator('aside .side-foot a[href="/guide/"]');
    check('侧栏底部存在入口', (await link.count()) === 1, `匹配到 ${await link.count()} 个`);
    check('入口对用户可见（非 display:none / 零尺寸）', await link.isVisible().catch(() => false));
    // 真点击：命中测试在 isVisible 之上再挡一层（被别的东西压住时点击会落到别人身上）
    const [popup] = await Promise.all([
      page.waitForEvent('popup', { timeout: 15000 }).catch(() => null),
      link.click({ timeout: 15000 }).catch((e) => { errors.push('click: ' + e.message); }),
    ]);
    check('点击后打开了新窗口', !!popup);
    if (popup) {
      await popup.waitForLoadState('domcontentloaded').catch(() => {});
      await popup.waitForTimeout(1200);
      const url = popup.url();
      check('新窗口落在 /guide/ 上（不是 401 页 / 空白）', /\/guide\/?$/.test(url), url);
      const h1 = (await popup.locator('h1').first().innerText().catch(() => '')) || '';
      check('说明书标题渲染出来了', /OfferWhere 使用说明/.test(h1), h1.slice(0, 60));
      // 配图真的加载了 —— 逐张查 naturalWidth，裂图是静默的（页面照样「没报错」）。
      // ⚠️ 必须先滚动到底：这一页的 <img> 全带 loading="lazy"，首屏之外的三张在
      //    滚动前 naturalWidth 恒为 0 —— 第一版直接断言，于是报出三张「裂图」，
      //    而它们只是**还没开始加载**（断言自己错了，不是页面错了）。
      //    走一遍读者真实的动作：往下滚，再回读。
      const steps = await popup.evaluate(() => Math.ceil(document.body.scrollHeight / window.innerHeight));
      for (let i = 1; i <= steps; i++) {
        await popup.evaluate((n) => window.scrollTo(0, n * window.innerHeight), i);
        await popup.waitForTimeout(450);
      }
      await popup.waitForTimeout(800);
      const imgs = await popup.evaluate(() => Array.from(document.images).map((i) => ({
        src: i.getAttribute('src') || '', w: i.naturalWidth, lazy: i.loading,
      })));
      const broken = imgs.filter((i) => i.w === 0).map((i) => i.src);
      check(`配图全部真的加载了（滚完全页后，${imgs.length} 张）`,
        imgs.length >= 4 && broken.length === 0, broken.join(', '));
      await popup.close();
    }

    // ── C. 手机宽度：入口在抽屉里，得先点汉堡 ────────────────────────────
    console.log('\n── C. 手机 390×844（抽屉）──');
    const m = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await m.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await m.waitForTimeout(2500);
    const menuBtn = m.locator('#menuBtn');
    check('手机上能看到汉堡按钮', await menuBtn.isVisible().catch(() => false));
    await menuBtn.click({ timeout: 10000 }).catch(() => {});
    await m.waitForTimeout(600);
    const mLink = m.locator('aside .side-foot a[href="/guide/"]');
    check('抽屉打开后入口可见', await mLink.isVisible().catch(() => false),
      '抽屉没打开时它在屏外 —— 这正是要先点汉堡的原因');
    const [mPopup] = await Promise.all([
      m.waitForEvent('popup', { timeout: 15000 }).catch(() => null),
      mLink.click({ timeout: 15000 }).catch(() => {}),
    ]);
    check('手机上也能点开这一页', !!mPopup && /\/guide\/?$/.test(mPopup.url()),
      mPopup ? mPopup.url() : '没有新窗口');
    if (mPopup) {
      // 光看 URL 不够：401 的错误体也会落在同一个 URL 上。回读正文才算数。
      await mPopup.waitForLoadState('domcontentloaded').catch(() => {});
      const mText = (await mPopup.locator('body').innerText().catch(() => '')) || '';
      check('手机上打开的是说明书正文，不是 401 错误体', /OfferWhere 使用说明/.test(mText),
        mText.slice(0, 80));
      await mPopup.close();
    }
    await m.close();

    console.log(`\n── 页面 console：${errors.length} 条 error ──`);
    if (errors.length) errors.slice(0, 5).forEach((e) => console.log(`   - ${e.slice(0, 160)}`));
    check('没有非预期 JS 报错', errors.filter((e) => !/status of 401/.test(e)).length === 0,
      errors.filter((e) => !/status of 401/.test(e)).slice(0, 2).join(' | ').slice(0, 200));
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  srv.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 800));
  srv.kill('SIGKILL');
}

console.log('');
console.log('══════ 使用说明页可达性实测 ══════');
console.log(`通过 ${pass} / 共 ${pass + fail}`);
if (fail) { console.log(`❌ ${fail} 项失败`); process.exitCode = 1; }
else { console.log('✅ 全部通过'); }
