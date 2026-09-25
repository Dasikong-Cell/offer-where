# 上线就绪度评估报告 · job-apply-agent

- **评估时间**：2026-09-25
- **评估口径**：**打包分发给他人使用**（`job-apply-agent-portable.zip`，对方解压即用）
- **代码版本**：`cf70264`（main，已双推 github/gitee）
- **评估方式**：只读取证 + 实跑验证（门禁、启动、来源校验 4 组合、UI 渲染、打包真机验收）

---

## 一、结论（TL;DR）

> **达标（可交付他人），综合分 ≈ 83/100。无 P0 阻塞项。**
>
> 真机验收通过：`pack.ps1` 白名单打包 → 解压到全新目录 → 用**包内自带 Node** 启动 → 4 秒就绪、`data/` 与 `chat.db` 从零自动创建、无 `.env` 时 AI 优雅降级为规则模式、控制台 200。**「解压即用」成立。**
>
> ~~上线前建议先修 1 项 P1：GET 侧带副作用的接口缺少跨站防护~~ → **已于 2026-09-25 修复并实跑复验**（见「七、整改记录」）。整改后综合分 **≈85/100**，**完全达标**。

---

## 二、实测表（每条均附命令 / 文件:行 / 实测输出）

| # | 维度 | 检查项 | 实测证据 | 结论 |
|---|------|--------|----------|------|
| 1 | 门禁 | 类型 + 控制台语法 | `npm run verify` → tsc 0 错误、`静态 HTML 容器标签配对平衡` | ✅ |
| 2 | 门禁 | 自测 + 合约测试 | `npm test` → **通过 193 / 共 193** | ✅ |
| 3 | 启动 | 冷启动耗时 | 包内实例日志：**冷启动 1785ms**，`/api/ping` 4s 内就绪 | ✅ |
| 4 | 启动 | 全局异常兜底 | `server/index.ts:2493` uncaughtException、`:2497` unhandledRejection（含 EPIPE 噪声抑制，防日志自激） | ✅ |
| 5 | 启动 | 优雅退出 | `server/index.ts:2484-2485` SIGINT/SIGTERM → `closeAll()` + `server.close()` | ✅ |
| 6 | 启动 | 端口占用处理 | `server/index.ts:2457-2472` EADDRINUSE → 友好中文提示 + `exit(1)` | ✅ |
| 7 | 配置 | 默认端口一致性 | `index.ts:59 DEFAULT_PORT=4400`，与 `start_server.bat:6 PORT=4400`、脚本约定一致（**无「默认 3000」陷阱**） | ✅ |
| 8 | 安全 | CORS | 非通配：`index.ts:120-133` 白名单回显 `int->Origin`，`buildAllowedOrigins(PORT, EXTRA_ORIGINS)` | ✅ |
| 9 | 安全 | 写方法来源校验（实跑） | ①GET 无 Origin→200 ②GET 白名单→200 ③**POST 恶意 Origin→403**（`{"error":"禁止的请求来源"}`） | ✅ 写方法已拦；⚠️ 见 P1 |
| 10 | 安全 | 密钥 | 全仓 grep `sk-*`/`api_key=`/`password=` → 仅 node_modules 误报；`.env` 未入库、未入包 | ✅ |
| 11 | 安全 | `.env.example` 键名一致性 | CODEBUDDY_/LLM_/MAIL_/ALERT_/APPLY_/ALLOW_BROWSER_EVAL/REQUIRE_AUTH/HOST/PORT/EXTRA_ORIGINS **全部命中代码读取处** | ✅ |
| 12 | 安全 | SQL 注入 | `server/db.ts` 全 `prepare(sql).all/run(...params)` 参数化；`exec` 仅用于 DDL | ✅ |
| 13 | 数据 | 磁盘与清理 | `data/`=961M（browser 505M/jd_images 234M/screenshots 207M）；`cleanup_data.ts` 有保留策略（`keepDbBackups` 默认 3，默认 dry-run），`:2452` 启动时自动 cleanupData | ✅ |
| 14 | 运维 | 可观测性 | `logRun` 落盘 `data/run_log/<date>.log`，`:90/:104` **20MB 上限**防日志写满；ERROR 走邮件告警（去重+节流）；`:161-169` 5xx 统一落日志 | ✅ |
| 15 | 运维 | 边界值 | `:118 express.json({limit:'15mb'})` 全局；`/api/resume/upload`(`:1346`) 无单独体积校验 → 见 P2 | ⚠️ |
| 16 | 交付物 | 打包自校验 | `pack.ps1` **白名单**（`:21-23`）+ **fail-closed 断言**（必需文件齐 + 禁 `.env`/`data/`/`src/`/`.git`，`:63-75`） | ✅ |
| 17 | 交付物 | 包内审计 | 181396 条目：`.env` 0、`data/*` 0、`src/*` 0、profile 0；`.env.example`✓ `node/node.exe`✓ `tsx cli`✓；**`server/**/*.js` 68 个（见 P2）** | ✅/⚠️ |
| 18 | 交付物 | **真机验收** | 解压 `D:\_pkgtest` → 包内 node 启动 → `/api/health` `{ai:false}`（优雅降级）→ `GET /` 200（92746 字节）→ **自动建 `data/chat.db` + 迁移列** → DB 读接口 `/api/apply/evidence`、`/api/apply/quota` 正常 | ✅ |
| 19 | UI | 渲染 + DOM 探针 | `agent-browser` 实渲染：9 视图**无一被 select/table 吞**（`swallowed:[]`），7 tab 切换内容长度各异，截图渲染精致 | ✅ |

