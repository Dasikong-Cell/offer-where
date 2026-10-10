/**
 * 收件邮箱「可投递性」评估 —— 发信前的四道闸门（2026-10-09 因真实退信而建）
 *
 * 起因：`huangy@ieit.com` 被 QQ 退回，NDR 原文
 *   「收件人（huangy@ieit.com）所属域名不存在，邮件无法送达。No MX Record Found.」
 * 而这个地址是从**微信推文长图的 OCR 文本**里提出来的 —— OCR 会吞字符、会认错字母，
 * 所以「JD 里有这个邮箱」**不能**当成「这个邮箱能收到信」。
 *
 * 四道闸门（顺序执行，遇错即停；取自 GitHub 上成熟的 email-deliverability 做法，
 * 并**刻意不做 SMTP 探测** —— 现在多数 MTA 把 RCPT 探测当垃圾邮件侦察，结果不可信）：
 *   ① 格式    ：形状不对直接死，不值得查 DNS
 *   ② 域名    ：域名压根不解析（NXDOMAIN / 无 A 无 MX）⇒ 死
 *   ③ MX      ：**没有 MX 就是死**（注：RFC 允许无 MX 时回退 A，但实测 QQ 不回退 —— 见下）
 *   ④ 角色/占位：info@ / admin@ / noreply@ / test@ / 纯数字 … ⇒ 降级为 risky（不判死）
 *      🔴 **招聘专用账号（hr@ / jobs@ / career@ / zhaopin@ / campus@ / talent@）例外**：
 *         本场景不是营销信，`hr@` 恰恰是要投递的目标收件人，必须放行。
 *         （通用角色表照抄会导致 `hr@do1.com.cn` 被判 risky —— 初版实测踩过。）
 *
 * 🔴 两条硬纪律：
 * 1. **探针失败 ≠ 对方有问题**。DoH 查不通时判 `unverified`，绝不判死 ——
 *    「一次失败的探测是关于你自己网络的证据，不是关于对方域名的证据」。
 *    （实测本沙箱 UDP/TCP 53 全被拒 `ECONNREFUSED`，连 qq.com 都查不出 ⇒ 只能用 DoH。）
 * 2. **判据是可注入的**：`classifyDns()` 是纯函数（DNS 结果由调用方传进来），
 *    这样单测零网络、结果可复现；只有 `assessMailbox()` 才真的发请求。
 */

export type MailVerdict = 'sendable' | 'risky' | 'dead' | 'unverified';
export type MailGate = 'format' | 'dead-domain' | 'no-mx' | 'role-placeholder' | 'doh-unreachable';

export interface MailboxAssessment {
  email: string;
  domain: string;
  local: string;
  verdict: MailVerdict;
  gate?: MailGate;
  reason: string;
  mx?: string[];
  /** 探针时刻；缓存命中时为首次探测时刻 */
  checkedAt?: string;
  cached?: boolean;
}

/** 形状检查用的宽松正则：宁可放过，也不要把合法地址判死 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/**
 * 通用角色账号（**非招聘语义**）：只降级为 risky，不判死。
 *
 * 🔴 招聘投递的 local part（`hr` / `hrbp` / `jobs` / `career` / `recruit` /
 *    `zhaopin` / `campus` / `talent` / `hiring` …）**一律不在本表里**。
 *    起因（2026-10-10）：初版偷懒把 `hr|jobs|career` 塞了进来，实测 `hr@do1.com.cn`
 *    被判 `risky`。通用邮件营销里「角色账号」是坏信号（没人会读 `info@`），
 *    但**招聘投递恰恰就该发给 `hr@`/`campus@`/`zhaopin@`**。
 *    参考 SkillHub `email-deliverability` 的口径：角色账号的动作是「从营销信里剔除」——
 *    本场景不是营销信，所以这些词根本不该出现在这里。
 *
 *    ⚠️ 曾另建一张 `RECRUIT_LOCAL` 白名单表来「先命中覆盖」本表，后来删掉了：
 *       两张表零重叠 ⇒ 那个分支永远走不到，是**死代码**。
 *       「本表不含招聘词」由合约测试盯着（且已用破坏性对照证明那条断言有区分力），
 *       比留一段走不到的保护逻辑更实在。
 */
