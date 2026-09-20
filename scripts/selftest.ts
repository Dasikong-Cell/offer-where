/**
 * 软件回归自检（只读：不发信、不投递、不改档案）
 * ==========================================================================
 * 覆盖核心纯函数的正确性与边界：简历解析 / 匹配引擎 / 邮箱抽取 / 域名归约 / 一岗一简历。
 * 用于「改动后快速确认没坏」以及「交付前测评」。
 *
 * 运行：./node/node.exe node_modules/tsx/dist/cli.mjs scripts/selftest.ts
 */
import '../server/env.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseResumeFile, structureResume } from '../server/services/resume.js';
import { matchResumeToJob } from '../server/services/match.js';
import { extractEmails, rootDomain } from '../server/services/offerbiuEmailScan.js';
import { tailorResume, parseSkills, buildResumeBlob } from '../server/services/apply/resumeTailor.js';
import { isAiEnabled } from '../server/services/apply/aiClient.js';
import { sanitizeJobText, sanitizePosition, sanitizeCompany } from '../server/db.js';
import { buildResumeHtml } from '../server/services/apply/resumeRender.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0, skip = 0;
const results: Array<{ name: string; ok: boolean; detail: string }> = [];

function check(name: string, ok: boolean, detail = '') {
  results.push({ name, ok, detail });
  ok ? pass++ : fail++;
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`);
}

// ─────────────────────────────────────────────────────────
console.log('\n══════ A. 简历解析 ══════');
const resumePath = path.join(ROOT, 'data', 'resume_source.pdf');
let struct: any = null;
if (!fs.existsSync(resumePath)) {
  // data/ 属个人数据、不入库；CI / 新机器上缺失属正常，跳过而非误报失败。
  console.log(`⏭️  跳过 A（未找到 ${path.relative(ROOT, resumePath)} —— 个人数据不入库，CI/新机器上正常缺失）`);
  skip += 6;
} else {
  try {
    struct = await parseResumeFile(resumePath);
    check('PDF 可解析', struct.rawText.length > 200, `${struct.rawText.length} 字符`);
    check('抽取到姓名', !!struct.name, struct.name || '(空)');
    check('抽取到手机号', /^1\d{10}$/.test(String(struct.phone || '')), struct.phone || '(空)');
    check('抽取到邮箱', /@/.test(String(struct.email || '')), struct.email || '(空)');
    check('抽取到技能', struct.skills.length >= 5, `${struct.skills.length} 项`);
    check('searchBlob 非空', Boolean(struct.searchBlob && struct.searchBlob.length > 50), `${(struct.searchBlob || '').length} 字符`);
  } catch (e: any) {
    check('简历解析整体', false, e?.message || String(e));
  }
}

console.log('\n══════ A2. 手机号抽取（多种常见写法） ══════');
const phoneCases: Array<[string, string]> = [
  ['电话：130-9532-8850', '13095328850'],   // 分段（本次修复）
  ['手机 138 0013 8000', '13800138000'],     // 空格分段
  ['联系方式：15912345678', '15912345678'],  // 连续
  ['+86 187 0000 0001', '18700000001'],      // 带国际区号
  ['邮箱 a@b.com 无手机', ''],               // 无手机号
];
for (const [input, expect] of phoneCases) {
  const got = structureResume(`张三\n${input}\n技能：Java`).phone || '';
  check(`手机号「${input}」`, got === expect, `→ ${got || '(空)'}${expect ? ' 期望 ' + expect : ''}`);
}

// ─────────────────────────────────────────────────────────
console.log('\n══════ B. 匹配引擎（纯本地规则，可复现） ══════');
const SKILLS_FIX = ['Java', 'Spring Boot', 'MySQL', 'Redis'];
const RESUME_BLOB = '杨欣宇 软件工程 本科 Java Spring Boot MySQL Redis Docker';

const t1 = matchResumeToJob(RESUME_BLOB, SKILLS_FIX, '招聘Java开发，要求熟悉Java、Spring Boot、MySQL、Redis，有Docker经验优先');
check('高相关 JD → 高分', t1.score >= 60, `score=${t1.score} matched=${t1.matched.length} missing=${t1.missing.length}`);

const t2 = matchResumeToJob(RESUME_BLOB, SKILLS_FIX, '招聘平面设计师，要求熟练 Photoshop、Illustrator，负责品牌视觉设计');
check('低相关 JD → 低分', t2.score < 40, `score=${t2.score}`);

const t3a = matchResumeToJob(RESUME_BLOB, SKILLS_FIX, 'Java开发工程师');
const t3b = matchResumeToJob(RESUME_BLOB, SKILLS_FIX, 'Java开发工程师');
check('同输入结果可复现', t3a.score === t3b.score, `${t3a.score} vs ${t3b.score}`);

// ⚠️ 2026-09-19 契约变更：无 JD 时**不再**用职位名兜底打分（否则按匹配度排序投递会退化成随机排序）。
// 无 JD → 明确得 0 分且 basis='none'，并提示"不应参与按分数排序"。
const t4 = matchResumeToJob(RESUME_BLOB, SKILLS_FIX, '', undefined, 'Java开发工程师');
check('无 JD 时不再兜底打分（应得 0 分）', t4.score === 0 && t4.basis === 'none', `score=${t4.score} basis=${t4.basis}`);
check('无 JD 时明确提示不可参与排序', t4.suggestions.some((s) => /(JD|排序)/.test(s)), t4.suggestions[0]?.slice(0, 40) || '');

const t5 = matchResumeToJob('', [], '');
check('全空输入不崩溃', t5.score === 0, `score=${t5.score}`);

// ─────────────────────────────────────────────────────────
console.log('\n══════ C. 招聘邮箱抽取（offerbiu 扫描核心） ══════');
const mailCases: Array<[string, string, boolean]> = [
  ['招聘邮箱：hr@company.com.cn', 'hr@company.com.cn', true],
  ['投递至 zhaopin@abc.cn / campus@abc.cn', 'zhaopin@abc.cn', true],
  ['noreply@example.com', '(应被过滤)', false],
  ['备案号 京ICP备123号 w3.org', '(无邮箱)', false],
];
for (const [input, expect, shouldFind] of mailCases) {
  const got = extractEmails(input);
  const ok = shouldFind ? got.includes(expect) : got.length === 0;
  check(`抽取「${input.slice(0, 22)}…」`, ok, got.join(',') || '(空)');
}

const domCases: Array<[string, string]> = [
  ['https://www.zhipin.com/job_detail/x.html', 'zhipin.com'],
  ['https://campus.abc.com.cn/apply', 'abc.com.cn'],
  ['https://hr.abc.co.uk/job', 'abc.co.uk'],
  ['not-a-url', ''],
];
for (const [input, expect] of domCases) {
  check(`注册域归约 ${input}`, rootDomain(input) === expect, `→ ${rootDomain(input) || '(空)'}`);
}

// ─────────────────────────────────────────────────────────
console.log('\n══════ D. 一岗一简历 ══════');
const profile = { name: '测试', school: 'X大学', major: '软件工程', education: '本科', skills: 'Java,Spring Boot,MySQL,Redis,Docker' };
check('parseSkills 解析分隔符', parseSkills(profile).length === 5, parseSkills(profile).join('|'));
check('buildResumeBlob 非空', buildResumeBlob(profile).length > 10, `${buildResumeBlob(profile).length} 字符`);
// AI 是否配置属「环境事实」而非「代码正确性」，故只提示、不判失败（换台没配 LLM 的机器也能跑通自检）
console.log(`  ${isAiEnabled() ? 'ℹ️' : '⏭️'}  AI 配置：${isAiEnabled() ? '已启用' : '未配置（将走本地规则回退）'}`);

const tailored = await tailorResume(profile as any, {
  position: 'Java开发工程师', company: '测试公司',
  jd: '任职要求：熟悉 Java、Spring Boot、MySQL、Redis、Docker，有微服务经验优先，负责后端接口开发与性能优化。',
});
check('定制产出 core 字段', Boolean(tailored.summary && tailored.markdown), `source=${tailored.source} score=${tailored.matchScore}`);
check('技能按 JD 相关度重排', tailored.orderedSkills[0] && /java/i.test(tailored.orderedSkills[0]), tailored.orderedSkills.slice(0, 4).join(','));
check('Markdown 含关键小节', /核心优势/.test(tailored.markdown) && /匹配/.test(tailored.markdown), `${tailored.markdown.length} 字符`);
if (tailored.source === 'llm') {
  const known = new Set(parseSkills(profile).map((s) => s.toLowerCase()));
  const invented = tailored.orderedSkills.filter((s) => !known.has(s.toLowerCase()));
  check('防幻觉：未凭空新增技能', invented.length === 0, invented.join(',') || '(无)');
} else {
  console.log('  ⏭️  LLM 未生效，跳过防幻觉校验（回退本地规则）');
}

// ─────────────────────────────────────────────────────────
console.log('\n══════ E. 岗位字段清洗（BOSS 加密字体污染） ══════');
// 实测脏值样本（库内 59/373 条 BOSS 岗位命中）
const cleanCases: Array<[string, string | null]> = [
  ['Java\n-K', 'Java'],                                             // 换行 + 薪资残片（数字被加密字体吞掉）
  ['java开发工程师\nK', 'java开发工程师'],
  ['Java（外包兴业银行-远程面试-项目稳定）\n-K', 'Java（外包兴业银行-远程面试-项目稳定）'],
  ['Java开发工程师', 'Java开发工程师'],                              // 干净值不动
  ['前端开发（Vue3）', '前端开发（Vue3）'],
  ['C++开发', 'C++开发'],
  ['Java 10-20K ·16薪', 'Java'],                                     // 完整薪资残片
  ['-K', null],                                                      // 整串即残片 → 置空
  ['\uE123\uE456Java\uE789', 'Java'],                                // PUA 字形
  ['  多  余   空白  ', '多 余 空白'],   // 折叠连续空白为单空格（不吞掉词间空格，避免误合并词）
];
for (const [input, expect] of cleanCases) {
  const got = sanitizeJobText(input, 80);
  check(`清洗 ${JSON.stringify(input)}`, got === expect, `→ ${JSON.stringify(got)}${got === expect ? '' : ' 期望 ' + JSON.stringify(expect)}`);
}

// ─────────────────────────────────────────────────────────
console.log('\n══════ F. 卡片尾巴清洗（老版 51job 采集器污染） ══════');
// 样本取自库内真实脏值（118/149 条 job51 岗位命中）
const cardCases: Array<[string, string]> = [
  ['软件全栈工程师(010565) 5-9千 昆明·呈贡区 无需经验 本科 java mysql 数据库', '软件全栈工程师(010565)'],
  ['上海_Java后端开发工程师 9千-1.1万 上海·杨浦区 1-3年 大专 五险一金 带薪年假', '上海_Java后端开发工程师'],
  ['人工智能算法（应用）工程师(010564) 8千-1.5万 昆明·呈贡区 3年及以上 本科 java', '人工智能算法（应用）工程师(010564)'],
  ['Java开发工程师', 'Java开发工程师'],                       // 干净值不动
  ['Java开发工程师·远程', 'Java开发工程师·远程'],              // 含·但无空格前缀 → 不误伤
  ['前端开发（Vue3）', '前端开发（Vue3）'],
];
for (const [input, expect] of cardCases) {
  const got = sanitizePosition(input);
  check(`卡片尾巴 ${input.slice(0, 20)}…`, got === expect, `→ ${JSON.stringify(got)}`);
}

const coCases: Array<[string, string | null]> = [
  ['公司全称：云南科诚卫远科技有限公司', '云南科诚卫远科技有限公司'],
  ['APP下载', null],
  ['首页', null],
  ['云南天霄科技', '云南天霄科技'],
];
for (const [input, expect] of coCases) {
  const got = sanitizeCompany(input);
  check(`公司名 ${JSON.stringify(input)}`, got === expect, `→ ${JSON.stringify(got)}`);
}

// ─────────────────────────────────────────────────────────
console.log('\n══════ G. 定制简历 HTML 渲染（一岗一简历出稿） ══════');
const html = buildResumeHtml({
  profile: { name: '张三', phone: '13000000000', email: 'a@b.com', city: '昆明' },
  struct: {
    rawText: '张三\n电话：13000000000\n求职意向\nJava开发工程师\n教育经历\n云南大学｜软件工程\n2020.09 — 2024.06\n• 主修数据结构、计算机网络\n专业技能\nJava、MySQL\n项目经历\n• 电商后台系统（Spring Boot）\n• 数据看板（Vue3）',
    name: '张三', phone: '13000000000', email: 'a@b.com',
  },
  tailored: {
    company: '测试公司', position: 'Java开发工程师',
    summary: '软件工程本科，具备 Java 后端开发能力。',
    highlights: ['熟练掌握 Java 与 Spring Boot'],
    orderedSkills: ['Java', 'Spring Boot', 'MySQL', 'Redis', 'Docker'],
  },
});
check('HTML 含姓名与应聘岗位', html.includes('张三') && html.includes('Java开发工程师'), `${html.length} 字符`);
check('HTML 含定制核心优势', html.includes('核心优势') && html.includes('软件工程本科'), '');
check('HTML 含重排后的技能', html.includes('Docker') && html.includes('class="tag"'), '');
check('HTML 保留原文经历（信息零丢失）', html.includes('项目经历') && html.includes('电商后台系统'), '');
// ⚠️ 关键：发给 HR 的简历里**不得**出现内部匹配分析
check('HTML 不泄露内部匹配信息', !/匹配度|matchScore|待补/.test(html), '');
const skillOccur = (html.match(/专业技能/g) || []).length;
check('专业技能只出现一次（未与原文重复）', skillOccur === 1, `出现 ${skillOccur} 次`);
check('HTML 自包含（无外链资源）', !/<(link|script|img)\b/i.test(html), '');

// ─────────────────────────────────────────────────────────
console.log('\n══════ 汇总 ══════');
console.log(`通过 ${pass} / 共 ${pass + fail}${skip ? `（跳过 ${skip} 项：无本地简历文件）` : ''}${fail ? `，失败 ${fail}` : ''}`);
if (fail) {
  console.log('\n失败明细：');
  for (const r of results.filter((x) => !x.ok)) console.log(`  ❌ ${r.name}  ${r.detail}`);
}
console.log(fail ? '\n❌ 自检未全部通过' : '\n✅ 全部通过');
process.exit(fail ? 1 : 0);
