import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 数据库文件路径
const dbPath = path.join(__dirname, '..', 'data', 'chat.db');

// 确保 data 目录存在
import fs from 'fs';
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// 创建数据库连接
const db: import('better-sqlite3').Database = new Database(dbPath);

// 启用 WAL 模式以提高性能
db.pragma('journal_mode = WAL');

// 通用只读查询助手（供统计/漏斗等即席聚合使用）
export function query<T = any>(sql: string, params: any[] = []): T[] {
  return db.prepare(sql).all(...params) as T[];
}

// 初始化数据库表
db.exec(`
  -- 会话表
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    model TEXT NOT NULL,
    sdk_session_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- 消息表
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    model TEXT,
    created_at TEXT NOT NULL,
    tool_calls TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  -- 为会话 ID 创建索引
  CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);

  -- 求职者档案（单条记录，id 固定为 'default'）
  CREATE TABLE IF NOT EXISTS profile (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- 邮箱配置（用于 IMAP 读取登录验证码）
  CREATE TABLE IF NOT EXISTS mail_config (
    id TEXT PRIMARY KEY,
    email TEXT,
    auth_code TEXT,
    imap_host TEXT,
    imap_port INTEGER,
    use_ssl INTEGER,
    updated_at TEXT NOT NULL
  );

  -- 投递记录
  CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    company TEXT,
    position TEXT,
    salary TEXT,
    city TEXT,
    job_url TEXT,
    status TEXT NOT NULL,
    login_method TEXT,
    message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_applications_platform ON applications(platform);
  CREATE INDEX IF NOT EXISTS idx_applications_created ON applications(created_at DESC);

  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL DEFAULT 'manual',
    company TEXT,
    position TEXT,
    city TEXT,
    jd TEXT,
    requirements TEXT,
    salary TEXT,
    apply_url TEXT,
    deadline TEXT,
    match_score REAL,
    match_detail TEXT,
    quarantine TEXT,
    skip_reason TEXT,
    -- 列表页卡片摘要（如 offerbiu 的「更新9月2日 / 2027届 / 投递入口」）。
    -- ⚠️ 它不是岗位描述：曾整批塞进 jd，导致「JD 覆盖率 89%」虚高、
    -- 匹配分与求职信/定制简历/面试攻略全部失效。单独存此列保留信息，jd 只放真岗位描述。
    card_text TEXT,
    status TEXT NOT NULL DEFAULT 'candidate',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs(source);
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

  -- 通用键值存储（运行时间段调度 / 求职信模板 / 简历版本 等轻量配置）
  CREATE TABLE IF NOT EXISTS app_kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- 求职信台账：用于「三重去重」（该 HR 是否已写过求职信、HR 是否已回复）
  CREATE TABLE IF NOT EXISTS cover_letters (
    id TEXT PRIMARY KEY,
    dedupe_key TEXT NOT NULL UNIQUE,
    platform TEXT NOT NULL,
    company TEXT,
    position TEXT,
    job_id TEXT,
    content TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'llm',
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_cover_letters_platform ON cover_letters(platform);

  -- HR 会话跟踪（自动回复用）
  -- conv_key 用于去重：同一平台+同一 HR+同一公司视为一条会话，避免重复回复
  CREATE TABLE IF NOT EXISTS hr_conversations (
    id TEXT PRIMARY KEY,
    conv_key TEXT NOT NULL UNIQUE,
    platform TEXT NOT NULL,
    hr_name TEXT,
    company TEXT,
    position TEXT,
    job_url TEXT,
    stage TEXT NOT NULL DEFAULT 'new',
    last_hr_message TEXT,
    last_reply TEXT,
    last_hr_message_at TEXT,
    last_replied_at TEXT,
    round INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_hrconv_platform ON hr_conversations(platform);
  CREATE INDEX IF NOT EXISTS idx_hrconv_stage ON hr_conversations(stage);

  -- 官网投递表单记忆（按域名存 {字段标签: 值}；人工填一次后自动复用）
  CREATE TABLE IF NOT EXISTS form_memory (
    id TEXT PRIMARY KEY,
    site TEXT NOT NULL UNIQUE,
    fields TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

// 数据库迁移：添加 sdk_session_id 列（如果不存在）
try {
  const tableInfo = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
  const hasColumn = tableInfo.some(col => col.name === 'sdk_session_id');
  if (!hasColumn) {
    db.exec("ALTER TABLE sessions ADD COLUMN sdk_session_id TEXT");
    console.log("[DB] Added sdk_session_id column to sessions table");
  }
} catch (e) {
  // 忽略错误（列可能已存在）
}

// 数据库迁移：hr_conversations 增加 ai_name / ai_source（标记 AI 回复身份）
try {
  const ti = db.prepare("PRAGMA table_info(hr_conversations)").all() as Array<{ name: string }>;
  const cols = ti.map((c) => c.name);
  if (!cols.includes('ai_name')) {
    db.exec("ALTER TABLE hr_conversations ADD COLUMN ai_name TEXT");
    console.log("[DB] Added ai_name column to hr_conversations");
  }
  if (!cols.includes('ai_source')) {
    db.exec("ALTER TABLE hr_conversations ADD COLUMN ai_source TEXT");
    console.log("[DB] Added ai_source column to hr_conversations");
  }
} catch (e) {
  // 忽略错误（列可能已存在）
}

// 数据库迁移：jobs 增加 quarantine 列（跨公司串号隔离标记）
try {
  const jc = db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
  if (!jc.some((c) => c.name === 'quarantine')) {
    db.exec("ALTER TABLE jobs ADD COLUMN quarantine TEXT");
    console.log("[DB] Added quarantine column to jobs");
  }
} catch (e) {
  // 忽略错误（列可能已存在）
}

// 数据库迁移：jobs 增加 skip_reason 列（跳过原因留痕，供漏斗分析规则误杀）
try {
  const jc2 = db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
  if (!jc2.some((c) => c.name === 'skip_reason')) {
    db.exec("ALTER TABLE jobs ADD COLUMN skip_reason TEXT");
    console.log("[DB] Added skip_reason column to jobs");
  }
} catch (e) {
  // 忽略错误（列可能已存在）
}

// 数据库迁移：jobs 增加 card_text 列（列表页卡片摘要，与真 JD 分离）
try {
  const jc3 = db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
  if (!jc3.some((c) => c.name === 'card_text')) {
    db.exec("ALTER TABLE jobs ADD COLUMN card_text TEXT");
    console.log("[DB] Added card_text column to jobs");
  }
} catch (e) {
  // 忽略错误（列可能已存在）
}

// ============= 通用 kv（app_kv） =============

/** 读 kv；不存在返回 null。value 为字符串，结构化数据由调用方自行 JSON 解析。 */
export function kvGet(key: string): string | null {
  const row = db.prepare('SELECT value FROM app_kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

/** 写 kv（upsert） */
export function kvSet(key: string, value: string): void {
  db.prepare(`INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, value, new Date().toISOString());
}