---

## 三、问题清单

### P0（阻塞上线，必须清零）
**无。** 未发现密钥泄露、未打包个人数据、CORS 非通配、写方法有来源校验、SQL 全参数化、异常有兜底。

### P1（上线前建议修复）—— 已全部清零 ✅

**P1-1 · GET 侧带副作用的接口缺少跨站防护（CSRF）** · 【已修复 2026-09-25】
- **位置**：`server/services/requestGuard.ts:44-45`（`if (SAFE_METHODS.has(method)) return { ok: true };`）+ `server/index.ts:1777`（`GET /api/auto-reply/run`）、`:1897`（`GET /api/auto-apply/watch`）
- **实测**：`GET` 带恶意 `Origin: http://evil.example` → **200**（未被拦）。链路：恶意页面 `<img src="http://127.0.0.1:4400/api/auto-reply/run?platform=boss&realSend=1">` → 浏览器发送简单 GET（无需预检）→ 服务端执行真实发信；响应虽因无 CORS 头而读不到，但**副作用已经发生**。
- **影响**：受害者本机运行本工具时，若访问恶意网页，可能被触发真实投递/发信/watch 开关。需「应用运行中 + 用户访问恶意页」两个条件。
- **修复方案**（已采用 a）：
  - a) ✅ **`requestGuard.ts` 取消「只读方法无条件放行」**，对**所有方法**统一校验：带 `Origin` 必须命中白名单；不带 `Origin` 时 `Sec-Fetch-Site: cross-site` 一律拒绝；OPTIONS 保持放行（中间件已短路）。直接导航（`none`）与同源调用不受影响。
  - b) （未采用）把 `auto-reply/run`、`auto-apply/watch` 等有副作用动作改为 POST。
- **工作量**：小（实改约 15 行 + 同步 6 条单测）。

### P2（建议改进，不阻塞）

| ID | 问题 | 位置 / 证据 | 修复建议 | 工作量 |
|----|------|-------------|----------|--------|
| P2-1 | 包内混入 68 个 `server/**/*.js` 编译产物 | `pack.ps1:21` 打包整个 `server` 目录；zip 审计 `server/**/*.js`=68 | ✅ **已修**：`pack.ps1` 增 `--exclude=server/*.js`/`shared/*.js` + 双向 fail-closed 断言（不误伤 node_modules 的 ~6.1 万 `.js`） | 已完 |
| P2-2 | ~~上传接口无体积校验~~ → **原判断有误** | `index.ts:1354` | ✅ **实为已有**：8MB 上限校验（`>8MB → 400 友好提示`）；仅 11–15MB 灰区可能落到全局 413，影响极小 | — |
| P2-3 | 分发给他人需对方自备 Google Chrome | `setenv.bat:16-20`（未装则报错并给下载链接） | ✅ **已补**：README 置顶「前置要求」（Windows 10 1803+ / 需装 Chrome） | 已完 |
| P2-4 | 包体 455MB / 18.1 万文件，解压约 3 分 20 秒 | 实测 `tar -xf` → 3m19s | ✅ **已补**：README 注明包体与解压耗时；原生依赖按平台裁剪属后续优化 | 已完 |
| P2-5 | `start_all.bat` 默认只启 5 个平台窗口 | `start_all.bat:23-27`（9223-9227） | ✅ **已补**：README 快速开始注明其余平台用 `start_platforms.bat` | 已完 |
| P2-6 | `data/` 无硬性总量上限 | screenshots 207M / jd_images 234M | 依赖 `cleanup_data.ts`（启动自动清理）；可后续加总量阈值告警 | 小 |