const ROLE_LOCAL =
  /^(info|admin|administrator|office|contact|support|service|sales|marketing|noreply|no-reply|postmaster|webmaster|abuse|privacy|legal|billing)$/i;
const PLACEHOLDER_LOCAL =
  /^(test|tests|demo|sample|example|foo|bar|asdasd|abc|abc123|xxx+|your|yourname|name|email|mail|none|null)$/i;

export function splitEmail(email: string): { local: string; domain: string } {
  const s = String(email || '').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  return at < 0 ? { local: '', domain: '' } : { local: s.slice(0, at), domain: s.slice(at + 1) };
}

/** ① 格式闸门（纯函数） */
export function checkShape(email: string): { ok: boolean; reason?: string } {
  const { local, domain } = splitEmail(email);
  if (!EMAIL_SHAPE.test(String(email || '').trim())) return { ok: false, reason: '地址形状不合法（缺 @ 或缺域名点号）' };
  if (local.length > 64) return { ok: false, reason: 'local part 超过 64 字符' };
  if (domain.length > 255) return { ok: false, reason: '域名超过 255 字符' };
  if (!/^[a-z0-9.-]+$/.test(domain)) return { ok: false, reason: '域名含非法字符' };
  if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return { ok: false, reason: '域名点号位置非法' };
  if (!/\.[a-z]{2,}$/.test(domain)) return { ok: false, reason: 'TLD 不合法' };
  // RFC 952/1123：域名标签不得以连字符开头或结尾
  for (const label of domain.split('.')) {
    if (!label) return { ok: false, reason: '域名里有点号造成的空标签' };
    if (label.startsWith('-') || label.endsWith('-')) return { ok: false, reason: '域名标签以连字符开头或结尾' };
  }
  return { ok: true };
}

/** ④ 角色 / 占位账号（纯函数）—— 只降级为 risky，不判死 */
export function isRoleOrPlaceholder(local: string): { risky: boolean; reason?: string } {
  const l = String(local || '').toLowerCase();
  if (ROLE_LOCAL.test(l)) return { risky: true, reason: `通用角色账号（${l}@，通常无人细读）` };
  if (PLACEHOLDER_LOCAL.test(l)) return { risky: true, reason: `占位账号（${l}@）` };
  if (/^\d+$/.test(l)) return { risky: true, reason: 'local part 全是数字' };
  if (/^(.)\1{2,}$/.test(l)) return { risky: true, reason: 'local part 是重复字符' };
  return { risky: false };
}

/**
 * ②③ 域名 / MX 判定（**纯函数**：DNS 结果由调用方注入 ⇒ 单测零网络）
 * @param dns  null 表示**探针失败**（不是"没有记录"！）⇒ 判 unverified
 *             { status, mx, a } 三种字段任一缺失按"没有"处理
 */
export function classifyDns(
  email: string,
  dns: { status?: number; mx?: string[]; a?: string[] } | null,
): MailboxAssessment {
  const { local, domain } = splitEmail(email);
  const base = { email: String(email || '').trim(), domain, local };

  const shape = checkShape(email);
  if (!shape.ok) return { ...base, verdict: 'dead', gate: 'format', reason: shape.reason! };

  if (dns === null) {
    return { ...base, verdict: 'unverified', gate: 'doh-unreachable',
      reason: 'DNS 探针不可达（这是本机网络的证据，不是对方域名的证据）—— 不据此判死' };
  }

  const mx = dns.mx || [];
  const a = dns.a || [];

  if (dns.status === 3) {
    return { ...base, verdict: 'dead', gate: 'dead-domain', reason: '域名不存在（NXDOMAIN）', mx };
  }
  if (mx.length) {
    const role = isRoleOrPlaceholder(local);
    return role.risky
      ? { ...base, verdict: 'risky', gate: 'role-placeholder', reason: role.reason!, mx }
      : { ...base, verdict: 'sendable', reason: `MX 正常（${mx[0]}）`, mx };
  }
  if (!a.length) {
    return { ...base, verdict: 'dead', gate: 'no-mx', reason: '既无 MX 也无 A 记录 ⇒ 无任何服务器收该域名的信', mx };
  }
  // 无 MX 但有 A：RFC 允许回退 A，但**实测 QQ 不回退**（2026-10-09 真实 NDR：ieit.com 有 A 仍被退）
  return { ...base, verdict: 'dead', gate: 'no-mx',
    reason: '无 MX 记录（仅有 A）⇒ 实测 QQ 直接退信 No MX Record Found，不做 A 回退', mx };
}

