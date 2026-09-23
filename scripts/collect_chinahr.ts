/**
 * 中华英才网（chinahr.com）岗位采集
 * ==========================================================================
 * 结构（2026-09-21 实机探针确认）：
 *   · 列表页 `https://www.chinahr.com/job/` 匿名可读，首页推荐 ~12 个详情链接 `/detail/{hexid}`
 *   · ⚠️ 中华英才网**不支持 URL 关键词/城市搜索**（实测 `/search/?keyword=` 会被重定向回首页、
 *     `/job/?keyword=` 与 `/job/` 返回完全相同的推荐列表），所以列表只能拿到"平台推荐"岗位，
 *     数量有限（约 12 条/页），且非按城市/关键词筛选 —— 故在详情页做客户端技术岗 + 城市过滤。
 *   · 详情页 `https://www.chinahr.com/detail/{hexid}` 正文含清晰字段行：
 *     `职位 薪资元/月 全职 学历 \uFF5C经验 \uFF5C城市 \uFF5C招若干人 收藏 投简历 职位描述...`
 *     · 职位名在 <title> 的 `【职位招聘】` 里；薪资形如 `7k-10k元/月`；投递按钮 = 直接投递/投简历
 *     · 公司名走详情页里的 `/company/homepage/{id}` 链接文本（最稳），兜底用正文公司名正则
 *
 * 用法：
 *   ... scripts/collect_chinahr.ts                 # 采推荐列表 + 详情，过滤技术岗
 *   ... scripts/collect_chinahr.ts --city=昆明     # 仅保留昆明（按详情页城市串客户端过滤）
 *   ... scripts/collect_chinahr.ts --limit=12 --detail-limit=12
 *   ... scripts/collect_chinahr.ts --keyword=java            # 搜索「java」（SPA 路由 /job?value=，直链可用）
 *   ... scripts/collect_chinahr.ts --keyword=java,前端,开发,软件工程师   # 多关键词逗号分隔，合并去重
 */
import { upsertJob } from '../server/db.ts';
import { makeEx } from './lib/browser.ts';

const ex = makeEx('chinahr');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const arg = (n: string, d?: string) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};

const LIMIT = Math.max(1, Number(arg('limit', '12')));
const DETAIL_LIMIT = Math.max(0, Number(arg('detail-limit', '12')));
const CITY = arg('city', ''); // 空 = 不限城市（默认全量入库，交由投递闸门按城市过滤）
const KEYWORD = arg('keyword', ''); // 空 = 采推荐流；非空 = 搜索模式（逗号分隔多关键词）

/** 技术岗保留 / 非技术排除（与其它采集器口径一致） */
const KEEP = ['开发', 'java', '前端', '软件', '程序', '技术', '工程师', 'web', '后端', '全栈',
  'api', '算法', '测试', '运维', '数据', 'python', 'go', 'c++', '计算机', 'net', '架构', '嵌入式', 'ai', '设计', '系统'];
const EXCLUDE = ['销售', '顾问', '运营', '客服', '人事', '财务', '行政', '文员', '护士', '老师', '教师',
  '导购', '司机', '普工', '中介', '主播', '兼职', '打包', '分拣', '配送', '保安', '保洁', '服务员', '收银', '乘务', '消防', '幼师', '家教'];

const LIST_URL = 'https://www.chinahr.com/job/';

/** 列表页：收集 /detail/ 详情链接（只判 href 含 /detail/，不依赖卡片结构） */
const LIST_EVAL = `(function(){
  var d=document;
  var links=[].slice.call(d.querySelectorAll('a[href]')).map(function(a){return a.getAttribute('href')||'';});
  var seen={}; var uniq=[];
  links.forEach(function(h){ try{ var u=new URL(h,location.href).href.split('?')[0]; if(!seen[u]){seen[u]=1;uniq.push(u);} }catch(e){} });
  return uniq.filter(function(u){return /\\/detail\\//.test(u);}).slice(0,${LIMIT});
})()`;

/** 详情页：职位 / 公司 / 薪资 / 城市 / JD */
const DETAIL_EVAL = `(function(){
  var d=document; var flat=(d.body?d.body.innerText.replace(/\\s+/g,' '):'');
  var title=d.title||'';
  var pos=(title.match(/【(.+?)招聘】/)||[])[1]||'';
  var h1=d.querySelector('h1'); if(!pos && h1) pos=h1.innerText.trim();
  // 公司：优先详情页 /company/homepage/ 链接文本，兜底正文公司名正则
  var compLink=[].slice.call(d.querySelectorAll('a[href*="/company/homepage/"]')).map(function(a){return (a.innerText||'').replace(/\\s+/g,' ').trim();}).filter(Boolean)[0]||'';
  var co=compLink || (flat.match(/([\\u4e00-\\u9fa5A-Za-z0-9()（）·]{3,30}(?:有限公司|有限责任公司|集团|科技股份有限公司|研究院|中心|学校|医院|事务所))/)||[])[1]||'';
  var sal=flat.match(/[\\d]{1,3}[kK]-?[\\d]{0,3}[kK]|[\\d]{4,7}[\\s]*[-~][\\s]*[\\d]{4,7}[\\s]*元|面议/g)||[];
  var salary=sal[0]||'';
  // 城市：详情页字段行形如 (天津-武清区) 分隔符，或 工作地点：昆明
  var city=(flat.match(/\uFF5C\\s*([^\uFF5C]{2,20}?(?:市|区|县))\\s*\uFF5C/)||[])[1]
         || (flat.match(/(工作地点|工作城市|城市|地点|办公地点)[：:]\\s*([\\u4e00-\\u9fa5]{2,8}(?:市|区|县)?)/)||[])[2] || '';
  city=(city||'').replace(/^[^-－\\u4e00-\\u9fa5]+/,'').replace(/[-－].*$/,function(m){return m.length>6?'':m;}).trim().slice(0,20);
  var keys=['职位描述','岗位职责','工作职责','职位职责','岗位要求','任职要求','招聘要求'];
  var jd=''; for(var i=0;i<keys.length;i++){var idx=flat.indexOf(keys[i]); if(idx>=0){jd=flat.slice(idx,idx+3000);break;}}
  if(!jd) jd=flat.slice(0,3000);
  return ({position:pos, company:co, salary:salary, city:city, jd:jd.slice(0,5000), textLen:flat.length});
})()`;

