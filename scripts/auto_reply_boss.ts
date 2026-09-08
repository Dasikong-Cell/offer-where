/**
 * BOSS 自动回复一轮扫描（dryRun 默认开，加 --send 才真实发送）
 *
 * 流程：进聊天页 → 列会话 → 逐一打开 → 读最新 HR 消息 → 意图识别 → 生成回复
 *       →（dryRun 仅预览 / --send 真实发送文本或简历）→ 落库去重
 */
import {
  openChat,
  listConversations,
  openConversation,
  readConversation,
  sendText,
  sendResume,
  ConvSummary,
} from '../server/services/apply/bossChat';
import { decide } from '../server/services/apply/autoReply';
import { getConversation, upsertConversation } from '../server/db';

const DRY = !process.argv.includes('--send');
const ONLY_UNREAD = process.argv.includes('--unread');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) : 0;
const nameArg = process.argv.find((a) => a.startsWith('--name='));
const NAMES = nameArg ? nameArg.split('=')[1].split(',').map((s) => s.trim()).filter(Boolean) : [];

async function main() {
  console.log(`\n===== BOSS 自动回复扫描 (${DRY ? 'DRY-RUN 不发送' : 'REAL SEND'} ) =====`);
  await openChat();
  const convs: ConvSummary[] = await listConversations();
  console.log(`会话总数: ${convs.length}`);
  let targets = ONLY_UNREAD ? convs.filter((c) => c.unread) : convs;
  if (NAMES.length) targets = targets.filter((c) => NAMES.includes(c.name));
  const limited = LIMIT > 0 ? targets.slice(0, LIMIT) : targets;
  console.log(`本轮处理: ${limited.length} 个\n`);

  let sent = 0;
  let skipped = 0;
  for (const c of limited) {
    console.log(`--- ${c.name} @ ${c.company || '?'} | unread=${c.unread} | ${c.lastMsg.slice(0, 40)}`);
    const ok = await openConversation(c.key);
    if (!ok) {
      console.log('   ✗ 未打开（匹配失败）');
      skipped++;
      continue;
    }
    const { messages, lastHr } = await readConversation();
    if (!lastHr) {
      console.log('   ⊘ 无 HR 消息（可能只有我方招呼）');
      skipped++;
      continue;
    }
    const db = getConversation(c.key);
    if (db && db.last_hr_message === lastHr) {
      console.log('   ⊘ 该 HR 消息已处理过，跳过');
      skipped++;
      continue;
    }
    const round = db ? (db.round || 0) + 1 : 1;
    const decision = decide(lastHr, {
      hrName: c.name,
      company: c.company,
      round,
    });
    console.log(`   HR: ${lastHr.slice(0, 70)}`);
    console.log(`   意图=${decision.intent} 停止=${decision.stop}`);
    console.log(`   回复=${decision.reply || '(无)'}`);

    if (DRY) {
      console.log('   [DRY] 不发送\n');
      continue;
    }
    // 真实发送
    let done = false;
    if (decision.intent === 'ask_resume') {
      done = await sendResume();
      console.log(`   → 发简历: ${done ? 'ok' : 'fail'}`);
    }
    if (decision.reply) {
      const s = await sendText(decision.reply);
      console.log(`   → 发文本: ${s ? 'ok' : 'fail'}`);
      done = done || s;
    }
    if (done) {
      upsertConversation({
        conv_key: c.key,
        platform: 'boss',
        hr_name: c.name,
        company: c.company,
        position: '',
        job_url: '',
        stage: decision.stop ? 'done' : 'active',
        last_hr_message: lastHr,
        last_reply: decision.reply,
        last_hr_message_at: new Date().toISOString(),
        last_replied_at: new Date().toISOString(),
        round,
      });
      sent++;
    }
    console.log('');
  }
  console.log(`\n===== 完成: 发送 ${sent}, 跳过 ${skipped} =====`);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
