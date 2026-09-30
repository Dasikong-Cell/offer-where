/**
 * 反向隧道 · 中继服务端（跑在你的国内轻量服务器上）
 * ==========================================================================
 * 用途：让朋友自己电脑上跑的 OfferWhere 后端，能被外网（手机 / 小程序）访问，
 *      而**朋友家里不需要开任何入站端口**（路由器 NAT 保持关闭）。
 *
 * 为什么用「出站反向隧道」而不是「端口映射」：
 *   - 端口映射 = 把朋友家电脑直接挂到公网，家庭宽带多数是 NAT 的、且 IP 会变
 *   - 反向隧道 = 朋友的电脑**主动连出**到本中继，中继把请求灌进这条连接
 *     ⇒ 不开入站端口、不需要公网 IP、不需要 DDNS
 *
 * 路由方式：按 **Host 首段子域名** 分发
 *   例如 Host: abc.offerwhere.example.com  ->  隧道 key = "abc"
 *   ⇒ 一个域名 + 一个 443 端口，服务任意多个朋友（每人一个子域）
 *
 * 本中继**不存储任何业务数据**，只做字节转发。它能看到明文（TLS 在本机终止），
 * 因此刻意**不记录请求体 / URL / 响应体**，日志只留连接级事件。
 *
 * 运行：
 *   node relay/relay.mjs                 # 默认监听 8080
 *   PORT=8080 HOST=127.0.0.1 node relay/relay.mjs
 *
 * ⚠️ 生产部署时不要直接把本进程暴露到公网 80/443 ——
 *    前面应有一层 nginx / Caddy 负责 TLS 终止并反代到本进程（见 relay/README.md）。
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';

/** 隧道密钥表：key(子域名首段) -> 允许的密钥值。为空则任意 key 都可注册（仅本地调试用） */
const TUNNEL_KEYS = new Map();
for (const pair of String(process.env.TUNNEL_KEYS || '').split(',')) {
  const [k, v] = pair.split(':').map((s) => (s || '').trim());
  if (k && v) TUNNEL_KEYS.set(k.toLowerCase(), v);
}

/** key -> 活跃的隧道连接 */
const tunnels = new Map();

const MAX_BODY = 8 * 1024 * 1024; // 8MB，够放简历 PDF 与截图
const REQ_TIMEOUT_MS = 60_000;

/** 逐跳首部，转发时必须剥掉（RFC 7230 §6.1） */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
]);

const ts = () => new Date().toISOString().slice(11, 19);

/** 从 Host 取子域名首段作为隧道 key；无子域时回退到 X-Tunnel-Key 头（便于本地调试） */
function keyFromRequest(req) {
  const explicit = String(req.headers['x-tunnel-key'] || '').trim().toLowerCase();
  if (explicit) return explicit;
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  const parts = host.split('.');
  // 至少 3 段才认为是「子域.主域.后缀」；少于 3 段时整段当 key（本地 localhost 调试）
  return parts.length >= 3 ? parts[0] : host;
}

/** 把 Node 的 headers 对象扁平化成可 JSON 化的结构（同名多值用数组） */
function flatHeaders(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

/**
 * 🔴 确保转发头存在 —— 不是可选的装饰，是安全不变量。
 * ==========================================================================
 * 本机后端用「有没有转发头」判定「这请求是不是内网直连」，
 * 进而决定要不要把 48 位访问令牌注入首页 HTML（见 requestGuard.canInjectToken）。
 * 若公网请求抵达后端时**一个转发头都没有**，后端就会把它当成「用户自己的设备」
 * ⇒ 把令牌注入到一个**公网谁都能看源码**的页面上 ⇒ 鉴权被完全绕过（2026-09-30 实测的漏洞）。
 *
 * 隧道对端（client.mjs）也会自己补这两个头（双重保险），但中继作为连接公网的那一端，
 * 有责任把**它实际看到的对端 IP** 带进去 —— 客户端无从知道公网 IP 是多少。
 * 若浏览器/中间层已经带了 XFF，则保留（它更接近真实来源），只补缺失项。
 */
function ensureForwardingHeaders(headers, socketAddress) {
  const ip = String(socketAddress || '').trim() || 'unknown';
  const hasXff = Object.keys(headers).some((k) => k.toLowerCase() === 'x-forwarded-for');
  if (!hasXff || !String(headers['x-forwarded-for'] ?? '').trim()) {
    headers['x-forwarded-for'] = ip;
  }
  const hasReal = Object.keys(headers).some((k) => k.toLowerCase() === 'x-real-ip');
  if (!hasReal || !String(headers['x-real-ip'] ?? '').trim()) {
    headers['x-real-ip'] = ip;
  }
  return headers;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体超过 8MB 上限'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 把一条 HTTP 请求通过隧道送到对端，等待响应帧 */
function forwardThroughTunnel(ws, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(payload.id);
      reject(new Error('隧道对端响应超时'));
    }, REQ_TIMEOUT_MS);

    pending.set(payload.id, {
      resolve: (msg) => { clearTimeout(timer); resolve(msg); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });

    try {
      ws.send(JSON.stringify(payload));
    } catch (e) {
      clearTimeout(timer);
      pending.delete(payload.id);
      reject(e);
    }
  });
}

