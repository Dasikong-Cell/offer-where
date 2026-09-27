//! OfferWhere 桌面外壳（Tauri v2）。
//!
//! 设计边界（刻意为之，勿扩大）：
//! - 本外壳**只**接管三件事：① 控制台 UI 窗口（WebView2 加载本机后端 http://127.0.0.1:4400）
//!   ② Node 后端进程的生命周期 ③ 系统托盘/退出清理。
//! - **投递核心一行不改**：仍然是用户**本机的真实 Google Chrome** + 持久化 profile 走 CDP，
//!   反检测与登录态完全沿用 start_all.bat 的那套参数。
//!
//! 启动流程（等价于双击 start_all.bat，只是把「黑框 + Chrome --app 标签页」换成原生窗口）：
//!   1. 定位负载根目录 ROOT（server/index.ts 所在的那一层）
//!   2. 起后端：`node/node.exe node_modules/tsx/dist/cli.mjs server/index.ts`，PORT=4400（已在跑则跳过）
//!   3. 开 5 个 CDP Chrome 窗口（boss/liepin/job51/zhilian/official，端口 9223-9227，已在跑则跳过）
//!   4. **隐藏**创建主窗口 → 轮询 /api/ping 就绪 → 再 show()（避免冷启动期把「无法访问」糊在脸上）
//!
//! 退出：窗口关闭 = 收进托盘（后端继续跑，投递不中断）；托盘「退出」才真正停服。
//!
//! ── 可诊断性 + GPU 兼容（2026-09-27 加，起因：窗口空白 + 应用静默退出）──
//! - 所有关键节点追加写 **exe 同级 `offer-where.log`**：启动参数、窗口创建、WebView2 参数、
//!   后端探活、窗口关闭/销毁、退出请求、panic。**出问题时唯一能看的就是它。**
//! - **🔴 `--in-process-gpu` 是必需的**：本机实测（Chromium 自带日志）WebView2 的
//!   **独立 GPU 进程**无法初始化自己的沙箱，会连崩 9 次
//!   （`GPU process exited unexpectedly: exit_code=7`），随后 Chromium 直接
//!   `FATAL: gpu_data_manager_impl_private.cc GPU process isn't usable. Goodbye.`
//!   终止**整个浏览器进程** ⇒ 窗口变空白，Crashpad 落一个 `SubCode=0x80000003`
//!   （STATUS_BREAKPOINT）转储。把 GPU 移进浏览器进程即可绕开。
//!   刻意**不用** `--no-sandbox`：那会整体关掉 Chromium 沙箱，属安全降级。
//! - 参数来源优先级：环境变量 `OFFERWHERE_WEBVIEW2_ARGS` > exe 同级 `offer-where.args`
//!   文件（每行一个/空格分隔，`#` 开头为注释）> 内置默认值。给非技术用户留的逃生舱。

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

/// 后端固定端口（与 start_server.bat / 全部采集脚本一致，不可改）。
const BACKEND_PORT: u16 = 4400;
/// 控制台地址。
const CONSOLE_URL: &str = "http://127.0.0.1:4400/";
/// 主窗口 label（capabilities/default.json 里也按这个 label 授权）。
const WINDOW_LABEL: &str = "main";
const WINDOW_TITLE: &str = "OfferWhere 投递助手";
/// 覆盖 WebView2 浏览器参数的环境变量（见文件头说明）。
const WEBVIEW2_ARGS_ENV: &str = "OFFERWHERE_WEBVIEW2_ARGS";
/// 覆盖 WebView2 浏览器参数的文件名（exe 同级）。
const WEBVIEW2_ARGS_FILE: &str = "offer-where.args";
/// 内置默认参数 = wry 默认的 `--disable-features=...` + 绕开 GPU 进程沙箱失败所需的 `--in-process-gpu`。
const DEFAULT_WEBVIEW2_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --in-process-gpu";

static START: OnceLock<Instant> = OnceLock::new();

/// 后端子进程句柄：退出时用它停服。
struct BackendState(Mutex<Option<Child>>);

// ───────────────────────────── 日志 ─────────────────────────────

/// 日志落在 **exe 同级**，与 `server.log` 并列，方便收件人直接找到并回传。
fn log_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.join("offer-where.log"))
}

/// 追加一行日志。写日志失败**绝不影响主流程**（分发副本可能落在只读目录）。
fn log_line(msg: &str) {
    let epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let up = START.get().map(|t| t.elapsed().as_millis()).unwrap_or(0);
    let line = format!("[epoch={epoch}] [+{up:>7}ms] {msg}\n");
    if let Some(p) = log_path() {
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(p)
        {
            let _ = f.write_all(line.as_bytes());
        }
    }
}

