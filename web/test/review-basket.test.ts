import { test } from "node:test";
import assert from "node:assert/strict";
import { blockMarks, diffLineRows, diffMarkdownBlocks, splitMarkdownBlocks, type LineDiff } from "../src/lib/diff.ts";
import { lineMarks } from "../src/lib/line-marks.ts";
import {
  basketItem,
  buildPrompt,
  clipLines,
  diffBody,
  enclosingSymbols,
  findHunk,
  groupByFile,
  headingPath,
  hunkFinder,
  hunkOccurrences,
  lineHunks,
  lineLocation,
  markdownHunks,
  markdownLocation,
  PROMPT_INTRO,
} from "../src/lib/review-basket.ts";

const lines = (ls: string[]) => ls.join("\n") + "\n";
const ldiff = (a: string, b: string): LineDiff => {
  const d = diffLineRows(a, b, { normalize: true });
  assert.ok(d);
  return d;
};

test("lineHunks: one per run of changes, matching the line marks' anchors and removals", () => {
  const a = lines(["a", "b", "c", "d", "e", "f"]);
  const b = lines(["a", "B", "c", "d", "x", "y", "f"]);
  const d = ldiff(a, lines(["a", "B", "c", "e", "f", "g"]));
  const hs = lineHunks(d);
  assert.deepEqual(
    hs.map((h) => [h.kind, h.start, h.end, h.removedBefore, h.beforeText, h.afterText]),
    [
      ["modified", 2, 2, undefined, "b", "B"],
      ["removed", null, null, 4, "d", ""],
      ["added", 6, 6, undefined, "", "g"],
    ],
  );
  const m = lineMarks(d);
  // Every anchor the views mark resolves to a hunk, and every removal marker too.
  for (const n of m.anchors) assert.ok(findHunk(hs, { line: n }) >= 0, `anchor ${n}`);
  for (const r of m.removed) assert.ok(findHunk(hs, { removedBefore: r.beforeLine }) >= 0);
  const m2 = lineMarks(ldiff(a, b));
  const hs2 = lineHunks(ldiff(a, b));
  assert.equal(hs2.length, m2.anchors.length);
  assert.equal(hs2[1].kind, "modified");
  assert.deepEqual([hs2[1].start, hs2[1].end], [5, 6]);
});

test("lineHunks agrees with lineMarks: anchors, removal markers and line kinds", () => {
  const fixtures: [string, string][] = [
    [lines(["a", "b", "c", "d", "e", "f"]), lines(["a", "B", "c", "e", "f", "g"])],
    [lines(["a", "b", "c", "d"]), lines(["a", "B"])],
    [lines(["a", "b", "c"]), lines(["b", "c"])],
    [lines(["a", "b", "c"]), lines(["a", "b"])],
    ["a\nb\nc", "a\nB\nc\nd"],
    [lines(["a", "b", "c", "d", "e"]), lines(["a", "X", "Y", "Z", "e", "f"])],
    [lines(["x", "a", "b", "c", "y"]), lines(["x", "A", "y", "z"])],
  ];
  for (const [a, b] of fixtures) {
    const d = ldiff(a, b);
    const hs = lineHunks(d);
    const m = lineMarks(d);
    const where = JSON.stringify([a, b]);
    assert.deepEqual(
      hs.map((h) => h.start ?? h.removedBefore).filter((n) => n != null),
      m.anchors,
      `anchors ${where}`,
    );
    assert.deepEqual(
      hs.filter((h) => h.removedBefore !== undefined).map((h) => h.removedBefore),
      m.removed.map((r) => r.beforeLine),
      `removed ${where}`,
    );
    const kinds = new Map<number, string>();
    for (const h of hs) {
      if (h.start === null || h.end === null) continue;
      const pairs = h.kind === "modified" ? Math.min(h.beforeText.split("\n").length, h.end - h.start + 1) : 0;
      for (let n = h.start; n <= h.end; n++) kinds.set(n, n - h.start < pairs ? "modified" : "added");
    }
    assert.deepEqual([...kinds].sort((x, y) => x[0] - y[0]), [...m.kinds].sort((x, y) => x[0] - y[0]), `kinds ${where}`);
  }
});

test("hunkFinder gives findHunk's answers", () => {
  const md = diffMarkdownBlocks("# A\n\none\n\ntwo\n\nthree\n", "# A\n\nONE\n\nthree\n\nfour\n");
  const cases = [
    lineHunks(ldiff(lines(["a", "b", "c", "d", "e", "f"]), lines(["a", "B", "c", "e", "f", "g"]))),
    lineHunks(ldiff(lines(["a", "b", "c", "d"]), lines(["a", "B"]))),
    md ? markdownHunks(md) : [],
  ];
  for (const hs of cases) {
    const find = hunkFinder(hs);
    const targets = [
      ...Array.from({ length: 12 }, (_, i) => ({ line: i })),
      ...Array.from({ length: 12 }, (_, i) => ({ removedBefore: i as number | null })),
      { removedBefore: null },
      ...Array.from({ length: 10 }, (_, i) => ({ lines: [i, i + 2] as [number, number] })),
    ];
    for (const t of targets) assert.equal(find(t), findHunk(hs, t), JSON.stringify(t));
  }
});

