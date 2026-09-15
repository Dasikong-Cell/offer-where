/**
 * 批量投递 —— 常驻后台监视器（解决「想让投递也在后台自动跑，不被自动回复抢走」）
 *
 * 设计同 autoReplyWatcher，但驱动的是批量投递 runBatchApply：
 *  - 每隔 intervalSec 对各启用平台跑一批投递（默认每轮 10 个、已投过的按 excludeApplied 跳过）；
 *  - 同一平台同一时刻只允许「投递」或「回复」之一占用浏览器（锁在 runBatchApply 内部已统一处理，
 *    本模块直接复用，不重复加锁）：若被自动回复监视器占用，runBatchApply 会抛「正被占用」错误，
 *    这里 catch 成「跳过、下一轮再试」，互不打架；
 *  - 配置持久化 data/auto_apply_watch.json（enabled / platforms / keyword / limit / intervalSec）；
 *    服务端启动若 enabled=true 则自动恢复轮询；
 *  - running 互斥 + AbortController，stop 可中途取消；EventEmitter('tick') 供 SSE 实时推给控制台。
 */

import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { runBatchApply } from './batch.js';
import { isSupported } from './index.js';
import type { ApplyPlatform } from './types.js';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'auto_apply_watch.json');
const LOG_PATH = path.join(DATA_DIR, 'auto_apply_watch.log');

export interface ApplyWatchConfig {
  enabled: boolean;
  platforms: string[];
  /** 筛选关键词（空 = 全部岗位） */
  keyword: string;
  /** 每轮最多投递数 */
  limit: number;
  /** 轮询间隔（秒） */
  intervalSec: number;
  /** 两次投递间隔（毫秒） */
  intervalMs: number;
}

const DEFAULT_CONFIG: ApplyWatchConfig = {
  enabled: false,
  platforms: ['boss'],
  keyword: '',
  limit: 10,
  intervalSec: 600,
  intervalMs: 20000,
};

let config: ApplyWatchConfig = { ...DEFAULT_CONFIG };
let timer: NodeJS.Timeout | null = null;
let running = false;
let abort: AbortController | null = null;
const lastRun: Record<string, { at: string; applied: number; skipped: number; error?: string }> = {};

export const watchEmitter = new EventEmitter();
watchEmitter.setMaxListeners(50);

function loadConfig(): void {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      config = { ...DEFAULT_CONFIG, ...raw };
    }
  } catch {
    config = { ...DEFAULT_CONFIG };
  }
}

function saveConfig(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  } catch {
    /* 忽略 */
  }
}

function logLine(s: string): void {
  try {
    const ts = new Date().toISOString();
    fs.appendFileSync(LOG_PATH, `[${ts}] ${s}\n`, 'utf8');
  } catch {
    /* 忽略 */
  }
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  abort = new AbortController();
  const platforms = config.platforms.filter((p) => p === 'auto' || isSupported(p as ApplyPlatform));
  if (platforms.length === 0) {
    running = false;
    abort = null;
    return;
  }
  logLine(`tick start: platforms=${platforms.join(',')} keyword=${config.keyword} limit=${config.limit}`);
  watchEmitter.emit('tick', { kind: 'start', platforms, at: new Date().toISOString() });
  for (const p of platforms) {
    if (abort.signal.aborted) break;
    try {
      const input = {
        platform: p as ApplyPlatform | 'auto',
        source: p === 'auto' ? undefined : p,
        limit: config.limit,
        intervalMs: config.intervalMs,
        criteria: {
          excludeApplied: true,
          keywords: config.keyword ? [config.keyword] : [],
        },
      };
      const r = await runBatchApply(input, (ev: unknown) =>
        watchEmitter.emit('tick', { kind: 'event', platform: p, ev }),
      );
      lastRun[p] = { at: new Date().toISOString(), applied: r.applied, skipped: r.skipped };
      logLine(`tick ${p}: applied=${r.applied} skipped=${r.skipped}`);
      watchEmitter.emit('tick', { kind: 'platform-done', platform: p, applied: r.applied, skipped: r.skipped, at: lastRun[p].at });
    } catch (e: unknown) {
      const msg = String((e as Error)?.message || e);
      lastRun[p] = { at: new Date().toISOString(), applied: 0, skipped: 0, error: msg };
      logLine(`tick ${p} ERROR: ${msg}`);
      watchEmitter.emit('tick', { kind: 'platform-error', platform: p, error: msg, at: lastRun[p].at });
    }
  }
  running = false;
  abort = null;
  watchEmitter.emit('tick', { kind: 'end', at: new Date().toISOString() });
  logLine('tick end');
}

/** 启动监视器。immediate=false 时只挂定时器、等首个间隔再跑（服务端启动用）。 */
export function startWatcher(immediate = true): void {
  loadConfig();
  config.enabled = true;
  saveConfig();
  if (timer) return;
  const ms = Math.max(30, config.intervalSec) * 1000;
  timer = setInterval(tick, ms);
  if (immediate) void tick();
}

export function stopWatcher(): void {
  config.enabled = false;
  saveConfig();
  if (abort) abort.abort();
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function watcherStatus(): {
  running: boolean;
  enabled: boolean;
  platforms: string[];
  keyword: string;
  limit: number;
  intervalSec: number;
  lastRun: Record<string, { at: string; applied: number; skipped: number; error?: string }>;
} {
  return {
    running: !!timer,
    enabled: config.enabled,
    platforms: config.platforms,
    keyword: config.keyword,
    limit: config.limit,
    intervalSec: config.intervalSec,
    lastRun,
  };
}

export function setWatchConfig(patch: Partial<ApplyWatchConfig>): void {
  loadConfig();
  config = { ...config, ...patch };
  if (Array.isArray(config.platforms)) {
    config.platforms = config.platforms.filter((p) => p === 'auto' || isSupported(p as ApplyPlatform));
  }
  saveConfig();
  if (timer && (patch.intervalSec !== undefined || patch.platforms !== undefined)) {
    clearInterval(timer);
    timer = null;
    if (config.enabled) {
      const ms = Math.max(30, config.intervalSec) * 1000;
      timer = setInterval(tick, ms);
    }
  }
}

/** 服务端启动时调用：若配置为启用则恢复常驻轮询（不立即跑，等首个间隔）。 */
export function bootstrapWatcher(): void {
  loadConfig();
  if (config.enabled) startWatcher(false);
}
