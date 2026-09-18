# BOSS / 猎聘 平台 API 对接方案

> 目标：评估「用平台官方 API 替代浏览器自动化」的可行性，并把可落地的部分做成脚手架。
> 结论日期：2026-09-18 ｜ 依据：官方开放平台文档 + 本机实测（`scripts/probe_platform_api.ts`）

---

## 一、结论先行（TL;DR）

| 问题 | 结论 |
|---|---|
| BOSS/猎聘 有官方开放平台吗？ | **有**。BOSS：`open.zhipin.com` / `hi-open.zhipin.com/open-apis`；猎聘：`developer.liepin.com` / `api.liepin.com`。 |
| 能用来「投递求职者简历」吗？ | **不能**。两个平台开放的都是 **B 端（招聘方/服务商）** 能力：职位管理、简历库、员工 IM、薪资元数据。求职者个人账号拿不到凭证。 |
| 那「彻底消验证码」怎么解？ | 不是找官方 API，而是 **把平台登录会话搬出用户本机**（云端执行）。这正是职得鸭验证码无感的真正原因。 |
| 本次落地了什么？ | ① 官方开放平台的**凭证→调用→判错**管道骨架；② 复用已登录 Chrome 会话、直连 JSON 接口的**只读检索**通道（已实测跑通登录态读取）。 |

---

## 二、官方开放平台现状核查

### 2.1 BOSS 直聘

文档：`https://histatic.zhipin.com/front/bosshi-mp-docs/...`（**BossHi 开发文档**）

- 接入前提（官方原文）：完成**创建应用 → 申请权限 → 获取访问凭证 → 设置 IP 白名单** 之后才能调用。
- 鉴权：`POST https://hi-open.zhipin.com/open-apis/auth/tenant_access_token/internal`，Body `{"app_id","app_secret"}`；
  调用业务接口时把凭证放 Header：`Authorization: Bearer <tenant_access_token>`；协议 HTTPS + UTF-8。
- 响应结构：`{ code, msg, data, traceId }`，成功 `code=0` / `msg="success"`；**官方明确要求不要用 `msg` 判成败**，只看 `code`。
- 官方示例能力：`im/v2/messages`（**向企业内员工发消息**）、`contact/v2/users/{id}`（企业通讯录）。
  → 全部是**企业内部协作**场景，与「找工作」无关。

### 2.2 猎聘

- 开发者入口：`developer.liepin.com`，API 域名 `api.liepin.com`；开放能力为**职位基础信息 / 薪资元数据**等数据接口。
- 接入同样需要**企业开发者账号 + 实名认证 + 申请接口权限**。
- 求职者侧无任何「投递」开放接口。

### 2.3 硬约束（三条）

1. **身份错位**：开放平台的调用主体是「招聘方/服务商」，不是「求职者」。求职者无法通过实名审核获得凭证。
2. **IP 白名单**：即便拿到凭证，也必须从**报备过的固定 IP** 调用；本地开发机随时变动，天然不适配。
3. **能力缺失**：开放平台根本**没有**「以求职者身份投递职位」这个 API，无论怎么申请都不存在。

> 因此：**「对接官方 API 实现自动投递」在求职者侧 = 此路不通。** 不要再往这个方向投入。

---

## 三、那职得鸭怎么做到「验证码无感」？

对照本项目取证报告 `ZHIDEYA_FORENSICS.md`：职得鸭是 **Electron 壳 + 云端 Web 应用（`product.gagajob.cn`）**，
用户在本地只做「上传简历」，真正的平台操作发生在**它的服务器上**。

```
用户本地（只上传简历）          职得鸭云端（真正干活的）              招聘平台
      │                              │                              │
      │ 简历 PDF                      │  ① 服务端会话登录             │
      ├─────────────────────────────►│  ② 逆向 JSON 接口检索/投递    │
      │                              ├─────────────────────────────►│
      │                              │  ③ 验证码在服务端处理/绕过     │
      │      结果回传                 │                              │
      │◄─────────────────────────────┤                              │
```

**关键推论**：平台风控看到的是「一个来自云机房的、行为正常的登录会话」，而不是「用户本机被 Playwright 驱动的浏览器」。
- 用户本机零平台凭证（不用装 Chrome、不用扫码）；
- 验证码在**服务端**出现，服务端可以用打码/住宅代理/人工兜底解决，用户全程无感。

这也解释了此前用户反馈的疑惑：「为什么职得鸭猎聘不弹验证」——因为**那不是用户本机的会话**。

---

## 四、三条可选架构（对比与推荐）

| | A. 官方开放平台 | B. 本地会话 + 逆向 JSON | C. 云端会话中继 |
|---|---|---|---|
| **可行性（求职者侧）** | ❌ 不可行（身份/IP/能力三重阻断） | ✅ 可行 | ✅ 可行（职得鸭同款） |
| **验证码** | 不涉及 | 仍有（本机 IP + 本机会话） | ✅ 用户端基本无感 |
| **本机依赖** | 需固定 IP | 需本机常驻 Chrome | 无 |
| **维护成本** | 低（若拿得到凭证） | 中（逆向接口随版本变） | 高（云端浏览器集群/Session 池） |
| **合规风险** | 低 | 中（违反平台用户协议） | 中高（规模化更显眼） |
| **适用** | 企业/服务商业务 | 个人自用、当前项目 | 产品化 SaaS |

