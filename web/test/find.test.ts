import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cellMatches,
  cellsText,
  compileFind,
  counterLabel,
  DEFAULT_FIND_OPTIONS,
  findInCells,
  findInText,
  lineAt,
  lineStarts,
  lowerBound,
  matchesToLines,
  spansByLine,
  step,
  type FindOptions,
} from "../src/lib/find/core.ts";
import { runFind, TOO_SLOW } from "../src/lib/find/run.ts";

const opts = (o: Partial<FindOptions> = {}): FindOptions => ({ ...DEFAULT_FIND_OPTIONS, ...o });

function re(q: string, o: Partial<FindOptions> = {}): RegExp {
  const c = compileFind(q, opts(o));
  assert.ok(c && c.ok, `compiles: ${q}`);
  return c.re;
}

const spans = (text: string, q: string, o: Partial<FindOptions> = {}) => {
  const r = findInText(text, re(q, o));
  return r.starts.map((s, i) => text.slice(s, r.ends[i]));
};

test("empty query compiles to nothing", () => {
  assert.equal(compileFind("", opts()), null);
});

test("plain text: case-insensitive by default, case-sensitive on request", () => {
  assert.deepEqual(spans("Foo foo FOO", "foo"), ["Foo", "foo", "FOO"]);
  assert.deepEqual(spans("Foo foo FOO", "foo", { caseSensitive: true }), ["foo"]);
});

test("plain text: regex characters are literal", () => {
  assert.deepEqual(spans("a.b axb (x) [y] $1 a\\b", "a.b"), ["a.b"]);
  assert.deepEqual(spans("(x) [y] $1 a\\b c/d", "(x)"), ["(x)"]);
  assert.deepEqual(spans("(x) [y] $1 a\\b c/d", "[y]"), ["[y]"]);
  assert.deepEqual(spans("(x) [y] $1 a\\b c/d", "$1"), ["$1"]);
  assert.deepEqual(spans("(x) [y] $1 a\\b c/d", "a\\b"), ["a\\b"]);
  assert.deepEqual(spans("(x) [y] $1 a\\b c/d", "c/d"), ["c/d"]);
});

test("whole word: no letter, digit or underscore around", () => {
  const t = "cat concat cat_x cats cat. (cat) 1cat café caté";
  const r = findInText(t, re("cat", { wholeWord: true }));
  assert.deepEqual(r.starts, [0, 22, 28]);
  // accented letters count as word characters
  assert.deepEqual(spans("café cafés", "café", { wholeWord: true }), ["café"]);
  assert.deepEqual(spans("Straße strasse", "straße", { wholeWord: true }), ["Straße"]);
});

test("whole word with a regex alternation wraps the whole pattern", () => {
  assert.deepEqual(spans("foo bar foobar barfoo", "foo|bar", { regex: true, wholeWord: true }), ["foo", "bar"]);
});

test("regex: groups, classes, anchors per line", () => {
  assert.deepEqual(spans("v1.2 v10.20 x3.4", "v\\d+\\.\\d+", { regex: true }), ["v1.2", "v10.20"]);
  assert.deepEqual(spans("ab\nab\nxab", "^ab", { regex: true }), ["ab", "ab"]);
  assert.deepEqual(spans("ab\nab\nxab", "ab$", { regex: true }), ["ab", "ab", "ab"]);
});

test("regex: a match never spans lines", () => {
  assert.deepEqual(spans("foo\nbar", "foo\\s*bar", { regex: true }), []);
  assert.deepEqual(spans("foo\nbar", "o\\s+", { regex: true }), []);
  assert.deepEqual(spans("foo \nbar", "o\\s+", { regex: true }), ["o "]);
});

test("invalid regex: an error, no throw", () => {
  for (const q of ["(", "[a-", "a{2,1}", "*a", "(?<n>a)(?<n>b)"]) {
    const c = compileFind(q, opts({ regex: true }));
    assert.ok(c && !c.ok, q);
    assert.ok(c.error.length > 0 && c.error.length <= 120);
    assert.ok(!c.error.startsWith("Invalid regular expression"), c.error);
  }
});

test("regex accepted without Unicode mode too (\\- and lone braces)", () => {
  assert.deepEqual(spans("a-b a_b", "a\\-b", { regex: true }), ["a-b"]);
  assert.deepEqual(spans("x{ y}", "x{", { regex: true }), ["x{"]);
});

