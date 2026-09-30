# 反向隧道：在自己家里的电脑上跑后端，从外网访问

> 一句话：朋友的电脑（或你自己的电脑）**主动连出**到一台公网中继，中继把外网请求灌进这条连接。
> 家里**不用开放任何入站端口**、不用公网 IP、不用 DDNS。

---

## 0. 先想清楚：这个方案解决的是什么，不解决什么

| 你想要的 | 这个方案能给你 | 说明 |
|---|---|---|
| **自己在外网用自己的控制台**（手机蜂窝网络 / 公司电脑） | ✅ 可以 | 这是本方案的主场。数据始终在你自己的电脑上 |
| 手机访问**同一个 Wi-Fi** 里的后端 | ❌ 不需要 | 用 `start_lan.bat` 就够了，别上隧道 |
| **朋友用他们自己的电脑**跑这个工具 | ❌ **负收益** | 见下 |
| 朋友访问**你电脑上**的这个工具 | ⚠️ 技术可行，但**强烈不建议** | 见下 |

### 为什么「朋友自用」是负收益

投递的物理前提是「**那台电脑上的 Chrome 已经登录了招聘网站**」。
所以朋友要真投递，**必须**在他们自己的电脑上跑一份 —— 数据就落在他们自己的机器上。

⇒ 你的中继**不提供任何数据**，只白白增加：一台服务器、一个域名、备案、以及一个把你的简历和
BOSS 账号登录态暴露给朋友的口子。朋友要的东西是**安装包 + 说明**，你已经有了：

- `OfferWhere-*.exe`（或 portable zip）—— 直接发给朋友
- `public/guide/index.html` —— 一页手机友好的说明，一个链接就能发

**结论：把「朋友也能用」实现成「各自本地安装 + PWA」，而不是「共用你的实例」。**

### 那什么时候该用隧道

- 你在外面（不是家里 Wi-Fi），想用自己电脑上那个已经登录好 Chrome 的控制台；
- 或者想让手机在任何网络下都能看到自己电脑上的投递进度。

⚠️ 用隧道 = **把你的后端挂上公网**。挂上之后，任何知道地址的人都能访问登录页，
只要拿到令牌就能触发**不可撤销的真实投递**。所以下面的安全清单不是可选项。

---

## 1. 拓扑

```
 浏览器（外网 / 手机）
        │  https
        ▼
 ┌──────────────────────┐
 │ nginx / Caddy        │  TLS 终止，反代到 127.0.0.1:8080
 │ 你的服务器            │  同时转发 WebSocket（/__tunnel）
 └──────────┬───────────┘
            │  http (回环)
            ▼
 ┌──────────────────────┐
 │ relay.mjs            │  按 Host 首段子域名分发；不存业务数据
 │ 127.0.0.1:8080       │  仅字节转发，日志只留连接级事件
 └──────────┬───────────┘
            │  WebSocket（对端**主动连出**）
            ▼
 ┌──────────────────────┐
 │ client.mjs           │  跑在你家里那台电脑上
 │  + OfferWhere 后端    │  http://127.0.0.1:4400（HOST 保持回环）
 └──────────────────────┘
```

一个域名 + 一个 443 端口可服务任意多台机器：每台用一个子域名。
例如 `abc.offerwhere.example.com` → 隧道 key = `abc`。

---

## 2. 前置条件

1. 一台有公网 IP 的服务器（国内轻量服务器首年约 ¥60–99，续费跳 ¥300–1,000）
2. 一个域名 + 一条**泛解析** A 记录：`*.offerwhere.example.com → 服务器 IP`
   - 国内服务器 + 国内域名 ⇒ 需要 **ICP 备案**（免费，5–19 个工作日）
   - 不想备案 ⇒ 用境外服务器 + 境外域名（本方案对延迟不敏感）
3. 服务器上有 Node.js 22+ 与 `ws` 依赖（用仓库里的 `node_modules` 即可）
4. 你家里那台电脑能**出站**访问 443（几乎所有网络都能）

---

## 3. 部署

### 3.1 DNS

```
*.offerwhere.example.com   A   你的服务器IP
```

泛解析是必须的 —— 中继按 Host 首段识别隧道，不想每加一台机器就加一条记录。

### 3.2 nginx

