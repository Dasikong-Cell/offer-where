# OfferWhere 小程序

用微信开发者工具打开本目录即可运行。它是控制台（`public/console.html`）的**移动端只读视图**：
在手机上看投递看板、职位记录、简历状态与运行日志，不用把电脑搬到手边。

---

## 一、5 分钟跑起来

### 1. 启动后端（必须开局域网）

在项目根目录（即本目录的上一级）双击 **`start_lan.bat`**。

它会以 `HOST=0.0.0.0` 启动后端，并在窗口里打印两个地址，形如：

```
本机访问：http://127.0.0.1:4400
手机/局域网访问：http://10.10.45.157:4400
```

**记下第二个地址**（局域网那个），下一步要用。

> 只在本机开发时也可以用 `start_server.bat`，但那样小程序连不上 ——
> 小程序运行在手机上，`127.0.0.1` 指的是手机自己。

### 2. 用微信开发者工具打开本目录

1. 打开微信开发者工具 → **导入项目**
2. 目录选择：`job-apply-agent/miniprogram`（**就是这个目录**，不是项目根目录）
3. AppID：选 **「测试号」**（本项目的 `project.config.json` 里写的是 `touristappid`）
4. 导入后进入 **详情 → 本地设置**，勾选：
   - ☑️ **不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书**

   这一步不做的话，小程序访问 `http://<局域网IP>:4400` 会直接失败。

### 3. 在「连接后端」页填地址

小程序启动后，如果还没配置过，看板页会提示「还没连上后端」。点进去：

- **后端地址**：填第 1 步拿到的局域网地址，例如 `http://10.10.45.157:4400`
  （只填 `10.10.45.157:4400` 也行，会自动补 `http://`）
- 点 **测试连接**，看到「连接成功」即完成

### 4. 填访问令牌（重要）

后端以局域网方式启动时**会自动开启令牌鉴权**（这是安全设计，不是故障）。
不填令牌的表现是：**看数据正常，一保存/一操作就 401**。

令牌在**运行后端那台电脑**上：

```
job-apply-agent/data/.auth_token
```

用记事本打开，复制里面那串 48 位字符，粘到「连接后端」页的「访问令牌」里。

> 连接页如果检测到「后端已开启鉴权但你没填令牌」，会显示橙色警告 —— 看到它就去填。

只有两个接口不需要令牌：`/api/ping`、`/api/version`、`/api/lan`。
它们不含任何个人信息，且连接页要靠它们在**填令牌之前**判断后端是否可达。
**其余接口（含看起来「只是读一下」的 `/api/profile`、`/api/jobs`、`/api/resume/file`）
一律要令牌** —— 原因见下面第 5 条。

---

## 二、页面清单

| 页面 | Tab | 数据来源 | 能做什么 |
|------|-----|----------|----------|
| 首页看板 | 看板 | `/api/stats/funnel`、`/api/stats/trend`、`/api/apply/quota` | 看总量/已投递/沟通中、投递率、近 7 天趋势、配额与封禁告警、来源分布、匹配度 |
| 职位记录 | 职位 | `/api/jobs` | 搜索（公司/职位/城市）、按来源筛选、分页浏览、进详情 |
| 职位详情 | — | `/api/jobs` | 看岗位要求与 JD 全文、清理 JD 噪音、复制职位链接 |
| 简历中心 | 简历 | `/api/resume/current` | 看原始/优化版简历是否就绪、体量与时间、复制下载链接 |
| 运行日志 | 日志 | `/api/logs/run` | 按级别/日期/关键词筛日志、长按复制某行 |
| 连接后端 | — | `/api/ping`、`/api/version`、`/api/lan` | 配地址与令牌、测试连接、一键填入后端报告的地址 |

**这是只读视图。** 投递、自动回复、简历上传等**写操作不在小程序里做** ——
那些操作会真发消息、真投简历，需要人在电脑前盯着，放在手机上误触代价太大。
需要这些功能请用控制台。

---

## 三、已知限制（先看这里，避免误判成 bug）

