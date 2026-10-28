/**
 * 文字颜色 / 字背景色。
 *
 * ── 落盘格式 ─────────────────────────────────────────────
 * 用户明确要内联 HTML，不用 **：
 *
 *   <span style="color:#e5484d">红字</span>
 *   <span style="background-color:#fde68a">黄底</span>
 *   两个一起用时合成一个 span：<span style="color:#e5484d;background-color:#fde68a">…</span>
 *
 * ── 为什么是「一个 mark 带 fg/bg 两个 attr」而不是两个 mark ──
 * Milkdown 的解析器 `#matchTarget` 是 `.find()`：一个 mdast 节点**只会命中第一个**
 * 匹配的 schema。所以两个 mark 抢同一个 `colorSpan` 节点时，背景色会被吃掉。
 * 合成一个 mark 就没这个问题。
 *
 * ── 为什么 toDOM 要带 data-color ────────────────────────
 * ProseMirror 从 DOM 反解 mark 时，`style` 属性不可靠（颜色可能被规范化成
 * `rgb()`、相对色词会被展开），所以额外挂一个 `data-color="fg=…;bg=…"` 做往返锚点。
 */
import {
  commandsCtx,
  editorViewCtx,
  remarkPluginsCtx,
  remarkStringifyOptionsCtx,
} from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import { $command, $markAttr, $markSchema } from "@milkdown/kit/utils";

export const COLOR_MARK = "textColor";

/** `{fg,bg}` → `color:…;background-color:…`，空值不输出。 */
export function buildStyle(attrs = {}) {
  return [
    attrs.fg ? `color:${attrs.fg}` : "",
    attrs.bg ? `background-color:${attrs.bg}` : "",
  ]
    .filter(Boolean)
    .join(";");
}

/** `{fg,bg}` → `fg=…;bg=…`，给 data-color 用。 */
export function buildData(attrs = {}) {
  return [
    attrs.fg ? `fg=${attrs.fg}` : "",
    attrs.bg ? `bg=${attrs.bg}` : "",
  ]
    .filter(Boolean)
    .join(";");
}

export function parseData(value) {
  const fg = /(?:^|;)\s*fg=([^;]+)/i.exec(value || "");
  const bg = /(?:^|;)\s*bg=([^;]+)/i.exec(value || "");
  return { fg: fg ? fg[1].trim() : null, bg: bg ? bg[1].trim() : null };
}

/**
 * 解析 CSS style 串里的颜色。
 *
 * ⚠️ `background-color` 里**也**含有 `color` 子串，所以裸的 `/color:/` 会先命中
 * `background-color:`。两个都要带上边界，并且**先判 background-color**。
 */
export function parseStyle(style) {
  const s = String(style || "");
  const bg = /(?:^|;)\s*background-color\s*:\s*([^;]+)/i.exec(s);
  // 前面必须不是 `-`，否则会吃到 background-color 的尾巴
  const fg = /(?:^|;)\s*(?<![-\w])color\s*:\s*([^;]+)/i.exec(s);
  return {
    fg: fg ? fg[1].trim() : null,
    bg: bg ? bg[1].trim() : null,
  };
}

/* ══════════════════════════════════════════════════════════════
   序列化：给 mdast-util-to-markdown 注册一个 colorSpan handler。
   必须挂在 remarkStringifyOptionsCtx 上、且在 init 读取它之前。
   ══════════════════════════════════════════════════════════════ */

/**
 * 这版 mdast-util-to-markdown（v2）的 handler 就是「返回字符串」，
 * `state.containerPhrasing(...)` 负责把 children 渲染出来。
 */
function colorSpanHandler(node, _parent, state, info) {
  const style = buildStyle(node);
  if (!style) return state.containerPhrasing(node, info);
  const inner = state.containerPhrasing(node, info);
  return `<span style="${style}">${inner}</span>`;
}

/** 在 ctx 阶段同步写入 —— init 的 runner 才去读这个 slice，所以来得及。 */
const remarkColorStringify = (ctx) => {
  ctx.update(remarkStringifyOptionsCtx, (prev) => ({
    ...prev,
    handlers: { ...(prev && prev.handlers), colorSpan: colorSpanHandler },
  }));
};

/* ══════════════════════════════════════════════════════════════
   反序列化：把 remark 拆散的 `<span>…</span>` 三连合并回一个节点。
   ══════════════════════════════════════════════════════════════ */

