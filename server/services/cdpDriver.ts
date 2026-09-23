/**
 * 裸 CDP 浏览器驱动（用于 BOSS/猎聘 等强反爬站点）
 *
 * 根因（经逐步验证确定）：
 *  BOSS直聘 / 猎聘 会检测 CDP 的 `Runtime.enable` 命令（即启用 Runtime 事件通知），
 *  命中后数秒内把页面 `location.href = 'about:blank'`（表现为空白页）。
 *  关键发现：`Runtime.evaluate` 命令本身无需先 `Runtime.enable` 即可执行，
 *  且**不会**触发该检测。因此本驱动只开启 `Page` 域，所有 JS 交互一律通过
 *  `Runtime.evaluate` 命令完成，页面得以稳定渲染（已实测连续 25s+ 不空白）。
 *  `Runtime.enable` / `Debugger` / `Profiler` / `Network` / `DOM` / `Input` 域
 *  均不开（DOM 仅在 upload 时按需瞬时开启，用完即弃）。
 *
 * 本驱动与 browser.execAction 保持同一返回结构（BrowserActionResult），
 * 作为 cdp.json 中配置平台（boss / liepin）的替代实现，对投递引擎透明。
 */
import WebSocket from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ensureHealthy } from './browserHealth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_ROOT = path.join(__dirname, '..', '..', 'data', 'browser');
const SHOT_DIR = path.join(__dirname, '..', '..', 'data', 'screenshots');

export interface BrowserActionResult {
  ok: boolean;
  url?: string;
  title?: string;
  text?: string;
  html?: string;
  data?: unknown;
  screenshot?: string;
  error?: string;
  hint?: string;
}

interface PageSession {
  platform: string;
  ws: WebSocket;
  nextId: number;
  pending: Map<number, { res: (v: any) => void; rej: (e: any) => void }>;
  loadWaiters: Array<() => void>;
  createdAt: number;
  dead?: boolean;
  /** 该会话绑定的 CDP 目标 id：用于 adoptPopup 识别「新弹出的标签」 */
  targetId?: string;
}

const sessions = new Map<string, PageSession>();

/** 已做过「清理空白标签」的端点集合（每个 CDP 端点只清一次，避免每次建会话都扫一遍） */
const cleanedEndpoints = new Set<string>();

/**
 * 清理 Chrome 启动残留的空白标签（about:blank / chrome://newtab/）。
 * 这些标签与平台投递标签挤在同一个真实 Chrome 窗口里，既占位置又容易让用户找错页面。
 * 在首次接触某端点时调用一次。
 */
async function closeStrayBlankTabs(endpoint: string): Promise<void> {
  if (cleanedEndpoints.has(endpoint)) return;
  cleanedEndpoints.add(endpoint);
  try {
    const ver: any = await httpReq('GET', `${endpoint}/json/version`);
    if (!ver?.webSocketDebuggerUrl) return;
    const ws = await connect(ver.webSocketDebuggerUrl);
    const bs = attachSession(ws, '__browser__');
    const { targetInfos } = await send(bs, 'Target.getTargets');
    // ⚠️ 关键保护：绝不能把窗口的页面标签清空 —— 关掉最后一个标签会让整个 Chrome 进程退出，
    // 后续所有 CDP 调用都会 ECONNREFUSED（实测踩过：只剩空白标签时清理直接杀了 Chrome）。
    const pages: any[] = (targetInfos || []).filter((t: any) => t.type === 'page');
    let remaining = pages.length;
    const isBlank = (t: any) => t.url === 'about:blank' || t.url === 'chrome://newtab/' || t.url === '';
    for (const t of pages) {
      if (isBlank(t)) {
        if (remaining <= 1) continue; // 保留最后一个（哪怕是空白）
        try { await send(bs, 'Target.closeTarget', { targetId: t.targetId }); remaining--; } catch { /* 忽略 */ }
      } else if (t.webSocketDebuggerUrl) {
        // 2026-09-12 反检测：首次接触端点时，给每个已有页面标签（含「养熟」标签）
        // 注入 anti-bot 脚本，无需重建标签即可抹掉自动化特征。
        try {
          const tws = await connect(t.webSocketDebuggerUrl);
          const ts = attachSession(tws, '__stealth__');
          await send(ts, 'Page.enable');
          await send(ts, 'Page.addScriptToEvaluateOnNewDocument', { source: STEALTH_SRC });
          try { tws.close(); } catch { /* 忽略 */ }
        } catch { /* 忽略 */ }
      }
    }
    try { ws.close(); } catch { /* 忽略 */ }
  } catch {
    // 清理失败不影响投递
  }
}

/** 在页面上下文中查找元素的函数源码（按 selector / role+name / text 三种方式） */
const FIND_EL_SRC = `
function __findEl(opts){
  opts = opts || {};
  function norm(s){ return (s||'').replace(/\\s+/g,' ').trim(); }
  if (opts.selector) { return document.querySelector(opts.selector); }
  if (opts.role) {
    var cand = Array.prototype.slice.call(document.querySelectorAll('[role="'+opts.role+'"]'));
    if (opts.name) {
      cand = cand.filter(function(n){ return norm(n.innerText).indexOf(opts.name)>=0 || (n.getAttribute('aria-label')||'').indexOf(opts.name)>=0; });
    }
    return cand[opts.index||0] || null;
  }
  if (opts.text) {
    var t = opts.text;
    function __vis(el){ if(!el) return false; if(el.offsetParent===null && el.getClientRects().length===0) return false; try{ var s=getComputedStyle(el); return s.display!=='none' && s.visibility!=='hidden' && s.opacity!=='0'; }catch(e){ return true; } }
    function __clickable(el){ if(!el) return false; var tag=el.tagName; if(tag==='BUTTON' || tag==='A' || tag==='INPUT') return true; var r=el.getAttribute('role'); if(r==='button' || r==='link') return true; if(el.onclick || el.getAttribute('onclick')) return true; return false; }
    // 1) 优先在显式可交互元素中匹配
    var interactive = 'button, a[href], [role="button"], input[type="button"], input[type="submit"], [role="link"]'
    var nodes = Array.prototype.slice.call(document.querySelectorAll(interactive)).filter(function(n){ return norm(n.innerText).indexOf(t)>=0 || (n.getAttribute('aria-label')||'').indexOf(t)>=0 || (n.title||'').indexOf(t)>=0; });
    var visNodes = nodes.filter(__vis);
    if (visNodes.length) return visNodes[opts.index||0];
    if (nodes.length) return nodes[opts.index||0];
    // 2) BOSS 等站点按钮常是 div/span 并带点击事件，未声明 role；在可见元素中回退查找
    var broad = Array.prototype.slice.call(document.querySelectorAll('div, span, a, button, [role="button"], [role="link"]')).filter(function(n){ return norm(n.innerText).indexOf(t)>=0 && __vis(n); });
    if (broad.length) {
      // 优先可点击（含子节点 button/a 也算）
      var clickables = broad.filter(__clickable);
      if (clickables.length) return clickables[opts.index||0];
      // 否则找尺寸最大、最可能是按钮的那个
      return broad.sort(function(a,b){ var ar=a.getBoundingClientRect(), br=b.getBoundingClientRect(); return (br.width*br.height)-(ar.width*ar.height); })[opts.index||0];
    }
    // 3) 叶子节点精确/部分匹配
    var exact = Array.prototype.slice.call(document.querySelectorAll('*')).filter(function(n){ return n.children && n.children.length===0 && norm(n.innerText)===t; });
    if (exact.length) return exact[opts.index||0];
    var partial = Array.prototype.slice.call(document.querySelectorAll('*')).filter(function(n){ return n.children && n.children.length===0 && norm(n.innerText).indexOf(t)>=0; });
    return partial.length ? partial[opts.index||0] : null;
  }
  return null;
}
`;