// ───────────────────────────── 负载定位 ─────────────────────────────

/// 定位负载根目录（含 `server/index.ts` 的那一层）。
///
/// 优先级：
///   1. 环境变量 `OFFERWHERE_ROOT`（开发/调试时显式指定）
///   2. exe 同级 `payload/`（发行版：resources 解包目录）
///   3. exe 同级目录（便携版：整个项目就在 exe 旁边）← 把 exe 丢进 pack.ps1 便携包根目录即命中这条
///   4. exe 上一级 / 上上级（`dist-app/`、`target/release/` 里跑构建产物时的兜底）
fn resolve_root() -> PathBuf {
    if let Ok(raw) = std::env::var("OFFERWHERE_ROOT") {
        let p = PathBuf::from(raw);
        if p.join("server").join("index.ts").exists() {
            return p;
        }
    }
    let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
    let dir = exe
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let mut candidates = vec![dir.join("payload"), dir.clone()];
    if let Some(parent) = dir.parent() {
        candidates.push(parent.to_path_buf());
        if let Some(grand) = parent.parent() {
            candidates.push(grand.to_path_buf());
        }
    }
    for c in candidates.iter() {
        if c.join("server").join("index.ts").exists() {
            return c.clone();
        }
    }
    dir
}

/// 内置 node 运行时优先（收件人无需装 Node）；缺失则退回 PATH 上的 `node`。
fn node_exe(root: &Path) -> PathBuf {
    let bundled = root.join("node").join("node.exe");
    if bundled.exists() {
        bundled
    } else {
        PathBuf::from("node")
    }
}

/// 按 setenv.bat 的同一顺序探测 Google Chrome。
fn find_chrome() -> Option<PathBuf> {
    let mut cands: Vec<PathBuf> = Vec::new();
    for key in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Ok(base) = std::env::var(key) {
            cands.push(
                PathBuf::from(base)
                    .join("Google")
                    .join("Chrome")
                    .join("Application")
                    .join("chrome.exe"),
            );
        }
    }
    cands.into_iter().find(|p| p.exists())
}

/// CDP 调试 profile：沿用 setenv.bat 的规则（`C:\chrome-cdp-profile` 优先，保住登录态）。
fn profile_root(root: &Path) -> PathBuf {
    let shared = PathBuf::from("C:\\chrome-cdp-profile");
    if shared.exists() {
        shared
    } else {
        root.join("chrome-cdp-profile")
    }
}

// ───────────────────────────── 进程 / 端口 ─────────────────────────────

/// 端口是否有监听（用于「已在跑就复用」，避免重复开窗口/重复起后端）。
fn port_open(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(600)).is_ok()
}

/// 后端就绪探针：真发一次 HTTP GET /api/ping，只有 200 才算就绪。
fn http_ping_ok() -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], BACKEND_PORT));
    match TcpStream::connect_timeout(&addr, Duration::from_millis(800)) {
        Ok(mut stream) => {
            let _ = stream.set_read_timeout(Some(Duration::from_millis(1500)));
            let req = format!(
                "GET /api/ping HTTP/1.0\r\nHost: 127.0.0.1:{BACKEND_PORT}\r\nConnection: close\r\n\r\n"
            );
            if stream.write_all(req.as_bytes()).is_err() {
                return false;
            }
            let mut buf = String::new();
            let _ = stream.read_to_string(&mut buf);
            buf.starts_with("HTTP/1.1 200") || buf.starts_with("HTTP/1.0 200")
        }
        Err(_) => false,
    }
}

/// 起后端（等价 start_server.bat）。已在运行则返回 None。
fn spawn_backend(root: &Path) -> Option<Child> {
    if http_ping_ok() || port_open(BACKEND_PORT) {
        log_line("backend: 已在运行，复用（不重复起）");
        return None;
    }
    let node = node_exe(root);
    let tsx = root
        .join("node_modules")
        .join("tsx")
        .join("dist")
        .join("cli.mjs");
    log_line(&format!("backend: spawn node={node:?} tsx={tsx:?} cwd={root:?}"));
    let mut cmd = Command::new(&node);
    cmd.arg(&tsx)
        .arg("server/index.ts")
        .current_dir(root)
        .env("PORT", BACKEND_PORT.to_string())
        .stdin(Stdio::null());

    // 日志追加写 server.log（与 CLI 启动保持一致，方便排查冷启动问题）。
    match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("server.log"))
    {
        Ok(log) => {
            let log2 = log.try_clone().ok();
            cmd.stdout(Stdio::from(log));
            if let Some(l) = log2 {
                cmd.stderr(Stdio::from(l));
            } else {
                cmd.stderr(Stdio::null());
            }
        }
        Err(_) => {
            cmd.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }
    match cmd.spawn() {
        Ok(c) => {
            log_line(&format!("backend: spawned pid={}", c.id()));
            Some(c)
        }
        Err(e) => {
            log_line(&format!("backend: SPAWN FAILED: {e}"));
            None
        }
    }
}

