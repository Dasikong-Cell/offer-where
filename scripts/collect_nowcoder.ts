/**
 * 牛客网（nowcoder.com）岗位采集
 * ==========================================================================
 * 结构（2026-09-23 实机探针确认）：
 *   · 搜索页 `https://www.nowcoder.com/search/job?query=<kw>&type=job` 匿名可读
 *     ⚠️ 参数名是 `query`（不是 `keyword`；用 keyword 会重定向成 `query=` 空值）
 *   · 列表卡片链接 = `/jobs/detail/{id}`（每页滚动加载约 14-15 个）
 *     卡片文本形如：`校招 | Java研发工程师-西安 14-17K·12薪 … 西安 … 电科金仓 数据服务 500-999人`
 *     / `实习 | Java开发（实习） 200-500元/天 HR刚处理简历 成都 … 艾思克瑞 …`
 *     （前缀 校招/社招/实习；个别标「简历直投官网」= 外链企业站，投递时归 need_manual）
 *   · 详情页 `https://www.nowcoder.com/jobs/detail/{id}`：
 *     h1 = 职位名；`<公司全称>·<HR职位>` 提公司（如 北京字节跳动科技有限公司·资深技术专家）；
 *     薪资 `200-500元/天` / `14-17K·12薪` / `薪资面议`；字段行含城市；
 *     `岗位职责`…`岗位要求`… 为 JD；投递按钮 = **「立即申请」**（nowcoder.ts 已同步补该标签）
 *
 * 用法：
 *   ... scripts/collect_nowcoder.ts                                  # 默认 SWE 关键词
 *   ... scripts/collect_nowcoder.ts --keyword=java,前端,算法          # 自定义关键词（逗号分隔）
 *   ... scripts/collect_nowcoder.ts --city=昆明 --limit=30            # 仅昆明、总上限 30
 *   ... scripts/collect_nowcoder.ts --detail-limit=20                 # 只抓前 20 条的详情(JD)
 */
import { upsertJob } from '../server/db.ts';
import { makeEx } from './lib/browser.ts';

const ex = makeEx('nowcoder');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const arg = (n: string, d?: string) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};

const LIMIT = Math.max(1, Number(arg('limit', '40')));
const DETAIL_LIMIT = Math.max(0, Number(arg('detail-limit', String(LIMIT))));
const CITY = arg('city', ''); // 空 = 不限城市
const KEYWORD = arg('keyword', 'java,前端,后端,开发,软件,测试,运维,算法');

/** 技术岗保留 / 非技术排除（与其它采集器口径一致） */
const KEEP = ['开发', 'java', '前端', '软件', '程序', '技术', '工程师', 'web', '后端', '全栈',
  'api', '算法', '测试', '运维', '数据', 'python', 'go', 'c++', '计算机', 'net', '架构', '嵌入式', 'ai', '系统', '研发', '服务端'];
const EXCLUDE = ['销售', '顾问', '运营', '客服', '人事', '财务', '行政', '文员', '护士', '老师', '教师',
  '导购', '司机', '普工', '中介', '主播', '兼职', '打包', '分拣', '配送', '保安', '保洁', '服务员', '收银', '乘务', '消防', '幼师', '家教', '产品经理', '设计师', '美术'];

const CITIES = '北京|上海|深圳|广州|杭州|成都|武汉|西安|南京|苏州|天津|重庆|长沙|郑州|合肥|厦门|青岛|大连|福州|济南|昆明|南昌|宁波|无锡|佛山|东莞|珠海|中山|惠州|沈阳|哈尔滨|长春|石家庄|太原|贵阳|南宁|兰州|乌鲁木齐|海口|三亚';

/** 列表页：收集 /jobs/detail/ 详情链接 */
const LIST_EVAL = `(function(){
  var d=document;
  var links=[].slice.call(d.querySelectorAll('a[href]')).map(function(a){return a.getAttribute('href')||'';});
  var seen={}; var uniq=[];
  links.forEach(function(h){ try{ var u=new URL(h,location.href).href.split('?')[0]; if(!seen[u]){seen[u]=1;uniq.push(u);} }catch(e){} });
  return uniq.filter(function(u){return /\\/jobs\\/detail\\//.test(u);});
})()`;

