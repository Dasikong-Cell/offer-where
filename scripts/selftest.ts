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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
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
try {
  if (!fs.existsSync(resumePath)) throw new Error('简历文件不存在：' + resumePath);
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

const t4 = matchResumeToJob(RESUME_BLOB, SKILLS_FIX, '', undefined, 'Java开发工程师');
check('无 JD 时用职位名兜底', t4.score > 0 && t4.score <= 70, `score=${t4.score}（封顶70）`);
check('无 JD 时给出提示', t4.suggestions.some((s) => /职位名/.test(s)), t4.suggestions[0]?.slice(0, 40) || '');

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
check('AI 已启用', isAiEnabled(), isAiEnabled() ? 'deepseek-chat' : '未配置');

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
console.log('\n══════ 汇总 ══════');
console.log(`通过 ${pass} / 共 ${pass + fail}${fail ? `，失败 ${fail}` : ''}`);
if (fail) {
  console.log('\n失败明细：');
  for (const r of results.filter((x) => !x.ok)) console.log(`  ❌ ${r.name}  ${r.detail}`);
}
console.log(fail ? '\n❌ 自检未全部通过' : '\n✅ 全部通过');
process.exit(fail ? 1 : 0);
