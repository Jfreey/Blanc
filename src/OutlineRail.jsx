import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

/* 导航条：右侧一条细轨，每条横线代表一个标题。所有线一样粗（2px），
 * 只有长度按层级递减。点线 = 快捷滚到那个标题。
 * 大纲面板默认和它**重叠、都贴这个容器的顶端**，鼠标进导航条 → 导航条淡出、
 * 面板淡入；鼠标离开 → 反过来。
 * 两个开关（顶栏三点菜单里）：showRail 管导航条，showOutline 管大纲面板，
 * 互不依赖 —— 只留导航条时 hover 不弹面板，刻度线直接可点。
 * 两个都关则整块不渲染。
 * 没有标题时整个组件不渲染 —— 空轨道只会让人以为坏了。
 *
 * 槽位是**固定步进**的（2px 线 + 10px 缝 = 12px 一格，从轨道顶端往下排）：
 *   · 固定步进 = 一把等分的尺子，扫一眼就知道有几条、疏密一致
 *   · 和大纲面板对齐：面板也是从顶端铺开，两边第一条都在同一高度
 * 条目多到 12px×N 撑不下轨道时才退回「压满」，宁可缝隙变小也不让最后一条掉出去。
 * 早先试过「高度 ∝ 该章节的文档长度」（长章节留白多，能看出内容多少），
 * 但那是刻度尺的思路：这份东西的用途是**索引**不是比例尺，等距更好认。
 *
 * ⚠️ offsetTop 只在「文档变了 / 容器尺寸变了」时重算。滚动时**绝不**读
 * getBoundingClientRect —— 那是强制回流，长文档每帧一次直接掉帧。
 * 滚动帧只扫缓存下来的 tops 数组。
 */

/* 层级 → 线宽。一档 34 和 --olr-lw-max 对齐（当前项就是加长到那一档），
   CSS 那边也声明了一份 —— 改一处必须同步改另一处。 */
const LW = [34, 24, 16, 10, 10, 10];
/* 刻度线的**粗细**，和 CSS 的 --olr-lh 一致（那边也是 2px，改一处改两处）。
   一格的步进 = 线粗 + 缝，所以这两个数要一起算，不能只改其中一个。 */
const LH = 2;
const GAP = 10;
/* 槽位排布的两种模式：
   ① 首选：固定步进（线 2px + 缝 10px = 12px 一格），从顶端往下排。
      这样刻度是个**等间距的尺子**，扫一眼就知道有几条、均匀分布。
   ② 条目太多、12px × N 超出轨道高度时，退回「压满」：每格均分可用高度，
      保证最后一条还在轨道内。此时缝隙会小于 10px，但宁可密也不丢。 */
const SLOT_FIXED = LH + GAP;
// 轨道上下留白。必须由 JS 参与算，不能靠 CSS padding：
// tick 是 position:absolute，绝对定位的盒子相对**padding box** 定位，
// padding 对它完全无效 —— 之前 .olr-rail 写了 padding: 14px，首线到顶仍只有 9px。
const PAD_TB = 14;
/* 「当前是哪个标题」：拿一条**阅读线**判 —— 视口里从上往下 20% 那条水平线，
   取这条线上方最后一个标题。
   ⚠️ 原来这条线固定在「视口顶 + 24px」，也就是标题必须**顶到视口最上沿**才点亮。
   那是错的，用户报「在所在位置的 head 文字，但导航条并没有准确的 active」：
     · 标题自带 32~48px 上边距，滚到「标题刚露头、正文正在读」这种最常见的位置，
       它的顶还在阅读线**下面**，导航条指着上一节；
     · 文末必错 —— 实测 st 到 3782（到底）、末节标题 top=3880，也就是压在视口顶
       下面 98px，整条轨停在倒数第二节，怎么滚都点不亮。
   20% + 上下限是折中：视口越高越靠近「标题进入视口上四分之一就算数」，
   小窗口不至于因为比例太小而退化成原来的行为。 */
const CUR_LINE_RATIO = 0.2;
const CUR_LINE_MIN = 64;
const CUR_LINE_MAX = 160;
/** 阅读线离视口顶的高度（不含 scrollTop）。
    判定 active 和 jump 定位必须共用这一个 —— 否则「点某一格跳过去」之后，
    那一格未必是 active（跳到顶沿 vs 跳到阅读线，两处各写各的必然对不上）。 */
