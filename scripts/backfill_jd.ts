/**
 * 回填岗位 JD 正文（顺带补公司名）
 * ==========================================================================
 * 为什么需要：2026-09-19 测评实测 —— 全池 1687 个岗位里 **685 个（40.6%）JD 为空**，
 * 而 `matchResumeToJob` 在无 JD 时只能拿职位名兜底（封顶 70 分），
 * 导致「匹配度看板」的高分严重虚高（BOSS 246 个高分里 242 个是兜底出来的）。
 * 因此「补全 JD」是让匹配、排序、一岗一简历 真正可用的前置条件。
 *
 * 做法：对 JD 为空的岗位逐个访问详情页，抓 `.job-sec-text`（实测 170 字，干净）；
 *       公司名为空时顺带用 `.company-name`（实测「新印科技」）补上。
 *
 * 特点：
 *   · **可续跑**：天然跳过已有 JD 的岗位，随时 Ctrl-C，下次接着跑
 *   · **限数量**：默认 30 条/次，避免一次性高频访问触发风控
 *   · **失败不中断**：单条失败只记日志，继续下一条
 *
 * 用法：
 *   # 预览（只统计待回填数量，不访问页面）
 *   ./node/node.exe node_modules/tsx/dist/cli.mjs scripts/backfill_jd.ts --dry-run
 *   # 回填 30 条
 *   ./node/node.exe node_modules/tsx/dist/cli.mjs scripts/backfill_jd.ts --limit=30
 *   # 回填 100 条、含已投岗位、间隔 3 秒
 *   ./node/node.exe node_modules/tsx/dist/cli.mjs scripts/backfill_jd.ts --limit=100 --include-applied --interval=3000
 */
import * as db from '../server/db.js';
import { ex } from './lib/browser.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const arg = (name: string, def?: string) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

const SOURCE = arg('source', 'boss')!;
const LIMIT = Math.max(1, Number(arg('limit', '30')));
const INTERVAL = Math.max(500, Number(arg('interval', '2500')));
const INCLUDE_APPLIED = flag('include-applied');
const DRY_RUN = flag('dry-run');

/**
 * 平台「岗位详情页」链接特征（列表页/搜索页没有 JD，必须排除）。
 * ⚠️ 必须按**实测的真实 URL 形态**写，否则候选数会莫名变成 0：
 * 智联详情页是 `https://www.zhaopin.com/jobdetail/CCxxxxxxx.htm`，
 * 不是 `jobs.zhaopin.com`（早期写成后者 → 127 个智联岗位被误判为「无详情页直链」而整批漏掉）。
 */
const DETAIL_URL: Record<string, RegExp> = {
  boss: /\/job_detail\/[^/]+\.html/,
  liepin: /\/lptjob\/[^/]+/,
  job51: /jobs\.51job\.com\/[^/]+\/[^/]+\.html/,
  zhilian: /zhaopin\.com\/jobdetail\//,
};

/**
 * 详情页 JD 选择器（**按优先级排列**，逐个尝试取第一个够长的）。
 * 实测校准 2026-09-19，用 `scripts/calibrate_jd_selectors.ts` 可复查：
 *   boss    .job-sec-text            383 字（干净正文）
 *   job51   .bmsg.job_msg            856 字
 *   zhilian [class*=detail-content]  529 字（以「岗位职责」开头，比 describtion 更干净）
 *           [class*=describtion]     637 字（含技能标签，作兜底）
 *   liepin  [class*=job-intro-container] / .paragraph  1163 字
 */
const JD_SELECTORS: Record<string, string[]> = {
  boss: ['.job-sec-text', '[class*=job-sec]', '.job-detail-section'],
  job51: ['.bmsg.job_msg', '.job_msg', '[class*=job_msg]'],
  zhilian: ['[class*=detail-content]', '[class*=describtion]', '[class*=job-description]'],
  liepin: ['[class*=job-intro-container]', '.paragraph', '[class*=intro]'],
};

/**
 * 公司名选择器（详情页，按优先级）。
 * boss 实测 `.company-name` = 「新印科技」；
 * 51job 的公司名在 `.cname`；智联在 `.company__title`；猎聘在 `.company-name`。
 */
const COMPANY_SELECTORS = [
  '.company-name', '[class*="company-name"]', '.company-info .name', '.sider-company .name',
  '.cname', '[class*="cname"]',            // 51job
  '.company__title', '[class*="company-title"]', // 智联
];

const EXTRACT = (jdSels: string[]) => `(() => {
  const clean = (t) => (t || '').replace(/[\\uE000-\\uF8FF]/g, '').replace(/[ \\t]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim();
  /** 按优先级取第一个「够长」的选择器结果（避免命中侧边栏/推荐位等碎片） */
  const pick = (sels, min) => {
    for (const s of sels) {
      const e = document.querySelector(s);
      const t = e ? clean(e.innerText) : '';
      if (t.length >= min) return t;
    }
    return '';
  };
  const body = (document.body ? (document.body.innerText || '') : '');
  // 风控识别：51job 等在触发反爬时会整页替换成「访问验证 / 滑动验证」页，
  // 此时所有 JD 选择器都命中 null —— 早期版本把这种情况误报成「岗位已下架」，
  // 会让人以为数据没了、并继续无意义地刷（反而加重风控）。这里显式识别并让调用方中止。
  const BLOCK = /(访问验证|滑动验证|安全验证|人机验证|请按住滑块|拖动到最右边|verify)/i;
  const blocked = document.title ? BLOCK.test(document.title) : false;
  return {
    url: location.href,
    docTitle: document.title || '',
    blocked: blocked || (body.length < 400 && BLOCK.test(body)),
    bodyLen: body.length,
    title: ((document.querySelector('.job-name, .name') || {}).innerText || '').trim().slice(0, 60),
    jd: pick(${JSON.stringify(jdSels)}, 20),
    company: pick(${JSON.stringify(COMPANY_SELECTORS)}, 2).slice(0, 40),
  };
})()`;

