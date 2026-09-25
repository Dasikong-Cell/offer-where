# 短板与不足清单 · job-apply-agent

- **时间**：2026-09-25（凌晨）
- **口径**：打包分发给他人使用（延续上一轮上线就绪度评估）
- **取证方式**：源码审读（附 `文件:行`）+ 本会话实跑实测；每条标注【实证】或【审读】
- **说明**：本清单**只列不足**，优点见 `docs/launch-readiness-2026-09-25.md`。上一轮 P1/P2 已修的不重复列。

---

## 〇、整改状态（2026-09-25 按优先级全量实施）

| 项 | 状态 | 落地内容 | 验证 |
|----|------|----------|------|
| D2 | ✅ 已修 | `batch.ts` `excludeApplied !== false`（默认排除已投）+ 控制台本就默认勾选 | 实机 A/B：默认跳过 0 / 命中 3 个**新**岗位；显式 `false` 才纳入那 3 个已投岗位并全部跳过 |
| D1 | ✅ 已修 | `greetDecision.alreadyApplied(platform, company, position)`：加平台维度、去掉空 company 退化 | 新增合约测试 **H8**（4 条）；实库核对：`Java` 那 11 条里 10 条 company 为空、仅 1 条同公司，新口径仍正确命中真阳性 |
| S1+S2 | ✅ 已修 | `index.ts` 新增安全响应头：`X-Frame-Options: DENY`、`frame-ancestors 'none'`、`nosniff`、`Referrer-Policy`、最小 CSP | 实机 `curl -D -` 已回显全部 4 个头 |
| S3 | ✅ 已修 | `esc()` 增加 `"` / `'` 转义 | `console:check` 通过；标签配对平衡 |
| D3 | ✅ 已修 | `db.ts` 新增 `(platform, position)` 与 `company` 索引 | 建表断言随启动执行 |
| F4 | ✅ 已修 | 上传路由不再只解析 PDF：PDF/DOCX 都进解析 → 参与匹配/定制（mammoth 已是依赖）；并提示扫描件抽取过少 | 代码路径已改；`parseResumeFile` 本就支持 docx |
| F5 | ✅ 已修 | `applyAbTest.ts` 三分 letter/no_letter/legacy，**legacy 不参与对照**；报告加 `legacyExcluded` | 合约测试：`has=5 no=0 legacy=840 total=845`（对照组不再被 840 条污染）+ 三分完备断言 |
| O1 | ✅ 已修（**CI 端已实证**） | 新增 `scripts/pack_smoke.ps1`（打包→解压→包内 node 启动→健康探测）+ CI `package-smoke`（windows-latest） | 本地：`SMOKE OK health={"status":"ok","ai":false} consoleBytes=95654`；**GitHub CI #30 实跑通过（windows-latest，5m6s）** |
| F2 | ✅ 已做 | 控制台平台卡加「完整度」标注：全套 / 可投递 / 待接入（带 tooltip） | 渲染验证 |
| F3 | ✅ 已做 | 批量结果单列「需人工介入 N 条」+ 一键「打开该平台调试窗口」 | 代码路径已接 |
| O2 | ✅ 已做 | `dataCleanup` 统计 `data/` 总体积 + `DATA_MAX_MB`（默认 3000MB）阈值；超阈值启动时落 `run_log` ERROR | 接口字段 + 日志；`.env.example` 已补说明 |
| O3 | ✅ 已做 | `GET /api/stats/trend?days=7` + 仪表盘内联条形 | 实机返回真实数据（total 213，逐日 59/7/4/33/35/70/5） |
| F1 | ✅ 已做（**真·录屏**） | `cdpDriver.ts` 接 `Page.startScreencast` 帧流 + 逐帧 ack；`screencast.ts` 归档帧序列并生成 `play.html` 连续播放页（装了 ffmpeg 另出 mp4）；`POST /api/apply/record-video/{start,stop}`；批量投递加 `record` 开关，回看入口写入 `applications.video_path`；控制台「● 开始录像 / ■ 停止并归档」 | **实机**：start → 页面重绘 → stop = **9 帧 / 13s**；`play.html` HTTP 200 且探针显示已自动播到「第 8 / 9 帧」；帧 HTTP 200 image/jpeg |
| F1 附 | ℹ️ 保留 | `recordFrames`（按间隔抽帧）作为轻量备选保留 | 实机 3 帧、静态可访问 |
| O1 补 | ✅ 已修（**CI 已转绿**） | **CI 恒红的真因**：`contract_tests.ts` 无条件读 `data/browser/cdp.json`，而 `data/` 被 gitignore → CI 全新检出抛未捕获 ENOENT、整个测试进程中断。改为缺文件时只跳过「cdp 端口表」断言，其余 5 处同步点照常校验 | 干净 worktree 复现并修复：selftest 51/51（跳过 6 项无简历）· 合约 202/202 · **exit 0**；**CI #30（`2998a4f`）整轮 Success，两个 job 全绿** |
| F6 / A1–A4 | ⏳ 未做 | 双前端收敛 / 单机架构天花板 | 属架构级取舍，非本次范围 |

