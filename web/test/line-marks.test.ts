import { test } from "node:test";
import assert from "node:assert/strict";
import { diffLineRows, type LineDiff } from "../src/lib/diff.ts";
import { anchorsBetween, changedSymbols, lineMarks, REMOVED_KEEP_LINES, removedLabel, type SymbolRange } from "../src/lib/line-marks.ts";

/** As the banner diffs (diffVersions): normalized. */
const diff = (a: string, b: string): LineDiff => {
  const d = diffLineRows(a, b, { normalize: true });
  assert.ok(d);
  return d;
};
const marksOf = (a: string, b: string, opts = {}) => lineMarks(diff(a, b), opts);
const kinds = (m: ReturnType<typeof lineMarks>) => Object.fromEntries([...m.kinds].sort((x, y) => x[0] - y[0]));
const text = (lines: string[]) => lines.join("\n") + "\n";

test("lineMarks: lines added at the start, in the middle and at the end", () => {
  const m = marksOf("b\nc\nd\n", "a\nb\nc\nX\nd\ne\nf\n");
  assert.deepEqual(kinds(m), { 1: "added", 4: "added", 6: "added", 7: "added" });
  assert.deepEqual(m.anchors, [1, 4, 6]);
  assert.deepEqual(m.removed, []);
  assert.deepEqual(m.counts, { added: 4, modified: 0, removed: 0 });
  assert.equal(m.lineCount, 7);
  assert.equal(m.removedAtEnd, false);
});

test("lineMarks: a modified line pairs removed with added, with its changed words", () => {
  const m = marksOf("const a = 1;\nkeep\n", "const a = 2;\nkeep\n");
  assert.deepEqual(kinds(m), { 1: "modified" });
  assert.deepEqual(m.counts, { added: 0, modified: 1, removed: 0 });
  const w = m.words.get(1);
  assert.ok(w);
  assert.deepEqual(
    w.map(([s, e]) => "const a = 2;".slice(s, e)),
    ["2"],
  );
  assert.equal(m.partial, false);
});

test("lineMarks: a run with more added than removed lines: modified first, then added", () => {
  const m = marksOf("a\nold\nz\n", "a\nnew one\nnew two\nz\n");
  assert.deepEqual(kinds(m), { 2: "modified", 3: "added" });
  assert.deepEqual(m.anchors, [2]);
});

test("lineMarks: a run with more removed than added lines: the rest is a removal after the run", () => {
  const m = marksOf("a\nold 1\nold 2\nold 3\nz\n", "a\nnew 1\nz\n");
  assert.deepEqual(kinds(m), { 2: "modified" });
  assert.equal(m.removed.length, 1);
  assert.deepEqual(m.removed[0], { beforeLine: 3, oldStart: 3, count: 2, lines: ["old 2", "old 3"] });
  assert.deepEqual(m.counts, { added: 0, modified: 1, removed: 2 });
});

test("lineMarks: removals at the start, in the middle and at the end", () => {
  const m = marksOf("x\na\nb\ny\nc\nz1\nz2\n", "a\nb\nc\n");
  assert.deepEqual(kinds(m), {});
  assert.deepEqual(
    m.removed.map((r) => [r.beforeLine, r.oldStart, r.count, r.lines]),
    [
      [1, 1, 1, ["x"]],
      [3, 4, 1, ["y"]],
      [null, 6, 2, ["z1", "z2"]],
    ],
  );
  // A pure removal anchors on the line it sits before; at the end there is no such line.
  assert.deepEqual(m.anchors, [1, 3]);
  assert.equal(m.removedAtEnd, true);
  assert.equal(removedLabel(m.removed[0]), "1 line removed");
  assert.equal(removedLabel(m.removed[2]), "2 lines removed at the end");
});

test("lineMarks: everything removed", () => {
  const m = marksOf("a\nb\n", "");
  assert.equal(m.lineCount, 0);
  assert.deepEqual(m.anchors, []);
  assert.deepEqual(m.removed, [{ beforeLine: null, oldStart: 1, count: 2, lines: ["a", "b"] }]);
});

test("lineMarks: CRLF and a missing final newline are not changes; line numbers stay right", () => {
  assert.equal(diff("a\r\nb\r\n", "a\nb").hunks.length, 0);
  assert.equal(diff("a\nb\n", "a\nb").hunks.length, 0);
  const m = marksOf("a\r\nb\r\nc\r\n", "a\r\nB\r\nc");
  assert.deepEqual(kinds(m), { 2: "modified" });
  assert.equal(m.lineCount, 3);
  // A real trailing blank line added is a change.
  assert.deepEqual(kinds(marksOf("a\n", "a\n\n")), { 2: "added" });
});

test("lineMarks: whitespace-only edits are marked, the changed whitespace highlighted", () => {
  const m = marksOf("if x:\n  return 1\n", "if x:\n    return 1\n");
  assert.deepEqual(kinds(m), { 2: "modified" });
  const w = m.words.get(2);
  assert.ok(w && w.length > 0);
  for (const [s, e] of w) assert.match("    return 1".slice(s, e), /^\s+$/);
});

