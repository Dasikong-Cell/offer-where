/**
 * 应届生求职网（yingjiesheng.com）岗位采集
 * ==========================================================================
 * 结构（2026-09-21 实机探针确认）：
 *   · 列表页 `https://q.yingjiesheng.com/jobs/search/?jobarea=270200`（昆明=270200，51job 城市码）
 *     匿名可读，返回 ~12 个**频道/分类页** `/jobs/k_{id}/`（不是单岗详情！）
 *   · 频道页 `/jobs/k_{id}/` 内含多个职位卡，每张卡是一个 `<a href=".../jobdetail/{id}.html?property=...">`
 *     · property 是 URL 编码的 JSON，含结构化字段：**jobTitle / companyName / monthSalary / jobId**
 *     · 卡片正文同时内嵌 城市+经验+公司+行业+薪资+「先聊聊/立即申请」按钮
 *   · 单岗详情页 = `https://q.yingjiesheng.com/jobdetail/{id}.html`（投递入口，web 端「立即申请/先聊聊」）
 *
 * 采集策略：列表 → 频道页 → 职位卡（从 property 取结构化字段，最稳）。
 * 城市过滤：jobarea=270200 已粗筛昆明，但频道内卡片可能含其它城市，故客户端再按城市串过滤。
 *
 * 用法：
 *   ... scripts/collect_yingjiesheng.ts                     # 采昆明全部频道，技术岗过滤
 *   ... scripts/collect_yingjiesheng.ts --city=昆明
 *   ... scripts/collect_yingjiesheng.ts --cats=4 --cards=30 --interval=1500
 */
import { upsertJob } from '../server/db.ts';
import { makeEx } from './lib/browser.ts';

const ex = makeEx('yingjiesheng');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const arg = (n: string, d?: string) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};

const CITY = arg('city', '昆明');
const MAX_CATS = Math.max(1, Number(arg('cats', '12')));
const MAX_CARDS = Math.max(1, Number(arg('cards', '30')));
const INTERVAL = Math.max(1000, Number(arg('interval', '1500')));

const KEEP = ['开发', 'java', '前端', '软件', '程序', '技术', '工程师', 'web', '后端', '全栈',
  'api', '算法', '测试', '运维', '数据', 'python', 'go', 'c++', '计算机', 'net', '架构', '嵌入式', 'ai', '设计', '系统', '研发'];
const EXCLUDE = ['销售', '顾问', '运营', '客服', '人事', '财务', '行政', '文员', '护士', '教师',
  '导购', '司机', '普工', '中介', '主播', '兼职', '打包', '分拣', '配送', '保安', '保洁', '服务员', '收银', '乘务', '消防', '幼师', '家教', '柜员', '话务'];

const LIST_URL = 'https://q.yingjiesheng.com/jobs/search/?jobarea=270200';

/** 列表页：收集频道链接 /jobs/k_{id}/ */
const LIST_EVAL = `(function(){
  var d=document;
  var links=[].slice.call(d.querySelectorAll('a[href]')).map(function(a){return a.getAttribute('href')||'';});
  var seen={}; var uniq=[];
  links.forEach(function(h){ try{ var u=new URL(h,location.href).href.split('?')[0]; if(!seen[u]){seen[u]=1;uniq.push(u);} }catch(e){} });
  return uniq.filter(function(u){return /\\/jobs\\/k_/.test(u);}).slice(0,${MAX_CATS});
})()`;

/** 频道页：抽取职位卡（从 property 参数取结构化字段） */
const CARD_EVAL = `(function(){
  var d=document;
  var cards=[].slice.call(d.querySelectorAll('a')).filter(function(a){return /jobdetail\\/\\d+\\.html/.test(a.getAttribute('href')||'');});
  var out=[]; var seen={};
  cards.forEach(function(a){
    var href=a.getAttribute('href')||'';
    var base=href.split('?')[0];
    if(seen[base]) return; seen[base]=1;
    var txt=(a.innerText||'').replace(/\\s+/g,' ').trim();
    if(!txt) return;
    var m=href.match(/[?&]property=([^&]+)/);
    var prop={}; try{ prop=JSON.parse(decodeURIComponent(m[1])); }catch(e){}
    // 城市：卡片正文形如 "兰州无需经验..." / "苏州-苏州工业园区..." / "昆明-五华区..."
    var cm=txt.match(/([\\u4e00-\\u9fa5]{2,8}(?:市|区|县))\\s*(无需经验|在校生|1年|2年|3年|本科|大专|硕士|高中)/);
    var city=cm?cm[1]:(txt.match(/([\\u4e00-\\u9fa5]{2,8}(?:市|区|县))/)||[])[1]||'';
    out.push({href:base, jobTitle:prop.jobTitle||'', companyName:prop.companyName||'', salary:prop.monthSalary||'', city:city, txt:txt});
  });
  return out.slice(0,${MAX_CARDS});
})()`;

(async () => {
  console.log(`[列表] ${LIST_URL}`);
  const nav = await ex('navigate', { url: LIST_URL, waitUntil: 'domcontentloaded' });
  if (!nav.ok) { console.log('导航失败', JSON.stringify(nav).slice(0, 140)); process.exit(1); }
  await sleep(5000);
  const cats: string[] = (await ex('eval', { script: LIST_EVAL })).data || [];
  console.log(`[列表] 收集到 ${cats.length} 个频道页`);

  const pool: any[] = [];
  for (let c = 0; c < cats.length; c++) {
    const cat = cats[c];
    try {
      const n = await ex('navigate', { url: cat, waitUntil: 'domcontentloaded' });
      if (!n.ok) { console.log(`[频道 ${c + 1}] 导航失败`); continue; }
      await sleep(3500);
      for (let i = 0; i < 4; i++) { await ex('eval', { script: 'window.scrollBy(0,1000); "ok"' }); await sleep(500); }
      const cards: any[] = (await ex('eval', { script: CARD_EVAL })).data || [];
      console.log(`[频道 ${c + 1}/${cats.length}] ${cat} → ${cards.length} 个职位卡`);
      for (const card of cards) {
        const position = card.jobTitle || '';
        const company = card.companyName || '';
        const city = card.city || '';
        const salary = card.salary || '';
        const s = `${position} ${card.txt || ''}`.toLowerCase();
        if (EXCLUDE.some((e) => s.includes(e)) && !KEEP.some((k) => s.includes(k))) continue;
        if (CITY && !city.includes(CITY)) continue;
        if (!position || !card.href) continue;
        pool.push({ apply_url: card.href, company: company || null, position, city: city || null, salary: salary || null, jd: null });
      }
    } catch (e: any) {
      console.log(`[频道 ${c + 1}] ⚠️ ${String(e?.message || e).slice(0, 60)}`);
    }
    await sleep(INTERVAL);
  }

  // 去重（同 apply_url）
  const seen = new Set<string>();
  const uniq = pool.filter((j) => { if (seen.has(j.apply_url)) return false; seen.add(j.apply_url); return true; });

  let inserted = 0;
  for (const j of uniq) {
    if (!j.apply_url) continue;
    upsertJob({ source: 'yingjiesheng', ...j, status: 'candidate' } as any);
    inserted++;
  }
  console.log(`\n=== 应届生求职网入库 ${inserted} 个（source=yingjiesheng, status=candidate）===`);
  if (inserted) console.log('    下一步：POST /api/jobs/match {source:"yingjiesheng",status:"candidate"} 算分后再投');
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
