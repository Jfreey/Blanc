import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Crepe, CrepeFeature } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/kit/core";
import { NodeSelection, Plugin, PluginKey, TextSelection } from "@milkdown/kit/prose/state";
import { Fragment, Slice } from "@milkdown/kit/prose/model";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { $prose, replaceAll } from "@milkdown/kit/utils";
import { colorMarkPlugins } from "./colorMarks.jsx";
import ColorPalette, {
  makeColorOpener, applyColor, iconSvg, COLOR_ICON_KEYS,
} from "./colorPalette.jsx";

/* ⚠️ 只 import 功能样式，**不再 import nord.css**（#12）。
   Crepe 那 23 个 `--crepe-color-*` 已经在 styles.css 的 :root 里自己定义了 ——
   保留 import 的话同特异度下「谁后加载谁赢」不可控，而 Crepe 自带的
   nord-dark 是冷蓝灰、和这个 app 的暖中性 UI 不同调。
   夜间模式只是给 <html> 加一个 data-theme，CSS 那边跟着切。 */
import "@milkdown/crepe/theme/common/style.css";   // 功能样式：把手/工具条/列表/代码块…
import { api, desktop } from "./api.js";
import OutlineRail from "./OutlineRail.jsx";
import { splitFrontmatter, joinFrontmatter, propsToRows, readTypes, guessType,
         UI_KEY, TYPES_KEY } from "./props.js";
import { PropIcon, iconKeyFor } from "./propIcons.jsx";
/* 字数统计原本住在这个文件里；为了让 App 能懒加载整个编辑器，挪去了独立小模块。 */
import { countText } from "./countText.js";

// 编辑器宿主 —— 直接用 Milkdown 的 Crepe（就是 milkdown.dev/playground 那一套：
// 拖拽把手、斜杠菜单、选中文字的格式工具条、链接浮层、CodeMirror 代码块、表格、待办）。
// 我们只接三件事：把磁盘上的 markdown 喂进去、把改动的 markdown 存回去、Cmd+S。
//
// 契约和之前一样：
//   doc = { root, rel, content, name }，content 是 App 从磁盘读出的 markdown
//   切文档靠 App 侧 <EditorPane key={doc.rel}> 整体重建
//   自动保存：内容变化 0.8s 防抖 → api.write(doc.root, doc.rel, md)
//   Cmd/Ctrl+S 手动立即存盘
//
// markdown 走 Milkdown 的 remark 管道双向转换，往返无损，存盘直接拿字符串。

const DEFAULT_TITLE = "未命名";

