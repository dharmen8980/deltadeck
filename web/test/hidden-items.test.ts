import { test } from "node:test";
import assert from "node:assert/strict";

import type { HiddenRow } from "../src/lib/api.ts";
import {
  formatCount,
  groupRules,
  headerState,
  hiddenLabel,
  isUserHidden,
  listedRows,
  mergeSticky,
  pageItems,
  partialMessage,
  patternRows,
} from "../src/lib/hidden-items.ts";

const row = (path: string, group: HiddenRow["group"], extra: Partial<HiddenRow> = {}): HiddenRow => ({
  path,
  name: path.split("/").pop() ?? path,
  dir: true,
  group,
  visible: false,
  ...extra,
});

test("headerState: all, none, mixed, no checkboxes", () => {
  assert.equal(headerState([row("a", "builtin", { visible: true }), row("b", "builtin", { visible: true })]), "checked");
  assert.equal(headerState([row("a", "builtin"), row("b", "builtin")]), "unchecked");
  assert.equal(headerState([row("a", "builtin", { visible: true }), row("b", "builtin")]), "mixed");
  assert.equal(headerState([row(".env", "deny"), row(".env.local", "deny")]), "unchecked");
  assert.equal(headerState([]), "unchecked");
  // protected rows do not count
  assert.equal(headerState([row("a", "git", { visible: true }), row(".env", "deny")]), "checked");
});

test("mergeSticky: a row the server no longer returns stays, as the user set it, in order", () => {
  const sticky = new Map([["dist", row("dist", "builtin", { visible: true })]]);
  const next = [row("build", "builtin"), row("logs", "git"), row("node_modules", "builtin")];
  const out = mergeSticky(sticky, next);
  assert.deepEqual(out.map((r) => r.path), ["build", "dist", "node_modules", "logs"]);
  assert.equal(out.find((r) => r.path === "dist")?.visible, true);
});

test("mergeSticky: the server's row wins when it is still returned", () => {
  const sticky = new Map([["build", row("build", "builtin", { visible: true })]]);
  const out = mergeSticky(sticky, [row("build", "builtin", { visible: false })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].visible, false);
});

test("mergeSticky: order by group, then folded path", () => {
  const out = mergeSticky(new Map(), [row("b", "user"), row("B2", "builtin"), row("a", "builtin"), row(".env", "deny")]);
  assert.deepEqual(out.map((r) => r.path), ["a", "B2", "b", ".env"]);
});

test("groupRules: more than 3 rows with the same rule collapse into one sub-group", () => {
  const rows = [
    row("a/build", "builtin", { rule: "build" }),
    row("b/build", "builtin", { rule: "build" }),
    row("c", "builtin", { rule: "dist" }),
    row("d/build", "builtin", { rule: "build" }),
    row("e/build", "builtin", { rule: "build" }),
    row("x/node_modules", "builtin", { rule: "node_modules" }),
  ];
  const items = groupRules(rows);
  assert.deepEqual(
    items.map((i) => (i.kind === "rule" ? `rule:${i.rule}:${i.rows.length}` : i.row.path)),
    ["rule:build:4", "c", "x/node_modules"],
  );
  // exactly 3 stay flat
  assert.deepEqual(groupRules(rows.slice(0, 4)).map((i) => i.kind), ["row", "row", "row", "row"]);
});

test("groupRules then pageItems: a sub-group covers its rows past the first page", () => {
  // 600 .pyc files sorted among 300 other rows: the page of 200 items holds the whole sub-group
  const rows: HiddenRow[] = [];
  for (let i = 0; i < 300; i++) rows.push(row(`a${String(i).padStart(3, "0")}/node_modules`, "builtin", { rule: "node_modules" }));
  for (let i = 0; i < 600; i++) rows.push(row(`b${String(i).padStart(3, "0")}/__pycache__`, "builtin", { rule: "__pycache__" }));
  const items = groupRules(rows);
  assert.equal(items.length, 2);
  const page = pageItems(items, 200);
  const pyc = page.find((i) => i.kind === "rule" && i.rule === "__pycache__");
  assert.ok(pyc && pyc.kind === "rule");
  assert.equal(pyc.rows.length, 600);
  // grouping only the first page (the old way) split it
  const old = groupRules(rows.slice(0, 200));
  assert.equal(old.some((i) => i.kind === "rule" && i.rule === "__pycache__"), false);
  // a group's header state follows all its rows
  assert.equal(headerState(pyc.rows.map((r, i) => ({ ...r, visible: i < 599 }))), "mixed");
});

