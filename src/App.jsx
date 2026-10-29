// Blanc 主界面
// 左：知识库切换 + 文件树 + 搜索 + 文件操作；右：Milkdown（Crepe）编辑器
import React, { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, uiPrefs, API_BASE, appInfo, desktop, inTauriShell, pickDir, windows } from "./api";
import { SORT_MODES, sortTree, moveInLevel, parentOf, pathUnder, isUnder } from "./treeOrder";
/* ⚠️ 编辑器**必须懒加载**（2026-10-21 实测）：`EditorPane` 一路静态拉到
   Milkdown/Crepe + ProseMirror + KaTeX，占主包 1.99MB 里的 ~83%，而首屏
   （侧栏 + 顶栏 + 空态）一个都用不到。改动前主包 1.99MB / gzip 615KB、
   关键 CSS 151KB；改成懒加载后 0.34MB / gzip 108KB、CSS 68KB。
   代价：打开第一篇时要等一下 chunk（本地文件，一两帧），用 Suspense 的骨架兜住。 */
const EditorPane = React.lazy(() => import("./EditorPane"));
/* 字数统计单独住一个小模块 —— 从这里 import 它就等于把整个编辑器拽回关键路径，
   懒加载就白做了（原因写在 countText.js 里）。 */
import { countText } from "./countText.js";
import { readTreeCache, writeTreeCache, dropTreeCache } from "./treeCache.js";
import { ICON_CATS, PICK_ICON_KEYS, findIcon } from "./pickIcons";
/* 「关于」里显示的应用图标：直接引打包用的那张 icon128.png。
 * 不用运行时去 bundle 里读 .icns —— 那条路要 Rust 开命令、要权限，
 * 而且 .icns 本身 WKWebView 根本渲染不了（只认 PNG/JPEG）。
 * 选 128 而不是 1024：面板里最大画到 72px，128 刚好 2x 清晰，
 * 体积从 47KB 降到 4.8KB，vite 会把它内联进产物。 */
import appIconUrl from "../desktop/src-tauri/icons/icon128.png";
import { ErrorBoundary } from "./ErrorBoundary";

// 图标：整套用 Lucide（ISC，24×24 描边，strokeWidth 2.4 —— 默认的 2 比原来那套
// Radix 细一档，加到 2.4 才对得上）。原始 SVG 从 Iconify 的 lucide 集取，
// 颜色全走 currentColor，跟 hover/选中态联动。
// 换过三套：Radix（Notion 同源，但 1.x 起整体删了 folder 系列，Iconify 332 枚里也没有）
// → Tabler（outline 够用但库杂，filled 子集反而跟描边风打架）
// → Lucide（folder/folder-open/folder-plus/panel-left 全有，且跟自绘那几枚几乎同形）。
const ICONS = {
  file: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/>
    </svg>
  ),
  dir: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
      <path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>
    </svg>
  ),
  folderOpen: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
      <path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="m6 14l1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>
    </svg>
  ),
  plus: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
      <path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 12h14m-7-7v14"/>
    </svg>
  ),
  folderPlus: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
      <path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 10v6m-3-3h6m5 7a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>
    </svg>
  ),
  filePlus: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5M9 15h6m-3 3v-6"/>
    </svg>
  ),
  gear: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0a2.34 2.34 0 0 0 3.319 1.915a2.34 2.34 0 0 1 2.33 4.033a2.34 2.34 0 0 0 0 3.831a2.34 2.34 0 0 1-2.33 4.033a2.34 2.34 0 0 0-3.319 1.915a2.34 2.34 0 0 1-4.659 0a2.34 2.34 0 0 0-3.32-1.915a2.34 2.34 0 0 1-2.33-4.033a2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/>
    </svg>
  ),
  star: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
      <path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>
    </svg>
  ),
  restore: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>
    </svg>
  ),
  trash: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
      <path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 11v6m4-6v6m5-11v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
    </svg>
  ),
  fileText: (
    /* 文件树里的 .md 文件用 file-text：带两道正文横线，比空白 file 更贴「笔记」 */
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5M10 9H8m8 4H8m8 4H8"/>
    </svg>
  ),
  pencil: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
      <path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497zM15 5l4 4"/>
    </svg>
  ),
  squarePen: (
    /* 顶部「新建笔记」用 square-pen；右键菜单的「重命名」继续用 pencil */
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/>
    </svg>
  ),
  search: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
      <path d="m21 21l-4.34-4.34"/><circle cx="11" cy="11" r="8"/>
    </svg>
  ),
  book: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
      <path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 5v16m8.001-2A2 2 0 0 0 22 17V5a2 2 0 0 0-1.999-2L16 3.002A5 5 0 0 0 12 5a5 5 0 0 0-4-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 1.999 2H8a5 5 0 0 1 4 2a5 5 0 0 1 4-2z"/>
    </svg>
  ),
  note: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5M10 9H8m8 4H8m8 4H8"/>
    </svg>
  ),
  panel: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
      <rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>
    </svg>
  ),
  x: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
      <path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M18 6L6 18M6 6l12 12"/>
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
      <path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M20 6L9 17l-5-5"/>
    </svg>
  ),
  chevron: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
      <path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="m9 18l6-6l-6-6"/>
    </svg>
  ),
  gridCircles: (
    /* 侧栏最底下那枚：Lucide layout-grid-circles，官方原样的四个空心圈。
       （试过改成实心，用户要空心。）行内的「⋯更多」是 ellipsis，两处别混 */
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
      <circle cx="17.5" cy="17.5" r="3.5"/><circle cx="17.5" cy="6.5" r="3.5"/><circle cx="6.5" cy="17.5" r="3.5"/><circle cx="6.5" cy="6.5" r="3.5"/>
    </svg>
  ),
  menu: (
    /* Lucide 的 ellipsis 三个点是 r=1 的空心圆，2.4 描边下看着像三个小圈，
       比 Radix 的实心点轻一半。这里给圆补 fill、去掉描边，点径放大到 r=1.6 */
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/>
      <circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>
      <circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/>
    </svg>
  ),
  /* 迷你模式：三条短横线，长度递减 —— 和「导航条」(ICONS.bars) 的等长横线区分开。
     两者在同一个菜单里挨着，图形太像会点错。 */
  mini: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6H13M20 12H9M20 18H5" />
    </svg>
  ),
  /* 「回知识库」：方向朝左，和「展开侧栏」的 ⬓ 区分开 */
  chevLeft: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
      <path d="m15 18-6-6 6-6"/>
    </svg>
  ),
  chevD: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
      <path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="m6 9l6 6l6-6"/>
    </svg>
  ),
  chevR: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
      <path fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="m9 18l6-6l-6-6"/>
    </svg>
  ),
  // 顶栏三点菜单那一排的图标。都是 lucide 原样，形状对着菜单项的语义挑的：
  //   list —— 大纲（层级列表）
  //   bars —— 导航条。**特意用 align-end**：右对齐、长度递减的三条横线，
  //           和右侧那排刻度线长得几乎一样，比用 chart 之类的更不用解释
  //   check —— 保存状态（已保存 / 保存中）
  //   hash  —— 字数统计（计数）
  //   lock  —— 锁定
  //   type  —— 正文字号（大写 A 的示意）
  list: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>
    </svg>
  ),
  bars: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 6h-4M17 12h-8M21 18h-4M3 6v18"/>
    </svg>
  ),
  hash: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 9h16M4 15h16M10 3L8 21M16 3l-2 18"/>
    </svg>
  ),
  lock: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
      <rect width="18" height="11" x="3" y="11" rx="2"/>
      <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
    </svg>
  ),
  /* 设置面板「快捷键」那一节。lucide 的 keyboard */
  keyboard: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
      <rect width="20" height="16" x="2" y="4" rx="2"/>
      <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10"/>
    </svg>
  ),
  /* 设置面板「外观」那一节。lucide 的 palette —— 和文字颜色那两个按钮
     取自同一份 src/lucideAll.js，不要另画一套。 */
  palette: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
      <circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/>
      <circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/>
      <circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/>
      <circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/>
      <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>
    </svg>
  ),
  /* 「关于」分区用：lucide 的 info */
  about: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <path d="M12 16v-4"/><path d="M12 8h.01"/>
    </svg>
  ),
  /* 「在新窗口打开」：lucide 的 external-link */
  externalLink: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 3h6v6"/><path d="M10 14 21 3"/>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
    </svg>
  ),
  type: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7V4h16v3M9 20h6M12 4v16"/>
    </svg>
  ),
  // 「清空回收站」用扫帚而不是垃圾桶：回收站入口那枚图标已经是垃圾桶了，
  // 操作按钮再用同一个图标，看不出「这一行是入口、那枚是清空」的区别。
  // broom 是 lucide 的路径，和界面其它 ICONS 同一套画法（24 网格 / 2px 描边 / 圆头圆角）。
  broom: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
      <path d="M13.5 10.5 22 2"/>
      <path d="M14.734 13.841a2 2 0 00-.314-2.42L12.58 9.58a2 2 0 00-2.421-.314l-7.657 4.461A1 1 0 002.3 15.3l6.403 6.403a1 1 0 001.571-.204z"/>
      <path d="m5 18 2-2"/>
      <path d="m7.699 10.7 5.602 5.601"/>
    </svg>
  ),
  // 「添加图标」按钮前的笑脸（lucide smile 的路径）。图标选择器入口给个笑脸最直观，
  // 纯文字的「添加图标」在只有一行小字时太容易被当成标签而不是按钮
  smile: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <path d="M8 14s1.5 2 4 2 4-2 4-2"/>
      <line x1="9" x2="9.01" y1="9" y2="9"/>
      <line x1="15" x2="15.01" y1="9" y2="9"/>
    </svg>
  ),
};

const base = (p) => (p && p !== "/" ? p.replace(/\/$/, "") : "");

// 侧栏宽度：可拖动，限宽 270–600px，偏好存 localStorage
const SIDE_MIN = 270, SIDE_MAX = 600, SIDE_DEF = 280;
// 文件树缩进：和 styles.css 的 --indent / --indent-first 必须一致。
// 同样的「CSS 变量 JS 读不到」问题，改那边时要回来同步这两个常量。
const INDENT = 16, INDENT_FIRST = 10;
// 拖拽热区半宽（总宽 16px）。对齐卡片右边框用，见 JSX 里的 .side-resizer。
const RESIZER_HALF = 8;
// 卡片内缩量，和 styles.css 的 --side-inset 必须一致 —— JSX 要用它把热区
// 摆到卡片边框上。CSS 变量读不到 JS，两边各写一份是这个方案的固有代价，
// 所以改 CSS 那边时记得回来同步这个常量。
const SIDE_INSET = 10;
// 收起/展开动画时长。CSS 和 JS 的兜底计时器共用这一个值（写进 .app 的行内
// --side-anim），别再在两处各写一遍 —— 之前 0.26s / 260 就是这么写死两处的
const SIDE_ANIM_MS = 300;
const clampSide = (w) => Math.min(SIDE_MAX, Math.max(SIDE_MIN, Math.round(w)));

// 知识库图标：r.icon 是服务端从 config.json 的 rootIcons 读出来的
// { kind, value, color }，交给 CustomIcon 渲染（和侧栏文件图标同一套解析 + 兜底）。
// 没设过就是默认书本。
const kbIcon = (r) => <CustomIcon icon={r.icon} fallback={ICONS.book} />;
/* **只有默认书本图标**才配那块深色圆角底 —— 它是白色描边，撤掉底就看不见了。
 * 设了**任何**自定义图标都要撤掉（CSS 里的 .em）：
 *   · emoji 是彩色字形，压在深底上糊掉
 *   · svg 走 currentColor，会被这层底色反相 —— 线框版被染成浅色压在深方块上，
 *     看着就像「反色版」，用户会以为自己选错了（2026-10-16 用户报）。
 *     自带深色底的图标（比如 Blanc 反色版）自己有 rect，不受影响。
 * 注意 .em 这个名字来自 emoji，现在含义是「有自定义图标」，别按字面理解。 */
const kbAvatar = (r) => <span className={"kb-avatar" + (r.icon ? " em" : "")}>{kbIcon(r)}</span>;

// 默认文件名：新建笔记的默认名，也是标题删空后侧栏显示的兜底值
// （编辑器那边只显示占位符，见 EditorPane 的 dispTitle）
const DEFAULT_TITLE = "未命名";

// 桌面端（Tauri macOS）窗口无标题栏、红绿灯浮在左上角（tauri.conf.json 里
// trafficLightPosition x=14），侧栏顶排按钮要给它让出位置；浏览器里调试没有红绿灯。
// Tauri v2 会往 window 上注入 __TAURI_INTERNALS__，据此区分「真桌面端」和「浏览器」。
const HAS_TRAFFIC_LIGHTS =
  typeof navigator !== "undefined"
  && /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || "")
  && (typeof window !== "undefined"
    && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window));

// macOS 原生全屏（绿灯 / ⌃⌘F）时红绿灯会藏进菜单栏，窗口尺寸撑满屏幕。
// 这时候还按 HAS_TRAFFIC_LIGHTS 留 78px 的让位就是一段没来由的空白，
// 所以让位条件要额外看「当前是否原生全屏」。
// 判定用「窗口尺寸 ≈ 屏幕可用尺寸」：Tauri 的原生全屏会派发 resize，
// 但不保证触发 web 的 webkitfullscreenchange，所以额外挂一个轮询兜底。
/* 原生全屏（绿灯 / ⌃⌘F）时红绿灯藏进菜单栏、窗口撑满屏幕，这时候再留 88px
 * 让位就是一段没来由的空白，所以让位条件要额外看「当前是否原生全屏」。
 *
 * ⚠️ 这里原来用「窗口尺寸 ≈ 屏幕可用尺寸」来判（2026-10-17 加）。那个判据
 * **分不出最大化和原生全屏** —— 绿灯点两下的 zoom 窗口，尺寸和全屏几乎一样
 * （availHeight 就是菜单栏以下的全部高度）。于是最大化时被误判成全屏、
 * 让位被撤掉，顶栏的展开按钮和面包屑直接压在红绿灯上（用户 2026-10-18 截图：
 * 「普通情况下」正常，「最大化」时挤成一团）。
 *
 * 改问 Tauri 自己的 isFullscreen()：它读的是 NSWindow 的真实状态，
 * 只有真正进/出全屏（独立 Space）才为 true，zoom 不算。
 *
 * 原生全屏的切换是异步的（出全屏时 resize 甚至不一定触发），所以 resize
 * 之后补一小串快检，不然会慢半拍才把让位加回去。 */
function useNativeFullscreen() {
  const [fs, setFs] = useState(false);
  useEffect(() => {
    let alive = true;
    let timer = null;
    const read = async () => {
      try {
        const m = await import("@tauri-apps/api");
        const v = await m.window.getCurrentWindow().isFullscreen();
        if (alive) setFs(!!v);
      } catch {
        /* 浏览器里没有这个 API：保持 false（那边也没有红绿灯可让） */
      }
    };
    /* resize 之后连打 14 次、每次隔 120ms —— 覆盖系统约 1.5s 的全屏动画 */
    const burst = () => {
      clearTimeout(timer);
      let n = 0;
      const tick = () => { read(); if (alive && ++n < 14) timer = setTimeout(tick, 120); };
      tick();
    };
    read();
    window.addEventListener("resize", burst);
    return () => {
      alive = false;
      window.removeEventListener("resize", burst);
      clearTimeout(timer);
    };
  }, []);
  return fs;
}

// 「最近」：近 7 天内打开/编辑过的笔记，最多 10 条，按时间倒序（按知识库分别记）
const RECENT_MAX = 10, RECENT_DAYS = 7, RECENT_KEEP = 40;
const RECENT_TTL = RECENT_DAYS * 864e5;

// 自定义图标：内置图标目录，按分类分组（版式和 emoji 页签一致）。
// 之前是一格一格带中文小标签的，8 列太窄标签全被截断，末行还空着，看着不均匀 ——
// 现在标签只留在 title 提示里，格子统一 34px 方格 + 分类小节标题。
// value 存的是 ICONS 的 key，服务端只校验字符集，前端按 key 取 SVG，
// 所以往里加图标不用改服务端。
// 图标目录见 ./pickIcons.js：112 枚 lucide，14 个分类，路径数据是从
// lucide-static 抠出来的（手写 112 条路径必然画歪）。
const PICK_ICONS = ICON_CATS.flatMap((c) => c.items);

// 内置 emoji 目录：按分类分组，每项带中文名 —— 分类小节标题用分类名，
// 筛选框靠中文名 / emoji 本身匹配（没有 unicode 名字库，自造一份够用了）。
// 内置表有限：筛选框里直接粘一个表外的 emoji 也能用（见 IconPicker 的「用这个」）。
const EMOJI_RAW = [
  { name: "人物", items: [
    ["😀","笑脸"], ["😃","开心"], ["😄","大笑"], ["😁","咧嘴笑"], ["😆","憨笑"], ["😅","苦笑"],
    ["🤣","笑翻"], ["😂","笑出泪"], ["🙂","微笑"], ["🙃","倒笑"], ["😉","眨眼"], ["😊","害羞笑"],
    ["😇","天使笑"], ["🥰","爱心眼"], ["😍","心动"], ["🤩","星星眼"], ["😘","飞吻"], ["😗","亲亲"],
    ["😚","亲亲"], ["😋","舔嘴"], ["😛","吐舌"], ["😜","顽皮眼"], ["🤪","搞怪"], ["😝","吐舌闭眼"],
    ["🤑","金钱眼"], ["🤗","拥抱"], ["🤭","捂嘴笑"], ["🤫","嘘"], ["🤔","思考"], ["🤐","闭嘴"],
    ["😐","没表情"], ["😑","发呆"], ["😶","无嘴"], ["😏","得意"], ["😒","不开心"], ["🙄","翻白眼"],
    ["😬","龇牙"], ["😌","放松"], ["😔","失落"], ["😪","犯困"], ["😴","睡觉"], ["🥱","打哈欠"],
    ["😷","戴口罩"], ["🤒","发烧"], ["🤕","难受"], ["🥵","太热"], ["🥶","太冷"], ["🥴","晕乎乎"],
    ["😵","晕倒"], ["🤯","爆炸头"], ["🤠","牛仔"], ["🥳","派对脸"], ["😎","墨镜"], ["🤓","书呆子"],
    ["🧐","单片眼镜"], ["😕","疑惑"], ["😟","担心"], ["🙁","撅嘴"], ["😮","张嘴"], ["😯","惊讶"],
    ["😲","震惊"], ["😳","脸红"], ["🥺","恳求"], ["😦","困惑"], ["😧","焦虑"], ["😨","害怕"],
    ["😰","冷汗"], ["😥","心疼"], ["😢","流泪"], ["😭","大哭"], ["😱","惊叫"], ["😖","痛苦"],
    ["😣","难受"], ["😞","失望"], ["😓","累了"], ["😩","疲惫"], ["😫","累坏了"], ["😤","哼一声"],
    ["😡","生气"], ["😠","皱眉"], ["🤬","骂人"], ["😈","小恶魔"], ["👿","恶魔"], ["💀","骷髅"],
    ["💩","便便"], ["🤡","小丑"], ["👻","幽灵"], ["👽","外星人"], ["🤖","机器人"], ["😺","猫脸"],
  ] },
  { name: "手势", items: [
    ["👍","赞"], ["👎","踩"], ["👌","好的"], ["🤌","手势"], ["✌️","胜利"], ["🤞","好运"],
    ["🤟","爱你"], ["🤘","摇滚"], ["🤙","打电话"], ["👈","左指"], ["👉","右指"], ["👆","上指"],
    ["👇","下指"], ["☝️","第一"], ["✋","举手"], ["🖐️","张开手"], ["🖖","瓦肯礼"], ["👋","挥手"],
    ["🤚","举拳"], ["🫰","抬手指"], ["✍️","书写"], ["💪","肌肉"], ["🙏","拜托"], ["👏","鼓掌"],
    ["🙌","欢呼"], ["👐","张开双手"], ["🤲","掌心向上"], ["🫶","比心"], ["🤝","握手"], ["🙏","合十"],
    ["✌️","剪刀手"], ["🤞","交叉手指"], ["👌","OK"], ["🤌","捏手指"],
  ] },
  { name: "动物", items: [
    ["🐶","小狗"], ["🐱","小猫"], ["🐭","老鼠"], ["🐹","仓鼠"], ["🐰","兔子"], ["🦊","狐狸"],
    ["🐻","小熊"], ["🐼","熊猫"], ["🐨","考拉"], ["🐯","老虎"], ["🦁","狮子"], ["🐮","奶牛"],
    ["🐷","小猪"], ["🐸","青蛙"], ["🐵","猴子"], ["🐔","公鸡"], ["🐧","企鹅"], ["🐦","小鸟"],
    ["🦆","鸭子"], ["🦉","猫头鹰"], ["🐝","蜜蜂"], ["🐛","毛毛虫"], ["🦋","蝴蝶"], ["🐌","蜗牛"],
    ["🐞","瓢虫"], ["🐢","乌龟"], ["🐍","蛇"], ["🦎","蜥蜴"], ["🐙","章鱼"], ["🦑","鱿鱼"],
    ["🦀","螃蟹"], ["🐠","小鱼"], ["🐬","海豚"], ["🐳","鲸鱼"], ["🦖","恐龙"], ["🐲","龙"],
    ["🦄","独角兽"], ["🐴","马"], ["🐑","羊"], ["🐐","山羊"], ["🦌","鹿"], ["🐕","狗"],
  ] },
  { name: "食物", items: [
    ["🍎","苹果"], ["🍐","梨"], ["🍊","橘子"], ["🍋","柠檬"], ["🍌","香蕉"], ["🍉","西瓜"],
    ["🍇","葡萄"], ["🍓","草莓"], ["🫐","蓝莓"], ["🍒","樱桃"], ["🍑","桃子"], ["🥭","芒果"],
    ["🍍","菠萝"], ["🥝","猕猴桃"], ["🍅","番茄"], ["🥑","牛油果"], ["🥦","西兰花"], ["🥕","胡萝卜"],
    ["🌽","玉米"], ["🌶️","辣椒"], ["🥔","土豆"], ["🍞","面包"], ["🥐","可颂"], ["🥨","甜甜圈"],
    ["🧀","奶酪"], ["🍳","煎蛋"], ["🥓","培根"], ["🍔","汉堡"], ["🍟","薯条"], ["🍕","披萨"],
    ["🌮","卷饼"], ["🍣","寿司"], ["🍜","面条"], ["🍝","意面"], ["🍚","米饭"], ["🍦","冰淇淋"],
    ["🍰","蛋糕"], ["🍪","饼干"], ["🎂","生日蛋糕"], ["🍺","啤酒"], ["☕","咖啡"], ["🍵","茶"],
    ["🧋","奶茶"], ["🥤","饮料"],
  ] },
  { name: "活动", items: [
    ["⚽","足球"], ["🏀","篮球"], ["🏈","橄榄球"], ["⚾","棒球"], ["🎾","网球"], ["🏐","排球"],
    ["🏓","乒乓球"], ["🏸","羽毛球"], ["🏒","冰球"], ["⛳","高尔夫"], ["🏹","弓箭"], ["🎣","钓鱼"],
    ["🥊","拳击"], ["🥋","武术"], ["⛸️","滑冰"], ["🎿","滑雪"], ["🏂","滑雪板"], ["🏄","冲浪"],
    ["🚴","骑车"], ["🏃","跑步"], ["🧗","攀岩"], ["🏋️","举重"], ["🤸","体操"], ["🤼","摔跤"],
    ["🧘","瑜伽"], ["🎯","靶心"], ["🎲","骰子"], ["🎮","游戏机"], ["🕹️","街机"], ["🎨","画画"],
    ["🎬","场记板"], ["🎤","麦克风"], ["🎧","耳机"], ["🎸","吉他"], ["🎹","钢琴"], ["🥁","鼓"],
    ["🎺","小号"], ["🎻","小提琴"], ["🎉","庆祝"], ["🎊","彩纸"], ["🎈","气球"], ["🎁","礼物"],
  ] },
  { name: "旅行", items: [
    ["🚗","汽车"], ["🚕","出租车"], ["🚌","公交车"], ["🚑","救护车"], ["🚒","消防车"], ["🚚","卡车"],
    ["🚜","拖拉机"], ["🛵","摩托车"], ["🏍️","摩托车"], ["🚲","自行车"], ["🛴","滑板车"], ["🚂","火车"],
    ["🚆","地铁"], ["🚀","火箭"], ["✈️","飞机"], ["🛫","起飞"], ["🛬","降落"], ["🚁","直升机"],
    ["⛵","帆船"], ["🚤","快艇"], ["🛳️","轮船"], ["⚓","锚"], ["🗺️","地图"], ["🏔️","高山"],
    ["🏕️","露营"], ["🏖️","沙滩"], ["🏝️","海岛"], ["🌋","火山"], ["🏙️","城市"], ["🏠","家"],
    ["🏢","写字楼"], ["🏫","学校"], ["🏥","医院"], ["🏦","银行"], ["🌃","夜景"], ["🌆","黄昏"],
    ["🌉","桥"], ["🌌","星空"], ["🌠","流星"], ["⛰️","山"],
  ] },
  { name: "物品", items: [
    ["⌚","手表"], ["📱","手机"], ["💻","电脑"], ["🖥️","显示器"], ["🖨️","打印机"], ["⌨️","键盘"],
    ["🖱️","鼠标"], ["💾","硬盘"], ["💿","光盘"], ["📷","相机"], ["📸","拍照"], ["📹","摄像机"],
    ["🎥","摄影机"], ["📞","电话"], ["☎️","座机"], ["📺","电视"], ["📻","收音机"], ["⏰","闹钟"],
    ["⏱️","秒表"], ["⌛","沙漏"], ["🔋","电池"], ["🔌","插头"], ["💡","灯泡"], ["🔦","手电筒"],
    ["🕯️","蜡烛"], ["💸","花钱"], ["💰","钱袋"], ["💳","信用卡"], ["💎","钻石"], ["⚖️","天平"],
    ["🧰","工具箱"], ["🔧","扳手"], ["🔨","锤子"], ["⚙️","齿轮"], ["🧲","磁铁"], ["💊","药丸"],
    ["🩺","听诊器"], ["🌡️","体温计"], ["🧬","DNA"], ["🔬","显微镜"], ["🔭","望远镜"], ["📡","天线"],
    ["🗝️","钥匙"], ["🔑","钥匙"], ["🔒","锁"], ["🔓","解锁"], ["🖊️","钢笔"], ["📏","直尺"],
  ] },
  { name: "符号", items: [
    ["✅","完成"], ["❌","错误"], ["⚠️","警告"], ["❓","疑问"], ["❗","感叹"], ["💬","对话"],
    ["💭","想法"], ["♻️","回收"], ["🔱","三叉戟"], ["⚜️","徽章"], ["🔰","新手"], ["⭕","空心圆"],
    ["🛑","停止"], ["⛔","禁止"], ["🚫","禁止"], ["☑️","勾选"], ["🔲","方框"], ["🔴","红圈"],
    ["🔵","蓝圈"], ["🔶","橙菱形"], ["🔷","蓝菱形"], ["🔺","红三角"], ["🔻","红三角"], ["💠","菱形"],
    ["❤️","红心"], ["🧡","橙心"], ["💛","黄心"], ["💚","绿心"], ["💙","蓝心"], ["💜","紫心"],
    ["🖤","黑心"], ["🤍","白心"], ["💔","碎心"], ["💕","双心"], ["💖","闪亮心"], ["💯","满分"],
    ["🔥","火"], ["✨","闪光"], ["💫","星星"], ["💥","爆炸"], ["💢","冒火"], ["💦","水滴"],
    ["🌈","彩虹"], ["🎵","音符"], ["🎶","音符"], ["🔔","铃铛"], ["🔕","静音"], ["🕐","时间"],
    ["#️⃣","井号"], ["💯","满分"], ["🔖","书签"], ["🏷","标签"], ["📌","图钉"], ["📎","回形针"],
    ["🖇","回形针"], ["✂️","剪刀"], ["🗑","垃圾桶"],
  ] },
];

// 目录里同一个 emoji 会在好几个分类里重复（✌️ / 🙏 / 🤞 这类手势和符号都撞了），
// 网格里连着出现两个一样的很难看，React 的 key 也会撞车告警。
// 跨分类去重：只保留第一次出现的那个，后面的丢掉。
const EMOJI_CATS = (() => {
  const seen = new Set();
  const out = [];
  for (const cat of EMOJI_RAW) {
    const items = cat.items.filter(([em]) => (seen.has(em) ? false : (seen.add(em), true)));
    if (items.length) out.push({ name: cat.name, items });
  }
  return out;
})();

// 图标配色。第一个是「跟随主题」= 不指定颜色，按行状态走
// （普通 #b0aea8，hover / 激活 --ink，和没设图标时一样）。
// 参考图里那个「每次询问」开关在这里没意义，就用「跟随主题」占这个位置。
// hex 用色阶偏灰的一组，别用高饱和的 —— 侧栏本来就淡，抢眼会盖过正文。
// 正好 14 个 = 7 列两行，排满不留孤格；「白」被去掉了：侧栏是白底，白图标看不见。
// key 会写进 .icons/_index.json（服务端只校验字符集）。
const ICON_COLORS = [
  { key: "auto",   label: "跟随主题" },
  { key: "sand",   label: "沙",   hex: "#d3d1cb" },
  { key: "gray",   label: "浅灰", hex: "#b0aea8" },
  { key: "stone",  label: "石板", hex: "#8f8d87" },
  { key: "ink",    label: "墨黑", hex: "#37352f" },
  { key: "red",    label: "红",   hex: "#d9534f" },
  { key: "orange", label: "橙",   hex: "#d98324" },
  { key: "yellow", label: "黄",   hex: "#b8912a" },
  { key: "green",  label: "绿",   hex: "#3f8f5b" },
  { key: "teal",   label: "青",   hex: "#2f8f8a" },
  { key: "blue",   label: "蓝",   hex: "#3a7bd5" },
  { key: "indigo", label: "靛",   hex: "#5b5fc7" },
  { key: "purple", label: "紫",   hex: "#8250df" },
  { key: "pink",   label: "粉",   hex: "#c2508f" },
];
const COLOR_HEX = Object.fromEntries(ICON_COLORS.filter((c) => c.hex).map((c) => [c.key, c.hex]));
const colorHex = (key) => COLOR_HEX[key] || null;   // 认不出来的 key 当「跟随主题」，不留白

