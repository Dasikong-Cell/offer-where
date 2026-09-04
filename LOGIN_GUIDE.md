# 投递平台登录清单

> 检测时间：2026-09-04 21:12
> 检测方式：对每平台跑非破坏性 `action=search`（只收集岗位、不投递）判定登录态

---

## 一、登录态总览

| # | 平台 | key | 状态 | 登录地址 | 需你操作 |
|---|---|---|---|---|---|
| 1 | **智联招聘** | `zhilian` | ✅ **已登录** | — | 无需操作，可直接投递 |
| 2 | **BOSS直聘** | `boss` | ❌ **需登录** | https://www.zhipin.com/web/user/?ka=header-login | **需登录** |
| 3 | **前程无忧(51job)** | `job51` | ❌ **需登录** | https://login.51job.com/login.php | **需登录** |
| 4 | **猎聘** | `liepin` | ❌ **需登录** | https://passport.liepin.com/ | **需登录** |
| 5 | **牛客网** | `nowcoder` | ⚠️ 未验证 | https://www.nowcoder.com/login | **建议登录** |

### 判定依据
- **智联**：`登录态 → 已登录`，收集到 1 个岗位，且已真实投递 30 个岗位验证通过。
- **51job**：`登录态 → 未登录，尝试邮箱验证码登录` → 返回 `need_login`（自动邮箱验证码登录选择器已过时，需人工登录）。
- **BOSS / 猎聘**：`loginCheck` 报"已登录"，但**搜索页收集到 0 个岗位**、页面对自动化浏览器返回空白。属登录判定误报（未登录时页面无登录文案，检测器就认为已登录），**实际需人工登录**。

---

## 二、你要做的事（按顺序）

1. 在已弹出的浏览器窗口里，逐个登录以下 4 个平台（**一次即可，会话持久化到磁盘**）：
   - BOSS直聘 → https://www.zhipin.com/web/user/?ka=header-login
   - 51job → https://login.51job.com/login.php
   - 猎聘 → https://passport.liepin.com/
   - 牛客网 → https://www.nowcoder.com/login

2. **登录完成后告诉我**，我会重跑登录态检测，确认全部就绪后立即批量投递。

3. 建议登录后在目标平台把「**在线简历**」补全 —— 本工具是职得鸭模式：官网一键投递、**不填表单/不碰级联**，完全依赖账号里已填好的在线简历。简历不完整会被站点拦截。

---

## 三、登录后自动投递命令

```bash
# 批量自动投递（以智联·昆明 Java 为例，上限 10 个）
curl -X POST http://127.0.0.1:3000/api/apply -H "Content-Type: application/json" \
  -d '{"platform":"zhilian","action":"keyword","keyword":"Java","maxPages":1,"maxApply":10}'

# 把 platform 换成对应 key 即可投其他平台：
#   zhilian | boss | job51 | liepin | nowcoder | offerbiu
```

- 服务端口 3000：`npm run server`（**非 watch 模式，改服务端需手动重启**）
- 前端端口 5173：`npm run dev`
- 安全阀：`maxPages`（翻页数，默认 5）、`maxApply`（总投递上限）
- 浏览器默认**可见窗口**，遇滑块/验证码在窗口内人工过一下即可

---

## 四、重新检测登录态

登录完后，用这条命令一次性复查全部平台：

```bash
cd job-apply-agent
for p in zhilian boss job51 liepin; do
  echo "===== $p ====="
  curl -s -m 150 -X POST http://127.0.0.1:3000/api/apply -H "Content-Type: application/json" \
    -d "{\"platform\":\"$p\",\"action\":\"search\",\"keyword\":\"Java\",\"maxPages\":1}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(' status:',d.get('status'));[print(' 登录态 ->',s.get('detail','')) for s in d.get('logs',[]) if '登录' in s.get('step','')]"
done
```

判定标准：`登录态 → 已登录` **且** `收集到 N 个岗位(N>0)` 才算真正就绪；仅报"已登录"但收集 0 个，说明仍未登录或被反爬拦截。
