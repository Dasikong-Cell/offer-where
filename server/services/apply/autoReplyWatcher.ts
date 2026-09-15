/**
 * HR 消息自动回复 —— 常驻监视器（解决「无法及时进行回复」）
 *
 * 问题：原自动回复只能手动触发（/api/auto-reply/run 或 CLI），HR 来消息时不会自动去回。
 * 本模块在后端起一个 setInterval 轮询：每隔 intervalSec 秒，对「已启用平台」自动跑一次
 * runAutoReply（unreadOnly 模式 + 检测加固后，会把漏检的未读 / 已读未回 一并补上）。
 *
 * 设计要点：
 *  - 配置持久化到 data/auto_reply_watch.json（enabled / platforms / intervalSec / realSend / useAi），
 *    服务端启动若 enabled=true 则自动恢复轮询，重启不丢设置。
 *  - running 互斥 + AbortController，避免上一轮未结束又开新一轮，stop 可中途取消。
 *  - 每次 tick 通过 EventEmitter('tick') 广播，供 /api/auto-reply/watch SSE 实时推给控制台。
 *  - 同时写 data/auto_reply_watch.log，便于无前端时排查。
 */

import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { runAutoReply, getChatDriver } from './autoReplyRunner.js';
import type { ApplyPlatform } from './types.js';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'auto_reply_watch.json');
const LOG_PATH = path.join(DATA_DIR, 'auto_reply_watch.log');

export interface WatchConfig {
  enabled: boolean;
  platforms: string[];
  intervalSec: number;
  realSend: boolean;
  useAi: boolean;
  /** 两次发送最小间隔（秒），防风控 */
  throttleSec: number;
  /** 单轮最多发送条数，0 = 不限制 */
  maxPerRun: number;
  /** 同一 HR 两次自动回复冷却（秒） */
  hrCooldownSec: number;
}

const DEFAULT_CONFIG: WatchConfig = {
  enabled: false,
  platforms: ['boss', 'liepin'],
  intervalSec: 180,
  realSend: true,
  useAi: true,
  throttleSec: 45,
  maxPerRun: 20,
  hrCooldownSec: 3600,
};

let config: WatchConfig = { ...DEFAULT_CONFIG };
let timer: NodeJS.Timeout | null = null;
let running = false;
let abort: AbortController | null = null;
const lastRun: Record<string, { at: string; sent: number; skipped: number; error?: string }> = {};

/** 供 SSE / 前端订阅的实时事件 */
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
    /* 忽略写失败 */
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
  if (running) return; // 上一轮还没跑完，跳过本次，避免叠加
  running = true;
  abort = new AbortController();
  const platforms = config.platforms.filter((p) => getChatDriver(p as ApplyPlatform));
  if (platforms.length === 0) {
    running = false;
    abort = null;
    return;
  }
  logLine(`tick start: platforms=${platforms.join(',')} realSend=${config.realSend} useAi=${config.useAi}`);
  watchEmitter.emit('tick', { kind: 'start', platforms, at: new Date().toISOString() });
  for (const p of platforms) {
    if (abort.signal.aborted) break;
    try {
      const r = await runAutoReply(
        p as ApplyPlatform,
        {
          unreadOnly: true,
          realSend: config.realSend,
          useAi: config.useAi,
          throttleSec: config.throttleSec,
          maxPerRun: config.maxPerRun,
          hrCooldownSec: config.hrCooldownSec,
          signal: abort.signal,
        },
        (ev) => watchEmitter.emit('tick', { kind: 'event', platform: p, ev }),
      );
      lastRun[p] = { at: new Date().toISOString(), sent: r.sent, skipped: r.skipped };
      logLine(`tick ${p}: sent=${r.sent} skipped=${r.skipped}`);
      watchEmitter.emit('tick', { kind: 'platform-done', platform: p, sent: r.sent, skipped: r.skipped, at: lastRun[p].at });
    } catch (e: unknown) {
      const msg = String((e as Error)?.message || e);
      lastRun[p] = { at: new Date().toISOString(), sent: 0, skipped: 0, error: msg };
      logLine(`tick ${p} ERROR: ${msg}`);
      watchEmitter.emit('tick', { kind: 'platform-error', platform: p, error: msg, at: lastRun[p].at });
    }
  }
  running = false;
  abort = null;
  watchEmitter.emit('tick', { kind: 'end', at: new Date().toISOString() });
  logLine('tick end');
}

/** 启动监视器。immediate=false 时只挂定时器、等首个间隔再跑（服务端启动用，避免启动即重操作浏览器）。 */
export function startWatcher(immediate = true): void {
  loadConfig();
  config.enabled = true;
  saveConfig();
  if (timer) {
    // 已运行：仅确保配置生效（interval 变化下次生效），不重复挂定时器
    return;
  }
  const ms = Math.max(30, config.intervalSec) * 1000;
  timer = setInterval(tick, ms);
  if (immediate) {
    // 异步立即跑一次，不阻塞启动
    void tick();
  }
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
  intervalSec: number;
  realSend: boolean;
  useAi: boolean;
  throttleSec: number;
  maxPerRun: number;
  hrCooldownSec: number;
  lastRun: Record<string, { at: string; sent: number; skipped: number; error?: string }>;
} {
  return {
    running: !!timer,
    enabled: config.enabled,
    platforms: config.platforms,
    intervalSec: config.intervalSec,
    realSend: config.realSend,
    useAi: config.useAi,
    throttleSec: config.throttleSec,
    maxPerRun: config.maxPerRun,
    hrCooldownSec: config.hrCooldownSec,
    lastRun,
  };
}

/** 更新配置；intervalSec 变化且正在运行则重启定时器使其立即生效。 */
export function setWatchConfig(patch: Partial<WatchConfig>): void {
  loadConfig();
  config = { ...config, ...patch };
  // 平台合法性兜底：只保留有 driver 的平台
  if (Array.isArray(config.platforms)) {
    config.platforms = config.platforms.filter((p) => getChatDriver(p as ApplyPlatform));
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
  if (config.enabled) {
    startWatcher(false);
  }
}
