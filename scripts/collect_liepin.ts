/**
 * 猎聘（liepin.com）岗位采集
 * ==========================================================================
 * 结构（2026-09-23 实机探针确认，窗口已登录）：
 *   · 搜索页 `https://www.liepin.com/zhaopin/?key=<关键词>`（**参数名是 `key`**，非 keyword）
 *     实测单页可收 **39** 个详情链接；`&city=<城市码>` 可筛城市（可选）。
 *   · 详情链接形态 `https://www.liepin.com/job/{数字id}.shtml`
 *     ⚠️ 旧形态 `/lptjob/xxx` 已失效（`backfill_jd.ts` 的正则已同步修正）。
 *   · 列表卡片锚文本 = 职位名（最稳，直接取 `a.innerText`）。
 *   · 详情页正文形如：
 *     `<职位名> 急聘 15-22k 武汉-江夏区 应届 本科 学生可投 招1人 8月20日更新 聊一聊 收藏 …`
 *     `… <HR姓名> … 招聘负责人 · <公司名> 聊一聊 职位介绍 岗位描述：<JD> 任职要求 <JD> 截止日期 招聘人数 公司简介…`
 *   · **投递入口 = 「聊一聊」**（`apply/liepin.ts` 已有实现，本脚本只负责采集）。
 *
 * 用法：
 *   ... scripts/collect_liepin.ts                                   # 默认 SWE 关键词
 *   ... scripts/collect_liepin.ts --keyword=java,前端 --limit=40
 *   ... scripts/collect_liepin.ts --city=昆明 --limit=20
 *   ... scripts/collect_liepin.ts --detail-limit=15                 # 只抓前 15 条的详情(JD)
 */
import { upsertJob } from '../server/db.ts';
import { makeEx } from './lib/browser.ts';

const ex = makeEx('liepin');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const arg = (n: string, d?: string) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};

const LIMIT = Math.max(1, Number(arg('limit', '40')));
const DETAIL_LIMIT = Math.max(0, Number(arg('detail-limit', String(LIMIT))));
const CITY = arg('city', '');
// 详情页间隔：猎聘风控阈值低 —— 实测 3.5s 间隔连开 ~20 个详情页仍被判「账号行为异常」，
// 故默认放慢到 8s，并可用 --interval= 调整（宁可慢，不要被锁）。
const INTERVAL = Math.max(2000, Number(arg('interval', '8000')));
const KEYWORD = arg('keyword', 'java,前端,后端,开发,软件,测试,运维,算法,python,数据分析,全栈,实施');

/** 技术岗保留 / 非技术排除（与其它采集器口径一致） */
const KEEP = ['开发', 'java', '前端', '软件', '程序', '技术', '工程师', 'web', '后端', '全栈',
  'api', '算法', '测试', '运维', '数据', 'python', 'go', 'c++', '计算机', 'net', '架构', '嵌入式', 'ai', '研发', '服务端'];
const EXCLUDE = ['销售', '顾问', '运营', '客服', '人事', '财务', '行政', '文员', '护士', '老师', '教师',
  '导购', '司机', '普工', '中介', '主播', '兼职', '打包', '分拣', '配送', '保安', '保洁', '服务员', '收银', '乘务', '消防', '幼师', '家教', '产品经理', '美术',
  '前台', '酒店', '餐饮', '店长', '美发', '美容'];

/** 列表页：收集 `{url, pos}`（pos 取锚文本，最稳） */
const LIST_EVAL = `(function(){
  var d=document;
  var out=[]; var seen={};
  [].slice.call(d.querySelectorAll('a[href]')).forEach(function(a){
    var h=a.getAttribute('href')||'';
    if(!/\\/job\\/\\d+\\.shtml/.test(h)) return;
    var u=''; try{ u=new URL(h,location.href).href.split('?')[0]; }catch(e){ return; }
    if(seen[u]) return; seen[u]=1;
    var t=(a.innerText||'').replace(/[\\s]+/g,' ').trim().slice(0,60);
    out.push(u+'||'+t);
  });
  return out;
})()`;

