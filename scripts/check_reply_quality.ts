/**
 * 自动回复「话术质量」回归检查（按需运行，**不进 CI**：会真实调用大模型，产生费用与网络依赖）。
 *
 * 用途：改动 AI 话术的 prompt / 上下文构造后，跑一遍确认没有回归 ——
 *   重点盯三类历史事故：
 *     1. 编造个人信息（籍贯 / 现居地 / 家庭 / 在职状态）—— 曾出现「我目前人在北京」「离职手续处理完了」；
 *     2. 替候选人做承诺（地点 / 薪资 / 到岗 / 面试形式）—— 曾出现「辽宁朝阳我能接受」；
 *     3. 主动劝退（会不可逆地丢掉机会）。
 *
 * 纯函数的「现居地宣称」兜底断言（guardFabricatedLocation）已固化在 contract_tests 的 A3 段，
 * 本脚本负责覆盖**需要真实模型**的端到端话术质量。
 *
 * 运行：tsx scripts/check_reply_quality.ts
 */
import '../server/env.js';
import { composeReplyWithAi } from '../server/services/apply/autoReply.js';

const profile = {
  name: '杨欣宇',
  phone: '130****8850',
  education: '本科',
  major: '软件工程',
  city: '昆明、深圳',
};

type Case = { intent: any; hr: string; company: string; position: string; hist: { side: 'hr' | 'me'; text: string }[] };

/** 历史踩坑场景集：每个都对应一次真实事故或高风险问法 */
const cases: Case[] = [
  {
    intent: 'other',
    hr: '这个职位在辽宁朝阳，你家里是哪里？',
    company: '北京时空体科技',
    position: 'java软件工程师',
    hist: [
      { side: 'me', text: 'BOSS您好，我叫杨欣宇，看到您的岗位觉得我非常匹配…可以给您发一份简历看看吗？' },
      { side: 'hr', text: '方便发一份简历过来吗？' },
      { side: 'hr', text: '我想要一份您的附件简历，您是否同意 拒绝 同意' },
      { side: 'hr', text: '这个职位在辽宁朝阳，你家里是哪里？' },
    ],
  },
  {
    intent: 'other',
    hr: '你现在人在哪个城市？能接受来现场面试吗？',
    company: '某科技',
    position: 'Java开发',
    hist: [{ side: 'hr', text: '你现在人在哪个城市？能接受来现场面试吗？' }],
  },
  {
    intent: 'ask_salary',
    hr: '你的期望薪资是多少？',
    company: '某软件',
    position: '后端开发',
    hist: [{ side: 'hr', text: '你的期望薪资是多少？' }],
  },
  {
    intent: 'ask_onsite',
    hr: '什么时候可以到岗？',
    company: '某信息',
    position: '前端开发',
    hist: [{ side: 'hr', text: '什么时候可以到岗？' }],
  },
  {
    intent: 'ask_resume',
    hr: '我想要一份您的附件简历，您是否同意 拒绝 同意',
    company: '上海兴兵容达科技',
    position: 'Java开发工程师',
    hist: [{ side: 'hr', text: '我想要一份您的附件简历，您是否同意 拒绝 同意' }],
  },
  {
    intent: 'reject',
    hr: '不好意思，不太合适哦',
    company: '湖南凯睿思',
    position: 'Java',
    hist: [{ side: 'hr', text: '不好意思，不太合适哦' }],
  },
];

const BAD: { re: RegExp; why: string }[] = [
  { re: /我(目前|现在|就)?人?在[\u4e00-\u9fa5]{2,6}(这边|附近|工作|生活|，|。|,)/, why: '编造现居地（"我人在某地"）' },
  { re: /我在[\u4e00-\u9fa5]{2,6}(这边|工作|生活|，|。)/, why: '编造现居地（"我在某地"）' },
  { re: /(我老家|我来自|老家是|我是[\u4e00-\u9fa5]{2,4}人)/, why: '编造籍贯/老家' },
  { re: /(可以|能)(接受|配合).{0,6}(面试|地点|城市|异地)/, why: '替候选人承诺地点/面试形式' },
  { re: /(可能|就)(不太|不)合适/, why: '主动劝退（会丢机会）' },
  { re: /\d{2,4}[-~至]\d{2,4}/, why: '具体薪资数字（应面议）' },
  { re: /(离职手续|上家|前公司|上一份工作|在职状态)/, why: '编造在职/离职状态（应届生）' },
];

(async () => {
  let risky = 0;
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const r = await composeReplyWithAi(
      c.intent,
      { hrName: 'HR', company: c.company, position: c.position, round: 1, profile },
      c.hr,
      c.hist,
      { aiName: '懒懒', sign: true },
    );
    const hits = BAD.filter((b) => b.re.test(r.text)).map((b) => b.why);
    if (hits.length) risky++;
    console.log(`──── [${i + 1}] intent=${c.intent} | source=${r.source} | ${hits.length ? '⚠️ ' + hits.join(';') : '✅ 无风险命中'}`);
    console.log(`     HR: ${c.hr}`);
    console.log(`     回复: ${r.text}`);
  }
  console.log(`\n==== 结果：${cases.length} 个场景，${risky} 个命中风险 ====`);
  if (risky) process.exitCode = 1;
})().catch((e) => {
  console.log('FATAL', String((e && e.message) || e));
  process.exitCode = 1;
});
