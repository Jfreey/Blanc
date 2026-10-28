import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { desktop } from "./api";
import "./styles.css";

// dev 下把错误攒到一个跨 reload 存活的全局里。
// CDP 的 console 事件只在「连上之后」可见，一 reload 就丢，
// 页面白屏时反而什么都留不下 —— 这个数组能跨 reload 留住现场。
if (import.meta.env.DEV) {
  window.__blancErrors = window.__blancErrors || [];
  window.addEventListener("error", (e) =>
    window.__blancErrors.push("ERROR " + (e.error?.stack || e.message)));
  window.addEventListener("unhandledrejection", (e) =>
    window.__blancErrors.push("REJECT " + (e.reason?.stack || e.reason)));
}

/* 右键菜单（2026-10-21 用户报）：WKWebView 会给页面挂一个原生菜单，在编辑器里
   右键只有一项「Reload」，点了整页重载（外部文件窗口还会丢当前篇，见 App.jsx
   的 ?ext= 注释）。应用自己要用右键的地方（侧栏树）本来就会 preventDefault
   再弹自己的 HTML 菜单，所以这里统一拦一道，把那项浏览器动作从笔记里去掉。 */
document.addEventListener("contextmenu", (e) => e.preventDefault());

// 最外层兜一道：就算某块渲染炸了，也别让用户对着白屏，
// 至少能看到报错和「重试」，编辑器里的正文也不会跟着一起没了。
createRoot(document.getElementById("root")).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);

/* 主窗口在 tauri.conf.json 里是 visible:false —— 等首帧画完再露，
   否则暗色主题启动时会先闪一下窗口底色（浅色）再变成内容。
   两次 rAF：第一次是 React 提交后的布局，第二次保证那一帧已经上屏。
   2.5s 兜底：rAF 一直不来（后台启动 / 渲染炸了）也别让窗口永远不出现；
   Rust 侧 setup 里还有一个 3s 兜底，两条互相独立。 */
if (desktop.available()) {
  let shown = false;
  const show = () => { if (shown) return; shown = true; desktop.showWindow(); };
  requestAnimationFrame(() => requestAnimationFrame(show));
  setTimeout(show, 2500);
}