/// 开 5 个核心平台的 CDP Chrome 窗口（参数与 start_all.bat 逐字一致，别改）。
fn launch_core_platforms(chrome: &Path, root: &Path) {
    let shared = profile_root(root).to_string_lossy().to_string();
    let flags = "--no-first-run --no-default-browser-check \
--disable-background-timer-throttling --disable-backgrounding-occluded-windows \
--disable-renderer-backgrounding --disable-blink-features=AutomationControlled --disable-infobars";

    // (id, port, user-data-dir, x, y, w, h) —— 布局：640x700 网格，1080p 放得下 5 个。
    let table: [(&str, u16, String, i32, i32, u32, u32); 5] = [
        ("boss", 9223, shared.clone(), 0, 0, 640, 700),
        ("liepin", 9224, format!("{shared}-liepin"), 660, 0, 760, 900),
        ("job51", 9225, format!("{shared}-job51"), 1320, 0, 760, 900),
        ("zhilian", 9226, format!("{shared}-zhilian"), 0, 720, 760, 900),
        ("official", 9227, format!("{shared}-official"), 660, 720, 760, 900),
    ];

    let mut opened = 0usize;
    for (id, port, udd, x, y, w, h) in table.iter() {
        if port_open(*port) {
            continue; // 已开着就复用，绝不重复开（同 start_all.bat）
        }
        match Command::new(chrome)
            .arg(format!("--remote-debugging-port={port}"))
            .arg(format!("--user-data-dir={udd}"))
            .arg(format!("--window-position={x},{y}"))
            .arg(format!("--window-size={w},{h}"))
            .args(flags.split_whitespace())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(_) => {
                opened += 1;
                log_line(&format!("chrome: 打开 {id} (port {port})"));
            }
            Err(e) => log_line(&format!("chrome: 打开 {id} 失败: {e}")),
        }
    }
    log_line(&format!("chrome: 本轮新开 {opened} 个窗口"));
}

// ───────────────────────────── 主窗口 ─────────────────────────────

/// 解析本次要用的 WebView2 浏览器参数，并返回**来源**（写进日志便于排障）。
///
/// 优先级：环境变量 `OFFERWHERE_WEBVIEW2_ARGS` > exe 同级 `offer-where.args` 文件 > 内置默认值。
///
/// 为什么要走这里而不是 WebView2 自带的 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`：
/// Tauri/wry 一旦设置了 `additional_browser_args` 就会**覆盖**那个环境变量，
/// 所以必须从我们自己的入口注入才有效（实测：只设 WebView2 那个变量毫无效果）。
fn webview2_args() -> (String, &'static str) {
    if let Ok(v) = std::env::var(WEBVIEW2_ARGS_ENV) {
        if !v.trim().is_empty() {
            return (v.trim().to_string(), "环境变量");
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if let Ok(text) = std::fs::read_to_string(dir.join(WEBVIEW2_ARGS_FILE)) {
                let joined = text
                    .lines()
                    .map(str::trim)
                    .filter(|l| !l.is_empty() && !l.starts_with('#'))
                    .collect::<Vec<_>>()
                    .join(" ");
                if !joined.is_empty() {
                    return (joined, "offer-where.args");
                }
            }
        }
    }
    (DEFAULT_WEBVIEW2_ARGS.to_string(), "内置默认值")
}

/// 创建（或复用）主窗口。
///
/// 刻意**不写在 tauri.conf.json 里**：只有走 `WebviewWindowBuilder` 才能在运行时
/// 注入 `additional_browser_args`，而 Tauri 一旦设了它就会覆盖
/// `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` —— 这正是之前设了那个环境变量却毫无效果的原因。
fn create_main_window(app: &tauri::AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(w) = app.get_webview_window(WINDOW_LABEL) {
        log_line("window: 已存在，复用");
        return Ok(w);
    }
    let url: tauri::Url = CONSOLE_URL.parse().expect("CONSOLE_URL 必须是合法 URL");
    let mut builder = WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::External(url))
        .title(WINDOW_TITLE)
        .inner_size(1280.0, 860.0)
        .min_inner_size(960.0, 640.0)
        .resizable(true)
        .center()
        // 先隐藏：等 /api/ping 通了再 show，避免冷启动那几秒把「无法访问此网站」糊在脸上
        .visible(false);

    // 无条件注入：内置默认值本身就已包含 wry 的那串 --disable-features，
    // 再加 --in-process-gpu 绕开本机确定性的 GPU 进程沙箱失败（详见常量注释）。
    let (args, src) = webview2_args();
    log_line(&format!("webview2: additional_browser_args（来源={src}）= {args}"));
    builder = builder.additional_browser_args(&args);

    match builder.build() {
        Ok(w) => {
            log_line("window: 创建成功（隐藏中，等后端就绪）");
            Ok(w)
        }
        Err(e) => {
            log_line(&format!("window: 创建失败: {e}"));
            Err(e)
        }
    }
}

