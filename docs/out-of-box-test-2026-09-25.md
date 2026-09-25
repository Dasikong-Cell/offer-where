# 开箱体验实测：「下载即用」达标评估

**日期**：2026-09-25 ｜ **口径**：模拟**接收方在干净机器上从拿到包到投出第一份简历**的全过程
**结论先行**：**不达标。** 现在这套东西不是「下载即用」，而是「下载 → 踩三个坑 → 回来找作者」。问题不在打包脚本，而在**分发链路与首跑配置**。

---

## 0. 一句话结论

| 关卡 | 问题 | 结果 |
|---|---|---|
| ① 能不能「下载」 | GitHub / Gitee **都没有 Release，也没有任何 tag** | ❌ **不成立** |
| ② 解压后能不能起 | 自带 Node、后端起得来、控制台打得开 | ✅ 成立 |
| ③ 起来后能不能干活 | 缺 `data/browser/cdp.json` → **核心投递功能完全不可用** | ❌ **不成立** |
| ④ 用起来顺不顺 | 挂起接口、过时文档、硬编码路径、开发脚本混入 | ⚠️ 多处待修 |

**②③ 的对比就是本次最关键的发现**：程序能启动，但**启动后干不了它唯一的正事**。

---

## 1. 实测过程与证据

全部为本次实跑，非推断。

### 1.1 拿包（关卡①）

```bash
curl -s "https://api.github.com/repos/Dasikong-Cell/offer-where/releases"   # -> []
curl -s "https://api.github.com/repos/Dasikong-Cell/offer-where/tags"        # -> []
curl -s "https://gitee.com/api/v5/repos/grand-minister-of-works/offer-where/releases"  # -> []
git tag                                                                      # -> 空
ls .github/workflows/                                                        # -> 只有 ci.yml，无 release 工作流
```

**桌面上那个包是手工产的，且是「整改做到一半」的快照。**

用 zip 条目自带时间戳取证：

| 项 | 值 |
|---|---|
| zip 文件 mtime | 2026-09-25 **01:55:35** |
| 包内非 node_modules 条目最新 mtime | 2026-09-25 **01:53:42** |
| 当天整改提交时间 | 2026-09-25 **15:43–16:33** |

逐文件比对（包里 vs 当前源码）：

| 文件 | 包里 | 磁盘 | 判定 |
|---|---|---|---|
| `server/services/requestGuard.ts` | 3158 B | 3158 B | 一致（含安全修复，00:47 已改） |
| `pack.ps1` | 6470 B | 6470 B | 一致 |
| `server/services/apply/batch.ts` | 44124 B | 45798 B | **旧版**（缺 `record` 录屏开关） |
| `server/index.ts` | 112094 B | 115750 B | **旧版** |
| `public/console.html` | 95654 B | 102120 B | **旧版** |
| `server/services/apply/screencast.ts` | **不存在** | 存在 | **整份录屏功能缺失** |
| `.env.example` / `README.md` | 旧 | 新 | **旧版** |

⇒ 该包**不对应任何一次提交**（既非 HEAD，也非任何 tag），且**无法追溯是哪个版本**。给出去就是给了一个「比 HEAD 少 4 个提交」的构建。

### 1.2 解压与安全断言（关卡②）

重新用当前代码打包（4 个必含断言 + 4 个禁含断言全过）：

```
PACKED: D:\Desktop\job-apply-agent-portable.zip
  zip 454.7 MB | 181325 entries | elapsed 276.8 s
```

解压到干净目录 `D:\_pkgtest_oob`：

| 断言 | 结果 |
|---|---|
| tar 退出码 | 0 |
| **解压耗时** | **308.5 s（约 5 分 8 秒）** ← README 写的是「3–4 分钟」 |
| `.env` / `data` / `src` / `.git` 存在？ | 全部 **False** ✅ |
| `node\node.exe`、各启动器、`server\index.ts`、`public\console.html`、`tsx` | 全部 **True** ✅ |

### 1.3 首次启动（关卡②）

以全新用户状态直接跑包内后端（独立端口 4500，不干扰本机开发实例）：

```
[DB] Added remote column to jobs
[DB] Added strategy column to applications
[DB] Added evidence_path column to applications
[DB] Added video_path column to applications
[DB] Added ai_name column to hr_conversations
[DB] Added ai_source column to hr_conversations
[DB] Added ocr_status column to jobs
[INFO] API 服务器已启动 http://127.0.0.1:4500｜数据库 SQLite(data/chat.db)｜冷启动 3161ms
```

