# 待登录平台「登录后一键校准」Runbook（nowcoder / iguopin / yingjiesheng）

> 配套代码：`server/services/apply/platformsChat.ts`（3 平台 config）+ `scripts/probe_chat.ts`（真机探针，gitignored 本地）+ `docs/chat-driver-calibration-checklist.md`（通用校准规范，§2 字段表为准）。
> 一键脚本：`scripts/calibrate_pending.sh`（自动探测后端 / CDP 标签、跑探针、给回填指引）。
> 现状（2026-09-24）：这 3 个平台卡在「**profile 未登录**」，不是代码问题。登录养熟后即可走完校准、置 `calibrated:true` 投产。
> 投产意义：校准完 = 自动回复 + 简历卡片在 **boss / liepin / zhilian + 本 3 平台 = 6 平台** 全部可用；剩下 job51 / chinahr / yupao 三平台为「架构上无 Web IM」，引擎自动跳过（见 `platformsChat.ts` 的 `autoReplySupported:false`）。

---

## 0. 三平台前置条件差异（⚠️ 关键）

| 平台 | CDP 端口 | 浏览器农场标签现状 | 校准前还要做 |
|---|---|---|---|
| **nowcoder** 牛客 | 9237 | ✅ 标签**在农场里**（browserLaunch.json profiles 含 9237） | 仅差：**登录**该 profile 并养熟 |
| **iguopin** 国聘 | 9235 | ❌ 标签**已被剔除出农场**（早前整顿移出，profiles 无 9235） | ① 加回农场标签 → ② 登录 → ③ 校准 |
| **yingjiesheng** 应届生 | 9236 | ❌ 标签**已被剔除出农场**（profiles 无 9236） | ① 加回农场标签 → ② 登录 → ③ 校准 |

> 端口映射真相源：`data/browser/cdp.json`（`iguopin→9235`、`yingjiesheng→9236` 路由**仍在**，只是农场没起对应 Chrome）。
> 农场标签清单真相源：`data/browser/browserLaunch.json` 的 `profiles`（改它**必须重启 watchdog + 后端**，`loadSpecs` 有模块缓存，否则不生效）。

---

## 1. 一键脚本用法

```bash
# 校准单个平台（自动：探后端 → 探 CDP 标签 → 跑探针 --dump → 给回填指引）
bash scripts/calibrate_pending.sh nowcoder
bash scripts/calibrate_pending.sh iguopin
bash scripts/calibrate_pending.sh yingjiesheng

# 一次三个
bash scripts/calibrate_pending.sh all
```

脚本会：
1. `curl /api/ping` 确认后端在跑（不在跑直接给起后端命令）。
2. `curl :<port>/json/version` 确认该平台 CDP 标签在跑。
   - **iguopin / yingjiesheng 标签不在** → 直接打印「加回 browserLaunch.json」的具体步骤（见 §2），不跑探针（跑了也是 NO_LIST）。
3. 标签在 → 跑 `probe_chat.ts <platform> --dump` 打印真实 DOM class 锚点。
4. 打印「人工回填」指引（指向 §3 / §4）。

> 探针需要真实浏览器交互，脚本**不能替你登录 / 替你回填 class**——它把机械步骤串起来，登录和回填是人工的。

---

## 2. iguopin / yingjiesheng 专属：加回农场标签（仅这俩需要）

`data/browser/browserLaunch.json` 当前 `profiles` 末尾是 9237（nowcoder）。在这行**后面加逗号**，补 9235 / 9236 两行：

```json
  "profiles": {
    "9223": "C:/chrome-cdp-profile",
    "9224": "C:/chrome-cdp-profile-liepin",
    "9225": "C:/chrome-cdp-profile-job51",
    "9226": "C:/chrome-cdp-profile-zhilian",
    "9227": "C:/chrome-cdp-profile-official",
    "9230": "C:/chrome-cdp-profile-chinahr",
    "9232": "C:/chrome-cdp-profile-yupao",
    "9233": "C:/chrome-cdp-profile-maimai",
    "9237": "C:/chrome-cdp-profile-nowcoder",
    "9235": "C:/chrome-cdp-profile-iguopin",
    "9236": "C:/chrome-cdp-profile-yingjiesheng"
  }
```

> 路径 `C:/chrome-cdp-profile-iguopin` / `...-yingjiesheng` 不存在会自动新建空 profile（首次启动即干净登录态）。
> 改完**必须重启**：`start_all.bat` 或手动重启 watchdog 进程 + 后端（watchdog 读 `browserLaunch.json` 有模块缓存，`loadSpecs` 不热更）。重启后用 `curl 127.0.0.1:4400/api/browser/health` 确认 9235 / 9236 出现。

