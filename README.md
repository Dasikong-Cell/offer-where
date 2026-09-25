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
| 📄 **一岗一简历** | `/api/jobs/tailor` + `/api/jobs/tailor-resume` | 按 JD 定制：技能按相关度重排 + 定制「核心优势」+ 命中/待补分析。**已接入投递**——可生成定制简历 PDF 作为邮件附件（`tailorResume` → HTML → Chrome 排版 → PDF，带内容哈希缓存）。LLM 优先、本地规则兜底，**严禁编造**事实 |
| 🩺 **平台可用性巡检** | `/api/platforms/health` | 把「连接 / 登录态 / 风控」收敛成**一个结论 + 一条处置建议**，消除「跑完 50 个却投出 0 个」的静默失败 |
| 📊 **投递漏斗 + 匹配度看板** | `/api/stats/funnel` | 全池按状态/来源聚合（候选/已投/不可用/已隔离），匹配分覆盖度与高/中/低分布，控制台实时展示 |
| 🔐 **平台 API 通道** | `platformApi/bossOpenApi.ts` | CDP 读取已登录会话 Cookie（含 httpOnly）做**登录态巡检**；逆向 JSON 只读检索提速。**结论：官方开放平台是 B 端，求职者侧无法用它投递**（详见 `docs/BOSS_OPENAPI_PLAN.md`） |

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

共 **15 个已登记平台**，分两档：

**① 已接入（可直接批量投递，共 8 个）**

| 平台 | 投递 | 复聊 | 端口 | 采集 | 备注 |
|---|:---:|:---:|:---:|---|---|
| BOSS直聘 | ✅ | ✅ | 9223 | DOM | 沟通型，发起沟通即投递；自动复聊最成熟 |
| 智联招聘 | ✅ | — | 9226 | DOM | 两级采集（公司页→岗位） |
| 前程无忧 51job | ✅ | — | 9225 | DOM | 列表页直投，规避 JD 详情页风控 |
| 猎聘 | ✅ | ✅ | 9224 | DOM | 需短信验证后使用 |
| 牛客网 | ✅ | — | 9237 | DOM | 校招/内推 |
| offerbiu（校招邮箱/官网） | ✅ | — | 9227（与 official 共用） | — | 走 HR 邮箱投递通道 |
| **国聘** | ✅ | — | 9235 | **API** | `POST gp-api.iguopin.com/api/jobs/v1/list` **匿名可调**，一次返回 30+ 字段**含 JD**；投递入口「申请职位」。岗位偏央企国企 |
| **鱼泡直聘** | ✅ | — | 9232 | DOM | 详情页 `/zhaogong/{id}.html`；投递入口「聊一聊 / 发送简历」。⚠️ 蓝领垂直，**实测昆明 33 个岗位全是打包工/店员/司机，零技术岗** |

> 国聘采集：`scripts/collect_iguopin.ts`（API，秒级；`--city=昆明` 可过滤）｜ 鱼泡采集：`scripts/collect_yupao.ts`（列表+详情）
> 两者投递均**需先登录**；服务端已实现 `preview` 只读预览分支，可零风险自测。

**② 已登记、投递实现待接入**（窗口/巡检/控制台已就绪，登录后需实机校准页面选择器）

| 平台 | 端口 | 域名 | 备注 |
|---|:---:|---|---|
| 易直聘 | 9228 | easyzhipin.com | 以 APP 为主，Web 端目前是落地页，需先评估可操作性 |
| 58同城招聘 | 9229 | km.58.com/job/ | 求职频道为**城市子域**（非 jobs.58.com，那是58集团自招官网）；未登录跳登录墙 |
| 中华英才网 | 9230 | chinahr.com | 已并入「新华英才」，域名不变 |
| 店长直聘 | 9231 | dianzhangzhipin.com | BOSS 同集团。可采集（`/joblist/{city}/` + `/job/{id}.html`），但**PC 端登录/注册均跳 APP 下载页 → Web 投递不可行** |
| 脉脉高聘 | 9233 | maimai.cn/gaopin | 脉脉旗下招聘模块 |
| 赶集招聘 | 9234 | ganji.com/zhaopin/ | 58 同集团；**首访常触发风控验证码**，需人工过一次 |
| 应届生求职网 | 9236 | yingjiesheng.com | 校招垂直 |

