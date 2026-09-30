/**
 * 反向隧道端到端自检（会 spawn 子进程 ⇒ 刻意不进 `npm test` / `npm run verify`）
 * ==========================================================================
 * 为什么必须真跑一遍：隧道的正确性全在**进程间**（浏览器 → 中继 → 客户端 → 后端），
 * 静态断言只能证明「代码里写了某行」，证明不了「这条链路真的通、且真的不泄露令牌」。
 * 本仓库已有教训：静态断言全绿，页面却是错的（PWA 引导条层叠那次）。
 *
 * 一个进程里跑完（沙箱不能留常驻进程）：
 *   · 进程内起「假后端」—— 但它用的是**真实的** `canInjectToken`（从 server/services 导入），
 *     所以被测的安全判定就是线上那份代码，不是我在测试里重写的一份
 *   · spawn 真 relay/relay.mjs
 *   · spawn 真 relay/client.mjs
 *   · 最后从「公网侧」发请求穿过整条隧道
 *
 * 关键对照（token 泄露）：
 *   ① 经隧道  GET /            -> 必须 NO-TOKEN（中继/客户端补了转发头）
 *   ② 直连    GET /            -> 必须 TOKEN   （本机直连仍注入，没被过度纠正）
 *   同一个假后端、同一个判定函数，差别只在「有没有经过隧道」⇒ ①与②互为对照。
 *
 * 用法：npx tsx scripts/relay_e2e.ts
 */
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canInjectToken } from '../server/services/requestGuard.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MOCK_PORT = 4399;   // 假后端（模拟 OfferWhere 本机服务）
const RELAY_PORT = 4398;  // 中继
const KEY = 'e2e';
const SECRET = 'sekret-e2e';
const TOKEN = 'T'.repeat(48);
const DOMAIN = 'e2e.example.com';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ✅ ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; failures.push(name); console.log(`  🔴 ${name}${detail ? '  — ' + detail : ''}`); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── 假后端：用真实的 canInjectToken 判定是否注入令牌 ─────────────────────────
const seen: Array<{ path: string; xff: string; real: string; body: string }> = [];

