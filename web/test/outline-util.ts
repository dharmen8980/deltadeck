import { readFileSync } from "node:fs";
import type { OutlineSymbol } from "../src/lib/outline/common.ts";

/** A fixture under test/fixtures/outline (stored as .txt so tsc and eslint skip it). */
export function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/outline/${name}.txt`, import.meta.url), "utf8");
}

/** The outline as indented "kind name @line" rows: compact, and exact about nesting. */
export function rows(symbols: OutlineSymbol[], depth = 0): string[] {
  return symbols.flatMap((s) => [`${"  ".repeat(depth)}${s.kind} ${s.name} @${s.line}`, ...rows(s.children, depth + 1)]);
}

export function find(symbols: OutlineSymbol[], name: string): OutlineSymbol | undefined {
  for (const s of symbols) {
    if (s.name === name) return s;
    const hit = find(s.children, name);
    if (hit) return hit;
  }
  return undefined;
}