(async () => {
  const keywords = (KEYWORD || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  /** 列表采集：给定列表 URL，滚动加载后收集 /detail/ 链接 */
  async function collectList(listUrl: string): Promise<string[]> {
    console.log(`[列表] ${listUrl}`);
    const nav = await ex('navigate', { url: listUrl, waitUntil: 'domcontentloaded' });
    if (!nav.ok) { console.log('导航失败', JSON.stringify(nav).slice(0, 140)); return []; }
    await sleep(4000);
    for (let i = 0; i < 6; i++) { await ex('eval', { script: 'window.scrollBy(0,1200); "ok"' }); await sleep(600); }
    const r = await ex('eval', { script: LIST_EVAL });
    return (r.data as any) || [];
  }

  /** 单卡片详情抓取 + 客户端过滤（技术岗 + 城市） */
  async function fetchDetail(url: string, idx: number, total: number): Promise<any | null> {
    let item: any = { apply_url: url, city: null, position: null, company: null, salary: null, jd: null };
    try {
      const n2 = await ex('navigate', { url, waitUntil: 'domcontentloaded' });
      if (n2.ok) {
        await sleep(2500);
        const det: any = (await ex('eval', { script: DETAIL_EVAL })).data || {};
        item = {
          apply_url: url,
          city: det.city || null,
          position: det.position || null,
          company: det.company || null,
          salary: det.salary || null,
          jd: (det.jd || '').slice(0, 6000) || null,
        };
        const s = `${(item.position || '')} ${(item.jd || '')}`.toLowerCase();
        if (EXCLUDE.some((e) => s.includes(e)) && !KEEP.some((k) => s.includes(k))) {
          console.log(`[${idx + 1}/${total}] ⛔ 非技术岗跳过：${String(item.position).slice(0, 22)}`);
          return null;
        }
        if (CITY && !(item.city || '').includes(CITY)) {
          console.log(`[${idx + 1}/${total}] ⛔ 城市不符(${item.city})跳过：${String(item.position).slice(0, 22)}`);
          return null;
        }
        console.log(`[${idx + 1}/${total}] ✅ ${String(item.position).slice(0, 22)} | ${String(item.company || '').slice(0, 16)} | ${item.salary || '-'} | ${item.city || '-'}`);
      }
    } catch (e: any) {
      console.log(`[${i + 1}/${total}] ⚠️ 详情失败：${String(e?.message || e).slice(0, 60)}`);
    }
    await sleep(1500);
    return item;
  }

  const pool: any[] = [];
  let detailOpened = 0;
  const listUrls: string[] = keywords.length
    ? keywords.map((kw) => `https://www.chinahr.com/job?value=${encodeURIComponent(kw)}`)
    : [LIST_URL];
  const mode = keywords.length ? `搜索[${keywords.join('/')}]` : '推荐';

  for (const lu of listUrls) {
    if (pool.length >= LIMIT) break;
    const cards: string[] = await collectList(lu);
    console.log(`[列表] ${mode} 收集到 ${cards.length} 个详情链接`);
    const target = cards.slice(0, LIMIT - pool.length);
    for (let i = 0; i < target.length; i++) {
      const url = target[i];
      let item: any = { apply_url: url, city: null, position: null, company: null, salary: null, jd: null };
      if (detailOpened < DETAIL_LIMIT) {
        const det = await fetchDetail(url, i, target.length);
        if (!det) continue; // 客户端过滤掉 → 跳过
        item = det;
        detailOpened++;
      } else {
        console.log(`[${i + 1}/${target.length}] 仅链接（超出 detail-limit）：${String(url).slice(0, 50)}`);
      }
      if (item.apply_url) pool.push(item);
    }
  }

  let inserted = 0;
  for (const j of pool) {
    if (!j.apply_url) continue;
    upsertJob({ source: 'chinahr', ...j, status: 'candidate' } as any);
    inserted++;
  }
  console.log(`\n=== 中华英才网入库 ${inserted} 个（source=chinahr, status=candidate）===`);
  if (inserted) console.log('    下一步：POST /api/jobs/match {source:"chinahr",status:"candidate"} 算分后再投');
  if (!inserted) console.log('    （搜索无结果或全被过滤；可换关键词或放宽 KEEP/EXCLUDE）');
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
