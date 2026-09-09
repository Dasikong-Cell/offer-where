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
├── public/console.html          # 单一控制台入口（由 4400 托管）
├── scripts/                     # 脚本工具（登录引导、采集等）
├── data/                        # 本地数据（岗位库 / 投递记录 / 会话 / 截图）—— 不入库
├── node/                        # 自带 Node 运行时（便携包用，免安装）
└── *.bat                        # Windows 一键启动器（含 %USERPROFILE% 规避中文路径 + UTF-8 BOM）
```

**浏览器自动化**：通过本地 CDP Chrome（默认 `9222` 端口、`C:/chrome-cdp-profile` 登录态隔离）驱动各招聘站点；服务端默认监听 **4400**。

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

未配置 AI 时，项目以**「规则匹配 + 模板文案」**模式完整运行。配置任意 OpenAI 兼容网关后，自动切换为**「AI 语义匹配 + AI 文案」**。

在 `.env`（参考 `.env.example`）中设置：

```bash
LLM_BASE_URL=https://api.openai.com/v1      # 或 http://127.0.0.1:11434/v1（本地 Ollama）
LLM_API_KEY=sk-xxx                          # 本地 Ollama 可留空
LLM_MODEL=gpt-4o-mini                       # 或 qwen2.5:7b / deepseek-chat ...
```

兼容：OpenAI / DeepSeek / SiliconFlow / 通义 / 智谱 / Groq / 本地 Ollama 等。
设置后 `/api/health` 返回 `"ai": true`，控制台可据此提示 AI 已启用。

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
npm run dev          # 前端(5173) + 后端(默认 3000)；生产以 PORT=4400 tsx server/index.ts 启动
npm run build        # tsc -b && vite build
```

## License

MIT