/**
 * 反检测注入脚本（在页面 document_start 阶段执行，早于站点自身脚本）。
 * 仅用 Page 域的 addScriptToEvaluateOnNewDocument 注册，不开启 Runtime.enable，
 * 因此不会触发 BOSS/猎聘对 Runtime.enable 的检测。
 * 作用：
 *  - 抹掉 Chrome 调试器注入的 cdc_ 变量（经典自动化指纹）
 *  - 强制 navigator.webdriver = false（配合启动参数 AutomationControlled 双保险）
 *  - 移除常见自动化全局标记（__nightmare / __puppeteer_* 等）
 *  - 补全 window.chrome.runtime 桩，避免部分站点据此判定为非真实浏览器
 * 注意：刻意不伪造 navigator.plugins / languages（伪造错误结构反而更可疑）。
 */
const STEALTH_SRC = `
(function () {
  'use strict';
  try {
    var keys = Object.getOwnPropertyNames(window);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k.indexOf('cdc_') === 0 || k.indexOf('$cdc_') === 0) { try { delete window[k]; } catch (e) {} }
    }
  } catch (e) {}
  try {
    var navProto = Object.getPrototypeOf(navigator);
    Object.defineProperty(navProto || navigator, 'webdriver', { get: function () { return false; }, configurable: true });
  } catch (e) {
    try { Object.defineProperty(navigator, 'webdriver', { get: function () { return false; }, configurable: true }); } catch (e2) {}
  }
  try {
    ['__nightmare','__puppeteer_evaluation_script__','__webdriver_evaluate__','__driver_evaluate__','__selenium_evaluate__','__fxdriver_evaluate__','_Selenium_IDE_Recorder'].forEach(function (m) {
      try { delete window[m]; } catch (e) {}
    });
  } catch (e) {}
  try {
    if (!window.chrome) { window.chrome = {}; }
    if (!window.chrome.runtime) {
      window.chrome.runtime = {
        connect: function () { return { onDisconnect: { addListener: function () {}, removeListener: function () {} }, onMessage: { addListener: function () {}, removeListener: function () {} }, postMessage: function () {} }; },
        sendMessage: function () {},
        onMessage: { addListener: function () {}, removeListener: function () {} },
        getManifest: function () { return {}; },
        getURL: function () { return ''; }
      };
    }
  } catch (e) {}
})();
`;

/** 给某个已连接的页面会话注入反检测脚本（幂等：重复调用只会多注册一份，无害） */
async function installStealth(s: PageSession): Promise<void> {
  try {
    await send(s, 'Page.addScriptToEvaluateOnNewDocument', { source: STEALTH_SRC });
  } catch {
    // 注入失败不影响主流程（极少发生）
  }
}

function httpReq(method: string, url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, res => {
      let d = '';
      res.on('data', c => (d += c));
      res.on('end', () => {
        try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(new Error('bad json: ' + d.slice(0, 120))); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function connect(wsUrl: string, timeoutMs = 8000): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    // 握手也要有超时：目标标签若处于半死状态，'open' 可能永远不触发，
    // 早期实现会在这里无限挂起（表现为整条链路"卡住"却没有任何报错）。
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* ignore */ }
      reject(new Error(`CDP WebSocket 握手超时（${timeoutMs}ms）：${wsUrl.slice(-40)}`));
    }, timeoutMs);
    ws.on('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
  });
}

/**
 * 探测标签的「渲染进程是否还活着」。
 *
 * 背景（实测）：BOSS 的聊天页长时间挂机后会变成**僵尸标签** ——
 * 浏览器进程级命令正常（`Page.getNavigationHistory` 秒回），
 * 但所有渲染进程级命令（`Runtime.evaluate` / `Page.enable` / `DOM.getDocument`）全部超时。
 * 此时若直接接管，之后每条命令都要白等 25s 才失败，整批投递看起来就是"卡住、投出 0 个"。
 *
 * 判定方式：发一条极轻量的 `Runtime.evaluate`，短超时内收到应答即视为存活。
 * 实现上只用一个 `settled` 标志收敛结果，不依赖 `ws.off()`（不同 ws 版本/类型定义不一致）。
 */
function probeRendererAlive(ws: WebSocket, timeoutMs = 3500): Promise<boolean> {
  return new Promise((resolve) => {
    const id = Math.floor(Math.random() * 1e9);
    let settled = false;
    const done = (v: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const onMsg = (raw: WebSocket.RawData) => {
      let m: any;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.id === id) done(true);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    ws.on('message', onMsg);
    try {
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: '1', returnByValue: true } }));
    } catch {
      done(false);
    }
  });
}

/** 临时连一下目标标签探测存活；无论结果如何都会释放这条临时连接 */
async function targetRendererAlive(
  target: { id: string; webSocketDebuggerUrl: string },
  timeoutMs = 3500,
): Promise<boolean> {
  let ws: WebSocket | undefined;
  try {
    ws = await connect(target.webSocketDebuggerUrl, timeoutMs);
    return await probeRendererAlive(ws, timeoutMs);
  } catch {
    return false;
  } finally {
    try { ws?.close(); } catch { /* ignore */ }
  }
}

/** 关闭指定标签（失败忽略）。⚠️ 不要关闭端点下最后一个标签，否则 Chrome 会退出。 */
async function closeTarget(endpoint: string, targetId: string): Promise<void> {
  try { await httpReq('GET', `${endpoint}/json/close/${targetId}`); } catch { /* ignore */ }
}

function attachSession(ws: WebSocket, platform: string): PageSession {
  const s: PageSession = { platform, ws, nextId: 0, pending: new Map(), loadWaiters: [], createdAt: Date.now() };
  ws.on('message', async (data: WebSocket.RawData) => {
    let msg: any;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.id && s.pending.has(msg.id)) {
      const p = s.pending.get(msg.id)!;
      s.pending.delete(msg.id);
      if (msg.error) p.rej(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.res(msg.result);
    } else if (msg.method === 'Page.loadEventFired') {
      const ws2 = s.loadWaiters.splice(0);
      ws2.forEach(fn => { try { fn(); } catch { /* ignore */ } });
    } else if (msg.method === 'Page.javascriptDialogOpening') {
      // BOSS/猎聘 在投递过程中可能弹出原生 JS 对话框（beforeunload 离开确认、
      // alert 提示、confirm 二次确认等）。这类对话框会阻塞页面、使脚本卡住，
      // 且用户在屏幕上能看到「弹出窗口」无人点击。这里一律自动确认（accept），
      // 让自动化不被阻塞；同时打印日志便于排查具体弹了什么。
      //   accept=true 语义：alert→关闭；confirm→点「确定/是」；
      //   beforeunload→确认离开（导航放行）；prompt→以空值确认。
      const dlg = (msg.params || {}) as { type?: string; message?: string; url?: string };
      console.log(`[CDP ${platform}] 自动处理原生对话框: type=${dlg.type || '?'} message="${(dlg.message || '').slice(0, 200)}" url=${dlg.url || ''}`);
      try { await send(s, 'Page.handleJavaScriptDialog', { accept: true }); } catch { /* 忽略 */ }
    }
  });
  ws.on('error', (err: Error) => {
    console.error(`[CDP ${platform}] WebSocket error:`, err?.message || err);
    s.dead = true;
    for (const [, p] of s.pending) { try { p.rej(err); } catch { /* ignore */ } }
    s.pending.clear();
  });
  ws.on('close', () => { s.dead = true; });
  return s;
}

function send(s: PageSession, method: string, params: any = {}, timeoutMs = 25000): Promise<any> {
  const id = ++s.nextId;
  return new Promise((res, rej) => {
    const timer = setTimeout(() => {
      if (s.pending.has(id)) {
        s.pending.delete(id);
        s.dead = true; // 标记会话失效，下次调用重建
        rej(new Error(`CDP 命令超时（${method}），疑似页面上下文被反爬销毁`));
      }
    }, timeoutMs);
    s.pending.set(id, {
      res: (v: any) => { clearTimeout(timer); res(v); },
      rej: (e: any) => { clearTimeout(timer); rej(e); },
    });
    try { s.ws.send(JSON.stringify({ id, method, params })); }
    catch (e) { clearTimeout(timer); rej(e); }
  });
}

function waitForLoad(s: PageSession, timeout: number): Promise<void> {
  return new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const t = setTimeout(finish, timeout);
    s.loadWaiters.push(() => { clearTimeout(t); finish(); });
    // 兜底：若 loadEventFired 未触发（SPA 等），最长等待 timeout
  });
}

