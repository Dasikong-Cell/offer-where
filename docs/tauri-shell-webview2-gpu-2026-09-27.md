# Tauri 桌面外壳：WebView2「窗口空白」根因定位与修复（2026-09-27）

> 现象：双击 `dist-app/offer-where.exe` 后 **Tauri 主进程活着、原生窗口在、标题正确、responding=True，但窗口内一片空白**；
> 且 `Crashpad/reports` 每跑一次必增一个转储。

## 1. 症状与排除过程

| 观察 | 结论 |
|---|---|
| 主进程 `offer-where.exe` 全程 ALIVE（12 次 × 15s 采样） | 不是「应用自杀」 |
| 「命令一结束进程就没了」 | **沙箱回收**，不是产品行为；两回事，别混为一谈 |
| 窗口 hwnd 非 0、标题 = `OfferWhere 投递助手`、`Responding=True` | 原生窗口层没问题 |
| WebView2 缓存里出现 `127.0.0.1:4400`、`/api/health`、`/api/cities`、`/api/stats/funnel`、`app.ico` | 页面**曾经**加载并跑过 JS |
| `Crashpad/reports` 每跑 +1，`ProcessType=browser; ModuleName=msedge.dll; SubCode=0x80000003` | 崩的是 **WebView2 浏览器进程** |
| 干净对照（`killed=0`、profile 全新、提权脱离沙箱）**仍复现** | 不是沙箱 / 不是文件污染，是本机**确定性**故障 |

### 真因（唯一直接证据来源：Chromium 自带日志）

`additional_browser_args` 里加 `--enable-logging --v=1` 后，`EBWebView/chrome_debug.log` 给出：

```
GPU process exited unexpectedly: exit_code=7      ×9
FATAL:gpu_data_manager_impl_private.cc(436)] GPU process isn't usable. Goodbye.
```

即：WebView2 的**独立 GPU 进程**无法初始化自己的沙箱，连崩 9 次，Chromium 随后主动终止**整个浏览器进程**。
窗口于是变空白，而 Tauri 主进程对此一无所知（wry 没有把 browser process 死亡上抛），所以留下一个「活的空窗口」。

> 注：`--remote-debugging-port` 走 `additional_browser_args` **不生效**（交付时 Chromium 会剥离该开关），
> 所以视觉截图取证走不通，只能靠落盘日志 + 进程/转储计数做机器判定。

## 2. 修复：把 GPU 移进浏览器进程

在 `src-tauri/src/lib.rs` 的内置默认参数里追加 **`--in-process-gpu`**：

```rust
const DEFAULT_WEBVIEW2_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --in-process-gpu";
```

- 前半段是 **wry 原本的默认值**：一旦我们自己调用 `additional_browser_args`，就会**覆盖**它，
  所以必须原样带上，否则会静默丢掉 wry 的既有优化。
- 刻意**不用** `--no-sandbox`：那会整体关掉 Chromium 沙箱，属**安全降级**，只为了绕 GPU 不值得。

### 为什么必须从代码注入

Tauri/wry 一旦设置 `additional_browser_args`，就会**覆盖** WebView2 自带的
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 环境变量 —— 这是「只设那个环境变量毫无效果」的原因。

### 参数来源优先级（给非技术用户留的逃生舱）

1. 环境变量 `OFFERWHERE_WEBVIEW2_ARGS`
2. exe 同级文件 `offer-where.args`（每行一个 / 空格分隔，`#` 开头为注释）
3. 内置默认值（上表那条）

日志里会打印**实际生效值与来源**，便于远程排障：

```
webview2: additional_browser_args（来源=内置默认值）= --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --in-process-gpu
```

## 3. A/B 验证（同一二进制，唯一变量 = `--in-process-gpu`）

工具：工作区内的临时脚手架 `_tools/ow_gpu_verify.cjs`（**刻意不入库**）。
理由：这个故障是**本机图形驱动层的确定性行为**，CI 跑步机上不会复现，
把它做成随包脚本只会牵动 `pack.ps1` 的「剔除清单 / 引用守卫」而没有回归价值。

