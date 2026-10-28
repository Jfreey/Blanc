/**
 * 文字颜色 / 字背景色的取色面板。
 *
 * 挂在两处：
 *   · 选区工具条（Crepe toolbar，buildToolbar 钩子）
 *   · 块把手菜单（Crepe block-edit，buildMenu 钩子）
 *
 * 两处都是 Crepe 的**非 React 回调**里被调用的，拿不到 setState，
 * 所以靠 openerRef 转发到组件里的 React state。
 *
 * 落盘格式见 ./colorMarks.jsx：内联 HTML `<span style="color:…">`。
 */
import { useEffect, useRef, useState } from "react";
import { commandsCtx, editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import { setTextColorCommand } from "./colorMarks.jsx";

/**
 * Crepe 的 toolbar / block 菜单要的是 **SVG 字符串**（不是 React 节点），
 * 由它自己的 Icon 组件以 innerHTML 渲染。所以要把 `lucideAll` 的
 * 「[标签, 属性][] 数组」转成字符串。
 *
 * ⚠️ Crepe 自带图标是 **fill 路径**，没有 stroke 属性；
 * lucide 是 stroke 风格，所以这里必须自己带上 stroke-*，
 * 否则描边宽度为 0，**图标会完全看不见**。
 */
/* preserveAspectRatio 不是默认值保险：SVG 放进 flex 容器、容器一旦
   align-items: stretch（或给了 height 不给 width），它就会被**非等比拉伸** ——
   表现是一个又高又窄的细条，图标看起来"变小/变形"。
   钉死 meet + 配套 CSS 里的 flex:0 0 auto / align-self:center，两头都堵上。 */
const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ` +
  `preserveAspectRatio="xMidYMid meet" ` +
  `fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ` +
  `stroke-linejoin="round">${body}</svg>`;

/**
 * lucideAll 的 NODES[key] → SVG 字符串。
 *
 * ⚠️ `data-lucide` 那个属性不是装饰，是**必需的**，见 styles.css 里的同名规则：
 * Crepe 的图标全是 fill 路径，所以它的 CSS 强制
 * `.toolbar-item svg { fill: var(--crepe-color-outline) }`。
 * 而 lucide 是 stroke 风格（fill="none" + stroke），被那条规则一覆盖就
 * **整块填实**（highlighter 直接糊成一坨），看上去就像图标没换过。
 * 加上 data-lucide 就能用更特异的规则把 fill 还原成 none，
 * 同时不影响 Crepe 自己的图标。
 */
export function iconSvg(nodes, key) {
  if (!nodes) return "";
  const body = nodes
    .map(([tag, attrs]) =>
      `<${tag} ${Object.entries(attrs)
        .map(([k, v]) => `${k}="${v}"`)
        .join(" ")}/>`
    )
    .join("");
  return svg(body).replace("<svg ", `<svg data-lucide="${key}" `);
}

/**
 * 两个按钮用的 lucide key。
 *
 * ⚠️ 试过 `type`（A 去掉斜杠 + 上下横杠），渲染出来**就是一个 T**，
 * 完全不像「文字」，用户一眼就会认错 —— 换成 `baseline`（完整的 A + 下划线），
 * 这是各编辑器「文字颜色」按钮的通用画法：字 + 颜色条。
 * 背景色用 `highlighter`（荧光笔），同样是通用画法。
 */
export const COLOR_ICON_KEYS = { fg: "baseline", bg: "highlighter" };

/** 调色板。挑的都是正文背景（亮/暗）上都够contrast的一档。 */
export const SWATCHES = [
  { name: "红", fg: "#e5484d", bg: "#ffd7d5" },
  { name: "橙", fg: "#d9730d", bg: "#ffe8c2" },
  { name: "黄", fg: "#9a6700", bg: "#fff0c2" },
  { name: "绿", fg: "#30a46c", bg: "#d1e9dd" },
  { name: "青", fg: "#0b7285", bg: "#cce8ea" },
  { name: "蓝", fg: "#0090ff", bg: "#d6e8ff" },
  { name: "紫", fg: "#8e4ec6", bg: "#eadcf8" },
  { name: "粉", fg: "#d6409f", bg: "#fbdcf0" },
  { name: "灰", fg: "#6b7280", bg: "#e5e7eb" },
];

/**
 * 把选区扩成「光标 / 块把手所在的那一块」的整段文字。
 *
 * 块把手菜单的入口**不是**文本选区，是 **NodeSelection**（Crepe 点把手时会
 * 把选区设成指向那个块的 NodeSelection）。两种情况得分开处理：
 *
 *   · NodeSelection —— `$from` 停在节点**之前**，`$from.parent` 是 doc 而不是段落。
 *     早先只按 TextSelection 那条路写，结果 `parent.isTextblock` 为 false，
 *     函数直接返回 false，整段上色**静默不生效**（面板照开，选区是空的）。
 *   · TextSelection —— 从光标往上找最近的 textblock 祖先。
 */
export function selectBlockText(ctx) {
  const view = ctx.get(editorViewCtx);
  const { state } = view;
  const sel = state.selection;

  let from;
  let to;

  if (sel.node) {
    // NodeSelection：$from 在节点前，$from.nodeAfter 就是目标块
    const node = sel.node;
    if (!node.isTextblock) return false;
    from = sel.$from.pos + 1;
    to = from + node.content.size;
  } else {
    const $from = sel.$from;
    let found = false;
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).isTextblock) {
        from = $from.start(d);
        to = $from.end(d);
        found = true;
        break;
      }
    }
    if (!found) return false;
  }

  // 空段落整段上色没意义，直接返回
  if (from >= to) return false;
  view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
  return true;
}

/** 取色板按钮的入口：把 ctx 交给外面那个 React 回调去开面板。 */
export function makeColorOpener(ctx, opener, channel, wholeBlock) {
  const view = ctx.get(editorViewCtx);
  if (wholeBlock) selectBlockText(ctx);
  const { from, to } = ctx.get(editorViewCtx).state.selection;
  const coords = view.coordsAtPos(from);
  opener({ channel, x: coords.left, y: coords.bottom });
  return true;
}

/** 选中一个颜色并落盘。 */
export function applyColor(ctx, channel, color) {
  return ctx
    .get(commandsCtx)
    .call(setTextColorCommand.key, { channel, color });
}

const CHANNEL_LABEL = { fg: "文字颜色", bg: "背景色" };

export default function ColorPalette({ pop, onPick, onClose }) {
  const boxRef = useRef(null);
  const [custom, setCustom] = useState("");
  // 面板可能被点出屏幕外（段落很短、在窗口边缘）——夹回可视区。
  const PAD = 8;
  const w = 232;
  const h = 260;
  const left = Math.max(PAD, Math.min(pop.x, window.innerWidth - w - PAD));
  const top =
    pop.y + h + PAD > window.innerHeight
      ? Math.max(PAD, pop.y - h)
      : pop.y + 8;

  useEffect(() => {
    if (!pop) return undefined;
    const away = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) onClose();
    };
    const esc = (e) => {
      if (e.key === "Escape") onClose();
    };
    // 延到下一帧再监听：否则「点开面板的那一下」会立刻被判定为外部点击。
    const t = setTimeout(() => {
      document.addEventListener("pointerdown", away);
      document.addEventListener("keydown", esc);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [pop, onClose]);

  if (!pop) return null;

  return (
    <div
      ref={boxRef}
      className="mk-color-pop"
      style={{ position: "fixed", left, top, width: w }}
      role="dialog"
      aria-label={CHANNEL_LABEL[pop.channel]}
    >
      <div className="mk-color-pop-title">{CHANNEL_LABEL[pop.channel]}</div>
      <div className="mk-color-grid">
        {SWATCHES.map((s) => (
          <button
            key={s.name}
            type="button"
            className="mk-color-sw mk-color-sw-fg"
            style={{ background: s.fg }}
            title={s.name}
            aria-label={s.name}
            onClick={() => onPick(pop.channel, s.fg)}
          />
        ))}
      </div>
      <div className="mk-color-grid">
        {SWATCHES.map((s) => (
          <button
            key={s.name}
            type="button"
            className="mk-color-sw mk-color-sw-bg"
            style={{ background: s.bg }}
            title={s.name}
            aria-label={`${s.name}背景`}
            onClick={() => onPick(pop.channel, s.bg)}
          />
        ))}
      </div>
      <div className="mk-color-foot">
        <label className="mk-color-custom">
          自定义
          <input
            type="color"
            value={custom || "#0090ff"}
            onChange={(e) => setCustom(e.target.value)}
            onInput={(e) => setCustom(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="mk-color-clear"
          onClick={() => onPick(pop.channel, null)}
        >
          清除
        </button>
      </div>
      <button
        type="button"
        className="mk-color-apply"
        onClick={() => custom && onPick(pop.channel, custom)}
      >
        应用自定义色
      </button>
    </div>
  );
}
