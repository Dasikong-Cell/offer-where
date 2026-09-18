/**
 * 收敛各平台调试 Chrome 里堆积的标签页
 * ==========================================================================
 * 背景（2026-09-19 用户反馈「投递时一个点击事件占一个窗口」）：
 * 根因是 cdpDriver 的 `closeTab` 是空壳（从不关闭），而 `ensureSession` 在会话失效时
 * **无条件新建标签** —— 任何 CDP 命令超时都会把会话标记 dead，于是每投一个岗位就泄漏
 * 一个停在 job_detail 的标签（实测 9223 堆了 16 个，5 个端点合计 49 个）。
 *
 * 代码侧已修（复用已有标签 + 真正实现 closeTab + 新增 closeExtraTabs）。
 * 本脚本用于**清理历史上已经堆积**的标签：
 *   每个平台只保留 1 个标签（优先保留匹配该平台常用页面的那个），其余关闭。
 *
 * ⚠️ 安全约束：
 *   · 每个端点**至少保留 1 个标签** —— 关掉最后一个会让整个 Chrome 进程退出；
 *   · 只会关 `type=page` 的标签；
 *   · 默认 dry-run，加 `--apply` 才真正关闭。
 *
 * 用法：
 *   ./node/node.exe node_modules/tsx/dist/cli.mjs scripts/clean_tabs.ts            # 预览
 *   ./node/node.exe node_modules/tsx/dist/cli.mjs scripts/clean_tabs.ts --apply    # 执行
 *   ./node/node.exe node_modules/tsx/dist/cli.mjs scripts/clean_tabs.ts --apply --platforms=boss,liepin
 */
import http from 'node:http';

const APPLY = process.argv.includes('--apply');
const arg = (n: string) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : undefined;
};

/** 端口 → 该端点承载的平台 + 「优先保留」的 URL 关键字（列表页/首页，比岗位详情页更该留） */
const ENDPOINTS: Array<{ port: number; platforms: string[]; keepHint: string }> = [
  { port: 9223, platforms: ['boss'], keepHint: 'zhipin.com/web/geek' },
  { port: 9224, platforms: ['liepin'], keepHint: 'c.liepin.com' },
  { port: 9225, platforms: ['job51'], keepHint: '51job.com' },
  { port: 9226, platforms: ['zhilian'], keepHint: 'zhaopin.com' },
  { port: 9227, platforms: ['official', 'offerbiu'], keepHint: '' },
];

function req(method: string, url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const r = http.request(url, { method, timeout: 4000 }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve(d); } });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    r.end();
  });
}

const only = arg('platforms')?.split(',').map((s) => s.trim()).filter(Boolean);
const targets = ENDPOINTS.filter((e) => !only || e.platforms.some((p) => only.includes(p)));

let totalClosed = 0;
for (const ep of targets) {
  const base = `http://127.0.0.1:${ep.port}`;
  let pages: any[] = [];
  try {
    const list: any = await req('GET', `${base}/json/list`);
    pages = (Array.isArray(list) ? list : []).filter((t) => t.type === 'page' && t.id);
  } catch {
    console.log(`\n[${ep.port} ${ep.platforms.join('/')}] 未启动或无响应，跳过`);
    continue;
  }
  if (!pages.length) { console.log(`\n[${ep.port} ${ep.platforms.join('/')}] 无标签页，跳过`); continue; }

  // 保留策略（按优先级）：keepHint 命中 → 非详情页 → 非空白页 → 第一个
  // （空白页/about:blank 最该被关掉，不能让 it 当 keeper）
  const hint = ep.keepHint;
  const isDetail = (u: string) => /job_detail|\/lptjob\/|jobs\.51job\.com\/[^/]+\/[^/]+\.html|jobdetail\//.test(u);
  const isBlank = (u: string) => !u || u === 'about:blank' || /^chrome/i.test(u);
  const keeper =
    (hint ? pages.find((t) => String(t.url).includes(hint)) : undefined) ||
    pages.find((t) => !isDetail(String(t.url)) && !isBlank(String(t.url))) ||
    pages.find((t) => !isBlank(String(t.url))) ||
    pages[0];
  const victims = pages.filter((t) => t.id !== keeper.id);

  console.log(`\n[${ep.port} ${ep.platforms.join('/')}] 共 ${pages.length} 个标签，保留 1 个，待关 ${victims.length} 个`);
  console.log(`  保留: ${String(keeper.url).slice(0, 90)}`);
  for (const v of victims.slice(0, 6)) console.log(`  关闭: ${String(v.url).slice(0, 90)}`);
  if (victims.length > 6) console.log(`  …（其余 ${victims.length - 6} 个略）`);

  if (!APPLY) continue;
  let closed = 0;
  for (const v of victims) {
    try { await req('GET', `${base}/json/close/${v.id}`); closed++; } catch { /* 单个失败不影响整体 */ }
  }
  totalClosed += closed;
  console.log(`  ✅ 已关闭 ${closed} 个`);
}

console.log(`\n══════ 汇总 ══════`);
if (APPLY) console.log(`  共关闭 ${totalClosed} 个标签页`);
else console.log(`  这是 dry-run（未关闭任何标签）。加 --apply 执行。`);
