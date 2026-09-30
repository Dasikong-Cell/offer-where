/**
 * 反向隧道 · 客户端（跑在「本机的那台电脑」上，与 OfferWhere 后端同一台机器）
 * ==========================================================================
 * 作用：把本机回环上的 OfferWhere 后端，通过一条**主动出站**的 WebSocket 挂到公网中继，
 *      从而在外网（手机蜂窝网络 / 公司电脑）也能打开自己的控制台。
 *
 * 为什么是出站：家庭宽带多在 NAT 后面，入站端口映射既不稳也不安全。
 *   本客户端只发起到中继的**出站**连接 ⇒ 路由器无需开放任何端口、无需公网 IP、无需 DDNS。
 *
 * 拓扑：
 *   浏览器 ──https──> nginx/Caddy（TLS 终止）──http──> relay.mjs ──ws──> 本客户端 ──http──> 127.0.0.1:4400
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 两条安全铁律（本文件的存在意义之一）
 *
 *   ① 后端必须开着令牌鉴权：`REQUIRE_AUTH=1`。
 *      默认 HOST=127.0.0.1 时鉴权是**关闭**的 —— 一旦隧道挂上去，
 *      公网任何人猜到子域名就能直接操作（含**不可撤销的真实投递**）。
 *      本客户端启动时会主动探测后端是否真的会 401，不通过就拒绝启动（见 preflight）。
 *
 *   ② 转发时必须**带上 X-Forwarded-For / X-Real-IP**。
 *      否则后端看到的 remoteAddress 是 127.0.0.1 且没有任何转发头 ⇒ 会被判定为
 *      「本机直连」⇒ 把 48 位访问令牌**注入到公网可读的首页 HTML 里**（2026-09-30 实测的漏洞）。
 *      本客户端无条件设置这两个头，不依赖 nginx 配置正确。
 *
 * 用法（在「本机」上跑，与后端同一台机器）：
 *   RELAY_URL=wss://abc.example.com/__tunnel \
 *   TUNNEL_KEY=abc \
 *   TUNNEL_SECRET=<与中继的 TUNNEL_KEYS 一致> \
 *   TARGET=http://127.0.0.1:4400 \
 *   node relay/client.mjs
 *
 * 也支持命令行参数（不推荐传密钥：argv 会出现在进程列表里）：
 *   node relay/client.mjs --url wss://... --key abc
 *   （密钥请走环境变量 TUNNEL_SECRET，或 TUNNEL_SECRET_FILE 指向一个只读文件）
 */

import http from 'node:http';
import fs from 'node:fs';
import { WebSocket } from 'ws';

// ── 参数解析 ────────────────────────────────────────────────────────────────
function argValue(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : '';
}
function readSecret() {
  const direct = String(process.env.TUNNEL_SECRET || '').trim();
  if (direct) return direct;
  const file = String(process.env.TUNNEL_SECRET_FILE || '').trim();
  if (file) {
    try { return fs.readFileSync(file, 'utf8').trim(); } catch (e) {
      console.error(`无法读取 TUNNEL_SECRET_FILE=${file}：${e.message}`);
      process.exit(1);
    }
  }
  return '';
}

const RELAY_URL = String(process.env.RELAY_URL || argValue('url') || '').trim();
const TUNNEL_KEY = String(process.env.TUNNEL_KEY || argValue('key') || '').trim().toLowerCase();
const TUNNEL_SECRET = readSecret();
const TARGET = String(process.env.TARGET || argValue('target') || 'http://127.0.0.1:4400').trim();
const MAX_BODY = Number(process.env.MAX_BODY || 8 * 1024 * 1024);
/** 传输层每帧体积上限（base64 膨胀 ~4/3，再留余量） */
const MAX_PAYLOAD = MAX_BODY * 2;

if (!RELAY_URL || !TUNNEL_KEY) {
  console.error('缺少 RELAY_URL / TUNNEL_KEY。示例：');
  console.error('  RELAY_URL=wss://abc.example.com/__tunnel TUNNEL_KEY=abc TUNNEL_SECRET=xxx node relay/client.mjs');
  process.exit(1);
}
if (process.argv.includes('--secret')) {
  console.error('⚠️ 不要用命令行传密钥（argv 会出现在进程列表 / 日志里）。请改用环境变量 TUNNEL_SECRET。');
}

const targetUrl = new URL(TARGET);
const TARGET_PORT = Number(targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80));
const TARGET_HOST = targetUrl.hostname;

/** 逐跳首部：转发时必须剥掉（RFC 7230 §6.1） */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
]);

const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);

// ── ① 启动自检：后端必须真的开着鉴权，否则拒绝启动 ───────────────────────────
/**
 * 探测 `GET /api/selfcheck`（或任一受保护接口）是否返回 401。
 * ⚠️ 这里**故意不带令牌**发请求：
 *   - 401 ⇒ 鉴权开启 ⇒ 安全，可以挂隧道
 *   - 200 ⇒ 鉴权关闭 ⇒ **拒绝启动**，否则等于把不可撤销的投递能力无认证地挂上公网
 * 为什么要在客户端做这件事：用户很容易忘记设 REQUIRE_AUTH=1，
 *   而这个疏漏的后果（公网任何人可投递）与「忘了加个环境变量」完全不成比例 ⇒ 必须 fail-closed。
 */
function preflight() {
  return new Promise((resolve) => {
    const req = http.request(
      { host: TARGET_HOST, port: TARGET_PORT, path: '/api/selfcheck', method: 'GET', timeout: 5000 },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode });
      },
    );
    req.on('timeout', () => { req.destroy(new Error('探测超时')); });
    req.on('error', (e) => resolve({ error: e }));
    req.end();
  });
}

