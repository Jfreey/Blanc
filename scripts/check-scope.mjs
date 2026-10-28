/* 作用域检查：名字在**当前函数里**看不见。
 *
 * 为什么要有第三个检查（`check-undeclared-idents` / `check-tdz` 之外）：
 *   `check-undeclared-idents` 判的是「全文有没有这个名字」—— **过度近似**，
 *   于是漏掉一整类 bug：名字在文件**别处**声明了，但在当前函数里根本不在作用域内。
 *   实测：`TopMenu` 的 JSX 里写了 `onChange={setWideMode}`，而 TopMenu 的参数里
 *   只有 `onWide` —— `setWideMode` 是 App 里定义的，TopMenu 看不见。
 *   一开三点菜单就 ReferenceError，两个已有检查却都放行
 *   （一个认为「声明过了」，一个认为「不是 TDZ」）。
 *
 * 做法：真建作用域树。函数/模块、块、for、catch、class 体各是一个作用域；
 * `var` 和函数声明提升到最近的函数作用域，`let`/`const`/`class` 留在本块，
 * 参数和 import 归函数/模块作用域。沿作用域链往外找，找不到就报。
 *
 * 与另两个检查的分工：
 *   check-undeclared-idents —— 全文都没有（绝对错误）
 *   check-tdz               —— 声明在引用**之后**（时序错误）
 *   本脚本                  —— 有声明但**不在作用域里**（可见性错误）
 */
import { readFileSync, readdirSync } from "node:fs";
import { parse } from "@babel/parser";
import { GLOBALS } from "./globals.mjs";

const files = readdirSync("src")
  .filter((f) => /\.jsx?$/.test(f))
  .map((f) => `src/${f}`);

const problems = [];

const isFnNode = (n) => n.type === "FunctionDeclaration" || n.type === "FunctionExpression"
  || n.type === "ArrowFunctionExpression" || n.type === "ObjectMethod"
  || n.type === "ClassMethod" || n.type === "ClassPrivateMethod";
const isBlockNode = (n) => n.type === "BlockStatement" || n.type === "ForStatement"
  || n.type === "ForOfStatement" || n.type === "ForInStatement"
  || n.type === "CatchClause" || n.type === "ClassBody" || n.type === "SwitchStatement";

const mkScope = (parent, isFn) => ({ names: new Set(), parent, isFn });

/* 这个标识符是不是「取值」而不是绑定/标签 —— 排除声明 id、属性键、
   import 名、JSX 标签名、对象 pattern 的键。 */
const isReference = (node, parent, key) => {
  if (!parent) return true;
  const t = parent.type;
  if (t === "VariableDeclarator" && parent.id === node) return false;
  if ((t === "FunctionDeclaration" || t === "FunctionExpression" || t === "ArrowFunctionExpression"
    || t === "ClassDeclaration" || t === "ClassExpression") && parent.id === node) return false;
  if (t === "ImportSpecifier" || t === "ImportDefaultSpecifier" || t === "ImportNamespaceSpecifier") return false;
  if (t === "ImportDeclaration") return false;
  // `import.meta.x` 里的 import / meta 属于 MetaProperty，不是自由引用
  if (t === "MetaProperty") return false;
  if (t === "CatchClause" && parent.param === node) return false;
  if ((t === "ObjectProperty" || t === "ObjectMethod" || t === "ClassProperty" || t === "ClassMethod"
    || t === "ClassPrivateMethod") && parent.key === node && !parent.computed) return false;
  if ((t === "MemberExpression" || t === "OptionalMemberExpression")
    && parent.property === node && !parent.computed) return false;
  if ((t === "JSXOpeningElement" || t === "JSXClosingElement" || t === "JSXMemberExpression") && parent.name === node) return false;
  if (t === "ObjectPattern" && key === "key" && !parent.computed) return false;
  if (t === "LabeledStatement" && parent.label === node) return false;
  if (t === "BreakStatement" || t === "ContinueStatement") return false;
  return true;
};

const declarePattern = (scope, n) => {
  if (!n) return;
  if (n.type === "Identifier") scope.names.add(n.name);
  else if (n.type === "ObjectPattern") n.properties.forEach((p) =>
    declarePattern(scope, p.type === "RestElement" ? p.argument : p.value));
  else if (n.type === "ArrayPattern") n.elements.forEach((e) => declarePattern(scope, e));
  else if (n.type === "AssignmentPattern") declarePattern(scope, n.left);
  else if (n.type === "RestElement") declarePattern(scope, n.argument);
};

