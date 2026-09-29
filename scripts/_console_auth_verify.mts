/**
 * 控制台在**收紧鉴权之后**的浏览器级回归。
 *
 * 为什么必须用真浏览器：
 *   这次改动的风险点全是「浏览器取资源的方式」——
 *   `<img src>`、`<a href>`、`window.open` 都发不出自定义请求头。
 *   curl / fetch 能带 `X-Auth-Token`，所以 curl 全绿**恰恰证明不了它们没坏**
 *   （我第一版就是这么漏掉的：curl 全过，控制台里的图其实已经全裂了）。
 *
 * 判据：打开控制台 → 等首屏数据 → 检查
 *   1. 关键面板有真实内容（不是空/错误）
 *   2. 所有指向 /data/ 的 <img> 都真的加载成功（naturalWidth > 0）
 *   3. 简历预览按钮的链接带签名且能被匿名打开
 *   4. 页面 console 无 error
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const PORT = 4414;
const TOKEN = fs.readFileSync(path.join(ROOT, 'data', '.auth_token'), 'utf8').trim();

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, hint = '') => {
  if (ok) { pass++; console.log(`  ✅ ${n}`); }
  else { fail++; console.log(`  ❌ ${n}${hint ? '  — ' + hint : ''}`); }
};

const srv = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'server/index.ts'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: '0.0.0.0', REQUIRE_AUTH: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
srv.stdout.on('data', (d) => { log += d; });
srv.stderr.on('data', (d) => { log += d; });

let browser: any = null;
try {
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/api/ping`)).ok) { ready = true; break; } } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ready) { console.log('后端未就绪', log.slice(-1200)); process.exitCode = 2; }
  else {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    page.on('console', (m: any) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e: any) => errors.push('pageerror: ' + e.message));

    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    console.log('── 页面基本可用 ──');
    check('标题渲染', !!(await page.title()));
    const tokenInjected = await page.evaluate(() => !!(window as any).__AUTH_TOKEN__);
    check('令牌已注入页面（同源）', tokenInjected);

    // 切到「投递」视图再回「简历」，触发证据与简历两个面板的真实加载
    for (const view of ['deliver', 'resume', 'records', 'dashboard']) {
      const nav = page.locator(`[data-view="${view}"]`).first();
      if (await nav.count()) { await nav.click().catch(() => {}); await page.waitForTimeout(1800); }
    }
    // 回投递页看证据图
    const deliver = page.locator('[data-view="deliver"]').first();
    if (await deliver.count()) { await deliver.click().catch(() => {}); await page.waitForTimeout(2500); }

    console.log('\n── `<img>` 指向后端的图必须真的加载出来（发不出请求头的那条路）──');
    const imgs = await page.evaluate(() => {
      const out: Array<{ src: string; w: number; visible: boolean }> = [];
      document.querySelectorAll('img').forEach((el: any) => {
        const src = el.getAttribute('src') || '';
        if (src.indexOf('/data/') === 0) {
          out.push({ src, w: el.naturalWidth || 0, visible: el.offsetParent !== null || el.clientHeight > 0 });
        }
      });
      return out;
    });
    if (!imgs.length) console.log('  ⏭  页面上没有 /data/ 图（可能没有证据记录）');
    else {
      const broken = imgs.filter((i) => i.w === 0);
      check(`页面上 ${imgs.length} 张 /data/ 图全部加载成功`, broken.length === 0,
        broken.length ? `裂图 ${broken.length} 张，例：${broken[0].src.slice(0, 110)}` : '');
      const signed = imgs.filter((i) => /[?&]t=\d+\.[0-9a-f]{64}/.test(i.src));
      check('这些图都用了签名 URL', signed.length === imgs.length,
        `${signed.length}/${imgs.length} 带签名`);
    }

    console.log('\n── 简历预览链接（window.open 那条路）──');
    const prevs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-prev]')).map((b: any) => b.getAttribute('data-prev') || ''),
    );
    if (!prevs.length) console.log('  ⏭  没有找到预览按钮');
    else {
      check('预览按钮的链接带签名', prevs.every((p) => /[?&]t=\d+\.[0-9a-f]{64}/.test(p)),
        `实际 ${prevs[0]}`);
      // 真开一次，确认状态码是 200（这就是 window.open 的效果）
      const code = await page.evaluate(async (u) => (await fetch(u)).status, prevs[0]);
      check('该链接能被打开（fetch 直接命中）', code === 200, `实际 ${code}`);
      // 裸路径必须 401 —— 证明签名不是摆设
      const bare = prevs[0].split('?')[0] + '?version=' + (prevs[0].match(/version=(\w+)/)?.[1] || 'original');
      const bareCode = await page.evaluate(async (u) => (await fetch(u)).status, bare);
      check('去掉签名后同一路径 401', bareCode === 401, `实际 ${bareCode}`);
    }

    console.log('\n── 关键面板不是空的 ──');
    const bodyText = await page.evaluate(() => document.body.innerText || '');
    check('页面有实质内容（>200 字）', bodyText.length > 200, `实际 ${bodyText.length} 字`);
    check('没有出现 401 提示', !/访问令牌鉴权|缺少或无效的访问令牌/.test(bodyText));

    console.log(`\n── 页面 console ──\n  ${errors.length} 条 error`);
    if (errors.length) errors.slice(0, 5).forEach((e) => console.log(`     - ${e.slice(0, 160)}`));
    // ⚠️ 上面那段「裸路径必须 401」是**故意**发起的负向请求，浏览器会照例记一条
    // Failed to load resource: 401。把统计边界划到它之前，否则测试自己造出来的
    // 预期内错误会把「无报错」这条断言永远打红 —— 那种红报会被无视，比不报还糟。
    check('页面无**非预期** JS 报错',
      errors.filter((e) => !/status of 401/.test(e)).length === 0,
      errors.filter((e) => !/status of 401/.test(e)).slice(0, 2).join(' | ').slice(0, 200));
    check('（预期内）裸路径 401 确实产生了 1 条资源错误', errors.some((e) => /status of 401/.test(e)),
      '如果一条都没有，说明上面那次负向请求没真的发出去，该断言失去意义');
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  srv.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 800));
  srv.kill('SIGKILL');
}

console.log(`\n══════ 控制台（收紧鉴权后）浏览器回归 ══════`);
console.log(`通过 ${pass} / 共 ${pass + fail}`);
if (fail) { console.log(`❌ ${fail} 项失败`); process.exitCode = 1; } else { console.log('✅ 全部通过'); }