/** 详情页：公司 / 薪资 / 城市 / JD（职位名由列表锚文本提供） */
const DETAIL_EVAL = `(function(){
  var d=document; var flat=(d.body?d.body.innerText.replace(/[\\s]+/g,' '):'');
  var title=d.title||'';
  var CITYD='北京|上海|广州|深圳|杭州|成都|武汉|西安|南京|苏州|天津|重庆|长沙|郑州|合肥|厦门|青岛|大连|福州|济南|昆明|南昌|宁波|无锡|佛山|东莞|珠海|中山|惠州|沈阳|哈尔滨|长春|石家庄|太原|贵阳|南宁|兰州|乌鲁木齐|海口|三亚';
  // 公司：优先取 <title> 的「-<公司>招聘信息-」（实测最稳，如「-金山软件招聘信息-猎聘」）
  // ⚠️ 猎聘把城市拼在公司名后（「-金山软件武汉招聘信息-」）→ 必须剥离结尾城市
  var co=(title.match(/-([^-]+?)招聘信息-/)||[])[1]||'';
  if(!co) co=(flat.match(/[\\u4e00-\\u9fa5]{2,10}(?:负责人|总监|经理|HR|招聘者|顾问|主管|专员|组长)\\s*[·•]\\s*([^\\s·•]{2,30})/)||[])[1]||'';
  co=String(co).replace(/[\\s]+/g,'').replace(new RegExp('('+CITYD+')$'),'');
  // 薪资：15-22k / 20-40k·13薪 / 8-11k
  var sal=(flat.match(/\\d{1,3}(?:\\.\\d)?-\\d{1,3}(?:\\.\\d)?[kK](?:[·•]\\d{1,2}薪)?/)||[])[0]||'';
  var city='';
  var m1=flat.match(/\\d{1,3}(?:\\.\\d)?-\\d{1,3}(?:\\.\\d)?[kK](?:[·•]\\d{1,2}薪)?\\s+([\\u4e00-\\u9fa5]{2,8}-[\\u4e00-\\u9fa5]{2,10})/);
  if(m1) city=m1[1].split('-')[0];
  if(!city){
    var si=flat.search(/\\d{1,3}(?:\\.\\d)?-\\d{1,3}(?:\\.\\d)?[kK]/);
    var win=si>=0?flat.slice(si,si+80):flat.slice(0,80);
    var m2=win.match(new RegExp('('+CITYD+')'));
    if(m2) city=m2[1];
  }
  // JD：职位介绍/岗位描述 起，截到 截止日期/公司简介
  var keys=['职位介绍','岗位描述','工作职责','职位描述','岗位职责','任职要求'];
  var jd='';
  for(var i=0;i<keys.length;i++){
    var k=flat.indexOf(keys[i]);
    if(k>=0){ jd=flat.slice(k,k+3200); break; }
  }
  if(!jd) jd=flat.slice(0,3000);
  var cut=jd.search(/(截止日期|公司简介|猎聘温馨提示)/);
  if(cut>80) jd=jd.slice(0,cut);
  // 风控识别：liepin 会在异常访问时 302 到 safe.liepin.com 的短信验证页
  //（实测文案「账号行为异常…请进行短信验证」）→ 调用方应立刻中止本批，别硬刚验证码。
  var blocked = /safe\\.liepin\\.com/.test(location.href) || /(安全中心|风险提示|账号行为异常|短信验证)/.test(title + flat.slice(0, 200));
  return {company:co, salary:sal, city:city, jd:jd.slice(0,6000), textLen:flat.length, blocked:blocked};
})()`;