// titleIconEl / hasTitleIcon / onPickIcon 由 App 传入：图标的实际绘制（CustomIcon 依赖
// 懒加载的 lucide 全量）留在 App 一处，EditorPane 不重复实现，避免两份图标解析逻辑漂移。
function EditorInner({ doc, onDirtyChange, onSaved, onFlushSave, onStats,
                       onConflict, onSaveError, onReloadDoc, onApi,
                       titleIconEl, hasTitleIcon, onPickIcon, smileyEl, showIconUi = true, onScrolledChange,
                       onTitleCommit, onTitleFlush, onTitleCancel,
                       showRail, showOutline, showMini, readOnly = false, preview = false,
                       findTick = 0, showProps = true, onShowProps }) {
  const rootRef = useRef(null);
  const crepeRef = useRef(null);
  // 预览（回收站内容）一律强制锁定，不看用户的 readOnly。
  // 反过来（用户锁了、预览一篇）也一样是锁，所以直接取或。
  const locked = readOnly || preview;
  // 锁的镜像：installBlockSelect / installDragGhost 那些非 React 的监听器要读它，
  // 但它们在挂载时就被调好了，拿不到 prop。ref 每渲染同步一次。
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  // 滚动容器要交给 <OutlineRail>：它得量标题相对这个容器的文档坐标，
  // 而量的时候轨道自己可能还没挂上（没标题时组件 return null），
  // 不能反过来从 railRef 里 closest() 找 —— 那是鸡生蛋。
  const scrollRef = useRef(null);
  // 大纲轨道要用 ProseMirror view 收 heading，走 props 传给 <OutlineRail>
  const [view, setView] = useState(null);
  /* 文字颜色 / 背景色面板。Crepe 的 buildToolbar / buildMenu 回调在
     React 之外被调用，拿不到 setState，所以用 ref 把开面板的动作转进来。 */
  const [colorPop, setColorPop] = useState(null);
  const colorCtxRef = useRef(null);
  const openColorRef = useRef(() => {});
  /* Crepe 回调每次都是新闭包，这里用 ref 转发到最新的 state。 */
  openColorRef.current = (pop) => setColorPop(pop);
  const pickColor = useCallback((channel, color) => {
    const ctx = colorCtxRef.current;
    setColorPop(null);
    if (!ctx) return;
    applyColor(ctx, channel, color);
    // 取色会让编辑器失焦，但选区必须留着，否则连着点两个颜色只有第一次生效。
    ctx.get(editorViewCtx).focus();
  }, []);
  const closeColor = useCallback(() => setColorPop(null), []);
  const handlers = useRef({ onSaved, onDirtyChange, onStats, onConflict, onSaveError, onReloadDoc });
  useEffect(() => { handlers.current = { onSaved, onDirtyChange, onStats, onConflict, onSaveError, onReloadDoc }; });

  const savedRef = useRef(doc.content || "");
  const timerRef = useRef(null);
  // 只有用户真的编辑过才允许写盘。没这个闸门的话，编辑器一旦显示的不是本文档
  // （例如文件内容为空、Crepe 退回自带示例），卸载时那次「兜底保存」会把示例文档
  // 整个写进用户的 .md —— 实际踩过一次：验收测试.md 被写成 3093 字节的 Welcome 文档。
  const touchedRef = useRef(false);
  /* 写入乐观锁：doc.mtime 是**打开这一篇时**磁盘上的 mtime。
     保存时连同内容一起送回服务端比对；对不上说明这之后有别处改过
     （另一个窗口、或用户拿别的编辑器存了），服务端回 409 而不是覆盖。
     存盘成功后要用服务端返回的新 mtime 覆盖它，否则下一次保存必然又 409。 */
  const mtimeRef = useRef(doc.mtime || 0);
  useEffect(() => { mtimeRef.current = doc.mtime || 0; }, [doc.root, doc.rel]);
  /* 冲突时把「磁盘上那份」和「我这份」一起交给 App 去弹选择。
     这里**不能**自作主张选一边 —— 覆盖会丢对方的改动，丢弃会丢用户的改动。
     状态留在这边（resolve/force 要摸 mtimeRef、savedRef），UI 交给 App。 */
  const [conflict, setConflict] = useState(null);
  useEffect(() => {
    if (!conflict) return;
    handlers.current.onConflict?.(conflict);
  }, [conflict]);

  // 顶部固定标题 = 文件名（双向绑定，改标题即改文件名）
  const [title, setTitle] = useState(() => doc.name || "");
  /* md 属性头（#5）。propsTable 是 frontmatter 里的用户属性；
     createdAt / updatedAt 是 fs.stat 给的两个时间戳，**不在 frontmatter 里**
     （那是文件系统的事实，写进文件只会变成对不上的第二份）。 */
  const [propsTable, setPropsTable] = useState(null);
  const [propsBroken, setPropsBroken] = useState("");
  // 默认折叠：属性是补充信息，不该在打开笔记的第一屏占掉三四行。
  const [propsExpanded, setPropsExpanded] = useState(false);
  // doSave 在 mount 之后、setState 之外被调用（监听回调、定时器），
  // 闭包里的 propsTable 可能是旧值 —— 用 ref 拿最新的。
  const propsRef = useRef(propsTable);
  propsRef.current = propsTable;
  const propsBrokenRef = useRef(propsBroken);
  propsBrokenRef.current = propsBroken;
  /* 改属性的唯一入口。
     ref 要**同步**写，不能靠 propsRef.current = propsTable 那句在渲染时赋值 ——
     点完「添加标签」紧接着 doSave() 时，setPropsTable 还没触发重渲染，
     读到的是旧表，存回去等于没改。
     存盘走 doSave()（不带参数）：它取当前正文 + 当前属性拼成全文，
     和 savedRef 里那份一比，不同就写。属性变了正文没变，照样存得下去。 */
  const updateProps = (next) => {
    propsRef.current = next;
    setPropsTable(next);
    doSave();
  };

  // 页内查找框（#4）。q / replace / idx 的真值在 PM 插件里，这里存的是
  // 「开没开 + 是不是替换态」和一份镜像（插件状态变了要重新渲染面板）。
  const [find, setFindUI] = useState({ open: false, mode: "find" });
  const [findMirror, setFindMirror] = useState(emptyFind);
  const titleRef = useRef(null);
  // 「未命名」只是占位：为空时标题栏显示占位符，但文件名仍保持真实名
  const dispTitle = (n) => (n && n !== DEFAULT_TITLE ? n : "");
  useEffect(() => {
    if (document.activeElement === titleRef.current) return;
    const shown = dispTitle(doc.name);
    setTitle(shown);
    if (titleRef.current && titleRef.current.textContent !== shown) titleRef.current.textContent = shown;
  }, [doc.name]);

  // h1 contenteditable：取纯文本（剥掉换行，标题只允许一行）
  const titleText = (el) => String(el?.textContent ?? "").replace(/\n+/g, " ");
  const syncTitle = (name) => {
    if (document.activeElement === titleRef.current) return;
    setTitle(name);
    if (titleRef.current && titleRef.current.textContent !== name) titleRef.current.textContent = name;
  };
  // 提交标题：展示层立即同步（App 内 setDoc），真实 rename 由 App 防抖 ~900ms；
  // 失焦/Enter 触发 onTitleFlush 立即落盘。删空 → 保持空值（只显示占位符）
  const commitTitle = () => {
    const clean = (titleText(titleRef.current) || "").trim().replace(/\.md$/i, "");
    if (!clean) return;
    onTitleCommit?.(clean);
  };

  const currentMd = () => {
    try { return crepeRef.current?.getMarkdown() ?? savedRef.current; }
    catch { return savedRef.current; }
  };

  /* ---- 外部改动（2026-10-30）----
   * App 在停留于某一篇时轮询 /api/stat，磁盘 mtime 一变就把新内容递进来。
   * 这里负责「怎么换」和「换的时候别把自己搅进保存流程」：
   *
   *   · applyExternal —— 这边没有未保存内容：**原地**换掉文档，不重开这一篇。
   *     走 openFile 重开的话 doc.id 会变、EditorPane 整体重建，滚动位置回顶部 ——
   *     而用户多半只是停在中间读，这正是「静默刷新」最不该发生的事。
   *   · conflictFor  —— 这边有未保存内容：不替用户选，构造一个和 409 一样的
   *     对照对象交给 App 弹面板（带 diff）。
   *
   * applyingRef 是**闸门**：replaceAll 会触发 markdownUpdated，那一瞬间
   * md !== savedRef，不拦住就会被当成「用户编辑了」→ 标脏 → 800ms 后写盘，
   * 等于刚同步完就把磁盘那份又覆盖回去。
   */
  const applyingRef = useRef(false);
  const impRef = useRef(null);
  impRef.current = {
    /** 编辑器里的全文（含 frontmatter），跟磁盘那份逐字比对用 */
    getText: () => (propsBrokenRef.current
      ? `---\n${propsBrokenRef.current}---\n${currentMd()}`
      : joinFrontmatter(propsRef.current, currentMd())),

    /** 静默替换成磁盘那份；返回 false = 编辑器还没建好，交给下一轮 */
    applyExternal: (md, mtime) => {
      const crepe = crepeRef.current;
      if (!crepe) return false;
      const fm = splitFrontmatter(md);
      const scroller = scrollRef.current;
      const top = scroller ? scroller.scrollTop : 0;
      applyingRef.current = true;
      try {
        crepe.editor.action(replaceAll(fm.body));
      } catch (e) {
        applyingRef.current = false;
        console.error("[blanc] 外部改动替换失败", e);
        return false;
      }
      // 属性面板、保存基准、脏标记，一起对齐到磁盘那份
      setPropsTable(fm.props);
      propsRef.current = fm.props;
      setPropsBroken(fm.broken ?? "");
      propsBrokenRef.current = fm.broken ?? "";
      savedRef.current = md;
      mtimeRef.current = mtime || 0;
      touchedRef.current = false;
      handlers.current.onDirtyChange?.(false);
      handlers.current.onSaved?.(mtime);
      // replaceAll 是同步 dispatch，DOM 已经换完，可以立刻放回阅读位置
      if (scroller) scroller.scrollTop = top;
      // listener 可能在这之后还有一次回调，下一帧再解闸
      requestAnimationFrame(() => { applyingRef.current = false; });
      return true;
    },

    /** 有未保存内容时：把两边交给 App，弹和 409 一样的对照面板 */
    conflictFor: (theirs, theirsMtime, kind = "external") => ({
      kind,
      rel: doc.rel,
      mine: impRef.current.getText(),
      theirs,
      theirsMtime,
      reload: async () => { await handlers.current.onReloadDoc?.(); },
      force: async () => {
        const text = impRef.current.getText();
        const r = doc.external
          ? await desktop.write(doc.rel, text, 0)
          : await api.write(doc.root, doc.rel, text, 0);
        if (r && r.mtime) mtimeRef.current = r.mtime;
        savedRef.current = text;
        handlers.current.onSaved?.(r?.mtime);
      },
    }),
  };
  useEffect(() => { onApi?.(impRef.current); });

  const doSave = (md) => {
    // 预览模式：任何写盘都不允许。
    // 这一句是**硬闸**，不是「应该不会走到」。预览的 doc.rel 是那份文件的
    // 原路径（在库里的活路径），doSave 走 api.write(doc.root, doc.rel) 就会把
    // .trash/ 里的旧内容盖到活文件上 —— 用户可能正在看一篇已经恢复了的同名笔记。
    // 靠 editable=false 拦是不行的：那只是不产生编辑，不产生编辑 ≠ 不保存
    //（⌘S、切文档时的兜底 flush、标题改名都会调到 doSave）。
    if (preview) return;
    const raw = md ?? currentMd();
    /* 拼回 frontmatter。
       - props 是当前属性表（改过就存新值）
       - broken 非空 = 文件头那段 YAML 解析失败，**原样写回**，
         绝不能因为「解析不出来」就把它抹掉 —— 那是用户手写的东西
       - 两者都空 = 本来就没有 frontmatter，body 直接落盘
       ⚠️ savedRef 比的是**拼好之后**的全文：早先只比正文，改属性会算成「没变」
       而被 text === savedRef.current 那道早退拦掉，属性就永远存不下去。 */
    const text = propsBrokenRef.current
      ? `---\n${propsBrokenRef.current}---\n${raw}`      // YAML 坏了：原样写回
      : joinFrontmatter(propsRef.current, raw);
    if (text === savedRef.current) return;
    savedRef.current = text;
    clearTimeout(timerRef.current);
    // 外部文档（从 Finder 打开、不在知识库里）走桌面壳写绝对路径，
    // server.mjs 的 safeJoin 不认这种路径（见 api.js 里 desktop 的注释）
    const writing = doc.external
      ? desktop.write(doc.rel, text, mtimeRef.current)
      : api.write(doc.root, doc.rel, text, mtimeRef.current);
    Promise.resolve(writing)
      .then((r) => {
        // 服务端回新的 mtime，刷新基准；下一次保存才不会自己跟自己冲突
        if (r && r.mtime) {
          mtimeRef.current = r.mtime;
          /* 顺带把「更新时间」显示刷新（2026-10-16）。
             库外文件的面板时间来自 doc.updated，只在打开时算一次 ——
             存盘后不改的话，这一篇改了半天，显示的还是打开那天的日期。
             库内文件不用管：它的 updated 来自 /api/tree，下次重新拉树时会更新。 */
          if (doc.external) handlers.current.onDocTime?.(r.mtime);
        }
        handlers.current.onSaved?.();
      })
      .catch((e) => {
        // 409 = 有人在这之后改过同一篇。**不做任何自动决策**，把两边都交上去问用户：
        // 覆盖 = 丢对方的改动，丢弃 = 丢用户的改动，这个只能用户定。
        if (e && e.conflict) {
          // savedRef 退回去 —— 不然下一次任何触发都会因为「和上次一样」
          // 被 text === savedRef.current 那道早退拦掉，用户的编辑就再也存不下去
          savedRef.current = "";
          setConflict({
            mine: text,
            theirs: e.currentContent ?? "",
            theirsMtime: e.currentMtime || 0,
            rel: doc.rel,
            /** 「以磁盘为准」= 放弃我的编辑，重新读一遍文件。
                交给 App 走 openFile（key 变 → 编辑器整体重建），
                不在这里热替换内容 —— 重建那条路径本来就有，不出岔子。 */
            reload: async () => handlers.current.onReloadDoc?.(),
            /** 「以我的为准」= 跳过这次比对强写。baseMtime 传 0，
                服务端就不参与检查（见 server.mjs PUT 里 baseMtime>0 才比对的逻辑）。
                这是用户明确表达过「我知道有个改动，我要覆盖它」之后才走的路。 */
            force: async () => {
              const r = doc.external
                ? await desktop.write(doc.rel, text, 0)
                : await api.write(doc.root, doc.rel, text, 0);
              if (r && r.mtime) mtimeRef.current = r.mtime;
              savedRef.current = text;
              handlers.current.onSaved?.();
            },
          });
          return;
        }
        console.error("保存失败", e);
        handlers.current.onSaveError?.(e);
      });
  };

  // 暴露给 App：标题 rename 落盘前「立即把当前正文写进旧 rel」，避免重挂载丢输入。
  // doSave 闭包持有最新 doc.rel（渲染时生成），flush 发生在 setDoc(rel) 之前 → 写的就是旧路径
  useEffect(() => { onFlushSave?.(doSave); }, [doc.root, doc.rel]); // eslint-disable-line react-hooks/exhaustive-deps

  // 建编辑器
  useEffect(() => {
    let dead = false;
    /** boot 是 async 的，cleanup 可能先跑 —— 所以 crepe 存到外层变量再判空。 */
    let instance = null;
    const boot = async () => {
    /* 交给 Crepe 的是**正文**，frontmatter 那段已经被切走了（见 props.js 的 A2 方案）。
       切完顺手把属性存进 state 给面板用 —— 注意 broken 那条：YAML 坏了的话
       props 是 null，而 broken 里存着原文，存盘时要原样写回去。 */
    const fm = splitFrontmatter(doc.content || "");
    setPropsTable(fm.props);
    setPropsBroken(fm.broken ?? "");

    /* 图标要从 lucideAll 现取，所以建 Crepe 之前先把那个模块拉下来。
       **必须用动态 import()**：lucideAll 是 1877 枚图标的一个对象字面量，
       静态 import 的话 Rollup 没法按属性摇树，实测主包 1947 kB → 2543 kB。
       动态引入会单独出一个 chunk（App.jsx 的图标选择器本来就这么干），
       缓存后只拉一次，首屏零成本。 */
    let icons = { fg: "", bg: "" };
    try {
      const m = await import("./lucideAll");
      icons = {
        fg: iconSvg(m.NODES[COLOR_ICON_KEYS.fg], COLOR_ICON_KEYS.fg),
        bg: iconSvg(m.NODES[COLOR_ICON_KEYS.bg], COLOR_ICON_KEYS.bg),
      };
    } catch (err) {
      // 图标取不到不该拦住整个编辑器，退化成空图标继续跑
      console.error("[blanc] lucideAll 载入失败", err);
    }

    const startEditor = () => new Crepe({
      root: rootRef.current,
      defaultValue: fm.body,
      featureConfigs: {
        // Crepe 把自定义条目的入口藏在这两个钩子里：
        //   buildToolbar —— 选区浮动工具条
        //   buildMenu    —— 块把手（block-edit）里的菜单
        [CrepeFeature.Toolbar]: {
          buildToolbar: (builder) => {
            builder
              .addGroup("color", "文字颜色")
              .addItem("fg", {
                icon: icons.fg,
                label: "文字颜色",
                active: () => false,
                onRun: (c) => {
                  colorCtxRef.current = c;
                  makeColorOpener(c, openColorRef.current, "fg", false);
                },
              })
              .addItem("bg", {
                icon: icons.bg,
                label: "背景色",
                active: () => false,
                onRun: (c) => {
                  colorCtxRef.current = c;
                  makeColorOpener(c, openColorRef.current, "bg", false);
                },
              });
          },
        },
        [CrepeFeature.BlockEdit]: {
          buildMenu: (builder) => {
            builder
              .addGroup("color", "文字颜色")
              .addItem("fg", {
                label: "文字颜色",
                icon: icons.fg,
                onRun: (c) => {
                  colorCtxRef.current = c;
                  makeColorOpener(c, openColorRef.current, "fg", true);
                },
              })
              .addItem("bg", {
                label: "背景色",
                icon: icons.bg,
                onRun: (c) => {
                  colorCtxRef.current = c;
                  makeColorOpener(c, openColorRef.current, "bg", true);
                },
              });
          },
        },
      },
    });
    if (dead) return;
    const crepe = startEditor();
    instance = crepe;
    crepeRef.current = crepe;

    // 文字颜色 / 字背景色。必须在 create() 之前 use：schema 插件要在
    // SchemaReady 建表时进 marksCtx，remark 插件要在 ParserReady 之前挂上。
    for (const plugin of colorMarkPlugins) crepe.editor.use(plugin);
    // 框选高亮：被完整选中的块逐块挂 .mk-bs。
    // use() 收的必须是「造插件的函数」本身，多包一层箭头会丢掉 ctx
    crepe.editor.use(blockFramePlugin);
    crepe.editor.use(findPlugin);
    crepe.on((listener) => {
      // 注意：Crepe 挂载时不会回调（defaultValue 直接进编辑器），所以**每一次**
      // markdownUpdated 都是真改动，别学 BlockNote 那套「跳过第一次」——
      // 跳过的话用户第一次输入不会落盘（实测：打完第一个字，编辑器里有、磁盘上没有）。
      listener.markdownUpdated((_ctx, md, prev) => {
        if (dead || md === prev) return;
        /* 外部改动刚被换成正文（applyExternal）—— 这次回调不是用户输入，
           不标脏、不排保存，否则会把刚同步进来的磁盘内容又写回去一遍。 */
        if (applyingRef.current) return;
        touchedRef.current = true;
        handlers.current.onDirtyChange?.(md !== savedRef.current);
        // 字数统计跟着正文走。markdownUpdated 每次击键都触发，
        // 但只是算几个数字（一次正则扫描），不必再套一层防抖。
        handlers.current.onStats?.(countText(md));
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => doSave(md), 800);
      });
    });
    // ⚠️ 必须带 .catch：插件/schema 出问题时 create() 是 reject，
    // 少了它就是**静默失败** —— 编辑器不渲染、控制台也不报错，极难查。
    crepe.create()
      .catch((err) => {
        if (import.meta.env.DEV) {
          (window.__blancErrors ||= []).push("CREPE " + (err?.stack || err));
          console.error("[blanc] crepe.create() 失败", err);
        }
      })
      .then(() => {
      if (dead) return;
      if (import.meta.env.DEV) {
        // CDP 自动化要有个入口：直接读 ctx 跑命令、拿 markdown。
        // 只挂 dev，prod 打包里不会出现。
        window.__blanc = { crepe, getView, get md() { return crepe.getMarkdown(); } };
      }
      installDragGhost(rootRef.current, getView);
      installBlockSelect(rootRef.current, getView);
      // 首次创建时就得按当前锁状态落一次 —— 下面那个 useEffect 跑在
      // crepe.create() 之前，那时 crepeRef 还是 null，什么都做不了。
      applyLock(crepe, lockedRef.current);
      setView(crepe.editor.ctx.get(editorViewCtx) ?? null);
    });
    };

    boot();

    return () => {
      dead = true;
      setView(null);
      // 卸载前把没存完的立刻写回去（App 切文档时会拦一道 dirty，这里是兜底）。
      // 但只在用户真的编辑过时写 —— 否则会把「编辑器当前显示的东西」当成正文存盘。
      clearTimeout(timerRef.current);
      if (touchedRef.current) doSave();
      // boot 是 async 的：图标模块还在路上时组件就卸载了的话，
      // instance 还是 null（dead 也会挡住它继续建）。所以这里必须判空。
      instance?.destroy();
      crepeRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const getView = () => {
    try { return crepeRef.current?.editor.ctx.get(editorViewCtx) ?? null; }
    catch { return null; }
  };

  // 锁定。editable=false 让 PM 自己挡掉输入、粘贴和大部分删除，
  // 我们不用逐个 keydown 去拦。剩下 PM 挡不住的（块拖动 / 整组删除 / 标题栏 h1）
  // 靠 editorLock 标志各自判。真正落下去的地方见 applyLock。
  useEffect(() => {
    editorLock = locked;
    applyLock(crepeRef.current, locked);
  }, [locked]);

  // Cmd/Ctrl+A 是**三段式**（2026-10-13 用户定的）：
  //   ① 光标在某个有字的块里（哪怕在中间，比如问号前）→ **只选这一块的文字**，
  //     走普通文本选区，**不套块框** —— 块框是「块选中」，会被拖走、会被当作一个整体操作，
  //     和「我要选中这段字去复制」是两件事。Cmd+A 是后者，就别顺手把它变成前者。
  //   ② 这一块的文字**已经全选上了**（再按一次）→ 升格成块选中，也就是拖框选的那种框。
  //   ③ 已经是块选中了 → 框全部块。
  // 焦点在空块里 / 编辑器无焦点 → 直接框全部块（没有文字可选，前两段没有意义）。
  // 监听挂在 capture 上：ProseMirror 自己的 "Mod-a → selectAll" 挂在编辑器 DOM 上（冒泡），
  // 先截住才不会两边都跑。
  useEffect(() => {
    // 只选当前这一个块的文字。刻意**不**写 blockSel.mode、也**不**带 BLOCK_SEL ——
    // 两者任一在，isBlockSel 就成立，块会被套上 .mk-bs 的框。
    const oneBlock = (view, $from) => {
      const from = $from.before($from.depth) + 1;
      const to = $from.after($from.depth) - 1;
      // 必须显式清空：之前拖出来的块框选还记着 range，新选区恰好和它 from/to 一致时，
      // isBlockSel 会判成「还是块选中」，框就摘不掉了。
      blockSel.mode = null;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to))
        .setMeta("addToHistory", false));
      view.focus();
    };
    const allBlocks = (view) => {
      const { doc } = view.state;
      const from = 1, to = doc.content.size - 1;
      blockSel.mode = "all";              // 记成块框选，块才会被框起来
      view.dispatch(view.state.tr.setSelection(
        TextSelection.create(doc, from, to),
      ).setMeta("addToHistory", false).setMeta(BLOCK_SEL, true));
      view.focus();
    };
    const onKey = (e) => {
      if (!(e.metaKey || e.ctrlKey) || (e.key !== "a" && e.key !== "A")) return;
      const el = document.activeElement;
      const view = getView?.();
      if (!view) return;
      // 焦点在别的可编辑元素（搜索框、标题栏…）→ 交给浏览器
      const editable = el?.closest?.("[contenteditable='true'], input, textarea");
      if (editable && !el.closest(".milkdown")) return;
      if (el?.closest?.(".cm-editor")) return;          // 代码块内交给 CodeMirror 自己处理

      // 编辑器没有焦点（刚点完空白/侧栏）
      if (!editable && !el?.closest?.(".milkdown")) {
        e.preventDefault();
        allBlocks(view);
        return;
      }
      const sel = view.state.selection;
      const $from = sel.$from;
      const inEmptyBlock = $from.depth === 0
        || !$from.parent.isTextblock || !$from.parent.textContent.trim();
      e.preventDefault();
      e.stopPropagation();
      if (inEmptyBlock) { allBlocks(view); return; }        // 空行 → 没有文字可选，直接框全部块

      const from = $from.before($from.depth) + 1;
      const to = $from.after($from.depth) - 1;

      // ③ 已经是块选中了（框还在）→ 升到全部块。
      //    判据用 coveredBlocks 而不是 blockSel.mode：mode 是模块级记账，
      //    用户中途点一下别处它不会自己清，靠它判会把已经没了的框当成还在。
      if (coveredBlocks(view).length) { allBlocks(view); return; }

      // ② 这一块的文字已经全选上了 → 升格成块选中。
      //    用**严格相等**而不是「sel 更大」：块里划了半句、或跨块划了一片再按 ⌘A，
      //    都还该老老实实走第一段（把当前块的文字整段选上），
      //    跨块划选更是不能直接跳到块框 —— 那会把用户已经选好的范围改意思。
      if (sel.from === from && sel.to === to) {
        /* ⚠️ 这里必须是 `$from.before(1)`，**不能**用 `$from.before($from.depth)`。
           setRange 和 coveredBlocksOf 全都建立在「a/b 是**顶层**块前面那个位置」
           这个前提上：
             · setRange 选出 [off+1, off+nodeSize-1]
             · coveredBlocksOf 要求选区**完整覆盖某个顶层节点**
           普通段落 / 标题 depth 本来就是 1，两者相等，看不出差别；
           但列表项是 doc > ordered_list > list_item > paragraph，depth=3，
           `$from.before(3)` 落在 list_item **内部**（段落之前），
           框出来的只是段落那一小段 [903,992]，
           而顶层块要的是整个列表 [901,994] → coveredBlocksOf 返回空 →
           框根本不画（没有 .mk-bs）→ ③ 的前置条件永远不成立；
           而 ② 自己的判定 `sel.from===from && sel.to===to` 又**成立**
           （每次都算出同一段），于是永远重跑 ② —— 按三次卡在 ①。
           （症状：列表里按 ⌘A 第一次选中该列表项文字，之后再也不升级。） */
        const off = $from.before(1);                        // 顶层块「前面那个位置」
        setRange(view, off, off);
        return;
      }
      oneBlock(view, $from);                                 // ① 光标在某个块里 → 只选这一块的文字
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 顶栏底部分隔线：正文只要**滚动过**（scrollTop > 0）就该出现，滚回顶部消失。
     不看滚动方向（2026-10-16 用户选定）—— 向上滚时那根线留着，只在回到顶时收掉。
     ⚠️ 阈值取 0.5 而不是 0：macOS 的惯性/橡皮筋滚动会经过 0.4、0.2 这种小数，
        判 `> 0` 会在「差一点点到顶」时就闪一下。
     passive 是必须的：这里只读 scrollTop，不该拦滚动。
     依赖里放 doc.rel：换文档时这个滚动容器是新的，要重新读一次初始位置
     （否则从长文切到短文、scrollTop 已经是 0，线却还留着）。 */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !onScrolledChange) return undefined;
    const up = () => onScrolledChange(el.scrollTop > 0.5);
    up();
    el.addEventListener("scroll", up, { passive: true });
    return () => el.removeEventListener("scroll", up);
  }, [onScrolledChange, doc.rel]);

  // Cmd/Ctrl+S 手动立即存盘
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        clearTimeout(timerRef.current);
        doSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.root, doc.rel]);

  // 框选状态下的键盘：Esc 取消框选；Delete/Backspace 整块删掉（不留空行）。
  // 光标 / 普通文本选区不拦，交给 ProseMirror。
  useEffect(() => {
    const onKey = (e) => {
      const view = getView();
      const blocks = view ? coveredBlocks(view) : [];
      if (!blocks.length) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(blocks[0] + 1))));
        view.focus();
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && !e.metaKey && !e.ctrlKey) {
        // 锁定只读：整组删除是 PM 之外自己 dispatch 的，editable=false 拦不住。
        // Esc 那条要留在上面 —— 取消框选不是改文档，只读时也该能取消。
        if (editorLock) return;
        e.preventDefault();
        e.stopPropagation();
        const last = blocks[blocks.length - 1];
        const end = last + view.state.doc.nodeAt(last).nodeSize;
        // 连块一起删（不留一排空行），落点回到删除处的第一个块
        const tr = view.state.tr.delete(blocks[0], end);
        const at = Math.min(blocks[0] + 1, tr.doc.content.size);
        view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(at))).scrollIntoView());
        view.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  /* ⌘F / ⌘R 唤起查找框。
     挂 window + capture，和 ⌘S / ⌘A 那两条一个路子 —— ProseMirror 自己也在
     编辑器 DOM 上挂了 Mod-f，不先截住会两边都跑。
     ⌘F 开着的时候再按是**关掉**它（和系统查找框一致），不是重新聚焦。
     锁定 / 预览下不给开 —— 面板是键盘入口，锁定状态下弹出来却打不了字会让人以为坏了。 */
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k !== "f" && k !== "r") return;
      const el = document.activeElement;
      const ce = el?.closest?.("[contenteditable='true'], input, textarea");
      /* 只有焦点在**编辑器之外**的可编辑元素里才让给浏览器（侧栏筛选框、设置面板…）。
         ⚠️ 判据不能写成「在可编辑元素里就让」—— `.ProseMirror` 自己也是
         contenteditable="true"，而那正是最常见的情况（在正文里按 ⌘F），
         那样写会把查找框让给浏览器，页内查找永远唤不起来。 */
      if (ce && !ce.closest(".editor-wrap") && !ce.closest(".find-box")) return;
      // 锁定 / 预览下不给开，但**快捷键仍然要吃掉**。
      // ⌘R 在 macOS 上是「刷新页面」，放过去等于用户按一下查找就把没存的东西丢了。
      if (locked) { e.preventDefault(); return; }
      e.preventDefault();
      e.stopPropagation();
      setFindUI((s) => (k === "r"
        ? { open: true, mode: "replace" }
        : (s.open && s.mode === "find" ? { open: false, mode: "find" } : { open: true, mode: "find" })));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [locked]);

  /* 把插件状态接到 React 上（见 findStateSink 的注释：受控输入框必须有实时镜像，
     否则用户敲的字会被下一次重渲染抹掉）。
     挂上时先同步一次 —— view 刚建好时可能已经错过了几次 update。 */
  useEffect(() => {
    if (!view) return;
    const push = (st) => setFindMirror(st);
    findStateSink = push;
    push(getFind(view));
    return () => { if (findStateSink === push) findStateSink = null; };
  }, [view]);
  /* 三点菜单里的「查找与替换」也走这里：App 只递一个自增的整数当信号，
     不直接伸手进来改 EditorPane 的 state —— 查找的实现在这边，
     状态（q / 命中）也在插件里，散在两个组件同步迟早走散。 */
  const seenTick = useRef(0);
  useEffect(() => {
    if (!findTick || findTick === seenTick.current) return;
    seenTick.current = findTick;
    setFindUI({ open: true, mode: "find" });
  }, [findTick]);

  // 关掉框：清掉查询词，否则下次打开还留着上次的高亮（正文里一片黄）
  const closeFind = useCallback(() => {
    setFindUI({ open: false, mode: "find" });
    if (view) setFind(view, { q: "", replace: "", idx: 0 });
  }, [view]);

  // .editor-scroll 是独立的滚动容器（min-height:0 必需，否则内容会把 flex 容器撑高、
  // 整页跟着滚）；.editor-pad 只负责居中定宽。
  // 多包一层 .editor-wrap 是为了让大纲轨道有位置可挂：它必须**在滚动容器外面**，
  // 绝对定位到编辑区右缘 —— 放进 .editor-scroll 的话它会跟着正文一起滚走。
  return (
    <div className={"editor-wrap" + (locked ? " locked" : "")}>
    {find.open && (
      <FindPanel view={view} mode={find.mode} setMode={(m) => setFindUI({ open: true, mode: m })}
        mirror={{ open: true, ...findMirror }} close={closeFind} />
    )}
    <div className="editor-scroll" ref={scrollRef}>
      <div className="editor-pad">
        {/* 标题区：大图标(78px) + 「添加图标」按钮 + 标题，垂直堆叠。
            两者指向同一个图标选择器（App 侧复用侧栏那套 IconPicker / pickIcon）。

            **没设图标时整块大图标位不渲染**（用户要求：不要给个默认的文档符号占位），
            入口只剩 hover 时淡入的笑脸按钮。所以标题上方那块 88px 会整个塌掉、
            标题跟着上移 —— 这是预期效果，不是抖动。
            反过来设了图标之后大图标出现、笑脸按钮让位（.off），标题会往下跳一截，
            但那是一次性的、由用户自己触发的操作，不算抖动。 */}
        {/* ⚠️ .doc-head 是 flex column，**标题栏也在里面**，所以只能关这两个图标元素，
            不能整块不渲染（那会把标题一起关掉）。
            showIconUi=false = 外部文件：它的图标**写不进文件**，只落在
            localStorage.extIcons，永远不出现在知识库树或任何列表里 ——
            等于给一篇库外的笔记挂了个没人读的标记。 */}
        <div className="doc-head">
          {showIconUi && hasTitleIcon && (
            <button className="doc-icon set"
              onClick={(e) => onPickIcon(e.currentTarget.getBoundingClientRect())}
              title="更改图标" aria-label="更改文档图标">
              {titleIconEl}
            </button>
          )}
          {showIconUi && (
            <button className={"doc-icon-btn" + (hasTitleIcon ? " off" : "")}
              onClick={(e) => onPickIcon(e.currentTarget.getBoundingClientRect())}
              aria-hidden={hasTitleIcon} tabIndex={hasTitleIcon ? -1 : 0}>
              {smileyEl}
              <span>添加图标</span>
            </button>
          )}
        {/* 顶部固定标题 = 文件名，双向绑定：改标题即改文件名（不可拖动/删除） */}
        <div className="doc-title-bar">
          {/* 锁定提示不在这里 —— 挪到顶栏三点按钮左侧了（`App.jsx` 的 .tb-lock）。
             两处都放的话正文上方多一行、和标题抢位置，而且锁一个全局状态
             不该在正文里留下痕迹。 */}
          <h1 ref={titleRef} className={"doc-title" + (title ? "" : " empty")}
            /* 外部文档的标题现在也可编辑。它**不与文件名联动**：
               App.jsx 的 onTitleCommit 对 doc.external 只更新展示层名字、
               不排 rename，所以这里放开 contentEditable 不会碰到磁盘文件。
               ⚠️ 但它不在 .ProseMirror 里 —— PM 的 editable=false 管不到它，
               锁定只读时必须自己关掉，否则「只读」的文档标题还能改名。 */
            contentEditable={!locked} suppressContentEditableWarning
            spellCheck={false} data-ph={DEFAULT_TITLE} aria-label="文档标题（文件名）"
            onInput={() => {
              const el = titleRef.current;
              const raw = titleText(el);
              // 删空后浏览器会留一个 <br>，它排在 ::before 占位符之后 → 光标被顶到占位符末尾。
              // 这里直接清空子节点，只留占位符，光标回到开头
              if (!raw && el.firstChild) el.textContent = "";
              setTitle(raw);
              onTitleCommit?.(raw);
            }}
            onBlur={() => {
              commitTitle();
              onTitleFlush?.();
              // 落定后名字就是默认「未命名」→ 标题栏收起成空值 + 占位符
              if (!dispTitle(titleText(titleRef.current))) {
                setTitle("");
                titleRef.current.textContent = "";
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              else if (e.key === "Escape") { onTitleCancel?.(); syncTitle(dispTitle(doc.name)); e.currentTarget.blur(); }
            }} />
          {/* 属性头在标题**下面**（用户定的）。标题是第一眼要看的东西，
              属性是补充信息 —— 放在标题上面会把标题挤到第二条，
              打开一篇笔记第一眼看到的不是它的名字。 */}
          {showProps && !preview && (
            <PropPanel table={propsTable} broken={propsBroken}
              created={doc.created} updated={doc.updated}
              expanded={propsExpanded} setExpanded={setPropsExpanded}
              readOnly={locked} onChange={updateProps} />
          )}
        </div>
        </div>
        <div className="mk-host" ref={rootRef} />
      </div>
    </div>
    {/* showMini 要在这里再传一跳：OutlineRail 是渲染在 EditorPane **内部**的
        （它需要 view / scrollRef，这两个只有这里有），App 传不到它身上。
        ⚠️ JSX 里的注释必须用花括号包起来，裸写的会被当成真正的文本节点
        渲染到界面上 —— 而且**花括号里也不能再套一层块注释**，
        内层的结束符会把外层提前终止、报「expected }」。
        这个项目在前者上栽过两次，在后者上栽过一次（就在下面这行）。 */}
    <OutlineRail view={view} scrollRef={scrollRef} showRail={showRail}
      showOutline={showOutline} showMini={showMini} />
    {colorPop && (
      <ColorPalette pop={colorPop} onPick={pickColor} onClose={closeColor} />
    )}
    </div>
  );
}

