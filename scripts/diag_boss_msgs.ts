/**
 * 诊断：dump 一个已打开会话的真实消息 DOM 结构，用于校准 readConversation 的
 * 选择器与 HR/我 区分逻辑。
 */
import { openChat, listConversations, openConversation } from '../server/services/apply/bossChat';

const PORT = Number(process.env.PORT) || 4400;
const BASE = `http://127.0.0.1:${PORT}/api/browser/exec`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ex(action: string, extra: any = {}): Promise<any> {
  const r = await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: 'boss', action, ...extra }),
  });
  return r.json();
}

async function main() {
  await openChat();
  const convs = await listConversations();
  console.log(`会话总数: ${convs.length}`);
  // 打开前 2 个会话做采样
  for (let i = 0; i < Math.min(2, convs.length); i++) {
    const c = convs[i];
    console.log(`\n########## 会话 ${i + 1}: ${c.name} @ ${c.company} ##########`);
    const ok = await openConversation(c.key);
    console.log(`open=${ok}`);
    await sleep(1500);
    const r = await ex('eval', {
      script: `(()=>{
        const conv=document.querySelector('.chat-conversation');
        if(!conv) return JSON.stringify({err:'NO_CONV'});
        // 候选消息容器
        const scope=conv.querySelector('.chat-conversation-content')||conv;
        // 收集所有可能的消息节点：类名里含 chat-item / msg / message / bubble / item
        const all=[].slice.call(scope.querySelectorAll('*'));
        const seen=new Set(); const out=[];
        for(const n of all){
          const cls=(n.className||'').toString();
          if(/chat-item|message-item|msg-item|chat-msg|bubble|chat-window/.test(cls)){
            if(seen.has(n)) continue; seen.add(n);
            const txt=(n.innerText||'').replace(/\\s+/g,' ').trim();
            if(!txt) continue;
            out.push({cls, txt:txt.slice(0,80), html:n.outerHTML.slice(0,200)});
          }
        }
        return JSON.stringify({count:out.length, items:out});
      })()`,
    });
    const d = JSON.parse((r.data as string) || '{}');
    console.log(`消息节点数: ${d.count}`);
    for (const it of d.items || []) {
      console.log(`  [${it.cls}] :: ${it.txt}`);
      console.log(`     html=${it.html}`);
    }
  }
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
