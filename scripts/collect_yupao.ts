/**
 * 鱼泡直聘（yupao.com）岗位采集
 * ==========================================================================
 * 结构（2026-09-21 实机探针确认）：
 *   · 城市列表页 `https://www.yupao.com/zhaogong/{cityId}/`（昆明=a367）一次可拿 160+ 个详情链接
 *   · 详情链接形如 `/zhaogong/{数字id}.html`，**匿名可读**
 *   · 详情页 h1 = 职位名；正文含 招聘人数/薪资报酬/工作地点/核心工作内容/岗位基本条件/公司名称/法定代表人
 *
 * 与 BOSS 采集器的差别：鱼泡的列表卡片**本身没有结构化字段**（只有一大段文本），
 * 所以薪资/公司/职位名统一从**详情页**取（--detail-limit 控制访问条数，避免高频触发风控）。
 *
 * 用法：
 *   ... scripts/collect_yupao.ts --limit=60 --detail-limit=40 --interval=2500
 *   ... scripts/collect_yupao.ts --city-id=a367 --city-name=昆明
 */
import { upsertJob } from '../server/db.ts';
import { makeEx } from './lib/browser.ts';

const ex = makeEx('yupao');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const arg = (n: string, d?: string) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};

const CITY_ID = arg('city-id', 'a367');      // a367 = 昆明
const CITY_NAME = arg('city-name', '昆明');
const LIMIT = Math.max(1, Number(arg('limit', '60')));
const DETAIL_LIMIT = Math.max(0, Number(arg('detail-limit', '40')));
const INTERVAL = Math.max(1200, Number(arg('interval', '2500')));

/** 技术岗保留 / 非技术排除（与其它采集器口径一致） */
const KEEP = ['开发', 'java', '前端', '软件', '程序', '技术', '工程师', 'web', '后端', '全栈',
  'api', '算法', '测试', '运维', '数据', 'python', 'go', 'c++', '计算机', 'net', '架构', '嵌入式', 'ai', '设计'];
const EXCLUDE = ['销售', '顾问', '运营', '客服', '人事', '财务', '行政', '文员', '护士', '老师', '教师',
  '导购', '司机', '普工', '中介', '主播', '兼职', '打包', '分拣', '配送', '保安', '保洁', '服务员', '收银'];

/** 列表页：收集详情链接
 *  ⚠️ 只判断 href 里含 `.html` 而**不要**用 /\.html$/ —— 登录后链接会带 ?query 跟踪参数，
 *     锚定结尾会导致「一个都收不到」（实测踩过：登录前 32 条 → 登录后 0 条）。 */
const LIST_EVAL = `(function(){
  var ABS=function(h){try{return new URL(h,location.href).href}catch(e){return ''}};
  var out=[],seen={};
  [].slice.call(document.querySelectorAll('a[href]')).forEach(function(a){
    var h=a.getAttribute('href')||'';
    if(h.indexOf('/zhaogong/')<0 || h.indexOf('.html')<0) return;
    var u=ABS(h).split('?')[0]; if(!u||seen[u]) return; seen[u]=1;
    out.push({url:u, text:(a.innerText||'').replace(/\\s+/g,' ').trim().slice(0,120)});
  });
  return out;
})()`;

/** 详情页：职位/薪资/公司/JD */
const DETAIL_EVAL = `(function(){
  var t=(document.body&&document.body.innerText)||'';
  var flat=t.replace(/\\s+/g,' ');
  var h1=document.querySelector('h1');
  var pos=h1?h1.innerText.trim().slice(0,60):'';
  var sal=(flat.match(/\\d{3,6}-\\d{3,6}元\\/(天|月)/)||[])[1]?flat.match(/\\d{3,6}-\\d{3,6}元\\/(天|月)/)[0]:'';
  var co=(flat.match(/公司名称[：:]\\s*([^\\s·]{2,30})/)||[])[1]||'';
  if(!co){ var m=flat.match(/([\\u4e00-\\u9fa5A-Za-z0-9()（）]{4,30}(?:有限公司|有限责任公司|集团|科技|研究院|事务所))/); co=m?m[1]:''; }
  var start=flat.indexOf('职位详情');
  var jd=start>=0?flat.slice(start, start+2500):flat.slice(0,2500);
  return JSON.stringify({position:pos, salary:sal, company:co, jd:jd, textLen:flat.length,
    loginWall:/(点击登录|请登录)/.test(t)});
})()`;

(async () => {
  const listUrl = `https://www.yupao.com/zhaogong/${CITY_ID}/`;
  console.log(`[列表] ${listUrl}`);
  const nav = await ex('navigate', { url: listUrl, waitUntil: 'domcontentloaded' });
  if (!nav.ok) { console.log('导航失败', JSON.stringify(nav).slice(0, 140)); process.exit(1); }
  await sleep(4000);
  for (let i = 0; i < 6; i++) { await ex('eval', { script: 'window.scrollBy(0,1200); "ok"' }); await sleep(700); }

  const r = await ex('eval', { script: LIST_EVAL });
  const cards: Array<{ url: string; text: string }> = (r.data as any) || [];
  console.log(`[列表] 收集到 ${cards.length} 个详情链接`);

  // 列表文本先做一轮粗筛（详情页访问很贵，先剔除明显不相关的）
  const picked = cards.filter((c) => {
    const s = (c.text || '').toLowerCase();
    if (EXCLUDE.some((e) => s.includes(e))) return false;
    return KEEP.some((k) => s.includes(k));
  });
  console.log(`[列表] 粗筛后 ${picked.length} 个（命中技术岗关键词）`);

  const pool: any[] = [];
  const target = picked.slice(0, LIMIT);
  for (let i = 0; i < target.length; i++) {
    const c = target[i];
    let item: any = { apply_url: c.url, city: CITY_NAME, position: (c.text || '').split(' ')[0].slice(0, 50), company: null, salary: null, jd: null };
    if (i < DETAIL_LIMIT) {
      try {
        const n2 = await ex('navigate', { url: c.url, waitUntil: 'domcontentloaded' });
        if (n2.ok) {
          await sleep(1800);
          const d = await ex('eval', { script: DETAIL_EVAL });
          const det: any = d.data || {};
          item = {
            apply_url: c.url,
            city: CITY_NAME,
            position: det.position || item.position,
            company: det.company || null,
            salary: det.salary || null,
            jd: (det.jd || '').slice(0, 6000) || null,
          };
          console.log(`[${i + 1}/${target.length}] ✅ ${String(item.position).slice(0, 22)} | ${String(item.company || '').slice(0, 16)} | ${item.salary || '-'} | JD ${String(item.jd || '').length}字`);
        }
      } catch (e: any) {
        console.log(`[${i + 1}/${target.length}] ⚠️ 详情失败：${String(e?.message || e).slice(0, 60)}`);
      }
      await sleep(INTERVAL);
    } else {
      console.log(`[${i + 1}/${target.length}] 仅列表（超出 detail-limit）：${String(item.position).slice(0, 22)}`);
    }
    if (item.apply_url) pool.push(item);
  }

  let inserted = 0;
  for (const j of pool) {
    if (!j.apply_url) continue;
    upsertJob({ source: 'yupao', ...j, status: 'candidate' } as any);
    inserted++;
  }
  console.log(`\n=== 鱼泡入库 ${inserted} 个（source=yupao, status=candidate）===`);
  if (inserted) console.log('    下一步：POST /api/jobs/match {source:"yupao",status:"candidate"} 算分后再投');
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