test("lineHunks: extra removed lines after a modified run, and a removal at the end", () => {
  const d = ldiff(lines(["a", "b", "c", "d"]), lines(["a", "B"]));
  const [h] = lineHunks(d);
  assert.equal(h.kind, "modified");
  assert.equal(h.removedBefore, null);
  assert.equal(findHunk([h], { removedBefore: null }), 0);
  assert.equal(findHunk([h], { line: 2 }), 0);
  assert.equal(findHunk([h], { line: 1 }), -1);
});

test("markdownHunks: highlighted blocks and removal groups, as blockMarks marks them", () => {
  const a = "# Title\n\nIntro.\n\n## Setup\n\nOld step.\n\nGone one.\n\nGone two.\n\n## Use\n\nRun it.\n";
  const b = "# Title\n\nIntro.\n\n## Setup\n\nNew step.\n\n## Use\n\nRun it.\n\nMore.\n";
  const d = diffMarkdownBlocks(a, b);
  assert.ok(d);
  const hs = markdownHunks(d);
  assert.deepEqual(
    hs.map((h) => [h.kind, h.start, h.removedBefore, h.beforeText, h.afterText]),
    [
      ["modified", 7, undefined, "Old step.", "New step."],
      ["removed", null, 9, "Gone one.\n\nGone two.", ""],
      ["added", 13, undefined, "", "More."],
    ],
  );
  const marks = blockMarks(d);
  for (const r of marks.ranges) assert.ok(findHunk(hs, { lines: [r.start, r.end] }) >= 0);
  for (const r of marks.removed) assert.ok(findHunk(hs, { removedBefore: r.beforeLine }) >= 0);
  assert.equal(markdownLocation(d.newBlocks, hs[0]), "Title > Setup");
  assert.equal(markdownLocation(d.newBlocks, hs[1]), "Title > Setup");
  assert.equal(markdownLocation(d.newBlocks, hs[2]), "Title > Use");
});

test("headingPath: levels, setext headings, closing hashes, before the first heading", () => {
  const blocks = splitMarkdownBlocks("Intro\n\nTop\n===\n\n### Deep ##\n\n## Mid\n\ntext\n\n# Next\n\nend\n");
  assert.deepEqual(headingPath(blocks, 1), []);
  assert.deepEqual(headingPath(blocks, 6), ["Top", "Deep"]);
  assert.deepEqual(headingPath(blocks, 10), ["Top", "Mid"]);
  assert.deepEqual(headingPath(blocks, null), ["Next"]);
  assert.equal(markdownLocation(blocks, { kind: "added", start: 1, end: 1, beforeText: "", afterText: "Intro" }), "start of the document");
});

test("enclosingSymbols and lineLocation", () => {
  const flat = [
    { name: "Parser", line: 1, endLine: 20, depth: 0 },
    { name: "parse", line: 2, endLine: 10, depth: 1 },
    { name: "close", line: 11, depth: 1 },
    { name: "main", line: 22, depth: 0 },
  ];
  assert.deepEqual(enclosingSymbols(flat, [3, 5]), ["Parser", "parse"]);
  assert.deepEqual(enclosingSymbols(flat, [9, 12]), ["Parser"]);
  assert.deepEqual(enclosingSymbols(flat, [21]), []);
  assert.deepEqual(enclosingSymbols(flat, [30]), ["main"]);
  const h = { kind: "modified" as const, start: 3, end: 5, beforeText: "", afterText: "" };
  assert.equal(lineLocation(h, flat), "Line 3-5 · Parser > parse");
  assert.equal(lineLocation({ ...h, end: 3 }), "Line 3");
  assert.equal(lineLocation({ ...h, start: null, end: null, removedBefore: 12 }, flat), "removed before line 12 · Parser > close");
  assert.equal(lineLocation({ ...h, start: null, end: null, removedBefore: null }, flat), "removed at the end");
  // A removed body tail: in the symbol whose first line is indented less than the removed text.
  const src = ["class A:", "    def f(self):", "        x = 1", "", "def g():", "    pass"];
  const syms = [
    { name: "A", line: 1, endLine: 3, depth: 0 },
    { name: "f", line: 2, endLine: 3, depth: 1 },
    { name: "g", line: 5, endLine: 6, depth: 0 },
  ];
  const tail = { ...h, start: null, end: null, removedBefore: 4, beforeText: "        return x" };
  const text = (n: number) => src[n - 1];
  assert.equal(lineLocation(tail, syms), "removed before line 4");
  assert.equal(lineLocation(tail, syms, text), "removed before line 4 · A > f");
  assert.equal(lineLocation({ ...tail, beforeText: "    def h(self):\n        pass" }, syms, text), "removed before line 4 · A");
  assert.equal(lineLocation({ ...tail, removedBefore: 5, beforeText: "def h():" }, syms, text), "removed before line 5");
});