- **自动建库、自动迁移、冷启动 3.2s** ✅
- 自动创建 `data/{evidence,resume_tailored,run_log,screenshots}` ✅
- 控制台 `GET /` → **HTTP 200 / 102120 B / UTF-8** ✅
- `/api/health` → `{"status":"ok","ai":false}` —— 无 `.env` 时**优雅降级为规则模式** ✅（设计正确）
- `/api/jobs`、`/api/stats/trend`、`/api/apply/ab-report` 空态均为**结构化返回且带说明文案** ✅

### 1.4 核心功能实测（关卡③）——**失败**

投递引擎的真实调用链（已核到代码行）：

```
server/services/apply/common.ts:10   import { execAction } from '../browser.js'
        ↓
server/services/browser.ts:258       const cdpUrl = getCdpEndpoint(platform);
server/services/browser.ts:259       if (cdpUrl) return execCdpAction(...)   ← 用真实 Chrome（带登录态）
server/services/browser.ts:263       const session = await getSession(...)  ← 退化：Playwright 自带 Chromium
        ↓
server/services/browser.ts:60        if (!fs.existsSync(CDP_CONFIG_PATH)) return null;
```

`data/browser/cdp.json` 不在包里（`data/` 被整体排除），且**全仓库没有任何代码会创建它**（grep 到的全是「读」）。

**实跑复现**（用 `PLAYWRIGHT_BROWSERS_PATH` 指向空目录，精确模拟「从没跑过 `playwright install` 的机器」——本机恰好有 Playwright 浏览器，不这样设会「碰巧成功」）：

```bash
curl -X POST http://127.0.0.1:4500/api/browser/exec -H "Content-Type: application/json" \
  -d '{"platform":"boss","action":"navigate","url":"about:blank"}'
```

```json
{"ok":false,
 "error":"Chromium 浏览器未下载。请执行：npx playwright install chromium",
 "hint":"npm install playwright && npx playwright install chromium"}
```

**这个提示是有害的**，三重错：

1. 包内自带 `node/node.exe` 就是为了让接收方**不必装 Node** —— 那么他机器上**根本没有 `npx`**，照提示做第一步就卡住；
2. 即便他装上，那也是一个**全新未登录的 Chromium**，不是他已在平台登录过的真实 Chrome → 投递照样全部失败（未登录）；
3. 真正的修法是补 `data/browser/cdp.json` —— 而 **README 与任何文档都没提过这个文件**。

**因果闭环验证**（补入 `cdp.json`，**不重启后端**，重发同一条请求）：

```json
{"ok":true,"url":"about:blank","title":""}
```

`/api/browser/connections` 同时从「未配置 CDP 端口」变为：

```json
{"boss":{"endpoint":"http://127.0.0.1:9223","connected":true,"browser":"Chrome/151.0.7922.109"}}
```

⇒ **一个文件的差别，就是「能投递」与「完全不能用」。** 而它能接管到真实 Chrome（`Chrome/151.0.7922.109`），正是这个项目反风控能力的根。

### 1.5 首跑其他问题

| 探测 | 结果 | 判定 |
|---|---|---|
| `GET /api/check-login` | **HTTP 000，耗时 60.0s，0 字节，后端日志一行错误都没有** | ❌ **永久挂起** |
| `GET /api/platforms/health` | 200，但**耗时 12.7s** | ⚠️ 慢 |
| `GET /api/resume/current` | `hasOriginal:false, hasOptimized:false` | ⚠️ 新用户无简历（有上传 API，但无引导） |
| `GET /api/apply/quota` | `limit:40, used:0, remaining:40` | ✅ |
| `GET /api/mail/config` | `hasAuthCode:false` | ✅ 空态合理 |

`/api/check-login` 的挂起后果是**实的**：控制台按钮的处理是

```js
b.textContent='检查中…'; b.disabled=true;
try{ const r = await api('/api/check-login?...') ... }   // 永不 resolve
```

⇒ 接收方点一次「检查登录」，按钮**永久停在「检查中…」且禁用**，没有超时、没有报错。
根因：`unstable_v2_authenticate` 调用**没有 timeout 包裹**；开发机已登录 CodeBuddy，所以一直没暴露。

### 1.6 端口表的「三套来源」问题

同一份「平台 → CDP 端口」映射，在不同模块里的缺失表现**不一致**：

| 模块 | 缺 `cdp.json` 时 | 后果 |
|---|---|---|
| `browser.ts`（投递执行） | 返回 null → 退 Playwright Chromium | ❌ **核心功能不可用** |
| `connection.ts`（连接判定） | 全平台报「未配置 CDP 端口」 | ⚠️ 控制台未消费该接口，影响面小 |
| `platformHealth.ts`（平台巡检） | 有内置默认端口表 → 照常工作 | ✅ |
| `browserHealth.ts`（农场自愈） | 有内置兜底（9 端口）→ 照常工作 | ✅ |
| `chatResumeImage.ts` / `tailoredResumePdf.ts` | 硬编码 `pick('official', 9227)` 兜底 | ✅ |

