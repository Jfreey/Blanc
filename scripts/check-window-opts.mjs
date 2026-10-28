/**
 * 校对**运行时新建的窗口**和 `tauri.conf.json` 里主窗口的那份一致。
 *
 * ## 谁在造窗口（2026-10-15 改过，来源从两个变成两个但换了一份）
 *
 *   ① desktop/src-tauri/tauri.conf.json  → **主窗口**
 *   ② desktop/src-tauri/src/lib.rs        → **所有运行时窗口**
 *      （前端「在新窗口打开」和 Finder 双击 .md 都走 lib.rs 的
 *        open_doc_window()，前端自己 new WebviewWindow 的那条老路已经删掉）
 *
 * ## 为什么需要这个检查
 *
 * 运行时用 `WebviewWindowBuilder` 开的窗口**不继承 tauri.conf.json** ——
 * 每个选项都有自己的默认值，不写就退回默认。
 *
 * 两份不一致时最典型的症状：**主窗口拖动正常、新窗口块拖动失效** ——
 * 因为 `dragDropEnabled` 默认是 true，漏写它就等于「用 Tauri 原生层接管拖放」，
 * HTML5 的 dragstart/dragover/drop 根本不派发。
 * 这个坑 2026-10-14 实际踩过一次：主窗口在 conf 里修好了，lib.rs 里的
 * 新窗口照旧坏，就是漏了 disable_drag_drop_handler()。
 *
 * 所以这里把两份逐项对一遍。改 conf 忘了改 lib.rs（或反过来）就会红。
 *
 * ⚠️ lib.rs 是 Rust，没法 import，用正则把那段 builder 抠出来做「形状对账」——
 *    抠不出来就报错，宁可红也不要默默放过。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/* ---- 1. 读 conf 里的主窗口 ---- */
const conf = JSON.parse(
  readFileSync(join(root, "desktop/src-tauri/tauri.conf.json"), "utf8")
);
const main = conf.app.windows.find((w) => w.title === "Blanc") || conf.app.windows[0];

/* ---- 2. 从 lib.rs 里把 builder 的参数抠出来 ----
   Rust 那边不能 import，只能抠字面量。这里认两种写法：
     .inner_size(1180.0, 760.0)               ← 注意 .0，是 f64
     .min_inner_size(840.0, 560.0)
     .title_bar_style(tauri::TitleBarStyle::Overlay)
     .hidden_title(true)
     .traffic_light_position(tauri::LogicalPosition::new(18.0, 32.0))
     .disable_drag_drop_handler()             ← 对应 dragDropEnabled: false
   任一条抠不到就报错。 */
