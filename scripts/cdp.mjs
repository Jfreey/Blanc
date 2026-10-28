#!/usr/bin/env node
/* 浏览器验证链路（2026-10-13 建立的）。
 *
 * ⚠️ **为什么不用 cua-driver**：它的点击 / 打字在这台机器上完全无效 ——
 * 当初查出来的原因是「一直在对着一个早就换掉的 pid 发事件」（Edge 从 709 变成了
 * 2461 又变成别的），但即使 pid 对了，`click` 也只回一个
 * `{"effect":"unverifiable","path":"cgevent"}`，事件送不进去。
 * 走 Apple Events 的 `click at` 能用，但点到某些网页元素会被系统截去打开
 * 「表情与符号」，DOM 事件根本送不到目标。
 *
 * 现在这条路：**Edge 用 `--remote-debugging-port` + 独立 user-data-dir 启动**
 * （Chromium 136+ 禁止在默认 profile 上开远程调试），走 CDP。
 * CDP 给的是浏览器内部的能力，三样都是我们缺的：
 *   · `Runtime.evaluate` —— 读 DOM、读 computedStyle、跑断言
 *   · `Input.dispatchMouseEvent` / `dispatchKeyEvent` —— 真的送到页面，绕开系统干扰
 *   · `DOM.getBoxModel` —— 元素坐标，点得准
 *
 * 用法：
 *   node scripts/cdp.mjs eval "<js 表达式>"            求值并打印 JSON
 *   node scripts/cdp.mjs click "<css>"                点一个元素（按盒子中心）
 *   node scripts/cdp.mjs hover "<css>"
 *   node scripts/cdp.mjs hoverxy <x> <y>
 *   node scripts/cdp.mjs type  "<文本>"                往当前焦点元素打字
 *   node scripts/cdp.mjs key   "Enter" | "Meta+Shift+b"  按一个键（含组合）
 *   node scripts/cdp.mjs viewport <w> <h>               设视口尺寸（响应式复现）
 *   node scripts/cdp.mjs focus                     强制页面聚焦（窗口在后台时 click/drag 会全部落空）
 *   node scripts/cdp.mjs clickmod <x> <y> [Meta+Alt]   带修饰键点击
 *   node scripts/cdp.mjs draghtml <源css> <目标css> [type data]  真 HTML5 拖放（CDP 原生事件）
 *   node scripts/cdp.mjs drag  <x1> <y1> <x2> <y2>       真实拖选（程序化选区唤不起浮动条）
 *   node scripts/cdp.mjs open  "<url>"                 开一个新标签
 *   node scripts/cdp.mjs shot  "<路径.png>" [css选择器]  整页截图 / 只截某个元素
 *   node scripts/cdp.mjs shotbox <x> <y> <w> <h> <路径.png>     按页面坐标截一块
 *
 * ⚠️ **打字的路径和之前不同**：`Input.insertText` 走的是 IME 提交那条路，
 * 对 contenteditable 最不容易丢；而 `Input.dispatchKeyEvent` 逐字符发，
 * 页面自己的 keydown 处理才看得见（属性面板的改名框要的就是这个）。
 * `type` 默认用 insertText，要逐字符就加 `--per-key`。
 */
import { writeFileSync } from "node:fs";
// Node 22 自带全局 WebSocket，不需要 ws 包（这个项目也不该为了测试多一个依赖）
const WebSocket = globalThis.WebSocket;

const PORT = process.env.CDP_PORT || 9222;
const BASE = `http://127.0.0.1:${PORT}`;

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n) => rest.includes(`--${n}`);

/* ---- 连上目标标签页 ---- */
const list = await (await fetch(`${BASE}/json/list`)).json();
/* ⚠️ 必须按 URL 选标签，不能取第一个 page ——
   Edge 会恢复上次会话，这个 profile 里可能有别的站点的标签页。
   「默认抓第一个」的结果是命令打到隔壁页面上，报错还特别难懂
   （第一次用就踩到：连到了别的应用，读出来一堆不相干的文字）。 */
