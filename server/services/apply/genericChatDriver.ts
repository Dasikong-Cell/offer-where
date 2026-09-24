/**
 * 跨平台「聊天驱动」通用工厂（config 驱动）。
 *
 * 背景（2026-09-23 复盘）：自动回复引擎 runAutoReply 已平台无关，只依赖 ChatDriver 接口。
 * 此前 boss / liepin 各自写了近 300 行几乎同构的浏览器操作（openChat / listConversations /
 * openConversation / readConversation / sendText / sendResume），只有 DOM 选择器不同。
 * 把这 6 个方法的「骨架 + 健壮启发式」抽成工厂：每个平台只需提供一份 ChatDriverConfig
 * （chatUrl + 选择器），即可获得完整 ChatDriver 能力；resumeRequest 检测与 acceptResumeRequest
 * 直接复用 resumeCard.ts 的跨平台通用实现。
 *
 * ⚠️ 选择器校准：本工厂的默认启发式覆盖市面上大多数 React/Vue 聊天 UI 的常见结构，
 * 但每个平台 IM 的真实 class 仍需真机校准（见 scripts/probe_chat.ts）。config.calibrated=false
 * 的平台为「启发式基线」，生产使用前应先跑探针、把实测选择器回填到 config 再置 calibrated=true。
 *
 * 设计要点：
 *  - 每个 buildChatDriver 实例持有独立 _exOverride（测试注入桩），互不串扰。
 *  - sendText 同时兼容 contenteditable（execCommand insertText）与 textarea/input（原生 setter + input 事件）。
 *  - readConversation 的「我/HR」判定：mineClassRe 命中 → me；hrClassRe 命中 → hr；两者都不中 →
 *    跳过该条（宁可不回，也不误把己方消息当 HR 回 —— 防重复自言自语）。
 *  - acceptResumeRequest 始终走通用实现（resumeCard.ts），含 ALREADY 守卫 + 一次点击。
 */

import type { ChatDriver, ConvSummary, ParsedMessage } from './chatTypes.js';
import { acceptResumeRequestGeneric, detectResumeRequestClause, type ExFn } from './resumeCard.js';

const PORT = Number(process.env.PORT) || 4400;
const BASE = `http://127.0.0.1:${PORT}/api/browser/exec`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 平台聊天驱动配置（选择器缺失时由工厂用启发式兜底） */
export interface ChatDriverConfig {
  platform: string;
  /** openChat 导航目标（一般为平台首页或消息中心 URL） */
  chatUrl: string;
  /** 进聊天页后点击的「IM 入口」选择器（浮层类 IM 需要，如猎聘 .im-ui-basic-entry）；空则不点 */
  entrySelector?: string;
  /** IM 入口「文本正则」（无稳定 class 时按文本点，如 /消息|沟通|聊天|IM|私信/）；优先级低于 entrySelector */
  entryTextRe?: string;
  /** 会话列表是否已加载的轮询上限（秒*2） */
  pollMax?: number;

  // —— 会话列表 ——
  listItemSelector: string;
  nameSelector: string;
  companySelector?: string;
  lastMsgSelector?: string;
  /** 未读判定：该选择器命中（或文本含「未读」）即未读 */
  unreadSelector?: string;

  // —— 消息气泡 ——
  messageSelector: string;
  /** 我方消息 class 正则（如 /\b(mine|self|my|right|send|out|owner|user)\b/i） */
  mineClassRe?: string;
  /** HR 消息 class 正则（如 /\b(friend|left|in|opposite|hr|them|peer|other)\b/i） */
  hrClassRe?: string;
  /** 非己方即 HR：多数双人聊天 UI 只标记「我方」气泡（如 zhilian 的 --me），HR 侧无专属 class。
   *  置 true 时：命中 mineClassRe → me，否则该气泡 → hr（自动互斥，无需 HR class）。推荐开启。 */
  hrElse?: boolean;
  /** 气泡内文本元素选择器（缺省用元素自身 innerText） */
  textSelector?: string;
  /** 系统/非真人消息容器选择器（命中则跳过，防把推送卡片当 HR 说话） */
  systemSelector?: string;