/* ===== 页内查找面板（#4）=====
   浮在编辑区右上角。⌘F 开搜索、⌘R 直接开替换，同一个框：
   搜索行常驻，替换行只在 replace 态出现。
   为什么放编辑区右上角而不是侧栏的筛选框 / ⌘K 面板：找的是**这一篇**，
   框就该贴在正文边上；侧栏那个框是「筛文件名」，⌘K 是「跳文件」，
   语义不同，硬合并会让两边都变别扭。

   q / replace / idx 的真值在 PM 插件状态里（getFind）—— 命中位置每次文档变动
   都得重算，存 React 里就得自己维护一份会过期的副本。React 这里只存
   「框开没开 + 是不是替换态 + 插件状态的镜像」用于渲染。 */
/* ===== md 属性头面板（#5）=====
   照参考图（Notion 的属性区）做，但**只放对这个应用有意义的**：
   类型选择器里只有 标签 / 文本 / 数字 / 复选框 / 日期。
   参考图那一堆「文档模式 / Journal / 无界配色方案 / 页面宽度 / 模板」是 Notion 的
   概念，和本地 markdown 笔记无关，不照抄。
   其中「页面宽度」和需求 #7 是同一件事 —— 要做就在 #7 里做，不在这里重复。

   默认只显示三行：**标签 / 创建时间 / 更新时间**，其余折在「⌄ 隐藏了 N 个属性」里。
   创建时间和更新时间**不在 frontmatter 里** —— 它们的值来自 fs.stat（server 的 scan()），
   写进文件只会变成一份和真实文件时间对不上的副本（复制、git checkout 都会打架）。
   这两行也**不可编辑**：那是文件系统的事实，改它没有意义。

   值的真值在 `table`（父组件的 propsTable，即 frontmatter 里的用户属性），
   面板本身无状态 —— 改一行就 onChange(新表) 出去，由 EditorPane 同步 ref 后存盘。 */
const PROP_TYPES = [
  { key: "tags", label: "标签", hint: "多个词，分开填", icon: "tag" },
  { key: "text", label: "文本", hint: "一行文字", icon: "type" },
  { key: "number", label: "数字", hint: "可排序 / 可计算", icon: "hash" },
  { key: "checkbox", label: "复选框", hint: "是 / 否", icon: "check" },
  { key: "date", label: "日期", hint: "YYYY-MM-DD", icon: "calendar" },
];

/* 显隐三档（照参考图）。存进 frontmatter 的 `_ui` 下 —— 那是保留键，
   面板渲染时会把它从「属性行」里滤掉，不会当成一条属性显示。
   默认是 "empty"（为空就隐藏）：大多数属性平时是空的，全露出来全是空行。 */
const VIS_MODES = [
  { key: "always", label: "始终显示", icon: "eye" },
  { key: "empty", label: "当属性为空时隐藏", icon: "git-branch" },
  { key: "hidden", label: "始终隐藏", icon: "eye-off" },
];
// UI_KEY / TYPES_KEY 现在从 props.js 导入（那边才是它们的定义处）

// 系统属性：固定那两行，值来自文件系统，不可编辑、也不进 frontmatter
const SYS_ROWS = [
  { key: "created", label: "创建时间", sys: "created", icon: "clock" },
  { key: "updated", label: "更新时间", sys: "updated", icon: "calendar-clock" },
];

// 「为空」怎么判：空串、null/undefined、空数组。**数字 0 是有效值，不算空** ——
// 「评分 0 分」是有意义的，不能藏。
const isEmptyVal = (v) =>
  v === "" || v === null || v === undefined
  || (Array.isArray(v) && !v.length);

/* 时间戳 → 「2026年10月16日」。0 视为「拿不到」返回空串 ——
   created() 在 Linux 上多数文件系统不提供、会回 0，直接 new Date(0) 会
   显示「1970年1月1日」，那不是「创建时间」，是个明显的错值。 */
const fmtDay = (ms) => {
  if (!ms) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
};

