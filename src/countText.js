/* 字数 / 词数 / 字符数。中英混排：CJK 逐字算一个词，拉丁与数字按词边界切。
   先把 Markdown 的标记符剔掉再数，否则 `#`、`**`、`-` 这些语法符号会被算进去。
   这是阅读量级的近似值，不是排版引擎那套精确计数（要精确得把 AST 渲染成纯文本再数）。

   ⚠️ 为什么单独一个文件（2026-10-21）：`App.jsx` 要它算首屏那一次字数，而它原来住在
   `EditorPane.jsx` 里。App 静态 import 那个文件 → 整个 Milkdown/Crepe（2MB 里的 ~83%）
   被拽回首屏关键路径，编辑器就懒加载不起来了。这里只有十几个字节的正则，谁引都不亏。 */
export function countText(md) {
  const text = String(md || "")
    .replace(/^```.*$/gm, "")          // 代码围栏
    .replace(/^#{1,6}\s+/gm, "")       // 标题井号
    .replace(/^\s*[-*+]\s+/gm, "")     // 无序列表符号
    .replace(/^\s*\d+\.\s+/gm, "")     // 有序列表序号
    .replace(/^>\s?/gm, "")            // 引用符号
    .replace(/[*_~`]/g, "")            // 行内强调 / 代码的标记符
    .replace(/\]\([^)]*\)/g, "]");     // 链接只留文字，丢掉 URL
  const cjk = (text.match(/[㐀-鿿豈-﫿぀-ヿ]/g) || []).length;
  const latin = (text.replace(/[㐀-鿿豈-﫿぀-ヿ]/g, " ")
                      .match(/[A-Za-z0-9_'’-]+/g) || []).length;
  return { words: cjk + latin, chars: text.length, charsNoSpace: text.replace(/\s/g, "").length };
}
