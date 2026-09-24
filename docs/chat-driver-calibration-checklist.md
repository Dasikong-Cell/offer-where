# 逐平台聊天驱动校准 Checklist（auto-reply 7 平台）

> 配套代码：`server/services/apply/platformsChat.ts`（7 平台 config）+ `server/services/apply/genericChatDriver.ts`（通用工厂）+ `scripts/probe_chat.ts`（真机探针）。
> 状态：**zhilian 已真机校准（`calibrated:true`，2026-09-24）**；其余 6 平台仍 `calibrated:false` 启发式基线 —— 校准前引擎不误发（消息侧判定未知则跳过、不回），但也不会真正回复，直到本 checklist 走完。
> ⚠️ 2026-09-24 实机探测结论：7 平台里仅 zhilian 当前具备校准条件（已登录 + 有独立 Web IM）。job51(403 反爬)/chinahr(无消息入口)/yupao(蓝领无 Web IM) 即便已登录也无可用 Web 收件箱；nowcoder/iguopin/yingjiesheng 三个 profile **未登录**，需先登录再校。详见 §6。
> 校准目标：把每个平台 IM 的真实 DOM class 回填到 config 并置 `calibrated:true`，使其能真实读消息 / 回话 / 点简历卡片「同意」。

---

## 0. 前置条件（每平台都一样）

| 项 | 要求 | 验证方式 |
|---|---|---|
| 后端在跑 | `PORT=4400 ./node/node.exe node_modules/tsx/dist/cli.mjs server/index.ts` | `curl 127.0.0.1:4400/api/ping` 返回 ok |
| 浏览器农场在跑 | watchdog 管理的 CDP 端口（boss/liepin/…）已建 | `curl 127.0.0.1:4400/api/browser/health` |
| 该平台 CDP 标签已登录「养熟」 | 对应平台的浏览器标签**已登录**、有会话列表、cookie 未过期 | 探针 `listItems` 数量 ≥ 1 |
| 一次只校一个平台 | 避免标签互相干扰 | —— |

> ⚠️ 若浏览器农场没起 / 该平台标签未登录：探针会 `✗ 浏览器执行失败` 或 `NO_LIST`，属预期，不是代码 bug。先养好标签再校。

---

## 1. 校准通用流程（每平台 6 步，必走）

1. **起标签**：确保该平台 CDP 标签已登录、停留在其 IM 页（或首页，工厂会按 `entryTextRe` 点入口）。
2. **跑探针**：`tsx scripts/probe_chat.ts <platform>`（看消息气泡加 `--dump`，全探用 `all`）。
   - 例：`tsx scripts/probe_chat.ts zhilian --dump`
3. **读输出**：关注 5 类候选 → 会话列表项 / 消息气泡 / 输入框 / 发送按钮 / 简历卡片（每类给出真实 `cls` + 样本文本）。
4. **回填** `platformsChat.ts` 对应 config 字段（见 §2 字段→判据映射）。
5. **置 `calibrated: true`**（config 里 `...p` 覆盖，加 `calibrated: true`）。
6. **验证**：
   - 重跑探针 → `listItems` 数量应 > 0、`bubbles` 有内容（证明 list/message 选择器对齐）。
   - `tsx scripts/contract_tests.ts` 仍 **170/170**（G10 校验 7 驱动接通用实现，不该破）。
   - 对该平台做一次**预览模式**真实跑（`GET /api/auto-reply/run?platform=<p>&unreadOnly=0&limit=5`，**不带 `realSend`**），确认读到的 `hr`/`me` 侧正确、未误把己方消息当 HR。

---

## 2. 选择器字段 → 判据映射（回填时对照）

