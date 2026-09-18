# 职得鸭（GaGaJob）全功能实现深度解析

> **取证对象**：`D:\新建文件夹\gagajob\`（安装体）+ `C:\Users\吉学静\AppData\Roaming\gagajob\`（用户数据）+ `product.gagajob.cn`（Web 端前端包）
> **方法**：解包 `resources/app.asar`（52MB）→ 全量源码静态分析（32 个 JS、16,377 行）+ 前端 bundle 反查（2.27MB）+ CDP/JS 沙箱动态观察
> **产物**：`zhideya_analysis/app/`（完整解包源码）、`zhideya_analysis/asar_tool.mjs`（自研 asar 解析器）
> **日期**：2026-09-19

---

## 0. ⚠️ 对上一版取证结论的重要更正

上一版 `ZHIDEYA_FORENSICS.md` 只看了 `AppData\Roaming\gagajob\`（用户数据目录，里面确实"只有 token、没有平台凭证"），据此得出：

> ❌ **上一版结论（错误）**：「职得鸭 = 云端 SaaS + 轻壳；搜岗/匹配/代投全部运行在厂商服务器；用户不登录平台账号；验证码由服务端消化」

本次解包**安装体**后推翻了它。真实情况是：

> ✅ **真实架构**：**云端 AI 编排 + 本地真实 Chrome 自动化**的混合架构。
> 职得鸭在**用户自己电脑上启动真实 Google Chrome**（`headless:false`，**窗口可见**），
> 用 Puppeteer 打开 BOSS/猎聘/51job/智联，**用户必须在这个窗口里自己登录平台账号**，
> 验证码/滑块也由**用户在这个可见窗口里手动过**。

**铁证**（全部来自解包源码）：

| 证据 | 位置 |
|---|---|
| 依赖 `puppeteer-real-browser` / `rebrowser-puppeteer-core` / `chrome-finder` | `app/package.json` |
| `connect({ headless: false, executablePath: findChrome(), customConfig:{ userDataDir } })` | 所有 `puppeteer/*.js` |
| 日志字符串「**检测到未登录，请在浏览器中完成登录操作**」 | `job51Hello.js:227`、`liepinHello.js:54` |
| 前端明确提示「**请确保已经安装了谷歌浏览器**，且职得鸭为客户端最新版，还需保证账号有足够金币以及在「个人中心」已上传简历和配置岗位要求」 | `product.gagajob.cn` bundle |
| FAQ 里有「**没有谷歌浏览器怎么办？**」 | 同上 |

**结论**：职得鸭与我们的 `job-apply-agent` **本质是同一条技术路线**（本地浏览器自动化平台操作）。
你之前问的「为什么职得鸭不像我们总弹验证」——真实答案不是"它没有风控"，
而是下面 §7 讲的三件事叠加：**真实 Chrome（非 Chromium）+ 用 `rebrowser` 补丁消除 CDP 泄漏 + 持久化 profile 长期养熟**。
它的验证码也不是免的，只是**首次登录/触发风控时同样要用户手动过**——只是窗口标题是 Chrome，
你没意识到那个窗口是职得鸭开的。

---

## 1. 系统架构全景

```
┌──────────────────────────────────────────────────────────────┐
│  云端 SaaS（厂商服务器，世纪云端 century-cloud）                 │
│  api.century-cloud.com/ai-job                                  │
│   · LLM 编排：判定是否打招呼 / 写求职信 / 复聊 / 按JD生成简历    │
│   · 账号体系、金币计费、套餐、优惠券、邀请返佣、代理分销          │
│   · 简历存储与优化（PDF 导出）、面试鸭攻略、面试题库（流式）      │
│   · 职位记录库、平台统计、错误日志回收                          │
└────────────────────────────┬─────────────────────────────────┘
                             │ HTTPS + Bearer JWT
                  自动更新源：public.century-cloud.com/aijob/
┌────────────────────────────┴─────────────────────────────────┐
│  Electron 桌面壳（职得鸭.exe，version 1.0.39）                  │
│  main.js = 纯 IPC 路由器（20KB，零业务逻辑）                     │
│  win.loadURL('https://product.gagajob.cn')  ← UI 全是远程网页   │
│  preload.cjs → contextBridge 暴露 ipcRenderer（薄）             │
│  唯一本地持久化：userData/token.txt（JWT）                      │
│  ── IPC 契约：open-bossAuto / open-liepinLetter / ... ──        │
└────────────────────────────┬─────────────────────────────────┘
                             │
┌────────────────────────────┴─────────────────────────────────┐
│  本地 Puppeteer 自动化层（32 个 JS、16,377 行、含 node_modules）│
│  puppeteer/bossAuto.js(1268行)  liepinAuto.js(1463行) ...      │
│   · findChrome() → 本机真实 Google Chrome                       │
│   · puppeteer-real-browser.connect() 反检测启动                 │
│   · 每平台独立 userDataDir（登录态持久化）                       │
│   · 拟人输入 typeSlowly（100–150ms/字随机延迟）                  │
│   · PageHelper 统一容错 / TimeManager 时间段调度                │
└────────────────────────────┬─────────────────────────────────┘
                             │
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
   BOSS直聘(zhipin.com)   猎聘(liepin.com)   51job / 智联招聘
```

**关键设计**：Electron 壳里**没有一行业务代码**，UI 是远程网页，业务自动化和 AI 全在别处。
好处是前端改动免发版、风控策略可云端热更；坏处是一旦断网整个客户端变空壳。

---

## 2. 技术栈清单（实测版本）

| 依赖 | 版本 | 用途 |
|---|---|---|
| Electron | — | 桌面壳（181MB 主程序） |
| puppeteer-real-browser | 1.4.4 | 反检测启动器（核心） |
| rebrowser-puppeteer-core | 23.10.3 | **打了 CDP 泄漏补丁的 puppeteer-core** |
| puppeteer-core | 24.37.5 | 直接依赖 |
| chrome-launcher | 1.2.1 | 启动本机真实 Chrome |
| ghost-cursor | 1.4.2 | 拟人鼠标轨迹（**实际未使用**） |
| puppeteer-extra | 3.3.6 | 插件化（仅 `demo.js` 用） |
| puppeteer-extra-plugin-stealth | 2.11.2 | 隐身插件（**仅 `demo.js` 用**） |
| chrome-finder | 1.0.7 | 定位本机 Chrome 路径 |
| axios | 1.11.0 | 调自家云端 API |
| crypto-js | 4.2.0 | MD5（用聊天对象名做 group_id） |
| dayjs | 1.11.19 | 时间格式化 |
| canvas | 3.2.0 | 随包分发但**未发现直接调用** |
| electron-updater | 6.8.3 | 自动更新（COS/自建源） |

---

## 3. 完整功能矩阵

前端源码里功能是**按平台硬编码**的（`product.gagajob.cn` bundle）：

```js
const ne = platformId === '51job'
  ? [{label:'AI打招呼', type:'type1'}, {label:'关键词打招呼', type:'type5'}]
  : platformId === 'zhilian'
  ? [{label:'AI打招呼', type:'type1'}, {label:'关键词打招呼', type:'type5'}]
  : /* boss / liepin 相同 */
    [{label:'AI打招呼',     type:'type1'},
     {label:'AI写求职信',   type:'type2'},
     {label:'AI复聊',       type:'type3'},
     {label:'AI自动化',     type:'type4'},
     {label:'关键词打招呼', type:'type5'}];
