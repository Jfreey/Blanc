/* 未声明 / 未导入标识符检查。
 *
 * 背景：这个项目里 **构建抓不到**这类错误。rolldown 把未知标识符当全局变量放过，
 * `npm run build` 一路绿灯，直到浏览器里求值那一刻才
 * `ReferenceError: X is not defined` —— 轻则功能坏掉，重则整页白屏。
 * 本轮已经踩了五次：
 *   ① useCallback 用了没导入   ② PluginKey 用了没导入
 *   ③ propsToRows 用了没导入   ④ useEffect 的依赖数组引用了它上面还没声明的 const（TDZ）
 *   ⑤ isEmptyVal 在一次文本替换里被连带删掉，组件体内还在引用
 * ①②③ 是「模块顶层用了没导入的」，用正则就能查；
 * ④⑤ 是「作用域内引用了根本没声明的」，正则查不出来 —— 必须真的解析。
 *
 * 做法：用 @babel/parser 解析（node_modules 里已有，是 @vitejs/plugin-react 的依赖），
 * 手工走一遍 AST：
 *   - declared = 全文所有声明（变量/函数/类/参数/解构/import）
 *   - referenced = 真正的「取值位置」的 Identifier，排除：
 *       声明本身的 id、对象字面量的键（`{a: 1}` 的 a）、非计算的属性访问（`o.a`）、
 *       JSX 标签名（小写开头的 `div`/`span`）
 *   - 报 referenced − declared − 全局
 *
 * declared 采取**全文过度近似**（不管作用域）：只关心「这个名字在这个文件里
 * 到底存不存在」，不追求精确的跨作用域解析。代价是同一个名字在两个互不可见的
 * 作用域各声明一次不会报 —— 那是罕见情况，认了。
 */
import { readFileSync, readdirSync } from "node:fs";
import { parse } from "@babel/parser";
import { GLOBALS } from "./globals.mjs";



const files = readdirSync("src")
  .filter((f) => /\.jsx?$/.test(f))
  .map((f) => `src/${f}`);

const problems = [];

// JSX 标签：小写开头的是内置元素（div/span/…），大写的是组件引用
const isJsxTagName = (node, parentIsOpening) =>
  node && node.type === "JSXIdentifier";

for (const f of files) {
  const src = readFileSync(f, "utf-8");
  let ast;
  try {
    ast = parse(src, {
      sourceType: "module",
      plugins: ["jsx"],
      errorRecovery: true,
    });
  } catch (e) {
    problems.push(`${f}  解析失败：${e.message}`);
    continue;
  }

  const declared = new Set(GLOBALS);

  // --- 先收集所有声明 ---
  const addPattern = (n) => {
    if (!n) return;
    if (n.type === "Identifier") declared.add(n.name);
    else if (n.type === "ObjectPattern") n.properties.forEach((p) =>
      addPattern(p.type === "RestElement" ? p.argument : p.value));
    else if (n.type === "ArrayPattern") n.elements.forEach(addPattern);
    else if (n.type === "AssignmentPattern") addPattern(n.left);
    else if (n.type === "RestElement") addPattern(n.argument);
  };

  const walk = (node, cb, parent = null, key = null) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach((c) => walk(c, cb, parent, key)); return; }
    if (typeof node.type !== "string") return;
    cb(node, parent, key);
    for (const k of Object.keys(node)) {
      if (k === "type" || k === "start" || k === "end" || k === "loc" || k === "range" || k === "leadingComments" || k === "trailingComments") continue;
      walk(node[k], cb, node, k);
    }
  };

  walk(ast.program, (node) => {
    switch (node.type) {
      case "VariableDeclarator": addPattern(node.id); break;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
      case "ClassDeclaration":
      case "ClassExpression":
        if (node.id) declared.add(node.id.name);
        (node.params || []).forEach(addPattern);
        break;
      case "ImportSpecifier":
      case "ImportDefaultSpecifier":
      case "ImportNamespaceSpecifier":
        declared.add(node.local.name);
        break;
      case "CatchClause":
        addPattern(node.param);
        break;
      case "ClassMethod":
      case "ClassPrivateMethod":
      case "ObjectMethod":
        if (node.key && !node.computed && node.key.type === "Identifier") declared.add(node.key.name);
        (node.params || []).forEach(addPattern);
        break;
      case "RestElement": addPattern(node.argument); break;
      case "AssignmentPattern": addPattern(node.left); break;
      case "ObjectPattern":
        node.properties.forEach((p) => addPattern(p.type === "RestElement" ? p.argument : p.value));
        break;
      case "ArrayPattern": node.elements.forEach(addPattern); break;
      default: break;
    }
  });

  // --- 再收集真正的「取值位置」 ---
  const refs = new Map(); // name -> 首个行号
  walk(ast.program, (node, parent, key) => {
    if (node.type !== "Identifier") return;
    // 声明本身
    if (parent) {
      if (parent.type === "VariableDeclarator" && parent.id === node) return;
      if ((parent.type === "FunctionDeclaration" || parent.type === "FunctionExpression"
        || parent.type === "ArrowFunctionExpression") && parent.id === node) return;
      if ((parent.type === "ClassDeclaration" || parent.type === "ClassExpression") && parent.id === node) return;
      if (parent.type === "ImportSpecifier" || parent.type === "ImportDefaultSpecifier"
        || parent.type === "ImportNamespaceSpecifier") return;
      // 对象字面量的键（非简写）不是引用
      if ((parent.type === "ObjectProperty" || parent.type === "ObjectMethod"
        || parent.type === "ClassProperty" || parent.type === "ClassMethod") && parent.key === node) {
        if (!parent.computed && !parent.shorthand) return;
      }
      // 属性访问的键不是引用
      if ((parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression")
        && parent.property === node && !parent.computed) return;
      // JSX：标签名不是普通引用（大小写都要排除）
      if (parent.type === "JSXOpeningElement" && parent.name === node) return;
      if (parent.type === "JSXClosingElement" && parent.name === node) return;
      if (parent.type === "JSXMemberExpression" && parent.property === node) return;
      // import 语句里的路径 / 关键字位置
      if (parent.type === "ImportDeclaration") return;
      // `import.meta.env` 里的 import / meta 是 MetaProperty 的一部分，不是自由引用。
      // ⚠️ 之前漏了这条：`import.meta.env.DEV` 一写，下面两条 skip 都命中不了
      //（parent 不是 ImportDeclaration，也不是 MemberExpression），
      // 于是 import 和 meta 被当成未声明标识符报出来。
      if (parent.type === "MetaProperty") return;
      // 标签模板的 tag 之外无所谓；对象 pattern 的 key
      if ((parent.type === "ObjectPattern") && key === "key") return;
    }
    if (!refs.has(node.name)) refs.set(node.name, node.loc?.start?.line ?? 0);
  });

  for (const [name, line] of refs) {
    if (declared.has(name)) continue;
    problems.push(`${f}:${line}  ${name}  (引用了但全文没有声明)`);
  }
}

if (problems.length) {
  console.error("❌ 引用了但没有声明的标识符（构建抓不到，浏览器里会 ReferenceError）：");
  for (const p of [...new Set(problems)].slice(0, 60)) console.error("   " + p);
  if (problems.length > 60) console.error(`   …还有 ${problems.length - 60} 条`);
  process.exit(1);
}
console.log(`✓ ${files.length} 个文件，没有未声明的标识符`);