test("zero-length matches are skipped and never loop", () => {
  assert.deepEqual(spans("abc", "^", { regex: true }), []);
  assert.deepEqual(spans("bab", "a*", { regex: true }), ["a"]);
  assert.deepEqual(spans("abc", "(?=b)", { regex: true }), []);
  assert.deepEqual(spans("a😀b", "x*", { regex: true }), []);
  assert.deepEqual(findInText("", re("x*", { regex: true })).starts, []);
});

test("overlapping occurrences: non-overlapping, left to right", () => {
  assert.deepEqual(findInText("aaaa", re("aa")).starts, [0, 2]);
  assert.deepEqual(findInText("aaa", re("aa")).starts, [0]);
});

test("unicode: astral characters, case folding, accents not folded", () => {
  const t = "😀 ok 😀 ÉCOLE école ecole";
  const r = findInText(t, re("😀"));
  assert.deepEqual(r.starts, [0, 6]);
  assert.equal(r.ends[0] - r.starts[0], 2);
  assert.deepEqual(spans(t, "école"), ["ÉCOLE", "école"]);
  assert.deepEqual(spans("ΣΊΣΥΦΟΣ σίσυφος", "σίσυφος"), ["ΣΊΣΥΦΟΣ", "σίσυφος"]);
  assert.deepEqual(spans("naïve naive", "naive"), ["naive"]);
  assert.deepEqual(spans("😀😀", ".", { regex: true }), ["😀", "😀"]);
});

test("cap: stops at max and says so", () => {
  const t = "x ".repeat(12000);
  const r = findInText(t, re("x"));
  assert.equal(r.starts.length, 5000);
  assert.equal(r.capped, true);
  const exact = findInText("x x x", re("x"), { max: 3 });
  assert.equal(exact.starts.length, 3);
  assert.equal(exact.capped, false);
  const small = findInText("x x x x", re("x"), { max: 3 });
  assert.equal(small.capped, true);
});

test("budget: stops when time runs out", () => {
  let t = 0;
  const now = () => (t += 1);
  const text = Array.from({ length: 5000 }, () => "a b c").join("\n");
  const r = findInText(text, re("a"), { budgetMs: 20, now });
  assert.equal(r.timedOut, true);
  assert.ok(r.starts.length > 0 && r.starts.length < 5000);
  const ok = findInText(text, re("a"), { budgetMs: 1e9 });
  assert.equal(ok.timedOut, false);
  assert.equal(ok.starts.length, 5000);
});

test("budget on one long line with many matches", () => {
  let t = 0;
  const r = findInText("ab".repeat(100000), re("b"), { budgetMs: 10, now: () => (t += 1), max: 1e9 });
  assert.equal(r.timedOut, true);
  assert.ok(r.starts.length < 100000);
});

test("runFind (no worker here): plain and regex, errors, caps", async () => {
  const r = await runFind("k1", "one two one", "one", opts());
  assert.deepEqual(r.starts, [0, 8]);
  const bad = await runFind("k1", "one", "(", opts({ regex: true }));
  assert.equal(bad.starts.length, 0);
  assert.ok(bad.error);
  const rx = await runFind("k1", "a1 b22 c333", "\\d{2,}", opts({ regex: true }));
  assert.deepEqual(rx.starts, [4, 8]);
  const capped = await runFind("k2", "y".repeat(100), "y", opts(), 10);
  assert.equal(capped.capped, true);
  assert.equal(capped.starts.length, 10);
  assert.equal(typeof TOO_SLOW, "string");
});

test("line mapping: starts, lineAt, matchesToLines, spansByLine", () => {
  const text = "alpha\nbeta alpha\n\nalpha";
  const ls = lineStarts(text);
  assert.deepEqual(ls, [0, 6, 17, 18]);
  assert.equal(lineAt(ls, 0), 1);
  assert.equal(lineAt(ls, 5), 1); // the newline belongs to line 1
  assert.equal(lineAt(ls, 6), 2);
  assert.equal(lineAt(ls, 18), 4);
  const r = findInText(text, re("alpha"));
  const lm = matchesToLines(ls, r);
  assert.deepEqual(lm, [
    { line: 1, start: 0, end: 5 },
    { line: 2, start: 5, end: 10 },
    { line: 4, start: 0, end: 5 },
  ]);
  assert.deepEqual([...spansByLine(lm)], [
    [1, [[0, 5]]],
    [2, [[5, 10]]],
    [4, [[0, 5]]],
  ]);
  // a text that starts at a later line (a segment of a large file)
  assert.equal(matchesToLines(ls, r, 1001)[2].line, 1004);
});