test("clipLines: trims blank ends, caps the lines", () => {
  assert.deepEqual(clipLines("\n\n  a\nb\n\n"), { text: "  a\nb", more: 0 });
  const long = Array.from({ length: 70 }, (_, i) => `l${i}`).join("\n");
  const c = clipLines(long);
  assert.equal(c.text.split("\n").length, 60);
  assert.equal(c.more, 10);
});

test("diffBody: context lines inside a block, pure additions and removals", () => {
  assert.equal(diffBody("a\nb\nc", "a\nB\nc"), " a\n-b\n+B\n c");
  assert.equal(diffBody("", "x\ny"), "+x\n+y");
  assert.equal(diffBody("x", ""), "-x");
});

test("basketItem ids: the same change of the same file once; groupByFile orders by position", () => {
  const h = { kind: "added" as const, start: 9, end: 9, beforeText: "", afterText: "x" };
  const a = basketItem("a.md", "markdown", h, "S");
  assert.equal(a.id, basketItem("a.md", "markdown", { ...h }, "S").id);
  assert.notEqual(a.id, basketItem("b.md", "markdown", h, "S").id);
  const b = basketItem("a.md", "markdown", { ...h, start: 2, end: 2, afterText: "y" }, "T");
  const c = basketItem("z.py", "code", h, "Line 9");
  // An edit above moves the change: same id. Identical changes in one file: told apart.
  assert.equal(a.id, basketItem("a.md", "markdown", { ...h, start: 30, end: 30 }, "S").id);
  const twins = [h, { ...h, start: 20, end: 20 }];
  const occ = hunkOccurrences(twins);
  assert.deepEqual(occ, [0, 1]);
  assert.notEqual(basketItem("a.md", "markdown", twins[0], "S", occ[0]).id, basketItem("a.md", "markdown", twins[1], "S", occ[1]).id);
  const g = groupByFile([a, c, b]);
  assert.deepEqual(g.map((x) => [x.path, x.items.map((i) => i.line)]), [["a.md", [2, 9]], ["z.py", [9]]]);
});

test("buildPrompt: intro, per file, numbered items with a diff fence, notes and cuts", () => {
  const h1 = { kind: "modified" as const, start: 7, end: 7, beforeText: "Run npm i.", afterText: "Run pnpm i." };
  const h2 = { kind: "added" as const, start: 3, end: 4, beforeText: "", afterText: "x = 1\ns = '```'" };
  const long = Array.from({ length: 65 }, (_, i) => `r${i}`).join("\n");
  const h3 = { kind: "removed" as const, start: null, end: null, removedBefore: null, beforeText: long, afterText: "" };
  const i1 = { ...basketItem("docs/setup.md", "markdown", h1, "Setup > Install"), note: "  keep npm  " };
  const i2 = basketItem("src/a.py", "code", h2, "Line 3-4");
  const i3 = basketItem("docs/setup.md", "markdown", h3, "Setup");
  const p = buildPrompt([i1, i2, i3]);
  assert.ok(p.startsWith(`${PROMPT_INTRO}\n\n## docs/setup.md\n\n### 1. Setup > Install (edited)\n\n\`\`\`diff\n-Run npm i.\n+Run pnpm i.\n\`\`\`\n\nNote: keep npm\n`));
  assert.ok(p.includes("### 2. Setup (removed)"));
  assert.ok(p.includes("(Not shown: 5 more lines of the old text.)"));
  assert.ok(p.includes("## src/a.py\n\n### 3. Line 3-4 (added)\n\n````diff\n+x = 1\n+s = '```'\n````"));
  assert.ok(p.includes("Note: none; check this change and fix anything wrong."));
  assert.ok(p.endsWith("\n"));
  // Opened below the repo root: paths are repo-relative.
  const q = buildPrompt([i2], "web/");
  assert.ok(q.includes("\n## web/src/a.py\n"));
  // One change copied on its own: no intro, and only a note that was typed.
  const one = buildPrompt([i2], "", true);
  assert.ok(one.startsWith("## src/a.py\n\n### 1. Line 3-4 (added)"));
  assert.ok(!one.includes(PROMPT_INTRO) && !one.includes("Note:"));
  assert.ok(buildPrompt([{ ...i2, note: "rename it" }], "", true).endsWith("\nNote: rename it\n"));
});