⇒ 农场和巡检**看起来一切正常**（`/api/browser/health` 在本机全绿），唯独**真正干活的投递执行**是唯一没有兜底的那条路。这就是为什么此前的 `pack_smoke.ps1` 冒烟测试（只验 ping/health/quota/console）和 CI 都发现不了它。

---

## 2. 与「软件商城下载即用」的差距对照

| 维度 | 商城软件 | 本项目现状 | 差距 |
|---|---|---|---|
| 获取 | 应用商店点一下 | **无 Release、无 tag**，得自己 clone 源码跑打包脚本 | ❌ 高 |
| 安装 | 双击安装包 | 解压 454.7MB / 18 万文件 / **5.1 分钟** | ⚠️ 中 |
| 版本 | 有版本号、可回滚 | 包无版本标识，**不对应任何提交** | ❌ 高 |
| 首次启动 | 自动完成初始化 | 后端能起，但**首跑必需配置靠手工补** | ❌ 高 |
| 依赖 | 全自带 | 自带 Node ✅，但**未登录的浏览器依赖**会成为拦路虎 | ❌ 高 |
| 配置 | 图形化向导 | 无向导；缺文件时不提示「缺什么」 | ❌ 高 |
| 更新 | 应用内更新 | 无任何更新机制 | ⚠️ 中 |
| 卸载 | 控制面板 | 删目录即可（反而更干净） | ✅ |
| 平台限制 | 视软件而定 | Windows 10 1803+ / 需 Chrome / 需各平台账号 | 说明即可 |
| 首跑自检 | 有 | **无** | ❌ 高 |

---

## 3. 卡点清单（按严重度）

### P0 — 不修则「下载即用」不成立

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| **P0-1** | **没有任何分发渠道**：GitHub/Gitee 均无 Release，无 tag，无 release 工作流 | API + `git tag` + `ls workflows` | 用户「下载」这个动作无处可点 |
| **P0-2** | **`data/browser/cdp.json` 缺失** → 投递完全不可用，且报错指向错误解法 | §1.4 实跑 | 核心功能失效 |
| **P0-3** | **无版本可追溯**：桌面包是整改中途快照，不对应任何提交 | §1.1 时间戳取证 | 出问题无法定位是哪个版本 |

### P1 — 首次使用明显受阻

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| **P1-1** | `/api/check-login` **永久挂起**，无超时无报错 | 60s / 0 字节 / 日志空白 | 点一次按钮即卡死 |
| **P1-2** | 无首跑引导/自检：README 说「双击桌面「投递Agent」」，但包里**没有这个文件**（要先跑 `创建桌面快捷方式.bat`） | 包内根目录清单 | 第一步就对不上 |
| **P1-3** | `LOGIN_GUIDE.md` **端口过时**（写 3000/前端 5173，实际 4400），且内容是**作者本人的登录态清单**（「智联已登录」「已真实投递 30 个岗位验证通过」） | 文件正文 | 错误文档 + 个人痕迹随包外发 |
| **P1-4** | README 解压耗时写「3–4 分钟」，实测 **5.1 分钟** | §1.2 | 小，但属可验证的失准 |

### P2 — 体验与整洁度

