/**
 * 邮件标题要求解析单测。
 *
 * ⚠️ 本文件里的**每一条 JD 原文都是从 `data/chat.db` 真实语料里原样抄下来的**
 *    （含全角「＋」、方括号字面前缀、把要求写在「标题」之前的写法）。
 *    旧实现在这 11 条里只解析得出 1 条 —— 所以这些用例同时是**回归集**：
 *    谁把触发词、分隔符或括号处理改窄，这里立刻红。
 *
 * ⚠️ JD 原文是真实的，但 `PROFILE` 里的**姓名/学校/电话一律用占位值**（`张三` / `某某大学` /
 *    `13800000000`）—— 真实身份不许写进仓库：pre-push 的 PII 守卫会直接拦下推送
 *    （本轮就被拦过一次），而已推送的提交改写历史也收不回。
 *
 * ⚠️ 断言的重点不只是「能拼出标题」，还有两条不变量：
 *    ① **拼不出来时必须诚实**：`matched=false` + `unresolved` 非空，**不许猜**。
 *       猜错的标题比默认标题更糟 —— 默认标题至少一眼看得出是兜底。
 *    ② **抽不到要求不等于没有要求**：OCR 把要求打散的 JD 必须报 `degraded`。
 *       这与 `huangy@ieit.com` 退信是同一个根因（OCR 既读错域名，也读散要求）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSubjectPlan,
  extractSubjectRequirement,
  looksDegraded,
  normalizeSubjectText,
  planSubject,
  defaultSubject,
  splitSubjectSegments,
} from '../../server/services/apply/subjectSpec.js';

const PROFILE = {
  name: '张三',
  phone: '13800000000',
  education: '本科',
  school: '某某大学',
  major: '计算机科学与技术',
  city: '杭州',
  workYears: '1年',
  graduationYear: '2027',
  acceptAdjust: '是',
};
const JOB = { position: '后端开发工程师', company: '某某科技' };

const plan = (text: string) => buildSubjectPlan(text, PROFILE, JOB);

// ── A. 真实语料：要求 → 标题 ────────────────────────────────────────────────
// [JD 原文片段, 期望抽到的要求, 期望标题, 用例说明]
const REAL_CASES: Array<[string, string, string, string]> = [
  [
    '邮件标题格式“学历+专业+学校+姓名”',
    '学历+专业+学校+姓名',
    '本科+计算机科学与技术+某某大学+张三',
    '最常见的一种，`+` 分隔',
  ],
  [
    '请将简历发送至 hr@example.com。邮件标题：学校名+专业+姓名',
    '学校名+专业+姓名',
    '某某大学+计算机科学与技术+张三',
    '触发词是「邮件标题」而非「标题格式」；占位词是「学校名」',
  ],
  [
    '邮件标题格式：【Java全栈】 - 姓名 - 工作年限 - 最高学历院校',
    '【Java全栈】 - 姓名 - 工作年限 - 最高学历院校',
    '【Java全栈】 - 张三 - 1年 - 某某大学',
    '方括号是**字面前缀**、` - ` 分隔、占位词是「最高学历院校」',
  ],
  [
    '联系方式 dhuizhen@zjjtgc.com（邮件标题：岗位+学校+名字）',
    '岗位+学校+名字',
    '后端开发工程师+某某大学+张三',
    '要求夹在括号里；`岗位` 取的是**本岗位名称**',
  ],
  [
    '简历请投递至 yinyuzhu@mcf.org.cn。邮件标题：【保育数据库实习申请】姓名＋学校＋专业。',
    '【保育数据库实习申请】姓名＋学校＋专业',
    '【保育数据库实习申请】张三+某某大学+计算机科学与技术',
    '🔴 全角「＋」+ 方括号：旧实现两个都漏，是「只解析出 1 条」的主因之一',
  ],
  [
    '邮件标题请注明：应聘岗位 - 姓名 - 学校 - 专业 - 毕业年份',
    '应聘岗位 - 姓名 - 学校 - 专业 - 毕业年份',
    '后端开发工程师 - 张三 - 某某大学 - 计算机科学与技术 - 2027',
    '「请注明：」引导语要剥掉',
  ],
  [
    '以“应聘岗位+姓名+学校+专业+学历”为标题',
    '应聘岗位+姓名+学校+专业+学历',
    '后端开发工程师+张三+某某大学+计算机科学与技术+本科',
    '要求写在锚点**之前**（`以“…”为标题`）',
  ],
  [
    '邮件主题及附件文件名格式： “院校+专业+姓名”',
    '院校+专业+姓名',
    '某某大学+计算机科学与技术+张三',
    '🔴 用「主题」而不是「标题」；前面还有「及附件文件名」这类干扰',
  ],
  [
    '请将简历投递至 hr@example.com。邮件主题：岗位+学校+姓名',
    '岗位+学校+姓名',
    '后端开发工程师+某某大学+张三',
    // 🔴 这条**没有引号**，只有「后置式」那一路抓得到 ⇒ 是 `ANCHOR_RE` 里那个「主题」
    //    唯一的区分力来源。上面西飞那条走的是引号式，把 `主题` 从 ANCHOR_RE 删掉它照样过
    //    （破坏性对照 V8 实测：只留上面那条时，删掉「主题」**零条用例变红**）。
    '用「主题」当锚点且**不带引号**（只有后置式能抓到）',
  ],
  [
    '标题注明【Java技术合伙人-姓名】 请附上：最引以为豪的架构设计案例',
    '【Java技术合伙人-姓名】',
    '【Java技术合伙人-张三】',
    '🔴 方括号在这里包住的是**整个要求**（内部含分隔符）⇒ 后面是散文，不许接上',
  ],
  [
    '简历发送至 hr@example.com，标题名为姓名-应聘XXX岗位。',
    '姓名-应聘XXX岗位',
    '张三-后端开发工程师',
    '🔴 `应聘XXX岗位` 里的 `XXX` 是岗位占位符，必须整段替换',
  ],
  [
    '投递邮箱 hr@example.com，邮件标题命名为：岗位+姓名',
    '岗位+姓名',
    '后端开发工程师+张三',
    '「命名为」引导语',
  ],
];
for (const [jd, req, subject, why] of REAL_CASES) {
  test(`真实语料 · ${why}`, () => {
    const p = plan(jd);
    assert.equal(p.requirement, req, '抽到的要求原文');
    assert.equal(p.subject, subject, '拼出的标题');
    assert.equal(p.matched, true, '应完全照做');
    assert.deepEqual(p.unresolved, []);
    assert.equal(p.degraded, undefined, '解析成功时不该报 degraded');
  });
}

test('真实语料 · 无分隔符、靠「及」连接两个字段（`以院校及专业为标题`）', () => {
  // 这条一个分隔符都没有 —— 若「可解析性」判据只看分隔符就会整条漏掉
  const p = plan('简历请投至 hr@example.com，以院校及专业为标题');
  assert.equal(p.requirement, '院校及专业');
  assert.equal(p.subject, '某某大学及计算机科学与技术', '「及」是格式的一部分，原样保留');
  assert.equal(p.matched, true);
});

// ── B. 「抽得出来但拼不全」必须诚实（核心不变量）────────────────────────────
test('要求里有取不到值的占位词时：matched=false 且把占位词留在标题里，不静默留空', () => {
  const p = plan('请按“实习岗位名称+姓名+应聘部门+是否接受调剂”命名标题和简历名称');
  assert.equal(p.requirement, '实习岗位名称+姓名+应聘部门+是否接受调剂');
  assert.equal(p.matched, false);
  assert.equal(p.unresolved.length, 1);
  assert.match(p.unresolved[0], /应聘部门/);
  // 关键：占位词必须**原样留着**，让人一眼看到「这里没填」。
  // 若实现改成「留空」，标题会变成 `后端开发工程师+张三++是`，反而看不出问题。
  assert.equal(p.subject, '后端开发工程师+张三+应聘部门+是');
});

test('档案缺字段时同样 matched=false，且把缺的字段名说出来', () => {
  const p = planSubject('学历+专业+学校+姓名', { name: '张三' }, JOB);
  assert.equal(p.matched, false);
  assert.equal(p.unresolved.length, 3, '学历/专业/学校 三项都缺');
  assert.match(p.unresolved.join('；'), /档案缺「学历」/);
  assert.match(p.subject, /学历/, '缺值时原样保留占位词');
});

// ── C. 误报守卫：这些「看起来像要求」的都不是 ────────────────────────────────
const NOISE_CASES: Array<[string, string]> = [
  ['点击标题查看往期文章精选', '公众号页脚的「往期文章」'],
  ['2.短视频账号日常运营：内容发布、文案标题编辑、话题维护；', '「文案标题编辑」是岗位职责'],
  ['识别二维码 关注航空工业 关注新舟飞机', '页脚二维码引导'],
];
for (const [text, why] of NOISE_CASES) {
  test(`误报守卫 · ${why}：「${text}」→ 不抽要求`, () => {
    assert.equal(extractSubjectRequirement(text), null);
    assert.equal(looksDegraded(text), false, '也不该报 degraded（会无谓地惊动人工核对）');
  });
}

test('误报守卫 · 页脚噪音不得把同段里的真要求挤掉', () => {
  const jd = '邮件主题及附件文件名格式： “院校+专业+姓名” 识别二维码 关注航空工业 点击标题查看往期文章精选';
  assert.equal(extractSubjectRequirement(jd), '院校+专业+姓名');
});

// ── D. OCR 打散：抽不到 ≠ 没有 ──────────────────────────────────────────────
test('OCR 打散的 JD：抽不到要求，但必须报 degraded，不许静默用默认标题', () => {
  // 这两段是真实库原文（芯聚能 / 轾驱），要求被 OCR 拆到了相隔十几行的位置
  const broken = [
    '岗位职责\n工艺开发及试制\n技术预研与路线规划\nower.com\n聘岗位”为标题\n-6019\n-7809',
    '薪资福利\n五险一金\ne.com\n院校及专业为标题\n公众号 · 轻驱科技',
  ];
  for (const jd of broken) {
    const p = plan(jd);
    assert.equal(p.requirement, null, '打散的文本不该硬猜出一个要求');
    assert.equal(p.degraded, true, '但必须显式告诉人「这里本来有要求」');
    assert.equal(p.matched, false);
    // 兜底标题必须是**诚实的默认标题**，不含任何从打散文本里抠出来的碎片
    assert.equal(p.subject, defaultSubject(PROFILE, JOB));
  }
});

// ── E. 兜底标题 ────────────────────────────────────────────────────────────
test('JD 根本没写要求时：用默认标题，且不报 degraded', () => {
  const p = plan('我们是一家很好的公司，欢迎投递。');
  assert.equal(p.requirement, null);
  assert.equal(p.degraded, undefined);
  assert.equal(p.subject, '应聘后端开发工程师-张三-13800000000');
});

test('默认标题在缺岗位/缺电话时逐级降级，不产生空段', () => {
  assert.equal(defaultSubject(PROFILE, { position: '前端工程师' }), '应聘前端工程师-张三-13800000000');
  assert.equal(defaultSubject(PROFILE, {}), '应聘简历-张三');
  assert.equal(defaultSubject({}, {}), '应聘简历-应聘者');
});

// ── F. 工具函数 ────────────────────────────────────────────────────────────
test('全角分隔符归一化', () => {
  assert.equal(normalizeSubjectText('姓名＋学校＋专业'), '姓名+学校+专业');
  assert.equal(normalizeSubjectText('姓名－学校'), '姓名-学校');
  assert.equal(normalizeSubjectText('姓名／学校'), '姓名/学校');
  assert.equal(normalizeSubjectText('  姓名  学校  '), '姓名 学校', '全角空格与多空格归一');
});

test('片段切分：方括号前缀与「及」连接都要拆开', () => {
  assert.deepEqual(splitSubjectSegments('【Java全栈】 - 姓名 - 学校'), ['【Java全栈】', '姓名', '学校']);
  assert.deepEqual(splitSubjectSegments('【保育数据库实习申请】姓名＋学校＋专业'), [
    '【保育数据库实习申请】',
    '姓名',
    '学校',
    '专业',
  ]);
  assert.deepEqual(splitSubjectSegments('院校及专业'), ['院校', '专业'], '「及」连接、两侧都认识才拆');
  assert.deepEqual(splitSubjectSegments('应聘部门'), ['应聘部门'], '不认识的片段不硬拆');
});

test('null / 空串输入不抛错', () => {
  assert.equal(extractSubjectRequirement(''), null);
  assert.equal(extractSubjectRequirement(null as unknown as string), null);
  assert.equal(looksDegraded(''), false);
  assert.equal(planSubject(null, PROFILE, JOB).subject, '应聘后端开发工程师-张三-13800000000');
});
