/**
 * 各招聘平台「官网一键投递」配置
 * 选择器/脚本直接对齐职得鸭(gagajob) 解析出的真实实现：
 *   - 智联  zhilianHello.js  → .summary-planes__action button.a-button（立即投递）
 *   - BOSS   bossHello.js     → .op-btn-chat（立即沟通）
 *   - 51job  job51Hello.js    → #app_ck（申请职位）
 *   - 猎聘   liepinHello.js   → .btn-main（聊一聊）
 * 核心模式：一键完成，依赖账号已填好的在线简历，不碰任何表单/级联。
 */
import type { ApplyPlatform } from './types.js';

export type PlatformKey = Exclude<ApplyPlatform, 'offerbiu' | 'nowcoder'>;

export interface PlatformCfg {
  key: PlatformKey;
  label: string;
  homeUrl: string;
  /** 关键词搜索结果页 URL */
  searchUrl: (kw: string) => string;
  /** 当前列表页收集「下一级入口」链接（eval 脚本，返回 string[]）。
   *  - 智联：搜索列表页标题非锚点，需先收公司页链接，再进公司页收岗位 → 返回 companydetail 链接
   *  - 其余平台：列表页直接是岗位 → 与 collectLinksScript 相同（直接返回 JD 链接） */
  collectListScript?: string;
  /** JD 页/公司页：收集所有 JD 链接（eval 脚本，返回 string[]） */
  collectLinksScript: string;
  /** JD 页：找到并点击「投递/沟通/聊一聊」按钮（eval 脚本，返回 boolean） */
  applyScript: string;
  /** 投递成功判定正则（页面文本命中即视为成功） */
  confirmRegex: string;
  /** 未登录判定（基于页面文本 + URL） */
  loginCheck: (text: string, url: string) => boolean;
  /** 邮箱验证码登录配置（无则未登录时返回 need_login 需人工登录） */
  login?: {
    loginUrl: string;
    emailTab?: string[];
    emailInput: string[];
    sendCodeBtn: string[];
    codeInput: string[];
    submitBtn: string[];
    sliderHint?: string[];
    subjectKeyword: string;
  };
  /** 沟通型平台（投递=发起沟通），again/letter 用 */
  chatBased: boolean;
  hr?: {
    chatInputSel: string[];
    sendSel: string[];
  };
}