async function ensureSession(platform: string, endpoint: string): Promise<PageSession> {
  // 首次接触该端点时，清理 Chrome 启动残留的空白标签，避免与平台标签挤在一个窗口
  await closeStrayBlankTabs(endpoint);

  const existing = sessions.get(platform);
  if (existing && !existing.dead && existing.ws.readyState === WebSocket.OPEN) {
    try {
      // 短超时（3.5s）探活：僵尸标签在这里就能被快速识别并丢弃，
      // 而不是让后续每条业务命令都白等 25s。
      await send(existing, 'Runtime.evaluate', { expression: '1', returnByValue: true }, 3500);
      // ⚠️ 这里**绝不能**调用 Page.bringToFront：本函数是每一次浏览器动作（click/fill/
      // eval/screenshot…）的公共入口，一旦置顶，用户刚最小化的窗口会在下一个动作被立刻
      // 弹回来，表现为「点了最小化没用、窗口又自己弹出来」。
      // 自动化在后台标签同样能正常执行（Runtime.evaluate / 点击 / 截图 均不受前台与否影响），
      // 确实需要展示给用户的场景（如登录页要人工过验证），由调用方显式使用 'bringToFront' 动作。
      return existing;
    }
    catch { sessions.delete(platform); }
  }
  if (existing && existing.dead) { try { existing.ws.close(); } catch { /* ignore */ } sessions.delete(platform); }

  // ── 优先「接管已有标签」，而不是无脑新建 ─────────────────────────────
  // 旧实现在会话失效时无条件 `PUT /json/new`，而会话**经常**失效
  // （任何 CDP 命令超时都会把 s.dead 置真，见 send 的超时分支），
  // 于是每投一个岗位就泄漏一个停在 job_detail 的标签 —— 实测 9223 堆到 16 个。
  // 现在按优先级复用：
  //   ① 上次该平台用过的那个 targetId 还在 → 直接接管（页面状态都还在，最理想）
  //   ② 有「同主机名」的真实页面 → 接管
  //   ③ 该端点下只有一个真实页面 → 接管
  //   ④ 都没有 → 才新建
  // ⚠️ 不直接用「任意第一个页面」：一个端点会承载多个平台（boss/bosschat 共用 9223，
  //    official/offerbiu 共用 9227），随便接管会把别人的标签抢走、两个平台互相踩。
  const remembered = lastTarget.get(platform);
  const candidates = await listPageTargets(endpoint);
  const sameHost = (url: string, host: string): boolean => {
    try {
      const h = new URL(url).hostname;
      return h === host || h.endsWith('.' + host) || host.endsWith('.' + h);
    } catch { return false; }
  };
  const picked0 =
    (remembered?.id ? candidates.find((t) => t.id === remembered.id) : undefined) ||
    (remembered?.host ? candidates.find((t) => sameHost(t.url, remembered.host!)) : undefined) ||
    (candidates.length === 1 ? candidates[0] : undefined);

  // ── 僵尸标签检测（实测修复）─────────────────────────────────────────
  // 挑中的标签可能是个"僵尸"：渲染进程已死，浏览器进程仍把它列在 /json/list 里。
  // 直接接管 → 之后每条命令都要等到超时（25s）才失败，整批投递表现为"卡住、投出 0 个"。
  // 这里先花最多 3.5s 探一次；是僵尸就关掉它并改走"新建标签"分支。
  let picked = picked0;
  if (picked) {
    const alive = await targetRendererAlive(picked);
    if (!alive) {
      console.log(`[CDP] 检测到僵尸标签（渲染进程无响应），已关闭并改用新标签：${String(picked.url).slice(0, 60)}`);
      // 只在端点下不止这一个标签时才关，避免把 Chrome 关掉
      if (candidates.length > 1) await closeTarget(endpoint, picked.id);
      if (lastTarget.get(platform)?.id === picked.id) lastTarget.delete(platform);
      picked = undefined;
    }
  }

  let target: any;
  if (picked) {
    target = picked;
  } else {
    // 都没有才在真实 Chrome 中新建标签（绝不使用 Playwright connectOverCDP：会开启 Debugger 域触发反爬）
    try {
      target = await httpReq('PUT', `${endpoint}/json/new?about:blank`);
    } catch (e: any) {
      throw new Error(`CDP 新建标签页失败（${endpoint}）：${e?.message || e}。请确认真实 Chrome 以 --remote-debugging-port=9222 启动。`);
    }
  }
  const ws = await connect(target.webSocketDebuggerUrl);
  const s = attachSession(ws, platform);
  s.targetId = target.id;
  // 记住「本次接管/新建的是哪个标签」，供下次会话失效时复用
  lastTarget.set(platform, { id: target.id, host: remembered?.host });
  // 关键：只开 Page 域，绝不开 Runtime.enable。
  // 实测证据：BOSS直聘/猎聘 会检测 `Runtime.enable`（启用 Runtime 事件通知），
  // 命中后数秒内把页面 navigate 回 about:blank（表现为空白页）。
  // 但 `Runtime.evaluate` 命令本身无需 enable 即可执行，且不会触发该检测 ——
  // 因此所有 JS 交互（click/fill/eval/screenshot 等）照常通过 Runtime.evaluate 完成，
  // 页面保持正常渲染。Page 域用于导航与 loadEventFired 等待。
  //
  // ⚠️ Page.enable 为**软步骤**：它只是启用导航类事件通知，失败不影响 click/fill/eval。
  // 早期实现让它继承 25s 超时且失败即抛 → 一个慢页面就会让整条链路失败，
  // 并顺带把会话标记 dead（下次又要重建标签）。现在短超时 + 容忍失败。
  await send(s, 'Page.enable', {}, 6000).catch(() => { /* 软失败：不阻断 */ });
  // 2026-09-12 反检测：新标签注入 anti-bot 脚本（Page 域，不触发 Runtime.enable 检测）
  await installStealth(s);
  // 接管后做一次轻量存活校验：若这里就无响应，说明标签本身就是坏的，
  // 如实报出来（而不是等到业务动作里以"超时"的形式暴露，让人误判成业务问题）。
  const ok = await probeRendererAlive(ws, 5000);
  if (!ok) {
    try { ws.close(); } catch { /* ignore */ }
    sessions.delete(platform);
    throw new Error(`CDP 标签无响应（渲染进程未就绪）：${endpoint}。请在浏览器里手动刷新该平台页面，或关掉该标签后重试。`);
  }
  // 新标签不再自动置顶：置顶会把用户已最小化的窗口重新弹出（同上）。
  // 需要展示给用户的场景请显式调用 'bringToFront' 动作。
  sessions.set(platform, s);
  return s;
}

async function okResult(s: PageSession): Promise<BrowserActionResult> {
  try {
    const r = await send(s, 'Runtime.evaluate', {
      expression: 'JSON.stringify({url: location.href, title: document.title})',
      returnByValue: true,
    });
    const v = JSON.parse(r.result.value);
    // 记录该平台会话最后停留的「主机名」，供会话失效后复用同域标签（见 ensureSession）
    if (v?.url) rememberHost(s.platform, v.url);
    return { ok: true, url: v.url, title: v.title };
  } catch {
    return { ok: true };
  }
}

/**
 * 「上一次用过的标签」记忆（**跨会话失效保留**）。
 *
 * 为什么需要：`sessions` 会因 CDP 命令超时被标记 dead（见 send 的超时分支），
 * 而旧实现里 dead 之后 `ensureSession` 会**无条件新建标签** ——
 * 于是每投一个岗位就泄漏一个停在 job_detail 的标签（实测 9223 堆了 16 个）。
 * 把「上次的 targetId + 主机名」单独记在这里，会话失效后就能**重新接管原标签**而不是再开一个。
 */
const lastTarget = new Map<string, { id?: string; host?: string }>();

function rememberHost(platform: string, url: string): void {
  try {
    const host = new URL(url).hostname;
    const prev = lastTarget.get(platform) || {};
    lastTarget.set(platform, { id: prev.id, host });
  } catch { /* 非 http(s) URL 忽略 */ }
}