---

## 四、最小整改 Checklist

- [x] **修 P1-1**：GET 侧副作用接口加跨站校验（改 `requestGuard.ts`，读写一视同仁）—— 已完成
- [x] 回验 P1-1：实跑 **7 组合** —— ①②③④ 均 200、⑤⑥⑦ 均 403，`GET /api/auto-reply/run` 跨站 → **403**（副作用已阻断）—— 已完成
- [x] P2-1：`pack.ps1` 不再打包 `server/**/*.js`（改用**确定性文件清单**，非 tar `--exclude`）+ 双向 fail-closed 断言 —— 已完成
- [x] P2-3/2-4/2-5：README 前置要求 / 包体与解压提示 / 平台窗口说明 —— 已完成
- [x] 门禁回验：`npm run verify` 0 错、`npm test` **197/197** —— 已完成
- [ ] （可选）再跑一次「解压即用」真机验收

---

## 五、评分卡（**现状**，含两轮整改；评估时的原始分见「七、整改记录」）

| 维度 | 得分 | 说明 |
|------|------|------|
| 代码质量 | 85 | TS 严格、参数化 SQL、ESM 规范、结构清晰 |
| 功能完备度 | 90 | 10 平台 + AI 匹配/复聊 + 一岗一简历 + A/B + 录屏回溯 + 远程筛选 + 合规检测 + 真人节奏 |
| 可交付性 | 84 | 白名单打包 + fail-closed + 自带运行时 + 解压即用实测通过；✅ 已剔除 `.js` 冗余、README 补前置要求/体积提示；扣分：包体 455MB / 解压约 3 分 20 秒 |
| 稳定性容错 | 88 | 全局异常兜底、EADDRINUSE、优雅退出、日志上限、风险信号封锁、每日上限 |
| 测试覆盖 | 90 | **203/203**（自测+合约，含平台登记 / 预览透传 / 来源守卫 / 已投口径防回归）；**CI 双 job 且已实证全绿**（`verify-and-test` on ubuntu + `package-smoke` on **windows-latest**，CI #30 整轮 Success）——✅ 真实交付路径已在干净 Windows runner 上跑通；扣分：仍无浏览器 E2E |
| 数据治理 | 78 | `data/` 隔离+清理策略+DB 备份保留；总量无硬上限 |
| 可观测性 | 88 | 落盘日志+上限+邮件告警+5xx 记录+运行健康面板 |
| 安全边界 | 86 | 白名单 CORS + **来源校验对所有方法生效** + 可选令牌 + 无硬编码密钥 + 参数化 + 安全响应头（`frame-ancestors 'none'`/`nosniff`）+ 控制台转义补全；✅ 已消除 GET 侧 CSRF |
| **综合** | **≈86** | 无 P0 → **达标（可交付他人）**；含两轮整改（P1 清零 + 13 项短板） |

---

## 六、总体评价

这是一款**工程成熟度明显高于同类个人项目**的工具：安全中间件、异常兜底、日志治理、启动清理、打包自校验这些「上线才暴露」的点都已提前覆盖，`pack.ps1` 甚至把 bsdtar `--exclude` 的坑写进了注释。**分发给他人这一口径下，它已经能「解压即用」**（本次已真机验证）。

唯一的实质风险是 **GET 侧副作用接口的 CSRF**（P1），修复成本极低，建议上线前清掉。其余为冗余文件、体积提示、上传限额等体验/健壮性改进（P2）。清理 P1 后，本项目在「分发给他人」口径下可判**完全达标**。

> 注：**公网 / 多租户**不在支持范围（本机 Chrome/CDP + SQLite 单机架构，README 已声明），如需该口径需架构级改造，本报告结论不适用。