```

| 功能（type 码） | BOSS | 猎聘 | 51job | 智联 | 本地脚本 |
|---|:--:|:--:|:--:|:--:|---|
| **AI打招呼** (type1) | ✅ | ✅ | ✅ | ✅ | `{p}Hello.js` |
| **AI写求职信** (type2) | ✅ | ✅ | ❌ | ❌ | `bossLetter.js` / `liepinLetter.js` |
| **AI复聊** (type3) | ✅ | ✅ | ❌ | ❌ | `bossAgain.js` / `liepinAgain.js` |
| **AI自动化**（一条龙）(type4) | ✅ | ✅ | ❌ | ❌ | `bossAuto.js` / `liepinAuto.js` |
| **关键词打招呼**（海投）(type5) | ✅ | ✅ | ✅ | ✅ | `{p}Keyword.js` |
| **公司背调/搜索** | ✅ | ✅ | ✅ | ✅ | `{p}Search.js` |
| **交换联系方式**（发简历/换微信/换电话） | ❌ | ✅ | ❌ | ❌ | `liepinAuto.js` 内 |

> 注意：前端注册了 `close-job51Auto`/`close-zhilianAuto` 等监听，但 `main.js` **并未实现** `open-job51Auto`，
> 属前端防御性冗余。另：`demo.js` 也挂了 IPC（`open-demo`），是**调试遗留**（打开 DeepSeek 网页上传简历）。

### 渲染层路由（Web 端页面）

```
/index          首页（平台程序卡片 + 功能开关 + 运行时间段配置）
/job-records    职位记录（投递漏斗 + 状态 + AI 跳过原因）★
/recharge       充值中心（金币/套餐/微信支付）
/token-bill     token 账单（含消费图表 /api/bill/chartData）
/coupon         优惠券
/invite         邀请返佣
/proxy          代理管理（分销佣金 + 银行卡提现）
/account        个人中心（简历上传/优化、岗位要求、简历类型切换）
/feedback       意见反馈
/faq            常见问题（含"没有谷歌浏览器怎么办"）
/logs           运行日志（可清空）
/download       客户端下载（Windows / 安卓 APK）
```

---

## 4. 逐功能实现剖析

### 4.1 简历体系

| 能力 | 实现 |
|---|---|
| 上传 | `POST /api/file/upload`（前端支持 PDF；"上传后将展示优化后的简历在下方"） |
| AI 优化 | 上传后云端优化，产出「优化后的简历」 |
| **双简历切换** | 本地 `user-config.json` 存 `resumeType: 'original' \| 'optimized'`，**每个 AI 接口都带上这个参数**，让云端按用户选择用不同底稿 |
| 对话式改简历 | `POST /api/ai/updateResumeByChat`（UI："输入您的回答，或粘贴简历内容…"）；另有 `POST /api/ai/checkResumeUpdate` 由 AI 主动判定"是否需要更新简历（${reason}）" |
| **PDF 导出** | `GET /api/resume/export`（`responseType:'blob'`，支持 `borderColor`/`lineColor` 参数）→ **PDF 由服务端生成** |
| 移动端 | 安卓 APK + "移动端简历管理 / 随时随地查看投递进度" |

### 4.2 「一岗一简历」的真实实现 ★ 最有价值的一条

我们此前的理解是"按 JD 生成定制简历"。**实际做法比想象的更取巧**（`bossAuto.js:771`）：

```js
const generateAndSendResume = async (page, jd, jobTitle) => {
  // ① 云端按 JD 生成简历 HTML
  const resumeRes = await letterResumeApi(jd, 'boss');   // POST /api/ai/letterResume
  const html = resumeRes.data;

  // ② 开一个临时页渲染这份 HTML
  const resumePage = await browser.newPage();
  await resumePage.setViewport({ width: 1000, height: 800 });
  await resumePage.setContent(html, { waitUntil: 'networkidle0' });

  // ③ 直接对 <body> 截图成 PNG（不是 PDF！）
  const filePath = path.resolve(`./resume_${Date.now()}.png`);
  await (await resumePage.$('body')).screenshot({ path: filePath, type: 'png' });
  await resumePage.close();

  // ④ 当作"聊天图片"发给 HR
  const fileInput = await page.$('div[aria-label="发送图片"] input[type="file"]');
  await fileInput.uploadFile(filePath);

  // ⑤ 立刻删掉临时文件
  fs.unlinkSync(filePath);
};
```

**这个设计的三个妙处**：
1. **绕开平台简历附件系统** —— 完全不用碰 BOSS 的"在线简历/附件简历"设置，没有格式限制、不占用"简历次数"
2. **一岗一简历零成本落地** —— 只要能在聊天里发图，就能发任意定制简历，四个平台通用一套代码
3. **不落盘留痕** —— 截图用完即删，本地不留求职简历文件

**代价**：HR 只收到一张图（不能被 ATS 解析、不能搜索文本）。所以**只对"人看的聊天场景"有效**。
文案印证：前端提示「**当 AI 给 HR 发求职信时就会自动附上适配该岗位的简历**」——即"求职信文字 + 定制简历图"一起发。

### 4.3 AI 打招呼（type1）

```
打开职位列表 → 逐个点开卡片 → 提取 JD → 调 checkAutoChatApi(jd, platform)
   → 云端返回 "是" / "否" / "否-已写过" / "否-HR已回复"（+ 原因）
   → "是" 则点按钮发起沟通；否则存 skipped 记录并写明原因
