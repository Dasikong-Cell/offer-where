/**
 * 快速扫描会话列表，找出「HR 真正用文字回复过」的会话（用于验证自动回复全链路）。
 * 依据列表预览：最新消息不是我的招呼（BOSS您好）、也不是系统卡片（PK情况）的，即为真实 HR 文本。
 */
import { openChat, listConversations } from '../server/services/apply/bossChat';

async function main() {
  await openChat();
  const convs = await listConversations();
  const GREET = /BOSS您好|我叫杨欣宇/;
  const SYS = /你与该职位竞争者PK情况|查看详细分析|职位推荐|牛人竞争力/;
  const candidates = [];
  const systemOnly = [];
  for (const c of convs) {
    const preview = c.lastMsg || '';
    if (SYS.test(preview) || GREET.test(preview) || !preview) {
      systemOnly.push(c.name);
      continue;
    }
    candidates.push(c);
  }
  console.log(`会话总数: ${convs.length}`);
  console.log(`疑似真实 HR 文本回复: ${candidates.length} 个`);
  for (const c of candidates) {
    console.log(`  - ${c.name} @ ${c.company} :: ${c.lastMsg.slice(0, 60)}`);
  }
  console.log(`\n系统卡片/仅我方招呼（跳过）: ${systemOnly.length} 个`);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
