/* 侧栏目录树的「上次看到的快照」。
 *
 * 为什么：启动时 /api/tree 要现扫磁盘 —— 目录被 TCC 拦着、库在网盘上、
 * 或者单纯文件多的时候要几百毫秒到几秒，这段时间侧栏是空的，用户看到的是
 * 「应用开了，但我的笔记一篇都不见了」。有了这份缓存，先按上次的样子画出来，
 * 真实扫描回来再替换（stale-while-revalidate）—— 错了也就是某个刚删的文件
 * 多显示一下，点开会走现有的「文件打不开」提示，不会丢数据。
 *
 * 只缓存树和排序表，不缓存正文；按知识库**绝对路径**分键，换库/换机器自然失效。
 * localStorage 在 Tauri 的各个 webview 之间是共享的（见 App.jsx 的说明），
 * 所以文档窗口顺手写进来也无妨 —— 键是同一个。
 */
const PREFIX = "blanc:tree:v1:";
/* localStorage 配额通常 5MB（UTF-16 下约 250 万字符）。写爆会把同域下
 * 的 blanc-ui 偏好一起挤掉，所以超大库干脆不缓存，只是没这个加速而已。 */
const MAX_CHARS = 2_000_000;

const keyOf = (root) => PREFIX + root;

export function readTreeCache(root) {
  if (!root) return null;
  try {
    const raw = localStorage.getItem(keyOf(root));
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || v.v !== 1 || !v.tree || !Array.isArray(v.tree.folders) || !Array.isArray(v.tree.files)) {
      return null;
    }
    return { tree: v.tree, order: v.order || {} };
  } catch {
    return null;
  }
}

export function writeTreeCache(root, tree, order) {
  if (!root || !tree) return;
  try {
    const raw = JSON.stringify({ v: 1, at: Date.now(), tree, order: order || {} });
    if (raw.length > MAX_CHARS) { localStorage.removeItem(keyOf(root)); return; }
    localStorage.setItem(keyOf(root), raw);
  } catch {
    /* 配额满 / 隐私模式：缓存只是加速，写不进去就算 */
  }
}

/* 知识库被移除时清掉它那份，别在 localStorage 里留一堆没人读的路径。 */
export function dropTreeCache(root) {
  try { localStorage.removeItem(keyOf(root)); } catch {}
}
