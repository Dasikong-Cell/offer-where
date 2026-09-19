/**
 * 阶段 1（抓图方案）：微信推文 JD 长图抓取
 * ==========================================================================
 * offerbiu 里大量岗位入口是 mp.weixin.qq.com 推文，而这类校招推文的 JD 是**图片长图**
 * （#js_content 内是大图，innerText 几乎为空，纯文本抽取只能抽到"点击蓝字关注我们"）。
 * 因此原计划「文本抽取回填 jd」对这批无效。本脚本改用「抓图」：
 *   用 9227 调试 Chrome 的 captureUrlElement 截取 #js_content 长图 → 存 data/jd_images/<id>.png
 *   → 写 jobs.jd_images(JSON) + jd_source='image'。
 *   若某篇推文其实是文字 JD（少数），则直接把文本写进 jd、jd_source='text'（顺带提升文本覆盖率）。
 *
 * 安全设计：
 *  - 分批 40/轮、间隔 1.5s，降低微信批量访问限流概率；
 *  - 截到的 PNG < 30KB 视为风控/空页 → 跳过；连续 3 次微小截图 → 判定已限流，整轮中止并提示冷却；
 *  - 幂等：只处理 jd_source!='image' 且尚无 jd_images 者；--dry-run 仍会截图以验证管线，但不写库；
 *  - 推文已删除（#js_content 不存在）→ captureUrlElement 报错 → 跳过该条。
 *
 * 运行：
 *   ./node/node.exe node_modules/tsx/dist/cli.mjs scripts/capture_wechat_jd_images.ts            # 全量
 *   ./node/node.exe node_modules/tsx/dist/cli.mjs scripts/capture_wechat_jd_images.ts --limit 3   # 冒烟
 *   ./node/node.exe node_modules/tsx/dist/cli.mjs scripts/capture_wechat_jd_images.ts --dry-run    # 只报告(仍截图验证)
 * 参数：--limit N --offset N --batch N --interval Ms --ctx KEY --endpoint URL --dry-run
 */
import '../server/env.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as db from '../server/db.js';
import { execCdpAction } from '../server/services/cdpDriver.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..');

/** 取 offerbiu/official 的 CDP 端点（默认 9227） */
function officialEndpoint(): string {
  try {
    const p = path.join(ROOT, 'data', 'browser', 'cdp.json');
    const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const ep = cfg?.official || cfg?.offerbiu;
    if (typeof ep === 'string' && ep.trim()) return ep.trim();
  } catch { /* ignore */ }
  return 'http://127.0.0.1:9227';
}

const WEIXIN_RE = /mp\.weixin\.qq\.com/i;
const TINY_BYTES = 30 * 1024; // 截图小于此值视为风控/空页
const MAX_H = 24000;

