import { test } from "node:test";
import assert from "node:assert/strict";

import { escapeHtml, parseLineHash, plainHtml } from "../src/lib/code-lines.ts";
import { formatBytes, plural, whenMs } from "../src/lib/format.ts";

test("format: plural, formatBytes, whenMs", () => {
  assert.equal(plural(1, "line"), "1 line");
  assert.equal(plural(2, "line"), "2 lines");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(NaN), "?");
  assert.equal(whenMs(2), 2000);
  assert.equal(whenMs(2e12), 2e12);
  assert.equal(whenMs("1970-01-01T00:00:01Z"), 1000);
  assert.ok(Number.isNaN(whenMs(null)));
});

test("code-lines: line hashes and plain lines", () => {
  assert.equal(parseLineHash("L12"), 12);
  assert.equal(parseLineHash("heading"), null);
  assert.equal(escapeHtml(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  assert.equal(
    plainHtml("a\n<b>\n"),
    '<pre class="shiki"><code><span class="line" data-line="1" id="L1">a</span>\n<span class="line" data-line="2" id="L2">&lt;b&gt;</span></code></pre>',
  );
});