| config 字段 | 控制哪个方法 | 怎么从探针输出取 | 填错后果 |
|---|---|---|---|
| `listItemSelector` | `listConversations` / `openConversation` | 会话列表项候选里的 `cls`（取稳定那一段，如 `im-conversation-item`） | 读不到会话 → 引擎空跑 |
| `nameSelector` | `listConversations`（名字） | 列表项内名字元素的 `cls` | 会话 key 错乱 / 去重失效 |
| `companySelector` | `listConversations`（公司） | 列表项内公司元素的 `cls`（可选） | 仅影响展示，可空 |
| `lastMsgSelector` | `listConversations`（末条） | 列表项内末条消息 `cls`（可选，缺省回退 nameSelector） | 展示错位，可空 |
| `unreadSelector` | `listConversations`（未读） | 未读红点/徽标元素 `cls`（可选） | 影响「只回未读」过滤，可空 |
| `messageSelector` | `readConversation` / `openConversation` 轮询 | 消息气泡候选 `cls` | **读不到消息 → 不回** |
| `mineClassRe` | `readConversation`（我方） | 己方气泡 class 含的单词（如 `mine`/`self`/`right`） | 我方消息被当 HR 回 → 自言自语 |
| `hrClassRe` | `readConversation`（HR） | HR 气泡 class 含的单词（如 `friend`/`left`/`other`） | HR 消息漏读 → 不回 |
| `textSelector` | `readConversation`（文本） | 气泡内文本元素 `cls`（可选，缺省 `.text,.txt,.content`） | 读到空/错位文本 |
| `systemSelector` | `readConversation`（系统卡） | 系统推送卡容器 `cls`（可选） | 把推送卡当 HR 说话 |
| `inputSelector` | `sendText` | 输入框候选 `<tag>` + `cls`（textarea / contenteditable） | 填不进 → 发不出 |
| `sendSelector` | `sendText` | 发送按钮候选 `cls` | 点不到发送 → 发不出 |
| `sendBtnTextRe` | `sendText`（按钮文本正则） | 按钮文本（缺省 `/发送|Send/`） | 误点其它按钮 |
| `resumeToolbarSelector` | `sendResume`（工具栏兜底） | 工具栏「简历/附件」元素 `cls`（可选） | 无卡片纯文本简历请求发不出（卡片路径不受影响） |
| `entrySelector` | `openChat`（IM 入口，有稳定 class 时） | 入口元素 `cls`（可选，优先于 entryTextRe） | 进不去 IM |
| `entryTextRe` | `openChat`（IM 入口，按文本点） | 入口文本（如 `消息|沟通|聊天|私信|IM`） | 进不去 IM（浮层类 IM 常见） |
| `calibrated` | 全部 | 校准完成后置 `true` | 生产前必须 `true` |

> 关键不变量（来自 `resumeCard.ts`）：`resumeRequest` 检测与「点卡片同意」**已通用化、不依赖平台 class**，所以简历卡片路径基本开箱可用；其余 7 个字段是按平台 IM 结构校准的重点。

---

## 3. 逐平台表

| 平台 | chatUrl | IM 形态 | 重点校准字段 | 备注 / 坑 |
|---|---|---|---|---|
| **zhilian** 智联 ✅已校准 | `https://i.zhaopin.com/im` | **独立 IM 页**（首页带 refcode 跳转） | 已回填：`listItemSelector=.im-session-item`、`nameSelector=.im-session-item__name`、`messageSelector=.im-message__bubble`、`textSelector=.im-msg-text`、`mineClassRe=im-message__bubble--me`、`hrElse=true`、`inputSelector=textarea.im-sender__input`、`sendSelector=.im-sender__send-btn` | **2026-09-24 真机验证通过**：抽出 20 会话、readConversation 正确分类 me/hr；HR 气泡无专属 class，靠 `hrElse` 判定。已 `calibrated:true` |
| **job51** 前程无忧 | `https://www.51job.com/` | 首页**浮层** IM | 同上 | 51job 有滑块风控（采集时已知），校准时人工过滑块、勿并发 |
| **nowcoder** 牛客 | `https://www.nowcoder.com/im` | **独立页** `/im` | `entryTextRe`（消息/私信/IM，已设）、`listItemSelector`、`messageSelector` | 独立页，无需点浮层入口；消息页结构较标准 |
| **iguopin** 国聘 | `https://www.iguopin.com/` | 首页**浮层** IM | 同 zhilian | 采集走 API，IM 选择器需真机取 |
| **yupao** 鱼泡 | `https://www.yupao.com/` | 首页**浮层** IM（蓝领） | 同 zhilian | 蓝领平台，Web IM 结构可能偏简单；注意过滤非技术岗 |
| **chinahr** 中华英才 | `https://www.chinahr.com/` | 首页**浮层** IM | 同 zhilian | 老牌站点，class 命名可能偏传统 |
| **yingjiesheng** 应届生 | `https://www.yingjiesheng.com/` | 首页**浮层** IM | 同 zhilian | 校招向，HR 话术多为「简历」「附件」，卡片路径收益高 |

> **offerbiu 不在本表**：其 HR 沟通走**邮件**通道，由 `offerbiu-email-direct-apply` 处理，本自动回复引擎故意不登记（探针也探不到它）。

---

## 4. 验证与门禁（校准后必做）