function PropPanel({ table, broken, created, updated, expanded, setExpanded, readOnly, onChange }) {
  // cfg = 正在编辑配置的属性名；picking = 类型菜单开着。
  // 「添加属性」的流程：点 ＋ → picking 打开（类型菜单）→ 选一个类型 →
  // **picking 收起、cfg 落到新属性上**，配置菜单自动顶上（用户要的行为）。
  // 点属性的 key 也走 cfg（直接打开配置菜单）。
  const [picking, setPicking] = useState(false);
  const [cfg, setCfg] = useState(null);
  const [newKey, setNewKey] = useState("");
  const [cfgErr, setCfgErr] = useState("");
  /* 藏起来的属性要不要临时摊开给人看（底部那行「还有 N 个已隐藏属性」）。
     不做成「记住」：这是一个「找回被我藏起来的东西」的动作，
     每次打开面板都摊着一堆隐藏项反而成了另一种噪音。 */
  const [revealed, setRevealed] = useState(false);
  /* drafts = 「刚加进来、还没有值」的属性名。
     ⚠️ 这条是被 write() 的空值即删规则逼出来的：用户选完「文本」，种子值是 ""，
     write 一写就把键删了 —— 而默认显隐档是「为空就隐藏」，于是这一行**当场蒸发**，
     用户点了「添加」却什么都没发生。标签更糟：种子 [""] 会往 frontmatter 里
     落一个空标签（`标签:\n  - ""`），那就是脏数据。
     所以空种子**不进表**，行先只活在 drafts 里；用户真填了值、write 落了盘，
     它就从 drafts 里毕业。用户填一半就走了 —— 文件里干干净净，本来也不该留。 */
  const [drafts, setDrafts] = useState([]);
  /* 菜单是**浮层**（像右键菜单那样弹在触发点旁边），不在文档流里撑位置 ——
     在流里的话「＋ 添加属性」下面会突然长出一大块，把正文顶下去。
     锚点记触发元素的 rect，渲染时换算成相对 .props 的坐标。
     flip = 下方空间不够就翻到上面去；right = 右边不够就翻到左边。 */
  const [anchor, setAnchor] = useState(null);
  const propsRef = useRef(null);
  const nameRef = useRef(null);
  // 配置菜单一打开就把光标放进改名框并全选。挂在 effect 里而不是 autoFocus：
  // anchor 每次 openAt 都是新对象，用它当依赖 = 每次开菜单都会重新触发一次。
  useEffect(() => {
    if (!anchor || cfg == null) return;
    const el = nameRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [anchor, cfg]);
  const openAt = (el, which) => {
    const host = propsRef.current;
    if (!el || !host) return;
    const r = el.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const flip = below < 220;
    setAnchor({
      left: Math.max(0, r.left - h.left),
      // 翻到上方时用 bottom 而不是「top:auto」—— absolute 定位里 top:auto
      // 等于回到文档流原位，菜单会掉回面板底部（正好压在触发点下面），看着像没弹出来
      ...(flip
        ? { bottom: h.bottom - r.top + 4 }
        : { top: r.bottom - h.top + 4 }),
      flip,
    });
    setCfgErr("");
    if (which === "types") { setPicking(true); setCfg(null); }
    else {
      setCfg(which);
      setPicking(false);
      // 改名输入框要显示**这一行**的名字。早先没同步，打开 A 的配置菜单
      // 里面却还是上次改名的那个词，一进去就是错的。
      setNewKey(which);
    }
  };
  // 改名提交统一走它：Esc / 点外面 / 回车 / 失焦，四条路都要落盘。
  // 少了任何一条都表现成「改了名字没反应」，而四条路用户都会走。
  // ⚠️ 别拆成「先提交再 closeMenus」两处写：提交只改表，cfg 还指着旧键，
  // 紧跟着的第二次提交会拿旧键当 from 走 draft 分支，凭空造一行出来。
  const commitAndClose = () => {
    if (cfg != null) {
      const err = renameProp(cfg, newKey);
      if (err) { setCfgErr(err); return; }             // 改名没过：菜单留着，把原因显示出来
    }
    setCfgErr("");
    setPicking(false); setCfg(null); setAnchor(null); setNewKey("");
  };
  const closeMenus = () => { setPicking(false); setCfg(null); setAnchor(null); };

  // Esc 关菜单。挂在 window + capture：输入框里按 Esc 时浏览器会清空内容，
  // 那是这段的属性（用户可能正在改名），让它整体退出才符合预期。
  useEffect(() => {
    if (!picking && cfg == null) return;
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenus(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [picking, cfg]);

  // 点外面关菜单。靠 mousedown（不是 click）—— 点在输入框上收起菜单会吞掉这一次聚焦
  useEffect(() => {
    if (!picking && cfg == null) return;
    const onDown = (e) => {
      if (e.target.closest?.(".props-menu") || e.target.closest?.(".props-key")
        || e.target.closest?.(".props-add-btn")) return;
      // 点外面 = 用户不打算继续改了，但**已经打出来的新名字要留住**，
      // 不能因为收菜单就把这次改名丢掉（表现：菜单一关，改名回弹）
      commitAndClose();
    };
    window.addEventListener("mousedown", onDown, true);
    return () => window.removeEventListener("mousedown", onDown, true);
  }, [picking, cfg]);

  const rows = propsToRows(table);       // props.js 里已经把 _ui / _types 滤掉了
  const types = readTypes(table);
  const draftRows = drafts.map((d) => ({ key: d.key, type: d.type, value: undefined }));
  // 内建的「标签」行：键是 tags。**draft 也算数** —— 用户从类型菜单选了「标签」，
  // 值还是空的（空数组会被删掉），这一行得照样出现，不然就是「标签加不上来」。
  const tagsRow = rows.find((r) => r.key === "tags") || draftRows.find((r) => r.key === "tags");
  const hasTags = !!tagsRow;
  const rest = rows.filter((r) => r.key !== "tags");
  // draft 行排在最后：它是「刚加的」，视觉上就该跟在已有属性后面
  const shown = [...rest, ...draftRows.filter((r) => r.key !== "tags")];


  /* 一次落盘：改值 + 记类型 + 收掉 draft，**只发一次 onChange**。
     ⚠️ 必须合成一个函数：拆成 write() + setType() 两次发，两次都是拿同一个
     旧的 table 算 next，后一次会把前一次的结果整个冲掉（值回退、类型也丢）。
     换类型这条路上「先转值再记类型」正好踩这个坑。 */
  const commit = (key, value, type) => {
    const n = { ...(table || {}) };
    const empty = value === "" || value === null || value === undefined
      || (Array.isArray(value) && !value.length);
    if (empty) delete n[key]; else n[key] = value;

    const t = { ...(n[TYPES_KEY] || {}) };
    const want = type || t[key] || guessType(n[key]);
    if (n[key] === undefined) delete t[key];            // 值没了，类型跟着没
    else if (guessType(n[key]) === want) delete t[key]; // 猜得出来就别写，文件干净
    else t[key] = want;
    if (Object.keys(t).length) n[TYPES_KEY] = t; else delete n[TYPES_KEY];

    if (n[key] !== undefined) {
      // 值落进表里了，这个 draft 毕业（表格成了它的真值来源）
      setDrafts((d) => d.filter((x) => x.key !== key));
    } else if (type) {
      // 「加属性」明确要建这一行 → 行只活在 drafts 里。
      // type 要跟着走，否则空的标签属性一渲染就是文本框
      // （下面 PropValue 只认 row.type）。
      setDrafts((d) => (d.some((x) => x.key === key)
        ? d.map((x) => (x.key === key ? { ...x, type: want || x.type } : x))
        : [...d, { key, type: want || "text" }]));
    } else {
      // 用户自己把值清空了（删掉最后一个标签、清空输入框）→ 这一行就该跟着消失。
      // 不然标签删光了还留一条空行，「删掉这个属性」就再也删不掉了。
      setDrafts((d) => d.filter((x) => x.key !== key));
    }
    onChange(Object.keys(n).length ? n : null);
  };
  const write = (key, value) => commit(key, value, null);

  /* 显隐档存在 frontmatter 的保留键 `_ui` 下 —— 那是「界面状态」而不是
     「文档内容」，混在用户属性里会污染 frontmatter，抽出来放 _ui 干净些。
     渲染属性行时会把 _ui 滤掉（见 propsToRows 的调用处）。 */
  const ui = (table?.[UI_KEY] && typeof table[UI_KEY] === "object") ? table[UI_KEY] : {};
  const vis = (key) => ui[key] || "empty";
  const hiddenRows = [
    // 内建「标签」行不在 shown 里（它单独渲染在上面），但它一样能被设成始终隐藏，
    // 所以这里要单独补回去，否则「标签」藏起来就再也调不出来了
    ...(vis("tags") === "hidden"
      ? [{ key: "tags", label: "标签", icon: "tag", row: tagsRow || { key: "tags", type: "tags" } }]
      : []),
    ...shown.filter((r) => vis(r.key) === "hidden")
      .map((r) => ({ key: r.key, label: r.key, icon: iconKeyFor(r.key, r.type), row: r })),
  ];
  const setVis = (key, mode) => {
    const n = { ...(table || {}) };
    const u = { ...(n[UI_KEY] || {}) };
    if (mode === "empty") delete u[key]; else u[key] = mode;
    if (Object.keys(u).length) n[UI_KEY] = u; else delete n[UI_KEY];
    onChange(Object.keys(n).length ? n : null);
  };

  /* 种子的值。**null = 不落盘**，那一行改走 drafts（见上面的 drafts 说明）：
     空串和空数组都会被当成「删掉这个键」，直接写进去等于没加。 */
  const seedFor = (type) =>
    type === "checkbox" ? false : type === "number" ? 0 : null;
  /* 当前类型：显式记的 > 从值猜的 > 文本。draft 也在内 —— 空属性没有值可猜。 */
  const typeOf = (key) => types[key]
    || (rows.find((r) => r.key === key) || {}).type
    || (drafts.find((d) => d.key === key) || {}).type
    || "text";
  const typeLabel = (t) => (PROP_TYPES.find((x) => x.key === t) || {}).label || "文本";
  /* 默认键名。**标签走内建那一行**（键就是 tags）—— 面板顶部本来就有「标签」，
     再另起一个键叫「标签」的行会出现两个同名行，那才叫看不懂。
     其余类型用类型名当键（「文本」「数字」…），选完立刻能在配置菜单里改。 */
  const defaultKeyFor = (type) => (type === "tags" ? "tags" : typeLabel(type));

  /* 加一条属性。
     ⚠️ **key 一律由类型推出来，不吃 newKey** —— 早先这里传的是 `newKey`，
     而 newKey 是上一次 addProp 写进去的（上一次的名字）。于是第二次点类型菜单，
     k 还是上次的键 → `table[k]` 已存在 → 直接开配置菜单、什么新属性都没加，
     用户看到的就是「不管选什么都是上回那个」。
     真正的改名入口是配置菜单里那个输入框，不该由这里抢。 */
  const addProp = (type) => {
    const k = defaultKeyFor(type);
    setPicking(false);
    setExpanded(true);
    setCfgErr("");
    if (table?.[k] !== undefined || drafts.some((d) => d.key === k)) { setCfg(k); setNewKey(k); return; }
    commit(k, seedFor(type), type);
    setCfg(k);
    setNewKey(k);
  };

  /* 改名。**返回失败原因**（成功返回 null）——
     早先失败一律静默 return：名字重了、名字空了，用户看到的就是
     「输入框里的字回弹了 / 什么都没发生」，完全不知道被什么挡了。
     菜单会把原因显示出来，静默失败才会被当成「改名功能坏了」。 */
  const renameProp = (from, to) => {
    const k = (to || "").trim();
    if (!k) return "属性名不能为空";
    if (k === from) return null;
    if (table?.[k] !== undefined || drafts.some((d) => d.key === k)) return `已经有叫「${k}」的属性了`;
    if (table?.[from] === undefined) {                 // 改的是个 draft：表里没它，只挪名字
      setDrafts((d) => d.map((x) => (x.key === from ? { ...x, key: k } : x)));
      return null;
    }
    const n = {};
    for (const [key, v] of Object.entries(table || {})) {
      // ⚠️ _ui / _types 里面是**按属性名索引**的，改名要一起搬。
      // 只搬顶层键的话：显隐档和类型还挂在旧名字上，改完名「始终显示」就失效了，
      // 而那条死设置在文件里谁也看不见、也删不掉。
      if ((key === UI_KEY || key === TYPES_KEY) && v && typeof v === "object") {
        const m = {};
        for (const [ik, iv] of Object.entries(v)) m[ik === from ? k : ik] = iv;
        n[key] = m;
        continue;
      }
      n[key === from ? k : key] = v;
    }
    onChange(n);
    return null;
  };

  /* 换类型 = 把现值转成新类型能表示的东西，转不动就换成空值。
     直接换个 type 不动值的话，checkbox=true 存进 text 类型的键会变成字符串 "true"。
     ⚠️ 值和类型必须**一次** commit —— 见上面 commit() 的说明。 */
  const retype = (key, type) => {
    const cur = table?.[key];
    let next = cur;
    if (type === "tags") next = Array.isArray(cur) ? cur : (cur === "" || cur == null ? [] : [String(cur)]);
    else if (Array.isArray(cur)) next = cur.join(" ");
    else if (type === "checkbox") next = cur === true || cur === "true" || cur === 1;
    else if (type === "number") next = typeof cur === "number" ? cur : (cur === "" || cur == null ? 0 : Number(cur) || 0);
    else if (cur !== undefined && cur !== null) next = String(cur);
    commit(key, next, type);
  };

  const removeProp = (key) => {
    commit(key, "", null);                            // 连 _types 里那一条一起清
    closeMenus();
    setNewKey("");
  };

  /* 折叠态就一行：折叠按钮 + 一行摘要（标签 + 几个时间）。
     摘要不能省 —— 折叠了就完全看不见，用户会以为「这篇没属性」，
     而标签和创建时间恰恰是最该一眼扫到的东西。 */
  const summary = [
    hasTags && (tagsRow.value || []).join(" "),
    fmtDay(created),
  ].filter(Boolean).join(" · ");

  if (!expanded) {
    return (
      <div className="props collapsed">
        {broken && (
          <div className="props-warn">文件头的属性解析失败，已原样保留。</div>
        )}
        <button className="props-toggle" onClick={() => setExpanded(true)}
          title="展开属性" aria-expanded="false">
          <span className="pt-chev" aria-hidden="true">›</span>
          {/* 摘要后面**不跟属性条数**（用户 2026-10-13 定的）：
              那个数字不解决任何问题 —— 折叠态一行就该是「扫一眼知道这篇有什么」，
              塞个计数只是多一个要读的符号，而且它算的是 `shown.length + 2`
              （两行系统属性恒定占位），用户看到「6」根本不知道该期待几行。 */}
          <span className="props-sum">{summary || "属性"}</span>
        </button>
      </div>
    );
  }

  return (
    <div className="props" ref={propsRef}>
      <button className="props-toggle open" onClick={() => setExpanded(false)}
        title="折叠属性" aria-expanded="true">
        <span className="pt-chev" aria-hidden="true">⌄</span>
        <span className="props-sum">属性</span>
      </button>
      {broken && (
        <div className="props-warn">
          文件头的属性解析失败，已原样保留。要改属性请先把它改成合法的 YAML。
        </div>
      )}

      {/* 标签 —— 三行里的第一行。没有 tags 键时是个占位，点 key 走配置菜单。
          ⚠️ 值取自 tagsRow 而不是现查 rows：刚加的标签属性还是 draft，
          rows 里查不到，rows.find(...).value 会直接抛。 */}
      {vis("tags") !== "hidden" && (hasTags || vis("tags") === "always") && (
        <PropRow icon="tag" label="标签" clickable={!readOnly}
          onOpen={(e) => openAt(e.currentTarget, "tags")} onRemove={null}>
          {hasTags
            ? <TagsInput value={tagsRow.value}
                readOnly={readOnly}
                onChange={(v) => write("tags", v.filter(Boolean))} />
            : <span className="props-empty">属性为空</span>}
        </PropRow>
      )}

      {/* 系统属性两行：值拿不到就整行不渲染。
          库外文件走 Rust 的 read_file_meta，created() 在 Linux 上拿不到，
          显示一行空值比不显示更让人以为「这文件没有创建时间」。 */}
      {SYS_ROWS.map((r) => {
        const v = r.sys === "created" ? created : updated;
        if (!v) return null;
        return (
          <PropRow key={r.key} icon={r.icon} label={r.label} onRemove={null}>
            <span className="props-sys">{fmtDay(v)}</span>
          </PropRow>
        );
      })}

      {shown
        .filter((r) => vis(r.key) !== "hidden")
        .filter((r) => vis(r.key) === "always" || !isEmptyVal(r.value)
          || drafts.some((d) => d.key === r.key))
        .map((r) => (
          <PropRow key={r.key} icon={iconKeyFor(r.key, r.type)} label={r.key} clickable={!readOnly}
            onOpen={(e) => openAt(e.currentTarget, r.key)} onRemove={null}>
            <PropValue row={r} readOnly={readOnly} onChange={(v) => write(r.key, v)} />
          </PropRow>
        ))}

      {/* 被「始终隐藏」藏起来的属性：摊开给人看，好把它改回别的档 / 删掉。
          摊出来的行和普通行一样能点 key 开配置菜单 —— 这才是「回得来」的真正入口。
          ⚠️ 这一段在 `.props-add` 之前：菜单是浮层，位置锚在触发元素上，
          按钮被这一行盖住就点不到了。 */}
      {hiddenRows.length > 0 && (
        <div className="props-reveal">
          <button className={"props-toggle" + (revealed ? " open" : "")}
            onClick={() => setRevealed((v) => !v)}
            aria-expanded={revealed}>
            <span className="pt-chev" aria-hidden="true">{revealed ? "⌄" : "›"}</span>
            <span className="props-sum">
              {revealed ? "收起已隐藏的属性" : `还有 ${hiddenRows.length} 个已隐藏属性`}
            </span>
          </button>
          {revealed && hiddenRows.map((h) => (
            <PropRow key={h.key} icon={h.icon} label={h.label} clickable={!readOnly}
              onOpen={(e) => openAt(e.currentTarget, h.key)} onRemove={null}>
              <PropValue row={h.row} readOnly={readOnly}
                onChange={(v) => write(h.key, v)} />
            </PropRow>
          ))}
        </div>
      )}

      {/* ＋ 添加属性 → 类型菜单；选完类型，类型菜单收起、配置菜单自动顶上 */}
      {!readOnly && !picking && cfg == null && (
        <div className="props-add">
          <button className="props-add-btn"
            onClick={(e) => openAt(e.currentTarget, "types")}>＋ 添加属性</button>
        </div>
      )}
      {picking && anchor && (
        <div className={"props-menu" + (anchor.flip ? " up" : "")}
          style={anchor.flip
            ? { left: anchor.left, bottom: anchor.bottom }
            : { left: anchor.left, top: anchor.top }} onClick={(e) => e.stopPropagation()}>
          <div className="pm-head">类型</div>
          {PROP_TYPES.map((t) => (
            <button key={t.key} className="pm-item"
              onClick={() => addProp(t.key)}>
              <span className="pm-ic"><PropIcon name={t.icon} /></span>
              <span className="pm-text">
                <span className="pm-label">{t.label}</span>
                <span className="pm-hint">{t.hint}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      {!readOnly && cfg != null && anchor && (
        <div className={"props-menu cm" + (anchor.flip ? " up" : "")}
          style={anchor.flip
            ? { left: anchor.left, bottom: anchor.bottom }
            : { left: anchor.left, top: anchor.top }} onClick={(e) => e.stopPropagation()}>
<div className="pm-name">
            <PropIcon name={iconKeyFor(cfg, typeOf(cfg))} size={13} />
            {/* 改名框要自动聚焦 + 全选：菜单就是**为改名这件事**弹出来的，
                弹完还得先点一下才能打字的话，这菜单等于白弹。
                ⚠️ 原来靠 `autoFocus` + `onFocus → select()`，两条都不可靠：
                autoFocus 要等 React 的 commit 阶段才 focus，而这一刻
                「点 key 那个按钮」的焦点还在它身上，时序一错就丢焦点，
                而且丢得**没有任何提示** —— 框在、光标不在，敲字毫无反应，
                表现就是「key 改不了」。改成挂 effect、以 anchor 为触发
                （openAt 每次都换一个新 anchor 对象，重开菜单必触发）。 */}
            <input ref={nameRef} value={newKey} aria-label="属性名" placeholder="属性名"
              onChange={(e) => setNewKey(e.target.value)}
              /* 失焦也提交，不能只认 Enter —— 改完顺手点值那一栏是很自然的动作。
                 提交后把菜单收掉：改名这件事做完了，浮层留着会挡住值那一栏。 */
              onBlur={(e) => {
                // 焦点还留在菜单里（点下面的类型/显隐/删除项）→ 别收，
                // 一收菜单就整个卸载，那一下点击自然也落空了。
                const host = e.currentTarget.closest(".props-menu");
                if (e.relatedTarget && host && host.contains(e.relatedTarget)) return;
                commitAndClose();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); commitAndClose(); }
                if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); commitAndClose(); }
              }} />
          </div>
          {cfgErr && <div className="pm-err">{cfgErr}</div>}
          <div className="pm-head">类型　<span className="pm-cur">{typeLabel(typeOf(cfg))}</span></div>
          {PROP_TYPES.map((t) => (
            <button key={t.key} className="pm-item" onClick={() => retype(cfg, t.key)}>
              <span className="pm-ic"><PropIcon name={t.icon} /></span>
              <span className="pm-label">{t.label}</span>
              {typeOf(cfg) === t.key && <span className="pm-check"><PropIcon name="check" size={13} /></span>}
            </button>
          ))}
          {VIS_MODES.map((v) => (
            <button key={v.key} className="pm-item" onClick={() => setVis(cfg, v.key)}>
              <span className="pm-ic"><PropIcon name={v.icon} /></span>
              <span className="pm-label">{v.label}</span>
              {vis(cfg) === v.key && <span className="pm-check"><PropIcon name="check" size={13} /></span>}
            </button>
          ))}
          <button className="pm-item danger" onClick={() => removeProp(cfg)}>
            <span className="pm-ic"><PropIcon name="trash" /></span>
            <span className="pm-label">删除属性</span>
          </button>
        </div>
      )}
    </div>
  );
}

function PropRow({ icon, label, children, clickable, onOpen }) {
  return (
    <div className="props-row">
      {/* 图标 + 属性名 是一块可点的：点了开配置菜单（改名 / 换类型 / 显隐 / 删除）。
          值那一栏**不**在这个热区里 —— 否则点输入框会顺带弹菜单，没法好好打字。 */}
      <button className={"props-key" + (clickable ? " can" : "")} disabled={!clickable}
        title={clickable ? `${label}（点击改名 / 换类型）` : label} onClick={onOpen}>
        <span className="props-ic" aria-hidden="true"><PropIcon name={icon} size={13} /></span>
        <span className="props-label">{label}</span>
      </button>
      <span className="props-val">{children}</span>
    </div>
  );
}

function PropValue({ row, readOnly, onChange }) {
  const [text, setText] = useState(String(row.value ?? ""));
  useEffect(() => { setText(String(row.value ?? "")); }, [row.key, row.value]);
  if (readOnly) {
    return <span className="props-readonly">
      {row.type === "tags" ? (Array.isArray(row.value) ? row.value.join(" · ") : "") : String(row.value ?? "")}
    </span>;
  }
  /* ⚠️ tags 分支原来根本没有：数组值会掉进最后那个 input，
     显示成 "a,b"，改一个字就存成字符串 → guessType 说是文本 →
     下次打开标签就变成一个文本框了（「标签值填不进去」就是这个）。
     现在交给 TagsInput：chip 多选，存进 frontmatter 的仍是数组。 */
  if (row.type === "tags") {
    return <TagsInput value={row.value} readOnly={false}
      onChange={(v) => onChange(v.filter(Boolean))} />;
  }
  if (row.type === "checkbox") {
    return (
      <input type="checkbox" className="props-check" checked={!!row.value}
        onChange={(e) => onChange(e.target.checked)} />
    );
  }
  if (row.type === "number") {
    return <input className="props-input" type="number" value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onChange(text === "" ? "" : Number(text))} />;
  }
  return <input className="props-input" value={text}
    onChange={(e) => setText(e.target.value)}
    onBlur={() => onChange(text)} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />;
}

function TagsInput({ value, readOnly, onChange }) {
  const list = Array.isArray(value) ? value : [];
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const commit = () => {
    const v = draft.trim();
    setDraft("");
    setAdding(false);
    if (v) onChange([...list, v]);
  };
  if (readOnly) return <span className="props-readonly">{list.join(" · ")}</span>;
  return (
    <span className="props-tags">
      {list.map((t, i) => (
        <span className="tag" key={i}>
          {t}
          <button className="tag-x" aria-label={`删除标签 ${t}`}
            onClick={() => onChange(list.filter((_, k) => k !== i))}>✕</button>
        </span>
      ))}
      {adding
        ? <input className="tag-input" value={draft} autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") { setDraft(""); setAdding(false); }
            }} />
        : <button className="tag-add" onClick={() => setAdding(true)}>＋</button>}
    </span>
  );
}

function FindPanel({ view, mode, setMode, mirror, close }) {
  const searchRef = useRef(null);
  const replaceRef = useRef(null);
  // 每次打开都把光标放进搜索框，并选中上次搜的词（接着上次找是常见动作）
  useEffect(() => {
    if (!mirror.open) return;
    const el = searchRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [mirror.open]);   // eslint-disable-line react-hooks/exhaustive-deps

  const { q, replace, idx, hits } = mirror;
  const total = hits.length;
  const cur = total ? idx + 1 : 0;

  // 跳到第 n 个命中。**不改 selection**，只滚动 + 换 decoration 的 cur 类。
  const goto = (n) => {
    if (!total || !view) return;
    const next = ((n % total) + total) % total;
    setFind(view, { idx: next });
    const h = getFind(view).hits[next];
    if (!h) return;
    const dom = view.domAtPos(h.from);
    const el = (dom.node.nodeType === 1 ? dom.node : dom.node.parentElement)
      ?.closest("p,h1,h2,h3,h4,h5,h6,li,pre,blockquote,td");
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    el?.animate?.([{ backgroundColor: "rgba(255,214,0,.55)" }, { backgroundColor: "" }],
      { duration: 520, easing: "ease-out" });
  };

  // 替换当前这一处。替换完正文变了 → 插件重扫，idx 由 apply 里夹回去，
  // 接着替换的是「原来下一处」，正好是用户预期的连续替换。
  const replaceOne = () => {
    if (!view || !total || !q) return;
    const f = getFind(view);
    const h = f.hits[f.idx];
    if (!h) return;
    view.dispatch(view.state.tr
      .insertText(replace, h.from, h.to)
      .setMeta(FIND_KEY, { q: f.q, replace: f.replace, idx: f.idx }));
    goto(getFind(view).idx);
  };

  /* 全部替换：**从后往前**插。
     从前往后插会让后面的命中位置整体后移，剩下那些 from/to 全部错位 ——
     这是替换功能最经典的一个 bug。后往前插则只影响已处理位置之后的，
     而那些本来就还没用到。 */
  const replaceAll = () => {
    if (!view || !total || !q) return;
    const f = getFind(view);
    let tr = view.state.tr;
    for (let i = f.hits.length - 1; i >= 0; i--) {
      tr = tr.insertText(f.replace, f.hits[i].from, f.hits[i].to);
    }
    view.dispatch(tr.setMeta(FIND_KEY, { q: f.q, replace: f.replace, idx: 0 }));
  };

  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      if (mode === "replace" && (e.metaKey || e.ctrlKey)) { replaceAll(); return; }
      goto(idx + (e.shiftKey ? -1 : 1));
    }
  };

  return (
    <div className={"find-box" + (mode === "replace" ? " replace" : "")} onKeyDown={onKey}>
      <div className="find-row">
        <span className="find-ic" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
               strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>
          </svg>
        </span>
        {/* **非受控**（defaultValue，不是 value）。受控输入框只要组件重渲染一次，
            React 就按 value 把 DOM 里用户敲的字抹掉 —— 这里 value 来自 PM 插件的镜像，
            任何别处的重渲染（统计回传、锁定切换）都会连带清空输入框。
            只有用户会往这两个框里打字，没有第二个写入方，所以完全不需要受控。 */}
        <input ref={searchRef} className="find-input" defaultValue={q} spellCheck={false}
          placeholder="查找" aria-label="查找"
          onChange={(e) => { if (view) setFind(view, { q: e.target.value, idx: 0 }); }} />
        <span className={"find-count" + (q && !total ? " none" : "")}>
          {q ? (total ? `${cur} / ${total}` : "无结果") : ""}
        </span>
        <button className="find-mini" title="上一个（Shift+Enter）" aria-label="上一个"
          disabled={!total} onClick={() => goto(idx - 1)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
               strokeLinecap="round" strokeLinejoin="round"><path d="m18 15l-6-6l-6 6"/></svg>
        </button>
        <button className="find-mini" title="下一个（Enter）" aria-label="下一个"
          disabled={!total} onClick={() => goto(idx + 1)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
               strokeLinecap="round" strokeLinejoin="round"><path d="m6 9l6 6l6-6"/></svg>
        </button>
        <button className="find-mini" title="在下面这行替换（⌘R）" aria-label="切换替换"
          aria-pressed={mode === "replace"}
          onClick={() => { setMode(mode === "replace" ? "find" : "replace"); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
               strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 8h13l-3-3M21 16H8l3 3"/>
          </svg>
        </button>
        <button className="find-mini" title="关闭（Esc）" aria-label="关闭" onClick={close}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
               strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>
      {mode === "replace" && (
        <div className="find-row">
          <span className="find-ic" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                 strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 8h13l-3-3M21 16H8l3 3"/>
            </svg>
          </span>
          <input ref={replaceRef} className="find-input" defaultValue={replace} spellCheck={false}
            placeholder="替换为" aria-label="替换为"
            onChange={(e) => { if (view) setFind(view, { replace: e.target.value }); }} />
          <button className="find-btn" disabled={!total}
            onClick={replaceOne} title="替换这一处（⌘Enter）">替换</button>
          <button className="find-btn" disabled={!total}
            onClick={replaceAll} title="全部替换（⌘⌥Enter）">全部</button>
        </div>
      )}
    </div>
  );
}

export default function EditorPane(props) {
  return <EditorInner {...props} />;
}

// ===== 拖拽的三处修正（原型见 milkdown-spike 分支的 /spike.html）=====
// 1) 自绘幽灵：Crepe 用浏览器原生拖拽影像（setDragImage），Chromium 会自己加半透明和
//    投影，还按「按下瞬间记的偏移」摆，容易盖住正文 —— 换成自己克隆一份跟着光标走
//    （只装内容，不要底框；透明度 .7；源行盖一层白蒙版当作「变淡」）
// 2) 落地设 NodeSelection：否则 ProseMirror 会留一个文本选区在落点，
//    格式工具条（改字体那个）就跟着弹出来
// 3) 克隆件要套一层 .milkdown：Crepe 的样式全是 `.milkdown xxx` 作用域，
//    裸 div 里克隆出来的列表项会散架（原生 marker 和 .label-wrapper 各画一份）
// 4) 手把手的热区放宽：主题只在指针压到把手元素上才显形，正文左侧那一大片空白
//    划过去是「什么都没有」，得刻意瞄那条 ⠿。这里把每块左侧 32px 也算进热区，
//    在那条带上移动就显形（.mk-handle-hot 由下面的 mousemove 维护）
// 5) 空白处（正文列左侧的空白带）按住拖 = 框选：从起点块拖到终点块，
//    跟 Notion 一样，不用先 Alt 也不用够把手
const TYPO = [
  "font-family", "font-size", "font-weight", "font-style", "line-height",
  "letter-spacing", "color", "text-align", "text-indent",
  "padding", "margin", "border", "box-sizing",
  "width", "min-width", "max-width", "height", "min-height", "max-height",
];

function copyTypo(src, dst) {
  const a = [src, ...src.querySelectorAll("*")];
  const b = [dst, ...dst.querySelectorAll("*")];
  for (let i = 0; i < a.length && i < b.length; i++) {
    const cs = getComputedStyle(a[i]);
    for (const p of TYPO) b[i].style.setProperty(p, cs.getPropertyValue(p));
  }
}

/* 这个位置在不在某个列表里。
   列表项拖到列表外时要靠它决定「摊平成段落」还是「照原样插入」。 */
function isInsideList(doc, pos) {
  if (pos < 0 || pos > doc.content.size) return false;
  const $p = doc.resolve(pos);
  for (let d = $p.depth; d >= 1; d--) {
    const t = $p.node(d).type;
    if (t.spec?.group === "listItem") return true;
    // bullet_list / ordered_list 都算列表，按节点名后缀判，不写死具体名字
    if (/list$/i.test(t.name)) return true;
  }
  return false;
}

/* 屏幕坐标 → 该点所属**最内层 listItem** 的区间（不在列表里则 null）。
 *
 * 为什么必须单独有一个（2026-10-16 修「列表项拖不动」）：
 * blockPosAt 那套 `while (d < $p.depth && $p.node(d-1).type.name !== "doc") d++`
 * 是按**顶层块**写的。指针落在列表项文字上时 depth=3（doc › bullet_list ›
 * list_item › paragraph），循环第一轮就因为 node(0) 是 doc 而退出，d 停在 1，
 * `$p.before(1)` 解析成**整个 bullet_list** 的起点。
 *
 * 于是拖源和落点都算成「整个列表」：落点必然落在拖源区间内部，
 * applyMove 命中 `target > drag.from` 直接 return —— 什么都不发生，也不报错。
 * 用户看到的现象就是「拖第一项到第二项后面，永远没反应」。
 *
 * 用 type.spec.group 判 listItem，不按节点名硬匹配：bullet_list / ordered_list
 * 两种列表都覆盖，将来换命名也不会失效。
 */
function listItemRangeAt(view, x, y) {
  const probe = (px) => {
    const at = view.posAtCoords({ left: px, top: y });
    if (!at) return null;
    /* 解 at.**pos** 而不是 at.inside（blockPosAt 用的是 inside，两处不一样是有原因的）：
       posAtCoords 对列表第一项返回 {pos: 10, inside: 9}，而 resolve(9) 的 depth 只有 1
       —— inside 给的是「刚进 bullet_list」的位置，往下钻不到 list_item。
       at.pos 才是真正落在文字上的那个位置（depth 2~3），才能找到最内层的 listItem。
       at.inside === -1 说明点在块间空隙上，这时 at.pos 解出来 depth 0，
       下面的循环自然不执行、返回 null，交给顶层块那套逻辑处理。 */
    const $p = view.state.doc.resolve(at.pos);
    for (let d = $p.depth; d >= 1; d--) {
      const n = $p.node(d);
      if (n.type.spec?.group === "listItem") {
        const from = $p.before(d);
        return { from, to: from + n.nodeSize, depth: d, node: n };
      }
    }
    return null;
  };

  const hit = probe(x);
  if (hit) return hit;
  /* ⚠️ 拖动的起点是**块把手**，而把手挂在正文列**左边外面**（实测把手 654~720px，
     .ProseMirror 从 736px 才开始）。拿把手的 x 去 posAtCoords 打不进任何内容，
     于是 probe 返回 null，拖拽退回「顶层块」= 整个列表 —— 表现就是
     「列表项之间怎么拖都没反应」（用户 2026-10-16 报的就是这个）。

     所以必须**只借 y、x 换成正文列内侧**，和 looseBlockPosAt 的兜底是同一个道理。 */
  const r = view.dom.getBoundingClientRect();
  return probe(r.left + Math.min(20, r.width / 2));
}

// 屏幕坐标 → 该点所属顶层块的起始位置
function blockPosAt(view, x, y) {
  const at = view.posAtCoords({ left: x, top: y });
  if (!at) return null;
  const $p = view.state.doc.resolve(at.inside > -1 ? at.inside : at.pos);
  // 点在块边缘时 posAtCoords 常给不出 inside，落在 doc 层的 pos 本身就是块起点
  if ($p.depth === 0) return $p.pos;
  let d = 1;
  while (d < $p.depth && $p.node(d - 1).type.name !== "doc") d++;
  return $p.before(d);
}

function installDragGhost(root, getView) {
  const ghost = document.createElement("div");
  ghost.className = "mk-ghost";
  ghost.hidden = true;
  const dim = document.createElement("div");
  dim.className = "mk-dim";
  dim.hidden = true;
  const noDrag = document.createElement("div");
  noDrag.className = "mk-nodrag";
  document.body.append(ghost, dim, noDrag);

  let dims = [];
  let grab = { x: 0, y: 0 };
  let lastDrop = null;
  // 按下把手那一瞬的框选状态。必须挂在 mousedown 捕获阶段：Milkdown 会在同一个
  // mousedown 里把跨块选区换成「单块 NodeSelection」，等 dragstart 再看就只剩一块了。
  let press = null;
  // 框选 >=2 块时整组一起搬。Milkdown 自带拖拽只认「把手底下那一块」，框了 3 块
  // 拖走 1 块，所以这条路径我们自己切自己插（applyGroupMove）。
  // 本次拖动的区间 { from, to, size, slice }：框选整组就是整段，单块就是那一块。
  // 落点一律我们自己算、自己搬 —— Milkdown 自带的 drop 会把代码块拖到列表旁边时
  // 塞成列表的子项（实测把 ``` 块拖到列表下面直接变成列表项，还嵌套了一层）
  let drag = null;       // { from, to, size, slice }
  let groupMoved = false;
  let dropPos = null;

  // 指针按在哪个块上（把手的 x 在正文左边，posAtCoords 常给不出位置 → 按 y 兜底）
  const looseBlockPosAt = (view, x, y) => {
    const direct = blockPosAt(view, x, y);
    if (direct != null && view.state.doc.nodeAt(direct)) return direct;
    const r = view.dom.getBoundingClientRect();
    const byY = blockPosAt(view, r.left + Math.min(20, r.width / 2), y);
    if (byY != null && view.state.doc.nodeAt(byY)) return byY;
    return null;
  };

  const onPress = (e) => {
    const view = getView?.();
    if (!view) { press = null; return; }
    const blocks = coveredBlocksOf(view.state);
    press = {
      blocks: blocks.length >= 2 ? blocks : null,
      els: blocks.length >= 2 ? [...root.querySelectorAll(".mk-bs")] : [],
      at: looseBlockPosAt(view, e.clientX, e.clientY),   // 按下那一刻指针所在块
    };
  };

  const onDragStart = (e) => {
    // 锁定只读：原生拖拽是块移动的起点，editable=false 拦不住它（PM 照样给 NodeSelection）。
    if (editorLock) { e.preventDefault(); drag = null; press = null; return; }
    if (!e.target.closest?.(".milkdown-block-handle")) return;

    const view = getView?.();
    drag = null;
    groupMoved = false;
    dropPos = null;
    let sels;

    const grabPos = (view ? looseBlockPosAt(view, e.clientX, e.clientY) : null)
      ?? press?.at ?? null;     // dragstart 里有时算不出位置，退回按下那一刻记录的
    const pb = press?.blocks;
    const grabInside = !!(pb && grabPos != null && grabPos >= pb[0] && grabPos <= pb[pb.length - 1]);

    if (view && grabPos != null) {
      /* 框选整组时搬整组；否则指针落在某个列表项里就**只搬那一条**。
         这一条是上面 listItemRangeAt 的注释里说的那个坑的修复：
         以前不管什么情况都退回顶层块，列表项和整个列表被算成同一个东西。 */
      const item = grabInside ? null : listItemRangeAt(view, e.clientX, e.clientY);
      const first = grabInside ? pb[0] : (item ? item.from : grabPos);
      const last = grabInside ? pb[pb.length - 1] : (item ? item.from : grabPos);
      const to = last + view.state.doc.nodeAt(last).nodeSize;
      drag = { from: first, to, size: to - first,
               slice: view.state.doc.slice(first, to),
               // 记一下这是列表项：搬完之后幽灵/选区高亮的收尾走另一条路
               item: item || null };
    }
    if (grabInside) sels = press.els;                   // 幽灵画整组，而不是只有被拖的那一块

    // 框选态的块挂 .mk-bs（decoration），普通拖拽挂 .ProseMirror-selectednode
    if (!sels) sels = [...root.querySelectorAll(".mk-bs, .ProseMirror-selectednode")];
    // 代码块这类：Milkdown 不给 NodeSelection，上面两个都选不到 → 直接取该块的 DOM
    if (!sels.length && drag) {
      const dom = view?.nodeDOM(drag.from);
      if (dom) sels = [dom];
    }
    if (!sels.length) return;

    const rects = sels.map((el) => el.getBoundingClientRect());
    const r = {
      left: Math.min(...rects.map((x) => x.left)),
      top: Math.min(...rects.map((x) => x.top)),
      right: Math.max(...rects.map((x) => x.right)),
      bottom: Math.max(...rects.map((x) => x.bottom)),
    };
    r.width = r.right - r.left; r.height = r.bottom - r.top;
    grab = { x: e.clientX - r.left, y: e.clientY - r.top };

    const wrap = document.createElement("div");
    wrap.className = "milkdown";
    for (const sel of sels) {
      const clone = sel.cloneNode(true);
      clone.classList.remove("ProseMirror-selectednode");
      clone.classList.remove("mk-bs");
      clone.removeAttribute("data-dragging");
      copyTypo(sel, clone);
      // Crepe 的列表结构是
      //   .milkdown > ul > .milkdown-list-item-block > li.list-item > [.label-wrapper, .children]
      // 克隆出来的 li 脱离了 ul 和 .milkdown-list-item-block，会退回浏览器的
      // display:list-item + 圆点项目符号，看着就是「一个条目冒出两个标记」。
      // 所以按原结构把外壳补回去。
      if (clone.tagName === "LI") {
        const list = document.createElement(sel.parentElement?.tagName === "OL" ? "ol" : "ul");
        const holder = document.createElement("div");
        holder.className = "milkdown-list-item-block";
        list.appendChild(holder);
        holder.appendChild(clone);
        wrap.appendChild(list);
      } else {
        wrap.appendChild(clone);
      }
    }
    ghost.replaceChildren(wrap);
    ghost.style.width = r.width + "px";
    ghost.hidden = false;
    ghost.style.transform = `translate(${e.clientX - grab.x}px, ${e.clientY - grab.y}px)`;

    // 源块盖白蒙版表示「变淡」：多选时逐块盖，单个包围盒会在块之间的空隙也盖一层
    for (const d of dims) d.remove();
    dims = rects.map((x) => {
      const d = document.createElement("div");
      d.className = "mk-dim";
      d.style.cssText = `left:${x.left}px;top:${x.top}px;width:${x.width}px;height:${x.height}px`;
      document.body.appendChild(d);
      return d;
    });

    // 不能只 setDragImage(noDrag)：plugin-block 自己在 handle 上（目标阶段、更晚）
    // 也会调一次 setDragImage(activeEl)，会把占位覆盖回去 → 原生影像和自绘幽灵同时出现。
    // 正解是在捕获阶段把方法整个换掉，谁调都只拿到那个 1×1 占位。
    const dt = e.dataTransfer;
    const orig = dt.setDragImage.bind(dt);
    dt.setDragImage = () => orig(noDrag, 0, 0);
    setTimeout(() => { delete dt.setDragImage; }, 0);
  };

  // 落点：指针在那块的上半 / 下半 → 插到之前 / 之后
  const dropTargetAt = (x, y) => {
    const view = getView?.();
    if (!view) return null;
    // 先按「正文块的实际上下边界」判断：.ProseMirror 底部有 120px 下内边距，
    // 指针落在那圈空白里时 posAtCoords 会给出莫名其妙的邻近位置
    // （实测整组拖到底部会算成「原地不动」）
    let last = null;
    view.state.doc.forEach((_n, off) => { last = off; });
    if (last == null) return null;
    const lastRect = view.nodeDOM(last)?.getBoundingClientRect?.();
    if (lastRect && y > lastRect.bottom) return last + view.state.doc.nodeAt(last).nodeSize;
    const firstRect = view.nodeDOM(0)?.getBoundingClientRect?.();
    if (firstRect && y < firstRect.top) return 0;
    /* 指针在某个列表项上 → 落点按**这一条**算（上半插前、下半插后）。
       放在顶层块解析之前：它俩算的是完全不同粒度的位置，混用必错。 */
    const item = listItemRangeAt(view, x, y);
    if (item) {
      const ir = view.nodeDOM(item.from)?.getBoundingClientRect?.();
      const below = ir ? y > ir.top + ir.height / 2 : false;
      return below ? item.to : item.from;
    }
    const at = view.posAtCoords({ left: x, top: y });
    if (!at) return null;
    const $p = view.state.doc.resolve(at.inside > -1 ? at.inside : at.pos);
    if ($p.depth === 0) {
      // 落在块与块之间的空隙 / 正文上下方：取两侧最近的顶层块，光标在它下半就插到它之后。
      // 直接返回 null 的话，把手松在行间（最常见的落点）就完全搬不动
      let near = null;
      view.state.doc.forEach((node, off) => { if (off <= $p.pos) near = off; });
      if (near == null) return null;
      const n = view.state.doc.nodeAt(near);
      const rc = view.nodeDOM(near)?.getBoundingClientRect?.();
      return rc && y <= rc.top + rc.height / 2 ? near : near + n.nodeSize;
    }
    let d = 1;
    while (d < $p.depth && $p.node(d - 1).type.name !== "doc") d++;
    const pos = $p.before(d);
    const node = view.state.doc.nodeAt(pos);
    if (!node) return null;
    const r = view.nodeDOM(pos)?.getBoundingClientRect?.();
    const after = r ? y > r.top + r.height / 2 : false;
    return after ? pos + node.nodeSize : pos;
  };

  const onDragOver = (e) => {
    if (ghost.hidden) return;
    ghost.style.transform = `translate(${e.clientX - grab.x}px, ${e.clientY - grab.y}px)`;
    // 落点指示交给 crepe 自带的 .crepe-drop-cursor，不再自己画一条（两条线看着像重复功能）
    if (!drag) return;
    dropPos = dropTargetAt(e.clientX, e.clientY);
  };

  // 整组搬走的是我们自己 preventDefault 掉的 drop，Milkdown 的落点线没人收，
  // 会留一条横线在文档里（图片 2 那个现象）
  const hideDropCursor = () => {
    const kill = () => document.querySelectorAll(".crepe-drop-cursor, .milkdown-drop-indicator")
      .forEach((el) => { el.style.display = "none"; });
    kill();
    setTimeout(kill, 60);
    setTimeout(kill, 300);
  };

  const onEnd = () => {
    ghost.hidden = true; ghost.replaceChildren();
    for (const d of dims) d.remove();
    dims = [];
    hideDropCursor();
  };

  // 搬：切下拖动的区间，插到落点（落点在自己区间之后时要先扣掉被切掉的宽度）
  const applyMove = (pos) => {
    const view = getView?.();
    if (!view || !drag) return false;
    let target = pos;
    if (target >= drag.to) target -= drag.size;
    else if (target > drag.from) return false;        // 落在自己区间里 = 没动

    /* 列表项被拖到**列表之外**时要把内容摊平成普通段落，不能直接插 list_item。
       直接插会产出 `1) 甲` 这种游离在正文里的畸形标记 —— 实测过一次，
       存盘就是坏 Markdown。摊平就是 PM 里 liftListItem 的效果：
       把 listItem 的子块（通常是 paragraph）原样放到目标位置。

       ⚠️ 必须用 `tr.doc` 判、且在 delete **之后**判：
       target 已经按「切掉 drag.size」扣减过了，拿它去问**删除前**的 doc 会问错地方
       （实测：拖到正文末尾本该摊平，却因为原文档里那个偏移量恰好落在最后一个
       列表项内部，被误判成「还在列表里」，于是插出一个游离的 `1) 甲`）。 */
    const tr = view.state.tr.delete(drag.from, drag.to);
    const slice = (drag.item && !isInsideList(tr.doc, target))
      ? new Slice(Fragment.from(drag.item.node.content), 0, 0)
      : drag.slice;
    // replaceRange 而不是 insert：slice 里可能是多个块（openStart/openEnd = 0），
    // insert 只接受单个节点，会抛 "Can not convert … to a Fragment"
    tr.replaceRange(target, target, slice);
    tr.setSelection(NodeSelection.create(tr.doc, target, target + slice.size));
    view.dispatch(tr.scrollIntoView());
    view.focus();
    groupMoved = true;
    return true;
  };

  // 落地后把落点所在的块设成 NodeSelection —— 视觉上是「行背景高亮」，工具条不弹。
  // 必须放 dragend：drop 时 ProseMirror 的落点 transaction 还没应用完，会被它覆盖。
  const selectLandedBlock = (x, y) => {
    const view = getView?.();
    if (!view) return;
    try {
      const at = view.posAtCoords({ left: x, top: y });
      if (!at) return;
      const $p = view.state.doc.resolve(at.inside > -1 ? at.inside : at.pos);
      let d = 1;
      while (d < $p.depth && $p.node(d - 1).type.name !== "doc") d++;
      view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, $p.before(d))));
      view.focus();
    } catch { /* 落点不在可选块里就算了 */ }
  };

  const onDrop = (e) => {
    // 锁定只读：没有 drag 就没有搬运，但 drop 仍可能由外部文件拖进来 —— 一样挡掉。
    if (editorLock) { e.preventDefault(); e.stopPropagation(); drag = null; return; }
    lastDrop = { x: e.clientX, y: e.clientY };
    if (drag) {
      // 自己搬：别让 Milkdown 插手（它只会挪把手底下那一块，还会把代码块塞进列表）
      e.preventDefault();
      e.stopPropagation();
      if (dropPos != null) applyMove(dropPos);
      drag = null;
    }
    onEnd();
  };

  const onDragEnd = (e) => {
    const d = lastDrop || { x: e.clientX, y: e.clientY };
    lastDrop = null;
    onEnd();
    if (groupMoved) { drag = null; groupMoved = false; return; }
    drag = null;
    selectLandedBlock(d.x, d.y);
  };

  /* 调试钩子（和 window.__blanc 一个性质）：用**屏幕坐标**跑一遍
     listItemRangeAt → dropTargetAt → applyMove，返回实际搬的区间和落点。

     为什么需要它：CDP 的 Input.dispatchDragEvent **发不出 dragstart**，
     scripts/cdp.mjs 的 draghtml 也明说了只能验落点那一半。所以列表项拖动
     这类功能在自动化里没法端到端点一次，靠这个钩子能验到真正的搬运逻辑。

     用法（浏览器控制台）：
       __blancDrag(x1, y1, x2, y2)   // 从 (x1,y1) 的列表项拖到 (x2,y2)
     坐标取 .milkdown-list-item-block 的 getBoundingClientRect()。
     已在用的一例：见 STATUS 里「列表项拖动排序」那条。 */
  window.__blancDrag = (sx, sy, dx, dy) => {
    const view = getView?.();
    if (!view) return "没有 view";
    const item = listItemRangeAt(view, sx, sy);
    if (!item) return "源不在列表项上";
    const before = view.state.doc;
    drag = { from: item.from, to: item.to, size: item.to - item.from,
             slice: before.slice(item.from, item.to), item };
    const pos = dropTargetAt(dx, dy);
    const ok = applyMove(pos);
    const out = { 源: item.node.textContent, 源区间: [item.from, item.to], 落点: pos, 成功: ok };
    drag = null;
    return out;
  };

  root.addEventListener("mousedown", onPress, true);
  document.addEventListener("dragstart", onDragStart, true);
  document.addEventListener("dragover", onDragOver, true);
  document.addEventListener("drop", onDrop, true);
  document.addEventListener("dragend", onDragEnd, true);
  return () => {
    root.removeEventListener("mousedown", onPress, true);
    document.removeEventListener("dragstart", onDragStart, true);
    document.removeEventListener("dragover", onDragOver, true);
    document.removeEventListener("drop", onDrop, true);
    document.removeEventListener("dragend", onDragEnd, true);
    ghost.remove(); dim.remove(); noDrag.remove();
    // HMR / 重新挂载时别把上一份闭包留在 window 上（getView 会指向已销毁的 view）
    if (window.__blancDrag) { delete window.__blancDrag; }
  };
}

// ===== 多选块：把一串块「框」成一体（BlockNote 那套）=====
// 实现要点：
// - ProseMirror 的 NodeSelection.create 只认一个位置（内部就是 `new NodeSelection($pos)`），
//   造不出跨块选区；跨块得用 TextSelection 从首块开头拉到末块末尾。
// - 「框」用 decoration 画：凡是选区完整盖住的顶层块逐块挂 .mk-bs（纯 CSS 描边），
//   所以普通鼠标划选也会给整段块加框，和 Notion 的观感一致。
// - 入口：Option/Alt + 点块正文，或 Shift/Cmd/Ctrl + 点块把手（⠿）。
//   锚点留在第一次点的那块，连点几个就是一段连续区间；点在区间内 = 把那块摘掉。
// - 框住 >=2 块时给 .ProseMirror 挂 .mk-multi，藏掉 crepe 的文字格式工具条。
// 只有我们自己发起的框选才算「块框选」：Cmd+A、鼠标划字这些普通文本选区不该把整块框起来。
// 标记记在模块变量里而不是 PM 的插件 state：Milkdown 会在 feature 异步加载完后重建
// EditorState，插件的 init() 一跑标记就丢了（实测框选完立刻掉框）。
// 用「当前选区必须和记下的 range 完全一致」来判断，用户改了选区自然就不算框选了。
const BLOCK_SEL = "mk-block-select";
/* 锁定只读。两个模块级的东西：
   - editorLock 是标志位。模块级而不是 prop/闭包，是因为 installBlockSelect /
     installDragGhost 那几个监听器挂在 window/root 上、挂载时就把闭包定死了，
     读不到之后的 prop。和 blockSel 同一个理由。
   - applyLock 真正落下去：editable=false 让 PM 自己挡掉输入、粘贴和大部分删除。
     但它**挡不住 PM 之外的三条**：块拖动、整组删除、标题栏那个 h1，
     那三条各自去读 editorLock。
   锁的范围 = 一切会改文档的动作。不锁的：滚动、划词、⌘A 选中、复制、查找高亮。 */
let editorLock = false;

function applyLock(crepe, ro) {
  editorLock = !!ro;
  if (!crepe) return;   // 还没 create 完，初始那次由 create().then() 里补上
  try {
    const view = crepe.editor.ctx.get(editorViewCtx);
    /* 必须走 view.setProps，**不能** ctx.update(editorViewOptionsCtx)。
     * 那个 slice 只在 `new EditorView(el, { ...options })` 那一刻被读一次
     * （@milkdown/core/src/internal-plugin/editor-view.ts:127），view 建好之后
     * 再 update 这个 slice，对活着的 view 一点影响都没有 —— 表现就是
     * 「开关拨了、editable 没变、正文照样能打字」。
     * editable 给函数而不是布尔：PM 每次问都现读 editorLock，
     * 不用每次切换都记得重新 set 一遍。 */
    view?.setProps({ editable: () => !editorLock });
  } catch {
    // ctx 还没准备好（切文档的间隙）。下一次 readOnly 变化会再落一次。
  }
}
// 我们自己设的跨块选区：mode="block" 记精确区间（空白拖出来的框选），
// mode="all" 记「从头选到尾」（Cmd+A）。后者不记精确位置 —— 尾部空块会被 Milkdown 的
// trailing 插件删掉，位置一变就匹配不上，框会莫名其妙消失（实测空块里 Cmd+A 框不出来）。
// 判断条件改成「还盖着第一个块和最后一个块」，中间随便变。
const blockSel = { mode: null, from: 0, to: 0 };
const isBlockSel = (state) => {
  const sel = state.selection;
  if (sel.empty || !blockSel.mode) return false;
  if (blockSel.mode === "block") return sel.from === blockSel.from && sel.to === blockSel.to;
  return sel.from <= 1 && sel.to >= state.doc.content.size - 2 && sel.to > sel.from;
};
const coveredBlocks = (view) => (isBlockSel(view.state) ? coveredBlocksOf(view.state) : []);

/* 框住 [a, b] 这几个顶层块（a/b 是「块前面那个位置」，不是块内位置）。
   提到模块级是因为 ⌘A 的第二段也要用 —— 它复制一份的话，blockSel.from/to
   这套位置账就得分成两份，迟早对不上（那套账错一次的直接后果是块框选时有时无）。 */
const setRange = (view, a, b, focus = true) => {
  const last = view.state.doc.nodeAt(b);
  if (!last) return;
  /* ⚠️ blockSel 要**先写再 dispatch**，不能反过来。
     块框那个 .mk-bs 框是 decoration 插件画的，插件在事务进 view 的那一刻
     就读 isBlockSel(state) 算装饰集 —— 账还没写就 dispatch，算出来是
     「没有块选中」，之后没有任何事务再来触发重算，框就一直不出现。
     oneBlock（清账）和 allBlocks（记 all）都是先写后 dispatch，就这个顺序。 */
  blockSel.mode = "block";
  blockSel.from = a + 1;
  blockSel.to = b + last.nodeSize - 1;
  view.dispatch(view.state.tr
    .setSelection(TextSelection.create(view.state.doc, a + 1, b + last.nodeSize - 1))
    .setMeta("addToHistory", false)   // 框选不进撤销栈，只有真的挪动/删除才该撤销
    .setMeta(BLOCK_SEL, true));
  if (focus) view.focus();
};

const coveredBlocksOf = (state) => {
  const sel = state.selection;
  if (sel.empty) return [];
  const out = [];
  state.doc.forEach((node, offset) => {
    if (sel.from <= offset + 1 && sel.to >= offset + node.nodeSize - 1) out.push(offset);
  });
  return out;
};

/* ===== 页内查找与替换（#4）=====
   一个浮在编辑区右上角的框：上面一行输入关键字，下面一行（⌘R / 切换时）输入替换成什么。
   命中用 **decoration** 画，不用 TextSelection 真选中 —— 块框选（.mk-bs）是靠
   isBlockSel(state) 判断的，而它读的就是 state.selection；真选中一变框就没了。
   这也是「查找」和「自由框选」能同时存在的前提。

   扫描范围只到 textblock（段落 / 标题 / 列表项 / 代码块），逐块 textContent 里
   indexOf。块内 position = pos+1+i —— textblock 的内容全是 inline，
   textContent 的第 i 个字符就是 pos+1+i，这个映射对嵌套 inline（粗体、链接）也成立。 */
const FIND_KEY = new PluginKey("mk-find");

const scanHits = (doc, q) => {
  const out = [];
  if (!q) return out;
  const needle = q.toLowerCase();
  const step = needle.length;
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const hay = node.textContent.toLowerCase();
    if (!hay) return false;
    let i = hay.indexOf(needle);
    while (i !== -1) {
      out.push({ from: pos + 1 + i, to: pos + 1 + i + q.length });
      i = hay.indexOf(needle, i + step);
    }
    return false;   // textblock 内部只有 inline，别往里再走
  });
  return out;
};