---

## 3. 登录养熟（三平台相同，人工）

在对应端口的 Chrome 标签里：
1. 打开该平台首页并**登录**（nowcoder `/im` 独立页、iguopin / yingjiesheng 首页浮层 IM）。
2. 确认**停在 IM 页**且有会话列表（至少 1 条历史会话，证明 cookie 有效、能读消息）。
3. 不要关标签、不要登出。探针靠 `openChat()` 导航 + 点入口，标签需保持在线。

> 若首页不是 IM 页（iguopin / yingjiesheng 是首页浮层 IM），探针会自动按 `entryTextRe` 点入口；若入口文本对不上需在校准回填时补 `entryTextRe`（如 `消息|沟通|聊天|私信|IM`）。nowcoder 已设 `entryTextRe='消息|私信|IM'`。

---

## 4. 跑探针 + 回填字段

```bash
# 脚本已替你跑过；也可手动：
./node/node.exe node_modules/tsx/dist/cli.mjs scripts/probe_chat.ts <platform> --dump
```

读输出里 5 类候选 → 回填 `platformsChat.ts` 的 `<platform>ChatDriver` 的 `cfg({...})`。**重点字段**（对照 checklist §2，按平台 IM 结构取真实 class）：

| 字段 | 从探针哪类取 | 填错后果 |
|---|---|---|
| `listItemSelector` | 会话列表项候选（稳定 class 段） | 读不到会话 → 空跑 |
| `nameSelector` | 列表项内名字元素 class | 会话 key 错乱 / 去重失效 |
| `messageSelector` | 消息气泡候选 class | **读不到消息 → 不回** |
| `textSelector` | 气泡内文本元素 class（可选，缺省 `.text,.txt,.content`） | 读到空/错位文本 |
| `mineClassRe` | 己方气泡 class 含的单词（如 `mine`/`self`/`right`） | 我方消息被当 HR 回 → 自言自语 |
| `hrClassRe` | HR 气泡 class 含的单词（如 `friend`/`left`/`other`）；若无专属 class 用 `hrElse:true` | HR 消息漏读 → 不回 |
| `inputSelector` | 输入框候选 `<tag>`+class（textarea / contenteditable） | 填不进 → 发不出 |
| `sendSelector` | 发送按钮候选 class | 点不到发送 → 发不出 |
| `entryTextRe` | IM 入口文本（浮层类平台，iguopin / yingjiesheng 若未命中才补） | 进不去 IM |
| `calibrated` | 校准完成后置 `true` | 生产前必须 `true` |

> **不变量**：简历卡片「点同意」路径已通用化、不依赖平台 class（`resumeCard.ts`），所以这 3 平台卡片路径基本开箱可用；上面字段是读消息 / 回话 / 发文本的重点。

---

## 5. 置 calibrated + 验证（校准后必做）

1. 在 `cfg({...})` 末尾加 `calibrated: true`（如 `cfg({ platform:'nowcoder', chatUrl:'...', entryTextRe:'...', calibrated: true })`）。
2. **门禁全绿**：
   ```bash
   npm run verify          # tsc -b + console:check，必须全绿
   ./node/node.exe node_modules/tsx/dist/cli.mjs scripts/contract_tests.ts   # 期望 ≥193/193（G10/H7 不该破）
   ```
3. **预览模式真实跑**（不点发送、不回 HR，仅验证读侧）：
   ```
   GET /api/auto-reply/run?platform=<platform>&unreadOnly=0&limit=5
   ```
   省略 `realSend` = 预览。确认日志里 `hr`/`me` 侧分类正确、`resumeRequest` 检测对、未误把己方当 HR。
4. 重跑探针确认 `listItems > 0`、`bubbles` 有内容（证明选择器对齐）。

---

## 6. 进度（校准一个勾一个）

- [x] **zhilian** — `calibrated:true`（2026-09-24，真机通过）
- [ ] **nowcoder** — 待登录校准（标签在农场 9237，只差登录）
- [ ] **iguopin** — 待加回农场(9235)+登录校准
- [ ] **yingjiesheng** — 待加回农场(9236)+登录校准
- （job51 / chinahr / yupao — 架构上无 Web IM，引擎跳过，不在此清单）

> 三个全勾 = 自动回复 + 简历卡片在 boss / liepin / zhilian / nowcoder / iguopin / yingjiesheng **6 平台**全部投产。