// 最近使用的图标（emoji / svg 混在一起），localStorage.blanc-ui.iconRecent
// 存 "kind:value:color"，color 可以是空串（跟随主题）
const iconKey = (kind, value, color) => `${kind}:${value}:${color || ""}`;
const pushRecentIcon = (kind, value, color) => {
  if (!value) return;
  const rest = uiPrefs.get().iconRecent || [];
  const k = iconKey(kind, value, color);
  uiPrefs.set({ iconRecent: [k, ...rest.filter((x) => x !== k)].slice(0, 14) });
};
const splitIconKey = (k) => {
  const str = String(k);
  const i = str.indexOf(":");
  if (i < 0) return null;
  const kind = str.slice(0, i);
  const rest = str.slice(i + 1);
  // value 里理论上不会有冒号（emoji / lucide key 都没有），但保险起见从**最后**一个冒号切
  const j = rest.lastIndexOf(":");
  return j < 0
    ? { kind, value: rest, color: "" }
    : { kind, value: rest.slice(0, j), color: rest.slice(j + 1) };
};
// 把 pickIcons.js 里的图元数据画成 SVG。属性名是 SVG 原样（d/cx/r/points…），
// React 认这些短名，直接 spread 即可；stroke-* 这类要写成驼峰（见 STATUS 里的坑）。
// style 要透传：配色是 cloneElement 打过来的 style，
// 不接住的话颜色会被丢掉（CSS 里 .icon.file svg 的 color 还在生效）。
/* viewBox 默认 24×24（lucide 就是这个规格）。**Blanc 自己的 logo 是 1024×1024**，
   走同一套渲染器就得让它带自己的 vb —— 否则会被 24 的坐标系裁掉一大块。
   格子尺寸由 CSS 的 `.icp-cell svg { width:17px }` 定死，viewBox 不同不影响显示。 */
function Lucide({ els, size, style, vb }) {
  const base = size ? { width: size, height: size } : { width: "100%", height: "100%" };
  return (
    <svg viewBox={vb || "0 0 24 24"} fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" style={{ ...base, ...(style || {}) }}>
      {els.map(([tag, attrs], i) => React.createElement(tag, { key: i, ...attrs }))}
    </svg>
  );
}

// ---- lucide 全量图标（懒加载）----
// 1877 枚 + 英文标签 + 264 个别名，放在 src/lucideAll.js（674KB / gzip 138KB）。
// 必须在 App 挂载后就后台拉一次：用户可能先从「筛选」里选一枚图标，
// 之后树里就要渲染它 —— 那时 pickIcons.js 的 128 枚里根本没有这个 key，
// 认不出来就只剩「未知图标」了。所以这里是异步加载 + 全局缓存 + 加载完触发重渲染。
const FULL = { nodes: null, tags: null, alias: null };
let fullLoad = null;
const loadLucideAll = () => {
  if (!fullLoad) {
    fullLoad = import("./lucideAll").then((m) => {
      FULL.nodes = m.NODES;
      FULL.tags = m.TAGS;
      FULL.alias = m.ALIAS;
    }).catch(() => { fullLoad = null; });
  }
  return fullLoad;
};
// 全量里查（带别名解析）；没加载完返回 null
function findLucideAll(key) {
  if (!FULL.nodes) return null;
  const real = key in FULL.nodes ? key : (FULL.alias && FULL.alias[key]);
  const els = real && FULL.nodes[real];
  return els ? { key: real, els } : null;
}
// 图标 key 的可搜索文本：正名 + 别名 + 英文标签
const lucideSearchText = (key) => {
  if (!FULL.tags) return key;
  const t = FULL.tags[key];
  return t ? key + " " + t.join(" ") : key;
};

// 图标 key -> { 元素, 中文名 }。
// **一定要走这个函数拿名字**：以前这里写成 `findIcon(k) || ICONS[k] ? findIcon(k).label : ...`，
// 遇到 findIcon 返回 null 但 ICONS 里有的旧 key（比如 trash），
// 条件为真却去读 null.label —— 直接抛异常，React 整棵树被卸载，就是「选图标白屏」。
// 统一在这里兜底，调用方只管渲染。
// 颜色用行内 style 打在 svg 上：CSS 里那条 `.icon.file svg { color:#b0aea8 }`
// 特异性比外层高，只有行内样式能盖住它（给包裹元素加色是盖不住的）。
function tint(node, hex) {
  if (!hex || !React.isValidElement(node)) return node;
  return React.cloneElement(node, { style: { ...(node.props.style || {}), color: hex } });
}

function iconInfo(key, color) {
  const hex = colorHex(color);
  const it = findIcon(key);
  if (it) return { node: tint(<Lucide els={it.els} vb={it.vb} />, hex), label: it.label };
  // 内置 128 枚之外的都是从「筛选」里搜出来的全量图标，懒加载到位后在这里兜住
  const all = findLucideAll(key);
  if (all) return { node: tint(<Lucide els={all.els} />, hex), label: all.key };
  if (ICONS[key]) return { node: tint(ICONS[key], hex), label: key };
  return { node: ICONS.star, label: "未知图标" };
}
const iconByKey = (key, color) => iconInfo(key, color).node;

function CustomIcon({ icon, fallback }) {
  if (!icon) return fallback;
  if (icon.kind === "emoji" && icon.value) return <span className="ic-emoji">{icon.value}</span>;
  if (icon.kind === "svg") {
    const el = iconByKey(icon.value, icon.color);
    if (el) return el;
  }
  return fallback;
}

/// 面包屑分段：把 "a/b/c.md" 拆成带**累积 rel** 的段，
/// 因为 .icons/_index.json 是按 rel 索引的，要拿图标必须知道每一层的完整路径。
/// filter(Boolean) 不是洁癖：绝对路径 "/Users/x" split("/") 的首元素是空串，
/// 不滤掉就会渲染出一个空分段，面包屑变成「外部文件 / / Users …」。
function buildCrumbs(rel) {
  return String(rel || "")
    .split("/")
    .filter(Boolean)
    .map((name, i, arr) => ({ name, rel: arr.slice(0, i + 1).join("/") }));
}

/// 外部文件的路径条：不折行，空间不够时**中间**一段折叠成省略号，首尾保持完整。
/// 用纯 flex 收缩而不是 JS 测宽再 setState —— 后者要么得 flushSync 要么在
/// setState 里读 scrollWidth 拿到的是上一帧的值，循环判断必然错一帧。
function ExternalCrumb({ absPath, name }) {
  const segs = String(absPath || "").split("/").filter(Boolean);
  const last = segs.length ? segs[segs.length - 1] : "";
  const dirs = segs.slice(0, -1);
  const head = dirs.slice(0, 1);   // 第一段（通常是 /Users）固定显示
  const mid = dirs.slice(1);       // 这段才是被压缩/省略的
  return (
    <span className="crumb ext" title={absPath}>
      <span className="seg ext-badge">外部文件</span>
      {head.map((s, i) => (
        <span key={"h" + i} className="crumb-part">
          <span className="csep">/</span>
          <span className="seg">{s}</span>
        </span>
      ))}
      {mid.length > 0 && (
        <span className="crumb-mid">
          {mid.map((s, i) => (
            <span key={"m" + i} className="mid-item"><span className="csep">/</span>{s}</span>
          ))}
        </span>
      )}
      <span className="crumb-part">
        <span className="csep">/</span>
        <span className="cur">{dispName(name || last)}</span>
      </span>
    </span>
  );
}

/* 抽屉：展开/收起走高度过渡。
 *
 * 为什么之前没有动画：直接上 grid 0fr→1fr，收起的子树就必须一直留在 DOM 里 ——
 * 整棵文件树一次性全渲染，条目一多就卡，于是退回「折叠即不挂载」，动画也就没了。
 *
 * 这里是「先挂上、再量高度」：收起态依然**不挂载**（快，和原来一样），
 * 只在展开/收起这 220ms 的窗口里把子树挂上、量出真实高度、从 0 过渡过去，
 * 动画结束立刻卸载。渲染代价被限制在动画那一下，而不是常驻。
 *
 * 用手写 height 过渡而不是 grid 0fr→1fr：grid 那条路要求内容必须在 DOM 里
 * 才能解析出 1fr，正好和上面「收起即卸载」的取舍冲突。
 *
 * ⚠️ 两个必须保留的细节，删掉任何一条都会闪一下：
 *   1. 展开时在 useLayoutEffect 里（绘制之前）把高度压到 0 —— 等绘制完再压，
 *      第一帧已经是展开态，紧接着又从 0 长出来，肉眼看到的是「闪一下再展开」。
 *   2. 压 0 之后强制读一次 offsetHeight 触发回流，让 transition:none 真正生效；
 *      不读的话浏览器会把 none+0 和 目标高度 合并成一次样式变更，过渡根本不播。
 */
const DRAWER_MS = 220;
const DRAWER_EASE = "cubic-bezier(.2,.7,.3,1)";
/* 超过这个高度就不播动画，直接切。
 * 实测（1520 文件 / 120 目录的库，把所有子目录都展开、1641 行全挂着）：
 * 收起「笔记」分组要 167ms，连着 12 个 >50ms 的长任务。动画期这 220ms 里 DOM
 * 一直挂着，每一帧都要重绘一整屏大小的区域 —— 视觉上也只是「一大片突然没了」，
 * 过渡并不比直接切更清楚。日常展开的文件夹都在一两百 px 以内，照常播。 */
const DRAWER_ANIM_MAX = 1200;

function Drawer({ open, children, className = "" }) {
  // rendered 才是「子树在不在 DOM 里」，open 是「要不要展开」。收起动画跑完才把
  // rendered 置 false，否则高度还没到 0 就没了，动画会被截断。
  const [rendered, setRendered] = useState(open);
  const [prevOpen, setPrevOpen] = useState(open);
  // 在渲染期同步状态：展开时子树必须在**这一次提交之前**就挂好，
  // 否则下面的 useLayoutEffect 拿不到 ref，量不到高度。
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setRendered(true);
  }

  const ref = useRef(null);
  const firstRun = useRef(true);

  useLayoutEffect(() => {
    const el = ref.current;
    const skip = firstRun.current;   // 首帧不播：父级一开始就是展开的，
    firstRun.current = false;         // 没有「收起来」这个前态可过渡
    if (!el) return;

    if (open) {
      const target = el.scrollHeight;       // 此刻是 height:auto，量到的是真实高度
      if (target > DRAWER_ANIM_MAX) {       // 见 DRAWER_ANIM_MAX 的实测依据
        el.style.height = ""; el.style.overflow = "";
        return;
      }
      el.style.overflow = "hidden";
      el.style.height = "0px";
      el.style.transition = "none";
      void el.offsetHeight;                 // 强制回流，提交上面三行
      if (skip) { el.style.height = ""; el.style.overflow = ""; return; }
      el.style.transition = `height ${DRAWER_MS}ms ${DRAWER_EASE}`;
      el.style.height = target + "px";
      const t = setTimeout(() => {
        if (!ref.current) return;
        // 交还 auto：动画期间内容高度变了（新建了笔记、字体改了）能自己长，
        // 钉死成 px 会一直停在旧高度。
        el.style.height = ""; el.style.transition = ""; el.style.overflow = "";
      }, DRAWER_MS);
      return () => clearTimeout(t);
    }

    const start = el.getBoundingClientRect().height;
    if (start > DRAWER_ANIM_MAX) {
      el.style.height = ""; el.style.transition = ""; el.style.overflow = "";
      setRendered(false);
      return;
    }
    el.style.overflow = "hidden";
    el.style.height = start + "px";
    el.style.transition = "none";
    void el.offsetHeight;
    el.style.transition = `height ${DRAWER_MS}ms ${DRAWER_EASE}`;
    el.style.height = "0px";
    const t = setTimeout(() => setRendered(false), DRAWER_MS);
    return () => clearTimeout(t);
  }, [open, rendered]);

  if (!rendered) return null;
  return <div ref={ref} className={"drawer" + (className ? " " + className : "")}>{children}</div>;
}

function FileTree({ node, depth, root, openFile, active, onCreate, onDelete, onMenu, depthMax = 8, activeName, icons,
  dnd = null }) {
  const [open, setOpen] = useState(depth < 1);
  const icon = icons && icons[node.rel];
  /* 拖动落点的两种姿态：
     · over  = 行与行之间（这一层重排）
     · into  = 悬在某个文件夹**上**（搬进去 = 真的搬文件）
     两者分开是因为「悬在文件夹上」和「悬在它下面那一行」得给出不同的视觉提示，
     而且处理方式也不同：前者跨层级要写盘。 */
  const [over, setOver] = useState(null);
  const [into, setInto] = useState(false);
  const [dragging, setDragging] = useState(false);
  // 悬在「不能搬进去」的文件夹上（自己 / 自己的子目录）：不给任何提示，drop 忽略
  const [invalid, setInvalid] = useState(false);
  // 拖过折叠文件夹时自动展开的定时器
  const expandTimer = useRef(null);
  useEffect(() => () => clearTimeout(expandTimer.current), []);
  // dnd.enabled = 当前允不允许拖。搜索过滤开着时是 false ——
  // 屏幕上那一列是筛出来的残次，不是这一层的真实顺序，
  // 照着它算新序号会把用户没看见的条目挤掉。
  const canDrag = !!dnd && dnd.enabled;

  const onDragStart = (e) => {
    if (!canDrag || dnd.readOnly) return;
    e.dataTransfer.setData("text/plain", node.rel);
    e.dataTransfer.effectAllowed = "move";
    dnd.setDrag(node.rel);
    setDragging(true);
  };
  /* 这一行上的落点到底是什么。**dragover 和 drop 共用这一个判据** ——
     两边必须算出同一个结果，所以只写一份。

     文件行：上半插前、下半插后（文件树的老规矩，也是「最上/最下能落下」的唯一办法；
     早先只判 "before"，于是列表最后一项后面永远没有落点 —— 用户 2026-10-13 报的）。

     文件夹行：**上 30% / 下 30% 插前插后，中间 40% 才是「搬进去」**。
     这两种落点必须分开 —— 用户 2026-10-13 明确提的就是这两种情况：
       ① 直接拖到某个文件/目录上      → 中间那条带 = 整个丢进去
       ② 拖到展开目录里、和它的内容同级 → 上/下那两条带 = 插在那一项的前/后
     早先文件夹行**只有「搬进去」一种**，结果同一层的兄弟文件夹之间根本没法互相插位置
     （不管怎么拖都只会变成「丢进去」）。 */
  const intentAt = (el, clientY) => {
    const r = el.getBoundingClientRect();
    const k = r.height ? (clientY - r.top) / r.height : 0.5;
    if (node.type !== "dir") return { into: false, after: k >= 0.5, invalid: false };
    if (isUnder(dnd.drag, node.rel)) return { into: false, after: false, invalid: true };
    if (k < 0.3) return { into: false, after: false, invalid: false };
    if (k > 0.7) return { into: false, after: true, invalid: false };
    return { into: true, after: false, invalid: false };
  };

  const onDragOver = (e) => {
    if (!canDrag || dnd.readOnly || !dnd.drag) return;
    e.preventDefault();                       // 不 preventDefault 就没有 drop
    e.dataTransfer.dropEffect = "move";
    /* ⚠️ 判据是 `isUnder(drag, node)` 而不是原来的 `parentOf(drag) !== parentOf(node)`。
       那条「不同层才搬进去」把**同一层的兄弟文件夹**也排除了，于是同一层里
       根本没有任何办法拖进文件夹（用户 2026-10-13 报「无法放入文件夹子节点」）。
       它本来只想防「把文件夹塞进它自己」，用 isUnder 表达才准确。 */
    const it = intentAt(e.currentTarget, e.clientY);
    setOver(it.into ? null : (it.after ? "after" : "before"));
    setInto(it.into);
    setInvalid(it.invalid);
    if (it.into && !open) {
      // 悬停一会儿自动展开 —— 不展开就看不见子节点，只能扔到文件夹末尾，
      // 想放到中间的位置就没有办法（和上面第 ② 种情况配套）。
      clearTimeout(expandTimer.current);
      expandTimer.current = setTimeout(() => setOpen(true), 600);
    } else if (!it.into) {
      clearTimeout(expandTimer.current);
    }
  };
  const onDrop = (e) => {
    if (!canDrag || dnd.readOnly || !dnd.drag) return;
    e.preventDefault();
    e.stopPropagation();
    const from = dnd.drag;
    /* 落点用 drop 事件自己的坐标**重算一遍**，不能直接用 onDragOver 里存的那个：
       拖动过程中指针可能没再触发 dragover（HTML5 的 dragover 是节流的），
       存的值和落手的位置对不上就会插错地方。 */
    const it = intentAt(e.currentTarget, e.clientY);
    dnd.clear();
    setDragging(false);
    setOver(null); setInto(false); setInvalid(false);
    clearTimeout(expandTimer.current);
    if (it.invalid) return;                       // 搬进自己 / 自己的子目录：静默忽略
    /* ⚠️ **必须先看层级**，再决定是重排还是搬。
       早先不管层级一律调 reorder(from, toRel, after)，而 reorder 是按
       **from 自己那一层**（parentOf(from)）算顺序的 ——
       把根层的 a.md 拖到 `B/x.md` 那一行上时，toRel 根本不在根层那一列里，
       moveInLevel 的 `out.indexOf(to) < 0` 分支把它**原样放回原位**，
       next === 原数组 → 「没动」直接 return。
       表现就是：线画得出来、位置也对，**放下去什么都不发生**
       （用户 2026-10-13 报「能拖动到对应位置，但没有实际作用」）。
       正确做法：落在别的层级上就是**搬进那个文件夹**，只是搬进去之后还要按
       上下半把位置定准 —— 这正是用户说的第 ② 种情况。 */
    const toLevel = parentOf(node.rel);
    if (it.into) dnd.moveInto(from, node.rel);
    else if (toLevel !== parentOf(from)) dnd.moveIntoAt(from, toLevel, node.rel, it.after);
    else dnd.reorder(from, node.rel, it.after);
  };

  return (
    <div className="node">
      <div
        className={"row" + (active === node.rel ? " active" : "")
          + (dragging ? " dragging" : "")
          + (over === "before" ? " drop-before" : "")
          + (over === "after" ? " drop-after" : "")
          + (into ? " drop-into" : "")
          + (invalid ? " drop-invalid" : "")}
        data-rel={node.rel}
        draggable={canDrag && !dnd.readOnly}
        onDragStart={onDragStart}
        onDragEnd={() => { setDragging(false); clearTimeout(expandTimer.current);
          if (dnd) { dnd.clear(); setOver(null); setInto(false); setInvalid(false); } }}
        onDragOver={onDragOver}
        /* ⚠️ `relatedTarget` 在行**内部**（移到 .name / .icon 上）时要当作
           没离开 —— 不判的话每在行内挪一下就 fire 一次 dragleave，
           落点线会跟着闪。浏览器正是靠它区分「离开这一行」和「进这一行的子元素」。 */
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget)) return;
          setOver(null); setInto(false); setInvalid(false);
          clearTimeout(expandTimer.current);
        }}
        onDrop={onDrop}
        /* 缩进步长 16（--indent）、顶层左边距 10（--indent-first）。
           原来是 14+8：一级父子之间只差 14px，测试用目录 和它下面的子项
           看着像并列而不是父子。 */
        /* paddingLeft 管缩进，--row-indent 把同一个值再喂给 CSS：
           落点横线是 absolute 定位的，**padding 不偏移绝对定位的元素**
           （包含块是 padding box，left:0 就是 padding 的起点），
           所以横线不缩进的话，拖进子目录时那条线还是顶在最左边 ——
           和它标记的那一行对不上（用户 2026-10-13 提的）。
           同一个数只能写在一处，所以这里算好一次、两个用途。 */
        style={{
          paddingLeft: INDENT_FIRST + depth * INDENT,
          "--row-indent": INDENT_FIRST + depth * INDENT + "px",
        }}
        onClick={() => (node.type === "dir" ? setOpen((o) => !o) : openFile(node))}
        onContextMenu={(e) => {
          e.preventDefault();
          onMenu({ x: e.clientX, y: e.clientY, node });
        }}
      >
        {node.type === "dir" ? (
          /* 静止是文件夹图标，hover 时交叉淡入成折叠箭头（见 .icon.dir）。
             自定义图标放在同一个 18px 盒子里，hover 也一样让位给折叠箭头。 */
          <span className={"icon dir" + (open ? " open" : "")}>
            <CustomIcon icon={icon} fallback={open ? ICONS.folderOpen : ICONS.dir} />
            <span className="fold-chev">{open ? ICONS.chevD : ICONS.chevR}</span>
          </span>
        ) : (
          <span className="icon file"><CustomIcon icon={icon} fallback={ICONS.fileText} /></span>
        )}
        <span className="name">{active === node.rel && activeName ? dispName(activeName) : dispName(node.name)}</span>
        <span className="row-actions">
          {/* 文件夹行不再放「新建文件夹」：新建统一走右键 / 三点菜单 */}
          <button title="更多" onClick={(e) => { e.stopPropagation(); onMenu({ x: e.clientX, y: e.clientY, node }); }}>{ICONS.menu}</button>
        </span>
      </div>

      {/* 文件夹的展开/收起走 Drawer：收起态子树不挂载（保持原来的性能），
          只在动画那 220ms 里挂上去量高度。展开状态的取舍和动画都在 Drawer 里，
          这里只管传 open。*/}
      {node.type === "dir" && (
        <Drawer open={open}>
          <div className="children">
          {node.children.length === 0 && (
            <div className="empty-row" style={{ paddingLeft: INDENT_FIRST + (depth + 1) * INDENT }} onClick={() => onCreate(node, "file")}>
              ＋ 新建笔记
            </div>
          )}
          {node.children.map((c) => (
            <FileTree key={c.rel} node={c} depth={depth + 1} root={root} openFile={openFile}
              active={active} onCreate={onCreate} onDelete={onDelete}
              onMenu={onMenu} activeName={activeName} icons={icons} dnd={dnd} />
          ))}
          </div>
        </Drawer>
      )}
    </div>
  );
}

function flatten(nodes, acc = []) {
  for (const n of nodes) {
    if (n.type === "dir") flatten(n.children, acc);
    else acc.push(n);
  }
  return acc;
}

/**
 * 按 rel 在树里找节点（目录也找得到）。独立窗口自动打开那篇时用。
 *
 * ⚠️ `/api/tree` 的形状是 `{root, folders, files}`，**没有 nodes 字段** ——
 * 文件直接挂在 files 里，目录的 children 才是嵌套的。
 * （写之前按 `{nodes:[...]}` 想当然过一次，结果永远找不到、静默停在空壳上。）
 */
function findNodeByRel(tree, rel) {
  const walkDirs = (dirs) => {
    for (const d of dirs || []) {
      if (d.rel === rel) return d;
      const hit = walkDirs(d.children);
      if (hit) return hit;
    }
    return null;
  };
  const walkFiles = (files) => {
    for (const f of files || []) {
      if (f.rel === rel) return f;
      if (f.type === "dir") {
        const hit = walkFiles(f.children);
        if (hit) return hit;
      }
    }
    return null;
  };
  if (!tree) return null;
  return walkFiles(tree.files) || walkDirs(tree.folders);
}