> 说清楚口径：**「已登记」≠「能自动投递」**。第二档平台在控制台里可选、能被巡检（查连接与登录态）、
> 能启动独立调试窗口，但点投递会明确返回「已登记、投递实现待接入」，不会静默失败。
> 接入某个平台 = 实现 `runXxx` → 从 `PENDING_PLATFORMS` 移到 `SUPPORTED_PLATFORMS`，测试会自动校验六处同步。
>
> 启动额外平台窗口：`start_platforms.bat job58 yupao`（不带参数=启动第二档 9 个；`all`=全部 15 个）。
>
> 各平台登录态特征词：`anon` 于 2026-09-21 用调试窗口**实机访问首页采集**；`logged` 为通用保守值，
> 首次登录后建议用控制台 🩺 复核并按需补充（保守取值只会在匹配不上时判 `unknown`，不会误报"已登录"）。

---

## 快速开始（Windows 一键）

> **前置要求**：① Windows 10 1803+（需系统自带 `tar.exe`）；② 已安装 **Google Chrome**（未装时启动器会明确提示并给出下载链接）。
>
> **便携包**：`job-apply-agent-portable.zip` 含自带 Node 与各启动器，解压到任意机器双击即用，无需安装 Node 环境（约 455MB / 18 万文件，解压约 3–4 分钟）。

1. 双击桌面 **「投递Agent」**（或项目内 `start_all.bat`）：自动启动 CDP Chrome + 后端(4400) + 打开控制台页。
   - `start_all.bat` 默认启动 **BOSS / 猎聘 / 51job / 智联 / 官网** 5 个平台窗口；其余平台（国聘、鱼泡、中华英才、应届生等）用 `start_platforms.bat` 按需启动。
2. 在控制台勾选平台、设置数量/间隔，点「开始投递」。
3. 首次使用需在打开的 Chrome 里登录各招聘平台账号（登录态持久化在 `C:/chrome-cdp-profile`）。

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
| `selftest.ts` | 功能回归自检（42 项，只读）：简历解析/手机号多格式/匹配引擎/邮箱抽取/域名归约/一岗一简历/防幻觉/字段清洗 |
| `db_report.ts` | 数据库体检（只读）：表行数、岗位池与投递分布、匹配覆盖、数据质量（重复/空JD/记录不一致） |
| `fix_job_data.ts` | 历史脏数据修复：清洗被加密字体污染的字段、按 apply_url 回填公司名、清理空壳/重复。**默认 dry-run，`--apply` 才写库且自动备份** |
| `backfill_jd.ts` | 回填岗位 JD 正文（顺带补公司名）。**可续跑、失败不中断**，建议 `--limit=50` 分批跑；`--include-applied` 可连已投岗位一起补 |
| `calibrate_jd_selectors.ts` | 探测各平台详情页的 JD/公司名选择器（用于校准 `backfill_jd.ts`，只读） |
| `focus_login.ts <platform> [url]` | 把指定平台调试窗口导航到登录页并置顶，引导用户登录/收验证码 |
| `check_logins.ts` | **平台可用性巡检**：连接 / 登录态 / 风控三合一 → 一个结论 + 处置建议（判定逻辑与 `/api/platforms/health` 同源）。退出码 0=全可用 1=有未登录或被风控 2=有未知 |
| `probe_platform_api.ts` | 平台 API 通道自检：CDP 端点 + 登录态（关键鉴权 Cookie）+ 两条通道开关 |
| `check_console_syntax.ts` | 校验 `public/console.html` 内联脚本语法（提交前拦下模板字面量笔误） |
| `clean_tabs.ts` | 收敛各平台调试 Chrome 里堆积的标签页（每端点只留 1 个）。**默认 dry-run**，`--apply` 执行 |
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