**推荐路线**：
- **当前阶段（个人自用）→ 架构 B**：保留 CDP 整页投递做「投递」，用逆向 JSON 做「**检索提速 + 登录态诊断**」。投入小、立即见效。
- **若要产品化 → 架构 C**：把 CDP 链路整体搬到云端（远端 Chrome + 会话持久化 + 住宅代理），本地只做简历上传与结果订阅。这是与职得鸭正面竞争的唯一形态。

---

## 五、本次已落地的脚手架

### 5.1 文件清单

| 文件 | 作用 |
|---|---|
| `server/services/platformApi/bossOpenApi.ts` | 平台 API 通道总入口：Cookie 会话读取、登录态判定、官方 B 端客户端、逆向只读检索、能力自检 |
| `server/services/cdpDriver.ts` | **新增 `cookies` 动作**：经 CDP 读取含 **httpOnly** 的 Cookie（`document.cookie` 读不到，如 BOSS `__zp_stoken__`、猎聘 `XSRF-TOKEN`） |
| `scripts/probe_platform_api.ts` | CLI 自检：打印两平台端点、登录态、两条通道开关 |

### 5.2 关键 API

```ts
// 读会话 Cookie（含 httpOnly）——本地调试 Chrome 的独立 profile
getSessionCookies('boss')            // → CookieItem[]
isLoggedIn('boss')                   // → { loggedIn, matched: ['wt2','__zp_stoken__','bst'] }

// A) 官方 B 端开放平台（需 env BOSS_OPEN_APP_ID / BOSS_OPEN_APP_SECRET）
getTenantAccessToken()               // 带缓存，code!=0 抛错并透出 traceId
callOpenPlatform('/open-apis/im/v2/messages', {...})
// ⚠️ 能力边界：OPEN_PLATFORM_SCOPE.unsupported = ['求职者投递简历', ...]

// B) 逆向只读检索（需 env PLATFORM_WEBAPI_ENABLED=1）
bossSearchJobs('Java', '101280600')  // 昆明 101280600
liepinSearchJobs('Java', '410')
applyViaWebApiNotSupported('boss')   // 显式抛错：投递必须走 CDP，禁止 HTTP 复现签名
```

### 5.3 实测结果（2026-09-18）

```
$ ./node/node.exe node_modules/tsx/dist/cli.mjs scripts/probe_platform_api.ts
{
  "webApiEnabled": false,
  "openPlatformConfigured": false,
  "targets": {
    "boss":   { "endpoint": "http://127.0.0.1:9223", "loggedIn": true,
                "authCookies": ["wt2", "__zp_stoken__", "bst"] },
    "liepin": { "endpoint": "http://127.0.0.1:9224", "loggedIn": true,
                "authCookies": ["__gc_id", "XSRF-TOKEN"] }
  }
}
```

→ **`cookies` 通道跑通**，两个平台的关键鉴权 Cookie 均读取成功（此前只能靠截图肉眼判断登录态）。

### 5.4 为什么不把「投递」也搬进 HTTP

BOSS 投递带服务端下发的加密签名（`__zp_stoken__`/tk），猎聘带 `X-XSRF-TOKEN` 配套签名，
纯 HTTP 复现 = 持续对抗平台的签名算法升级：**维护成本极高、封号风险大**。
而 CDP 整页链路是「真浏览器点真按钮」，签名由页面自己算，**反而更稳**。
→ 所以本项目定位：**CDP 负责投递，JSON 通道只负责检索与诊断。**

---

## 六、红线（必须遵守）

1. **不代投**：官方 B 端凭证**绝不**用于求职者简历代投。
2. **不规模化**：架构 B 仅限**单人自用**、低频率；不得做成对外服务。
3. **不硬编码凭证**：`BOSS_OPEN_APP_ID`/`SECRET` 只走环境变量，不进版本库。
4. **渠道隔离**：逆向检索接口若失效，**降级为 CDP 整页采集**，不做签名对抗军备竞赛。

---

## 七、后续路线图

| 阶段 | 事项 | 状态 |
|---|---|---|
| P0 | `cookies` 读取 + 登录态诊断 + 脚手架 | ✅ 本次完成 |
| P1 | 用 `bossSearchJobs`/`liepinSearchJobs` 替换部分 CDP 采集，实测字段校准 | ⏳ 待实测校准 |
| P2 | 会话健康度巡检（定时 `isLoggedIn`，掉线自动提醒用户扫码） | ⏳ 待做 |
| P3 | 云端会话中继 PoC（远端 Chrome + 会话持久化 + 代理出口） | ⏳ 蓝图 |
