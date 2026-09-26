# 发布链路本地复现验证（2026-09-26）

> 承接 `docs/out-of-box-test-2026-09-25.md`（§8 整改与验证、zip 中文名编码边界）。
> 该文记录的是**为什么**要有 `pack.ps1` 的 fail-closed 断言；本文记录的是**这些断言在
> runner 的 shell 下是否真的成立**——此前从未被验证过，因为 Release 流水线两次都红。

## 0. 背景：为什么必须做这件事

`release.yml` 用 `shell: pwsh`（PowerShell **7**）在 `windows-latest` 上跑 `./pack.ps1`，
而本机只有 Windows PowerShell **5.1**。两次 Release（v1.0.0 / v1.0.1）都卡在「打包」步，
且**远端日志不可读**（无 token）。能读到的只有 check-run 注解：

```
archive contains developer-only scripts: start.bat
```

所以「本地绿」≠「runner 绿」这件事一直是个悬而未决的假设。本文用**同一份 `pack.ps1`、
同一个 shell、同一个调用方式**把它测掉。

另有一个先决问题：`workflow_dispatch` **不能**用来验新代码——它 checkout 的是
**远端 main**。所以「本地复现」是唯一能验证未推送代码的手段。

## 1. 环境与实测编码差异

装了 pwsh 7 便携版（不污染系统 PATH、不改 `PATH`、可整个目录删掉）：

```
C:\Users\吉学静\WorkBuddy\2026-09-02-09-33-33\_tools\pwsh7\pwsh.exe   # 7.6.6, Core
```

| | PS 5.1.26100.9444 (Desktop) | pwsh **7.6.6** (Core) |
|---|---|---|
| `[Console]::OutputEncoding` | `gb2312` | `gb2312` |
| `$OutputEncoding` | **`us-ascii`** | **`utf-8`** |
| 代码页 | 936 | 936 |

两点值得记住：

- **`[Console]::OutputEncoding` 才是「解码原生命令 stdout」的那一项**（本机两者都是
  gb2312，因为都在 CP936 控制台上）。`$OutputEncoding` 管的是**喂给**原生命令的编码，
  即 PS 7.4+ 改默认值的那个。二者常被混为一谈。
- 用 `& $pwsh -File <脚本>` 起子进程时，**子进程自己的编码**决定它读自己的
  `tar -tf` 输出；外层宿主是谁无关。所以复现 runner 的关键是**换成 pwsh**，不是改代码页。

## 2. 跑法（可复用的操作配方）

打包脚本的产物落点由 `PACK_ZIP_DIR` 决定，**不设就会落到用户桌面并覆盖现有包**。
复现时必须显式指向临时目录：

```powershell
$tools = "C:\Users\吉学静\WorkBuddy\2026-09-02-09-33-33\_tools"
$pwsh  = "$tools\pwsh7\pwsh.exe"
$repo  = "C:\Users\吉学静\WorkBuddy\2026-09-02-09-33-33\job-apply-agent"

# ① 复现 runner 的打包步（release.yml「打包」步的等价物）
$env:PACK_ZIP_DIR = "$tools\packout_final"
Set-Location $repo
& $pwsh -NoProfile -File "$repo\pack.ps1"

# ② 复现 runner 的冒烟步（release.yml「解压即用冒烟」步的等价物）
#    它自己会再跑一次 pack.ps1，占 :4401，收尾自动清临时目录
& $pwsh -NoProfile -File "$repo\scripts\pack_smoke.ps1"
```

⚠️ **不要从 Bash 调 PowerShell**（本机安全策略直接拦截，报
`Invoking PowerShell from Bash bypasses PowerShell security checks`）。
⚠️ **`pack_smoke.ps1` 内部会重新打包**，所以它比 `pack.ps1` 多花一次打包的时间才走到断言。

## 3. 结果

四次打包，产物完全一致：

| 运行 | 宿主 | 退出码 | 大小 | 条目 | 耗时 |
|---|---|---|---|---|---|
| A（上一轮） | PS 5.1 | 0 | 454.7 MB | 181290 | 259.8 s |
| B | pwsh 7.6.6 | 0 | 454.7 MB | 181290 | 285.1 s |
| C（`pack_smoke` 内部） | pwsh 7.6.6 | 0 | 454.7 MB | 181290 | 258.5 s |
| D（含本文新增护栏） | pwsh 7.6.6 | 0 | 454.7 MB | 181290 | 281.3 s |

**A/B/C/D 均 0 条 `::error::`，条目数与大小逐次相同 ⇒ 换 shell 不影响打包结论。**

`pack_smoke.ps1`（②）**首次在本机跑通**，四段全过（总耗时 877.4 s）：

```
[1/4] packing ...            zip 454.7 MB | 181290 entries
[2/4] extracting into a fresh directory ...
[3/4] asserting fresh-machine state ...
      required files present, no secrets/personal data, no build artifacts
[4/4] starting the packaged server with the bundled node ...
      platforms/health: 15 items, sample=boss/unknown
SMOKE OK  health={"status":"ok",...}  consoleBytes=126153
cleaned up smoke dir
```

覆盖到的关键断言：自带 node + tsx + better-sqlite3 能跑、`:4401` 就绪、`/api/health` ok、
`/api/apply/quota?platform=boss` 通（原生 SQLite 真的加载了）、
**`/api/browser/connections` 里 boss 端点不依赖 `data/browser/cdp.json`**（P0 回归护栏）、
`/api/selfcheck` ≥5 项、`/api/platforms/health?deep=0` 返回 15 项且每项有
`.platform`/`.verdict`（形状护栏）、`version.json` 在包内、控制台 126153 字节、
`data/chat.db` 自建。收尾干净：无残留临时目录、无残留 node 进程。

