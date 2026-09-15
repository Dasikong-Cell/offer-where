import { openChat, listConversations, openConversation } from '../server/services/apply/bossChat.js';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await openChat();
  await sleep(3000);
  const convs = await listConversations();
  // 挑一个开发类岗位会话（邵女士 产品助理 / 姚先生 全栈）
  const target = convs.find((c) => /邵女士|姚先生|缪全|冯女士/.test(c.name)) || convs[0];
  const ok = await openConversation(target.key);
  console.log('open', target.name, 'company=', target.company, 'ok=', ok);
  await sleep(4000);

  const probe = await fetch('http://127.0.0.1:4400/api/browser/exec', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: 'boss', action: 'eval', script: `(()=>{
      const conv=document.querySelector('.chat-conversation');
      if(!conv) return JSON.stringify({none:true});
      const tag=conv.tagName;
      const parentCls=conv.parentElement?(conv.parentElement.className||''):'';
      // 聊天窗内所有 class 含 job/title/role/position/header 的元素文本
      const all=[...conv.querySelectorAll('*')];
      const relevant=all.filter(e=>{const c=(e.className||'').toString();return /job|title|role|position|header|info/.test(c);})
        .map(e=>({cls:(e.className||'').toString().slice(0,40), t:(e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,40)}))
        .filter(x=>x.t && x.t.length<50).slice(0,25);
      const head=conv.innerHTML.slice(0,1600);
      return JSON.stringify({tag, parentCls, relevant, head});
    })()` }),
  }).then((x) => x.json());
  const d = probe.data || probe;
  console.log('tag=', d.tag, 'parentCls=', d.parentCls);
  console.log('relevant=', JSON.stringify(d.relevant, null, 1));
  console.log('HEAD_HTML=', (d.head || '').replace(/\\s+/g, ' ').slice(0, 1200));
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