const emptyFind = { q: "", replace: "", idx: 0, hits: [] };

/* 插件每次事务后把最新状态推给 React。
   为什么必须这样：查找框的输入框是**受控**的（value 来自这份镜像）。
   打字走的是「派一条只有 meta 的事务」，docChanged 是 false、EditorPane 的
   state 一个都没动 —— **不会触发任何重渲染**。镜像只在 [view, open, mode] 上取，
   于是 value 永远是打开那一刻的空串，任何一次别的重渲染都会把用户敲的字抹掉，
   表现就是「框出来了但打不进字」。 */
let findStateSink = null;

const findPlugin = $prose(() => new Plugin({
  key: FIND_KEY,
  view() {
    return { update: (v) => findStateSink?.(FIND_KEY.getState(v.state)) };
  },
  state: {
    init: () => emptyFind,
    apply(tr, old) {
      const meta = tr.getMeta(FIND_KEY);
      if (meta) {
        const q = meta.q ?? old.q;
        // 只有「查询词或文档变了」才值得重扫。翻上一个/下一个只带 idx，
        // 位置一个都没动，每点一下都全文扫一遍纯属浪费（大文档上很明显）。
        const hits = (tr.docChanged || q !== old.q) ? scanHits(tr.doc, q) : old.hits;
        return {
          q,
          replace: meta.replace ?? old.replace,
          hits,
          /* meta.idx 是「上一个/下一个」派进来的，必须优先用它。
             早先这里只写 `old.idx`，把 meta.idx 整个丢了 —— 上一个/下一个
             点了没反应，而命中计数和 .cur 高亮也永远停在第 1 条。
             没传 idx 时（打字、关闭清空）才沿用旧的，并夹进 hits 的范围，
             免得替换后命中数变少、索引越界。 */
          idx: Math.max(0, Math.min(meta.idx ?? old.idx, hits.length - 1)),
        };
      }
      // 没有 meta 但文档变了（打字、撤销、替换后重算）→ 重扫，位置刷新
      if (tr.docChanged && old.q) {
        const hits = scanHits(tr.doc, old.q);
        return { ...old, hits, idx: Math.max(0, Math.min(old.idx, hits.length - 1)) };
      }
      return old;
    },
  },
  props: {
    decorations(state) {
      const f = FIND_KEY.getState(state);
      if (!f || !f.hits.length) return null;
      return DecorationSet.create(state.doc, f.hits.map((h, i) =>
        Decoration.inline(h.from, h.to, { class: "mk-find-hit" + (i === f.idx ? " cur" : "") })));
    },
  },
}));

