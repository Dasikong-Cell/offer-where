/**
 * `server/services/pairing.ts` 的纯函数单测。
 *
 * 配对**行为**（局域网陌生人拿不到令牌、码用过即废、限速生效）由
 * `_tools/_pairing_probe.mjs`（21 条，真起两个后端）覆盖。
 * 这里钉的是解析与开关这类容易写错的边角：cookie 解析、Set-Cookie 属性、env 开关。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readCookie, buildPairSetCookie, isPairingEnabled, isPairedRequest,
  PAIR_COOKIE, PAIR_MAX_AGE_SEC,
} from '../../server/services/pairing.js';

function withEnv(kv: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(kv)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(kv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

// ── readCookie ─────────────────────────────────────────────────────────────
test('readCookie: 从多个 cookie 中挑出目标', () => {
  const req = { headers: { cookie: 'a=1; ow_pair=xyz; b=2' } };
  assert.equal(readCookie(req, 'ow_pair'), 'xyz');
});
test('readCookie: 容忍多余空格与无空格写法', () => {
  assert.equal(readCookie({ headers: { cookie: 'a=1;ow_pair=xyz' } }, 'ow_pair'), 'xyz');
  assert.equal(readCookie({ headers: { cookie: '  ow_pair = xyz  ' } }, 'ow_pair'), 'xyz');
});
test('readCookie: 值会被 URL 解码', () => {
  assert.equal(readCookie({ headers: { cookie: 'ow_pair=a%2Eb' } }, 'ow_pair'), 'a.b');
});
test('readCookie: 不存在 / 无 header / 空 req 都返回空串', () => {
  assert.equal(readCookie({ headers: { cookie: 'a=1' } }, 'ow_pair'), '');
  assert.equal(readCookie({ headers: {} }, 'ow_pair'), '');
  assert.equal(readCookie({}, 'ow_pair'), '');
  assert.equal(readCookie(null, 'ow_pair'), '');
});
test('readCookie: 不把前一个 cookie 的后缀误当成命中（前缀匹配陷阱）', () => {
  // `xow_pair=evil` 不该被认成 ow_pair
  assert.equal(readCookie({ headers: { cookie: 'xow_pair=evil' } }, 'ow_pair'), '');
});

// ── buildPairSetCookie ─────────────────────────────────────────────────────
test('buildPairSetCookie: 安全属性齐全', () => {
  const c = buildPairSetCookie('dev.sig', 3600);
  assert.ok(c.startsWith(`${PAIR_COOKIE}=dev.sig`), c);
  assert.match(c, /Path=\//);
  assert.match(c, /Max-Age=3600/);
  assert.match(c, /HttpOnly/, '前端脚本不该能读到设备凭证');
  assert.match(c, /SameSite=Lax/);
});
test('buildPairSetCookie: 刻意不带 Secure（局域网是 http，带了浏览器会丢弃 cookie）', () => {
  assert.doesNotMatch(buildPairSetCookie('a.b', 60), /Secure/,
    '设了 Secure ⇒ 局域网(http)下配对永远不生效，且症状是"配对成功但刷新又要配对"');
});
test('PAIR_MAX_AGE_SEC: 是长期有效的正数（用户自己的设备不该频繁重配）', () => {
  assert.ok(PAIR_MAX_AGE_SEC >= 24 * 3600, `实际 ${PAIR_MAX_AGE_SEC}`);
});

// ── isPairingEnabled ───────────────────────────────────────────────────────
test('isPairingEnabled: 默认开启（安全性默认在）', () => {
  withEnv({ PAIRING: undefined }, () => assert.equal(isPairingEnabled(), true));
});
test('isPairingEnabled: off / 0 / false 关闭（大小写不敏感）', () => {
  for (const v of ['off', 'OFF', '0', 'false', ' off ']) {
    withEnv({ PAIRING: v }, () => assert.equal(isPairingEnabled(), false, `PAIRING=${v}`));
  }
});
test('isPairingEnabled: 其它值都按开启处理（失败方向是安全的）', () => {
  for (const v of ['on', '1', 'yes', 'maybe']) {
    withEnv({ PAIRING: v }, () => assert.equal(isPairingEnabled(), true, `PAIRING=${v}`));
  }
});

// ── isPairedRequest：不成立的凭证一律 false ────────────────────────────────
test('isPairedRequest: 无 cookie ⇒ false', () => {
  assert.equal(isPairedRequest({ headers: {} }), false);
  assert.equal(isPairedRequest({}), false);
  assert.equal(isPairedRequest(null), false);
});
test('isPairedRequest: 格式不合法 ⇒ false（缺少分隔点 / 空 id / 空签名）', () => {
  for (const v of ['abc', '.sig', 'id.', '', 'a.b.c.d']) {
    assert.equal(isPairedRequest({ headers: { cookie: `${PAIR_COOKIE}=${v}` } }), false, `值=${JSON.stringify(v)}`);
  }
});
test('isPairedRequest: 签名不匹配 ⇒ false（HMAC 验签生效）', () => {
  assert.equal(isPairedRequest({ headers: { cookie: `${PAIR_COOKIE}=deadbeef.deadbeef` } }), false);
});