### 1. 真机必须 HTTPS 或代理

微信规定：小程序**真机**只能访问已在微信公众平台配置过的 **HTTPS** 域名。
`http://<局域网IP>:4400` 只在**开发者工具**里（勾了「不校验合法域名」）能用。

要在真机上跑，三选一：

| 方案 | 做法 | 代价 |
|------|------|------|
| 内网穿透 + HTTPS | 用 frp/ngrok 之类把 4400 映射成 https 域名，再加进微信后台 | 需要域名与备案，且等于把后端暴露到公网 —— **本项目不推荐** |
| 本机自签 HTTPS + 微信后台配域名 | 自签证书不被微信认可，走不通 | — |
| 只用开发者工具的模拟器 | 勾「不校验合法域名」 | 不是真机环境 |

> ⚠️ **不要为了真机预览把后端暴露到公网。** 后端能操作真实招聘账号、能读简历，
> 暴露公网的收益远小于风险。需要真机就单独评估。

### 2. `downloadFile` 也需要合法域名

「简历中心 → 小程序内打开」走的是 `wx.downloadFile` + `wx.openDocument`，
同样受合法域名限制。所以该按钮在模拟器（勾了不校验）之外通常会失败 ——
失败时会弹窗告诉你原因，并保留「复制链接」这条退路（用手机浏览器打开）。

### 3. 职位记录最多显示 1000 条

`db.listJobs()` 的 SQL 里 `LIMIT` 的默认值写死为 **1000**（`params.push(opts.limit || 1000)`），
与库大小无关 —— 不是「刚好这么多」，而是**到 1000 就停**。前端分页是在这 1000 条之内翻。

还有个容易误判的点：记录列表的排序是
`ORDER BY (match_score IS NULL), match_score DESC, created_at DESC`
—— 即**先按有无匹配分分组、再按匹配分降序**，**不是时间序**。
想按时间找某个岗位请用搜索框，别指望往下滚。

### 4. 字段名是 snake_case

后端 `/api/jobs`、`/api/applications` 直接返回**数据库原始行**，字段名是下划线风格，
且与直觉不符：

- 职位名是 **`position`**，不是 `title`
- 职位链接是 **`apply_url`**，不是 `jobUrl`
- 匹配分是 **`match_score`**，不是 `matchScore`
- 时间是 **`created_at`**，不是 `createdAt`

写错**不会报错**，wxml 里只是静默渲染成空白 —— 最难发现的一类 bug。
所以有 `scripts/_mp_api_probe.mts` 逐个钉死这些字段名（见下）。

---

## 四、改了代码怎么验证

三道检查，**从便宜到贵**：

```bash
# 1. 静态自检（秒级）：页面注册、tabBar、路由、wxml 事件绑定、模板变量、标签配对、语法
npm run mp:check

# 2. 契约实测（约 20 秒）：真起一个后端，按小程序的方式请求，核对每个字段
npx tsx scripts/_mp_api_probe.mts

# 3. 全量门禁（npm run verify 已包含 mp:check）
npm run verify
```

**为什么第 2 步不能省**：`mp:check` 只能证明「文件之间自洽」，
证明不了「后端真的会这样回」。而小程序页面里大量读取深层字段
（`funnel.byStatus.applied`、`trend.items[].count`），字段名错了小程序不报错、只是空白。
这个探针就是为此存在的 —— 它第一次运行就抓出了 `title` vs `position` 的错误。

**tabBar 图标**：由脚本生成，不要手改 PNG。

```bash
# 需要系统 Python 3.9（装有 Pillow），与生成 app.ico 的管线同一套
npm run mp:icons
```

图标视觉基线与 `public/app.ico` 一致：24×24 设计坐标、1024 超采样后降采样、
单色 + 挖空细节（不做第二种颜色）。配色取自控制台 CSS 变量 ——
选中 `#ff7a45`（= `--brand` = `manifest.theme_color`），未选中 `#8a8f98`。

---

## 五、目录结构

