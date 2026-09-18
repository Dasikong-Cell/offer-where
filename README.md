# offer-where · AI 求职管家（对标「职得鸭」）

一个**完全对标「职得鸭」AI 求职管家**的本地化、开源、可自托管的求职自动化引擎。

> 职得鸭对外承诺的五大能力：**智能匹配 → 文案撰写 → 自动投递 → 跟进(HR复聊) → 全程 AI 托管，求职者只需准备面试**。
> 本项目把这套能力在自己的机器上跑起来：数据、简历、账号全在本机，AI 可选接入，不依赖任何商业 SaaS。

---

## 功能对标矩阵

| 职得鸭能力 | offer-where 实现 | 说明 |
|---|---|---|
| 🔍 **智能匹配** | `/api/jobs/match` + `matchResumeToJobAi` | 接 LLM 时对「简历 vs JD」做语义打分(0-100)+命中/缺失/建议；无 LLM 自动回退本地规则匹配，**离线可跑** |
| ✍️ **文案撰写** | `letterWriter` + `aiClient` | 按 JD/公司/岗位生成个性化招呼语与 HR 复聊回复；接 LLM 时 AI 生成，否则模板兜底 |
| 🚀 **自动投递** | `engine.ts` 跨平台引擎 | BOSS直聘 / 智联 / 前程无忧(51job) / 猎聘 / 牛客 / offerbiu(校招邮箱) 多平台，支持单投/批量/关键词/搜索收集 |
| 💬 **跟进（HR复聊）** | `autoReply.ts` / `bossChat.ts` | BOSS 自动读取会话、按意图生成回复、自动发送；识别拒聊/已读不回等状态 |
| 🖥️ **全程 AI 托管** | `public/console.html` 单一控制台 | 多选平台 + 数量/间隔 + SSE 实时进度 + 一键启动，浏览器里完成全套操作 |
| 📄 **简历解析** | `/api/resume/parse` | 解析 PDF/Word 简历为结构化文本与技能列表，供匹配与投递复用 |
| 📄 **一岗一简历** | `/api/jobs/tailor` + `resumeTailor.ts` | 按目标岗位 JD 定制简历片段：技能按岗位相关度重排 + 定制「核心优势」+ 命中/待补分析；LLM 优先、本地规则兜底，**严禁编造**不存在的事实 |
| 📊 **投递漏斗 + 匹配度看板** | `/api/stats/funnel` | 全池按状态/来源聚合（候选/已投/不可用/已隔离），匹配分覆盖度与高/中/低分布，控制台实时展示 |
| 🔐 **平台 API 通道** | `platformApi/bossOpenApi.ts` | CDP 读取已登录会话 Cookie（含 httpOnly）做**登录态巡检**；逆向 JSON 只读检索提速。**结论：官方开放平台是 B 端，求职者侧无法用它投递**（详见 `BOSS_OPENAPI_PLAN.md`） |

> 说明：**模拟面试 / 笔试题库 / 简历润色** 属于世纪云端另一产品「职达鸭」范畴，不在本仓库（job-apply-agent）范围内。

---

## 架构

```
offer-where/
├── server/                      # 后端（Node + Express + TypeScript，tsx 直跑）
│   ├── index.ts                 # 路由入口（/api/health, /api/jobs/match, /api/apply/batch, /api/chat ...）
│   ├── services/
│   │   ├── apply/
│   │   │   ├── aiClient.ts      # 统一 OpenAI 兼容 LLM 客户端（软失败，未配置返回 null）
│   │   │   ├── matchAi.ts       # AI 智能匹配（回退规则匹配）
│   │   │   ├── letterWriter.ts  # AI 文案撰写（回退模板）
│   │   │   ├── engine.ts        # 跨平台一键/批量投递引擎
│   │   │   ├── batch.ts         # 自动筛选 + 批量连投编排
│   │   │   ├── autoReply.ts     # BOSS 自动复聊
│   │   │   ├── bossChat.ts      # BOSS 会话读写
│   │   │   ├── job51.ts / zhilian.ts / liepin.ts / nowcoder.ts / offerbiu.ts
│   │   │   └── platforms.ts     # 平台配置注册表
│   │   ├── match.ts             # 本地规则匹配（兜底）
│   │   └── resume.ts            # 简历解析
│   └── db.ts                    # SQLite（better-sqlite3）
├── src/                         # 前端（React + Vite + @tencent-ai/agent-sdk）：Agent 分析界面，npm run dev 使用
├── public/console.html          # 生产控制台入口（由 4400 托管）
├── scripts/                     # 脚本工具（登录引导、采集等）
├── data/                        # 本地数据（岗位库 / 投递记录 / 会话 / 截图）—— 不入库
├── node/                        # 自带 Node 运行时（便携包用，免安装）
└── *.bat                        # Windows 一键启动器（含 %USERPROFILE% 规避中文路径 + UTF-8 BOM）
```

