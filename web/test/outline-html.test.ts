import { test } from "node:test";
import assert from "node:assert/strict";
import { outlineHtml } from "../src/lib/outline/html.ts";
import { find, fixture, rows } from "./outline-util.ts";

test("html: headings, landmarks, ids, script and style contents", () => {
  const out = outlineHtml(fixture("sample.html"));
  assert.deepEqual(rows(out), [
    "style style @5",
    "  selector body @6",
    "  media @media (max-width: 600px) @7",
    "    selector .nav @8",
    "landmark header @14", // the commented-out <h1> is not listed
    '  landmark nav "Primary" @15',
    "    element li#home-link @15",
    "landmark main#content @17",
    "  heading Tom & Jerry @18",
    "  landmark article @19",
    "    heading Intro @20",
    "  landmark aside @23",
    "    heading <h3> @23", // empty heading
    "  landmark form#find @24", // role="search"
    "    element input#q @24",
    "landmark footer @26",
    "script script @27",
    "  class App @28",
    "    method start @29",
    "script script (text/x-template) @33", // not JavaScript: no children
  ]);
  assert.equal(find(out, "main#content")?.endLine, 25);
});

test("html: script types and a heading over two lines", () => {
  const src = [
    "<h2 class=t>Part",
    "  <em>one</em></h2>",
    '<script src="app.js"></script>',
    '<script type="text/babel">const App = () => <div/>;</script>',
    '<script lang="ts">function f(a: number) {}</script>',
    '<script type="application/json">{"function": 1}</script>',
    "",
  ].join("\n");
  assert.deepEqual(rows(outlineHtml(src)), [
    "heading Part one @1",
    "script script app.js @3",
    "script script @4", // a type is only shown for scripts that are not parsed
    "  function App @4",
    "script script @5",
    "  function f @5",
    "script script (application/json) @6",
  ]);
});