```

平台差异（同一个 AI 判定接口，三种落地动作）：

| 平台 | 判定入参 | 落地动作 | 选择器 |
|---|---|---|---|
| BOSS | `jd`（HTML 序列化） | 点「继续沟通」→ 关弹窗 | `.op-btn-chat` → `.cancel-btn` |
| 猎聘 | `jd` | 点沟通按钮 | `.job-apply-content` 区域 |
| 51job | `jd` | 点「申请职位」 | `#app_ck`（先校验按钮文案 == "申请职位"） |
| 智联 | `jobName + jd`（**无分隔符拼接**） | 点「立即投递」 | 遍历 `button.a-button` 按文案匹配 + 全局兜底 |

> 智联那个字符串拼接缺分隔符，是把两个字段直接粘一起送 AI —— 属于实现瑕疵，会影响判定准确率。

**JD 提取技巧**：递归序列化 DOM 为**带标签的字符串**（先 `remove()` 掉所有 `<svg>`），保留层级结构：

```js
function serializeClean(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const tag = node.tagName.toLowerCase();
  const children = Array.from(node.childNodes).map(serializeClean).join('');
  return `<${tag}>${children}</${tag}>`;
}
```
比 `innerText` 保留了"这段是要求/福利/描述"的结构信息，比 `innerHTML` 干净（剥掉了图标噪声）。**这点很值得抄。**

