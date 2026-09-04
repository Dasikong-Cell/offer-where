/**
 * 浏览器自动化服务
 * 基于 Playwright 的持久化上下文（launchPersistentContext），
 * 每个平台（boss / zhaopin / job51 / official）独立用户数据目录，登录态自动复用。
 */
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_ROOT = path.join(__dirname, '..', '..', 'data', 'browser');
const SHOT_DIR = path.join(__dirname, '..', '..', 'data', 'screenshots');

type PW = typeof import('playwright');

let pw: PW | null = null;
async function loadPlaywright(): Promise<PW> {
  if (pw) return pw;
  try {
    pw = (await import('playwright')) as PW;
    return pw;
  } catch (error: any) {
    const err = new Error(
      'Playwright 未安装。请先执行：npm install playwright && npx playwright install chromium'
    );
    (err as any).code = 'PLAYWRIGHT_MISSING';
    throw err;
  }
}

interface BrowserSession {
  platform: string;
  context: import('playwright').BrowserContext;
  page: import('playwright').Page;
  createdAt: number;
}

const sessions = new Map<string, BrowserSession>();

function ensureDirs() {
  if (!fs.existsSync(DATA_ROOT)) fs.mkdirSync(DATA_ROOT, { recursive: true });
  if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
}

function safePlatformName(platform: string): string {
  return (platform || 'default').replace(/[^a-zA-Z0-9_\-]/g, '_');
}

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