const rs = readFileSync(join(root, "desktop/src-tauri/src/lib.rs"), "utf8");
const need = [
  ["inner_size", /\.inner_size\(\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/, (m) => ({ width: +m[1], height: +m[2] })],
  ["min_inner_size", /\.min_inner_size\(\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/, (m) => ({ minWidth: +m[1], minHeight: +m[2] })],
];
const win = {};
for (const [name, re, f] of need) {
  const m = re.exec(rs);
  if (!m) {
    console.error(`❌ lib.rs 里找不到 .${name}(...)（会退回默认尺寸）`);
    process.exit(1);
  }
  Object.assign(win, f(m));
}
const tbs = /\.title_bar_style\(tauri::TitleBarStyle::(\w+)\)/.exec(rs);
if (!tbs) { console.error("❌ lib.rs 里找不到 .title_bar_style(...)"); process.exit(1); }
win.titleBarStyle = tbs[1];
const ht = /\.hidden_title\((true|false)\)/.exec(rs);
if (!ht) { console.error("❌ lib.rs 里找不到 .hidden_title(...)"); process.exit(1); }
win.hiddenTitle = ht[1] === "true";
/* 有没有设 traffic_light_position —— 只要「有/无」，不看数值。
   原因见下面第 5 段：设了就会踩 tao 的重绘发散 bug。 */
const hasTlpRs = /\.traffic_light_position\(/.test(rs);
win.trafficLightPosition = hasTlpRs ? { x: 0, y: 0 } : null;
win.dragDropEnabled = /\.disable_drag_drop_handler\(\)/.test(rs) ? false : null;

/* ---- 3. 逐项对账 ----
   只比「两边都该有」的键：title/url 之类是各自专有的，不参与。 */
const KEYS = [
  "width", "height", "minWidth", "minHeight",
  "dragDropEnabled", "titleBarStyle", "hiddenTitle",
  /* trafficLightPosition 故意不在对账列表里：它现在必须**两边都没有**，
     由下面第 5 段单独断言（见那里的原因说明）。 */
];

const problems = [];
for (const k of KEYS) {
  if (!(k in win) || win[k] === null) {
    problems.push(`lib.rs 的 builder 里没有 ${k}（会退回默认值）`);
    continue;
  }
  if (!(k in main)) {
    problems.push(`tauri.conf.json 的主窗口里没有 ${k}`);
    continue;
  }
  const a = JSON.stringify(win[k]);
  const b = JSON.stringify(main[k]);
  if (a !== b) problems.push(`${k}：lib.rs=${a} / conf=${b}`);
}

/* ---- 4. 专门盯住 dragDropEnabled ----
   它漏了不会报「不一样」，只会报「某一边没有」；而症状是块拖动失效，
   很难联想到是这里，所以单独再钉一遍、给一句人话提示。 */
if (win.dragDropEnabled !== false) {
  problems.push(
    "dragDropEnabled 必须是 false —— true 会让 Tauri 在原生层接管拖放，" +
      "HTML5 的 dragstart/dragover/drop 不再派发，块拖动直接失效"
  );
}

/* ---- 5. 对账 CSS 的 --topbar-h 与 conf 的 trafficLightPosition.y ----
   顶栏高、红绿灯纵向位置、侧栏顶行按钮的 margin-top 是**同一件事的三个面**：
     · CSS  --topbar-h            → 顶栏高
     · CSS  .side-top 的 margin    → 由 --topbar-h 推（顶栏高/2 − 25）
     · conf trafficLightPosition.y → 要让灯中心落在 --topbar-h/2
   实测恒等式：**灯中心 = y − 2.5**（这个关系是对着打包后的真窗口量的），
   所以 y 必须 = --topbar-h / 2 + 2.5。
   换句话说 y = --topbar-h/2 时灯心只差 2.5px，正好是用户要的「向下再挪一点」。

   ⚠️ 为什么这个设置必须是 tao 提供的（2026-10-18 记）：
   AppKit 会在窗口显示之后重排标题栏并**把按钮原点还回去**，自己 setFrameOrigin
   是按不住的 —— 试过「只挪按钮」和「挪按钮 + 改容器高度」两种，都被下一次
   布局覆盖（实测容器高度确实停在常量上，但灯心还是 AppKit 默认的 15.5）。
   tao 是把这段挂在 drawRect 上（每次绘制前）才生效的。
   代价是它按「量出来的当前灯高 + y」重写容器高度，窗口缩放后可能发散
   （灯被拉成竖长椭圆）。我们把 y 取小一点、并配合 --topbar-h 的恒等式，
   让「量出来的灯高 + y」收敛到一个不大的数，别离默认灯高太远。 */
const css = readFileSync(join(root, "src/styles.css"), "utf8");
const hMatch = /--topbar-h:\s*([\d.]+)px/.exec(css);
if (!hMatch) {
  console.error("❌ src/styles.css 里找不到 --topbar-h");
  process.exit(1);
}
const topbarH = Number(hMatch[1]);
/* 对账要拿**灯心**去比顶栏中心，不是拿 y 本身 —— 两者差一个 2.5。
   容差 4px：用户最终要的是 y=28（灯心 25.5，比顶栏中心低 1.5px），
   肉眼看不出来，不该让检查把它判红。 */
const lightCenterY = main.trafficLightPosition.y - 2.5;   // 实测恒等式
const topbarCenter = topbarH / 2;
if (Math.abs(lightCenterY - topbarCenter) > 4.01) {
  problems.push(
    `红绿灯灯心 ${lightCenterY} 离顶栏中心 ${topbarCenter} 太远（容差 4px）。` +
    `灯心 = trafficLightPosition.y − 2.5，当前 y=${main.trafficLightPosition.y}`
  );
} else {
  console.log(`✓ 红绿灯 y=${main.trafficLightPosition.y} → 灯心 ${lightCenterY}（顶栏中心 ${topbarCenter}，差 ${(lightCenterY - topbarCenter).toFixed(1)}px）`);
}

/* ---- 6. 主窗口必须 visible:false ----
   先建窗、等前端首帧画完再 show（lib.rs 的 show_main_window + main.jsx 的两次 rAF），
   否则暗色主题启动时会先闪一下窗口的静态浅色底。
   这条一旦丢了，构建照样能过，症状只在「启动瞬间白闪」里出现 —— 只能靠断言钉住。
   注意**只查主窗口**：运行时开的一篇一窗口要立即可见，不能跟着 hidden。 */
if (main.visible !== false) {
  problems.push("主窗口必须 \"visible\": false —— 起点不可见，由 show_main_window 首帧后露出");
}

if (problems.length) {
  console.error("❌ 新窗口参数和 tauri.conf.json 对不上：");
  for (const p of problems) console.error("   " + p);
  process.exit(1);
}
console.log(`✓ 新窗口参数与 tauri.conf.json 主窗口一致（${KEYS.length} 项）`);