> F1 说明：已从「按间隔截图」升级为 **`Page.startScreencast` 帧流**（浏览器合成器在页面重绘时推帧，点击/跳转/弹窗都被连续捕获）。本机无 ffmpeg，故回看形态是**帧序列 + `play.html` 连续播放**（浏览器里点开即看，等效视频）；装了 ffmpeg 会自动额外合成 mp4。录像只读页面、不进投递判定路径，失败不影响投递结果。
>
> O1 补 说明：这条是**既有潜伏缺陷**（非本次改动引入）——CI 从「E 段平台注册校验」加入起就一直红，只是日志里表现为一句 `ENOENT`，容易被当成环境问题忽略。修法刻意保守：**缺文件只跳过依赖本机 data/ 的那部分断言**，仓库内 5 处同步点（types / connection / platformHealth / console / start_platforms）照常校验。

---

## 一、功能与产品短板

### F1【实证】「投递录屏」名不副实——只有 1 张静态截图，不是录屏
`cdpDriver.ts` 的 `screenshot` 动作每次成功投递只落 1 张 PNG；全仓 grep `startScreencast|screencastFrame|recordVideo|saveVideo` **零命中**。
> 对标 CareerBoom.ai 的卖点是「每次投递生成**操作录屏**」。当前实现只能算「单帧证据」，无法回看操作过程。
> **建议**：CDP `Page.startScreencast` 抽帧 → 落 `data/evidence/<appId>/*.jpg` → 可选 ffmpeg 合成 mp4。**工作量：中**。

### F2【审读】平台能力参差：10 个「可投」里只有 4 个是「全套引擎」
`server/services/apply/index.ts:48` `ENGINE_PLATFORMS = ['zhilian','boss','job51','liepin']` —— 只有这 4 个平台支持「批量/搜索/复聊/求职信」全套动作；其余 6 个可投平台（nowcoder / offerbiu / iguopin / yupao / chinahr / yingjiesheng）能力不齐。
另有 **5 个仅登记未实现**（`index.ts:35`：easyzhipin / job58 / dianzhang / maimai / ganji），点投递只返回「已登记、投递实现待接入」。
> **建议**：控制台按「完整度」给平台打标（全套/仅投递/待接入），并补 `cityData.ts` 里 job58/ganji 的 pinyin（`cityData.ts:10` 自注「尚未接入」）。

### F3【实证】自动化不彻底，多处需人工兜底
- BOSS 有 **3 条 `need_manual` 出口**（`apply/boss.ts:190/224/226`：找不到按钮 / 附件简历未确认 / 需完善在线简历或开 VIP）。
- **job51 投递需人工选简历**（本会话实测：跑完返回 `need_manual`，一个 `applied` 都没落库）。
- 51job 采集遇滑块 → 整页被替换、选择器全 null，需人工过滑块。
> 意味着「无人值守批量投递」在多平台并不成立。**建议**：控制台把「需人工」单独成列 + 一键跳转到对应调试窗口。**工作量：小**。