/** 读 JSON kv，解析失败返回 fallback */
export function kvGetJson<T>(key: string, fallback: T): T {
  const raw = kvGet(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

/** 写 JSON kv */
export function kvSetJson(key: string, value: unknown): void {
  kvSet(key, JSON.stringify(value));
}

/** 删除 kv（不存在也不报错） */
export function kvDelete(key: string): void {
  db.prepare('DELETE FROM app_kv WHERE key = ?').run(key);
}

/** 按前缀列出 kv 键（如 'interview:'） */
export function kvKeysByPrefix(prefix: string): string[] {
  const rows = db.prepare('SELECT key FROM app_kv WHERE key LIKE ? ORDER BY key').all(`${prefix}%`) as Array<{ key: string }>;
  return rows.map((r) => r.key);
}

// ============= 求职信台账（三重去重） =============

export interface CoverLetterRow {
  id: string;
  dedupe_key: string;
  platform: string;
  company: string | null;
  position: string | null;
  job_id: string | null;
  content: string;
  source: string;
  created_at: string;
}

/** 生成求职信去重键：同平台 + 同 HR/公司 + 同岗位 视为同一封信 */
export function coverLetterKey(platform: string, company?: string | null, position?: string | null, hrKey?: string | null): string {
  const part = (s?: string | null) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');
  return hrKey ? `${platform}|hr:${part(hrKey)}` : `${platform}|${part(company)}|${part(position)}`;
}

export function getCoverLetter(dedupeKey: string): CoverLetterRow | undefined {
  return db.prepare('SELECT * FROM cover_letters WHERE dedupe_key = ?').get(dedupeKey) as CoverLetterRow | undefined;
}

export function saveCoverLetter(row: {
  dedupe_key: string; platform: string; company?: string | null;
  position?: string | null; job_id?: string | null; content: string; source?: string;
}): CoverLetterRow {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO cover_letters (id, dedupe_key, platform, company, position, job_id, content, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(dedupe_key) DO UPDATE SET content = excluded.content, source = excluded.source, job_id = excluded.job_id`)
    .run(randomUUID(), row.dedupe_key, row.platform, row.company ?? null, row.position ?? null,
      row.job_id ?? null, row.content, row.source || 'llm', now);
  return getCoverLetter(row.dedupe_key) as CoverLetterRow;
}

export function countCoverLetters(platform?: string): number {
  const r = platform
    ? db.prepare('SELECT COUNT(*) c FROM cover_letters WHERE platform = ?').get(platform) as { c: number }
    : db.prepare('SELECT COUNT(*) c FROM cover_letters').get() as { c: number };
  return r.c;
}

// 类型定义
export interface DbSession {
  id: string;
  title: string;
  model: string;
  sdk_session_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant';
  content: string;
  model: string | null;
  created_at: string;
  tool_calls: string | null;
}

// ============= 会话操作 =============

// 获取所有会话
export function getAllSessions(): DbSession[] {
  const stmt = db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC');
  return stmt.all() as DbSession[];
}

// 获取单个会话
export function getSession(id: string): DbSession | undefined {
  const stmt = db.prepare('SELECT * FROM sessions WHERE id = ?');
  return stmt.get(id) as DbSession | undefined;
}

// 创建会话
export function createSession(session: DbSession): DbSession {
  const stmt = db.prepare(`
    INSERT INTO sessions (id, title, model, sdk_session_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(session.id, session.title, session.model, session.sdk_session_id, session.created_at, session.updated_at);
  return session;
}

// 更新会话
export function updateSession(id: string, updates: Partial<Pick<DbSession, 'title' | 'model' | 'sdk_session_id'>>): boolean {
  const fields: string[] = [];
  const values: any[] = [];
  
  if (updates.title !== undefined) {
    fields.push('title = ?');
    values.push(updates.title);
  }
  if (updates.model !== undefined) {
    fields.push('model = ?');
    values.push(updates.model);
  }
  if (updates.sdk_session_id !== undefined) {
    fields.push('sdk_session_id = ?');
    values.push(updates.sdk_session_id);
  }
  
  if (fields.length === 0) return false;
  
  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);
  
  const stmt = db.prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE id = ?`);
  const result = stmt.run(...values);
  return result.changes > 0;
}

// 删除会话
export function deleteSession(id: string): boolean {
  const stmt = db.prepare('DELETE FROM sessions WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

// ============= 消息操作 =============

// 获取会话的所有消息
export function getMessagesBySession(sessionId: string): DbMessage[] {
  const stmt = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC');
  return stmt.all(sessionId) as DbMessage[];
}

// 创建消息
export function createMessage(message: DbMessage): DbMessage {
  const stmt = db.prepare(`
    INSERT INTO messages (id, session_id, role, content, model, created_at, tool_calls)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    message.id,
    message.session_id,
    message.role,
    message.content,
    message.model,
    message.created_at,
    message.tool_calls
  );
  
  // 更新会话的 updated_at
  const updateStmt = db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?');
  updateStmt.run(new Date().toISOString(), message.session_id);
  
  return message;
}

// 更新消息内容
export function updateMessage(id: string, updates: Partial<Pick<DbMessage, 'content' | 'tool_calls'>>): boolean {
  const fields: string[] = [];
  const values: any[] = [];
  
  if (updates.content !== undefined) {
    fields.push('content = ?');
    values.push(updates.content);
  }
  if (updates.tool_calls !== undefined) {
    fields.push('tool_calls = ?');
    values.push(updates.tool_calls);
  }
  
  if (fields.length === 0) return false;
  
  values.push(id);
  
  const stmt = db.prepare(`UPDATE messages SET ${fields.join(', ')} WHERE id = ?`);
  const result = stmt.run(...values);
  return result.changes > 0;
}

// 删除消息
export function deleteMessage(id: string): boolean {
  const stmt = db.prepare('DELETE FROM messages WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

// 批量创建消息（用于保存对话）
export function createMessages(messages: DbMessage[]): void {
  const stmt = db.prepare(`
    INSERT INTO messages (id, session_id, role, content, model, created_at, tool_calls)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  
  const insertMany = db.transaction((msgs: DbMessage[]) => {
    for (const msg of msgs) {
      stmt.run(msg.id, msg.session_id, msg.role, msg.content, msg.model, msg.created_at, msg.tool_calls);
    }
  });
  
  insertMany(messages);
}

// ============= 求职者档案 =============

export interface ProfileRow {
  id: string;
  data: string;
  updated_at: string;
}

export function getProfile(): Record<string, unknown> {
  const row = db.prepare('SELECT data FROM profile WHERE id = ?').get('default') as ProfileRow | undefined;
  if (!row) return {};
  try {
    return JSON.parse(row.data);
  } catch {
    return {};
  }
}

export function saveProfile(data: Record<string, unknown>): void {
  db.prepare(`
    INSERT INTO profile (id, data, updated_at) VALUES ('default', ?, ?)
    ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run(JSON.stringify(data), new Date().toISOString());
}

// ============= 邮箱配置 =============

export interface MailConfigRow {
  id: string;
  email: string | null;
  auth_code: string | null;
  imap_host: string | null;
  imap_port: number | null;
  use_ssl: number | null;
  updated_at: string;
}

export function getMailConfig(): MailConfigRow | undefined {
  return db.prepare('SELECT * FROM mail_config WHERE id = ?').get('default') as MailConfigRow | undefined;
}

export function saveMailConfig(cfg: {
  email?: string | null;
  authCode?: string | null;
  imapHost?: string | null;
  imapPort?: number | null;
  useSsl?: boolean | null;
}): void {
  const current = getMailConfig();
  const merged: MailConfigRow = {
    id: 'default',
    email: cfg.email !== undefined ? cfg.email : (current?.email ?? null),
    auth_code: cfg.authCode !== undefined ? cfg.authCode : (current?.auth_code ?? null),
    imap_host: cfg.imapHost !== undefined ? cfg.imapHost : (current?.imap_host ?? 'imap.qq.com'),
    imap_port: cfg.imapPort !== undefined ? cfg.imapPort : (current?.imap_port ?? 993),
    use_ssl: cfg.useSsl !== undefined ? (cfg.useSsl ? 1 : 0) : (current?.use_ssl ?? 1),
    updated_at: new Date().toISOString(),
  };
  db.prepare(`
    INSERT INTO mail_config (id, email, auth_code, imap_host, imap_port, use_ssl, updated_at)
    VALUES (@id, @email, @auth_code, @imap_host, @imap_port, @use_ssl, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      email = excluded.email,
      auth_code = excluded.auth_code,
      imap_host = excluded.imap_host,
      imap_port = excluded.imap_port,
      use_ssl = excluded.use_ssl,
      updated_at = excluded.updated_at
  `).run(merged);
}

// ============= 投递记录 =============

export interface ApplicationRow {
  id: string;
  platform: string;
  company: string | null;
  position: string | null;
  salary: string | null;
  city: string | null;
  job_url: string | null;
  status: string;
  login_method: string | null;
  message: string | null;
  created_at: string;
  updated_at: string;
}

export function listApplications(limit = 500): ApplicationRow[] {
  return db.prepare('SELECT * FROM applications ORDER BY created_at DESC LIMIT ?').all(limit) as ApplicationRow[];
}

export function createApplication(app: Omit<ApplicationRow, 'created_at' | 'updated_at'>): ApplicationRow {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO applications (id, platform, company, position, salary, city, job_url, status, login_method, message, created_at, updated_at)
    VALUES (@id, @platform, @company, @position, @salary, @city, @job_url, @status, @login_method, @message, @created_at, @updated_at)
  `).run({ ...app, created_at: now, updated_at: now });
  return { ...app, created_at: now, updated_at: now };
}

export function updateApplication(id: string, updates: Partial<Pick<ApplicationRow,
  'platform' | 'company' | 'position' | 'salary' | 'city' | 'job_url' | 'status' | 'login_method' | 'message'
>>): boolean {
  const fields: string[] = [];
  const values: any[] = [];
  for (const key of Object.keys(updates) as Array<keyof typeof updates>) {
    const value = (updates as any)[key];
    if (value !== undefined) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }
  if (fields.length === 0) return false;
  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);
  const result = db.prepare(`UPDATE applications SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return result.changes > 0;
}

export function deleteApplication(id: string): boolean {
  return db.prepare('DELETE FROM applications WHERE id = ?').run(id).changes > 0;
}

// ============= 岗位池（来自 Offerbiu / 手动录入） =============

export interface JobRow {
  id: string;
  source: string;
  company: string | null;
  position: string | null;
  city: string | null;
  jd: string | null;
  requirements: string | null;
  salary: string | null;
  apply_url: string | null;
  deadline: string | null;
  match_score: number | null;
  match_detail: string | null;
  /** 跨公司串号隔离原因（非空表示默认跳过投递，需 force 放行） */
  quarantine: string | null;
  /** 跳过投递的原因（AI/规则给出，用于漏斗分析规则误杀；非空表示此岗位被主动跳过） */
  skip_reason: string | null;
  /** 列表页卡片摘要（非岗位描述）。与 jd 分离，避免它被当成 JD 参与匹配/AI 文案 */
  card_text: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export function listJobs(opts: { source?: string; status?: string; limit?: number } = {}): JobRow[] {
  let sql = 'SELECT * FROM jobs WHERE 1=1';
  const params: any[] = [];
  if (opts.source) { sql += ' AND source = ?'; params.push(opts.source); }
  if (opts.status) { sql += ' AND status = ?'; params.push(opts.status); }
  sql += ' ORDER BY (match_score IS NULL), match_score DESC, created_at DESC LIMIT ?';
  params.push(opts.limit || 1000);
  return db.prepare(sql).all(...params) as JobRow[];
}

export function getJob(id: string): JobRow | undefined {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
}

/** 按来源+公司+岗位去重插入/更新；返回最终行 */
/**
 * 岗位文本字段统一清洗（**防御层**：放在写库口，任何采集器调用方都受保护）。
 *
 * 背景（2026-09-19 测评实测）：BOSS 列表页的薪资用**加密字体**渲染（Unicode 私有区 U+E000–U+F8FF），
 * 抽取时字形丢失、数字变空，于是 `job-title` 的文本变成 `"Java\n-K"`；
 * 又因某些采集器（collect_multi）用 `.job-title` 取职位名且不做空白折叠，脏值直接落了库。
 * 实测库内 59/373 条 BOSS 岗位的 position 含换行或薪资残片。
 *
 * 清洗规则：去 PUA 字形 → 折叠换行/多余空白 → 剥离尾部薪资残片 → 去首尾符号；
 * 若整串本身就是无意义的薪资残片（如 `"-K"`），返回 null（宁可为空，也不要脏值）。
 */
const PUA_RE = /[\uE000-\uF8FF]/g;
/** 尾部薪资残片：`Java -K` / `java开发工程师 K`（数字已被加密字体吞掉） */
const SALARY_LOST_TAIL_RE = /\s+[-–—]?\s*[kK]\s*$/;
/** 完整薪资：`Java 10-20K ·16薪` / `20~30k` */
const SALARY_NUM_TAIL_RE = /\s*·?\s*\d+\s*[-~至]\s*\d+\s*[kK千]\s*(?:·?\s*\d+\s*薪)?\s*$/;
/** 整串即薪资残片 */
const SALARY_ONLY_RE = /^[-–—·,，\s]*[kK]?\s*(?:·?\s*\d+\s*薪)?$/;

export function sanitizeJobText(input: unknown, maxLen = 120): string | null {
  if (input === null || input === undefined) return null;
  let s = String(input).replace(PUA_RE, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (SALARY_ONLY_RE.test(s)) return null;
  s = s.replace(SALARY_NUM_TAIL_RE, '').replace(SALARY_LOST_TAIL_RE, '').trim();
  s = s.replace(/^[-–—·,，;；|｜/\s]+/, '').replace(/[-–—·,，;；|｜/\s]+$/, '').trim();
  if (!s) return null;
  return s.slice(0, maxLen);
}

/**
 * 薪资字段专用清洗：**不能**复用 sanitizeJobText —— 后者的「剥离尾部薪资残片」规则
 * 会把合法的 `10-20k` 整串清成 null（实测踩过）。
 * 薪资只需要：去 PUA 字形 → 折叠空白；若清洗后**一个数字都不剩**（加密字体把数字吞了，
 * 只剩 `-K` 这种残片）则视为无信息，返回 null。
 */
export function sanitizeSalary(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  const s = String(input).replace(PUA_RE, '').replace(/\s+/g, ' ').trim();
  if (!/\d/.test(s)) return null;
  return s.slice(0, 30);
}

/**
 * 去掉「职位名」后面粘上的卡片元数据。
 *
 * 背景（2026-09-19 测评实测）：老版 51job 采集器直接拿链接元素的 `innerText` 当职位名，
 * 而那是**整张卡片**的文本，于是入库成：
 *   `"软件全栈工程师(010565) 5-9千 昆明·呈贡区 无需经验 本科 java mysql 数据库"`
 * （实测 118/149 条 job51 岗位被污染，同时污染关键词过滤与展示）。
 *
 * 修复：截断到「城市·区」或「薪资」标记之前。仅在能识别出标记、且截断后长度合理时才生效 ——
 * 否则原样返回（宁可保留长值，也不误伤合法职位名如「Java开发工程师·远程」）。
 */
const CARD_CITY_DIST = /\s+[\u4e00-\u9fa5]{2,5}·[\u4e00-\u9fa5]{2,6}/;
const CARD_SALARY = /\s+\d+(?:\.\d+)?\s*[-~至]?\s*\d*(?:\.\d+)?\s*[千万kK](?:·\s*\d+\s*薪)?/;

export function stripCardTail(s: string): string {
  let out = s;
  const c = out.match(CARD_CITY_DIST);
  if (c && c.index !== undefined && c.index >= 2) out = out.slice(0, c.index);
  const sal = out.match(CARD_SALARY);
  if (sal && sal.index !== undefined && sal.index >= 2) out = out.slice(0, sal.index);
  out = out.trim().replace(/[·,，;；|｜/\s]+$/, '').trim();
  return out.length >= 2 && out.length <= 50 ? out : s;
}

/** 职位名清洗 = 通用文本清洗 + 去掉卡片尾巴 */
export function sanitizePosition(input: unknown): string | null {
  const s = sanitizeJobText(input, 80);
  return s ? stripCardTail(s) : null;
}

/** 公司名清洗 = 通用文本清洗 + 剥掉标签前缀 + 过滤纯导航/按钮类脏值 */
const COMPANY_JUNK = /^(APP下载|下载APP|首页|登录|注册|搜索|关注公众号|求职招聘|立即投递|查看全部)$/;
export function sanitizeCompany(input: unknown): string | null {
  let s = sanitizeJobText(input, 60);
  if (!s) return null;
  s = s.replace(/^公司全称[：:]\s*/, '').trim();
  if (COMPANY_JUNK.test(s)) return null;
  return s || null;
}

/**
 * 判断一段文本其实是「列表页卡片摘要」而不是岗位描述。
 *
 * 背景（2026-09-19 复测发现）：offerbiu 采集器曾把列表页卡片的 innerText 整批写进 jd，
 * 形如「中大咨询集团 更新 9月2日 博士顾问… 2027届 尽快投递 秋招 需要笔试 投递入口」。
 * 它有 80~120 字、能通过所有"JD 非空"检查，却让「JD 覆盖率 89%」成为虚高数字，
 * 并使匹配分 / 求职信 / 定制简历 / 面试攻略全部失效。
 *
 * 这类文本应存进 card_text，不得存进 jd。
 */
export function isCardSummaryJd(text: unknown): boolean {
  const t = String(text || '');
  if (!t.trim()) return false;
  // 只保留「结构性」标记：实测它们对真 JD 零误伤、对卡片摘要 100% 命中。
  // ⚠️ 别再加「尽快投递」「等 N 项」——真 JD 正文里会自然出现
  //    （如「…请尽快投递简历」→ 实测 boss 误判 1 条；「等 3 项」→ 误判 81 条）。
  return t.includes('投递入口')
    || /更新\s*\d{1,2}\s*月\s*\d{1,2}\s*日/.test(t);
}

export function upsertJob(job: {
  id?: string;
  source?: string;
  company?: string | null;
  position?: string | null;
  city?: string | null;
  jd?: string | null;
  requirements?: string | null;
  salary?: string | null;
  apply_url?: string | null;
  deadline?: string | null;
  /** 列表页卡片摘要（非岗位描述）。调用方若只有卡片文本，应传这里而**不要**传 jd */
  card_text?: string | null;
}): JobRow {
  // 写库口统一清洗（员工 见 sanitizeJobText 注释）
  job = {
    ...job,
    company: sanitizeCompany(job.company),
    position: sanitizePosition(job.position),
    city: sanitizeJobText(job.city, 30),
    // 薪资也被加密字体污染（`10-20K` → `-K`），用专用清洗（保留合法薪资、丢弃无数字残片）
    salary: sanitizeSalary(job.salary),
  };
  const now = new Date().toISOString();
  // 去重键：优先「来源 + 公司 + 职位」，退化到「来源 + apply_url」。
  // ⚠️ 必须用 COALESCE 包一层：SQL 里 `NULL = NULL` 恒为 false，
  // 若沿用 `company = ?` 而历史行的 company 为 NULL，就永远匹配不上 → 同一岗位被反复插入。
  // 这正是 2026-09-19 测评发现「重复岗位」的根因（实测 company 为空的记录重复了 11+ 组）。
  const src = job.source || 'manual';
  const existing = job.company && job.position
    ? db.prepare("SELECT * FROM jobs WHERE source = ? AND COALESCE(company,'') = ? AND COALESCE(position,'') = ?")
        .get(src, job.company, job.position) as JobRow | undefined
    : job.apply_url
      ? db.prepare('SELECT * FROM jobs WHERE source = ? AND apply_url = ?')
          .get(src, job.apply_url) as JobRow | undefined
      : undefined;
  const id = existing?.id || job.id || randomUUID();
  db.prepare(`
    INSERT INTO jobs (id, source, company, position, city, jd, requirements, salary, apply_url, deadline, card_text, status, created_at, updated_at)
    VALUES (@id, @source, @company, @position, @city, @jd, @requirements, @salary, @apply_url, @deadline, @card_text, 'candidate', @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      company = excluded.company,
      position = excluded.position,
      city = excluded.city,
      jd = excluded.jd,
      requirements = excluded.requirements,
      salary = excluded.salary,
      apply_url = excluded.apply_url,
      deadline = excluded.deadline,
      card_text = excluded.card_text,
      updated_at = excluded.updated_at
  `).run({
    id,
    source: job.source || 'manual',
    company: job.company ?? null,
    position: job.position ?? null,
    city: job.city ?? null,
    jd: job.jd ?? null,
    card_text: job.card_text ?? null,
    requirements: job.requirements ?? null,
    salary: job.salary ?? null,
    apply_url: job.apply_url ?? null,
    deadline: job.deadline ?? null,
    created_at: existing?.created_at || now,
    updated_at: now,
  });
  return getJob(id)!;
}

export function updateJob(id: string, updates: Partial<Pick<JobRow,
  'company' | 'position' | 'city' | 'jd' | 'requirements' | 'salary' | 'apply_url' | 'deadline' | 'match_score' | 'match_detail' | 'quarantine' | 'skip_reason' | 'card_text' | 'status'
>>): boolean {
  const fields: string[] = [];
  const values: any[] = [];
  /** 文本字段同样过清洗，避免绕过 upsertJob 直接脏写（见 sanitize* 系列） */
  const sanitizeField = (k: string, v: any): any => {
    if (k === 'company') return sanitizeCompany(v);
    if (k === 'position') return sanitizePosition(v);
    if (k === 'salary') return sanitizeSalary(v);
    if (k === 'city') return sanitizeJobText(v, 30);
    return v;
  };
  for (const key of Object.keys(updates) as Array<keyof typeof updates>) {
    const raw = (updates as any)[key];
    if (raw === undefined) continue;
    const value = sanitizeField(key as string, raw);
    fields.push(`${key} = ?`);
    values.push(value);
  }
  if (fields.length === 0) return false;
  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);
  const result = db.prepare(`UPDATE jobs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return result.changes > 0;
}

export function deleteJob(id: string): boolean {
  return db.prepare('DELETE FROM jobs WHERE id = ?').run(id).changes > 0;
}

export function deleteJobsBySource(source: string): number {
  return db.prepare('DELETE FROM jobs WHERE source = ?').run(source).changes;
}

export function clearJobs(): void {
  db.exec('DELETE FROM jobs');
}

/* ─────────────── 官网投递表单记忆（按域名自动填表） ─────────────── */

export interface FormMemoryRow {
  id: string;
  site: string;
  fields: string; // JSON: { "字段标签": "值" }
  updated_at: string;
}

/** 读取某域名的表单记忆（{ 字段标签: 值 }），无则返回空对象 */
export function getFormMemory(site: string): Record<string, string> {
  const row = db.prepare('SELECT fields FROM form_memory WHERE site = ?').get(site) as FormMemoryRow | undefined;
  if (!row) return {};
  try {
    const o = JSON.parse(row.fields);
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

/** 写入/覆盖某域名的表单记忆（人工填一次后下次自动复用） */
export function saveFormMemory(site: string, fields: Record<string, string>): void {
  if (!site || !Object.keys(fields).length) return;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO form_memory (id, site, fields, updated_at)
    VALUES (@id, @site, @fields, @now)
    ON CONFLICT(site) DO UPDATE SET fields = excluded.fields, updated_at = excluded.updated_at
  `).run({ id: randomUUID(), site, fields: JSON.stringify(fields), now });
}

// 清空所有数据
export function clearAllData(): void {
  db.exec('DELETE FROM messages');
  db.exec('DELETE FROM sessions');
}

/* ─────────────── HR 会话跟踪（自动回复用） ─────────────── */

export interface HrConversationRow {
  id: string;
  conv_key: string;
  platform: string;
  hr_name: string | null;
  company: string | null;
  position: string | null;
  job_url: string | null;
  stage: string;
  last_hr_message: string | null;
  last_reply: string | null;
  last_hr_message_at: string | null;
  last_replied_at: string | null;
  round: number;
  /** AI 回复身份标记：发出回复的 AI 助手名（如「懒懒」） */
  ai_name: string | null;
  /** 回复来源：'ai' = 大模型生成；'rule' = 规则模板；null = 未回复 */
  ai_source: string | null;
  created_at: string;
  updated_at: string;
}

const norm = (s?: string | null) => (s || '').replace(/\s+/g, '').toLowerCase();

/** 会话去重键：平台 + HR + 公司 + 岗位，四者相同视为同一段对话 */
export function convKey(
  platform: string,
  hrName?: string | null,
  company?: string | null,
  position?: string | null,
): string {
  return [norm(platform), norm(hrName), norm(company), norm(position)].join('|');
}

export function getConversation(key: string): HrConversationRow | null {
  return (db.prepare('SELECT * FROM hr_conversations WHERE conv_key = ?').get(key) as HrConversationRow) || null;
}

export function upsertConversation(c: {
  conv_key: string;
  platform: string;
  hr_name?: string | null;
  company?: string | null;
  position?: string | null;
  job_url?: string | null;
  stage?: string | null;
  last_hr_message?: string | null;
  last_reply?: string | null;
  last_hr_message_at?: string | null;
  last_replied_at?: string | null;
  round?: number | null;
  ai_name?: string | null;
  ai_source?: string | null;
}): HrConversationRow {
  // 已存在：只覆盖「显式传入」的字段。
  // 不用 ON CONFLICT DO UPDATE + COALESCE —— round 是 NOT NULL 列，
  // 传入 null 会直接违反约束，而传入 0 又会把已有轮次清掉。
  if (getConversation(c.conv_key)) {
    const patch: Record<string, unknown> = {};
    if (c.hr_name != null) patch.hr_name = c.hr_name;
    if (c.company != null) patch.company = c.company;
    if (c.position != null) patch.position = c.position;
    if (c.job_url != null) patch.job_url = c.job_url;
    if (c.stage != null) patch.stage = c.stage;
    if (c.last_hr_message != null) patch.last_hr_message = c.last_hr_message;
    if (c.last_reply != null) patch.last_reply = c.last_reply;
    if (c.last_hr_message_at != null) patch.last_hr_message_at = c.last_hr_message_at;
    if (c.last_replied_at != null) patch.last_replied_at = c.last_replied_at;
    if (c.round != null) patch.round = c.round;
    if (c.ai_name != null) patch.ai_name = c.ai_name;
    if (c.ai_source != null) patch.ai_source = c.ai_source;
    updateConversation(c.conv_key, patch as any);
    return getConversation(c.conv_key)!;
  }

  // 新会话：round 至少为 1（NOT NULL 列不可插 null）
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO hr_conversations
      (id, conv_key, platform, hr_name, company, position, job_url, stage,
       last_hr_message, last_reply, last_hr_message_at, last_replied_at, round, ai_name, ai_source, created_at, updated_at)
    VALUES
      (@id, @conv_key, @platform, @hr_name, @company, @position, @job_url, @stage,
       @last_hr_message, @last_reply, @last_hr_message_at, @last_replied_at, @round, @ai_name, @ai_source, @now, @now)
  `).run({
    id: randomUUID(),
    conv_key: c.conv_key,
    platform: c.platform,
    hr_name: c.hr_name ?? null,
    company: c.company ?? null,
    position: c.position ?? null,
    job_url: c.job_url ?? null,
    stage: c.stage ?? 'new',
    last_hr_message: c.last_hr_message ?? null,
    last_reply: c.last_reply ?? null,
    last_hr_message_at: c.last_hr_message_at ?? null,
    last_replied_at: c.last_replied_at ?? null,
    round: c.round ?? 1,
    ai_name: c.ai_name ?? null,
    ai_source: c.ai_source ?? null,
    now,
  });
  return getConversation(c.conv_key)!;
}

export function updateConversation(
  key: string,
  patch: Partial<Pick<HrConversationRow,
    'stage' | 'last_hr_message' | 'last_reply' | 'last_hr_message_at' | 'last_replied_at' | 'round'
    | 'hr_name' | 'company' | 'position' | 'job_url' | 'ai_name' | 'ai_source'>>,
): boolean {
  const allowed = ['stage', 'last_hr_message', 'last_reply', 'last_hr_message_at', 'last_replied_at', 'round',
    'hr_name', 'company', 'position', 'job_url', 'ai_name', 'ai_source'];
  const fields: string[] = [];
  const values: any[] = [];
  for (const k of allowed) {
    const v = (patch as any)[k];
    if (v !== undefined) { fields.push(`${k} = ?`); values.push(v); }
  }
  if (fields.length === 0) return false;
  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(key);
  return db.prepare(`UPDATE hr_conversations SET ${fields.join(', ')} WHERE conv_key = ?`).run(...values).changes > 0;
}

export function listConversations(opts: { platform?: string; stage?: string } = {}): HrConversationRow[] {
  const where: string[] = [];
  const args: any[] = [];
  if (opts.platform) { where.push('platform = ?'); args.push(opts.platform); }
  if (opts.stage) { where.push('stage = ?'); args.push(opts.stage); }
  const sql = `SELECT * FROM hr_conversations${
    where.length ? ` WHERE ${where.join(' AND ')}` : ''
  } ORDER BY updated_at DESC`;
  return db.prepare(sql).all(...args) as HrConversationRow[];
}

export default db;