| # | 问题 | 说明 |
|---|---|---|
| P2-1 | `创建桌面快捷方式.bat` 的 COM 兜底分支**硬编码开发机路径** `%USERPROFILE%\WorkBuddy\2026-09-02-09-33-33\job-apply-agent\` | 对方机器上会生成指向不存在路径的快捷方式 |
| P2-2 | 自用/开发脚本随包分发（`打包.bat`、`pack.ps1`、`apply_boss.bat`、`rerun_liepin.bat`、`start_cdp*.bat`、`wait_*.sh`、`collect_all.sh`） | 根目录 34 个条目，接收方难辨认 |
| P2-3 | `/api/platforms/health` 单次 **12.7s**（15 平台串行探测） | 控制台首屏等待偏长 |
| P2-4 | 双前端并存 | 体积与困惑（此前已记录，未动） |

---

## 4. 已达标的部分（应保持）

- **打包白名单 + fail-closed 断言有效**：`.env`/`data`/`src`/`.git` 确实不在包里；`node_modules` 完整性有反向断言（防历史 `--exclude` 误删 254 文件复发）。
- **自带 Node 运行时**：`node/node.exe` 在包内且被强制断言存在 → 接收方无需安装 Node。方向完全正确。
- **无 `.env` 时优雅降级**：AI 未配置则回退规则匹配 + 模板文案，`ai:false` 如实上报，**软失败不中断投递**。
- **DB 自动创建 + 自动迁移**：首次启动零手工步骤。
- **空状态设计良好**：`/api/jobs`、`/api/stats/trend`、`/api/apply/ab-report` 都返回结构化空态并附说明文案。
- **Chrome 缺失有明确中文报错 + 下载链接**（`setenv.bat`）。
- **冷启动 3.2s、控制台 200/102KB 正常**。

---

## 5. 最小整改清单

### 第一优先（修完才谈得上「下载即用」）

1. **让 `cdp.json` 内置化**。两个方案，推荐后者：
   - A. 把 `data/browser/cdp.json` 放进打包白名单 → 但 `data/` 整体排除是有意设计，会开一个口子；
   - **B.（推荐）在 `connection.ts` / `browser.ts` 加内置默认端口表**，与 `platformHealth.ts` / `browserHealth.ts` 的兜底**收敛为同一份**（现在有 3 套来源，正是本 bug 的温床）。
     顺带把「端口表」抽成单一模块导出，六处同步点收敛为一处。
2. **加 Release 工作流**：`.github/workflows/release.yml` —— 打 tag 时自动跑 `pack.ps1` 并上传 zip 到 Release。同时给包内注入 `version.json`（提交号 + 构建时间），解决 P0-3 的不可追溯。
3. **修 `check-login` 挂起**：给 `unstable_v2_authenticate` 加 `Promise.race` 超时（如 8s），超时即返回 `{isLoggedIn:false, error:'未配置凭据'}`；控制台按钮补 `finally` 兜底恢复。

### 第二优先（首次使用体感）

4. **加首跑自检**：`GET /api/selfcheck` 返回逐项状态（Node✅ / Chrome✅ / 端口表✅ / 简历❌ / 平台登录❌ / AI 未配置·可选），控制台用一张清单渲染「还差什么、点哪里补」。这是把 P0-2/P1-2 一起根治的做法。
5. **修文档**：`LOGIN_GUIDE.md` 端口改 4400、**移除作者私有登录态**（改成通用「如何登录各平台」）；README 首步改为「双击 `start_all.bat`（或先跑 `创建桌面快捷方式.bat`）」；解压时长改「约 5 分钟」。
6. **修 `创建桌面快捷方式.bat` 兜底**：把硬编码路径改为 `%~dp0` 相对定位（该脚本已在 `%PKG%` 上算了 `%~dp0`，兜底分支却退回了绝对路径）。

### 第三优先（整洁）

7. 打包白名单剔除自用脚本（保留 `start_all/start_server/setenv/start_platforms/创建桌面快捷方式` 即可）。
8. `/api/platforms/health` 加并发或缓存，压到 3s 内。

---

## 6. 复现命令（可照抄）

```bash
# 打包（约 4.6 分钟）
powershell -NoProfile -ExecutionPolicy Bypass -File "job-apply-agent/pack.ps1"

# 解压到纯 ASCII 路径（含中文的 MSYS 路径会让 bsdtar 报 could not chdir）
#   D:\_pkgtest_oob 为本次测试目录
& "$env:SystemRoot\System32\tar.exe" -xf "D:\Desktop\job-apply-agent-portable.zip" -C "D:\_pkgtest_oob"

# 以「全新用户 + 无 Playwright 浏览器」状态启动（精确模拟接收方机器）
$env:PORT='4500'; $env:PLAYWRIGHT_BROWSERS_PATH='D:\_pkgtest_oob\_nobrowsers'
cd D:\_pkgtest_oob
.\node\node.exe .\node_modules\tsx\dist\cli.mjs server\index.ts

# 复现 P0-2：应返回「Chromium 浏览器未下载…」
curl -X POST http://127.0.0.1:4500/api/browser/exec -H "Content-Type: application/json" ^
  -d "{\"platform\":\"boss\",\"action\":\"navigate\",\"url\":\"about:blank\"}"

# 复现 P1-1：应挂起 60s 且无响应体
curl -m 60 -o NUL -w "%{http_code} %{time_total}\n" http://127.0.0.1:4500/api/check-login