test("pageItems: flat rows are paged; listedRows: flat rows and open sub-groups", () => {
  const flat = Array.from({ length: 450 }, (_, i) => row(`f${i}`, "builtin", { rule: `r${i}` }));
  assert.equal(pageItems(groupRules(flat), 200).length, 200);
  assert.equal(pageItems(groupRules(flat), 400).length, 400);
  const items = groupRules([
    ...Array.from({ length: 5 }, (_, i) => row(`p${i}/__pycache__`, "builtin", { rule: "__pycache__" })),
    row("x/.DS_Store", "builtin", { rule: ".DS_Store", dir: false }),
  ]);
  assert.deepEqual(listedRows(items, () => false).map((r) => r.path), ["x/.DS_Store"]);
  assert.equal(listedRows(items, (rule) => rule === "__pycache__").length, 6);
});

test("mergeSticky: a sticky row inside a folder listed as hidden is hidden too", () => {
  // shown inside a __pycache__, then the folder was hidden again: the file is no longer visible
  const sticky = new Map([["a/__pycache__/m.pyc", row("a/__pycache__/m.pyc", "builtin", { dir: false, visible: true, choice: "show" })]]);
  const out = mergeSticky(sticky, [row("a/__pycache__", "builtin", { rule: "__pycache__" })]);
  const m = out.find((r) => r.path === "a/__pycache__/m.pyc");
  assert.equal(m?.visible, false);
  assert.equal(m?.choice, undefined);
  // inside a folder the user hid: left out (it can only be shown with the folder; the server says 400)
  const hid = mergeSticky(sticky, [row("a/__pycache__", "user", { choice: "hide" })]);
  assert.deepEqual(hid.map((r) => r.path), ["a/__pycache__"]);
  const pat = mergeSticky(sticky, [row("a", "user", { rule: "a" })]);
  assert.deepEqual(pat.map((r) => r.path), ["a"]);
  // a visible folder (shown, partly) does not hide what is in it
  const open = mergeSticky(sticky, [row("a/__pycache__", "builtin", { visible: true, choice: "show" })]);
  assert.equal(open.find((r) => r.path === "a/__pycache__/m.pyc")?.visible, true);
  // a name sharing a prefix is not inside
  const other = mergeSticky(new Map([["ab/x", row("ab/x", "builtin", { visible: true })]]), [row("a", "user", { choice: "hide" })]);
  assert.equal(other.find((r) => r.path === "ab/x")?.visible, true);
});

test("isUserHidden", () => {
  assert.equal(isUserHidden(row("a", "user", { choice: "hide" })), true);
  assert.equal(isUserHidden(row("a", "git", { choice: "hide" })), true);
  assert.equal(isUserHidden(row("a", "user", { rule: "*.log" })), true);
  assert.equal(isUserHidden(row("a", "user", { rule: "*.log", visible: true })), false);
  assert.equal(isUserHidden(row("a", "builtin", { rule: "__pycache__" })), false);
});

test("partialMessage", () => {
  assert.equal(partialMessage(0, 600, "x is protected"), "x is protected");
  assert.equal(partialMessage(400, 1200, "x is protected"), "x is protected (400 of 1,200 were changed first)");
});

test("formatCount", () => {
  assert.equal(formatCount(null), "");
  assert.equal(formatCount(undefined), "");
  assert.equal(formatCount({ files: 10000, more: true }), "10,000+");
  assert.equal(formatCount({ files: 1, more: false }), "1 file");
  assert.equal(formatCount({ files: 812, more: false }), "812 files");
  assert.equal(formatCount({ files: 0, more: false }), "0 files");
});

test("patternRows: each pattern with the rows it hides", () => {
  const rows = [
    row("a/app.log", "user", { rule: "*.log", dir: false }),
    row("b.log", "user", { rule: "*.LOG", dir: false }),
    row("notes/old.md", "user", { choice: "hide", dir: false }),
    row("x.log", "builtin", { rule: "*.log" }),
  ];
  const out = patternRows(["*.log", "fixtures"], rows);
  assert.deepEqual(
    out.map((p) => [p.rule, p.rows.map((r) => r.path)]),
    [["*.log", ["a/app.log", "b.log"]], ["fixtures", []]],
  );
});

test("hiddenLabel", () => {
  assert.equal(hiddenLabel("git"), "Ignored by git");
  assert.equal(hiddenLabel("ignore"), "On the viewer's ignore list");
  assert.equal(hiddenLabel("deny"), "Protected: may contain secrets");
  assert.equal(hiddenLabel("user"), "Hidden by you");
  assert.equal(hiddenLabel("user", "/docs/old"), "Hidden by you (/docs/old)");
  assert.equal(hiddenLabel("ignore", "build"), "On the viewer's ignore list (build)");
});
