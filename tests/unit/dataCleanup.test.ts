/**
 * `server/services/dataCleanup.ts` 里**纯函数**部分的单测。
 *
 * 自动限额的"会不会删错东西"由 `_tools/_autolimit_probe.mts`（真跑隔离实例）覆盖；
 * 这里只钉**决策函数**：超多少倍收紧几档、档位怎么解析。
 * 两者分工明确 —— 决策错了这里红，执行错了那边红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tightenParams, resolveAutoLimitMode } from '../../server/services/dataCleanup.js';

const BASE = { screenshotDays: 14, keepDbBackups: 3, keepResumeBackups: 2, runLogDays: 30 };

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

// ── tightenParams：分档边界 ────────────────────────────────────────────────
test('tightenParams: 刚好 1.0 倍走一档', () => {
  const t = tightenParams(BASE, 1.0);
  assert.equal(t.screenshotDays, 7);
  assert.equal(t.runLogDays, 14);
  assert.equal(t.keepDbBackups, 2);
  assert.equal(t.keepResumeBackups, 2);
});
test('tightenParams: 1.49 仍是一档（边界下方）', () => {
  assert.equal(tightenParams(BASE, 1.49).screenshotDays, 7);
});
test('tightenParams: 1.5 起走两档（边界上方）', () => {
  const t = tightenParams(BASE, 1.5);
  assert.equal(t.screenshotDays, 3);
  assert.equal(t.runLogDays, 7);
  assert.equal(t.keepResumeBackups, 1);
});
test('tightenParams: 远超阈值仍封顶在两档（不做无上限收缩）', () => {
  const t = tightenParams(BASE, 99);
  assert.deepEqual(t, { screenshotDays: 3, keepDbBackups: 2, keepResumeBackups: 1, runLogDays: 7 });
});
test('tightenParams: 用户已配更短的保留期不会被反向放大', () => {
  const t = tightenParams({ screenshotDays: 2, keepDbBackups: 1, keepResumeBackups: 0, runLogDays: 1 }, 2);
  assert.deepEqual(t, { screenshotDays: 2, keepDbBackups: 1, keepResumeBackups: 0, runLogDays: 1 });
});
test('tightenParams: 不修改传入对象（纯函数）', () => {
  const base = { ...BASE };
  tightenParams(base, 2);
  assert.deepEqual(base, BASE, '传入的 base 被改写 ⇒ 调用方再跑一轮会拿到已收紧的值');
});

// ── resolveAutoLimitMode：档位解析 ─────────────────────────────────────────
test('resolveAutoLimitMode: 默认 safe（不做破坏性自动删除）', () => {
  withEnv({ DATA_AUTO_LIMIT: undefined }, () => {
    assert.equal(resolveAutoLimitMode({}), 'safe');
  });
});
test('resolveAutoLimitMode: env 可指定三档', () => {
  for (const m of ['off', 'safe', 'full'] as const) {
    withEnv({ DATA_AUTO_LIMIT: m }, () => assert.equal(resolveAutoLimitMode({}), m));
  }
});
test('resolveAutoLimitMode: env 大小写与空白不敏感', () => {
  withEnv({ DATA_AUTO_LIMIT: '  FULL  ' }, () => assert.equal(resolveAutoLimitMode({}), 'full'));
});
test('resolveAutoLimitMode: 非法 env 值退回 safe（不是 off，也不是报错）', () => {
  withEnv({ DATA_AUTO_LIMIT: 'yes-please-delete-everything' }, () => {
    assert.equal(resolveAutoLimitMode({}), 'safe');
  });
});
test('resolveAutoLimitMode: 显式 options 优先于 env', () => {
  withEnv({ DATA_AUTO_LIMIT: 'off' }, () => {
    assert.equal(resolveAutoLimitMode({ autoLimit: 'full' }), 'full');
  });
});
