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
//!   4. 轮询 /api/ping 直到后端就绪 → 把主窗口导航到控制台
//!
//! 退出：窗口关闭 = 收进托盘（后端继续跑，投递不中断）；托盘「退出」才真正停服。

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, RunEvent, WindowEvent};

/// 后端固定端口（与 start_server.bat / 全部采集脚本一致，不可改）。
const BACKEND_PORT: u16 = 4400;
/// 控制台地址。
const CONSOLE_URL: &str = "http://127.0.0.1:4400/";

/// 后端子进程句柄：退出时用它停服。
struct BackendState(Mutex<Option<Child>>);

/// 定位负载根目录（含 `server/index.ts` 的那一层）。
///
/// 优先级：
///   1. 环境变量 `OFFERWHERE_ROOT`（开发/调试时显式指定）
///   2. exe 同级 `payload/`（发行版：resources 解包目录）
///   3. exe 同级目录（便携版：整个项目就在 exe 旁边）
///   4. exe 上一级（`target/release/` 里跑 dev 构建时的兜底）
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
        return None;
    }
    let node = node_exe(root);
    let tsx = root
        .join("node_modules")
        .join("tsx")
        .join("dist")
        .join("cli.mjs");
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
    cmd.spawn().ok()
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

    for (_id, port, udd, x, y, w, h) in table.iter() {
        if port_open(*port) {
            continue; // 已开着就复用，绝不重复开（同 start_all.bat）
        }
        let _ = Command::new(chrome)
            .arg(format!("--remote-debugging-port={port}"))
            .arg(format!("--user-data-dir={udd}"))
            .arg(format!("--window-position={x},{y}"))
            .arg(format!("--window-size={w},{h}"))
            .args(flags.split_whitespace())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(BackendState(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();
            let root = resolve_root();

            // ① 起后端
            let child = spawn_backend(&root);
            if let Some(state) = app.try_state::<BackendState>() {
                *state.0.lock().unwrap() = child;
            }

            // ② 开浏览器窗口（放后台线程：起 5 个 Chrome 有 ~3s/个的等待，别卡住 UI）
            if let Some(chrome) = find_chrome() {
                let root2 = root.clone();
                std::thread::spawn(move || launch_core_platforms(&chrome, &root2));
            }

            // ③ 系统托盘
            let show = MenuItem::with_id(app, "show", "显示控制台", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("OfferWhere 投递助手")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            let _tray = tray.build(app)?;

            // ④ 后端就绪（冷启动 ~6s）后再把主窗口导航到控制台，避免白屏/连接错误
            let handle2 = handle.clone();
            std::thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(90);
                while Instant::now() < deadline {
                    if http_ping_ok() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(700));
                }
                if let Some(w) = handle2.get_webview_window("main") {
                    if let Ok(url) = tauri::Url::parse(CONSOLE_URL) {
                        let _ = w.navigate(url);
                    }
                }
            });

            Ok(())
        })
        // 关闭窗口 = 收进托盘（后端继续跑，正在进行的投递不被打断）
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("构建 Tauri 应用失败")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<BackendState>() {
                    if let Some(mut child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
