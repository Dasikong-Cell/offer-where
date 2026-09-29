/**
 * 小程序契约实测。
 *
 * 目的：小程序静态自检只能证明「文件之间自洽」，**证明不了「后端真的会这样回」**。
 * 本脚本用 Node 起一个后端，然后按小程序 utils/request.js 的**同样方式**发请求
 * （同样的路径、同样的头、同样的鉴权假设），核对返回结构是否与小程序页面读的字段一致。
 *
 * 这是必要的，因为小程序页面里有大量 `funnel.byStatus.applied` / `trend.items[].count`
 * 这类**深层字段读取**：字段名写错时小程序不会报错，只会渲染成空白 —— 最难发现的一类 bug。
 *
 * 用法：node --import tsx scripts/_mp_api_probe.mts
 * 注意：必须在**同一条命令**里起服务 + 测试 + 收尾 —— 沙箱会在命令结束时回收整棵进程树。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 4400;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
const fails = [];

function check(name, ok, detail = '') {
  if (ok) pass++;
  else { fail++; fails.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** 读取后端自己生成的令牌，模拟「用户从 data/.auth_token 复制」这一步。 */
function readToken() {
  const p = path.join(ROOT, 'data', '.auth_token');
  try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; }
}

/**
 * 按小程序的方式请求：所有方法都带 X-Auth-Token。
 * method=GET 时 data 走 query（与 request.js 的 serializeQuery 行为一致）。
 */
async function req(pathname, { method = 'GET', data, token } = {}) {
  let url = BASE + pathname;
  if (method === 'GET' && data && typeof data === 'object') {
    const qs = Object.keys(data)
      .filter((k) => data[k] !== undefined && data[k] !== null && data[k] !== '')
      .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(data[k]))
      .join('&');
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Auth-Token'] = token;
  const res = await fetch(url, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(data || {}),
  });
  let body = null;
  try { body = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, body };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(BASE + '/api/ping');
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(400);
  }
  return false;
}