## 投递安全（仅预览 / 每日上限 / 风控信号）

批量投递是**唯一会不可逆地对外产生动作**的功能，因此这里有三道闸门（全部可在控制台看到状态）：

### 1. 仅预览（dry-run）—— 零副作用验证链路
控制台「投递中心」勾选「**仅预览（不真正投递）**」后，服务端会：
打开岗位页 → 登录态校验 → 已下线/关闭检测 → 抓取 JD 入库 → **探测投递入口按钮是否可用，但不点击**。
返回 `status='preview'`，**不写 `applications`、不改岗位状态**。

- 用途：换机器/换账号后先验证「登录态、页面选择器、岗位是否可投」，确认无误再实投。
- 接口：`POST /api/apply/batch` 带 `{"preview": true}`（对应 `ApplyInput.preview`）。
- 实测：`previewed=2 / applied=0`，`applications` 计数不变。

### 2. 每日投递上限（保号）
平台对骚扰式批量投递有**账号级**处罚，且每日额度有限（同类开源项目实测 BOSS 每日沟通上限约 100 次）。
- 默认 **40 份/平台/天**，可在控制台「每日上限」临时调整（`0` = 不限制，不推荐），或用 `APPLY_DAILY_LIMIT` 设默认。
- 口径：以 `applications` 表按**本地日期**统计（不是内存计数）—— 重启/多进程/多脚本都一致。
- 只读查询：`GET /api/apply/quota?platform=boss` → `{used, limit, remaining, blocked, blockedReason, blockedMinutesLeft}`。

### 3. 平台风控信号识别 + 自动封锁
把「页面信号 → 类别 → 可执行处置」收敛成纯函数 `server/services/riskSignals.ts`（可单测）：

| 类别 | 典型文案 | 处置 |
|---|---|---|
| `account_risk` | 账号异常 / 环境异常 / 存在风险 | **不要重试**；人工过校验 + 主动发消息，封 12 小时 |
| `rate_limited` | **今日沟通人数已达上限** / 操作过于频繁 | **整批中止**并封 6 小时（避免连续重试升级风控） |
| `captcha` | 访问验证 / 请按住滑块 | 人工过一次即可继续（不封锁） |

命中 `account_risk` / `rate_limited` 后会**立即中止整批**，并写持久封锁标志（`app_kv`）；
封锁期内后续批次**直接短路不投递**（参考同类开源项目的 `PUSH_LIMIT` 持久标志）。
控制台会显示封锁原因与剩余时间，人工处理完可点「我已人工处理，解除封锁」提前解封
（`POST /api/apply/risk-unblock`）。

> 三者的共同原则：**宁可少投，也不把账号玩坏**。批量投递的失败原因会归类汇总进结果摘要
> （如「未投递原因：匹配度过低×7」），不会再出现「跑完却不知道为什么不投」。

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

### 接入投递：一岗一简历 PDF

邮箱直投时勾选「一岗一简历」即可按各岗位 JD 生成定制 PDF 作为附件：

```bash
# 单个岗位：生成并返回路径（首次约 8s，之后命中缓存 1s）
curl -X POST http://127.0.0.1:4400/api/jobs/tailor-resume -H 'Content-Type: application/json' -d '{"jobId":"..."}'
# 批量投递时自动逐岗生成：POST /api/offerbiu/email-apply 加 "tailor": true
```

管线：`tailorResume()` → `buildResumeHtml()`（自包含 A4 HTML）→ `cdpDriver.htmlToPdf`（**临时标签页**借调试 Chrome 排版，不打断平台主标签）→ `data/resume_tailored/<公司>-<职位>-<hash>.pdf`。
三处设计取舍：
- **不给 HR 看内部信息**：PDF 里只有简历内容，**不含**「匹配度 73/100」「待补 2 项」这类内部分析；
- **信息零丢失**：定制部分之外的原文完整保留，仅把原文的「专业技能」段替换为重排版本；
- **缓存键只用输入**：绝不能把 LLM 生成文案纳入哈希 —— LLM 每次输出微变会导致永远缓存不命中（实测踩到）。