for (const f of files) {
  const src = readFileSync(f, "utf-8");
  let ast;
  try {
    ast = parse(src, { sourceType: "module", plugins: ["jsx"], errorRecovery: true });
  } catch (e) {
    problems.push(`${f}  解析失败：${e.message}`);
    continue;
  }

  /* ⚠️ `export const x = …` 在 AST 里是 **ExportNamedDeclaration 包着**
     VariableDeclaration，两层。直接按 st.type 判会把它整个漏掉
     （`guessType` 就是这么被误报的）。这里先拆掉导出壳子。 */
  const stripExports = (n) => {
    if (!n || typeof n !== "object") return n;
    if (Array.isArray(n)) return n.map(stripExports);
    if (typeof n.type !== "string") return n;
    if ((n.type === "ExportNamedDeclaration" || n.type === "ExportDefaultDeclaration") && n.declaration) {
      return { ...stripExports(n.declaration), _exported: true };
    }
    const out = {};
    for (const k of Object.keys(n)) {
      if (["type", "start", "end", "loc", "range"].includes(k)) { out[k] = n[k]; continue; }
      out[k] = stripExports(n[k]);
    }
    return out;
  };
  ast = stripExports(ast);

  const moduleScope = mkScope(null, true);
  /* fileNames = 这个文件里**任何地方**声明过的名字（含别的函数内部）。
     用来把两种失败分开：
       · 不在 fileNames 里 → 真的没声明（check-undeclared-idents 已经覆盖，这里兜底）
       · 在 fileNames 里但当前作用域看不见 → 「声明在别的函数里，拿到这儿用不了」，
         这才是本脚本要报的，也是 check-undeclared-idents 因为「全文过度近似」
         而一直放过的那一类。 */
  /* fileNames 只装**本文件**声明过的名字，**不含 GLOBALS** ——
     它要回答的是「这个名字在本文件里别处声明过吗」，不是「是不是全局」。
     （把 GLOBALS 也塞进来会把每个 Math / window 都报成 out-of-scope。） */
  const fileNames = new Set();
  const visible = (scope, name) => {
    for (let s = scope; s; s = s.parent) if (s.names.has(name)) return true;
    return GLOBALS.has(name);
  };

  const walk = (node, scope, parent = null, key = null) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach((c) => walk(c, scope, parent, key)); return; }
    if (typeof node.type !== "string") return;

    /* —— 本节点的声明先落进 scope（可见性只管「看不看得见」，不管顺序；
         顺序是 check-tdz 的事） —— */
    if (node.type === "VariableDeclaration") {
      const target = node.kind === "var" ? (scope.isFn ? scope : nearestFn(scope)) : scope;
      node.declarations.forEach((d) => { declarePattern(target, d.id); remember(d.id); });
    } else if ((node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") && node.id) {
      (scope.isFn ? scope : nearestFn(scope)).names.add(node.id.name);
      fileNames.add(node.id.name);
    }

    /* —— 引用判定用**当前**作用域 —— */
    if (node.type === "Identifier" && isReference(node, parent, key)) {
      const name = node.name;
      if (!visible(scope, name)) {
        problems.push({
          kind: fileNames.has(name) ? "out-of-scope" : "absent",
          file: f, line: node.loc?.start?.line ?? 0, name,
        });
      }
    }

    /* —— 子节点的 scope ——
       **进入作用域时先把该作用域的声明全部登记**，再走子节点。
       顺序无关（hoisting）不是 JS 的语义，但这是**可见性**检查：
       一个函数里第 10 行引用、第 800 行才声明的 `const`，那个函数跑起来时
       800 行早就执行过了 —— 除非它落在 TDZ 上，那是 check-tdz 的活。
       不预登记的话会把一大半正常代码误报成「全文都没有声明」。 */
    let childScope = scope;
    if (isFnNode(node)) {
      childScope = mkScope(scope, true);
      (node.params || []).forEach((p) => declarePattern(childScope, p));
      if (node.id) { childScope.names.add(node.id.name); fileNames.add(node.id.name); }
      (node.params || []).forEach((p) => remember(p));
      prescan(node.body, childScope);
    } else if (isBlockNode(node)) {
      childScope = mkScope(scope, false);
      if (node.type === "CatchClause" && node.param) declarePattern(childScope, node.param);
      if ((node.type === "ForStatement") && node.init && node.init.type === "VariableDeclaration") {
        node.init.declarations.forEach((d) => declarePattern(childScope, d.id));
      }
      prescan(node.body, childScope);
    }

    const skip = new Set(["type", "start", "end", "loc", "range", "leadingComments", "trailingComments"]);
    for (const k of Object.keys(node)) {
      if (skip.has(k)) continue;
      walk(node[k], childScope, node, k);
    }
  };

  const nearestFn = (scope) => (scope.isFn ? scope : nearestFn(scope.parent));

  const remember = (n) => {
    if (!n) return;
    if (n.type === "Identifier") fileNames.add(n.name);
    else if (n.type === "ObjectPattern") n.properties.forEach((p) => remember(p.type === "RestElement" ? p.argument : p.value));
    else if (n.type === "ArrayPattern") n.elements.forEach(remember);
    else if (n.type === "AssignmentPattern") remember(n.left);
    else if (n.type === "RestElement") remember(n.argument);
  };

  /* 把一个作用域体里的所有声明登记进去（不进去，只登记）。 */
  const prescan = (body, scope) => {
    let stmts = body;
    if (!Array.isArray(stmts)) stmts = (body && Array.isArray(body.body) ? body.body : null) || [];
    for (const st of stmts) {
      if (!st || typeof st.type !== "string") continue;
      if (st.type === "VariableDeclaration") {
        const target = st.kind === "var" ? (scope.isFn ? scope : nearestFn(scope)) : scope;
        st.declarations.forEach((d) => declarePattern(target, d.id));
      } else if ((st.type === "FunctionDeclaration" || st.type === "ClassDeclaration") && st.id) {
        (scope.isFn ? scope : nearestFn(scope)).names.add(st.id.name);
      }
    }
  };

  /* ⚠️ 模块级的声明必须**先全部登记**，再开始走。
     否则「第 577 行引用、第 3066 行声明」这种（dispName 就是）会被误判成
     「全文都没有」—— 走到引用那一刻还没登记到后面的声明。
     （TDZ 是另一回事，由 check-tdz 负责；这里只管可见性。） */
  for (const st of ast.program.body) {
    if (st.type === "ImportDeclaration") {
      for (const s of st.specifiers) if (s.local) { moduleScope.names.add(s.local.name); fileNames.add(s.local.name); }
    } else if (st.type === "VariableDeclaration") {
      st.declarations.forEach((d) => { declarePattern(moduleScope, d.id); remember(d.id); });
    } else if ((st.type === "FunctionDeclaration" || st.type === "ClassDeclaration") && st.id) {
      moduleScope.names.add(st.id.name);
      fileNames.add(st.id.name);
    }
  }
  /* ⚠️ fileNames 必须**整份文件先收齐**，再开始判定。
     否则「第 1436 行引用、第 1808 行声明」这种（TopMenu 引用 App 里的
     `setWideMode`）会因为引用在前面、还没登记到而被归成「全文都没声明」，
     消息就指错了方向 —— 而它恰恰是本脚本要抓的那一类。 */
  const collect = (n) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { n.forEach(collect); return; }
    if (typeof n.type !== "string") return;
    if (n.type === "VariableDeclaration") n.declarations.forEach((d) => remember(d.id));
    else if ((n.type === "FunctionDeclaration" || n.type === "ClassDeclaration") && n.id) fileNames.add(n.id.name);
    else if (n.type === "ImportDeclaration") {
      for (const s of n.specifiers) if (s.local) fileNames.add(s.local.name);
    }
    if (isFnNode(n)) (n.params || []).forEach(remember);
    const skip = new Set(["type", "start", "end", "loc", "range"]);
    for (const k of Object.keys(n)) { if (!skip.has(k)) collect(n[k]); }
  };
  collect(ast.program.body);

  walk(ast.program.body, moduleScope);
}

if (problems.length) {
  const absent = problems.filter((p) => p.kind === "absent");
  const oos = problems.filter((p) => p.kind === "out-of-scope");
  if (absent.length) {
    console.error("❌ 引用了但全文都没有声明：");
    for (const p of [...new Set(absent.map((x) => `${x.file}:${x.line}  ${x.name}`))].slice(0, 40)) console.error("   " + p);
  }
  if (oos.length) {
    console.error("❌ 名字在文件里有声明，但**当前作用域看不见**（运行时 ReferenceError）：");
    for (const p of [...new Set(oos.map((x) => `${x.file}:${x.line}  ${x.name}`))].slice(0, 40)) console.error("   " + p);
  }
  process.exit(1);
}
console.log(`✓ ${files.length} 个文件，没有越出作用域的引用`);
