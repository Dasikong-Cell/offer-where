/**
 * 验证自动回复全链路（只读，不发送）：对已知有真实 HR 文本的会话，
 * 打开 → 读消息 → 打印解析结果 + 意图 + 生成的回复。
 * 用于校准 readConversation 的 HR/我 区分与 decide 的意图识别。
 */
import { openChat, listConversations, openConversation, readConversation } from '../server/services/apply/bossChat';
import { decide } from '../server/services/apply/autoReply';

async function main() {
  await openChat();
  const convs = await listConversations();
  // 目标：已知有真实 HR 文本的会话
  const targets = convs.filter((c) =>
    ['冯女士', '王女士', '赵先生'].includes(c.name) ||
    /中软国际|科锐国际|软通动力|华为/.test(c.company)
  );
  console.log(`命中目标会话: ${targets.length} 个\n`);
  for (const c of targets) {
    console.log(`===== ${c.name} @ ${c.company} =====`);
    const ok = await openConversation(c.key);
    console.log(`open=${ok}`);
    const { messages, lastHr } = await readConversation();
    console.log(`解析消息数: ${messages.length}`);
    for (const m of messages) console.log(`   [${m.side}] ${m.text.slice(0, 60)}`);
    console.log(`lastHr: ${lastHr ? lastHr.slice(0, 60) : '(空)'}`);
    if (lastHr) {
      const decision = decide(lastHr, { hrName: c.name, company: c.company, round: 1 });
      console.log(`意图=${decision.intent} 停止=${decision.stopReason || '否'}`);
      console.log(`回复=${decision.reply || '(无)'}`);
    }
    console.log('');
  }
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
