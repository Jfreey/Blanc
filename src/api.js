import pkg from "../package.json";

// Blanc API 客户端（对应 server.mjs 的 /api/*）
const j = (r) => {
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
};

// 两件事要分开看：
//  · API_BASE —— 打包后 origin 是 tauri://localhost，相对 /api 打不到后端，得用绝对地址；
//    但 `tauri dev` 下页面是 http://localhost:5173（vite 代理兜着），这时相对路径反而是对的。
//  · 是不是在 Tauri 壳里 —— 用 __TAURI_INTERNALS__ 判断，**不能**用 protocol 判断：
//    `tauri dev` 的 protocol 也是 http，但桌面桥接（invoke / 事件）在那种模式下同样存在。
const isTauriProtocol = !window.location.protocol.startsWith("http");
// 用 127.0.0.1 而不是 localhost：后端只监听回环 IPv4（server.mjs），
// 而 localhost 在 macOS 上先解析到 ::1，多走一次失败再回退。
export const API_BASE = isTauriProtocol ? "http://127.0.0.1:8787" : "";
/** Rust 侧的冲突错误用 "CONFLICT\u{1}<mtime>" 前缀传回来（见 lib.rs 的 write_file）。
 *  转成结构化对象，前端不用去猜字符串。 */
function toConflict(e) {
  const msg = String(e && e.message ? e.message : e);
  const i = msg.indexOf("CONFLICT\u0001");
  if (i < 0) return e;
  return {
    conflict: true,
    currentMtime: Number(msg.slice(i + "CONFLICT\u0001".length)) || 0,
    message: "文件已被其它地方修改",
  };
}

export const inTauriShell = () => typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

/* ---- 桌面壳（Rust 侧）----
 * 「作为 md 默认编辑器」需要两条通道：
 *   openedFile()  启动时系统交过来的那个文件路径（Finder 双击 / 拖进来）
 *   desktop.read/write  读写**知识库之外**的绝对路径
 * 为什么读写不走 server.mjs：它是 HTTP 服务，且用 safeJoin 把所有路径锁在
 * 知识库根目录内 —— 给它开「任意绝对路径读写」等于开一个远程写任意文件的口子。
 * Rust 命令只能被本应用自己的 webview 调用，边界小得多。
 */
let tauriApi = null;
if (inTauriShell()) {
  // 动态 import：纯浏览器里跑（npm run dev）时这个包根本不该被拉进来
  tauriApi = import("@tauri-apps/api").then((m) => m).catch(() => null);
}

/* ── 独立窗口（一个进程多窗口，不是多实例）───────────────────
 *
 * 新窗口是**同一个 app 进程里的另一个 webview**，所以：
 *   · 后端 server 只有一个（不需要端口协商）
 *   · 前端代码同一份，每个窗口一个 React 根，各自的 doc 天然独立
 *
 * 要做的两件事：
 *   1. capabilities 里放行 core:webview:allow-create-webview-window，
 *      且 windows 要涵盖新窗口的 label（默认 "main" 只覆盖主窗口）
 *   2. 新窗口怎么知道要开哪篇 → 走 URL 查询参数 ?doc=<rel>
 *      （同源，localStorage 里的知识库选择两边共享，所以只传 rel 就够） */