// 面板和插件之间的桥：派发一条带 meta 的空事务改查询词。
const setFind = (view, patch) => view.dispatch(view.state.tr.setMeta(FIND_KEY, patch));
const getFind = (view) => { try { return FIND_KEY.getState(view.state); } catch { return emptyFind; } };

const blockFramePlugin = $prose(() => new Plugin({
  view(view) {
    // 工具条挂在 .milkdown 根上、不在 .ProseMirror 里，所以 class 要挂到 .mk-host 上
    const host = view.dom.closest(".mk-host") || view.dom;
    const sync = () => {
      const n = isBlockSel(view.state) ? coveredBlocksOf(view.state).length : 0;
      host.classList.toggle("mk-framesel", n >= 1);   // 有块被框住
      host.classList.toggle("mk-multi", n >= 2);      // 框住多块：藏掉文字格式工具条
    };
    sync();
    return { update: sync };
  },
  props: {
    decorations(state) {
      if (!isBlockSel(state)) return null;   // 普通文本选区（Cmd+A / 划字）不套框
      return DecorationSet.create(state.doc, coveredBlocksOf(state).map(
        (offset) => Decoration.node(offset, offset + state.doc.nodeAt(offset).nodeSize, { class: "mk-bs" }),
      ));
    },
  },
}));