test("lineMarks: no word highlights for long lines, mostly different lines, or words: false", () => {
  const long = "x".repeat(1200);
  const m = marksOf(`${long}\n`, `${long}y\n`);
  assert.deepEqual(kinds(m), { 1: "modified" });
  assert.equal(m.words.size, 0);
  assert.equal(m.partial, true);
  // Mostly different: modified, but highlighting nearly everything helps nobody.
  const d = marksOf("alpha beta\n", "gamma delta epsilon\n");
  assert.deepEqual(kinds(d), { 1: "modified" });
  assert.equal(d.words.size, 0);
  const off = marksOf("a = 1\n", "a = 2\n", { words: false });
  assert.equal(off.words.size, 0);
  assert.equal(off.partial, false);
});

test("lineMarks: huge diffs keep the line marks but drop the word highlights", () => {
  // A whole-file rewrite, built directly (a real diff of it would run near DIFF_TIMEOUT_MS):
  // n removed rows, then n added ones, one run.
  const n = 300;
  const d: LineDiff = {
    rows: [
      ...Array.from({ length: n }, (_, i) => ({ type: "del" as const, text: `value ${i} = ${i}`, oldNo: i + 1 })),
      ...Array.from({ length: n }, (_, i) => ({ type: "add" as const, text: `value ${i} = ${i + 1}`, newNo: i + 1 })),
    ],
    hunks: [{ oldStart: 1, oldLines: n, newStart: 1, newLines: n }],
    added: n,
    removed: n,
  };
  // More changed lines than the cap: no word diff at all.
  const capped = lineMarks(d, { maxChangedLines: 100 });
  assert.equal(capped.kinds.size, n);
  assert.equal(capped.words.size, 0);
  assert.equal(capped.partial, true);
  // One run with more pairs than maxRunPairs: a rewrite, no words for it.
  const run = lineMarks(d, { maxRunPairs: 10 });
  assert.equal(run.words.size, 0);
  assert.equal(run.partial, true);
  // maxPairs: only the first ones.
  const pairs = lineMarks(d, { maxPairs: 10, maxRunPairs: n });
  assert.equal(pairs.words.size, 10);
  assert.equal(pairs.partial, true);
  // Time budget (injected clock): stops early, marks stay complete.
  let t = 0;
  const timed = lineMarks(d, { maxRunPairs: n, budgetMs: 5, now: () => (t += 1) });
  assert.equal(timed.kinds.size, n);
  assert.ok(timed.words.size < 10);
  assert.equal(timed.partial, true);
  // And all of them get words within the default caps.
  const all = lineMarks(d, { maxRunPairs: n });
  assert.equal(all.kinds.size, n);
  assert.equal(all.words.size, n);
  assert.equal(all.partial, false);
});

test("lineMarks: removed lines kept for the inline view are capped", () => {
  const n = REMOVED_KEEP_LINES + 20;
  const a = text(["top", ...Array.from({ length: n }, (_, i) => `gone ${i}`), "end"]);
  const m = marksOf(a, "top\nend\n");
  assert.equal(m.removed[0].count, n);
  assert.equal(m.removed[0].lines.length, REMOVED_KEEP_LINES);
  assert.equal(m.removed[0].beforeLine, 2);
  assert.equal(m.counts.removed, n);
});

// ---------- outline symbols holding a change ----------

/** class A (1-12) { m1 (2-4), m2 (6-8), m3 (10-11) }, function f (14-16), function g (18, no end) */
const flat: SymbolRange[] = [
  { line: 1, endLine: 12, depth: 0 },
  { line: 2, endLine: 4, depth: 1 },
  { line: 6, endLine: 8, depth: 1 },
  { line: 10, endLine: 11, depth: 1 },
  { line: 14, endLine: 16, depth: 0 },
  { line: 18, depth: 0 },
];
const at = (kindsAt: number[], removed: (number | null)[] = [], lineCount = 20) => ({
  kinds: new Map(kindsAt.map((n) => [n, "modified" as const])),
  removed: removed.map((beforeLine) => ({ beforeLine, oldStart: 1, count: 1, lines: ["x"] })),
  lineCount,
});
const ids = (s: Set<number>) => [...s].sort((a, b) => a - b);

test("changedSymbols: a changed line marks the symbols around it", () => {
  assert.deepEqual(ids(changedSymbols(flat, at([7]))), [0, 2]);
  assert.deepEqual(ids(changedSymbols(flat, at([15]))), [4]);
  // between symbols: none (line 13 is outside A and before f)
  assert.deepEqual(ids(changedSymbols(flat, at([13]))), []);
  // no end line: up to the end of the file
  assert.deepEqual(ids(changedSymbols(flat, at([20]))), [5]);
  assert.deepEqual(ids(changedSymbols(flat, at([]))), []);
});

