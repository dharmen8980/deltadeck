import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeSymbol,
  byLine,
  cachedOutline,
  cacheOutline,
  computeOutline,
  flattenOutline,
  outlineCacheKey,
  outlineTargetFor,
  OUTLINE_MAX_BYTES,
} from "../src/lib/outline/index.ts";
import { Budget, LineIndex, OutlineTimeout, cleanName, type OutlineSymbol } from "../src/lib/outline/common.ts";
import { rows } from "./outline-util.ts";

const now = () => Promise.resolve();

test("outlineTargetFor: languages by extension", () => {
  assert.deepEqual(outlineTargetFor("PY"), { lang: "python", variant: "" });
  assert.deepEqual(outlineTargetFor("tsx"), { lang: "javascript", variant: "tsx" });
  assert.deepEqual(outlineTargetFor("mjs"), { lang: "javascript", variant: "jsx" });
  assert.deepEqual(outlineTargetFor("scss"), { lang: "css", variant: "scss" });
  assert.deepEqual(outlineTargetFor("htm"), { lang: "html", variant: "" });
  assert.equal(outlineTargetFor("cs")?.lang, "csharp");
  assert.equal(outlineTargetFor("zsh")?.lang, "shell");
  for (const ext of ["go", "rs", "md", "json", "yaml", "docx", ""]) assert.equal(outlineTargetFor(ext), null);
});

test("computeOutline: loads the language lazily and parses in slices", async () => {
  let yields = 0;
  const yieldFn = () => {
    yields++;
    return Promise.resolve();
  };
  const py = await computeOutline(outlineTargetFor("py")!, "class A:\n    def f(self): pass\n", { yieldFn });
  assert.deepEqual(rows(py!), ["class A @1", "  method f @2"]);
  assert.ok(yields >= 1);
  const sh = await computeOutline(outlineTargetFor("sh")!, "x() { :; }\n", { yieldFn });
  assert.deepEqual(rows(sh!), ["function x @1"]);
  const css = await computeOutline(outlineTargetFor("less")!, "@a: 1;\n.b { .m(); }\n", { yieldFn });
  assert.deepEqual(rows(css!), ["selector .b @2"]);
});

test("computeOutline: size cap, time budget, abort", async () => {
  const target = outlineTargetFor("ts")!;
  assert.equal(await computeOutline(target, "x".repeat(OUTLINE_MAX_BYTES + 1), { yieldFn: now }), null);

  const big = Array.from({ length: 20000 }, (_, i) => `export function f${i}(a: number) { return a * ${i}; }`).join("\n");
  assert.equal(await computeOutline(target, big, { yieldFn: now, budgetMs: 1 }), null);

  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(computeOutline(target, "function f() {}", { yieldFn: now, signal: ctrl.signal }), { name: "AbortError" });
});

test("Budget: throws OutlineTimeout once past the deadline", () => {
  const b = new Budget(Date.now() - 1);
  assert.throws(() => b.check(), OutlineTimeout);
  // tick() only looks at the clock every 1024 calls
  const t = new Budget(Date.now() - 1);
  for (let i = 0; i < 1023; i++) t.tick();
  assert.throws(() => t.tick(), OutlineTimeout);
  assert.doesNotThrow(() => new Budget().check());
});

test("LineIndex and cleanName", () => {
  const idx = new LineIndex("a\nbc\n\nd");
  assert.deepEqual([0, 1, 2, 4, 5, 6, 99].map((o) => idx.line(o)), [1, 1, 2, 2, 3, 4, 4]);
  assert.equal(cleanName("  a\n   b\tc "), "a b c");
  assert.equal(cleanName("x".repeat(200)).length, 120);
});

test("cache: keyed by path, mtime, size and content; least recently used goes first", () => {
  const sym: OutlineSymbol[] = [{ name: "a", kind: "function", line: 1, children: [] }];
  const k = outlineCacheKey("/a.py", 1, 10, "def a(): pass");
  assert.notEqual(k, outlineCacheKey("/a.py", 2, 10, "def a(): pass"));
  assert.notEqual(k, outlineCacheKey("/a.py", 1, 10, "def b(): pass"));
  assert.equal(k, outlineCacheKey("/a.py", 1, 10, "def a(): pass"));
  cacheOutline(k, sym);
  assert.equal(cachedOutline(k), sym);
  for (let i = 0; i < 23; i++) cacheOutline(`other${i}`, []);
  assert.equal(cachedOutline(k), sym); // touched: now the most recent
  cacheOutline("one-more", []);
  assert.equal(cachedOutline(k), sym);
  assert.equal(cachedOutline("other0"), undefined); // evicted
});

const tree: OutlineSymbol[] = [
  {
    name: "A",
    kind: "class",
    line: 1,
    endLine: 20,
    children: [
      { name: "f", kind: "method", line: 3, endLine: 8, children: [] },
      { name: "g", kind: "method", line: 10, endLine: 18, children: [{ name: "inner", kind: "function", line: 12, endLine: 14, children: [] }] },
    ],
  },
  { name: "b", kind: "function", line: 25, endLine: 30, children: [] },
  { name: "section", kind: "section", line: 40, children: [] },
];

test("flattenOutline: preorder with depth and parent", () => {
  const flat = flattenOutline(tree);
  assert.deepEqual(
    flat.map((s) => [s.id, s.name, s.depth, s.parent, s.hasChildren]),
    [
      ["o0", "A", 0, -1, true],
      ["o1", "f", 1, 0, false],
      ["o2", "g", 1, 0, true],
      ["o3", "inner", 2, 2, false],
      ["o4", "b", 0, -1, false],
      ["o5", "section", 0, -1, false],
    ],
  );
});

test("activeSymbol: innermost symbol containing the line", () => {
  const flat = flattenOutline(tree);
  const order = byLine(flat);
  const at = (line: number) => {
    const i = activeSymbol(flat, order, line);
    return i === -1 ? null : flat[i].name;
  };
  assert.equal(at(0), null); // above the first symbol
  assert.equal(at(1), "A");
  assert.equal(at(5), "f");
  assert.equal(at(9), "A"); // between methods: back to the class
  assert.equal(at(13), "inner");
  assert.equal(at(16), "g");
  assert.equal(at(22), "A"); // after everything ended: the last one above
  assert.equal(at(26), "b");
  assert.equal(at(1000), "section"); // no end line: runs on
});

test("byLine: sorts by line, preorder for ties", () => {
  const flat = flattenOutline([
    { name: "z", kind: "function", line: 9, children: [] },
    { name: "a", kind: "class", line: 2, children: [{ name: "a2", kind: "method", line: 2, children: [] }] },
  ]);
  assert.deepEqual(byLine(flat).map((i) => flat[i].name), ["a", "a2", "z"]);
});

test("runOutliner (the worker's path): prepare, parse and extract in one budget", async () => {
  const { loadOutliner, runOutliner } = await import("../src/lib/outline/run.ts");
  const css = await loadOutliner("css");
  assert.deepEqual(rows(runOutliner(css, "less", "@a: 1;\n.b { .m(); }\n", new Budget())), ["selector .b @2"]);
  const sh = await loadOutliner("shell");
  assert.deepEqual(rows(runOutliner(sh, "", "x() { :; }\n", new Budget())), ["function x @1"]);
  // the SCSS / LESS preprocessing counts too: an expired budget gives up in it
  const big = ".a { .m(); }\n".repeat(20000);
  assert.throws(() => runOutliner(css, "less", big, new Budget(Date.now() - 1)), OutlineTimeout);
});
