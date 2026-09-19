/**
 * 阶段 1 延伸（OCR 回填）：微信 JD 长图 → 文本
 * ==========================================================================
 * capture_wechat_jd_images.ts 把 220+ 张微信推文 JD 长图存进了 data/jd_images/，
 * 并标记 jd_source='image'，但 jd 列仍为空 —— 匹配引擎无法用这些 JD（死数据）。
 * 本脚本用「已配置的视觉大模型」把这些长图 OCR 成文本，写回 jd，让它们进入匹配。
 *
 * 管线：读 PNG → @napi-rs/canvas 缩放(宽≤1280)转 JPEG 降体积 → OpenAI 兼容
 *       /chat/completions(多模态 messages + image_url) 提取 JD 文本 → 写回 jd。
 *
 * 设计：
 *  - 复用 aiClient.getAiConfig()：LLM_BASE_URL + LLM_API_KEY + LLM_MODEL 三者齐备才启用；
 *    模型需为「视觉模型」（如 gpt-4o-mini / qwen-vl / glm-4v / deepseek-vl 等），
 *    纯文本模型会返回空 → 标记 failed，不会无限重试。
 *  - 幂等：只处理 jd_source='image' 且 jd 为空 且 ocr_status∈(NULL|pending)。
 *  - ocr_status：done=已写回；failed=识别失败（留待 --retry-failed 重跑）。
 *  - 节流：每图间隔，降低视觉 API 限频概率；--dry-run 验证图片管线但不调 API、不写库。
 *
 * 运行：
 *   tsx scripts/ocr_wechat_jd.ts                 # 全量回填
 *   tsx scripts/ocr_wechat_jd.ts --limit 3       # 冒烟
 *   tsx scripts/ocr_wechat_jd.ts --model gpt-4o-mini   # 指定视觉模型
 *   tsx scripts/ocr_wechat_jd.ts --retry-failed  # 重跑失败项
 *   tsx scripts/ocr_wechat_jd.ts --dry-run       # 只报告待处理量 + 验证首图可读取
 */
import '../server/env.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as db from '../server/db.js';
import { getAiConfig } from '../server/services/apply/aiClient.js';
import { loadImage, createCanvas } from '@napi-rs/canvas';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..');
const IMG_DIR = path.join(ROOT, 'data', 'jd_images');
const MAX_W = 1280; // 缩放上限宽，控视觉 API 体积/像素
const JD_MAX = 8000;

/** 真实 JD 判定（与 capture 脚本同款关键词） */
function looksLikeJd(text: string): boolean {
  return /(岗位职责|任职要求|职位描述|招聘|校招|实习|应聘|任职资格|工作内容|任职条件|岗位要求|工作职责|职位要求|我们需要|等你加入|热招|专业要求|学历要求|工作地点)/.test(String(text || ''));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Args { limit: number; offset: number; model: string | null; retryFailed: boolean; dryRun: boolean; batch: number; interval: number; }
function parseArgs(argv: string[]): Args {
  const a: Args = { limit: 0, offset: 0, model: null, retryFailed: false, dryRun: false, batch: 20, interval: 900 };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--dry-run') a.dryRun = true;
    else if (v === '--retry-failed') a.retryFailed = true;
    else if (v === '--limit') a.limit = Number(argv[++i]) || 0;
    else if (v === '--offset') a.offset = Number(argv[++i]) || 0;
    else if (v === '--batch') a.batch = Math.max(1, Number(argv[++i]) || 20);
    else if (v === '--interval') a.interval = Math.max(0, Number(argv[++i]) || 900);
    else if (v === '--model') a.model = argv[++i] || null;
  }
  return a;
}

/** PNG → 缩放 JPEG base64（失败返回 null） */
async function toJpegBase64(pngPath: string): Promise<string | null> {
  try {
    const buf = fs.readFileSync(pngPath);
    const img = await loadImage(buf);
    const scale = Math.min(1, MAX_W / img.width);
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const jpeg = canvas.toBuffer('image/jpeg', { quality: 0.82 });
    return jpeg.toString('base64');
  } catch {
    return null;
  }
}

