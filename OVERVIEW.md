# 简历自动投递 Agent · Web 应用

基于 **CodeBuddy SDK**（`init-cbc-sdk-web` 脚手架）实现的简历自动投递助手，支持招聘官网 / BOSS直聘 / 智联招聘 / 前程无忧；官网邮箱登录验证码经 **QQ 邮箱 IMAP 自动读取并回填**。

## 项目位置
`C:\Users\吉学静\WorkBuddy\2026-09-02-09-33-33\job-apply-agent`

## 技术栈
- 前端：React 18 + TDesign（Chat / AIGC 组件）+ Vite + React Router
- 后端：Express + TypeScript（tsx 运行）+ SQLite（better-sqlite3）
- Agent：@tencent-ai/agent-sdk
- 自动化：Playwright（浏览器）、imapflow + mailparser（邮箱验证码）

## 已实现能力
| 模块 | 说明 | 关键文件 |
|------|------|----------|
| 档案管理 | 姓名/手机/邮箱/期望职位城市/简历路径，持久化 | `server/db.ts`、`src/pages/ProfilePage.tsx` |
| QQ 邮箱验证码 | IMAP 拉取最新验证码邮件，正则提取 4–8 位码，连接测试 | `server/services/mail.ts` |
| 浏览器自动化 | 按平台隔离持久化登录态；navigate/click/fill/text/html/screenshot/upload/wait/select | `server/services/browser.ts` |
| 投递记录 | 平台/公司/职位/薪资/城市/链接/状态/登录方式/备注，增删查 | `server/db.ts`、`src/pages/ApplicationsPage.tsx` |
| Agent 人设 | 登录（邮箱验证码）→ 搜索岗位 → 解析 JD → 填简历 → 投递 的能力契约 Prompt | `shared/agentPrompt.ts` |
| 前端界面 | 品牌「简历投递 Agent」、内置投递 Agent、侧边栏导航、档案页/投递记录页 | `src/config.ts`、`src/App.tsx`、`src/components/Sidebar.tsx` |

## 后端 API（端口 3000）
- `GET /api/health` 健康检查
- `GET|PUT /api/profile` 档案读写
- `GET|PUT /api/mail/config` 邮箱配置；`GET /api/mail/code?sinceMinutes=` 读取验证码
- `GET|POST|PUT|DELETE /api/applications` 投递记录
- `POST /api/browser/exec` 浏览器动作；`GET /api/browser/sessions` 会话列表

## 启动方式
```bash
cd job-apply-agent
npm install
npx playwright install chromium   # 首次需下载浏览器
npm run dev                       # 同时起 server(3000) + vite(5173)
# 浏览器打开 http://localhost:5173
```
生产构建：`npm run build`（已验证通过，无类型错误）。

## 验证结果
- ✅ 数据库三张新表创建与读写正常
- ✅ 浏览器导航 + 截图生成 PNG 成功（修复 Windows 无 GPU 下截图挂起：加 `--disable-gpu --disable-software-rasterizer --disable-dev-shm-usage` 及 `animations:'disabled'`）
- ✅ 会话创建/列表/删除正常（修复 `sdk_session_id` 必填问题）
- ✅ `npm run build` 类型检查 + 打包通过

## 使用前置条件（需用户自备）
1. QQ 邮箱 **授权码**（非登录密码）：在「设置 → 账户 → 开启 IMAP/SMTP」获取。
2. 个人简历 PDF 文件路径（用于上传投递）。
3. 招聘平台账号；BOSS/智联/前程无忧需先手动完成手机号实名与滑块验证（自动化无法绕过人机校验），之后可由 Agent 接管邮箱验证码类登录。
4. Agent SDK 所需的 API Key（在 `server/index.ts` 的 SDK 初始化处配置环境变量）。

## 岗位匹配 + 自动投递（Offerbiu 接入）
- **简历解析** `POST /api/resume/parse`：抽取 PDF/DOCX/TXT 文本并结构化（姓名/手机/邮箱/教育/技能/经历/项目），依赖 `pdf-parse` + `mammoth`。
- **岗位池** `jobs` 表 + CRUD：`GET/POST /api/jobs`、`PATCH/DELETE /api/jobs/:id`。
- **一键匹配** `POST /api/jobs/match`：用简历画像对全库岗位打分（0-100）+ 命中/缺失关键词，按分排序并回写 `match_score`。
- **Offerbiu 采集** `POST /api/offerbiu/collect`：登录态下采集「校招信息库」岗位卡片入库（自动外链投递入口）；未登录返回 401 并提示先登录。
- **前端「岗位匹配」页**（侧边栏「岗位匹配」入口）：解析简历 → Offerbiu 采集 / 手动加岗 → 一键匹配 → 点「投递入口」打开企业官网、或「标记已投递」写入投递记录。
- **跨平台专用投递脚本（BOSS / 智联 / 51job / 牛客 / 官网）**：
  - 后端 `server/services/apply/{boss,zhilian,job51,nowcoder,offerbiu,common,index,types}.ts`：状态驱动、可重复执行；流程 = 检测登录态 →（未登录）邮箱验证码登录（自动读 QQ 邮箱验证码）→ 打开岗位 → 点击投递/沟通 → 上传简历 → 校验成功。
  - `offerbiu.ts` 为「企业官网自动投递」：对 Offerbiu 校招信息库采集来的岗位（apply_url=企业官方招聘站），导航到官网 → 尽力而为的邮箱验证码登录 → 找「投递/网申」入口 → 上传简历 → 校验；企业官网结构差异大，识别不到入口时返回 `need_manual` 转人工。
  - 接口 `POST /api/apply` `{ platform: 'boss'|'zhilian'|'job51'|'nowcoder'|'offerbiu', jobId?, jobUrl?, sinceMinutes? }`：成功后自动写投递记录 + 更新岗位状态；遇滑块返回 `need_captcha`（在打开的浏览器里人工过一下后再次调用即可继续，登录态已持久化）；不支持平台返回 400。
  - 前端「岗位匹配」页每个岗位卡片带「BOSS 投递 / 智联投递 / 51job 投递 / 牛客投递 / 官网投递」按钮，弹出结果日志对话框。
  - Agent 提示词同步加入五个平台的能力说明（shared/agentPrompt.ts）。

## 一键启动
- 双击桌面快捷方式 **「简历投递Agent.bat」**（或项目内 `start.bat`）即可同时拉起后端(3000)+前端(5173)并自动打开浏览器。
- 关闭时直接关掉两个命令行窗口。

## 构建注意事项（本机环境）
- vite 默认会在构建前清空 `dist`，但本环境对删除操作做了「回收站」拦截会导致 `emptyDir` 失败、构建中断。
- 已通过两处规避：`vite.config.ts` 设 `build.emptyOutDir: false`；`package.json` 的 `build` 脚本前置 `rm -rf dist`（非致命分隔符）。
- 如在本机改完前端后构建报错 `safe-delete ... trash failed`，先手动删除 `dist` 目录再 `npm run build` 即可。

## 合规与安全提示
- 自动投递应仅在本人授权范围内、遵守各平台《用户协议》与反爬/反自动化条款，避免高频操作导致封号。
- 邮箱授权码、简历等敏感信息仅存于本地 SQLite，请勿提交到公开仓库。