/** 未完成的请求：id -> {resolve,reject} */
const pending = new Map();

// ── HTTP 侧：接收外部请求，转发进隧道 ────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const key = keyFromRequest(req);

  // 健康检查（供 nginx / 监控用）
  if (req.url === '/__relay/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, tunnels: [...tunnels.keys()] }));
    return;
  }

  const entry = tunnels.get(key);
  if (!entry || entry.ws.readyState !== entry.ws.OPEN) {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(
      `隧道未连接：${key}\n\n` +
      `这说明「${key}」的电脑当前没有连上中继。请确认：\n` +
      `  1) 那台电脑上隧道客户端正在运行\n` +
      `  2) 那台电脑的后端（OfferWhere）已启动\n` +
      `  3) 网络可出站访问本中继\n`
    );
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(String(e.message));
    return;
  }

  const id = crypto.randomUUID();
  const clientIp = String(req.socket?.remoteAddress || '').trim();
  try {
    const msg = await forwardThroughTunnel(entry.ws, {
      t: 'req',
      id,
      method: req.method,
      url: req.url,
      // 🔴 转发头必须先补齐再进隧道（安全不变量，见 ensureForwardingHeaders 注释）
      headers: ensureForwardingHeaders(flatHeaders(req.headers), clientIp),
      clientIp,
      bodyB64: body.length ? body.toString('base64') : '',
    });

    const headers = { ...(msg.headers || {}) };
    for (const h of Object.keys(headers)) {
      if (HOP_BY_HOP.has(h.toLowerCase())) delete headers[h];
    }
    res.writeHead(Number(msg.status) || 502, headers);
    res.end(msg.bodyB64 ? Buffer.from(msg.bodyB64, 'base64') : undefined);
  } catch (e) {
    if (!res.headersSent) {
      res.writeHead(504, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('隧道转发失败：' + String(e.message || e));
    }
  }
});

// ── WS 侧：隧道客户端注册与响应回传 ─────────────────────────────────────────
const wss = new WebSocketServer({
  server,
  path: '/__tunnel',
  maxPayload: MAX_BODY * 2, // base64 膨胀 + 余量
  perMessageDeflate: false, // 简历 PDF 已是压缩格式，deflate 只增 CPU
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://placeholder');
  const key = String(url.searchParams.get('key') || '').trim().toLowerCase();
  const secret = String(url.searchParams.get('secret') || '').trim();

  if (!key) {
    ws.close(4000, 'missing key');
    return;
  }
  // 配了密钥表就必须匹配；没配则允许（仅本地调试）
  if (TUNNEL_KEYS.size > 0) {
    const expect = TUNNEL_KEYS.get(key);
    if (!expect || !timingSafeStrEq(expect, secret)) {
      console.log(`[${ts()}] ✗ 拒绝注册 key=${key}（密钥不匹配）`);
      ws.close(4003, 'bad secret');
      return;
    }
  }

  const prev = tunnels.get(key);
  if (prev) prev.ws.close(4001, 'replaced by new connection');
  tunnels.set(key, { ws, since: Date.now() });
  console.log(`[${ts()}] ✓ 隧道已连接 key=${key}  当前在线 ${tunnels.size} 条`);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.t === 'res' && msg.id) {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p.resolve(msg); }
    }
  });

  ws.on('close', () => {
    if (tunnels.get(key)?.ws === ws) {
      tunnels.delete(key);
      console.log(`[${ts()}] ✗ 隧道已断开 key=${key}  当前在线 ${tunnels.size} 条`);
    }
  });

  ws.on('error', () => { /* close 会跟着触发 */ });

  ws.send(JSON.stringify({ t: 'welcome', key, maxBody: MAX_BODY }));
});

/** 常量时间字符串比较（防时序侧信道） */
function timingSafeStrEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch { return false; }
}

server.listen(PORT, HOST, () => {
  console.log(`[${ts()}] 中继已启动  http://${HOST}:${PORT}`);
  console.log(`         隧道注册点 ws://${HOST}:${PORT}/__tunnel?key=<子域>&secret=<密钥>`);
  if (TUNNEL_KEYS.size) {
    console.log(`         已配置 ${TUNNEL_KEYS.size} 个隧道密钥：${[...TUNNEL_KEYS.keys()].join(', ')}`);
  } else {
    console.log('         ⚠️ 未设 TUNNEL_KEYS —— 任意 key 均可注册（仅限本地调试！）');
  }
});