export const windows = {
  /** 这个前端是不是跑在 Tauri 壳里（决定能不能开新窗口） */
  canSpawn: () => inTauriShell(),
  /**
   * 为 rel 开一个新窗口。返回新窗口的 label。
   * 纯浏览器里直接抛 —— 那边没有窗口概念，只能提示去打包版试。
   */
  /* 打开「一篇文档」的窗口。
   *
   * ⚠️ 现在**不在前端建窗口**，而是调 Rust 的 open_doc_window_cmd。
   * 原因有两个，都是踩出来的：
   *   ① label 必须全局唯一。各窗口各有一个 `window.__blancWinSeq`，各自 ++
   *      **会撞** —— 撞了 Tauri 报 "window already exists"，窗口开不出来。
   *      发号得在 Rust 里做（那里是单进程的）。
   *   ② 「同一篇只在一个窗口里」这条产品规则，得只有一份实现。
   *      Finder 双击 .md 也走这个函数，否则两套逻辑迟早对不上。
   * Rust 那边已有窗口会把那个叫到前面（unminimize + show + set_focus），
   * 没有才新建 —— 返回的 label 是「这篇现在开在哪个窗口」。
   *
   * rel = 库内相对路径；path = 库外绝对路径。两者给其一。 */
  spawnForDoc: async (rel, name) => {
    const api = await tauriApi;
    if (!api) throw new Error("独立窗口只能在打包版里用");
    return invoke("open_doc_window_cmd", { rel: rel ?? null, path: null });
  },
  spawnForPath: async (path) => {
    const api = await tauriApi;
    if (!api) throw new Error("独立窗口只能在打包版里用");
    return invoke("open_doc_window_cmd", { rel: null, path });
  },
  /** 当前窗口的 label；主窗口是 "main" */
  currentLabel: async () => {
    const api = await tauriApi;
    if (!api) return null;
    return api.window.getCurrentWindow().label;
  },
  /** 关掉当前这个「独立窗口」。主窗口关不得 —— 返回 false 表示没关。 */
  closeSelfWindow: async () => {
    const api = await tauriApi;
    if (!api) return false;
    const w = api.window.getCurrentWindow();
    if (w.label === "main") return false;
    await w.close();
    return true;
  },
};

const invoke = async (cmd, args) => {
  if (!tauriApi) return null;
  const api = await tauriApi;
  if (!api) return null;
  return api.core.invoke(cmd, args);
};

export const desktop = {
  available: () => inTauriShell(),
  // 返回 string | null；浏览器里恒为 null
  openedFile: async () => {
    try { return await invoke("opened_file"); } catch { return null; }
  },
  /* 把主题档位告诉 Rust，让它建窗口时按这一档铺底色。
     必须在**改主题的同时**调，不能等窗口下次才建：窗口底色只在 webview 接管前
     那一下露出来，那时候前端还没跑、说了也来不及。Rust 侧读的是 app data
     目录里的一个小文件（见 lib.rs 的 theme_pref_path）。 */
  setThemeMode: (mode) => invoke("set_theme_mode", { mode }).catch(() => {}),
  /* 主窗口以 visible:false 创建，前端首帧画完再露出来（见 lib.rs 的 show_main_window）。
     浏览器里是空操作。 */
  showWindow: () => invoke("show_main_window").catch(() => {}),
  /** 读文件 + mtime + ctime。
      mtime 是**乐观锁的基准**：保存时送回去，服务端/后端比对不上就拒写
      （见 write）。ctime 是文件创建时间，只给属性面板显示用 ——
      库外文件不走 /api/tree，拿不到 scan() 的 fs.stat，只能从这儿带。
      ctime 为 0 表示系统不提供（Linux 上常见），前端据此隐藏那一行。 */
  read: async (path) => {
    const [content, mtime, ctime] = await invoke("read_file_meta", { path });
    return { content, mtime, ctime };
  },
  /** 写文件，带乐观锁。baseMtime 为 0/undefined 表示不参与检查。
      冲突时 reject 一个带 `conflict: true` 的对象（见 CONFLICT 前缀）。 */
  write: async (path, content, baseMtime = 0) => {
    try {
      const mtime = await invoke("write_file", { path, content, baseMtime });
      return { mtime };
    } catch (e) {
      throw toConflict(e);
    }
  },
  reveal: (path) => invoke("reveal_in_file_manager", { path }),
  // 把自己设成 .md 默认编辑器（只有 macOS 有这个系统机制）
  setDefaultMarkdownApp: () => invoke("set_default_markdown_app"),
  isMac: () => typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent),
  // 应用已在运行时又打开了一个文件：前端切过去
  onOpenFile: async (fn) => {
    if (!tauriApi) return () => {};
    const api = await tauriApi;
    if (!api) return () => {};
    const un = await api.event.listen("blanc:open-file", (e) => fn(e.payload));
    return un;
  },
};

