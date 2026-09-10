/**
 * HR 消息自动回复引擎（规则模板版，无需大模型）
 *
 * 设计要点：
 *  1. 纯逻辑、不依赖浏览器 —— 可单独单元测试，也便于后续换成大模型生成。
 *  2. 意图识别按「优先级」匹配：先判终态（已约面试 / 婉拒），再判具体问题，最后兜底。
 *     顺序很重要，否则「明天方便面试吗」会被误判成普通打招呼。
 *  3. 护栏：同一条消息不重复回、超过 MAX_ROUNDS 轮无进展则停止（避免和 HR 无限寒暄）、
 *     识别到已约面试或婉拒后立即停止。
 */

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
const com = (ctx: ReplyContext) => ctx.company || '贵公司';
const name = (ctx: ReplyContext) => ctx.profile?.name || '';

/** 生成回复文案 */
export function composeReply(intent: HrIntent, ctx: ReplyContext = {}): string {
  const n = name(ctx);
  const phone = ctx.profile?.phone;
  switch (intent) {
    case 'interview_scheduled':
      return `好的，已收到面试安排。我会准时参加，提前做好准备。届时若有变动我会及时与您沟通，谢谢！`;
    case 'reject':
      return `好的，理解。感谢您的时间和反馈，祝您招聘顺利，也希望能有机会再次合作！`;
    case 'ask_interview_time':
      return `您提的时间我可以。麻烦告知具体的日期、时间点以及面试形式（线上/线下），我会准时参加。如果有需要提前准备的内容也请一并告知，谢谢！`;
    case 'ask_availability':
      return `我目前时间比较灵活，工作日基本都可以配合。您看什么时间方便？我按您的时间来安排。`;
    case 'ask_resume':
      return `您好，我的简历已作为文件发送，请您查收。如果文件打不开或需要其他格式，随时告诉我，我再补发一份。简历里项目经历写得比较详细，您有任何想了解的都可以直接问我。`;
    case 'ask_salary':
      return `我的期望薪资可以面议，主要还是看岗位的发展空间和整体匹配度。方便的话我们先沟通一下具体职责和团队情况，再谈薪资会更好一些。`;
    case 'ask_onsite':
      return `我目前在找工作状态，确认录用后可以较快到岗，一般一到两周内就能入职，具体时间可以协商。`;
    case 'ask_experience':
      return `我有相关的项目与实习经历，主要做 Java 后端和 Web 全栈方向，常用 Spring Boot、MySQL、MyBatis，也做过前后端联调。具体的项目职责和技术细节简历里都有写，您有感兴趣的部分我可以展开讲。`;
    case 'ask_education':
      return `我是${ctx.profile?.education || '本科'}学历，${ctx.profile?.major || '软件工程'}专业，简历里有完整的教育背景，您可以看下。${n ? `我是${n}。` : ''}`;
    case 'ask_phone':
      return phone
        ? `好的，我的联系电话是 ${phone}，微信同号。您方便的时间都可以联系我，我也随时看消息。`
        : `好的，我的联系方式在简历里都有（电话和邮箱），您也可以直接在这个平台上联系我，我看到会第一时间回复。`;
    case 'greeting':
      return `您好！${n ? `我是${n}，` : ''}很高兴收到您的消息。我对${com(ctx)}的「${pos(ctx)}」很感兴趣，简历已发您，方便的话我们可以进一步沟通。`;
    case 'other':
    default:
      return `您好，感谢您的回复。我对${com(ctx)}的「${pos(ctx)}」依然很感兴趣，您刚才说的我这边没有问题。如果还有其他想了解的，随时问我都可以，盼复，谢谢！`;
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
