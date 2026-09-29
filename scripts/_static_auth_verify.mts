/**
 * 回归验证：收紧 GET 鉴权后，控制台的 **`<img>` / `window.open` 这类"不可带请求头"的访问**
 * 会不会挂掉。
 *
 * 为什么必须实测而不是推理：
 *   收紧鉴权时最容易忽略的就是「浏览器里那些发不出自定义请求头的取资源方式」——
 *   `<img src>`、`<a href>`、`window.open`、EventSource 都无法附加 `X-Auth-Token`。
 *   它们不受 fetch 封装保护，静态检查也扫不出来（HTML 里的字符串拼接）。
 *   唯一的判据是起真服务、按它们真实的方式去取，看状态码。
 *
 * 期望：
 *   - 需要令牌的接口：匿名 401（隐私收口）
 *   - 静态图片：匿名**仍应 200**，否则控制台里证据截图/录制帧会全变成裂图
 *     （`onerror` 只是隐藏，用户看到的是「证据没了」，比报错更难查）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const PORT = 4413;
const TOKEN = fs.readFileSync(path.join(ROOT, 'data', '.auth_token'), 'utf8').trim();

let pass = 0, fail = 0;
const check = (n, ok, hint = '') => {
  if (ok) { pass++; console.log(`  ✅ ${n}`); }
  else { fail++; console.log(`  ❌ ${n}${hint ? '  — ' + hint : ''}`); }
};

const pick = (dir) => {
  try {
    const f = fs.readdirSync(path.join(ROOT, 'data', dir)).filter((x) => /\.(png|jpg|jpeg)$/i.test(x));
    return f.length ? `/data/${dir}/${f[0]}` : '';
  } catch { return ''; }
};

const srv = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'server/index.ts'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: '0.0.0.0', REQUIRE_AUTH: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
srv.stdout.on('data', (d) => { log += d; });
srv.stderr.on('data', (d) => { log += d; });

try {
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/api/ping`)).ok) { ready = true; break; } } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ready) { console.log('后端未就绪：', log.slice(-1500)); process.exitCode = 2; }
  else {
    const st = async (p, hdr) => (await fetch(`http://127.0.0.1:${PORT}${p}`, hdr ? { headers: hdr } : undefined)).status;

    console.log('── 静态资源：`<img src>` 发不出请求头 ⇒ 必须靠 URL 签名而不是放开目录 ──');
    for (const dir of ['evidence', 'screenshots', 'resume_tailored']) {
      const p = pick(dir);
      if (!p) { console.log(`  ⏭  /data/${dir}/ 下没有文件，跳过`); continue; }
      const bare = await st(p);
      check(`裸路径匿名 401  ${p}`, bare === 401, `实际 ${bare} ⇒ 目录没被保护住`);
    }
    // 签名路径的可达性在下面「签名 URL」一节验证（那里拿的是服务端真实签发的链接）。
    // 这一节只证明「裸路径确实被挡住了」——两者合起来才说明「保护有效且没把功能弄坏」。

    console.log('\n── 需要令牌的接口：匿名必须 401（隐私收口） ──');
    for (const p of ['/api/profile', '/api/resume/file?version=original', '/api/jobs?limit=1']) {
      check(`匿名 401  ${p}`, (await st(p)) === 401);
    }

    console.log('\n── 白名单探活仍匿名可达 ──');
    for (const p of ['/api/ping', '/api/version', '/api/lan']) {
      check(`匿名 200  ${p}`, (await st(p)) === 200);
    }

    console.log('\n── 签名 URL：控制台 window.open / img 的实际走法 ──');
    {
      const j = await (await fetch(`http://127.0.0.1:${PORT}/api/resume/current`, { headers: { 'X-Auth-Token': TOKEN } })).json() as any;
      const pv = j?.original?.previewUrl || '';
      check('简历 previewUrl 带签名参数', /[?&]t=\d+\.[0-9a-f]{64}/.test(pv), `实际 ${pv || '(空)'}`);
      if (pv) check('签名 URL 匿名可达（window.open 场景）', (await st(pv)) === 200, `实际 ${await st(pv)}`);
      // 去掉签名后必须回到 401，否则说明「签名」只是装饰
      const bare = '/api/resume/file?version=original';
      check('无签名的裸路径仍是 401（签名不是摆设）', (await st(bare)) === 401, `实际 ${await st(bare)}`);
      // 篡改过期时间必须失败
      if (pv) {
        const tampered = pv.replace(/t=(\d+)\./, 't=99999999999999.');
        check('篡改有效期后签名校验失败', (await st(tampered)) === 401, `实际 ${await st(tampered)}`);
      }
    }

    console.log('\n── 证据接口返回的 evidence_path 必须是已签名形态 ──');
    {
      const j = await (await fetch(`http://127.0.0.1:${PORT}/api/apply/evidence`, { headers: { 'X-Auth-Token': TOKEN } })).json() as any;
      const withShot = (j?.items || []).filter((x: any) => x.evidence_path);
      if (!withShot.length) console.log('  ⏭  没有带 evidence_path 的记录，跳过');
      else {
        const p = withShot[0].evidence_path as string;
        check('evidence_path 带签名', /[?&]t=\d+\.[0-9a-f]{64}/.test(p), `实际 ${p}`);
        check('该签名路径匿名可达（img src 场景）', (await st(p)) === 200, `实际 ${await st(p)}`);
        const bare = p.split('?')[0];
        check('同路径去掉签名仍是 401', (await st(bare)) === 401, `实际 ${await st(bare)}`);
      }
    }
  }
} finally {
  srv.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 800));
  srv.kill('SIGKILL');
}

console.log(`\n══════ 不可带头的静态访问回归 ══════`);
console.log(`通过 ${pass} / 共 ${pass + fail}`);
if (fail) { console.log(`❌ ${fail} 项失败`); process.exitCode = 1; } else { console.log('✅ 全部通过'); }