### 4.4 AI 写求职信（type2）

两种模式：

| 模式 | 流程 | 计费 |
|---|---|---|
| **AI 生成** | 取 `group_id`(=MD5(HR/聊天名)) + 聊天记录 + JD → `POST /api/ai/letter` → 键入 `.chat-input` → 点 `.btn-send` | 消耗金币 |
| **自定义模板** | 本地加载 `GET /api/letter-template/get` → 直接用 | **不消耗金币**（前端明说） |

自定义模板支持变量：`{职位名称}`、`{公司名称}`。

**三重去重/护栏**（比我们更严）：
1. `GET /api/letter/check?group_id=` —— 该 HR 是否已写过（服务端）
2. AI 返回 `"否-已写过"` —— 兜底
3. AI 返回 `"否-HR已回复"` —— **HR 已回复就不打扰**（这条很聪明，避免在真人对话中插播模板信）
4. 每次写之前先把聊天记录也喂给 AI，让它判断 HR 是否已拒绝

**输入拟人化**：`typeSlowly` 逐字符键入，每字延迟 **100–150ms 随机**。

### 4.5 AI 复聊（type3）

- 打开 `/web/geek/chat`（BOSS）
- `getList()` 抓聊天列表，用 `isTodayChat()`（**时间文本含 `:` 即今天**）区分今日/历史
- 历史不够时**向下滑动加载更多**，直到拿到目标条数
- 调 `POST /api/ai/again`（group_id + chat_history + jd + platform）生成回复
- 猎聘额外支持 **交换联系方式状态机**（见 4.9）

### 4.6 关键词打招呼 / 海投（type5）

```
用户配置关键词（"关键词间用逗号或空格分隔"，已保存 N 个）
→ 逐个关键词走搜索 → 打开职位 → AI 判定 → 打招呼
```
是**唯一"用户显式表达意图"的通道**，与 AI 自主捞岗（type4）互补。

### 4.7 AI 自动化（type4）—— 一条龙编排 ★

`bossAuto.js` 的主线（`bossAuto()` → `hello()` → `letter()` → `again()`）：

```
启动真实 Chrome → 打开 zhipin.com
→ login():  轮询 a[ka="header-message"]（最多 3 分钟，每 3s 一次）
            找不到就点 a[ka="header-login"] → 让用户手动登录
            读取 .nav-chat-num 未读数上报
→ 等待 30 秒（缓冲/避险）
→ hello():  目标数 = getRandomInt(10, 20)  ← 随机化，规避固定频率特征
            逐个职位：跳过 .is-seen → 点卡片 → 取 JD(HTML) 
               → 额外点 .more-job-btn 开新标签拿**完整工商公司名**（.business-info-box .company-name）
                 ⚠️ 拿完立即 newPage.close()  ← 标签页卫生，正是我们昨天修的同类问题
               → 存 viewed 记录 → AI 判定 → 打招呼/跳过 → 存 applied/skipped
            达到目标数 → 跳转聊天页 → letter()
→ letter(): 目标数 = getRandomInt(10, 20)
            逐个 HR：点开 → 点 .position-name 开新标签取 JD → **finally 里立即关标签**
               → 写求职信（AI 或自定义）→ 键入 → 发送
               → 若 generateResume：再走 4.2 发定制简历图
            → again()
→ again():  复聊（含滑动加载历史）
```

**每个环节都查余额**：任一 AI 接口返回 `code===501`（token 余额不足）→ **立即整体停机**（`closeBossAuto('insufficient')`），
前端弹「Token余额不足，自动化任务已停止。请充值后继续使用。」——**计费即断路器**。

**时间片调度**（我们没有的能力）：`TimeManager` 支持配置**多个运行时间段**
（UI：`[{id:'1', startTime, endTime}]`，可加多段），
未到时间就分段休眠等待、到点自动关浏览器、并要求"时间段不能只选开始或结束"。
设计上支持**中断续跑**（已完成的时间段 `shift()` 掉，下次启动继续剩余段）。

### 4.8 公司背调（Search）

**营销名"AI公司背调"与实际实现有落差** —— 代码里它其实是**人工浏览辅助**：

```
打开平台搜索页 → 检查登录 → 把公司名输入 .input-wrap input.input 并搜索
→ 点 .count-job（"在招职位"）→ 在 input[placeholder*="查找职位"] 输入职位名 → 回车
→ 找到目标岗位点开 → 汇报 updateJobRecordSearchedContactedApi(recordId, true)
```
即"**帮你在平台里把这个岗位的页面调出来，你自己看**"。真正的 AI 背调/面经在云端 Web UI（另有面试模块）。
此功能价值在于**人机协同**：机器负责定位与状态回写，人负责判断。

