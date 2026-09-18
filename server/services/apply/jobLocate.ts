/**
 * 公司背调 / 岗位定位（对标职得鸭 `bossSearch.js`，它前端叫「AI公司背调」）
 * ==========================================================================
 * ⚠️ 先说实话：职得鸭那个功能**名不副实**。读它的源码，`bossSearch.js` 做的是：
 *   打开平台搜索页 → 搜公司名 → 点「在招职位」→ 搜职位名 → 点开目标岗位
 *   → 回写 `updateJobRecordSearchedContacted(id, true)`。
 * 全程**没有任何 AI 分析**，本质是「机器帮你把岗位页面调出来，你自己看」。
 *
 * 我们按「它宣称的、也是真正有用的」去做：**人机协同定位 + 留痕**，
 * 并且把「帮你找到这个岗位」这件事做成可复用的能力（投递失败时人工接管的第一步）。
 *
 * 支持情况：BOSS 走完整公司→岗位两级定位（选择器已在真机校验）；
 *          其他平台退化为「直接打开岗位详情页」，并如实说明。
 */
import { bexec, ApplyLogger, sleep } from './common.js';
import { kvGetJson, kvSetJson, getJob, type JobRow } from '../../db.js';

export interface LocateResult {
  ok: boolean;
  platform: string;
  jobId?: string;
  steps: Array<{ step: string; ok: boolean; detail?: string }>;
  message: string;
}

const kvKey = (jobId: string) => `located:${jobId}`;

export interface LocatedRecord {
  jobId: string;
  platform: string;
  company?: string | null;
  position?: string | null;
  url?: string;
  at: string;
}

export function getLocated(jobId: string): LocatedRecord | null {
  return kvGetJson<LocatedRecord | null>(kvKey(jobId), null);
}

function markLocated(rec: LocatedRecord): void {
  kvSetJson(kvKey(rec.jobId), rec);
}

/** BOSS 平台页面内搜索：输入关键词并回车（选择器来自真机实测） */
async function searchInPage(
  platform: string,
  logs: ApplyLogger,
  opts: { inputSelectors: string[]; buttonTexts?: string[]; keyword: string; label: string },
): Promise<boolean> {
  // 优先用真实键入（isTrusted=true，搜索框普遍对合成事件不敏感）
  for (const sel of opts.inputSelectors) {
    const r = await bexec(
      platform, 'typeHuman',
      { selector: sel, value: opts.keyword, timeout: 8000, minDelay: 60, maxDelay: 150 },
      logs, `${opts.label}：输入「${opts.keyword}」`,
    );
    if (r.ok) {
      await sleep(500);
      for (const t of opts.buttonTexts || []) {
        const c = await bexec(platform, 'click', { text: t, timeout: 2500 }, undefined, `${opts.label}：点「${t}」`);
        if (c.ok) return true;
      }
      // 没有按钮就回车提交
      const p = await bexec(platform, 'press', { key: 'Enter' }, logs, `${opts.label}：回车提交`);
      return p.ok;
    }
  }
  return false;
}

/**
 * 定位岗位：把目标岗位的页面在平台里"翻出来"，方便人工查看或人工接管投递。
 */
export async function locateJob(
  platform: string,
  job: Partial<JobRow> & { id?: string },
  logs: ApplyLogger = new ApplyLogger(),
): Promise<LocateResult> {
  const steps: LocateResult['steps'] = [];
  const push = (step: string, ok: boolean, detail?: string) => {
    steps.push({ step, ok, detail });
    logs.step(step, ok, detail);
  };
  const jobId = job.id ? String(job.id) : undefined;

  // ── BOSS：公司 → 在招职位 → 岗位，两级定位
  if (platform === 'boss' && job.company) {
    try {
      await bexec(platform, 'navigate', { url: 'https://www.zhipin.com/web/geek/jobs', waitUntil: 'domcontentloaded' }, logs, '打开 BOSS 职位页');
      await sleep(2500);
      const ok1 = await searchInPage(platform, logs, {
        inputSelectors: ['.input-wrap input.input', 'input[placeholder*="搜索"]'],
        buttonTexts: ['搜索'],
        keyword: String(job.company),
        label: '公司搜索',
      });
      push(`搜索公司「${job.company}」`, ok1);
      if (!ok1) return fail();

      await sleep(2000);
      // 进入该公司的「在招职位」列表
      const enter = await bexec(platform, 'eval', {
        script: `(function(){ var el = document.querySelector('.count-job'); if(!el) return JSON.stringify({ok:false});
          el.click(); return JSON.stringify({ok:true}); })()`,
      }, logs, '进入「在招职位」');
      const entered = (() => { try { return !!JSON.parse(String(enter.data || '{}')).ok; } catch { return false; } })();
      push('进入公司「在招职位」列表', entered);
      await sleep(2500);

      if (entered && job.position) {
        const ok2 = await searchInPage(platform, logs, {
          inputSelectors: ['input[placeholder*="查找职位"]', '.company-job-search input'],
          keyword: String(job.position),
          label: '岗位搜索',
        });
        push(`在公司内搜索职位「${job.position}」`, ok2);
        await sleep(2200);
      }

      const url = (await bexec(platform, 'html', { maxLength: 1 }, undefined, '读取当前页面 URL')).url || '';
      if (jobId) {
        markLocated({ jobId, platform, company: job.company, position: job.position, url, at: new Date().toISOString() });
      }
      return {
        ok: true, platform, jobId, steps,
        message: `已在 BOSS 定位到「${job.company}${job.position ? ' · ' + job.position : ''}」，请在浏览器中查看`,
      };
    } catch (e: any) {
      push('BOSS 定位流程异常', false, e?.message || String(e));
      return fail(e?.message);
    }
  }

  // ── 其他平台/信息不全：退化为直接打开岗位详情页
  const url = job.apply_url;
  if (!url) {
    return { ok: false, platform, jobId, steps, message: '岗位缺少 apply_url，无法定位（也不支持自动搜索）' };
  }
  const nav = await bexec(platform, 'navigate', { url, waitUntil: 'domcontentloaded' }, logs, '打开岗位详情页');
  push('打开岗位详情页', nav.ok, nav.ok ? url : nav.error);
  if (nav.ok && jobId) {
    markLocated({ jobId, platform, company: job.company, position: job.position, url, at: new Date().toISOString() });
  }
  return {
    ok: nav.ok, platform, jobId, steps,
    message: nav.ok
      ? `${platform} 已打开岗位页（该平台无公司级搜索定位，仅直达详情）`
      : `打开失败：${nav.error || '未知错误'}`,
  };

  function fail(msg?: string): LocateResult {
    return { ok: false, platform, jobId, steps, message: msg || '定位未成功，可在浏览器中手动查找' };
  }
}

/** 定位并按需打开（供 API 使用）：从库里的岗位 ID 出发 */
export async function locateJobById(
  jobId: string,
  platform?: string,
  logs: ApplyLogger = new ApplyLogger(),
): Promise<LocateResult> {
  const job = getJob(jobId);
  if (!job) {
    return { ok: false, platform: platform || '?', jobId, steps: [], message: '岗位不存在' };
  }
  return locateJob(platform || job.source, job, logs);
}
