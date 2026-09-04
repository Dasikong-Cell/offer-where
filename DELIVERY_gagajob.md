# 职得鸭全套投递功能 · 交付说明

> 目标：把职得鸭(gagajob) 的「全部投递相关功能」落地进 job-apply-agent，并补齐「像以前那样去官网一键投递」的能力。
> 核心策略（对齐职得鸭）：**一键完成，依赖账号已填好的在线简历，不碰任何表单/级联**；用户选择「直接投不过滤」，故不做 AI 匹配门槛。

## 已交付的能力（6 平台 × 6 动作）

| 平台 | 标识 | 官网一键投递入口 |
|---|---|---|
| BOSS直聘 | boss | `.op-btn-chat`（立即沟通） |
| 智联招聘 | zhilian | `.summary-planes__action button.a-button`（立即投递） |
| 前程无忧 | job51 | `#app_ck`（申请职位） |
| 猎聘 | liepin | `.btn-main`（聊一聊） |
| 牛客网 | nowcoder | 官网投递 |
| 企业官网 | offerbiu | Offerbiu 校招官网网申 |

**6 个动作（统一引擎 `runEngine` 分发）**
- `hello`   单岗位一键投递
- `auto`    默认列表/关键词批量自动翻页投递
- `keyword` 强制关键词搜索后批量投递
- `search`  仅搜索收集岗位链接（不过滤、不投递），返回 `foundJobs`
- `again`   HR 会话复聊（boss/liepin 沟通型平台，需 hrGroupId 或岗位链接）
- `letter`  打开岗位 → 发起沟通 → 发求职信/招呼语（AI 未配置回退模板）

## 涉及改动

**后端**
- `server/services/apply/types.ts` — 新增 `ApplyAction`、`action/keyword/maxPages/hrGroupId/chatHistory/jdText` 入参、`foundJobs` 出参、`liepin` 平台。
- `server/services/apply/platforms.ts`（新增）— 各平台选择器/脚本/确认正则/登录配置注册表。
- `server/services/apply/engine.ts`（新增）— 统一引擎，覆盖 6 动作；登录检测→邮箱验证码登录→一键点击→确认弹窗补点。
- `server/services/apply/letterWriter.ts`（新增）— 求职信/复聊文案，可选 `AI_LETTER_ENDPOINT`，否则模板。
- `server/services/apply/zhilian.ts`、`liepin.ts` — 委托统一引擎（智联弃用旧级联填报，改一键投递）。
- `server/services/apply/index.ts` — `SUPPORTED_PLATFORMS` 含 liepin；非 hello 的 4 主平台走引擎。
- `server/index.ts` — `/api/apply` 透传 6 动作字段；`PLATFORM_LABEL` 补 liepin。
- `shared/agentPrompt.ts` — 文档对齐 6 平台 + 6 动作 + 「直接投不过滤」。

**前端** `src/pages/JobMatchPage.tsx`
- 岗位池每行：新增 **猎聘投递** 按钮，新增 **求职信** / **复聊** 按钮（按岗位来源/链接自动推断平台）。
- 批量连投向导：新增「动作模式」Select（auto/keyword/search/again/letter）+ HR 会话链接输入；选定动作时走统一引擎（直接投不过滤），`search` 结果展示 `foundJobs`。
- `applyOnPlatform` 支持 `action` 参数并透传；`PLATFORM_LABEL` 补 liepin。

## 冒烟验证（已通过）
- 服务启动无报错；`tsc` 前端零错误。
- 智联 `search`：复用已登录持久会话，成功收集到真实 JD（`/jobdetail/CCL1429401230J40880623409.htm`）。
- 智联 `hello` 真实一键投递：打开 JD → 检测到登录 → 点击「立即投递」→ **status: applied**（已真实投递）。

## 使用方式
1. 前端 `npm run dev`（或构建后预览），后端 `npm run server`（改代码需手动重启，非 watch）。
2. 岗位池点各平台「XX 投递」即官网一键投；「求职信/复聊」发起沟通。
3. 批量向导选「动作模式」+ 平台，开始连投（auto/keyword/search/again/letter）。

## 备注
- 项目根目录遗留一批临时探针脚本（`_probe_*.cjs`、`_gaga_*.cjs`、`_gaga_app/` 等），属历史调试产物，未删除，可在确认无用后清理。
- 各站点实时 DOM/反爬策略会变，链接收集与一键按钮选择器后续如失效，只需更新 `platforms.ts` 对应条目。
