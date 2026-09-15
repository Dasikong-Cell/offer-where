/**
 * BOSS 自动回复命令行入口（薄包装，核心逻辑在 server/services/apply/autoReplyRunner.ts）
 *
 * 注意：本脚本独立运行，需先加载 .env（LLM_ 与 MAIL_ 等），否则 AI 与邮箱配置不生效。
 */
import '../server/env.js';

/**
 * 用法：
 *   tsx scripts/auto_reply_boss.ts                      预览全部会话（不发送）
 *   tsx scripts/auto_reply_boss.ts --send              真实发送
 *   tsx scripts/auto_reply_boss.ts --unread            仅处理未读会话
 *   tsx scripts/auto_reply_boss.ts --unread --send --limit=10 --name=张三,李四
 *   tsx scripts/auto_reply_boss.ts --no-ai           强制走规则模板（不用大模型）
 *   tsx scripts/auto_reply_boss.ts --no-sign         不署名 AI 身份
 *   tsx scripts/auto_reply_boss.ts --ai-name=小助手  指定 AI 名称（默认「懒懒」）
 *   tsx scripts/auto_reply_boss.ts --positions=Java,前端  只回复与这些职位相关的 HR
 */
import { runAutoReply, ReplyEvent } from '../server/services/apply/autoReplyRunner.js';

const realSend = process.argv.includes('--send');
const unreadOnly = process.argv.includes('--unread');
const useAi = !process.argv.includes('--no-ai');
const signAi = !process.argv.includes('--no-sign');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : 0;
const nameArg = process.argv.find((a) => a.startsWith('--name='));
const names = nameArg ? nameArg.split('=')[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
const aiNameArg = process.argv.find((a) => a.startsWith('--ai-name='));
const aiName = aiNameArg ? aiNameArg.split('=')[1].trim() : undefined;
const posArg = process.argv.find((a) => a.startsWith('--positions='));
const targetPositions = posArg
  ? posArg.split('=')[1].split(/[,，、;；]+/).map((s) => s.trim()).filter(Boolean)
  : undefined;

function aiTag(ev: ReplyEvent): string {
  const base = ev.ai === 'ai' ? 'AI' : ev.ai === 'rule' ? '规则' : '';
  if (!base) return '';
  return ev.aiName ? ` [${base}·${ev.aiName}]` : ` [${base}]`;
}

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
      console.log(`   ⊘ 跳过(${ev.reason}) ${ev.name || ''}${ev.reason === 'position-unrelated' ? ` 职位:${(ev.position as string) || '?'} 目标不符` : ''}`);
      break;
    case 'intent':
      console.log(`   HR 意图=${ev.intent} 轮次=${ev.round}${aiTag(ev)}${ev.stop ? ` 停止:${ev.stop}` : ''}`);
      console.log(`   回复: ${ev.reply || '(无)'}`);
      break;
    case 'dry':
      console.log(`   [DRY] 不发送${aiTag(ev)}`);
      break;
    case 'send-resume':
      console.log(`   → 发简历: ${ev.ok ? 'ok' : 'fail'}`);
      break;
    case 'send-text':
      console.log(`   → 发文本: ${ev.ok ? 'ok' : 'fail'}${aiTag(ev)}`);
      break;
    case 'sent':
      console.log(`   ✓ 已回复 ${ev.name}${aiTag(ev)}`);
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

runAutoReply('boss', { unreadOnly, limit, realSend, names, useAi, signAi, aiName, targetPositions }, log).catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