# 验证 P0-2 的修法：补入端口表后同一条请求应立即 ok:true（无需重启）
mkdir D:\_pkgtest_oob\data\browser
copy "job-apply-agent\data\browser\cdp.json" "D:\_pkgtest_oob\data\browser\cdp.json"
```

> 本机 `%LOCALAPPDATA%\ms-playwright` 已存在（`chromium-1161/1234`），**不设 `PLAYWRIGHT_BROWSERS_PATH` 就测不出 P0-2** —— 这正是它长期未被发现的原因。

---

## 7. 遗留与善后

| 项 | 说明 |
|---|---|
| 桌面 `job-apply-agent-portable.OLD-0155.zip` | 01:55 那个中途快照，已改名留证（454MB），确认无用后可删 |
| 桌面 `job-apply-agent-portable.zip` | **最终包**（454.7MB / 181316 条目），含 `version.json` build stamp `4d55796 dirty`，已通过打包冒烟（§8.5）。⚠️ 因本轮改动尚未提交，`dirty:true` 会显示到下次打 tag 为止 |
| `D:\_pkgtest_oob` | 首次测试的旧包解压目录（约 460MB + 测试用 `data/`），**可删** |
| `_smoke_run.log` / `_smoke_final.log` | 两轮冒烟的原始输出（仓库根，`*.log` 已被 gitignore、且不在打包白名单内，不会外发） |
| `_console_syntax.mjs` / `_console_render_check.mjs` | 本机专用校验脚本（workspace 根，**刻意不进仓库**，避免混入交付包） |
| `browser_watchdog.ts` | 不被任何启动脚本引用，是手工脚本 → **不在一键链路，不构成开箱阻塞** |

---

## 8. 整改实施与验证（2026-09-25 20:xx）

> 本节记录 §5 清单的落地情况。§1–§3 的原始发现**保留不动**，作为历史记录。

### 8.1 清单逐项落地

| # | 项 | 结果 | 落点 |
|---|---|---|---|
| 1 | 端口表内置化（方案 B） | ✅ 已做 | **新建 `server/services/platformPorts.ts`**（唯一真相源：`DEFAULT_CDP_PORTS` 17 项 + `defaultCdpEndpoint()` + `readCdpOverrides()` + `resolveCdpEndpoint()`，优先级 `cdp.json` 覆盖 > 内置默认 > `null`）。`browser.ts` / `connection.ts` / `platformHealth.ts` 三处本地实现全部删除、改调同一函数。同步点由 6 处降为 **3 处**（`types.ts` / `platformPorts.ts` / `console.html`） |
| 2 | Release 工作流 + `version.json` | ✅ 已做 | **新建 `.github/workflows/release.yml`**（`push: tags v*` → verify + test → 准备 `node/node.exe` → `pack.ps1` → `pack_smoke.ps1` → `gh release create`，`permissions: contents: write`）；`pack.ps1` 增加 build stamp（`git rev-parse --short HEAD` + dirty + 时间），写入**包内** `version.json`，并列入 `$must` 断言；`.gitignore` 已忽略该文件 |
| 3 | 修 `check-login` 挂起 | ✅ 已做 | `server/index.ts`：`AUTH_TIMEOUT_MS`（默认 8000，可用 `AUTH_CHECK_TIMEOUT_MS` 覆盖）+ `Promise.race` + `finally { clearTimeout }`；超时返回可读原因而非永久 pending |
| 4 | 首跑自检 `/api/selfcheck` | ✅ 已做 | `server/index.ts` 新增；6 项（runtime / chrome / ports / windows / resume / ai），`status: ok\|todo\|warn`，端口并行 TCP 探活。控制台首页新增「开箱自检」卡片（`#selfCheckCard` / `loadSelfCheck()` / 可重跑） |
| 5 | 修文档 | ✅ 已做 | `LOGIN_GUIDE.md` **完全重写**（端口 4400、六平台地址表、风控提示、「收集到 N>0 才算就绪」判定标准、**移除作者本人登录态**）；README 首步改「双击 `start_all.bat`」+ 提自检面板 + 「先仅预览」，解压时长改约 5 分钟，新增「平台端口无需手工配置」 |
| 6 | 修 `创建桌面快捷方式.bat` 兜底 | ✅ 已做 | 兜底分支硬编码路径 → `%PKG%`（烘焙当前实际路径） |
| 7 | 打包白名单剔除自用脚本 | ✅ 已做 | `pack.ps1` `$dropScripts` 扩到 13 项（含 `pack.ps1` 自身）。实跑包内根脚本只剩：`ensure_chrome.sh` / `setenv.bat` / `start_all.bat` / `start_platforms.bat` / `start_server.bat` / `创建桌面快捷方式.bat` |
| 8 | `/api/platforms/health` 性能 | ⚠️ **部分达成**（见 8.3） | `platformHealth.ts` 新增 `probePlatformHealthCached()`：**只对「全量 + deep」**（即控制台仪表盘那次）走 45s TTL 缓存，**定向 `platforms=` 调用永不缓存**（用户主动复核必须实时），`?refresh=1` 强制刷新；响应新增 `cached` / `ageMs` 如实标注 |

### 8.2 实施过程中**新发现**的两个 bug（原报告未列）