test("large file: a match only in the middle maps to its line", () => {
  const lines = Array.from({ length: 40000 }, (_, i) => `const value_${i} = ${i};`);
  lines[20000] = "const needle = 'here';";
  const text = lines.join("\n") + "\n";
  assert.ok(text.length > 300 * 1024);
  const r = findInText(text, re("needle"));
  assert.equal(r.starts.length, 1);
  const lm = matchesToLines(lineStarts(text), r);
  assert.deepEqual(lm, [{ line: 20001, start: 6, end: 12 }]);
});

test("CRLF lines: the carriage return is not part of the line, columns unchanged", () => {
  const text = "foo\r\nbar foo\r\n";
  const r = findInText(text, re("foo$", { regex: true }));
  // the line ends before its "\r", as the rendered line does
  assert.equal(r.starts.length, 2);
  const lm = matchesToLines(lineStarts(text), findInText(text, re("foo")));
  assert.deepEqual(lm, [
    { line: 1, start: 0, end: 3 },
    { line: 2, start: 4, end: 7 },
  ]);
});

test("lowerBound", () => {
  assert.equal(lowerBound([1, 3, 5], 0), 0);
  assert.equal(lowerBound([1, 3, 5], 3), 1);
  assert.equal(lowerBound([1, 3, 5], 4), 2);
  assert.equal(lowerBound([1, 3, 5], 9), 3);
  assert.equal(lowerBound([], 9), 0);
});

test("cells: per cell, row-major, never across cells, empty cells skipped", () => {
  const rows = [
    ["name", "city"],
    ["Ada", "London"],
    ["", "don"],
    ["Don", "Paris\nLondon"],
  ];
  const r = findInCells(rows, re("don"));
  assert.deepEqual(r.matches, [
    { row: 1, col: 1, start: 3, end: 6 },
    { row: 2, col: 1, start: 0, end: 3 },
    { row: 3, col: 0, start: 0, end: 3 },
    { row: 3, col: 1, start: 9, end: 12 },
  ]);
  // "a" at a cell end and "L" at the next cell start do not join
  assert.equal(findInCells([["xa", "Ly"]], re("aL")).matches.length, 0);
  // a line break inside a cell is a space for matching
  assert.equal(findInCells([["Paris\nLondon"]], re("s L", {})).matches.length, 1);
  // anchors are per cell
  assert.equal(findInCells([["ab", "ab"]], re("^ab$", { regex: true })).matches.length, 2);
});

test("cells: width limit, caps, mapping from a worker-style result", () => {
  const rows = [["x", "x", "x"], ["x", "x", "x"]];
  assert.equal(findInCells(rows, re("x"), { cols: 2 }).matches.length, 4);
  const capped = findInCells(rows, re("x"), { max: 4 });
  assert.equal(capped.matches.length, 4);
  assert.equal(capped.capped, true);
  const ct = cellsText([["ab", "cab"], ["b"]]);
  assert.equal(ct.text, "ab\ncab\nb");
  assert.deepEqual(cellMatches(ct, findInText(ct.text, re("b"))), [
    { row: 0, col: 0, start: 1, end: 2 },
    { row: 0, col: 1, start: 2, end: 3 },
    { row: 1, col: 0, start: 0, end: 1 },
  ]);
});

test("cells: a large sheet with a match near the end", () => {
  const rows = Array.from({ length: 5000 }, (_, i) => [`row ${i}`, `value ${i * 7}`, "filler text"]);
  rows[4990][2] = "the needle";
  const r = findInCells(rows, re("needle"));
  assert.deepEqual(r.matches, [{ row: 4990, col: 2, start: 4, end: 10 }]);
});

test("counter and stepping", () => {
  assert.equal(counterLabel(2, 17, false), "3 of 17");
  assert.equal(counterLabel(0, 5000, true), "1 of 5,000+");
  assert.equal(counterLabel(-1, 0, false), "No results");
  assert.equal(counterLabel(-1, 4, false), "4 found");
  assert.deepEqual(step(-1, 3, 1), { index: 0, wrapped: false });
  assert.deepEqual(step(-1, 3, -1), { index: 2, wrapped: false });
  assert.deepEqual(step(2, 3, 1), { index: 0, wrapped: true });
  assert.deepEqual(step(0, 3, -1), { index: 2, wrapped: true });
  assert.deepEqual(step(1, 3, 1), { index: 2, wrapped: false });
  assert.deepEqual(step(0, 0, 1), { index: -1, wrapped: false });
});

