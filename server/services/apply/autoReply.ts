/**
 * HR 消息自动回复引擎
 *
 * 两层设计（安全 + 智能兼得）：
 *  - 意图识别（detectIntent / decide）：始终保持「规则」实现。分类任务规则更可控，
 *    且内置终态判定顺序、疑问句规避等护栏，避免误判导致不回 / 乱回。
 *  - 话术生成（composeReply / composeReplyWithAi）：默认优先用大模型（context-aware，
 *    自然像真人）；未配置 LLM_* 或模型调用失败，自动回退到规则模板 composeReply。
 *    即「接入 AI 大模型进行自动回复」，但永远不会因为 AI 抽风而破坏投递护栏。
 */

import { chatText, isAiEnabled } from './aiClient.js';

export type HrIntent =
  | 'interview_scheduled' // 已确定面试安排
  | 'reject'              // 不合适 / 婉拒
  | 'ask_interview_time'  // 询问具体面试时间
  | 'ask_availability'    // 询问是否有空 / 约面试
  | 'ask_resume'          // 要简历
  | 'ask_salary'          // 期望薪资
  | 'ask_onsite'          // 到岗时间
  | 'ask_experience'      // 经验 / 项目
  | 'ask_education'       // 学历
  | 'ask_phone'           // 要电话 / 微信
  | 'greeting'            // 打招呼
  | 'other';

export interface ReplyContext {
  hrName?: string | null;
  company?: string | null;
  position?: string | null;
  /** 第几轮回复（从 1 开始） */
  round?: number;
  /** 可选：求职者信息，用于填充话术 */
  profile?: {
    name?: string | null;
    phone?: string | null;
    education?: string | null;
    major?: string | null;
    /** 期望工作城市（来自 profile.expectedCity）：用于异地岗位判断，并避免 AI 编造现居地 */
    city?: string | null;
  };
}

/** 会话阶段 */
export type ConvStage = 'new' | 'replied' | 'interview' | 'rejected' | 'stalled';

/** 超过这个轮数仍未约到面试就停止，避免无限寒暄 */
export const MAX_ROUNDS = 8;

interface Rule {
  intent: HrIntent;
  patterns: RegExp[];
}

/** 按优先级排列：终态意图必须排在最前 */
const RULES: Rule[] = [
  {
    intent: 'interview_scheduled',
    patterns: [
      /面试.{0,4}(时间|安排)?.{0,8}(定[在了为]|确定|安排好|安排了)/,
      /(已|已经).{0,6}(发|发送|安排|约).{0,8}面试/,
      /面试邀请/,
      /(明天|后天|今天|周[一二三四五六日]|下周).{0,10}(见|面谈|面试)/,
      /那就.{0,6}(这么)?(定|约).{0,4}(了|吧|下)/,
      /(请|欢迎).{0,6}(准时|参加).{0,6}面试/,
    ],
  },
  {
    // 必须带否定词：否则「你挺合适的」「很匹配」会被误判成婉拒
    intent: 'reject',
    patterns: [
      /(不太|不够|不是很|不)(合适|匹配|符合|适合|考虑)/,
      /(抱歉|不好意思|遗憾).{0,12}(不|没能|无法|暂时)/,
      /(抱歉|不好意思|遗憾).{0,20}(找到|心仪|工作|机会)/,
      /(暂时|这次)(不|没|无法)/,
      /(岗位|职位).{0,8}(已?招满|已关闭|已暂停|暂停招聘|招到人了)/,
      /(我们|这边|公司).{0,6}(觉得|认为|看)?(不太|不)(合适|匹配|符合)/,
      /祝你?.{0,6}(好运|找到.{0,8}工作|心仪)/,
      /祝您.{0,12}(早日|尽快|找到|心仪)/,
    ],
  },
  {
    intent: 'ask_interview_time',
    patterns: [
      /(明天|后天|周[一二三四五六日]|下周|今天).{0,10}(方便|有空|可以|行)吗/,
      // 「明天方便面试吗」：日期与面试之间隔着「方便」，上面的规则接不上，需单独兜住
      /(明天|后天|今天|周[一二三四五六日]|下周).{0,12}(面试|面谈|面聊)/,
      /(什么|哪个)时间.{0,6}(方便|有空|面试)/,
      /几点.{0,6}(方便|面试)/,
      /(线上|线下|视频|现场)面试/,
    ],
  },
  {
    // 到岗类问题要排在「是否有空」之前：
    // 「什么时候能到岗」会先被 ask_availability 的「什么时候…能」抢走
    intent: 'ask_onsite',
    patterns: [
      /(什么|啥)时候.{0,6}(能|可以).{0,4}(到岗|入职|上班)/,
      /(到岗|入职)时间/,
      /(多久|多长时间).{0,6}(能|可以).{0,4}(到岗|入职)/,
    ],
  },
  {
    intent: 'ask_availability',
    patterns: [
      /(方便|有空|可以).{0,8}(面试|聊|沟通|聊聊)/,
      /(约|安排).{0,6}(面试|时间)/,
      /什么时候.{0,6}(方便|有空|能)/,
      /(能|可以)来.{0,6}面试/,
    ],
  },
  {
    intent: 'ask_resume',
    patterns: [
      /(发|给|传|要|看下|看一下).{0,6}简历/,
      /简历.{0,6}(发|给|传)我/,
      /(有|带).{0,4}简历吗/,
    ],
  },
  {
    intent: 'ask_salary',
    patterns: [
      /(期望|希望|要求).{0,6}(薪资|薪水|工资|待遇)/,
      /(薪资|薪水|工资).{0,6}(期望|要求|多少)/,
      /多少钱/,
    ],
  },
  {
    intent: 'ask_experience',
    patterns: [
      /(几|多少)年.{0,4}经验/,
      /(做|搞)过.{0,8}(项目|什么)/,
      /项目(经验|经历)/,
      /(熟悉|用过|掌握).{0,8}(什么|哪些)/,
      /工作(经验|经历)/,
    ],
  },
  {
    intent: 'ask_education',
    patterns: [
      /(什么|哪个).{0,4}(学历|学校|院校|专业)/,
      /(本科|专科|研究生|硕士|博士|大专)/,
      /(毕业|就读).{0,6}(于|学校|院校)/,
      /(学历|专业)/,
    ],
  },
  {
    intent: 'ask_phone',
    patterns: [
      /(电话|手机号|联系方式|微信)/,
      /(留|给)个?.{0,4}(电话|联系方式|微信)/,
    ],
  },
  {
    intent: 'greeting',
    patterns: [
      /^(你好|您好|hi|hello|hey|在吗|在么)/i,
      /^(你好|您好)/,
    ],
  },
];