const mock = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    seen.push({
      path: String(req.url),
      xff: String(req.headers['x-forwarded-for'] || ''),
      real: String(req.headers['x-real-ip'] || ''),
      body,
    });

    if (String(req.url).startsWith('/api/selfcheck')) {
      const ok = String(req.headers['x-auth-token'] || '') === TOKEN;
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ authEnabled: true, ok }));
      return;
    }

    if (String(req.url).split('?')[0] === '/') {
      // 🔴 与线上 server/index.ts 的 GET / 同构：只有 canInjectToken 为真才注入
      const inject = canInjectToken({
        remoteAddress: req.socket.remoteAddress || '',
        headers: req.headers as Record<string, unknown>,
      });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<html><body>${inject ? 'TOKEN:' + TOKEN : 'NO-TOKEN'}</body></html>`);
      return;
    }

    if (String(req.url) === '/echo') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, body }));
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
});

/** 从「公网侧」发请求：可指定 Host 头（模拟子域名路由） */
function requestThroughRelay(pathname: string, opts: { method?: string; body?: string; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1', port: RELAY_PORT, path: pathname,
        method: opts.method || 'GET',
        headers: { host: `${KEY}.${DOMAIN}`, ...(opts.headers || {}) },
      },
      (res) => {
        const cs: Buffer[] = [];
        res.on('data', (c) => cs.push(c));
        res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(cs).toString('utf8'), headers: res.headers }));
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/** 本机直连假后端（不带任何转发头）—— 对照组 */
function requestDirect(pathname: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: MOCK_PORT, path: pathname, method: 'GET' }, (res) => {
      const cs: Buffer[] = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(cs).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

function relayHealth() {
  return new Promise<{ ok: boolean; tunnels: string[] } | null>((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: RELAY_PORT, path: '/__relay/health', method: 'GET' }, (res) => {
      const cs: Buffer[] = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(cs).toString('utf8'))); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function waitFor(fn: () => Promise<boolean>, ms: number, label: string) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(200);
  }
  console.log(`  ⚠️ 等待超时：${label}`);
  return false;
}

// ── 跑 ──────────────────────────────────────────────────────────────────────
const children: Array<ReturnType<typeof spawn>> = [];

function killAll() {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* ignore */ } }
}

try {
  console.log('\n══════ 反向隧道 端到端自检 ══════\n');

  // 端口预检：占用则早失败（避免把「端口被占」误判成「隧道不通」）
  for (const p of [MOCK_PORT, RELAY_PORT]) {
    const busy = await new Promise<boolean>((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(true));
      s.once('listening', () => s.close(() => resolve(false)));
      s.listen(p, '127.0.0.1');
    });
    if (busy) { console.log(`🔴 端口 ${p} 已被占用，无法进行自检`); process.exit(1); }
  }

  await new Promise<void>((r) => mock.listen(MOCK_PORT, '127.0.0.1', () => r()));
  console.log(`· 假后端已起 127.0.0.1:${MOCK_PORT}（使用真实 canInjectToken 判定）`);

  children.push(spawn(process.execPath, [path.join(ROOT, 'relay/relay.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(RELAY_PORT), HOST: '127.0.0.1', TUNNEL_KEYS: `${KEY}:${SECRET}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  children.push(spawn(process.execPath, [path.join(ROOT, 'relay/client.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      RELAY_URL: `ws://127.0.0.1:${RELAY_PORT}/__tunnel`,
      TUNNEL_KEY: KEY, TUNNEL_SECRET: SECRET, TARGET: `http://127.0.0.1:${MOCK_PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  console.log('· 已 spawn relay.mjs 与 client.mjs');

  const up = await waitFor(async () => {
    const h = await relayHealth();
    return !!h?.ok && h.tunnels.includes(KEY);
  }, 20_000, '隧道建立');
  check('隧道客户端成功注册到中继', up, `key=${KEY}`);

  if (!up) throw new Error('隧道未建立，后续断言无法进行');

  // ── ① 令牌绝不能经隧道泄露 ──
  // ⚠️ 加 `?via=` 区分来源：上面的对照组也打 `/`，
  //    若只按 path 取「最后一条」会取到直连那条 —— 实测踩过（断言 ③/④ 因此假红）。
  const viaTunnel = await requestThroughRelay('/?via=tunnel');
  check('① 经隧道 GET / 不注入令牌（公网看不到令牌）',
    viaTunnel.status === 200 && viaTunnel.body.includes('NO-TOKEN') && !viaTunnel.body.includes(TOKEN),
    `status=${viaTunnel.status} body=${viaTunnel.body.slice(0, 40)}`);

  // ── ② 对照组：本机直连仍注入（证明没有「过度纠正」把本机体验也弄坏）──
  const direct = await requestDirect('/?via=direct');
  check('② 对照：本机直连 GET / 仍注入令牌（本机免填体验不变）',
    direct.body.includes('TOKEN:' + TOKEN),
    direct.body.slice(0, 30));

  // ── ③ 转发头确实被补上了（必须查隧道那条，不是直连那条）──
  const tunnelSeen = seen.filter((s) => s.path === '/?via=tunnel').pop();
  const directSeen = seen.filter((s) => s.path === '/?via=direct').pop();
  check('③ 后端收到的 x-forwarded-for 非空（客户端/中继补齐了）',
    !!tunnelSeen && tunnelSeen.xff.trim() !== '', `xff=${JSON.stringify(tunnelSeen?.xff)}`);
  check('④ 后端收到的 x-real-ip 非空', !!tunnelSeen && tunnelSeen.real.trim() !== '', `real=${JSON.stringify(tunnelSeen?.real)}`);
  // 反向对照：直连那条**不该**有转发头 —— 否则 ① 的通过可能来自别的原因
  check('④b 对照：本机直连那条没有转发头（① 的通过确实来自隧道补头）',
    !!directSeen && directSeen.xff.trim() === '' && directSeen.real.trim() === '',
    `xff=${JSON.stringify(directSeen?.xff)} real=${JSON.stringify(directSeen?.real)}`);

  // ── ⑤ 鉴权语义穿过隧道仍然成立 ──
  const noToken = await requestThroughRelay('/api/selfcheck');
  check('⑤ 无令牌经隧道访问受保护接口 -> 401', noToken.status === 401, `status=${noToken.status}`);

  const withToken = await requestThroughRelay('/api/selfcheck', { headers: { 'x-auth-token': TOKEN } });
  check('⑥ 带令牌经隧道访问同一接口 -> 200（请求头双向透传正常）',
    withToken.status === 200, `status=${withToken.status}`);

  // ── ⑦ 请求体往返完整 ──
  const payload = JSON.stringify({ hello: '世界', n: 42 });
  const echo = await requestThroughRelay('/echo', { method: 'POST', body: payload, headers: { 'content-type': 'application/json' } });
  let echoOk = false;
  try { echoOk = JSON.parse(echo.body).body === payload; } catch { /* ignore */ }
  check('⑦ POST 请求体经隧道往返完整（含非 ASCII）', echo.status === 200 && echoOk, echo.body.slice(0, 60));

  // ── ⑧ 未连接的子域名 -> 502 且给出可读提示 ──
  const noTunnel = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: RELAY_PORT, path: '/', method: 'GET', headers: { host: 'nobody.example.com' } }, (res) => {
      const cs: Buffer[] = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(cs).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
  check('⑧ 无隧道在线时返回 502 且提示可读（不是挂住或空响应）',
    noTunnel.status === 502 && noTunnel.body.includes('隧道未连接'), `status=${noTunnel.status}`);

  // ── ⑨ 密钥错误的客户端不得注册 ──
  const rogue = spawn(process.execPath, [path.join(ROOT, 'relay/client.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      RELAY_URL: `ws://127.0.0.1:${RELAY_PORT}/__tunnel`,
      TUNNEL_KEY: 'rogue', TUNNEL_SECRET: 'wrong-secret', TARGET: `http://127.0.0.1:${MOCK_PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(rogue);
  // 给 client.mjs 一点时间去完成 preflight 再连（preflight 通过才会连）
  await sleep(1500);
  const h2 = await relayHealth();
  check('⑨ 密钥错误的客户端无法注册隧道', !!h2 && !h2.tunnels.includes('rogue'),
    `在线隧道=${JSON.stringify(h2?.tunnels)}`);
} catch (e: any) {
  check('自检过程未抛异常', false, String(e?.message || e));
} finally {
  killAll();
  try { mock.close(); } catch { /* ignore */ }
  // 给子进程一点时间真正退出（SIGKILL 已发，这里只是避免端口 TIME_WAIT 干扰下一轮）
  await sleep(300);
}

console.log(`\n══════ 汇总 ══════`);
console.log(`通过 ${pass} / 共 ${pass + fail}`);
if (fail) {
  console.log('失败项：');
  for (const f of failures) console.log(' - ' + f);
}
process.exit(fail ? 1 : 0);