const lineOffset = (sc) =>
  Math.max(CUR_LINE_MIN, Math.min(CUR_LINE_MAX, sc.clientHeight * CUR_LINE_RATIO));
/** 判定线的容差（px）。
    ⚠️ 没有它就是「跳过去了却不亮」那个 bug 的全部原因（2026-10-18 用户报）：
    jump 要滚到 `tops[k] - lineOffset`，判定又要看 `tops[k] <= scrollTop + lineOffset`
    —— 看着是同一个式子，实际浏览器的 scrollTop 是**取整**过的
    （实测目标 394、落点 393），判定线因此差 1px 落在标题上面，那一格永远不亮。
    这 1px 还不是必现的（有时正好落上），所以表现为「有时跳过去不亮，有时亮」。
    容差取 2px：够吃掉取整误差，又比标题上边距小两个数量级，不改变判定语义。 */
const CUR_EPS = 2;

/* ===== 迷你模式（2026-10-16 用户要的第二种模式）=====
 *
 * 完整模式：一条占 50% 屏高的刻度轨 + hover 弹完整大纲。
 * 迷你模式：一条**很短**的轨（--olr-mini-h，默认 150px），但它映射的仍然是
 * 整篇 —— 「很短」说的是条子本身，不是它代表的范围。
 *
 * 交互（用户 2026-10-16 定的）：
 *   · 鼠标移到某条 → 那条变成**波峰**（最长最深），向上下按高斯衰减成波浪
 *   · 同时左侧弹出**片段预览**：标题 + 该标题下的第一行正文
 *     （不是完整大纲 —— 完整大纲已经在完整模式里了，这里再来一份就是重复）
 *   · 鼠标移出 → 波峰收回、预览消失
 *   · 点条子仍然跳转（和完整模式一样）
 */
/* 波峰宽度和基线宽度。基线刻意很短：迷你模式里刻度只是「位置提示」，
   让人知道大概在哪一篇，不该抢正文的视线。 */
const MW_BASE = 8;
const MW_MAX = 24;
/* 迷你轨里一格的最大步进（见 mSlots）。封顶的作用和完整模式的 SLOT_FIXED
   一样：条目少的时候别把它们摊到整条轨上。24px 一格 → 5 条以内都保持紧凑，
   6 条以上自然铺满，不会有「2 条线孤零零挂在半空」这种稀疏感。
   ⚠️ 24 → 16（2026-10-18 用户报「迷你模式的 item 能不能稍微紧凑点」）：
   24 是当初按「5 条以内紧凑」定的，可那条经验来自条目更少的时候；6~7 条的
   文档正好卡在封顶上，122px 被 6 条均分成 20px 一格，看着已经散成一小撮。
   16px 一格 → 6 条占 96px（原来 122px），差距一眼能看出来又不至于挤成一片。
   只影响**条目少**的场合：want 一旦小于 16 就是 n 变大，那条路由
   MINI_SLOT_MIN 抽样管着（见下），这个上限根本不参与。 */
const MSLOT_MAX = 16;
/* 迷你轨的**长度**是算出来的，不是写死的 150px（2026-10-18 用户报
   「内容很多时导航条挤在一起」）。
 *
 * 两头都要管，缺一头就出怪相：
 *   条目少 → 均分整条轨会散（2 条相隔 60px 挂半空），用 MSLOT_MAX 封顶
 *   条目多 → 122px 装 61 个标题就是 2px 一格，线本身 2px 直接糊成灰柱，
 *            所以轨要**跟着内容长**，但最多占编辑区 45%
 * 长到上限还装不下，才抽样（每 step 条取一条），保证每格 ≥ MINI_SLOT_MIN。
 * 这个值取 6px：2px 线 + 4px 缝，是「还能数出有几条」的下限。 */
const MINI_H_BASE = 150;
const MINI_SLOT_MIN = 6;
const MINI_H_MAX_RATIO = 0.45;
/* 高斯衰减的 σ。1.6 是试出来的：相邻一档还看得出短长更，3 档外基本回到基线，
   整条轨不会被拉成一块等长的板子 —— 那样就没有「波」了。 */
