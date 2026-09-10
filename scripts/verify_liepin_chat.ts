/**
 * 校准验证（只读，不发送）：用校准后的 liepinChatDriver 拉会话列表 + 读首个会话，
 * 确认选择器解析正确。不调用 sendText/sendResume。
 */
import { liepinChatDriver } from '../server/services/apply/liepinChat.js';

(async () => {
  console.log('[openChat] 打开 IM 面板…');
  await liepinChatDriver.openChat();

  const convs = await liepinChatDriver.listConversations();
  console.log(`[会话列表] 共 ${convs.length} 个会话`);
  console.log(
    convs.slice(0, 5).map((c, i) => `  ${i + 1}. ${c.name} | 未读=${c.unread} | ${c.lastMsg.slice(0, 40)}`).join('\n'),
  );

  if (convs.length) {
    const first = convs[0];
    console.log(`\n[打开会话] ${first.key}`);
    const ok = await liepinChatDriver.openConversation(first.key);
    console.log('  打开结果:', ok);
    const { messages, lastHr } = await liepinChatDriver.readConversation();
    console.log(`[消息] 共 ${messages.length} 条，最近一条 HR 消息:`, lastHr.slice(0, 80));
    console.log('  前 3 条:', messages.slice(0, 3).map((m) => `[${m.side}] ${m.text.slice(0, 40)}`).join(' | '));
  }
  console.log('\n[verify done — 未发送任何消息]');
  process.exit(0);
})();
