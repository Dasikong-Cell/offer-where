/**
 * 投递真实性核查 —— 回答「到底发出去没有」，而不是「代码说发出去了」。
 *
 * 四条**互相独立**的证据，任一条异常都不下结论：
 *   A. **已发送**：IMAP 里 `from == 我们自己的邮箱` 的邮件。
 *      QQ 的「已发送」是**服务器侧存档** ⇒ 证明确实过了 SMTP，
 *      而不是本地 `console.log('已发送')` 就算数。这是本文件最硬的一条。
 *   B. **退信 NDR**：同窗口内的投递失败通知，并解析出被拒的收件人地址。
 *   C. **对方回执 / 自动回复**：指纹取自**库里的档案**（手机号 / 姓名），
 *      ⚠️ 不硬编码进仓库 —— 真实手机号写进脚本会被 pre-push 的 PII 守卫拦下。
 *   D. **台账交叉核对**：DB `applications` 窗口内条数 vs A 的封数。
 *      两者不等 ⇒ 「发了没记账」或「记了没发」，任一方向都要人看。
 *
 * 用法：`node_modules/.bin/tsx scripts/mail_verify.ts [--days=3] [--show=8]`
 *   （本环境 `npx tsx <file>` 会被 SIGTERM，走 `node_modules/.bin/tsx` 或 npm 脚本）
 *
 * ⚠️ 本脚本**只读**：不发信、不写库、不改任何状态。
 *    真实投递前后的差量才有意义 ⇒ 投递前先跑一次存基线（`--days=1` 足够）。
 */
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { getMailConfig, getProfile, listApplications } from '../server/db.js';

const arg = (name: string, dflt: number) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  const v = hit ? Number(hit.split('=')[1]) : NaN;
  return Number.isFinite(v) ? v : dflt;
};
const DAYS = arg('days', 3);
const SHOW = arg('show', 8);

const cfg = getMailConfig();
if (!cfg?.email || !cfg.auth_code) { console.error('未配置邮箱/授权码'); process.exit(1); }
const me = String(cfg.email).trim().toLowerCase();

const profile = getProfile() as Record<string, any>;
/** 只取足够长的字段当指纹，避免「姓名两个字」把无关邮件也扫进来 */
const FINGERPRINT = [String(profile.phone || '').trim(), String(profile.name || '').trim()]
  .filter((s) => s.length >= 5)
  .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

const BOUNCE = /(mailer-daemon|postmaster|退信|delivery status|undelivered|delivery has failed|delivery incomplete|无法投递|发送失败|mail delivery)/i;
const ACK = /自动回复|自动答复|auto-?reply|已查收|已收到|简历收到|投递成功|已成功投递|感谢应聘|已收到你的申请|感谢您的投递|简历已收到/i;
const NOT_A_PERSON = /^(postmaster|mailer-daemon|no-?reply|noreply|abuse)@/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

interface Rec { folder: string; from: string; to: string; subject: string; date: Date; body?: string; }

/**
 * 本通道的**正文指纹**。
 *
 * 🔴 绝不能用**标题**当通道指纹（第一版就是这么写的，立刻误报一次）：
 *    标题是**按招聘方要求拼**出来的 —— `院校+专业+姓名` 这种要求下，标题里既没有我们的手机号、
 *    也不一定有岗位名（实测「航空工业西飞民机」那封标题就是 `某校+某专业+姓名`）⇒
 *    会被判成「非本通道」，进而误报「台账比已发送多 1 条 ⇒ 可能是假成功」。
 *    正文不一样：它是我们自己的模板，与招聘方要求无关 ⇒ 稳。
 */
const CHANNEL_BODY = /我在招聘信息中看到贵单位|【基本信息】/;

const client = new ImapFlow({
  host: cfg.imap_host || 'imap.qq.com',
  port: Number(cfg.imap_port ?? 993),
  secure: true,
  auth: { user: cfg.email, pass: cfg.auth_code },
  tls: { rejectUnauthorized: false },
  logger: false,
});

