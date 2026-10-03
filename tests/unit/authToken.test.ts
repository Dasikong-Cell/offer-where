/**
 * `server/services/authToken.ts` 的纯函数单测。
 *
 * 这里钉的是**判据本身**：哪些路径能匿名读、哪些是控制台资源、配对相关路径怎么放行、
 * 签名 URL 怎么算。它们原先只有源码文本断言（"代码里写了这个方法"）与真起服务的探针兜底，
 * 改错一个 `includes` 或漏一个扩展名不会有任何单测变红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPublicReadGet, isConsoleAsset, isGuideAsset, isPairAnonRequest,
  isAuthEnabled, extractToken, isAuthorizedStrict, safeEqual,
  signStaticPath, isAuthorizedStaticRes, getAuthToken,
  PUBLIC_READ_GET_PATHS, SIDE_EFFECT_GET_PATHS, PAIR_PAGE_PATHS, PAIR_ANON_POST_PATHS,
} from '../../server/services/authToken.js';

// ── isPublicReadGet：白名单 GET ────────────────────────────────────────────
test('isPublicReadGet: 探活/元信息 GET 放行', () => {
  for (const p of PUBLIC_READ_GET_PATHS) {
    assert.equal(isPublicReadGet('GET', p), true, `${p} 应放行`);
  }
});
test('isPublicReadGet: 含个人信息的 GET 不放行（只读 ≠ 无隐私）', () => {
  for (const p of ['/api/jobs', '/api/applications', '/api/profile', '/api/resume/file', '/api/logs/today', '/api/sessions']) {
    assert.equal(isPublicReadGet('GET', p), false, `${p} 不应匿名可读`);
  }
});
test('isPublicReadGet: 非读方法一律不放行', () => {
  assert.equal(isPublicReadGet('POST', '/api/ping'), false);
  assert.equal(isPublicReadGet('DELETE', '/api/version'), false);
});
test('isPublicReadGet: HEAD 与 GET 同等对待', () => {
  assert.equal(isPublicReadGet('HEAD', '/api/ping'), true);
});
test('isPublicReadGet: 副作用清单优先 —— 即使被误加进白名单也拦住', () => {
  for (const p of SIDE_EFFECT_GET_PATHS) {
    assert.equal(isPublicReadGet('GET', p), false, `${p} 是带副作用的 GET（如 realSend=1）`);
  }
});
test('isPublicReadGet: 区分大小写与精确匹配（/api/ping/extra 不算）', () => {
  assert.equal(isPublicReadGet('GET', '/api/ping/extra'), false);
  assert.equal(isPublicReadGet('get', '/api/ping'), true, '方法名应大小写不敏感');
});

// ── isConsoleAsset ─────────────────────────────────────────────────────────
test('isConsoleAsset: 控制台自身资源放行（否则连页面都打不开）', () => {
  for (const p of ['/', '/console.html', '/manifest.webmanifest', '/sw.js', '/app.ico']) {
    assert.equal(isConsoleAsset('GET', p), true, `${p} 是控制台资源`);
  }
});
test('isConsoleAsset: 只有读方法', () => {
  assert.equal(isConsoleAsset('POST', '/'), false);
});
test('isConsoleAsset: 显式清单而非目录放行（public/ 里的数据文件不会自动公开）', () => {
  // 这条判据的意义：哪天 public/ 多放一个导出的 CSV，不应被自动带出去
  assert.equal(isConsoleAsset('GET', '/export.csv'), false);
  assert.equal(isConsoleAsset('GET', '/data/evidence/a.png'), false);
});

// ── isGuideAsset：使用说明页 ───────────────────────────────────────────────
test('isGuideAsset: 目录请求放行（落到 index.html）', () => {
  assert.equal(isGuideAsset('GET', '/guide'), true);
  assert.equal(isGuideAsset('GET', '/guide/'), true);
});
test('isGuideAsset: 文档类扩展名放行', () => {
  for (const p of ['/guide/index.html', '/guide/img/step1.png', '/guide/a.webp', '/guide/b.svg']) {
    assert.equal(isGuideAsset('GET', p), true, `${p} 应放行`);
  }
});
test('isGuideAsset: 数据类扩展名不放行（只读 ≠ 无隐私）', () => {
  for (const p of ['/guide/data.csv', '/guide/x.json', '/guide/resume.pdf', '/guide/a.txt']) {
    assert.equal(isGuideAsset('GET', p), false, `${p} 不应匿名可读`);
  }
});
test('isGuideAsset: 路径穿越拿不到白名单里的扩展名', () => {
  // `/guide/../.env` 的 extname 是 `.env`，不在白名单 ⇒ 挡住
  assert.equal(isGuideAsset('GET', '/guide/../.env'), false);
  assert.equal(isGuideAsset('GET', '/guide/sub/../../.env'), false);
});
test('isGuideAsset: 前缀相近的兄弟目录不算（/guidex/）', () => {
  assert.equal(isGuideAsset('GET', '/guidex/a.png'), false);
});

// ── isPairAnonRequest：配对相关路径 ────────────────────────────────────────
test('isPairAnonRequest: 配对页与换凭证接口必须匿名可达（否则死循环）', () => {
  for (const p of PAIR_PAGE_PATHS) assert.equal(isPairAnonRequest('GET', p), true, `${p} 应放行`);
  for (const p of PAIR_ANON_POST_PATHS) assert.equal(isPairAnonRequest('POST', p), true, `${p} 应放行`);
  assert.equal(isPairAnonRequest('GET', '/api/pair/code'), true, '回环读配对码要先能进来（再由路由判回环）');
});
test('isPairAnonRequest: 不放行配对之外的任何东西', () => {
  assert.equal(isPairAnonRequest('GET', '/api/jobs'), false);
  assert.equal(isPairAnonRequest('POST', '/pair'), false, '配对页只应是 GET');
  assert.equal(isPairAnonRequest('POST', '/api/resume/upload'), false);
  assert.equal(isPairAnonRequest('DELETE', '/api/pair'), false);
});

// ── isAuthEnabled：开关优先级 ──────────────────────────────────────────────
function withEnv(kv: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(kv)) { saved[k] = process.env[k]; }
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

test('isAuthEnabled: 未设 env 时，回环关闭、非回环自动开启', () => {
  withEnv({ REQUIRE_AUTH: undefined }, () => {
    assert.equal(isAuthEnabled('127.0.0.1'), false, '本机自用零影响');
    assert.equal(isAuthEnabled('localhost'), false);
    assert.equal(isAuthEnabled('0.0.0.0'), true, '暴露到局域网必须自动开鉴权');
    assert.equal(isAuthEnabled('192.168.1.5'), true);
  });
});
test('isAuthEnabled: 显式 env 覆盖自动判断', () => {
  withEnv({ REQUIRE_AUTH: '1' }, () => assert.equal(isAuthEnabled('127.0.0.1'), true));
  withEnv({ REQUIRE_AUTH: '0' }, () => assert.equal(isAuthEnabled('0.0.0.0'), false));
});

// ── 令牌提取与校验 ─────────────────────────────────────────────────────────
test('extractToken: 支持 X-Auth-Token 与 Authorization: Bearer', () => {
  assert.equal(extractToken({ headers: { 'x-auth-token': 'abc' } }), 'abc');
  assert.equal(extractToken({ headers: { authorization: 'Bearer abc' } }), 'abc');
  assert.equal(extractToken({ headers: { authorization: 'bearer abc' } }), 'abc');
  assert.equal(extractToken({ headers: {} }), '');
  assert.equal(extractToken({}), '');
});
test('safeEqual: 相等为真、不等/长度不同为假', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', ''), true);
});
test('isAuthorizedStrict: 正确令牌通过、错令牌拒绝、空令牌拒绝', () => {
  const token = getAuthToken();
  assert.ok(token.length > 0, '令牌应可获取');
  assert.equal(isAuthorizedStrict({ headers: { 'x-auth-token': token } }), true);
  assert.equal(isAuthorizedStrict({ headers: { authorization: `Bearer ${token}` } }), true);
  assert.equal(isAuthorizedStrict({ headers: { 'x-auth-token': token + 'x' } }), false);
  assert.equal(isAuthorizedStrict({ headers: {} }), false);
});

// ── 静态资源签名 URL ───────────────────────────────────────────────────────
function signedQuery(pathname: string): string {
  const signed = signStaticPath(pathname);
  const q = signed.indexOf('?');
  return q >= 0 ? signed.slice(q + 1) : '';
}

test('签名 URL: 正确签名放行（浏览器取图发不出请求头，只能把授权放进 URL）', () => {
  const p = '/data/evidence/a.png';
  const req = { method: 'GET', path: p, query: { t: signedQuery(p).replace(/^t=/, '') } };
  assert.equal(isAuthorizedStaticRes(req), true);
});
test('签名 URL: 签名绑定路径 —— A 图的签名不能读 B 图', () => {
  const t = signedQuery('/data/evidence/a.png').replace(/^t=/, '');
  assert.equal(isAuthorizedStaticRes({ method: 'GET', path: '/data/evidence/b.png', query: { t } }), false);
});
test('签名 URL: 篡改签名被拒', () => {
  const p = '/data/evidence/a.png';
  const t = signedQuery(p).replace(/^t=/, '');
  const tampered = t.slice(0, -1) + (t.slice(-1) === 'a' ? 'b' : 'a');
  assert.equal(isAuthorizedStaticRes({ method: 'GET', path: p, query: { t: tampered } }), false);
});
test('签名 URL: 没有签名参数被拒', () => {
  assert.equal(isAuthorizedStaticRes({ method: 'GET', path: '/data/evidence/a.png', query: {} }), false);
});
test('签名 URL: 不在白名单前缀的路径一律拒绝', () => {
  const p = '/api/jobs';
  const req = { method: 'GET', path: p, query: { t: signedQuery(p).replace(/^t=/, '') } };
  assert.equal(isAuthorizedStaticRes(req), false, '签名只对"下载/展示型"端点有效，不能蔓延到 JSON API');
});
test('签名 URL: 格式不合法一律拒绝（缺分隔点 / exp 非数字）', () => {
  const p = '/data/evidence/a.png';
  for (const t of ['abc', 'x.deadbeef', '.deadbeef', '', 'deadbeef.']) {
    assert.equal(isAuthorizedStaticRes({ method: 'GET', path: p, query: { t } }), false, `t=${JSON.stringify(t)}`);
  }
});
test('签名 URL: 超过有效期即失效（用 1 秒 TTL 实测，不 mock 时间）', async () => {
  const p = '/data/evidence/a.png';
  // ⚠️ 刻意用「短 TTL + 真等 1.1 秒」而不是 mock 时间：`node:test` 的 mock.timers
  //    在这里没能拦住模块内部的 `Date.now()`（试过，断言不翻红），
  //    而"过期不生效"是一条**安全属性**，宁可贵 1 秒也要确定性。
  const signed = signStaticPath(p, 1000);
  const t = signed.slice(signed.indexOf('?') + 1).replace(/^t=/, '');
  assert.equal(isAuthorizedStaticRes({ method: 'GET', path: p, query: { t } }), true, '签完立刻用应有效');
  await new Promise((r) => setTimeout(r, 1150));
  assert.equal(isAuthorizedStaticRes({ method: 'GET', path: p, query: { t } }), false,
    '过期签名仍有效 ⇒ 链接被复制出去后就长期可读');
});
test('签名 URL: 非读方法不放行', () => {
  const p = '/data/evidence/a.png';
  assert.equal(isAuthorizedStaticRes({ method: 'POST', path: p, query: { t: signedQuery(p).replace(/^t=/, '') } }), false);
});
