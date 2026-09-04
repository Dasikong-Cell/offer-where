/**
 * 邮件验证码服务
 * 通过 IMAP 连接邮箱（默认 QQ 邮箱）拉取最新邮件，提取登录/注册验证码。
 */
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { getMailConfig } from '../db.js';

export interface MailCodeResult {
  ok: boolean;
  code?: string;
  subject?: string;
  from?: string;
  date?: string;
  snippet?: string;
  uid?: number;
  candidates?: string[];
  error?: string;
  hint?: string;
}

/** 验证码触发关键词 */
const CODE_KEYWORDS = [
  '验证码', '校验码', '验证代码', '动态码', '动态密码', '登录码', '登陆码',
  '安全码', '确认码', '一次性密码', '激活码', '邮箱验证',
  'verification code', 'verify code', 'security code', 'one-time', 'one time',
  'otp', 'passcode', 'code',
];

/** 常见误判：年份、金额、日期等 */
const NOISE_PATTERN = /(19\d{2}|20[0-3]\d)[\/\-年]|\d{4}[\-\/]\d{1,2}[\-\/]\d{1,2}/;

function toPlainText(htmlOrText: string): string {
  return htmlOrText
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#\d+;/g, ' ')
    .replace(/[ \t]+/g, ' ');
}

/**
 * 从邮件正文中提取验证码
 * 策略：优先在关键词后方 60 字符窗口内找 4-8 位数字；否则退化为取最后一串 6 位数字。
 */
export function extractCode(raw: string): { code?: string; candidates: string[] } {
  const text = toPlainText(raw || '');
  const candidates: string[] = [];

  for (const keyword of CODE_KEYWORDS) {
    let idx = text.toLowerCase().indexOf(keyword.toLowerCase());
    while (idx !== -1) {
      const window = text.slice(idx, idx + keyword.length + 60);
      // 优先 6 位，其次 4-8 位
      const m6 = window.match(/\b(\d{6})\b/);
      const mAny = window.match(/\b(\d{4,8})\b/);
      const hit = m6?.[1] || mAny?.[1];
      if (hit && !NOISE_PATTERN.test(hit)) {
        candidates.push(hit);
        return { code: hit, candidates };
      }
      idx = text.toLowerCase().indexOf(keyword.toLowerCase(), idx + 1);
    }
  }

  // 退化策略：收集所有 4-8 位纯数字段（排除噪声），取最后一个
  const all = text.match(/\b\d{4,8}\b/g) || [];
  for (const item of all) {
    if (!NOISE_PATTERN.test(item)) candidates.push(item);
  }
  if (candidates.length > 0) {
    return { code: candidates[candidates.length - 1], candidates };
  }

  return { candidates };
}

interface ResolvedConfig {
  user: string;
  pass: string;
  host: string;
  port: number;
  secure: boolean;
}

function resolveConfig(override?: Partial<{
  email: string; authCode: string; imapHost: string; imapPort: number; useSsl: boolean;
}>): ResolvedConfig {
  const saved = getMailConfig();
  const user = override?.email || saved?.email || process.env.MAIL_USER || '';
  const pass = override?.authCode || saved?.auth_code || process.env.MAIL_AUTH_CODE || '';
  const host = override?.imapHost || saved?.imap_host || process.env.MAIL_IMAP_HOST || 'imap.qq.com';
  const port = Number(override?.imapPort ?? saved?.imap_port ?? process.env.MAIL_IMAP_PORT ?? 993);
  const secure = override?.useSsl !== undefined
    ? override.useSsl
    : (saved?.use_ssl === null || saved?.use_ssl === undefined ? true : saved.use_ssl === 1);

  if (!user || !pass) {
    const err = new Error('邮箱未配置：请先在我的档案页面填写邮箱地址与 IMAP 授权码');
    (err as any).code = 'MAIL_NOT_CONFIGURED';
    throw err;
  }
  return { user, pass, host, port, secure };
}

async function withClient<T>(cfg: ResolvedConfig, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    // QQ 邮箱要求认证，关闭 TLS 校验错误的严格模式（企业代理环境兼容）
    tls: { rejectUnauthorized: false },
    logger: false,
  });

  try {
    await client.connect();
    return await fn(client);
  } catch (error: any) {
    const message = error?.message || String(error);
    if (/AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed/i.test(message)) {
      error.message = '邮箱认证失败：请确认使用「IMAP 授权码」而不是登录密码（QQ 邮箱需在设置中开启 IMAP/SMTP 服务）';
    } else if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|getaddrinfo/i.test(message)) {
      error.message = `无法连接 IMAP 服务器 ${cfg.host}:${cfg.port}，请检查网络与服务器配置`;
    }
    throw error;
  } finally {
    try {
      await client.logout();
    } catch {
      /* 忽略登出异常 */
    }
  }
}

