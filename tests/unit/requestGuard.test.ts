/**
 * `server/services/requestGuard.ts` 的纯函数单测。
 *
 * 这些函数是**来源校验**与**令牌注入**的判据本身 —— 原来只由合约测试的源码文本断言
 * 和真起服务的探针间接覆盖，缺一层"直接喂输入、断言输出"的单元测试：
 * 改错一个边界（比如把 `172.32` 也算成私有）不会有任何东西变红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeIp, isLoopbackIp, isPrivateIp, isPrivateIpv6,
  lanOriginsFromIps, buildAllowedOrigins, checkRequestOrigin, canInjectToken,
} from '../../server/services/requestGuard.js';

// ── normalizeIp ────────────────────────────────────────────────────────────
const NORMALIZE_CASES: Array<[string, string]> = [
  ['::ffff:192.168.1.5', '192.168.1.5'],   // IPv4-mapped IPv6（Node 在双栈监听下给出的就是这种）
  ['[::1]', '::1'],                        // 带方括号的 IPv6 字面量
  ['  127.0.0.1  ', '127.0.0.1'],          // 首尾空白
  ['::FFFF:10.0.0.1', '10.0.0.1'],         // 大小写不敏感
  ['', ''],
];
for (const [input, want] of NORMALIZE_CASES) {
  test(`normalizeIp(${JSON.stringify(input)}) === ${JSON.stringify(want)}`, () => {
    assert.equal(normalizeIp(input), want);
  });
}

// ── isLoopbackIp ───────────────────────────────────────────────────────────
const LOOPBACK_TRUE = ['127.0.0.1', '::1', '127.5.6.7', '::ffff:127.0.0.1'];
const LOOPBACK_FALSE = ['192.168.1.1', '10.0.0.1', '', '128.0.0.1', '::2'];
for (const ip of LOOPBACK_TRUE) {
  test(`isLoopbackIp(${ip}) 为真`, () => assert.equal(isLoopbackIp(ip), true));
}
for (const ip of LOOPBACK_FALSE) {
  test(`isLoopbackIp(${JSON.stringify(ip)}) 为假`, () => assert.equal(isLoopbackIp(ip), false));
}

// ── isPrivateIp（RFC1918 + 169.254 链路本地）───────────────────────────────
const PRIVATE_TRUE = ['10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.254', '192.168.1.1', '169.254.1.1'];
// 172.32 与 172.15 是**公网**地址段 —— 边界错一格就会把公网当内网，进而注入令牌
const PRIVATE_FALSE = ['172.32.0.1', '172.15.255.255', '11.0.0.1', '192.169.1.1', '8.8.8.8', '127.0.0.1', '::1'];
for (const ip of PRIVATE_TRUE) {
  test(`isPrivateIp(${ip}) 为真`, () => assert.equal(isPrivateIp(ip), true));
}
for (const ip of PRIVATE_FALSE) {
  test(`isPrivateIp(${ip}) 为假`, () => assert.equal(isPrivateIp(ip), false));
}

// ── isPrivateIpv6 ──────────────────────────────────────────────────────────
for (const ip of ['fe80::1', 'fc00::1', 'fd12:3456::1']) {
  test(`isPrivateIpv6(${ip}) 为真`, () => assert.equal(isPrivateIpv6(ip), true));
}
for (const ip of ['2001:db8::1', '::1', '2606:4700::1']) {
  test(`isPrivateIpv6(${ip}) 为假`, () => assert.equal(isPrivateIpv6(ip), false));
}

// ── lanOriginsFromIps ──────────────────────────────────────────────────────
test('lanOriginsFromIps: 拼出 http://<ip>:<port>，跳过空项', () => {
  assert.deepEqual(
    lanOriginsFromIps(4400, ['192.168.1.5', '', '   ', '10.0.0.7']),
    ['http://192.168.1.5:4400', 'http://10.0.0.7:4400'],
  );
});

// ── buildAllowedOrigins ────────────────────────────────────────────────────
test('buildAllowedOrigins: 含回环两址 + Vite 5173', () => {
  const s = buildAllowedOrigins(4400);
  for (const o of ['http://127.0.0.1:4400', 'http://localhost:4400', 'http://127.0.0.1:5173', 'http://localhost:5173']) {
    assert.ok(s.has(o), `缺少 ${o}`);
  }
});
test('buildAllowedOrigins: extra 会被去尾斜杠后并入', () => {
  const s = buildAllowedOrigins(4400, ['http://192.168.1.5:4400/', '  ', 'http://10.0.0.7:4400']);
  assert.ok(s.has('http://192.168.1.5:4400'), '尾斜杠未去掉 ⇒ 同源判断会漏');
  assert.ok(s.has('http://10.0.0.7:4400'));
});

// ── checkRequestOrigin ─────────────────────────────────────────────────────
const ALLOWED = buildAllowedOrigins(4400, ['http://192.168.1.5:4400']);

test('checkRequestOrigin: OPTIONS 预检放行（由中间件短路处理 CORS 头）', () => {
  assert.deepEqual(checkRequestOrigin({ method: 'OPTIONS', origin: 'http://evil.example.com', allowed: ALLOWED }), { ok: true });
});
test('checkRequestOrigin: 白名单 Origin 放行', () => {
  assert.deepEqual(checkRequestOrigin({ method: 'GET', origin: 'http://192.168.1.5:4400', allowed: ALLOWED }), { ok: true });
});
test('checkRequestOrigin: 非白名单 Origin 拒绝（恶意页面静默调用）', () => {
  const r = checkRequestOrigin({ method: 'POST', origin: 'http://evil.example.com', allowed: ALLOWED });
  assert.equal(r.ok, false);
});
test('checkRequestOrigin: 无 Origin + Sec-Fetch-Site: cross-site 拒绝', () => {
  const r = checkRequestOrigin({ method: 'GET', origin: undefined, secFetchSite: 'cross-site', allowed: ALLOWED });
  assert.equal(r.ok, false);
});
test('checkRequestOrigin: 无 Origin（curl / 双击启动器）放行', () => {
  assert.deepEqual(checkRequestOrigin({ method: 'GET', origin: undefined, allowed: ALLOWED }), { ok: true });
});
test('checkRequestOrigin: same-origin 放行', () => {
  assert.deepEqual(checkRequestOrigin({ method: 'GET', secFetchSite: 'same-origin', allowed: ALLOWED }), { ok: true });
});
test('checkRequestOrigin: 只读方法不豁免 —— 带副作用 GET 同样受来源校验', () => {
  const r = checkRequestOrigin({ method: 'GET', origin: 'http://evil.example.com', allowed: ALLOWED });
  assert.equal(r.ok, false, 'GET 若被无条件放行，<img src> 就能触发 realSend');
});

// ── canInjectToken ─────────────────────────────────────────────────────────
test('canInjectToken: 回环 ⇒ 注入（控制台免填令牌）', () => {
  assert.equal(canInjectToken({ remoteAddress: '127.0.0.1', headers: {} }), true);
});
test('canInjectToken: 私有网段 ⇒ 注入（手机与桌面同一 Wi-Fi）', () => {
  assert.equal(canInjectToken({ remoteAddress: '::ffff:192.168.1.5', headers: {} }), true);
});
test('canInjectToken: 公网地址 ⇒ 不注入', () => {
  assert.equal(canInjectToken({ remoteAddress: '203.0.113.9', headers: {} }), false);
});
test('canInjectToken: 带 X-Forwarded-For ⇒ 不注入（反代/隧道那条路径）', () => {
  assert.equal(canInjectToken({ remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.9' } }), false);
});
test('canInjectToken: 转发头名大小写不敏感（Forwarded 大写也要拦住）', () => {
  assert.equal(canInjectToken({ remoteAddress: '127.0.0.1', headers: { Forwarded: 'for=203.0.113.9' } }), false);
});
test('canInjectToken: 转发头为空串 / 纯空白不算"带转发头"', () => {
  assert.equal(canInjectToken({ remoteAddress: '127.0.0.1', headers: { 'x-real-ip': '   ' } }), true);
});