/** 视觉 OCR：返回提取文本或 null（软失败） */
async function ocrImage(b64: string, model: string, timeoutMs = 60000): Promise<string | null> {
  const cfg = getAiConfig();
  if (!cfg) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: model || cfg.model,
        temperature: 0.1,
        max_tokens: 2500,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: '这是一张招聘长图/海报。请完整提取其中的招聘JD正文（含：公司简介、岗位职责、任职要求、工作地点、薪资、福利等）。只输出提取到的原文文字，不要解释、不要翻译、不要总结；若图中没有招聘内容，仅输出空字符串。',
              },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
            ],
          },
        ],
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as any;
    const txt: unknown = data?.choices?.[0]?.message?.content;
    return typeof txt === 'string' ? txt.trim() : null;
  } catch {
    return null;
  }
}

export interface OcrSummary {
  mode: string;
  pending: number;
  processed: number;
  done: number;
  failed: number;
  skipped: number;
  visionEnabled: boolean;
  report: Array<{ jobId: string; company: string; position: string; kind: string; chars: number; note: string }>;
}

/** 待处理数量（供后端统计） */
export function pendingCount(retryFailed: boolean): number {
  const rows = db.query<{ c: number }>(
    `SELECT COUNT(*) c FROM jobs WHERE jd_source='image' AND (jd IS NULL OR TRIM(jd)='') AND (${retryFailed ? "ocr_status='failed'" : "ocr_status IS NULL OR ocr_status='pending'"})`,
  );
  return rows[0]?.c || 0;
}

