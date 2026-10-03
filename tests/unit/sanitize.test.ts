/**
 * 岗位字段清洗单测 —— 由 `scripts/selftest.ts` 的 E/F 两组**迁移**而来（2026-10-01）。
 *
 * 为什么迁移：这两组是典型的**表格驱动纯函数测试**（喂脏值、断言干净值），
 * 放在 `selftest.ts` 里只能整体跑、失败只有一行 ❌ 没有用例名；
 * 迁到标准 test runner 后能单跑一个文件、每条用例独立命名、失败能精确到是哪条脏值。
 *
 * ⚠️ 已知副作用：`server/db.ts` 的**模块顶层**会打开 `data/chat.db` 并跑建表/migration
 *    （`CREATE TABLE IF NOT EXISTS` + try/catch 包住的 `ALTER TABLE`）。所以 import 它
 *    会碰一下数据库。这是既有设计（`selftest.ts` 一直如此），且那些语句是**幂等**的；
 *    但没有把它包装成"零副作用"是遗憾 —— 真要较真的话，应把清洗函数抽到独立的纯模块。
 *    这里选择如实记录而不是顺手重构：本次的目标是补测试框架，不是动 db.ts 的分层。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeJobText, sanitizePosition, sanitizeCompany } from '../../server/db.js';

// ── E. 岗位字段清洗（BOSS 加密字体污染）────────────────────────────────────
// 实测脏值样本（库内 59/373 条 BOSS 岗位命中）
const CLEAN_CASES: Array<[string, string | null]> = [
  ['Java\n-K', 'Java'],                                             // 换行 + 薪资残片（数字被加密字体吞掉）
  ['java开发工程师\nK', 'java开发工程师'],
  ['Java（外包兴业银行-远程面试-项目稳定）\n-K', 'Java（外包兴业银行-远程面试-项目稳定）'],
  ['Java开发工程师', 'Java开发工程师'],                              // 干净值不动
  ['前端开发（Vue3）', '前端开发（Vue3）'],
  ['C++开发', 'C++开发'],
  ['Java 10-20K ·16薪', 'Java'],                                     // 完整薪资残片
  ['-K', null],                                                      // 整串即残片 → 置空
  ['\uE123\uE456Java\uE789', 'Java'],                                // PUA 字形
  ['  多  余   空白  ', '多 余 空白'],   // 折叠连续空白为单空格（不吞词间空格，避免误合并词）
];
for (const [input, expect] of CLEAN_CASES) {
  test(`sanitizeJobText(${JSON.stringify(input)}) === ${JSON.stringify(expect)}`, () => {
    assert.equal(sanitizeJobText(input, 80), expect);
  });
}

// ── F. 卡片尾巴清洗（老版 51job 采集器污染）───────────────────────────────
// 样本取自库内真实脏值（118/149 条 job51 岗位命中）
const POSITION_CASES: Array<[string, string]> = [
  ['软件全栈工程师(010565) 5-9千 昆明·呈贡区 无需经验 本科 java mysql 数据库', '软件全栈工程师(010565)'],
  ['上海_Java后端开发工程师 9千-1.1万 上海·杨浦区 1-3年 大专 五险一金 带薪年假', '上海_Java后端开发工程师'],
  ['人工智能算法（应用）工程师(010564) 8千-1.5万 昆明·呈贡区 3年及以上 本科 java', '人工智能算法（应用）工程师(010564)'],
  ['Java开发工程师', 'Java开发工程师'],                       // 干净值不动
  ['Java开发工程师·远程', 'Java开发工程师·远程'],              // 含·但无空格前缀 → 不误伤
  ['前端开发（Vue3）', '前端开发（Vue3）'],
];
for (const [input, expect] of POSITION_CASES) {
  test(`sanitizePosition(${JSON.stringify(input.slice(0, 24))}…) 剥掉卡片尾巴`, () => {
    assert.equal(sanitizePosition(input), expect);
  });
}

const COMPANY_CASES: Array<[string, string | null]> = [
  ['公司全称：云南科诚卫远科技有限公司', '云南科诚卫远科技有限公司'],
  ['APP下载', null],
  ['首页', null],
  ['云南天霄科技', '云南天霄科技'],
];
for (const [input, expect] of COMPANY_CASES) {
  test(`sanitizeCompany(${JSON.stringify(input)}) === ${JSON.stringify(expect)}`, () => {
    assert.equal(sanitizeCompany(input), expect);
  });
}