(async () => {
  await client.connect();
  const since = new Date(Date.now() - DAYS * 86400_000);
  const sinceIso = since.toISOString();

  const sent: Rec[] = [];
  const bounces: Array<Rec & { rejected: string[] }> = [];
  const acks: Rec[] = [];

  const boxes = (await client.list()) as any[];
  for (const b of boxes) {
    const p = String(b.path);
    if (p === 'Drafts') continue;
    try {
      const lock = await client.getMailboxLock(p);
      try {
        let seq: any[] = [];
        try { seq = (await client.search({ since }, { uid: true })) || []; } catch { seq = []; }
        for await (const msg of client.fetch(seq.slice(-200), { uid: true, envelope: true, source: true })) {
          const from = (msg.envelope?.from || []).map((t: any) => String(t.address || '')).join(',');
          const to = (msg.envelope?.to || []).map((t: any) => String(t.address || '')).join(',');
          const subject = msg.envelope?.subject || '';
          const rec: Rec = { folder: p, from, to, subject, date: new Date(msg.envelope?.date || Date.now()) };

          // 正文对我们自己发的也要解析 —— 通道指纹（CHANNEL_BODY）取的就是正文
          let body = '', raw = '';
          try {
            raw = (msg.source as Buffer).toString('utf8');
            const parsed = await simpleParser(msg.source as Buffer);
            const html = typeof parsed.html === 'string' ? parsed.html : '';
            const xfr = parsed.headers?.get('x-failed-recipients');
            body = `${parsed.text || ''}\n${html}${xfr ? '\nX-Failed-Recipients: ' + String(xfr) : ''}`.slice(0, 4000);
          } catch { /* ignore */ }

          // A. 我们自己发的（服务器侧存档 ⇒ 真的过了 SMTP）
          if (from.toLowerCase().includes(me)) { sent.push({ ...rec, body }); continue; }

          const hay = `${from} ${subject} ${body}`;

          // B. 退信：优先读 DSN 的标准字段，再兜底扫正文
          if (BOUNCE.test(hay)) {
            const found: string[] = [];
            // ① 标准字段（最权威）：X-Failed-Recipients / Final-Recipient。
            //    QQ 的退信正文是 HTML，直接扫正文经常一个地址都抓不到（本轮实测）。
            for (const m of raw.matchAll(/(?:X-Failed-Recipients|Final-Recipient)\s*:\s*([^\n\r]+)/gi)) {
              for (const a of (m[1].match(EMAIL_RE) || [])) found.push(a);
            }
            // ② 兜底：正文里的地址
            for (const a of (body.match(EMAIL_RE) || [])) found.push(a);
            const rejected = [...new Set(
              found.map((a) => a.toLowerCase()).filter((a) => a !== me && !NOT_A_PERSON.test(a)),
            )];
            bounces.push({ ...rec, rejected });
            continue;
          }

          // C. 对方回执：指纹（库内档案）或通用自动回复话术
          const byFp = FINGERPRINT.length > 0 && FINGERPRINT.some((f) => new RegExp(f).test(hay));
          if (byFp || ACK.test(hay)) acks.push(rec);
        }
      } finally { lock.release(); }
    } catch (e: any) { console.log(`[${p}] 读取失败: ${e?.message}`); }
  }

  const fmt = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 19);
  const byFrom = new Map<string, Rec>();
  for (const a of acks) if (!byFrom.has(a.from)) byFrom.set(a.from, a);

  console.log(`=== 投递真实性核查（窗口 ${DAYS} 天，自 ${sinceIso.slice(0, 19)} UTC）===`);
  console.log(`我方邮箱：${me}`);
  console.log('');

  console.log(`【A】已发送（服务器侧存档 = 真的过了 SMTP）：${sent.length} 封`);
  sent.sort((x, y) => +y.date - +x.date).slice(0, SHOW).forEach((r, i) => {
    console.log(`  ${i + 1}. ${fmt(r.date)}  →  ${r.to}`);
    console.log(`      ${r.subject.slice(0, 90)}   [${r.folder}]`);
  });
  if (sent.length > SHOW) console.log(`  …（另有 ${sent.length - SHOW} 封，用 --show 调）`);
  console.log('');

  console.log(`【B】退信 / 投递失败（NDR）：${bounces.length} 封`);
  if (!bounces.length) console.log('  （无）');
  bounces.sort((x, y) => +y.date - +x.date).forEach((b) => {
    console.log(`  ${fmt(b.date)}  ${b.from} | ${b.subject.slice(0, 70)}`);
    console.log(`      被拒收件人：${b.rejected.length ? b.rejected.join(', ') : '(正文里没解析出地址)'}`);
  });
  console.log('');

  console.log(`【C】对方回执 / 自动回复（按对方地址去重）：${byFrom.size} 个`);
  if (!byFrom.size) console.log('  （无）');
  [...byFrom.values()].sort((x, y) => +y.date - +x.date).slice(0, SHOW).forEach((a, i) => {
    console.log(`  ${i + 1}. ${fmt(a.date)}  ${a.from} | ${a.subject.slice(0, 70)}`);
  });
  console.log('');

  // D. 台账交叉核对
  //
  // 🔴 **必须「同类比同类」**：第一次写这条时，我拿「窗口内**所有**已发送」去比
  //    「`platform='offerbiu'` 的台账行」，结果立刻报「已发送比台账多 1 封 ⇒ 台账没记」。
  //    查下去发现那 1 封是更早一次别的通道发出的。**台账没问题，是仪器错了** ——
  //    一次误报，正是「误报比漏报危险」的现实版。
  //    改用正文指纹后**又暴露了第二层**：标题指纹本身就不该用（标题由招聘方要求决定，
  //    可能不含我们的手机号/姓名）。两次都错在同一件事上：**拿会变的字段当身份判据**。
  const isOurChannel = (r: Rec) => CHANNEL_BODY.test(r.body || '');
  const sentCh = sent.filter(isOurChannel);
  const sentOther = sent.filter((r) => !isOurChannel(r));

  const apps = listApplications(5000, 0, { platform: 'offerbiu' })
    .filter((a) => String(a.created_at || '') >= sinceIso);
  console.log('【D】台账交叉核对（platform=offerbiu，只比本通道的已发送）');
  console.log(`  库内 applications 窗口内：${apps.length} 条`);
  console.log(`  已发送（本通道）       ：${sentCh.length} 封`);
  if (sentOther.length) {
    console.log(`  已发送（非本通道，不参与核对）：${sentOther.length} 封 —— 正文里没有我们的模板，`
      + '多为人工/别的平台发的，别拿它们比台账');
    sentOther.slice(0, 3).forEach((r) => console.log(`      ${fmt(r.date)}  →  ${r.to}  「${r.subject.slice(0, 40)}」`));
  }
  const diff = sentCh.length - apps.length;
  if (diff === 0) {
    console.log('  ⇒ 一致 ✅（发了的都记了账，记了账的也都真发了）');
  } else if (diff > 0) {
    console.log(`  ⇒ 🔴 已发送比台账多 ${diff} 封：邮件真发出去了，但台账没记（用户会以为没投）`);
  } else {
    console.log(`  ⇒ 🔴 台账比已发送多 ${-diff} 条：记了账却没找到已发送存档（可能是假成功，要查）`);
  }

  await client.logout();
})().catch(async (e) => {
  console.error('ERR:', e?.message || e);
  try { await client.logout(); } catch { /* ignore */ }
  process.exit(1);
});