**浏览器自动化**：通过本地 CDP Chrome 多实例（各平台独立端口 `9223`~`9227`、`C:/chrome-cdp-profile*` 登录态隔离，见 `data/browser/cdp.json`）驱动各招聘站点；服务端默认监听 **4400**。

---

## 前端界面：两套并存与分工

本项目**同时存在两套前端**，由不同运行模式驱动，共用同一后端 API（无接口断链）：

| 界面 | 技术 | 由谁托管 / 何时用 | 主要功能 |
|---|---|---|---|
| `public/console.html` | 原生 JS 单页 | **生产控制台**：`npm run server`（或 `start_all.bat`）在 `/` 直出（默认 `4400`） | 平台多选、自动识别有连接的平台、批量投递、自动回复/消息跟进面板、SSE 实时日志 |
| `src/`（React + Vite + `@tencent-ai/agent-sdk`） | React SPA | **开发 / Agent 分析界面**：`npm run dev` 由 Vite 在 `5173` 提供，经 CORS 调后端 | Agent 对话(`ChatPage`)、岗位匹配(`JobMatchPage`)、投递记录(`ApplicationsPage`)、档案(`ProfilePage`)；`vite build` 产物在 `dist/` |

- 后端 `server/index.ts` 同时提供**投递类**（`/api/apply/batch`、`/api/auto-reply/*`、`/api/browser/*` 等，供 console.html）与 **Agent 类**（`/api/chat`、`/api/sessions`、`/api/permission-response` 等，供 React 应用）API。
- 生产部署以 `console.html` 为准；React 应用用于本地开发期的高级 Agent 分析，二者不冲突、不重复开发。
- 磁盘上的 `server/**/*.js`、`.d.ts`、`vite.config.js`、`*.tsbuildinfo`、`_*.cjs` 等均为 `.gitignore` 已忽略的构建/临时产物，会由 `tsc`/`vite` 重新生成，**不入库、不影响运行**（运行时用 `tsx` 直跑 `.ts`）。

---

## 支持平台

| 平台 | 投递 | 复聊 | 备注 |
|---|:---:|:---:|---|
| BOSS直聘 | ✅ | ✅ | 沟通型，发起沟通即投递；自动复聊最成熟 |
| 前程无忧 51job | ✅ | — | 列表页直投，规避 JD 详情页风控 |
| 智联招聘 | ✅ | — | 两级采集（公司页→岗位） |
| 猎聘 | ✅ | ✅ | 需短信验证后使用 |
| 牛客 | ✅ | — | 校招/内推 |
| offerbiu（校招邮箱） | ✅ | — | 走 HR 邮箱投递通道 |

---

## 快速开始（Windows 一键）

1. 双击桌面 **「投递Agent」**（或项目内 `start_all.bat`）：自动启动 CDP Chrome + 后端(4400) + 打开控制台页。
2. 在控制台勾选平台、设置数量/间隔，点「开始投递」。
3. 首次使用需在打开的 Chrome 里登录各招聘平台账号（登录态持久化在 `C:/chrome-cdp-profile`）。

> 便携包 `job-apply-agent-portable.zip` 含自带 Node 与各启动器，解压到任意机器双击即用，无需安装环境。

---

## 接入 AI（可选，对标职得鸭的 AI 内核）

未配置 AI 时，项目以**「规则匹配 + 模板文案」**模式完整运行。配置任意 OpenAI 兼容网关后，自动切换为**「AI 语义匹配 + AI 文案 + AI 自动复聊」**。

