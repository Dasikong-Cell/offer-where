/**
 * 专门验证「`<img src>` 那条路」：证据截图能不能真的显示出来。
 *
 * 为什么单开一个：这条路径是这次改动里**最容易被漏掉的**——
 * 它不在 fetch 封装里，是控制台用字符串拼出来的 HTML（`<img src="'+path+'">`），
 * 静态检查扫不到、curl 也模拟不了。只有让真浏览器去加载才知道成不成。
 *
 * 做法：起服务 → 登录态（注入令牌）→ 直接注入一个 <img> 指向**服务端签发的**
 * evidence_path → 等图加载 → 读 naturalWidth。
 * naturalWidth > 0 才算真出来；0 就是裂图（而页面上 `onerror` 会把它隐藏掉，肉眼看不到）。
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const PORT = 4417;
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
let b: any = null;
try {
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/api/ping`)).ok) { ready = true; break; } } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ready) { console.log('后端未就绪'); process.exitCode = 2; }
  else {
    const ev = await (await fetch(`http://127.0.0.1:${PORT}/api/apply/evidence`, { headers: { 'X-Auth-Token': TOKEN } })).json() as any;
    const items = (ev?.items || []).filter((x: any) => x.evidence_path);
    console.log(`证据记录 ${items.length} 条`);

    b = await chromium.launch();
    const page = await b.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });

    if (!items.length) console.log('  ⏭  没有证据记录，跳过（无法验证 <img> 路径）');
    else {
      const p = items[0].evidence_path as string;
      check('evidence_path 带短时签名', /[?&]t=\d+\.[0-9a-f]{64}/.test(p), `实际 ${p}`);

      const w = await page.evaluate(async (src: string) => {
        return await new Promise<number>((resolve) => {
          const img = new Image();
          img.onload = () => resolve(img.naturalWidth);
          img.onerror = () => resolve(0);
          img.src = src;
          setTimeout(() => resolve(-1), 12000); // 超时也算失败
        });
      }, p);
      check('<img> 真的加载出像素（naturalWidth > 0）', w > 0, `naturalWidth=${w}${w === 0 ? ' ⇒ 裂图' : ''}`);

      // 反向：去掉签名必须失败（证明保护有效）
      const bare = p.split('?')[0];
      const w2 = await page.evaluate(async (src: string) => {
        return await new Promise<number>((resolve) => {
          const img = new Image();
          img.onload = () => resolve(img.naturalWidth);
          img.onerror = () => resolve(0);
          img.src = src;
          setTimeout(() => resolve(-1), 8000);
        });
      }, bare);
      check('去掉签名的裸路径 <img> 加载失败（保护有效）', w2 === 0, `naturalWidth=${w2}`);
    }
  }
} finally {
  if (b) await b.close().catch(() => {});
  srv.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 800));
  srv.kill('SIGKILL');
}

console.log(`\n══════ 证据截图 <img> 路径 ══════`);
console.log(`通过 ${pass} / 共 ${pass + fail}`);
if (fail) { console.log(`❌ ${fail} 项失败`); process.exitCode = 1; } else { console.log('✅ 全部通过'); }