### F4【审读】简历解析仅支持 PDF，.docx 上传后**不参与匹配/定制**
`server/index.ts:1386`：`Word 简历已保存，但当前解析管线仅支持 PDF；如需参与匹配 / 定制，请上传 PDF 版本。`
> 而 `mammoth`（解析 docx）**已经是项目依赖**（package.json），只是没接进解析管线。**建议**：接上 mammoth，成本低收益直接。**工作量：小**。

### F5【审读】A/B 的对照组不干净，结论天然偏弱
`applyAbTest.ts`：实验组 `letter`，对照组用 `legacy`（= 全部历史投递，策略未知、混杂）。这不是干净的两臂对照（真正的 `no_letter` 臂从未被显式投出）。
> 即便回复率出现差异，也难以归因。**建议**：新增 `no_letter` 显式臂（投递时可指定不带求职信），或把 `legacy` 从对照中剔除只比 `letter` vs `no_letter`。**工作量：小–中**。

### F6【审读】两套并存的前端
`public/console.html`（生产用，单文件 50KB 内联 JS）+ `src/` React 应用 + `dist/` 构建产物。README 称「不冲突、不重复开发」，但实际是**双份 UI 维护面**（同一功能两处改）。
> **建议**：明确冻结一套，或在 README 标注 React 侧为「实验/只读」，避免双向漂移。

---

## 二、准确性与数据质量

### D1【实证·本会话踩到】`alreadyApplied` 误判——同名职位跨公司/跨平台被当成「已投」
`server/services/apply/greetDecision.ts:131-142`：
```sql
SELECT COUNT(*) FROM applications WHERE position = ? AND (? IS NULL OR ? = '' OR company = ?)
```
两个问题：**① 无平台维度**；**② `company` 为空即匹配任意同名职位**。
> 实测：boss 上 5 个高分岗位反复被判「已投递过」而跳过；zhilian 也出现同类跳过。历史 `applications.company` 大量为空，放大了误判。
> **建议**：判定加 `platform` 维度；company 为空时**不要**退化为「只比 position」。**工作量：小**（但会影响已投判定口径，需配回归测试）。

### D2【实证】`excludeApplied` 默认关闭，导致反复选中已投岗位
`apply/batch.ts:328-332`：`db.listJobs({source})` 取全量，仅在显式传 `criteria.excludeApplied` 时才剔除 `status='applied'`。
> 本会话实测：不传参时，已投高分岗位持续排在最前，每轮都被选中→跳过，永远触达不到真实可投候选（浪费 CDP 调用、刷 `need_manual`）。
> **建议**：**默认开启**（改为 `!== false` 语义），显式 `false` 才关闭。**工作量：小**。

### D3【审读】`alreadyApplied` 每岗位一次全表扫描
`applications` 仅有 `platform` / `created_at` 索引（`db.ts:98-99`），无 `position` / `company` 索引，而该查询按 position 过滤。
> 当前 845 行无感，投递量上万后会明显。**建议**：加 `CREATE INDEX ... ON applications(position, company)`。**工作量：极小**。

### D4【审读】AI「事实边界」机械兜底只覆盖「地点」一类
输出侧 `guardFabricatedLocation()` 只拦「我+在+城市名」；其它编造类（学历、项目经历、在职状态、薪资）**仅靠 prompt 约束**。
> 已知模型对 prompt 禁令遵守不稳定（本会话 memory：改完 prompt 仍复发）。**建议**：把机械兜底扩到「学校/公司/在职状态」等高风险字段。**工作量：中**。

---

## 三、安全与健壮性（残留项）

### S1【审读】**无 `X-Frame-Options` / CSP `frame-ancestors` → 控制台可被任意站点 iframe（点击劫持）**
`server/index.ts` 全文无 `X-Frame-Options` / `frame-ancestors` / helmet。
> 风险链条：恶意页面把 `http://127.0.0.1:4400/` 套进透明 iframe + 诱导点击 → 用户以为自己点的是别的东西，实际点了「开始投递」（**真实副作用**）。虽然上一轮已把跨站**写请求**与**跨站 GET** 拦掉，但**点击劫持发生在同源页面内部**，来源校验拦不住。
> **建议**：加 `X-Frame-Options: DENY` + `Content-Security-Policy: frame-ancestors 'none'`。**工作量：极小**。

