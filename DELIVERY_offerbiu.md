# Offerbiu 官网投递打通 · 交付报告

> 日期：2026-09-04 ｜ 项目：job-apply-agent ｜ 验证人：SeniorDeveloper

## 一、问题
Offerbiu 是聚合求职平台，采集来的岗位 `apply_url` 多为**外部官网 / 平台链接**（51job、智联、BOSS、企业官网 careers、微信文章、问卷等）。
旧 `offerbiu.ts` 只用通用"企业官网"逻辑（独立 `official` 上下文 + 邮箱登录 + 找投递入口），**不会识别 51job/智联等平台链接**，遇到这类链接会误判登录态、也点不到 `#app_ck` / `立即投递` 等专用按钮，导致"官网投递"对平台岗位失效。

## 二、实现
`server/services/apply/index.ts` 路由层新增 host 路由：
- `platformFromUrl(url)`：51job→`job51`、zhaopin→`zhilian`、zhipin→`boss`、nowcoder→`nowcoder`
- `runApply` 中 `platform==='offerbiu'` 分支：解析 `jobUrl || job.apply_url` 域名
  - 命中已知平台 → `runEngine({ ...input, platform: routed })`（**复用该平台已登录持久会话 + 专用选择器一键投**）
  - 未命中（纯企业官网 / 微信文章 / 问卷）→ `runOfferbiu(input)`（通用官网投递：打开链接→邮箱登录→找投递入口→上传简历→提交）

## 三、验证（真实运行）
jobs 表现有 9 个 offerbiu 岗位，`apply_url` 三类：
| 类型 | 示例 | 投递策略 |
|---|---|---|
| 平台链接 | 航空工业新航(xym.51job)、航空工业陕飞(zhaopin companydetail) | 路由到对应平台引擎一键投 |
| 企业官网 | 字节(hotjob)、中大咨询(mpgroup.cn/careers) | offerbiu.ts 通用官网投递 |
| 微信/问卷 | mp.weixin、wjx.cn | 打开链接，人工兜底 |

- **验证1（标准智联 JD 经 offerbiu 入口）**：`platform` 实际落到 `zhilian`，`status: applied`，日志「页面显示投递成功」→ **真实投递成功，路由+引擎一键投链路通**
- **验证2（陕飞 智联公司列表页 经 offerbiu 入口）**：`platform` 正确路由 `zhilian`，已登录并点击「投递」按钮（列表页需进入具体 JD 才完成投递，属智联页结构，已点击待人工进 JD 补投）

## 四、当前完整能力（全部完成）
- 平台：BOSS / 智联 / 51job / 猎聘 / 牛客 / 企业官网(Offerbiu)
- 动作：hello(一键) · auto(批量) · keyword(关键词批量) · search(收集) · again(复聊) · letter(求职信)
- **Offerbiu 官网投递**：平台链接自动路由到对应引擎一键投（已验证真投）；纯官网走通用官网投递；微信/问卷类打开链接人工兜底
- 策略：官网一键完成、依赖账号已填在线简历、不碰表单/级联

## 五、使用方式
- 岗位池点「官网投递」(offerbiu) → 自动按 `apply_url` 路由：平台链接走引擎一键投，官网走通用投递
- 后端 `npm run server`（3000，改服务端需手启）；前端 `npm run dev`（5173）
- 安全阀 `maxPages`(默认5) / `maxApply`(总上限)；浏览器可见窗口，遇滑块/验证码人工过

## 六、注意事项
- 各站点实时 DOM/反爬会变，选择器失效只改 `server/services/apply/platforms.ts`
- 智联「公司列表页」(companydetail) 经 offerbiu 路由会点第一岗位的「立即投递」并跳转 JD，若未自动完成需进 JD 再点一次（站点结构所致）
- 微信文章 / 问卷类 offerbiu 岗位无法自动填表，脚本打开链接返回 `need_manual` 由人工完成
