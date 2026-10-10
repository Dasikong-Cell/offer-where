/**
 * 收件邮箱可投递性单测。
 *
 * ⚠️ 本文件**只测纯函数**（`classifyDns` / `checkShape` / `isRoleOrPlaceholder`），
 *    DNS 结果由用例直接注入，**零网络**。原因有二：
 *    ① 本沙箱 UDP/TCP 53 全被拒（连 `qq.com` 都 `ECONNREFUSED`），真发请求测不稳；
 *    ② 「判定逻辑」和「怎么拿到 DNS」是两件事，混在一起测会导致 CI 上必然红。
 *    真正发 DoH 的 `assessMailbox()` 由 `_tools/_deliver_probe.ts` 对着真域名验收。
 *
 * ⚠️ 最重要的一条断言是 **`probe failed ⇒ unverified`**：
 *    `dns === null` 表示**探针失败**（网络不通），而不是「这个域名没有记录」。
 *    把探针失败判成 dead，会在自己断网时把所有岗位都判死 ——
 *    「一次失败的探测是关于你自己网络的证据，不是关于对方域名的证据」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyDns,
  checkShape,
  isRoleOrPlaceholder,
  splitEmail,
  describeAssessment,
  type MailboxAssessment,
} from '../../server/services/mailDeliverability.js';

const MX_QQ = ['5 mxbiz1.qq.com.'];
const A_ONLY = ['1.2.3.4'];
const v = (email: string, dns: Parameters<typeof classifyDns>[1]) => classifyDns(email, dns).verdict;

// ── A. 核心不变量：探针失败 ≠ 对方有问题 ─────────────────────────────────────
test('🔴 探针失败（dns===null）一律判 unverified，绝不判死', () => {
  for (const email of ['hr@qq.com', 'a@nonexistent-xyz.com', 'bad@@x.com']) {
    const r = classifyDns(email, null);
    // 形状闸门在 DNS 之前：形状就不合法的，即便探针失败也该是 dead/format（见 B 组）
    if (checkShape(email).ok) {
      assert.equal(r.verdict, 'unverified', `${email} 探针失败不该判死`);
      assert.equal(r.gate, 'doh-unreachable');
      assert.match(r.reason, /本机网络/);
    }
  }
});

test('探针失败时不写缓存 —— 否则网络恢复后 10 分钟内仍判 unverified', () => {
  // 这条由 `lookupDomain` 的 `catch { return null }`（不 cache.set）保证；
  // 此处断言纯函数侧的可观察行为：同一域名连续两次传 null 结果一致且都不判死
  assert.equal(v('hr@qq.com', null), v('hr@qq.com', null));
  assert.equal(v('hr@qq.com', null), 'unverified');
});

// ── B. ① 格式闸门 ──────────────────────────────────────────────────────────
test('格式闸门：形状不对直接死，不必查 DNS', () => {
  const bad = ['bad-shape@@qq.com', 'no-at-sign.com', 'a@b', 'a@b.c', 'a@-x.com', 'a@x..com', 'a@x.com.', ''];
  for (const e of bad) {
    assert.equal(checkShape(e).ok, false, `${e} 应判形状不合法`);
    assert.equal(v(e, null), 'dead', `${e} 即便探针失败也应判死（不该被 unverified 兜住）`);
    assert.equal(classifyDns(e, null).gate, 'format');
  }
});

test('格式闸门：合法地址一律放行（宁可放过也不误杀）', () => {
  for (const e of ['hr@qq.com', 'a.b+tag@sub.example.com.cn', 'zhaopin@x.io']) {
    assert.equal(checkShape(e).ok, true, `${e} 不该被判不合法`);
  }
});

test('超长 local part / 域名的边界', () => {
  assert.equal(checkShape(`${'a'.repeat(64)}@qq.com`).ok, true, '64 字符是上限内');
  assert.equal(checkShape(`${'a'.repeat(65)}@qq.com`).ok, false);
});

// ── C. ②③ 域名 / MX ────────────────────────────────────────────────────────
test('NXDOMAIN ⇒ dead/dead-domain', () => {
  const r = classifyDns('hr@tuhu-cn-not-exist-xyz.com', { status: 3, mx: [], a: [] });
  assert.equal(r.verdict, 'dead');
  assert.equal(r.gate, 'dead-domain');
});

test('有 MX ⇒ sendable', () => {
  const r = classifyDns('lzw30559@hfzq.com.cn', { status: 0, mx: MX_QQ, a: [] });
  assert.equal(r.verdict, 'sendable');
  assert.equal(r.gate, undefined);
  assert.match(r.reason, /MX 正常/);
});

test('🔴 无 MX 即使有 A 也判死 —— 实测 QQ 不回退 A', () => {
  // 真实 NDR：`huangy@ieit.com` 所属域名有 A 记录，QQ 仍退「No MX Record Found」
  const r = classifyDns('huangy@ieit.com', { status: 0, mx: [], a: A_ONLY });
  assert.equal(r.verdict, 'dead');
  assert.equal(r.gate, 'no-mx');
  assert.match(r.reason, /不做 A 回退/);
});

test('既无 MX 也无 A ⇒ dead/no-mx', () => {
  const r = classifyDns('campus@luhu.cn', { status: 0, mx: [], a: [] });
  assert.equal(r.verdict, 'dead');
  assert.equal(r.gate, 'no-mx');
});

// ── D. ④ 角色账号：招聘邮箱必须放行（本轮修的 bug）──────────────────────────
test('🔴 招聘专用账号判 sendable —— 本场景下 hr@ 就是目标收件人', () => {
  // 这些词**一个都不在 ROLE_LOCAL 里**，且这是刻意的：初版把它们塞进角色账号表，
  // 实测 `hr@do1.com.cn` 被判 risky。「通用角色账号是坏信号」这条经验属于营销邮件，
  // 招聘投递恰恰相反。合约测试里有一条专门盯「ROLE_LOCAL 不许含这些词」。
  for (const local of ['hr', 'HR', 'hrbp', 'jobs', 'job', 'career', 'careers', 'recruit', 'recruiting', 'zhaopin', 'campus', 'talent', 'hiring', 'apply', 'resume', 'cv']) {
    const r = classifyDns(`${local}@example.com`, { status: 0, mx: MX_QQ, a: [] });
    assert.equal(r.verdict, 'sendable', `${local}@ 是招聘账号，不该判 risky`);
    assert.equal(isRoleOrPlaceholder(local).risky, false);
  }
});

test('通用角色账号只降级为 risky，不判死', () => {
  for (const local of ['info', 'admin', 'support', 'sales', 'marketing', 'noreply', 'no-reply', 'postmaster', 'webmaster', 'abuse']) {
    const r = classifyDns(`${local}@example.com`, { status: 0, mx: MX_QQ, a: [] });
    assert.equal(r.verdict, 'risky', `${local}@ 应判 risky`);
    assert.equal(r.gate, 'role-placeholder');
  }
});

test('占位/垃圾账号判 risky', () => {
  for (const local of ['test', 'demo', 'sample', 'foo', 'asdasd', 'xxx', 'yourname', '123456', 'aaaa']) {
    const r = classifyDns(`${local}@example.com`, { status: 0, mx: MX_QQ, a: [] });
    assert.equal(r.verdict, 'risky', `${local}@ 应判 risky`);
  }
});

test('普通真人账号判 sendable', () => {
  for (const local of ['lzw30559', 'jiabin.su', 'shens', 'zhang.san01']) {
    const r = classifyDns(`${local}@example.com`, { status: 0, mx: MX_QQ, a: [] });
    assert.equal(r.verdict, 'sendable');
  }
});

test('isRoleOrPlaceholder 直接调用时行为一致', () => {
  assert.equal(isRoleOrPlaceholder('hr').risky, false, '招聘账号例外');
  assert.equal(isRoleOrPlaceholder('info').risky, true);
  assert.equal(isRoleOrPlaceholder('info').reason, '通用角色账号（info@，通常无人细读）');
  assert.equal(isRoleOrPlaceholder('test').risky, true);
  assert.equal(isRoleOrPlaceholder('lzw30559').risky, false);
  assert.equal(isRoleOrPlaceholder('').risky, false);
});

test('风险闸门只在有 MX 时才谈 —— 死域名不该被标成 risky', () => {
  // 顺序很重要：先判死，再谈角色。否则 `noreply@已停用域名.com` 会显示成「有风险」而非「不可投递」
  const r = classifyDns('noreply@dead-domain-xyz.com', { status: 3, mx: [], a: [] });
  assert.equal(r.verdict, 'dead');
  assert.equal(r.gate, 'dead-domain');
});

// ── E. 辅助函数 ────────────────────────────────────────────────────────────
test('splitEmail 取最后一个 @（local part 允许含 @ 的引号形式之外都按最后一个切）', () => {
  assert.deepEqual(splitEmail('HR@Example.COM'), { local: 'hr', domain: 'example.com' });
  assert.deepEqual(splitEmail('no-at-sign'), { local: '', domain: '' });
  assert.deepEqual(splitEmail(''), { local: '', domain: '' });
  assert.deepEqual(splitEmail(null as unknown as string), { local: '', domain: '' });
});

test('describeAssessment 给出中文结论，四种判定都要能说清', () => {
  const cases: Array<[MailboxAssessment, RegExp]> = [
    [classifyDns('hr@qq.com', { status: 0, mx: MX_QQ, a: [] }), /^可投递：/],
    [classifyDns('info@qq.com', { status: 0, mx: MX_QQ, a: [] }), /^有风险：/],
    [classifyDns('a@x.com', { status: 3, mx: [], a: [] }), /^不可投递：/],
    [classifyDns('hr@qq.com', null), /^未能核实：/],
  ];
  for (const [a, re] of cases) assert.match(describeAssessment(a), re);
});

test('返回值带上 email/domain/local，供日志与面板直接显示', () => {
  const r = classifyDns('HR@Example.com', { status: 0, mx: MX_QQ, a: [] });
  assert.equal(r.email, 'HR@Example.com', 'email 保留原始大小写（显示给人看）');
  assert.equal(r.domain, 'example.com', 'domain/local 归一小写（用于比对与去重）');
  assert.equal(r.local, 'hr');
  assert.deepEqual(r.mx, MX_QQ);
});
