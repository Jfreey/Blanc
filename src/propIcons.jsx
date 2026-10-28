import React from "react";

/* 属性面板用的图标。
 *
 * 用的是**项目里同一套 Lucide 描边图标**（24 网格 / 2px 描边 / 圆头圆角），
 * 和侧栏、顶栏、类型选择器里的完全一致 —— 这块面板夹在正文上方，
 * 混进 emoji 会和周围所有图标打架。
 *
 * 数据从 `lucideAll.js`（lucide-static@1.55.0）里按 key 取，和 `pickIcons.js`
 * 是同一份来源。**为什么不直接 那两个模块**：
 *   · `lucideAll.js` 674KB，`App.jsx` 是懒加载的，属性面板每篇笔记都要用，懒不了；
 *   · `pickIcons.js` 只有 128 枚，缺 hash / eye-off / git-branch 这些，
 *     而往里加会让它们出现在「选图标」面板里（那是给**文档**选图标的，不该混）。
 * 所以在这里固化一份小的，只取这块面板要用的十几枚。
 *
 * ⚠️ 和 `lucideAll.js` 顶部那条「只增不改名」一样：这些 key 是从 lucide-static
 * 直接取的，改名等于图标认不出来。升级 lucide 版本时要重新核一遍。
 */

export const PROP_ICONS = {
  /* ---- 类型的图标（和类型选择器共用一套）---- */
  tag: [["path", { "d": "M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" }], ["circle", { "cx": "7.5", "cy": "7.5", "r": ".5", "fill": "currentColor" }]],
  type: [["path", { "d": "M12 4v16" }], ["path", { "d": "M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2" }], ["path", { "d": "M9 20h6" }]],
  hash: [["line", { "x1": "4", "x2": "20", "y1": "9", "y2": "9" }], ["line", { "x1": "4", "x2": "20", "y1": "15", "y2": "15" }], ["line", { "x1": "10", "x2": "8", "y1": "3", "y2": "21" }], ["line", { "x1": "16", "x2": "14", "y1": "3", "y2": "21" }]],
  check: [["path", { "d": "M21.801 10A10.9 10.9 0 1 1 17 3.335" }], ["path", { "d": "m9 11 3 3L22 4" }]],
  calendar: [["path", { "d": "M8 2v4" }], ["path", { "d": "M16 2v4" }], ["rect", { "width": "18", "height": "18", "x": "3", "y": "4", "rx": "2" }], ["path", { "d": "M3 10h18" }]],

  /* ---- 系统属性那两行 ---- */
  clock: [["circle", { "cx": "12", "cy": "12", "r": "10" }], ["path", { "d": "M12 6v6l4 2" }]],
  "calendar-clock": [["path", { "d": "M8 2v4" }], ["path", { "d": "M16 2v4" }], ["rect", { "width": "18", "height": "18", "x": "3", "y": "4", "rx": "2" }], ["path", { "d": "M3 10h18" }], ["path", { "d": "M12 14v3l2 1" }]],

  /* ---- 配置菜单里的三个显隐档 + 删除 ---- */
  eye: [["path", { "d": "M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" }], ["circle", { "cx": "12", "cy": "12", "r": "3" }]],
  "git-branch": [["path", { "d": "M15 6a9 9 0 0 0-9 9V3" }], ["circle", { "cx": "18", "cy": "6", "r": "3" }], ["circle", { "cx": "6", "cy": "18", "r": "3" }]],
  "eye-off": [["path", { "d": "M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.588 3.275" }], ["path", { "d": "M11.733 11.733a2 2 0 0 1 2.834 2.834" }], ["path", { "d": "M21 12a9.003 9.003 0 0 1-2.636 6.364M9 17a9 9 0 0 0 5.001-2.333" }], ["path", { "d": "M2 8.82a15 15 0 0 0 4.177 5.943" }], ["path", { "d": "M2.002 2.002 22 22" }]],
  trash: [["path", { "d": "M10 11v6" }], ["path", { "d": "M14 11v6" }], ["path", { "d": "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" }], ["path", { "d": "M3 6h18" }], ["path", { "d": "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" }]],
  "chevron-right": [["path", { "d": "m9 18 6-6-6-6" }]],
};

/* 属性名 → 图标 key。不存 frontmatter（理由见需求 #5）。 */
const BY_NAME = {
  tags: "tag", "标签": "tag", tag: "tag", labels: "tag",
  status: "tag", "状态": "tag", priority: "tag", "优先级": "tag",
  author: "type", "作者": "type", creator: "type", "创建者": "type", owner: "type",
  type: "type", "类型": "type", category: "type", "分类": "type",
  score: "hash", rating: "hash", "评分": "hash", "重要度": "hash", weight: "hash",
  date: "calendar", "日期": "calendar", due: "calendar", deadline: "calendar",
  "截止": "calendar", "截止日期": "calendar", start: "calendar", "开始": "calendar",
  done: "check", "完成": "check", completed: "check", "已完成": "check", "归档": "check",
  version: "hash", "版本": "hash", "编号": "hash", count: "hash", "数量": "hash",
};

/* 类型 → 图标。和类型选择器里那五枚是同一套。 */
const BY_TYPE = {
  tags: "tag", text: "type", number: "hash", checkbox: "check", date: "calendar",
};

/* 「＋ 添加属性」自动分配的默认名就是**类型名本身**。这些名字不带信息 ——
   一条还叫「文本」的属性，本来也没法从名字看出它是文本类型。 */
const GENERIC_NAMES = new Set(["标签", "文本", "数字", "复选框", "日期"]);

/* 图标两条路，**按这个优先级**：
   ① 名字有实义（作者 / 状态 / 评分 / 截止日期…）→ 按名字给，信息量最大，
      哪怕它当前是别的类型（一条叫「日期」的属性是标签类型，
      给日历图标比给标签图标更贴切）。
   ② 名字还是自动分配的默认名 → 按**类型**给。
      ⚠️ 早先只走①，于是「换个类型、图标不变」—— 用户看着像没换成功。
      这条是 2026-10-13 用户报出来的。
   两条都不中就退回类型图标，至少和控件形态一致。 */
export const iconKeyFor = (name, type) => {
  const n = String(name ?? "");
  if (n === "tags" || GENERIC_NAMES.has(n)) return BY_TYPE[type] || "type";
  return BY_NAME[n] ?? BY_NAME[n.toLowerCase()] ?? BY_TYPE[type] ?? "type";
};

/* 渲染成 <svg>。els 是 [标签, 属性][] —— 和 pickIcons.js / lucideAll.js 的格式一致。
   刻意不走 App 的 iconByKey：那是给「文档图标」用的，会被 .icon.file svg 那条
   规则的颜色压住，这里要的是当前文字色。 */
export function PropIcon({ name, size = 14, className = "" }) {
  const els = PROP_ICONS[name] || PROP_ICONS.type;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      className={className} aria-hidden="true">
      {els.map(([tag, attrs], i) => React.createElement(tag, { key: i, ...attrs }))}
    </svg>
  );
}