/** 获取（或创建）平台浏览器会话 */
async function getSession(
  platform = 'default',
  options: { headless?: boolean; userAgent?: string } = {}
): Promise<BrowserSession> {
  const key = safePlatformName(platform);
  const existing = sessions.get(key);
  if (existing) {
    try {
      // 探活
      await existing.page.title();
      return existing;
    } catch {
      sessions.delete(key);
    }
  }

  ensureDirs();
  const playwright = await loadPlaywright();
  const userDataDir = path.join(DATA_ROOT, key);
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

  let context: import('playwright').BrowserContext;
  try {
    context = await playwright.chromium.launchPersistentContext(userDataDir, {
      headless: options.headless ?? false,
      viewport: { width: 1440, height: 900 },
      userAgent: options.userAgent,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--disable-infobars',
        // Windows 无 GPU 环境下不加这三项会导致截图挂起
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-dev-shm-usage',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    });
  } catch (error: any) {
    const message = error?.message || String(error);
    if (/Executable doesn't exist|browserType.launch|Please run the following command/i.test(message)) {
      const err = new Error(
        'Chromium 浏览器未下载。请执行：npx playwright install chromium'
      );
      (err as any).code = 'CHROMIUM_MISSING';
      throw err;
    }
    throw error;
  }

  const page = context.pages()[0] || (await context.newPage());
  const session: BrowserSession = { platform: key, context, page, createdAt: Date.now() };
  sessions.set(key, session);
  return session;
}

async function resolveSelector(
  page: import('playwright').Page,
  action: string,
  args: Record<string, any>
): Promise<import('playwright').Locator> {
  const { selector, text, role, name, index = 0, timeout = 15000 } = args;

  let locator: import('playwright').Locator;
  if (selector) {
    locator = page.locator(selector);
  } else if (role) {
    locator = page.getByRole(role as any, name ? { name } : undefined);
  } else if (text) {
    // 优先在「可交互元素」中按文本筛选：直接 getByText 会命中按钮内层的 span 等
    // 非交互节点，点击不触发 Vue/React 的事件处理（表现为"点得动但页面没反应"）。
    const interactive = page
      .locator('button, a[href], [role="button"], input[type="button"], input[type="submit"]')
      .filter({ hasText: text });
    let count = 0;
    try { count = await interactive.count(); } catch { count = 0; }
    locator = count > 0 ? interactive : page.getByText(text, { exact: args.exact === true });
  } else {
    throw new Error(`${action} 需要提供 selector / role / text 之一`);
  }

  await locator.first().waitFor({ state: 'visible', timeout });
  return index > 0 ? locator.nth(index) : locator.first();
}

/**
 * 统一动作分发
 */
export async function execAction(
  platform: string,
  action: string,
  args: Record<string, any> = {}
): Promise<BrowserActionResult> {
  try {
    const session = await getSession(platform, {
      headless: args.headless,
      userAgent: args.userAgent,
    });
    const { page, context } = session;

    switch (action) {
      case 'navigate':
      case 'goto': {
        if (!args.url) throw new Error('navigate 需要 url 参数');
        await page.goto(args.url, {
          waitUntil: args.waitUntil || 'domcontentloaded',
          timeout: args.timeout || 30000,
        });
        return okResult(page);
      }

      case 'click': {
        const locator = await resolveSelector(page, 'click', args);
        await locator.click({ timeout: args.timeout || 15000 });
        if (args.waitAfter) await page.waitForTimeout(args.waitAfter);
        return okResult(page);
      }

      case 'fill': {
        if (args.value === undefined) throw new Error('fill 需要 value 参数');
        const locator = await resolveSelector(page, 'fill', args);
        await locator.fill(String(args.value), { timeout: args.timeout || 15000 });
        return okResult(page);
      }

      case 'type': {
        if (args.value === undefined) throw new Error('type 需要 value 参数');
        const locator = await resolveSelector(page, 'type', args);
        await locator.click({ timeout: args.timeout || 15000 });
        await locator.type(String(args.value), { delay: args.delay || 60 });
        return okResult(page);
      }

      case 'press': {
        if (!args.key) throw new Error('press 需要 key 参数');
        if (args.selector) {
          const locator = await resolveSelector(page, 'press', args);
          await locator.press(args.key);
        } else {
          await page.keyboard.press(args.key);
        }
        return okResult(page);
      }

      case 'select': {
        const locator = await resolveSelector(page, 'select', args);
        await locator.selectOption(args.value !== undefined ? { label: String(args.value) } : args);
        return okResult(page);
      }

      case 'check':
      case 'uncheck': {
        const locator = await resolveSelector(page, action, args);
        if (action === 'check') await locator.check({ timeout: args.timeout || 15000 });
        else await locator.uncheck({ timeout: args.timeout || 15000 });
        return okResult(page);
      }

      case 'upload': {
        if (!args.filePath) throw new Error('upload 需要 filePath 参数（简历文件绝对路径）');
        if (!fs.existsSync(args.filePath)) throw new Error(`文件不存在：${args.filePath}`);
        const locator = await resolveSelector(page, 'upload', args);
        await locator.setInputFiles(args.filePath, { timeout: args.timeout || 20000 });
        return okResult(page);
      }

      case 'wait': {
        if (args.selector || args.text || args.role) {
          await resolveSelector(page, 'wait', args);
        } else if (args.url) {
          await page.waitForURL(args.url, { timeout: args.timeout || 30000 });
        } else {
          await page.waitForTimeout(args.timeout || 1000);
        }
        return okResult(page);
      }

      case 'text': {
        const raw = args.selector || args.text || args.role
          ? await (await resolveSelector(page, 'text', args)).innerText({ timeout: args.timeout || 15000 })
          : await page.innerText(args.scope || 'body', { timeout: args.timeout || 15000 });
        return { ...(await okResult(page)), text: raw.replace(/\s+\n/g, '\n').trim() };
      }

      case 'html': {
        const raw = args.selector
          ? await (await resolveSelector(page, 'html', args)).innerHTML({ timeout: args.timeout || 15000 })
          : await page.content();
        return { ...(await okResult(page)), html: raw.slice(0, args.maxLength || 20000) };
      }

      case 'screenshot': {
        ensureDirs();
        const fileName = `${session.platform}-${Date.now()}.png`;
        const filePath = path.join(SHOT_DIR, fileName);
        await page.screenshot({
          path: filePath,
          fullPage: args.fullPage !== false,
          // 禁用动画并隐藏光标，避免页面存在持续动画时截图挂起
          animations: 'disabled',
          caret: 'hide',
          timeout: args.timeout || 20000,
        });
        const base64 = args.includeBase64
          ? fs.readFileSync(filePath).toString('base64')
          : undefined;
        return { ...(await okResult(page)), screenshot: `/data/screenshots/${fileName}`, data: base64 };
      }

      case 'eval': {
        if (process.env.ALLOW_BROWSER_EVAL === 'false') {
          throw new Error('eval 已被禁用（ALLOW_BROWSER_EVAL=false）');
        }
        if (!args.script) throw new Error('eval 需要 script 参数');
        const result = await page.evaluate(args.script as string);
        return { ...(await okResult(page)), data: result };
      }

      case 'newTab': {
        const newPage = await context.newPage();
        if (args.url) await newPage.goto(args.url, { waitUntil: 'domcontentloaded' });
        session.page = newPage;
        return okResult(newPage);
      }

      case 'closeTab': {
        if (context.pages().length > 1) {
          await page.close();
          session.page = context.pages()[0];
        }
        return okResult(session.page);
      }

      case 'reload': {
        await page.reload({ waitUntil: args.waitUntil || 'domcontentloaded' });
        return okResult(page);
      }

      case 'close': {
        await context.close();
        sessions.delete(session.platform);
        return { ok: true };
      }

      default:
        return {
          ok: false,
          error: `不支持的动作：${action}`,
          hint: '支持：navigate / click / fill / type / press / select / check / upload / wait / text / html / screenshot / eval / newTab / closeTab / reload / close',
        };
    }
  } catch (error: any) {
    const code = (error as any)?.code;
    if (code === 'PLAYWRIGHT_MISSING' || code === 'CHROMIUM_MISSING') {
      return { ok: false, error: error.message, hint: 'npm install playwright && npx playwright install chromium' };
    }
    return { ok: false, error: error?.message || String(error) };
  }
}

async function okResult(page: import('playwright').Page): Promise<BrowserActionResult> {
  let url = '';
  let title = '';
  try {
    url = page.url();
    title = await page.title();
  } catch {
    /* 忽略 */
  }
  return { ok: true, url, title };
}

export function listSessions() {
  return Array.from(sessions.values()).map(s => {
    let url = '';
    try {
      url = s.page.url();
    } catch {
      /* 页面已关闭 */
    }
    return { platform: s.platform, url, createdAt: new Date(s.createdAt).toISOString() };
  });
}

/** 关闭所有浏览器会话 */
export async function closeAll(): Promise<void> {
  for (const session of sessions.values()) {
    try {
      await session.context.close();
    } catch {
      /* 忽略 */
    }
  }
  sessions.clear();
}