const OPEN_SPAN = /^<span\b[^>]*>$/i;
const CLOSE_SPAN = /^<\/span\s*>$/i;

/**
 * remark 把 `<span style="color:red">文字</span>` 拆成**三个平级**节点：
 *   html(`<span …>`) + text(`文字`) + html(`</span>`)
 * 所以必须在 ProseMirror 解析之前把它们重新合起来，否则会退化成裸 HTML 节点。
 *
 * 只处理**带颜色**的 span；用户自己写的无色 `<span>` 原样保留（不吞标签）。
 */
function mergeColorSpans(node) {
  if (!node || !node.children) return node;
  node.children = mergeList(node.children);
  return node;
}

function mergeList(children) {
  const out = [];
  /** 当前打开的、带颜色的 span 栈 */
  const stack = [];

  for (const child of children) {
    mergeColorSpans(child);

    if (child.type === "html" && CLOSE_SPAN.test(String(child.value).trim())) {
      // 只有栈里有对应的开标签才弹，否则是无色 span 的收尾，原样留着
      if (stack.length) {
        stack.pop();
        continue;
      }
    }

    if (child.type === "html" && OPEN_SPAN.test(String(child.value).trim())) {
      const { fg, bg } = parseStyle(extractStyle(String(child.value)));
      if (fg || bg) {
        const span = { type: "colorSpan", fg, bg, children: [] };
        if (stack.length) {
          // 嵌套的带色 span **没法用嵌套的 mark 表达**：
          // 文字在 mark 里是扁平的，内层 span 会把外层整个盖掉
          // （实测 `<span color><span bg>字</span></span>` 只剩 bg，前景色丢了）。
          // 既然一个 mark 本来就同时带 fg/bg，这里直接**拍平**：
          // 内层非空的通道优先，拍成一个节点。
          const outer = stack[stack.length - 1];
          span.fg = fg ?? outer.fg;
          span.bg = bg ?? outer.bg;
        }
        const parent = stack.length ? stack[stack.length - 1].children : out;
        parent.push(span);
        stack.push(span);
        continue;
      }
      // 无色 span：不进栈，标签照常输出
    }

    const parent = stack.length ? stack[stack.length - 1].children : out;
    parent.push(child);
  }

  // 栈没清空说明标签不配对，剩下的已经挂在 out 上了，交给原样处理
  return out;
}

/**
 * 从 `<span …>` 开标签里取出 style 的**值**。
 *
 * ⚠️ 必须只返回捕获组：`RegExp.exec()` 返回的是数组，而 `Array#toString()`
 * 是**用逗号拼接**的。直接把它丢给 parseStyle 会得到
 * `color:#111,color:#111,,` 这种东西 —— 于是颜色值里混进 `,`，
 * 单色 span 因为正则只认 `^`/`;` 分隔而匹配不上（整个 span 被跳过），
 * 双色 span 则侥幸匹配上但值是错的。两种症状同一个根因。
 */
function extractStyle(tag) {
  const m = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
  return m ? m[1] ?? m[2] ?? m[3] ?? "" : "";
}