export async function runOcrBackfill(opts: Partial<Args> = {}): Promise<OcrSummary> {
  const args: Args = { limit: 0, offset: 0, model: null, retryFailed: false, dryRun: false, batch: 20, interval: 900, ...opts };
  const cfg = getAiConfig();
  const visionEnabled = !!cfg;

  const where = args.retryFailed
    ? "jd_source='image' AND (jd IS NULL OR TRIM(jd)='') AND ocr_status='failed'"
    : "jd_source='image' AND (jd IS NULL OR TRIM(jd)='') AND (ocr_status IS NULL OR ocr_status='pending')";
  const all = db.query<any>(`SELECT * FROM jobs WHERE ${where} ORDER BY updated_at ASC`);
  const jobs = args.limit ? all.slice(args.offset, args.offset + args.limit) : all.slice(args.offset);

  const summary: OcrSummary = {
    mode: args.dryRun ? 'dry-run' : 'write',
    pending: pendingCount(args.retryFailed),
    processed: jobs.length, done: 0, failed: 0, skipped: 0, visionEnabled,
    report: [],
  };

  console.log(`\n══════ 微信 JD 长图 OCR 回填 ══════`);
  console.log(`视觉模型=${cfg ? (args.model || cfg.model) : '未配置(跳过)'}  batch=${args.batch}  间隔=${args.interval}ms  模式=${args.dryRun ? 'DRY-RUN' : '写入'}`);
  console.log(`待处理 ${summary.pending} | 本轮 ${jobs.length}\n`);

  if (!visionEnabled) {
    console.log('⚠️ 未检测到 LLM 视觉配置（LLM_BASE_URL/LLM_API_KEY/LLM_MODEL）。请在 .env 配置视觉模型后重跑。');
  }
  if (jobs.length === 0) { console.log('没有待识别的微信图片JD，结束。'); return summary; }

  for (let i = 0; i < jobs.length; i++) {
    const j: any = jobs[i];
    const tag = `[${i + 1}/${jobs.length}]`;
    process.stdout.write(`${tag} ${j.company || '(未知)'} · ${j.position || ''}  `);
    let firstLocal: string | null = null;
    try { const arr = JSON.parse(j.jd_images || '[]'); if (Array.isArray(arr) && arr[0]?.local) firstLocal = arr[0].local; } catch { /* ignore */ }
    if (!firstLocal) {
      console.log('无 jd_images 路径，跳过');
      summary.skipped++;
      summary.report.push({ jobId: j.id, company: j.company, position: j.position, kind: 'skip', chars: 0, note: '无 jd_images' });
      continue;
    }
    const abs = path.join(ROOT, String(firstLocal).replace(/^\//, ''));
    if (!fs.existsSync(abs)) {
      console.log('图文件缺失，标记 failed');
      if (!args.dryRun) db.updateJob(j.id, { ocr_status: 'failed' });
      summary.failed++;
      summary.report.push({ jobId: j.id, company: j.company, position: j.position, kind: 'failed', chars: 0, note: '图文件缺失' });
      continue;
    }

    const b64 = await toJpegBase64(abs);
    if (!b64) {
      console.log('图解码失败，标记 failed');
      if (!args.dryRun) db.updateJob(j.id, { ocr_status: 'failed' });
      summary.failed++;
      summary.report.push({ jobId: j.id, company: j.company, position: j.position, kind: 'failed', chars: 0, note: '图解码失败' });
      continue;
    }
    if (args.dryRun) {
      console.log(`图可读并缩放为 JPEG(${(b64.length * 3 / 4 / 1024).toFixed(0)}KB)，dry-run 不调 API`);
      summary.skipped++;
      summary.report.push({ jobId: j.id, company: j.company, position: j.position, kind: 'dry', chars: 0, note: `jpeg ${(b64.length * 3 / 4 / 1024).toFixed(0)}KB` });
      continue;
    }

    const text = visionEnabled ? await ocrImage(b64, args.model || cfg!.model) : null;
    if (text && text.length > 4 && looksLikeJd(text)) {
      const jd = text.length > JD_MAX ? text.slice(0, JD_MAX) : text;
      db.updateJob(j.id, { jd, ocr_status: 'done', match_score: null });
      summary.done++;
      summary.report.push({ jobId: j.id, company: j.company, position: j.position, kind: 'done', chars: jd.length, note: 'JD写回' });
      console.log(`✓ 识别 ${jd.length} 字`);
    } else {
      db.updateJob(j.id, { ocr_status: 'failed' });
      summary.failed++;
      summary.report.push({ jobId: j.id, company: j.company, position: j.position, kind: 'failed', chars: text?.length || 0, note: text ? '非JD内容' : '模型未返回(可能非视觉模型)' });
      console.log(`✗ 未识别(${text ? '非JD' : '空/非视觉'})`);
    }
    await sleep(args.interval);
    if ((i + 1) % args.batch === 0) console.log(`  —— 进度 ${i + 1}/${jobs.length}（done ${summary.done} / failed ${summary.failed} / skip ${summary.skipped}）`);
  }

  const outPath = path.join(ROOT, 'data', 'ocr_wechat_report.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ ...summary, at: new Date().toISOString() }, null, 2), 'utf-8');
  console.log(`\n══════ 汇总 ══════`);
  console.log(`处理 ${summary.processed} | 写回 ${summary.done} | 失败 ${summary.failed} | 跳过 ${summary.skipped}${visionEnabled ? '' : ' | ⚠ 视觉未启用'}`);
  console.log(`报告：${outPath}`);
  return summary;
}

// CLI 直接运行（兼容 tsx 把脚本放在 argv[2] 的情形）
const myPath = fileURLToPath(import.meta.url);
const isMain = process.argv.slice(1).some((a) => {
  try { return path.resolve(a) === myPath; } catch { return false; }
});
if (isMain) {
  process.on('unhandledRejection', (e) => { console.error('[unhandledRejection]', e); });
  process.on('uncaughtException', (e) => { console.error('[uncaughtException]', e); });
  runOcrBackfill(parseArgs(process.argv.slice(2)))
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exitCode = 1; });
}
