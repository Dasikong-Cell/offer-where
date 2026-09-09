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
    for (const t of targetInfos || []) {
      if (t.type === 'page' && (t.url === 'about:blank' || t.url === 'chrome://newtab/' || t.url === '')) {
        try { await send(bs, 'Target.closeTarget', { targetId: t.targetId }); } catch { /* 忽略 */ }
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

function connect(wsUrl: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.on('open', () => resolve(ws));
    ws.on('error', e => reject(e));
  });
}

function attachSession(ws: WebSocket, platform: string): PageSession {
  const s: PageSession = { platform, ws, nextId: 0, pending: new Map(), loadWaiters: [], createdAt: Date.now() };
  ws.on('message', (data: WebSocket.RawData) => {
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
    }
  });
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
      await send(existing, 'Runtime.evaluate', { expression: '1', returnByValue: true });
      // 复用已有标签时，把当前平台的标签置顶，确保用户看到的是正在跑的这个平台
      try { await send(existing, 'Page.bringToFront'); } catch { /* 忽略 */ }
      return existing;
    }
    catch { sessions.delete(platform); }
  }
  if (existing && existing.dead) { try { existing.ws.close(); } catch { /* ignore */ } sessions.delete(platform); }
  // 在真实 Chrome 中新建一个标签页（默认 profile），连接其调试 ws
  // 每个平台拿到自己独立的标签，互不共用，避免「拥挤在一个页面上」
  // 注意：绝不使用 Playwright connectOverCDP（会开启 Debugger 域触发反爬）
  let target: any;
  try {
    target = await httpReq('PUT', `${endpoint}/json/new?about:blank`);
  } catch (e: any) {
    throw new Error(`CDP 新建标签页失败（${endpoint}）：${e?.message || e}。请确认真实 Chrome 以 --remote-debugging-port=9222 启动。`);
  }
  const ws = await connect(target.webSocketDebuggerUrl);
  const s = attachSession(ws, platform);
  // 关键：只开 Page 域，绝不开 Runtime.enable。
  // 实测证据：BOSS直聘/猎聘 会检测 `Runtime.enable`（启用 Runtime 事件通知），
  // 命中后数秒内把页面 navigate 回 about:blank（表现为空白页）。
  // 但 `Runtime.evaluate` 命令本身无需 enable 即可执行，且不会触发该检测 ——
  // 因此所有 JS 交互（click/fill/eval/screenshot 等）照常通过 Runtime.evaluate 完成，
  // 页面保持正常渲染。Page 域用于导航与 loadEventFired 等待。
  await send(s, 'Page.enable');
  // 新标签创建后立刻置顶，让当前平台的标签成为窗口前台页
  try { await send(s, 'Page.bringToFront'); } catch { /* 忽略 */ }
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
    return { ok: true, url: v.url, title: v.title };
  } catch {
    return { ok: true };
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
        // 导航完成后把当前平台标签置顶，确保它显示在前台而非藏在别的标签后面
        try { await send(s, 'Page.bringToFront'); } catch { /* 忽略 */ }
        return last;
      }
      case 'click': {
        const found = await waitForElement(s, args, args.timeout || 15000).catch(() => false);
        if (!found) return { ok: false, error: `未找到可点击元素：${args.text || args.selector || args.role || ''}` };
        const r = await actInPage(s, 'click', args);
        if (args.waitAfter) await new Promise(r => setTimeout(r, args.waitAfter));
        return r;
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
        const expr = `(function(){ ${FIND_EL_SRC} const el = __findEl(${JSON.stringify(args)}); if(!el) return JSON.stringify({found:false}); el.checked = ${want}; el.dispatchEvent(new Event('change',{bubbles:true})); return JSON.stringify({found:true}); })()`;
        await send(s, 'Runtime.evaluate', { expression: expr, returnByValue: true });
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
       *  用途：需要用户人工介入（扫码 / 短信验证）时，把登录页弹到最前面，
       *  用户无需在多个 Chrome 窗口里猜哪个才是投递用的调试浏览器。 */
      case 'bringToFront': {
        await send(s, 'Page.bringToFront', {});
        return await okResult(s);
      }
      case 'newTab': {
        const t = await httpReq('PUT', `${ep}/json/new?${args.url || 'about:blank'}`);
        const nws = await connect(t.webSocketDebuggerUrl);
        const ns = attachSession(nws, platform);
        // 仅开 Page 域（同 ensureSession 原则：绝不开 Runtime.enable，否则被反爬清空）
        await send(ns, 'Page.enable');
        try { await send(ns, 'Page.bringToFront'); } catch { /* 忽略 */ }
        sessions.set(platform, ns);
        return await okResult(ns);
      }
      case 'closeTab': {
        return await okResult(s);
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