/* ---- 「关于」面板要的应用名 / 版本号 ----
 * 打包版从 Rust 的 package_info() 取（见 lib.rs 的 app_info）——那是用户
 * 真正装到的那个版本。浏览器里跑（npm run dev）没有桌面壳，退回
 * package.json 里那份：vite 会把 JSON import 内联进来，改版本号时
 * 这个回落值跟着一起变，不会成为第二份需要手工维护的真值。 */
export const appInfo = async () => {
  const fb = { name: "Blanc", version: pkg.version };
  if (!inTauriShell()) return fb;
  try {
    const r = await invoke("app_info");
    if (!r || r.length < 2) return fb;
    return { name: String(r[0] || fb.name), version: String(r[1] || fb.version) };
  } catch {
    return fb;                 // 桥没就绪（极少见）：宁可显示旧值也别让面板空着
  }
};

/* 系统目录选择器。
 * 只有 Tauri 壳里才有 —— 它走 @tauri-apps/plugin-dialog，能力清单里要
 * dialog:allow-open（见 desktop/src-tauri/capabilities/default.json）。
 * 浏览器里返回 null，调用方据此回落到手输绝对路径那条老路。
 *
 * ⚠️ 这个包**不能**静态 import：纯浏览器跑（npm run dev / vite build 给静态托管用）
 * 时 @tauri-apps/api 的 invoke 在这个包里会直接摸 window.__TAURI_INTERNALS__，
 * 静态引入会让整个模块在浏览器里求值失败。必须跟着上面 tauriApi 一样动态 import。
 */
export const pickDir = async (title = "选择知识库目录") => {
  if (!inTauriShell()) return null;
  try {
    const m = await import("@tauri-apps/plugin-dialog");
    const picked = await m.open({ directory: true, multiple: false, title });
    // macOS 上对话框允许选 .app 包，会返回 /Applications/X.app 这种路径 ——
    // 那是单文件包不是目录，接进来当知识库根目录会一路报「不是目录」。
    return typeof picked === "string" ? picked : null;
  } catch {
    return null;
  }
};

/* 启动竞速（2026-10-21）。Rust 那边拉起 server.mjs 是异步的（node 启动 ~350ms），
   而主窗口一渲染就会问 /api/roots —— 端口还没监听时这次请求直接被拒。
   以前靠 Rust 在 setup 里同步等 3s 来保证顺序，代价是窗口首帧跟着一起等；
   现在那边不阻塞了，改成这里对**连不上**重试：业务错误（HTTP 4xx/5xx，
   j() 抛的是 "404 Not Found" 这种）立刻抛，只有网络层的失败才重试。 */
const RETRY_MS = 80;
const RETRY_TIMES = 15;                     // ~1.2s，比 node 冷启动的常见耗时留够余量
const isHttpError = (e) => /^\d{3}\b/.test(String((e && e.message) || e));
function fetchWithRetry(url, init) {
  let tries = 0;
  const once = () => fetch(url, init).then(j).catch((e) => {
    if (isHttpError(e) || tries >= RETRY_TIMES) throw e;
    tries += 1;
    return new Promise((r) => setTimeout(r, RETRY_MS)).then(once);
  });
  return once();
}

