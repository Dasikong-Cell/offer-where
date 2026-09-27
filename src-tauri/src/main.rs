// Windows 发行版下不弹出额外的黑框控制台（后端日志已重定向到 server.log）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    offer_where_lib::run()
}