(async () => {
  const keywords = (KEYWORD || '').split(',').map((s) => s.trim()).filter(Boolean);
  const pool: any[] = [];
  let detailOpened = 0;
  let blockedOut = false;
  const seen = new Set<string>();

  for (const kw of keywords) {
    if (pool.length >= LIMIT || blockedOut) break;
    const lu = `https://www.liepin.com/zhaopin/?key=${encodeURIComponent(kw)}${CITY ? `&city=${encodeURIComponent(CITY)}` : ''}`;
    console.log(`[列表] ${lu}`);
    const nav = await ex('navigate', { url: lu, waitUntil: 'domcontentloaded' });
    if (!nav.ok) { console.log('  导航失败', JSON.stringify(nav).slice(0, 140)); continue; }
    await sleep(5000);
    for (let i = 0; i < 4; i++) { await ex('eval', { script: 'window.scrollBy(0,1600); "ok"' }); await sleep(700); }
    const cards: string[] = ((await ex('eval', { script: LIST_EVAL })).data as any) || [];
    console.log(`[列表] 搜索[${kw}] 收集到 ${cards.length} 个详情链接`);

    for (const c of cards) {
      if (pool.length >= LIMIT) break;
      const [url, pos] = String(c).split('||');
      if (!url || seen.has(url)) continue;
      seen.add(url);
      // 锚文本常带「【 城市 】」徽标尾巴 → 截到「【」为止
      const cleanPos = String(pos || '').split(/[【\[]/)[0].replace(/\s+/g, ' ').trim().slice(0, 60);
      let item: any = { apply_url: url, position: cleanPos || null, city: null, company: null, salary: null, jd: null };
      if (detailOpened < DETAIL_LIMIT) {
        const n2 = await ex('navigate', { url, waitUntil: 'domcontentloaded' });
        if (n2.ok) {
          await sleep(4500); // 猎聘详情页较慢，且不宜过快（风控敏感）
          const det: any = (await ex('eval', { script: DETAIL_EVAL })).data || {};
          if (det.blocked) {
            console.log('\n🛑 触发猎聘风控（账号行为异常 → safe.liepin.com 短信验证页）—— 已中止本批');
            console.log('   处置：在该平台调试窗口里人工完成短信验证，冷却一段时间后再跑；不要连续快跑详情页。');
            blockedOut = true;
            break;
          }
          item = { ...item, city: det.city || null, company: det.company || null, salary: det.salary || null, jd: (det.jd || '').slice(0, 6000) || null };
        }
        detailOpened++;
        const s = `${(item.position || '')} ${(item.jd || '')}`.toLowerCase();
        if (EXCLUDE.some((e) => s.includes(e)) && !KEEP.some((k) => s.includes(k))) {
          console.log(`[${pool.length + 1}] ⛔ 非技术岗跳过：${String(item.position).slice(0, 22)}`);
          continue;
        }
        if (CITY && !(item.city || '').includes(CITY)) {
          console.log(`[${pool.length + 1}] ⛔ 城市不符(${item.city})跳过：${String(item.position).slice(0, 22)}`);
          continue;
        }
        console.log(`[${pool.length + 1}] ✅ ${String(item.position).slice(0, 24)} | ${String(item.company || '').slice(0, 14)} | ${item.salary || '-'} | ${item.city || '-'} | JD ${(item.jd || '').length}`);
        await sleep(INTERVAL); // 详情页间隔：放慢以降低被风控概率（猎聘阈值低）
      }
      pool.push(item);
    }
  }

  let inserted = 0;
  for (const j of pool) {
    if (!j.apply_url) continue;
    upsertJob({ source: 'liepin', ...j, status: 'candidate' } as any);
    inserted++;
  }
  console.log(`\n=== 猎聘入库 ${inserted} 个（source=liepin, status=candidate）===`);
  if (inserted) console.log('    下一步：POST /api/jobs/match {source:"liepin",status:"candidate"} 算分后再投');
  if (!inserted) console.log('    （无结果或全被过滤；可换关键词或放宽 KEEP/EXCLUDE）');
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
