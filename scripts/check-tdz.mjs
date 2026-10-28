/* TDZ 检查：`const` / `let` 在声明之前就被用到。
 *
 * 背景：这个坑本项目栽了**两次**，都是同一个：
 *   ① `useEffect(() => {...}, [someRef])` 的依赖数组引用了它**下面**才声明的 const
 *   ② `useCallback(fn, [sortedTree])` —— sortedTree 声明在下面 300 行
 *
 * 为什么会炸：`useCallback` / `useMemo` / `useEffect` 的**依赖数组是在渲染时求值**的，
 * 也就是组件函数体自上而下执行到那一行就求值。引用还没初始化的 const →
 * `ReferenceError: Cannot access 'x' before initialization` → ErrorBoundary 接管 → 白屏。
 *
 * ⚠️ `vite build` **抓不到**（未知标识符按全局放过），`check-undeclared-idents.mjs`
 * 也抓不到（它按「全文有没有这个名字」判定，而 TDZ 的名字确实声明了，只是太晚）。
 *
 * 做法：每个函数体（含模块顶层）收集**直属**的 const/let 及其行号，
 * 再扫该函数内所有引用；引用行 < 声明行 → 报。
 *
 * 保守取舍（会有假阳性，但方向是对的）：
 *   · `var` 和函数声明会提升，不查（那两种写法本来就没事）。
 *   · 「先声明一个函数、函数体里引用后面才声明的 const」也会报。
 *     运行时不一定炸（要等函数被调用），但在 React 里回调基本都是渲染期跑的，
 *     当它是错误更省事。假阳性的修法通常是「把声明往上挪」，而那本来也是对的。
 */
import { readFileSync, readdirSync } from "node:fs";
import { parse } from "@babel/parser";

const files = readdirSync("src")
  .filter((f) => /\.jsx?$/.test(f))
  .map((f) => `src/${f}`);

const problems = [];

