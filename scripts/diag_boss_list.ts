/**
 * 诊断：提取会话列表项的结构化字段（time/name/company/title/lastMsg）。
 */
import { openChat } from '../server/services/apply/bossChat';

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
  const r = await ex('eval', {
    script: `(()=>{
      const uls=document.querySelectorAll('.user-list-content ul');
      let t=null; for(const u of uls){ if(u.children.length>0){ t=u; break; } }
      if(!t) return JSON.stringify({err:'NO_LIST'});
      const out=[];
      for(let i=0;i<Math.min(5,t.children.length);i++){
        const li=t.children[i];
        const fc=li.querySelector('.friend-content')||li;
        const nameEl=li.querySelector('.name-text');
        const name=nameEl?nameEl.innerText.trim():'';
        // 找可能的公司/岗位元素：class 含 company / sub / title / job / position
        const cand=[].slice.call(fc.querySelectorAll('[class*=company],[class*=sub],[class*=title],[class*=job],[class*=position],[class*=info]'));
        const candTexts=cand.map(e=>(e.className||'')+' => '+(e.innerText||'').replace(/\\s+/g,' ').trim()).slice(0,6);
        const fullText=(fc.innerText||'').replace(/\\s+/g,' ').trim();
        out.push({i,name,candTexts,fullText:fullText.slice(0,160)});
      }
      return JSON.stringify({items:out});
    })()`,
  });
  const d = JSON.parse((r.data as string) || '{}');
  for (const it of d.items || []) {
    console.log(`\n===== 列表项 ${it.i} | name=${it.name} =====`);
    console.log('  fullText:', it.fullText);
    for (const c of it.candTexts) console.log('   cand:', c);
  }
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