// ---------- keys ----------

import { findKeyAction, MENU_ECHO_MS, menuEchoFilter, seedFromSearch, seedFromSelection, SEED_MAX } from "../src/lib/find/keys.ts";
import { DOC_SKIP, FIND_SKIP } from "../src/lib/find/dom.ts";
import { registerFindSource, subscribeFindSources, type FindSource } from "../src/lib/find/registry.ts";

const key = (k: string, mods: Partial<{ meta: boolean; ctrl: boolean; shift: boolean; alt: boolean }> = {}) => ({
  key: k,
  metaKey: !!mods.meta,
  ctrlKey: !!mods.ctrl,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
});

test("find keys: Cmd on a Mac, Ctrl elsewhere", () => {
  assert.equal(findKeyAction(key("f", { meta: true }), true), "open");
  assert.equal(findKeyAction(key("f", { ctrl: true }), true), null);
  assert.equal(findKeyAction(key("f", { ctrl: true }), false), "open");
  assert.equal(findKeyAction(key("f", { meta: true }), false), null);
  assert.equal(findKeyAction(key("F", { ctrl: true }), false), "open");
});

test("find keys: next / previous, F3, and what is not ours", () => {
  assert.equal(findKeyAction(key("g", { meta: true }), true), "next");
  assert.equal(findKeyAction(key("G", { meta: true, shift: true }), true), "prev");
  assert.equal(findKeyAction(key("F3"), false), "next");
  assert.equal(findKeyAction(key("F3", { shift: true }), true), "prev");
  assert.equal(findKeyAction(key("f", { meta: true, shift: true }), true), null);
  assert.equal(findKeyAction(key("f", { meta: true, alt: true }), true), null);
  assert.equal(findKeyAction(key("f"), true), null);
  assert.equal(findKeyAction(key("k", { meta: true }), true), null);
  assert.equal(findKeyAction(key("f", { meta: true, ctrl: true }), true), null);
});

test("seedFromSelection: first non-blank line, trimmed, capped", () => {
  assert.equal(seedFromSelection("  foo bar \n baz"), "foo bar");
  assert.equal(seedFromSelection("\n\r\n  second\nthird"), "second");
  assert.equal(seedFromSelection("   \n  "), null);
  assert.equal(seedFromSelection(""), null);
  assert.equal(seedFromSelection(null), null);
  assert.equal(seedFromSelection("x".repeat(SEED_MAX + 50))?.length, SEED_MAX);
});

test("compileFind: error messages are short and regex mode falls back to non-unicode", () => {
  const bad = compileFind("(", { ...DEFAULT_FIND_OPTIONS, regex: true });
  assert.ok(bad && !bad.ok);
  if (bad && !bad.ok) assert.doesNotMatch(bad.error, /^Invalid regular expression/);
  const loose = compileFind("a\\-b", { ...DEFAULT_FIND_OPTIONS, regex: true });
  assert.ok(loose && loose.ok);
  if (loose && loose.ok) assert.deepEqual(findInText("xa-b", loose.re).starts, [1]);
});

test("seed from the global search: words without quotes and wildcards, one phrase", () => {
  assert.equal(seedFromSearch("needle"), "needle");
  assert.equal(seedFromSearch('"exact phrase"'), "exact phrase");
  assert.equal(seedFromSearch("  conf*  'files' "), "conf files");
  assert.equal(seedFromSearch("Ünïcode Case"), "Ünïcode Case");
  assert.equal(seedFromSearch('"" * \'\''), null);
  assert.equal(seedFromSearch(""), null);
  assert.equal(seedFromSearch(undefined), null);
  assert.equal(seedFromSearch("x".repeat(SEED_MAX + 50))?.length, SEED_MAX);
});

test("documents skip their controls and the print-only diagram copy", () => {
  assert.ok(FIND_SKIP.split(",").includes(".mermaid-print"));
  for (const sel of [".no-print", "button", ".sr-only", "style"]) assert.ok(DOC_SKIP.split(",").includes(sel), sel);
});

test("registry: relink says the set changed, changed names the source", () => {
  const src: FindSource = { kind: "dom", root: () => null };
  const seen: (FindSource | null)[] = [];
  const stop = subscribeFindSources((c) => seen.push(c));
  const h = registerFindSource(src);
  h.changed();
  h.relink();
  h.unregister();
  stop();
  assert.deepEqual(seen, [null, src, null, null]);
});