/** 详情页：职位 / 公司 / 薪资 / 城市 / JD */
const DETAIL_EVAL = `(function(){
  var d=document; var flat=(d.body?d.body.innerText.replace(/\\s+/g,' '):'');
  var h1=d.querySelector('h1');
  var pos=(h1?h1.innerText.trim():'') || ((d.title||'').match(/^(.+?)_/)||[])[1] || '';
  // 公司：<公司全称>·<HR职位>
  var co=(flat.match(/([\\u4e00-\\u9fa5A-Za-z0-9()（）·]{4,40}?(?:有限公司|有限责任公司|股份有限公司|集团|研究院|事务所|中心|科技))\\s*[·•]/)||[])[1]||'';
  // 薪资：200-500元/天 | 14-17K·12薪 | 薪资面议
  var sal=flat.match(/(\\d{1,3}-\\d{1,3}[Kk](?:[·•]\\d{1,2}薪)?|\\d{2,4}-\\d{2,4}\\s*元\\/天|薪资面议|面议)/);
  var salary=sal?sal[1]:'';
  // 城市：取职位名之后 ~160 字窗口内的首个城市（避开公司名里的城市）
  var idx=flat.indexOf(pos); var head=idx>=0?flat.slice(idx,idx+160):flat.slice(0,160);
  var city=(head.match(new RegExp('(${CITIES})'))||[])[1]||'';
  // JD：岗位职责/职位描述 起
  var keys=['岗位职责','职位描述','工作职责','岗位描述','职位职责','任职要求','岗位要求'];
  var jd=''; for(var i=0;i<keys.length;i++){var k=flat.indexOf(keys[i]); if(k>=0){jd=flat.slice(k,k+3000);break;}}
  if(!jd) jd=flat.slice(0,3000);
  return ({position:pos, company:co, salary:salary, city:city, jd:jd.slice(0,6000), textLen:flat.length});
})()`;

(async () => {
  const keywords = (KEYWORD || '').split(',').map((s) => s.trim()).filter(Boolean);
  const pool: any[] = [];
  let detailOpened = 0;

  /** 列表采集：滚动加载后收集详情链接 */
  async function collectList(listUrl: string): Promise<string[]> {
    console.log(`[列表] ${listUrl}`);
    const nav = await ex('navigate', { url: listUrl, waitUntil: 'domcontentloaded' });
    if (!nav.ok) { console.log('导航失败', JSON.stringify(nav).slice(0, 140)); return []; }
    await sleep(4500);
    for (let i = 0; i < 5; i++) { await ex('eval', { script: 'window.scrollBy(0,1600); "ok"' }); await sleep(700); }
    const r = await ex('eval', { script: LIST_EVAL });
    return (r.data as any) || [];
  }

  /** 单卡片详情抓取 + 客户端过滤（技术岗 + 城市） */
  async function fetchDetail(url: string, idx: number, total: number): Promise<any | null> {
    let item: any = { apply_url: url, city: null, position: null, company: null, salary: null, jd: null };
    try {
      const n2 = await ex('navigate', { url, waitUntil: 'domcontentloaded' });
      if (n2.ok) {
        await sleep(3000);
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
        console.log(`[${idx + 1}/${total}] ✅ ${String(item.position).slice(0, 26)} | ${String(item.company || '').slice(0, 16)} | ${item.salary || '-'} | ${item.city || '-'}`);
      }
    } catch (e: any) {
      console.log(`[${idx + 1}/${total}] ⚠️ 详情失败：${String(e?.message || e).slice(0, 60)}`);
    }
    await sleep(1200);
    return item;
  }

  const seen = new Set<string>();
  for (const kw of keywords) {
    if (pool.length >= LIMIT) break;
    const lu = `https://www.nowcoder.com/search/job?query=${encodeURIComponent(kw)}&type=job`;
    const cards: string[] = (await collectList(lu)).filter((u) => !seen.has(u));
    cards.forEach((u) => seen.add(u));
    console.log(`[列表] 搜索[${kw}] 新增 ${cards.length} 个详情链接（累计去重 ${seen.size}）`);
    const target = cards.slice(0, LIMIT - pool.length);
    for (let i = 0; i < target.length; i++) {
      const url = target[i];
      let item: any = { apply_url: url, city: null, position: null, company: null, salary: null, jd: null };
      if (detailOpened < DETAIL_LIMIT) {
        const det = await fetchDetail(url, i, target.length);
        if (!det) continue; // 客户端过滤 → 跳过
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
    upsertJob({ source: 'nowcoder', ...j, status: 'candidate' } as any);
    inserted++;
  }
  console.log(`\n=== 牛客入库 ${inserted} 个（source=nowcoder, status=candidate）===`);
  if (inserted) console.log('    下一步：POST /api/jobs/match {source:"nowcoder",status:"candidate"} 算分后再投');
  if (!inserted) console.log('    （搜索无结果或全被过滤；可换关键词或放宽 KEEP/EXCLUDE）');
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
