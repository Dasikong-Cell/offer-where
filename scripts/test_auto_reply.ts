/**
 * 自动回复引擎的规则回归测试（不需要浏览器）
 * 用法: tsx scripts/test_auto_reply.ts
 */
import { detectIntent, composeReply, decide, formatHistory, type HrIntent } from '../server/services/apply/autoReply.ts';

// [HR 消息, 期望意图]
const CASES: Array<[string, HrIntent]> = [
  // ── 容易误判的关键用例 ──
  ['你挺合适的', 'other'],                       // 曾会被误判成 reject
  ['你的经历跟我们岗位很匹配', 'other'],          // 曾会被误判成 reject
  ['明天方便面试吗', 'ask_interview_time'],       // 疑问句，不能当已约面试
  ['面试时间定在明天下午3点', 'interview_scheduled'], // 陈述句，确认已约
  ['好的，那就定在下周一吧', 'interview_scheduled'],
  ['已发送面试邀请，请查收', 'interview_scheduled'],
  ['不好意思，我们觉得你不太合适', 'reject'],
  ['岗位已经招到人了', 'reject'],

  // ── 常规意图 ──
  ['你好', 'greeting'],
  ['你好，方便发一份简历吗', 'ask_resume'],
  ['把你的简历发我看看', 'ask_resume'],
  ['你期望薪资多少', 'ask_salary'],
  ['什么时候能到岗', 'ask_onsite'],
  ['你有几年工作经验', 'ask_experience'],
  ['你是什么学历', 'ask_education'],
  ['留个电话吧', 'ask_phone'],
  ['你好，请问什么时候方便沟通一下', 'ask_availability'],
];

let pass = 0;
let fail = 0;
console.log('=== 意图识别回归测试 ===');
for (const [msg, expected] of CASES) {
  const got = detectIntent(msg);
  const ok = got === expected;
  if (ok) pass++; else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} | 期望=${expected.padEnd(20)} 实得=${got.padEnd(20)} | ${msg}`);
}
console.log(`\n结果: 通过 ${pass}/${CASES.length}，失败 ${fail}`);

console.log('\n=== 回复文案样例 ===');
const ctx = {
  company: '某某科技',
  position: 'Java开发',
  profile: { name: '杨欣宇', education: '本科', major: '软件工程', phone: null },
};
for (const msg of ['你好', '方便发一份简历吗', '明天方便面试吗', '面试时间定在明天下午3点', '我们觉得你不太合适']) {
  const d = decide(msg, { ...ctx, round: 1 });
  console.log(`\nHR: ${msg}`);
  console.log(`  意图=${d.intent} 应回复=${d.shouldReply} 阶段=${d.nextStage}${d.stopReason ? ' 停止原因=' + d.stopReason : ''}`);
  if (d.reply) console.log(`  回复: ${d.reply}`);
}

console.log('\n=== 护栏测试 ===');
const same = decide('你好', { ...ctx, round: 1 }, '你好');
console.log(`重复同一条消息 -> 应回复=${same.shouldReply} (期望 false) 原因=${same.stopReason}`);
const over = decide('你好', { ...ctx, round: 9 });
console.log(`超过 ${8} 轮 -> 应回复=${over.shouldReply} (期望 false) 原因=${over.stopReason}`);

console.log('\n=== 上下文(历史)读取能力测试 ===');
// 自动回复必须能读取最近对话上下文，避免重复/矛盾。核心逻辑抽成纯函数 formatHistory。
// 造 20 条历史（HR/我 交替），验证：只取最近 16 条、且格式正确接入 prompt。
const hist = Array.from({ length: 20 }, (_, i) => ({
  side: (i % 2 === 0 ? 'me' : 'hr') as 'me' | 'hr',
  text: `第${i + 1}条`,
}));
const out = formatHistory(hist);
const lines = out.split('\n').filter(Boolean);
if (lines.length === 16 && out.includes('第17条') && !out.includes('第1条')) {
  pass++; console.log(`PASS | 历史截取最近16条: 末条含「第17条」、不含「第1条」(共 ${lines.length} 行)`);
} else {
  fail++; console.log(`FAIL | 历史截取错误: 行数=${lines.length}, 含第1条=${out.includes('第1条')}, 含第17条=${out.includes('第17条')}`);
}
// 空历史不应崩
const empty = formatHistory([]);
if (empty === '') { pass++; console.log('PASS | 空历史返回空串不崩溃'); } else { fail++; console.log('FAIL | 空历史应返回空串, 实得: ' + JSON.stringify(empty)); }

console.log(`\n结果: 通过 ${pass}/${CASES.length + 2}，失败 ${fail}`);

process.exit(fail > 0 ? 1 : 0);