(async () => {
  const urlRe = DETAIL_URL[SOURCE] || DETAIL_URL.boss;
  const statuses = INCLUDE_APPLIED ? ['candidate', 'applied', 'unavailable'] : ['candidate'];
  const all = statuses.flatMap((s) => db.listJobs({ source: SOURCE, status: s }));
  // 候选：JD 为空 且 有详情页直链
  const targets = all.filter((j) => {
    const noJd = !j.jd || !String(j.jd).trim();
    return noJd && j.apply_url && urlRe.test(j.apply_url);
  });

  console.log(`[JD 回填] source=${SOURCE} 状态=${statuses.join('/')}`);
  console.log(`  该范围岗位 ${all.length} 个，其中「无 JD 且有详情页直链」的候选 ${targets.length} 个`);
  if (DRY_RUN) {
    console.log('  --dry-run：只统计，不访问页面。去掉 --dry-run 即开始回填。');
    console.log('\n  样例（前 5）：');
    for (const t of targets.slice(0, 5)) console.log(`    · ${t.company || '(无公司)'} — ${t.position || '(无职位)'}  ${t.apply_url}`);
    process.exit(0);
  }
  if (!targets.length) { console.log('  没有需要回填的岗位 ✅'); process.exit(0); }

  const batch = targets.slice(0, LIMIT);
  console.log(`  本次回填 ${batch.length} 个（间隔 ${INTERVAL}ms，预计约 ${Math.round(batch.length * (INTERVAL + 4500) / 60000)} 分钟）\n`);

  const jdSels = JD_SELECTORS[SOURCE] || JD_SELECTORS.boss;
  let okJd = 0, okCo = 0, failed = 0, emptyPage = 0, blocked = false;

  for (let i = 0; i < batch.length; i++) {
    const j = batch[i];
    const tag = `[${i + 1}/${batch.length}]`;
    try {
      const nav: any = await ex(SOURCE, { action: 'navigate', url: j.apply_url!, waitUntil: 'domcontentloaded' });
      if (!nav?.ok) { failed++; console.log(`${tag} ❌ 导航失败 ${j.position || j.apply_url}`); await sleep(INTERVAL); continue; }
      await sleep(4200);
      const r: any = await ex(SOURCE, { action: 'eval', script: EXTRACT(jdSels) });
      const d = r?.data || {};

      // 命中风控验证页 → 立即中止整批（继续刷只会加重风控，且数据一条也拿不到）
      if (d.blocked) {
        blocked = true;
        console.log(`${tag} 🛑 触发风控验证页（标题「${d.docTitle}」）—— 已中止本批`);
        break;
      }

      const jdText = String(d.jd || '');
      const patch: Record<string, any> = {};
      if (jdText.length >= 20) { patch.jd = jdText.slice(0, 4000); okJd++; }
      // 公司名为空时顺带补（测评发现大量岗位 company 为空）
      if ((!j.company || !String(j.company).trim()) && d.company) { patch.company = String(d.company); okCo++; }
      if (Object.keys(patch).length) {
        db.updateJob(j.id, patch);
        console.log(`${tag} ✅ JD ${jdText.length} 字${patch.company ? ` · 公司「${patch.company}」` : ''}  ${j.position || ''}`);
      } else if (String(d.bodyLen || 0) < 400) {
        // 页面几乎是空壳（非验证页）→ 多为岗位已下架/要求登录
        emptyPage++; failed++;
        console.log(`${tag} ⚠️ 页面空白（${d.bodyLen} 字，疑似已下架或需登录）  ${j.position || j.apply_url}`);
      } else {
        failed++;
        console.log(`${tag} ⚠️ 页面正常但未命中 JD 选择器  ${j.position || j.apply_url}`);
      }
    } catch (e: any) {
      failed++;
      console.log(`${tag} ❌ ${e?.message || e}  ${j.position || j.apply_url}`);
    }
    await sleep(INTERVAL);
  }

  console.log('\n══════ 回填汇总 ══════');
  console.log(`  JD 补全 ${okJd} 个 ｜ 公司名补全 ${okCo} 个 ｜ 失败/跳过 ${failed} 个（其中页面空白 ${emptyPage}）`);
  if (blocked) {
    console.log(`  🛑 因触发风控验证页提前中止（本次未处理完 ${batch.length} 个）`);
    console.log(`     处理办法：在该平台的调试浏览器窗口里人工过一次滑块/短信验证，稍等冷却后再跑本脚本；`);
    console.log(`     同一时间不要同时跑采集/投递，避免叠加触发风控。`);
  }

  // 剩余待回填
  const remain = targets.length - okJd - (batch.length - okJd);
  const stillNoJd = db.listJobs({ source: SOURCE }).filter((j) => !j.jd || !String(j.jd).trim()).length;
  console.log(`  该来源仍无 JD 的岗位：${stillNoJd} 个 → 继续跑本脚本可接着回填（可续跑）`);
  if (remain > 0) console.log(`  建议下次再跑一轮：--limit=${Math.min(100, remain)}`);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