const probe = await preflight();
if (probe.error) {
  console.error(`\n🔴 连不上本机后端 ${TARGET}：${probe.error.message}`);
  console.error('   请先启动 OfferWhere 后端（PORT=4400），再运行本客户端。\n');
  process.exit(1);
}
if (probe.status !== 401 && probe.status !== 403) {
  console.error(`\n🔴 拒绝启动：后端未开启令牌鉴权（探测返回 ${probe.status}，期望 401）。`);
  console.error('');
  console.error('   当前配置下，公网任何人在浏览器里打开隧道地址就能：');
  console.error('     · 下载你的在线简历');
  console.error('     · 触发**不可撤销的真实投递**与自动回复发信');
  console.error('');
  console.error('   修法：后端改用以下环境变量启动（HOST 保持回环，只经隧道出入）：');
  console.error('     HOST=127.0.0.1  REQUIRE_AUTH=1  PORT=4400');
  console.error('   隧道场景还需把公网域名加进来源白名单（否则写请求 403）：');
  console.error('     EXTRA_ORIGINS=https://<你的子域名>');
  console.error('');
  console.error('   需要临时跳过（仅本机调试，切勿对公网）：加 --allow-no-auth\n');
  if (!process.argv.includes('--allow-no-auth')) process.exit(1);
  log('⚠️ 已按 --allow-no-auth 跳过鉴权自检 —— 请勿在此状态下对公网开放！');
} else {
  log(`✓ 后端鉴权已开启（探测 ${TARGET}/api/selfcheck -> ${probe.status}）`);
}

// ── ② 把一条隧道请求转发给本机后端 ──────────────────────────────────────────
/** 把后端响应回灌给中继；两条路径（正常/出错）都要发一帧，否则中继侧会等到超时 */
function sendFrame(ws, frame) {
  try {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
  } catch (e) {
    log('✗ 回传帧失败：' + (e?.message || e));
  }
}

function forwardToLocal(ws, msg) {
  const headers = { ...(msg.headers || {}) };
  for (const k of Object.keys(headers)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) delete headers[k];
  }

  // 🔴 安全铁律②：无条件带上转发头，确保后端不把隧道流量误判成「本机直连」
  //    （误判的后果是把访问令牌注入公网可读的首页 HTML）
  const remote = String(msg.clientIp || '').trim();
  const prevXff = String(headers['x-forwarded-for'] || headers['X-Forwarded-For'] || '').trim();
  headers['x-forwarded-for'] = [prevXff, remote].filter(Boolean).join(', ') || 'tunnel';
  headers['x-real-ip'] = String(headers['x-real-ip'] || '').trim() || remote || 'tunnel';

  const body = msg.bodyB64 ? Buffer.from(msg.bodyB64, 'base64') : null;

  const req = http.request(
    {
      host: TARGET_HOST,
      port: TARGET_PORT,
      method: msg.method || 'GET',
      path: msg.url || '/',
      headers,
    },
    (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          req.destroy();
          sendFrame(ws, {
            t: 'res', id: msg.id, status: 502,
            headers: { 'content-type': 'text/plain; charset=utf-8' },
            bodyB64: Buffer.from('响应体超过上限').toString('base64'),
          });
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        const out = { ...res.headers };
        for (const k of Object.keys(out)) {
          if (HOP_BY_HOP.has(k.toLowerCase())) delete out[k];
        }
        const buf = Buffer.concat(chunks);
        sendFrame(ws, {
          t: 'res', id: msg.id, status: res.statusCode, headers: out,
          bodyB64: buf.length ? buf.toString('base64') : '',
        });
      });
      res.on('error', () => {
        sendFrame(ws, { t: 'res', id: msg.id, status: 502, headers: {}, bodyB64: '' });
      });
    },
  );

  req.on('error', (e) => {
    sendFrame(ws, {
      t: 'res', id: msg.id, status: 502,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      bodyB64: Buffer.from('本机后端未响应：' + (e?.message || e)).toString('base64'),
    });
  });

  if (body && body.length) req.write(body);
  req.end();
}

// ── ③ 连接中继，断线指数退避重连 ────────────────────────────────────────────
let backoff = 1000;
const BACKOFF_MAX = 30_000;
let ws = null;
let closedByUs = false;

function connect() {
  const url = new URL(RELAY_URL);
  url.searchParams.set('key', TUNNEL_KEY);
  if (TUNNEL_SECRET) url.searchParams.set('secret', TUNNEL_SECRET);

  log(`连接中继 ${url.origin}${url.pathname} key=${TUNNEL_KEY} …`);
  ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: MAX_PAYLOAD, handshakeTimeout: 15_000 });

  ws.on('open', () => {
    backoff = 1000;
    log('✓ 隧道已建立');
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.t === 'req' && msg.id) forwardToLocal(ws, msg);
    // welcome 帧忽略
  });

  ws.on('close', (code, reason) => {
    if (closedByUs) return;
    const why = reason ? String(reason) : '';
    log(`✗ 隧道断开 code=${code} ${why} —— ${Math.round(backoff / 1000)}s 后重连`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, BACKOFF_MAX);
  });

  ws.on('error', (e) => {
    // close 会跟着触发，这里只记原因（避免重复重连）
    log('隧道出错：' + (e?.message || e));
  });
}

connect();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    closedByUs = true;
    log('收到退出信号，断开隧道');
    try { ws?.close(1000, 'client shutdown'); } catch { /* ignore */ }
    process.exit(0);
  });
}