for (const f of files) {
  const src = readFileSync(f, "utf-8");
  let ast;
  try {
    ast = parse(src, { sourceType: "module", plugins: ["jsx"], errorRecovery: true });
  } catch (e) {
    problems.push(`${f}  解析失败：${e.message}`);
    continue;
  }

  const walk = (node, cb, parent = null, key = null) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach((c) => walk(c, cb, parent, key)); return; }
    if (typeof node.type !== "string") return;
    cb(node, parent, key);
    for (const k of Object.keys(node)) {
      if (["type", "start", "end", "loc", "range", "leadingComments", "trailingComments"].includes(k)) continue;
      walk(node[k], cb, node, k);
    }
  };

  /* 这个函数体直属的 const/let：name -> 声明行。
     只看**直属**的（body 的直接子语句），嵌套函数自己算一个作用域。 */
  const ownDecls = (fn) => {
    const body = fn.type === "Program" ? fn.body : fn.body && fn.body.body;
    if (!Array.isArray(body)) return new Map();
    const out = new Map();
    for (const st of body) {
      if (st.type !== "VariableDeclaration" || st.kind === "var") continue;
      const line = st.loc?.start?.line ?? 0;
      for (const d of st.declarations) {
        const id = d.id;
        if (id.type === "Identifier") { if (!out.has(id.name)) out.set(id.name, line); }
        else {
          // 解构 const { a, b } = …
          const pat = (n) => {
            if (!n) return;
            if (n.type === "Identifier") { if (!out.has(n.name)) out.set(n.name, line); }
            else if (n.type === "ObjectPattern") n.properties.forEach((p) => pat(p.type === "RestElement" ? p.argument : p.value));
            else if (n.type === "ArrayPattern") n.elements.forEach(pat);
            else if (n.type === "AssignmentPattern") pat(n.left);
            else if (n.type === "RestElement") pat(n.argument);
          };
          pat(id);
        }
      }
    }
    return out;
  };

  const isFnNode = (n) => n.type === "FunctionDeclaration" || n.type === "FunctionExpression"
    || n.type === "ArrowFunctionExpression";

  /* 只收**同一个函数体直线代码里**的引用（不下钻进嵌套函数体）。
     这条限制是准确性的关键：
       · 模块级 `const foo` 被后面的函数引用 —— 安全，模块体自上而下跑完才有人调它
       · `const f = () => g(); const g = () => {}` —— 安全，f 要等调用才跑
       · 但 `useCallback(fn, [late])` 的**依赖数组是渲染期求值的**，
         它就在直线代码里 —— 这才是真会炸的那一种，也正是本项目栽过的两次。
     块（if / for / try）里的要收：那些也是渲染期跑的。 */
  const refsIn = (fn) => {
    const out = [];
    const root = fn.type === "Program" ? fn : (fn.body && fn.body.type === "BlockStatement" ? fn.body : null);
    if (!root) return out;
    const visit = (node, parent, key) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { node.forEach((c) => visit(c, parent, key)); return; }
      if (typeof node.type !== "string") return;
      // 嵌套函数：只看参数**默认值**里的引用（`(x = laterConst) => …` 也在渲染期求值），
      // 参数名本身和函数体都不算 —— 参数名是绑定不是引用（`forEach((node, off) => …)`
      // 那个 node 曾被当成引用报过一次假阳性），函数体里的引用要等它被调用，
      // 那时外层早就跑完了。
      if (isFnNode(node) && node !== fn) {
        for (const prm of node.params || []) {
          if (prm.type === "AssignmentPattern") visit(prm.right, prm, "right");
        }
        return;
      }
      if (node.type === "Identifier") {
        let skip = false;
        if (parent) {
          if (parent.type === "VariableDeclarator" && parent.id === node) skip = true;
          if (parent.id === node && (isFnNode(parent) || parent.type === "ClassDeclaration"
            || parent.type === "ClassExpression")) skip = true;
          if (parent.type === "ImportSpecifier" || parent.type === "ImportDefaultSpecifier"
            || parent.type === "ImportNamespaceSpecifier") skip = true;
          if (parent.type === "ImportDeclaration") skip = true;
          if ((parent.type === "ObjectProperty" || parent.type === "ObjectMethod"
            || parent.type === "ClassProperty" || parent.type === "ClassMethod") && parent.key === node) {
            if (!parent.computed && !parent.shorthand) skip = true;
          }
          if ((parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression")
            && parent.property === node && !parent.computed) skip = true;
          if ((parent.type === "JSXOpeningElement" || parent.type === "JSXClosingElement") && parent.name === node) skip = true;
          if (parent.type === "JSXMemberExpression" && parent.property === node) skip = true;
          if (parent.type === "ObjectPattern" && key === "key") skip = true;
          if (parent.type === "CatchClause" && parent.param === node) skip = true;
        }
        if (!skip) out.push({ name: node.name, line: node.loc?.start?.line ?? 0 });
      }
      for (const k of Object.keys(node)) {
        if (["type", "start", "end", "loc", "range", "leadingComments", "trailingComments"].includes(k)) continue;
        visit(node[k], node, k);
      }
    };
    const stmts = (fn.type === "Program" ? root : root.body) || [];
    (Array.isArray(stmts) ? stmts : [stmts]).forEach((st) => visit(st, null, null));
    return out;
  };

  // 逐个函数体检查
  const check = (fn) => {
    const own = ownDecls(fn);
    if (!own.size) return;
    for (const r of refsIn(fn)) {
      const decl = own.get(r.name);
      if (decl === undefined || decl <= r.line) continue;
      problems.push(`${f}:${r.line}  ${r.name}  (第 ${decl} 行才声明，引用在它前面 → 运行时 TDZ)`);
    }
  };

  walk(ast.program, (node) => { if (isFnNode(node) || node.type === "Program") check(node); });
}

if (problems.length) {
  console.error("❌ const/let 在声明之前就被引用（构建抓不到，浏览器里会 Cannot access ... before initialization）：");
  for (const p of [...new Set(problems)].slice(0, 60)) console.error("   " + p);
  if (problems.length > 60) console.error(`   …还有 ${problems.length - 60} 条`);
  process.exit(1);
}
console.log(`✓ ${files.length} 个文件，没有 TDZ 引用`);