/**
 * 拉取最近 N 分钟内最新的验证码
 */
export async function fetchLatestCode(options: {
  sinceMinutes?: number;
  limit?: number;
  /** 只匹配主题/发件人包含该关键词的邮件 */
  subjectKeyword?: string;
  config?: Partial<{ email: string; authCode: string; imapHost: string; imapPort: number; useSsl: boolean }>;
} = {}): Promise<MailCodeResult> {
  const { sinceMinutes = 10, limit = 5, subjectKeyword } = options;
  let cfg: ResolvedConfig;
  try {
    cfg = resolveConfig(options.config);
  } catch (error: any) {
    return { ok: false, error: error.message, hint: '请到「我的档案 → 邮箱配置」填写邮箱与授权码' };
  }

  try {
    return await withClient(cfg, async (client) => {
      const lock = await client.getMailboxLock('INBOX');
      const results: MailCodeResult[] = [];
      try {
        const since = new Date(Date.now() - sinceMinutes * 60 * 1000);
        const seq = await client.search({ since }, { uid: true });
        // 从新到旧遍历
        const targets = (seq || []).slice(-limit).reverse();

        for await (const msg of client.fetch(targets, { uid: true, envelope: true, source: true })) {
          const parsed = await simpleParser(msg.source as Buffer);
          const subject = parsed.subject || msg.envelope?.subject || '';
          const from = parsed.from?.text || msg.envelope?.from?.[0]?.address || '';
          const body = parsed.text || toPlainText(parsed.html || '') || '';

          if (subjectKeyword && !`${subject} ${from}`.toLowerCase().includes(subjectKeyword.toLowerCase())) {
            continue;
          }

          const { code, candidates } = extractCode(body || subject);
          if (code) {
            results.push({
              ok: true,
              code,
              subject,
              from,
              date: (parsed.date || new Date()).toISOString(),
              snippet: body.replace(/\s+/g, ' ').slice(0, 200),
              uid: msg.uid,
              candidates,
            });
          }
        }
      } finally {
        lock.release();
      }

      if (results.length > 0) return results[0];
      return {
        ok: false,
        error: `最近 ${sinceMinutes} 分钟内未找到验证码邮件`,
        hint: '确认站点已发送验证码且邮件已到达收件箱；必要时调大时间窗口（sinceMinutes）',
      };
    });
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error) };
  }
}

/**
 * 列出最近邮件（用于排查与人工确认）
 */
export async function listRecentMails(limit = 10): Promise<{
  ok: boolean;
  mails?: Array<{ subject: string; from: string; date: string; preview: string }>;
  error?: string;
}> {
  let cfg: ResolvedConfig;
  try {
    cfg = resolveConfig();
  } catch (error: any) {
    return { ok: false, error: error.message };
  }

  try {
    return await withClient(cfg, async (client) => {
      const lock = await client.getMailboxLock('INBOX');
      const mails: Array<{ subject: string; from: string; date: string; preview: string }> = [];
      try {
        const seq = await client.search({ all: true }, { uid: true });
        const targets = (seq || []).slice(-limit).reverse();
        for await (const msg of client.fetch(targets, { uid: true, envelope: true, source: true })) {
          const parsed = await simpleParser(msg.source as Buffer);
          const body = parsed.text || toPlainText(parsed.html || '') || '';
          mails.push({
            subject: parsed.subject || msg.envelope?.subject || '(无主题)',
            from: parsed.from?.text || msg.envelope?.from?.[0]?.address || '',
            date: (parsed.date || new Date()).toISOString(),
            preview: body.replace(/\s+/g, ' ').slice(0, 120),
          });
        }
      } finally {
        lock.release();
      }
      return { ok: true, mails };
    });
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error) };
  }
}

/**
 * 测试邮箱连接
 */
export async function testConnection(config?: Partial<{
  email: string; authCode: string; imapHost: string; imapPort: number; useSsl: boolean;
}>): Promise<{ ok: boolean; email?: string; host?: string; error?: string }> {
  let cfg: ResolvedConfig;
  try {
    cfg = resolveConfig(config);
  } catch (error: any) {
    return { ok: false, error: error.message };
  }
  try {
    await withClient(cfg, async (client) => {
      await client.getMailboxLock('INBOX').then(l => l.release());
    });
    return { ok: true, email: cfg.user, host: `${cfg.host}:${cfg.port}` };
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error) };
  }
}