  // —— 输入框 / 发送 ——
  inputSelector: string;
  sendSelector: string;
  /** 发送按钮文本正则（缺省 /发送|发送\(S\)/） */
  sendBtnTextRe?: string;

  // —— 工具栏「发简历」兜底（无结构化卡片的纯文本简历请求走这里）——
  resumeToolbarSelector?: string;

  /** 真机校准状态：false = 启发式基线（生产前需校准） */
  calibrated?: boolean;
  /** 架构上是否支持本引擎自动回复：false = 该平台无可用 Web IM（如 51job/鱼泡/中华英才 HR 走 App），
   * 即使登录也无法驱动，引擎应直接跳过而非空跑导航。缺省 true。 */
  autoReplySupported?: boolean;
  /** autoReplySupported=false 时的说明（返回给用户 / 日志） */
  disabledReason?: string;
}

export function buildChatDriver(cfg: ChatDriverConfig): ChatDriver & { __setExForTest: (fn: ExFn | null) => void; config: ChatDriverConfig } {
  const PLATFORM = cfg.platform;
  const mineRe = cfg.mineClassRe ? new RegExp(cfg.mineClassRe, 'i') : /\b(mine|self|my|right|send|out|owner|user|me)\b/i;
  const hrRe = cfg.hrClassRe ? new RegExp(cfg.hrClassRe, 'i') : /\b(friend|left|in|opposite|hr|them|peer|other|bot)\b/i;
  const sendTextRe = cfg.sendBtnTextRe ? new RegExp(cfg.sendBtnTextRe) : /发送|Send/;
  const pollMax = cfg.pollMax || 20;

  // —— 测试注入桩（每实例独立） ——
  let _exOverride: ExFn | null = null;
  const __setExForTest = (fn: ExFn | null) => { _exOverride = fn; };

  async function realEx(action: string, extra: any = {}): Promise<any> {
    const r = await fetch(BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: PLATFORM, action, ...extra }),
    });
    return r.json();
  }
  const ex: ExFn = (action, extra) => (_exOverride || realEx)(action, extra || {});

  /** 进聊天页：导航 + 可选入口点击 + 轮询等待列表加载 */
  async function openChat(): Promise<void> {
    await ex('navigate', { url: cfg.chatUrl, waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3500);
    if (cfg.entrySelector) {
      await ex('eval', {
        script: `(()=>{const e=document.querySelector(${JSON.stringify(cfg.entrySelector)});if(e){e.click();return 'opened';}return 'NO_ENTRY';})()`,
      });
      await sleep(1500);
    } else if (cfg.entryTextRe) {
      await ex('eval', {
        script: `(()=>{const re=${JSON.stringify(cfg.entryTextRe)}?new RegExp(${JSON.stringify(cfg.entryTextRe)}):null;if(!re)return 'NO_RE';const els=[].slice.call(document.querySelectorAll('a,button,[role=button],.entry,[class*=entry]'));const e=els.find(x=>(x.innerText||x.getAttribute('title')||'')&&re.test(x.innerText||x.getAttribute('title')||''));if(e){e.click();return 'opened';}return 'NO_ENTRY';})()`,
      });
      await sleep(1500);
    }
    for (let i = 0; i < pollMax; i++) {
      await sleep(2000);
      const r = await ex('eval', {
        script: `(()=>{const n=document.querySelectorAll(${JSON.stringify(cfg.listItemSelector)}).length;return JSON.stringify({n});})()`,
      });
      const d = JSON.parse((r.data as string) || '{"n":0}');
      if (d.n >= 1) break;
    }
    await sleep(1200);
  }

  async function listConversations(): Promise<ConvSummary[]> {
    const r = await ex('eval', {
      script: `(()=>{
        const items=[].slice.call(document.querySelectorAll(${JSON.stringify(cfg.listItemSelector)}));
        if(!items.length) return JSON.stringify({items:[],note:'NO_LIST'});
        const out=[];
        for(const li of items){
          const name=((li.querySelector(${JSON.stringify(cfg.nameSelector)})||{innerText:''}).innerText||'').trim();
          let company='';
          ${cfg.companySelector ? `company=((li.querySelector(${JSON.stringify(cfg.companySelector)})||{innerText:''}).innerText||'').replace(/\\s+/g,' ').trim();` : ''}
          const msgRaw=((li.querySelector(${JSON.stringify(cfg.lastMsgSelector || cfg.nameSelector)})||li).innerText||'').replace(/\\s+/g,' ').trim();
          const unread=${cfg.unreadSelector ? `!!li.querySelector(${JSON.stringify(cfg.unreadSelector)})` : 'false'} || /未读/.test(msgRaw) || /\\d+/.test((li.querySelector('[class*=unread],[class*=badge],[class*=red-dot],[class*=dot]')||{textContent:''}).textContent||'');
          out.push({name, company, raw:msgRaw, unread});
        }
        return JSON.stringify({items:out});
      })()`,
    });
    const d = JSON.parse((r.data as string) || '{"items":[]}');
    const items: any[] = d.items || [];
    return items.map((c, i) => ({
      key: `${PLATFORM}|${c.name}|${i}`,
      name: c.name || '未知',
      company: c.company || '',
      lastMsg: String(c.raw || '').replace(/^\\[未读\\]/, '').trim().slice(0, 120),
      unread: !!c.unread,
      raw: c.raw || '',
    }));
  }

  async function openConversation(key: string): Promise<boolean> {
    const parts = key.split('|');
    const idx = Number(parts[2] || '0');
    const name = parts[1] || '';
    const r = await ex('eval', {
      script: `(()=>{
        const items=[].slice.call(document.querySelectorAll(${JSON.stringify(cfg.listItemSelector)}));
        let target=items[${idx}];
        if(!target && ${JSON.stringify(name)}){ target=items.find(li=>(li.innerText||'').includes(${JSON.stringify(name)})); }
        if(!target) return 'NOT_FOUND';
        target.click();
        return 'opened';
      })()`,
    });
    for (let i = 0; i < 12; i++) {
      await sleep(1500);
      const chk = await ex('eval', {
        script: `(()=>{return JSON.stringify({msgs:document.querySelectorAll(${JSON.stringify(cfg.messageSelector)}).length});})()`,
      });
      const d = JSON.parse((chk.data as string) || '{"msgs":0}');
      if (d.msgs >= 1) break;
    }
    await sleep(1000);
    return (r.data as string) === 'opened';
  }

  async function readConversation(): Promise<{ messages: ParsedMessage[]; lastHr: string; resumeRequest?: boolean }> {
    const r = await ex('eval', {
      script: `(()=>{
        const all=[].slice.call(document.querySelectorAll(${JSON.stringify(cfg.messageSelector)}));
        const msgs=[];
        for(const li of all){
          const cls=(li.className||'').toString();
          ${cfg.systemSelector ? `if(li.querySelector(${JSON.stringify(cfg.systemSelector)})) continue;` : `if(/system-tip|system-card|articles-center/.test(cls) && !li.querySelector('.text,.txt,.content')) continue;`}
          const txtEl=li.querySelector(${JSON.stringify(cfg.textSelector || '.text,.txt,.content')})||li;
          const txt=(txtEl.innerText||li.innerText||'').replace(/\\s+/g,' ').trim();
          if(!txt) continue;
          const isMine=${JSON.stringify(cfg.mineClassRe || '__MINE__')}!=='__MINE__'
            ? new RegExp(${JSON.stringify(cfg.mineClassRe || '')},'i').test(cls)
            : (new RegExp('\\\\b(mine|self|my|right|send|out|owner|user|me)\\\\b','i').test(cls) || !!li.querySelector('.item-myself,.mine,.self'));
          const isHr=${cfg.hrElse ? '!isMine' : `${JSON.stringify(cfg.hrClassRe || '__HR__')}!=='__HR__' ? new RegExp(${JSON.stringify(cfg.hrClassRe || '')},'i').test(cls) : (new RegExp('\\\\b(friend|left|in|opposite|hr|them|peer|other|bot)\\\\b','i').test(cls) || !!li.querySelector('.item-friend,.friend,.other'))`};
          // 只明确判定的一侧才入列：宁可不回，也不误把己方消息当 HR 回
          if(isMine && !isHr) msgs.push({side:'me',text:txt});
          else if(isHr && !isMine) msgs.push({side:'hr',text:txt});
          else if(!isMine && !isHr){ /* 无法判定：跳过，待校准 */ }
        }
        const resumeRequest=(${detectResumeRequestClause()});
        return JSON.stringify({msgs, resumeRequest});
      })()`,
    });
    const d = JSON.parse((r.data as string) || '{"msgs":[]}');
    const messages: ParsedMessage[] = d.msgs || [];
    const hrs = messages.filter((m: ParsedMessage) => m.side === 'hr');
    return { messages, lastHr: hrs.length ? hrs[hrs.length - 1].text : '', resumeRequest: !!d.resumeRequest };
  }

  async function sendText(text: string): Promise<boolean> {
    // 1) 填输入框：contenteditable → execCommand；textarea/input → 原生 setter + input 事件
    const fillRes = await ex('eval', {
      script: `(()=>{
        const SELS=[${JSON.stringify(cfg.inputSelector)},'.chat-input,[contenteditable]','textarea','input[type=text]'];
        let el=null; for(const s of SELS){ el=document.querySelector(s); if(el) break; }
        if(!el) return 'NO_INPUT';
        if(el.isContentEditable || /contenteditable/i.test(el.getAttribute('contenteditable')||'')){
          el.focus(); el.innerHTML=''; document.execCommand('insertText',false,${JSON.stringify(text)});
          el.dispatchEvent(new InputEvent('input',{bubbles:true})); return 'ce';
        }
        const tag=(el.tagName||'').toUpperCase();
        if(tag==='TEXTAREA'||tag==='INPUT'){
          const proto=tag==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;
          const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;
          if(setter){ setter.call(el,${JSON.stringify(text)}); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return 'native'; }
        }
        return 'NO_FILL';
      })()`,
    });
    await sleep(700);
    if ((fillRes.data as string) === 'NO_INPUT' || (fillRes.data as string) === 'NO_FILL') return false;
    // 2) 点发送按钮（带文本正则 + 未禁用校验，失败重试 3 次）
    for (let i = 0; i < 3; i++) {
      const r = await ex('eval', {
        script: `(()=>{
          const b=document.querySelector(${JSON.stringify(cfg.sendSelector)});
          if(b && ${JSON.stringify(sendTextRe.toString())}.test(b.innerText||'') && !b.disabled && !/disabled/.test(b.className||'')){ b.click(); return 'sent'; }
          const all=[].slice.call(document.querySelectorAll('button')).find(x=>${JSON.stringify(sendTextRe.toString())}.test(x.innerText||'')&&!x.disabled);
          if(all){ all.click(); return 'sent'; }
          return 'NO_BTN';
        })()`,
      });
      if ((r.data as string) === 'sent') { await sleep(2200); return true; }
      await sleep(1200);
    }
    return false;
  }

  async function sendResume(): Promise<boolean> {
    const r = await ex('eval', {
      script: `(()=>{
        ${cfg.resumeToolbarSelector ? `const cand=document.querySelector(${JSON.stringify(cfg.resumeToolbarSelector)}); if(cand){cand.click();return 'clicked';}` : ''}
        const alt=[].slice.call(document.querySelectorAll('[class*=action],[class*=toolbar],button')).find(x=>/(简历|附件|上传|发简历)/.test(x.innerText||x.getAttribute('title')||x.getAttribute('aria-label')||''));
        if(alt){ alt.click(); return 'clicked'; }
        const file=document.querySelector('input[type=file]'); if(file){ file.click(); return 'file-clicked'; }
        return 'NO_BTN';
      })()`,
    });
    await sleep(2500);
    return (r.data as string) === 'clicked' || (r.data as string) === 'file-clicked';
  }

  /** 同意平台「请求附件简历」结构化卡片（跨平台通用实现，含 ALREADY 守卫 + 一次点击）。
   *  ⚠️ 真实副作用：点下去会向 HR 发简历；引擎只在真实发送模式调用。 */
  async function acceptResumeRequest(): Promise<boolean> {
    return acceptResumeRequestGeneric(ex);
  }

  return {
    platform: PLATFORM,
    openChat,
    listConversations,
    openConversation,
    readConversation,
    sendText,
    sendResume,
    acceptResumeRequest,
    __setExForTest,
    config: cfg,
  };
}
