/**
 * hr_conversations 表与 helper 的冒烟测试
 * 用法: tsx scripts/test_conv_db.ts
 */
import { convKey, upsertConversation, getConversation, updateConversation, listConversations } from '../server/db.ts';

const key = convKey('boss', '张HR', '某某科技', 'Java开发');
console.log('convKey =', key);

// 1) 首次写入
const row1 = upsertConversation({
  conv_key: key,
  platform: 'boss',
  hr_name: '张HR',
  company: '某某科技',
  position: 'Java开发',
  stage: 'new',
  last_hr_message: '你好，方便发一份简历吗',
  round: 1,
});
console.log('写入后 stage =', row1.stage, '| round =', row1.round);

// 2) 再次写同样 conv_key（模拟重复扫描）不应产生新行，且不应把 round 清掉
const row2 = upsertConversation({
  conv_key: key,
  platform: 'boss',
  stage: 'replied',
  last_reply: '您好，简历已发送',
});
console.log('二次 upsert 后 stage =', row2.stage, '| round =', row2.round, '(round 应保持 1)');

// 3) 更新轮次与阶段
updateConversation(key, { round: 2, stage: 'replied', last_hr_message_at: new Date().toISOString() });
const row3 = getConversation(key)!;
console.log('update 后 stage =', row3.stage, '| round =', row3.round, '(期望 replied / 2)');

// 4) 列表查询
const all = listConversations({ platform: 'boss' });
console.log('boss 平台会话数 =', all.length, '(期望 1)');

// 5) 去重键归一化：带空格/大小写差异应视为同一会话
const key2 = convKey('boss', ' 张HR ', '某某科技', 'Java 开发');
console.log('归一化后是否同一键 =', key === key2, '(期望 true)');

const ok = all.length === 1 && row2.round === 1 && row3.round === 2 && key === key2;
console.log(ok ? '\n✅ 数据库层测试通过' : '\n❌ 数据库层测试失败');
process.exit(ok ? 0 : 1);