---

## 平台 API 通道与「消验证码」路线

```bash
# 登录态巡检：打印 BOSS/猎聘 的 CDP 端点与关键鉴权 Cookie（含 httpOnly）
./node/node.exe node_modules/tsx/dist/cli.mjs scripts/probe_platform_api.ts
# HTTP：GET /api/platform-api/probe
```

实测（2026-09-18）：BOSS `wt2 / __zp_stoken__ / bst`、猎聘 `__gc_id / XSRF-TOKEN` 均读取成功 —— 此前只能靠截图肉眼判断登录态。

**核心结论**（详见 [`docs/BOSS_OPENAPI_PLAN.md`](./docs/BOSS_OPENAPI_PLAN.md)）：BOSS/猎聘的「开放平台」**都是 B 端（招聘方/服务商）能力**（企业 IM、简历库、薪资元数据），需企业实名 + IP 白名单，**求职者个人无法用它投递简历**。因此「彻底消验证码」的正解不是找官方 API，而是**把平台登录会话搬出用户本机（云端执行）**——这正是职得鸭验证码无感的真正原因。
本仓库当前策略：**CDP 整页链路负责投递**（签名由页面自算，最稳），**JSON 通道只负责检索提速与登录态诊断**，不做签名对抗军备竞赛。

---

## 开发

```bash
npm install
npm run dev          # 前端(React, 5173) + 后端(默认 4400)；浏览器开 http://127.0.0.1:5173 使用 React 界面
npm run build        # tsc -b && vite build（产物 dist/，供自托管/开发用）
npm run server       # 仅起后端，并在 / 托管 public/console.html（生产控制台，默认 4400，PORT 可覆盖）
```

### ⚠️ 改完代码必须跑 `npm run verify`（血的教训）

服务端用 `tsx` 直跑 `.ts`，**完全不做类型检查** —— 类型错误在运行期毫无异常、冒烟测试全绿，
但 `npm run build`（`tsc -b`）会直接失败。2026-09-19 软件测评实测踩到：给 `jobs` 加 `quarantine` 列时
漏改 `JobRow` 接口，运行时一切正常，**构建却长期是坏的**，直到测评才发现。

```bash
npm run verify       # = typecheck(tsc -b，含 server/) + console:check(控制台内联 JS 语法)
npm run test         # = selftest + 合约测试（CI 同款；离线可跑，不碰浏览器/不联网）
npm run selftest     # 只读功能回归 58 项（无本地简历文件时自动跳过 A 段）
npm run test:contract # 23 项合约测试：请求来源守卫 8 + 自动回复引擎 15（mock 驱动，无需 CDP）
npm run hooks:install # 装 git pre-push：推送前自动跑 verify，杜绝「构建坏了没人知道」
```

`npm run hooks:install` 会设置 `core.hooksPath=.githooks`（配置随 `.githooks/` 一起入库）。
紧急时可 `git push --no-verify` 跳过。

> 生产一键启动：双击桌面「投递Agent」（= `start_all.bat`）→ 起 CDP Chrome + 后端(`PORT=4400`) + 自动打开 `http://127.0.0.1:4400/`（console.html 控制台）。

## 部署与安全（分发 / 多人共用）

本服务会**触发真实副作用**（批量投递、邮箱直投发信），因此内置了来源防护：

| 场景 | 配置 | 说明 |
|---|---|---|
| 本机自用（默认） | 无需配置 | 仅监听 `127.0.0.1`，CORS 白名单只放行本机来源 |
| 局域网小团队共用 | `HOST=0.0.0.0`<br>`EXTRA_ORIGINS=http://192.168.1.20:4400,...` | 把**对方浏览器访问本服务的来源地址**加入白名单，否则其写操作会被 403 |
| 公网 / 多租户 | ❌ 不支持 | 需账号体系、数据隔离、托管浏览器，属架构级改造；**请勿直接暴露公网** |