### 配置（`.env`）

根目录 `.env`（参考 `.env.example`）设置以下三项，**三者齐备才启用 AI**，否则所有 AI 调用自动回退规则/模板（软失败，不会中断投递）：

```bash
LLM_BASE_URL=https://api.openai.com/v1      # 或 http://127.0.0.1:11434/v1（本地 Ollama）
LLM_API_KEY=sk-xxx                          # 本地 Ollama 可留空
LLM_MODEL=gpt-4o-mini                       # 或 qwen2.5:7b / deepseek-chat ...
```

兼容：OpenAI / DeepSeek / SiliconFlow / 通义 / 智谱 / Groq / 本地 Ollama 等。

> **加载机制**：后端 `server/env.ts` 在启动时（早于其它模块）解析根目录 `.env` 注入 `process.env`，无需安装 dotenv、也无需在启动命令里手动 `export`。改完 `.env` 重启后端即生效（双击桌面「投递Agent」或 `start_server.bat`）。

### AI 用在哪

| 能力 | 是否用 AI | 说明 |
|---|---|---|
| 智能匹配（`/api/jobs/match`、`matchAi.ts`） | ✅ 启用时 | 简历 vs JD 语义打分；无 LLM 回退本地规则 |
| 文案撰写（`letterWriter.ts`） | ✅ 启用时 | 招呼语 / HR 复聊文案；无 LLM 回退模板 |
| **自动回复话术（`autoReply.ts` `composeReplyWithAi`）** | ✅ 启用时 | **HR 复聊直接调用大模型生成语境感知话术** |
| 自动回复**意图识别**（`detectIntent` / `decide`） | ❌ 始终规则 | 分类任务规则更可控；内置终态判定顺序、疑问句规避等护栏，避免误判 |

**自动回复的「AI + 护栏」设计**：意图识别永远走规则（保证不误回/不乱回），话术生成优先走大模型（结合 HR 原文、意图、求职者档案、最近对话上下文写 1-3 句口语化回复）；模型调用失败或超时则自动回退规则模板，**护栏不因 AI 抽风而失效**。

### 控制台与接口

- 控制台「④ 自动回复」面板新增 **AI 状态徽标**（绿=已启用模型 X / 黄=未配置将回退规则）与 **「AI 生成话术」开关**（默认勾选；未配置时运行自动回退规则）。预览日志标注 `[AI]` / `[规则]`。
- `GET /api/ai-status` → `{ enabled, model, baseUrl }`，供徽标实时刷新。
- 命令行：`tsx scripts/auto_reply_boss.ts`（猎聘为 `auto_reply_liepin.ts`）支持 `--no-ai` 强制走规则模板；`--send` 真实发送前建议先预览。

> 设置后 `GET /api/health` 返回 `"ai": true`，控制台可据此提示 AI 已启用。

---

## 主要 API

| 端点 | 方法 | 描述 |
|---|---|---|
| `/api/health` | GET | 健康检查（含 `ai` 状态） |
| `/api/jobs/match` | POST | 用简历对岗位池 AI 打分并排序 |
| `/api/apply/batch` | POST | 跨平台自动筛选 + 批量连投（SSE 进度） |
| `/api/apply` | POST | 单岗位一键投递 / 复聊 / 求职信 |
| `/api/sessions` | GET/POST/PATCH/DELETE | BOSS 会话管理 |
| `/api/chat` | POST | 本机 Agent 对话（SSE） |
| `/api/resume/parse` | POST | 简历解析 |
| `/api/profile` | GET/PUT | 求职者档案 |

---

## 脚本工具速查（scripts/）

所有脚本用 `tsx scripts/<name>.ts [参数]` 运行（项目自带 tsx）。浏览器类脚本统一调用后端 `POST /api/browser/exec`（平台优先的 `ex()` / 平台固定的 `makeEx()`，见下）。

### 统一浏览器执行封装 `scripts/lib/browser.ts`（2026-09-12 新增）