// 正文列左侧这条空白带（把手就悬在这里）：hover 显把手、按住拖 = 框选一块区域
const HANDLE_ZONE = 112;

function installBlockSelect(root, getView) {
  // 「空白」= 编辑器范围内、但不落在正文（.ProseMirror）里的点：正文左侧那条带、
  // 右侧留白、正文上下方的空地。按下这些地方就能拉框选。
  const isBlank = (view, x, y) => {
    const box = root.closest(".editor-scroll")?.getBoundingClientRect() ?? view.dom.getBoundingClientRect();
    if (x < box.left || x > box.right || y < box.top || y > box.bottom) return false;
    const el = document.elementFromPoint(x, y);
    if (!el) return true;
    if (!view.dom.contains(el)) return true;            // 正文之外（左右留白、正文上下）
    // 正文之内：不在任何一块的矩形里 = 块间空隙，也是空白
    const block = el.closest(".ProseMirror > *") || el;
    const parts = block.querySelectorAll("p,h1,h2,h3,h4,h5,h6,ul,ol,li,pre,blockquote,table,img");
    // 整块就是一段文字（标题、纯文本段落，里面没有子元素）：命中即文字，不是空白。
    // 不判这一条的话，点标题会被当成空白拦掉 → 光标没落进去，Cmd+A 选的还是上一处
    if (!parts.length) return false;
    for (const k of parts) {
      const r = k.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return false;
    }
    return true;
  };
  // 左侧那条带额外放宽一点：把手就在那儿，hover 得能显形
  const inZone = (view, x, y) => {
    if (isBlank(view, x, y)) return true;
    const r = view.dom.getBoundingClientRect();
    return x < r.left && x >= r.left - HANDLE_ZONE && y >= r.top && y <= r.bottom;
  };
  // 指针在空白处：把 y 换算成正文列里的位置来定位块
  const blockPosAtY = (view, y) => {
    const r = view.dom.getBoundingClientRect();
    const raw = blockPosAt(view, r.left + Math.min(20, r.width / 2), y);
    // raw 可能是 doc.content.size（正文下方的空白），那不是块起点，要认一下
    if (raw != null && view.state.doc.nodeAt(raw)) return raw;
    // y 在正文上方/下方：posAtCoords 给不出位置，按方向夹到第一块 / 最后一块
    let last = null;
    view.state.doc.forEach((_n, off) => { last = off; });
    if (last == null) return null;
    const firstRect = view.nodeDOM(0)?.getBoundingClientRect?.();
    if (firstRect && y < firstRect.top) return 0;
    return last;
  };

  // hover 空白带 → 合成一个 pointermove 给 ProseMirror，否则把手不显形。
  // 原因：Milkdown 的把手靠插件的 mousemove 触发，而那个监听挂在 .ProseMirror 上，
  // 空白带属于 .editor-pad 的 padding，事件根本到不了编辑器（实测：指针在正文列左侧
  // 90px 内移动，把手一直是隐藏的）
  let lastSynth = 0;
  // 把手就在正文左侧那条空白上：只要它在，空白就没法起框选。办法是「指针不在把手上时
  // 把按钮的命中关掉」—— 把手的视觉位置不动（不加 margin），只有指针真的压到把手上
  // 才让 ＋ / ⠿ 接事件。
  const handleUnder = (x, y) => {
    const h = root.querySelector(".milkdown-block-handle");
    if (!h || !h.offsetParent) return false;
    const r = h.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };

  const onZoneHover = (e) => {
    if (band) { root.classList.add("mk-handle-ghost"); return; }   // 正在框选，别把把手叫出来
    if (!e.target.closest?.(".ProseMirror") && e.target.closest?.("[contenteditable='true']")) return; // 标题栏：让给浏览器
    if (e.target.closest?.(".ProseMirror")) return;          // 正文里正常，不用管
    if (e.target.closest?.(".milkdown-block-handle .operation-item")) return; // ＋ / ⠿ 本身不插手
    const view = getView?.();
    if (!view || !inZone(view, e.clientX, e.clientY)) {
      root.classList.remove("mk-handle-ghost");
      return;
    }
    root.classList.toggle("mk-handle-ghost", !handleUnder(e.clientX, e.clientY));
    const now = Date.now();
    if (now - lastSynth < 60) return;                       // 节流，别把编辑器刷爆
    lastSynth = now;
    // 注意类型是 pointermove 不是 mousemove：Milkdown 的把手插件监听的是
    // handleDOMEvents.pointermove，合成一个 MouseEvent 它根本收不到
    view.dom.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY,
      pointerType: "mouse", isPrimary: true,
    }));
  };

  // 空白带按住拖 = 框选：起点块 → 当前块，同时画一个跟手的框
  let band = null;
  let marquee = null;

  const showMarquee = (view, x0, y0, x, y) => {
    if (!marquee) {
      marquee = document.createElement("div");
      marquee.className = "mk-marquee";
      document.body.appendChild(marquee);
    }
    // 自由矩形：按下点到当前点的包围盒（横向不再铺满，从正文左侧起拖就是一条窄框）
    const left = Math.min(x0, x), right = Math.max(x0, x);
    const top = Math.min(y0, y), bottom = Math.max(y0, y);
    marquee.style.cssText =
      `left:${left}px;top:${top}px;` +
      `width:${Math.max(2, right - left)}px;height:${Math.max(2, bottom - top)}px`;
  };

  const hideMarquee = (host) => {
    marquee?.remove(); marquee = null;
    host?.classList.remove("mk-marquee-drag");
  };

  const onZoneDown = (e) => {
    // 锁定只读：框选本身不改文档，但它是块拖动和整组删除的入口 ——
    // 只读时连框选一起断掉，免得用户框了一组才发现删不掉。
    if (editorLock) return;
    if (e.button !== 0 || e.altKey || e.shiftKey || e.metaKey || e.ctrlKey) return;
    const view = getView?.();
    if (!view) return;
    // 顶部标题栏（可编辑的 h1）也在 .editor-scroll 里，空白判定会把它吃掉 →
    // 点标题进不了编辑态。只放行**编辑器之外**的可编辑元素：
    // .ProseMirror 自己也是 contenteditable，一并放行的话上下空白就拖不动了
    const ce = e.target.closest?.("[contenteditable='true']");
    if (ce && !view.dom.contains(ce)) return;
    /* ⚠️ 上一条只放行 contentEditable —— **输入框不是**。
       而 onZoneDown 挂在 `.editor-scroll` 上（`.mk-host` 的父级），属性头、标题区
       这些面板**也在这个容器里**，它们所在的位置对 `isBlank()` 来说就是「正文上方的空白」。
       于是点属性值输入框时：ce 为 null → 判到空白 → `preventDefault()` →
       浏览器不再把焦点交给输入框。表现是**属性值打不进字、改名框点不亮**，
       而标签那个能填 —— 只因为它有 autoFocus，压根不靠点击拿焦点。
       这里要把面板整体划出去：面板上的任何按下都该留给控件自己。 */
    if (e.target.closest?.(".props, .doc-head, .find-box")) return;
    // ＋ / ⠿ 本身就悬在空白带上，按它们要留给新增和拖拽，别当成框选起点。
    // 只认这两个按钮本身：把手容器有 66px 宽且盖在空白带上，判太宽会连空白一起吃掉。
    if (e.target.closest?.(".milkdown-block-handle .operation-item")) return;
    // 代码块内保持原生文字选择：CodeMirror 自己的拖拽/选区更合适
    if (e.target.closest?.(".cm-editor")) return;
    // 表格同理：在单元格里（行 / 单元格）点击拖动要能选单元格，不能变成框行
    if (e.target.closest?.("table, td, th, tr, .milkdown-table, .tableWrapper")) return;
    // 只有空白处才起框。内容行（文字/代码/表格）上按下要留给编辑器：
    // 点击 = 光标落在点中的那个字符（之前会把光标顶到块首），拖动 = 正常划选文字。
    // 框选只从正文左侧/右侧留白、正文上下方这些空白发起。
    if (!isBlank(view, e.clientX, e.clientY)) return;
    const pos = blockPosAtY(view, e.clientY);
    if (pos == null || !view.state.doc.nodeAt(pos)) return;
    e.preventDefault();
    e.stopPropagation();
    band = { anchor: pos, last: null, x0: e.clientX, y0: e.clientY, host: root, clickX: e.clientX, clickY: e.clientY };
    root.classList.add("mk-marquee-drag");   // 拖框期间藏把手（Milkdown 自己不会收）
    showMarquee(view, e.clientX, e.clientY, e.clientX, e.clientY);
  };

  // 指针回到正文里 → 把手恢复正常交互
  const onEditorHover = (e) => {
    if (!e.target.closest?.(".ProseMirror")) return;
    if (!band) root.classList.remove("mk-handle-ghost");
  };

  const onZoneMove = (e) => {
    if (!band) return;
    if (e.type === "pointermove") e.stopPropagation();   // Milkdown 监听的是 pointermove
    if (e.type === "mousemove") e.stopPropagation();
    const view = getView?.();
    if (!view) return;
    showMarquee(view, band.x0, band.y0, e.clientX, e.clientY);
    const pos = blockPosAtY(view, e.clientY);
    if (pos == null || pos === band.last) return;
    band.last = pos;
    setRange(view, Math.min(band.anchor, pos), Math.max(band.anchor, pos), false);
  };

  const onZoneUp = () => {
    if (!band) return;
    const { host, anchor, last, clickX, clickY } = band;
    band = null;
    hideMarquee(host);
    const view = getView?.();
    if (!view) return;
    // 只是点了一下（没拖动）→ 光标落到点中的那个字符位置（和系统行为一致）
    if (last == null) {
      const at = view.posAtCoords({ left: clickX, top: clickY });
      if (at) {
        const $p = view.state.doc.resolve(at.inside > -1 ? at.inside : at.pos);
        view.dispatch(view.state.tr.setSelection(TextSelection.near($p)));
      } else {
        view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(anchor + 1))));
      }
      view.focus();
      return;
    }
    view.focus();
  };

  let handledAt = 0;
  const onDown = (e) => {
    // 锁定只读：Alt/Shift+点起的是块框选，后面接着就能拖、就能整组删。
    if (editorLock) return;
    // 只拦两种组合：Alt + 点块正文，或 Shift/Cmd/Ctrl + 点块把手。
    // 把手上**不带修饰键**的按下必须放行 —— 拦掉它 preventDefault 就不会触发原生拖拽，
    // 表现为「按着 ⠿ 拖不动块」。
    const onHandle = !!e.target.closest?.(".milkdown-block-handle");
    if (!e.altKey && !(onHandle && (e.shiftKey || e.metaKey || e.ctrlKey))) return;
    if (e.button !== 0) return;
    const view = getView?.();
    if (!view) return;
    const pos = blockPosAt(view, e.clientX, e.clientY);
    if (pos == null || !view.state.doc.nodeAt(pos)) return;
    e.preventDefault();
    e.stopPropagation();
    handledAt = Date.now();

    const picked = coveredBlocks(view);            // 当前被框住的块
    if (!picked.length) { setRange(view, pos, pos); return; }
    if (pos >= picked[0] && pos <= picked[picked.length - 1]) {
      // 点在框内 → 把这块摘掉：只剩一块时退化成光标
      if (picked.length === 1) { setRange(view, pos, pos); return; }
      if (pos > picked[0]) setRange(view, pos, picked[picked.length - 1]);
      else setRange(view, picked[1], picked[picked.length - 1]);
      return;
    }
    // 点在框外 → 从锚块扩到这块（锚块 = 第一次点的那块）
    setRange(view, Math.min(picked[0], pos), Math.max(picked[0], pos));
  };

  // 只拦 mousedown 不够：ProseMirror 在随后的 click 里还会按坐标再设一次选区，
  // 把刚设好的跨块选区覆盖成「光标落在那一个块上」。这一下的 click 一并吃掉。
  const onClick = (e) => {
    if (Date.now() - handledAt > 800) return;
    e.preventDefault();
    e.stopPropagation();
  };

  root.addEventListener("mousedown", onDown, true);
  root.addEventListener("click", onClick, true);
  // 空白带属于 .editor-pad 的 padding，而 .mk-host 在 .editor-pad **里面**，
  // 挂在 root 上的捕获监听收不到指向父元素 padding 的事件 —— 挂到滚动容器上
  const zoneRoot = root.closest(".editor-scroll") || root.parentElement || root;
  zoneRoot.addEventListener("mousemove", onZoneHover, true);
  zoneRoot.addEventListener("mousedown", onZoneDown, true);
  zoneRoot.addEventListener("pointermove", onEditorHover, true);
  document.addEventListener("mousemove", onZoneMove, true);
  document.addEventListener("mouseup", onZoneUp, true);
  return () => {
    root.removeEventListener("mousedown", onDown, true);
    root.removeEventListener("click", onClick, true);
    zoneRoot.removeEventListener("mousemove", onZoneHover, true);
    zoneRoot.removeEventListener("mousedown", onZoneDown, true);
    zoneRoot.removeEventListener("pointermove", onEditorHover, true);
    document.removeEventListener("mousemove", onZoneMove, true);
    document.removeEventListener("mouseup", onZoneUp, true);
  };
}
