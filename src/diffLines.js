/**
 * 行级差异（给「这篇已被其它地方修改」的对照面板用）。
 *
 * 为什么要自己写：项目零依赖，diff 库（diff / fast-diff）都要额外安装；
 * 这里需要的只是「哪些行加了、哪些行删了」，够用就行。
 *
 * 算法：先剥掉公共前缀 / 后缀（笔记改动通常集中在中间几段，剥完往往只剩几十行），
 * 中间部分再做 LCS。极端情况（两版完全不相干、几千行 × 几千行）LCS 的表格是
 * n×m 个格子，会吃掉几百 MB —— 所以有 CELL_LIMIT，超了就退化成「整段删 + 整段加」，
 * 结果仍然正确，只是不够细。
 */

const CELL_LIMIT = 1_500_000;   // 约 1200×1200 行以内照常精确比对
const MAX_LINES = 20_000;       // 再长的文件不逐行比，避免主线程卡住

const lines = (s) => String(s ?? "").split("\n");

/** 纯 LCS 走一遍，返回 [{t:"same"|"del"|"add", text}] */
function lcsOps(A, B) {
  const n = A.length, m = B.length;
  if (!n) return B.map((text) => ({ t: "add", text }));
  if (!m) return A.map((text) => ({ t: "del", text }));
  if (n * m > CELL_LIMIT) {
    return [
      ...A.map((text) => ({ t: "del", text })),
      ...B.map((text) => ({ t: "add", text })),
    ];
  }
  const W = m + 1;
  const dp = new Uint32Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * W + j] = A[i] === B[j]
        ? dp[(i + 1) * W + j + 1] + 1
        : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
    }
  }
  const out = [];
  /* 外层游标故意叫 x/y：内层 DP 用的是块级 i/j，
     同名的话本项目的 check-tdz 会把它当成「引用在声明之前」。 */
  let x = 0, y = 0;
  while (x < n && y < m) {
    if (A[x] === B[y]) { out.push({ t: "same", text: A[x] }); x++; y++; }
    else if (dp[(x + 1) * W + y] >= dp[x * W + y + 1]) { out.push({ t: "del", text: A[x] }); x++; }
    else { out.push({ t: "add", text: B[y] }); y++; }
  }
  while (x < n) out.push({ t: "del", text: A[x++] });
  while (y < m) out.push({ t: "add", text: B[y++] });
  return out;
}

/**
 * @param {string} aText  「我这份」
 * @param {string} bText  「磁盘上那份」
 * @param {number} context 变化行前后各留几行
 * @returns {{rows: Array<{t:string,text?:string,aNo?:number,bNo?:number,count?:number}>,
 *            added:number, removed:number, tooBig:boolean}}
 */
export function diffLines(aText, bText, context = 3) {
  const A = lines(aText), B = lines(bText);
  if (A.length > MAX_LINES || B.length > MAX_LINES) {
    return { rows: [], added: 0, removed: 0, tooBig: true };
  }

  let head = 0;
  while (head < A.length && head < B.length && A[head] === B[head]) head++;
  let tail = 0;
  while (tail < A.length - head && tail < B.length - head
    && A[A.length - 1 - tail] === B[B.length - 1 - tail]) tail++;

  const ops = [
    ...A.slice(0, head).map((text) => ({ t: "same", text })),
    ...lcsOps(A.slice(head, A.length - tail), B.slice(head, B.length - tail)),
    ...A.slice(A.length - tail).map((text) => ({ t: "same", text })),
  ];

  // 补行号 + 统计
  let aNo = 0, bNo = 0, added = 0, removed = 0;
  const numbered = ops.map((o) => {
    if (o.t === "same") return { ...o, aNo: ++aNo, bNo: ++bNo };
    if (o.t === "del") { removed++; return { ...o, aNo: ++aNo }; }
    added++; return { ...o, bNo: ++bNo };
  });

  // 一模一样：没什么可折叠的，直接空表（调用方据此显示「两份内容相同」）
  if (!added && !removed) return { rows: [], added: 0, removed: 0, tooBig: false };

  /* 折叠：只留有变化的地方，前后各 context 行。
     两处改动之间隔着几十行没变的，把它压成一行「… 未改动 N 行」。 */
  const keep = new Array(numbered.length).fill(false);
  numbered.forEach((o, i) => {
    if (o.t === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(numbered.length - 1, i + context); k++) keep[k] = true;
  });

  const rows = [];
  let run = 0;
  numbered.forEach((o, i) => {
    if (keep[i]) {
      if (run) { rows.push({ t: "skip", count: run }); run = 0; }
      rows.push(o);
    } else {
      run++;
    }
  });
  if (run) rows.push({ t: "skip", count: run });

  return { rows, added, removed, tooBig: false };
}
