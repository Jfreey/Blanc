/* 侧栏树的排序（#6）。
 *
 * ⚠️ **排序在客户端做，服务端不参与**：/api/tree 回来的顺序是按名字排好的，
 * 「按创建 / 按修改」是**界面偏好**（存在 uiPrefs），不是库的属性 ——
 * 同一个库在两台机器上偏好不一样很正常。让服务端排就得把偏好传过去，
 * 而且每改一次偏好都要重拉整棵树。
 * 服务端只做两件事：把 `<库>/.order/_index.json` 那张表原样吐出来，
 * 以及拖完之后把新顺序写回去。
 */

/* 排序档。label 是设置面板里显示的字。 */
export const SORT_MODES = [
  { key: "manual", label: "手动排序", hint: "拖动调整" },
  { key: "name", label: "按名称", hint: "A → Z" },
  { key: "created", label: "按创建时间", hint: "新 → 旧" },
  { key: "updated", label: "按修改时间", hint: "新 → 旧" },
];

const byName = (a, b) => a.name.localeCompare(b.name, "zh");

/* 时间排序：**新 → 旧**（和 Finder 的「按修改日期」一致）。
   拿不到时间戳的排最后，而不是当成 0 排最前 ——
   文件夹没有 stat，硬当成 1970 年会让文件夹集体沉底，看着像坏了。 */
const byTimeDesc = (key) => (a, b) => {
  const x = typeof a[key] === "number" ? a[key] : null;
  const y = typeof b[key] === "number" ? b[key] : null;
  if (x === null && y === null) return byName(a, b);
  if (x === null) return 1;
  if (y === null) return -1;
  return y - x;
};

/* 手动档：有序号的按序号排，**没序号的排在有序号的后面**、彼此按名字。
   这个「后面」很重要：新加的文件没有序号，它得排在已经排好的那些后面，
   而不是插到最前面把用户摆好的位置顶开。 */
const byManual = (order) => (a, b) => {
  const x = order[a.rel];
  const y = order[b.rel];
  if (x === undefined && y === undefined) return byName(a, b);
  if (x === undefined) return 1;
  if (y === undefined) return -1;
  return x - y || byName(a, b);
};

const cmpFor = (mode, order) => {
  if (mode === "created") return byTimeDesc("created");
  if (mode === "updated") return byTimeDesc("updated");
  if (mode === "manual") return byManual(order || {});
  return byName;
};

/* **文件夹永远排在文件前面**，四个档位都一样 —— 这不是排序档的一部分，
   是「目录是容器、文件是内容」这个结构本身决定的。每一组内部才按档位排。 */
/* 手动档：**目录和文件混在一起排**（用户 2026-10-13 报的 ——
   「文件夹和文件无法做平级排序」）。手动排序的意义就是「我拖到哪它就在哪」，
   强行把文件夹顶到前面就废了一半。
   其余三个档位保持「文件夹在前」：那是按名字/时间看目录的常规约定，
   而且这三个档位本来就没人去拖。 */
const sortSiblings = (nodes, cmp, mode) => {
  if (mode === "manual") return nodes.slice().sort(cmp);
  const dirs = nodes.filter((n) => n.type === "dir").sort(cmp);
  const files = nodes.filter((n) => n.type !== "dir").sort(cmp);
  return [...dirs, ...files];
};

/* 递归重排整棵树。返回新对象，不改原树（React 靠引用判断变化）。
   ⚠️ 额外产出一个 **nodes**：根层的显示顺序。
   服务端 `/api/tree` 返回的是 `{folders, files}` 两段，而文件夹内部的
   `children` 是**一段混排**的 —— 于是「目录在前」这条规则只对根层是显示约束，
   手动档下根层要混排就**只能靠 nodes**：只靠 folders+files 渲染的话，
   文件永远排在文件夹后面，怎么拖都上不去（用户 2026-10-13 报的就是这个）。 */
export const sortTree = (tree, mode, order) => {
  const cmp = cmpFor(mode, order);
  const walk = (nodes) =>
    sortSiblings(nodes, cmp, mode).map((n) =>
      n.type === "dir" && n.children ? { ...n, children: walk(n.children) } : n);
  return {
    ...tree,
    nodes: walk([...(tree.folders || []), ...(tree.files || [])]),
    folders: walk(tree.folders || []),
    files: walk(tree.files || []),
  };
};

/* ---- 拖动算新顺序 ----
   服务端存的是「每项一个序号」，前端拖动时只需要算出**这一层**的新 rel 数组。
   算出的是**完整一层**（含没被动过的），不是增量 ——
   序号本来就是「以最后一次为准」的整份数据，写全量省得中途失败留半套。 */

/** rel → 它的父 rel（顶层是 ""）。 */
export const parentOf = (rel) => {
  const i = String(rel).lastIndexOf("/");
  return i < 0 ? "" : String(rel).slice(0, i);
};

const baseName = (rel) => {
  const i = String(rel).lastIndexOf("/");
  return i < 0 ? String(rel) : String(rel).slice(i + 1);
};

/**
 * 把 from 拖到 to 那一行的前面（after=false）或后面（after=true）。
 * siblings 是**同一层、按当前显示顺序**的 rel 数组。
 * 返回新数组；from 不在其中就原样返回。
 *
 * ⚠️ `after` 是必需的，不是可选的便利参数：早期版本只有「插在前面」一种落点，
 * 于是**列表最下面永远没有落点**（用户 2026-10-13 报「最上最下无法落下」）。
 * `after` 由 drop 事件的坐标现算，不复用 dragover 时存的那个 ——
 * HTML5 拖拽的 dragover 是节流的，存的和落手的位置对不上就会插错地方。
 */
export const moveInLevel = (siblings, from, to, after = false) => {
  const i = siblings.indexOf(from);
  if (i < 0) return siblings;
  const out = siblings.filter((r) => r !== from);
  const j = out.indexOf(to);
  if (j < 0) { out.splice(i, 0, from); return out; }   // 落点没了，退回原位
  out.splice(after ? j + 1 : j, 0, from);
  return out;
};

/** 把 rel 挪到 parent 底下（跨文件夹拖放用的目标路径）。 */
export const pathUnder = (parent, rel) =>
  parent ? `${parent}/${baseName(rel)}` : baseName(rel);

/** rel 是否是别的 rel 的后代（拖进自己里面要拦掉）。 */
export const isUnder = (parent, rel) =>
  rel === parent || String(rel).startsWith(String(parent) + "/");