async function main() {
  console.log('小程序 ↔ 后端 契约实测');
  console.log('');

  // 起后端（鉴权按 HOST 自动判定；这里用默认回环，鉴权关闭，但我们仍带令牌以验证头被接受）
  const srv = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'server/index.ts'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvOut = '';
  srv.stdout.on('data', (d) => { srvOut += d.toString(); });
  srv.stderr.on('data', (d) => { srvOut += d.toString(); });

  let ok = false;
  try {
    ok = await waitReady();
    check('后端启动并就绪', ok, ok ? '' : srvOut.slice(-800));
    if (!ok) return;

    const token = readToken();
    console.log(`  （读到令牌：${token ? token.slice(0, 8) + '…（' + token.length + ' 位）' : '无'}）`);

    // ── 1. /api/ping：连接页探活 ────────────────────────────────────────────
    const ping = await req('/api/ping', { token });
    check('/api/ping 返回 200', ping.status === 200, `status=${ping.status}`);
    check('/api/ping 有 ok 字段', ping.body && ping.body.ok === true, JSON.stringify(ping.body));
    check('/api/ping 有 uptimeMs（连接页展示）', typeof ping.body?.uptimeMs === 'number');

    // ── 2. /api/version ─────────────────────────────────────────────────────
    const ver = await req('/api/version', { token });
    check('/api/version 返回 200', ver.status === 200, `status=${ver.status}`);
    check('/api/version 有 version/commit（连接页展示）',
      !!ver.body?.version && !!ver.body?.commit, JSON.stringify(ver.body));

    // ── 3. /api/lan：连接页的地址来源 ───────────────────────────────────────
    const lan = await req('/api/lan', { token });
    check('/api/lan 返回 200', lan.status === 200, `status=${lan.status}`);
    check('/api/lan 有 urls 数组（连接页渲染芯片）', Array.isArray(lan.body?.urls));
    check('/api/lan 有 authEnabled 布尔（连接页预警）', typeof lan.body?.authEnabled === 'boolean');
    check('/api/lan 有 exposed 布尔', typeof lan.body?.exposed === 'boolean');
    check('/api/lan 不含任何令牌/秘密',
      !JSON.stringify(lan.body || {}).match(/[0-9a-f]{48}/), '返回体里出现了 48 位 hex');

    // ── 4. /api/stats/funnel：看板核心 ──────────────────────────────────────
    const fn = await req('/api/stats/funnel', { token });
    check('/api/stats/funnel 返回 200', fn.status === 200, `status=${fn.status}`);
    const b = fn.body || {};
    check('funnel 有 total', typeof b.total === 'number');
    check('funnel 有 byStatus.applied（看板「已投递」）', typeof b.byStatus?.applied === 'number');
    check('funnel 有 byStatus.candidate（看板「沟通中」）', typeof b.byStatus?.candidate === 'number');
    check('funnel 有 appliedRate', typeof b.appliedRate === 'number');
    check('funnel 有 bySource 数组', Array.isArray(b.bySource));
    if (Array.isArray(b.bySource) && b.bySource.length) {
      const s0 = b.bySource[0];
      check('bySource[].count 存在（看板来源分布读它）', typeof s0.count === 'number' || typeof s0.total === 'number',
        JSON.stringify(s0));
    }
    check('funnel 有 matchScore', !!b.matchScore);
    if (b.matchScore) {
      for (const k of ['scored', 'coverage', 'avg', 'high', 'mid', 'low', 'realJdRate']) {
        check(`matchScore.${k} 存在（看板匹配度读它）`, b.matchScore[k] !== undefined, JSON.stringify(b.matchScore));
      }
    }
    check('funnel 有 quarantined', typeof b.quarantined === 'number');

    // ── 5. /api/stats/trend：看板折线 ───────────────────────────────────────
    const tr = await req('/api/stats/trend', { token, data: { days: 7 } });
    check('/api/stats/trend 返回 200', tr.status === 200, `status=${tr.status}`);
    check('trend 有 items 数组', Array.isArray(tr.body?.items));
    check('trend 有 max（折线归一化用）', typeof tr.body?.max === 'number');
    check('trend 有 days', typeof tr.body?.days === 'number');
    if (Array.isArray(tr.body?.items) && tr.body.items.length) {
      const it = tr.body.items[0];
      check('trend.items[].date 存在', typeof it.date === 'string', JSON.stringify(it));
      check('trend.items[].count 存在', typeof it.count === 'number', JSON.stringify(it));
      check('trend.items[].date 是 YYYY-MM-DD（看板 slice(5) 取 MM-DD）',
        /^\d{4}-\d{2}-\d{2}$/.test(it.date), it.date);
    }
    check('trend 天数与请求一致', tr.body?.items?.length === 7, `items=${tr.body?.items?.length}`);

    // ── 6. /api/apply/quota：看板配额卡片 ──────────────────────────────────
    const qa = await req('/api/apply/quota', { token });
    check('/api/apply/quota 返回 200', qa.status === 200, `status=${qa.status}`);
    check('quota 有 blocked 布尔（看板据此决定是否红色告警）', typeof qa.body?.blocked === 'boolean');
    check('quota 有 unlimited 布尔', typeof qa.body?.unlimited === 'boolean');
    check('quota 有 used / limit / remaining',
      typeof qa.body?.used === 'number' && typeof qa.body?.limit === 'number' && typeof qa.body?.remaining === 'number',
      JSON.stringify(qa.body));

    // ── 7. /api/jobs：记录页 + 详情页 ───────────────────────────────────────
    //
    // ⚠️ 这段是本探针存在的最重要理由：/api/jobs 返回的是**数据库原始行**，
    // 字段名是 snake_case 且与直觉不符（position 而不是 title、apply_url 而不是 jobUrl）。
    // 曾经把小程序页面按驼峰写，结果静态检查全绿、页面却整片空白 —— 因为
    // `{{item.title}}` 取到 undefined 在 wxml 里**不报错**，静默渲染为空。
    // 所以这里逐个钉死字段名，任何一端改名都会立刻失败。
    const jobs = await req('/api/jobs', { token });
    check('/api/jobs 返回 200', jobs.status === 200, `status=${jobs.status}`);
    check('/api/jobs 有 jobs 数组（记录页读它）', Array.isArray(jobs.body?.jobs), JSON.stringify(jobs.body).slice(0, 200));
    check('/api/jobs 有 total', typeof jobs.body?.total === 'number');
    if (Array.isArray(jobs.body?.jobs) && jobs.body.jobs.length) {
      const j = jobs.body.jobs[0];
      const keys = Object.keys(j);
      // 逐个断言「页面实际读取的字段」存在
      const REQUIRED_JOB_FIELDS = [
        'id', 'source', 'company', 'position', 'city', 'status', 'created_at',
      ];
      for (const k of REQUIRED_JOB_FIELDS) {
        check(`jobs[].${k} 存在（记录页/详情页读它）`, keys.includes(k),
          `实际字段：${keys.join(', ')}`);
      }
      // 反向断言：这些是**曾经写错**的驼峰名，必须不存在，否则说明后端做了映射、
      // 而页面还在按 snake_case 读 —— 同样会白屏，只是方向相反。
      for (const wrong of ['title', 'jobUrl', 'createdAt', 'matchScore']) {
        check(`jobs[] 不含驼峰字段 ${wrong}（页面按 snake_case 读）`, !keys.includes(wrong),
          `keys=${keys.join(',')}`);
      }
      check('jobs[].id 非空（详情页跳转依赖）', j.id !== null && j.id !== undefined);
      check('jobs[].position 是字符串或 null（记录页卡片标题）',
        j.position === null || typeof j.position === 'string', typeof j.position);
      check('jobs[].status 非空（记录页状态标签据此着色）', !!j.status, String(j.status));
      // JD 字段：详情页的折叠/清理逻辑依赖它是长字符串
      check('jobs[].jd 存在（详情页正文）', 'jd' in j, keys.join(','));
      if (typeof j.jd === 'string') {
        check('jobs[].jd 足够长以验证折叠逻辑（>220 字）', j.jd.length > 220, `length=${j.jd.length}`);
      }
      // 记录页会加盐显示 company，确认它确实带采集噪音（说明 stripCompanySuffix 有用）
      const noisy = (jobs.body.jobs || []).filter((x) => /在招\s*\d+\s*个职位/.test(String(x.company || '')));
      console.log(`  （company 含「在招N个职位」噪音的记录：${noisy.length} 条 —— 记录页会清理展示）`);
    }

    // ── 7b. /api/applications：与 jobs 是不同来源，字段也是 snake_case ──────
    const apps = await req('/api/applications', { token });
    check('/api/applications 返回 200', apps.status === 200, `status=${apps.status}`);
    check('/api/applications 有 applications 数组', Array.isArray(apps.body?.applications),
      JSON.stringify(apps.body).slice(0, 200));
    if (Array.isArray(apps.body?.applications) && apps.body.applications.length) {
      const a = apps.body.applications[0];
      const akeys = Object.keys(a);
      for (const k of ['id', 'platform', 'company', 'position', 'status', 'created_at']) {
        check(`applications[].${k} 存在`, akeys.includes(k), `实际字段：${akeys.join(', ')}`);
      }
    }

    // ── 8. /api/resume/current：简历页 ─────────────────────────────────────
    const rs = await req('/api/resume/current', { token });
    check('/api/resume/current 返回 200', rs.status === 200, `status=${rs.status}`);
    check('resume 有 status 字段', rs.body?.status !== undefined, JSON.stringify(rs.body).slice(0, 200));
    check('resume 有 original 对象（简历页读 exists/size/fileName/uploadedAt）', !!rs.body?.original);
    check('resume 有 optimized 对象', !!rs.body?.optimized);
    if (rs.body?.original) {
      check('original.exists 是布尔（简历页据此显示「存在/缺失」）',
        typeof rs.body.original.exists === 'boolean', JSON.stringify(rs.body.original));
      check('original 有 fileName / size / uploadedAt 键',
        'fileName' in rs.body.original && 'size' in rs.body.original && 'uploadedAt' in rs.body.original,
        JSON.stringify(rs.body.original));
    }

    // ── 9. /api/logs/run：日志页 ───────────────────────────────────────────
    const lg = await req('/api/logs/run', { token, data: { limit: 50 } });
    check('/api/logs/run 返回 200', lg.status === 200, `status=${lg.status}`);
    check('/api/logs/run 有 lines 数组（日志页读它）', Array.isArray(lg.body?.lines), JSON.stringify(lg.body).slice(0, 200));
    check('/api/logs/run 有 dates 数组（日志页日期筛选读它）', Array.isArray(lg.body?.dates));
    check('/api/logs/run 有 total', typeof lg.body?.total === 'number');
    if (Array.isArray(lg.body?.lines) && lg.body.lines.length) {
      const l = lg.body.lines[0];
      check('lines[].ts 存在（日志页显示时间）', l.ts !== undefined, JSON.stringify(l));
      check('lines[].level 存在（日志页着色用）', l.level !== undefined, JSON.stringify(l));
      check('lines[].msg 存在', typeof l.msg === 'string', JSON.stringify(l));
    }
    // 带级别筛选
    const lgErr = await req('/api/logs/run', { token, data: { level: 'ERROR', limit: 10 } });
    check('/api/logs/run?level=ERROR 返回 200', lgErr.status === 200, `status=${lgErr.status}`);
    check('level=ERROR 结果里只有 ERROR', (lgErr.body?.lines || []).every((x) => String(x.level).toUpperCase() === 'ERROR'),
      JSON.stringify((lgErr.body?.lines || []).map((x) => x.level).slice(0, 5)));

    // ── 10. 鉴权头被接受（写方法必须带令牌）────────────────────────────────
    // 用无副作用的 PATCH 不存在的 id 来探：带令牌应得到 404/400，不带令牌在鉴权开启时才是 401。
    // 回环下鉴权关闭，所以这里只验证「带了令牌不会被拒」。
    const withToken = await req('/api/applications/__probe_nonexistent__', { method: 'PATCH', data: { status: 'applied' }, token });
    check('带 X-Auth-Token 的写请求未被 401 拒绝', withToken.status !== 401, `status=${withToken.status}`);

  } finally {
    srv.kill('SIGTERM');
    await sleep(600);
    try { srv.kill('SIGKILL'); } catch { /* ignore */ }
  }

  console.log('');
  console.log(`契约实测：通过 ${pass} / 共 ${pass + fail}`);
  if (fail) {
    console.log('');
    console.log('失败项：');
    fails.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('探针异常：', e);
  process.exit(1);
});
