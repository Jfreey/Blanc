// Blanc 桌面壳：系统 WebView + 内嵌前端
// 前端 dist 由 Vite 构建并嵌进二进制；API 默认走 http://localhost:8787（server.mjs）。
// server.mjs 作为 resource 打进 Contents/Resources，由 lib.rs 的 setup() 拉起、
// 退出时收掉；端口已被占用（开发时自带的 node）则沿用不抢占。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    blanc::run();   // crate 名跟着 Cargo.toml 的 name 改了
}