test("menu echo: the desktop menu's copy of a handled shortcut is dropped, once", () => {
  let t = 1000;
  const f = menuEchoFilter(() => t);
  assert.equal(f.menu("open"), true); // a menu click with no key before it
  f.key("next");
  t += 50;
  assert.equal(f.menu("next"), false); // the echo
  assert.equal(f.menu("next"), true); // a second click runs
  f.key("next");
  assert.equal(f.menu("prev"), true); // another command is no echo
  f.key("open");
  t += MENU_ECHO_MS + 1;
  assert.equal(f.menu("open"), true); // too late to be an echo
});

test("cells: header and rows in display order, matches name their cell", () => {
  const ct = cellsText([["Name", "City"], ["ann", "Oslo"], ["", "oslo two"]], 2);
  const r = findInText(ct.text, re("oslo"));
  assert.deepEqual(
    cellMatches(ct, r).map((m) => [m.row, m.col, m.start]),
    [
      [1, 1, 0],
      [2, 1, 0],
    ],
  );
});

// ---------- review fixes ----------

import { shiftPos } from "../src/lib/find/core.ts";
import { joinFlat, type FlatItem } from "../src/lib/find/dom.ts";

test("CRLF: `$` matches at the end of a line, offsets unchanged", () => {
  const text = "a foo\r\nb foo\r\nfoo x\r\n";
  const r = findInText(text, re("foo$", { regex: true }));
  assert.deepEqual(r.starts, [2, 9]);
  assert.deepEqual(r.ends, [5, 12]);
  assert.deepEqual(spans(text, "foo"), ["foo", "foo", "foo"]);
});

test("cells: a CR in a cell is a space", () => {
  const ct = cellsText([["a\r\nb"]], 1);
  assert.equal(ct.text, "a  b");
});

test("shiftPos: a place keeps its text through an edit before it", () => {
  const before = "Title\nSome foo text and Foo again.";
  const after = "Title\nA new line here\nSome foo text and Foo again.";
  const pos = before.indexOf("Foo");
  assert.equal(after.slice(shiftPos(before, after, pos), shiftPos(before, after, pos) + 3), "Foo");
  assert.equal(shiftPos(before, after, 2), 2); // before the edit
  assert.equal(shiftPos(before, before, 9), 9);
  // removed text around the place: the start of the edit
  assert.equal(shiftPos("abcXYZdef", "abcdef", 4), 3);
  assert.equal(shiftPos("abcXYZdef", "abcdef", 7), 4);
});

const node = (t: string) => ({ t }) as unknown as Text;
const item = (text: string, block: unknown, pre = false): FlatItem => ({ node: node(text), text, block, pre });

test("flatten: a soft line break in a paragraph reads as a space, kept in preformatted text", () => {
  const flat = joinFlat([item("The quick brown\nfox", "p1"), item("item alpha\ncontinued", "li"), item("a\nb", "pre", true)]);
  assert.equal(flat.text, "The quick brown fox\nitem alpha continued\na\nb");
  assert.deepEqual(flat.starts, [0, 20, 41]);
  assert.deepEqual(spans(flat.text, "brown fox"), ["brown fox"]);
  assert.deepEqual(spans(flat.text, "alpha continued"), ["alpha continued"]);
});

test("flatten: <br> breaks the line inside a block", () => {
  const flat = joinFlat([item("Line one", "p"), { br: true }, item("two", "p"), { br: true }, { br: true }, item("three", "p")]);
  assert.equal(flat.text, "Line one\ntwo\nthree");
  assert.deepEqual(spans(flat.text, "onetwo"), []);
  assert.deepEqual(flat.starts, [0, 9, 13]);
});

test("find keys: a non-Latin layout uses the key's position", () => {
  assert.equal(findKeyAction({ ...key("а", { ctrl: true }), code: "KeyF" }, false), "open");
  assert.equal(findKeyAction({ ...key("π", { meta: true }), code: "KeyG" }, true), "next");
  assert.equal(findKeyAction({ ...key("Π", { meta: true, shift: true }), code: "KeyG" }, true), "prev");
  // a Latin layout with F elsewhere (Dvorak): the letter typed counts, not the position
  assert.equal(findKeyAction({ ...key("u", { meta: true }), code: "KeyF" }, true), null);
});
