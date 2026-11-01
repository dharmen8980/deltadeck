// Shared pieces of the code outline extractors (src/lib/outline/<lang>.ts).
// Everything here is pure and DOM-free so the extractors run under
// `node --test` (and could run in a worker or an agent tool later).

import type { Parser, Tree } from "@lezer/common";

export type SymbolKind =
  | "package"
  | "namespace"
  | "module"
  | "class"
  | "interface"
  | "struct"
  | "record"
  | "enum"
  | "annotation"
  | "type"
  | "function"
  | "method"
  | "constructor"
  | "getter"
  | "setter"
  | "property"
  | "field"
  | "variable"
  | "test"
  | "suite"
  | "selector"
  | "media"
  | "supports"
  | "container"
  | "keyframes"
  | "font-face"
  | "layer"
  | "at-rule"
  | "heading"
  | "landmark"
  | "element"
  | "script"
  | "style"
  | "section";

export interface OutlineSymbol {
  name: string;
  kind: SymbolKind;
  /** 1-based line of the definition: the line of its name (or of the keyword when it has none), never of decorators/attributes. */
  line: number;
  /** 1-based last line, when known */
  endLine?: number;
  children: OutlineSymbol[];
}

export class OutlineTimeout extends Error {
  constructor() {
    super("outline time budget exceeded");
    this.name = "OutlineTimeout";
  }
}

/** Wall-clock budget, checked cheaply (every 1024 ticks). */
export class Budget {
  private n = 0;
  readonly deadline: number;
  constructor(deadline = Infinity) {
    this.deadline = deadline;
  }
  tick(): void {
    if ((++this.n & 1023) === 0 && this.deadline !== Infinity && Date.now() > this.deadline) throw new OutlineTimeout();
  }
  check(): void {
    if (this.deadline !== Infinity && Date.now() > this.deadline) throw new OutlineTimeout();
  }
}

export const NO_BUDGET = new Budget();

/** Offset -> 1-based line, by binary search over line starts. */
export class LineIndex {
  private starts: number[] = [0];
  constructor(text: string) {
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) this.starts.push(i + 1);
  }
  line(offset: number): number {
    const s = this.starts;
    let lo = 0;
    let hi = s.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (s[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }
}

/** Collapse runs of whitespace and cut very long names. */
export function cleanName(s: string, max = 120): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Run a Lezer parser to completion, giving up past the budget's deadline. */
export function parseWithBudget(parser: Parser, text: string, budget: Budget = NO_BUDGET): Tree {
  const p = parser.startParse(text);
  for (;;) {
    const tree = p.advance();
    if (tree) return tree;
    budget.check();
  }
}

/**
 * Same, but cooperative: works in slices of about `sliceMs`, awaiting
 * `yieldFn` (an idle callback in the browser) between slices. Gives up when
 * the work itself (not the waiting) exceeds `maxWorkMs`. Returns the tree and
 * the work time spent.
 */
export async function parseCooperative(
  parser: Parser,
  text: string,
  maxWorkMs: number,
  yieldFn: () => Promise<void>,
  signal?: AbortSignal,
  sliceMs = 10,
): Promise<{ tree: Tree; workMs: number }> {
  const p = parser.startParse(text);
  let work = 0;
  for (;;) {
    const start = Date.now();
    const sliceEnd = start + sliceMs;
    let tree: Tree | null = null;
    while (!tree && Date.now() < sliceEnd) tree = p.advance();
    work += Date.now() - start;
    if (tree) return { tree, workMs: work };
    if (work > maxWorkMs) throw new OutlineTimeout();
    await yieldFn();
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  }
}

/** Shift every line by `delta` (for symbols of an embedded block, e.g. HTML <script>). */
export function shiftLines(symbols: OutlineSymbol[], delta: number): OutlineSymbol[] {
  for (const s of symbols) {
    s.line += delta;
    if (s.endLine !== undefined) s.endLine += delta;
    shiftLines(s.children, delta);
  }
  return symbols;
}
