/**
 * 反检测指纹自检（技术债 D4 的验证工具）
 * ============================================================
 * 背景：竞品取证发现职得鸭的 4 项"卖点级"反检测**全是摆设**
 * （fingerprint / ghost-cursor / turnstile / setWebdriverFalse 全部误配或未接线）。
 * 教训：**不要靠"配了参数"来相信反检测生效，要能实测出来。**
 *
 * 本脚本对每个平台的调试 Chrome 逐个取真实指纹，并与「同机普通 Chrome」的期望值比对，
 * 输出一张「泄露点清单」。它是只读的：只做 eval，不导航、不点击。
 *
 * 用法：
 *   tsx scripts/check_stealth.ts                 # 检查全部平台
 *   tsx scripts/check_stealth.ts boss liepin     # 只检查指定平台
 */
import { ex } from './lib/browser.ts';

const PLATFORMS = ['boss', 'liepin', 'job51', 'zhilian', 'offerbiu'];

/** 一次 eval 取回全部指纹字段（单次调用，避免多次 eval 互相影响） */
const PROBE = `(() => {
  const out = {};
  // 1) 最关键的自动化标志
  out.webdriver = navigator.webdriver;                     // 期望 undefined / false
  // 2) 插件与语言（自动化环境常为空数组或 ['en-US']）
  out.plugins = (navigator.plugins || []).length;          // 期望 > 0
  out.mimeTypes = (navigator.mimeTypes || []).length;      // 期望 > 0
  out.languages = (navigator.languages || []).join(',');
  out.platform = navigator.platform || '';
  out.hardwareConcurrency = navigator.hardwareConcurrency || 0;
  // 3) window.chrome 对象（真实 Chrome 存在，headless/旧版 CDP 常缺失）
  out.hasChromeObj = typeof window.chrome === 'object' && window.chrome !== null;
  out.chromeRuntime = !!(window.chrome && window.chrome.runtime);
  // 4) 视口 vs 屏幕（自动化窗口常出现 outer=inner，或被固定成奇怪尺寸）
  out.screen = [screen.width, screen.height].join('x');
  out.outer = [window.outerWidth, window.outerHeight].join('x');
  out.inner = [window.innerWidth, window.innerHeight].join('x');
  out.devicePixelRatio = window.devicePixelRatio;
  out.outerEqualsInner = window.outerWidth === window.innerWidth && window.outerHeight === window.innerHeight;
  // 5) 权限查询行为（headless 下 Permission.query 表现异常）
  out.hasNotification = typeof Notification !== 'undefined';
  out.permissionsApi = !!(navigator.permissions && navigator.permissions.query);
  // 6) WebGL 渲染器（软件渲染 = swiftshader 是典型自动化特征）
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      out.webglVendor = dbg ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || '') : '';
      out.webglRenderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '') : '';
    }
  } catch (e) { out.webglError = String(e && e.message || e); }
  // 7) CDP 泄漏探针：Runtime.enable 会把函数 toString 改写，从而被风控识别。
  //    这里只做"读"——比较一个原生函数 toString 是否还是 native code 形态。
  try {
    const s = Function.prototype.toString.call(Element.prototype.getBoundingClientRect);
    out.nativeToString = /\\[native code\\]/.test(s);
  } catch (e) { out.nativeToString = null; }
  return JSON.stringify(out);
})()`;

interface Probe {
  webdriver?: unknown;
  plugins?: number;
  mimeTypes?: number;
  languages?: string;
  platform?: string;
  hardwareConcurrency?: number;
  hasChromeObj?: boolean;
  chromeRuntime?: boolean;
  screen?: string;
  outer?: string;
  inner?: string;
  devicePixelRatio?: number;
  outerEqualsInner?: boolean;
  hasNotification?: boolean;
  permissionsApi?: boolean;
  webglVendor?: string;
  webglRenderer?: string;
  webglError?: string;
  nativeToString?: boolean | null;
}

interface Finding {
  level: 'ok' | 'warn' | 'bad';
  field: string;
  value: string;
  note: string;
}