test("changedSymbols: removals inside, at the tail of a body, a whole symbol, at the end", () => {
  // inside m2 (before its line 7)
  assert.deepEqual(ids(changedSymbols(flat, at([], [7]))), [0, 2]);
  // the tail of m1 removed: the cut sits right after its last line (line 5 is blank)
  assert.deepEqual(ids(changedSymbols(flat, at([], [5]))), [0, 1]);
  // a whole method removed right before m3: its class, not m2 nor m3
  assert.deepEqual(ids(changedSymbols(flat, at([], [10]))), [0]);
  // a whole function removed before f: none of them
  assert.deepEqual(ids(changedSymbols(flat, at([], [14]))), []);
  // at the end: the symbol reaching the last line
  assert.deepEqual(ids(changedSymbols(flat, at([], [null]))), [5]);
  assert.deepEqual(ids(changedSymbols([{ line: 1, endLine: 20, depth: 0 }], at([], [null]))), [0]);
  assert.deepEqual(ids(changedSymbols([{ line: 1, endLine: 5, depth: 0 }], at([], [null]))), []);
});

test("changedSymbols: implicit ends stop at the next symbol of the same or a shallower depth", () => {
  const noEnds: SymbolRange[] = [
    { line: 1, depth: 0 },
    { line: 2, depth: 1 },
    { line: 5, depth: 1 },
    { line: 9, depth: 0 },
  ];
  assert.deepEqual(ids(changedSymbols(noEnds, at([3]))), [0, 1]);
  assert.deepEqual(ids(changedSymbols(noEnds, at([7]))), [0, 2]);
  assert.deepEqual(ids(changedSymbols(noEnds, at([12]))), [3]);
});

test("changedSymbols: from real marks", () => {
  const before = text(["def a():", "    return 1", "", "def b():", "    return 2", ""]);
  const after = text(["def a():", "    return 1", "", "def b():", "    return 3", ""]);
  const m = marksOf(before, after);
  const syms: SymbolRange[] = [
    { line: 1, endLine: 2, depth: 0 },
    { line: 4, endLine: 5, depth: 0 },
  ];
  assert.deepEqual(ids(changedSymbols(syms, m)), [1]);
});

test("changedSymbols: with the text, a removal right after a symbol counts when it is its body's tail", () => {
  // Python: the last line of a removed, b follows directly.
  const before = text(["def a():", "    x = 1", "    return x", "def b():", "    return 2"]);
  const after = text(["def a():", "    x = 1", "def b():", "    return 2"]);
  const m = marksOf(before, after);
  assert.deepEqual(m.removed.map((r) => r.beforeLine), [3]);
  const syms: SymbolRange[] = [
    { line: 1, depth: 0 },
    { line: 3, depth: 0 },
  ];
  const lines = after.split("\n");
  const lineText = (n: number) => lines[n - 1];
  assert.deepEqual(ids(changedSymbols(syms, m, lineText)), [0]);
  // Without the text: the old rule (a symbol starts where the removal sits: none).
  assert.deepEqual(ids(changedSymbols(syms, m)), []);
});

test("changedSymbols: with the text, the last function removed does not mark the one before it", () => {
  const before = text(["function a() {", "  return 1;", "}", "", "function c() {", "  return 3;", "}"]);
  const after = text(["function a() {", "  return 1;", "}"]);
  const m = marksOf(before, after);
  assert.deepEqual(m.removed.map((r) => r.beforeLine), [null]);
  const syms: SymbolRange[] = [{ line: 1, depth: 0 }];
  const lines = after.split("\n");
  assert.deepEqual(ids(changedSymbols(syms, m, (n) => lines[n - 1])), []);
  // The tail of the last function's body, removed at the end of the file: its dot.
  const tailBefore = text(["def a():", "    return 1", "def b():", "    x = 2", "    return x"]);
  const tailAfter = text(["def a():", "    return 1", "def b():", "    x = 2"]);
  const t = marksOf(tailBefore, tailAfter);
  const tl = tailAfter.split("\n");
  const py: SymbolRange[] = [
    { line: 1, depth: 0 },
    { line: 3, depth: 0 },
  ];
  assert.deepEqual(ids(changedSymbols(py, t, (n) => tl[n - 1])), [1]);
  // Removed blank lines after a symbol: no dot.
  const blank = { kinds: new Map(), removed: [{ beforeLine: 3, oldStart: 3, count: 1, lines: [""] }], lineCount: 4 };
  assert.deepEqual(ids(changedSymbols(py, blank, (n) => tl[n - 1])), []);
});

test("anchorsBetween: the changes in an unloaded middle part of a large file", () => {
  // A 9000-line file edited at lines 2, 4501 and 8991; lines 1700-7300 not loaded.
  const before = text(Array.from({ length: 9000 }, (_, i) => `line ${i + 1}`));
  const lines = before.split("\n").slice(0, -1);
  for (const n of [2, 4501, 8991]) lines[n - 1] += " edited";
  const m = marksOf(before, text(lines));
  assert.deepEqual(m.anchors, [2, 4501, 8991]);
  assert.deepEqual(anchorsBetween(m.anchors, 1700, 7300), [4501]);
  assert.deepEqual(anchorsBetween(m.anchors, 1, 1), []);
  assert.deepEqual(anchorsBetween(m.anchors, 2, 2), [2]);
  assert.deepEqual(anchorsBetween(m.anchors, 8991, 9000), [8991]);
  assert.deepEqual(anchorsBetween([], 1, 10), []);
});