---

## 七、整改记录（2026-09-25）

| 项 | 改动 | 文件 | 回验 |
|----|------|------|------|
| P1-1 | 取消「只读方法无条件放行」，来源校验对**所有方法**生效（OPTIONS 保持放行，中间件已短路） | `server/services/requestGuard.ts` | 实跑 7 组合：①GET 无 Origin ②GET `none` ③GET `same-origin` ④GET 白名单 Origin → **200**；⑤GET 恶意 Origin ⑥GET 跨站无 Origin ⑦POST 恶意 Origin → **403**；`GET /api/auto-reply/run` + 跨站 → **403** |
| P1-1 配套 | 同步合约测试：原「GET 任意来源放行」断言改为「GET 非白名单 Origin / 跨站 → 拒绝」，并新增导航放行用例 | `scripts/contract_tests.ts` | `npm test` → **197/197** |
| P2-1 | 打包不再包含 `server/**/*.js`、`shared/**/*.js`（tsc 编译产物，tsx 直跑 `.ts`） | `pack.ps1` | 重新打包审计（**逐前缀与磁盘比对**）：server 204→136、shared 3→2（**恰为要剔除的 69 个 `.js`**）；node_modules 172765、node 1、public 1、scripts 91 **逐个全等**；根级 28 项（8 文件 + 20 启动器）齐全；**另做决定性实证**：把 68 个 `server/**/*.js` 全移走后 tsx 仍正常启动（2s 就绪 / `/api/health` ok / SQLite 可读），证明应用不依赖编译产物 |
| P2-1 ⚠️踩坑 | bsdtar 的 `--exclude=server/*.js` 在**任意层级**匹配，曾误删 `node_modules/**/server/*.js` **254 个**文件 → 改为**确定性文件清单**（逐文件列举剔除 `.js`）+ **磁盘比对** fail-closed 断言 | `pack.ps1` | 断言价值已验证（首版即被审计发现） |
| P2-3/4/5 | README 置顶「前置要求」（Win10 1803+ / 需装 Chrome）、包体与解压耗时、平台窗口说明 | `README.md` | 文档 |
| P2-2 | **更正**：`/api/resume/upload` 本就有 8MB 上限校验（原判断有误） | — | `index.ts:1354` |

**整改后评分**（评估时 → 现状）：安全边界 74 → **86**（P1 清零 + 响应头/转义）；可交付性 80 → **84**（P2-1 修复 + 文档补全）；测试覆盖 82 → **90**（**CI 实为存在**——上一轮「无 CI」判断有误已更正；且新增 `package-smoke`(windows-latest) 并以 **CI #30 整轮 Success** 实证真实交付路径）。综合 **83 → ≈86**，**完全达标**。
> 注：测试数 193 → 197（P1 整改）→ **203**（短板整改新增 H8 已投口径回归等）；本地 `npm test` 全绿，CI 双 job 全绿。

**CI 实跑结果（连续两轮全绿）**

| run | commit | 内容 | 整轮 | 门禁+测试 (ubuntu) | 打包冒烟 (windows) |
|---|---|---|---|---|---|
| #30 | `2998a4f` | 真·录屏 + 修 CI 恒红 | ✅ Success / 5m10s | ✅ 1m20s | ✅ 5m6s |
| #31 | `fcfb059` | action 升 v5 | ✅ Success / 5m18s | ✅ 1m21s | ✅ 5m13s |

> ✅ **告警已清零**：`#30` 上还有 2 条 `Node.js 20 is deprecated`（`actions/checkout@v4`、`actions/setup-node@v4`）；升到 `@v5` 后 **`#31` 上该告警为 0 条**。
> ℹ️ 仅剩 1 条 notice（无法干预、与本项目无关）：`ubuntu-latest` 将于 2026-10-19 自动迁移到 Ubuntu 26。
> 📌 附带发现：CI 耗时从 #7–#28 的 **34–56s**（仅 ubuntu 单 job）变为 **5 分钟级**，正是 `package-smoke`(windows-latest) 加入（#29 起）所致——这是**必要成本**，换来真实交付路径被守住。

**另：本轮「找出不足」新增短板清单** → 见 `docs/shortcomings-2026-09-25.md`（功能/准确性/安全/工程/架构 5 类，含 3 条「先修小事」）。