| # | 问题 | 证据 | 修法 |
|---|---|---|---|
| N1 | **控制台 15 张平台卡片恒显「未知」** | `console.html:964` 请求 `/api/platforms/health` 后写 `health[p.id]` —— 把响应当**按键的映射**读，而该接口返回的是 `{deep, summary, platforms:[...]}`（**数组**）；同一文件 `:1183` 就是按 `.platforms.find(p=>p.platform===...)` 正确取的。更糟的是它读 `st.status` / `st.logged`，而 `PlatformHealth` 里根本没有这两个字段，真字段是 `verdict`。⇒ 判定分支**一条都进不去**，卡片永远是灰底「未知」 | 按 `platform` 建映射 + 改用 `verdict` 映射徽标；「接口失败未检测」与「巡检过但判不出」分开显示；`detail`/`action` 挂到 `title` 提示 |
| N2 | `pack.ps1` 剔除清单与自身注释**不一致** | 注释写明「Repack helpers, CLI one-shots, **bash collectors** ... stay in the repo」，但 `$dropScripts` 只含 `.bat` ⇒ `collect_all.sh` / `wait_*.sh` / `offerbiu_auto.sh` / `pack.ps1` 仍在发包 | 清单补齐到 13 项，并把「保留项 + 理由」写进注释（`ensure_chrome.sh` 因 README 脚本表与控制台离线提示仍指向它而**特意保留**） |

> N1 的性质值得记一笔：它是**类型检查、selftest、合约测试、打包冒烟四道门都绿**的情况下静默存在的显示层 bug —— 与 P0-2 同源（响应形状/兜底口径不一致），只是这次坏在 UI 侧。故 `pack_smoke.ps1` 已补一条**响应形状断言**作为回归防线。

### 8.3 关于 §5-8 的诚实结论

**没能压到 3s 以内，也不该假装能。** `deep=1` 的耗时不是「没并发」——`probePlatformHealth` 本来就是 `Promise.all` 并发；12.7s ≈ **最慢那个平台**的链路（导航真实页面 → 等 4.5s 让 SPA 稳定 → 取样判定）。**要 <3s 只能放弃导航**，而导航正是登录态判定准确性的来源（详见该模块顶部注释里的三条铁律）。

缓存解决的是**重复成本**：控制台每次打开/刷新都调它，现在 45s 内第二次起即刻返回。首次仍需约 13s（缓存未命中），这一点在响应里用 `cached` / `ageMs` 如实暴露，不伪装成刚跑过。

### 8.4 验证结果（全部实跑）

| 验证 | 结果 |
|---|---|
| `tsc -b` | ✅ 无输出（通过） |
| `console.html` 内联脚本语法（esbuild 进程内） | ✅ `script #1: OK (59125 chars)` |
| `scripts/selftest.ts` | ✅ **58 / 58** |
| `scripts/contract_tests.ts` | ✅ **248 / 248**（含新增的端口表回归 45 条） |
| `pack.ps1` + `pack_smoke.ps1`（打包 → 全新目录解压 → 包内 node 启动 → 断言） | ✅ 见 8.5 |
| **控制台首页真实渲染**（Playwright headless 打开真实后端，读 DOM） | ✅ 见 8.5.1 |

### 8.5.1 控制台首页真实渲染（N1 的端到端证据）

语法检查与 typecheck 都**证明不了**「页面画得出来」——`console.html` 是内联脚本拼 DOM，`loadDashboard()` 一旦抛错，`#pfGrid` 会先被 `innerHTML=''` 清空、然后一张卡片都画不出来，而页面上其他部分照常。故本轮补了一次真实渲染验证（临时把仓库后端起在 4502，用 Playwright headless 打开首页读 DOM）：

```json
{ "cardCount": 15, "blankBadgeCards": 0,
  "badgeCount": { "已登录": 6, "未登录": 4, "离线": 4, "未知": 1 },
  "samples": [ { "name": "BOSS直聘", "badge": "已登录",
                 "tip": "页面命中已登录特征：消息、简历 · 正常" }, ... ],
  "selfCheckItems": 6, "selfCheckSummary": "全部就绪 ✓",
  "errors": [], "ok": true }
```

**修复前这 15 张卡片的徽标全是「未知」**（N1）；现在是按 `verdict` 出来的真实结论，且 `title` 带上了 `detail · action`。`selfCheck` 卡片 6 项渲染正常、汇总「全部就绪 ✓」，页面零 JS 报错。

> 检查脚本在本机 workspace 根 `_console_render_check.mjs`（**刻意不进仓库**，避免混入交付包）。用法：仓库内 `PORT=4502 HOST=127.0.0.1 ./node/node.exe node_modules/tsx/dist/cli.mjs server/index.ts` 起后端 → `node _console_render_check.mjs`。


### 8.5 打包冒烟实测输出（关键行）

> 最终一次（含 N1 修复与形状断言）的完整输出；打包耗时 306s，比首次的 293s 略增属正常波动。

