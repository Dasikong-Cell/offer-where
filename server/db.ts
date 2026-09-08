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
    status TEXT NOT NULL DEFAULT 'candidate',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs(source);
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

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
}): JobRow {
  const now = new Date().toISOString();
  const existing = job.company && job.position
    ? db.prepare('SELECT * FROM jobs WHERE source = ? AND company = ? AND position = ?')
        .get(job.source || 'manual', job.company, job.position) as JobRow | undefined
    : job.apply_url
      ? db.prepare('SELECT * FROM jobs WHERE source = ? AND apply_url = ?')
          .get(job.source || 'manual', job.apply_url) as JobRow | undefined
      : undefined;
  const id = existing?.id || job.id || randomUUID();
  db.prepare(`
    INSERT INTO jobs (id, source, company, position, city, jd, requirements, salary, apply_url, deadline, status, created_at, updated_at)
    VALUES (@id, @source, @company, @position, @city, @jd, @requirements, @salary, @apply_url, @deadline, 'candidate', @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      company = excluded.company,
      position = excluded.position,
      city = excluded.city,
      jd = excluded.jd,
      requirements = excluded.requirements,
      salary = excluded.salary,
      apply_url = excluded.apply_url,
      deadline = excluded.deadline,
      updated_at = excluded.updated_at
  `).run({
    id,
    source: job.source || 'manual',
    company: job.company ?? null,
    position: job.position ?? null,
    city: job.city ?? null,
    jd: job.jd ?? null,
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
  'company' | 'position' | 'city' | 'jd' | 'requirements' | 'salary' | 'apply_url' | 'deadline' | 'match_score' | 'match_detail' | 'status'
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
    updateConversation(c.conv_key, patch as any);
    return getConversation(c.conv_key)!;
  }

  // 新会话：round 至少为 1（NOT NULL 列不可插 null）
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO hr_conversations
      (id, conv_key, platform, hr_name, company, position, job_url, stage,
       last_hr_message, last_reply, last_hr_message_at, last_replied_at, round, created_at, updated_at)
    VALUES
      (@id, @conv_key, @platform, @hr_name, @company, @position, @job_url, @stage,
       @last_hr_message, @last_reply, @last_hr_message_at, @last_replied_at, @round, @now, @now)
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
    now,
  });
  return getConversation(c.conv_key)!;
}

export function updateConversation(
  key: string,
  patch: Partial<Pick<HrConversationRow,
    'stage' | 'last_hr_message' | 'last_reply' | 'last_hr_message_at' | 'last_replied_at' | 'round'
    | 'hr_name' | 'company' | 'position' | 'job_url'>>,
): boolean {
  const allowed = ['stage', 'last_hr_message', 'last_reply', 'last_hr_message_at', 'last_replied_at', 'round',
    'hr_name', 'company', 'position', 'job_url'];
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