export const PLATFORMS: Record<PlatformKey, PlatformCfg> = {
  zhilian: {
    key: 'zhilian',
    label: '智联招聘',
    homeUrl: 'https://www.zhaopin.com/',
    searchUrl: (kw) =>
      kw
        ? `https://www.zhaopin.com/jobs?kw=${encodeURIComponent(kw)}`
        : 'https://www.zhaopin.com/jobs',
    // 智联搜索列表页标题非锚点、SPA 懒加载，静态抓不到 JD 链接；先收公司详情页链接
    collectListScript: `(() => {
      const set = new Set();
      document.querySelectorAll('a[href*="companydetail"]').forEach(a => { const h = a.href; if (h) set.add(h.split('?')[0]); });
      return Array.from(set);
    })()`,
    collectLinksScript: `(() => {
      const set = new Set();
      document.querySelectorAll('a').forEach(a => {
        const h = a.href || '';
        if (h && (/(zhaopin\\.com\\/(jobdetail|job)\\/)/.test(h) || /jobs\\.zhaopin\\.com/.test(h))) set.add(h.split('?')[0]);
      });
      return Array.from(set);
    })()`,
    applyScript: `(() => {
      const c = document.querySelector('.summary-planes__action') || document.querySelector('.summary-plane__action');
      const tryBtn = (b) => { if (!b) return false; if (b.disabled || b.classList.contains('a--disabled')) return false; const t = (b.textContent || '').trim(); return t.includes('立即投递') || t.includes('投递'); };
      if (c) { const btns = c.querySelectorAll('button.a-button'); for (const b of btns) { if (tryBtn(b)) { b.click(); return true; } } }
      const all = document.querySelectorAll('button.a-button.a--bordered.a--filled');
      for (const b of all) { if (tryBtn(b)) { b.click(); return true; } }
      return false;
    })()`,
    confirmRegex: '投递成功|已投递|简历已送达|申请成功|投递完成|继续沟通|已申请|已发送|简历投递成功',
    loginCheck: (text, url) =>
      /passport\.zhaopin/.test(url) ||
      /(请登录|未登录|账号登录|登录招聘网|登录后查看更多|国家网络身份认证|登录\/注册|获取验证码|完成认证|实名认证|手机号登录)/.test(text),
    login: {
      loginUrl: 'https://www.zhaopin.com/',
      emailInput: ['#email', 'input[placeholder*="邮箱"]', 'input[name="email"]'],
      sendCodeBtn: ['获取验证码', '发送验证码'],
      codeInput: ['#code', 'input[placeholder*="验证码"]', 'input[name="code"]'],
      submitBtn: ['登录', '立即登录', '确认'],
      sliderHint: ['请拖动', '滑动验证', '拖动滑块'],
      subjectKeyword: '智联',
    },
    chatBased: false,
  },

  boss: {
    key: 'boss',
    label: 'BOSS直聘',
    homeUrl: 'https://www.zhipin.com/',
    searchUrl: (kw) =>
      kw
        ? `https://www.zhipin.com/web/geek/job?query=${(kw)}&city=100010000`
        : 'https://www.zhipin.com/web/geek/jobs',
    collectLinksScript: `(() => {
      const set = new Set();
      const push = (h) => { if (h && /job_detail/.test(h)) set.add(h.split('?')[0]); };
      document.querySelectorAll('a[href]').forEach(a => push(a.href));
      document.querySelectorAll('.job-card-wrapper, .rec-job-item, [class*="job-card"]').forEach(c => {
        const a = c.querySelector('a'); if (a) push(a.href);
      });
      return Array.from(set);
    })()`,
    applyScript: `(() => { let b = document.querySelector('.btn-startchat'); if (!b) b = [...document.querySelectorAll('a,button')].find(e => /立即沟通/.test(e.textContent || '')); if (b && !b.disabled) { b.click(); return true; } return false; })()`,
    confirmRegex: '已发送|发送成功|沟通中|交换微信|简历已送达|打招呼',
    loginCheck: (text, url) =>
      /web\/user|login\.zhipin|passport\.zhipin/.test(url) ||
      /(邮箱登录|短信登录|账号密码登录|扫码登录|验证码登录)/.test(text),
    login: {
      loginUrl: 'https://www.zhipin.com/web/user/?ka=header-login',
      emailTab: ['邮箱登录'],
      emailInput: ['#email', 'input[placeholder*="邮箱"]', 'input[name="email"]'],
      sendCodeBtn: ['获取验证码', '发送验证码'],
      codeInput: ['#code', 'input[placeholder*="验证码"]', 'input[name="code"]'],
      submitBtn: ['登录', '立即登录', '确认'],
      sliderHint: ['请拖动', '滑动验证', '拖动滑块'],
      subjectKeyword: 'BOSS',
    },
    chatBased: true,
    hr: {
      chatInputSel: ['.chat-input', '#chat-input', 'textarea[placeholder*="沟通"]', 'div[contenteditable="true"]'],
      sendSel: ['发送', '.send-btn'],
    },
  },

  job51: {
    key: 'job51',
    label: '前程无忧',
    homeUrl: 'https://www.51job.com/',
    searchUrl: (kw) =>
      kw
        ? `https://we.51job.com/pc/search?keyword=${(kw)}&partner=`
        : 'https://we.51job.com/pc/my/myjob',
    collectLinksScript: `(() => {
      const set = new Set();
      document.querySelectorAll('a[href]').forEach(a => {
        const h = a.href || '';
        // 真岗位详情形如 jobs.51job.com/<city>/<id>.html；
        // 排除 /all/ 公司聚合页、/co... 公司主页、/campus/ 校招页等导航/非标准 JD 链接。
        if (/jobs\\.51job\\.com\\//.test(h) && !/jobs\\.51job\\.com\\/all\\//.test(h) && !/jobs\\.51job\\.com\\/campus\\//.test(h) && !/jobs\\.51job\\.com\\/[^/]+\\/co/.test(h) && /jobs\\.51job\\.com\\/[^/]+\\/[^/]+\\.html/.test(h)) {
          set.add(h.split('?')[0]);
        }
      });
      return Array.from(set);
    })()`,
    applyScript: `(() => {
      // 51job 现行 JD 页：主按钮文本为「投递」（class=apply-btn normal / jobapply-wrapper apply_btn）。
      // 点击后弹出「请选择需要投递的简历」对话框，确认按钮为「立即申请」。
      const all = [...document.querySelectorAll('a,button,[class*="btn"],[class*="apply"]')];
      const byText = (re) => all.find(x => { const t = (x.innerText || x.textContent || '').trim(); return re.test(t) && !x.disabled; });
      // 先关掉可能出现的「我知道了」提示框
      const hint = byText(/^我知道了$/);
      if (hint) { try { hint.click(); } catch (e) {} }
      // 主投递按钮：优先「投递」/「立即投递」/「立即申请」/「申请职位」，排除「去聊聊」「聊」等沟通按钮
      const main = byText(/^(投递|立即投递|立即申请|申请职位|投个简历|申请)$/) || byText(/投递简历/);
      if (main) { main.click(); return 'main'; }
      return false;
    })()`,
    confirmRegex: '申请成功|已投递|投递成功|简历已送达|申请职位成功|投递完成',
    loginCheck: (text, url) => {
      // 已登录强指标：这些元素只有登录后的 51job 页面才有（JD 页顶部「在线简历 <用户名>」、
      // 「我的投递」「职位推荐」等）。命中即直接判已登录。
      // 背景：实测引擎在 JD 页会误判为未登录并跑去走邮箱验证码登录，
      // 报「未找到『发送验证码』按钮」——因为页面尚未渲染完/带登录浮层文案，
      // 靠「我的求职」等导航文案判断并不稳（JD 页可能不含这些词）。
      if (/(在线简历|我的投递|职位推荐|退出登录|我的简历|我的求职|个人中心|消息中心|竞争力分析)/.test(text)) return false;
      // 否则再判断是否命中明确登录墙（账号登录/扫码/短信登录/登录后投递等）。
      return /(请登录|账号登录|登录并投递|登录后投递|扫码登录|短信登录|登录无忧|登录后可)/.test(text);
    },
    login: {
      loginUrl: 'https://www.51job.com/',
      emailInput: ['#loginname', 'input[placeholder*="邮箱"]', 'input[name="loginname"]'],
      sendCodeBtn: ['获取验证码', '发送验证码'],
      codeInput: ['#password', 'input[placeholder*="验证码"]', 'input[name="code"]'],
      submitBtn: ['登录', '立即登录'],
      subjectKeyword: '51job',
    },
    chatBased: false,
  },

  liepin: {
    key: 'liepin',
    label: '猎聘',
    homeUrl: 'https://www.liepin.com/',
    searchUrl: (kw) =>
      kw
        ? `https://www.liepin.com/zhaopin/?key=${(kw)}&curPage=0`
        : 'https://www.liepin.com/zhaopin',
    // 猎聘现行岗位链接是 /lptjob/<id>（旧版 /job/<id> 已不再产出），两者都要匹配，
    // 否则列表页一个岗位链接都收不到（实测：只匹配 /job/ 时 count=0）。
    collectLinksScript: `(() => {
      const set = new Set();
      document.querySelectorAll('a[href*="liepin.com/job/"], a[href*="liepin.com/lptjob/"]').forEach(a => { const h = a.href; if (h) set.add(h.split('?')[0]); });
      return Array.from(set);
    })()`,
    applyScript: `(() => { const b = document.querySelector('.btn-main'); if (b) { const t = (b.textContent || '').trim(); if (t.includes('聊一聊')) { b.click(); return true; } } return false; })()`,
    confirmRegex: '已发送|打招呼成功|聊一聊成功|沟通中|交换微信',
    loginCheck: (text, url) =>
      /(请登录|登录猎聘|账号登录|登录后)/.test(text) && !/(聊一聊成功|打招呼成功)/.test(text),
    login: {
      loginUrl: 'https://www.liepin.com/',
      emailInput: ['input[placeholder*="邮箱"]', '#email', 'input[name="email"]'],
      sendCodeBtn: ['获取验证码', '发送验证码'],
      codeInput: ['input[placeholder*="验证码"]', '#code', 'input[name="code"]'],
      submitBtn: ['登录', '立即登录', '确认'],
      subjectKeyword: '猎聘',
    },
    chatBased: true,
    hr: {
      chatInputSel: ['.im-chat-input', 'textarea[placeholder*="沟通"]', 'div[contenteditable="true"]'],
      sendSel: ['发送', '.send-btn'],
    },
  },
};

export function getPlatform(key: string): PlatformCfg | undefined {
  return (PLATFORMS as Record<string, PlatformCfg>)[key];
}