```nginx
# WebSocket 升级所需的 Connection 头映射（必须放 http {} 里，只能定义一次）
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl http2;
    server_name *.offerwhere.example.com;

    ssl_certificate     /etc/letsencrypt/live/offerwhere.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/offerwhere.example.com/privkey.pem;

    # 泛域名证书：用 DNS-01 挑战签发（HTTP-01 签不出通配符）
    #   certbot certonly --manual --preferred-challenges dns \
    #     -d offerwhere.example.com -d '*.offerwhere.example.com'

    client_max_body_size 20m;   # 简历 PDF / 截图上传

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;

        # 🔴 必须原样保留 Host —— 中继靠它的首段（子域）选隧道
        proxy_set_header Host              $host;
        # 🔴 必须设置转发头 —— 本机后端靠「有没有转发头」判定要不要注入访问令牌。
        #    不设 ⇒ 后端会把公网请求误判成「本机直连」⇒ 把 48 位令牌注入到
        #    公网谁都能看源码的首页里 ⇒ 鉴权被完全绕过。
        #    （relay/client 两端都会兜底补上，但别把安全建立在兜底上）
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;

        # WebSocket（隧道注册点）
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        # 隧道是长连接，读超时给长一点（默认 60s 会把空闲隧道掐掉）
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;        # SSE（投递进度）需要
    }
}

server {
    listen 80;
    server_name *.offerwhere.example.com;
    return 301 https://$host$request_uri;
}
```

Caddy 版更短（自动签泛域名证书需配 DNS 插件）：

```caddy
*.offerwhere.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Caddy 默认就会带 `X-Forwarded-For` / `X-Forwarded-Proto`，且自动处理 WebSocket 升级。

### 3.3 中继（服务器上）

```bash
# 每台机器一个 key:secret，逗号分隔。secret 请用随机串，别用可猜的词。
TUNNEL_KEYS="abc:$(openssl rand -hex 24)" PORT=8080 HOST=127.0.0.1 \
  node relay/relay.mjs
```

- `HOST=127.0.0.1` ⇒ 中继**只监听回环**，外部只能经 nginx 进来（不要直接暴露 8080）
- `TUNNEL_KEYS` 为空时**任何 key 都能注册** —— 只允许本地调试，绝不要这样上线

systemd（`/etc/systemd/system/offerwhere-relay.service`）：

```ini
[Unit]
Description=OfferWhere reverse tunnel relay
After=network.target

[Service]
Type=simple
User=offerwhere
WorkingDirectory=/opt/offerwhere
Environment=PORT=8080
Environment=HOST=127.0.0.1
EnvironmentFile=/etc/offerwhere-relay.env    # 里面写 TUNNEL_KEYS=abc:xxxx
ExecStart=/usr/bin/node relay/relay.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo install -m 600 /dev/null /etc/offerwhere-relay.env
echo 'TUNNEL_KEYS=abc:<你的随机密钥>' | sudo tee /etc/offerwhere-relay.env
sudo systemctl enable --now offerwhere-relay
curl -s http://127.0.0.1:8080/__relay/health
```

### 3.4 后端（你家里那台电脑）

🔴 **三个环境变量缺一不可**：

```bash
HOST=127.0.0.1 \
REQUIRE_AUTH=1 \
PORT=4400 \
EXTRA_ORIGINS=https://abc.offerwhere.example.com \
  npm run server
```

| 变量 | 为什么必须有 |
|---|---|
| `HOST=127.0.0.1` | 后端**不直接监听**局域网/公网，唯一入口是隧道 |
| `REQUIRE_AUTH=1` | ⚠️ **默认在回环地址上鉴权是关闭的**。不开 = 公网任何人可触发不可撤销的真实投递 |
| `EXTRA_ORIGINS=https://<子域名>` | 浏览器从公网域名发起写请求会带 `Origin: https://abc.…`；不在白名单里会被 403（症状：**能打开、一点投递就失败**） |

### 3.5 隧道客户端（同一台电脑）

```bash
RELAY_URL=wss://abc.offerwhere.example.com/__tunnel \
TUNNEL_KEY=abc \
TUNNEL_SECRET=<与中继的 TUNNEL_KEYS 一致> \
TARGET=http://127.0.0.1:4400 \
  node relay/client.mjs
```

- 密钥请走环境变量 `TUNNEL_SECRET`（或 `TUNNEL_SECRET_FILE` 指向只读文件）——
  `--secret` 参数会出现在进程列表里，客户端会就此告警
- 客户端启动时会**探测后端是否真的开着鉴权**（不带令牌请求 `/api/selfcheck`）：
  不是 401/403 就**拒绝启动**并把修法打印出来。这是刻意的 fail-closed ——
  「忘了设 `REQUIRE_AUTH=1`」的后果（公网任何人可投递）与这个疏漏完全不成比例
- 临时跳过用 `--allow-no-auth`，**仅限本机调试，绝不要对公网**

### 3.6 令牌怎么给用户

隧道场景下后端**不会**把令牌注入页面（这正是安全设计），所以第一次打开会弹一个输入框：
> 令牌在「跑后端的那台电脑」上：安装目录 → `data` → `.auth_token`

把那个文件里的 48 位字符串粘进去即可，之后存在浏览器 `localStorage` 里，只填一次。

---