用户桌面上的包**未被触碰**（476,783,527 字节 / 17:45:13，跑前跑后一致）。
四次运行全部通过 `PACK_ZIP_DIR` 重定向到工作区临时目录。

门禁：`npm run verify` ✅ ｜ selftest **58/58** ｜ contract **286/286**。

## 4. 一次自我推翻：编码探针是空洞的

我先写了个「编码敏感度探针」：同一份归档，分别在宿主默认 / 强制 utf-8 / 强制 gb2312
三种 `[Console]::OutputEncoding` 下做 `tar -tf`，然后比对。

结果三份清单 **SHA256 完全相同**。看起来结论很漂亮——但它是**空洞成立**的：

```
total lines       : 181290
bytes             : 16028924   highBytes(>127): 0
non-ASCII entries : 0
replacement char  : 0
```

**归档里根本没有非 ASCII 条目**，所以「三种解码下一致」不构成任何证据——没有能产生分歧的
输入。探针缺**阴性对照**。独立复核文件系统后确认这不是探针漏测，而是真实性质：

```
scanned files      : 173080   (node, node_modules, public, server, shared, scripts)
non-ASCII relpaths : 0
```

**所以真正被证实的命题是：「本发布包 100% 全 ASCII」**，而不是「`tar -tf` 解码稳定」。
两者差别很大：前者是当下的**事实**，后者是**未被证明的假设**。

这也顺带更正了 `pack.ps1` 注释里一句当时想当然的话——「scripts/ 和 node_modules/
仍有大量非 ASCII 路径」。实测是 0。args-based 传参仍有必要（成本为零且更稳），但
**理由不是「现在有很多」**。

顺带一个自身教训：探针的比对循环写成
`$base | Where-Object { $sets[$n] -notcontains $_ }`，在 18 万元素上是 **O(n²)**，
把 CPU 烧了 1029 s 还没跑完（三份清单早在 20:36 就写完了）。**PowerShell 里对十万级
数组禁用 `-contains`/`-notcontains` 做集合运算**，用 `HashSet` 或 `Compare-Object`。

## 5. 由此新增的机械护栏（本次唯一代码改动）

既然「全 ASCII」是承重的（`:7` 节的 `$must` 逐项 pin 与 `$shippedDev` basename 比对，
比的都是字符串；而 `tar -tf` 输出是**按控制台代码页解码**的，非 ASCII 条目可能解成
U+FFFD 或干脆比不相等，从而**静默**击败这两组断言——v1.0.1 挂掉的正是这两组之一），
那就把它从「碰巧成立」变成「被证明」。

`pack.ps1` 加了两半（都 fail-closed、都打 `::error::` 注解）：

1. **tar 之前**扫 `$members`（根启动器 / `$files` / 枚举出的 `scripts/`、
   `server/`、`shared/`）——中文名启动器 **1.5 s** 就拦下，不必等 5 分钟 tar。
2. **tar 之后**扫 `$listing`——覆盖 `node/`、`node_modules/`、`public/` 这三个
   **由 tar 自行递归**、`$members` 里看不到的目录。

回滚方式：删掉这两块即可，无其他代码依赖它们。

### 护栏的双向对照（护栏不响 == 没有护栏）

| 对照 | 期望 | 实测 |
|---|---|---|
| **A** 根目录放中文名启动器 | tar 前快速失败 | `exit=1` / **1.5 s**、`::error::ship set contains non-ASCII names: 测试.bat`、无 `PACKED` 行 |
| **B** 合成归档含 `中文.txt` | 检测器必须命中 | 3 条目 / **命中 1**（`./中文.txt`） |
| **C** 真实归档 181290 条目 | 必须 0 命中 | **0 命中** |

A 走的是真实代码路径；B 用**同一个 `tar.exe`** 造合成归档来驱动 archive 级那半的
同一条表达式（为此跑一次 5 分钟全量打包只为验一个正则不值得）；C 证明它不误报。
对照 A 的种子文件确认已删除，`git status` 只剩预期内的那一个改动文件。

`pack.ps1` 改动后**仍为纯 ASCII**（24161 字节 / 0 个 ≥0x80 字节），且被
`[Parser]::ParseFile` 在 **PS 5.1 与 pwsh 7 两个宿主**下解析通过——
因为 PS 5.1 会把无 BOM 的 .ps1 当 ANSI/GBK 读，非 ASCII 会直接炸解析。

## 6. 仍未验证的（诚实边界）

- **真实 runner 仍未验过。** 本文证明的是「同一份脚本在 pwsh 7 下、以 runner 的调用方式
  跑得通」。`windows-latest` 的镜像、`runner.temp`、`npm ci` 后的 `node_modules` 三件事
  本地无法等价复现。**唯一的证明办法是把修复推上去看流水线**（8 个提交待推，见当日日志）。
  在此之前，「四关验收」的第①关「能否下载」依然是**未验状态**——远端 Releases = 0 个。
- 本次没有任何东西能替代「有人真的点一次下载并解压」。代码改不动这一关。

## 7. 产物与落点

| 路径 | 说明 |
|---|---|
| `_tools/pwsh7/`（工作区，非仓库） | pwsh 7.6.6 便携版，可整个删除；不进包、不改 PATH |
| `_tools/run_pack.ps1` / `run_smoke.ps1` | 复现 runner 两个步骤的包装脚本（设 `PACK_ZIP_DIR` + 落日志） |
| `_tools/enc_probe.ps1` | 编码探针（结论见 §4；本身是空洞的，留作方法记录） |
| `_tools/guard_negative.ps1` | §5 的三组对照 |
| `_tools/packout_*/` | 三次打包产物，验证后已删（不留「不对应任何提交的快照包」） |
