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
  collectListScript: string;
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
        ? `https://www.zhaopin.com/jobs?jl=489&kw=${(kw)}`
        : 'https://www.zhaopin.com/jobs?jl=489',
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
      /(请登录|未登录|账号登录|登录招聘网|登录后查看更多)/.test(text),
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
    applyScript: `(() => { const b = document.querySelector('.op-btn-chat'); if (b && !b.disabled) { b.click(); return true; } return false; })()`,
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
        // 真岗位详情形如 jobs.51job.com/<path>/<id>.html；排除首页/导航链接
        if (/jobs\\.51job\\.com\\/[^/]+\\/[^/]+\\.html/.test(h)) set.add(h.split('?')[0]);
      });
      return Array.from(set);
    })()`,
    applyScript: `(() => {
      // 51job 现行页面：主按钮是 a.btn / button 的「立即申请」，点击后弹确认对话框
      const cands = [...document.querySelectorAll('a.btn, button, [class*="apply-component"], [class*="el-button"]')];
      const b = cands.find(x => {
        const t = (x.innerText || x.textContent || '').trim();
        return (t === '立即申请' || t === '申请职位' || t === '投递简历' || t === '投个简历') && !x.disabled;
      });
      if (b) { b.click(); return true; }
      return false;
    })()`,
    confirmRegex: '申请成功|已投递|投递成功|简历已送达|申请职位成功',
    loginCheck: (text, url) =>
      // 「登录/注册」是 51job 顶栏未登录态标志；命中即视为未登录
      /(请登录|登录51job|账号登录|登录后|登录\/注册)/.test(text) && !/(申请成功|已投递)/.test(text),
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
    collectLinksScript: `(() => {
      const set = new Set();
      document.querySelectorAll('a[href*="liepin.com/job/"]').forEach(a => { const h = a.href; if (h) set.add(h.split('?')[0]); });
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
