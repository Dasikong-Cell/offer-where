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

## 开发

```bash
npm install
npm run dev          # 前端(React, 5173) + 后端(默认 3000，CORS 互通)；浏览器开 http://127.0.0.1:5173 使用 React 界面
npm run build        # tsc -b && vite build（产物 dist/，供自托管/开发用）
npm run server       # 仅起后端，并在 / 托管 public/console.html（生产控制台，默认 3000，PORT=4400 覆盖）
```

> 生产一键启动：双击桌面「投递Agent」（= `start_all.bat`）→ 起 CDP Chrome + 后端(`PORT=4400`) + 自动打开 `http://127.0.0.1:4400/`（console.html 控制台）。

## License

MIT
