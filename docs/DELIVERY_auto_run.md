# 自动投递简历 — 实跑报告

**时间**：2026-09-04
**目标**：自动运行投递简历（智联 / BOSS / 51job）

---

## 一、实跑结果

| 批次 | 平台 | 关键词/地区 | 结果 | 明细 |
|---|---|---|---|---|
| 1 | 智联招聘 | Java · 昆明(jl=489) | ✅ **成功 10 / 跳过 0** | 全部「页面显示投递成功」 |
| 2 | 智联招聘 | Java · 昆明(2页) | ✅ **成功 15 / 跳过 0** | 第1页收集 19 个公司入口 |
| 3 | BOSS直聘 | Java | ⚠️ 成功 0 | 搜索页收集到 0 个岗位入口 |
| 4 | 51job | Java | ⚠️ 成功 0 / 跳过 10 | 收集 212 入口但均为非岗位链接 |
| 5(回归) | 智联招聘 | Java · 昆明 | ✅ **成功 5 / 跳过 0** | 验证引擎改动未破坏两级采集 |

**累计真实投递：智联 30 个岗位**（10 + 15 + 5），全部经「页面显示投递成功」确认态（投递成功后按钮变为「继续沟通/已投递」）。

---

## 二、过程中发现并修复的问题

### 1. 批量引擎对非智联平台错误双重导航（真 bug）
`batchApply` 对所有平台都套用了智联的**两级采集**（先开公司页→再收岗位→再开岗位投递）。
对 51job/BOSS 这类「列表链接本身就是 JD」的平台，等于把岗位链接当公司入口又导航一层，既浪费又导致投递落错页面。

**修复**（`engine.ts`）：仅在平台配置了 `collectListScript` 时才走两级；否则 entry 即 JD，直接打开投递。

### 2. 51job 岗位收集抓错链接
原 `collectLinksScript` 用 `a[href*="jobs.51job.com"]`，把首页/导航链接 `https://jobs.51job.com/` 也收进来了（212 条里大量非岗位）。

**修复**：改为只收真岗位详情页 `/jobs.51job.com/<path>/<id>.html`。

### 3. 51job 投递按钮选择器失效
页面上 `#app_ck` **已不存在**（`document.querySelector('#app_ck')` 返回 null）。
实际按钮是 `a.btn` / `button` 上文案为**「立即申请」**的控件，点击后弹出确认对话框。

**修复**：`applyScript` 改为匹配「立即申请 / 申请职位 / 投递简历 / 投个简历」并点击。

### 4. 51job 登录态误判
批量时日志报「已登录」，实际**未登录**（页面顶栏显示「登录/注册」）。
导致跳过登录直接投递 → 10 次「未命中投递按钮」。

**修复**：`loginCheck` 增加「登录/注册」识别，未登录时正确返回 `need_login` 而非误报后空转。

---

## 三、当前各平台状态

| 平台 | 登录态 | 批量自动投递 | 说明 |
|---|---|---|---|
| **智联招聘** | ✅ 已登录(持久会话) | ✅ **可用，已实投 30 个** | 两级采集(公司页→岗位)稳定 |
| **BOSS直聘** | ⚠️ 需人工登录 | ❌ 收集 0 | 登录页已打开待登录；BOSS 反爬强，搜索页对自动化浏览器返回空白(about:blank) |
| **51job** | ⚠️ 需人工登录 | ❌ 未登录 | 登录页已打开待登录；自动邮箱验证码登录选择器已过时（点不到邮箱登录/验证码按钮） |
| **猎聘/牛客** | 未验证 | 待登录 | 选择器已按 gagajob 实现配置 |

---

## 四、下一步（需你操作）

1. **在已弹出的浏览器窗口里人工登录 51job 与 BOSS**（一次即可，会话持久化到磁盘）
   - 51job：`https://login.51job.com/login.php`
   - BOSS：`https://www.zhipin.com/web/user/?ka=header-login`
2. 登录完成后告诉我，我立刻重跑 51job / BOSS 的批量投递。
3. 若希望 51job/BOSS 也支持**全自动邮箱验证码登录**，需我重新抓取这两家登录页的选择器（目前仅智联可用）。

---

## 五、使用命令

```bash
# 智联批量自动投递（昆明 Java，上限 10）
curl -X POST http://127.0.0.1:3000/api/apply -H "Content-Type: application/json" \
  -d '{"platform":"zhilian","action":"keyword","keyword":"Java","maxPages":1,"maxApply":10}'

# 单岗一键投递
curl -X POST http://127.0.0.1:3000/api/apply -H "Content-Type: application/json" \
  -d '{"platform":"zhilian","action":"hello","jobUrl":"<岗位详情链接>"}'
```

- 服务：`npm run server`（端口 3000，**非 watch 模式，改服务端需手动重启**）
- 前端：`npm run dev`（端口 5173）
- 安全阀：`maxPages`（翻页数，默认 5）、`maxApply`（总投递上限）
- 浏览器默认**可见窗口**，遇滑块/验证码在窗口内人工过一下即可（登录态持久化）

---

## 六、变更文件

- `server/services/apply/engine.ts` — `batchApply` 两级采集仅对配置 `collectListScript` 的平台生效
- `server/services/apply/platforms.ts`
  - 51job `collectLinksScript`：只收 `.html` 岗位详情页
  - 51job `applyScript`：改点「立即申请」（`#app_ck` 已失效）
  - 51job `loginCheck`：补「登录/注册」未登录识别
  - BOSS `collectLinksScript`：增补 `.job-card-wrapper / .rec-job-item / [class*="job-card"]` 兜底