// 快速搜索面板（图 2）：顶部输入框 + 最近 + 导航
function SearchPalette({ files, recent, onOpen, onNav, onClose }) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const key = q.trim().toLowerCase();
  const hits = (key
    ? files.filter((f) => (f.name || "").toLowerCase().includes(key))
    : files
  ).slice(0, 8);
  const recents = recent.slice(0, 5);
  const rows = key ? hits : recents;
  useEffect(() => { setIdx(0); }, [q]);
  const fmtTime = (ts) => {
    const d = new Date(ts);
    const p2 = (n) => String(n).padStart(2, "0");
    const today = new Date();
    const same = d.toDateString() === today.toDateString();
    return same
      ? `今天 ${p2(d.getHours())}:${p2(d.getMinutes())}`
      : `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  };
  const run = (r) => {
    if (!r) return;
    if (r.__nav) { onNav(r.rel); onClose(); return; }
    onOpen(r);
    onClose();
  };
  return (
    <div className="sp-mask" onMouseDown={onClose}>
      <div className="sp" onMouseDown={(e) => e.stopPropagation()}>
        <div className="sp-head">
          <input className="sp-input" autoFocus value={q} spellCheck={false}
            placeholder="搜索文档或粘贴链接 …" aria-label="搜索文档"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") { e.preventDefault(); onClose(); }
              else if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(i + 1, rows.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
              else if (e.key === "Enter") { e.preventDefault(); run(rows[idx]); }
            }} />
        </div>
        <div className="sp-body">
          {key ? (
            rows.length ? (
              <>
                <div className="sp-label">结果</div>
                {rows.map((f, i) => (
                  <div key={f.rel} className={"sp-row" + (i === idx ? " on" : "")} onMouseEnter={() => setIdx(i)}
                    onClick={() => run(f)}>
                    <span className="sp-ico">{ICONS.fileText}</span>
                    <span className="sp-name">{dispName(f.name)}</span>
                    <span className="sp-meta">{f.rel.includes("/") ? f.rel.slice(0, f.rel.lastIndexOf("/")) : ""}</span>
                  </div>
                ))}
              </>
            ) : <div className="sp-empty">没有匹配的文档</div>
          ) : (
            <>
              <div className="sp-label">最近</div>
              {recents.length ? recents.map((r, i) => (
                <div key={r.rel} className={"sp-row" + (i === idx ? " on" : "")} onMouseEnter={() => setIdx(i)}
                  onClick={() => run(r)}>
                  <span className="sp-ico">{ICONS.fileText}</span>
                  <span className="sp-name">{dispName(r.name)}</span>
                  <span className="sp-time">{fmtTime(r.ts)}</span>
                </div>
              )) : <div className="sp-empty">还没有打开过文档</div>}
              <div className="sp-label">导航</div>
              {NAV_ITEMS.map((it) => (
                <div key={it.rel} className="sp-row" onClick={() => { onNav(it.rel); onClose(); }}>
                  <span className="sp-ico">{it.icon}</span>
                  <span className="sp-name">{it.label}</span>
                  <span className="sp-arrow">{ICONS.chevR}</span>
                </div>
              ))}
            </>
          )}
        </div>
        <div className="sp-foot">↑↓ 选择 · 回车打开 · Esc 关闭</div>
      </div>
    </div>
  );
}

const NAV_ITEMS = [
  { rel: "__all__", label: "前往所有文档", icon: ICONS.fileText },
  { rel: "__notes__", label: "前往「笔记」分组", icon: ICONS.dir },
  { rel: "__trash__", label: "前往回收站", icon: ICONS.trash },
];

// 回收站列表上的时间：刚刚 / N 分钟前 / N 小时前 / M 月 D 日
function fmtAgo(ts) {
  const d = Date.now() - ts;
  if (d < 60e3) return "刚刚";
  if (d < 3600e3) return `${Math.floor(d / 60e3)} 分钟前`;
  if (d < 86400e3) return `${Math.floor(d / 3600e3)} 小时前`;
  const t = new Date(ts);
  return `${t.getMonth() + 1} 月 ${t.getDate()} 日`;
}

// 重命名：贴着那一行弹出的输入框（图标按钮 + 输入框）
// 前面那个图标同时是「改图标」的入口：点一下在原位弹图标选择器，
// 改完重命名卡片还在，可以接着改名（见 App 里 renameNode + iconNode 的关系）。
const RENAME_ICONS = { file: ICONS.fileText, dir: ICONS.dir };
function RenameCard({ node, rect, icon, onIcon, onCancel, onSubmit }) {
  const [val, setVal] = useState(() => dispName(node.name));   // 去掉 .md 再显示
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = async () => {
    const name = val.trim().replace(/[\\/:*?"<>|]/g, "");
    if (!name) return;
    setBusy(true); setErr("");
    try {
      const base = node.rel.slice(0, node.rel.lastIndexOf("/") + 1);
      // 文件的 .md 是磁盘后缀，不让用户看到/维护
      await onSubmit(node, base + name + (node.type === "dir" ? "" : ".md"));
      onCancel();
    } catch (e) {
      setErr(e.message || String(e)); setBusy(false);
    }
  };
  // 贴着那一行：默认在下方，空间不够就翻到上方
  const below = rect ? rect.bottom + 4 : 120;
  const flip = rect && below + 52 > window.innerHeight;
  const style = rect ? {
    left: rect.left, top: flip ? Math.max(8, rect.top - 46) : below, width: Math.max(200, rect.width),
  } : undefined;
  return (
    <div className="rn-mask" onMouseDown={onCancel}>
      <div className="rn-card" style={style} onMouseDown={(e) => e.stopPropagation()}>
        {/* onMouseDown 要 preventDefault：不然按钮抢走焦点，
             下面 input 的 onBlur 会先把整张重命名卡片关掉 */}
        <button className={"rn-icon " + node.type}
          title={icon ? "更换图标" : "设置图标"}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onIcon(node, rect)}>
          <CustomIcon icon={icon} fallback={RENAME_ICONS[node.type] || ICONS.fileText} />
        </button>
        <input className="rn-input" autoFocus value={val} spellCheck={false} disabled={busy}
          placeholder={node.type === "dir" ? "文件夹名称" : "文档名称"}
          onChange={(e) => setVal(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={(e) => {
            if (busy) return;
            // 焦点跑到图标选择器里（筛选框）不算「改完了要收起」
            if (e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest(".icp")) return;
            onCancel();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); submit(); }
            else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
          }} />
        {err && <div className="rn-err">{err}</div>}
      </div>
    </div>
  );
}

// 图标选择器：贴着那一行弹出。版式照参考图 ——
// 顶部「表情符号 / 图标」两个页签 + 右边「移除」；下面是筛选框；
// 主体是分类小节（人物 / 手势 / …）；最底下钉一条「最近使用」。
// 存的是 {kind,value}：emoji 存字符本身，svg 存 ICONS 的 key。
const IconPicker = ({ node, rect, current, onCancel, onPick, out }) => {
  // 默认落在「当前图标」那一页，不然选了 emoji 之后打开还是图标页，看着像没设置上
  const [tab, setTab] = useState(current && current.kind === "emoji" ? "emoji" : "svg");
  const [q, setQ] = useState("");
  const [recent, setRecent] = useState(() => (uiPrefs.get().iconRecent || []).map(splitIconKey).filter(Boolean));
  // Esc 无论焦点在哪都关掉（和 SearchPalette 一样走 window 捕获阶段：
  // 焦点落在 emoji 网格的 button 上时，冒泡到卡片的 onKeyDown 是靠谱的，
  // 但筛选框里按 Esc 会先被输入框吃掉，所以还是挂 window）
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); onCancel(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  const isOn = (kind, value) => current && current.kind === kind && current.value === value;
  // 先挑颜色再挑图标：颜色存 pending，等点图标时一起提交
  const [pendingColor, setPendingColor] = useState("");
  // 空字符串就是「跟随主题」，高亮时统一归一成 "auto"，否则第一格永远选不亮
  const curColor = current && current.kind === "svg" ? current.color || "auto" : "";
  const pick = (kind, value, color, keepOpen) => {
    // curColor 已经归一成 "auto"，落盘前转回空串
    let c = "";
    if (kind === "svg") {
      const raw = color !== undefined ? color : (pendingColor || curColor);
      c = raw === "auto" ? "" : raw;
    }
    if (value) pushRecentIcon(kind, value, c);   // 「移除」不记进最近使用
    setPendingColor("");
    setRecent((uiPrefs.get().iconRecent || []).map(splitIconKey).filter(Boolean));
    onPick(node, kind, value, c, keepOpen);
  };
  // 已经选了图标就直接改色；还没选就存着，等下一枚图标
  const pickColor = (key) => {
    // 已经选了图标就直接改色（选择器留着，方便连着试），没选就先存着，等下一枚图标
    if (current && current.kind === "svg") {
      const c = key === "auto" ? "" : key;
      pushRecentIcon("svg", current.value, c);
      setRecent((uiPrefs.get().iconRecent || []).map(splitIconKey).filter(Boolean));
      onPick(node, "svg", current.value, c, true);
    } else {
      setPendingColor(key);
    }
  };

  // 卡片比行高得多，翻到上方的阈值也要跟着放大
  const CARD_H = 380;
  const below = rect ? rect.bottom + 4 : 120;
  const flip = rect && below + CARD_H > window.innerHeight;
  const style = rect ? {
    left: rect.left, top: flip ? Math.max(8, rect.top - CARD_H) : below,
    width: Math.max(268, rect.width),
  } : undefined;

  // 筛选：中文名 / pinyin 都不做，只按中文名、图标 key、emoji 本身匹配。
  // 图标页签还会搜 lucide 全量的英文名和标签（test -> test-tube / vitest…），
  // 和 lucide.dev 官网的搜索框一个思路。
  const kw = q.trim().toLowerCase();
  const hit = (em, name) => !kw || name.toLowerCase().includes(kw) || em.includes(kw);
  const cats = EMOJI_CATS.map((c) => ({ ...c, items: c.items.filter(([em, name]) => hit(em, name)) }))
    .filter((c) => c.items.length);
  const iconCats = ICON_CATS.map((c) => ({ ...c, items: c.items.filter((it) => hit(it.key, it.label)) }))
    .filter((c) => c.items.length);
  // 全量命中：1877 枚 + 别名，一次性全铺出来会卡，所以截断
  const ALL_CAP = 200;
  const allHits = kw && FULL.nodes
    ? Object.keys(FULL.nodes)
      .filter((k) => lucideSearchText(k).toLowerCase().includes(kw))
      .filter((k) => !PICK_ICON_KEYS.has(k))     // 内置的那 128 枚上面已经按分类显示过了
      .slice(0, ALL_CAP)
    : [];
  const allTotal = kw && FULL.nodes ? "…" : 0;
  // 表外的 emoji（输入框粘进来的、或者 _index.json 里手写的）：1~4 个码点
  const pasted = kw && [...kw].length <= 4 ? kw : "";
  const pastedOk = pasted && !cats.some((c) => c.items.some(([em]) => em === pasted))
    && !Object.values(EMOJI_CATS).some((c) => c.items.some(([em]) => em === pasted));

  return (
    <div className="rn-mask" onMouseDown={onCancel}>
      {/* 关键：除筛选框外一律 preventDefault，不让焦点离开（可能是）重命名输入框。
          之前只 stopPropagation，结果在选择器里点一下 → 输入框 blur → RenameCard 的
          onBlur 把整张重命名卡片关了，改完图标连改名都接着做不了。 */}
      <div className={"icp" + (out ? " icp-out" : "")} style={style}
        onMouseDown={(e) => {
          e.stopPropagation();
          if (!e.target.closest(".icp-find")) e.preventDefault();
        }}>
        <div className="icp-tabs">
          <button className={"icp-tab" + (tab === "emoji" ? " on" : "")} onClick={() => setTab("emoji")}>表情符号</button>
          <button className={"icp-tab" + (tab === "svg" ? " on" : "")} onClick={() => setTab("svg")}>图标</button>
          <button className="icp-rm" disabled={!current}
            title={current ? "恢复默认图标" : "当前是默认图标"}
            onClick={() => pick(current.kind, "")}>移除</button>
        </div>

        <div className="icp-find">
          <span className="icp-find-ic">{ICONS.search}</span>
          {/* 聚焦就预热全量：1877 枚 + 标签是独立 chunk，拉完再打字就不用等 */}
          <input value={q} placeholder="筛选…" spellCheck={false}
            onFocus={loadLucideAll}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && pastedOk) pick("emoji", pasted); }} />
          {q && <button className="icp-clear" onClick={() => setQ("")}>{ICONS.x}</button>}
        </div>

        {/* 配色只对 svg 有意义，emoji 页签不显示。
            「先挑颜色后挑图标」也支持：还没设图标时点色块只记住，点图标时一起生效。 */}
        {tab === "svg" && (
          <div className="icp-colors">
            <div className="icp-cat-n">颜色</div>
            <div className="icp-swatches">
              {ICON_COLORS.map((c) => (
                <button key={c.key} title={c.label}
                  className={"icp-sw" + ((pendingColor || curColor || "auto") === c.key ? " on" : "")}
                  onClick={() => pickColor(c.key)}>
                  {c.hex
                    ? <span className="icp-sw-dot" style={{ background: c.hex }} />
                    : <span className="icp-sw-auto">{ICONS.check}</span>}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="icp-body">
          {tab === "emoji" ? (
            pastedOk
              ? <button className="icp-paste" onClick={() => pick("emoji", pasted)}>
                  用这个 <span className="ic-emoji">{pasted}</span>
                </button>
              : null
          ) : null}

          {tab === "emoji" ? (
            cats.length === 0
              ? <div className="icp-none">没有匹配的 emoji</div>
              : cats.map((c) => (
                <div className="icp-cat" key={c.name}>
                  <div className="icp-cat-n">{c.name}</div>
                  <div className="icp-grid em">
                    {c.items.map(([em, name]) => (
                      <button key={c.name + "|" + em} className={"icp-cell em" + (isOn("emoji", em) ? " on" : "")}
                        title={name} onClick={() => pick("emoji", em)}>{em}</button>
                    ))}
                  </div>
                </div>
              ))
          ) : (
            <div className="icp-pane">
              {kw && allHits.length > 0 && (
                <div className="icp-cat">
                  <div className="icp-cat-n">
                    lucide 全量（{allHits.length}{allHits.length >= ALL_CAP ? "+" : ""}）
                  </div>
                  <div className="icp-grid em">
                    {allHits.map((k) => (
                      <button key={"all:" + k}
                        className={"icp-cell" + (isOn("svg", k) ? " on" : "")}
                        title={k} onClick={() => pick("svg", k, pendingColor || curColor)}>
                        <Lucide els={FULL.nodes[k]} />
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {iconCats.length === 0 && allHits.length === 0
                ? (kw && !FULL.nodes
                  ? <div className="icp-none">正在载入 lucide 全量图标…</div>
                  : <div className="icp-none">没有匹配的图标</div>)
                : iconCats.map((c) => (
                  <div className="icp-cat" key={c.name}>
                    <div className="icp-cat-n">{c.name}</div>
                    <div className="icp-grid em">
                      {c.items.map((it) => (
                        <button key={c.name + "|" + it.key} className={"icp-cell" + (isOn("svg", it.key) ? " on" : "")}
                          title={it.label} onClick={() => pick("svg", it.key, pendingColor || curColor)}>
                          {/* vb 要带：Blanc logo 是 1024×1024 的坐标系，
                              不给就用默认的 24×24，会被裁掉一大块 */}
                          <Lucide els={it.els} vb={it.vb} />
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
            </div>
          )}
        </div>

        {recent.length > 0 && (
          <div className="icp-recent">
            <div className="icp-cat-n">最近使用</div>
            {/* 用 em 这一档高度（emoji 和 svg 都按 34px），不然混着 svg 时格子会高一截 */}
            <div className="icp-grid em">
              {recent.map((r, i) => (
                <button key={iconKey(r.kind, r.value) + i}
                  className={"icp-cell em" + (isOn(r.kind, r.value) ? " on" : "")}
                  title={r.kind === "svg" ? iconInfo(r.value, r.color).label : r.value}
                  onClick={() => pick(r.kind, r.value, r.color)}>
                  {r.kind === "svg"
                    ? iconByKey(r.value, r.color)
                    : <span className="ic-emoji">{r.value}</span>}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="icp-hint">Esc 关闭 · 点空白处取消</div>
      </div>
    </div>
  );
};

/* 写入冲突：同一篇在别处被改过了。
 *
 * 为什么必须让用户选：两条路各丢一边的东西 ——
 *   覆盖 = 丢「对方」（另一个窗口，或用户拿别的编辑器存的那份）
 *   丢弃 = 丢「我自己」（在编辑器里敲了半天的东西）
 * 程序没有资格替人做这个决定，所以**不自动选、不自动合并**。
 * 并排摆出来是为了让用户至少看得见自己在丢什么。 */
function ConflictDialog({ c, onClose }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [side, setSide] = useState("mine");
  const run = async (fn) => {
    setBusy(true); setErr("");
    try { await fn(); onClose(); } catch (e) { setErr(e?.message || String(e)); setBusy(false); }
  };
  const text = side === "mine" ? c.mine : c.theirs;
  return (
    <div className="dlg-mask">
      <div className="dlg cfl-dlg">
        <div className="dlg-title">这篇已被其它地方修改</div>
        <div className="dlg-msg">
          「{c.rel}」在你编辑期间被别处改过了（多半是另一个窗口）。
          继续保存会覆盖对方那份。挑一边吧 —— <b>程序不会替你合并</b>。
        </div>
        <div className="cfl-tabs">
          <button className={side === "mine" ? "on" : ""} onClick={() => setSide("mine")}>
            我这份（未保存）
          </button>
          <button className={side === "theirs" ? "on" : ""} onClick={() => setSide("theirs")}>
            磁盘上那份
          </button>
        </div>
        <pre className="cfl-body">{text || "（空）"}</pre>
        {err && <div className="dlg-err">{err}</div>}
        <div className="dlg-btns">
          <button onClick={onClose} disabled={busy}>先不处理</button>
          {/* 「以磁盘为准」= 放弃我的编辑，重新读一遍文件。
              走的是**重新打开这篇**（key 变 → EditorPane 整体重建），
              而不是热替换编辑器内容 —— 重建这条路径本来就有，不会出岔子。 */}
          <button onClick={() => run(() => c.reload?.())} disabled={busy}>
            以磁盘为准
          </button>
          <button className="primary" onClick={() => run(() => c.force?.())} disabled={busy}>
            以我的为准（覆盖）
          </button>
        </div>
      </div>
    </div>
  );
}

function Dialog({ dlg, onClose, out }) {
  const [val, setVal] = useState(dlg.value || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const ok = async () => {
    if (dlg.type === "input" && !val.trim()) return;
    setBusy(true); setErr("");
    try {
      await dlg.onOk(dlg.type === "input" ? val.trim() : undefined);
      onClose();
    } catch (e) {
      setErr(e.message || String(e)); setBusy(false);
    }
  };
  return (
    <div className={"dlg-mask" + (out ? " dlg-mask-out" : "")}
onMouseDown={(e) => { if (e.target === e.currentTarget) { dlg.onCancel?.(); onClose(); } }}>
      <div className="dlg">
        <div className="dlg-title">{dlg.title}</div>
        {dlg.type === "input" ? (
          <>
            <div className="dlg-label">{dlg.label}</div>
            <input className="dlg-input" autoFocus value={val} placeholder={dlg.placeholder}
              onChange={(e) => setVal(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && ok()} />
          </>
        ) : (
          <>
            {dlg.path && <div className="dlg-path">{dlg.path}</div>}
            <div className="dlg-msg">{dlg.message}</div>
          </>
        )}
        {err && <div className="dlg-err">{err}</div>}
        <div className="dlg-btns">
          {/* 可选的第三种动作（2026-10-18「以后不再提示」）。
             不做成三选一的按钮组：那条语义是「永久关掉这类询问」，
             跟「这一次的取舍」不是一回事，混在一起容易点错。 */}
          {dlg.extraLabel && <button className="ghost" onClick={() => { dlg.onExtra?.(); onClose(); }}>{dlg.extraLabel}</button>}
          <button onClick={() => { dlg.onCancel?.(); onClose(); }}>取消</button>
          <button className={dlg.danger ? "danger" : "primary"} disabled={busy} onClick={ok}>
            {dlg.confirmLabel || "确定"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* 设置面板。
 * 分组可见性**故意只放在这里**、不放右键菜单：
 *   · 它是跨会话的粘性偏好，不是「针对某条笔记」的内容操作
 *   · 两处都能改同一份状态就会各自持有写入口，出现「设置里开了、右键菜单还显示隐藏」这类不一致
 *   · 右键容易误触，而「分组消失且没有痕迹」在用户看来非常像数据丢了 —— 代价不对称
 * 真要加右键的信号是分组数量涨到十几个（届时再配一个带「撤销」的 toast）。
 * 开关一律即时生效，不设「应用 / 取消」：这类开关一旦要确认反而更烦。
 * 侧栏分组就三行，直接写死在这里，不再抽成配置数组 —— 三个区各带不同的
 * 控件类型（开关 / 分段 / 开关），抽成统一 schema 反而比 JSX 更绕。
 */
const SIDE_SEC_ITEMS = [
  { key: "recent", label: "最近", desc: "近 7 天打开过的笔记快捷入口" },
  { key: "notes", label: "笔记", desc: "当前知识库的完整目录。隐藏后搜索仍能搜到这里的文件" },
  { key: "other", label: "其它", desc: "隐藏后回收站也一起消失，删掉的文件要先在这里放回来", warn: "包含回收站" },
];

const ED_FONTS = [15, 16, 17, 18];

/* 配色方案（#13）。和明暗（#12）是**两个维度**：
   data-theme 决定用亮变体还是暗变体，data-palette 决定用哪一族色 ——
   所以「米色 + 跟随系统」是米色的暗色版，不是默认色的暗色版。 */
const PALETTES = [
  { key: "paper", label: "纸白", swatch: ["#ffffff", "#f7f6f3", "#37352f"], dark: ["#191918", "#202020", "#e6e4de"] },
  { key: "sepia", label: "米色", swatch: ["#fdfaf1", "#efe7d5", "#4a3f2c"], dark: ["#262117", "#2b2519", "#ece3cf"] },
  { key: "slate", label: "冷灰", swatch: ["#ffffff", "#eef1f3", "#2b3238"], dark: ["#1b2023", "#1f2529", "#e3e8ec"] },
];

/* 夜间模式三档（#12）。系统那档靠 matchMedia 实时跟，不刷新页面。 */
const THEME_MODES = [
  { key: "auto", label: "跟随系统", hint: "系统切换时实时跟着变" },
  { key: "light", label: "亮色", hint: "" },
  { key: "dark", label: "暗色", hint: "" },
];

/* 段落间距四档（2026-10-13 用户要的，形态照正文字号那一套）。
   值是**上下各一份**的 padding，所以段与段之间的实际间隔是它的两倍 ——
   label 里直接写了实际间隔，免得用户以为「选 8 就是隔 8px」。
   标准档 = Crepe 的原值（`p { padding: 4px 0 }`），保持默认观感不变。
   为什么是 2/4/8/12 而不是等差：4→8 是用户自己试出来想要的那一档，
   等差（2/4/6/8）里没有它，单独拉出来做一档更值。 */
const ED_SPACING = [
  { pad: 2, label: "紧凑", sub: "4px" },
  { pad: 4, label: "标准", sub: "8px" },
  { pad: 8, label: "宽松", sub: "16px" },
  { pad: 12, label: "极松", sub: "24px" },
];
const ED_SPACING_PAD = ED_SPACING.map((x) => x.pad);

/* 右下角那枚胶囊里「文字统计」显示哪几项。多选：三个单位可以任意组合，
   只想要字数就单选字数，想要字数+词数就点两个。全不选 = 统计那半不显示
   （和「保存状态」关掉是一个效果），所以不用再单开一个「隐藏」开关位。
   渲染顺序永远按这个数组的顺序，跟点击顺序无关。 */
const STATS_ITEMS = [
  { key: "charsNoSpace", label: "字数" },
  { key: "words", label: "词数" },
  { key: "chars", label: "字符数" },
];
const STATS_UNIT = { charsNoSpace: "字", words: "词", chars: "字符" };
// 存进 state 的数组一律是这个顺序 —— 勾选顺序可能乱，渲染顺序不能跟着乱。
const ALL_STATS_KEYS = STATS_ITEMS.map((m) => m.key);

/* 字数统计的投递口（2026-10-21）。
 *
 * 原来 `stats` 是 App 的 state，而 EditorPane 每**击一次键**就 onStats 一次 ——
 * 也就是每敲一个字，整棵 App（侧栏整棵树 + 顶栏 + 正文壳）都要重渲染一遍。
 * 大库里这一下是 5–15ms，直接压在打字延迟上，而真正需要更新的只有右下角那半颗胶囊。
 *
 * 现在值存在模块里，DocStats 自己订阅：EditorPane 照旧每次喂，
 * 但只有胶囊重渲染。value 留一份是为了胶囊后挂载（用户刚在设置里勾上统计）时
 * 能立刻显示上一次算好的数，而不是先空着等下一次击键。 */
const EMPTY_STATS = { words: 0, chars: 0, charsNoSpace: 0 };
const statsBox = { value: EMPTY_STATS, push: null };
const pushStats = (s) => {
  statsBox.value = s;
  if (statsBox.push) statsBox.push(s);
};

/* 右下角那半颗胶囊：字数 / 词数 / 字符数。
   单独成组件就是为了让上面那条「每次击键只重渲染这一小块」成立。 */
function DocStats({ units }) {
  const [stats, setStats] = useState(statsBox.value);
  useEffect(() => {
    statsBox.push = setStats;
    // 订阅间隙里可能已经算过一次（比如组件刚挂载），补上
    if (statsBox.value !== stats) setStats(statsBox.value);
    return () => { if (statsBox.push === setStats) statsBox.push = null; };
  }, []);                                     // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <span className="doc-stats" title={`${units.map((k) => STATS_UNIT[k]).join(" · ")}（词数按中英混排估算）`}>
      {ALL_STATS_KEYS.filter((k) => units.includes(k))
        .map((k) => `${stats[k]} ${STATS_UNIT[k]}`).join(" · ")}
    </span>
  );
}

/* 编辑器 chunk 还没解析完时的占位。
   宽度/留白对齐真实正文（styles.css 的 --ed-maxw / --ed-gutter，和 .editor-pad
   同一套，全宽时同一条覆盖），换上来的时候不跳；
   故意不做呼吸动画 —— 本机是打包后的本地文件，通常一两帧就换掉了，
   闪一下比静止更扎眼。 */
function EditorSkeleton() {
  return (
    <div className="editor-skeleton" aria-hidden="true">
      <div className="es-title" />
      <div className="es-line" style={{ width: "78%" }} />
      <div className="es-line" style={{ width: "92%" }} />
      <div className="es-line" style={{ width: "61%" }} />
    </div>
  );
}

/* 偏好迁移，三代：
   ① docStats 数组 —— 现在的形状。
   ② docStatsMode 字符串 —— 中间那版单选（"off" / 单个 key），本机 localStorage 里可能还留着。
   ③ showDocStats 布尔 —— 发出去的版本，只有开/关，默认开时显示全部三项。
   ④ 什么都没存 → 和 ③ 的默认一致（全部三项），别让老用户一升级就少两项。 */
const readDocStats = () => {
  const p = uiPrefs.get();
  const valid = (a) => a.filter((k) => STATS_ITEMS.some((m) => m.key === k));
  if (Array.isArray(p.docStats)) return valid(p.docStats);
  if (p.docStatsMode) {
    if (p.docStatsMode === "off") return [];
    if (STATS_ITEMS.some((m) => m.key === p.docStatsMode)) return [p.docStatsMode];
  }
  return p.showDocStats === false ? [] : STATS_ITEMS.map((m) => m.key);
};

/* 设置面板里的一行开关。开关本体只负责画，点击热区是铺满整行的 .set-row-hit ——
   点描述文字也能切，不用精确点那个 26px 的小开关。 */
function SwitchRow({ on, onChange, label, desc, note, warn }) {
  return (
    <div className={"set-row" + (warn ? " warn" : "")}>
      <button className="set-row-hit" onClick={() => onChange(!on)}
        role="switch" aria-checked={on} aria-label={label} />
      <span className="set-row-main">
        <span className="set-row-label">
          {label}
          {note && <span className="set-row-note">{note}</span>}
        </span>
        {desc && <span className="set-row-desc">{desc}</span>}
      </span>
      <span className={"set-switch" + (on ? " on" : "")} aria-hidden="true"><i /></span>
    </div>
  );
}

/* 顶栏三点菜单里的一行：左边标题，右边开关（复用设置面板那枚 .set-switch，
   两处同款，不然同一件事在两个界面里长成两个样）。disabled = 预埋项：
   画出来但不响应，右端标「待做」，让人知道是还没做而不是坏了。 */
/* ⚠️ `disabled` 和 `locked` 是两回事，别混用：
 *   disabled —— 还没做，右侧挂「待做」标签（预留项用）
 *   locked   —— 做得了，但此刻被**别的东西接管了**，开关点不动。
 *               视觉上要保留开关的形状（不然用户以为这一项坏了），
 *               只是整体变淡、开关强制呈「关」。
 * 迷你模式开着时大纲/导航条就是 locked：它们不是没做，是被替代了。 */
function TbToggleRow({ on, onChange, label, desc, icon, disabled, locked }) {
  return (
    <div className={"tb-item" + (disabled ? " off" : "") + (locked ? " locked" : "")}>
      <span className="tb-ic" aria-hidden="true">{icon}</span>
      <span className="tb-lbl">
        {label}
        {desc && <span className="tb-desc">{desc}</span>}
      </span>
      {disabled
        ? <span className="tb-soon">待做</span>
        : (
          /* 整行都是命中区：真开关塞 .set-switch 的盒子里，::before 铺满整行。
             和设置面板 .set-row-hit 一个路子 —— 点标题也能切。 */
          /* locked 用原生 disabled：浏览器直接吞掉点击，
             比「onClick 里判断再 return」可靠（那样键盘 Enter 仍进得来）。 */
          <button className="tb-hit" role="switch" aria-checked={locked ? false : on}
            aria-label={label} disabled={locked || undefined}
            onClick={() => onChange(!on)} />
        )}
      {!disabled && <span className={"set-switch" + (on ? " on" : "")} aria-hidden="true"><i /></span>}
    </div>
  );
}

/* 一行带二级子菜单的条目。子菜单**横向向左**飞出（right:100%）——
   主菜单贴着窗口右缘，往右飞会直接飞出屏幕。
   靠 .tb-sub-wrap 的 :hover / :focus-within 开关，不用 JS 管开合：
   指针从主菜单移到子菜单的路径全程都在 wrap 的命中区内（子菜单是它的子元素，
   且中间那 6px 的缝用 padding 补上），不会中途断掉。 */
function TbSubRow({ label, icon, children }) {
  return (
    <div className="tb-sub-wrap">
      <div className="tb-item" tabIndex={0} role="menuitem" aria-haspopup="true">
        <span className="tb-ic" aria-hidden="true">{icon}</span>
        <span className="tb-lbl">{label}</span>
        <span className="tb-chev" aria-hidden="true">{ICONS.chevR}</span>
      </div>
      <div className="tb-sub" role="menu">{children}</div>
    </div>
  );
}

/* 文字统计的勾选逻辑 —— **顶栏三点菜单和设置面板共用这一个组件**。
   两边各写一份的话，改了一边忘了另一边，用户要的「保持一致」就白说了。
   optCls / allCls 让同一份逻辑渲染成两种皮：
     · 顶栏   optCls="tb-opt"（样式挂在 .tb-opt 上）
     · 设置   optCls="" + 外层 .set-seg.multi（样式挂在 .set-seg button 上，
               选中态靠 .on，总闸那一颗额外挂 .all 拿那 4px 分隔间距） */
function StatsPicker({ value, onChange, optCls, allCls }) {
  const all = value.length === ALL_STATS_KEYS.length;
  return (
    <>
      {/* ⚠️ 三段拼 class 必须各自带前导空格，否则会拼成 "onall" ——
          .set-seg.multi > button.all 那条就匹配不上了（分隔间距失效）。 */}
      <button className={[optCls, all ? "on" : "", allCls].filter(Boolean).join(" ")}
        onClick={() => onChange(all ? [] : ALL_STATS_KEYS)}>全部</button>
      {STATS_ITEMS.map((m) => (
        <button key={m.key} className={optCls + (value.includes(m.key) ? " on" : "")}
          onClick={() => onChange(value.includes(m.key)
            ? value.filter((k) => k !== m.key)
            : ALL_STATS_KEYS.filter((k) => value.includes(k) || k === m.key))}>{m.label}</button>
      ))}
    </>
  );
}

/* 顶栏三点菜单里的一行**动作**（不是开关）：点一下做件事，右端带快捷键提示。
   和 TbToggleRow 分开是因为语义不同 —— 一个改变持久状态，一个只是打开一个框。 */
/* ⚠️ desc 和 hint 不是一个东西，别混用：
     · hint  = `.tb-hint` 是 `flex:0 0 auto`，排在标题**右边同一行**
                —— 只配「⌘F / ⌘R」这种快捷键提示（本来就该横排）
     · desc  = `.tb-desc` 是 `display:block`，标题下**另起一行**
                —— 配「外观 / 侧栏 / 编辑器 / 快捷键」这种说明文字
     之前拿 hint 塞说明，两段文字挤在一行上，读起来是「设置外观 / 侧栏…」连成一坨。 */
function TbItem({ icon, label, desc, hint, onClick }) {
  return (
    <button className="tb-item act" onClick={onClick}>
      <span className="tb-ic" aria-hidden="true">{icon}</span>
      <span className="tb-lbl">
        {label}
        {desc && <span className="tb-desc">{desc}</span>}
      </span>
      {hint && <span className="tb-hint">{hint}</span>}
    </button>
  );
}

/* 顶栏三点菜单。分两组：显示（右侧那几样东西显不显示）+ 视图（排版类的），
   中间一条分割线。字号和锁定是**真的接上了**，宽屏仍预埋
   （对应 `需求清单-2026-10-13.md` 的 #7 / #8）。 */
function TopMenu({ out, showOutline, onOutline, showRail, onRail, showMini, onMini, showSaveFlag, onSaveFlag,
                    docStats, onDocStats, edFont, onFont, edSpacing, onSpacing, wide, onWide, readOnly, onLock, onFind,
                    showProps, onShowProps, sideHidden, onBackToLibrary, onOpenSettings }) {
  return (
    /* out：退场那 110ms 里加 .tb-drop-out 播淡出。和侧栏那两个面板走同一套
       （PANEL_OUT_MS = 110 与 CSS 的 .11s 对齐）—— 直接卸载来不及播动画。 */
    <div className={"tb-drop" + (out ? " tb-drop-out" : "")} role="menu">
      {/* 两条动作项放最上面，和下面的「显示 / 视图」那两排开关分开：
            · 设置 —— **一直都在**。原先入口只在侧栏底栏，侧栏收着就得先展开、
              外部文件时更是完全打不开。放这儿是哪条路都够得着。
            · 回到知识库 —— 只在侧栏被拿掉时出现（外部文件），
              那时正文顶到左缘、没有侧栏可以回库，这里是唯一一条看得见的退路。
          两者都不占工具位：那个位置除了红绿灯让位之外不该塞东西。 */}
      <TbItem icon={ICONS.gear} label="设置" desc="外观 / 侧栏 / 编辑器 / 快捷键"
        onClick={onOpenSettings} />
      {sideHidden && (
        <TbItem icon={ICONS.chevLeft} label="回到知识库"
          desc="打开最近一篇库内笔记" onClick={onBackToLibrary} />
      )}
      {/* 「索引」单列一组：这三项摆的是**同一块屏幕**（右缘），
          拆散到「显示」里会和属性头/保存状态混在一起，看不出它们互相牵制。
          迷你模式是另一种**形态**而不是第三个叠加开关 —— 开它之后刻度轨和大纲面板
          都不渲染，所以那两项这时是 locked（点不动），而不是悄悄改掉它们的值：
          关掉迷你模式，原来的设置原样回来。 */}
      <div className="tb-sec">索引</div>
      <TbToggleRow on={showMini} onChange={onMini} icon={ICONS.mini} label="迷你模式"
        desc="右缘换成短索引条，悬停出片段预览" />
      <TbToggleRow on={showOutline} onChange={onOutline} icon={ICONS.list} locked={showMini}
        label="大纲" desc={showMini ? "迷你模式开着时被替代" : (showRail ? "悬停导航条时弹出" : "常驻显示")} />
      <TbToggleRow on={showRail} onChange={onRail} icon={ICONS.bars} label="导航条"
        locked={showMini} desc={showMini ? "迷你模式开着时被替代" : undefined} />

      <div className="tb-sec">显示</div>
      <TbToggleRow on={showProps} onChange={onShowProps} icon={ICONS.list} label="属性头" />
      <TbToggleRow on={showSaveFlag} onChange={onSaveFlag} icon={ICONS.check} label="保存状态" />
      {/* 查找与替换（#4）：和 ⌘F / ⌘R 同一个开关，不是另开一处入口 */}
      <TbItem icon={ICONS.search} label="查找与替换"
        hint="⌘F / ⌘R" onClick={onFind} />
      <TbSubRow label="字数统计" icon={ICONS.hash}>
        <StatsPicker value={docStats} onChange={onDocStats} optCls="tb-opt" />
      </TbSubRow>

      <div className="tb-divider" />
      <div className="tb-sec">视图</div>
      <TbToggleRow on={wide} onChange={onWide} icon={ICONS.panel}
        label="全宽模式" desc="正文不限宽，铺满编辑区" />
      <TbToggleRow on={readOnly} onChange={onLock} icon={ICONS.lock} label="锁定" desc="锁住当前文档，不能编辑" />
      <TbSubRow label="正文字号" icon={ICONS.type}>
        {ED_FONTS.map((n) => (
          <button key={n} className={"tb-opt" + (n === edFont ? " on" : "")} onClick={() => onFont(n)}>
            {n}<span className="tb-opt-u">px</span>
          </button>
        ))}
      </TbSubRow>
      {/* 段落间距。和正文字号并排放在「视图」这一组末尾 —— 都是排版类的，
          不该塞进「显示」那一组（那组管的是显不显示）。 */}
      <TbSubRow label="段落间距" icon={ICONS.bars}>
        {ED_SPACING.map((x) => (
          <button key={x.pad} className={"tb-opt" + (x.pad === edSpacing ? " on" : "")}
            onClick={() => onSpacing(x.pad)} title={`段间隔 ${x.sub}`}>{x.label}</button>
        ))}
      </TbSubRow>
    </div>
  );
}

/* 设置面板的分区（#14 双栏）。左索引按这个顺序排；
   「快捷键」（#10）以后挂在这里 —— 加一节只是加一行，布局不用再动。 */
/* 设置面板的分区（#14 双栏）。三节：
     · 外观   主题 / 配色方案 —— 纯粹的「什么颜色」
     · 侧栏   分组常显 + 排序方式 —— 都作用在侧栏那一列上，
              排序放进侧栏当二级分组：它调的就是侧栏里条目的先后，
              单独占一节会和「侧栏」平级，看着像两件不相干的事
     · 编辑器 正文字号 / 段落间距 / 全宽模式 + 编辑行为 ——
              「尺寸」归这里而不是外观：它们改的是正文怎么排，不是什么颜色
   每节带一个图标 —— 左索引和右侧标题用同一个 `icon`，不用各画一套。 */
/* 快捷键清单（#10）。**只读**，不做自定义绑定。
   ⚠️ 这张表是「按下去验过的」，不是照抄代码也不是抄 tooltip：
     格式四项（⌘B/⌘I/⌥⌘X/⌘E）是用 scripts/cdp.mjs 的 `key "Meta+b"` 真按一遍、
     读回 markdown 确认有 `**` / `*` / `~~` / 反引号 才写进来的；
     ⌘A 的三段式是按三次分别看选区类型和 .mk-bs 块框数量确认的；
     ⌘S 是打完字 0.35s 就去看磁盘 —— 早于 800ms 自动存盘防抖，才算它生效了。
   新增快捷键时照这个流程验一遍再往里加，别只信 tooltip。
   ⚠️ 鼠标那组只有 **Alt+点正文**是真按出来的（.mk-bs 计数从 0 变 1）。
   「⇧/⌘ + 点块把手」是照 EditorPane.jsx 的 onDown 写的，
   实测**没触发**——把手落在正文框外 68px，blockPosAt 解析不到位置就 return 了。
   这里如实写「块把手」而不是「正文」，但要知道它目前不太好使。 */
const SHORTCUTS = [
  { group: "全局", items: [
    { keys: ["⌘", "K"], label: "快速搜索", where: "任意位置" },
    { keys: ["⌘", "S"], label: "立即存盘", where: "任意位置，不等自动存盘" },
  ]},
  { group: "正文", items: [
    { keys: ["⌘", "A"], label: "选中当前块的文字；再按升格为块选中；再按框住全文", where: "光标在正文里" },
    { keys: ["⌘", "F"], label: "页内查找（再按一次关闭）", where: "正文 / 文档" },
    { keys: ["⌘", "R"], label: "页内查找并替换", where: "正文 / 文档" },
    { keys: ["Esc"], label: "取消块选中 / 关闭查找框", where: "任意浮层" },
    { keys: ["⌫"], label: "删掉块选中的整组块（连块一起删，不留空行）", where: "块选中时" },
  ]},
  { group: "格式", items: [
    { keys: ["⌘", "B"], label: "加粗", where: "编辑器自带" },
    { keys: ["⌘", "I"], label: "斜体", where: "编辑器自带" },
    { keys: ["⌥", "⌘", "X"], label: "删除线", where: "编辑器自带" },
    { keys: ["⌘", "E"], label: "行内代码", where: "编辑器自带" },
  ]},
  { group: "鼠标", items: [
    { keys: ["Alt", "点击"], label: "加选一个块", where: "块正文" },
    { keys: ["⇧", "点击"], label: "选中一个块", where: "块把手" },
    { keys: ["拖动"], label: "块把手：同层换位置 / 拖进别的文件夹", where: "块把手" },
  ]},
];

const SET_SECS = [
  { key: "look", label: "外观", icon: ICONS.palette },
  { key: "side", label: "侧栏", icon: ICONS.panel },
  { key: "editor", label: "编辑器", icon: ICONS.type },
  { key: "keys", label: "快捷键", icon: ICONS.keyboard },
  { key: "config", label: "配置", icon: ICONS.gear },
  { key: "about", label: "关于", icon: ICONS.about },
];

function SettingsPanel({ onClose, secVis, onToggleSecVis, edFont, onFont, collapseOnExternal, onCollapseExt, showSaveFlag, onSaveFlag, docStats, onDocStats, sortMode, onSortMode, edSpacing, onSpacing, wide, onWide, themeMode, onTheme, palette, onPalette,
  askAddRoot, onAskAddRoot, sidePeek, onPeek }) {
  // Esc 关闭；点遮罩关闭。焦点不给输入控件，所以不用做焦点陷阱
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  /* 双栏（#14）：左索引 + 右详情，右边**只挂当前分区**。
     只渲染一个分区，所以每多一个分区不会让面板变长 —— 这是这次改动的全部动机。
     「快捷键」（#10）以后就挂在这一列上，不用再改布局。 */
  const [sec, setSec] = useState("look");
  /* 「关于」：名字和版本号从桌面壳取（api.js 的 appInfo），取不到也有回落值，
     所以这块**永远**有内容 —— 一个空白的关于面板比没有更糟。
     开了面板就取一次：这俩值一辈子不变，没必要反复 invoke。 */
  const [about, setAbout] = useState(null);
  useEffect(() => {
    let alive = true;
    appInfo().then((v) => { if (alive) setAbout(v); });
    return () => { alive = false; };
  }, []);

  return (
    <div className="dlg-mask set-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="set-panel">
        <div className="set-head">
          <span className="set-title">设置</span>
          <button className="set-x" onClick={onClose} title="关闭">{ICONS.x}</button>
        </div>

        <div className="set-body two">
          <nav className="set-nav">
            {SET_SECS.map((s) => (
              <button key={s.key} className={"set-nav-item" + (sec === s.key ? " on" : "")}
                onClick={() => setSec(s.key)}>
                <span className="set-nav-ico">{s.icon}</span>
                {s.label}
              </button>
            ))}
          </nav>
          <div className="set-pane">
          {sec === "look" && (
          <section className="set-sec">
            <h4 className="set-sec-name">{ICONS.palette}<span>外观</span></h4>

            <p className="set-sec-hint">整体色调。明暗决定用哪一版亮/暗色，配色方案决定这一版的纸张底色和强调色。</p>
            <div className="set-row static">
              <span className="set-row-main">
                <span className="set-row-label">主题</span>
                <span className="set-row-desc">
                  {themeMode === "system" ? "跟随系统" : themeMode === "dark" ? "始终暗色" : "始终亮色"}
                </span>
              </span>
              <div className="set-seg">
                {THEME_MODES.map((m) => (
                  <button key={m.key} className={m.key === themeMode ? "on" : ""}
                    onClick={() => onTheme(m.key)} title={m.hint}>{m.label}</button>
                ))}
              </div>
            </div>
            <div className="set-row static">
              <span className="set-row-main">
                <span className="set-row-label">配色方案</span>
                <span className="set-row-desc">
                  {PALETTES.find((p) => p.key === palette)?.label}。改纸张底色，正文的黑/白和强调色跟着一起调。
                </span>
              </span>
              <div className="set-swatches">
                {PALETTES.map((p) => (
                  <button key={p.key} className={"set-swatch" + (p.key === palette ? " on" : "")}
                    onClick={() => onPalette(p.key)} title={p.label}>
                    {/* 只摆亮色那套三格 —— .set-swatch 是按 3×15px 设计的，
                        6 格会顶成一根 90px 高的柱子。明暗是上面「主题」那一档的事。 */}
                    {p.swatch.map((c, i) => <i key={i} style={{ background: c }} />)}
                  </button>
                ))}
              </div>
            </div>

          </section>
          )}

          {sec === "side" && (
          <section className="set-sec">
            <h4 className="set-sec-name">{ICONS.panel}<span>侧栏</span></h4>
            <p className="set-sec-hint">哪些分组常驻显示、条目按什么顺序排 —— 都作用在左边这一列上。</p>
            {SIDE_SEC_ITEMS.map((it) => (
              <SwitchRow key={it.key} on={secVis[it.key]} onChange={() => onToggleSecVis(it.key)}
                label={it.label} desc={it.desc} note={it.warn} warn={it.warn && !secVis[it.key]} />
            ))}
            <SwitchRow on={collapseOnExternal} onChange={onCollapseExt}
              label="打开外部文件时不显示侧栏"
              desc="外部文件不在任何知识库里，左侧那一大片用不上。关掉它就会照旧显示侧栏。" />
            <SwitchRow on={sidePeek} onChange={onPeek}
              label="收起侧栏后，鼠标贴到左缘把它浮出来"
              desc="带 0.26 秒延迟和 0.22 秒宽限，指针只是路过不会触发。嫌吵就关掉，仍可用顶栏的展开按钮。" />
            {/* 「以后不再提示」必须有个回头路（2026-10-18）。
                那个按钮一旦点掉就永久关掉询问，没有出口的话用户等于被自己的
                一次点击锁死 —— 这个开关就是那个出口。 */}
            <SwitchRow on={askAddRoot} onChange={onAskAddRoot}
              label="询问是否把文件夹加为知识库"
              desc="从访达打开一个不在任何知识库里的文件夹时问一次。关掉后就一直按外部文件打开。" />

            <h5 className="set-sub">排序</h5>
            <p className="set-sec-hint">
              文件和文件夹的先后顺序。文件夹永远排在文件前面，各档位只管每组内部怎么排。
            </p>
            <div className="set-row static">
              <span className="set-row-main">
                <span className="set-row-label">排序方式</span>
                <span className="set-row-desc">
                  {sortMode === "manual"
                    ? "拖动侧栏里的条目调整。拖到别的文件夹上 = 把文件搬进去；拖到某一行上 = 在同一层换位置。"
                    : "切到「手动排序」后才能拖动调整。"}
                </span>
              </span>
              <div className="set-seg">
                {SORT_MODES.map((m) => (
                  <button key={m.key} className={m.key === sortMode ? "on" : ""}
                    onClick={() => onSortMode(m.key)} title={m.hint}>{m.label}</button>
                ))}
              </div>
            </div>
          </section>
          )}

          {sec === "keys" && (
          <section className="set-sec">
            <h4 className="set-sec-name">{ICONS.keyboard}<span>快捷键</span></h4>
            <p className="set-sec-hint">
              <b>只读清单</b>，还不能自定义绑定。Windows 上 <b>⌘</b> 一律换成 <b>Ctrl</b>。
            </p>
            {SHORTCUTS.map((g) => (
              <div key={g.group} className="set-keys">
                <h5 className="set-sub">{g.group}</h5>
                {g.items.map((it, i) => (
                  <div key={g.group + i} className="set-key-row">
                    <span className="set-key-combo">
                      {it.keys.map((k, j) => <kbd key={j}>{k}</kbd>)}
                    </span>
                    <span className="set-key-desc">
                      <span className="set-key-label">{it.label}</span>
                      <span className="set-key-where">{it.where}</span>
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </section>
          )}

          {sec === "about" && (
          <section className="set-sec">
            <h4 className="set-sec-name">{ICONS.about}<span>关于</span></h4>
            {/* 居中一列：图标 → 名字 → 版本号。这是「关于」这种只读信息唯一说得通的
                排法 —— 三行都居中，一眼看完；左对齐的话会和上面所有分区的
                「标题 + 左对齐行」长得一样，看不出这是个结束而不是设置项。 */}
            <div className="set-about">
              <img className="set-about-logo" src={appIconUrl} alt="Blanc 应用图标" draggable="false" />
              <div className="set-about-name">{about?.name || "Blanc"}</div>
              <div className="set-about-ver">
                {about?.version ? `版本 ${about.version}` : "版本 —"}
              </div>
            </div>
            <p className="set-sec-hint set-about-note">
              本地优先的 Markdown 笔记应用。笔记以纯 <b>.md</b> 文件存在你自己的文件夹里，
              不上传、不同步、不需要账号。
            </p>
          </section>
          )}

          {/* 配置目录搬到这里（2026-10-18 用户定的位置）：「关于」只放身份信息，
              应用自己的路径属于配置，跟着设置走比混在关于里清楚。 */}
          {sec === "config" && (
          <section className="set-sec">
            <h4 className="set-sec-name">{ICONS.gear}<span>配置</span></h4>
            <div className="set-row static">
              <span className="set-row-main">
                <span className="set-row-label">配置目录</span>
                <span className="set-row-desc">
                  知识库列表、界面偏好等应用自身的配置放在 <code>~/.blanc/</code>。
                  笔记不在这儿 —— 它们始终是你自己文件夹里的普通 .md 文件。
                </span>
              </span>
            </div>
          </section>
          )}

          {sec === "editor" && (
          <section className="set-sec">
            <h4 className="set-sec-name">{ICONS.type}<span>编辑器</span></h4>
            <p className="set-sec-hint">
              正文的排版和编辑行为。编辑器里的所有尺寸都是基准字号的倍数，改一个值整体缩放。
            </p>

            <div className="set-row static">
              <span className="set-row-main">
                <span className="set-row-label">正文字号</span>
                <span className="set-row-desc">标题、列表、斜杠菜单条目会按比例跟着变</span>
              </span>
              <div className="set-seg">
                <button onClick={() => onFont(edFont - 1)} disabled={edFont <= 12} aria-label="减小字号">−</button>
                <span className="set-seg-u">{edFont}<i>px</i></span>
                <button onClick={() => onFont(edFont + 1)} disabled={edFont >= 22} aria-label="增大字号">+</button>
              </div>
            </div>
            {/* 段落间距。label 写**实际段间隔**（padding 是上下各一份），
                所以这里的数字看着比 padding 小一半，这是对的。 */}
            <div className="set-row static">
              <span className="set-row-main">
                <span className="set-row-label">段落间距</span>
                <span className="set-row-desc">段落上下留白。列表和分隔线跟着一起走。</span>
              </span>
              <div className="set-seg">
                {/* ⚠️ ED_SPACING 的主键是 `pad`（数字），不是 `key`。
                   写成 m.key 会传 undefined 过去 → --para-pad 变成 "undefinedpx"
                   → 整条 padding 规则失效，段落全部贴死。 */}
                {ED_SPACING.map((m) => (
                  <button key={m.pad} className={m.pad === edSpacing ? "on" : ""}
                    onClick={() => onSpacing(m.pad)} title={`段间隔 ${m.sub}`}>{m.label}</button>
                ))}
              </div>
            </div>
            {/* 全宽模式：改的是**正文栏**的宽度约束，和上面两个尺寸项是一类。 */}
            <SwitchRow on={wide} onChange={onWide} label="全宽模式"
              desc="正文铺满可用宽度，不再限制在便于阅读的一栏内" />

            <h5 className="set-sub">状态栏</h5>
            <SwitchRow on={showSaveFlag} onChange={onSaveFlag} label="显示保存状态"
              desc="右下角那一枚「已保存 / 未保存」。关掉只在有改动时短暂出现。" />
            {/* ⚠️ 这里原来是个 SwitchRow on={docStats} —— docStats 是**数组**，
                传进开关永远 truthy，等于一个恒开的假开关，而且只有开/关两态，
                和顶栏菜单的「全部 / 字数 / 词数 / 字符数」多选对不上。
                现在两边共用 StatsPicker，改一处两边同步。 */}
            <div className="set-row static">
              <span className="set-row-main">
                <span className="set-row-label">文字统计</span>
                <span className="set-row-desc">右下角那枚胶囊显示哪几项，可多选；全不选就整枚不显示。</span>
              </span>
              <div className="set-seg multi">
                <StatsPicker value={docStats} onChange={onDocStats} optCls="" allCls="all" />
              </div>
            </div>
          </section>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* 首启引导：配置里一个知识库都没有时挡在主界面前面。
   2026-10-16 改版之前是**后端直接替用户建** —— 往人家家目录里塞一个文件夹，
   从没问过。现在只问一次，选完就写进 config.json，之后不再出现。

   两个选项都不是「随便给你挑一个」：
     · ~/Blanc Notes —— 新库。看得见、好备份、不和配置混在一起
     · ~/.blanc      —— 兜底。老版本默认就往这儿写，选它能把以前的笔记接上，
                        目录里确实有笔记时会把数量说出来（否则用户是在盲选）
   两个都不选就直接关窗：这里一个字节都没写（/api/setup 是只读的），
   下次启动接着问。 */
function Setup({ info, busy, onPick, onBrowse }) {
  if (!info) return <div className="setup" />;
  return (
    <div className="setup">
      <div className="setup-card">
        <h1>欢迎使用 Blanc</h1>
        <p className="setup-lead">
          还没有任何知识库。Blanc 的笔记就是普通的 Markdown 文件，
          放在哪个文件夹都行 —— 先选一个地方开始吧。
        </p>

        <button className="setup-opt" disabled={busy} onClick={() => onPick(info.suggested)}>
          <span className="setup-opt-t">创建新的知识库</span>
          <span className="setup-opt-d">{info.suggested}</span>
        </button>

        <button className="setup-opt setup-opt-alt" disabled={busy} onClick={onBrowse}>
          <span className="setup-opt-t">选择已有的文件夹</span>
          <span className="setup-opt-d">上面那个位置不合适</span>
        </button>

        {/* 配置目录里还躺着笔记时如实告知，但不代劳搬 —— 见 server.mjs setupInfo。
            全新用户看不到这一条。 */}
        {info.legacy && (
          <p className="setup-warn">
            配置目录 {info.legacy.path} 里还有 {info.legacy.count} 篇笔记。
 Blanc 不再把它当知识库用了，需要的话请自己移走。
          </p>
        )}

        <p className="setup-foot">
          之后可以随时在左下角添加或切换知识库。
          现在先关闭窗口的话，下次打开会再问一次。
        </p>
      </div>
    </div>
  );
}

export default function App() {
  const [roots, setRoots] = useState([]);
  /* 首启引导的数据。null = 还没问过；>0 个知识库时引导根本不渲染。 */
  /* 首启那一下必须等 roots 回来才知道该不该显示引导。
     用一个明确的布尔而不是拿 setupInfo 判空 —— 后者会把「还没拉完」
     和「拉完了但就是没有库」两种状态混成一个 null，引导会闪一下再出现。 */
  const [loadingRoots, setLoadingRoots] = useState(true);
  const [setupInfo, setSetupInfo] = useState(null);
  const [setupBusy, setSetupBusy] = useState(false);

  /* 独立窗口：新窗口靠 URL 上的 ?doc=<rel> 知道自己该开哪篇。
     放在最前面声明，是因为下面那个自动打开的 effect 要用 openFileRef。 */
  const [curRoot, setCurRootRaw] = useState(null);
  const [tree, setTree] = useState(null);
  const [doc, setDoc] = useState(null);
  /* 「这个窗口已经被外部文件占了」的标记。
     给**异步回调**判断用，但**不能靠 useEffect 同步 doc** 来做 ——
     setDoc 之后要等 React 重渲染、effect 跑完才同步得上，而树请求的
     .then 正好落在中间那个窗口里（实测：openExternal 已经 read 完了，
     树回调读到 docRef 仍是 null，于是又开了知识库第一篇，把外部文件顶掉）。

     所以改成在 openExternal **入口**同步置位 —— 那时候根本不用等渲染。
     读失败要撤销，否则用户会得到一个什么都不显示的空窗口。 */
  const externalClaimedRef = useRef(false);
  /* 系统递过来的路径若命中某个知识库，先记在这儿，等那个库的树载入完再开。
     为什么不直接读文件开：created / updated 是 /api/tree 的 fs.stat 带的，
     /api/file 不返回 —— 直接读的话属性面板会空掉两行。等树到位后拿**真正的
     节点**走 openFile，和点侧栏那一行走完全一样的路。 */
  const pendingKbOpenRef = useRef(null);
  /* 正文有没有滚动过 → 顶栏底边那根分隔线。放在 App 是因为线在 .topbar 上，
     而滚动的 .editor-scroll 在 EditorPane 里，两者隔了一层组件。 */
  const [editorScrolled, setEditorScrolled] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [query, setQuery] = useState("");
  const [toast, setToast] = useState("");
  const [loadErr, setLoadErr] = useState("");
  const [dlg, setDlg] = useState(null);
  /* 写入冲突（同一篇在别处被改过）。UI 在 ConflictDialog，
     但「以磁盘为准」要重开当前篇 —— 那是 openFile，所以用一个 ref 兜住闭包。 */
  const [conflict, setConflict] = useState(null);
  const openFileRef = useRef(null);
  // 对话框的淡出：setDlg(null) = 直接卸载，来不及播退场动画（删除确认、清空回收站
  // 这类都是「消失得比出现快」，看着像闪了一下）。改成先挂 .dlg-mask-out 播完
  // .12s 淡出再卸载。
  const [dlgOut, setDlgOut] = useState(false);
  const dlgTimer = useRef(null);
  const DLG_OUT_MS = 120;                                // 与 CSS 里 dlg-mask-out 的 .12s 对齐
  const closeDlg = useCallback(() => {
    setDlgOut(true);
    clearTimeout(dlgTimer.current);
    dlgTimer.current = setTimeout(() => { setDlg(null); setDlgOut(false); }, DLG_OUT_MS);
  }, []);
  const openDialog = (d) => {
    clearTimeout(dlgTimer.current);                      // 退场途中又被打开 = 取消关闭
    setDlgOut(false);
    setDlg(d);
  };
  useEffect(() => () => clearTimeout(dlgTimer.current), []);
  const [menu, setMenu] = useState(null); // 单例右键菜单 { x, y, node }
  const [renameNode, setRenameNode] = useState(null);   // 待重命名的节点（重命名输入框）
  const [iconNode, setIconNode] = useState(null);       // 待改图标的节点（图标选择器）
  // 选择器的淡出：iconNode 置空 = 直接卸载，没有退场动画。改成先挂 .icp-out 播完
  // 淡出再卸载（icpOut=true → ICP_OUT_MS 后 setIconNode(null)）。
  // 再次打开时立刻把 icpOut 复位，否则会带着退场态重新挂上来。
  const [icpOut, setIcpOut] = useState(false);
  const icpTimer = useRef(null);
  const ICP_OUT_MS = 100;                                // 与 CSS 里 icp-out 的 .1s 对齐
  const closeIconPicker = useCallback(() => {
    setIcpOut(true);
    clearTimeout(icpTimer.current);
    icpTimer.current = setTimeout(() => { setIconNode(null); setIcpOut(false); }, ICP_OUT_MS);
  }, []);
  const openIconPicker = useCallback((next) => {
    clearTimeout(icpTimer.current);
    setIcpOut(false);
    setIconNode(next);
  }, []);
  useEffect(() => () => clearTimeout(icpTimer.current), []);
  const [icons, setIcons] = useState({});               // rel -> { kind, value }，来自 <库>/.icons/_index.json
  /* 手动排序（#6）。orderMap = rel → 同级内序号，来自 <库>/.order/_index.json；
     排序档是界面偏好，存 uiPrefs —— 同一个库在两台机器上偏好不同很正常。 */
  const [orderMap, setOrderMap] = useState({});
  const [sortMode, setSortModeRaw] = useState(() => {
    const k = uiPrefs.get().sortMode;
    return SORT_MODES.some((m) => m.key === k) ? k : "manual";
  });
  const setSortMode = (k) => { setSortModeRaw(k); uiPrefs.set({ sortMode: k }); };

  /* 排序在这里落地（#6）。四个档位都是「文件夹在前、文件在后」，
     档位只管每组内部的顺序。服务端 /api/tree 回的是按名字排好的原样，
     按创建 / 按修改是界面偏好，所以在前端排、不回服务端。
     ⚠️ **必须声明在拖动那几段回调之前**（它们在下面 levelRels / dndReorder 里
     要用 sortedTree，而 useCallback 的依赖数组在**渲染时**求值，
     引用后面才声明的 const 会踩 TDZ —— 整棵树被 ErrorBoundary 接管 = 白屏）。
     同一条纪律见 pickKbIcon 上面那段注释。 */
  const sortedTree = useMemo(
    () => (tree ? sortTree(tree, sortMode, orderMap) : null),
    [tree, sortMode, orderMap]);
  const [paletteOpen, setPaletteOpen] = useState(false); // 快速搜索面板
  const [settingsOpen, setSettingsOpen] = useState(false); // 设置面板
  const [trashItems, setTrashItems] = useState([]);       // 回收站条目
  const closeMenu = () => setMenu(null);
  // 弹层：'roots'/'ops' 是侧栏底部的两个，'quick' 是顶栏右端那个三点菜单。
  // 共用一套开关状态和退场定时器 —— 三者不会同时开（点开一个就是另一个）。
  const [panel, setPanel] = useState(null);          // 'roots' 切库 | 'ops' 库操作 | 'quick' 顶栏菜单 | null
  // 弹层的淡出：panel 置 null = 直接卸载，来不及播退场动画（和图标选择器同理）。
  // 改成先挂 .*-drop-out 播完 .11s 淡出再卸载。
  const [panelOut, setPanelOut] = useState(false);
  const panelTimer = useRef(null);
  const PANEL_OUT_MS = 110;                            // 与 CSS 里 kb-drop-out 的 .11s 对齐
  const closePanel = useCallback(() => {
    setPanelOut(true);
    clearTimeout(panelTimer.current);
    panelTimer.current = setTimeout(() => { setPanel(null); setPanelOut(false); }, PANEL_OUT_MS);
  }, []);
  const openPanel = useCallback((p) => {
    clearTimeout(panelTimer.current);
    setPanelOut(false);
    setPanel(p);
  }, []);
  // 退场途中再点开关 = 取消关闭、重新展开。所以这里要一起看 panelOut，
  // 只判断 panel 的话，110ms 内点第二下会变成「又 close 一次」，怎么点都关不掉。
  const togglePanel = useCallback((p) => {
    if (panel !== p) { openPanel(p); return; }
    if (panelOut) openPanel(p); else closePanel();
  }, [panel, panelOut, openPanel, closePanel]);
  useEffect(() => () => clearTimeout(panelTimer.current), []);
  // 切文档时先按已存内容算一次统计，否则新开的文档右下角要等用户敲一下键才出数
  // 字数不再是 App 的 state（每次击键都会重渲染整棵树），走投递口喂给右下角那个组件
  useEffect(() => { pushStats(doc ? countText(doc.content) : EMPTY_STATS); }, [doc?.id]);
  // 侧栏收起状态，持久化在 uiPrefs（下次打开还保持收起）
  const [collapsed, setCollapsed] = useState(() => uiPrefs.get().collapsed === true);
  /* 收起后把鼠标贴到窗口左缘，侧栏**浮**出来（2026-10-18 用户要求恢复）。
   *
   * 这套曾经有过、后来按用户要求删了，理由写在旧代码里：悬停就滑出半屏，
   * 「既吵又容易误触」。所以这次不是原样搬回来，而是把那个理由解掉：
   *   ① 触发点是顶栏那个**看得见的展开按钮**，不是一条看不见的窄条
   *      （最初做的是「左缘 10px 命中条」，用户指正：应该 hover 那个按钮）
   *   ② 打开有 260ms 延迟：指针扫过顶栏 / 只是路过，到不了就自动收
   *   ③ 关闭有 220ms 宽限：在「面板」和「按钮」之间来回移动不会抖
   *   ④ 不写进 uiPrefs：它是**临时**状态，刷新/重开一律回到收起态
   * ⑤ 只在知识库模式生效（sideHidden 时整块不挂载，本来就够不着）
   * 设置里可关 —— 万一还是嫌吵，不用改代码。 */
  const [peeking, setPeeking] = useState(false);
  const [sidePeek, setSidePeek] = useState(() => uiPrefs.get().sidePeek !== false);
  const setPeek = (v) => { setSidePeek(v); uiPrefs.set({ sidePeek: v }); if (!v) setPeeking(false); };
  const peekTimer = useRef(null);
  /* 滑入动画结束前不判定指针在不在面板内（见下面那个 effect） */
  const armedRef = useRef(false);
  const sideRef = useRef(null);
  /* 顶栏那个展开按钮：peek 的触发点，也是「别关」的范围之一 */
  const peekTriggerRef = useRef(null);
  // 原生全屏：红绿灯会消失，顶栏/侧栏的让位要让掉
  // 外部文件的图标：它不在任何知识库里，没有 .icons/_index.json 可写，
  // 只能落到 uiPrefs（按绝对路径索引）。只影响显示，不碰磁盘文件。
  // 右下角统计：字数 / 词数 / 字符数。跟着编辑器实时走（EditorPane 的 onStats）
  const nativeFs = useNativeFullscreen();
  // 原来这里有 peek（收起后 hover 左缘把侧栏浮出来）。按用户要求去掉了：
  // 悬停一个按钮就让半屏界面滑出来，既吵又容易误触。收起后只从顶栏那个展开按钮
  // 回来，行为可预期。相关代码（状态 / 计时器 / .side.peek 样式）已一并删除。
  const [sideW, setSideW] = useState(() =>
    clampSide(uiPrefs.get().sideW || SIDE_DEF));
  // 侧栏三个分组的折叠状态，持久化在 uiPrefs
  const [sec, setSec] = useState(() => {
    const s = uiPrefs.get().sections;
    return {
      recent: s ? s.recent !== false : true,
      notes: s ? s.notes !== false : true,
      other: s ? s.other !== false : true,
    };
  });
  // 分组**可见性**，和上面的折叠状态 sec 是两回事，必须分开存：
  //   sec    —— 这一栏在不在（展开 / 收起），点标题栏切换
  //   secVis —— 这一栏出不出现（隐藏 / 显示），只在设置面板里切
  // 混在一起的话「隐藏其它」会顺手抹掉它的折叠状态，下次显示出来是展开的。
  const [secVis, setSecVis] = useState(() => {
    const v = uiPrefs.get().secVis;
    return {
      recent: v ? v.recent !== false : true,
      notes: v ? v.notes !== false : true,
      other: v ? v.other !== false : true,
    };
  });
  // 编辑器字号：Crepe 的所有尺寸都是 --crepe-base-font-size 的倍数，
  // 改这一个变量就能整体缩放（斜杠菜单条目 0.875× 也跟着走）
  const [edFont, setEdFont] = useState(() => {
    const n = uiPrefs.get().edFont;
    return [15, 16, 17, 18].includes(n) ? n : 16;
  });
  const [collapseOnExternal, setCollapseOnExternal] = useState(
    () => uiPrefs.get().collapseOnExternal !== false);
  /* 外部文件「要不要收成知识库」的询问。默认开着；弹窗里那个
     「以后不再提示」把它按成 false，设置里再能开回来。 */
  const [askAddRoot, setAskAddRoot] = useState(() => uiPrefs.get().askAddRoot !== false);
  const setAskRoot = (v) => { setAskAddRoot(v); uiPrefs.set({ askAddRoot: v }); };
  /* 角落那条可点的升级提示（见 offerAddRoot）。只留一条，新的覆盖旧的。 */
  const [kbOffer, setKbOffer] = useState(null);
  // 右下角胶囊的两半各自可选，默认都开着。
  // 都关掉时整个 .save-float 不挂载，不是「挂一个空胶囊」——空胶囊还是有投影和边框。
  const [showSaveFlag, setShowSaveFlag] = useState(() => uiPrefs.get().showSaveFlag !== false);
  const setSaveFlag = (v) => { setShowSaveFlag(v); uiPrefs.set({ showSaveFlag: v }); };
  const [docStats, setDocStats] = useState(readDocStats);
  // 只写新键 docStats。老的 showDocStats / docStatsMode 留着不删 ——
  // 删了的话万一新键丢了，readDocStats 会一路回落到「默认全选」，
  // 用户存的选择静默丢失。
  const saveDocStats = (v) => { setDocStats(v); uiPrefs.set({ docStats: v }); };

  /* 右侧那两块各自的显示开关（顶栏三点菜单里改）。两个都默认开。
     四种组合的布局在 OutlineRail 的 pinned 判定里，hover 互换的 CSS
     靠 :has(.olr-list) 判断面板在不在 —— 别在 JS 那边再加一个平行的 class，
     走过散了就复现「导航条 hover 就消失但还点得到」。 */
  const [showRail, setShowRail] = useState(() => uiPrefs.get().showRail !== false);
  const [showOutline, setShowOutline] = useState(() => uiPrefs.get().showOutline !== false);
  const setRail = (v) => { setShowRail(v); uiPrefs.set({ showRail: v }); };
  const setOutline = (v) => { setShowOutline(v); uiPrefs.set({ showOutline: v }); };
  /* 迷你模式：右缘索引条的第二种形态。
     默认**关** —— 它是另一种形态不是第三个叠加开关，开了会顶掉刻度轨和大纲面板
     （三者抢同一块屏幕）。默认 false 才不会一升级就把用户已有的布局改了。 */
  const [showMini, setShowMini] = useState(() => uiPrefs.get().showMini === true);
  const setMini = (v) => { setShowMini(v); uiPrefs.set({ showMini: v }); };

  /* 锁定只读。**不落 uiPrefs、也不跟着文档走** —— 切文档就解锁。
   * 这是刻意的：锁是个「临时看一眼 / 防止误触」的模式，不是文档的属性。
   * 真要做成「某些笔记天生是只读的」（像 Notion 的 lock page）得按 doc.rel 存，
   * 那是另一件事，别和这个混在一起。
   * 这也是 #9 垃圾箱预览要用的那个原语 —— 那边是「强制 true」，
   * 写成 readOnly || 强制只读 就行，用户自己没锁也不影响。 */
  const [readOnly, setReadOnly] = useState(false);
  useEffect(() => { setReadOnly(false); }, [doc?.id]);
  // 顶栏菜单「查找与替换」→ 通知编辑器打开查找框。只递信号，不越界改它的状态。
  const [findTick, setFindTick] = useState(0);
  // 属性头（#5）显示与否
  const [showProps, setShowPropsRaw] = useState(() => uiPrefs.get().showProps !== false);
  const setShowProps = (v) => { setShowPropsRaw(v); uiPrefs.set({ showProps: v }); };

  /* 编辑器基准字号。只在 :root 上写 --ed-font —— 不能直接写 --crepe-base-font-size：
     Crepe 把它声明在 .milkdown 上（不是 :root），.milkdown 自己的声明会盖掉
     继承来的值，之前设在这儿等于没设。真正的声明在 styles.css 的
     `.mk-host .milkdown { --crepe-base-font-size: var(--ed-font) }`。 */
  useEffect(() => {
    document.documentElement.style.setProperty("--ed-font", edFont + "px");
  }, [edFont]);

  const setEdFontPx = (n) => { setEdFont(n); uiPrefs.set({ edFont: n }); };

  /* 段落间距。和 --ed-font 同一个套路：**只在 :root 写 --para-pad**，
     由 styles.css 里 `.mk-host .milkdown ... { padding: var(--para-pad) }` 转译 ——
     Crepe 自己没提供任何间距变量（34 个 --crepe-* 全是颜色/字体/阴影/字号），
     只能我们覆盖它的 reset.css。
     ⚠️ 段落 / 列表 / 分隔线**必须共用这一个值**：Crepe 把它们清零后逐块手工加回去，
     列表和 hr 当初就漏了（padding: 0 且无 margin），只改段落会造出一个新的不一致。 */
  const [edSpacing, setEdSpacing] = useState(() => {
    const n = uiPrefs.get().edSpacing;
    return ED_SPACING_PAD.includes(n) ? n : 4;
  });
  useEffect(() => {
    document.documentElement.style.setProperty("--para-pad", edSpacing + "px");
  }, [edSpacing]);
  const setEdSpacingPx = (n) => { setEdSpacing(n); uiPrefs.set({ edSpacing: n }); };

  /* 夜间模式（#12）。三档：跟随系统 / 强制亮 / 强制暗。
     真正的活只有一件：把解析后的结果写到 <html data-theme>，
     CSS 那边 `:root[data-theme="dark"]` 一整套跟着换。
     ⚠️ **JS 解析、CSS 只认属性**，CSS 里不写 @media ——
     那样「跟随系统」和「强制亮」会变成两套规则打架，而且
     强制亮时没法覆盖 @media 里的 dark（只能反过来写一堆 :not）。
     跟随系统要**实时跟**：matchMedia 的 change 事件监听，
     系统切了不刷新页面就变（用户以为要重启的那种体验最劝退）。 */
  const [themeMode, setThemeModeRaw] = useState(() => {
    const m = uiPrefs.get().themeMode;
    return ["auto", "light", "dark"].includes(m) ? m : "auto";
  });
  /* ===== 跨窗口同步偏好 =====
   *
   * 前提：localStorage 在 Tauri 的各个 webview 之间**值是共享的**
   * （同一份 WKWebsiteDataStore），所以新窗口启动时读到的就是最新的。
   * 但**「已经是打开着的那个窗口」不会自动重渲染** ——
   * `storage` 事件在跨 webview 时不保证派发（WKWebView 上尤其不靠谱）。
   *
   * 所以两条一起上：
   *   ① `storage` 事件 —— 同源时能收就收，零成本；
   *   ② **窗口拿到焦点时重读一遍** —— 这条才是真正管用的那条。
   *      因为用户看得见不一致的时刻，一定是「他刚从另一个窗口切过来」。
   *      只做 ① 的话，WKWebView 上大概率一条都收不到。
   *
   * ⚠️ 同步时一律**不往回写**（setCollapsedSafe 传 persist=false）：
   *   否则「读到 → 写回」会触发对方窗口的 focus 再读，绕成环。
   */
  useEffect(() => {
    const sync = () => {
      const p = uiPrefs.get();
      if (typeof p.collapsed === "boolean") setCollapsedSafe(p.collapsed, false);
      if (typeof p.sideW === "number") setSideW(p.sideW);
      if (typeof p.edFont === "number") setEdFont(p.edFont);
      if (typeof p.edSpacing === "number") setEdSpacing(p.edSpacing);
      if (typeof p.wide === "boolean") setWide(p.wide);
      if (typeof p.showSaveFlag === "boolean") setShowSaveFlag(p.showSaveFlag);
      if (typeof p.showRail === "boolean") setShowRail(p.showRail);
      if (typeof p.showOutline === "boolean") setShowOutline(p.showOutline);
      if (typeof p.showMini === "boolean") setShowMini(p.showMini);
      if (typeof p.showProps === "boolean") setShowPropsRaw(p.showProps);
      if (["auto", "light", "dark"].includes(p.themeMode)) setThemeModeRaw(p.themeMode);
      if (p.palette) setPaletteRaw(p.palette);
      if (Array.isArray(p.docStats)) setDocStats(p.docStats);
    };
    window.addEventListener("focus", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("focus", sync);
      window.removeEventListener("storage", sync);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = themeMode === "dark" || (themeMode === "auto" && !!mq?.matches);
      document.documentElement.dataset.theme = dark ? "dark" : "light";
      /* 同步告诉 Rust 主题档：它建新窗口时按这一档铺底色。
         少了这一步，Rust 只能问**系统**外观 —— 系统夜间 + 强制日间的用户
         每次开新窗口都会先闪一下黑再变白（用户 2026-10-16 报）。
         auto 也要报：它得知道「别预设，让 Rust 问系统」。 */
      desktop.setThemeMode(themeMode);
    };
    apply();
    if (themeMode !== "auto" || !mq) return;          // 强制档不 listens 系统
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [themeMode]);
  const setThemeMode = (m) => { setThemeModeRaw(m); uiPrefs.set({ themeMode: m }); };

  /* 配色方案（#13）。和 themeMode 一样只写一个属性，CSS 那边
     `:root[data-palette="x"]` 整套跟着换。swatch 用来在设置里显示三个色块，
     **亮/暗两套色都带上**：用户往往是在暗色下挑配色的，只给亮色色块
     会让他选完才发现不是那个颜色。 */
  const [palette, setPaletteRaw] = useState(() => {
    const k = uiPrefs.get().palette;
    return PALETTES.some((p) => p.key === k) ? k : "paper";
  });
  useEffect(() => {
    document.documentElement.dataset.palette = palette;
  }, [palette]);
  const setPalette = (k) => { setPaletteRaw(k); uiPrefs.set({ palette: k }); };

  /* 全宽模式（#7）。正文默认**一列 720**、居中，余量均分当留白（最多 100）；
     全宽时盒子铺满编辑区，左右固定各留 100px（--ed-pad-x）。
     几何全在 styles.css 的 :root 那几个变量里，这里只负责开/关这一档：
     在 <html> 上挂 data-wide，CSS 用它覆盖 .editor-pad 的 max-width 和留白。
     ⚠️ **不要**给右边额外让出索引条的位置。早先留了
     `--ed-pad-r: calc(100px + 230px + 14px)` = **344px**，为的是
     「hover 展开的大纲面板别盖住正文」—— 结果右边空一大块，
     正文被挤到左边偏着（用户 2026-10-13 报「右侧 padding 那么多」）。
     大纲面板是**临时浮层**，让它盖住正文一小会儿是所有编辑器的通行做法
     （它自己是实心卡片，盖上去读得清），不值得拿 244px 的正文宽度去换。 */
  const [wide, setWide] = useState(() => uiPrefs.get().wide === true);
  useEffect(() => {
    const root = document.documentElement;
    if (wide) root.setAttribute("data-wide", "");
    else root.removeAttribute("data-wide");
  }, [wide]);
  const setWideMode = (v) => { setWide(v); uiPrefs.set({ wide: v }); };
  const toggleSecVis = (k) =>
    setSecVis((v) => { const n = { ...v, [k]: !v[k] }; uiPrefs.set({ secVis: n }); return n; });
  const setCollapseExt = (v) => { setCollapseOnExternal(v); uiPrefs.set({ collapseOnExternal: v }); };

  const [recTick, setRecTick] = useState(0);   // 打开/保存笔记后触发「最近」重算
  const searchRef = useRef(null);
  const rootNode = () => ({ type: "dir", rel: "", name: rootName(curRoot) });
  const fileCount = useMemo(() =>
    tree ? flatten(tree.folders, [...tree.files]).length : 0, [tree]);

  // 收起/展开：走 CSS 过渡，动画结束后再补一刀强制终态
  // （窗口被遮挡时 WebKit 会卡住过渡，侧栏会停在中间宽度）
  const animTimer = useRef(null);
  // 收起/展开：宽度过渡是单相位的，改 class 就完事，不抖。
  // 动画结束后补一刀强制终态（窗口被遮挡时 WebKit 会卡住过渡，侧栏会停在中间宽度）。
  // persist=false 用于「外部文件打开时默认收起」这类一次性场景：
  // 只改本次的视图状态，不写 uiPrefs —— 否则用户平时「侧栏展开」的偏好
  // 会被一次外部打开悄悄改掉，下次开 app 侧栏就是收起的。
  const setCollapsedSafe = useCallback((v, persist = true) => {
    setCollapsed(v);
    if (persist) uiPrefs.set({ collapsed: v });
    const app = document.querySelector(".app");
    clearTimeout(animTimer.current);
    animTimer.current = setTimeout(() => {
      if (!app) return;
      app.classList.add("no-anim");
      setTimeout(() => app.classList.remove("no-anim"), 60);
    }, SIDE_ANIM_MS);
  }, []);

  // 瞬间收起/展开、**不播滑出动画**。
  // 做法是给 .app 挂 .no-anim（那条规则让 .side / .main 的 transition 全部失效），
  // 改完状态再摘掉。
  // ⚠️ 必须等两帧再摘：no-anim 要覆盖到 React 把 className 提交进 DOM 的那一帧，
  // 当场摘等于过渡照播。
  // 两个场景共用：拖拽时越过阈值（手还按着，260ms 的滑出会把手感彻底带偏）
  // 和打开外部文件（用户已经明确说了不要动画）。
  const jumpCollapsed = useCallback((v, persist = true) => {
    const app = document.querySelector(".app");
    if (app) app.classList.add("no-anim");
    setCollapsedSafe(v, persist);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      app && app.classList.remove("no-anim");
    }));
  }, [setCollapsedSafe]);

  const toggleSec = (k) =>
    setSec((s) => { const n = { ...s, [k]: !s[k] }; uiPrefs.set({ sections: n }); return n; });

  /* peek 的开/合。延迟与宽限见上面 peeking 的注释 ——
     「路过不触发」靠的就是这个 260ms，鼠标斜划过去根本等不到。
     ⚠️ 关闭**不能**靠面板自己的 onMouseLeave（2026-10-18 实测失效）：
     面板是在指针**纹丝不动**的情况下凭空浮出来的，它从没收到过 mouseenter，
     React 的进出配对里它根本不算「已悬停」，于是指针移开时也不会有
     mouseleave —— 面板就永远关不掉了。
     改成浮出期间监听 document 的 mousemove，按**矩形**判定指针在不在面板内。
     几何判定不依赖事件怎么配对，是这里唯一稳的做法。 */
  const openPeek = useCallback(() => {
    clearTimeout(peekTimer.current);
    /* 这里**不能**去动 armedRef：armed 只由「浮出期间那个 effect」在
       滑入结束后置位（那时 rect 才可信）。要是这里把它清掉，而此时面板
       已经在浮出状态（peeking 没变 → effect 不重跑 → 没人再置位），
       armed 就永远停在 false，关闭判定整个失效 —— 表现为「浮出来就再也不
       收不回去了」。实测踩过：先 hover 按钮浮出，再移开、再移回按钮，
       之后就再也关不掉。 */
    peekTimer.current = setTimeout(() => setPeeking(true), 260);
  }, []);
  useEffect(() => {
    if (!peeking) return;
    /* 浮出后这段时间内**不判**指针位置：滑入动画有 --side-anim(300ms)，
       这期间什么都别做，否则下面那个矩形判定会在半路上把面板关掉。 */
    const settle = setTimeout(() => { armedRef.current = true; }, SIDE_ANIM_MS + 40);
    const trig = peekTriggerRef.current
      ? peekTriggerRef.current.getBoundingClientRect() : null;
    const onMove = (e) => {
      if (!armedRef.current) return;
      const el = sideRef.current;
      const app = document.querySelector(".app");
      if (!el || !app) return;
      /* ⚠️ 必须用 offsetLeft/offsetWidth，**不能**用 getBoundingClientRect()。
         rect 反映的是**动画中的 transform**：面板从 translateX(-280) 滑到 0
         要 300ms，这期间它的 rect 还在屏幕外，于是停在 x=5 的指针被判成
         「在外面」→ 220ms 后关掉 → 面板滑回去。实测就是这个 —— 看着像
         完全不弹（弹出来又立刻收回去，肉眼只看到一线残影）。
         offset* 是未变换的布局值，拿到的是**最终**矩形。 */
      /* offsetLeft/offsetWidth 是**未变换**的布局值，拿到的是最终矩形 ——
         见上面关于 getBoundingClientRect 的那段注释。 */
      const par = el.offsetParent || app;
      const pr = par.getBoundingClientRect();
      const l = pr.left + el.offsetLeft, t = pr.top + el.offsetTop;
      /* PAD：面板右缘那条分隔线正好压着边界，指针停在线上时不算「出去」，
         否则会一路抖。 */
      const PAD = 4;
      const inPanel = e.clientX >= l - PAD && e.clientX <= l + el.offsetWidth + PAD
                   && e.clientY >= t - PAD && e.clientY <= t + el.offsetHeight + PAD;
      /* ⚠️ 触发按钮**也要算**在「别关」的范围里：面板浮在左缘，而指针停在
         顶栏那个按钮上，两者根本不重叠。只按面板矩形判定的话，面板一浮出来
         就会被判成「指针在外面」→ 220ms 后自己关掉（实测就是「闪一下就没」）。
         这也是 VS Code / Notion 的做法：指针在按钮上或在面板上都保持展开。

         按钮不参与动画（只有侧栏在滑），所以浮出那一刻量一次存住就够，
         之后每次 mousemove 直接比 —— 别去算它的 offsetParent，那个换算
         很容易因为中间隔着定位祖先而整体偏移。 */
      const inTrig = trig
        && e.clientX >= trig.left - PAD && e.clientX <= trig.right + PAD
        && e.clientY >= trig.top - PAD && e.clientY <= trig.bottom + PAD;
      if (inPanel || inTrig) {
        clearTimeout(peekTimer.current);       // 又回到面板/按钮里：取消待关
        return;
      }
      clearTimeout(peekTimer.current);
      peekTimer.current = setTimeout(() => setPeeking(false), 220);
    };
    document.addEventListener("mousemove", onMove, true);
    return () => {
      clearTimeout(settle);
      armedRef.current = false;
      document.removeEventListener("mousemove", onMove, true);
      clearTimeout(peekTimer.current);
    };
  }, [peeking]);
  /* 侧栏真被展开/收起时，peek 必须立刻让位：否则会留一个浮在半空的副本，
     或者展开后还挂着 .peeking 把展开后的侧栏又变回浮层。 */
  useEffect(() => {
    clearTimeout(peekTimer.current);
    if (!collapsed) setPeeking(false);
  }, [collapsed]);
  useEffect(() => () => clearTimeout(peekTimer.current), []);

  // 记一次「操作过」：同一篇只留最新时间，按知识库隔离
  const touchRecent = useCallback((rel, name) => {
    if (!rel || !curRoot) return;
    const rest = (uiPrefs.get().recent || [])
      .filter((r) => !(r.root === curRoot && r.rel === rel));
    uiPrefs.set({
      recent: [{ root: curRoot, rel, name, ts: Date.now() }, ...rest].slice(0, RECENT_KEEP),
    });
    setRecTick((n) => n + 1);
  }, [curRoot]);

  const startRename = (node) => {
    setMenu(null);                 // 菜单先卸载，避免它盖在重命名输入框上面
    // 记下那一行的位置，输入框贴着它弹（下一帧再量，菜单卸载后布局才稳定）
    const row = document.querySelector(`.tree [data-rel="${CSS.escape(node.rel)}"]`);
    const rect = row?.getBoundingClientRect();
    setRenameNode({ node, rect: rect ? { left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width } : null });
  };

  // 图标表：和 loadTrash 一样独立拉一次（<库>/.icons/_index.json，服务端会顺手清孤儿键）
  const loadIcons = useCallback(async () => {
    if (!curRoot) { setIcons({}); return; }
    try {
      const r = await api.icons(curRoot);
      setIcons(r.icons || {});
    } catch {
      setIcons({});
    }
  }, [curRoot]);
  useEffect(() => { loadIcons(); }, [loadIcons]);   // eslint-disable-line react-hooks/exhaustive-deps
  // 挂载后后台拉 lucide 全量：不然刷新页面时，之前从「筛选」里选的那枚图标
  // （key 不在内置的 128 枚里）会先渲染成「未知图标」，等用户点开筛选框才恢复。
  /* ⚠️ 但要等**首帧之后**（2026-10-21）：这份表是 674KB 的对象字面量，
     以前挂载就拉，下载 + 解析整个压在首屏那几百毫秒上，和主包的解析抢主线程。
     挪到 rIC（最迟 2s）后，侧栏里那几枚自定义图标晚一点点出现，完全无害。 */
  useEffect(() => {
    const ric = window.requestIdleCallback
      ? window.requestIdleCallback(() => { loadLucideAll(); }, { timeout: 2000 })
      : window.setTimeout(() => { loadLucideAll(); }, 800);
    return () => {
      if (window.cancelIdleCallback && typeof ric === "number") window.cancelIdleCallback(ric);
      else window.clearTimeout(ric);
    };
  }, []);

  // 图标选择器：量行的方式和 startRename 一样（先关菜单，下一帧再量）
  const startIconPick = (node) => {
    setMenu(null);
    const row = document.querySelector(`.tree [data-rel="${CSS.escape(node.rel)}"]`);
    const rect = row?.getBoundingClientRect();
    openIconPicker({ node, rect: rect ? { left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width } : null });
  };

  // 乐观更新：先把本地表改了，点完立刻能看到；再用服务端返回的整张表对齐。
  // value 传空串 = 恢复默认图标
  // color 只对 svg 有意义（emoji 是彩色字形），传进来也丢。
  // keepOpen：只改颜色时不要关选择器 —— 试色要连着点，关了就没法对比
  const pickIcon = useCallback(async (node, kind, value, color, keepOpen) => {
    const c = kind === "svg" ? color || "" : "";
    if (!keepOpen) closeIconPicker();
    setIcons((m) => {
      const n = { ...m };
      if (value) n[node.rel] = c ? { kind, value, color: c } : { kind, value };
      else delete n[node.rel];
      return n;
    });
    try {
      const r = await api.setIcon(curRoot, node.rel, kind, value, c);
      if (r && r.icons) setIcons(r.icons);
    } catch (e) {
      showToast((e && e.message) || "图标保存失败");
      loadIcons();
    }
  }, [curRoot, loadIcons, closeIconPicker]);

  // ---- 标题图标（侧栏右键「图标」用的是同一套选择器，只是入口不同）----
  const docIcon = !doc ? null
    : (icons && icons[doc.rel]) || null;   // 只管库内笔记：图标是知识库树里的身份标识

  const openTitleIcon = useCallback((rect) => {
    if (!doc) return;
    // IconPicker 只用到 rect / current / onCancel / onPick，node 传个占位即可。
    // rect 来自点击的按钮（大图标或文字按钮）→ 选择器在点击位置弹出。
    openIconPicker({ node: { rel: doc.rel, name: doc.name, type: "file" }, rect: rect || null, via: "title" });
  }, [doc, openIconPicker]);

  const pickTitleIcon = useCallback(async (node, kind, value, color, keepOpen) => {
    if (!doc) return;
    const c = kind === "svg" ? color || "" : "";
    await pickIcon(node, kind, value, color, keepOpen);
  }, [doc, pickIcon, closeIconPicker]);

  const toastTimerRef = useRef(null);
  // **必须稳定引用**：全篇二十多处 useCallback 都把它列进依赖，
  // 用普通函数的话它每次渲染都是新对象 → 下游回调身份跟着变 → 依赖它们的
  // effect 反复重跑（踩过一次：自动打开外部文件的 effect 无限重复读同一个文件）
  const showToast = useCallback((m) => {
    setToast(m);
    clearTimeout(toastTimerRef.current);   // 连点时不让旧计时器提前把新 toast 清掉
    toastTimerRef.current = setTimeout(() => setToast(""), 2500);
  }, []);

  // 拖拽条 pointerup 时已经写过一次 uiPrefs.sideW；这里兜一层：
  // 拖动过程中直接关窗口 / pointerup 丢失时，宽度也能留住。
  // 声明在 startResize **之前**：下面的 collapseIfDragged 要读 sideWRef.current
  // 判断「是否已经贴在最窄」。函数体在调用时才求值、实际踩不到 TDZ，
  // 但读一个声明在自己下方的 ref 很容易看漏。
  const sideWRef = useRef(sideW);
  useEffect(() => { sideWRef.current = sideW; }, [sideW]);
  useEffect(() => () => uiPrefs.set({ sideW: sideWRef.current }), []);

  // 拖动侧栏右缘改宽。三个相位，全部在**同一次按下**里完成：
  //
  //   resize     正常调宽，宽度被 clampSide 钉在 [SIDE_MIN, SIDE_MAX]
  //   collapsed  宽度已触底(SIDE_MIN)，又继续左拖过 50% → 侧栏**瞬间**收起；
  //              这时鼠标还按着，宽度已经管不了了
  //   （回到 resize）再往右拖过侧栏宽的 40% → 瞬间弹出，并立刻接回调宽
  //
  // ── 三个必须注意的点 ────────────────────────────────────────
  // 1. 阈值必须是**比例**不是固定像素：SIDE_MIN 会变，写死 50px 等于把
  //    「多大宽度算触底」硬编码进了手感里。
  // 2. 阈值必须从「宽度恰好触底的那个位置」算，不是从按下那一刻。
  //    startW=500 拖到 min 要 230px，若从 startX 算，总位移一过 135px 但还没触底
  //    就被判「已在 min」，结果是**刚碰到底就立刻收起**，中间那段缓冲全丢了。
  //    那个位置用解析式算：minAtX = startX + (SIDE_MIN - startW)。
  //    ⚠️ 千万别用「第一次采样到触底时记下指针位置」——那个值取决于 pointermove 的
  //    采样粒度：事件稀的时候记得晚、密的时候记得早，同一个手势能差出几十像素，
  //    阈值跟着漂，同一段代码在不同机器/不同帧率下表现不一致。
  // 3. 收起后 .side-resizer 会**卸载**（JSX 里 {!collapsed && …}），
  //    所以监听必须挂在 window 上而不是拖拽条自身 —— 挂在元素上的话元素一没了
  //    拖拽就断，松手时也不会走收尾逻辑。
  const COLLAPSE_RATIO = 0.5;    // 触底后再左拖「最窄宽度」的 50% → 收起
  const RESURGE_RATIO = 0.4;     // 收起后往右拖「侧栏宽度」的 40% → 弹出
  const startResize = (e) => {
    e.preventDefault();
    const el = e.currentTarget;
    let startX = e.clientX;              // 调宽相位的起点（弹出后会重置）
    let startW = sideWRef.current;
    // 宽度恰好等于 SIDE_MIN 时指针应在的位置（见上面第 2 点）
    let minAtX = startX + (SIDE_MIN - startW);
    let collapsed = false;
    let collapseX = 0;                  // 收起那一刻的指针位置
    // 弹出之后**先不跟随鼠标**，等指针重新回到热区里才恢复。
    // 不设这道闸的话：弹出的那一刻指针往往还停在热区左侧（热区跟着 sideW 走，
    // 侧栏一弹出来热区才跟着回到指针附近），此时继续往右拖会「凭空」把侧栏拉宽 ——
    // 看着像鼠标没压着边缘却在改宽度。
    let armed = true;                   // 起点本来就是热区，所以一开始是就绪的
    const collapseW = SIDE_MIN;         // 收起时宽度必然就是 SIDE_MIN

    const widthAt = (x) => clampSide(startW + (x - startX));
    // 热区的实际范围，和 JSX 里 .side-resizer 的 inline left / CSS 的 width 对齐
    const hotLeft = (w) => w - RESIZER_HALF - SIDE_INSET;
    const inHotZone = (x, w) => x >= hotLeft(w) && x <= hotLeft(w) + RESIZER_HALF * 2;

    const move = (ev) => {
      const x = ev.clientX;
      if (collapsed) {
        // 往右拖过 40% 才弹出；不够就继续按住等。
        // ⚠️ 减 0.5px 的容差：270 * 0.4 在浮点上等于 108.00000000000001，
        // 「正好拖够 40%」会差这一丁点不触发。0.5px 远小于人能控制的量，
        // 纯粹是给浮点擦屁股。
        if (x - collapseX < collapseW * RESURGE_RATIO - 0.5) return;
        collapsed = false;
        // 弹出这一刻**不接管宽度**：只把侧栏放出来，指针去哪都先不管。
        // 沿用旧的 startX/startW 会让侧栏瞬间跳回「按下时的宽度」。
        startW = collapseW;
        minAtX = startX + (SIDE_MIN - startW);
        setSideW(collapseW);
        jumpCollapsed(false);
        armed = false;
        return;
      }
      if (!armed) {
        // 指针还没回到热区：宽度保持不动，只等它回来
        if (!inHotZone(x, sideWRef.current)) return;
        // 回到热区：以这一刻为新起点接着调宽，避免宽度在「等」的过程中已经变了
        armed = true;
        startX = x;
        startW = sideWRef.current;
        minAtX = startX + (SIDE_MIN - startW);
        return;
      }
      // 「指针已经越过触底点，再往左多出 SIDE_MIN 的一半」→ 收起。
      // 这个条件本身就蕴含了 raw <= SIDE_MIN（x <= minAtX 等价于触底），
      // 所以不必再单独判一次有没有触底 —— 也不需要「拉回来就把触底点作废」的分支。
      if (minAtX - x >= SIDE_MIN * COLLAPSE_RATIO) {
        collapsed = true;
        collapseX = x;
        setSideW(SIDE_MIN);
        uiPrefs.set({ sideW: SIDE_MIN });
        jumpCollapsed(true);
        return;
      }
      setSideW(widthAt(x));
    };

    const up = (ev) => {
      move(ev);                          // 松手位置可能跨过阈值，收尾也要跑一次
      // armed 为假 = 指针一直没回到热区，这段拖拽不该改过宽度，
      // 收尾也就不能再按 widthAt 覆写一次（那会把宽度按陈旧的 startX 改掉）。
      if (!collapsed && armed) {
        const w = widthAt(ev.clientX);
        setSideW(w);
        uiPrefs.set({ sideW: w });
      }
      document.body.classList.remove("resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    document.body.classList.add("resizing");
    // 监听挂 window 而非 el：收起时 el 被卸载，挂在自己身上的话拖拽会断。
    // setPointerCapture 仍然留着，用来兜住指针移出浏览器窗口的情况。
    try { el.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const refreshRoots = useCallback(() =>
    api.getRoots().then((list) => {
      setRoots(list);
      if (!list.length) {
        api.setup().then(setSetupInfo).catch(() => {});
      }
      setLoadingRoots(false);
      /* 当前库还在、目录也还在 → **什么都别动**（只返回列表）。
         ⚠️ 这里以前是裸 `return`，把**列表本身也一起吞掉了**：只有换库那条
         分支才 return list。「刚加完知识库」那次要拿这份列表重算归属
         （openFromSystem 里的注释），拿不到就退回到旧 state → 又问一遍 →
         死循环。所以两条路都必须 return list。 */
      const cur = curRootRef.current;
      const stillOk = cur && list.some((r) => r.path === cur && r.exists);
      if (stillOk) return list;
      const pref = uiPrefs.get().root;
      const target = list.find((r) => r.path === pref) || list.find((r) => r.exists) || list[0];
      setCurRoot(target?.path ?? null);
      return list;
    }).catch((e) => {
      // 桌面端连不上最常见的原因是拉不起 server.mjs（没装 Node.js）。
      // 只报「无法连接」用户没法判断该找谁，这里把该做的事直接说出来。
      const hint = inTauriShell()
        ? "桌面端没能启动本地后端。请确认已安装 Node.js；若有自建后端占用 8787 端口，它会被沿用。"
        : "请先在项目目录运行 npm run node 启动后端。";
      setLoadErr(`无法连接后端服务（${API_BASE || "本机 8787 端口"}）：${e.message || e}。${hint}`);
      throw e;
    }), []);

  /* 知识库列表要跟着别的窗口走（2026-10-16 修「切库后报 404 / 列表里有过期库」）。
     根列表**只在启动时拉一次**，而增删知识库是全局操作：多窗口下在 A 窗口移除一个库，
     B 窗口的列表还留着它，点下去 tree 请求 404，正文区只甩一句
     「载入文件列表失败：404 Not Found」—— 用户完全不知道是自己刚在另一个窗口删了它。

     窗口拿到焦点就重拉一次，跟上面 uiPrefs 的做法一致；`refreshRoots` 已经在
     useCallback 里，这里只挂一次。focus 事件在这个 app 里很稀疏（切窗口/切应用才来），
     多这一次 GET 不值一提。 */
  useEffect(() => {
    const onFocus = () => { refreshRoots().catch(() => {}); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshRoots]);

  /* 用户在引导页点了某个路径。走和「添加知识库」完全一样的 api.addRoot，
     不另开一条写入通道 —— 首启选完就变成一个普通知识库，后面该有的
     目录创建、图标、配置落盘全都是现成逻辑，不用在这边复刻一遍。 */
  const pickSetupRoot = useCallback(async (path) => {
    setSetupBusy(true);
    try {
      const r = await api.addRoot(path);
      showToast(`已添加 ${r.path}`);
      const list = await refreshRoots();
      setCurRoot(list.find((x) => x.path === r.path)?.path ?? r.path);
    } catch (e) {
      showToast(`创建失败：${e?.message || e}`);
    } finally {
      setSetupBusy(false);
    }
  }, [refreshRoots, showToast]);

  /* 「选择已有的文件夹」：Tauri 才有原生选目录，纯浏览器里给不了。
     没装桌面端就不显示这个选项，免得摆一个点了没反应的按钮。 */
  const browseSetupRoot = useCallback(async () => {
    const picked = await pickDir("选择知识库目录");
    if (!picked) return;
    await pickSetupRoot(picked);
  }, [pickSetupRoot]);

  const loadTree = useCallback(async (rootPath) => {
    /* 先用上次的树把侧栏铺出来（几百毫秒的空白期没了），再等真实扫描替换。
       不能 return 缓存：调用方要的是**最新**树（自动打开第一篇、找刚改名的那篇）。 */
    const cached = readTreeCache(rootPath);
    if (cached) {
      setTree(cached.tree);
      setOrderMap(cached.order);
    }
    const [t, o] = await Promise.all([
      api.tree(rootPath),
      // 排序表拉不到就当没有（退成按名字排），不该让整个侧栏空掉
      api.order(rootPath).then((r) => r.order || {}).catch(() => ({})),
    ]);
    setTree(t);
    setOrderMap(o || {});
    writeTreeCache(rootPath, t, o || {});
    return t;
  }, []);

  // 知识库图标：落点不在某个库里的 .icons/_index.json（那是「库内相对路径 → 图标」，
  // 而知识库本身没有 rel），而是 config.json 的 rootIcons，按**绝对路径**索引。
  // 乐观更新 + 服务端回填，和 pickIcon 一致。
  // ⚠️ 必须排在 showToast 和 refreshRoots **之后**：useCallback 的依赖数组在**渲染时**
  // 求值，引用后面才声明的 const 会踩 TDZ（Cannot access 'showToast' before
  // initialization），整棵树被 ErrorBoundary 接管 = 白屏。加新回调时留意这条。
  const pickKbIcon = useCallback(async (node, kind, value, color, keepOpen) => {
    const c = kind === "svg" ? color || "" : "";
    const root = node.rel;
    if (!root) return;
    if (!keepOpen) closeIconPicker();
    setRoots((m) => m.map((r) => {
      if (r.path !== root) return r;
      return value ? { ...r, icon: c ? { kind, value, color: c } : { kind, value } } : { ...r, icon: null };
    }));
    try {
      const res = await api.setRootIcon(root, kind, value, c);
      if (res && res.icon !== undefined) {
        setRoots((m) => m.map((r) => (r.path === root ? { ...r, icon: res.icon } : r)));
      }
    } catch (e) {
      showToast((e && e.message) || "知识库图标保存失败");
      refreshRoots().catch(() => {});
    }
  }, [closeIconPicker, showToast, refreshRoots]);

  // 回收站列表：<库>/.trash 里的条目（删除时记下的原路径 + 删除时间）
  const loadTrash = useCallback(async () => {
    if (!curRoot) { setTrashItems([]); return; }
    try {
      const r = await api.trash(curRoot);
      setTrashItems(r.items || []);
    } catch {
      setTrashItems([]);
    }
  }, [curRoot]);
  useEffect(() => { loadTrash(); }, [loadTrash]);   // eslint-disable-line react-hooks/exhaustive-deps

  /* 回收站内容预览（#9）。和打开普通文档走同一套 EditorPane，只是：
     · 内容来自 GET /api/trash/file（只读接口），不是库里的活文件
     · preview=true → EditorPane 强制锁定 + doSave 硬短路，一个字节都写不出去
     · rel 用**原路径**：面包屑和标题要显示成「这篇笔记长什么样」，
       但正好因为它是活路径，save 那道闸才必须硬做，不能只靠锁定。
     关掉预览回 null，恢复 / 彻底删除之后也要关 —— 文件已经不在回收站了，
     预览区留着会指向一个 404 的路径。 */
  const [preview, setPreview] = useState(null);

  /* 切知识库要**连编辑区一起清**（2026-10-16 修「切库后右侧还留着上一个库的内容」）。
     以前是裸的 setCurRoot，只换侧栏不管正文 —— 侧栏已经切到新库、正文还停在上一个库
     的文档上。用户以为在编辑新库里的东西，其实保存仍写回旧库那个文件
     （doc 自带 root/rel，所以**不会写坏文件**，但界面在骗人）。

     为什么不在 useEffect([curRoot]) 里清：那个 ?doc=<rel> 的自动打开 effect 也依赖
     curRoot，两者排在同一个提交里，清除会跑在打开**之后**，把刚打开的文档又清掉。
     放在「切」这个动作里做，没有时序问题。 */
  const curRootRef = useRef(null);
  useEffect(() => { curRootRef.current = curRoot; }, [curRoot]);
  const setCurRoot = useCallback((p) => {
    /* 同一个库就什么都不做。
       必须幂等：refreshRoots 在「窗口获得焦点」时也会跑，它内部要 setCurRoot，
       而当前库通常没变 —— 不挡这一下的话，每切一次窗口就把正在编辑的文档关掉。
       ref 同步就地更新，连着切两次同一个库也不会误清。 */
    if (curRootRef.current === p) return;
    curRootRef.current = p;
    /* 记住「上次打开的是哪个库」。refreshRoots 启动时读 uiPrefs.root 来选，
       所以**每一次**切库都要落盘 —— 不只是点侧栏那一次：从访达打开一个
       别的库里的文件（openAsLibrary 走这条）、删掉当前库后自动改选，都算。

       ⚠️ 这行以前是**缺的**：refreshRoots 一直在读 uiPrefs.root，但全项目
       没有一处写它，于是永远是 undefined，启动只能落到 list[0] ——
       用户报「点图标打开 app 记不住上一次的知识库」（2026-10-18）。

       落盘放在早期 return **之后**：同一个库连点两次不用重复写。 */
    uiPrefs.set({ root: p });
    /* 外部文档**不清**。
       启动时 refreshRoots 的这一次调用，可能落在 opened_file → openExternal
       之后（实测就是这个顺序），无条件 setDoc(null) 会把刚打开的库外文件擦掉，
       结果窗口只剩一个空壳 —— 「冷启动双击 .md 打不开」。
       外部文档不属于任何知识库，切库不该动它：和下面 loadTree 那段
       `setDoc((d) => (d && d.external ? d : null))` 是同一个约定。 */
    setDoc((d) => (d && d.external ? d : null));
    setPreview(null);
    setCurRootRaw(p);
  }, []);
  const openPreview = useCallback(async (it) => {
    if (!curRoot) return;
    try {
      const r = await api.trashFile(curRoot, it.trashRel);
      if (!r || typeof r.content !== "string") throw new Error("读取失败");
      setPreview({ trashRel: it.trashRel, rel: it.rel, name: it.name, content: r.content });
    } catch (e) {
      showToast(`预览失败：${e.message || e}`);
    }
  }, [curRoot, showToast]);

  // Esc 关预览。挂在 capture 上、且只在「焦点不在可编辑元素」时收 ——
  // 正文虽然锁了，浏览器里仍可能有别的可编辑元素获得焦点，那种 Esc 归它们。
  useEffect(() => {
    if (!preview) return;
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      const el = document.activeElement;
      if (el?.closest?.("[contenteditable='true'], input, textarea")) return;
      e.preventDefault();
      setPreview(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [preview]);

  // ⌘K / Ctrl+K 打开搜索面板
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 搜索面板开着时，Esc 无论焦点在哪都关掉（autoFocus 偶尔会落空，只靠输入框的 onKeyDown 不够）
  useEffect(() => {
    if (!paletteOpen) return;
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); setPaletteOpen(false); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [paletteOpen]);

  // 初始化
  useEffect(() => {
    setLoadErr("");
    refreshRoots().catch(() => {});
  }, [refreshRoots]);
  // 切换知识库 → 载入树
  useEffect(() => {
    // 外部文档（doc.external）不属于任何知识库，别在这里被清掉 ——
    // 新机器上一个知识库都没配时，双击 .md 也得能打开
    if (!curRoot) { setTree(null); setDoc((d) => (d && d.external ? d : null)); return; }
loadTree(curRoot).then((t) => {
        /* 系统刚递过来一篇知识库里的文件：树刚好是新鲜的，用真节点开。
           找不到节点（文件刚被删 / 不在树里）就不动 —— 宁可什么都不开，
           也不要掉进下面「打开第一篇」那条分支，那会把用户带到另一篇去。 */
        const want = pendingKbOpenRef.current;
        if (want && want.root === curRoot) {
          pendingKbOpenRef.current = null;
          const node = flatten(t.folders, [...t.files]).find(
            (n) => n.type === "file" && n.rel === want.rel);
          if (node) { openFile(node); return; }
        }
        /* 外部文件窗口**不自动打开知识库里的第一篇**（2026-10-16 修「外部文件打不开」）。
         URL 上的 ?ext= 已经说明这个窗口要显示的是库外文件，这里再开一篇，
         等于用知识库的内容把它顶掉 —— 窗口标题写着「外部测试.md」，正文却是
         知识库里的「新建」，用户只会以为是自己没打开成功。

         bootExternal 只挡得住 ?ext= 这种**同步已知**的情况。系统启动时通过
         openedFile() 递过来的文件没有 ?ext=，那时 bootExternal 还是 false，
         只能靠 docRef —— 见上面 docRef 的说明。两个一起才把竞态堵死。 */
      if (bootExternal) return;
      const first = flatten(t.folders, [...t.files])[0];
      if (first && !doc && !externalClaimedRef.current) openFile(first);
    }).catch((e) => setLoadErr(`载入文件列表失败：${e.message || e}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curRoot]);

  /* ---- 知识库之外的「外部文档」----
   * 从 Finder 双击 / 拖进来的 .md 往往不在任何知识库根目录下，
   * server.mjs 的 safeJoin 不认这种路径，所以这类文档的读写直接走桌面壳（Rust）。
   * doc.external = true 时：rel 存的是**绝对路径**，面包屑显示全路径，
   * 标题不参与重命名（外部文件改名是另一件事，见 STATUS）。
   */
  // 「设为 .md 默认应用」只在 Tauri 壳 + macOS 下出现
  const showSetDefault = desktop.available() && desktop.isMac();
  const setAsDefaultApp = useCallback(async () => {
    try {
      await desktop.setDefaultMarkdownApp();
      // **别说成「已设为默认」**：实测这个 API 会返回成功但实际没换 ——
      // 别的应用（比如 Obsidian）在系统里自称 Owner（拥有者）时，
      // Owner 的优先级压过我们这种 Default 声明，系统会照旧用它的。
      // 这时只能让用户自己点一下「打开方式 → 始终打开」，那是 Apple 有意要的一次知情确认。
      showToast("已向系统登记为 .md 编辑器；若双击仍打开别的应用，请右键 .md → 打开方式 → 始终打开");
    } catch (e) {
      showToast(`设置失败：${e?.message || e}`);
    }
  }, [showToast]);

  const openExternal = useCallback(async (absPath) => {
    let content;
    let mtime = 0;
    let ctime = 0;
    externalClaimedRef.current = true;
    try {
      // desktop.read 返回 {content, mtime}（mtime 是写入乐观锁的基准）
      const r = await desktop.read(absPath);
      content = r.content;
      mtime = r.mtime || 0;
      ctime = r.ctime || 0;
    } catch (e) {
      showToast(`打开失败：${e?.message || e}`);
      externalClaimedRef.current = false;   // 没打开成，别占着窗口
      return false;
    }
    if (typeof content !== "string") { externalClaimedRef.current = false; showToast("打开失败：读不到文件内容"); return false; }
    const name = String(absPath.split("/").pop() || absPath).replace(/\.mdx?$/i, "");
    setDoc({ external: true, root: null, rel: absPath, content, name,
             mtime,   // 乐观锁基准，同上
             /* 属性面板那两行系统属性（2026-10-16 加）。库内文件是从
                /api/tree 的 scan() 拿 fs.stat，库外文件不走那条路，
                不给的话面板上「创建时间 / 更新时间」永远是空的
                （用户报「外部文件没有属性」）。
                和库内一致：这两行是文件系统的事实，不进 frontmatter、不可编辑。 */
             created: ctime, updated: mtime,
             id: ++docIdRef.current });
    setDirty(false);
    /* 这里**不再**去 jumpCollapsed 了（2026-10-14 改）。
       以前是把侧栏收起来让出正文，但那只是「藏起来」：它仍挂在 DOM 里、
       Tab 还能 Tab 到，主区还留着 --side-w 的空档。
       现在是按 doc.external 直接**不渲染侧栏**（见渲染处 sideHidden），
       正文自然贴到左缘，关掉外部文件时侧栏原样回来 —— 不用记「之前是不是收着的」。

       「打开外部文件时收起侧栏」这个设置项继续管用，关掉它就照旧渲染侧栏。 */
    return true;                    // 给 bootExternal 的回退用（读失败要还原）
  }, [showToast, setCollapsedSafe]);

  // 同一个路径只自动打开一次的闸门（下面那个 effect 用）：
  // 那个 effect 会因依赖变化重跑，没有闸门就会一帧一帧地重复读同一个文件
  // （开发时实测 read_file 被调了几百次）。
  const autoOpenedRef = useRef(null);

  // 「以磁盘为准」要用它重开当前篇；挂到 ref 上免得 onReloadDoc 拿到旧闭包
  const openFile = useCallback(async (node) => {
    if (dirty) showToast("请先等待自动保存完成");
    let data;
    // 提示里用去掉 .md 的显示名，和侧栏、标题栏叫法一致
    const label = String(node?.name || node?.rel || "这篇").replace(/\.md$/i, "");
    try {
      data = await api.read(curRoot, node.rel);
    } catch (e) {
      /* 404 = 侧栏那一行过时了：文件在访达里被改名 / 移走 / 删掉，而树还是旧的。
         光说「打不开」没用 —— 用户看不出说的是哪一篇，也没法修（2026-10-29 用户报）。
         所以：报出文件名 + 顺手把树重拉一遍，让那行过期条目自己消失。 */
      if (e?.status === 404) {
        showToast(`「${label}」已经不在磁盘上了（可能被改名或移走），列表已刷新`);
        loadTree(curRoot).catch(() => {});
      } else {
        showToast(`打开失败：「${label}」${e?.message || e}`);
      }
      return;
    }
    // 读不到正文就别切文档：否则编辑器会变成空白，随后自动保存把空内容写回文件
    if (typeof data?.content !== "string") { showToast(`打开失败：「${label}」读到的正文是空的`); return; }
    // 开着回收站预览时点开别的文件：预览要收掉。
    // 不收的话编辑区会停在 .trash/ 的内容上，而 `doc` 已经换成新文件了 ——
    // 面包屑指着 B 篇、正文显示的是回收站里的 A 篇，还以为打开失败。
    setPreview(null);
    /* created / updated 来自 /api/tree 的 fs.stat（server 的 scan() 现在会带），
       属性面板的「创建时间 / 更新时间」两行直接用 —— 它们**不进 frontmatter**，
       那是文件系统的事实，写进文件只会变成一份对不上的副本。 */
    setDoc({ root: curRoot, rel: node.rel, content: data.content,
             name: String(node.name || "").replace(/\.md$/i, ""),
             created: node.created, updated: node.updated,
             // 读到时的 mtime —— 写入乐观锁的基准，由 EditorPane 保存后回填。
             // 没有它的话两个窗口开同一篇，后写的会静默覆盖前一个。
             mtime: data.mtime || 0,
             id: ++docIdRef.current });
    setDirty(false);
    touchRecent(node.rel, node.name);
  }, [curRoot, dirty, touchRecent, loadTree]);
  useEffect(() => { openFileRef.current = () => openFile(doc && { rel: doc.rel, name: doc.name }); });

  /* ---- 系统递过来的文件：先看它属于哪个知识库 ----
   *
   * 2026-10-17 用户报：「从某个笔记文件夹打开文件，会变成非外部文件打开，
   * 但没法定位到对应的笔记库」。根因是这一段以前**不看 roots**，
   * 一律按库外文件走，于是知识库里的笔记被塞进一个没有侧栏的外部文件窗口，
   * 而真正的那个库还停在原来的样子。
   *
   * 判断放在前端而不是 Rust：知识库列表归 server.mjs 管（~/.blanc/config.json），
   * Rust 再读一份就成了第二份真相，配置一改两处就漂。前端本来就持有 roots。
   */
  const resolveInRoots = useCallback((absPath, list) => {
    /* 去掉结尾斜杠，/Users/me/notes/ 和 /Users/me/notes 要当同一个库 */
    const norm = (p) => String(p || "").replace(/\/+$/, "");
    const target = norm(absPath);
    /* list 允许外部传（「刚加完库、state 还没更新」那次要用，见 openFromSystem） */
    const use = list || roots;
    let best = null;
    for (const r of use) {
      /* 失效的库不认领文件：目录都没了，认了也打不开 */
      if (!r || r.exists === false) continue;
      const root = norm(r.path);
      if (!root || target === root) continue;      // 库目录本身不是一篇
      /* 前缀必须跟分隔符，否则 /a/notes 会认领 /a/notes-旧/x.md */
      if (!target.startsWith(`${root}/`)) continue;
      /* 知识库可以嵌套，取**最长**的那个 —— 先命中的短库不算数 */
      if (!best || root.length > best.root.length) {
        best = { root: r.path, rel: target.slice(root.length + 1) };
      }
    }
    return best;
  }, [roots]);


  /* openFromSystem 的「命中知识库」那一半。单独抽出来是因为「刚加完库」要
     再走一次，而那条路必须能带着**新拉回来的** roots 进来（见下面）。 */
  const openAsLibrary = useCallback(async (hit) => {
    if (curRootRef.current === hit.root) {
      /* 已经在那个库里了：切库不会触发树的 effect，所以这里自己来。
         ⚠️ 必须**重拉**树，不能用内存里那份（`tree`）：
         用户很可能刚在访达里建了这个文件/文件夹，侧栏那份还是旧的 ——
         实测就是栽在这：新建的「子目录」不在旧树里，表现成「双击打不开」。
         顺带也覆盖了外部改名/删除的情况。 */
      const t = await loadTree(hit.root).catch(() => null);
      const node = t && flatten(t.folders, [...t.files]).find(
        (n) => n.type === "file" && n.rel === hit.rel);
      if (node) { openFile(node); return; }
      showToast(`打不开：${hit.rel} 不在这个知识库里`);
      return;
    }
    /* 换库：pendingKbOpenRef 交给切库那个 effect 的树回调去开（见上面的 loadTree） */
    pendingKbOpenRef.current = hit;
    setCurRoot(hit.root);
  }, [loadTree, openFile, showToast]);

  /* 角标：挂在角落的小卡片，**不挡路**（用户 2026-10-18 定的「不打断」）。
   *
   * 为什么不是模态框：这条询问是被系统触发的 —— 用户双击一个文件，App 正
   * 在另一个库里编辑，一个盖住整屏的确认框就把手头的事拦下了。而问的前提
   * 「这个文件已经能打开」是成立的，所以问与不问不该挡路：先照常打开，
   * 再在角落给一个可点的升级入口。
   *
   * 只留一条：新的覆盖旧的（连开三个库外文件也只提示最后一个那一个）。
   * 不自动消失 —— 它对应的是一次真实的决策，替用户做了不合适。
   *
   * ⚠️ 标题里必须带**文件名**（2026-10-18 用户报「从知识库内打开的文件，
   *    却弹出这个文件夹不在知识库里」）：这条角标说的是**某一次**打开的那篇
   *    文件，而窗口里显示的可能是完全另一篇。名字不带出来时，
   *    「这个文件夹不在知识库里」+ 一个路径，看起来就是在说眼前这篇。 */
  const offerAddRoot = useCallback((o) => {
    if (!askAddRoot || !o?.dir) return;
    setKbOffer(o);
  }, [askAddRoot]);

  /* 从绝对路径造一条角标：拆出所在文件夹（要加为知识库的对象）和文件名（说清是在说谁）。
     路径 = 单个文件名（没有 /）时 dir 就等于它自己，交给下面那道 !o?.dir 之外的判断不管。 */
  const offerFromPath = useCallback((absPath) => {
    const slash = absPath.lastIndexOf("/");
    const dir = slash > 0 ? absPath.slice(0, slash) : absPath;
    const name = slash > 0 ? absPath.slice(slash + 1) : absPath;
    offerAddRoot({ dir, absPath, name });
  }, [offerAddRoot]);

  const dismissKbOffer = useCallback(() => setKbOffer(null), []);
  /* 「以后不再提示」是个**永久**开关（存 uiPrefs，跨窗口共享），按钮上又没有
     「恢复」的入口 —— 用户点一次就再也见不到这条角标了。这属于把选择权收走了，
     所以点下去的同时告诉他开关在哪儿（2026-10-18 用户问「哪里能恢复」）。 */
  const neverAskKbOffer = useCallback(() => {
    setAskRoot(false);
    setKbOffer(null);
    showToast("以后不再提示 · 要恢复：设置 → 侧栏 → 询问是否把文件夹加为知识库");
  }, [showToast]);

  /* 点「加进来」：加库 → 重拉列表 → 现在它是知识库了 → 切过去重开这篇。
     ⚠️ 用 refreshRoots 刚返回的那份列表重算归属：resolveInRoots 闭包里的
     roots 是本次渲染的旧值，setRoots 要下一次渲染才生效。 */
  const acceptKbOffer = useCallback(async () => {
    const o = kbOffer;
    setKbOffer(null);
    if (!o) return;
    try {
      await api.addRoot(o.dir);
      const list = await refreshRoots();
      const hit = resolveInRoots(o.absPath, list);
      if (!hit) { showToast(`已添加 ${o.dir}，但仍打不开这篇`); return; }
      await openAsLibrary(hit);
      showToast(`已添加 ${o.dir}`);
    } catch (e) {
      showToast(`添加失败：${e?.message || e}`);
    }
  }, [kbOffer, refreshRoots, resolveInRoots, openAsLibrary, showToast]);

  /* 系统给了一条路径。warm = 是不是应用已在运行时。
   * 冷启动必须用 openExternal 在**本窗口**打开（主窗口是系统必定打开的那个，
   * 再开一个就变成两个窗口了）；运行中才另开窗口，那是一篇一窗口的意义。
   *
   * 命中知识库时一律走主窗口（切库 + 打开），不分冷热 ——
   * 知识库文件的价值就在侧栏上，另开一个没侧栏的窗口等于白开。 */
  const openFromSystem = useCallback(async (absPath, warm) => {
    /* ⚠️ 一定要用**刚拉回来的**列表判归属，不能用 state 里的 roots。
       冷启动时前端刚挂载，refreshRoots 还在路上，roots 是空数组 ——
       此时判断必然落到「库外文件」。实测踩过：双击 Blanc Notes 里的
       VibeCoding1.md，却弹出「这个文件夹不在知识库里」，而它明明就是
       当前库（用户 2026-10-18 截图里那个弹窗）。 */
    const list = await refreshRoots();
    let hit = resolveInRoots(absPath, list);
if (!hit) {
      /* 库外文件：**照常打开**，同时在角落里挂一条可点的提示（用户 2026-10-18 定的
         「不打断」）。原来这里先 await 一个模态确认框，等于系统递进来的一个文件
         能把用户手头正做的事盖住 —— 文件已经能看了，问与不问不该挡路。
         点「加进来」之后再走下面的 reopenKbOffer 切库重开。
         ⚠️ 角标只在**显示这篇文件的那个窗口**里弹（2026-10-18 用户报）。
         热启动这条路文件是开在 spawn 出来的新窗口里的，角标却留在当前窗口 ——
         当前窗口正显示着另一篇（多半是知识库里那篇），用户看到的就是
         「我打开的是库里的文件，怎么弹了这个」。所以这里不再 offer：
         新窗口自己从 ?ext= 参数认出「我是库外文件窗口」，开完自己 offer。 */
      if (warm) {
        try { await windows.spawnForPath(absPath); }
        catch (e) { showToast(`开不了新窗口：${e?.message || e}`); }
      } else {
        /* 打不开就**别问**：问的是「这个文件夹要不要成为知识库」，前提是文件
           已经能看（角标文案里就写着「文件已经能打开」）。打不开时窗口停在
           上一篇上这时再问，等于让用户对着 A 的正文决定 B 的文件夹去留 ——
           用户 2026-10-18 截图里就是这个组合：正文是 VibeCoding1，
           角标问 VibeCoding2.md 的文件夹，同屏还挂着一条「读取失败」。 */
        if (await openExternal(absPath)) offerFromPath(absPath);
      }
      return;
    }
    await openAsLibrary(hit);
  }, [resolveInRoots, refreshRoots, offerFromPath, openAsLibrary, openExternal, showToast]);

  /* 角标的**不变量**：只有当本窗口正显示着那篇文件时它才允许存在。
     上面那条「打不开就别问」治的是入口，这个 effect 治的是**残留**：
     用户处理完之后切到别的文档（或这条角标来自一次失败/过期的打开），
     它就该跟着消失，而不是顶着另一篇正文的标题继续问。
     doc.rel 对库外文件存的就是绝对路径（openExternal 里这么设的），对得上。 */
  useEffect(() => {
    if (!kbOffer) return;
    if (!doc || doc.rel !== kbOffer.absPath) setKbOffer(null);
  }, [doc, kbOffer]);

  /* 这个窗口是不是「某篇文档的独立窗口」（?doc= / ?ext=）。
     ⚠️ 独立窗口**绝不能**去问系统交过来的那条路径（2026-10-21 用户报：
        开过一个外部文件之后，后续每开一个外部文件，窗口里都是第一篇）。
        根因是 `OPENED` 是进程级的**一个**静态量，取走也不清空（见 lib.rs），
        于是每个新窗口调 opened_file() 都拿到「上一次系统打开的那条路径」，
        醒来就把 URL 里正确的那篇覆盖掉 —— 而 ?ext= 那篇正好是同一个窗口
        刚读完的，抢输赢取决于两个 invoke 谁先回来，用户看到的就是「永远是第一篇」。
        URL 参数是这一层唯一可信的真相：独立窗口开什么，建窗口时就写在 URL 上了。 */
  const isDocWindowRef = useRef(null);
  if (isDocWindowRef.current === null) {
    const sp = new URLSearchParams(window.location.search);
    isDocWindowRef.current = sp.has("ext") || sp.has("doc");
  }

  // 启动时系统交过来的文件 + 运行中又打开的文件。只有**主窗口**接管。
  useEffect(() => {
    if (isDocWindowRef.current) return;                    // 独立窗口：URL 说了算
    let alive = true;
    const open = (p, warm) => {
      if (!alive || !p || autoOpenedRef.current === p) return;
      autoOpenedRef.current = p;
      openFromSystem(p, warm);
    };
    desktop.openedFile().then((p) => open(p, false));      // 冷启动：主窗口自己接管
    const un = desktop.onOpenFile((p) => open(p, true));   // 运行中：Rust emit 的
    return () => { alive = false; Promise.resolve(un).then((f) => f && f()); };
  }, [openFromSystem]);

  /* 独立窗口：URL 上带 ?doc=<rel> 时自动打开那篇。
     等 tree 到位（得先知道文件在不在）再开 —— 早了 openFile 会因为 tree 里
     找不到节点而 toast「打开失败」，窗口就停在一个空壳上。
     用 ref 存参数：React 严格模式会跑两遍 effect，
     直接把 docFromUrl 算成 state 会触发额外的重渲染。 */
  const docParamRef = useRef(null);
  if (docParamRef.current === null) {
    const q = new URLSearchParams(window.location.search).get("doc");
    docParamRef.current = q ? { rel: q, done: false } : { done: true };
  }
  /* 独立窗口开的是**库外文件**时（Finder 双击 / 拖进来），URL 上带的是
     `?ext=<绝对路径>` —— 不是 `?doc=`，因为外部文件没有 rel。
     由 lib.rs 的 open_doc_window() 拼（urlencode 过的绝对路径）。
     ⚠️ 这个参数**不能抹掉**（2026-10-21 用户报）：早先读完之后用
     history.replaceState 把 query 清成干净路径，代价是窗口里任何一次
     reload（右键菜单的 Reload、⌘R、以后加的刷新入口…）都会去加载
     「没有参数的 URL」—— 外部文件窗口一刷新就掉回知识库首页，当前这篇没了。
     留着它，reload 就等于「重新打开同一篇」，正是要的行为。 */
  const extParamRef = useRef(null);
  if (extParamRef.current === null) {
    const q = new URLSearchParams(window.location.search).get("ext");
    extParamRef.current = { path: q, done: !q };
  }
  /* ⚠️ 侧栏「闪一下框」的根因与解法（2026-10-15 用户报）：
     外部文件窗口启动时 doc 要等 desktop.read 回来才变成 external，
     而**首帧 doc 还是 null** —— 那一两帧里侧栏已经画出来了，
     于是表现为「打开外部文件时，侧栏的位置有个框一闪而过」。
     解法：URL 上的 ?ext= 是**同步可读**的，首帧就能判定这是外部文件窗口，
     所以用它把 sideHidden 提前算出来（lazy initializer，在第一次 render 里就定）。
     读失败时回退成 false —— 不然界面会停在「没有侧栏也没有内容」的空壳上。 */
  const [bootExternal, setBootExternal] = useState(
    () => new URLSearchParams(window.location.search).has("ext"));
  useEffect(() => {
    const p = extParamRef.current;
    if (p.done || !p.path) return;
    p.done = true;
    openExternal(p.path).then(async (ok) => {
      if (!ok) {
        /* 打不开的这个独立窗口**没有任何东西可显示**。留着它更糟：
           bootExternal 一撤，侧栏就回来了，窗口里出现的是「上一篇知识库文档」，
           而窗口标题还是那个打不开的文件名（VibeCoding2.md）——
           标题和内容对不上，比直接关掉更难解释。已经弹过「打开失败」的 toast，
           这里直接收工；主窗口不能关（关了这个 App 就没有窗口了），退回上一篇。 */
        setBootExternal(false);
        try { await windows.closeSelfWindow(); } catch { /* 关不掉就算了 */ }
        return;
      }
      /* 库外文件窗口：角标挂在**这个**窗口里（2026-10-18 用户报）。
         之前是由「发起打开的那个窗口」代弹的，而那会儿它显示的是另一篇，
         于是看起来像在质疑用户正在看的那篇。文件既然开在这儿，询问也该在这儿。 */
      offerFromPath(p.path);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const p = docParamRef.current;
    if (p.done || !tree || !curRoot) return;
    const hit = findNodeByRel(tree, p.rel);
    // 文件不存在（被删/被移走）：不静默停着，直接进主界面让用户看到侧栏
    if (!hit) { p.done = true; showToast(`要打开的文件不在了：${p.rel}`); return; }
    p.done = true;
    openFile(hit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, curRoot]);

  // 收集某目录下（一级）现有文件/文件夹名，用于「未命名N」自增
  const collectNames = (dir, nodes, out) => {
    for (const n of nodes || []) {
      if ((n.rel || "").startsWith(dir)) {
        if (!n.rel.slice(dir.length).includes("/")) out.push(String(n.name || ""));
      } else {
        collectNames(dir, n.children, out);
      }
    }
  };
  const nextN = (names, base) => { let n = 2; while (names.includes(`${base}${n}`)) n++; return n; };

  // dir: "" = 当前库根；"a/b/" = 该目录下。返回不冲突的「未命名[N]」
  const pickName = (dir, nodes) => {
    const names = [];
    collectNames(dir, nodes || [], names);
    return names.includes(DEFAULT_TITLE) ? `${DEFAULT_TITLE}${nextN(names, DEFAULT_TITLE)}` : DEFAULT_TITLE;
  };

  const onCreate = useCallback(async (node, kind) => {
    try {
      // 目标目录：只有「在 dir item 上点 +」(rel 非空) → 该文件夹内；其余一律当前库根
      const dir = node && node.type === "dir" && node.rel ? node.rel + "/" : "";
      // 从磁盘读目标目录真实名再取 N（磁盘已含此前所有创建，连续快速创建也准确）
      let name = DEFAULT_TITLE;
      try {
        const dnodes = (await api.tree(curRoot)).children || [];
        name = pickName(dir, dnodes);
      } catch (_) {}
      const rel = kind === "dir" ? dir + name + "/" : dir + name + ".md";
      await (kind === "dir" ? api.mkdir(curRoot, rel) : api.create(curRoot, rel));
      await loadTree(curRoot);
      if (kind === "file") openFile({ rel, name: rel.split("/").pop().replace(/\.md$/, ""), type: "file" });
    } catch (e) {
      console.error("创建失败:", e.message);
    }
  }, [curRoot, loadTree, openFile]);

  /* ---- 侧栏拖动（#6）---- */
  // 拖的源 rel。只放 React state 不放 dataTransfer：dataTransfer 跨进程读不到，
  // 而「这一层的新顺序」要在 drop 时现算（拖动过程中排序档可能已经变了）。
  const [dragRel, setDragRel] = useState(null);

  // 拿到「同一层、按当前显示顺序」的 rel 数组。同层 = parentOf 相同（顶层是 ""）。
  const levelRels = useCallback((parent) => {
    if (!sortedTree) return [];
    const out = [];
    const push = (nodes) => { for (const n of nodes) if (parentOf(n.rel) === parent) out.push(n.rel); };
    if (parent === "") {
      // nodes 已经是**显示顺序**（手动档下目录文件混排），拖动算新顺序必须以它为准
      push(sortedTree.nodes);
    } else {
      const find = (nodes) => {
        for (const n of nodes) {
          if (n.rel === parent) return n.children || [];
          if (n.type === "dir") { const r = find(n.children); if (r) return r; }
        }
        return null;
      };
      push(find(sortedTree.nodes) || []);
    }
    return out;
  }, [sortedTree]);

  /* 同一层重排：只改 .order，**文件一个字节都不动**。
     算的是这一层的完整顺序（含没被动过的）—— 序号本来就是「以最后一次为准」
     的整份数据，写全量比逐条增量更不容易在中途失败时留下半套序号。 */
  const dndReorder = useCallback(async (from, toRel, after) => {
    if (!curRoot) return;
    /* 非手动档位下，同层重排是**做不到的** —— 顺序由档位决定，
       写进 .order 也会被下一次排序覆盖。以前这里直接静默 return，
       于是：行照样能拖起来、落点线照样画、放下却什么都不发生，
       也没有任何提示 —— 表现就是「拖动排序没效果」（用户 2026-10-16 报）。

       拖动**不能整个禁掉**：跨文件夹搬文件跟排序档无关，那部分照常能用。
       所以只在这里说明白为什么这一次没生效、要去哪儿改。 */
    if (sortMode !== "manual") {
      const label = SORT_MODES.find((m) => m.key === sortMode)?.label || "当前排序方式";
      showToast(`现在是「${label}」，同层顺序由它决定。设置 → 侧栏 → 排序改成「手动排序」才能拖动调序`);
      return;
    }
    const parent = parentOf(from);
    const next = moveInLevel(levelRels(parent), from, toRel, after);
    if (next.join("\u0000") === levelRels(parent).join("\u0000")) return;   // 没动
    const nextMap = { ...orderMap };
    next.forEach((rel, i) => { nextMap[rel] = i; });
    setOrderMap(nextMap);                                            // 乐观更新，拖完立刻就位
    try {
      const r = await api.setOrder(curRoot, next);
      if (r && r.order) setOrderMap(r.order);
    } catch (e) {
      showToast("排序没存上：" + (e.message || "未知错误"));
      await loadTree(curRoot);
    }
  }, [sortMode, curRoot, orderMap, levelRels, showToast, loadTree]);

  /* 跨层级 = **真的搬文件**（拖到别的文件夹里）。
     这条比换图标重得多：写盘 + 图标键/排序键跟着搬 + 目标重名要拦。
     目标路径同名时服务端回 409，这里原样把话带给用户，不自作主张加 "(1)"。 */
  const dndMoveInto = useCallback(async (from, dirRel) => {
    if (!curRoot || !from) return;
    if (isUnder(from, dirRel)) { showToast("不能移进它自己里面"); return; }
    const to = pathUnder(dirRel, from);
    try {
      const r = await api.move(curRoot, from, to);
      if (!r || r.ok === false) { showToast((r && r.error) || "移动失败"); return; }
      if (doc && doc.rel === from) {
        // 正文开着这一篇：路径变了，编辑器还挂在旧 rel 上 → 重新读一次接上
        const data = await api.read(curRoot, to).catch(() => null);
        if (data) setDoc((d) => (d ? { ...d, rel: to, name: to.split("/").pop().replace(/\.md$/, "") } : d));
      }
      await loadTree(curRoot);
      await loadIcons();
      showToast(`已移动到「${dirRel || "库根"}」`);
    } catch (e) {
      showToast("移动失败：" + (e.message || "未知错误"));
    }
  }, [curRoot, doc, loadTree, loadIcons, showToast]);

  /* 跨层移动**并定位置**：拖到某个文件夹内部、和它已有的内容同级的那一行
     前面/后面（用户 2026-10-13 的第 ② 种情况）。
     = 先 move 写盘搬过去，再把新路径插进目标文件夹那一层的 before/after。
     ⚠️ 顺带把**旧层**重新编号：搬走一项之后旧的序号会留空洞
     （`{a:0, c:2}`），虽然按值排序也认，但下次再拖就更容易看不明白。
     两层一起发给 /api/order —— 两个层级的 rel 互不相干，
     序号在各自那一段里连续，indexOf 算出来的就是各层自己的序号。 */
  const dndMoveIntoAt = useCallback(async (from, dirRel, toRel, after) => {
    if (!curRoot || !from) return;
    if (isUnder(from, dirRel)) { showToast("不能移进它自己里面"); return; }
    const to = pathUnder(dirRel, from);
    const oldSibs = levelRels(parentOf(from)).filter((r) => r !== from);
    try {
      const r = await api.move(curRoot, from, to);
      if (!r || r.ok === false) { showToast((r && r.error) || "移动失败"); return; }
      // 目标文件夹当前的内容 + 新搬进来的这一项，再按 before/after 定位
      const next = moveInLevel([...levelRels(dirRel), to], to, toRel, after);
      const nextMap = { ...orderMap };
      delete nextMap[from];
      oldSibs.forEach((rel, i) => { nextMap[rel] = i; });
      next.forEach((rel, i) => { nextMap[rel] = i; });
      setOrderMap(nextMap);
      try {
        const o = await api.setOrder(curRoot, [...oldSibs, ...next]);
        if (o && o.order) setOrderMap(o.order);
      } catch (_) { /* 顺序没存上不影响文件已经搬走，下面重新拉一次树 */ }
      if (doc && doc.rel === from) {
        const data = await api.read(curRoot, to).catch(() => null);
        if (data) setDoc((d) => (d ? { ...d, rel: to, name: to.split("/").pop().replace(/\.md$/, "") } : d));
      }
      await loadTree(curRoot);
      await loadIcons();
      showToast(`已移动到「${dirRel || "库根"}」`);
    } catch (e) {
      showToast("移动失败：" + (e.message || "未知错误"));
    }
  }, [curRoot, orderMap, levelRels, doc, loadTree, loadIcons, showToast]);

  const dnd = useMemo(() => ({
    drag: dragRel,
    setDrag: setDragRel,
    clear: () => setDragRel(null),
    reorder: dndReorder,   // (from, toRel, after)
    moveInto: dndMoveInto,
    moveIntoAt: dndMoveIntoAt,   // (from, dirRel, toRel, after)
    /* 筛选开着时禁掉拖动：屏幕上那一列是筛出来的残次，不是真实顺序。 */
    enabled: !query.trim(),
    readOnly: false,
  }), [dragRel, dndReorder, dndMoveInto, dndMoveIntoAt, query]);

  const onDelete = useCallback((node) => {
    openDialog({
      type: "confirm",
      title: "删除",
      message: `「${dispName(node.name)}」会移进回收站，可随时恢复。`,
      confirmLabel: "移到回收站",
      danger: true,
      onOk: async () => {
        await api.remove(curRoot, node.rel);
        if (doc?.rel === node.rel) setDoc(null);
        await loadTree(curRoot);
        await loadTrash();
        showToast(`已移入回收站：${dispName(node.name)}`);
      },
    });
  }, [curRoot, doc, loadTree, loadTrash, showToast]);

  const onRename = useCallback(async (node, to) => {
    await api.rename(curRoot, node.rel, to);
    if (doc?.rel === node.rel) {
      // EditorPane 以 doc.rel 为 key，rename 后会重挂载 → 必须读回最新正文，
      // 不能用旧快照（否则未保存的输入会被陈旧 content 覆盖）
      try {
        const data = await api.read(curRoot, to);
        setDoc({ root: curRoot, rel: to, content: data.content, name: to.split("/").pop().replace(/\.md$/, "") });
        setDirty(false);
      } catch (e) {
        setDoc({ ...doc, rel: to, name: to.split("/").pop().replace(/\.md$/, "") });
      }
    }
    await loadTree(curRoot);
  }, [curRoot, doc, loadTree]);

  const restoreItem = useCallback(async (it) => {
    try {
      await api.restoreFromTrash(curRoot, it.trashRel);
      await Promise.all([loadTree(curRoot), loadTrash()]);
      // 正开着这一篇的预览：文件已经回到活路径上，预览必须收掉，
      // 否则编辑区继续显示 .trash/ 里的旧内容，而用户以为已经恢复了。
      setPreview((p) => (p && p.trashRel === it.trashRel ? null : p));
      showToast(`已恢复：${dispName(it.name)}`);
    } catch (e) {
      showToast(`恢复失败：${e.message || e}`);
    }
  }, [curRoot, loadTree, loadTrash, showToast]);

  const purgeItem = useCallback((it) => {
    openDialog({
      type: "confirm",
      title: "彻底删除",
      message: `「${dispName(it.name)}」将被永久删除，无法恢复。`,
      danger: true,
      confirmLabel: "永久删除",
      onOk: async () => {
        await api.purgeFromTrash(curRoot, it.trashRel);
        await loadTrash();
        setPreview((p) => (p && p.trashRel === it.trashRel ? null : p));
      },
    });
  }, [curRoot, loadTrash, openDialog]);

  const emptyTrash = useCallback(() => {
    openDialog({
      type: "confirm",
      title: "清空回收站",
      message: `回收站里的 ${trashItems.length} 项将被永久删除，无法恢复。`,
      danger: true,
      confirmLabel: "清空",
      onOk: async () => {
        await api.emptyTrash(curRoot);
        await loadTrash();
      },
    });
  }, [curRoot, trashItems.length, loadTrash, openDialog]);

  // 标题 → 文件名（双向绑定）。策略：
  //   · 输入时展示层立即同步：setDoc({name}) → 侧栏树/面包屑马上跟着变（doc.rel 不变，
  //     EditorPane key=rel 不重挂载，正在编辑的正文不受影响）
  //   · 真实 rename 防抖 ~900ms（打字停顿后落盘一次）；失焦/Enter 由 flushTitleRename 立即冲刷
  const titleTimerRef = useRef(null);
  const pendingTitleRef = useRef(null); // { name, rel }：待落盘的最终状态
  const docIdRef = useRef(0); // 文档稳定 id（root+rel），做 EditorPane key：rename 只改 rel 不重挂载
  const saveFlushRef = useRef(null); // () => Promise<void>：EditorPane 暴露的「立即落盘当前正文」

  const runTitleRename = useCallback(async ({ name: cleanName, rel: oldRel, prevName }) => {
    pendingTitleRef.current = null;
    try {
      // flush 当前正文到旧 rel（防抖期间可能有未自动保存的输入）；ref 缺失时兜底等自动保存窗口
      if (saveFlushRef.current) await saveFlushRef.current();
      else if (dirty) await new Promise((r) => setTimeout(r, 900));
      const target = oldRel.slice(0, oldRel.lastIndexOf("/") + 1) + cleanName + ".md";
      if (target === doc?.rel) return; // 期间已被别的路径改过 → 放弃本次
      const rr = await api.rename(curRoot, oldRel, target);
      const data = await api.read(curRoot, target);
      // 仅当用户仍停留在被改名的文档上才更新视图（期间可能已切走）
      setDoc((d) => d && d.rel === oldRel ? { root: curRoot, rel: target, content: data.content, name: cleanName } : d);
      setDirty(false);
      touchRecent(target, cleanName);
      await loadTree(curRoot); // 侧栏树拿到真实新名（期间展示层已显示该名，视觉无跳变）
    } catch (e) {
      console.error("标题改名落盘失败:", e.message);
      showToast(`重命名失败：${e.message || e}`);
      setDoc((d) => d && d.rel === oldRel ? { ...d, name: prevName } : d); // 还原展示层为真实名
    }
  }, [curRoot, doc, dirty, loadTree, touchRecent]);

  const onTitleCommit = useCallback((newName) => {
    if (!doc) return;

    // 删空（或只剩非法字符）→ 取默认名「未命名」：展示层立即变、照常排防抖 rename，
    // 磁盘名也落成「未命名」（编辑器那边只显示空值 + 占位符，见 EditorPane 的 dispTitle）
    const clean = String(newName || "").trim().replace(/[\\/:*?"<>|]/g, "").replace(/\.md$/i, "") || DEFAULT_TITLE;

    /* ⚠️ 「这次没变化」的判断**必须在作废待落盘那份之前**（2026-10-16 修「改名不生效」）。
     * 以前是反过来的：先 clearTimeout + pendingTitleRef=null，再判 clean === doc.name。
     * 而 doc.name 是被乐观写进去的，所以**同一个名字会被提交两次**
     * （实测 WKWebView 失焦时先抖一个 onInput("")，把名字打成「未命名」、
     *  再被 commitTitle 写回 VibeCoding —— 第二次再触发一次重复提交）。
     * 第二次进来：先把上一次排好的防抖 rename 连同 pending 一起作废，
     * 然后才判定「没变化」直接 return —— **待落盘的那份就这么被抹掉了**，
     * flush 时 pending=false，什么都不做。症状是标题栏和侧栏都变成新名（乐观显示），
     * 磁盘上还是旧名，点一下侧栏才现原形。
     *
     * 顺序反过来之后：没变化就原样返回，不碰 pending；确实变了才作废上一次、
     * 排新的防抖。 */
    if (clean === doc.name) return;

    // 作废上一次排定的防抖 rename：删到空 / 继续改时，旧 snap 不能晚点再执行把标题弹回
    clearTimeout(titleTimerRef.current);
    pendingTitleRef.current = null;
    // 外部文件：标题**与文件名解耦**。
    // 用户原话是「外部文件一般内部已经有标题了，标题与文件名联动的功能就不需要了」——
    // 意思是这个标题只是个显示层标签，改它不��搬动磁盘上的文件。
    // 所以只更新 doc.name（面包屑/侧栏跟着变），不排防抖 rename。
    // 反过来如果照常排，runTitleRename 会拿 curRoot=null 去调 api.rename，
    // 那是拿知识库的路径去改名外部文件 —— 写错地方的风险。
    if (doc.external) { setDoc({ ...doc, name: clean }); return; }
    setDoc({ ...doc, name: clean }); // ① 展示层立即同步（侧栏/面包屑）
    const snap = { name: clean, rel: doc.rel, prevName: doc.name }; // ② 防抖落盘：commit 瞬间的 rel + 旧名
    pendingTitleRef.current = snap;
    clearTimeout(titleTimerRef.current);
    titleTimerRef.current = setTimeout(() => runTitleRename(snap), 900);
  }, [doc, runTitleRename]);

  // 失焦 / Enter → 立即冲刷待落盘的重命名（不再等防抖）
  const flushTitleRename = useCallback(() => {
    if (pendingTitleRef.current) {
      clearTimeout(titleTimerRef.current);
      runTitleRename(pendingTitleRef.current);
    }
  }, [runTitleRename]);

  // Esc → 取消待落盘的重命名（展示层已还原为 doc.name）
  const cancelTitleRename = useCallback(() => {
    pendingTitleRef.current = null;
    clearTimeout(titleTimerRef.current);
  }, []);

  // 组件卸载 / 切根目录前清掉未落盘的标题重命名定时器（防止对陈旧 doc 生效）
  useEffect(() => () => { clearTimeout(titleTimerRef.current); pendingTitleRef.current = null; }, [curRoot]);

  const addRoot = useCallback(() => {
    // 同一个动作的两条路：桌面壳走系统目录选择器，浏览器没有那套东西，
    // 回落到手输绝对路径。分流放在这里而不是组件里，是因为只有这一处需要知道
    // 当前跑在哪个壳里。
    if (!inTauriShell()) {
      openDialog({
        type: "input",
        title: "添加知识库",
        label: "目录绝对路径（如 ~/notes/工作）",
        placeholder: "~/notes/工作",
        onOk: async (p) => {
          const r = await api.addRoot(p);
          showToast(`已添加 ${r.path}`);
          await refreshRoots();
          setCurRoot(r.path);
        },
      });
      return;
    }
    (async () => {
      // 用户直接取消 = 字符串是 null（插件用 null 表示取消，不是空串）
      const picked = await pickDir("选择知识库目录");
      if (!picked) return;
      try {
        const r = await api.addRoot(picked);
        showToast(`已添加 ${r.path}`);
        await refreshRoots();
        setCurRoot(r.path);
      } catch (e) {
        showToast(`添加失败：${e?.message || e}`);
      }
    })();
  }, [refreshRoots, showToast]);

  /* 移除一个知识库。p 省略时是「当前库」。
     为什么要参数：失效的库（目录被删/移走）**切不过去**，所以它永远不会
     成为 curRoot —— 只认 curRoot 的版本等于「失效的库永远删不掉」，
     用户只能去改 ~/.blanc/config.json。用户 2026-10-18 问「这种已移除的
     库怎么管理」，这里就是那个出口。 */
  const removeRoot = useCallback((p) => {
    const target = p ?? curRoot;
    if (!target) return;
    openDialog({
      type: "confirm",
      title: "移除知识库",
      path: target,
      message: "把这个文件夹从知识库列表里移除吗？文件保留在磁盘上，不会删除。",
      danger: true,
      onOk: async () => {
        await api.removeRoot(target);
        dropTreeCache(target);
        await refreshRoots();
        showToast("已移除");
      },
    });
  }, [curRoot, refreshRoots]);

  const filtered = useMemo(() => {
    if (!sortedTree) return { folders: [], files: [] };
    const q = query.trim().toLowerCase();
    if (!q) return sortedTree;
    const hits = flatten(sortedTree.folders, [...sortedTree.files]).filter((f) =>
      f.name.toLowerCase().includes(q) || f.rel.toLowerCase().includes(q));
    // 筛选态是平铺的一列（没有层级了），nodes 和 files 是同一份
    return { folders: [], files: hits, nodes: hits };
  }, [sortedTree, query]);

  // 「最近」列表：7 天内操作过、且文件仍在当前库里的，最多 10 条
  const recentList = useMemo(() => {
    if (!tree || !curRoot) return [];
    const alive = new Set(flatten(tree.folders, [...tree.files]).map((f) => f.rel));
    const now = Date.now();
    return (uiPrefs.get().recent || [])
      .filter((r) => r.root === curRoot && now - r.ts < RECENT_TTL && alive.has(r.rel))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, RECENT_MAX);
  }, [tree, curRoot, recTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // 搜索面板用的扁平文件列表（含文件夹里的）
  // 注意：累加器要传副本。直接传 tree.files 会把嵌套文件 push 进 state 里那个数组，
  // 侧栏就会把文件夹里的文件在顶层再渲染一遍（同名文件还都会跟着高亮）
  const allFiles = useMemo(
    () => (tree ? flatten(tree.folders, [...tree.files]) : []), [tree]);

  const kbName = roots.find((r) => r.path === curRoot)?.name || "当前库";
  // 当前库那一条（用来取 icon）。没有匹配项时兜一个只有 path 的壳，
  // kbIcon 会因为没有 icon 字段而回落到默认书本，不至于整块渲染成空。
  const curRootObj = roots.find((r) => r.path === curRoot) || { path: curRoot, name: kbName };
  const notesEmpty = filtered.folders.length === 0 && filtered.files.length === 0;

  /* 「回到知识库」：切回最近一篇**库内**文档。
     侧栏被拿掉时（外部文件）正文一路顶到左缘，用户没法用侧栏回库；
     这条挂在顶栏三点菜单里当退路，不占工具位。 */
  const backToLibrary = useCallback(async () => {
    const last = allFiles[allFiles.length - 1];
    if (!curRoot || !last) {
      showToast("这个库还是空的，先新建一篇");
      return;
    }
    /* 回到库内文档时，「这是个外部文件窗口」这个**形态**也要一起撤掉
       （2026-10-18 用户报：点完「回到知识库」，侧栏和它的展开按钮都不回来）。
       sideHidden = collapseOnExternal && ((doc && doc.external) || bootExternal)，
       而 bootExternal 只在读文件失败时回落过一次 —— 成功切回库内文档并不会动它，
       于是窗口停在知识库文档上，却还挂着外部文件窗口的那副样子（正文顶到左缘、
       顶栏没有展开按钮），连回库的入口都只剩这一个菜单项，成了死胡同。 */
    setBootExternal(false);
    await openFile(last);
  }, [allFiles, curRoot, openFile, showToast]);

  /* 外部文件时**不渲染侧栏**，而不是把它藏起来。
     之前是 jumpCollapsed(true) —— 侧栏仍然挂在 DOM 里，只translateX(-100%) +
     visibility:hidden。区别不只是看不见：
       · 树还在渲染（大库是实打实的开销），Tab 还能 Tab 到那些「看不见」的按钮
       · 主区还留着 --side-w 的左边距，一片空白
     这里直接不挂载。设置项（打开外部文件时收起侧栏）仍然管用：
     关掉它就照旧渲染侧栏，由用户自己决定。 */
  /* bootExternal 让**首帧**就知道这是外部文件窗口（URL 上的 ?ext= 同步可读），
     否则 doc 要等 desktop.read 回来才变 external，中间那几帧侧栏已经画出来了。 */
  const sideHidden = collapseOnExternal && ((doc && doc.external) || bootExternal);
  const sideWNow = sideHidden ? 0 : sideW;

  /* 侧栏整块拿掉时**不要播滑出动画**。
     --side-w 从 280 变 0 会带着 .main 的 margin-left 一起过渡（300ms），
     看起来就像「侧栏缩回去了」—— 可侧栏压根没渲染过，没有东西可缩。
     这里是切**视图形态**（开了/关了一个设置），不是用户拖的开关，瞬时到位更对。
     手法和 jumpCollapsed 一样：临时挂 .no-anim，两帧后摘掉。 */
  useEffect(() => {
    const app = document.querySelector(".app");
    if (!app) return undefined;
    app.classList.add("no-anim");
    const t = requestAnimationFrame(() => requestAnimationFrame(() => app.classList.remove("no-anim")));
    return () => cancelAnimationFrame(t);
  }, [sideHidden]);

  return (
    <div className="app" style={{ "--side-w": sideWNow + "px", "--side-anim": SIDE_ANIM_MS + "ms" }}>
      {/* 一个库都没有 = 首次启动。整屏换成引导，不渲染主界面：
          没有工作目录时编辑/搜索/回收站全都无从谈起，摆一个空壳界面
          只会让人对着侧栏发呆，不如先问清楚。 */}
      {!loadingRoots && roots.length === 0 && (
        <Setup info={setupInfo} busy={setupBusy} onPick={pickSetupRoot} onBrowse={browseSetupRoot} />
      )}
      {roots.length > 0 && (
      <>
      {panel && <div className="kb-backdrop" onMouseDown={() => closePanel()} />}
      {/* ref={sideRef} 原来是给 peek 用的（判断指针是否还停在面板命中区里），
          2026-10-18 恢复 peek 后重新挂上。下面那条说明已经不成立了，
          一并摘掉 —— 留一个没人用的 ref 只会让人以为还有用途。 */}
      {/* 外部文件 + 设置开启时整块不挂载（见上面 sideHidden 的说明） */}
      {!sideHidden && (
      <aside
        ref={sideRef}
        className={"side" + (collapsed ? " collapsed" : "") + (peeking ? " peeking" : "")}
        onMouseDown={(e) => {
          // 知识库菜单展开时，点侧栏里菜单以外的地方要收起它。
          // 以前全屏 .kb-backdrop 顺带兜了侧栏这一侧；现在 .side 的层叠上下文在
          // backdrop 之上（为了让下拉能点到），侧栏这一侧得自己判断。
          // .kb-row 是开关本身，交给它自己的 toggle，否则这里先关、click 又开回来。
          if (panel && !e.target.closest(".kb-drop") && !e.target.closest(".kb-row")) closePanel();
          /* 浮出态：把「点一下就常开」这条接到面板自己身上（2026-10-18）。
             浮层压过顶栏之后（.side.peeking z-index 33 > .topbar 31），
             顶栏那个触发按钮被卡片盖住了 —— 而且**救不回来**：
             .topbar 自己就是一个层叠上下文（position:relative + z-index），
             里面的子元素再怎么抬 z-index 也只能排在 .topbar 那一层里，
             出不了它的上下文。所以「hover 按钮浮出、click 按钮常开」这条
             在浮出之后是点不到的，只能由浮层接管：
             在浮层里做的任何操作都视为「用户要留着它」，顺手把收起态清掉。
             mousedown 而不是 click：先切状态再让那一下 click 落到行上，
             用户看到的就是「点开并常驻」，而不是「点了但侧栏缩回去了」。
             标了 data-peek-stop 的控件例外 —— 目前只有「收起侧栏」，
             它的意思正好相反。 */
          if (peeking && !e.target.closest("[data-peek-stop]")) setCollapsedSafe(false);
        }}
        >
        {/* 无标题栏：整条顶栏都是窗口拖拽区（按钮会自动阻断拖拽） */}
        {/* has-tl 已经删掉：它只加左内边距，而这排按钮是 margin-left:auto 右对齐的，
            缩不缩内容盒渲染结果完全一样（styles.css 里留了记录）。
            红绿灯的横向让位只在侧栏收起时需要，那边走 .topbar.inset。 */}
        <div className="side-top" data-tauri-drag-region="deep">
          {/* 右：新建笔记 + 收起侧栏。收起按钮排在整排最右边，
              所以放进 ops 容器（靠 margin-left:auto 整块贴右）而不是排在前面。 */}
          <div className="side-top-ops">
            <button className="icon-btn" title="新建笔记" disabled={!curRoot}
              onClick={() => curRoot && onCreate({ type: "dir", rel: "", name: rootName(curRoot) }, "file")}>
              {ICONS.squarePen}
            </button>
            <button className="icon-btn" title="收起侧栏" data-peek-stop
              onClick={() => setCollapsedSafe(true)}>
              {ICONS.panel}
            </button>
          </div>
        </div>

        {/* 第二行：长条搜索（图标 + 快速搜索 + ⌘K 提示）。整条都可点，⌘K 直接聚焦 */}
        <button className="side-search" title="快速搜索（⌘K）" onClick={() => setPaletteOpen(true)}>
          <span className="ss-icon">{ICONS.search}</span>
          <span className="ss-label">快速搜索</span>
          <kbd className="ss-kbd">⌘K</kbd>
        </button>

        <div className="tree">
          {query && <div className="tree-hint">在 {kbName} 中匹配</div>}
          {loadErr ? <div className="empty-row err">{loadErr}</div> :
          !tree ? <div className="empty-row">加载中…</div> :
            <>
              {/* 最近：只读快捷入口，不提供新建/重命名/删除。
                  secVis.recent 关掉时整栏不挂载；搜索中也不挂（搜索结果走下面「笔记」）。*/}
              {!query && secVis.recent && (
                <>
                  <div className={"section-head" + (sec.recent ? "" : " closed")}
                    onClick={() => toggleSec("recent")}>
                    <span className="sec-name">最近</span>
                    <span className="sec-chev">{sec.recent ? ICONS.chevD : ICONS.chevR}</span>
                  </div>
                  <Drawer open={sec.recent}>
                    {recentList.length > 0 ? (
                      recentList.map((r) => (
                        <div className="node" key={r.rel}>
                          <div className={"row readonly" + (doc?.rel === r.rel ? " active" : "")}
                            style={{ paddingLeft: INDENT_FIRST }} title={r.rel}
                            onClick={() => openFile({ type: "file", rel: r.rel, name: r.name })}>
                            <span className="icon file"><CustomIcon icon={icons[r.rel]} fallback={ICONS.fileText} /></span>
                            <span className="name">{dispName(r.name)}</span>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="sec-empty">近 {RECENT_DAYS} 天打开过的笔记会出现在这里</div>
                    )}
                  </Drawer>
                </>
              )}

              {/* 笔记：当前知识库的完整目录。
                  「隐藏笔记」不能把搜索结果也一起藏掉 —— 搜索是跨分组的内容检索，
                  隐藏的是侧栏的常驻结构，不是把某批文件从检索里摘出去。
                  所以这里用 query || secVis.notes：搜索时无条件显示。*/}
              {(query || secVis.notes) && (<>
              <div className={"section-head" + (sec.notes || query ? "" : " closed")}
                onClick={() => toggleSec("notes")}>
                <span className="sec-name">笔记</span>
                <span className="sec-chev">{sec.notes || query ? ICONS.chevD : ICONS.chevR}</span>
                {/* 只留「新建文件夹」一个按钮：新建笔记走顶部 ✎，⋯ 菜单没内容，
                    两个占位按钮摆在这只会让人以为点得动 */}
                {(!query) && (
                  <span className="section-acts" onClick={(e) => e.stopPropagation()}>
                    <button title="新建文件夹" onClick={() => onCreate({ type: "dir", rel: "", name: "" }, "dir")}>{ICONS.folderPlus}</button>
                  </span>
                )}
              </div>
              {/* 搜索时强制展开：query 下没有「收起」这个概念，
                  否则点一下标题栏会把正在看的结果收起来。*/}
              <Drawer open={sec.notes || !!query}>
                {notesEmpty ? (
                  query ? <div className="empty-row">没有匹配的笔记</div> :
                    <div className="empty-row" onClick={() => onCreate({ type: "dir", rel: "", name: rootName(curRoot) }, "file")}>
                      {ICONS.plus} 新建第一篇笔记
                    </div>
                ) : (
                  <>
                    {/* 根层走**一段 nodes**，不再分 folders/files 两次 map ——
                        服务端返回的是两段，分开渲染就等于把「文件夹在前」
                        焊死在了 DOM 结构里：文件永远排在所有文件夹后面，
                        拖到第一条文件行之前也只能落到文件夹后面
                        （用户 2026-10-13 报「文件夹和文件无法做平级排序」）。
                        sortTree 在手动档下已经把两者混排进 nodes。 */}
                    {filtered.nodes.map((n) => (
                      <FileTree key={n.rel} node={n} depth={0} root={curRoot} openFile={openFile} icons={icons}
                        active={doc?.rel} onCreate={onCreate} onDelete={onDelete}
                        onMenu={setMenu} activeName={doc?.name} dnd={dnd} />
                    ))}
                  </>
                )}
              </Drawer>
              </>)}
            </>}

          {/* 其它：回收站做成一条 item，点开才列出被删掉的东西。
                  「其它」被隐藏时回收站跟着一起走 —— 这一点在设置面板里有灰色小字
                  明写（"包含回收站"），因为隐藏一整栏在用户看来很像数据丢了。*/}
          {!query && secVis.other && (
            <>
              {/* 和「最近」「笔记」同构：标题栏可折叠 + 三角跟随状态
                  （折叠时整栏只剩标题，回收站那一行也一起收起来） */}
              <div className={"section-head" + (sec.other ? "" : " closed")}
                onClick={() => toggleSec("other")}>
                <span className="sec-name">其它</span>
                <span className="sec-chev">{sec.other ? ICONS.chevD : ICONS.chevR}</span>
              </div>
              <Drawer open={sec.other}>
              <>
              <div className="node">
                {/* 展开时挂 active（不只是 open）：.row.active 那套底色 / 字色 /
                    active+hover 的表现和普通条目是同一条规则，这里直接复用，
                    不要为回收站另写一套 active 样式 */}
                <div className={"row trash-entry" + (sec.trash ? " active open" : "")}
                  onClick={() => toggleSec("trash")} title="回收站">
                  <span className="icon trash">{ICONS.trash}</span>
                  <span className="name">回收站</span>
                  {/* 数量徽标和「清空」按钮**占同一个位置**（.trash-slot 叠在一起）：
                      hover 这个位置 = 数量淡出、清空按钮淡入，两者在同一格互换，不左右推挤。
                      之前是数量在流里、按钮 margin-left:auto 另起一格，两个都在右边却是错开的。

                      清空挂在回收站这一行上（不放「其它」标题栏里）：它是回收站的操作，
                      不是分组的操作。图标用扫帚，区分于这一行入口的垃圾桶。 */}
                  {trashItems.length > 0 && (
                    <span className="trash-slot"
                      onClick={(e) => e.stopPropagation()}>
                      {/* 数量只在展开时出现：折叠态只留图标 + 名称 + 箭头，够干净 */}
                      {sec.trash && <span className="sec-count">{trashItems.length}</span>}
                      <span className="trash-acts">
                        <button title="清空回收站" aria-label="清空回收站"
                          onClick={() => emptyTrash()}>{ICONS.broom}</button>
                      </span>
                    </span>
                  )}
                  <span className="sec-chev">{sec.trash ? ICONS.chevD : ICONS.chevR}</span>
                </div>
              </div>
              <Drawer open={sec.trash}>
                {trashItems.length === 0
                  ? <div className="empty-row">回收站是空的</div>
                  : trashItems.map((it) => (
                    <div className={"node" + (preview && preview.trashRel === it.trashRel ? " active" : "")}
                      key={it.trashRel}>
                    {/* 整行可点 = 预览（和文件树里点一行开文件一个手势）。
                        原来这行完全不可点，只有右侧两个小按钮能操作。 */}
                    <div className="row trash-row" title={it.rel}
                      onClick={() => !it.isDir && openPreview(it)}
                      style={it.isDir ? { cursor: "default" } : null}>
                      <span className={"icon " + (it.isDir ? "dir" : "file")}>
                        {it.isDir ? ICONS.dir : ICONS.fileText}
                      </span>
                      <span className="name">{dispName(it.name)}</span>
                      <span className="trash-time">{fmtAgo(it.at)}</span>
                      <span className="row-actions">
                        {/* 目录进不去编辑区（预览的是文件正文），不给这个按钮 */}
                        {!it.isDir && (
                          <button title="预览" aria-label={`预览 ${dispName(it.name)}`}
                            onClick={(e) => { e.stopPropagation(); openPreview(it); }}>{ICONS.fileText}</button>
                        )}
                        <button title="恢复" onClick={(e) => { e.stopPropagation(); restoreItem(it); }}>{ICONS.restore}</button>
                        <button title="彻底删除" onClick={(e) => { e.stopPropagation(); purgeItem(it); }}>{ICONS.trash}</button>
                      </span>
                    </div>
                    </div>
                  ))}
              </Drawer>
              </>
              </Drawer>
            </>
          )}
        </div>

        {/* 底部两个入口，两个面板，职责不重叠：
            主行（头像 + 库名）= 切换，看列表
            四点按钮           = 操作，设置 / 默认应用 / 移除
            之前两个都开同一个面板，操作项混在切库列表中间，扫一眼分不清
            「切库」和「改这个库」是两种意图，不该挤在一处。*/}
        <div className="side-foot">
          <div className={"kb-row" + (panel === "kb" ? " open" : "")}
            onClick={() => togglePanel("kb")} title="切换知识库">
            {kbAvatar(curRootObj)}
            <span className="kb-name">{rootName(curRoot) || "未选择"}</span>
            {/* 文字后面这枚箭头：说明这一行能展开。
                右边那个四点按钮不挂它 —— 它锚在自己那个面板上，
                两边箭头都指向自己的菜单，一眼能分清。 */}
            <span className="kb-caret">{ICONS.chevR}</span>
          </div>
          <button className={"icon-btn" + (panel === "kbops" ? " on" : "")}
            title="知识库操作" onClick={() => togglePanel("kbops")}>
            {ICONS.gridCircles}
          </button>

          {panel === "kb" && (
            <div className={"kb-drop kb-menu" + (panelOut ? " kb-drop-out" : "")}>
              {/* 抬头：知识库名 + 右侧笔记总篇数（原先在侧栏最底下那行 .foot-count）。
                  左边那枚图标就是「改知识库图标」的入口（和文件标题区的大图标一个路子，
                  复用同一个 IconPicker）。外面套 .kb-av-btn 是因为 .kb-head 整块不可点，
                  得让图标单独成为 button 才有点击区域。 */}
              <div className="kb-head">
                <button className="kb-av-btn" title="更改知识库图标"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!curRoot) return;
                    openIconPicker({
                      node: { rel: curRoot, name: kbName, type: "kb" },
                      rect: (r => ({ left: r.left, top: r.bottom, bottom: r.bottom, width: r.width }))(e.currentTarget.getBoundingClientRect()),
                      via: "kb",
                    });
                  }}>
                  {kbAvatar(curRootObj)}
                </button>
                <span className="kb-text">
                  <span className="kb-name">{rootName(curRoot) || "未选择"}</span>
                  <span className="kb-total">{fileCount} 篇笔记</span>
                </span>
              </div>

              {/* 抬头和切库列表之间要一条线：抬头是「当前是哪个库」的信息，
                  下面是「可以切到哪些」，不隔开的话两段读起来是同一坨 */}
              <div className="kb-divider" />

              {/* 切库 */}
              <div className="kb-list">
                {roots.length === 0 && <div className="kb-empty">还没有知识库</div>}
                {roots.map((r) => (
                  <div key={r.path}
                    className={"kb-opt"
                      + (r.path === curRoot ? " cur" : "")
                      + (r.exists ? "" : " missing")}
                    title={r.exists ? r.path : `目录不存在：${r.path}`}
                    onClick={() => {
                      /* 目录没了就**说出来**，别默默不响应。
                         以前只有一句 `if (r.exists)` 就完事，点了什么也不发生，
                         用户会以为是自己点错了位置。后端也不再偷偷把空目录建回来，
                         两边对上：标记失效 + 讲清楚为什么切不过去。 */
                      if (!r.exists) {
                        showToast(`找不到「${r.name}」的目录，可能被移动或删除了：${r.path}`);
                        return;
                      }
                      setCurRoot(r.path);
                      closePanel();
                    }}>
                    <span className="kb-opt-icon">{kbIcon(r)}</span>
                    <span className="kb-name">{r.name}</span>
                    {/* ✓ 贴最右。原来这里还有一对 hover 才冒出来的「+ / ⋯」按钮，
                        是没接功能的占位（onClick 只有 stopPropagation），点了没反应，
                        反而让人以为是可用的行内操作，去掉。
                        失效的库用一个叹号代替勾 —— 它没有内容可「切过去」。 */}
                    {r.exists
                      ? <span className="kb-check">{r.path === curRoot && ICONS.check}</span>
                      : (
                        /* 失效的库给一个**能删**的出口（2026-10-18）。
                           只有失效行才有：正常库在四点菜单里已经能「移除当前
                           知识库」，再塞一个 ✕ 就是两个入口干同一件事。
                           平时藏起来，hover 才冒出来，不给列表添常驻噪声。 */
                        <>
                          <span className="kb-check kb-check-warn" title="目录不存在">!</span>
                          <button className="kb-drop" title="从列表移除（不删除文件）"
                            onClick={(e) => { e.stopPropagation(); removeRoot(r.path); }}>
                            {ICONS.trash}
                          </button>
                        </>
                      )}
                  </div>
                ))}
                <button className="kb-item link" onClick={() => { closePanel(); addRoot(); }}>
                  {ICONS.plus} 添加知识库
                </button>
              </div>
            </div>
          )}

          {/* 四点按钮的操作面板：设置 / 设为默认应用 / 移除。
              挂 .ops —— 锚点从整个底栏改成四点按钮自己（右对齐 + 从右下角长出来），
              两个面板的弹出位置和原点都不一样，不用点开才知道这是另一个菜单。*/}
          {panel === "kbops" && (
            <div className={"kb-drop kb-menu ops" + (panelOut ? " kb-drop-out" : "")}>
              <div className="kb-list">
                <button className="kb-item" onClick={() => { closePanel(); setSettingsOpen(true); }}>
                  {ICONS.gear} 设置
                </button>
                {/* 「设为 .md 默认应用」：bundle.fileAssociations 只是让系统认得我们，
                    真正改默认要走 LaunchServices（Rust 侧 set_default_markdown_app）。
                    只有 macOS 有这套机制，其它平台不显示这一项。 */}
                {showSetDefault && (
                  <button className="kb-item" title="向系统登记本应用为 .md 编辑器（若被别的应用抢走，去 Finder 的「打开方式 → 始终打开」）"
                    onClick={() => { closePanel(); setAsDefaultApp(); }}>
                    {ICONS.check} 设为 .md 默认应用
                  </button>
                )}
                <button className="kb-item danger" disabled={roots.length <= 1 || !curRoot}
                  onClick={() => { closePanel(); removeRoot(); }}>
                  {ICONS.trash} 移除当前知识库
                </button>
              </div>
            </div>
          )}
        </div>
      </aside>
      )}

      {/* 拖拽热区中心对齐**卡片的右边框**，不是 .side 的右缘。
          卡片内缩了 --side-inset，右边框落在 sideW - inset 上；这里取同一个值，
          于是「瞄准那条看得见的边拖」和「瞄准侧栏最右边拖」都落在同一处。
          RESIZER_HALF 是热区半宽：16 宽 → 跨 sideW-18 … sideW-2，
          右端停在主区之前 2px，不会抢走主区最左侧的点击。 */}
      {/* sideHidden 也要判：外部文件窗口整块侧栏都不渲染（sideHidden），
          那条 16px 的热区却还挂在 sideW 位置 —— 光标移过去照样变成 col-resize、
          tooltip 照样写「拖动调整侧栏宽度」，而底下根本没有侧栏可调
          （用户 2026-10-16 报）。热区必须和它调的那个东西同生共死。 */}
      {!collapsed && !sideHidden && (
        <div className="side-resizer"
          style={{ left: sideW - RESIZER_HALF - SIDE_INSET }}
          title="拖动调整侧栏宽度" onPointerDown={startResize} />
      )}

      {/* 侧栏脱离了 flex 流，主区左边靠自己让出 --side-w（见 .main.collapsed） */}
      <main className={"main" + (collapsed ? " collapsed" : "")}>
        {/* 侧栏收起时顶栏贴到窗口最左：只有真桌面端有红绿灯才需要让出左侧空位，
            浏览器里没有红绿灯，贴最左不留白 */}
        {/* 预览时**不是再加一条 bar，是这一条自己换内容**。
            原来预览条和顶栏同时在屏幕上、两条高度差不多只是内容不同，
            看起来就是「顶栏裂成两半」。现在：正常 = 顶栏，预览 = 同一条 bar，
            左端多一段「回收站」、右边换成还原/彻底删除/关闭。
            顶栏**样式一点不改**（白底、无底边线，和平时完全一样）——
            区分靠内容，不靠给这条 bar 换一身皮。 */}
        <div className={"topbar"
            /* inset = 给红绿灯让位。侧栏被**收起**或被**整块拿掉**（外部文件）
               两种情况顶栏都会贴到窗口最左，都要让开。
               之前只判 collapsed，去掉 jumpCollapsed 之后外部文件这条路就漏了，
               红绿灯直接压在面包屑上。 */
            + ((collapsed || sideHidden) && HAS_TRAFFIC_LIGHTS && !nativeFs ? " inset" : "")
            + (editorScrolled ? " scrolled" : "")} data-tauri-drag-region="deep">
          <div className="tb-left">
            {/* 只在**侧栏收着**时出现 —— 这是把它展开回来的唯一入口。
                ⚠️ 这里曾经写成 `collapsed || sideHidden ? " hidden" : ""`，
                整个三元反了：收起时不显示、展开时反倒显示（用户报「收起后按钮不见了」）。
                正确是 `collapsed && !sideHidden`：
                  · 库内笔记 + 侧栏收着 → 显示（用户要的就是能展开回来）
                  · 库内笔记 + 侧栏展开 → 藏（按钮和侧栏同时在会重复）
                  · 外部文件 sideHidden → 藏（压根没有侧栏可展开，点了是空操作；
                    回库那条路在顶栏三点菜单里）
                顺带：侧栏被整块拿掉时这排会空着，红绿灯的 inset 已经让出位置，
                不必再塞别的东西进来。 */}
            {/* hover 浮出侧栏（2026-10-18 用户定的触发点）。
                之前用的是「窗口左缘 10px 命中条」，看不见、摸不着；
                顶栏这个按钮本来就是「侧栏收起了」的信号，悬停它浮出来
                既看得见又不会误触（2026-10-18 用户指正）。
                click 仍然是「永久展开」，两条路都在。 */}
            <button ref={peekTriggerRef}
              className={"expand-btn" + (collapsed && !sideHidden ? "" : " hidden")} title="展开侧栏（悬停可临时浮出）"
              onMouseEnter={collapsed && !sideHidden ? openPeek : undefined}
              onClick={() => setCollapsedSafe(false)}>
              {ICONS.panel}
            </button>
            {/* 完整路径：知识库 / 各层文件夹 / 文件名。doc.rel 形如 "测试用目录/PlayGround.md"，
                按 / 拆开逐段显示；同名文件分布在不同目录时也能一眼看出自己在哪 */}
            {/* 外部文档没有知识库根，直接把绝对路径摊开；知识库文档照旧拆成层级 */}
            {doc && doc.external ? (
              <ExternalCrumb absPath={doc.rel} name={doc.name} />
            ) : (
            <span className="crumb" title={doc ? `${rootName(curRoot)} / ${doc.rel}` : ""}>
              <span className="seg">{rootName(curRoot)}</span>
              {/* 分段渲染，结构必须和外部文件那条一致：首段 / 可压缩的中间组 / 末段。
                  窄窗口时收缩的是中间组（.crumb-mid 出省略号），首段（知识库名）和
                  末段（文件名）都 flex:0 0 auto 保持完整 —— 文件名被截掉就没法判断
                  在哪个文件了。以前这里是「一长串 .crumb-part 平铺 + .crumb 换行」，
                  换行会撑破 .topbar 那条固定 44px 高度。 */}
              {/* 预览时面包屑走预览那份的 rel —— doc 仍是上一篇（或者 null），
                  不换的话顶栏会指着另一篇文档，标题栏却在显示回收站里的内容。
                  最前面插一段「回收站」，让「现在不在正常文档流里」这件事
                  一眼可见，而不是靠右侧那几个按钮去猜。 */}
              {preview && (
                <span className="crumb trash-crumb">
                  <span className="seg on">{ICONS.trash} 回收站</span>
                </span>
              )}
              {(preview || doc) && (() => {
                const segs = buildCrumbs((preview || doc).rel);
                if (!segs.length) return null;
                const only = segs.length === 1;
                const tail = only ? null : segs[segs.length - 1];
                const head = only ? [] : segs.slice(0, 1);
                const mid = only ? [] : segs.slice(1, -1);
                const one = (c, i, isCur) => {
                  const ic = icons && icons[c.rel];
                  return (
                    <span key={i} className="crumb-part">
                      <span className="csep">/</span>
                      {/* 图标：只有设了「非默认图标」的段落才显示，和树里的规则一致。
                          中间组里不画图标 —— 那里本来就要被省略号吃掉，图标只会添乱。 */}
                      {ic ? <span className="crumb-ic"><CustomIcon icon={ic} fallback={null} /></span> : null}
                      <span className={isCur ? "cur" : "seg"}>{dispName(c.name)}</span>
                    </span>
                  );
                };
                return (
                  <>
                    {head.map((c, i) => one(c, i, false))}
                    {mid.length > 0 && (
                      <span className="crumb-mid">
                        {mid.map((c, i) => (
                          <span key={"m" + i} className="mid-item">
                            <span className="csep">/</span>{dispName(c.name)}
                          </span>
                        ))}
                      </span>
                    )}
                    {only ? one(segs[0], "t", true) : one(tail, "t", true)}
                  </>
                );
              })()}
            </span>
            )}
          </div>

          {/* 右：三点菜单。**不用 :hover 打开** —— 指针从面包屑扫到最右才亮起来
              是靠不住的（中间的省略号段会吃掉 hover），而且菜单里有二级子菜单，
              hover 态得一直挂着才行。改成点开。 */}
          <div className="tb-right">
            {/* 预览：还原 / 彻底删除 / 关闭，**不挂三点菜单** ——
                预览里那些开关（字号、大纲粒度…）改的都是「库」和「全局」，
                对着一个即将被恢复的文件调它们只会让人困惑。
                锁提示也不显示：左边已经有「回收站」分段了，重复一遍更啰嗦。 */}
            {preview ? (
              <>
                <button className="tb-act danger" onClick={() => purgeItem(preview)}
                  title="从回收站永久删除，无法恢复">{ICONS.trash} 彻底删除</button>
                <button className="tb-act" onClick={() => restoreItem(preview)}>
                  {ICONS.restore} 还原
                </button>
                <button className="tb-act ghost" onClick={() => setPreview(null)}
                  title="关闭预览（Esc）">{ICONS.x} 关闭</button>
              </>
            ) : (
            /* 锁定提示，紧挨在三点按钮左边 —— 开关就在旁边，状态和开关
                挨着放才不用满屏找「在哪儿解的锁」。可点：直接解锁。
                之前放在正文标题上方，但锁是个全局模式，在正文里留一行提示
                既和标题抢位置、又像是这篇文档的属性。 */
            <>
            {doc && readOnly && (
              <button className="tb-lock" title="已锁定，点击解锁"
                onClick={() => setReadOnly(false)}>
                {ICONS.lock} 锁定
              </button>
            )}
            <button className={"icon-btn" + (panel === "quick" ? " on" : "")}
              title="显示与视图" aria-label="显示与视图"
              onClick={() => togglePanel("quick")}>
              {ICONS.menu}
            </button>
            {panel === "quick" && (
              <TopMenu out={panelOut} showOutline={showOutline} onOutline={setOutline}
                showRail={showRail} onRail={setRail}
                showMini={showMini} onMini={setMini}
                showSaveFlag={showSaveFlag} onSaveFlag={setSaveFlag}
                showProps={showProps} onShowProps={setShowProps}
                docStats={docStats} onDocStats={saveDocStats}
                edFont={edFont} onFont={setEdFontPx}
                edSpacing={edSpacing} onSpacing={setEdSpacingPx}
                wide={wide} onWide={setWideMode}
                readOnly={readOnly} onLock={setReadOnly}
                sideHidden={sideHidden} onBackToLibrary={backToLibrary}
                onOpenSettings={() => { closePanel(); setSettingsOpen(true); }}
                /* 动作项点了要把菜单收掉 —— 和侧栏那几个 .kb-item 一个路子
                   （它们也是 onClick 里先 closePanel()）。
                   只有「查找与替换」这么做：那几颗开关/子菜单是「改设置」，
                   用户可能要连着拨几个，菜单留着才顺手；
                   查找是「跳到别处干活」，菜单该让位。 */
                onFind={() => { setFindTick((n) => n + 1); closePanel(); }} />
            )}
            </>
            )}
          </div>
        </div>
        <Suspense fallback={<EditorSkeleton />}>
        {preview ? (
          /* 回收站预览。key 用 trashRel —— 和底下那篇真文档的 key 不同，
             切换时 EditorPane 会整体重建，不会拿上一份 Crepe 实例去改内容。
             **不传 onTitleCommit / onFlushSave / onDirtyChange**：
             预览不该改名、不该影响脏标记、不该往 App 交回一个保存句柄。
             preview=true 让 EditorPane 强制锁定 + doSave 硬短路。 */
          <EditorPane key={"trash:" + preview.trashRel}
            doc={{ id: "trash:" + preview.trashRel, root: curRoot,
                   rel: preview.rel, name: preview.name, content: preview.content }}
            onStats={pushStats}
            titleIconEl={null} hasTitleIcon={false} smileyEl={ICONS.smile}
            showRail={showRail} showOutline={showOutline}
            readOnly={false} preview findTick={findTick} showProps={false} />
        ) : doc ? (
          <EditorPane key={doc.id} doc={doc}
            onSaved={() => { setDirty(false); touchRecent(doc.rel, doc.name); }}
            /* 存盘后刷新属性面板的「更新时间」（只对库外文件有意义，
               库内那份来自 /api/tree，下次拉树自然更新）。 */
            onDocTime={(ms) => setDoc((d) => (d && d.external ? { ...d, updated: ms } : d))}
            onConflict={setConflict}
            onSaveError={(e) => showToast(`保存失败：${e?.message || e}`)}
            onReloadDoc={async () => { setConflict(null); await openFileRef.current?.(); }}
            onFlushSave={(fn) => (saveFlushRef.current = fn)}
            onDirtyChange={setDirty}
            onStats={pushStats}
            titleIconEl={<CustomIcon icon={docIcon} fallback={null} />}
            hasTitleIcon={!!docIcon}
            /* 外部文件不提供「添加图标」：图标是知识库树里的身份标识，
               而外部文件不在树里，它那份 icon 只存 localStorage、谁也不读。 */
            showIconUi={!doc.external}
            onScrolledChange={setEditorScrolled}
            smileyEl={ICONS.smile}
            onPickIcon={openTitleIcon}
            onTitleCommit={onTitleCommit}
            onTitleFlush={flushTitleRename}
            onTitleCancel={cancelTitleRename}
            showRail={showRail} showOutline={showOutline} showMini={showMini}
            readOnly={readOnly} findTick={findTick}
            showProps={showProps} onShowProps={setShowProps} />
        ) : (
          <div className="placeholder">
            <div className="ph-emoji">📓</div>
            <div className="ph-main">选择左侧笔记开始编辑，或新建一篇</div>
            <div className="ph-tip">Markdown 编辑器 · 落盘 .md · 多知识库</div>
          </div>
        )}
        </Suspense>
        {/* 右下角胶囊。保存状态是一个开关，文字统计是多选（设置 › 编辑器）：
            统计那半只显示勾中的那几项，任一半关掉时对应的不渲染，两半都关整个胶囊不挂载。
            stats-only：状态点(::before)属于「已保存」那一半，没了状态点要跟着没，
            不然会剩一颗没有主语的绿点。 */}
        {doc && (showSaveFlag || docStats.length > 0) && (
          <span className={"save-float"
            + (dirty && showSaveFlag ? " dirty" : "")
            + (!showSaveFlag ? " stats-only" : "")}>
            {showSaveFlag && (
              <span className="save-flag">{dirty ? "保存中…" : "已保存"}</span>
            )}
            {docStats.length > 0 && (
              /* 左边距 + 竖线是「跟在保存状态后面」的分隔，单开时前面没有东西可分隔 ——
                 styles.css 的 `.save-float > .doc-stats:first-child` 已经把那一档收掉了。
                 按 ALL_STATS_KEYS 过滤而不是直接用 docStats：勾选顺序可能是乱的，
                 胶囊上的排列顺序得永远是 字数 · 词数 · 字符数。 */
              <DocStats units={docStats} />
            )}
          </span>
        )}
      </main>

      {toast && <div className="toast">{toast}</div>}

      {/* 角落的「要不要把这个文件夹加为知识库」。pointer-events 只开在卡片自己
          上，遮罩整屏是禁止的 —— 它不能挡用户继续编辑（2026-10-18 用户定的
          「不打断」，原来那个是盖住整屏的模态框）。
          z-index 高过 .toast，但比 .dlg-mask 低：真要确认的对话框仍然最上层。 */}
      {kbOffer && (
        <div className="kb-offer">
          <div className="kb-offer-t">
            {kbOffer.name ? `${kbOffer.name} 不在任何知识库里` : "这个文件夹不在知识库里"}
          </div>
          <div className="kb-offer-p" title={kbOffer.dir}>{kbOffer.dir}</div>
          <div className="kb-offer-b">
            <button className="ghost" onClick={neverAskKbOffer}>以后不再提示</button>
            <button onClick={dismissKbOffer}>不用</button>
            <button className="primary" onClick={acceptKbOffer}>加进来</button>
          </div>
        </div>
      )}

      {menu && (
        <div className="ctx-backdrop" onMouseDown={closeMenu}>
          <div className="ctx" style={{ left: menu.x, top: menu.y }}
            onMouseDown={(e) => e.stopPropagation()}>
            {/* 独立窗口（打包版才有意义；浏览器里点会提示）。
                只对文档给，文件夹没有「打开」可言。 */}
            {menu.node.type !== "dir" && (
              <div onClick={async () => {
                const rel = menu.node.rel;
                const nm = menu.node.name;
                closeMenu();
                try {
                  await windows.spawnForDoc(rel, String(nm || "").replace(/\.md$/i, ""));
                  showToast("已在新窗口打开");
                } catch (e) {
                  showToast(`开不了新窗口：${e?.message || e}`);
                }
              }}>{ICONS.externalLink} 在新窗口打开</div>
            )}
            <div onClick={() => startRename(menu.node)}>{ICONS.pencil} 重命名</div>
            <div onClick={() => startIconPick(menu.node)}>
              {ICONS.star}<span className="grow">设置图标</span>
              {icons[menu.node.rel] && <span className="ctx-cur">{icons[menu.node.rel].kind === "emoji" ? icons[menu.node.rel].value : ""}</span>}
            </div>
            {menu.node.type === "dir" && (
              <div onClick={() => { closeMenu(); onCreate(menu.node, "dir"); }}>{ICONS.dir} 创建子文件夹</div>
            )}
            <div onClick={() => { closeMenu(); onCreate(menu.node, "file"); }}>{ICONS.fileText} 添加文档</div>
            <div className="danger" onClick={() => { closeMenu(); onDelete(menu.node); }}>{ICONS.trash} 删除</div>
          </div>
        </div>
      )}

      {settingsOpen && (
        <SettingsPanel onClose={() => setSettingsOpen(false)}
          secVis={secVis} onToggleSecVis={toggleSecVis}
          edFont={edFont} onFont={setEdFontPx}
          collapseOnExternal={collapseOnExternal} onCollapseExt={setCollapseExt}
          askAddRoot={askAddRoot} onAskAddRoot={setAskRoot}
          sidePeek={sidePeek} onPeek={setPeek}
          showSaveFlag={showSaveFlag} onSaveFlag={setSaveFlag}
          docStats={docStats} onDocStats={saveDocStats}
          sortMode={sortMode} onSortMode={setSortMode}
          /* 段落间距：SettingsPanel 早就接了这个开关，但**这里一直没往下传**
             —— 面板里的按钮点了会报 onSpacing is not a function。
             顶栏下拉那一处传了，所以那条路是通的，只有设置面板这条路断着。 */
          edSpacing={edSpacing} onSpacing={setEdSpacingPx}
          wide={wide} onWide={setWideMode}
          themeMode={themeMode} onTheme={setThemeMode}
          palette={palette} onPalette={setPalette} />
      )}

      {paletteOpen && (
        <SearchPalette files={allFiles} recent={recentList} onOpen={openFile}
          onNav={(rel) => {
            if (rel === "__trash__") setSec((s0) => ({ ...s0, trash: true, notes: true }));
            else showToast(rel === "__all__" ? "所有文档就在下面的「笔记」里" : "已定位到「笔记」分组");
          }}
          onClose={() => setPaletteOpen(false)} />
      )}

      {/* 这两个浮层自己再包一层：它们直接渲染用户存下来的图标数据，
          一旦有脏数据，炸掉的只应该是这个浮层，不是整个侧栏 + 编辑器 */}
      <ErrorBoundary fallback={null}>
      {renameNode && (
        <RenameCard node={renameNode.node} rect={renameNode.rect}
          icon={icons[renameNode.node.rel]}
          onIcon={(node, rect) => openIconPicker({ node, rect })}
          onCancel={() => setRenameNode(null)} onSubmit={onRename} />
      )}

      {iconNode && (
        <IconPicker node={iconNode.node} rect={iconNode.rect} out={icpOut}
          current={iconNode.via === "title" ? docIcon
            : iconNode.via === "kb" ? (roots.find((r) => r.path === iconNode.node.rel)?.icon || null)
            : icons[iconNode.node.rel]}
          onCancel={closeIconPicker}
          onPick={iconNode.via === "title" ? pickTitleIcon
            : iconNode.via === "kb" ? pickKbIcon
            : pickIcon} />
      )}
      </ErrorBoundary>

      {/* 原来这里写的是 key={dlg.title + Date.now()} —— 每次 App 重渲染 key 都变，
          对话框被整个重建：用户已经敲进去的字、busy/err 状态全丢，
          淡入动画也会每次重播（闪）。key 只在需要「同一位置强制换实例」时才用得上，
          而 dlg 置 null 时组件本来就卸载了，不需要 key。 */}
      {dlg && <Dialog dlg={dlg} out={dlgOut} onClose={closeDlg} />}
      {/* 写入冲突。放在 App 这层是因为它要能触发「重新打开当前篇」——
          那是 openFile，不是编辑器内部能做的事。 */}
      {conflict && <ConflictDialog c={conflict} onClose={() => setConflict(null)} />}
      </>
      )}
    </div>
  );
}

/* 侧栏/面包屑等展示用：隐藏 .md 后缀（真实文件名不变） */
const dispName = (n) => String(n || "").replace(/\.md$/i, "");

function rootName(p) {
  if (!p) return "";
  const q = p.replace(/\/$/, "");
  return q.split("/").filter(Boolean).pop() || q;
}