const want = process.env.CDP_URL || "localhost:5173";
let page = list.find((t) => t.type === "page" && t.url.includes(want));
if (!page && cmd === "open") {
  /* ⚠️ `open` 本身是「把某个标签导航到某地址」，所以找不到匹配的标签时
     不能直接报错退出 —— 那正是冷启动时的常态（只有一个 about:blank）。
     这里退回第一个 page 导航过去；
     之后每条命令再按 URL 选，就又回到精确匹配了。 */
  page = list.find((t) => t.type === "page");
  if (!page) {
    console.error("这个浏览器里一个标签页都没有，先手工开一个。");
    process.exit(1);
  }
}
if (!page) {
  console.error(`没有 URL 含「${want}」的标签页。先 open 一个，或用 CDP_URL= 指定别的。`);
  console.error("现有的：", list.filter((t) => t.type === "page").map((t) => t.url.slice(0, 60)));
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
// 全局 WebSocket 走标准 addEventListener，没有 ws.on 那套（那是 ws 包的 API）
await new Promise((ok, bad) => {
  ws.addEventListener("open", ok, { once: true });
  ws.addEventListener("error", bad, { once: true });
});

let seq = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
  if (m.id && pending.has(m.id)) {
    const { ok, bad } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? bad(new Error(JSON.stringify(m.error))) : ok(m.result);
  }
});
const send = (method, params = {}) =>
  new Promise((ok, bad) => {
    const id = ++seq;
    pending.set(id, { ok, bad });
    ws.send(JSON.stringify({ id, method, params }));
  });

/* ---- 控制台报错收集 ----
   出问题时页面常常是白屏 / 编辑器干脆不渲染，
   而原因只在 console 里 —— 不 attach 就永远看不到。
   eval / open 每次都是新连接，所以只在「连上之后」到「命令跑完之前」之间可见。 */
const consoleErrors = [];
await send("Runtime.enable");
ws.addEventListener("message", (ev) => {
  if (consoleErrors.length > 40) return;
  const m = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
  if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    consoleErrors.push("EXCEPTION " + (d.exception?.description || d.text || ""));
  } else if (m.method === "Runtime.consoleAPICalled" && /error|warning/.test(m.params.type)) {
    consoleErrors.push(m.params.type.toUpperCase() + " " + m.params.args.map((a) => a.value ?? a.description ?? a.type).join(" "));
  }
});

/** 在页面里求值。返回按值传回来的结果（不是 JSON 文本）。 */
const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", {
    expression: `(async () => { return (${expr}); })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || "页面里抛了");
  }
  return r.result.value;
};

/* ---- 元素中心坐标：CSS 选择器 → (x, y) ---- */
const centerOf = async (selector) => {
  const box = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  })()`);
  if (!box) throw new Error(`找不到元素：${selector}`);
  return box;
};

const mouse = (type, x, y, extra = {}) =>
  send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, ...extra });

