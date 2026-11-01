import { test } from "node:test";
import assert from "node:assert/strict";

import { createPref, readItem, writeItem } from "../src/lib/prefs.ts";

const g = globalThis as { window?: unknown };

function withWindow(storage: unknown, fn: () => void) {
  const prev = g.window;
  g.window = { localStorage: storage };
  try {
    fn();
  } finally {
    g.window = prev;
  }
}

test("prefs: blocked storage reads as the default and still applies for the session", () => {
  const blocked = new Proxy({}, { get: () => () => { throw new DOMException("denied", "SecurityError"); } });
  withWindow(blocked, () => {
    assert.equal(readItem("k"), null);
    writeItem("k", "v"); // does not throw
    const p = createPref("viewer.sort", (raw) => (raw === "mtime" ? "mtime" : "name"), (v) => v);
    assert.equal(p.get(), "name");
    let calls = 0;
    const off = p.subscribe(() => calls++);
    p.set("mtime");
    assert.equal(p.get(), "mtime");
    assert.equal(calls, 1);
    off();
  });
});

test("prefs: saved under the key; null removes it; read once", () => {
  const m = new Map<string, string>([["ldv.pdf-options", '{"paper":"letter"}']]);
  const storage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
  withWindow(storage, () => {
    let parses = 0;
    const p = createPref<string | null>("ldv.pdf-options", (raw) => (parses++, raw), (v) => v);
    assert.equal(p.get(), '{"paper":"letter"}');
    p.get();
    assert.equal(parses, 1);
    p.set("x");
    assert.equal(m.get("ldv.pdf-options"), "x");
    p.set(null);
    assert.equal(m.has("ldv.pdf-options"), false);
  });
});