// ── 下面是会真的发网络请求的部分 ──────────────────────────────────────────────

const DOH = process.env.DOH_ENDPOINT || 'https://dns.alidns.com/resolve';
const CACHE_TTL_MS = 10 * 60 * 1000;
const DOH_TIMEOUT_MS = Number(process.env.DOH_TIMEOUT_MS || 6000);

type DnsBundle = { status?: number; mx?: string[]; a?: string[] };
const cache = new Map<string, { at: number; dns: DnsBundle | null }>();

async function dohQuery(name: string, type: 'MX' | 'A', signal: AbortSignal): Promise<{ status?: number; answers: string[] }> {
  const url = `${DOH}?name=${encodeURIComponent(name)}&type=${type}`;
  const res = await fetch(url, { headers: { accept: 'application/dns-json' }, signal });
  if (!res.ok) throw new Error(`DoH HTTP ${res.status}`);
  const j: any = await res.json();
  const answers: string[] = Array.isArray(j?.Answer) ? j.Answer.map((x: any) => String(x?.data || '')) : [];
  return { status: typeof j?.Status === 'number' ? j.Status : undefined, answers };
}

/** 查一个域名的 DNS（带超时 + 缓存）。失败返回 null（调用方据此判 unverified，不判死） */
export async function lookupDomain(domain: string): Promise<DnsBundle | null> {
  if (!domain) return null;
  const hit = cache.get(domain);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.dns;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), DOH_TIMEOUT_MS);
  try {
    const mxQ = await dohQuery(domain, 'MX', ctl.signal);
    const aQ = await dohQuery(domain, 'A', ctl.signal);
    const bundle: DnsBundle = { status: mxQ.status, mx: mxQ.answers, a: aQ.answers };
    cache.set(domain, { at: Date.now(), dns: bundle });
    return bundle;
  } catch {
    // 探针失败：**不写缓存**（否则网络恢复后 10 分钟内仍判 unverified）
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 完整评估：格式 → DoH → 判定 */
export async function assessMailbox(email: string): Promise<MailboxAssessment> {
  const { domain } = splitEmail(email);
  // 形状不对就不必查 DNS（classifyDns 内部会先做形状检查，所以这里传 null 也不会误判 unverified）
  if (!checkShape(email).ok) return classifyDns(email, null);
  const dns = await lookupDomain(domain);
  const out = classifyDns(email, dns);
  const hit = cache.get(domain);
  if (hit) { out.checkedAt = new Date(hit.at).toISOString(); out.cached = true; }
  return out;
}

/** 批量（本轮 50 条级别，够用；不做并发限制的复杂度） */
export async function assessMailboxes(emails: string[]): Promise<Map<string, MailboxAssessment>> {
  const map = new Map<string, MailboxAssessment>();
  for (const e of emails) map.set(e, await assessMailbox(e));
  return map;
}

/** 给投递路径用的一句话摘要 */
export function describeAssessment(a: MailboxAssessment): string {
  const tag = { sendable: '可投递', risky: '有风险', dead: '不可投递', unverified: '未能核实' }[a.verdict];
  return `${tag}：${a.reason}`;
}
