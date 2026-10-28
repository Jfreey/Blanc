/* frontmatter（md 属性头）读写。
 *
 * ⚠️ **这里的东西绝不进 ProseMirror**（需求 #5 定的 A2 方案）。
 * Milkdown / remark-commonmark **没有** frontmatter 支持：`remark-frontmatter` 没装，
 * 依赖里也没有。也就是现在打开一个带 frontmatter 的文件，`---` 会被当成
 * 主题分隔线（thematic break）、中间的 YAML 变成一个普通段落 ——
 * 用户在正文里动一下，那段配置就被重写成散文了。
 *
 * 所以走**边界拆装**：读文件时切掉开头那段交给属性面板，**正文**才交给 Crepe；
 * 存盘时把当前属性的 YAML 拼回正文前面。
 * 这样 ProseMirror 里压根没有 frontmatter 这个节点，
 * 「正文编辑弄坏属性」的风险从根上不存在，`countText`、导航条测量也完全不受影响。
 * 代价是多一条序列化路径，以及要装一个 yaml 解析器（`yaml` 包，零依赖）。
 *
 * 为什么不在文件头这一层和 Milkdown 死磕：`server.mjs:286` 当初明确选了不这么做，
 * 理由就是「会和 Milkdown 的解析打架」—— A2 绕开了这个矛盾而不是推翻它。
 */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/* 只认文件**第一行**是 --- 的那种。中间的 --- 是正文里的分隔线（Notion 的
 * 分隔块、Obsidian 的分隔线），不能碰。
 * 行尾必须只有空白（--- 后跟内容不算），否则正文里写 `---abc` 会被误判。
 * 结束的 --- 同样要求整行只有它自己。
 * 边界都要求「--- 之前 / 之后顶到头或空行」，避免把正文里的 --- 吃掉。 */
const FENCE = /^---\s*$/;
const CLOSE = /^---\s*$/;

export const splitFrontmatter = (md) => {
  const text = String(md ?? "");
  // 开头可能有 BOM 或若干空行，先跳过，但最多 3 行 —— 再多就不像 frontmatter 了
  const lines = text.split("\n");
  let start = 0;
  while (start < 3 && start < lines.length && lines[start].trim() === "") start++;
  if (start >= lines.length || !FENCE.test(lines[start] ?? "")) return { props: null, body: text };

  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (CLOSE.test(lines[i] ?? "")) { end = i; break; }
  }
  // 只有开头没闭合 —— 文件截断 / 用户手写坏了。当成没有 frontmatter，
  // 原样交给正文（编辑器会把 --- 显示成分隔线），别吞内容。
  if (end === -1) return { props: null, body: text };

  const raw = lines.slice(start + 1, end).join("\n");
  let props = null;
  try { props = parseYaml(raw) ?? null; }
  catch {
    // YAML 语法错（比如用户手写坏了）：**不要**猜。props 留 null，
    // 但要把坏掉的那段**原样带回存盘**，否则一存就把用户的东西抹了。
    return { props: null, body: text, broken: raw };
  }
  if (props === null || typeof props !== "object" || Array.isArray(props)) {
    // 不是键值对（比如只有一个列表）→ 当没有，免得当成属性表
    return { props: null, body: text, broken: raw };
  }
  return { props, body: lines.slice(end + 1).join("\n") };
};

export const joinFrontmatter = (props, body) => {
  if (!props || typeof props !== "object" || !Object.keys(props).length) {
    return String(body ?? "");
  }
  let head;
  try {
    head = stringifyYaml(props, { lineWidth: 0 });   // lineWidth:0 = 不折行，别把长标签拆成两行
  } catch {
    return String(body ?? "");      // 序列化不了就宁可不写属性，也别写坏文件
  }
  // stringify 结尾自带换行。正文开头的空行原样留着，别动用户的排版。
  return `---\n${head}---\n${String(body ?? "")}`;
};

/* 属性表 → 面板的行。系统字段（创建时间 / 更新时间）**不**进这里 ——
 * 它们的值在 doc 的 fs.stat 上，不在 frontmatter 里。混进来会出现
 * 「用户改了却存不进去」的行。 */
export const UI_KEY = "_ui";
/* ⚠️ `_types` 是给「值猜不出类型」的那些属性用的：空字符串、日期、
 * 一行文字 —— 从值上根本看不出它是标签还是日期（见 guessType）。
 * 之前没存类型，结果是：选「标签」加出来的属性存进去是个字符串，
 * 下次打开又变回文本框；标签值也填不进去。
 * 只存「猜不出来 / 和猜测不一致」的那些（见 PropPanel 的 commit），
 * 用户手写的 `tags: [a, b]`、`done: true` 不会多出这一块。
 * 和 _ui 一样是保留键，渲染时滤掉。 */
export const TYPES_KEY = "_types";

export const readTypes = (props) =>
  (props && typeof props[TYPES_KEY] === "object" && !Array.isArray(props[TYPES_KEY]))
    ? props[TYPES_KEY] : {};

export const propsToRows = (props) => {
  if (!props || typeof props !== "object") return [];
  const types = readTypes(props);
  return Object.entries(props)
    .filter(([k]) => k !== UI_KEY && k !== TYPES_KEY)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([key, value]) => ({ key, value, type: types[key] || guessType(value) }));
};

/* 从 YAML 值反推类型。显式类型（比如 checkbox 的 true、number 的 3）认得出来，
 * 字符串一律当「文本」，**不去猜日期**——"2026-10-13" 和 "版本 1.2.3" 长得
 * 太像，猜错比不猜更糟。真要日期类型，用户从类型选择器里显式选。 */
export const guessType = (value) => {
  if (typeof value === "boolean") return "checkbox";
  if (typeof value === "number") return "number";
  if (Array.isArray(value)) return "tags";
  return "text";
};