```
[0/2] build stamp: {"dirty":true,"commit":"4d55796","builtAt":"2026-09-25T20:44:44+08:00"}
[1/2] packaging 21 top-level items ...
      dirs: node, node_modules, public, scripts
      split(minus *.js): server, shared
      scripts: ensure_chrome.sh, setenv.bat, start_all.bat, start_platforms.bat, start_server.bat, 创建桌面快捷方式.bat
[2/2] verifying archive ...
  verified: all required files present, no secrets, no personal data
PACKED: D:\Desktop\job-apply-agent-portable.zip
  zip 454.7 MB | 181316 entries | elapsed 306 s
[3/4] asserting fresh-machine state ...
      required files present, no secrets/personal data, no build artifacts
[4/4] starting the packaged server with the bundled node ...
      platforms/health: 15 items, sample=boss/unknown
SMOKE OK  health={"status":"ok","timestamp":"2026-09-25T12:55:29.161Z","ai":false}  consoleBytes=105015
```

`dirty:true` 如实反映了本轮改动**尚未提交**——这正是 build stamp 存在的意义：接收方据此就能知道拿到的不是某个已发布版本。

其中 `SMOKE OK` 之前依次通过了这些断言（新增的三条是本轮补的）：

1. **P0 端口表兜底** —— 在**无 `data/browser/cdp.json`** 的全新解压目录里，`/api/browser/connections` 的 `boss.endpoint` 必须等于 `http://127.0.0.1:9223`（这一条正是 P0-2 的机械防线）；
2. `/api/selfcheck` 至少返回 5 项；
3. `version.json` 必须在包内；
4. **（新）`/api/platforms/health?deep=0` 必须返回 ≥10 项的平台数组，且每项含 `.platform` 与 `.verdict`** —— N1 的机械防线（`deep=0` 不导航，秒级，不扰动机器上的浏览器窗口）。

### 8.6 尚未完成 / 待你决定

> ⚠️ 本节记录的是**第一轮结束时**的状态，其中三条已在 §9 解决：桌面清理已执行（§9.3）、改动已提交（§9.4）、
> `console:check` 的假失败已修（§9.1 N4，本机 `npm run verify` 恢复可用、替代脚本已删）。

- 桌面两个包与测试目录的清理（见 §7 表）——**等你确认后再删**；
- 本轮改动**尚未提交**（按项目惯例提交需双推 github + gitee，且 pre-push 钩子会跑 typecheck + console:check）；
- 本机 `npm run verify` 的 `console:check` 环节会因**本机沙箱不允许二级 spawn node** 误报内联脚本语法错误（CI 正常）→ 当时用 workspace 根的 `node _console_syntax.mjs` 替代（该脚本已在 §9 删除）。

---

## 9. 第二轮：收口到「软件市场的下载即用」

> 用户指令：「那就进行修改优化达到软件市场的下载即用，该删就删就行了」。本节记录第二轮工作与其后的最终验证。

### 9.1 又修掉三处开箱问题

| # | 问题 | 证据 / 影响 | 修法 |
|---|---|---|---|
| N3 | **自检面板给了死胡同指令** | 简历项原写「请到控制台**「我的档案」**上传」——而左侧导航**根本没有这个入口**（分组只有 总览 / 投递 / 简历 / 进阶），真实位置是 **「简历 → 简历中心」→「上传简历」**（`console.html:444-466`）。首跑用户照这句是找不到地方的 | detail 改为实际菜单路径 + 文件类型与大小限制 |
| N4 | **`console:check` 在受限环境假失败** | 原实现把内联块写成临时 `.mjs` 再 `execFileSync(node --check)`：需要**再起一个 node 子进程**，受限环境在进程创建处就 EBUSY → 门禁把「环境不允许」误报成「内联脚本语法错误」，本机 `npm run verify` 不可用、**pre-push 钩子失效** | 改用 **`vm.Script` 进程内解析**（同一个 V8 解析器，不 spawn、不落盘），并把报错行号**回填成 HTML 真实行号** |
| N5 | **发布渠道只支持 tag，产出可下载的包必须本地推 tag** | `release.yml` 原为 `on: push: tags` | 补 `workflow_dispatch`：版本号输入框，留空自动生成 `v<日期>-<短提交号>`；可直接在 GitHub 页面点一次出 Release |

**N4 的改动做了「牙齿验证」**（否则等于把门禁改瞎）：故意注入 `const __teeth_probe__ = {{ ;` →
退出码 **1**、报出 **HTML 第 1659 行**（与实际注入行**完全一致**）、并打印出错源码行与插入符；
恢复后复跑 OK。同时删除了本机替代脚本 `_console_syntax.mjs` —— **不再需要两份实现**。