> ⚠️ **踩坑修复**：历史上散落 N 处本地 `ex()` 副本，签名不一致（2 参 `ex(platform, {action})` 与 3 参 `ex(platform, action, args)` 混用）。一旦「定义了 2 参却按 3 参调用」，action 被丢进字符串 spread，后端收不到 action → 400「缺少 action 参数」、`.data` 恒 `undefined`，采集/投递在静默中全失败（offerbiu 扫描曾恒返回 0 条）。
>
> 现统一为 `scripts/lib/browser.ts`：
> - `ex(platform, { action, ... })` 与 `ex(platform, action, args)` **两种写法都支持**；
> - 平台固定时 `const ex = makeEx('boss')`；
> - **缺 `action` 直接抛错**（reject），不再静默失败。
>
> 新脚本请 `import { ex, makeEx } from './lib/browser.ts'`，不要再本地定义 `ex`。

### 运维 / 体检

| 脚本 | 用途 |
|---|---|
| `ensure_chrome.sh` | 一键幂等拉起 5 个 CDP 调试窗口（boss/liepin/job51/zhilian/official），机器休眠/重启后服务端与 CDP 一起掉时首先跑它 |
| `healthcheck.ts` | 一键体检：后端可达性 / 各平台连接 / 岗位池数量 / 邮箱配置是否就绪 |
| `check_logins.ts` | 并行检查各平台登录态（boss/job51/liepin/zhilian）。**anon 优先**规则，输出明确结论与退出码（0=全登录 1=有未登录 2=有未知） |
| `selftest.ts` | 功能回归自检（42 项，只读）：简历解析/手机号多格式/匹配引擎/邮箱抽取/域名归约/一岗一简历/防幻觉/字段清洗 |
| `db_report.ts` | 数据库体检（只读）：表行数、岗位池与投递分布、匹配覆盖、数据质量（重复/空JD/记录不一致） |
| `fix_job_data.ts` | 历史脏数据修复：清洗被加密字体污染的字段、按 apply_url 回填公司名、清理空壳/重复。**默认 dry-run，`--apply` 才写库且自动备份** |
| `backfill_jd.ts` | 回填岗位 JD 正文（顺带补公司名）。**可续跑、失败不中断**，建议 `--limit=50` 分批跑；`--include-applied` 可连已投岗位一起补 |
| `calibrate_jd_selectors.ts` | 探测各平台详情页的 JD/公司名选择器（用于校准 `backfill_jd.ts`，只读） |
| `focus_login.ts <platform> [url]` | 把指定平台调试窗口导航到登录页并置顶，引导用户登录/收验证码 |
| `probe_platform_api.ts` | 平台 API 通道自检：CDP 端点 + 登录态（关键鉴权 Cookie）+ 两条通道开关 |
| `check_console_syntax.ts` | 校验 `public/console.html` 内联脚本语法（提交前拦下模板字面量笔误） |
| `backfill_match.ts` | 回填岗位匹配分（本地规则，零 LLM 成本），让漏斗看板「匹配度」覆盖全池 |
| `tailor_preview.ts <jobId>` \| `--source X --limit N` \| `--jd "..."` | 一岗一简历命令行预览（按 JD 定制简历片段） |
| `test_quarantine.ts` | 自检 offerbiu 邮箱直投的「跨公司串号隔离」闸门（合成岗位，跑完自动清理） |

### 岗位采集

| 脚本 | 用途 |
|---|---|
| `collect_multi.ts <平台,逗号> [每平台目标数]` | 多平台搜索列表页采集（job51/liepin/boss），写库 `status=candidate` |
| `collect_51job.ts` | 51job 两级采集（列表→公司页→岗位直链，规避 SPA 拿不到直链） |
| `collect_boss.ts` | BOSS 搜索列表页直采（卡片自带岗位详情链接） |
| `offerbiu_search.ts [关键词] [页数] [入库1/0]` | offerbiu **免登录**定向采集：按关键词搜 companies，解码「投递入口」得真实官网，入库软件岗 |
| `offerbiu_scan.ts` | offerbiu 免登录扫 companies 页，按软件相关筛选入库 |

### 投递

| 脚本 | 用途 |
|---|---|
| `apply_job51.ts` | 51job 投递，**自动跳过校招/应届生岗**（校招需单独简历、跳应届生求职网必失败） |
| `apply_one_offerbiu.ts` | offerbiu **一次只投一个**岗位（避免频繁跳站，符合「一次一个」操作约定） |
| `offerbiu_apply.ts` / `send_offerbiu_one.ts` | offerbiu 投递编排 / 单岗投递（官网网申 + 微信推文→HR 邮箱通道） |

