import { test } from "node:test";
import assert from "node:assert/strict";

import {
  encodeLinkPath,
  linkPathOptions,
  linkTargetAt,
  markdownHeadings,
  NameCache,
  relativePath,
  resolveLinkFile,
  type ProjectName,
} from "../src/lib/complete.ts";

const n = (name: string, def = false): ProjectName => ({ name, def, files: 1 });

test("NameCache answers longer prefixes from a complete shorter one", () => {
  let now = 0;
  const c = new NameCache(64, 1000, () => now);
  assert.equal(c.get("se"), null);
  c.set("se", [n("search", true), n("SearchIndex"), n("select")], 50);
  assert.deepEqual(c.get("SE")?.names.map((r) => r.name), ["search", "SearchIndex", "select"]);
  assert.deepEqual(c.get("sear"), { names: [n("search", true), n("SearchIndex")], complete: true });
  now = 2000;
  assert.equal(c.get("sear"), null, "expired");
});

test("NameCache does not narrow a result cut by the limit", () => {
  const c = new NameCache(64, 1000, () => 0);
  c.set("a", [n("abc"), n("abd")], 2);
  assert.equal(c.get("a")?.complete, false);
  assert.equal(c.get("ab"), null);
});

test("NameCache drops the oldest entries over its size", () => {
  const c = new NameCache(2, 1000, () => 0);
  c.set("aa", []);
  c.set("bb", []);
  c.set("cc", []);
  assert.equal(c.get("aa"), null);
  assert.ok(c.get("cc"));
});

test("linkTargetAt finds paths and anchors after ](", () => {
  assert.deepEqual(linkTargetAt("see [x]("), { kind: "path", typed: "" });
  assert.deepEqual(linkTargetAt("see [x](../do"), { kind: "path", typed: "../do" });
  assert.deepEqual(linkTargetAt("see [x](#ins"), { kind: "anchor", file: "", typed: "ins" });
  assert.deepEqual(linkTargetAt("[x](a/b.md#"), { kind: "anchor", file: "a/b.md", typed: "" });
  assert.equal(linkTargetAt("[x](a b"), null);
  assert.equal(linkTargetAt("[x](a.md) and"), null);
  assert.equal(linkTargetAt("plain (text"), null);
});

test("relativePath and resolveLinkFile", () => {
  assert.equal(relativePath("", "a/b.md"), "a/b.md");
  assert.equal(relativePath("docs", "docs/x.md"), "x.md");
  assert.equal(relativePath("docs/sub", "docs/x.md"), "../x.md");
  assert.equal(relativePath("docs", "server/app.py"), "../server/app.py");
  assert.equal(relativePath("a/b", "a/b/c/d.md"), "c/d.md");
  assert.equal(resolveLinkFile("docs/a.md", "../server/x%20y.md"), "server/x y.md");
  assert.equal(resolveLinkFile("docs/a.md", "/README.md"), "README.md");
  assert.equal(resolveLinkFile("a.md", "../out.md"), null);
  assert.equal(encodeLinkPath("my notes (1).md"), "my%20notes%20%281%29.md");
  for (const name of ["100%.md", "a#b.md", 'q"<x>\'.md', "50% (draft) #2.md"]) {
    const label = encodeLinkPath(`dir/${name}`);
    assert.match(label, /^[^\s()<>"'#]*$/); // linkTargetAt still reads it as one path
    assert.equal(resolveLinkFile("a.md", label), `dir/${name}`);
  }
  assert.equal(encodeLinkPath("100%.md"), "100%25.md");
});

test("linkPathOptions: relative labels, markdown and nearest first, filtered by the typed text", () => {
  const files = [
    { path: "docs/editing.md", kind: "markdown" },
    { path: "docs/img/shot.png", kind: "image" },
    { path: "README.md", kind: "markdown" },
    { path: "docs/search.md", kind: "markdown" },
    { path: "server/app.py", kind: "code" },
  ];
  const all = linkPathOptions(files, "docs/editing.md", "");
  assert.deepEqual(
    all.options.map((o) => o.label),
    ["search.md", "../README.md", "img/shot.png", "../server/app.py"],
  );
  assert.equal(all.capped, false);
  assert.deepEqual(linkPathOptions(files, "docs/editing.md", "../rd").options.map((o) => o.label), ["../README.md"]);
  assert.deepEqual(linkPathOptions(files, "docs/editing.md", "/se").options.map((o) => o.label), ["/docs/search.md", "/server/app.py"]);
  const capped = linkPathOptions(files, "docs/editing.md", "", 2);
  assert.equal(capped.options.length, 2);
  assert.equal(capped.capped, true);
});

test("markdownHeadings: ids as rehype-slug gives them, fences skipped", () => {
  const md = [
    "# Editing (opt-in)",
    "",
    "## The `data` dir",
    "",
    "```sh",
    "# not a heading",
    "```",
    "",
    "Setext title",
    "============",
    "",
    "## The `data` dir",
    "## [Link](x.md) and **bold** snake_case ##",
    "- item",
    "---",
  ].join("\n");
  assert.deepEqual(
    markdownHeadings(md).map((h) => [h.slug, h.text, h.level]),
    [
      ["editing-opt-in", "Editing (opt-in)", 1],
      ["the-data-dir", "The data dir", 2],
      ["setext-title", "Setext title", 1],
      ["the-data-dir-1", "The data dir", 2],
      ["link-and-bold-snake_case", "Link and bold snake_case", 2],
    ],
  );
});

test("markdownHeadings: autolinks keep their text, entities are decoded", () => {
  const md = ["# See <https://x.org/a> now", "## Q &amp; A &lt;3 &#33; &#x41;", "## <b>Bold</b> tag"].join("\n");
  assert.deepEqual(
    markdownHeadings(md).map((h) => [h.slug, h.text]),
    [
      ["see-httpsxorga-now", "See https://x.org/a now"],
      ["q--a-3--a", "Q & A <3 ! A"],
      ["bold-tag", "Bold tag"],
    ],
  );
});
