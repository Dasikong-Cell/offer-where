/**
 * 鉴权白名单改造的**真实验证**（起服务 → 打真请求 → 收尾，一条命令内完成）。
 *
 * 为什么必须入库（不是一次性探针）：
 *   这条缺口是靠「静态检查全绿但线上可被匿名读走简历 PDF」暴露的。
 *   静态断言只能证明「代码里有白名单」，证明不了「服务真的按它执行」——
 *   中间件顺序、Express 的 req.path 语义、代理层都可能让判定落空。
 *   唯一可信的判据是：起一个 HOST=0.0.0.0 的真服务，用**不带令牌**的请求去读。
 *
 * 为什么沙箱里必须自起自停：命令结束会回收整棵进程树，不能留常驻进程。
 *   ⇒ spawn + 轮询就绪 + 断言 + kill 全写在这一次运行里。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());
const PORT = 4411; // 换端口，避开用户正在用的 4400
const TOKEN = fs.readFileSync(path.join(ROOT, 'data', '.auth_token'), 'utf8').trim();

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, hint = '') {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${hint ? '  — ' + hint : ''}`); }
}

/** 不带令牌请求（模拟同网段陌生人 / 无凭据脚本） */
async function anon(p: string) {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`);
  const body = Buffer.from(await r.arrayBuffer());
  return { status: r.status, bytes: body.length };
}
/** 带令牌请求（模拟控制台 / 合法脚本） */
async function auth(p: string) {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { headers: { 'X-Auth-Token': TOKEN } });
  const body = Buffer.from(await r.arrayBuffer());
  return { status: r.status, bytes: body.length };
}

const srv = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'server/index.ts'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: '0.0.0.0', REQUIRE_AUTH: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
srv.stdout.on('data', (d) => { log += String(d); });
srv.stderr.on('data', (d) => { log += String(d); });

try {
  // 等就绪：轮询 /api/ping（它本身是白名单里的，正好也验证这一条）
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/ping`);
      if (r.ok) { ready = true; break; }
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ready) {
    console.log('后端未能在 60s 内就绪，日志尾部：');
    console.log(log.slice(-2000));
    process.exitCode = 2;
  } else {
    console.log('后端已就绪（HOST=0.0.0.0 + REQUIRE_AUTH=1，非回环 ⇒ 鉴权必须开着）\n');

    console.log('── 白名单：匿名**应该**能读（否则手机端填令牌前无法判断连通性） ──');
    for (const p of ['/api/ping', '/api/version', '/api/lan']) {
      const r = await anon(p);
      check(`匿名 200  ${p}`, r.status === 200, `实际 ${r.status}`);
    }

    console.log('\n── 含个人信息：匿名**必须** 401 ──');
    const mustBlock = [
      '/api/profile',
      '/api/resume/current',
      '/api/resume/file?version=original',
      '/api/jobs?limit=1',
      '/api/applications?limit=1',
      '/api/sessions',
      '/api/logs/run?limit=1',
      '/api/mail/config',
      '/api/jobs/image-jd',
      '/api/auto-reply/run',
      '/api/apply/record',
    ];
    for (const p of mustBlock) {
      const r = await anon(p);
      check(`匿名 401  ${p}`, r.status === 401, `实际 ${r.status}，${r.bytes} 字节`);
    }

    console.log('\n── 同上，但带令牌应恢复 200（别把功能一起关掉） ──');
    for (const p of ['/api/profile', '/api/resume/current', '/api/jobs?limit=1', '/api/applications?limit=1']) {
      const r = await auth(p);
      check(`带令牌 200  ${p}`, r.status === 200, `实际 ${r.status}`);
    }
    {
      // 简历本体必须能带令牌下载，且确实是 PDF（不是被鉴权改成了 JSON 错误体）
      const r = await auth('/api/resume/file?version=original');
      check('带令牌能下到简历 PDF', r.status === 200 && r.bytes > 10000, `实际 ${r.status} / ${r.bytes} 字节`);
    }

    console.log('\n── 反面：路径穿越不能绕过白名单 ──');
    {
      const r = await anon('/api/ping/../profile');
      check('匿名 /api/ping/../profile 不是 200', r.status !== 200, `实际 ${r.status}`);
    }

    console.log('\n── 侧面：白名单不能靠 query 扩大 ──');
    {
      const r = await anon('/api/profile?x=/api/ping');
      check('匿名 /api/profile?x=/api/ping 仍是 401', r.status === 401, `实际 ${r.status}`);
    }
  }
} finally {
  // 还原写进 finally：中断也不能留下常驻进程
  srv.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 800));
  if (!srv.killed) srv.kill('SIGKILL');
}

console.log(`\n══════ 鉴权白名单实测汇总 ══════`);
console.log(`通过 ${pass} / 共 ${pass + fail}`);
if (fail > 0) {
  console.log(`❌ ${fail} 项失败`);
  process.exitCode = 1;
} else {
  console.log('✅ 全部通过');
}
