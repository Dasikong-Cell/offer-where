/**
 * 国聘（iguopin.com）岗位采集 —— **走官方 JSON 接口**（2026-09-21 实测）
 * ==========================================================================
 * 为什么不用 DOM：
 *   国聘列表页是前端异步渲染，卡片（.job-card）里**没有岗位 id、没有详情链接**，
 *   且 CDP 点击卡片不触发跳转 —— DOM 路线既慢（等 12s）又拿不到详情。
 *   而接口 `/api/jobs/v1/list` **匿名 POST 即可调用**，一次返回 30+ 字段，
 *   **连 JD 正文（contents）都带**，因此连详情接口都不需要。
 *
 * 用法：
 *   # 采集 3 页（默认每页 20）
 *   ./node/node.exe node_modules/tsx/dist/cli.mjs scripts/collect_iguopin.ts
 *   # 采 5 页、每页 50 条
 *   ... scripts/collect_iguopin.ts --pages=5 --page-size=50
 *   # 只保留昆明的岗位（按 district_list 客户端过滤）
 *   ... scripts/collect_iguopin.ts --city=昆明
 */
import { upsertJob } from '../server/db.ts';

const arg = (n: string, d?: string) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const PAGES = Math.max(1, Number(arg('pages', '3')));
const PAGE_SIZE = Math.min(50, Math.max(5, Number(arg('page-size', '20'))));
const CITY = arg('city', '');           // 空 = 不限城市
const API = 'https://gp-api.iguopin.com/api/jobs/v1/list';

/** 技术岗保留词 / 非技术排除词（与其它采集器口径一致） */
const KEEP = ['开发', 'java', '前端', '软件', '程序', '技术', '工程师', 'web', '后端', '全栈',
  'api', '算法', '测试', '运维', '数据', 'python', 'go', 'c++', '计算机', 'net', '架构', '嵌入式', 'ai'];
const EXCLUDE = ['销售', '顾问', '运营', '客服', '人事', '财务', '行政', '文员', '护士', '老师', '教师',
  '导购', '司机', '普工', '商务', '中介', '主播', '兼职', '代理师', '经纪人'];

const fetchJson = async (body: unknown): Promise<any> => {
  const r = await fetch(API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
      Referer: 'https://www.iguopin.com/',
    },
    body: JSON.stringify(body),
  });
  return r.json();
};

/** 去掉 JD 里的 HTML 标签，压缩空白 */
const plain = (s: unknown): string =>
  String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();

/**
 * district_list 形如 [{area_code:'000000.420000.420100.4201', area_cn:'湖北省-武汉市-...'}]
 * → 取 area_cn 的第一段作为城市（湖北省-武汉市-洪山区 → 武汉市）
 */
const cityOf = (item: any): string => {
  const d = item?.district_list;
  const arr = Array.isArray(d) ? d : [];
  const first = arr.find((x: any) => x && (x.area_cn || typeof x === 'string'));
  if (!first) return '';
  const raw = typeof first === 'string' ? first : String(first.area_cn || '');
  const parts = raw.split(/[-·/]/).map((s) => s.trim()).filter(Boolean);
  // 「湖北省-武汉市-洪山区」→ 武汉市；只有一级就用它
  return (parts.find((p) => /市$/.test(p)) || parts[parts.length - 1] || parts[0] || '').slice(0, 20);
};

/** 搜索关键词（服务端 job_name 检索，实测有效） */
const KEYWORDS = [
  '软件工程师', 'Java', '后端', '前端', '测试', 'Python', '数据开发', '运维', '算法', '全栈', '嵌入式',
];

(async () => {
  const pool: any[] = [];
  const seen = new Set<string>();
  let kwIdx = 0;
  for (const kw of KEYWORDS) {
    kwIdx++;
    let added = 0;
    for (let page = 1; page <= PAGES; page++) {
      const j = await fetchJson({ page, page_size: PAGE_SIZE, job_name: kw });
      if (j.code !== 200 || !j.data) { console.log(`[${kwIdx}] 接口异常: ${JSON.stringify(j).slice(0, 120)}`); break; }
      const list: any[] = j.data.list || [];
      if (!list.length) break;
      for (const it of list) {
        const name = String(it.job_name || '').trim();
        const lower = name.toLowerCase();
        if (!name) continue;
        if (EXCLUDE.some((e) => lower.includes(e))) continue;
        if (!KEEP.some((k) => lower.includes(k))) continue;
        const city = cityOf(it);
        if (CITY && !city.includes(CITY)) continue;
        const jid = String(it.job_id || '');
        const url = `https://www.iguopin.com/job/detail?id=${jid}`;
        if (!jid || seen.has(jid)) continue;
        seen.add(jid);
        const hasWage = Number(it.min_wage) > 0 || Number(it.max_wage) > 0;
        const wage = hasWage
          ? `${Math.round(Number(it.min_wage) / 1000)}-${Math.round(Number(it.max_wage) / 1000)}K${it.wage_unit_cn ? `（${it.wage_unit_cn}）` : ''}`
          : (it.is_negotiable ? '面议' : '');
        pool.push({
          apply_url: url,
          company: it.company_name || null,
          position: name,
          city: city || null,
          salary: wage,
          jd: plain(it.contents).slice(0, 6000) || null,
          requirements: [
            it.education_cn && `学历：${it.education_cn}`,
            it.experience_cn && `经验：${it.experience_cn}`,
            it.nature_cn && `性质：${it.nature_cn}`,
            it.recruitment_type_cn && `类型：${it.recruitment_type_cn}`,
            it.category_cn && `职能：${it.category_cn}`,
            // 国聘的 district_list 粒度不统一（有时是省、有时是市、有时是区），
            // 把完整地区串保留在要求里，避免丢信息
            it.district_list?.[0]?.area_cn && `地区：${it.district_list[0].area_cn}`,
          ].filter(Boolean).join('；') || null,
        });
        added++;
      }
      if (list.length < PAGE_SIZE) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    console.log(`[${kwIdx}/${KEYWORDS.length}] 关键词=${kw} 入池 +${added} 累计 ${pool.length}`);
  }

  let inserted = 0;
  for (const j of pool) {
    if (!j.apply_url) continue;
    upsertJob({ source: 'iguopin', ...j, status: 'candidate' } as any);
    inserted++;
  }
  console.log(`\n=== 国聘入库 ${inserted} 个（source=iguopin, status=candidate）===`);
  if (inserted) console.log('    下一步：POST /api/jobs/match {source:"iguopin",status:"candidate"} 算分后再投');
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