const MW_SIGMA = 1.6;

/* 取 [from, to) 之间第一个有字的 textblock 的文字，压成一行。
   跳过代码块：预览卡里塞一段代码读不出「这节讲什么」。 */
const firstLineBetween = (doc, from, to) => {
  let best = "";
  doc.nodesBetween(from, to, (node) => {
    if (best) return false;
    if (node.isTextblock && !node.type.spec.code) {
      const t = node.textContent.replace(/\s+/g, " ").trim();
      if (t) best = t;
      return false;          // 找到第一个有字的就停，不再往里钻
    }
    return true;
  });
  return best;
};

export default function OutlineRail({ view, scrollRef, showRail = true, showOutline = false, showMini = false }) {
  const [items, setItems] = useState([]);
  const [cur, setCur] = useState(-1);
  const [railH, setRailH] = useState(0);
  /* 迷你模式：鼠标停在第几条（-1 = 不在轨上）。峰跟鼠标走，预览也跟鼠标走。 */
  const [hover, setHover] = useState(-1);
  const railRef = useRef(null);
  const miniRef = useRef(null);
  const listRef = useRef(null);
  const topsRef = useRef([]);
  // items 的镜像。只给 measure 做「内容变没变」的对比用 —— 拿不到 state 里那份
  // （闭包会拿到旧值），自己存一份最新的。
  const itemsRef = useRef([]);

  /* 「当前是哪个标题」：扫缓存的 tops，取阅读线上方最后一个。
     滚动时调，**重测之后也调** —— tops 变了（比如在正文上方插入一个标题，
     后面全部平移）但用户没滚动，光靠 scroll 事件 cur 会停在旧的那一格。 */
  const syncCur = useCallback(() => {
    const sc = scrollRef.current;
    const tops = topsRef.current;
    if (!sc || !tops.length) return;
    const y = sc.scrollTop + lineOffset(sc) + CUR_EPS;
    let i = -1;
    for (let k = 0; k < tops.length; k++) { if (tops[k] <= y) i = k; else break; }
    /* 一个标题都没到（文档最上面那段：标题块 + 属性头 + 引言）时兜底点亮第一条。
       不兜底的话刚打开文档时整条轨全灰，看着像导航条没生效。 */
    setCur(i < 0 ? 0 : i);
  }, []);

  // 量一遍：从 ProseMirror doc 里收 heading，量每个 heading 的**文档坐标** top。
  // 一次性布局读，发生在文档变化时，不在滚动路径上。
  const measure = useCallback(() => {
    const sc = scrollRef.current;
    if (!view || !sc) return;
    const hs = [];
    view.state.doc.descendants((node, pos) => {
      if (node.type.name !== "heading") return true;
      const text = node.textContent.trim();
      /* 记下**标题节点的结束位置**。预览要从标题**之后**开始找正文 ——
         用 pos + 1 会从标题内部起步，nodesBetween 第一个碰到的就是标题自己，
         于是预览卡里显示的还是标题（实测就是这样）。 */
      if (text) hs.push({ pos, end: pos + node.nodeSize, text,
        level: Math.min(6, node.attrs.level || 1) });
      return true;
    });
    if (!hs.length) {
      if (itemsRef.current.length) { setItems([]); setCur(-1); }
      topsRef.current = [];
      itemsRef.current = [];
      return;
    }
    /* 第二遍：给每个标题配「它下面第一行正文」（迷你模式的预览卡要用）。
       必须在收完所有标题**之后**做 —— 搜索范围的上界是**下一个标题的位置**，
       边收边找会跨过下一节去取到别人的开头。 */
    {
      const d = view.state.doc;
      for (let i = 0; i < hs.length; i++) {
        const to = i + 1 < hs.length ? hs[i + 1].pos : d.content.size;
        hs[i].preview = firstLineBetween(d, hs[i].end, to);
      }
    }
    // 文档坐标：元素相对视口的 top 减去滚动容器自己的视口 top
    const base = sc.getBoundingClientRect().top - sc.scrollTop;
    for (const h of hs) {
      const dom = view.nodeDOM(h.pos);
      h.top = dom ? Math.max(0, dom.getBoundingClientRect().top - base) : 0;
    }
    topsRef.current = hs.map((h) => h.top);
    /* 内容没变就别 setState。measure 由 180ms 防抖驱动，但正文里打普通字
       （不改任何标题）一样会触发观察者，每次都塞一份新数组进 state 就是
       一次纯浪费的重渲染 + 两份列表（导航条 + 大纲）全量 diff。 */
    const prev = itemsRef.current;
    const same = prev.length === hs.length && prev.every((p, i) =>
      p.pos === hs[i].pos && p.text === hs[i].text && p.level === hs[i].level
      && p.preview === hs[i].preview);
    if (same) { syncCur(); return; }
    itemsRef.current = hs;
    setItems(hs);
    syncCur();
  }, [view, scrollRef, syncCur]);

  /* 文档变化 → 重测。这是大纲跟不跟得上的关键：
   *
   * 之前只有 ResizeObserver 盯着 .editor-scroll，那是 `flex:1` 的**滚动容器**，
   * 它自己的盒子尺寸恒定不变 —— 正文里加一个标题，容器一点没变大，观察器不响，
   * 导航条就停在旧的那几条上。窗口 resize 也只覆盖缩放，覆盖不了「内容变了」。
   *
   * 这里改成盯 **view.dom（ProseMirror 正文）**，走两条路：
   *   · MutationObserver —— 加标题 / 删标题 / 改标题文字 / 升降级都改 DOM 树，
   *     childList + characterData 全开着。它跟着 ProseMirror 的增量更新走，
   *     不用碰 markdown 序列化（那个每次击键都要跑一遍 remark，太贵）。
   *   · ResizeObserver —— 图片加载完、代码块渲染完、字体换完这类**不改 DOM 结构
   *     只改高度**的情况，MutationObserver 看不见，这个能补上。
   * 两者都过 later 的 180ms 防抖：击键时前者会连着响十几次。
   */
  useEffect(() => {
    if (!view?.dom) return;
    let t = null;
    const later = () => { clearTimeout(t); t = setTimeout(measure, 180); };
    measure();
    const dom = view.dom;
    const mo = new MutationObserver(later);
    mo.observe(dom, { childList: true, subtree: true, characterData: true });
    const ro = new ResizeObserver(later);
    ro.observe(dom);
    window.addEventListener("resize", later);
    return () => {
      clearTimeout(t);
      mo.disconnect(); ro.disconnect();
      window.removeEventListener("resize", later);
    };
  }, [view, measure]);

  // 轨道高度变了（窗口缩放 / 侧栏折叠 / 大纲常驻后轨道分到的比例变了）→ 槽位要重排。
  // 依赖 items.length 和 showRail 两个「railRef 会不会是 null」的原因：
  // 没有标题时组件 return null，railRef 一直是 null，挂不上观察者；
  // showRail 关掉时轨道整块不渲染，railRef 同样是 null。
  // 少了 showRail 会漏一种：菜单里把导航条打开、标题数量没变，这个 effect
  // 不会重跑，railH 停在关之前的值（甚至从没量过时的 0），槽位按 fallback 排。
  useEffect(() => {
    const el = railRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setRailH(el.clientHeight));
    ro.observe(el);
    setRailH(el.clientHeight);
    return () => ro.disconnect();
  }, [items.length, showRail]);

  // 滚动时只扫缓存（见 syncCur 的注释）
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const onScroll = () => syncCur();
    onScroll();
    sc.addEventListener("scroll", onScroll, { passive: true });
    return () => sc.removeEventListener("scroll", onScroll);
  }, [items.length, syncCur]);

  /* 槽位：线在槽内 y 居中。上下留白由 PAD_TB 扣出来
     （CSS padding 管不到绝对定位的 tick，见 PAD_TB 的注释）。
     优先固定步进 8px（2px 线 + 6px 缝）；条目多到 8px×N 撑不下时才压满轨道，
     保证最后一条不掉出去。 */
  const slots = useMemo(() => {
    const n = items.length;
    if (!n) return [];
    const avail = Math.max(0, (railH || 600) - PAD_TB * 2);
    const slot = n * SLOT_FIXED <= avail ? SLOT_FIXED : avail / n;
    return items.map((_, i) => ({ y: PAD_TB + i * slot, h: slot }));
  }, [items.length, railH]);

  /* 迷你轨高度现在由 JS 算（见下面 miniH 的公式），所以这里量的是**宿主的
     可用高度** —— 也就是编辑区本身。原来的 ResizeObserver 量的是轨自己，
     而轨高已经由我们决定了，那条路成了循环依赖。 */
  const [hostH, setHostH] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHostH(el.clientHeight));
    ro.observe(el);
    setHostH(el.clientHeight);
    return () => ro.disconnect();
  }, [items.length]);

  /* 迷你轨该有多长：够放就按内容算，放不下最多到编辑区的 45%。
     下限仍是 MINI_H_BASE（150px）—— 少条目时不该比原来更短。 */
  const miniH = useMemo(() => {
    const n = items.length;
    if (!n) return MINI_H_BASE;
    const host = hostH || 600;
    const maxH = Math.max(MINI_H_BASE, host * MINI_H_MAX_RATIO);
    const need = PAD_TB * 2 + n * MINI_SLOT_MIN;
    return Math.min(maxH, Math.max(MINI_H_BASE, need));
  }, [items.length, hostH]);

  /* 迷你模式的槽位。**不复用**完整模式那套「固定 12px 步进」：轨只有 ~150px 起，
     12px 一格最多放 12 条，再多全挤在一格。这里按可用高度排，放不下才抽样。

     ⚠️ 「均分」两头都要管（见 MSLOT_MAX / MINI_SLOT_MIN 的注释）：
       · 少条目 → 封顶 + 整组垂直居中，否则两条线孤零零挂在半空
       · 多条目 → 每 step 条取一条，保证每格 ≥ 6px 是能数出来的
     返回值带 idx —— 抽样之后 mSlots 的下标和 items 对不上了。 */
  const mSlots = useMemo(() => {
    const n = items.length;
    if (!n) return [];
    const avail = Math.max(0, miniH - PAD_TB * 2);
    const want = avail / n;
    const step = want >= MINI_SLOT_MIN ? 1 : Math.ceil(MINI_SLOT_MIN / want);
    const shown = [];
    for (let i = 0; i < n; i += step) shown.push(i);
    const slot = Math.min(MSLOT_MAX, avail / shown.length);
    const y0 = PAD_TB + Math.max(0, avail - slot * shown.length) / 2;
    return shown.map((idx, k) => ({ y: y0 + k * slot, h: slot, idx }));
  }, [items.length, miniH]);

  /* 波峰宽度：峰在 hover 上，向上下高斯衰减。
     用 exp(−d²/2) 而不是线性衰减 —— 线性到一半就到底，边缘是折角，
     看着只是「几根长短不一的线」；高斯两头平滑收进去才像浪。 */
  const mWidth = useCallback((i) => {
    if (hover < 0) return MW_BASE;
    const d = (i - hover) / MW_SIGMA;
    return Math.round(MW_BASE + (MW_MAX - MW_BASE) * Math.exp(-(d * d) / 2));
  }, [hover]);

  const jump = useCallback((it) => {
    const sc = scrollRef.current;
    if (!sc) return;
    /* 落在**阅读线**上而不是视口顶沿：跳过去的那一格就成了 active，
       不会出现「点了 05，导航条还亮着 04」。 */
    sc.scrollTo({ top: Math.max(0, it.top - lineOffset(sc)), behavior: "smooth" });
  }, []);

  // 大纲展开时把当前项滚进可视区（面板内部滚动，滚动条藏掉）
  useLayoutEffect(() => {
    const el = listRef.current?.querySelector(".olr-item.cur");
    if (!el) return;
    const box = el.getBoundingClientRect();
    const host = listRef.current.getBoundingClientRect();
    if (box.top < host.top || box.bottom > host.bottom) {
      listRef.current.scrollTop += box.top - host.top - host.height / 3;
    }
  }, [cur]);

  // 两个都关 = 整块不渲染，和「这篇没标题」是同一种空。
  // ⚠️ 迷你模式是**另一种形态**不是第三个叠加开关：开它就不渲染 .olr-rail /
  //    .olr-list —— 完整模式那两块（刻度轨 + hover 大纲）与迷你模式是同一块
  //    屏幕空间，两者同时在会互相打架（大纲面板会盖住迷你轨的预览卡）。
  if (!items.length || (!showRail && !showOutline && !showMini)) return null;

  // 大纲开着但导航条关掉 → 常驻（没有 hover 触发点了），两块改成纵向堆叠。
  const pinned = !!showOutline && !showRail;

  return (
    // 右缘完全归 CSS（--inset-r + --sbw，和右下角胶囊同一个口径）。
    // 容器 pointer-events:none，只让轨道和面板吃指针 —— 否则这 230px 的透明区
    // 会盖住正文，鼠标划过去点不到字
    <div className={"olr" + (pinned ? " pinned" : "") + (showMini ? " mini" : "")}
      style={showMini ? { height: miniH + "px" } : undefined}>
      {showMini && (
        /* 迷你轨。onMouseLeave 清掉 hover —— 波峰和预览都挂在它上面，
           鼠标滑出去就该整个收回，而不是留一根长线在原地。
           高度来自 miniH（条目多就变长，最多编辑区 45%），inline 覆盖 CSS 里的
           --olr-mini-h；垂直居中仍由 .olr.mini 的 translateY(-50%) 管。 */
        <div className="olr-mini" ref={miniRef} onMouseLeave={() => setHover(-1)}>
          {mSlots.map((sl, k) => (
            <button key={items[sl.idx].pos}
              className={"olr-mtick" + (sl.idx === cur ? " cur" : "")}
              style={{ top: sl.y + "px", height: sl.h + "px", "--w": mWidth(k) + "px" }}
              onMouseEnter={() => setHover(k)}
              onFocus={() => setHover(k)}
              onClick={() => jump(items[sl.idx])}
              title={items[sl.idx].text} aria-label={items[sl.idx].text}>
              {/* ⚠️ 这个 <i> 漏过一次：按钮写成自闭合的，里面是空的 ——
                 看得见的线是 `.olr-mtick > i`，没有它整个轨**一条线都不画**，
                 而按钮盒子还在、宽度也照样量得出来（`--w` 挂在 button 上），
                 所以量宽度、按波峰、开关、hover 预览**全都验得过**，
                 唯独「看不看得见」这一条测不出来 —— 用户说「看不到导航条」才发现。
                 和完整的 .olr-tick 一样：槽是排版和命中的，线是画出来的。 */}
              <i />
            </button>
          ))}
          {/* 片段预览：标题 + 该标题下第一行正文。垂直位置跟着波峰走。
              pointer-events:none —— 它盖在正文上，但不拦鼠标，底下的字照样能选。 */}
          {hover >= 0 && items[mSlots[hover]?.idx] && (
            <div className="olr-mcard" style={{ top: mSlots[hover].y + "px" }}>
              <div className="olr-mcard-t">{items[mSlots[hover].idx].text}</div>
              {items[mSlots[hover].idx].preview
                ? <div className="olr-mcard-b">{items[mSlots[hover].idx].preview}</div>
                : null}
            </div>
          )}
        </div>
      )}
      {!showMini && showRail && (
        <div className="olr-rail" ref={railRef}>
          {items.map((it, i) => (
            // tick 的 height 是**槽高**（点击热区），看得见的线只有 2px，
            // 靠 flex 在槽内 y 居中。线长是层级，宽窄编码深浅。
            <button key={it.pos} className={"olr-tick" + (i === cur ? " cur" : "")}
              style={{ top: slots[i].y + "px", height: slots[i].h + "px", "--w": LW[it.level - 1] + "px" }}
              onClick={() => jump(it)} title={it.text} aria-label={it.text}>
              <i />
            </button>
          ))}
        </div>
      )}
      {/* hover 只是**触发方式**，不是面板的生命周期：勾了就在，没勾就压根不渲染。
          JSX 里的注释必须用花括号包起来，写成 // 会变成真正的文本节点渲染出去。*/}
      {!showMini && showOutline && (
        <div className="olr-list">
          <div className="olr-head">
            <span className="olr-head-t">大纲</span>
            <span className="olr-head-i" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                   strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 6h16M4 12h11M4 18h7" />
              </svg>
            </span>
          </div>
          <div className="olr-scroll" ref={listRef}>
            {items.map((it, i) => (
              <button key={it.pos}
                className={"olr-item lv" + it.level + (i === cur ? " cur" : "")}
                onClick={() => jump(it)} title={it.text}>{it.text}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}