/** 是否为疑问句（终态判定必须避开疑问句） */
function isQuestion(text: string): boolean {
  const t = (text || '').trim();
  if (!t) return false;
  // 注意：「吧」是建议语气而非疑问（如「那就定在下周一吧」），不能算疑问句，
  // 否则已约面试这类终态会被误判成疑问句而跳过。
  return /[?？]/.test(t)
    || /吗/.test(t)
    || /呢/.test(t)
    || /(好不好|行不行|能不能|有没有|方便吗|可以吗|行吗)/.test(t);
}

/** 把「软件工程师、前端开发、Java」之类的字符串解析成职位关键词数组 */
export function parsePositions(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean);
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return raw
    .split(/[,，、;；\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 核心技能 token：用于「目标职位」与「HR 发布的职位」之间的模糊相关判断 */
const CORE_TOKENS = [
  'java', '前端', '后端', 'web', '测试', 'python', '开发', '工程师', '全栈', '软件',
  '数据', '运维', 'go', 'c++', '架构', '算法', '.net', 'net', 'android', 'ios',
  'php', 'vue', 'react', 'node', '实施', '数据库', '嵌入式', '人工智能', 'ai', '大模型',
];

/**
 * HR 发布的职位是否与「目标职位」相关。
 *  - 未设目标职位 → 全部视为相关（向后兼容，回复所有）。
 *  - 无法识别 HR 职位 → 保守返回 true（宁可回复，不漏掉真实机会）。
 *  - 否则：双向子串命中，或核心技能 token 重叠，即视为相关。
 */
export function isPositionRelated(
  hrPosition?: string | null,
  targets?: string[] | null,
): boolean {
  if (!targets || targets.length === 0) return true;
  if (!hrPosition || !hrPosition.trim()) return true;
  const hp = hrPosition.toLowerCase();
  for (const t of targets) {
    const tl = String(t || '').toLowerCase().trim();
    if (!tl) continue;
    if (hp.includes(tl) || tl.includes(hp)) return true;
    if (CORE_TOKENS.some((tok) => hp.includes(tok) && tl.includes(tok))) return true;
  }
  return false;
}

/** 识别 HR 消息意图 */
export function detectIntent(text: string): HrIntent {
  const t = (text || '').replace(/\s+/g, '').toLowerCase();
  if (!t) return 'other';
  const q = isQuestion(text);
  for (const rule of RULES) {
    // 终态意图（已约面试 / 婉拒）必须是陈述句。
    // 否则「明天方便面试吗」会被当成已约面试、「你挺合适的吗」会被当成婉拒。
    const isTerminal = rule.intent === 'interview_scheduled' || rule.intent === 'reject';
    if (isTerminal && q) continue;
    for (const re of rule.patterns) {
      // 中文标点统一处理后再匹配，提高命中率
      if (re.test(t) || re.test(text || '')) return rule.intent;
    }
  }
  return 'other';
}

const pos = (ctx: ReplyContext) => ctx.position || '相关岗位';
const com = (ctx: ReplyContext) => ctx.company || '您这边';
const name = (ctx: ReplyContext) => ctx.profile?.name || '';

/** 稳定哈希（djb2）：纯函数、无随机源，用于确定性变体选取 */
function hashSeed(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * 从若干同义话术里确定性地挑一条。
 *
 * 种子用「公司 + 岗位 + 轮次」：同一 HR 的多轮回复不会重复同一句，
 * 不同 HR 之间措辞也不一样 —— 真人绝不可能对所有人说一字不差的话，
 * 「每家公司收到的回复都长得一模一样」本身就是最刺眼的 AI 味。
 * 刻意不用 Math.random：确定性才能被断言（否则单测只能测「非空」）。
 */
export function pickVariant(list: string[], seed?: string): string {
  if (!list.length) return '';
  return list[hashSeed(String(seed || '')) % list.length];
}

/**
 * 句首寒暄套话（不含句末标点，匹配时允许后跟任意标点）。
 * 刻意**不含**独立的「您好」——真人也会先问好，删掉反而生硬。
 */
const OPEN_PLEASANTRIES = [
  '您好，感谢您的回复', '非常感谢您的回复', '感谢您的回复', '谢谢您的回复', '感谢回复',
  '您好，感谢您的关注', '感谢您的关注', '谢谢您的关注',
  '您好，很高兴收到您的消息', '很高兴收到您的消息', '很高兴收到您的来信', '感谢您的来信',
  '您好，感谢您对我的关注',
];

/** 句首问候语（本身不该删 —— 真人也会问好；只有「问候 + 套话」连用时才一起剥掉） */
const LEAD_GREET_RE = /^(?:您好|你好|哈喽|hi|hello)[。！!，,、;；~～\s]*/i;

/** 句尾客套（锚定到结尾，可连串出现：`, 盼复，谢谢！` 会被整段删除） */
const TAIL_PLEASANTRIES_RE =
  /[。！!，,、;；~～\s]*(?:(?:期待您的回复|期待您的回音|静候回复|盼复|盼回复|盼您回复|如有(?:任何)?(?:问题|疑问|需要)随时(?:联系|告诉)我|随时(?:联系|咨询)我|祝(?:您)?(?:工作|招聘|求职)顺利|祝好|谢谢[您你]?[！!。]?)[。！!，,、;；~～\s]*)+$/;

/**
 * 输出侧「去 AI 味」（2026-10-08）。
 *
 * 背景：即使 SYSTEM 里已要求「口语化、1~3 句」，模型仍会**稳定地**带上客服式寒暄与客套收尾
 * （实测高发），叠在规则兜底模板上更明显 —— 真人 HR 一眼就能看出这不是人打的字。
 * 故在返回前再加一道**纯代码**清理（与 guardFabricatedLocation 同一个位置、同样思路：
 * 对模型的自觉不完全信任，关键形态用机械手段兜住）。
 *
 * 只做「删套话」，**绝不截断正文** —— 截断可能丢掉 HR 问到的关键信息，风险大于收益，
 * 长度约束交给 prompt。
 *
 * @returns 清理后的话术；若清理后为空（整条都是套话）则退回上一级结果，保证永不为空串。
 */
export function humanizeReply(text: string): string {
  const raw = String(text || '').trim();
  if (!raw) return text;

  // 1) 剥句首寒暄（可能连着两三条）
  //    先试「就是套话」，再试「问候语 + 套话」（如「您好！感谢您的回复。」——模型极爱这么开头）。
  //    注意不能一律删「您好」：只在它后面紧跟套话时才算寒暄，单独问好要留着。
  let opened = raw;
  for (let i = 0; i < 3; i++) {
    const hit = OPEN_PLEASANTRIES.find((g) => opened.startsWith(g));
    if (hit) {
      const rest = opened.slice(hit.length).replace(/^[。！!，,、;；~～\s]+/, '').trim();
      if (rest) { opened = rest; continue; }
      break; // 整条都是寒暄 ⇒ 别删成空
    }
    const gre = opened.match(LEAD_GREET_RE);
    if (gre) {
      const afterGreet = opened.slice(gre[0].length);
      const hit2 = OPEN_PLEASANTRIES.find((g) => afterGreet.startsWith(g));
      if (hit2) {
        const rest = afterGreet.slice(hit2.length).replace(/^[。！!，,、;；~～\s]+/, '').trim();
        if (rest) { opened = rest; continue; }
      }
    }
    break;
  }

  // 2) 剥句尾客套
  const closed = opened.replace(TAIL_PLEASANTRIES_RE, '').trim();

  // 3) 收尾标点整理（删掉客套后可能残留「，。」或「。。」）
  const t = (closed || opened)
    .replace(/[，,]\s*([。！!])/g, '$1')
    .replace(/。{2,}/g, '。')
    .replace(/^[，,、;；]+/, '')
    .replace(/[，,、;；]+$/, '')
    .trim();

  return t || raw;
}

/**
 * 生成回复文案（规则兜底：未配置 LLM / 模型调用失败时使用）。
 *
 * 每个意图给 2 条**同义**变体，按会话种子择一 —— 写法短、口语、不加客服套话，
 * 与 AI 分支保持同一套说话风格（用户看到的最终风格不该因为「有没有 AI」而突变）。
 */
export function composeReply(intent: HrIntent, ctx: ReplyContext = {}): string {
  const n = name(ctx);
  const phone = ctx.profile?.phone;
  const edu = ctx.profile?.education || '本科';
  const major = ctx.profile?.major || '软件工程';
  const seed = `${ctx.company || ''}|${ctx.position || ''}|${ctx.round || 1}`;
  const pick = (list: string[]) => pickVariant(list, seed);

  switch (intent) {
    case 'interview_scheduled':
      return pick([
        '收到，我会准时到，谢谢您安排！',
        '好的，那我准时过去，麻烦您到时候发下具体地点~',
      ]);
    case 'reject':
      return pick([
        '好的，理解，谢谢您抽时间看我的简历，祝好。',
        '明白了，谢谢您的反馈，祝您招聘顺利。',
      ]);
    case 'ask_interview_time':
      return pick([
        '这个时间可以的，您定就好。方便说下是线上还是线下吗？',
        '我这边时间好安排，您看什么时间合适？另外是线上还是现场面？',
      ]);
    case 'ask_availability':
      return pick([
        '时间上没什么问题，工作日都能配合，您看哪天合适？',
        '我这边时间比较灵活，按您方便的安排来就行~',
      ]);
    case 'ask_resume':
      return pick([
        '简历刚发过去了，麻烦您查收下~',
        '好的，简历已经发您了，您看下有没有需要补充的。',
      ]);
    case 'ask_salary':
      return pick([
        '薪资可以面议，主要看岗位情况，方便的话先聊聊具体职责？',
        '这个我想先了解下岗位内容，薪资面议可以吗？',
      ]);
    case 'ask_onsite':
      return pick([
        '我这边到岗比较快，一般一两周就行，具体时间可以商量。',
        '确认录用的话一两周内能到岗，时间上比较好衔接。',
      ]);
    case 'ask_experience':
      return pick([
        '主要做 Java 后端，Spring Boot、MySQL 用得比较多，简历里有写项目，您想了解哪块我细说。',
        '项目主要是 Java 后端和前后端联调，简历里都写了，有想了解的您问我~',
      ]);
    case 'ask_education':
      return pick([
        `我是${edu}，${major}专业，简历里有写~`,
        `${n ? `${n}，` : ''}${edu}学历，${major}专业，简历上能看到。`,
      ]);
    case 'ask_phone':
      return phone
        ? pick([
            `好的，我电话是 ${phone}，微信同号，您随时联系我。`,
            `电话 ${phone}，微信也是这个号~`,
          ])
        : pick([
            '联系方式简历里都有，您也可以直接在这儿找我，我看到就回。',
            '简历里有我的电话和邮箱，您看哪个方便都行~',
          ]);
    case 'greeting':
      return pick([
        `您好，看到在招「${pos(ctx)}」这个岗，简历发您了~`,
        `${n ? `${n}，` : ''}看到${com(ctx)}的「${pos(ctx)}」挺感兴趣的，简历先发您看下。`,
      ]);
    case 'other':
    default:
      return pick([
        '好的，我这边没问题，您接着说~',
        '收到，您看接下来需要我准备什么吗？',
      ]);
  }
}

export interface ReplyDecision {
  /** 是否需要回复 */
  shouldReply: boolean;
  intent: HrIntent;
  reply: string;
  /** 回复后应置的阶段 */
  nextStage: ConvStage;
  /** 停止原因（不再继续自动回复时给出） */
  stopReason?: string;
}

/**
 * 决策：收到 HR 新消息后要不要回、回什么、之后进入什么阶段。
 *
 * @param hrMessage  HR 最新一条消息
 * @param ctx        上下文（公司/岗位/轮次/档案）
 * @param lastRepliedMessage 上次我们已经回复过的那条 HR 消息（用于去重）
 */
export function decide(hrMessage: string, ctx: ReplyContext = {}, lastRepliedMessage?: string | null): ReplyDecision {
  const intent = detectIntent(hrMessage);
  const round = ctx.round || 1;

  // 已回复过同一条消息 —— 不重复回
  if (lastRepliedMessage && lastRepliedMessage.trim() === (hrMessage || '').trim()) {
    return { shouldReply: false, intent, reply: '', nextStage: 'replied', stopReason: '同一条消息已回复过' };
  }

  // 终态：已约面试
  if (intent === 'interview_scheduled') {
    return {
      shouldReply: true,
      intent,
      reply: composeReply(intent, ctx),
      nextStage: 'interview',
      stopReason: '已约到面试，停止自动回复',
    };
  }

  // 终态：被婉拒
  if (intent === 'reject') {
    return {
      shouldReply: true,
      intent,
      reply: composeReply(intent, ctx),
      nextStage: 'rejected',
      stopReason: '对方表示不合适，停止自动回复',
    };
  }

  // 护栏：轮数过多仍未有结果，停止，交给人工
  if (round > MAX_ROUNDS) {
    return {
      shouldReply: false,
      intent,
      reply: '',
      nextStage: 'stalled',
      stopReason: `已自动回复 ${MAX_ROUNDS} 轮仍未约到面试，停止并转人工跟进`,
    };
  }

  return { shouldReply: true, intent, reply: composeReply(intent, ctx), nextStage: 'replied' };
}

/** 该阶段是否还需要继续自动回复 */
export function isActiveStage(stage: string): boolean {
  return stage === 'new' || stage === 'replied';
}

/**
 * 在话术末尾追加 AI 身份标记（如「【懒懒】」）。
 * 仅当 opts.sign 为真且提供了 aiName 时追加；已含同名标记则不重复。
 * 用于「标记这是 AI 助手回复」，AI 名称来自服务端配置（默认「懒懒」）。
 */
function signIfNeeded(text: string, opts?: { aiName?: string; sign?: boolean }): string {
  if (!opts?.sign || !opts.aiName) return text;
  const sig = `【${opts.aiName.trim()}】`;
  if (!text || text.includes(sig)) return text;
  return `${text}${sig}`;
}

/** 大模型话术生成结果 */
export interface AiReply {
  /** 最终话术（AI 成功则来自模型，否则回退规则模板） */
  text: string;
  /** 实际来源：'ai' = 模型生成；'rule' = 规则兜底 */
  source: 'ai' | 'rule';
}

/**
 * 把会话历史格式化成「HR：… / 我：…」文本，供大模型语境感知。
 * 只取最近 max 条（默认 16），避免把最早几轮无关内容塞进 prompt，也控制 token。
 * 纯函数（无副作用），便于单测与复用。
 */
export function formatHistory(history?: { side: 'hr' | 'me'; text: string }[], max = 16): string {
  return (history || [])
    .slice(-max)
    .map((m) => `${m.side === 'hr' ? 'HR' : '我'}：${m.text}`)
    .join('\n');
}

/** 常见城市名：用于输出侧机械校验「现居地宣称」 */
const CITY_NAMES = [
  '北京', '上海', '广州', '深圳', '杭州', '成都', '武汉', '西安', '南京', '苏州',
  '天津', '重庆', '长沙', '郑州', '合肥', '厦门', '青岛', '大连', '福州', '济南',
  '昆明', '南昌', '宁波', '无锡', '佛山', '东莞', '珠海', '中山', '惠州', '沈阳',
  '哈尔滨', '长春', '石家庄', '太原', '贵阳', '南宁', '兰州', '乌鲁木齐', '海口', '三亚',
];

/**
 * 「我(目前在) + 城市名」——注意不能宽泛匹配 `我在`，否则「我在找工作」会被误伤。
 * 只有后接已知城市名才视为「声称现居地」。
 */
const CITY_CLAIM = new RegExp(`我(?:目前|现在|本人|现在人)?(?:人)?在\\s*(?:${CITY_NAMES.join('|')})`);

/**
 * 输出侧事实兜底（2026-09-23）：
 * 实测模型对「不得声称现居地」的指令遵守不稳定 —— 被直接问「你现在人在哪个城市」时，
 * 仍会把「期望城市」当现居地写出来（如「我目前在昆明这边」）。prompt 调优存在边际，
 * 故在返回前再加一道机械校验：命中即整句替换为安全中性表述。
 * 宁可话术通用一点，也不能编造候选人的个人信息 —— 这是发给真实 HR 的消息，不可撤回。
 */
export function guardFabricatedLocation(
  text: string,
  city?: string | null,
): { text: string; stripped: boolean } {
  if (!CITY_CLAIM.test(text)) return { text, stripped: false };
  const c = (city || '').trim();
  return {
    text: c
      ? `我主要在看${c}的机会，具体的面试安排咱们沟通一下就好。`
      : `我主要在看合适的机会，具体的面试安排咱们沟通一下就好。`,
    stripped: true,
  };
}

/**
 * 「绝对到岗表态」——把话说满的措辞（简短化的常见副作用）。
 * 刻意只在 ask_onsite 意图下启用，把误伤面压到最小。
 */
const ONSITE_ABSOLUTE_RE =
  /(随时可以|随时能|随时都|任何时候|什么(?:时候|时间)都(?:可以|行|没问题|能)|都行|都可以|怎么安排都行|听您安排|看您安排)/;

/**
 * 输出侧「到岗承诺」兜底（2026-10-08）。
 *
 * 实测：把话术改短之后，模型在「什么时候到岗」这类问题下**更爱给干脆的绝对表态**
 * （本轮真实对照里改后出现过「随时可以到岗，时间上也能商量，您这边怎么安排都行」）——
 * 这正是被明令禁止的「替候选人做承诺」，而消息发出去撤不回。
 * 与 guardFabricatedLocation 同一思路：prompt 的否定式禁令遵守不稳定，关键形态用代码兜住；
 * 宁可话术通用一点，也不能替候选人把话说满。
 */
export function guardOnsiteCommitment(text: string, intent: HrIntent): { text: string; stripped: boolean } {
  if (intent !== 'ask_onsite') return { text, stripped: false };
  if (!ONSITE_ABSOLUTE_RE.test(text)) return { text, stripped: false };
  return { text: '一两周内可以到岗，具体日期咱们再确认。', stripped: true };
}

/**
 * 「籍贯 / 老家」宣称。
 * 前缀加了约束（行首或标点之后），否则「大家是来面试的吗」会被「家是」误伤。
 */
const ORIGIN_CLAIM_RE =
  /(?:^|[，,。！!；;、\s])我?家(?:是|在|乡)|我?老家|籍贯|我是[\u4e00-\u9fa5]{2,4}人|土生土长/;

/**
 * 输出侧「籍贯编造」兜底（2026-10-08）。
 *
 * 实测：HR 问「你家里是哪里」时，模型会写「家是南方的」—— 这**同样是编造个人信息**
 * （档案里根本没有籍贯），只是措辞比「我老家是云南」隐蔽，既有检查器与 prompt 都没盖住。
 * 与另外两道 guard 同一思路：这类话一旦发出就撤不回，故加机械校验。
 * 注意命中即**整条替换**，宁可话术通用，也不让模型替候选人交代家庭信息。
 */
export function guardFabricatedOrigin(text: string, city?: string | null): { text: string; stripped: boolean } {
  if (!ORIGIN_CLAIM_RE.test(text)) return { text, stripped: false };
  const c = (city || '').trim();
  return {
    text: c
      ? `这个跟岗位关系不大吧。我主要在看${c}的机会，方便先聊下具体工作内容吗？`
      : `这个跟岗位关系不大吧，主要还是看合不合适 —— 方便先聊下具体工作内容吗？`,
    stripped: true,
  };
}

/**
 * 用大模型生成 HR 回复话术（语境感知、自然口语），失败/未配置自动回退规则模板。
 *
 * 设计：意图仍由调用方（decide）用规则判定，这里只负责「写出一句话」。
 *   - 把 HR 原文、规则识别出的意图、求职者档案、最近对话上下文一起喂给模型；
 *   - 系统提示固化护栏：不编造简历没有的经历、1-3 句、口语化、被动再给隐私；
 *   - chatText 内部「软失败」返回 null，这里回退 composeReply，绝不抛错中断投递链路。
 *
 * @param intent   规则识别出的意图（用于给模型意图提示 + 兜底模板选择）
 * @param ctx      上下文（公司/岗位/轮次/档案）
 * @param hrMessage HR 最新一条消息（原文）
 * @param history  最近若干条对话（HR/我 交替），用于语境
 */
export async function composeReplyWithAi(
  intent: HrIntent,
  ctx: ReplyContext = {},
  hrMessage?: string,
  history?: { side: 'hr' | 'me'; text: string }[],
  opts?: { aiName?: string; sign?: boolean },
): Promise<AiReply> {
  const fallback = composeReply(intent, ctx);

  if (!isAiEnabled()) {
    return { text: signIfNeeded(fallback, opts), source: 'rule' };
  }

  const n = ctx.profile?.name || '';
  const edu = ctx.profile?.education || '本科';
  const major = ctx.profile?.major || '软件工程';
  const phone = ctx.profile?.phone || '（简历里都有）';
  const city = (ctx.profile?.city || '').trim();
  const com = ctx.company || '贵公司';
  const pos = ctx.position || '相关岗位';

  const intentHint: Record<HrIntent, string> = {
    interview_scheduled: '对方已确定面试安排 —— 礼貌确认会准时参加、提前准备',
    reject: '对方表示不合适 / 婉拒 —— 得体回应、表达感谢，不要纠缠',
    ask_interview_time: '对方在问具体面试时间（哪天几点、线上还是线下）',
    ask_availability: '对方在约面试 / 问是否有空',
    ask_resume: '对方要简历 —— 引导其查看已发送的简历附件',
    ask_salary: '对方问期望薪资 —— 建议面议、看岗位匹配度与发展空间',
    ask_onsite: '对方问到岗时间 —— 说「一两周内可以到岗，具体日期再确认」这类留余地的话；严禁「随时可以」「什么时候都行」「都行」等绝对表态',
    ask_experience: '对方问经验 / 项目经历',
    ask_education: '对方问学历 / 专业 / 学校',
    ask_phone: '对方要电话 / 微信等联系方式',
    greeting: '日常打招呼 / 初次接触',
    other: '一般沟通',
  };

  // 2026-09-12：上下文窗口由 8 条放宽到 16 条。
  // BOSS 上 HR 常分多轮追问（先问学历 → 再问到岗时间 → 再约面试），
  // 只给 8 条会丢掉前面的约定，导致回复重复或与之前说辞矛盾。
  const histText = formatHistory(history);

  const SYSTEM = `你是正在求职的候选人，在招聘平台（BOSS直聘 / 猎聘等）和 HR 一对一聊天。
要求：
- 口语化、自然，1-3 句话，像真人求职者，不堆砌关键词、不套模板、不油腻。
- 【像真人打字·最重要】写成**一条微信式的短消息**：1~2 句，尽量 45 字以内，最多不超过 70 字。
  答完对方问的那件事就收住，不要补充没被问到的信息，不要总结、不要表决心。
  真人不会在招聘 App 里写整段文字。
- 【禁止出现 AI / 客服套话】下面这些词**一次都不要写**（它们是最明显的「机器味」来源）：
  「感谢您的回复」「很高兴收到您的消息」「感谢您的关注」「非常荣幸」
  「此外」「同时」「综上所述」「总的来说」「总之」「以上」
  「期待您的回复」「盼复」「如有任何问题随时联系我」「祝工作顺利」「祝好」
  「我具备扎实的…」「我拥有丰富的…」「致力于」「热爱学习」「具有较强的…」「贵公司」
- 不要复述对方的问题（不要写「您问我什么时候方便面试，我……」），直接回答。
- 不要每条都用同一个开头，连续两轮不要都用「好的」起头。中文可以省略主语。
- 允许并鼓励口语词：「嗯嗯」「好嘞」「行」「都可以」「明白」「麻烦您」「我先看下」。
- 【风格对照·务必对齐左侧】：
  · 问面试时间 → 像：「这个时间可以的，您定就好。是线上还是现场面？」
                 不像：「您好！感谢您的回复。关于面试时间，我这边是可以的，具体以您安排为准，谢谢！」
  · 要简历     → 像：「简历刚发过去了，麻烦您查收下~」
                 不像：「您好，我的简历已作为文件发送，请您查收。如果文件打不开或需要其他格式，随时告诉我，我再补发一份。」
  · 问薪资     → 像：「薪资可以面议，方便的话先聊聊具体职责？」
                 不像：「我的期望薪资可以面议，主要还是看岗位的发展空间和整体匹配度。方便的话我们先沟通一下具体职责，再谈薪资会更好一些。」
- 绝不编造简历里没有的公司、经历、数据、证书。
- 绝不编造「我的信息」里没有给出的**个人信息**：籍贯 / 老家 / 现居城市 / 家庭成员 / 年龄 / 婚育 / 期望薪资等，
  一律不得臆测、不得想象、不得用「应该是」式推断。被问到这类问题时，只用中性说法带过，或把话题引回岗位本身。
  被问「你家里是哪里的 / 老家哪的 / 哪里人」时**不要回答、不要猜、不要含糊交代**
  （「家是南方的」「老家云南」这种**同样是编造**），照这个句式把话题带回去：
  「这个跟岗位关系不大吧，主要还是看合不合适 —— 方便先聊下具体工作内容吗？」
- 也不要编造**在职/离职状态、工作年限、是否有 offer 在手**等未给出的经历信息
  （本候选人是在校/应届背景，不要提「离职手续」「上家单位」之类说法）。
- 【现居地·硬规则】你**不知道**候选人的现居城市。任何情况下都不得写「我在XX」「我人在XX」「我目前在XX」这类话。
  若对方问「你现在人在哪 / 在哪个城市 / 能不能来现场面试」，**直接照这个句式回**：
  「我主要在看${city || '目标城市'}的机会，具体的面试安排咱们沟通一下就好。」
  （句中城市只能来自上面的「期望工作城市」，不得替换成其他城市。）
- 绝不替候选人做承诺：不擅自接受或拒绝**工作地点、薪资、到岗时间、面试形式（线上/线下）与具体时间安排**等条件 —— 这些必须由本人确认。
  凡「我的信息」给出的期望城市之外的地点，一律不要表态「我可以接受」；
  面试安排用「具体时间和形式我们沟通就好」这类中性说法，不要直接应下「现场面试可以配合」。
  **到岗时间同理**：只说「一两周内可以到岗，具体日期咱们再确认」这种留余地的话，
  **绝不写「随时可以到岗」「什么时候都行」「都行」「都可以」「听您安排」** —— 简短不等于把话说满。
- 若岗位所在地与「期望城市」不同：**既不要表态接受，也不要主动拒绝**（主动劝退会直接丢掉机会）。
  只用中性说法回应，例如「这个岗位在 XX 是吗？方便先介绍下具体的工作内容和情况吗」，最多说明自己的期望城市，
  **是否继续由本人判断**，不要替候选人下「不合适」的结论。
- 必须结合「最近对话上下文」回应：承接上文，不要答非所问。
- 上下文中已经说过的内容（已报过学历、已约过时间、已发过简历等）**不要重复说**，
  也不要出现与之前承诺矛盾的表述（例如前面说"明天可以"，后面又说"随时都行"）。
- 被问到薪资/到岗等敏感点，给得体且留有余地的回答，不要过度承诺。
- 不要主动索要电话等隐私；除非对方先问，否则不写具体电话号码。
- 不要使用 Markdown 标题，不要用引号包裹整段回复。`;

  const USER = `【目标岗位】${com} ｜ ${pos}
【我的信息】姓名=${n || '（未提供）'} 学历=${edu} 专业=${major} 电话=${phone}
【期望工作城市】${city || '（未提供）'}（这只是求职意向城市，**不是现居地**；禁止据此声称"我人在某地/我在XX"，也不要声称自己在任何具体城市）
【对方意图】${intentHint[intent]}
【对方刚说的话】${hrMessage || ''}
【最近对话】
${histText || '（无）'}
请直接写一句回复 HR 的话（像发微信一样，一两句，不要标题、不要客套、不要用引号包裹整段）。`;

  // temperature 0.8：略微抬高采样多样性。避免「每个 HR 收到的句子高度雷同」——
  // 「重复」本身就是 AI 味的一大来源（真人绝不会对所有人说一字不差的话）。
  const ai = await chatText(USER, SYSTEM, { temperature: 0.8, timeoutMs: 20000 });
  if (ai && ai.trim()) {
    const cleaned = ai.trim().replace(/^["'「]|["'」]$/g, '');
    // 输出侧四道机械兜底（顺序固定，不能反）：
    //   ① guardFabricatedLocation —— 命中「我在 + 城市」整句替换（现居地，安全优先）
    //   ② guardFabricatedOrigin   —— 命中「家是 / 老家 / 籍贯 / 我是…人」整句替换（籍贯，同类）
    //   ③ guardOnsiteCommitment   —— 到岗类绝对表态整句替换（不替候选人把话说满）
    //   ④ humanizeReply           —— 剥掉客服式寒暄与客套收尾（说话风格，去 AI 味）
    // ①②③ 都在 ④ 之前：它们是整句重写，若放在 ④ 之后，humanize 的标点整理会作用在替换文本上。
    const guarded = guardFabricatedLocation(cleaned, ctx.profile?.city);
    const origin = guardFabricatedOrigin(guarded.text, ctx.profile?.city);
    const onsite = guardOnsiteCommitment(origin.text, intent);
    return { text: signIfNeeded(humanizeReply(onsite.text), opts), source: 'ai' };
  }
  return { text: signIfNeeded(humanizeReply(fallback), opts), source: 'rule' };
}
