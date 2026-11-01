import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { HIGHLIGHTS } from "../src/lib/highlights.ts";

test("highlights: every name in the table has a ::highlight rule in globals.css", () => {
  const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
  for (const { name } of Object.values(HIGHLIGHTS)) {
    assert.ok(css.includes(`::highlight(${name})`), name);
  }
});

test("highlights: find paints over search and change marks, current over all", () => {
  assert.ok(HIGHLIGHTS.findAll.priority > HIGHLIGHTS.search.priority);
  assert.ok(HIGHLIGHTS.findAll.priority > HIGHLIGHTS.changeWord.priority);
  assert.ok(HIGHLIGHTS.findCurrent.priority > HIGHLIGHTS.findAll.priority);
});
