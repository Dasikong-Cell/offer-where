import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
// 发布时间入库前的收敛（把「今天」「更新9月2日」等文案统一成 YYYY-MM-DD）。
// 该模块零依赖、零 IO，不会给 db.ts 的加载引入副作用。
import { normalizePostedDate, parsePostedAt, postedAtFromLabeled } from './services/parsePostedAt.js';
// 流程时间节点（笔试/面试/Offer/结束）的入库前规整。同样零依赖、零 IO。
// ⚠️ 规整必须发生在**入库这一层**：写入口不止一个（PATCH 路由 / 批量投递 / 脚本），
//    放在路由里做，脚本路径就会漏 —— 于是库里混进 `2026-13-45` 这种串，谁都没报错。
import { normalizeFlowTime, normalizeRound } from './services/reviewPlan.js';
// 校招卡片元数据（届别 / 快捷标签 / 投递截止日）的解析与收敛。
// 与「采集器各自解析」相比，放在这里的好处是：**入库这一层只有一个口径** ——
// 采集器、回填脚本、PATCH 路由、批量投递全都过同一份规则，不会各自漂移。
import { parseCardMeta, parseGradYear, normalizeGradYear, serializeTags } from './services/parseCardMeta.js';

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

// 通用写操作助手：INSERT / UPDATE / DELETE 等**不返回结果集**的语句。
// 注意 query() 用的是 .all()，对 DELETE 会抛 "This statement does not return data"，
// 写操作必须走这里（否则像测试清理那样静默失败）。
export function exec(sql: string, params: any[] = []): void {
  db.prepare(sql).run(...params);
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
  -- 「是否已投递过」判定（greetDecision.alreadyApplied）：按 平台+职位 查、公司参与比对。
  -- 此前只有 platform / created_at 索引 → 每个岗位一次全表扫描；投递量上来后明显拖慢。
  CREATE INDEX IF NOT EXISTS idx_applications_platform_position ON applications(platform, position);
  CREATE INDEX IF NOT EXISTS idx_applications_company ON applications(company);

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
    -- 岗位类型（产品岗/技术岗/运营岗…）。可空：手动录入是选填、采集端能识别才写。
    -- 与 source（平台来源）是两个维度：source 回答「从哪来」，job_type 回答「是什么岗」。
    job_type TEXT,
    match_score REAL,
    match_detail TEXT,
    -- 「最近一次 AI 匹配的时间」(ISO 串)。
    -- ⚠️ 为什么不能用 updated_at 兜底：updated_at 会随**任何**字段改动而前进，
    --    用它当匹配时间，用户改一次 deadline 后「匹配于 X 日」就变成假日期。
    --    老数据此列为 NULL ⇒ 历史列表按 updated_at 排、并标注「时间未知」。
    matched_at TEXT,
    quarantine TEXT,
    skip_reason TEXT,
    -- 列表页卡片摘要（如 offerbiu 的「更新9月2日 / 2027届 / 投递入口」）。
    -- ⚠️ 它不是岗位描述：曾整批塞进 jd，导致「JD 覆盖率 89%」虚高、
    -- 匹配分与求职信/定制简历/面试攻略全部失效。单独存此列保留信息，jd 只放真岗位描述。
    card_text TEXT,
    -- 微信推文等「JD 是图片长图」的岗位：把抓取到的长图路径(相对 data/ 的 URL)与来源图 URL 存这里。
    -- jd 列保持空（无文本），jd_source='image' 标记「真实 JD 以图片形式存在，可查看但不可文本匹配」。
    jd_images TEXT,
    -- 'text' = jd 列有真岗位描述；'image' = JD 为长图(见 jd_images)；'none'/NULL = 无 JD。
    jd_source TEXT,
    -- 🔴 「岗位发布时间」(YYYY-MM-DD，**平台口径**)，与 created_at「我们入库的时间」是两回事。
    --    此前只有 created_at，于是「查当天新开的岗位」只能退化成「查当天采集到的岗位」：
    --    一条 9 月 1 日发布、10 月 2 日才被我们采集到的岗位，会被当成「新增」推给用户，
    --    而它其实已挂了 31 天，简历多半石沉大海。
    --    NULL = 该平台没给发布时间（老数据、或解析不出来），此时筛选端退回 created_at 兜底。
    posted_at TEXT,
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

// 数据库迁移：jobs 增加 remote 列（远程岗位标记，对标 Resumly「远程岗位筛选」）
try {
  const jrc = db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
  if (!jrc.some((c) => c.name === 'remote')) {
    db.exec("ALTER TABLE jobs ADD COLUMN remote INTEGER");
    console.log("[DB] Added remote column to jobs");
  }
} catch (e) {
  // 忽略错误（列可能已存在）
}

// 数据库迁移：jobs 增加 job_type 列（岗位类型）
//   与 source（平台来源）是两个维度：source 回答「从哪来」，job_type 回答「是什么岗」。
//   CREATE TABLE IF NOT EXISTS 对**已存在**的表完全不起作用 ⇒ 必须显式 ALTER 一次。
try {
  const jtc = db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
  if (!jtc.some((c) => c.name === 'job_type')) {
    db.exec("ALTER TABLE jobs ADD COLUMN job_type TEXT");
    console.log("[DB] Added job_type column to jobs");
  }
} catch (e) {
  // 忽略错误（列可能已存在）
}

// 数据库迁移：applications 增加 strategy / evidence_path
//   · strategy     —— 投递策略标签（对标 LoopCV A/B 测试：如 letter|tailored / no_letter|original）
//   · evidence_path —— 投递瞬间平台页截图路径（对标 CareerBoom 操作录屏回溯，可审计/降封号风险）
try {
  const ac = db.prepare("PRAGMA table_info(applications)").all() as Array<{ name: string }>;
  if (!ac.some((c) => c.name === 'strategy')) {
    db.exec("ALTER TABLE applications ADD COLUMN strategy TEXT");
    console.log("[DB] Added strategy column to applications");
  }
  if (!ac.some((c) => c.name === 'evidence_path')) {
    db.exec("ALTER TABLE applications ADD COLUMN evidence_path TEXT");
    console.log("[DB] Added evidence_path column to applications");
  }
  if (!ac.some((c) => c.name === 'video_path')) {
    db.exec("ALTER TABLE applications ADD COLUMN video_path TEXT");
    console.log("[DB] Added video_path column to applications");
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

// 数据库迁移：jobs 增加 jd_images / jd_source 列（微信推文 JD 长图抓取，阶段 1 抓图方案）
try {
  const jc4 = db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
  if (!jc4.some((c) => c.name === 'jd_images')) {
    db.exec("ALTER TABLE jobs ADD COLUMN jd_images TEXT");
    console.log("[DB] Added jd_images column to jobs");
  }
  if (!jc4.some((c) => c.name === 'jd_source')) {
    db.exec("ALTER TABLE jobs ADD COLUMN jd_source TEXT");
    console.log("[DB] Added jd_source column to jobs");
  }
  if (!jc4.some((c) => c.name === 'ocr_status')) {
    db.exec("ALTER TABLE jobs ADD COLUMN ocr_status TEXT");
    console.log("[DB] Added ocr_status column to jobs");
  }
} catch (e) {
  // 忽略错误（列可能已存在）
}

// 数据库迁移：jobs 增加 posted_at 列（平台口径的岗位发布时间，YYYY-MM-DD）
//   目的：让「只看今天新开的岗位」能按**平台发布时间**筛，而不是退化成「我们入库的时间」。
//   老数据此列为 NULL ⇒ 筛选端会退回 created_at 兜底，不会因为缺列而漏掉整批岗位。
try {
  const jc5 = db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
  if (!jc5.some((c) => c.name === 'posted_at')) {
    db.exec("ALTER TABLE jobs ADD COLUMN posted_at TEXT");
    console.log("[DB] Added posted_at column to jobs");
  }
} catch (e) {
  // 忽略错误（列可能已存在）
}

// 数据库迁移：jobs 增加 grad_year / tags 列（校招卡片的结构化元数据）
//   · grad_year —— 届别，规范化成 4 位年份字符串（'2027'）。NULL = 卡片没写 / 认不出来。
//   · tags      —— 标签（JSON 数组串，如 '["免笔试","秋招"]'）。NULL = 无标签。
//   🔴 为什么必须落成列，而不是前端每次现解析 card_text：
//      ① 与 posted_at / remote 同一套路（入库时解析 + 存量回填），口径只有一个；
//      ② /api/jobs 返回的是**原始行**，扁平列直接可筛；标签集合还能被批量投递条件复用；
//      ③ 卡片文本来自 9 个采集器，格式漂移时**落库值是可审计的**；而「前端现解析」
//         一旦解析器与新格式错位，只会静默产出 0 个标签 —— 页面看着正常、筛不出东西。
//   ⚠️ CREATE TABLE IF NOT EXISTS 对**已存在**的表完全不起作用 ⇒ 必须显式 ALTER。
//   老数据这两列为 NULL ⇒ 前端按「无届别 / 无标签」显示，跑一次
//   scripts/backfill_card_meta.ts 即可补齐（该脚本与 upsertJob 共用 parseCardMeta）。
try {
  const jc6 = db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
  const addJobCol = (name: string) => {
    if (jc6.some((c) => c.name === name)) return;
    db.exec(`ALTER TABLE jobs ADD COLUMN ${name} TEXT`);
    console.log(`[DB] Added ${name} column to jobs`);
  };
  addJobCol('grad_year');
  addJobCol('tags');
  addJobCol('matched_at');
} catch (e) {
  // 忽略错误（列可能已存在）
}

// 数据库迁移：applications 增加「流程时间节点」五列
//   对标 offerbiu「我的投递」卡片上的节点行（截止 / 投递 / 笔试时间 / 面试时间 / Offer / 结束）。
//   🔴 这五列是「投递复盘」的地基：没有它们，复盘页只能数「有多少条记录」，
//      算不出「几天没进展」「本周有几场笔面」「进度卡在哪一步」。
//   · written_at       —— 笔试时间（YYYY-MM-DD 或带时刻的 ISO 串，原样存，不在这里做换算）
//   · interview_at     —— 面试时间（同上）
//   · interview_round  —— 面试轮次（一面/二面/HR面/终面…）
//                        刻意用「字段」而不是「加四个阶段列」：轮次是新出现就会被改写的
//                        自由文本，拆成列会让看板多出四列永远为空的假控件（历史教训）。
//   · offer_at         —— Offer 时间
//   · closed_at        —— 结束时间（未通过 / 已跳过 等流程终止的时刻）
//   ⚠️ 与 created_at 的区别：created_at 是「我们记下这条记录」的时间，
//      written_at 等是「招聘流程上那件事发生」的时间，两者可以差几十天，不可互相兜底。
//   ⚠️ CREATE TABLE IF NOT EXISTS 对**已存在**的表完全不起作用 ⇒ 必须显式 ALTER。
//   老数据此五列为 NULL ⇒ 前端按阶段显示「时间未定」而不是显示一个假日期。
try {
  const ac2 = db.prepare("PRAGMA table_info(applications)").all() as Array<{ name: string }>;
  const addAppCol = (name: string) => {
    if (ac2.some((c) => c.name === name)) return;
    db.exec(`ALTER TABLE applications ADD COLUMN ${name} TEXT`);
    console.log(`[DB] Added ${name} column to applications`);
  };
  addAppCol('written_at');
  addAppCol('interview_at');
  addAppCol('interview_round');
  addAppCol('offer_at');
  addAppCol('closed_at');
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
  /** 投递策略标签（A/B 测试用）：如 `letter|tailored` / `no_letter|original` */
  strategy?: string | null;
  /** 投递瞬间平台页截图路径（操作录屏回溯用），如 `/data/screenshots/<id>.png` */
  evidence_path?: string | null;
  /** 操作录屏回看入口（真·CDP screencast）：mp4 / play.html / 帧目录，如 `/data/evidence/vid-boss-...` */
  video_path?: string | null;
  /**
   * ── 招聘流程的时间节点（对标 offerbiu「我的投递」卡片上的节点行）──
   * 🔴 与 created_at 是两件事：created_at 是「我们记下这条记录」的时刻，
   *    下面这些是「流程上那件事发生」的时间（用户手填），两者可以差几十天，不可互相兜底。
   * 🔴 格式：`YYYY-MM-DD`（只到日）或 `YYYY-MM-DD HH:mm`（带时刻）。
   *    秒/毫秒/时区一律在入库前裁掉 —— 见 reviewPlan.normalizeFlowTime。
   * 🔴 非法值在入库时已经被规整成 NULL ⇒ 读出来要么是合法串、要么是 null，不会有中间态。
   */
  written_at?: string | null;
  interview_at?: string | null;
  /** 面试轮次（一面/二面/HR 面/终面…）。刻意用**字段**而不是加四个阶段列。 */
  interview_round?: string | null;
  offer_at?: string | null;
  /** 流程终止时刻（未通过 / 已跳过）。 */
  closed_at?: string | null;
  created_at: string;
  updated_at: string;
}

/** 投递台账的筛选条件（与 GET /api/applications 的查询参数同名）。 */
export interface ApplicationFilter {
  platform?: string | null;
  status?: string | null;
}

/**
 * 把筛选条件编成 WHERE 片段与参数。
 * 🔴 总数、分组统计、分页取数**必须共用这一份**。三处各写一遍筛选条件，迟早变成
 *    「列表按 A 筛、总数按 B 数」——而界面上显示的两个数字看起来都像对的。
 */
function applicationWhere(f: ApplicationFilter = {}): { sql: string; params: string[] } {
  const conds: string[] = [];
  const params: string[] = [];
  if (f.platform) { conds.push('platform = ?'); params.push(String(f.platform)); }
  if (f.status) { conds.push('status = ?'); params.push(String(f.status)); }
  return { sql: conds.length ? ' WHERE ' + conds.join(' AND ') : '', params };
}

/**
 * 投递台账**总数**——与分页无关，任何时候都返回「库里符合条件的条数」。
 * 存在的理由：`GET /api/applications` 原来把 `total` 写成 `list.length`，
 * 那是「截断后再筛选」的长度，恒 ≤ 500。界面拿它当「共多少条」显示，于是
 * 库里有 1087 条时页面说「500 条」，而且**没有任何东西会报错**。
 */
export function countApplications(f: ApplicationFilter = {}): number {
  const w = applicationWhere(f);
  return (query<{ c: number }>(`SELECT COUNT(*) c FROM applications${w.sql}`, w.params)[0] || { c: 0 }).c;
}

/**
 * 按阶段聚合条数（SQL GROUP BY，不把行捞到应用层再 `.length`）。
 * 控制台四张统计卡、仪表盘三张卡、复盘阶段分布共用这一个来源 —— 它们原先各自
 * 在浏览器里对**被截断的**数组现数一遍，所以数字本身就是错的。
 */
export function applicationStatusCounts(f: ApplicationFilter = {}): Record<string, number> {
  const w = applicationWhere(f);
  const rows = query<{ status: string | null; c: number }>(
    `SELECT status, COUNT(*) c FROM applications${w.sql} GROUP BY status`, w.params);
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status || 'unknown'] = r.c;
  return out;
}

/**
 * 投递台账分页取数。
 * @param limit  正数 = 本页最多几条；**<= 0 = 不分页（全量）**，给导出与需要全集的纯函数用。
 * @param offset 跳过前几条（仅在 limit > 0 时生效）。
 * 🔴 排序必须带 id 兜底：`created_at` 是毫秒时刻，同毫秒的两条在 LIMIT/OFFSET 下顺序
 *    由引擎自由决定，翻页时会**漏掉或重复**记录 —— 而且每一页单独看都「没问题」。
 */
export function listApplications(limit = 500, offset = 0, f: ApplicationFilter = {}): ApplicationRow[] {
  const w = applicationWhere(f);
  const order = ' ORDER BY created_at DESC, id DESC';
  if (limit > 0) {
    return query<ApplicationRow>(
      `SELECT * FROM applications${w.sql}${order} LIMIT ? OFFSET ?`,
      [...w.params, limit, Math.max(0, Math.floor(offset) || 0)]);
  }
  return query<ApplicationRow>(`SELECT * FROM applications${w.sql}${order}`, w.params);
}

/**
 * 带证据（投递瞬间截图 / 操作录屏）的投递，按时间倒序返回**全部**。
 * 🔴 原来是 `listApplications(1000).filter(a => a.evidence_path || a.video_path)`：
 *    先在**最新的** 1000 条里截断、再筛有没有证据。「录屏回溯」面板于是会开始丢掉更早
 *    的证据记录 —— 而丢掉的恰好是「投完已有一段时间」的那批，也就是最可能真被回看的。
 *    筛选必须在 SQL 里、在截断之前发生。
 */
export function listEvidenceApplications(): ApplicationRow[] {
  return query<ApplicationRow>(
    "SELECT * FROM applications WHERE (evidence_path IS NOT NULL AND TRIM(evidence_path) <> '') "
    + "OR (video_path IS NOT NULL AND TRIM(video_path) <> '') "
    + "ORDER BY created_at DESC, id DESC");
}

export function createApplication(app: Omit<ApplicationRow, 'created_at' | 'updated_at'>): ApplicationRow {
  const now = new Date().toISOString();
  const strategy = app.strategy ?? null;
  const evidence_path = app.evidence_path ?? null;
  // 五个流程时间节点同样要显式列出并兜 `?? null`：
  // 具名参数缺失时 better-sqlite3 会直接抛 `Missing named parameter`，
  // 而 `undefined` 传进去也是同样的错 —— 不能靠「不传就当没有」。
  const written_at = normalizeFlowTime(app.written_at);
  const interview_at = normalizeFlowTime(app.interview_at);
  const interview_round = normalizeRound(app.interview_round);
  const offer_at = normalizeFlowTime(app.offer_at);
  const closed_at = normalizeFlowTime(app.closed_at);
  const row = {
    ...app, strategy, evidence_path,
    written_at, interview_at, interview_round, offer_at, closed_at,
    created_at: now, updated_at: now,
  };
  db.prepare(`
    INSERT INTO applications (id, platform, company, position, salary, city, job_url, status, login_method, message, strategy, evidence_path,
      written_at, interview_at, interview_round, offer_at, closed_at, created_at, updated_at)
    VALUES (@id, @platform, @company, @position, @salary, @city, @job_url, @status, @login_method, @message, @strategy, @evidence_path,
      @written_at, @interview_at, @interview_round, @offer_at, @closed_at, @created_at, @updated_at)
  `).run(row);
  return row;
}

/**
 * 动态 UPDATE 的列名**运行时白名单**。
 * ==========================================================================
 * 🔴 2026-09-30 修复（P0：列名注入）
 *
 * 原先这几个 `updateXxx` 都写成：
 *     for (const key of Object.keys(updates)) fields.push(`${key} = ?`);
 *     db.prepare(`UPDATE jobs SET ${fields.join(', ')} WHERE id = ?`)
 * —— **列名位置直接取自对象的键**。而 `PATCH /api/jobs/:id` 又把 `req.body`
 * 整包转发进来（server/index.ts），于是键名可以被注入。
 *
 * 实测（隔离库，`_tools/_inject_probe.mjs`）：
 *   body = { "company = 'X', position = ?, city = ?, salary = ? --": "P" }
 *   拼出 UPDATE jobs SET company = 'X', position = ?, city = ?, salary = ? -- = ?, updated_at = ? WHERE id = ?
 *   `--` 把 `WHERE id = ?` 整段注释掉 ⇒ **全表被改写**，且接口静默返回 200。
 *
 * ⚠️ TypeScript 的 `Partial<Pick<JobRow, ...>>` **只是编译期约束**：`req.body` 是 any，
 *    运行时没有任何键名校验。凡是「列名来自对象键」的动态 SQL，运行时都必须过白名单。
 *
 * 修法：**按白名单顺序遍历**，而不是按对象键顺序 ——
 *   ① 键名只可能来自这里的常量，注入面被结构性消除（不是靠过滤黑名单）；
 *   ② 顺带消掉「SQL 文本随 body 键序变化」带来的 prepared-statement 缓存抖动。
 */
const JOB_UPDATABLE_COLUMNS = [
  'company', 'position', 'city', 'jd', 'requirements', 'salary', 'apply_url', 'deadline', 'job_type',
  'match_score', 'match_detail', 'quarantine', 'skip_reason', 'card_text', 'jd_images',
  'jd_source', 'ocr_status', 'posted_at', 'remote', 'status', 'grad_year', 'tags', 'matched_at',
] as const;

const APPLICATION_UPDATABLE_COLUMNS = [
  'platform', 'company', 'position', 'salary', 'city', 'job_url', 'status',
  'login_method', 'message', 'strategy', 'evidence_path', 'video_path',
  'written_at', 'interview_at', 'interview_round', 'offer_at', 'closed_at',
] as const;

/** 需要按 `YYYY-MM-DD[ HH:mm]` 规整的流程时间列（白名单里除 interview_round 之外的四个）。 */
const APPLICATION_FLOW_TIME_COLUMNS: readonly string[] = [
  'written_at', 'interview_at', 'offer_at', 'closed_at',
];

/**
 * applications 动态更新的取值规整。
 * 🔴 必须有这一层：前端「清空输入框」提交的是 `''`，直接写库就变成一个空串，
 *    复盘那边 `'' ` 与 `null` 要各判一次（漏判一处就多出一批「有值但没时间」的记录）。
 *    统一成 `null` 后，全项目只需认一种「没填」。
 */
function normalizeApplicationField(key: string, value: any): any {
  if (APPLICATION_FLOW_TIME_COLUMNS.indexOf(key) >= 0) return normalizeFlowTime(value);
  if (key === 'interview_round') return normalizeRound(value);
  return value;
}

/** 供路由层复用同一份清单（校验/回显），避免两处各抄一遍后走样 */
export const JOB_UPDATABLE = JOB_UPDATABLE_COLUMNS;

/**
 * 从 `updates` 里按 `allowed` 白名单取出待更新列。
 * 键名只来自 `allowed`（常量），**绝不来自调用方传入的对象键**。
 */
function collectUpdateFields(
  updates: Record<string, any>,
  allowed: readonly string[],
  transform: (key: string, value: any) => any = (_k, v) => v,
): { fields: string[]; values: any[] } {
  const fields: string[] = [];
  const values: any[] = [];
  for (const key of allowed) {
    const raw = updates?.[key];
    if (raw === undefined) continue;
    fields.push(`${key} = ?`);
    values.push(transform(key, raw));
  }
  return { fields, values };
}

export function updateApplication(id: string, updates: Partial<Pick<ApplicationRow,
  'platform' | 'company' | 'position' | 'salary' | 'city' | 'job_url' | 'status' | 'login_method' | 'message' | 'strategy' | 'evidence_path' | 'video_path'
  | 'written_at' | 'interview_at' | 'interview_round' | 'offer_at' | 'closed_at'
>>): boolean {
  const { fields, values } = collectUpdateFields(
    updates as Record<string, any>, APPLICATION_UPDATABLE_COLUMNS, normalizeApplicationField,
  );
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
  /** 岗位类型（产品岗 / 技术岗 / 运营岗…）。NULL = 未填/未识别，筛选端按「未分类」显示 */
  job_type: string | null;
  /**
   * 届别（4 位年份字符串 `'2027'`，**不是自由文本**）。NULL = 卡片没写或认不出来。
   * ⚠️ 必须是规范化后的单一形态：前端拿它当筛选下拉的候选值，库里一旦混进 `'2027届'`，
   *    下拉就会出现两个看着一样的选项、各筛出一部分，而用户完全无从察觉。
   */
  grad_year: string | null;
  /**
   * 校招卡片标签（JSON 数组串，如 `'["免笔试","秋招"]'`）。NULL = 无标签。
   * 值取自 `parseCardMeta.ts` 的 `CARD_TAG_DEFS` 白名单 —— 库里不可能出现表外的标签。
   */
  tags: string | null;
  match_score: number | null;
  match_detail: string | null;
  /** 最近一次 AI 匹配的时间(ISO串)；NULL=老数据（打分早于此列存在） */
  matched_at: string | null;
  /** 跨公司串号隔离原因（非空表示默认跳过投递，需 force 放行） */
  quarantine: string | null;
  /** 跳过投递的原因（AI/规则给出，用于漏斗分析规则误杀；非空表示此岗位被主动跳过） */
  skip_reason: string | null;
  /** 列表页卡片摘要（非岗位描述）。与 jd 分离，避免它被当成 JD 参与匹配/AI 文案 */
  card_text: string | null;
  /** JD 长图路径数组(JSON)：[{local, url, w, h}]。jd_source='image' 时有效 */
  jd_images: string | null;
  /** 'text'=jd 有真描述；'image'=JD 为长图(见 jd_images)；'none'/NULL=无 JD */
  jd_source: string | null;
  /** 图片JD的OCR回填状态：NULL/pending=待识别；done=已识别写回jd；failed=识别失败(模型非视觉/无内容)，可 --retry-failed 重跑 */
  ocr_status: string | null;
  /**
   * 岗位发布时间（`YYYY-MM-DD`，**平台口径**）。与 `created_at`（我们入库的时间）是两回事：
   * 前者回答「这个岗位挂了多久」，后者只回答「我们什么时候发现的」。
   * NULL = 平台没给、或文案解析不出来 ⇒ 筛选端退回 created_at 兜底。
   */
  posted_at: string | null;
  /** 远程岗位标记：1=远程/居家办公，0=非远程（驻场/坐班），NULL=未识别。采集时按文本自动推断，可被显式覆盖 */
  remote: number | null;
  status: string;
  created_at: string;
  updated_at: string;
}

/** 岗位池列表的取数选项（内部脚本与路由共用）。 */
export interface JobListOpts {
  source?: string;
  status?: string;
  /**
   * 正数 = 本页最多几条；**<= 0 = 不分页（全量）**。
   * 🔴 默认值从 `1000` 改成 **0（全量）**，这是本次缺陷的根因所在：
   *    原来是 `params.push(opts.limit || 1000)` —— 一个**与库大小无关的硬上限**。
   *    所有「先取一批、再在应用层筛」的调用点（批量投递、自动回复、JD 回填、
   *    以及控制台的校招信息库）都在**静默地**只看到前 1000 条，谁都不报错。
   */
  limit?: number;
  offset?: number;
  /** `'new'` = 最新入库优先（默认）；`'match'` = 匹配分优先（旧行为）。 */
  sort?: JobSort;
}

/** 岗位池排序口径。 */
export type JobSort = 'new' | 'match';

/**
 * 两个排序口径的 ORDER BY。
 * 🔴 **都必须带 `id DESC` 兜底**：`created_at` 是毫秒时刻，同毫秒入库的一批岗位
 *    （采集器批量写库时非常常见 —— 实测一次能有一屏同毫秒的行）在 LIMIT/OFFSET 下
 *    顺序由引擎自由决定，翻页时会**漏掉或重复**记录，而每一页单独看都「没问题」。
 */
export function jobOrderBy(sort: JobSort = 'new'): string {
  return sort === 'match'
    ? ' ORDER BY (match_score IS NULL), match_score DESC, created_at DESC, id DESC'
    : ' ORDER BY created_at DESC, id DESC';
}

/** 岗位池 WHERE 片段与参数（列表 / 计数 / 深搜**必须共用这一份**）。 */
function jobWhere(opts: { source?: string; status?: string } = {}): { sql: string; params: string[] } {
  const conds: string[] = [];
  const params: string[] = [];
  if (opts.source) { conds.push('source = ?'); params.push(String(opts.source)); }
  if (opts.status) { conds.push('status = ?'); params.push(String(opts.status)); }
  return { sql: conds.length ? ' WHERE ' + conds.join(' AND ') : '', params };
}

/**
 * 岗位池**总数**——与分页/截断无关，任何时候都返回「库里符合条件的条数」。
 * 存在的理由：`GET /api/jobs` 原来把 `total` 写成 `list.length`，那是**被 LIMIT 1000
 * 截断后**的长度 ⇒ 恒 ≤ 1000。控制台拿它当「库内共多少」显示，于是库里 2945 条时
 * 页面说「1000 个岗位」，而且没有任何地方会报错（数字看着完全合理）。
 */
export function countJobs(opts: { source?: string; status?: string } = {}): number {
  const w = jobWhere(opts);
  return (query<{ c: number }>(`SELECT COUNT(*) c FROM jobs${w.sql}`, w.params)[0] || { c: 0 }).c;
}

/**
 * 岗位池取数（**全字段**，含 `jd` 正文）。给内部脚本与服务端逻辑用。
 * ⚠️ 不要拿它直接喂接口 —— 全量全字段响应体约 5.9 MiB，列表请走 `listJobsLean()`。
 */
export function listJobs(opts: JobListOpts = {}): JobRow[] {
  const w = jobWhere(opts);
  const order = jobOrderBy(opts.sort);
  if (opts.limit && opts.limit > 0) {
    return query<JobRow>(
      `SELECT * FROM jobs${w.sql}${order} LIMIT ? OFFSET ?`,
      [...w.params, opts.limit, Math.max(0, Math.floor(opts.offset || 0))]);
  }
  return query<JobRow>(`SELECT * FROM jobs${w.sql}${order}`, w.params);
}

/**
 * 列表页返回的岗位行。
 *
 * 🔴 **刻意不含 `jd` / `requirements` / `match_detail`**（用 Omit 而不是把字段填 null：
 *    填 null 会让调用方以为「这个岗位没有 JD」，而 Omit 让「想在列表里用 jd」
 *    在**编译期**就报错 —— 要正文请走 `GET /api/jobs/:id`）。
 *    实测这三个字段占响应体的 **79%**（`jd` 一项 60.9% + `match_detail` 17.9%），
 *    而列表页一个字都不用它们：它是把「响应体大小」从 5.9 MiB 压到 1.7 MiB 的全部秘密。
 *    `has_jd` 顶上「有没有真 JD」这个**列表页真正要用的信息**（职位记录的「真JD」徽章）。
 */
export type JobListRow = Omit<JobRow, 'jd' | 'requirements' | 'match_detail'> & {
  /** 1 = 有非空 `jd` 正文（等价于原来的 `j.jd && j.jd.trim()`，不把正文搬过网） */
  has_jd: number;
};

/** 列表接口的列清单（显式列举，不是 `SELECT *` 再删）。
 *  🔴 必须显式：`SELECT *` 会把 `jd` 从盘里读出来再在 JS 里删掉 —— 白读 6 MiB。 */
const JOB_LIST_COLUMNS = [
  'id', 'source', 'company', 'position', 'city', 'salary', 'apply_url', 'deadline',
  'job_type', 'grad_year', 'tags', 'match_score', 'matched_at', 'quarantine', 'skip_reason',
  'card_text', 'jd_images', 'jd_source', 'ocr_status', 'posted_at', 'remote', 'status',
  'created_at', 'updated_at',
].join(', ') + ", CASE WHEN jd IS NOT NULL AND TRIM(jd) <> '' THEN 1 ELSE 0 END AS has_jd";

/** 岗位池列表取数（**轻量**，给 `GET /api/jobs` 用）。 */
export function listJobsLean(opts: JobListOpts = {}): JobListRow[] {
  const w = jobWhere(opts);
  const order = jobOrderBy(opts.sort);
  if (opts.limit && opts.limit > 0) {
    return query<JobListRow>(
      `SELECT ${JOB_LIST_COLUMNS} FROM jobs${w.sql}${order} LIMIT ? OFFSET ?`,
      [...w.params, opts.limit, Math.max(0, Math.floor(opts.offset || 0))]);
  }
  return query<JobListRow>(`SELECT ${JOB_LIST_COLUMNS} FROM jobs${w.sql}${order}`, w.params);
}

/**
 * 关键词深搜，**只回 id**。
 *
 * 存在的理由（两个缺陷叠在一起）：
 *  ① 列表接口不再下发 `jd` 正文 ⇒ 「搜 JD 关键词」这个页面承诺过的能力会消失；
 *  ② 原来那个搜索只在**已经被 LIMIT 1000 截断的**行上做，也就是「搜不全」。
 * 现在改成：服务端在**全库**上做 LIKE，只回命中的 id 列表（最坏也就几十 KB），
 * 前端把它当**并集**并进本地命中 —— 所以只会比「纯本地搜」多，绝不会少。
 *
 * 🔴 故意**不**搜平台名 / 岗位类型：那两维由前端本地覆盖，而前端用的是平台**中文名**
 *    映射（`jobSrcName`）。服务端再抄一份中文名表就是第二个真相源，改一边忘一边时
 *    搜索会静默少命中「平台名那一维」的岗位。并集语义下「多搜」安全、「少搜」才有害。
 */
export function searchJobIds(q: string, opts: { source?: string; status?: string } = {}): string[] {
  const kw = String(q == null ? '' : q).trim();
  if (kw.length < 2) return [];
  // LIKE 的通配符必须转义：用户搜「50%」时 `%` 会变成「任意串」，命中集凭空放大。
  const esc = kw.replace(/[\\%_]/g, (m) => '\\' + m);
  const like = '%' + esc + '%';
  const w = jobWhere(opts);
  const cols = ['company', 'position', 'city', 'jd', 'card_text'];
  const likeSql = cols.map((c) => `COALESCE(${c}, '') LIKE ? ESCAPE '\\'`).join(' OR ');
  const sql = `SELECT id FROM jobs${w.sql ? w.sql + ' AND' : ' WHERE'} (${likeSql})`
    + ' ORDER BY created_at DESC, id DESC';
  return query<{ id: string }>(sql, [...w.params, ...cols.map(() => like)]).map((r) => r.id);
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

/**
 * 远程岗位识别（对标 Resumly「远程岗位筛选」）。
 * 从岗位文本里识别「远程/居家办公/remote/telecommute/wfh」等表述，命中返回 1，否则 0。
 * 显式「非远程/需坐班/驻场/现场」优先判 0，避免把「不接受远程」误标成远程。
 */
export function detectRemote(text: unknown): number {
  const t = String(text || '').toLowerCase();
  if (!t) return 0;
  if (/(非远程|不接受远程|需坐班|必须坐班|驻场|现场办公|onsite|on-site|线?下办公)/.test(t)) return 0;
  return /(远程|居家办公|在家办公|remote|telecommute|\bwfh\b|弹性办公|异地办公|可远程)/.test(t) ? 1 : 0;
}

/**
 * 存量岗位远程标记回填：对所有 remote 为 NULL 的岗位按文本重新识别。
 * 供 /api/jobs/backfill-remote 与一次性迁移脚本复用（不直接依赖 HTTP）。
 */
export function backfillRemoteJobs(): { scanned: number; updated: number } {
  const rows = query<{ id: string; jd: string | null; card_text: string | null; position: string | null; requirements: string | null; company: string | null }>(
    'SELECT id, jd, card_text, position, requirements, company FROM jobs WHERE remote IS NULL',
  );
  let updated = 0;
  for (const r of rows) {
    const v = detectRemote([r.jd, r.card_text, r.position, r.requirements, r.company].join(' '));
    updateJob(r.id, { remote: v });
    updated++;
  }
  return { scanned: rows.length, updated };
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
  /** 岗位类型（产品岗 / 技术岗…）。不传 = 保持原值（部分更新语义） */
  job_type?: string | null;
  /** 届别。接受 4 位年份或 `'2027届'` 原文，入库前经 normalizeGradYear 收敛。不传 = 保持原值 */
  grad_year?: string | null;
  /** 标签。数组 / JSON 串 / 逗号串都接受，入库前过 CARD_TAG_KEYS 白名单。不传 = 保持原值 */
  tags?: string | null;
  /** 列表页卡片摘要（非岗位描述）。调用方若只有卡片文本，应传这里而**不要**传 jd */
  card_text?: string | null;
  /** JD 长图路径数组(JSON)。jd_source='image' 时配套写入 */
  jd_images?: string | null;
  /** 'text'|'image'|'none'：标记 JD 形态 */
  jd_source?: string | null;
  /**
   * 远程岗位标记（1/0）。显式传入则尊重；不传则由 detectRemote 在
   * jd/card_text/position/requirements/company 文本上自动推断（所有采集器零改动即得远程标记）。
   */
  remote?: number | null;
  /**
   * 岗位发布时间。接受两种形态：
   *   · 已解析好的 `YYYY-MM-DD`；
   *   · 平台原文（`'今天'` / `'更新9月2日'`）—— 入库前会经 normalizePostedDate 收敛。
   * 认不出来落 `null`（存脏值会让「仅当日新增」永远匹配不上，岗位静默消失）。
   */
  posted_at?: string | null;
  /**
   * 匹配分（AI/规则算出的界面匹配分）。**未评分时必须传 undefined/NULL，不要传 0**：
   * 老库 jobs.match_score 列默认值是 0（见 upsertJob INSERT 注释），若不显式写 NULL，
   * 新采集的岗位会落成 0，而打招呼闸门把「0 分」当成「已评 0 分」→ 全部被匹配度闸门拦下
   * （2026-09-30「边投递边找」0 投递死循环的真凶）。
   */
  match_score?: number | null;
}): JobRow {
  // 写库口统一清洗（见 sanitizeJobText 注释）
  // ⚠️ 只清洗**调用方真正传了的字段**：upsertJob 是「部分更新」语义（投递流程补 JD 时只传
  //    `{id, jd, requirements}`）。若无条件补上 company/position=''，下游就无法区分
  //    「这次没传」与「显式清空」，进而把已有数据抹掉。
  const cleaned = { ...job } as typeof job;
  if (job.company !== undefined) cleaned.company = sanitizeCompany(job.company);
  if (job.position !== undefined) cleaned.position = sanitizePosition(job.position);
  if (job.city !== undefined) cleaned.city = sanitizeJobText(job.city, 30);
  // 薪资也被加密字体污染（`10-20K` → `-K`），用专用清洗（保留合法薪资、丢弃无数字残片）
  if (job.salary !== undefined) cleaned.salary = sanitizeSalary(job.salary);
  // 发布时间：接受 `YYYY-MM-DD` 或平台原文（'今天' / '更新9月2日'），统一收敛后入库。
  // 认不出来落 null —— 存 `'面议'` 这类脏值会让筛选端 `= '2026-10-02'` 永远匹配不上，
  // 岗位会静默消失在「仅当日新增」里，且没有任何地方报错。
  // 发布时间取三种来源，优先级从高到低：
  //   ① 调用方显式传的 posted_at（最权威）；
  //   ② 卡片文本解析 —— 实测 offerbiu 的 card_text 100% 可解析（963/963），
  //      于是**所有已经写 card_text 的采集器零改动就获得了发布时间**；
  //   ③ 详情页正文里**带字段名**的日期（`更新时间2026-09-20`，真实库 80 例）。
  //      ⚠️ 只认字段名，绝不把整篇 JD 扔进全规则解析器 —— 实测那样命中 2% 且大多是
  //      「工作时间9-18」「宣讲会时间」这类噪声。
  //   ⚠️ 三者都没结果时**保持 undefined**（而不是写 null）：upsertJob 是部分更新语义，
  //      写 null 会把「投递流程补 JD」时已存好的 posted_at 抹掉。
  if (job.posted_at !== undefined) {
    cleaned.posted_at = normalizePostedDate(job.posted_at);
  } else if (job.card_text) {
    const guess = parsePostedAt(job.card_text).date;
    if (guess) cleaned.posted_at = guess;
  } else if (job.jd) {
    const guess = postedAtFromLabeled(job.jd);
    if (guess) cleaned.posted_at = guess;
  }
  // ── 卡片元数据：届别 / 标签 / 截止日 ─────────────────────────────────────
  //   与 posted_at 同一套路：**调用方显式传的优先，否则从卡片文本派生**；
  //   两者都没结果时**保持 undefined**（部分更新语义 —— 写 null 会把已存好的抹掉）。
  //   派生源按可信度排序：card_text（完整卡片）> jd（正文，只认「20xx 届」）> position。
  //   🔴 tags 刻意**只认 card_text**：正文里的「无需笔试」这类话与卡片上结构化的
  //      「免笔试」字段不是一回事，拿正文推断标签会造出一批似是而非的快捷关注项。
  //   🔴 deadline 同样只认 card_text，且判据是**结构性**的（届别 token 之后紧邻的日期），
  //      绝不把整篇 JD 丢进去找日期 —— 那正是 posted_at 已经踩过的坑（命中 2% 且多是噪声）。
  if (job.grad_year === undefined) {
    const gy = (job.card_text ? parseCardMeta(job.card_text).gradYear : null)
      ?? parseGradYear(job.jd) ?? parseGradYear(job.position);
    if (gy) cleaned.grad_year = gy;
  } else {
    cleaned.grad_year = normalizeGradYear(job.grad_year);
  }
  if (job.tags === undefined) {
    const tg = job.card_text ? serializeTags(parseCardMeta(job.card_text).tags) : null;
    if (tg) cleaned.tags = tg;
  } else {
    cleaned.tags = serializeTags(job.tags);
  }
  if (job.deadline === undefined && job.card_text) {
    const dl = parseCardMeta(job.card_text).deadline;
    if (dl) cleaned.deadline = dl;
  }
  // 远程标记：显式传入（含 0/1）则尊重；未传则按文本自动推断
  const remoteVal = job.remote !== undefined
    ? (job.remote ? 1 : 0)
    : detectRemote([job.jd, job.card_text, job.position, job.requirements, job.company].join(' '));
  job = cleaned;
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

  // 只更新调用方**显式提供**的列。
  // ⚠️ 2026-09-20 修复数据损坏：此前 DO UPDATE SET 把所有列都用 excluded 覆盖，
  //    而投递流程补 JD 时只传 `{id, jd, requirements}` → 刚投成功的岗位被顺手写成
  //    company/position/apply_url = NULL（实测 boss 12/277、job51 53/101 条被抹掉）。
  //    现在语义为「部分更新」：undefined = 保持原值；显式 null = 清空。
  const UPDATABLE = ['source', 'company', 'position', 'city', 'jd', 'requirements',
    'salary', 'apply_url', 'deadline', 'job_type', 'card_text', 'jd_images', 'jd_source', 'posted_at', 'remote',
    'grad_year', 'tags'] as const;
  const providedCols = UPDATABLE.filter((c) => (job as Record<string, unknown>)[c] !== undefined);
  // updated_at 始终更新，保证 SET 子句非空（否则只剩逗号会成为非法 SQL）
  const setSql = [...providedCols.map((c) => `${c} = excluded.${c}`), 'updated_at = excluded.updated_at'].join(',\n      ');

  db.prepare(`
    INSERT INTO jobs (id, source, company, position, city, jd, requirements, salary, apply_url, deadline, job_type, card_text, jd_images, jd_source, posted_at, grad_year, tags, match_score, remote, status, created_at, updated_at)
    VALUES (@id, @source, @company, @position, @city, @jd, @requirements, @salary, @apply_url, @deadline, @job_type, @card_text, @jd_images, @jd_source, @posted_at, @grad_year, @tags, @match_score, @remote, 'candidate', @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      ${setSql}
  `).run({
    id,
    source: job.source || 'manual',
    // ⚠️ 显式写 NULL：老库该列默认值是 0，不写就落成 0 ⇒ 未评分被当成「0 分」被闸门误杀
    match_score: job.match_score ?? null,
    company: job.company ?? null,
    position: job.position ?? null,
    city: job.city ?? null,
    jd: job.jd ?? null,
    card_text: job.card_text ?? null,
    jd_images: job.jd_images ?? null,
    jd_source: job.jd_source ?? null,
    posted_at: job.posted_at ?? null,
    grad_year: job.grad_year ?? null,
    tags: job.tags ?? null,
    remote: remoteVal,
    requirements: job.requirements ?? null,
    salary: job.salary ?? null,
    apply_url: job.apply_url ?? null,
    deadline: job.deadline ?? null,
    job_type: job.job_type ?? null,
    created_at: existing?.created_at || now,
    updated_at: now,
  });
  return getJob(id)!;
}

export function updateJob(id: string, updates: Partial<Pick<JobRow,
  // 🔴 这份硬编码的键名清单**必须**与上面的 JOB_UPDATABLE_COLUMNS 同集合：
  //    它是 `updateJob(...)` 的编译期类型，那份是运行期 SQL 白名单；两处任一处漏改，
  //    表现是「编译期报错」或「写进去了但被白名单丢掉」——两者都不说自己是列同步问题。
  //    （`grad_year`/`tags`/`matched_at` 都是这样加进来的）
  'company' | 'position' | 'city' | 'jd' | 'requirements' | 'salary' | 'apply_url' | 'deadline' | 'job_type' | 'match_score' | 'match_detail' |   'quarantine' | 'skip_reason' | 'card_text' | 'jd_images' | 'jd_source' | 'ocr_status' | 'posted_at' | 'remote' | 'status' | 'grad_year' | 'tags' | 'matched_at'
>>): boolean {
  /** 文本字段同样过清洗，避免绕过 upsertJob 直接脏写（见 sanitize* 系列） */
  const sanitizeField = (k: string, v: any): any => {
    if (k === 'company') return sanitizeCompany(v);
    if (k === 'position') return sanitizePosition(v);
    if (k === 'salary') return sanitizeSalary(v);
    if (k === 'city') return sanitizeJobText(v, 30);
    if (k === 'job_type') return sanitizeJobText(v, 20);
    if (k === 'posted_at') return normalizePostedDate(v);
    // 🔴 走 PATCH 直接脏写也必须收敛：`grad_year` 是前端下拉的候选值来源，
    //    存进 `'2027届'` 会让下拉多出一个看着相同却只筛一部分的选项。
    if (k === 'grad_year') return normalizeGradYear(v);
    if (k === 'tags') return serializeTags(v);
    return v;
  };
  const { fields, values } = collectUpdateFields(
    updates as Record<string, any>, JOB_UPDATABLE_COLUMNS, sanitizeField,
  );
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

export interface FormMemoryBrief {
  site: string;
  /** 只给字段**标签**，不给值 —— 值是姓名/手机号/邮箱，界面不该回显 */
  labels: string[];
  count: number;
  updatedAt: string;
}

/** 列出全部表单记忆（按最近更新排序）。刻意只回标签：值属个人信息，界面不需要 */
export function listFormMemory(): FormMemoryBrief[] {
  const rows = db
    .prepare('SELECT site, fields, updated_at FROM form_memory ORDER BY updated_at DESC')
    .all() as FormMemoryRow[];
  return rows.map((r) => {
    let labels: string[] = [];
    try {
      const o = JSON.parse(r.fields);
      if (o && typeof o === 'object') labels = Object.keys(o);
    } catch {
      labels = [];
    }
    return { site: r.site, labels, count: labels.length, updatedAt: r.updated_at };
  });
}

/** 删除某域名的表单记忆，返回删除行数（0 = 本来就没有） */
export function deleteFormMemory(site: string): number {
  if (!site) return 0;
  const r = db.prepare('DELETE FROM form_memory WHERE site = ?').run(site);
  return Number(r.changes || 0);
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