/**
 * 列出端点下所有「真实页面」标签（排除空白页）。
 * ⚠️ 必须重试：`/json/list` 偶发失败时会返回空数组，而空数组会让调用方
 * 「以为没有可复用的标签」→ 又去新建一个，重新走上泄漏老路（实测踩到：
 * 清理后 9227 只剩 1 个标签，一次失败后就变成了 2 个）。
 */
async function listPageTargets(endpoint: string): Promise<Array<{ id: string; url: string; title?: string; webSocketDebuggerUrl: string }>> {
  const pick = (list: any) => {
    const arr: any[] = Array.isArray(list) ? list : [];
    return arr.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl && t.id && t.url && t.url !== 'about:blank' && !/^chrome/i.test(t.url));
  };
  for (let i = 0; i < 2; i++) {
    const list: any = await httpReq('GET', `${endpoint}/json/list`).catch(() => null);
    if (Array.isArray(list)) return pick(list);
    if (i === 0) await new Promise((r) => setTimeout(r, 300));
  }
  return [];
}

/** 把某平台的会话重新绑定到一个**已存在**的标签上（不新建标签） */
async function rebindTo(endpoint: string, platform: string, target: any): Promise<BrowserActionResult> {
  try {
    const ws = await connect(target.webSocketDebuggerUrl);
    const s = attachSession(ws, platform);
    s.targetId = target.id;
    await send(s, 'Page.enable');
    await installStealth(s);
    sessions.set(platform, s);
    rememberHost(platform, target.url || '');
    lastTarget.set(platform, { id: target.id, host: lastTarget.get(platform)?.host });
    return await okResult(s);
  } catch (error: any) {
    return { ok: false, error: `重新绑定标签失败：${error?.message || error}` };
  }
}

/** 在页面内查找元素并执行动作（click / 设置值 / focus），返回执行结果 */
async function actInPage(s: PageSession, action: 'click' | 'fill' | 'focus', args: Record<string, any>): Promise<BrowserActionResult> {
  const a = JSON.stringify(args);
  if (action === 'click') {
    const expr = `(function(){ ${FIND_EL_SRC} const el = __findEl(${a}); if(!el) return JSON.stringify({found:false}); try { el.click(); } catch(e){ return JSON.stringify({found:true, err: String(e)}); } return JSON.stringify({found:true, tag: el.tagName}); })()`;
    const r = await send(s, 'Runtime.evaluate', { expression: expr, returnByValue: true });
    const v = JSON.parse(r.result.value);
    if (!v.found) return { ok: false, error: `未找到可点击元素：${args.text || args.selector || args.role || ''}` };
    return { ...(await okResult(s)), error: v.err };
  }
  if (action === 'fill') {
    const expr = `(function(){ ${FIND_EL_SRC} const el = __findEl(${a}); if(!el) return JSON.stringify({found:false});
      try {
        if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
          var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          setter.call(el, ${JSON.stringify(args.value)});
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (el.isContentEditable) {
          el.innerText = ${JSON.stringify(args.value)};
          el.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          el.value = ${JSON.stringify(args.value)};
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return JSON.stringify({found:true});
      } catch(e){ return JSON.stringify({found:true, err:String(e)}); }
    })()`;
    const r = await send(s, 'Runtime.evaluate', { expression: expr, returnByValue: true });
    const v = JSON.parse(r.result.value);
    if (!v.found) return { ok: false, error: `未找到输入框：${args.selector || ''}` };
    return { ...(await okResult(s)), error: v.err };
  }
  if (action === 'focus') {
    const expr = `(function(){ ${FIND_EL_SRC} const el = __findEl(${a}); if(!el) return JSON.stringify({found:false}); el.focus(); return JSON.stringify({found:true}); })()`;
    const r = await send(s, 'Runtime.evaluate', { expression: expr, returnByValue: true });
    const v = JSON.parse(r.result.value);
    if (!v.found) return { ok: false, error: `未找到元素：${args.selector || args.text || ''}` };
    return await okResult(s);
  }
  return { ok: false, error: 'unknown act' };
}

async function waitForElement(s: PageSession, args: Record<string, any>, timeout: number): Promise<boolean> {
  const a = JSON.stringify(args);
  const expr = `(function(){ ${FIND_EL_SRC} return !!__findEl(${a}); })()`;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const r = await send(s, 'Runtime.evaluate', { expression: expr, returnByValue: true });
      if (r.result && r.result.value === true) return true;
    } catch { /* ignore */ }
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