安全机制（`server/services/requestGuard.ts`，有单测覆盖）：
- **读写一视同仁**：带 `Origin` 的请求必须命中白名单，否则 **403**；
- 不带 `Origin` 时校验 `Sec-Fetch-Site`，`cross-site` 一律 **403**；
- **不再对只读方法无条件放行**：存在「带真实副作用的 GET」（如 `GET /api/auto-reply/run?realSend=1`），
  恶意网页可用 `<img src="http://127.0.0.1:4400/api/...">` 跨站触发（简单 GET 无预检，响应虽读不到，副作用却已发生）；
- 直接导航（`Sec-Fetch-Site: none`，如双击启动器 / 地址栏打开控制台）与本机脚本 / curl 不受影响。
- **安全响应头**：`X-Frame-Options: DENY` + CSP `frame-ancestors 'none'`（**防点击劫持**——控制台能触发真实投递，被 iframe 套娃诱导点击风险高）、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、最小 CSP。

### 行为变更速览（2026-09-25）

| 变更 | 说明 |
|---|---|
| 批量投递**默认排除已投岗位** | `criteria.excludeApplied` 默认 `true`（显式传 `false` 才把已投岗位纳入候选）。此前不传就不过滤，导致已投的高分岗位反复被选中→跳过，真实可投候选永远轮不到 |
| 「已投」判定改为**平台 + 职位** | 此前无平台维度、且历史 `company` 为空时退化为「只比职位」→ 同名职位跨公司/跨平台被误判已投。现在公司仅当**双方都有值**时才比对 |
| A/B 对照剔除 `legacy` | 历史未打标数据只计入总量、**不参与对照**（报告里给出 `legacyExcluded`） |
| 上传 `.docx` 简历**也参与匹配/定制** | 此前上传路由只对 PDF 调解析，Word 简历即便能保存也不参与匹配 |
| **真·操作录屏** | CDP `Page.startScreencast` 帧流（点击 / 跳转 / 弹窗都被连续捕获）→ 帧序列 + `play.html` 连续播放页；本机装了 ffmpeg 会自动另出 mp4。手动：`POST /api/apply/record-video/{start,stop}`，或控制台「投递操作证据回溯」面板「● 开始录像 / ■ 停止并归档」；**批量投递勾选「记录操作录像」**会每次投递自动录，回看入口写入 `applications.video_path` |
| 轻量备选 `GET /api/apply/record` | 按间隔**抽帧**（快速取样，非录屏），存到 `data/evidence/rec-*/` |
| 新增 `GET /api/stats/trend?days=7` | 近 N 天投递趋势，首页看板内联展示 |
| `data/` 体积阈值 | `DATA_MAX_MB`（默认 3000）：启动清理时超过会往运行日志写一条 ERROR 提醒 |

> 这套机制用于拦截「用户浏览恶意网页时，页面 JS 静默调用本机 API 触发投递/发信」（DNS-rebinding）。

运维要点：
- 运行日志落盘 `data/run_log/YYYY-MM-DD.log`；启动时自动清理过期截图与超量 DB 备份（`npm run data:cleanup` 可手动跑，`--dry-run` 只统计）。
- 控制台「运行日志」视图可按**日期 / 级别（INFO|ERROR）/ 关键字**筛选日志，并查看 OCR 失败项原文；
  首页「运行健康」卡片汇总 ERROR 数 / 日志行数 / OCR 失败数 / 运行状态，侧栏在近 1 天有 ERROR 时显示红点。
- **运行异常邮件告警**：服务端出现 ERROR（含接口 5xx 兜底）会经邮件通道推送到邮箱，做到无人值守也能第一时间知道。
  收件人默认=已配置邮箱自己，可用 `ALERT_EMAIL` 指定；同一错误默认 1 小时内不重复、两封间隔 ≥10 分钟（聚合防刷屏）；
  `ALERT_ENABLED=false` 可关闭。控制台「运行健康」有「测试告警邮件」按钮可一键验证通道。
- 未捕获异常有全局兜底（保活 + 落日志），不会静默退出。
- OCR 失败项的模型原文落盘 `data/ocr_failed/`，不丢数据，便于复核。

## License

MIT
