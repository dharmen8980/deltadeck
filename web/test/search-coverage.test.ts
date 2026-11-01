import { test } from "node:test";
import assert from "node:assert/strict";
import { searchCoverageHint, searchCoverageNotice } from "../src/lib/search-coverage.ts";

const res = (extra: object) => ({ indexing: false, names: [], content: [], ...extra });

test("cap reached: says how many files content search covers", () => {
  const r = res({ indexed_files: 49987, indexable_files: 55235, limit_reached: true, limit_reason: "files" });
  assert.equal(searchCoverageNotice(r), "Search covers 49,987 of 55,235 files - limit reached");
  const b = res({ indexed_files: 3, indexable_files: 4, limit_reached: true, limit_reason: "bytes" });
  assert.equal(searchCoverageNotice(b), "Search covers 3 of 4 files - limit reached");
});

test("disk full or write error is named", () => {
  const r = res({ indexed_files: 10, indexable_files: 20, limit_reached: true, limit_reason: "disk" });
  assert.equal(searchCoverageNotice(r), "Search covers 10 of 20 files - disk full");
  const e = res({ indexed_files: 10, indexable_files: 20, limit_reached: true, limit_reason: "error" });
  assert.equal(searchCoverageNotice(e), "Search covers 10 of 20 files - index write failed");
});

test("no notice when everything is covered, while indexing, or from an older server", () => {
  assert.equal(searchCoverageNotice(res({ indexed_files: 5, indexable_files: 5, limit_reached: false })), null);
  const busy = res({ indexing: true, indexed_files: 1, indexable_files: 9, limit_reached: true, limit_reason: "files" });
  assert.equal(searchCoverageNotice(busy), null);
  assert.equal(searchCoverageNotice(res({})), null);
  assert.equal(searchCoverageNotice(null), null);
});

test("the tooltip names the options only where they can be set", () => {
  const r = res({ indexed_files: 3, indexable_files: 4, limit_reached: true, limit_reason: "files" });
  assert.match(searchCoverageHint(r, false) ?? "", /--search-max-files/);
  const d = searchCoverageHint(r, true) ?? "";
  assert.ok(d.startsWith("Documents are indexed first") && !d.includes("--"));
  const e = res({ indexed_files: 3, indexable_files: 4, limit_reached: true, limit_reason: "disk" });
  assert.match(searchCoverageHint(e, false) ?? "", /tries again/);
  assert.equal(searchCoverageHint(res({ limit_reached: false }), false), null);
});