### S2【审读】缺安全响应头（无 CSP / `nosniff` / Referrer-Policy）
控制台是 50KB 内联 JS 单页（`console:check` 报 50598 chars），无任何 CSP 约束，也无 `X-Content-Type-Options: nosniff`。
> **建议**：至少补 `nosniff` + 一条最小 CSP（允许 self + inline）。**工作量：小**。

### S3【审读】`esc()` 只转义 `& < >`，**不转义引号**
`public/console.html:636`：`replace(/[&<>]/g, ...)`。全文 93 处 `esc(` 调用、61 处 `innerHTML`。
> `<`/`>` 已挡标签注入，但**属性上下文**（`src="…"`、`title='…'`、`href="…"`）仍可被引号突破——当前插进属性的值多为服务端生成（低风险），但缺这层防线，一旦有外部来源（平台页里的 HR 名/URL）进入属性就会出问题。
> **建议**：`esc()` 增加 `"` 与 `'` 转义。**工作量：极小**。

### S4【审读】无速率限制（仅「每日投递上限」）
除 `APPLY_DAILY_LIMIT` 外，没有限流。同机其它进程可高频打 AI 类接口（`/api/resume/compliance`、匹配/文案），`authToken.ts` 注释也自认「拦不住同机进程」。
> 对分发给他人：影响有限（同机进程本就半可信）。**建议**：可加简单令牌桶；**优先级：低**。

### S5【审读】`express.json` 15MB 与上传 8MB 之间的灰区返回裸 413
`index.ts:118` 全局 15MB；`:1354` 上传上限 8MB。8–11.25MB 的 PDF 会命中**友好的**「文件过大（上限 8MB）」；11.25–15MB 反而落到 express 的裸 413，提示不友好。
> **建议**：给上传路由单独 `express.json({limit:'12mb'})` 或调低下层上限统一文案。**工作量：极小**。

---

## 四、工程与运维

### O1【审读·更正前一轮结论】~~CI 在 ubuntu 上跑，测不到真实交付路径~~ → **已修正并 CI 实证**
原状：`.github/workflows/ci.yml:12` `runs-on: ubuntu-latest`，只跑 `npm ci` + `verify` + `test`（单元/合约）。
> 而产品是 **Windows-only**：`.bat` 启动器、本机 Chrome/CDP、Windows 路径解析、`pack.ps1`（PowerShell + `tar.exe`）——ubuntu job 一样都覆盖不到；也无浏览器 E2E。
> ✅ **已整改**：新增 `package-smoke` job（`windows-latest`）→ `npm ci` → 用 runner 自带 node 22 顶替被 gitignore 的 `node/`（`ci.yml:49-54`）→ 跑 `scripts/pack_smoke.ps1`：打包 → 解压到全新目录 → 断言无 `.env`/`data`/`src`/编译产物 → 用**包内 node** 启动 → `/api/ping` + `/api/health` + `/api/apply/quota`（证明原生 SQLite 已加载）+ 控制台 200 + `data/chat.db` 自动重建 → 清理。
> 📌 **CI #30（`2998a4f`）整轮 Success（5m10s）**：`类型检查 + 门禁 + 测试` 1m20s ✅、`Windows 打包 + 解压即用冒烟` 5m6s ✅ —— **真实交付路径首次在干净 Windows runner 上跑通**。随后的 **#31（`fcfb059`）亦 Success**，并把 action 升到 `v5`，`Node.js 20 is deprecated` 告警清零。
> 残留（非阻塞）：仍无浏览器 E2E（无法在 runner 上跑本机 Chrome/CDP）。
> ⚠️ 更正：上一轮评估报告写「无 CI 流水线」是**错的**，此项目**有** CI；已在报告更正。