export const api = {
  getRoots: () => fetchWithRetry(`${API_BASE}/api/roots`),
  // 首启引导的两个候选路径 + 兜底目录里有没有现成笔记。
  // 只读：用户看完直接关窗，磁盘上不会多出任何东西，下次启动继续问。
  setup: () => fetch(`${API_BASE}/api/setup`).then(j),
  addRoot: (path) =>
    fetch(`${API_BASE}/api/roots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    }).then(j),
  removeRoot: (root) =>
    fetch(`${API_BASE}/api/roots?root=${encodeURIComponent(root)}`, { method: "DELETE" }).then(j),
  // 知识库自定义图标；value 传空串 = 恢复默认书本
  setRootIcon: (root, kind, value, color) =>
    fetch(`${API_BASE}/api/roots/icon`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root, kind, value, color: kind === "svg" ? color || "" : "" }),
    }).then(j),

  /* 返回 {root, rev, folders, files}。rev 是服务端的「结构版本号」，
     拿到它顺手记成基线，免得下一次轮询以为结构刚变过（见 treeRev）。 */
  tree: (root) => fetch(`${API_BASE}/api/tree?root=${encodeURIComponent(root)}`).then(j),

  /** 只问「目录结构变了没有」，回 `{rev, watched}`（2026-10-30）。
   *  服务端每个库挂了 fs.watch，增删改名就 +1；前端轮询这个数字，
   *  变了才去拉 tree —— 裸轮询 tree 等于每次重扫全库 + 传整棵树。
   *  watched=false 表示这台机器上没挂上 watch（老 Linux / 网络盘），
   *  服务端会退化成定时重扫，数字照样会动，只是慢一点。 */
  treeRev: async (root) => {
    if (!root) return null;
    const r = await fetch(`${API_BASE}/api/tree/rev?root=${encodeURIComponent(root)}`, { cache: "no-store" });
    if (!r.ok) return null;
    return r.json().catch(() => null);
  },

  /* ---- 手动排序（#6）----
     order 是「rel → 同级内序号」，存 <库>/.order/_index.json。
     排序**不在服务端做**：按名称/创建/修改这几种是界面偏好，
     服务端只负责把 .order 那张表原样吐出来、在同一层被拖过之后写回去。 */
  order: (root) => fetch(`${API_BASE}/api/order?root=${encodeURIComponent(root)}`).then(j),
  setOrder: (root, rels) =>
    fetch(`${API_BASE}/api/order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root, order: rels }),
    }).then(j),
  /* 跨文件夹搬动 = 真的搬文件（拖到别的目录里才走这条）。
     目标已存在 / 搬进自己里面，服务端会拒（409 / 400），这里把 ok=false 原样带回去。 */
  move: (root, from, to) =>
    fetch(`${API_BASE}/api/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root, from, to }),
    }).then(j),

  /** 返回 {root, path, content, mtime}；mtime 是写入乐观锁的基准。
   *
   *  ⚠️ 非 2xx 必须**抛**，不能把 `{error:"文件不存在"}` 当数据返回（2026-10-29 修）。
   *  以前这里只是个 `.then(r => r.json())`，404 也照收；调用方只看到「没有 content」，
   *  只能报一句「文件内容为空响应」——真正的原因（侧栏那行是过时的，文件已被改名/移走）
   *  就丢了，用户既不知道是哪一篇，也不知道该怎么办。 */
  read: async (root, rel) => {
    /* 空库不发请求（2026-10-30）。不拦的话 encodeURIComponent(null) 会变成字符串
       "null"，后端只能回一句「这个知识库不在配置里」—— 说的是实话，但离真正的原因
       （调用方那一刻手上没有库）隔了好几层，排查时最费时间。 */
    if (!root) {
      const e = new Error("还没有选中知识库");
      e.status = 0;
      throw e;
    }
    const r = await fetch(`${API_BASE}/api/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(rel)}`);
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      const e = new Error((data && data.error) || `HTTP ${r.status}`);
      e.status = r.status;
      /* 服务端把收到的 root 一并回显（见 server.mjs 的 badRoot）。
         调用方要能把它摆到提示里：只说「这个库不在配置里」而说不出是哪个，
         用户没法把它和自己看到的侧栏对上，也就没法告诉我们（2026-10-30）。 */
      if (data && data.root !== undefined) e.root = data.root;
      throw e;
    }
    if (!data || typeof data.content !== "string") {
      const e = new Error("响应里没有正文");
      e.status = r.status;
      throw e;
    }
    return data;
  },
  /** 只问「磁盘上这份的 mtime 是多少」，不读正文（2026-10-30 静默刷新用）。
   *  停留在一篇上时前端按秒级轮询它，比对 mtime 决定要不要读全文 ——
   *  比每轮都调 read() 便宜三个数量级（stat 0.017 ms vs 读 13 KB 4.6 ms）。
   *  文件不在了回 404，调用方按「这篇被删了」处理，不要当成错误弹窗。 */
  stat: async (root, rel) => {
    if (!root) return { mtime: 0, size: 0 };
    const r = await fetch(`${API_BASE}/api/stat?root=${encodeURIComponent(root)}&path=${encodeURIComponent(rel)}`,
      { cache: "no-store" });
    if (!r.ok) {
      const e = new Error(`HTTP ${r.status}`);
      e.status = r.status;
      throw e;
    }
    return r.json();
  },
  /**
   * 写入。baseMtime 是这份内容**读到时**的 mtime；服务端对不上就回 409
   * （而不是覆盖）。返回 {ok, mtime}，或抛一个带 conflict:true 的对象。
   */
  write: async (root, rel, content, baseMtime = 0) => {
    const qs = new URLSearchParams({ root, path: rel });
    if (baseMtime > 0) qs.set("baseMtime", String(baseMtime));
    const r = await fetch(`${API_BASE}/api/file?${qs}`, { method: "PUT", body: content });
    if (r.status === 409) {
      const j = await r.json().catch(() => ({}));
      throw {
        conflict: true,
        message: j.error || "文件已被其它地方修改",
        currentMtime: j.currentMtime || 0,
        currentContent: j.currentContent ?? null,
      };
    }
    if (!r.ok) throw new Error(`保存失败（${r.status}）`);
    return r.json();
  },
  create: (root, rel, content = "") =>
    fetch(`${API_BASE}/api/file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root, path: rel, content }),
    }).then(j),
  mkdir: (root, rel) =>
    fetch(`${API_BASE}/api/mkdir`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root, path: rel }),
    }).then(j),
  remove: (root, rel) =>
    fetch(`${API_BASE}/api/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(rel)}`, {
      method: "DELETE",
    }).then(j),
  // ---- 回收站 ----
  trash: (root) => fetch(`${API_BASE}/api/trash?root=${encodeURIComponent(root)}`).then(j),
  // 读回收站里某个文件的正文。只读，没有配套的写接口。
  trashFile: (root, trashRel) =>
    fetch(`${API_BASE}/api/trash/file?root=${encodeURIComponent(root)}`
      + `&trashRel=${encodeURIComponent(trashRel)}`).then(j),
  restoreFromTrash: (root, trashRel) =>
    fetch(`${API_BASE}/api/trash/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root, trashRel }),
    }).then(j),
  purgeFromTrash: (root, trashRel) =>
    fetch(`${API_BASE}/api/trash/purge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root, trashRel }),
    }).then(j),
  emptyTrash: (root) =>
    fetch(`${API_BASE}/api/trash/purge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root, all: true }),
    }).then(j),

  // ---- 自定义图标（<库>/.icons/_index.json，按 rel 索引）----
  // icons() 返回 { "<rel>": { kind: "emoji" | "svg", value } }
  icons: (root) => fetch(`${API_BASE}/api/icons?root=${encodeURIComponent(root)}`).then(j),
  // value 传空串 = 恢复默认图标。返回整张表，直接 setState 即可
  // color 是调色板 key（"red"…），空串 = 跟随主题；只对 svg 有意义
  setIcon: (root, rel, kind, value, color) =>
    fetch(`${API_BASE}/api/icons`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root, rel, kind, value, color: color || "" }),
    }).then(j),

  rename: (root, from, to) =>
    fetch(`${API_BASE}/api/rename`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root, from, to }),
    }).then(j),
};

// 知识库配置持久化在 localStorage（服务端 config 为权威，这里是 UI 偏好）
export const uiPrefs = {
  get() {
    try {
      return JSON.parse(localStorage.getItem("blanc-ui") || "{}");
    } catch {
      return {};
    }
  },
  set(patch) {
    localStorage.setItem("blanc-ui", JSON.stringify({ ...uiPrefs.get(), ...patch }));
  },
};
