#!/usr/bin/env node
// Blanc — Notion 风格多知识库，Milkdown(Crepe) 编辑器
// 数据 = 各知识库目录里的 .md 文件（前端负责 markdown ⇄ JSON 转换，落盘始终是 .md）
// 用法:
//   node server.mjs              多知识库模式（~/.blanc/config.json）
//   node server.mjs /path/to/dir 独立模式
// 环境: BLANC_CONFIG 配置文件 | BLANC_DIR 默认知识库目录 | PORT 端口（默认 8787）

import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* ===== 进程内串行锁（按 key 排队）=====
 *
 * 为什么需要：`.order/_index.json` / `.icons/_index.json` / `.trash/_index.json`
 * 这三份索引的写入全是「读出来 → 改几个键 → 写回去」。
 * 单窗口时没问题；**多窗口下两个窗口同时拖动排序**，
 * 两边各自 read 到同一份旧值，各自改自己那一层，然后各写一次 ——
 * 后写的把先写的**整份**盖掉（先写那一方在**别的层**做的改动直接丢了）。
 *
 * 更糟的是 fs.writeFile 不是原子的：两次写交叠时，文件里可能留下半截 JSON，
 * 下次 readOrderMap 的 catch 会兜住（当空表），**用户的排序记录整份消失**。
 *
 * Node 是单线程的，所以一条 Promise 链就够了，不需要任何依赖、不需要文件锁
 * （后端全局只有一个进程，见 lib.rs 的 BACKEND_PORT —— 这也是加 single-instance
 * 插件的原因：万一起了第二个进程，锁就不跨进程了）。
 */
