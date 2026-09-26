/**
 * 一键体检：后端 / 各平台 CDP 连接 / 岗位待投量 / 邮箱配置
 *
 * 用法: tsx scripts/healthcheck.ts
 *
 * 说明：只读检查，不导航、不投递。若发现窗口掉线，会提示运行 ensure_chrome.sh。
 *      登录态检测请用专门的 scripts/check_logins.ts（会打开页面，有副作用）。
 */
const API = 'http://127.0.0.1:4400';
const PLATFORMS = ['boss', 'liepin', 'job51', 'zhilian'];

(async () => {
  console.log('========== 投递系统体检 ==========\n');

  // 1) 后端
  let backendOk = false;
  try {
    const r = await fetch(`${API}/api/health`);
    const h: any = await r.json();
    backendOk = h?.status === 'ok';
    console.log(`[后端] ${backendOk ? '在线' : '异常'} ${backendOk ? `(AI=${h.ai ? '已启用' : '未启用'})` : JSON.stringify(h).slice(0, 80)}`);
  } catch (e: any) {
    console.log(`[后端] 无法连接 ${API} —— ${e?.message || e}`);
    console.log('\n请先启动后端：PORT=4400 tsx server/index.ts（或双击桌面「OfferWhere」）');
    return;
  }
  if (!backendOk) return;

  // 2) 浏览器连接
  console.log('\n[浏览器窗口]');
  let offline: string[] = [];
  try {
    const r = await fetch(`${API}/api/browser/connections`);
    const body: any = await r.json();
    const conns = body.connections || {};
    for (const p of PLATFORMS) {
      const c = conns[p];
      if (!c) { console.log(` - ${p}: 未配置`); continue; }
      if (c.connected) console.log(` - ${p}: 在线 (${c.browser || ''})`);
      else { console.log(` - ${p}: 离线 (${c.error || '未知'})`); offline.push(p); }
    }
  } catch (e: any) {
    console.log(` - 读取失败：${e?.message || e}`);
  }

  // offerbiu 走 official(9227)，单独提示
  try {
    const r = await fetch('http://127.0.0.1:9227/json/version');
    if (r.ok) console.log(' - official(9227，offerbiu 用): 在线');
    else console.log(' - official(9227，offerbiu 用): 离线');
  } catch {
    console.log(' - official(9227，offerbiu 用): 离线');
  }

  // 3) 岗位待投量
  console.log('\n[岗位池]');
  try {
    const r = await fetch(`${API}/api/jobs`);
    const body: any = await r.json();
    const jobs: any[] = body.jobs || body || [];
    const bySrc = new Map<string, { total: number; pending: number; applied: number }>();
    for (const j of jobs) {
      const s = j.source || 'unknown';
      const cur = bySrc.get(s) || { total: 0, pending: 0, applied: 0 };
      cur.total++;
      if (j.status === 'candidate' || j.status === 'pending') cur.pending++;
      if (j.status === 'applied') cur.applied++;
      bySrc.set(s, cur);
    }
    for (const [s, v] of bySrc) {
      console.log(` - ${s}: 总 ${v.total} | 待投 ${v.pending} | 已投 ${v.applied}`);
    }
  } catch (e: any) {
    console.log(` - 读取失败：${e?.message || e}`);
  }

  // 4) 邮箱配置
  console.log('\n[邮箱配置]');
  try {
    const r = await fetch(`${API}/api/mail/config`);
    const body: any = await r.json();
    const c = body.config || {};
    console.log(` - 邮箱：${c.email || '(未设置)'} | 授权码：${c.hasAuthCode ? '已配置' : '未配置'}`);
    if (!c.hasAuthCode) console.log('   → 未配置授权码时，官网验证码登录与邮件投递都会失败');
  } catch (e: any) {
    console.log(` - 读取失败：${e?.message || e}`);
  }

  // 5) 建议
  console.log('\n[建议]');
  if (offline.length) {
    console.log(` - 有窗口离线（${offline.join(', ')}），运行：bash ensure_chrome.sh`);
  } else {
    console.log(' - 窗口均在线');
  }
  console.log(' - 检查各平台登录态：tsx scripts/check_logins.ts');
  console.log('========== 体检结束 ==========');
})();