switch (cmd) {
  case "eval": {
    const v = await evaluate(rest.filter((a) => !a.startsWith("--")).join(" "));
    console.log(JSON.stringify(v, null, 2));
    break;
  }
  case "open": {
    await send("Page.navigate", { url: rest[0] });
    // 等 load 事件之后的下一帧，返回时页面大致可用
    await new Promise((r) => setTimeout(r, 1200));
    console.log("opened", rest[0]);
    break;
  }
  case "click": {
    const { x, y } = await centerOf(rest[0]);
    await mouse("mouseMoved", x, y);
    await mouse("mousePressed", x, y);
    await mouse("mouseReleased", x, y);
    console.log(`clicked ${rest[0]} @ ${Math.round(x)},${Math.round(y)}`);
    break;
  }
  case "clickel": {
    /* 页内直接派发 pointerdown/pointerup/click 到元素上，**不做命中测试**。
     *
     * 什么时候需要它：像 Crepe 的块菜单那种「pointerenter 就自动滚动列表」的浮层，
     * 鼠标一移上去列表就滚，原坐标下的元素已经不是它了 —— 真鼠标按下去会落空
     * （实测按了 pointerup 一个都收不到，Crepe 自己的条目同样点不动）。
     * 这条命令验的是「handler 到功能」这一段，不是「点得中」那一段。 */
    const el = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(rest[0])});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const init = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      el.dispatchEvent(new PointerEvent("pointerdown", { ...init, pointerId: 1, isPrimary: true }));
      el.dispatchEvent(new PointerEvent("pointerup", { ...init, pointerId: 1, isPrimary: true }));
      el.dispatchEvent(new MouseEvent("click", init));
      return true;
    })()`);
    console.log(el ? `dispatched on ${rest[0]}` : `没找到 ${rest[0]}`);
    if (!el) process.exit(1);
    break;
  }
  case "focus": {
    /* 强制让页面处于「已聚焦」状态。
       窗口被切到后台时 document.activeElement 会退回 BODY，
       于是 click / drag 全部落空 —— 表现是「点不进编辑器」，
       很容易误判成编辑器坏了。 */
    await send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await send("Page.bringToFront");
    console.log("focused");
    break;
  }
  case "viewport": {
    /* 设视口尺寸。响应式问题只能在特定宽度下复现 ——
       用户那张窄窗口截图就是这么来的。 */
    const [w, h] = rest.map(Number);
    await send("Emulation.setDeviceMetricsOverride", {
      width: w, height: h, deviceScaleFactor: 1, mobile: false,
    });
    console.log(`viewport ${w}x${h}`);
    break;
  }
  case "draghtml": {
    /* draghtml <源选择器> <目标选择器> [data] —— CDP 的 Input.dispatchDragEvent。
       ⚠️ **它只能验一半**：`Input.dispatchDragEvent` 是在给定坐标上派发
       dragEnter/dragOver/drop，**发不出 dragstart** —— 拖拽源在浏览器内部的
       拖拽状态里，CDP 无法合成。所以：
         · 能验：落点目标收到了 dragover/drop（拖放目标区、指示线、落点判定）
         · 验不了：「从 A 按下去拖起来」这一段（排序、ghost、跟随光标）
       排「侧栏排序到底生效没有」这种 bug，还得真人拖，或者换 `type --per-key` 那种
       能在页面里直接 dispatch 的路子（但那是合成事件，验不了原生层劫持）。

       形状以 `curl http://127.0.0.1:9222/json/protocol` 为准：data 是
       **单个对象** `$ref: DragData`，不是数组（传数组会报 CBOR map start expected）。

       必须先 Input.setInterceptDrags(true)，否则 Chrome 不会把 drag 事件
       交给页面，而是当成浏览器自身的拖放。 */
    await send("Input.setInterceptDrags", { enabled: true });
    const boxOf = async (sel) => {
      const b = await evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(sel)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()`);
      if (!b) throw new Error(`没找到 ${sel}`);
      return b;
    };
    const src = await boxOf(rest[0]);
    const dst = await boxOf(rest[1]);
    /* data 的形状是 Array<DragData>，而 DragData 里面才是 items：
       { items: [{mimeType, data}], files: [], dragOperationsMask }
       直接传 item 会回 "CBOR: map start expected"。 */
    const item = { mimeType: "text/plain", data: String(rest[2] ?? "x") };
    /* ⚠️ data 是**单个对象**（协议里是 `$ref: DragData`，不是 array[DragData]）——
       传数组会报 "CBOR: map start expected"。形状以 /json/protocol 为准，别照抄旧文档。 */
    const data = { items: [item], files: [], dragOperationsMask: 0 };
    await send("Input.dispatchDragEvent", { type: "dragEnter", ...src, data });
    await send("Input.dispatchDragEvent", { type: "dragOver", ...dst, data });
    await send("Input.dispatchDragEvent", { type: "drop", ...dst, data });
    await send("Input.setInterceptDrags", { enabled: false });
    console.log(`dragged ${rest[0]} -> ${rest[1]}`);
    break;
  }
  case "clickmod": {
    /* 带修饰键点击：clickxy <x> <y> [mods]（mods 形如 Meta+Alt）。
       用来验「Alt 加选块」「⇧ 点块把手」这类**鼠标**快捷键。 */
    const [x, y] = rest.slice(0, 2).map(Number);
    const mods = (rest[2] || "").split("+").filter(Boolean).map((m) => m.toLowerCase());
    const modifiers = (mods.includes("meta") ? 4 : 0) | (mods.includes("ctrl") ? 2 : 0)
      | (mods.includes("alt") ? 1 : 0) | (mods.includes("shift") ? 8 : 0);
    await mouse("mouseMoved", x, y, { modifiers });
    await mouse("mousePressed", x, y, { modifiers });
    await mouse("mouseReleased", x, y, { modifiers });
    console.log(`clicked ${x},${y} mods=${rest[2] || "none"}`);
    break;
  }
  case "drag": {
    /* 真实拖选。程序化 setSelection **不会**唤起浮动工具条
       （实测：设完选区 .milkdown-toolbar 的 offsetWidth 仍是 0），
       所以要验选区相关的东西必须走真鼠标。 */
    const [x1, y1, x2, y2] = rest.map(Number);
    await mouse("mouseMoved", x1, y1);
    await mouse("mousePressed", x1, y1, 1);
    // 分几步移动：一步跳过去有些编辑器不会产生 selectionchange
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      await mouse("mouseMoved", x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps, 1);
    }
    await mouse("mouseReleased", x2, y2, 1);
    console.log(`dragged ${x1},${y1} -> ${x2},${y2}`);
    break;
  }
  case "hoverxy": {
    const [x, y] = rest.map(Number);
    await mouse("mouseMoved", x, y);
    console.log(`hovered @ ${x},${y}`);
    break;
  }
  case "clickxy": {
    // 按坐标点：选择器不方便表达时用（同名元素里挑第几个、父子关系、hover 才出现的…）
    const [x, y] = rest.map(Number);
    await mouse("mouseMoved", x, y);
    await mouse("mousePressed", x, y);
    await mouse("mouseReleased", x, y);
    console.log(`clicked @ ${x},${y}`);
    break;
  }
  case "hover": {
    const { x, y } = await centerOf(rest[0]);
    await mouse("mouseMoved", x, y);
    console.log(`hovered ${rest[0]} @ ${Math.round(x)},${Math.round(y)}`);
    break;
  }
  case "type": {
    const text = rest.filter((a) => !a.startsWith("--")).join(" ");
    /* ⚠️ **打字之前必须报出焦点在哪**。
       实测踩过：菜单被我自己的一个 Enter 关掉了，随后的 `type` 就落到了
       别的输入框上（那次是一个 type="number" 的属性值框，被写成了 0）——
       `Input.insertText` 不挑地方，它只往当前焦点里塞。
       焦点在 BODY 时直接拒绝：这时候打字要么没地方去，要么落在你不��的地方。 */
    const who = await evaluate(`(() => {
      const a = document.activeElement;
      if (!a || a === document.body) return null;
      const d = a.tagName + (a.type ? "[" + a.type + "]" : "")
        + (a.className ? "." + String(a.className).split(" ")[0] : "")
        + (a.ariaLabel ? " aria=" + a.ariaLabel : "");
      return d + " value=" + JSON.stringify(String(a.value ?? "").slice(0, 30));
    })()`);
    if (!who && !flag("force")) {
      console.error("焦点不在任何输入控件上（document.body），拒绝打字。确认目标后再来，或加 --force。");
      process.exit(1);
    }
    console.log("焦点:", who ?? "(BODY)");
    if (flag("per-key")) {
      for (const ch of text) {
        await send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, unmodifiedText: ch });
        await send("Input.dispatchKeyEvent", { type: "keyUp" });
      }
    } else {
      await send("Input.insertText", { text });
    }
    console.log("typed", JSON.stringify(text));
    break;
  }
  case "key": {
    // 名字见 https://chromedevtools.github.io/devtools-protocol/tot/Input/#dispatchKeyEvent
    const KEYS = {
      Enter: { windowsVirtualKeyCode: 13, code: "Enter", key: "Enter", text: "\r" },
      Tab: { windowsVirtualKeyCode: 9, code: "Tab", key: "Tab", text: "\t" },
      Escape: { windowsVirtualKeyCode: 27, code: "Escape", key: "Escape" },
      Backspace: { windowsVirtualKeyCode: 8, code: "Backspace", key: "Backspace" },
      ArrowDown: { windowsVirtualKeyCode: 40, code: "ArrowDown", key: "ArrowDown" },
      ArrowUp: { windowsVirtualKeyCode: 38, code: "ArrowUp", key: "ArrowUp" },
      Space: { windowsVirtualKeyCode: 32, code: "Space", key: " ", text: " " },
    };
    // 字母/数字：给 key 和 code（code 是 "KeyB"/"Digit1" 这套），
    // 但**不给 text** —— 有 text 的按 rawKeyDown 不会产生字符。
    const main0 = rest[0].split("+").pop();
    if (!KEYS[main0]) {
      if (/^[a-zA-Z]$/.test(main0))
        KEYS[main0] = {
          windowsVirtualKeyCode: main0.toUpperCase().charCodeAt(0),
          code: "Key" + main0.toUpperCase(),
          key: main0,
        };
      else if (/^[0-9]$/.test(main0))
        KEYS[main0] = {
          windowsVirtualKeyCode: main0.charCodeAt(0),
          code: "Digit" + main0,
          key: main0,
        };
    }
    /* 支持组合：Meta+b / Meta+Shift+x / Alt+ArrowUp。
       没有组合就没法验证快捷键列表 —— 工具条 tooltip 上写着 ⌘B，
       但那只是 tooltip，得真按下去看 markdown 有没有变才算数。 */
    const parts = rest[0].split("+");
    const main = parts.pop();
    const mods = parts.map((m) => m.toLowerCase());
    const k = KEYS[main];
    if (!k) throw new Error("不认识的键：" + main);
    const modifiers = (mods.includes("meta") ? 4 : 0) | (mods.includes("ctrl") ? 2 : 0)
      | (mods.includes("alt") ? 1 : 0) | (mods.includes("shift") ? 8 : 0);
    /* 有 text 的键（Enter/空格）用 keyDown 才带字符，
       字母这类没有 text 的用 rawKeyDown，和浏览器实际收到的一致。 */
    const type = k.text ? "keyDown" : "rawKeyDown";
    await send("Input.dispatchKeyEvent", { type, ...k, modifiers });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...k, modifiers });
    console.log("key", rest[0]);
    break;
  }
  case "shotbox": {
    /* shotbox <x> <y> <w> <h> <路径.png> —— 按**页面坐标**截一块。
       用来看跨元素的局部（比如窗口左上角同时有红绿灯占位和侧栏头部），
       按选择器截只能截到一个元素，看不到它们之间的关系。 */
    const [x, y, w, h] = rest.slice(0, 4).map(Number);
    const r = await send("Page.captureScreenshot", {
      format: "png",
      clip: { x, y, width: w, height: h, scale: 1 },
    });
    writeFileSync(rest[4], Buffer.from(r.data, "base64"));
    console.log("saved", rest[4], `${w}x${h}`);
    break;
  }
  case "shot": {
    /* 传第二个参数就只截那个元素（按盒子算 clip）——
       整页截图再靠 sips 裁会被 devicePixelRatio 坑（2 倍屏裁出来只剩一半）。 */
    const params = { format: "png" };
    if (rest[1]) {
      const box = await evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(rest[1])});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height };
      })()`);
      if (!box) {
        console.error(`没找到元素 ${rest[1]}`);
        process.exit(1);
      }
      /* ⚠️ **不能**同时用 clip 和 captureBeyondViewport**：
         实测那个组合会按 clip 的尺寸重新走一遍合成，输出被非等比拉伸 ——
         300x46 的工具条出来是 380x760，图标全成了又高又窄的细条。
         只用 clip（元素在视口内时足够），并且去掉 sips 二次缩放。 */
      params.clip = { ...box, scale: 1 };
    }
    const r = await send("Page.captureScreenshot", params);
    writeFileSync(rest[0], Buffer.from(r.data, "base64"));
    console.log("saved", rest[0]);
    break;
  }
  default:
    console.error("用法见文件头");
    process.exit(1);
}
/* 命令跑完，把这段时间里页面的报错/警告打出来 —— 白屏时全靠它定位 */
if (consoleErrors.length) {
  console.log("--- 页面 console ---");
  for (const e of consoleErrors) console.log(e);
}
ws.close();