脚手架的关键设计（复现时照抄即可）：

1. **父进程必须全程存活**再杀子进程 —— 本环境的沙箱会在「启动它的命令结束」时回收被启动的进程，
   否则会把「应用自杀」认成产品缺陷（此前就误判过一次）。
2. 每 3s 采样一次 `tasklist /FI "IMAGENAME eq msedgewebview2.exe"`（数子进程个数）
   + `tasklist /V` 取窗口标题与 responding 状态；共 36s。
3. 跑之前先记 `EBWebView/Crashpad/reports` 的 `.dmp` 集合，跑完取差集 —— 这才是「新增崩溃」。
4. 用户数据目录取 `%LOCALAPPDATA%\com.offerwhere.desktop\EBWebView`（由 identifier 决定）。

| 组 | `--in-process-gpu` | WebView2 子进程 | 新增崩溃转储 | 窗口 |
|---|---|---|---|---|
| **默认（内置参数）** | ✅ | 稳定 **11**，全程不衰减 | **0** | 标题正确 / responding / 全程存活 |
| **阴性对照**（注入 wry 原版默认值） | ❌ | 3s:10 → **9s 起掉到 6**（我们整棵子树死光） | **1**（`a9c16946-…dmp`） | 同上（原生窗口不受影响） |

> 对照组的「6」= Windows 系统组件的 6 个进程（`MicrosoftWindows.Client.CBS_cw5n1h2txyewy\LocalState\EBWebView`，
> 9/24 起常驻），**不是我们的**，任何时候都不要去杀它。
> 我们自己的 WebView2 树在修复后是 `browser + crashpad-handler + utility×2 + renderer` = 5 个，
> **看不到独立 `gpu-process`** —— 这正是 `--in-process-gpu` 生效的形态。

因果链闭合：唯一变量翻转 → 崩溃出现/消失完全跟随它。

> 另一条教训：`tasklist` 的 CSV 输出走 OEM 代码页，中文标题读出来是乱码（`OfferWhere Ͷ������`）。
> 断言只依赖 `includes('OfferWhere')` 这类 ASCII 子串，不要拿中文标题做精确比对。
> 同时注意：**窗口标题正确 + responding=True 并不等于「页面渲染出来了」**——
> 那是原生窗口的属性，对照组崩了浏览器进程后这两项**照样为真**。
> 「页面真的渲染过」要靠 WebView2 缓存里出现 `127.0.0.1:4400` 来判（缓存文件 mtime 需晚于本轮启动时刻）。

## 4. 顺带确立的排查口径

- **判 DLL 依赖只能读 PE 导入表**：`objdump -p <exe> | grep "DLL Name:"`。
  用「扫 `*.dll` 字符串」会误报（曾据此误判 `libgcc_s_dw2-1.dll` 缺失）。
  本 exe 唯一非系统 DLL = `WebView2Loader.dll` ⇒ 交付必须是**两个文件**，同目录。
- **`dist-app/` 已被 `.gitignore`**（3.5MB 二进制不入库），source of truth 是 `src-tauri/`。
- 本机 `curl` 默认走代理 ⇒ 测 localhost 必须 `--noproxy '*'`；node 内置 `fetch` 不读代理。

## 5. 仍未完成（不阻塞本次修复成立）

- `pack.ps1` **尚未包含** `dist-app/` ⇒ 便携包里还没有原生外壳，「双击即用」仍走 `.bat`。
  若要入库需先决策：**随包提交二进制** / **CI 里编 Rust**（CI 加 Rust+GNU 工具链成本高）。
- `--remote-debugging-port` 不可用 ⇒ CDP 视觉截图取证缺失，需另找路径。
- 冷启动首跑（后端未运行时）端到端验收未做（本机后端常驻，只验到了「复用」分支）。
- NSIS 安装包与代码签名，留发布阶段。
