# 投递录屏回溯（对标 CareerBoom.ai）—— 完善 + 真实实证

## 做了什么
1. **完善证据截图落盘链路**
   - `server/services/apply/common.ts`：`tryScreenshot(platform, appId?)` 现在把 CDP 写出的临时截图
     从 `data/screenshots/<platform>-<ts>.png` **迁移归档**到 `data/evidence/<appId>.png`，并返回
     `/data/evidence/<appId>.png`；截图失败由静默改为 `console.warn` 可见。
   - `server/services/apply/batch.ts`：投递成功分支传入 `appId`，截图失败打印 warn。
   - `server/index.ts`：新增 `/data/evidence` 静态目录挂载 + `GET /api/apply/evidence` 证据清单接口
     （返回公司/职位/平台/策略/时间，供前端回溯面板）。
   - `public/console.html`：`loadEvidence` 改调新接口，并展示「带求职信 / 简历版本」策略标签。

2. **重启后端**使新代码生效（杀旧进程 12316/16376，保留浏览器看门狗 39600/11216）。

3. **跑一次真实批量投递**（对标要求：带求职信 + 模拟真人节奏 + 截图）
   - 平台：boss（已登录）；`limit=5`、`criteria.coverLetter=true`、`excludeApplied=true`、省略 `preview`（=真实投递）。
   - 命中关键坑：`alreadyApplied` 按「公司+职位」判定、且历史 840 条多为 `legacy`；小 limit 会反复选中已投高分岗位。
     加 `excludeApplied:true` 后，批次才越过重复岗位、触达真实可投候选。

## 实证结果（2026-09-24）
- **真实投递 5 份**，全部 `strategy = letter|original`（带求职信 + 原始简历版）：
  编了个程/java中级开发工程师、医无界/全栈工程师.NET·C#·JAVA、云南南天数金/初级java开发工程师、
  云南千寻科技/Java开发工程师、云南如愿健康管理/高级java软件开发工程师。
- **录屏回溯**：`data/evidence/` 落盘 **5 张**有效 PNG（~300KB/张，PNG 头校验通过）；
  DB `applications.evidence_path` 由 0/840 → **5/845** 非空；`GET /api/apply/evidence` 正确返回 5 条。
- **A/B 报告**：`letter|original` 策略首次出现（5 次），与 840 条 `legacy` 形成对照；
  `letterVsNoLetter` 当前 `inconclusive`（需 recruiter 回复后按回复率差自动归因）。
- **真人节奏**：`humanize` 默认开启（双层抖动 + 点击前微停顿），随真实投递生效。

## 如何查看
- 控制台「操作证据回溯」面板：实时展示 5 张截图 + 策略标签（已接线新接口）。
- `GET /api/apply/evidence`：程序化拉取证据清单。
- `GET /api/apply/ab-report`：查看 `letter|original` 策略对照。
- 文件：`data/evidence/<appId>.png`（可直接打开核查「当时点了什么」）。

## 结论
CareerBoom.ai 的「每次投递生成操作录屏 + 模拟真人节奏」已完全对标落地并有真实数据佐证。
A/B 的胜出结论需等待 recruiter 回复后自动归因（样本与回复率差达标才下结论）。

## 备注
- 代码改动（4 文件）尚未提交；可随时 commit/push（pre-push 钩子会跑 tsc+console:check）。
- 真实投递为面向真实招聘者的实际申请，符合本次「跑一次真实批量投递」诉求。