const _locks = new Map();
function withLock(key, fn) {
  const prev = _locks.get(key) || Promise.resolve();
  // 故意不 catch 掉前一个任务的异常：否则一次失败会把整条链毒死，
  // 后面所有请求都跟着 reject。用 then(onOk, onOk) 让失败不阻断后续。
  const run = prev.then(fn, fn);
  // 队列本身不该因为 fn 抛错而变成一个永远 rejected 的 promise
  _locks.set(key, run.then(() => {}, () => {}));
  return run;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const CONFIG_DIR = path.join(HOME, ".blanc");
const CONFIG_PATH = process.env.BLANC_CONFIG || path.join(CONFIG_DIR, "config.json");
/* 首次启动引导里两个选项的路径。
   2026-10-16：原来这里直接 mkdir(DEFAULT_DIR) 自动建 —— 开源软件往人家家目录里
   偷偷建文件夹不合适，而且从没问过。现在**什么都不建**，把决定权交给用户：
     唯一推荐的落点是 ~/Blanc Notes（看得见、好备份、不和配置混在一起）。
   **~/.blanc 从此只做配置目录，不再兼任知识库** —— 两者混在一起已经害过用户：
   家目录里躺着 3 篇不隶属任何库、界面上也够不着的孤儿笔记。升级用户的那几篇
   走 /api/setup 的 legacy 通道显式搬走，不靠 .blanc 当库来接。
   不选就直接关窗的话，这里一律不落地，下次启动继续问。 */
const SUGGEST_DIR = process.env.BLANC_DIR || path.join(HOME, "Blanc Notes");

const SINGLE_ROOT = process.argv[2] ? path.resolve(process.argv[2]) : null;
const PORT = Number(process.env.PORT || 8787);
const STATIC_DIR = path.join(__dirname, "dist");

let ROOTS = [];
// 知识库自定义图标：absPath -> { kind, value, color }，和 roots 一起存在 config.json。
// 单独一张表而不是把 roots 改成对象数组 —— roots 在下面到处按字符串用
// （rootFromParam / saveRoots / 静态资源），改成对象要跟着改一大片。
let ROOT_ICONS = {};
async function loadRoots() {
  if (SINGLE_ROOT) {
    await fs.mkdir(SINGLE_ROOT, { recursive: true });
    ROOTS = [SINGLE_ROOT];
    ROOT_ICONS = {};
    return;
  }
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  let cfg = { roots: [] };
  try { cfg = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8")); } catch { /* 首次运行 */ }
  /* 一个库都没有 = 首次启动。**不要替用户决定**：ROOTS 留空，等前端引导页
     拿到选择后由用户点「添加知识库」写进来。原来这里直接填 DEFAULT_DIR，
     等于不问就替人在家目录里建了文件夹。 */
  ROOTS = Array.isArray(cfg.roots)
    ? cfg.roots.map(r => path.resolve(expandHome(r))).filter(Boolean)
    : [];
  if (ROOTS.length === 0) return;   // 还没选：一个字节都不写，config.json 也先不生成
  ROOT_ICONS = (cfg.rootIcons && typeof cfg.rootIcons === "object") ? cfg.rootIcons : {};
  // 顺带清孤儿：key 指向的知识库已经被移除了（和 listIcons 清孤儿键一个道理）
  for (const k of Object.keys(ROOT_ICONS)) if (!ROOTS.includes(k)) delete ROOT_ICONS[k];
  /* **不再**把每个库目录 mkdir 一遍（2026-10-16 改）。
     用户（或误操作、他人的同步盘）把库目录删掉/改名之后重启，原来这里会
     静默把空目录建回来：界面上库还在、点进去空空如也，用户以为笔记被清空了 ——
     实际文件在别处，或者根本已经没了。这种「悄悄修复」比直接报错坏得多。

     现在只标记不存在的（/api/roots 本来就返回 exists），让界面上明确显示
     「目录找不到」，用户自己决定是重新指路还是移除。 */
  await saveRoots();
}

/* 首启引导页要用的两条路径。放在服务端是因为前端不知道 HOME，
   而拼 "~" 前缀给用户看等于让他以为自己能用 —— 实际路径必须是真的。 */
async function setupInfo() {
  /* legacy 是「配置目录里还躺着笔记」的升级情况。
     ~/.blanc 从此只做配置目录，这些笔记就够不着了 —— 引导页上**如实告知**
     「有 N 篇在配置目录里，自己搬走」，但不提供自动搬运。
     试过做成一个按钮：一次 HTTP 调用就能搬动用户文件，风险不该由首启按钮承担；
     而 app 还没发布过，实际只有一个人需要搬几篇测试笔记，手动 mv 够了。 */
  const legacy = await legacyNotes();
  return { suggested: SUGGEST_DIR, ...(legacy ? { legacy } : {}) };
}
/* 只统计「笔记」，config.json 和 .icons/.trash/.order 这些应用自己的文件不算。 */
const APP_FILES = new Set(["config.json", ".DS_Store"]);
async function legacyNotes() {
  try {
    const names = await fs.readdir(CONFIG_DIR, { withFileTypes: true });
    const items = names.filter((d) =>
      !APP_FILES.has(d.name) &&
      (d.isFile() ? /\.md$/i.test(d.name) : !d.name.startsWith(".")));
    if (!items.length) return null;
    return { path: CONFIG_DIR, count: items.length };
  } catch { return null; }
}

async function saveRoots() {
  if (SINGLE_ROOT) return;
  /* 这份是**整份覆盖**：多窗口同时「添加知识库」时，
     后写的会把先写的那个 root 整个盖掉 —— 用户加了两个库，刷新少一个。
     同样靠锁串起来。 */
  await withLock("config", async () => {
    await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    await fs.writeFile(CONFIG_PATH, JSON.stringify({ roots: ROOTS, rootIcons: ROOT_ICONS }, null, 2));
  });
}
function expandHome(p) {
  p = String(p || "").trim();
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return path.join(HOME, p.slice(2));
  return p;
}
// root 参数：数字下标或绝对路径，必须是已登记的知识库
function rootFromParam(s) {
  if (s === null || s === "") return ROOTS[0] || null;
  if (/^\d+$/.test(s)) {
    const i = Number(s);
    return (i >= 0 && i < ROOTS.length) ? ROOTS[i] : null;
  }
  const abs = path.resolve(expandHome(s));
  return ROOTS.includes(abs) ? abs : null;
}

/* 写操作用这个：**空 root 一律拒绝**，绝不退回「第一个库」。
   rootFromParam 对 null / "" / 0 都返回 ROOTS[0]，读接口这么方便没问题，写接口就是
   数据落到用户没指的那个库。实测踩过：`DELETE /api/roots` 不带 root，
   直接把用户唯一的知识库从 config 里删掉了（只剩一个库时还有「至少保留一个」兜底，
   两个以上就真删）。
   宁可 400 —— 让调用方把话说明白，好过替它猜。 */
function rootStrict(s) {
  if (s === null || s === undefined || s === "") return null;
  if (/^\d+$/.test(s) && Number(s) === 0) return null;   // 数字 0 同样是「第一个库」，写操作不接受
  return rootFromParam(s);
}

// 安全：把任意请求路径限制在知识库根内，禁止 .. 逃逸
function safeJoin(rootAbs, rel) {
  const cleaned = String(rel || "").replace(/\\/g, "/");
  const abs = path.resolve(rootAbs, "." + path.posix.sep + cleaned);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return null;
  return abs;
}

async function readBody(req) {
  let data = "";
  for await (const chunk of req) data += chunk;
  return data;
}

// 递归列出 .md 文件 + 子目录
async function scan(dir, prefix = "") {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const folders = [], files = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    const rel = prefix ? prefix + "/" + e.name : e.name;
    if (e.isDirectory()) {
      const scanned = await scan(full, rel);
      folders.push({ name: e.name, rel, type: "dir", children: [...scanned.folders, ...scanned.files] });
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
      /* created / updated 来自 fs.stat，供属性面板的「创建时间 / 更新时间」两行用。
         **不进 frontmatter** —— 那两个值本来就是文件系统的事实，写进文件里只会
         变成第二份、还容易和真实文件时间对不上（复制、git checkout 都会打架）。
         外部工具改了文件，时间自动跟着变，不用同步。
         stat 失败（权限、竞态删除）就不带这两个字段，面板那两行显示成空。 */
      const st = await fs.stat(full).catch(() => null);
      files.push({
        name: e.name, rel, type: "file",
        ...(st ? { created: st.birthtimeMs, updated: st.mtimeMs } : {}),
      });
    }
  }
  folders.sort((a, b) => a.name.localeCompare(b.name, "zh"));
  files.sort((a, b) => a.name.localeCompare(b.name, "zh"));
  return { folders, files };
}

const server = http.createServer(async (req, res) => {
  // CORS：Tauri 桌面壳 origin 是 tauri://localhost，跨域调用本 API
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Max-Age": "86400" });
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  const send = (code, body, type = "application/json; charset=utf-8") => {
    res.writeHead(code, { "Content-Type": type });
    res.end(body);
  };

  /* 400 有两条完全不同的路，以前都甩一句「非法路径」（2026-10-30 用户报：
     点一篇库里的笔记弹出「打开失败：「话题探索日志」非法路径」—— 一句话没有
     主语，看不出是库没了还是路径坏了，也没法自己修）。
     现在分开说，并各自带上收到的值：前端能据此判断要不要重拉知识库列表，
     用户下次截图也能直接看出是哪个 root 对不上。 */
  const badRoot = (root) => JSON.stringify({
    error: "这个知识库不在配置里（可能刚被移除或改名）",
    root: String(root ?? ""),
  });
  const badPath = (rel) => JSON.stringify({
    error: "路径越出了知识库范围",
    path: String(rel ?? ""),
  });

  // ---- 回收站工具 ----
  // 回收站是 <库>/.trash/，里面按原路径存放，索引记在 _index.json
  // （移动不改 mtime，光看文件时间拿不到「什么时候删的」）
  const TRASH_DIR = ".trash";
  const TRASH_INDEX = "_index.json";

  const trashRoot = (absRoot) => path.join(absRoot, TRASH_DIR);

  const readTrashIndex = async (absRoot) => {
    try {
      const raw = await fs.readFile(path.join(trashRoot(absRoot), TRASH_INDEX), "utf-8");
      const j = JSON.parse(raw);
      return Array.isArray(j.items) ? j.items : [];
    } catch {
      return [];
    }
  };

  const writeTrashIndex = async (absRoot, items) => {
    await fs.mkdir(trashRoot(absRoot), { recursive: true });
    await fs.writeFile(path.join(trashRoot(absRoot), TRASH_INDEX), JSON.stringify({ items }, null, 2));
  };

  const uniqueInTrash = async (absRoot, rel) => {
    let candidate = rel, n = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        await fs.stat(path.join(trashRoot(absRoot), candidate));
        candidate = `${rel}.${n++}`;          // 同名再加序号，避免互相覆盖
      } catch {
        return candidate;
      }
    }
  };

  const moveToTrash = async (absRoot, rel, isDir) => {
    await fs.mkdir(trashRoot(absRoot), { recursive: true });
    const trashRel = await uniqueInTrash(absRoot, rel);
    const to = path.join(trashRoot(absRoot), trashRel);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.rename(path.join(absRoot, rel), to);
    /* 锁只包住**索引的读-改-写**，fs.rename 留在锁外（那是真正的搬运，慢，
       占着锁会让别的窗口白等）。但索引这三行必须原子：
       两个窗口同时删两个文件时，各自读到同一份旧 items、各自 unshift 一条，
       后写的会把先写的那条**挤掉** —— 文件还在 .trash 里，但索引里没了，
       用户在回收站里看不见它，等于丢了。 */
    await withLock(`trash:${absRoot}`, async () => {
      const items = (await readTrashIndex(absRoot)).filter((i) => i.trashRel !== trashRel);
      items.unshift({ trashRel, rel, isDir, at: Date.now() });
      await writeTrashIndex(absRoot, items);
    });
    return trashRel;
  };

  const restoreFromTrash = async (absRoot, trashRel) => {
    const items = await readTrashIndex(absRoot);
    const item = items.find((i) => i.trashRel === trashRel);
    if (!item) return false;
    const from = path.join(trashRoot(absRoot), trashRel);
    let to = path.join(absRoot, item.rel);
    // 原位置已经被占用 → 退回同名加序号，别覆盖别人的东西
    let n = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        await fs.stat(to);
        const dir = path.dirname(item.rel), base = path.basename(item.rel, path.extname(item.rel));
        to = path.join(absRoot, dir, `${base}.${n++}${path.extname(item.rel)}`);
      } catch {
        break;
      }
    }
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.rename(from, to);
    await withLock(`trash:${absRoot}`, async () =>
      writeTrashIndex(absRoot, items.filter((i) => i.trashRel !== trashRel)));
    return true;
  };

  const purgeFromTrash = async (absRoot, trashRel) => {
    const abs = safeJoin(trashRoot(absRoot), trashRel);
    if (!abs) return;
    await fs.rm(abs, { recursive: true, force: true });
    await withLock(`trash:${absRoot}`, async () =>
      writeTrashIndex(absRoot, (await readTrashIndex(absRoot)).filter((i) => i.trashRel !== trashRel)));
  };

  const emptyTrash = async (absRoot) => {
    await withLock(`trash:${absRoot}`, async () => {
      await fs.rm(trashRoot(absRoot), { recursive: true, force: true });
      await fs.mkdir(trashRoot(absRoot), { recursive: true });
      await writeTrashIndex(absRoot, []);
    });
  };

  const listTrash = async (absRoot) => {
    const items = await readTrashIndex(absRoot);
    const out = [];
    for (const it of items) {
      const abs = path.join(trashRoot(absRoot), it.trashRel);
      const st = await fs.stat(abs).catch(() => null);
      if (!st) continue;                        // 索引里有、实际没有（手动删过）→ 跳过
      out.push({
        trashRel: it.trashRel,
        rel: it.rel,
        name: path.basename(it.rel),
        isDir: it.isDir ?? st.isDirectory(),
        at: it.at || st.mtimeMs,
      });
    }
    return out;
  };

  // ---- 自定义图标 ----
  // 图标记在 <库>/.icons/_index.json，按相对路径索引：
  //   { "<rel>": { "kind": "emoji" | "svg", "value": "📓" | "star" } }
  // 为什么不做成 .md 的 frontmatter：用户的笔记是纯 markdown，
  // 不该被我们塞一段元数据进去（还会和 Milkdown 的解析、其它工具打架）。
  // .icons/ 以点开头，scan() 跳过所有点开头的条目，所以侧栏看不到它（同 .trash）。
  const ICONS_DIR = ".icons";
  const ICON_INDEX = "_index.json";

  const iconsRoot = (absRoot) => path.join(absRoot, ICONS_DIR);

  const readIconMap = async (absRoot) => {
    try {
      const raw = await fs.readFile(path.join(iconsRoot(absRoot), ICON_INDEX), "utf-8");
      const j = JSON.parse(raw);
      return j && typeof j.icons === "object" && j.icons ? j.icons : {};
    } catch {
      return {};
    }
  };

  const writeIconMap = async (absRoot, map) => {
    await fs.mkdir(iconsRoot(absRoot), { recursive: true });
    await fs.writeFile(path.join(iconsRoot(absRoot), ICON_INDEX), JSON.stringify({ icons: map }, null, 2));
  };

  // 顺手清掉孤儿键：用户可以直接在 Finder 里删/移文件，
  // 索引里的键不清理会一直攒着（listTrash 也在做同样的事）
  const listIcons = async (absRoot) => {
    const map = await readIconMap(absRoot);
    const out = {};
    let dirty = false;
    for (const [rel, v] of Object.entries(map)) {
      const abs = safeJoin(absRoot, rel);
      if (abs && await fs.stat(abs).then(() => true, () => false)) out[rel] = v;
      else dirty = true;
    }
    if (dirty) {
      for (const rel of Object.keys(map)) if (!(rel in out)) delete map[rel];
      await writeIconMap(absRoot, map);
    }
    return out;
  };

  // color 是调色板的 key（"red" / "blue"…），不是色值本身：
  // 存 key 一是文件好读，二是换主题时整套颜色能跟着一起变。
  /* 同 setOrder：读-改-写要占住锁。
     多窗口各设各的图标时，不加锁会互相覆盖（后写的盖掉先写的整份）。 */
  const setIcon = async (absRoot, rel, kind, value, color) =>
    withLock(`icons:${absRoot}`, async () => {
      const map = await readIconMap(absRoot);
      if (!value) delete map[rel];   // 空值 = 恢复默认图标
      else map[rel] = color ? { kind, value, color } : { kind, value };
      await writeIconMap(absRoot, map);
    });

  // ---- 手动排序（#6）----
  // 顺序记在 <库>/.order/_index.json，按相对路径索引：
  //   { "<rel>": <同级内的序号> }
  // 为什么照抄 .icons 的形状而不是塞进 .icons/：两套各管各的，
  // 图标那条路一行都不用改。要改名成 .meta 就得写迁移 + 动一堆引用，不划算。
  // 为什么不进 frontmatter：排序是**侧栏的呈现顺序**，不是文档内容，
  // 而 .md 是用户的笔记，不该被我们塞元数据（还会和 Milkdown 的解析打架）。
  // ⚠️ 序号是**同级内**的：{"笔记A": 0, "子目录/笔记B": 5} 里那两个数互不相干。
  // 删掉中间一个不重排，留空洞按值排即可（holey sort）。
  const ORDER_DIR = ".order";
  const ORDER_INDEX = "_index.json";

  const orderRoot = (absRoot) => path.join(absRoot, ORDER_DIR);

  const readOrderMap = async (absRoot) => {
    try {
      const raw = await fs.readFile(path.join(orderRoot(absRoot), ORDER_INDEX), "utf-8");
      const j = JSON.parse(raw);
      const m = j && typeof j.order === "object" && j.order ? j.order : {};
      // 只留是有限非负整数的键：这份文件用户可能手改过，别让脏数据渗进排序
      const out = {};
      for (const [rel, n] of Object.entries(m)) {
        if (Number.isInteger(n) && n >= 0) out[rel] = n;
      }
      return out;
    } catch {
      return {};
    }
  };

  const writeOrderMap = async (absRoot, map) => {
    await fs.mkdir(orderRoot(absRoot), { recursive: true });
    await fs.writeFile(path.join(orderRoot(absRoot), ORDER_INDEX),
      JSON.stringify({ order: map }, null, 2));
  };

  /* 和 listIcons 一样顺手清孤儿键：用户可以直接在 Finder 里删/移文件，
     索引里的键不清理会一直攒着。 */
  const listOrder = async (absRoot) => {
    const map = await readOrderMap(absRoot);
    const out = {};
    let dirty = false;
    for (const [rel, n] of Object.entries(map)) {
      const abs = safeJoin(absRoot, rel);
      if (abs && await fs.stat(abs).then(() => true, () => false)) out[rel] = n;
      else dirty = true;
    }
    if (dirty) {
      for (const rel of Object.keys(map)) if (!(rel in out)) delete map[rel];
      await writeOrderMap(absRoot, map);
    }
    return out;
  };

  /* 写一层的顺序。前端把「这一层拖完之后的 rel 数组」整份发过来，
     服务端只把序号写进去 —— 不做增量 diff：
     一次拖动改的是**整层**的序号，逐条增量的话中途失败会留下半套序号，
     而顺序本来就是「以最后一次为准」的整份数据，重算一遍反而更不容易错。 */
  /* 整个读-改-写都在锁里。多窗口同时拖不同层级时，
     两边各自拿到锁依次执行，后一个读到的是前一个**写完之后**的表，不会覆盖。 */
  const setOrder = async (absRoot, rels) => withLock(`order:${absRoot}`, async () => {
    const map = await readOrderMap(absRoot);
    for (const rel of rels) {
      const abs = safeJoin(absRoot, rel);
      if (!abs || abs === absRoot) continue;
      map[rel] = rels.indexOf(rel);
    }
    await writeOrderMap(absRoot, map);
    return map;
  });

  /* 移动 / 改名时把排序键一起搬走。顺序是按 rel 索引的，
     键不搬的话条目会变成孤儿（下次 listOrder 当垃圾清掉），等于这一项的
     手动位置悄悄丢了。 */
  const moveOrderKey = async (absRoot, from, to) => withLock(`order:${absRoot}`, async () => {
    if (!from || !to || from === to) return;
    const map = await readOrderMap(absRoot);
    if (!(from in map)) return;
    const n = map[from];
    delete map[from];
    if (!(to in map)) map[to] = n;
    await writeOrderMap(absRoot, map);
  });

  // 重命名时把图标一起搬走，不然改名后图标就丢了
  const moveIconKey = async (absRoot, from, to) =>
    withLock(`icons:${absRoot}`, async () => {
    if (!from || from === to) return;
    const map = await readIconMap(absRoot);
    if (!(from in map)) return;
    map[to] = map[from];
    delete map[from];
    await writeIconMap(absRoot, map);
  });

  /* 和 moveIconKey 一个区别：**前缀整棵换**。
     搬/改名一个目录时，里面每一项的图标键都带着旧前缀，只换顶层那一个的话
     子树的图标全成孤儿（下次 listIcons 当垃圾清掉），那一堆文件的图标就没了。
     改名单个文件时 from 后面带不上 "/"，这个函数就退化成 moveIconKey。 */
  const moveIconTree = async (absRoot, from, to) => {
    if (!from || from === to) return;
    const map = await readIconMap(absRoot);
    const pre = from + "/";
    const next = {};
    let touched = false;
    for (const [k, v] of Object.entries(map)) {
      if (k === from) { next[to] = v; touched = true; }
      else if (k.startsWith(pre)) { next[to + k.slice(from.length)] = v; touched = true; }
      else next[k] = v;
    }
    if (touched) await writeIconMap(absRoot, next);
  };

  // 删除（进回收站）时直接丢掉图标：不跟着搬到 .trash/ 下面，
  // 否则 listIcons 的「路径必须存在」会把它们当孤儿清掉，恢复回来也没图标了
  const dropIconKey = async (absRoot, rel) => {
    const map = await readIconMap(absRoot);
    if (!(rel in map)) return;
    delete map[rel];
    await writeIconMap(absRoot, map);
  };

  try {
    // ---- 知识库 API ----
    /* 首启引导用。**只读，不写任何东西** —— 用户看完直接关窗的话，
       磁盘上还是原样，下次启动接着问。 */
    if (p === "/api/setup" && req.method === "GET") {
      return send(200, JSON.stringify(await setupInfo()));
    }

    if (p === "/api/roots" && req.method === "GET") {
      const list = [];
      for (let i = 0; i < ROOTS.length; i++) {
        let exists = false;
        try { exists = (await fs.stat(ROOTS[i])).isDirectory(); } catch {}
        list.push({ i, name: path.basename(ROOTS[i]) || ROOTS[i], path: ROOTS[i], exists,
                    icon: ROOT_ICONS[ROOTS[i]] || null });
      }
      return send(200, JSON.stringify(list));
    }

    if (p === "/api/roots" && req.method === "POST") {
      if (SINGLE_ROOT) return send(400, JSON.stringify({ error: "独立模式不支持在线添加知识库" }));
      const body = JSON.parse((await readBody(req)) || "{}");
      const abs = path.resolve(expandHome(body.path || ""));
      if (!abs || abs === "/") return send(400, JSON.stringify({ error: "非法目录" }));
      await fs.mkdir(abs, { recursive: true });
      if (!ROOTS.includes(abs)) ROOTS.push(abs);
      await saveRoots();
      return send(200, JSON.stringify({ ok: true, path: abs, i: ROOTS.indexOf(abs) }));
    }

    if (p === "/api/roots" && req.method === "DELETE") {
      const abs = rootStrict(url.searchParams.get("root"));
      if (!SINGLE_ROOT && ROOTS.length <= 1) return send(400, JSON.stringify({ error: "至少保留一个知识库" }));
      const j = ROOTS.indexOf(abs);
      if (j < 0) return send(404, JSON.stringify({ error: "未知知识库" }));
      ROOTS.splice(j, 1);
      delete ROOT_ICONS[abs];
      if (!SINGLE_ROOT) await saveRoots();
      return send(200, JSON.stringify({ ok: true, roots: ROOTS }));
    }

    // 知识库图标：{ root, kind: "emoji" | "svg", value, color }，value 空 = 恢复默认书本
    // 校验规则和 /api/icons 那条一致（同一套图标目录，key 字符集必须一样）
    if (p === "/api/roots/icon" && req.method === "POST") {
      if (SINGLE_ROOT) return send(400, JSON.stringify({ error: "独立模式不支持修改知识库图标" }));
      const body = JSON.parse((await readBody(req)) || "{}");
      const abs = rootStrict(body.root);
      if (!abs) return send(400, JSON.stringify({ error: "未知知识库" }));
      const kind = body.kind === "svg" ? "svg" : "emoji";
      const value = String(body.value || "");
      const color = kind === "svg" ? String(body.color || "") : "";
      if (color && !/^[a-z][a-z0-9-]{0,15}$/.test(color)) {
        return send(400, JSON.stringify({ error: "颜色标识不合法" }));
      }
      if (value && kind === "svg" && !/^[A-Za-z][\w-]{0,39}$/.test(value)) {
        return send(400, JSON.stringify({ error: "图标标识不合法" }));
      }
      if (value && kind === "emoji" && [...value].length > 4) {
        return send(400, JSON.stringify({ error: "只支持单个 emoji" }));
      }
      if (value) ROOT_ICONS[abs] = color ? { kind, value, color } : { kind, value };
      else delete ROOT_ICONS[abs];
      await saveRoots();
      return send(200, JSON.stringify({ ok: true, icon: ROOT_ICONS[abs] || null }));
    }

    // ---- 文件 API（带 root 参数）----
    if (p === "/api/tree" && req.method === "GET") {
      const abs = rootFromParam(url.searchParams.get("root"));
      if (!abs) return send(404, JSON.stringify({ error: "未知知识库" }));
      return send(200, JSON.stringify({ root: abs, ...(await scan(abs)) }));
    }

    if (p === "/api/file" && req.method === "GET") {
      const absRoot = rootFromParam(url.searchParams.get("root"));
      if (!absRoot) return send(400, badRoot(url.searchParams.get("root")));
      const relParam = url.searchParams.get("path") || "";
      const abs = safeJoin(absRoot, relParam);
      if (!abs) return send(400, badPath(relParam));
      let content;
      try { content = await fs.readFile(abs, "utf8"); }
      catch { return send(404, JSON.stringify({ error: "文件不存在" })); }
      // 带 mtime 回去：客户端保存时把它当 baseMtime 送回来，服务端比对。
      // 没有这个的话两个窗口开同一篇就是**静默覆盖**（见 PUT 那段注释）。
      let mtime = 0;
      try { mtime = Math.floor((await fs.stat(abs)).mtimeMs); } catch { /* 读到了但 stat 不到，存 0 表示「未知」 */ }
      return send(200, JSON.stringify({ root: absRoot, path: url.searchParams.get("path"), content, mtime }));
    }

    if (p === "/api/file" && req.method === "PUT") {
      const absRoot = rootStrict(url.searchParams.get("root"));
      const rel = url.searchParams.get("path") || "";
      if (!absRoot) return send(400, badRoot(url.searchParams.get("root")));
      const abs = safeJoin(absRoot, rel);
      if (!abs) return send(400, badPath(rel));
      /* 乐观锁：客户端带上它**读到时**的 mtime，对不上就是有人在这之后改过。
         没有这层的话，两个窗口开同一篇，后写的把前一个静默覆盖 ——
         没有提示、没有撤销、连「已保存」都照常显示。
         （模式照抄下面 POST /api/move 的 409 不覆盖检查。）
         baseMtime 为 0 或缺省 = 客户端不参与这个检查（新建、或旧客户端）。 */
      const baseMtime = Number(url.searchParams.get("baseMtime") || 0);
      if (baseMtime > 0) {
        let cur = 0;
        try { cur = Math.floor((await fs.stat(abs)).mtimeMs); } catch { cur = 0; }
        if (cur !== baseMtime) {
          return send(409, JSON.stringify({
            error: "文件已被其它地方修改",
            currentMtime: cur,
            // 带上磁盘现状，让客户端不必再拉一次就能展示「对方改成了什么」
            currentContent: await fs.readFile(abs, "utf8").catch(() => null),
          }));
        }
      }
      const content = await readBody(req);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, "utf8");
      const mtime = Math.floor((await fs.stat(abs)).mtimeMs);
      // 把新 mtime 回给客户端：它要更新自己的 baseMtime，否则下次保存必然又 409
      return send(200, JSON.stringify({ ok: true, path: rel, mtime }));
    }

    if (p === "/api/file" && req.method === "POST") {
      // 新建：{ root, path, content? }
      const body = JSON.parse((await readBody(req)) || "{}");
      const absRoot = rootStrict(body.root);
      const abs = absRoot && safeJoin(absRoot, body.path || "");
      if (!abs) return send(400, JSON.stringify({ error: "非法路径" }));
      if (path.extname(abs).toLowerCase() !== ".md") return send(400, JSON.stringify({ error: "只能创建 .md 文件" }));
      await fs.mkdir(path.dirname(abs), { recursive: true });
      const existed = await fs.access(abs).then(() => true, () => false);
      if (!existed) await fs.writeFile(abs, body.content ?? "", "utf8");
      return send(200, JSON.stringify({ ok: true, path: body.path }));
    }

    if (p === "/api/mkdir" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const absRoot = rootStrict(body.root);
      const abs = absRoot && safeJoin(absRoot, body.path || "");
      if (!abs) return send(400, JSON.stringify({ error: "非法路径" }));
      await fs.mkdir(abs, { recursive: true });
      return send(200, JSON.stringify({ ok: true }));
    }

    // 删除 = 移进回收站（<库>/.trash/），不是真删；真删走 /api/trash 的 purge
    if (p === "/api/file" && req.method === "DELETE") {
      const absRoot = rootStrict(url.searchParams.get("root"));
      const rel = url.searchParams.get("path") || "";
      const abs = absRoot && safeJoin(absRoot, rel);
      if (!abs || abs === absRoot) return send(400, JSON.stringify({ error: "非法路径" }));
      const st = await fs.stat(abs).catch(() => null);
      if (!st) return send(404, JSON.stringify({ error: "文件不存在" }));
      const trashRel = await moveToTrash(absRoot, rel, st.isDirectory());
      await dropIconKey(absRoot, rel);   // 进回收站就丢掉图标（理由见 dropIconKey）
      return send(200, JSON.stringify({ ok: true, trash: trashRel }));
    }

    // ---- 回收站 ----
    if (p === "/api/trash" && req.method === "GET") {
      const absRoot = rootFromParam(url.searchParams.get("root"));
      if (!absRoot) return send(400, JSON.stringify({ error: "非法知识库" }));
      return send(200, JSON.stringify({ items: await listTrash(absRoot) }));
    }

    // 读回收站里某个文件的正文（预览用）。
    // 只读：这个端点只 GET，没有对应的 PUT/POST —— 回收站里的东西只能通过
    // restore 回到原位之后再改，从这里读到的内容一律不写回 .trash/。
    // safeJoin 的根换成 .trash/，所以 trashRel 里带 ../ 也出不去。
    if (p === "/api/trash/file" && req.method === "GET") {
      const absRoot = rootFromParam(url.searchParams.get("root"));
      if (!absRoot) return send(400, JSON.stringify({ error: "非法知识库" }));
      const trashRel = url.searchParams.get("trashRel") || "";
      const abs = safeJoin(trashRoot(absRoot), trashRel);
      if (!abs) return send(400, JSON.stringify({ error: "非法路径" }));
      // 目录进不去（回收站里也存了文件夹）
      let content;
      try { content = await fs.readFile(abs, "utf8"); }
      catch { return send(404, JSON.stringify({ error: "文件不存在" })); }
      return send(200, JSON.stringify({ root: absRoot, trashRel, content }));
    }

    if (p === "/api/trash/restore" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const absRoot = rootStrict(body.root);
      if (!absRoot) return send(400, JSON.stringify({ error: "非法知识库" }));
      const ok = await restoreFromTrash(absRoot, body.trashRel || "");
      if (!ok) return send(400, JSON.stringify({ error: "恢复失败" }));
      return send(200, JSON.stringify({ ok: true, rel: body.rel }));
    }

    if (p === "/api/trash/purge" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const absRoot = rootStrict(body.root);
      if (!absRoot) return send(400, JSON.stringify({ error: "非法知识库" }));
      const rel = body.trashRel || "";
      if (body.all) await emptyTrash(absRoot);
      else await purgeFromTrash(absRoot, rel);
      return send(200, JSON.stringify({ ok: true }));
    }

    if (p === "/api/rename" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const absRoot = rootStrict(body.root);
      const from = absRoot && safeJoin(absRoot, body.from || "");
      const to = absRoot && safeJoin(absRoot, body.to || "");
      if (!from || !to || to === absRoot) return send(400, JSON.stringify({ error: "非法路径" }));
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.rename(from, to);
      await moveIconTree(absRoot, body.from || "", body.to || "");   // 图标跟着改名一起搬（子树连前缀一起换）
      await moveOrderKey(absRoot, body.from || "", body.to || "");  // 排序也跟着搬（#6）
      return send(200, JSON.stringify({ ok: true, to: body.to }));
    }

    /* ---- 移动文件 / 文件夹（#6 的跨层级拖放）----
       拖到**别的文件夹**里去就是真的搬文件，这条路比「换图标」重得多：
         · 得写盘（fs.rename），排序键和图标键都得跟着搬
         · 目标可能已经有同名的东西 → 必须拦，不能默默覆盖
       同级拖动不走这里（只改 .order，文件不动）。
       目录整棵搬过去，所以要连带把**子树里每一项**的排序键都改前缀。
    */
    if (p === "/api/move" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const absRoot = rootStrict(body.root);
      const fromRel = String(body.from || "");
      const from = absRoot && safeJoin(absRoot, fromRel);
      const toRel = String(body.to || "");
      const to = absRoot && safeJoin(absRoot, toRel);
      if (!from || !to || from === absRoot || to === absRoot) {
        return send(400, JSON.stringify({ error: "非法路径" }));
      }
      if (!(await fs.stat(from).then(() => true, () => false))) {
        return send(404, JSON.stringify({ error: "源不存在" }));
      }
      // 目标已存在：绝不覆盖。这条是搬文件，不是保存，后者才是覆盖语义。
      if (await fs.stat(to).then(() => true, () => false)) {
        return send(409, JSON.stringify({ error: "目标位置已有同名文件" }));
      }
      // 搬进自己的子目录 = 会把目录搬进它自己，直接拦（否则 fs.rename 报 ENOTEMPTY）
      const fromPrefix = fromRel + "/";
      if (toRel === fromRel || toRel.startsWith(fromPrefix)) {
        return send(400, JSON.stringify({ error: "不能移进它自己里面" }));
      }
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.rename(from, to);
      await moveIconTree(absRoot, fromRel, toRel);      // 图标跟着搬（子树连前缀一起换）
      // 排序键同理：目录是整棵搬的，子树里每一项的前缀都要换
      const om = await readOrderMap(absRoot);
      const next = {};
      let touched = false;
      const pre = fromRel + "/";
      for (const [k, v] of Object.entries(om)) {
        if (k === fromRel) { next[toRel] = v; touched = true; }
        else if (k.startsWith(pre)) { next[toRel + k.slice(fromRel.length)] = v; touched = true; }
        else next[k] = v;
      }
      if (touched) await writeOrderMap(absRoot, next);
      return send(200, JSON.stringify({ ok: true, to: toRel }));
    }

    // ---- 手动排序（#6）----
    if (p === "/api/order" && req.method === "GET") {
      const absRoot = rootFromParam(url.searchParams.get("root"));
      if (!absRoot) return send(400, JSON.stringify({ error: "非法知识库" }));
      return send(200, JSON.stringify({ order: await listOrder(absRoot) }));
    }

    if (p === "/api/order" && req.method === "POST") {
      // { root, order: ["a/b.md", "a/c.md"] } —— 一层拖完之后的完整顺序
      const body = JSON.parse((await readBody(req)) || "{}");
      const absRoot = rootStrict(body.root);
      if (!absRoot) return send(400, JSON.stringify({ error: "非法知识库" }));
      const rels = Array.isArray(body.order) ? body.order.map(String) : [];
      if (rels.length > 5000) return send(400, JSON.stringify({ error: "条目过多" }));
      return send(200, JSON.stringify({ ok: true, order: await setOrder(absRoot, rels) }));
    }

    // ---- 自定义图标 ----
    if (p === "/api/icons" && req.method === "GET") {
      const absRoot = rootFromParam(url.searchParams.get("root"));
      if (!absRoot) return send(400, JSON.stringify({ error: "非法知识库" }));
      return send(200, JSON.stringify({ icons: await listIcons(absRoot) }));
    }

    if (p === "/api/icons" && req.method === "POST") {
      // { root, rel, kind: "emoji" | "svg", value, color }
      // value 为空 = 恢复默认图标；color 为空 = 跟随主题
      const body = JSON.parse((await readBody(req)) || "{}");
      const absRoot = rootStrict(body.root);
      if (!absRoot) return send(400, JSON.stringify({ error: "非法知识库" }));
      const rel = String(body.rel || "");
      const abs = safeJoin(absRoot, rel);
      if (!abs || abs === absRoot) return send(400, JSON.stringify({ error: "非法路径" }));
      const kind = body.kind === "svg" ? "svg" : "emoji";
      const value = String(body.value || "");
      // emoji 是彩色字形，配色没意义，直接丢掉
      const color = kind === "svg" ? String(body.color || "") : "";
      if (color && !/^[a-z][a-z0-9-]{0,15}$/.test(color)) {
        return send(400, JSON.stringify({ error: "颜色标识不合法" }));
      }
      if (value && kind === "svg" && !/^[A-Za-z][\w-]{0,39}$/.test(value)) {
        return send(400, JSON.stringify({ error: "图标标识不合法" }));
      }
      // emoji 可能是组合序列（ZWJ / 变体选择符），按码点算，放行 4 个
      if (value && kind === "emoji" && [...value].length > 4) {
        return send(400, JSON.stringify({ error: "只支持单个 emoji" }));
      }
      await setIcon(absRoot, rel, kind, value, color);
      return send(200, JSON.stringify({ ok: true, icons: await readIconMap(absRoot) }));
    }

    // ---- 静态资源（dist/）----
    if (p === "/" || p === "/index.html") {
      return send(200, await fs.readFile(path.join(STATIC_DIR, "index.html")), "text/html; charset=utf-8");
    }
    if (p.startsWith("/")) {
      const abs = path.join(STATIC_DIR, path.normalize(p));
      if (abs.startsWith(STATIC_DIR + path.sep)) {
        try {
          const type = abs.endsWith(".css") ? "text/css; charset=utf-8"
            : abs.endsWith(".js") ? "text/javascript; charset=utf-8"
            : abs.endsWith(".svg") ? "image/svg+xml"
            : abs.endsWith(".json") ? "application/json"
            : "text/plain; charset=utf-8";
          res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
          return send(200, await fs.readFile(abs), type);
        } catch { return send(404, "not found"); }
      }
    }
    return send(404, "not found");
  } catch (e) {
    return send(500, JSON.stringify({ error: String(e) }));
  }
});

await loadRoots();
// 只监听回环地址。这个 API 没有鉴权（本机应用不需要），
// 绑到 0.0.0.0 就等于把整个知识库的读写权交给同一 Wi-Fi 下的任何人。
server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  Blanc 已启动（${SINGLE_ROOT ? "独立模式" : "多知识库模式"}）`);
  for (const r of ROOTS) console.log(`  📚 ${r}`);
  console.log(`  打开: http://localhost:${PORT}/\n`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n  ✗ 端口 ${PORT} 已被占用。停掉旧实例：lsof -ti :${PORT} | xargs kill\n  或换端口：PORT=${PORT + 1} node server.mjs\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