### 4.9 猎聘专有：交换联系方式状态机 ★

`liepinAuto.js:989 handleExchangeActions()` —— 用户勾选「主动点击发简历 / 换微信 / 换电话」：

| 配置值 | 按钮文案 | 选择器 |
|---|---|---|
| `sendResume` | 发简历 | `.action-resume` |
| `changePhone` | 交换手机号 | `.action-phone` |
| `changeWechat` | 交换微信号 | `.action-wechat` |

**三态处理**（这块做得很细）：
1. `im-ui-action-button-disabled` → 「已在索要中」**跳过**（不重复点）
2. `.ant-im-badge` 存在 → 「对方已发起交换」→ **点同意**
3. 正常 → 直接点
4. 不可见先 `scrollIntoView` 再点

UI 文案印证：「在复聊/求职信后主动发送简历给对方」「在复聊后主动点击交换微信号」「已设置不进行交换」。

### 4.10 面试 / 面试鸭攻略

- `POST /api/ai/question` —— **流式**（`fetch` + `AbortController` 可中断），入参 `{content, isFirst}`，实现多轮追问
- 「面试鸭攻略」可**重新生成**；有「获取面试建议」「面试报告数量」
- FAQ 里出现"面试鸭"独立品牌词，属**同厂商另一产品线**（与 `zhida.century-cloud.com` 同族）

### 4.11 职位记录与统计

**职位记录**（`utils/jobRecordCollector.js`，1200+ 行）——最接近我们「漏斗」的部分：

采集字段（每平台独立 selector 表）：
```
title, salary, city, district, experience, education, skills, benefits, description,
company, company_size, industry, financing, hr_name, hr_position,
platform, platform_job_id, job_url        ← 比我们多 hr_name/hr_position/company_size/financing
```
状态机：`viewed → applied / skipped(带 skip_reason) / 已打招呼 / 已复聊 / 已投递`
（注意：BOSS 的采集器里 `info.salary = '暂无'` 硬编码——**平台薪资是字体加密的，他们直接放弃**，和我们遇到的 PUA 加密同一问题，处理方式更干脆：不抓。）

**统计上报** `POST /api/stats/update`：`{platform, jd_viewed, communication_initiated, letters_sent, unread_messages}`，
**每次操作立即 +1 落库**（`recordJDViewed()` 等），不是批量提交 —— 崩溃不丢统计。
未读消息数从 `.nav-chat-num` 读取并单独上报，支撑「BOSS直聘有 N 条未读消息待处理」。

### 4.12 计费体系

| 项 | 实现 |
|---|---|
| 货币 | **金币**（`1 元 = N 金币`）+ **token** 两种额度并存 |
| 充值 | 微信支付：`/api/wechatpay/createTokenQrcode` + `/queryOrder`（前端有"二维码已过期，请点击刷新"） |
| 套餐 | VIP 有效期（`token_expire_time`、`daysLeft`），套餐福利 |
| 新用户 | `POST /api/bonus/claimNewUserBonus`（"50万金币"） |
| 优惠券 | create / redeem / validate / usageStatus |
| 余额 | "充值tokens金额最低为1元"、"充值token输入金额不能超过账户余额" |
| 断电机制 | 任一 AI 调用返回 501 → 全流程停机 |

### 4.13 分销体系（"代理鸭"）

⚠️ 澄清：`/api/proxy/*` **不是网络代理**，是**代理分销（affiliate）**。

- `/api/invite/info`、`/api/invite/list`、`/api/invite/userRecords`
- 奖励规则（原文）：「好友每次充值后，平台会按其充值档位的 **20%** 金额存入您的账号，可提现或充值金币」；
  「好友充值 499 元，您可获得 99.8 元奖励」；另有**套餐有效期的 20% 时长奖励**，不限次
- `/api/proxy/use` 入参含 `name / bank_name / bank_card_number` → **提现**
- 页面：`/proxy`、`/invite`

---

## 5. 反检测实现（为什么它比我们少弹验证）

这是本次最核心的技术发现。真实的技术栈是三层叠加：

### 层 1：真实 Chrome + 抹掉自动化标志

`puppeteer-real-browser@1.4.4` 的 `connect()`（`lib/esm/index.mjs`）：