```
miniprogram/
├── app.js / app.json / app.wxss     入口、页面注册 + tabBar、全局样式
├── project.config.json              appid、urlCheck:false
├── sitemap.json                     全站 disallow（页面都依赖本机后端，无索引价值）
├── utils/
│   ├── config.js                    后端地址与令牌的读写 + 错误文案翻译
│   └── request.js                   wx.request 的 Promise 封装
├── images/                          tabBar 图标（由 npm run mp:icons 生成）
└── pages/
    ├── dashboard/                   首页看板
    ├── records/                     职位记录
    ├── job-detail/                  职位详情
    ├── resume/                      简历中心
    ├── logs/                        运行日志
    └── connect/                     连接后端
```

**不会进 Release 安装包。** 打包脚本 `pack.ps1` 的白名单只有
`node / node_modules / public / server / shared`，`miniprogram/` 天然不在其中，
无需改打包脚本，也无需为它加排除规则。

---

## 六、鉴权是怎么接上的（给改代码的人）

控制台能拿到令牌，是因为服务端在 `/` 路由把 `window.__AUTH_TOKEN__` 注入进了 HTML ——
**同源**页面才有的待遇。小程序不是同源页面，拿不到，所以只能用户手填一次。

`utils/request.js` 的两条规则：

1. **所有请求都带 `X-Auth-Token`。** 后端现在**默认所有接口都要令牌**，
   只放行 `/api/ping`、`/api/version`、`/api/lan` 这三个探活/元信息 GET
   （白名单在 `server/services/authToken.ts` 的 `PUBLIC_READ_GET_PATHS`）。
   统一带上，规则只有一条。
2. **401 单独识别**并引导到连接页 —— 它的解法是「去填令牌」而不是「重试」。

后端侧无需任何改动即可接受小程序请求：`wx.request` 不带 `Origin`、
不带 `Sec-Fetch-Site`，会通过 `checkRequestOrigin` 的来源守卫。

CORS 的 `Access-Control-Allow-Headers` 已补上 `X-Auth-Token` 与 `Authorization`
（原先只列 `Content-Type`；开发者工具内不走浏览器预检所以看不出来，
但一旦引入代理或跨源中间层，预检会因「请求头未获准」直接拒发实际请求）。

---

## 七、两个「页面看着对、其实是坏的」的坑（改代码前必读）

这两条都是**在真机模拟器里跑出来**的，静态检查全绿、肉眼也看不出，
属于「不报错但功能没生效」的最危险一类。写在这里是因为它们会重复发生。

### 1. GET 的参数必须拼进 URL，不能交给 `wx.request` 的 `data`

实测（基础库 3.17.3）：

| 写法 | 后端实际收到 |
|------|--------------|
| `data: 'limit=200&level=ERROR'`（字符串） | `total=32` —— **参数被整个丢掉** |
| `data: {limit:200, level:'ERROR'}`（对象） | `total=1, level=ERROR` ✅ |

`wx.request` 对 GET **只认对象形式的 `data`**；收到字符串时它既不拼进 URL、
也不报错。原先 `request.js` 正是「先序列化成字符串再交给 data」，
于是日志页的级别/日期/关键词筛选、看板的 `days` 全部静默失效 ——
点「错误」还是 32 行，页面照常渲染。
现在统一自己拼查询串并直接拼到 URL 上，GET 一律不设 body。
`scripts/mp_check.ts` 已加断言钉住这个写法。

### 2. wxml 里比较 `{{}}` 时，先确认那个值是字符串还是对象

`/api/resume/current` 的 `status` 是**对象**
（`{version,label,description,hasOriginal,hasOptimized,options}`），
不是字符串。模板里写 `{{status === 'ready' ? ... : (status || '未知')}}`
两个分支都不成立，直接把对象 `toString()` 出来 ⇒ 徽标显示成 **`[object Object]`**。

正确做法是在 js 里把它拆成字符串字段（本页是 `statusTone` / `statusText`）再给模板。
**通用规则：wxml 的 `{{}}` 只做字符串/数字比较，别把对象丢进去比。**
