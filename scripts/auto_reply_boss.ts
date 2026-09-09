/**
 * BOSS 自动回复命令行入口（薄包装，核心逻辑在 server/services/apply/autoReplyRunner.ts）
 *
 * 用法：
 *   tsx scripts/auto_reply_boss.ts                      预览全部会话（不发送）
 *   tsx scripts/auto_reply_boss.ts --send              真实发送
 *   tsx scripts/auto_reply_boss.ts --unread            仅处理未读会话
 *   tsx scripts/auto_reply_boss.ts --unread --send --limit=10 --name=张三,李四
 */
import { runAutoReply, ReplyEvent } from '../server/services/apply/autoReplyRunner.js';

const realSend = process.argv.includes('--send');
const unreadOnly = process.argv.includes('--unread');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : 0;
const nameArg = process.argv.find((a) => a.startsWith('--name='));
const names = nameArg ? nameArg.split('=')[1].split(',').map((s) => s.trim()).filter(Boolean) : [];

function log(ev: ReplyEvent): void {
  switch (ev.type) {
    case 'start':
      console.log(`\n===== BOSS 自动回复 (${ev.realSend ? 'REAL SEND' : 'DRY-RUN 预览'} ) =====`);
      break;
    case 'list':
      console.log(`会话总数 ${ev.total}，未读 ${ev.unread}，本次处理 ${ev.will}`);
      break;
    case 'conv':
      console.log(`\n--- ${ev.name} @ ${ev.company || '?'} | ${(ev.lastMsg as string).slice(0, 40)}`);
      break;
    case 'skipped':
      console.log(`   ⊘ 跳过(${ev.reason}) ${ev.name || ''}`);
      break;
    case 'intent':
      console.log(`   HR 意图=${ev.intent} 轮次=${ev.round}${ev.stop ? ` 停止:${ev.stop}` : ''}`);
      console.log(`   回复: ${ev.reply || '(无)'}`);
      break;
    case 'dry':
      console.log('   [DRY] 不发送');
      break;
    case 'send-resume':
      console.log(`   → 发简历: ${ev.ok ? 'ok' : 'fail'}`);
      break;
    case 'send-text':
      console.log(`   → 发文本: ${ev.ok ? 'ok' : 'fail'}`);
      break;
    case 'sent':
      console.log(`   ✓ 已回复 ${ev.name}`);
      break;
    case 'aborted':
      console.log('已停止');
      break;
    case 'done':
      console.log(`\n===== 完成: 发送 ${ev.sent}, 跳过 ${ev.skipped} =====`);
      break;
    case 'error':
      console.error('错误:', ev.message);
      break;
  }
}

runAutoReply({ unreadOnly, limit, realSend, names }, log).catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