```bash
# 1) 探针复检：listItems > 0、bubbles 有内容
tsx scripts/probe_chat.ts <platform> --dump

# 2) 合约测试全绿（不该破 G10）
tsx scripts/contract_tests.ts        # 期望 170/170

# 3) 预览模式真实跑（不点发送、不回 HR，仅验证读侧）
#    GET /api/auto-reply/run?platform=<platform>&unreadOnly=0&limit=5
#    （省略 realSend = 预览；确认日志里 hr/me 侧正确、resumeRequest 检测对）

# 4) 单平台发 resume 预览（确认工具栏兜底路径，仅当该平台无卡片纯文本简历请求时用到）
#    /api/auto-reply/run?platform=<platform>&realSend=0 观察 send-resume 事件
```

---

## 5. 常见坑（对照排查）

- **探针 `listItems` / `bubbles` 为空** → 多半是「IM 入口没打开 / 标签未登录」，不是命名偏离。`probe_chat.ts` 已增强：① DUMP 用**关键词广撒网**扫描（IM 词 `conversation|chat|contact|session|dialog|conv|message|msg|bubble|talk|friend|peer` + 条目词 `item|row|list` 双命中），覆盖 `conv-item`/`chat-list-item`/`im-conv-row` 等非标准命名；② 探针**复用生产 `openChat()`** 先导航+点 IM 入口再 dump（浮层类平台首页直接 dump 是空的）。所以现在 list 为空基本等于「落点没到 IM」——先确认该平台 CDP 标签已登录、IM 入口文本对得上 `entryTextRe`，再重跑。仍为空才在开发者工具 Elements 面板手动取真实 class 回填。
- **`mineClassRe` / `hrClassRe` 都没命中** → `readConversation` 走「无法判定→跳过」分支，该消息不回（安全但漏回）。必须给两个平台各自的 class 单词，至少让一侧命中。
- **`entryTextRe` 不匹配** → `openChat` 点不到浮层入口，列表永远 `NO_LIST`。用探针确认入口真实文本（有的站叫「消息」有的叫「沟通」有的叫「IM」），改 `entryTextRe`。
- **`sendSelector` + `sendBtnTextRe` 双重不匹配** → `sendText` 重试 3 次仍 `NO_BTN` → 发不出。优先用 `sendSelector`（class），文本正则兜底。
- **`messageSelector` 过宽** → 把系统提示/时间分割线也当消息读，可能误回。用 `systemSelector` 排除，或收窄 `messageSelector`。
- **卡片「同意」误点「是否接受面试」类卡** → `detectResumeRequestClause` 已要求「含简历类词 AND 含确认/请求类词」双命中，正常不会；但若某平台把「接受面试」卡也命名为「简历」，需在该平台 `systemSelector` 排除。

---

## 6. 进度记录（校准一个勾一个）

- [x] **zhilian** — `calibrated:true` 日期：**2026-09-24**（真机验证通过：20 会话 / me+hr 分类正确）
- [ ] **job51** — 阻塞：首页已登录，但直跳 `i.51job.com` 个人中心 **403 反爬**，顶栏无「消息」入口；51job 求职侧 IM 在「我的投递→聊一聊」深链，无独立收件箱 URL。→ 需人工养熟并定位真实聊天 URL 再校。`calibrated:false`
- [ ] **nowcoder** — 阻塞：profile **未登录**（`/im` 返回 404「页面找不到了」）。→ 先登录牛客再跑探针。`calibrated:false`
- [ ] **iguopin** — 阻塞：profile **未登录**（页显「登录/注册」）。仅见 `/chat/?a=kefu`（客服）非 HR 聊天。→ 先登录国聘再跑探针。`calibrated:false`
- [ ] **yupao** — 阻塞：profile 已登录，但全站**无「消息/沟通」入口**（鱼泡为蓝领直聘，HR 沟通走 APP 而非 Web IM）。→ 建议本平台暂不启用自动回复（保持 `calibrated:false`，引擎不误发）。`calibrated:false`
- [ ] **chinahr** — 阻塞：profile 已登录，点开「杨欣宇」下拉仅 我的简历/退出，**全站无「消息」入口**（新华英才 58 系求职侧无独立 Web HR 收件箱）。→ 确认是否真有 Web IM，否则同鱼泡处理。`calibrated:false`
- [ ] **yingjiesheng** — 阻塞：profile **未登录**（页显「登录/注册」）。→ 先登录应届生再跑探针。`calibrated:false`

> 说明：7 平台里当前仅 zhilian 具备校准条件。其余 6 个的阻塞分两类：① **未登录**（nowcoder/iguopin/yingjiesheng，3 个）——用户先在各 profile 登录即可解除；② **已登录但无可用 Web IM**（job51 403 / chinahr 无入口 / yupao 蓝领无 Web IM，3 个）——需确认平台是否提供 Web 侧 HR 聊天，否则该平台自动回复维持关闭。
> 全部勾完 = 9 平台（boss/liepin + 7）自动回复 + 简历卡片全部投产。