### 9.2 首跑指引补齐（N6）

**发现**：`start_all.bat` 只开 **5 个**核心平台窗口（9223–9227），而项目已登记 **15** 个平台；
`start_platforms.bat` 无参时才开另外 9 个。于是新用户双击一次后，**控制台里 10 个平台卡片显示「离线」，且没有任何提示告诉他还缺窗口**。

**修法（只补信息，不改行为）**，在三个地方把「怎么补齐」讲清楚：
1. `start_all.bat` 结尾增加提示：本次开了 5 个核心平台；其余平台二选一 —— 双击 `start_platforms.bat`（默认再开 9 个，`all` 全开）或在控制台对应卡片点「打开窗口」；
2. `/api/selfcheck` 的窗口项：部分打开时追加同样的补齐方式（只报「已打开 5/15」而不说怎么补，等于没给指引）；
3. README「下载 / 安装」表内同步说明。

> **待你决定（行为问题，未擅自改）**：是否让 `start_all.bat` 直接开满**全部可投平台**的窗口？
> 现在是「5 个核心 + 其余手动」的分层设计（另外 9 个用 620x340 布局，一次开 15 个 Chrome 对内存压力不小）。
> 改与不改各有取舍，属产品决策，故本轮只补指引。

### 9.3 清理（用户已授权「该删就删」）

| 目标 | 结果 |
|---|---|
| `D:\Desktop\job-apply-agent-portable.OLD-0155.zip`（454MB 中途快照） | 已删（进回收站；⚠️ **空间未释放，需清空回收站**） |
| `D:\_pkgtest_oob`（1.8 万文件的旧包解压目录） | 已删除 |
| `_console_syntax.mjs`（本机替代脚本，已被 N4 取代） | 已删除 |
| `job-apply-agent/.workbuddy/`（本地会话记忆副本） | 不删，改为**加入 `.gitignore`** 防误入库 |

> 环境护栏：一次删除 **>50 个文件**会被拦（返回 `SAFE_DELETE_BULK_CONFIRM_REQUIRED`），单文件走回收站；整目录删除需显式授权才通过。

### 9.4 提交与「包可追溯」闭合

本地提交 **`20e72ce`**（19 文件，+1186/−173；`.workbuddy/` 未入库）→ 提交后重打包，
包内 `version.json` 由 `{"dirty":true}` 变为：

```json
{"dirty":false,"commit":"20e72ce","builtAt":"2026-09-25T21:22:22+08:00"}
```

⇒ **P0-3「包不可追溯」彻底闭合**：这个 zip 精确对应提交 `20e72ce`，且不含任何未提交改动。
（推送未做 —— 属对外发布动作，留给你决定。）

### 9.5 最终验证

| 验证 | 结果 |
|---|---|
| `tsc -b` | ✅ |
| `npm run verify` 的 `console:check`（新实现） | ✅ 且已通过注入式反例验证仍有牙齿 |
| `selftest` | ✅ **58 / 58** |
| `contract` | ✅ **248 / 248** |
| `.github/workflows/release.yml` YAML 解析 | ✅ 触发器 `push` + `workflow_dispatch`、`permissions.contents=write`、10 步 |
| 启动器链路静态核查 | ✅ `start_all/start_server/setenv/start_platforms` 引用的 `setenv.bat`、`start_server.bat`、`node/node.exe`、`node_modules/tsx/dist/cli.mjs`、`server/index.ts` **全部在打包白名单内**（无「解压后缺文件」） |
| 打包冒烟（提交后、干净树） | ✅ 见 9.6 |

### 9.6 「下载即用」四关的最终状态

| 关 | 状态 | 说明 |
|---|---|---|
| ① 能不能下载 | 🟡 **代码与流程已就绪，但还没有任何 Release 存在** | 两条路：推 `v*` tag，或在 GitHub 的 **Actions → Release → Run workflow** 点一次（版本号可留空）。**这是唯一还需要你动手的一关** |
| ② 解压能不能起 | ✅ | 白名单打包 + fail-closed 断言 + 自带 Node + 原生 SQLite 加载 + `data/` 从零重建 + 启动器路径静态核查 |
| ③ 起来能不能干活 | ✅ | P0 端口表兜底修复 + 冒烟断言在**无 `cdp.json`** 的全新目录里验证 `boss.endpoint=http://127.0.0.1:9223` |
| ④ 顺不顺 | ✅ | 自检面板（含真实菜单路径与补齐指引）+ README「下载/安装」段 + 启动器提示 + 默认只预览的安全默认值 |

**结论**：代码侧已经达到「解压即用、双击可用」；剩下的是**发布这一个外部动作** —— 把 Release 点出来，链接往外一发即可。