/** 轻量 JD 质量判定：文本是否含岗位描述类关键词（用于区分"文字 JD" vs "图片 JD"） */
function looksLikeJd(text: string): boolean {
  return /(岗位职责|任职要求|职位描述|招聘|校招|实习|应聘|任职资格|工作内容|任职条件|岗位要求|工作职责|职位要求|我们需要|等你加入|热招|专业要求|学历要求|工作地点)/.test(String(text || ''));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Args { limit: number; offset: number; batch: number; interval: number; ctx: string; endpoint: string; dryRun: boolean; }
function parseArgs(argv: string[]): Args {
  const a: Args = { limit: 0, offset: 0, batch: 40, interval: 1500, ctx: 'official', endpoint: officialEndpoint(), dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--dry-run') a.dryRun = true;
    else if (v === '--limit') a.limit = Number(argv[++i]) || 0;
    else if (v === '--offset') a.offset = Number(argv[++i]) || 0;
    else if (v === '--batch') a.batch = Math.max(1, Number(argv[++i]) || 40);
    else if (v === '--interval') a.interval = Math.max(0, Number(argv[++i]) || 1500);
    else if (v === '--ctx') a.ctx = argv[++i] || 'official';
    else if (v === '--endpoint') a.endpoint = argv[++i] || a.endpoint;
  }
  return a;
}

interface ReportRow { jobId: string; company: string; position: string; kind: 'image' | 'text' | 'skip' | 'tiny' | 'deleted' | 'err'; bytes: number; chars: number; note: string; }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`\n══════ 微信推文 JD 抓取（阶段 1 · 抓图方案）══════`);
  console.log(`端点 ${args.endpoint}  上下文 ${args.ctx}  batch=${args.batch}  interval=${args.interval}ms  模式=${args.dryRun ? 'DRY-RUN(只截图不写库)' : '写入'}`);

  // 候选：offerbiu + 微信推文入口 + jd 空 + 尚未抓取(jd_source!='image')
  const all = db.listJobs({ source: 'offerbiu' }).filter((j: any) =>
    j.apply_url && WEIXIN_RE.test(j.apply_url) && !(j.jd && String(j.jd).trim()) && j.jd_source !== 'image',
  );
  const jobs = args.limit ? all.slice(args.offset, args.offset + args.limit) : all.slice(args.offset);
  console.log(`候选（微信推文 + jd空 + 未抓图）：${jobs.length} 条 / offerbiu 总 ${db.listJobs({ source: 'offerbiu' }).length} 条\n`);
  if (jobs.length === 0) { console.log('没有需要抓取的微信推文岗位，结束。'); return; }

  let image = 0, text = 0, skip = 0, tiny = 0, deleted = 0, err = 0, riskAbort = false, tinyStreak = 0;
  let abortedAt = '';
  const report: ReportRow[] = [];
  const imgDir = path.join(ROOT, 'data', 'jd_images');

  for (let i = 0; i < jobs.length; i++) {
    const j: any = jobs[i];
    const tag = `[${i + 1}/${jobs.length}]`;
    process.stdout.write(`${tag} ${j.company || '(未知)'} · ${j.position || ''}  `);
    const outPath = path.join(imgDir, `${j.id}.png`);
    const relLocal = `/data/jd_images/${j.id}.png`;
    try {
      const r: any = await execCdpAction(args.ctx, 'captureUrlElement', {
        url: j.apply_url, selector: '#js_content', outPath, maxHeight: MAX_H, scale: 1,
      }, args.endpoint).catch(() => undefined);

      if (!r || !r.ok) {
        // #js_content 不存在（推文已删除/违规）→ 明确标记 deleted；否则记 err
        const msg = String(r?.error || '未知');
        if (/未找到元素/.test(msg)) {
          console.log('推文已删除(#js_content缺失)，跳过');
          deleted++; report.push({ jobId: j.id, company: j.company, position: j.position, kind: 'deleted', bytes: 0, chars: 0, note: '推文已删除' });
        } else {
          console.log(`捕获失败：${msg}`);
          err++; report.push({ jobId: j.id, company: j.company, position: j.position, kind: 'err', bytes: 0, chars: 0, note: msg.slice(0, 60) });
        }
        await sleep(args.interval); continue;
      }

      const bytes = r.data?.bytes || 0;
      const elText = String(r.data?.text || '');
      // 微小截图 → 风控/空页
      if (bytes < TINY_BYTES) {
        console.log(`截图过小(${bytes}B)，疑似风控/空页，跳过`);
        tiny++; tinyStreak++;
        report.push({ jobId: j.id, company: j.company, position: j.position, kind: 'tiny', bytes, chars: 0, note: '截图过小(风控/空页)' });
        // 清理落盘的空文件
        try { fs.unlinkSync(outPath); } catch { /* ignore */ }
        if (tinyStreak >= 3) {
          console.log('\n⚠️ 连续 3 张微小截图 —— 判定 9227 已被微信限流，立即中止整轮。请冷却后(或人工在浏览器过验证后)重跑。');
          riskAbort = true; abortedAt = `${j.company || ''} ${j.position || ''}`;
          break;
        }
        await sleep(args.interval); continue;
      }
      tinyStreak = 0;

      // 文字 JD（少数推文是文字版）→ 直接写 jd 文本，提升文本覆盖率
      if (elText.length > 200 && looksLikeJd(elText)) {
        const jd = elText.length > 4000 ? elText.slice(0, 4000) : elText;
        if (!args.dryRun) db.updateJob(j.id, { jd, jd_source: 'text', match_score: null });
        text++;
        report.push({ jobId: j.id, company: j.company, position: j.position, kind: 'text', bytes, chars: jd.length, note: args.dryRun ? 'dry-run' : '文字JD已写回' });
        console.log(`✓ 文字JD ${jd.length} 字（jd_source=text）`);
        try { fs.unlinkSync(outPath); } catch { /* ignore */ } // 文字版无需图
        await sleep(args.interval); continue;
      }

      // 图片 JD → 存图 + jd_source='image'
      if (!args.dryRun) {
        db.updateJob(j.id, {
          jd_images: JSON.stringify([{ local: relLocal, w: r.data?.width || 0, h: r.data?.height || 0 }]),
          jd_source: 'image',
        });
      }
      image++;
      report.push({ jobId: j.id, company: j.company, position: j.position, kind: 'image', bytes, chars: 0, note: args.dryRun ? 'dry-run' : (r.data?.truncated ? '长图超上限已截断' : 'ok') });
      console.log(`✓ 抓图 ${bytes}B / ${r.data?.width}x${r.data?.height}${r.data?.truncated ? ' (截断)' : ''}`);
    } catch (e: any) {
      console.log(`异常：${e?.message || e}`);
      err++; report.push({ jobId: j.id, company: j.company, position: j.position, kind: 'err', bytes: 0, chars: 0, note: '异常: ' + (e?.message || e) });
    }
    await sleep(args.interval);
    if ((i + 1) % args.batch === 0) console.log(`  —— 进度 ${i + 1}/${jobs.length}（图 ${image} / 文 ${text} / 跳过 ${skip + tiny + deleted + err}）`);
  }

  const summary = {
    mode: args.dryRun ? 'dry-run' : 'write',
    candidateTotal: jobs.length,
    image, text, skip, tiny, deleted, err,
    riskAbort, abortedAt,
    offerbiuImageJd: db.query<{ c: number }>("SELECT COUNT(*) c FROM jobs WHERE source='offerbiu' AND jd_source='image'").pop()?.c || 0,
    offerbiuTextJd: db.query<{ c: number }>("SELECT COUNT(*) c FROM jobs WHERE source='offerbiu' AND jd_source='text'").pop()?.c || 0,
    report,
  };
  const outPath2 = path.join(ROOT, 'data', 'capture_wechat_report.json');
  fs.mkdirSync(path.dirname(outPath2), { recursive: true });
  fs.writeFileSync(outPath2, JSON.stringify(summary, null, 2), 'utf-8');

  console.log(`\n══════ 汇总 ══════`);
  console.log(`处理候选 ${jobs.length} | 抓图 ${image} | 文字JD ${text} | 微小跳过 ${tiny} | 已删除 ${deleted} | 失败 ${err}${riskAbort ? ' | ⚠ 风控中止' : ''}`);
  console.log(`offerbiu 现：图片JD ${summary.offerbiuImageJd} / 文字JD ${summary.offerbiuTextJd}`);
  console.log(`报告：${outPath2}`);
  if (riskAbort) process.exit(2);
}

// 顶层异常兜底：用 exitCode 而非立即 process.exit，避免 stderr 未刷出就退出（错误信息丢失）
process.on('unhandledRejection', (e) => { console.error('[unhandledRejection]', e); });
process.on('uncaughtException', (e) => { console.error('[uncaughtException]', e); });
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exitCode = 1; });
