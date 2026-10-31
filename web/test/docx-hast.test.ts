import { test } from "node:test";
import assert from "node:assert/strict";
import type { Element, Root, RootContent } from "hast";
import { docxTree } from "../src/lib/docx-hast.ts";
import { rehypeChangeMarks } from "../src/lib/rehype-change-marks.ts";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

const tops = (tree: Root) => tree.children.filter((n): n is Element => n.type === "element");

function find(node: Root | Element, tag: string): Element[] {
  const out: Element[] = [];
  for (const c of node.children as RootContent[]) {
    if (c.type !== "element") continue;
    if (c.tagName === tag) out.push(c);
    out.push(...find(c, tag));
  }
  return out;
}

const text = (node: Root | Element | RootContent): string =>
  node.type === "text" ? node.value : "children" in node ? node.children.map(text).join("") : "";

test("headings get ids, blocks get positions", () => {
  const tree = docxTree("<h1>Project plan</h1>\n<p>Hello <strong>world</strong></p>\n<ul><li>a</li><li>b</li></ul>", [
    [1, 1],
    [3, 3],
    [5, 6],
  ]);
  const t = tops(tree);
  assert.deepEqual(
    t.map((e) => e.tagName),
    ["h1", "p", "ul"],
  );
  assert.equal(t[0].properties.id, "project-plan");
  assert.deepEqual(
    t.map((e) => [e.position?.start.line, e.position?.end.line]),
    [
      [1, 1],
      [3, 3],
      [5, 6],
    ],
  );
});

test("positions dropped when blocks do not match", () => {
  const tree = docxTree("<p>a</p>\n<p>b</p>", [[1, 1]]);
  assert.ok(tops(tree).every((e) => e.position === undefined));
});

test("dangerous markup is removed", () => {
  const tree = docxTree(
    '<p onclick="x()" style="color:red" class="c">hi<script>alert(1)</script><style>p{}</style>' +
      '<a href="javascript:alert(1)">js</a><a href="file:///x">f</a><a href="https://ok.example">ok</a>' +
      '<a href="#footnote-1">n</a><img src="http://evil/x.png" alt="ext" onerror="x()">' +
      `<img src="data:image/svg+xml;base64,PHN2Zz4=" alt="vec"><img src="${PNG}" alt="png">` +
      '<iframe src="x"></iframe><svg><text>svgtext</text></svg><input value="v"><span>kept</span></p>',
    [[1, 1]],
  );
  const p = tops(tree)[0];
  assert.deepEqual(p.properties, {});
  const s = JSON.stringify(tree);
  for (const bad of ["onclick", "onerror", "style", "script", "alert", "javascript", "file:", "evil", "svg", "iframe", "input"]) {
    assert.ok(!s.toLowerCase().includes(bad), bad);
  }
  const hrefs = find(tree, "a").map((a) => a.properties.href);
  assert.deepEqual(hrefs, [undefined, undefined, "https://ok.example", "#footnote-1"]);
  const imgs = find(tree, "img").map((i) => [i.properties.alt, i.properties.src]);
  assert.deepEqual(imgs, [
    ["ext", undefined],
    ["vec", undefined],
    ["png", PNG],
  ]);
  assert.ok(text(p).includes("kept"));
});

test("ids are prefixed so they cannot clobber the page", () => {
  const tree = docxTree('<ol><li id="footnote-1"><p>note</p></li></ol>', [[1, 1]]);
  assert.equal(find(tree, "li")[0].properties.id, "user-content-footnote-1");
});

test("table spans survive", () => {
  const tree = docxTree('<table><tr><td colspan="2" rowspan="3">x</td></tr></table>', [[1, 3]]);
  const td = find(tree, "td")[0];
  assert.equal(td.properties.colSpan, 2);
  assert.equal(td.properties.rowSpan, 3);
});

test("change marks use the markdown lines", () => {
  const tree = docxTree("<h1>T</h1>\n<p>a</p>\n<p>b</p>", [
    [1, 1],
    [3, 3],
    [5, 5],
  ]);
  rehypeChangeMarks({ ranges: [{ start: 5, end: 5, kind: "modified" }], removed: [] })()(tree);
  assert.deepEqual(
    tops(tree).map((e) => e.properties.dataChange ?? null),
    [null, null, "modified"],
  );
});

test("bookmark anchors stay link targets", () => {
  const tree = docxTree('<h1><a id="_Toc1"></a>Intro</h1>\n<p><a href="#_Toc1">go</a> <a>plain</a></p>', [
    [1, 1],
    [3, 3],
  ]);
  const spans = find(tree, "span");
  assert.deepEqual(
    spans.map((s) => s.properties.id),
    ["user-content-_Toc1"],
  );
  assert.equal(tops(tree)[0].properties.id, "intro");
  assert.deepEqual(
    find(tree, "a").map((a) => a.properties.href),
    ["#_Toc1", undefined],
  );
});