/** 依据实测值给出判定（全部为启发式，但每条都写清依据，不做玄学结论） */
function analyze(p: Probe): Finding[] {
  const f: Finding[] = [];
  const push = (level: Finding['level'], field: string, value: unknown, note: string) =>
    f.push({ level, field, value: String(value), note });

  // navigator.webdriver
  if (p.webdriver === true) push('bad', 'navigator.webdriver', p.webdriver, 'CDP 自动化标志未抹除（--disable-blink-features=AutomationControlled 未生效）');
  else push('ok', 'navigator.webdriver', p.webdriver, '已抹除/未设置（预期）');

  // 插件
  if (!p.plugins) push('bad', 'navigator.plugins.length', p.plugins, '为 0 是典型自动化特征（正常 Chrome ≥ 3）');
  else push('ok', 'navigator.plugins.length', p.plugins, '非空，接近真实 Chrome');

  if (!p.mimeTypes) push('warn', 'navigator.mimeTypes.length', p.mimeTypes, '为 0 可能是 headless/精简环境');
  else push('ok', 'navigator.mimeTypes.length', p.mimeTypes, '非空');

  // window.chrome
  if (!p.hasChromeObj) push('bad', 'window.chrome', p.hasChromeObj, '缺少 window.chrome（真实 Chrome 必有）');
  else push('ok', 'window.chrome', p.hasChromeObj, '存在');

  // 窗口尺寸
  if (p.outerEqualsInner) push('warn', 'outer == inner', 'true', '外窗与视口完全相等，属自动化窗口常见形态（我们用网格窗口，此项无法完全消除）');
  else push('ok', 'outer vs inner', `${p.outer} / ${p.inner}`, '内外尺寸不同，符合带边框的真实窗口');

  // WebGL
  const r = String(p.webglRenderer || '');
  if (/swiftshader|software|llvmpipe/i.test(r)) push('bad', 'WebGL renderer', r, '软件渲染（SwiftShader）是强自动化信号 —— 检查是否误加了 --disable-gpu');
  else if (r) push('ok', 'WebGL renderer', r, '硬件渲染，正常');
  else push('warn', 'WebGL renderer', '(取不到)', '无法读取渲染器（可能被扩展或策略屏蔽）');

  // CDP 泄漏（函数 toString）
  if (p.nativeToString === false) push('bad', 'native toString', 'false', '有函数被改写为非 native 形态 —— 可能已启用 Runtime.enable 造成泄漏');
  else push('ok', 'native toString', String(p.nativeToString), '原生函数形态未被改写');

  // 语言
  if (!p.languages) push('warn', 'navigator.languages', '(空)', '语言列表为空，易被识别');
  else push('ok', 'navigator.languages', p.languages, '非空');

  return f;
}

const levelMark: Record<Finding['level'], string> = { ok: '[ OK ]', warn: '[WARN]', bad: '[BAD ]' };

(async () => {
  const argv = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const targets = argv.length ? argv : PLATFORMS;
  let bad = 0, warn = 0;

  for (const platform of targets) {
    console.log(`\n${'='.repeat(70)}\n平台：${platform}\n${'='.repeat(70)}`);
    let probe: Probe;
    try {
      const r = await ex(platform, { action: 'eval', script: PROBE });
      if (!r?.ok || !r.data) throw new Error(r?.error || 'eval 未返回数据');
      probe = JSON.parse(String(r.data)) as Probe;
    } catch (e: any) {
      console.log(`  跳过：${e?.message || e}（该平台调试窗口未启动？）\n`);
      continue;
    }

    const findings = analyze(probe);
    for (const x of findings) {
      if (x.level === 'bad') bad++;
      if (x.level === 'warn') warn++;
      console.log(`  ${levelMark[x.level]} ${x.field.padEnd(26)} = ${x.value}`);
      if (x.level !== 'ok') console.log(`         ↳ ${x.note}`);
    }
    console.log(`\n  小结：${findings.filter((x) => x.level === 'ok').length} 项正常 / ${findings.filter((x) => x.level === 'warn').length} 项注意 / ${findings.filter((x) => x.level === 'bad').length} 项需修`);
    console.log(`  原始指纹：screen=${probe.screen} outer=${probe.outer} inner=${probe.inner} dpr=${probe.devicePixelRatio} cpu=${probe.hardwareConcurrency} platform=${probe.platform}`);
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`总计：${bad} 项需修（BAD）、${warn} 项注意（WARN）`);
  console.log('说明：BAD 项多为启动参数问题，可直接修；WARN 项部分是架构取舍（如网格小窗口）。');
  console.log('      竞品用了 rebrowser-puppeteer-core 消除 Runtime.enable 泄漏，我们靠"绝不调用"规避 ——');
  console.log('      若上方 native toString 为 OK，说明该规避在当前链路上有效。');
  process.exit(bad > 0 ? 1 : 0);
})();