// ───────────────────────────── 入口 ─────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = START.set(Instant::now());

    // panic 也要留痕（release 是 panic=abort，钩子先跑再 abort）
    std::panic::set_hook(Box::new(|info| {
        log_line(&format!("PANIC: {info}"));
    }));

    log_line("──────── 启动 ────────");
    log_line(&format!(
        "exe={:?}",
        std::env::current_exe().unwrap_or_else(|_| PathBuf::from("?"))
    ));
    log_line(&format!(
        "{WEBVIEW2_ARGS_ENV}={:?}",
        std::env::var(WEBVIEW2_ARGS_ENV).ok()
    ));

    tauri::Builder::default()
        .manage(BackendState(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();
            let root = resolve_root();
            log_line(&format!("root={root:?}"));

            // ① 起后端
            let child = spawn_backend(&root);
            if let Some(state) = app.try_state::<BackendState>() {
                *state.0.lock().unwrap() = child;
            }

            // ② 开浏览器窗口（放后台线程：起 5 个 Chrome 有 ~3s/个的等待，别卡住 UI）
            match find_chrome() {
                Some(chrome) => {
                    log_line(&format!("chrome={chrome:?}"));
                    let root2 = root.clone();
                    std::thread::spawn(move || launch_core_platforms(&chrome, &root2));
                }
                None => log_line("chrome: 未找到 Google Chrome"),
            }

            // ③ 主窗口（隐藏创建，避免错误页闪现）
            let _win = create_main_window(&handle)?;

            // ④ 系统托盘
            let show = MenuItem::with_id(app, "show", "显示控制台", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip(WINDOW_TITLE)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        log_line("tray: 显示控制台");
                        if let Some(w) = app.get_webview_window(WINDOW_LABEL) {
                            let _ = w.show();
                            let _ = w.set_focus();
                        } else {
                            // 窗口被销毁过（例如 WebView2 崩了）⇒ 重建，保证托盘入口永远有效
                            log_line("tray: 窗口不存在，重建");
                            match create_main_window(app) {
                                Ok(w) => {
                                    let _ = w.show();
                                    let _ = w.set_focus();
                                }
                                Err(e) => log_line(&format!("tray: 重建失败: {e}")),
                            }
                        }
                    }
                    "quit" => {
                        log_line("tray: 退出");
                        app.exit(0);
                    }
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            let _tray = tray.build(app)?;

            // ⑤ 后端就绪（冷启动 ~6s）后再把窗口 show 出来
            let handle2 = handle.clone();
            std::thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(90);
                let mut ok = false;
                while Instant::now() < deadline {
                    if http_ping_ok() {
                        ok = true;
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(700));
                }
                log_line(&format!("backend: ping_ok={ok}（{}）", if ok { "就绪" } else { "超时，仍开窗" }));
                if let Some(w) = handle2.get_webview_window(WINDOW_LABEL) {
                    let _ = w.show();
                    let _ = w.set_focus();
                    log_line("window: 已显示");
                } else {
                    log_line("window: 就绪时窗口已不存在");
                }
            });

            Ok(())
        })
        // 关闭窗口 = 收进托盘（后端继续跑，正在进行的投递不被打断）
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                log_line("window: CloseRequested → 收进托盘（后端继续跑）");
                let _ = window.hide();
                api.prevent_close();
            }
            WindowEvent::Destroyed => log_line("window: DESTROYED（窗口被销毁！）"),
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("构建 Tauri 应用失败")
        .run(|app_handle, event| match event {
            // 窗口全关导致的**自动**退出（code=None）：托盘里还有入口，不该退出。
            // 程序化 app.exit(0)（code=Some）放行，否则托盘「退出」就失效了。
            RunEvent::ExitRequested { code, api, .. } => {
                log_line(&format!("run: ExitRequested code={code:?}"));
                if code.is_none() {
                    log_line("run: prevent_exit（托盘仍在，不退出）");
                    api.prevent_exit();
                }
            }
            RunEvent::Exit => {
                log_line("run: Exit → 停后端");
                if let Some(state) = app_handle.try_state::<BackendState>() {
                    if let Some(mut child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
            _ => {}
        });
}