### 自动回复（HR 复聊）

| 脚本 | 用途 |
|---|---|
| `auto_reply_boss.ts [--send] [--unread] [--limit=N] [--name=张三,李四] [--no-ai]` | BOSS 自动复聊；默认**预览**（不发送），`--send` 真实发送 |
| `auto_reply_liepin.ts` | 猎聘版，参数同上 |
| `test_auto_reply.ts` | 回归测试：意图识别 / 护栏（去重、超 8 轮转人工）/ **历史上下文读取**（formatHistory 截最近 16 条） |

> **自动回复读取上下文**：`readConversation()` 返回完整 HR/我 交替历史 → 运行器把 `history` 传入 `composeReplyWithAi` → 经 `formatHistory()` 取**最近 16 条**注入大模型 prompt，并附「承接上文、不重复、不矛盾」护栏。AI 未配置时回退规则模板（不消费历史）。回归测试见 `test_auto_reply.ts`。

---

## 反检测（绕过风控 / 减少反复登录）

**根因**：裸 CDP 驱动的 Chrome 会暴露 `navigator.webdriver = true` 与 `cdc_*` 调试器变量，
BOSS直聘 / 猎聘 / 51job 据此判定为自动化 → 强制重新登录、把页面清空为 `about:blank`、或弹风控墙。
这正是「需要一直登录」的主因（profile 本身是持久化的，cookie 跨启动保留）。

**已落地方案（2026-09-12）**：

1. **启动参数加固**（3 个启动器 `start_cdp.bat` / `start_all.bat` / `ensure_chrome.sh`）：
   新增 `--disable-blink-features=AutomationControlled --disable-infobars`，
   让 Chrome 在 CDP 层就不把 `navigator.webdriver` 置真。
2. **运行时反检测注入**（`server/services/cdpDriver.ts` 的 `STEALTH_SRC`）：
   经 `Page.addScriptToEvaluateOnNewDocument` 在每个页面 `document_start` 阶段执行（**Page 域命令，
   不开启 `Runtime.enable`**，因此不会触发 BOSS 对 `Runtime.enable` 的检测）。它：
   - 抹掉 `cdc_*` 调试器指纹变量；
   - 强制 `navigator.webdriver = false`（与启动参数双保险）；
   - 移除 `__nightmare` / `__puppeteer_*` 等自动化全局标记；
   - 补全 `window.chrome.runtime` 桩，避免站点据此判定非真实浏览器。
   - 覆盖点：首次接触端点时对**所有已有标签（含「养熟」标签）**注入；新建标签同样注入。

**验证方法**（后端重启后，对任一平台）：
```bash
# navigator.webdriver 应返回 false（改造前为 true）
curl -s -X POST http://127.0.0.1:4400/api/browser/exec -H 'Content-Type: application/json' \
  -d '{"platform":"boss","action":"navigate","url":"https://www.zhipin.com/"}'
curl -s -X POST http://127.0.0.1:4400/api/browser/exec -H 'Content-Type: application/json' \
  -d '{"platform":"boss","action":"eval","script":"navigator.webdriver"}'   # => {"data":false}
```

**生效条件**：
- 改了 `cdpDriver.ts` 必须 **重启后端**（停 4400 再 `PORT=4400 tsx server/index.ts`）才会加载注入逻辑；
- 启动参数只在**重新拉起 Chrome 窗口**时生效。运行时注入本身已足够把 `webdriver` 置否，
  因此即便窗口是旧参数启动的，重启后端后新开/复用的标签也会拿到反检测。

**已知边界（诚实说明）**：
- 滑块验证码（如 51job 滑块风控）是**轨迹行为分析**，无法可靠自动绕过；本项目保持「人工介入」兜底，
  不实现会显著提高封号风险的轨迹伪造。反检测只降低「环境指纹」层面的误判，不解决人为滑块。
- 会话 token 仍有服务端 TTL，长时间挂机后偶发需重新登录属正常，非缺陷。

