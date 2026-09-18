# 职得鸭本地取证 + 官网确认（**已被推翻，见更正**）

> ⚠️ **2026-09-19 更正**：本文档只看了 `AppData\Roaming\gagajob\`（用户数据目录），**没有解包安装体的 `resources/app.asar`**，
> 因而得出「纯云端 SaaS、用户不登录平台、验证码由服务端处理」的**错误结论**。
> 解包 `D:\新建文件夹\gagajob\resources\app.asar` 后证实：职得鸭是
> **「Electron 薄壳 + 本机真实 Chrome + Puppeteer(rebrowser 反检测补丁) + 云端 AI」**混合架构，
> **用户必须在自己电脑的可见 Chrome 窗口里登录平台账号、手动过验证码**。
> 详见 **[ZHIDEYA_DEEP_ANALYSIS.md](./ZHIDEYA_DEEP_ANALYSIS.md)**（全功能实现深度解析）。
> 本文档保留作为「只看用户数据目录会得出什么错误结论」的记录，**结论部分请以 DEEP_ANALYSIS 为准**。

> 方法：解析本机 `AppData` 中 `gagajob` 客户端文件 + 抓取 `gagajob.cn` 官网，核实产品身份、技术形态与投递逻辑。结论标【已确认】/【推断】。

## 一、产品身份（已确认）
- 品牌对应：**职得鸭 = GaGaJob = gagajob**。官网 `gagajob.cn` 标语："找工作嘎嘎乱杀 Offer 手到擒来""喂养你的职得鸭""AI全自动简历代投 · AI公司背调 · 一岗一简历 · AI面试"。
- 客户端程序代号：`gagajob`（桌面壳），产品域名 `product.gagajob.cn`，登录页 `https://product.gagajob.cn`。
- 注意：`JobJump`（`jobjump.teameet.cc`，v1.0.2）是**另一个产品**，不是职得鸭，勿混淆。

## 二、本地文件取证（已确认）
本机路径：`C:\Users\吉学静\AppData\Roaming\gagajob\`
- 类型：**Electron 桌面客户端**（Chromium 内核：含 Local Storage/leveldb、blob_storage、GPUCache、Code Cache 等）。
- 已登录：`token.txt` 内为有效 JWT（HS256，userId=`e21fad67-...`，iat/exp 齐全）；`user-config.json` = `{"resumeType":"original"}`。
- 本地存储极薄：仅 `version` / `resumeType` / `token` / `username` / 应用 `meta` URL（`https://product.gagajob.cn`）。**无任何岗位数据、投递记录、平台账号——证明核心逻辑在服务端。**
- 副应用 `JobJump` 同为 Electron 壳（v1.0.2，未登录，指向 `jobjump.teameet.cc`）。

## 三、技术形态（已确认 = 云端 SaaS + 轻壳）
- 桌面 App 只是 **Web 应用的套壳**（Electron wrapper around `product.gagajob.cn`）。
- 用户只登录职得鸭自己的账号（gagajob.cn），**不直接在本地浏览器登录 BOSS/猎聘/51job/智联**。
- 搜岗、匹配、代投、跟进全部运行在**厂商服务器**，本地零平台凭证。

## 四、官网披露的功能模块（已确认）
来自 `gagajob.cn` 首页：
- `RESUME_ENGINE_v2` 简历润色：流水账→职场黑话/HR 高光。
- `AI自动寻坑`（AUTO_JOB_HUNTER）：AI 雷达全网捞岗位，用户"划水待命"。
- `AI全自动简历代投`：一岗一简历，自动投递。
- `AI公司背调`：面试前背调公司。
- `INTERVIEW_BOT` AI 模拟面试。
- 定价：见习鸭 ¥0（基础简历润色 + AI自动找工作 + 面试攻略 + 50万金币）。
- 主张："告别无脑海投，从嘎嘎交流开始"——强调智能匹配而非盲目海投。

## 五、投递逻辑（已确认框架 + 推断细节）
已确认框架："嘎嘎交流(上传简历) → 脑机转换(简历提炼) → 开始划水(AI自动全网捞岗) → 嘎嘎乱杀(拿简历+攻略收割 Offer)"，即 **上传简历 → AI 解析 → 自动寻岗 → 一岗一简历代投 → 跟进/面试准备**。
推断（服务端如何实现平台对接，本地无法看到）：
- A) 官方开放平台 API / 平台合作通道（BOSS 开放平台、猎聘接口等）；
- B) 厂商托管浏览器农场（固定 IP + 养熟设备指纹 + 拟人节奏），代用户操作各平台账号。
- 无论哪种，**验证码对用户不可见**：用户从不在自己浏览器登招聘平台，风控由服务端消化。

## 六、与你之前疑问的确定答案
"为什么职得鸭（猎聘）不像我们总弹验证？"
- **确定**：因为职得鸭是云端中介服务，用户只登职得鸭账号；平台侧自动化在职得鸭服务器完成，验证码/滑块由服务端处理，终端用户无感。
- 我们的 `job-apply-agent` 是在**用户自己的浏览器/账号**里用本地 CDP 操作 BOSS/猎聘，首次或久未操作必触发风控验证——这是"本地直连平台"与"云端托管中介"的架构差异，不是投递代码缺陷。

## 七、对 job-apply-agent 的启示（确定）
1. 我们缺的是"服务端托管 + 平台 API 对接"这一层；若要彻底消验证码，最稳是对接 BOSS 开放平台 API（猎聘同理），把平台操作搬出用户本地浏览器。
2. 职得鸭卖点是"一岗一简历 + AI 自动寻坑 + 跟进"，我们目前有 BOSS/猎聘自动回复、offerbiu 邮箱直投，但缺"岗位匹配度评分 + 投递漏斗"数据层。
3. offerbiu 邮箱直投（微信推文/官网规模化）是职得鸭未做的差异化通道，继续沉淀。

---
取证文件：`AppData/Roaming/gagajob/{token.txt,user-config.json,Local Storage/leveldb}`；官网：`gagajob.cn`、`product.gagajob.cn`。