export async function execCdpAction(
  platform: string,
  action: string,
  args: Record<string, any> = {},
  endpoint?: string,
): Promise<BrowserActionResult> {
  try {
    const ep = endpoint || 'http://127.0.0.1:9222';
    // 自愈：端口挂了（窗口崩溃）先按原 profile 拉起再行动，避免整批 need_manual。
    await ensureHealthy(ep);
    const s = await ensureSession(platform, ep);

    switch (action) {
      case 'navigate':
      case 'goto': {
        if (!args.url) throw new Error('navigate 需要 url 参数');
        let last: BrowserActionResult = { ok: true };
        const maxRetry = 3;
        for (let i = 0; i < maxRetry; i++) {
          await send(s, 'Page.navigate', { url: args.url });
          await waitForLoad(s, args.timeout || 30000);
          // BOSS/猎聘 概率性反爬：命中后把页面清空为 about:blank，需重试导航
          const check = await okResult(s);
          last = check;
          if (check.url && check.url !== 'about:blank' && (check.title || '').trim() !== '') break;
          await new Promise(r => setTimeout(r, 800));
        }
        // 导航后不再置顶（同上：避免把用户最小化的窗口弹回来）。
        // 批量投递每投一个岗位都要导航一次，若在此置顶等于每个岗位都弹一次窗口。
        return last;
      }
      case 'click': {
        const found = await waitForElement(s, args, args.timeout || 15000).catch(() => false);
        if (!found) return { ok: false, error: `未找到可点击元素：${args.text || args.selector || args.role || ''}` };
        const r = await actInPage(s, 'click', args);
        if (args.waitAfter) await new Promise(r => setTimeout(r, args.waitAfter));
        return r;
      }
      /** 真实鼠标点击（CDP Input 域）。
       *  很多站点是 React/Vue 自研组件：对 el.click() 合成事件无响应，
       *  或按钮必须带「用户激活(user activation)」才允许开新标签 ——
       *  表现为「点名点击返回 ok，但页面毫无变化」。此处派发真实鼠标事件（移动+按下+抬起）绕过。
       *  找不到元素时返回 ok:false，调用方可回退到普通 click。 */
      case 'realClick': {
        const found = await waitForElement(s, args, args.timeout || 8000).catch(() => false);
        if (!found) return { ok: false, error: `未找到可点击元素：${args.text || args.selector || args.role || ''}` };
        const ra = JSON.stringify(args);
        const rexpr = `(function(){ ${FIND_EL_SRC} const el = __findEl(${ra}); if(!el) return JSON.stringify({found:false});
          try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch(e) {}
          const rr = el.getBoundingClientRect();
          return JSON.stringify({ found: true, x: rr.left + rr.width / 2, y: rr.top + rr.height / 2 });
        })()`;
        const rr = await send(s, 'Runtime.evaluate', { expression: rexpr, returnByValue: true });
        const rv = JSON.parse(rr.result.value);
        if (!rv.found) return { ok: false, error: `未找到可点击元素：${args.text || args.selector || ''}` };
        const cx = Math.round(rv.x), cy = Math.round(rv.y);
        await send(s, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
        await send(s, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
        await send(s, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
        if (args.waitAfter) await new Promise(r2 => setTimeout(r2, args.waitAfter));
        return await okResult(s);
      }
      case 'fill': {
        if (args.value === undefined) throw new Error('fill 需要 value 参数');
        const found = await waitForElement(s, args, args.timeout || 15000).catch(() => false);
        if (!found) return { ok: false, error: `未找到输入框：${args.selector || args.text || ''}` };
        return await actInPage(s, 'fill', args);
      }
      case 'type': {
        if (args.value === undefined) throw new Error('type 需要 value 参数');
        const found = await waitForElement(s, args, args.timeout || 15000).catch(() => false);
        if (!found) return { ok: false, error: `未找到输入框：${args.selector || args.text || ''}` };
        // 原生 setter + input/change 事件写入（兼容 React/Vue 受控组件），可带逐字符延迟
        const val = JSON.stringify(args.value);
        const expr = `(function(){ ${FIND_EL_SRC} const el = __findEl(${JSON.stringify(args)}); if(!el) return JSON.stringify({found:false});
          var proto = (el.tagName==='TEXTAREA')?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
          var setter = Object.getOwnPropertyDescriptor(proto,'value').set;
          el.focus();
          setter.call(el, ${val});
          el.dispatchEvent(new Event('input',{bubbles:true}));
          el.dispatchEvent(new Event('change',{bubbles:true}));
          return JSON.stringify({found:true});
        })()`;
        await send(s, 'Runtime.evaluate', { expression: expr, returnByValue: true });
        if (args.delay) await new Promise(r => setTimeout(r, args.delay));
        return await okResult(s);
      }
      /** 拟人输入（技术债 D2，对标职得鸭 `typeSlowly`）。
       *  区别：`type` 是 JS 原生 setter 一次性赋值（`event.isTrusted === false`，
       *  且没有逐键节奏）；`typeHuman` 走 CDP Input 域派发**真实键盘事件**，
       *  `isTrusted === true`，且每字符间有随机延迟 —— 更接近真人打字。
       *
       *  参数：{ selector|text, value, minDelay=60, maxDelay=180, timeout, verify=true }
       *  安全设计：打完会**回读校验**；若受控组件没接住（值没写进去），
       *  自动回退到 `type` 的 setter 方案，避免"打了字但没进去"的静默失败。 */
      case 'typeHuman': {
        if (args.value === undefined) throw new Error('typeHuman 需要 value 参数');
        const found = await waitForElement(s, args, args.timeout || 15000).catch(() => false);
        if (!found) return { ok: false, error: `未找到输入框：${args.selector || args.text || ''}` };
        const text = String(args.value);
        const minDelay = Number(args.minDelay) || 60;
        const maxDelay = Number(args.maxDelay) || 180;

        // 1) 先真实点击聚焦（触发 focus / onFocus / 弹层，很多输入框必须"点一下"才可编辑）
        const focusExpr = `(function(){ ${FIND_EL_SRC} const el = __findEl(${JSON.stringify(args)}); if(!el) return JSON.stringify({found:false});
          try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch(e) {}
          const rr = el.getBoundingClientRect();
          return JSON.stringify({ found: true, x: rr.left + rr.width / 2, y: rr.top + rr.height / 2 });
        })()`;
        const fr: any = await send(s, 'Runtime.evaluate', { expression: focusExpr, returnByValue: true });
        const fv = JSON.parse(fr.result.value);
        if (!fv.found) return { ok: false, error: `未找到输入框：${args.selector || args.text || ''}` };
        const fx = Math.round(fv.x), fy = Math.round(fv.y);
        await send(s, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: fx, y: fy });
        await send(s, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: fx, y: fy, button: 'left', clickCount: 1 });
        await send(s, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: fx, y: fy, button: 'left', clickCount: 1 });
        await new Promise(r => setTimeout(r, 150 + Math.random() * 250));

        // 2) 逐字符派发真实键盘事件（keydown 带 text → Chrome 插入字符；再 keyup）
        for (const ch of text) {
          if (ch === '\n') {
            await send(s, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
            await send(s, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
          } else {
            await send(s, 'Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, key: ch });
            await send(s, 'Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
          }
          await new Promise(r => setTimeout(r, minDelay + Math.random() * Math.max(0, maxDelay - minDelay)));
        }
        if (args.delay) await new Promise(r => setTimeout(r, args.delay));

        // 3) 回读校验：受控组件没接住就回退到 setter 方案（保证不静默丢字）
        if (args.verify !== false) {
          const checkExpr = `(function(){ ${FIND_EL_SRC} const el = __findEl(${JSON.stringify(args)}); if(!el) return JSON.stringify({ok:false});
            var v = (el.value !== undefined && el.value !== null) ? String(el.value) : String(el.innerText || '');
            return JSON.stringify({ ok: v.length >= ${Math.min(text.length, 4)} });
          })()`;
          const cr: any = await send(s, 'Runtime.evaluate', { expression: checkExpr, returnByValue: true }).catch(() => null);
          let ok = true;
          try { ok = JSON.parse(cr?.result?.value || '{"ok":true}').ok; } catch { ok = true; }
          if (!ok) {
            const val = JSON.stringify(text);
            const fallbackExpr = `(function(){ ${FIND_EL_SRC} const el = __findEl(${JSON.stringify(args)}); if(!el) return JSON.stringify({found:false});
              el.focus();
              if (el.isContentEditable) { el.textContent = ${val}; }
              else { var proto = (el.tagName==='TEXTAREA')?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
                Object.getOwnPropertyDescriptor(proto,'value').set.call(el, ${val}); }
              el.dispatchEvent(new Event('input',{bubbles:true}));
              el.dispatchEvent(new Event('change',{bubbles:true}));
              return JSON.stringify({found:true});
            })()`;
            await send(s, 'Runtime.evaluate', { expression: fallbackExpr, returnByValue: true });
            const res = await okResult(s);
            return { ...res, data: { typed: 'fallback-setter' } };
          }
          const res = await okResult(s);
          return { ...res, data: { typed: 'human', chars: text.length } };
        }
        return await okResult(s);
      }
      case 'press': {
        if (!args.key) throw new Error('press 需要 key 参数');
        const expr = `(function(){
          function fire(type){ var e = new KeyboardEvent(type, { key:${JSON.stringify(args.key)}, code:${JSON.stringify(args.code || args.key)}, bubbles:true, cancelable:true }); (document.activeElement||document.body).dispatchEvent(e); }
          fire('keydown'); fire('keypress'); fire('keyup');
          return true;
        })()`;
        await send(s, 'Runtime.evaluate', { expression: expr, returnByValue: true });
        return await okResult(s);
      }
      case 'select': {
        const found = await waitForElement(s, args, args.timeout || 15000).catch(() => false);
        if (!found) return { ok: false, error: `未找到 select：${args.selector || args.text || ''}` };
        const val = JSON.stringify(args.value);
        const expr = `(function(){ ${FIND_EL_SRC} const el = __findEl(${JSON.stringify(args)}); if(!el) return JSON.stringify({found:false}); el.value = ${val}; el.dispatchEvent(new Event('change',{bubbles:true})); return JSON.stringify({found:true}); })()`;
        await send(s, 'Runtime.evaluate', { expression: expr, returnByValue: true });
        return await okResult(s);
      }
      case 'check':
      case 'uncheck': {
        const found = await waitForElement(s, args, args.timeout || 15000).catch(() => false);
        if (!found) return { ok: false, error: `未找到复选框：${args.selector || args.text || ''}` };
        const want = action === 'check' ? 'true' : 'false';
        // 2026-09-12 修正：直接 `el.checked = x` 对 Vue/React 受控组件无效——
        // 实测出现「驱动返回 ok 但复选框实际未勾选」，导致后续「获取验证码」不触发。
        // 改为：优先真实 click（触发框架响应式更新），仍未生效再兜底赋值 + 派发 input/change，
        // 最后校验真实状态；不一致就如实返回失败，避免调用方误以为成功继续往下跑。
        const expr = `(function(){ ${FIND_EL_SRC}
          const el = __findEl(${JSON.stringify(args)});
          if (!el) return JSON.stringify({ found:false });
          const want = ${want};
          if (el.checked !== want) { try { el.click(); } catch (e) {} }
          if (el.checked !== want) {
            el.checked = want;
            try { el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); } catch (e) {}
          }
          return JSON.stringify({ found:true, checked: !!el.checked });
        })()`;
        const r = await send(s, 'Runtime.evaluate', { expression: expr, returnByValue: true });
        let parsed: any = null;
        try { parsed = JSON.parse(r?.result?.value ?? '{}'); } catch { /* 解析失败则跳过校验，保持原行为 */ }
        if (parsed && typeof parsed.checked === 'boolean' && parsed.checked !== (action === 'check')) {
          return { ok: false, error: `复选框未能${action === 'check' ? '勾选' : '取消勾选'}（可能是自定义控件，需人工点击）` };
        }
        return await okResult(s);
      }
      case 'upload': {
        if (!args.filePath) throw new Error('upload 需要 filePath 参数');
        if (!fs.existsSync(args.filePath)) throw new Error(`文件不存在：${args.filePath}`);
        const found = await waitForElement(s, args, args.timeout || 20000).catch(() => false);
        if (!found) return { ok: false, error: `未找到文件输入框：${args.selector || args.text || ''}` };
        // 取元素 objectId → backendNodeId，再用 DOM.setFileInputFiles 设置文件（不依赖 Debugger 域）
        const resolveExpr = `(function(){ ${FIND_EL_SRC} const el = __findEl(${JSON.stringify(args)}); if(!el) return null; return el; })()`;
        const objR = await send(s, 'Runtime.evaluate', { expression: resolveExpr, objectGroup: 'up' });
        const objId = objR.result && objR.result.objectId;
        if (!objId) return { ok: false, error: '无法解析文件输入框节点' };
        // upload 时按需临时开启 DOM 域（默认不开启，避免触发反爬）
        await send(s, 'DOM.enable');
        const desc = await send(s, 'DOM.describeNode', { objectId: objId });
        const backendNodeId = desc.node && desc.node.backendNodeId;
        if (!backendNodeId) return { ok: false, error: '无法取得 backendNodeId' };
        await send(s, 'DOM.setFileInputFiles', { files: [args.filePath], backendNodeId });
        return await okResult(s);
      }
      case 'wait': {
        if (args.selector || args.text || args.role) {
          const ok = await waitForElement(s, args, args.timeout || 15000);
          if (!ok) return { ok: false, error: '等待元素超时' };
          return await okResult(s);
        } else if (args.url) {
          const start = Date.now();
          while (Date.now() - start < (args.timeout || 30000)) {
            const r = await send(s, 'Runtime.evaluate', { expression: 'location.href', returnByValue: true });
            if (r.result && typeof r.result.value === 'string' && r.result.value.includes(args.url)) return await okResult(s);
            await new Promise(r => setTimeout(r, 400));
          }
          return { ok: false, error: '等待 URL 超时' };
        } else {
          await new Promise(r => setTimeout(r, args.timeout || 1000));
          return await okResult(s);
        }
      }
      case 'text': {
        const scope = args.selector || args.text || args.role ? `__findEl(${JSON.stringify(args)})` : (args.scope || 'document.body');
        // 优先 textContent（不依赖渲染可见性，SPA 导航后也能取到），回退 innerText；
        // 导航后可能瞬时为空，带多次重试。
        const expr = `(function(){ ${FIND_EL_SRC} var el = ${scope}; if(!el) return ''; var t = (el.textContent && el.textContent.length ? el.textContent : (el.innerText || '')); return t.replace(/\\s+\\n/g,'\\n').trim(); })()`;
        let text = '';
        // 导航后首个 Runtime.evaluate 偶发拿到空 execution context（返回空文本）。
        // 先发一次真正触达 DOM 的 evaluate 预热，激活当前上下文后再取正文。
        try { await send(s, 'Runtime.evaluate', { expression: 'document.body ? document.body.childElementCount : 0', returnByValue: true }); } catch { /* 忽略 */ }
        await new Promise(r => setTimeout(r, 300));
        for (let i = 0; i < 6; i++) {
          try {
            const r = await send(s, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
            text = (r.result && typeof r.result.value === 'string') ? r.result.value : '';
          } catch { /* 重试 */ }
          if (text.length > 0) break;
          await new Promise(r => setTimeout(r, 500));
        }
        return { ...(await okResult(s)), text };
      }
      case 'html': {
        const expr = args.selector
          ? `(function(){ ${FIND_EL_SRC} var el = __findEl(${JSON.stringify(args)}); return el ? el.innerHTML : document.documentElement.outerHTML; })()`
          : 'document.documentElement.outerHTML';
        const r = await send(s, 'Runtime.evaluate', { expression: expr, returnByValue: true });
        const html = r.result ? String(r.result.value) : '';
        return { ...(await okResult(s)), html: html.slice(0, args.maxLength || 20000) };
      }
      case 'screenshot': {
        if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
        const r = await send(s, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        const fileName = `${platform}-${Date.now()}.png`;
        const filePath = path.join(SHOT_DIR, fileName);
        fs.writeFileSync(filePath, Buffer.from(r.data, 'base64'));
        const base64 = args.includeBase64 ? r.data : undefined;
        return { ...(await okResult(s)), screenshot: `/data/screenshots/${fileName}`, data: base64 };
      }
      case 'eval': {
        const r = await send(s, 'Runtime.evaluate', {
          expression: String(args.script),
          returnByValue: true,
          awaitPromise: true,
        });
        const data = r.result ? r.result.value : (r.exceptionDetails ? undefined : undefined);
        return { ...(await okResult(s)), data };
      }
      case 'reload': {
        await send(s, 'Page.reload', { ignoreCache: false });
        await waitForLoad(s, args.timeout || 30000);
        return await okResult(s);
      }
      /** 把当前标签页切到窗口前台。
       *  ⚠️ 这是**唯一**允许激活窗口的地方（其余常规动作一律不置顶，
       *  否则用户最小化的窗口会被自动化反复弹回来）。
       *  用途：仅在需要用户人工介入时调用 —— 如登录页要扫码 / 短信验证，
       *  把登录页弹到最前面，用户无需在多个 Chrome 窗口里猜哪个才是投递用的调试浏览器。
       *  对应脚本：scripts/focus_login.ts。 */
      case 'bringToFront': {
        await send(s, 'Page.bringToFront', {});
        return await okResult(s);
      }
      case 'newTab': {
        const t = await httpReq('PUT', `${ep}/json/new?${args.url || 'about:blank'}`);
        const nws = await connect(t.webSocketDebuggerUrl);
        const ns = attachSession(nws, platform);
        ns.targetId = t.id;
        // 仅开 Page 域（同 ensureSession 原则：绝不开 Runtime.enable，否则被反爬清空）
        await send(ns, 'Page.enable');
        // 2026-09-12 反检测：新标签同样注入 anti-bot 脚本
        await installStealth(ns);
        // 不自动置顶（同上：避免把用户最小化的窗口弹回来）
        sessions.set(platform, ns);
        return await okResult(ns);
      }
      /** 接管「最新弹出的标签页」。
       *  场景：企业官网点「投递 / 立即投递」常以 target=_blank 打开申请表，
       *  此时会话仍绑定在旧标签，后续探测/填表/上传简历会全部落空（旧标签只剩弹窗）。
       *  做法：枚举 page 目标，挑一个「id ≠ 当前会话 targetId」且非空白/chrome 页的接管。
       *  注意：不能靠 URL 区分 —— 新标签与原标签 URL 常常完全相同。 */
      case 'adoptPopup': {
        const list = await httpReq('GET', `${ep}/json/list`).catch(() => [] as any[]);
        const arr: any[] = Array.isArray(list) ? list : [];
        const curId = s.targetId;
        const cands = arr.filter((t: any) => t.type === 'page' && t.webSocketDebuggerUrl && t.id
          && t.id !== curId && t.url && t.url !== 'about:blank' && !/^chrome/i.test(t.url));
        if (!cands.length) return { ok: false, error: 'adoptPopup: 未发现新弹窗标签' };
        const t = cands[cands.length - 1];
        try { sessions.delete(platform); } catch { /* ignore */ }
        try { s.ws.close(); } catch { /* ignore */ }
        const nws = await connect(t.webSocketDebuggerUrl);
        const ns = attachSession(nws, platform);
        ns.targetId = t.id;
        await send(ns, 'Page.enable');
        await installStealth(ns);
        sessions.set(platform, ns);
        return await okResult(ns);
      }
      /** 关闭「当前会话所在的标签页」并切回另一个标签。
       *  旧实现是**空壳**（直接 return okResult，什么都没关），所以标签从来没有被回收过 ——
       *  配合「会话失效就新建标签」，最终表现为「每投一个岗位多留一个窗口」。
       *  安全约束：只剩一个标签时拒绝关闭（关掉最后一个会让整个 Chrome 进程退出）。 */
      case 'closeTab': {
        const all: any[] = await httpReq('GET', `${ep}/json/list`).catch(() => []);
        const pages = (Array.isArray(all) ? all : []).filter((t: any) => t.type === 'page' && t.id);
        if (pages.length <= 1) {
          return { ok: false, error: '只剩一个标签页，关闭会导致 Chrome 退出，已跳过' };
        }
        const cur = s.targetId;
        const next = pages.find((t: any) => t.id !== cur) || pages[0];
        try { s.ws.close(); } catch { /* ignore */ }
        sessions.delete(platform);
        if (cur) await httpReq('GET', `${ep}/json/close/${cur}`).catch(() => undefined);
        return await rebindTo(ep, platform, next);
      }
      /** 收拾「多余标签页」：只保留一个（默认当前平台所在的那个，或按 URL 关键字挑），其余全关。
       *  用途：批量投递每完成一个岗位后调用一次，把历史泄漏的标签收敛掉，
       *  避免「一个点击事件占一个窗口」越滚越多。
       *  参数：
       *    urlContains?: string  优先保留 URL 含该串的标签
       *    sameHostOnly?: boolean 只关「与保留标签同主机名」的标签
       *      ⚠️ 强烈建议开启：一个端点会承载多个平台（official/offerbiu 共用 9227），
       *         不加这个限制会把**别的平台**的标签一起关掉
       *    dryRun?: boolean */
      case 'closeExtraTabs': {
        const all: any[] = await httpReq('GET', `${ep}/json/list`).catch(() => []);
        const pages = (Array.isArray(all) ? all : []).filter((t: any) => t.type === 'page' && t.id);
        const sub = String(args.urlContains || '');
        let keeper = pages.find((t: any) => t.id === s.targetId);
        if (sub) keeper = pages.find((t: any) => String(t.url || '').includes(sub)) || keeper;
        if (!keeper) keeper = pages[0];
        let victims = pages.filter((t: any) => t.id !== keeper?.id);
        if (args.sameHostOnly && keeper) {
          const hostOf = (u: string) => { try { return new URL(u).hostname; } catch { return ''; } };
          const kh = hostOf(String(keeper.url || ''));
          if (kh) victims = victims.filter((t: any) => hostOf(String(t.url || '')) === kh);
        }
        if (args.dryRun) {
          return { ...(await okResult(s)), data: { total: pages.length, kept: keeper?.url, wouldClose: victims.map((t: any) => t.url) } };
        }
        let closed = 0;
        for (const v of victims) {
          await httpReq('GET', `${ep}/json/close/${v.id}`).catch(() => undefined);
          closed++;
        }
        // 若被关掉的正好包含当前会话标签（理论上不会，keeper 优先取会话），重新绑定一次更稳
        return { ...(await okResult(s)), data: { total: pages.length, closed, kept: keeper?.url } };
      }
      /** 把本地 HTML 文件渲染成 PDF（用 Chrome 自己的排版引擎，Pages.printToPDF）。
       *
       *  场景：一岗一简历 —— 按 JD 定制好内容后，需要产出**真正的 PDF** 才能作为邮件附件/上传件。
       *  为什么不开新进程：项目已有 Playwright，但额外下载 Chromium(~150MB) 不划算；
       *  而平台调试 Chrome 本来就在跑，直接借它排版即可。
       *
       *  ⚠️ 关键：**开临时标签页**渲染，绝不占用平台主标签 ——
       *  否则会打断正在进行的投递/采集（把 BOSS 聊天页导航走，会话就乱了）。
       *  渲染完立即关掉临时标签。
       *
       *  参数：{ fileUrl: 'file:///C:/.../resume.html', outPath: 'C:/.../resume.pdf', timeout? }
       *  返回：{ data: { path, bytes } } */
      case 'htmlToPdf': {
        const fileUrl = String(args.fileUrl || '');
        const outPath = String(args.outPath || '');
        if (!fileUrl) return { ok: false, error: 'htmlToPdf 需要 fileUrl' };
        if (!outPath) return { ok: false, error: 'htmlToPdf 需要 outPath' };
        let tmpTargetId = '';
        let tmpWs: WebSocket | undefined;
        try {
          const t: any = await httpReq('PUT', `${ep}/json/new?about:blank`);
          tmpTargetId = t?.id || '';
          if (!t?.webSocketDebuggerUrl) return { ok: false, error: 'htmlToPdf 无法新建临时标签' };
          tmpWs = await connect(t.webSocketDebuggerUrl);
          const ts = attachSession(tmpWs, `${platform}__pdf`);
          ts.targetId = tmpTargetId;
          await send(ts, 'Page.enable');
          await send(ts, 'Page.navigate', { url: fileUrl });
          await waitForLoad(ts, args.timeout || 20000);
          const r: any = await send(ts, 'Page.printToPDF', {
            printBackground: true,
            paperWidth: Number(args.paperWidth) || 8.27,   // A4 宽（英寸）
            paperHeight: Number(args.paperHeight) || 11.69,
            marginTop: Number(args.marginTop ?? 0.35),
            marginBottom: Number(args.marginBottom ?? 0.35),
            marginLeft: Number(args.marginLeft ?? 0.4),
            marginRight: Number(args.marginRight ?? 0.4),
            scale: Number(args.scale) || 1,
          });
          if (!r?.data) return { ok: false, error: 'printToPDF 未返回数据' };
          const buf = Buffer.from(r.data, 'base64');
          fs.mkdirSync(path.dirname(outPath), { recursive: true });
          fs.writeFileSync(outPath, buf);
          return { ok: true, data: { path: outPath, bytes: buf.length } };
        } catch (error: any) {
          return { ok: false, error: `htmlToPdf 失败：${error?.message || error}` };
        } finally {
          // 无论成败都要关掉临时标签，避免残留空白页堆积
          if (tmpTargetId) { try { await httpReq('GET', `${ep}/json/close/${tmpTargetId}`); } catch { /* 忽略 */ } }
          try { tmpWs?.close(); } catch { /* 忽略 */ }
          sessions.delete(`${platform}__pdf`);
        }
      }
      /** HTML → PNG 长图（对标职得鸭「简历 HTML → 截图 → 聊天框发图」）。
       *  与 htmlToPdf 同样是**临时标签页**，绝不占用平台主标签。
       *  参数：{ fileUrl, outPath, width=1000, scale=2, maxHeight=16000, timeout } */
      case 'htmlToImage': {
        const fileUrl = String(args.fileUrl || '');
        const outPath = String(args.outPath || '');
        if (!fileUrl) return { ok: false, error: 'htmlToImage 需要 fileUrl' };
        if (!outPath) return { ok: false, error: 'htmlToImage 需要 outPath' };
        const width = Number(args.width) || 1000;
        const scale = Number(args.scale) || 2;
        let tmpTargetId = '';
        let tmpWs: WebSocket | undefined;
        try {
          const t: any = await httpReq('PUT', `${ep}/json/new?about:blank`);
          tmpTargetId = t?.id || '';
          if (!t?.webSocketDebuggerUrl) return { ok: false, error: 'htmlToImage 无法新建临时标签' };
          tmpWs = await connect(t.webSocketDebuggerUrl);
          const ts = attachSession(tmpWs, `${platform}__img`);
          ts.targetId = tmpTargetId;
          await send(ts, 'Page.enable');
          const setMetrics = (h: number) =>
            send(ts, 'Emulation.setDeviceMetricsOverride', { width, height: h, deviceScaleFactor: scale, mobile: false });
          await setMetrics(1200);
          await send(ts, 'Page.navigate', { url: fileUrl });
          await waitForLoad(ts, args.timeout || 20000);
          // 量出真实内容高度，再按内容高度重设视口 → 得到"完整长图"而非一屏
          const hr: any = await send(ts, 'Runtime.evaluate', {
            expression: 'Math.max(document.body?document.body.scrollHeight:0, document.documentElement?document.documentElement.scrollHeight:0, 800)',
            returnByValue: true,
          }).catch(() => null);
          const rawH = Number(hr?.result?.value) || 1200;
          const maxH = Number(args.maxHeight) || 16000;
          await setMetrics(Math.min(Math.max(rawH, 800), maxH));
          await new Promise((r) => setTimeout(r, 350));
          const r: any = await send(ts, 'Page.captureScreenshot', {
            format: 'png',
            captureBeyondViewport: true,
            fromSurface: true,
          });
          if (!r?.data) return { ok: false, error: 'captureScreenshot 未返回数据' };
          const buf = Buffer.from(r.data, 'base64');
          fs.mkdirSync(path.dirname(outPath), { recursive: true });
          fs.writeFileSync(outPath, buf);
          return { ok: true, data: { path: outPath, bytes: buf.length, width, height: Math.min(Math.max(rawH, 800), maxH) } };
        } catch (error: any) {
          return { ok: false, error: `htmlToImage 失败：${error?.message || error}` };
        } finally {
          if (tmpTargetId) { try { await httpReq('GET', `${ep}/json/close/${tmpTargetId}`); } catch { /* 忽略 */ } }
          try { tmpWs?.close(); } catch { /* 忽略 */ }
          sessions.delete(`${platform}__img`);
        }
      }
      /** 抓取远程页面中某个元素区域为长图 PNG（用于微信推文 JD 长图等「JD 是图片」场景）。
       *  与 htmlToPdf/htmlToImage 同样用临时标签页，绝不占用平台主标签。
       *  做法：临时标签打开 url → 等待 load → 量出 selector 元素在文档坐标系的绝对位置与尺寸 →
       *  设设备视口等于该元素尺寸 → captureScreenshot(clip=元素区域) 存盘。
       *  参数：{ url, selector='#js_content', outPath, maxHeight=24000, scale=1, timeout }
       *  返回：{ data: { path, bytes, width, height, truncated } } */
      case 'captureUrlElement': {
        const url = String(args.url || '');
        const selector = String(args.selector || '#js_content');
        const outPath = String(args.outPath || '');
        if (!url) return { ok: false, error: 'captureUrlElement 需要 url' };
        if (!outPath) return { ok: false, error: 'captureUrlElement 需要 outPath' };
        const maxH = Number(args.maxHeight) || 24000;
        const scale = Number(args.scale) || 1;
        let tmpTargetId = '';
        let tmpWs: WebSocket | undefined;
        try {
          const t: any = await httpReq('PUT', `${ep}/json/new?about:blank`);
          tmpTargetId = t?.id || '';
          if (!t?.webSocketDebuggerUrl) return { ok: false, error: 'captureUrlElement 无法新建临时标签' };
          tmpWs = await connect(t.webSocketDebuggerUrl);
          const ts = attachSession(tmpWs, `${platform}__cap`);
          ts.targetId = tmpTargetId;
          await send(ts, 'Page.enable');
          await send(ts, 'Page.navigate', { url });
          await waitForLoad(ts, args.timeout || 20000);
          await new Promise((r) => setTimeout(r, 600));
          // 同时抽取元素文本：供调用方判断「文字 JD」还是「图片 JD」（一次导航两用，避免重复导航触发限流）
          const txtR: any = await send(ts, 'Runtime.evaluate', {
            expression: `(function(){ var el=document.querySelector(${JSON.stringify(selector)}); return el ? (el.innerText||el.textContent||'') : ''; })()`,
            returnByValue: true,
          }).catch(() => null);
          const elText = String(txtR?.result?.value || '');
          const rectR: any = await send(ts, 'Runtime.evaluate', {
            expression: `(function(){ var el=document.querySelector(${JSON.stringify(selector)}); if(!el) return JSON.stringify({found:false}); var r=el.getBoundingClientRect(); return JSON.stringify({found:true, top:r.top+window.scrollY, left:r.left+window.scrollX, w:r.width, h:r.height}); })()`,
            returnByValue: true,
          }).catch(() => null);
          const rect = rectR?.result?.value ? JSON.parse(rectR.result.value) : null;
          if (!rect || !rect.found) return { ok: false, error: `captureUrlElement: 未找到元素 ${selector}` };
          const captureH = Math.min(Math.max(Math.round(rect.h), 1), maxH);
          const captureW = Math.max(Math.round(rect.w), 1);
          if (captureH < rect.h - 1) console.log(`[CDP] ${platform} 元素高 ${Math.round(rect.h)} 超 maxHeight ${maxH}，截取顶部 ${captureH}px`);
          await send(ts, 'Emulation.setDeviceMetricsOverride', { width: captureW, height: captureH, deviceScaleFactor: scale, mobile: false }).catch(() => undefined);
          await new Promise((r) => setTimeout(r, 350));
          const r: any = await send(ts, 'Page.captureScreenshot', {
            format: 'png',
            captureBeyondViewport: true,
            clip: { x: Math.max(0, Math.round(rect.left)), y: Math.max(0, Math.round(rect.top)), width: captureW, height: captureH, scale },
          });
          if (!r?.data) return { ok: false, error: 'captureUrlElement 未返回数据' };
          const buf = Buffer.from(r.data, 'base64');
          fs.mkdirSync(path.dirname(outPath), { recursive: true });
          fs.writeFileSync(outPath, buf);
          return { ok: true, data: { path: outPath, bytes: buf.length, width: captureW, height: captureH, truncated: captureH < rect.h - 1, text: elText } };
        } catch (error: any) {
          return { ok: false, error: `captureUrlElement 失败：${error?.message || error}` };
        } finally {
          if (tmpTargetId) { try { await httpReq('GET', `${ep}/json/close/${tmpTargetId}`); } catch { /* 忽略 */ } }
          try { tmpWs?.close(); } catch { /* 忽略 */ }
          sessions.delete(`${platform}__cap`);
        }
      }
      /** 读取当前 Chrome 会话可见的 Cookie（**含 httpOnly**，如 BOSS 的 `__zp_stoken__`、
       *  猎聘的 `X-XSRF-TOKEN` 配套 cookie）。文档中 `document.cookie` 读不到 httpOnly，
       *  必须走 CDP。用途：
       *   1) 走平台 JSON 接口直连时复用已登录会话（见 services/platformApi/bossOpenApi.ts）；
       *   2) 诊断「到底登没登录」。
       *  实现顺序：Storage.getCookies（浏览器级，无需 enable，最安全）→ Network.getCookies(urls) 回退。
       *  参数：{ url?: string, filterDomain?: string }。 */
      case 'cookies': {
        let list: any[] = [];
        try {
          const r: any = await send(s, 'Storage.getCookies', {});
          list = r?.cookies || [];
        } catch {
          try {
            await send(s, 'Network.enable', {}).catch(() => undefined);
            const one = String(args.url || '');
            const r: any = await send(s, 'Network.getCookies', one ? { urls: [one] } : {});
            list = r?.cookies || [];
          } catch { /* 读不到就当空 */ }
        }
        let cookies = list.map((c: any) => ({
          name: c.name, value: c.value, domain: c.domain, path: c.path,
          httpOnly: !!c.httpOnly, secure: !!c.secure, expires: c.expires,
        }));
        if (args.filterDomain) {
          const fd = String(args.filterDomain).toLowerCase();
          cookies = cookies.filter((c) => String(c.domain || '').toLowerCase().includes(fd));
        }
        return { ...(await okResult(s)), data: cookies };
      }
      case 'close': {
        try { s.ws.close(); } catch { /* ignore */ }
        sessions.delete(platform);
        return { ok: true };
      }
      default:
        return { ok: false, error: `CDP 驱动不支持的动作：${action}` };
    }
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error) };
  }
}

/** 关闭所有 CDP 驱动会话（被 browser.closeAll 调用） */
export async function closeAllCdp(): Promise<void> {
  for (const s of sessions.values()) {
    try { s.ws.close(); } catch { /* ignore */ }
  }
  sessions.clear();
}

export function listCdpSessions() {
  return Array.from(sessions.values()).map(s => ({ platform: s.platform, createdAt: new Date(s.createdAt).toISOString() }));
}