### O2【实证】`data/` 无硬性上限
实测 `data/` = **961MB**（browser 505M / jd_images 234M / screenshots 207M / chat.db 5.3M…）。只有「启动清理 + `npm run data:cleanup`（默认 dry-run）」。
> 分发给他人后，对方磁盘可能被静默吃满。**建议**：加总量阈值告警 + 默认定期清理截图。**工作量：小**。

### O3【审读】可观测性只有「日志 + 邮件告警」
有 ERROR 邮件告警与运行日志，但没有指标化面板（成功率 / 平均耗时 / 风控触发次数 / 平台维度趋势）。
> **建议**：从 `applications` / `app_kv` 派生一个「近 7 天趋势」小面板。**工作量：小**。

### O4【实证】分发依赖与体积
分发给他人需对方自备 **Google Chrome**（未打包，`setenv.bat:16-20` 会明确报错）；包体 **455MB / 18.1 万文件，解压 3–4 分钟**。
> 已在 README 提示，属可接受，但仍是交付摩擦点。**建议**：README 前置要求已置顶（已做）；原生依赖可按平台裁剪（**中**）。

### O5【审读·更正前一轮结论】依赖漏洞：**`npm audit` 0 条** ✓
`npm audit --json` → `metadata.vulnerabilities = {}`。**不是短板**，列出以更正。

---

## 五、架构天花板（非缺陷，是边界）

| # | 限制 | 证据 | 影响 |
|---|------|------|------|
| A1 | **单机架构**：本机 Chrome/CDP + SQLite + 无账号体系 | README:414「公网/多租户 ❌ 不支持」 | 做 SaaS/多人需架构级重写 |
| A2 | **必须有桌面环境** | 依赖真实 Chrome 窗口（`start_all.bat` / CDP 端口 9223+） | 无法跑在纯服务器/容器（无头场景未支持为主路径） |
| A3 | **强依赖登录态 + 人工过验证码** | 风控信号命中 → 中止整批；`data/.auth_token` 与 profile 绑定 | 无法规模化无人值守 |
| A4 | **平台改版即失效** | 各平台 DOM 选择器硬编码（`apply/*.ts`） | 需持续校准维护，长尾成本高 |

---

## 六、优先级排序（建议动手顺序）

| 优先级 | 项 | 理由 | 工作量 |
|--------|----|------|--------|
| **P1′** | D2 `excludeApplied` 默认开启 | 直接影响「能不能投到新岗位」，本会话已被它坑 | 小 |
| **P1′** | D1 `alreadyApplied` 加平台维度、去掉空 company 退化 | 误判已投 = 漏投，直接损失机会 | 小 |
| **P1′** | S1 + S3 安全响应头（frame-ancestors/nosniff）+ `esc()` 补引号转义 | 防点击劫持 + 补 XSS 防线，成本极低 | 极小 |
| **P2′** | F4 接 mammoth 解析 .docx | 依赖已在，收益直接 | 小 |
| **P2′** | F5 增加 `no_letter` 干净对照臂 | 让 A/B 结论真正可用 | 小–中 |
| **P2′** | O1 CI 加 windows job + 打包冒烟 | 守住真实交付路径 | 中 |
| **P2′** | D3 加 `applications(position, company)` 索引 | 一处 DDL | 极小 |
| **P3′** | F1 真·录屏（screencast 抽帧） | 对标卖点，但成本最高 | 中 |
| **P3′** | F2 平台完整度打标 / 补齐 F3 人工引导 | 体验与预期管理 | 小–中 |
| **P3′** | O2/O3 数据总量阈值 + 趋势面板 | 长期可用性 | 小 |

---

## 七、一句话总结

上轮修掉的是「**能不能安全地交付**」；本轮暴露的是「**交付之后好不好用、准不准**」——
最该先动的三件小事：**投递候选默认排除已投（D2）**、**已投判定加平台维度（D1）**、**补 `frame-ancestors`/`nosniff` 与 `esc()` 引号转义（S1+S3）**；
最该先认的一件事：**「录屏回溯」目前只是单帧截图（F1）**，对外表述需谨慎，别把截图说成录屏。