## 4. 验收：怎么证明「通了」且「没泄露」

```bash
# ① 整条链路的端到端自检（本地假后端 + 真 relay + 真 client，11 项）
npm run relay:e2e

# ② 静态护栏（随 npm test 一起跑）
npm test
```

`relay:e2e` 里最关键的两条互为对照：

- 经隧道 `GET /` ⇒ **必须** `NO-TOKEN`（公网拿不到令牌）
- 本机直连 `GET /` ⇒ **必须** 有令牌（本机免填体验没被弄坏）

⚠️ 只测「不注入」是不够的：把注入功能整个删掉也能让前一条通过。
所以两条必须成对存在，否则断言可以被「过度纠正」骗过。

**破坏性对照（想知道断言有没有牙时做一次）**：把 `relay.mjs` 的 `ensureForwardingHeaders` 调用
和 `client.mjs` 里设置 `x-forwarded-for` 的两行都注释掉，重跑 `npm run relay:e2e` ——
①③④ 应当立刻变红，且①的响应体会真的吐出完整 48 位令牌。**还原后再跑一次确认全绿。**

---

## 5. 安全清单

| # | 事项 | 不做会怎样 |
|---|---|---|
| 1 | `REQUIRE_AUTH=1` | 公网任何人可触发**不可撤销的真实投递**、下载简历 |
| 2 | 两端都补 `X-Forwarded-For` / `X-Real-IP` | 令牌被注入公网可读页面 ⇒ 鉴权完全绕过 |
| 3 | `TUNNEL_KEYS` 必设且用随机值 | 任何人可抢注你的子域，把流量接到他自己机器 |
| 4 | 中继 `HOST=127.0.0.1`，只经 nginx 进入 | 8080 直接被扫，绕过 TLS 与 nginx 的头部治理 |
| 5 | nginx 保留 `Host` 头 | 中继无法识别子域 ⇒ 全部 502 |
| 6 | `EXTRA_ORIGINS` 填公网域名 | 写请求全 403，表现为「能打开、一保存就失败」 |
| 7 | 中继不记 URL/请求体 | 中继看得到明文（TLS 在本机终止）⇒ 记日志 = 把简历内容写进磁盘 |
| 8 | 用完把密钥轮换 | 长期不变 + 曾进过日志 = 等于没设 |
| 9 | 不要做端口映射替代隧道 | 家庭宽带 NAT 后面做了也不稳，且把电脑直接挂上公网 |

---

## 6. 故障排查

| 症状 | 原因 | 修法 |
|---|---|---|
| 页面显示「隧道未连接：xxx」并给 502 | 客户端没跑 / 后端没起 / 出站被墙 | 按页面上的三条提示排查 |
| 能打开控制台，一投递就失败 | 写请求 403 —— `Origin` 不在白名单 | 补 `EXTRA_ORIGINS=https://<子域名>` |
| 一打开就弹「需要访问令牌」 | **正常**（隧道场景刻意不注入令牌） | 去 `data/.auth_token` 复制，填一次 |
| 客户端启动即退出并打印 `拒绝启动` | 后端没开鉴权 | 按提示加 `REQUIRE_AUTH=1` |
| 客户端反复重连 | 密钥不对 / key 已被占用 | 看中继日志的 `拒绝注册` / `replaced by new connection` |
| 手机上加不了主屏幕 | 非 HTTPS 或非 localhost | 隧道走的是 https，正常可装；局域网 http 下也能装，只是没有离线缓存 |
| 投递进度不刷新 | nginx 缓冲了 SSE | `proxy_buffering off;` |

---

## 7. 成本

| 项 | 首年 | 续费 |
|---|---|---|
| 国内轻量服务器 | ¥60–99（促销） | ¥300–1,000 |
| 域名 `.cn` / `.com` | ¥30–50 / ¥50–80 | 同左 |
| 泛域名证书 | ¥0（Let's Encrypt，DNS-01） | ¥0 |
| ICP 备案（国内服务器必做） | ¥0 | ¥0（约 5–19 工作日） |

⚠️ 若要走**小程序**路线，还有额外硬约束（个人主体禁招聘类目、request 合法域名只收 https 域名
不收 IP、三证合一）—— 见 `docs/小程序上线两条路成本对比.md`。

---

## 8. 撤销

不想用了：

1. `systemctl disable --now offerwhere-relay`（或直接删服务器）
2. 家里那台电脑停掉 `client.mjs`
3. 后端改回默认启动（去掉 `REQUIRE_AUTH` / `EXTRA_ORIGINS`）⇒ 回到「仅本机可达」
4. 轮换 `data/.auth_token` —— **删掉那个文件并重启后端**即可（首次启动会自动重新生成 48 位 hex）。
   既然它曾在公网上待过，就当它已经泄露。