const colorMarkSchema = $markSchema(COLOR_MARK, () => ({
  attrs: {
    fg: { default: null },
    bg: { default: null },
  },
  parseDOM: [
    {
      tag: "span[data-color]",
      getAttrs: (dom) => {
        const attrs = parseData(dom.getAttribute("data-color"));
        return attrs.fg || attrs.bg ? attrs : false;
      },
    },
    {
      // 从别处粘贴进来的带色 span（Obsidian / Typora / 手写 HTML）
      tag: "span[style]",
      getAttrs: (dom) => {
        const attrs = parseStyle(dom.getAttribute("style"));
        return attrs.fg || attrs.bg ? attrs : false;
      },
    },
  ],
  toDOM: (mark) => [
    "span",
    {
      "data-color": buildData(mark.attrs),
      style: buildStyle(mark.attrs),
    },
    0,
  ],
  parseMarkdown: {
    match: (node) => node.type === "colorSpan",
    runner: (state, node, markType) => {
      state.openMark(markType, { fg: node.fg ?? null, bg: node.bg ?? null });
      state.next(node.children);
      state.closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === COLOR_MARK,
    runner: (state, mark) => {
      state.withMark(mark, "colorSpan", undefined, {
        fg: mark.attrs.fg,
        bg: mark.attrs.bg,
      });
    },
  },
}));

const colorMarkAttr = $markAttr(COLOR_MARK);

/**
 * ⚠️ 这里**不能**用 `@milkdown/utils` 的 `$remark`，它是个时序陷阱：
 *
 *   $remark 的插件体是 `(ctx) => async () => { await ctx.wait(InitReady); 写入 }`
 *   而 core 的 `schema` 插件等的是同一个 `InitReady`，
 *   一到就立刻 `ctx.get(remarkPluginsCtx)` 拿去建 processor。
 *
 * 两者都等 `InitReady`，但 **schema 注册回调更早**（它是内部插件，runner 先启动），
 * 于是 schema 永远是先读的那一个 —— `$remark` 写进去的东西**赶不上**，
 * 表现为「插件写了但完全没效果」。
 *
 * 可靠做法：在 **ctx 阶段**同步写入。
 * 内部插件（schema/init/…）的 ctx 阶段先于用户插件跑完，
 * 所以 `remarkPluginsCtx` 这时已经被 `init` 注入，可以直接 update；
 * 而所有 runner 都还没开始，schema 读到的一定是写好的版本。
 */
const remarkColorSpans = (ctx) => {
  ctx.update(remarkPluginsCtx, (prev) => [
    ...(prev || []),
    // ⚠️ 这里必须是**工厂**：`() => mergeColorSpans`，不能直接给 mergeColorSpans。
    //
    // unified 的 freeze() 是这么调 attacher 的：
    //     const transformer = attacher.call(self, ...options)
    //     if (typeof transformer === "function") this.transformers.use(transformer)
    // 而 core 那边 `acc.use(plug.plugin, plug.options)` 会把 options 摊成**参数**。
    // 所以直接传函数的话，mergeColorSpans 会拿 `undefined` 当 tree 调用，
    // 返回值又不是函数 → 压根不会被注册成 transformer（症状：插件完全没效果）。
    // Milkdown 自己的 $remark 插件同样都是 `() => () => (tree) => {}` 这个三层形状。
    { plugin: () => mergeColorSpans, options: undefined },
  ]);
};

/* ══════════════════════════════════════════════════════════════
   命令
   ══════════════════════════════════════════════════════════════ */

/**
 * 给选区上色。
 *
 * ⚠️ 命令体是**三层**：`(ctx) => (payload) => (state, dispatch) => boolean`。
 * 因为 core 的 CommandManager.call 是这么走的：
 *
 *     const command = this.get(slice)(payload);          // 拿 payload 调一次
 *     return command(view.state, view.dispatch, view);   // 返回值再当 PM 命令调一次
 *
 * 写成两层（直接返回 boolean）的话，第二步会对 `true` 调函数，
 * 报 "command is not a function"。
 *
 * 一个 mark 同时带 fg/bg，所以「加前景色」时必须**保留已有的背景色**，
 * 否则会把已有的底色抹掉。
 *
 * @param {{channel:'fg'|'bg', color:string|null}} payload color 传 null = 去掉该通道
 */
export const setTextColorCommand = $command(
  "SetTextColor",
  (ctx) =>
    ({ channel, color }) =>
    (state, dispatch) => {
      const type = colorMarkSchema.type(ctx);
      const { from, to, empty } = state.selection;
      if (empty) return false;

      /** 选区里任取一段文本的现有颜色作为基底 */
      let base = null;
      state.doc.nodesBetween(from, to, (node) => {
        if (base || !node.isText) return;
        const mark = node.marks.find((m) => m.type === type);
        base = mark ? { fg: mark.attrs.fg, bg: mark.attrs.bg } : { fg: null, bg: null };
      });
      if (!base) return false;

      // 同色再点一次 = 取消该通道
      const merged = { ...base, [channel]: base[channel] === color ? null : color };
      const next = merged.fg || merged.bg ? merged : null;

      if (next) dispatch(state.tr.addMark(from, to, type.create(next)));
      else dispatch(state.tr.removeMark(from, to, type));

      return true;
    }
);

/**
 * 读选区当前颜色。
 *
 * ⚠️ 不能做成 $command：CommandManager.call 一定会把返回值当函数调一次，
 * 而这里要的是**值**。所以做成纯函数，由拿到 view.state 的调用方直接用。
 */
export function readColor(state, channel) {
  const type = state.schema.marks[COLOR_MARK];
  if (!type) return null;
  const { from, to } = state.selection;
  let result = null;
  state.doc.nodesBetween(from, to, (node) => {
    if (!node.isText) return;
    const mark = node.marks.find((m) => m.type === type);
    // ⚠️ 颜色在 mark.attrs 上，不在 mark 上。
    // 写 mark[channel] 不会报错，只会**永远返回 undefined** —— 极难查。
    if (mark) result = mark.attrs[channel];
  });
  return result;
}

export { colorMarkSchema, colorMarkAttr, remarkColorSpans };

/**
 * 注册顺序有讲究：
 *   1. remarkColorStringify —— 要赶在 core 的 init 读 remarkStringifyOptionsCtx 之前
 *   2. remarkColorSpans     —— 要赶在 schema 读 remarkPluginsCtx 之前
 *   3. mark / attr          —— runner 阶段写入 marksCtx，schema 会等到 InitReady，自然来得及
 */
export const colorMarkPlugins = [
  remarkColorStringify,
  remarkColorSpans,
  colorMarkAttr,
  colorMarkSchema.mark,
  colorMarkSchema.ctx,
  setTextColorCommand,
];

/* ══════════════════════════════════════════════════════════════
   dev 调试入口
   颜色是「序列化才看得见」的功能：DOM 里对不代表 markdown 对。
   所以必须能在浏览器里直接跑命令、拿 markdown 对账 —— scripts/cdp.mjs
   的 eval 就靠这个。prod 打包里不存在。
   ══════════════════════════════════════════════════════════════ */
if (import.meta.env && import.meta.env.DEV) {
  window.__blancColor = {
    /** 给当前选区上色：color("fg", "#e5484d") */
    color: (channel, value) => {
      const view = window.__blanc?.crepe?.editor?.ctx?.get(editorViewCtx);
      if (!view) throw new Error("编辑器还没建好");
      return window.__blanc.crepe.editor.ctx
        .get(commandsCtx)
        .call(setTextColorCommand.key, { channel, color: value });
    },
    /** 读当前选区的颜色 */
    read: (channel) => {
      const view = window.__blanc?.crepe?.editor?.ctx?.get(editorViewCtx);
      return view ? readColor(view.state, channel) : null;
    },
    /** 在页面上选中一段文字（按字符偏移），给上色测试用 */
    select: (needle) => {
      const view = window.__blanc?.crepe?.editor?.ctx?.get(editorViewCtx);
      if (!view) return null;
      let hit = null;
      view.state.doc.descendants((node, pos) => {
        if (hit || !node.isText || !node.text.includes(needle)) return;
        hit = pos + node.text.indexOf(needle);
      });
      if (hit === null) return null;
      view.dispatch(view.state.tr.setSelection(
        TextSelection.create(view.state.doc, hit, hit + needle.length)));
      return needle;
    },
    /** 文档 JSON：断言 mark 到底挂没挂上、attrs 对不对 */
    blocks: () => {
      const view = window.__blanc?.crepe?.editor?.ctx?.get(editorViewCtx);
      if (!view) return null;
      const out = [];
      view.state.doc.descendants((node, pos) => {
        if (node.isTextblock)
          out.push({ pos, from: pos + 1, to: pos + 1 + node.content.size,
                     type: node.type.name, text: node.textContent.slice(0, 12) });
      });
      return out;
    },
    sel: () => {
      const view = window.__blanc?.crepe?.editor?.ctx?.get(editorViewCtx);
      if (!view) return null;
      const s = view.state.selection;
      const $f = s.$from;
      return {
        kind: s.constructor.name,
        node: s.node ? s.node.type.name : null,
        pos: s.from,
        from: s.from, to: s.to,
        parentIsTextblock: $f.parent.isTextblock,
        parentType: $f.parent.type.name,
        depth: $f.depth,
      };
    },
    doc: () => {
      const view = window.__blanc?.crepe?.editor?.ctx?.get(editorViewCtx);
      if (!view) return null;
      return view.state.doc.toJSON();
    },
    /** 当前选区文本，方便断言到底选中了什么 */
    selected: () => {
      const view = window.__blanc?.crepe?.editor?.ctx?.get(editorViewCtx);
      if (!view) return null;
      const { from, to } = view.state.selection;
      return view.state.doc.textBetween(from, to, " ");
    },
  };
}