---

## 一岗一简历（按 JD 定制）

对标职得鸭核心卖点。`server/services/apply/resumeTailor.ts` → `tailorResume(profile, job)`：

- **输出**：技能按岗位相关度重排（JD 命中项前置）+ 定制「核心优势/亮点」+ 命中/待补（gap）分析 + 匹配分 + 可直接渲染的 Markdown。
- **策略**：LLM 优先（`chatJSON`），未配置或失败**自动回退本地规则** —— 与 `matchAi` 同款降级，离线可跑、绝不影响投递链路。
- **防幻觉三条硬规则**：① 严禁编造简历中不存在的经历/数字/公司/证书；② LLM 只能改写与重排既有事实；③ LLM 返回的技能会与「档案真实技能」求交集，凭空新增一律丢弃。

```bash
# 命令行预览（无需起服务）
./node/node.exe node_modules/tsx/dist/cli.mjs scripts/tailor_preview.ts --source boss --limit 3
./node/node.exe node_modules/tsx/dist/cli.mjs scripts/tailor_preview.ts --position "Java开发工程师" --jd "要求 Spring Boot / MySQL / Redis"
# HTTP：POST /api/jobs/tailor  { "jobId": "..." }  或 { "job": { "position","company","jd" } }
```

---

## 平台 API 通道与「消验证码」路线

```bash
# 登录态巡检：打印 BOSS/猎聘 的 CDP 端点与关键鉴权 Cookie（含 httpOnly）
./node/node.exe node_modules/tsx/dist/cli.mjs scripts/probe_platform_api.ts
# HTTP：GET /api/platform-api/probe
```

实测（2026-09-18）：BOSS `wt2 / __zp_stoken__ / bst`、猎聘 `__gc_id / XSRF-TOKEN` 均读取成功 —— 此前只能靠截图肉眼判断登录态。

**核心结论**（详见 [`BOSS_OPENAPI_PLAN.md`](./BOSS_OPENAPI_PLAN.md)）：BOSS/猎聘的「开放平台」**都是 B 端（招聘方/服务商）能力**（企业 IM、简历库、薪资元数据），需企业实名 + IP 白名单，**求职者个人无法用它投递简历**。因此「彻底消验证码」的正解不是找官方 API，而是**把平台登录会话搬出用户本机（云端执行）**——这正是职得鸭验证码无感的真正原因。
本仓库当前策略：**CDP 整页链路负责投递**（签名由页面自算，最稳），**JSON 通道只负责检索提速与登录态诊断**，不做签名对抗军备竞赛。

---

## 开发

```bash
npm install
npm run dev          # 前端(React, 5173) + 后端(默认 3000，CORS 互通)；浏览器开 http://127.0.0.1:5173 使用 React 界面
npm run build        # tsc -b && vite build（产物 dist/，供自托管/开发用）
npm run server       # 仅起后端，并在 / 托管 public/console.html（生产控制台，默认 3000，PORT=4400 覆盖）
```

### ⚠️ 改完代码必须跑 `npm run verify`（血的教训）

服务端用 `tsx` 直跑 `.ts`，**完全不做类型检查** —— 类型错误在运行期毫无异常、冒烟测试全绿，
但 `npm run build`（`tsc -b`）会直接失败。2026-09-19 软件测评实测踩到：给 `jobs` 加 `quarantine` 列时
漏改 `JobRow` 接口，运行时一切正常，**构建却长期是坏的**，直到测评才发现。

```bash
npm run verify       # = typecheck(tsc -b，含 server/) + console:check(控制台内联 JS 语法)
npm run selftest     # 42 项功能回归（只读，不投递不发信）
npm run hooks:install # 装 git pre-push：推送前自动跑 verify，杜绝「构建坏了没人知道」
```

`npm run hooks:install` 会设置 `core.hooksPath=.githooks`（配置随 `.githooks/` 一起入库）。
紧急时可 `git push --no-verify` 跳过。

> 生产一键启动：双击桌面「投递Agent」（= `start_all.bat`）→ 起 CDP Chrome + 后端(`PORT=4400`) + 自动打开 `http://127.0.0.1:4400/`（console.html 控制台）。

## License

MIT
