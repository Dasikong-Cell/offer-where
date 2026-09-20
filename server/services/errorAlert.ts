/**
 * 运行异常邮件告警（无人值守也可第一时间知道）
 * ==========================================================================
 * 背景：服务端的错误都会经 `logRun('ERROR', …)` 落盘 `data/run_log/日期.log`，
 * 但只有打开控制台才看得到 —— 夜里/外出时跑挂了没人知道。这里复用现有邮件通道
 * （`services/mail.ts` 的 sendMail，与邮箱直投同一套配置）把 ERROR 推到邮箱。
 *
 * 设计要点：
 *  - **只挂在 logRun 上**：所有服务端错误都从那里过，一处接入即全覆盖。
 *  - **批量 + 节流**：故障爆发时不会刷屏邮箱。同一错误内容默认 1 小时内不重复发；
 *    两封告警邮件之间默认至少间隔 10 分钟（聚合期间的多条错误合并成一封）。
 *  - **绝不递归**：本模块只用 console.error，不再回调 logRun，避免「告警失败→再告警」死循环。
 *  - **收件人**：优先环境变量 `ALERT_EMAIL`；否则回落到已配置邮箱自身（发给用户自己）。
 *  - 关掉：`ALERT_ENABLED=false`。
 *
 * 相关环境变量：
 *   ALERT_EMAIL             收件人（留空=发给已配置邮箱自己）
 *   ALERT_ENABLED           false 关闭告警
 *   ALERT_MIN_INTERVAL_SEC  两封告警最小间隔秒数（默认 600）
 *   ALERT_DEDUP_SEC         同一错误去重窗口秒数（默认 3600）
 */
import { sendMail } from './mail.js';
import { getMailConfig, getProfile } from '../db.js';

interface PendingAlert { ts: string; msg: string }

const recentKeys = new Map<string, number>();
let queue: PendingAlert[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let lastSentAt = 0;

function envNum(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : def;
}

function minIntervalMs(): number { return envNum('ALERT_MIN_INTERVAL_SEC', 600) * 1000; }
function dedupMs(): number { return envNum('ALERT_DEDUP_SEC', 3600) * 1000; }

export function alertsEnabled(): boolean {
  return String(process.env.ALERT_ENABLED || '').toLowerCase() !== 'false';
}

/** 告警收件人：ALERT_EMAIL > 已配置邮箱自身 > profile.email；都没有则 null */
export function resolveAlertRecipient(): string | null {
  const explicit = String(process.env.ALERT_EMAIL || '').trim();
  if (explicit) return explicit;
  try {
    const mc = getMailConfig();
    if (mc?.email) return String(mc.email);
  } catch { /* 忽略 */ }
  try {
    const p = getProfile() as Record<string, unknown> | undefined;
    const mail = p && typeof p.email === 'string' ? p.email.trim() : '';
    if (mail) return mail;
  } catch { /* 忽略 */ }
  return null;
}

export interface AlertStatus {
  enabled: boolean;
  to: string | null;
  minIntervalSec: number;
  dedupSec: number;
  pending: number;
  lastSentAt: string | null;
}

export function alertStatus(): AlertStatus {
  return {
    enabled: alertsEnabled(),
    to: resolveAlertRecipient(),
    minIntervalSec: Math.round(minIntervalMs() / 1000),
    dedupSec: Math.round(dedupMs() / 1000),
    pending: queue.length,
    lastSentAt: lastSentAt ? new Date(lastSentAt).toISOString() : null,
  };
}

/** 入队一条 ERROR 告警（去重 + 节流后异步发送，不阻塞调用方） */
export function queueErrorAlert(msg: string, ts = new Date().toISOString()): void {
  if (!alertsEnabled()) return;
  const key = String(msg || '').slice(0, 120);
  if (!key) return;
  const now = Date.now();
  const seen = recentKeys.get(key);
  if (seen && now - seen < dedupMs()) return; // 同一错误窗口内不重复
  recentKeys.set(key, now);
  if (recentKeys.size > 200) {
    for (const [k, v] of recentKeys) if (now - v > dedupMs()) recentKeys.delete(k);
  }
  queue.push({ ts, msg: String(msg || '') });
  scheduleFlush();
}

function scheduleFlush(): void {
  if (timer) return;
  const wait = Math.max(3000, minIntervalMs() - (Date.now() - lastSentAt));
  timer = setTimeout(() => { timer = null; void flush(); }, wait);
  if (typeof (timer as any).unref === 'function') (timer as any).unref();
}

async function flush(): Promise<void> {
  if (!queue.length) return;
  const to = resolveAlertRecipient();
  if (!to) { queue = []; return; }
  const batch = queue.splice(0, queue.length);
  lastSentAt = Date.now();
  const subject = `[投递Agent] 运行异常告警（${batch.length} 条）`;
  const text = [
    '投递 Agent 检测到运行异常：',
    '',
    ...batch.map((b) => `[${b.ts}] ${b.msg}`),
    '',
    '— 本邮件由 /api/logs 的运行日志告警自动发出，可在 .env 用 ALERT_ENABLED=false 关闭。',
  ].join('\n');
  try {
    const r = await sendMail({ to, subject, text, fromName: '投递Agent' });
    if (!r.ok) console.error('[alert] 告警邮件发送失败:', r.error);
    else console.log('[alert] 已发出告警邮件:', to, `(${batch.length} 条)`);
  } catch (e) {
    // 刻意只用 console.error：绝不回调 logRun，避免递归告警
    console.error('[alert] 告警邮件异常:', String((e as any)?.message || e));
  }
}

/** 主动发一封测试告警（供控制台/命令行验证通道是否打通） */
export async function sendTestAlert(): Promise<{ ok: boolean; to?: string; error?: string }> {
  const to = resolveAlertRecipient();
  if (!to) return { ok: false, error: '未找到收件人：请配置 ALERT_EMAIL，或先在我的档案里填写邮箱' };
  try {
    const r = await sendMail({
      to,
      subject: '[投递Agent] 告警通道测试',
      text: [
        '这是一封测试告警邮件。',
        '',
        `时间：${new Date().toISOString()}`,
        `间隔节流：${Math.round(minIntervalMs() / 1000)} 秒/封　内容去重：${Math.round(dedupMs() / 1000)} 秒`,
        '',
        '若你收到本邮件，说明「运行异常 → 邮件提醒」链路已打通。',
      ].join('\n'),
      fromName: '投递Agent',
    });
    return r.ok ? { ok: true, to } : { ok: false, to, error: r.error || '发送失败' };
  } catch (e: any) {
    return { ok: false, to, error: String(e?.message || e) };
  }
}
