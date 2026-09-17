/** 核查投递真实性：统计对方的自动回复/回执，并排查退信（NDR） */
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { getMailConfig } from '../server/db.js';

const cfg = getMailConfig();
if (!cfg?.email || !cfg.auth_code) { console.error('未配置邮箱/授权码'); process.exit(1); }

const client = new ImapFlow({
  host: cfg.imap_host || 'imap.qq.com',
  port: Number(cfg.imap_port ?? 993),
  secure: true,
  auth: { user: cfg.email, pass: cfg.auth_code },
  tls: { rejectUnauthorized: false },
  logger: false,
});

const SENT_SUBJECT = /杨欣宇-13095328850/;          // 我们发出的邮件主题指纹
const BOUNCE = /(mailer-daemon|postmaster|退信|delivery status|undelivered|delivery has failed|无法投递|发送失败|mail delivery)/i;

(async () => {
  await client.connect();
  const boxes = await client.list();
  const paths = boxes.map((b: any) => b.path);
  const since = new Date(Date.now() - 3 * 24 * 3600 * 1000);
  const acks: Array<{ folder: string; from: string; subject: string; date: Date }> = [];
  const bounces: Array<{ folder: string; from: string; subject: string; date: Date }> = [];

  for (const p of paths) {
    if (p === 'Drafts') continue;
    try {
      const lock = await client.getMailboxLock(p);
      try {
        let seq: any[] = [];
        try { seq = (await client.search({ since }, { uid: true })) || []; } catch { seq = []; }
        for await (const msg of client.fetch(seq.slice(-80), { uid: true, envelope: true, source: true })) {
          const from = (msg.envelope?.from || []).map((t: any) => t.address).join(',');
          const subject = msg.envelope?.subject || '';
          let body = '';
          try { const parsed = await simpleParser(msg.source as Buffer); body = `${parsed.text || ''}`.slice(0, 500); } catch { /* ignore */ }
          const hay = `${from} ${subject} ${body}`;
          const rec = { folder: p, from, subject, date: new Date(msg.envelope?.date || Date.now()) };
          if (BOUNCE.test(hay)) bounces.push(rec);
          // 回执：主题回带我们的投递标题，或正文提到已收到/自动回复
          if (SENT_SUBJECT.test(subject) || SENT_SUBJECT.test(body) || /自动回复|自动答复|auto-?reply|已查收|已收到|简历收到|投递成功|已成功投递|感谢应聘|已收到你的申请/i.test(hay)) {
            acks.push(rec);
          }
        }
      } finally { lock.release(); }
    } catch (e: any) { console.log(`[${p}] 读取失败: ${e?.message}`); }
  }

  console.log('=== 有回执/自动回复的邮件（按对方地址去重） ===');
  const byFrom = new Map<string, { from: string; subject: string; date: Date }>();
  for (const a of acks) if (!byFrom.has(a.from)) byFrom.set(a.from, a);
  [...byFrom.values()].sort((x, y) => +y.date - +x.date).forEach((a, i) => {
    console.log(`  ${i + 1}. ${a.from}  |  ${a.subject.slice(0, 78)}`);
  });
  console.log(`小计: ${byFrom.size} 个对方地址有回执（近 3 天）`);

  console.log('\n=== 退信 / 投递失败（NDR） ===');
  if (!bounces.length) console.log('  （无）');
  else bounces.forEach(b => console.log(`  [${b.folder}] ${b.from} | ${b.subject.slice(0, 90)}`));

  await client.logout();
})().catch(async (e) => { console.error('ERR:', e?.message || e); try { await client.logout(); } catch { /* ignore */ } process.exit(1); });
