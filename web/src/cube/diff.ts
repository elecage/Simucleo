// A line diff for the code generation preview (M36): what regenerating
// changes in a file. Longest common subsequence over lines (generated files
// are a few hundred lines), with the unchanged runs between changes folded
// down to a few lines of context. Pure; unit tested.

export type DiffLine = { kind: "same" | "add" | "del"; text: string; a?: number; b?: number } | { kind: "skip"; count: number };

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  // Strip the common head and tail first (most of a regenerated file).
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const A = a.slice(head, a.length - tail);
  const B = b.slice(head, b.length - tail);
  const n = A.length;
  const m = B.length;
  // LCS lengths, row by row (Uint32 rows).
  const L: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: DiffLine[] = [];
  for (let k = 0; k < head; k++) out.push({ kind: "same", text: a[k], a: k + 1, b: k + 1 });
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) {
      out.push({ kind: "same", text: A[i], a: head + i + 1, b: head + j + 1 });
      i++;
      j++;
    } else if (j < m && (i === n || L[i][j + 1] > L[i + 1][j])) {
      out.push({ kind: "add", text: B[j], b: head + j + 1 });
      j++;
    } else {
      out.push({ kind: "del", text: A[i], a: head + i + 1 });
      i++;
    }
  }
  for (let k = 0; k < tail; k++) out.push({ kind: "same", text: a[a.length - tail + k], a: a.length - tail + k + 1, b: b.length - tail + k + 1 });
  return out;
}

/** Fold unchanged runs longer than 2×`context` into a "skip". */
export function foldDiff(lines: DiffLine[], context = 3): DiffLine[] {
  const out: DiffLine[] = [];
  let run: DiffLine[] = [];
  const flush = (end: boolean) => {
    const first = out.length === 0;
    const keepHead = first ? 0 : context;
    const keepTail = end ? 0 : context;
    if (run.length > keepHead + keepTail + 1) {
      out.push(...run.slice(0, keepHead), { kind: "skip", count: run.length - keepHead - keepTail }, ...run.slice(run.length - keepTail));
    } else out.push(...run);
    run = [];
  };
  for (const l of lines) {
    if (l.kind === "same") run.push(l);
    else {
      flush(false);
      out.push(l);
    }
  }
  flush(true);
  return out;
}

export const diffStats = (lines: DiffLine[]) => ({
  added: lines.filter((l) => l.kind === "add").length,
  removed: lines.filter((l) => l.kind === "del").length,
});