```js
const flags = Launcher.defaultFlags();          // chrome-launcher 的完整默认参数集
const i = flags.findIndex(f => f.startsWith('--disable-features'));
flags[i] = `${flags[i]},AutomationControlled`;  // ★ 去掉自动化标志 → navigator.webdriver 为 false
flags.splice(flags.findIndex(f => f.startsWith('--disable-component-update')), 1);
                                                // ★ 故意不禁用组件更新，让 Chrome 更像正常浏览器
const chrome = await launch({ ignoreDefaultFlags: true, chromeFlags, ...customConfig });
const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${chrome.port}` });
```

要点：
- 用 `chrome-finder` 找到**用户本机安装的 Google Chrome**，不是 Puppeteer 自带的 Chromium
- 保留 chrome-launcher **整套默认 flags**（而不是手写几个参数），参数画像更"正常"
- `customConfig.userDataDir` → **每平台独立持久 profile**

### 层 2：`rebrowser-puppeteer-core` —— 这个才是真杀器

```
rebrowser-puppeteer-core@23.10.3
"A drop-in replacement for puppeteer-core patched with rebrowser-patches.
 It allows to pass modern automation detection tests."
```

它修的是 CDP 的**运行时泄漏**：现代风控（Cloudflare、DataDome、以及国内平台的加固）会检测
`Runtime.enable` 造成的副作用（如函数 `toString()` 被改写、`console.debug` 时序异常）来判定"这是自动化"。
我们项目的做法是**绕开**——注释里写着"绝不 `Runtime.enable`，只用 `navigate`/`eval`"，
这是有效的**手工规避**；而职得鸭是**打补丁后正常使用完整 puppeteer API**。
差别在于我们能用的 CDP 能力被自我阉割了，他们可以全用。

### 层 3：持久化 profile 长期养熟

| 平台 | userDataDir |
|---|---|
| BOSS | `~/.puppeteer-browser-data-boss` |
| BOSS 关键词 | `~/.puppeteer-browser-data-boss-keyword` |
| 猎聘 | `~/.puppeteer-browser-data-liepin` |
| 51job | `~/.puppeteer-browser-data-51job` |
| 招聘，`demo` | `userData/…/deepseek` |

Cookie/LocalStorage/设备指纹长期累积 → 平台侧"这是个老用户"。
**首次仍需用户自己登录，风控也仍需用户自己过**（源码里有对应提示文字）。

### 层 4：行为拟人化

| 手段 | 实现 |
|---|---|
| 拟人键入 | `typeSlowly()` 每字符 **100–150ms 随机** |
| 随机目标量 | 每轮 `getRandomInt(10,20)` 个 JD / 封求职信（猎聘打招呼是 `getRandomInt(1,2)`） |
| 页面间停顿 | 普遍 `waitForSeconds(2~4)`，登录后 **等 30 秒**才开工 |
| 时间片调度 | 只在用户配置的时间段运行（更像人上班时间） |

### ⚠️ 装了但**没生效**的反检测（同样重要）

| 被寄予厚望的能力 | 实际状态 |
|---|---|
| `fingerprint: true` | **`connect()` 根本没有这个参数**（合法参数只有 `args/headless/customConfig/proxy/turnstile/connectOption/disableXvfb/plugins/ignoreAllFlags`）→ 被静默忽略 |
| `ghost-cursor` 拟人鼠标 | `pageController` 挂在 `page.realClick`/`page.realCursor`，但**全部脚本都用 `page.click()`**，一次没调过 → 死代码 |
| Cloudflare Turnstile 自动过 | `pageController` 只在 `turnstile:true` 时才启用轮询点选；调用处**没传** → 关闭 |
| `setWebdriverFalse()` | `utils.js:1` 定义了，**全项目零调用** |
| `puppeteer-extra-plugin-stealth` | 只在调试遗留 `demo.js` 里 `use()` 过 |

**结论**：它的反检测真实生效的只有 **rebrowser 补丁 + 真实 Chrome 默认 flags + 持久 profile + 行为节流**这四项。
`fingerprint`、`ghost-cursor`、`turnstile` 三个"卖点级"能力全是**误配或未接线**——这是它的技术债。

---

## 6. 工程鲁棒性设计（可借鉴的具体手法）

| 手法 | 实现 | 对应我们的问题 |
|---|---|---|
| **统一的容错包装** | `PageHelper.safeOperation(op, fallback, silent)` 包住所有页面操作 | 我们的投递循环里到处散落 try/catch |
| **关闭态错误识别** | `isClosingRelatedError()` 精确匹配 `'detached Frame' / 'Target closed' / 'navigating frame was detached' / 'Session closed' / 'Attempted to use detached Frame' / 'Cannot read properties of null'` 并**静默吞掉** | 我们同样遇到这些噪声错误 |
| **状态准入检查** | 每个操作前 `isPageAvailable()` = `!shuttingDown && !forcedQuit && page && !page.isClosed() && browser.isConnected()` | 我们的会话失效判定 |
| **标签页即时回收** | 每次开新标签取完数据 → `finally { newPage.close() }` | **正是我们昨天修的标签泄漏** |
| **递归处理下一页** | 处理完一页后递归调用自身（`await hello(page, statsManager)`） | — |
| **失败重试** | 循环体出错 → `continue`；整体出错 → `waitForSeconds(5)` 后递归重试 | 我们的批量投递遇错即断 |
| **计费断路器** | 501 → 全流程停机，不留半途状态 | — |
| **统计即时落库** | 每个动作立即 `+1` 上报，不批量 | 我们遇过脚本汇总与实际不一致 |
| **本地进度标记** | `is-seen`/`y-read` class 标记已处理项，避免同轮重复 | 我们的 `criteria.excludeApplied` |
| **时间段调度** | 多时间段 + 中断续跑 + 到点自动关 | 我们没有 |
| **关闭信号双标志** | `isShuttingDown`（正常）与 `isForcedQuit`（异常）分开 | — |

---

## 7. 与 job-apply-agent 的逐项对照

| 维度 | 职得鸭 | job-apply-agent（我们） | 判定 |
|---|---|---|---|
| 浏览器 | 本机真实 Chrome，Puppeteer 驱动 | 本机真实 Chrome，裸 CDP 驱动 | 同路线 |
| 反检测 | rebrowser 补丁（可全用 CDP）+ 默认 flags + 持久 profile | `--disable-blink-features=AutomationControlled` + 自我限制 CDP | **我们更弱** |
| 登录/验证码 | 用户在可见窗口手动处理 | 用户在可见窗口手动处理 | 相同 |
| 平台覆盖 | BOSS / 猎聘 / 51job / 智联 | BOSS / 猎聘 / 51job / 智联 / **offerbiu** | 我们多一个通道 |
| AI 能力 | **全在云端付费 API**（判定/求职信/复聊/简历） | 本地调 LLM（deepseek），无计费 | 各有利弊 |
| 打招呼判定 | 云端 AI 分类，返回是/否+原因 | 本地规则 + LLM 匹配 | 我们较粗 |
| 一岗一简历 | **HTML→PNG 截图→聊天发图**，4 平台通用 | LLM 定制 → 本地渲染 HTML → Chrome printToPDF → **邮件附件** | **各有场景**（见下） |
| 求职信 | AI 生成 / 自定义模板（带变量）/ 三重去重 | 仅自动回复，无求职信 | **我们缺失** |
| 复聊 | 有（含滑动加载历史） | 自动回复引擎（11 类 HR 意图） | 相近 |
| 交换联系方式 | 猎聘发简历/换微信/换电话状态机 | 无 | **我们缺失** |
| 关键词海投 | 有 | 有（按职位关键词筛选） | 相近 |
| 时间段调度 | 有（多段+续跑） | 无（人工触发） | **我们缺失** |
| 职位漏斗 | 职位记录页 + 状态 + 跳过原因 | `/api/stats/funnel` + 控制台看板 | 相近 |
| 跳过原因留痕 | **每条 skipped 都落 skip_reason** | 无 | **值得抄** |
| 标签页卫生 | 取完即关（`finally`） | 昨天刚修（`lastTarget` 复用 + `closeExtraTabs`） | 已追平 |
| 邮箱直投 | 无 | **有**（offerbiu 微信推文/官网） | **我们独有** |
| 跨公司串号隔离 | 无（不需要，它不抽邮箱） | **有**（quarantine 列 + 强制开关） | **我们独有** |
| 计费/商业化 | 金币+token+套餐+分销 | 无 | 定位不同 |
| 部署形态 | Electron 桌面客户端 | Node 服务 + 本地控制台 | 各有取舍 |

**关于「一岗一简历」两种路线的结论**：
- 职得鸭走 **PNG 聊天图**：通用（四平台一套代码）、绕开附件系统、HR 在聊天里必看到；但**不可被 ATS 解析**。
- 我们走 **PDF 邮件附件**：可解析、可留档、专业；但**只覆盖有招聘邮箱的岗位**（实测 858 个岗位只扫出 26 个邮箱）。
- **两者不冲突，应该都保留**：有邮箱 → PDF 邮件；无邮箱但在平台内聊天 → 走 PNG 聊天图通道。
  这是本次分析给出的最直接的产品结论。

---

## 8. 可借鉴清单（按投入产出排序）

### P0 — 直接可用，改动小

1. **`rebrowser-puppeteer-core` 替换裸 CDP**（或至少引入其补丁思路）
   我们目前靠"绝不 `Runtime.enable`"手工规避，能力被阉割且脆弱。
   换成打了补丁的 puppeteer，可用完整 API 且不泄漏 → 反检测与开发效率双赢。
   ⚠️ 需评估：这会改变 `cdpDriver.ts` 的整个会话层，属大改；可先做 PoC 验证对 BOSS 聊天页是否仍判为"已登录"。

2. **JD 提取改用 DOM 递归序列化（保留标签结构）**
   我们现在取的是整块 `innerText`。改成 `serializeClean` + 剥 `svg`，
   给 AI 的输入保留"要求/福利/描述"的结构，**匹配判定质量应能直接提升**。

3. **`skip_reason` 全量留痕**
   我们漏斗统计了数量，但没沉淀"为什么跳过"。加上后能直接看出规则哪一段在误杀。

### P1 — 明确缺口，工作量中等

4. **求职信（cover letter）能力**
   我们有 JD + 简历 + 自动回复引擎，缺"主动写求职信"这一环。
   建议：`POST /api/jobs/letter` → LLM 生成 → 存入 `applications.letter_content`；
   加**自定义模板 + 变量（{职位名称}/{公司名称}）+ 三重去重**（已写过 / HR已回复 / HR已拒绝）。

5. **PNG 聊天图通道**（补齐一岗一简历的覆盖面）
   复用我们已有的 `htmlToPdf` 渲染管线 + `Page.captureScreenshot` → 上传到 BOSS/猎聘聊天框。
   与现有 PDF 邮件通道按"有无邮箱"自动分流。

6. **时间段调度 + 中断续跑**
   用户配置多个运行时间段，到点自动启停。降低风控、也让投递节奏更像真人。

### P2 — 锦上添花

7. **职位记录补充字段**：`hr_name` / `hr_position` / `company_size` / `financing` / `industry`（我们目前 company 还有 114 条为空）
8. **猎聘交换联系方式状态机**（发简历/换微信/换电话 + disabled/badge 三态）
9. **`PageHelper.safeOperation` 式统一容错**（收敛我们散落各处的 try/catch）
10. **`typeSlowly` 拟人键入**（100–150ms 随机；我们目前是直接赋值）
11. **统计即时上报**（我们遇过"脚本汇总 0/0 但实际投出去了"的问题，即时落库可解）

---

## 9. 局限与未解

1. **云端 API 的内部 prompt 与模型不可见** —— `checkAutoChat` / `letter` / `letterResume` 的实际提示词、模型、参数都在服务端，只能从入参出参反推契约（本文已给出完整出入参）。
2. **`canvas@3.2.0` 随包分发但未找到直接调用** —— 可能服务于已废弃的本地 PDF 渲染路径，或某个间接依赖。
3. **`update.js` 的发布源** `public.century-cloud.com/aijob/` 无法本地校验其内容签名（未下载验证）。
4. **`demo.js` 的定位** —— 打开 DeepSeek 网页上传简历图，且挂了 `open-demo` IPC。推测是早期"用网页版 LLM 替代自家 API"的实验遗留，现由 `generateResumeApi` 取代。
5. **未做动态运行**：本文全部结论来自静态源码 + 公开前端 bundle，**未实际运行客户端、未登录其账号**，
   故"运行时实际行为"（如云端返回的判定准确率）无法评估。
6. **版本时效**：客户端 `1.0.39`（构建于 2026-06-08），Web 端 bundle `index-DkgXsnH-.js`（抓取于 2026-09-19）；
   两者版本可能不同步，前端有 `get-version` → `version = 27` 的协议版本号用于兼容判断。

---

## 10. 一句话总结

职得鸭不是"云端黑箱中介"，而是**「Electron 薄壳 + 本机真实 Chrome + Puppeteer(rebrowser 反检测补丁) + 云端 AI 编排」**的混合体，
与 `job-apply-agent` 同源同路，**它的护城河只有两块**：① `rebrowser` 那层 CDP 泄漏补丁（让反检测比我们干净），
② 云端 AI + 计费/分销的**产品化包装**（求职信、时间片调度、职位记录、金币体系）。
而它的技术债同样明显：`fingerprint`/`ghost-cursor`/`turnstile`/`setWebdriverFalse` **四项反检测能力全部误配或未接线**，
`demo.js` 与 `canvas` 是未清理的死代码。**我们的机会在它的空白处**：邮箱直投、跨公司串号隔离、PDF 定制简历
——这三条它一条都没做。

---

*取证产物与复现方式：*
- 解包：`zhideya_analysis/asar_tool.mjs {ls|cat|extract|stat} <app.asar>`
- 全量源码：`zhideya_analysis/app/`（32 个 JS / 16,377 行）
- 前端包：`zhideya_analysis/web_main.js`（2.27MB）
