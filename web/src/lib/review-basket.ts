// Review basket: changes picked while reviewing, turned into one prompt for an AI agent.
// The hunks are the very changes the views highlight (the banner's diffs: the block diff for
// markdown and .docx, the line diff for code and text), so an item is what the user saw marked.
// Pure (no DOM, no React, no "@/" imports): unit tested with node --test.

import { diffLineRows, type LineDiff, type MarkdownBlockDiff, type MdBlock } from "./diff.ts";
import { plural } from "./format.ts";

export type ReviewChangeKind = "added" | "modified" | "removed";

/** One highlighted change: a changed block (markdown) or run of changed lines (code), or a removal marker. */
export interface ReviewHunk {
  kind: ReviewChangeKind;
  /** first and last line in the current version (markdown: the block's source lines); null for a pure removal */
  start: number | null;
  end: number | null;
  /**
   * The current-version line a removal marker of this hunk sits before (null: after the last
   * line); undefined when the hunk shows no removal marker.
   */
  removedBefore?: number | null;
  beforeText: string;
  afterText: string;
}

/** The hunks of a markdown (or .docx) block diff: each highlighted block, and each removal marker (blockMarks groups). */
export function markdownHunks(d: MarkdownBlockDiff): ReviewHunk[] {
  const out: ReviewHunk[] = [];
  const removed = new Map<number, MdBlock[]>();
  for (const c of d.changes) {
    if (c.kind === "removed") {
      const at = c.before ?? d.newBlocks.length;
      const list = removed.get(at) ?? [];
      if (c.oldBlock) list.push(c.oldBlock);
      removed.set(at, list);
    } else if (c.newBlock) {
      out.push({
        kind: c.kind,
        start: c.newBlock.startLine,
        end: c.newBlock.endLine,
        beforeText: c.kind === "modified" ? (c.oldBlock?.text ?? "") : "",
        afterText: c.newBlock.text,
      });
    }
  }
  for (const [at, blocks] of removed) {
    out.push({
      kind: "removed",
      start: null,
      end: null,
      removedBefore: at < d.newBlocks.length ? d.newBlocks[at].startLine : null,
      beforeText: blocks.map((b) => b.text).join("\n\n"),
      afterText: "",
    });
  }
  return out.sort((a, b) => hunkLine(a) - hunkLine(b));
}

/**
 * The hunks of a line diff (code and text): each run of changes, as lib/line-marks.ts marks it
 * (its removal marker, if any, sits after the run's last new line).
 */
export function lineHunks(d: LineDiff): ReviewHunk[] {
  const out: ReviewHunk[] = [];
  const rows = d.rows;
  let lineCount = 0;
  for (const r of rows) if (r.type === "ctx" || r.type === "add") lineCount++;
  let nextNew = 1;
  for (let i = 0; i < rows.length; ) {
    const r = rows[i];
    if (r.type !== "del" && r.type !== "add") {
      if (r.newNo !== undefined) nextNew = r.newNo + 1;
      i++;
      continue;
    }
    const dels: string[] = [];
    const adds: string[] = [];
    let first: number | null = null;
    let last: number | null = null;
    for (; i < rows.length && (rows[i].type === "del" || rows[i].type === "add"); i++) {
      const x = rows[i];
      if (x.type === "del") dels.push(x.text);
      else {
        const n = x.newNo ?? nextNew;
        adds.push(x.text);
        first ??= n;
        last = n;
        nextNew = n + 1;
      }
    }
    const h: ReviewHunk = {
      kind: !adds.length ? "removed" : !dels.length ? "added" : "modified",
      start: first,
      end: last,
      beforeText: dels.join("\n"),
      afterText: adds.join("\n"),
    };
    if (dels.length > adds.length) h.removedBefore = nextNew > lineCount ? null : nextNew;
    out.push(h);
  }
  return out;
}

/** The line a hunk is at (sorting, location): its first line, the line its removal sits before, or after the end. */
export function hunkLine(h: ReviewHunk): number {
  return h.start ?? h.removedBefore ?? Number.MAX_SAFE_INTEGER;
}

/** What a marked element on screen says about its change. */
export type HunkTarget =
  /** a highlighted markdown block: its source lines */
  | { lines: [number, number] }
  /** a marked code line (or the unchanged line a pure removal is anchored on) */
  | { line: number }
  /** a removal marker: the line it sits before, null at the end */
  | { removedBefore: number | null };

/** The index of the hunk of a marked element, or -1. */
export function findHunk(hunks: readonly ReviewHunk[], t: HunkTarget): number {
  if ("lines" in t) {
    const [s, e] = t.lines;
    return hunks.findIndex((h) => h.start !== null && h.end !== null && h.start <= e && h.end >= s);
  }
  if ("line" in t) {
    const i = hunks.findIndex((h) => h.start !== null && h.end !== null && h.start <= t.line && h.end >= t.line);
    if (i >= 0) return i;
    return hunks.findIndex((h) => h.start === null && h.removedBefore === t.line);
  }
  return hunks.findIndex((h) => h.removedBefore !== undefined && h.removedBefore === t.removedBefore);
}

/**
 * findHunk for many elements: the same answers from maps built once (O(lines of the hunks)),
 * for marking every change on screen without a scan per element.
 */
export function hunkFinder(hunks: readonly ReviewHunk[]): (t: HunkTarget) => number {
  const byLine = new Map<number, number>();
  const pureRemovalAt = new Map<number, number>();
  const byRemoval = new Map<number | null, number>();
  hunks.forEach((h, i) => {
    if (h.start !== null && h.end !== null) {
      for (let n = h.start; n <= h.end; n++) if (!byLine.has(n)) byLine.set(n, i);
    } else if (h.removedBefore != null && !pureRemovalAt.has(h.removedBefore)) pureRemovalAt.set(h.removedBefore, i);
    if (h.removedBefore !== undefined && !byRemoval.has(h.removedBefore)) byRemoval.set(h.removedBefore, i);
  });
  return (t) => {
    if ("lines" in t) {
      let best = -1;
      for (let n = t.lines[0]; n <= t.lines[1]; n++) {
        const i = byLine.get(n);
        if (i !== undefined && (best < 0 || i < best)) best = i;
      }
      return best;
    }
    if ("line" in t) return byLine.get(t.line) ?? pureRemovalAt.get(t.line) ?? -1;
    return byRemoval.get(t.removedBefore) ?? -1;
  };
}

// ---------- locations ----------

/** Level and text of a heading block (ATX or setext). */
function headingOf(b: MdBlock): { depth: number; text: string } | null {
  if (b.type !== "heading") return null;
  const atx = /^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(b.text.split("\n")[0]) ?? /^(#{1,6})()$/.exec(b.text.trim());
  if (atx) return { depth: atx[1].length, text: atx[2].trim() };
  const lines = b.text.split("\n");
  const under = lines[lines.length - 1].trim();
  if (lines.length < 2 || !/^(=+|-+)$/.test(under)) return null;
  return { depth: under.startsWith("=") ? 1 : 2, text: lines.slice(0, -1).join(" ").trim() };
}

/**
 * The headings a markdown line sits under, outermost first ("Setup", "Install"). A heading
 * on `line` itself counts; `line` null = after the last block.
 */
export function headingPath(blocks: readonly MdBlock[], line: number | null): string[] {
  const stack: { depth: number; text: string }[] = [];
  for (const b of blocks) {
    if (line !== null && b.startLine > line) break;
    const h = headingOf(b);
    if (!h) continue;
    while (stack.length && stack[stack.length - 1].depth >= h.depth) stack.pop();
    stack.push(h);
  }
  return stack.map((h) => h.text).filter(Boolean);
}

/** What enclosingSymbols needs of an outline entry (lib/outline FlatSymbol, preorder). */
export interface NamedSymbolRange {
  name: string;
  line: number;
  endLine?: number;
  depth: number;
}

/**
 * The symbols containing all of `lines`, outermost first. Symbols without an end line extend
 * to the line before the next one at the same or a shallower depth (as changedSymbols).
 */
export function enclosingSymbols(flat: readonly NamedSymbolRange[], lines: readonly number[]): string[] {
  return enclosing(flat, lines).map((s) => s.name);
}

function enclosing(flat: readonly NamedSymbolRange[], lines: readonly number[]): NamedSymbolRange[] {
  if (!lines.length) return [];
  const ends = new Array<number>(flat.length).fill(Number.POSITIVE_INFINITY);
  const open: number[] = [];
  for (let i = 0; i < flat.length; i++) {
    while (open.length && flat[open[open.length - 1]].depth >= flat[i].depth) ends[open.pop()!] = flat[i].line - 1;
    open.push(i);
  }
  const lo = Math.min(...lines);
  const hi = Math.max(...lines);
  const out: NamedSymbolRange[] = [];
  // A member without an end line ends with its parent at the latest.
  const parents: { depth: number; end: number }[] = [];
  for (let i = 0; i < flat.length; i++) {
    const s = flat[i];
    while (parents.length && parents[parents.length - 1].depth >= s.depth) parents.pop();
    const cap = parents.length ? parents[parents.length - 1].end : Number.POSITIVE_INFINITY;
    const end = Math.max(s.line, s.endLine ?? Math.min(ends[i], cap));
    parents.push({ depth: s.depth, end });
    if (s.line <= lo && end >= hi) out.push(s);
  }
  return out.sort((a, b) => a.depth - b.depth);
}

/** Leading whitespace width (a tab counts 4). */
function indentOf(line: string): number {
  let w = 0;
  for (const c of line) {
    if (c === " ") w++;
    else if (c === "\t") w += 4;
    else break;
  }
  return w;
}

/** "Setup > Install" for a markdown hunk ("start of the document" above the first heading). */
export function markdownLocation(blocks: readonly MdBlock[], h: ReviewHunk): string {
  const path = headingPath(blocks, h.start ?? (h.removedBefore != null ? h.removedBefore - 1 : null));
  return path.length ? path.join(" > ") : "start of the document";
}

/**
 * "L12-18 · Parser > parse" for a line hunk (the symbol part when an outline is known). With
 * `lineText` (1-based lines of the current text), a removal right after a symbol's last line is
 * in it when the removed text is indented deeper than the symbol's first line (a body's tail).
 */
export function lineLocation(
  h: ReviewHunk,
  symbols?: readonly NamedSymbolRange[] | null,
  lineText?: (n: number) => string | undefined,
): string {
  let where: string;
  let lines: number[];
  if (h.start !== null && h.end !== null) {
    where = h.start === h.end ? `Line ${h.start}` : `Line ${h.start}-${h.end}`;
    lines = [h.start, h.end];
  } else if (h.removedBefore != null) {
    where = `removed before line ${h.removedBefore}`;
    lines = h.removedBefore > 1 ? [h.removedBefore - 1, h.removedBefore] : [h.removedBefore];
  } else {
    where = "removed at the end";
    lines = [];
  }
  let sym = symbols?.length ? enclosingSymbols(symbols, lines) : [];
  const first = h.beforeText.split("\n").find((l) => l.trim());
  if (symbols?.length && lineText && h.start === null && h.removedBefore != null && h.removedBefore > 1 && first !== undefined) {
    const deep = indentOf(first);
    const inside: string[] = [];
    for (const s of enclosing(symbols, [h.removedBefore - 1])) {
      const head = lineText(s.line);
      if (head === undefined || indentOf(head) >= deep) break;
      inside.push(s.name);
    }
    if (inside.length > sym.length) sym = inside;
  }
  return sym.length ? `${where} · ${sym.join(" > ")}` : where;
}

// ---------- basket items ----------

/** Lines of the before / after text kept per item. */
export const ITEM_MAX_LINES = 60;

/** Blank lines at both ends dropped, at most `max` lines kept; `more` = lines left out. */
export function clipLines(text: string, max = ITEM_MAX_LINES): { text: string; more: number } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  const kept = lines.slice(a, b);
  if (kept.length <= max) return { text: kept.join("\n"), more: 0 };
  return { text: kept.slice(0, max).join("\n"), more: kept.length - max };
}

export interface BasketItem {
  /** same change of the same file = same id (adding it twice keeps one) */
  id: string;
  path: string;
  /** the file's kind (markdown, docx, code, text) */
  fileKind: string;
  change: ReviewChangeKind;
  /** "Setup > Install", "Line 12-18 · Parser > parse" */
  location: string;
  /** for the order within a file */
  line: number;
  before: string;
  /** lines of the before text left out (ITEM_MAX_LINES) */
  beforeMore: number;
  after: string;
  afterMore: number;
  /** one line typed by the user */
  note: string;
}

/** FNV-1a, base 36. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

/** Per hunk: how many earlier hunks have the same kind and text (tells identical changes of a file apart in ids). */
export function hunkOccurrences(hunks: readonly ReviewHunk[]): number[] {
  const seen = new Map<string, number>();
  return hunks.map((h) => {
    const k = `${h.kind}\u0000${h.beforeText}\u0000${h.afterText}`;
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return n;
  });
}

/** `occurrence`: hunkOccurrences of the hunk (0 for the first change with its text). */
export function basketItem(path: string, fileKind: string, h: ReviewHunk, location: string, occurrence = 0): BasketItem {
  const before = clipLines(h.beforeText);
  const after = clipLines(h.afterText);
  return {
    // Not from the location (it gains the symbol once the outline is known) nor the line (a later
    // edit above the change moves it): the same change keeps its id while it stays highlighted.
    id: `${path}\u0000${fileKind}\u0000${h.kind}\u0000${hash(`${h.beforeText}\u0000${h.afterText}`)}\u0000${occurrence}`,
    path,
    fileKind,
    change: h.kind,
    location,
    line: hunkLine(h),
    before: before.text,
    beforeMore: before.more,
    after: after.text,
    afterMore: after.more,
    note: "",
  };
}

/** Items by file (files in the order first added, items by position). */
export function groupByFile(items: readonly BasketItem[]): { path: string; items: BasketItem[] }[] {
  const by = new Map<string, BasketItem[]>();
  for (const it of items) {
    const list = by.get(it.path) ?? [];
    list.push(it);
    by.set(it.path, list);
  }
  return [...by].map(([path, list]) => ({ path, items: [...list].sort((a, b) => a.line - b.line) }));
}

// ---------- the prompt ----------

export const PROMPT_INTRO = "Review feedback on recent changes. For each item, revise as noted.";

const CHANGE_WORD: Record<ReviewChangeKind, string> = { added: "added", modified: "edited", removed: "removed" };

/** Unified diff lines (no header) of the before and after text: context " ", removed "-", added "+". */
export function diffBody(before: string, after: string): string {
  if (!before) return after.split("\n").map((l) => `+${l}`).join("\n");
  if (!after) return before.split("\n").map((l) => `-${l}`).join("\n");
  const d = diffLineRows(before, after, { normalize: true, timeoutMs: 200 });
  if (!d) return [...before.split("\n").map((l) => `-${l}`), ...after.split("\n").map((l) => `+${l}`)].join("\n");
  return d.rows.map((r) => `${r.type === "del" ? "-" : r.type === "add" ? "+" : " "}${r.text}`).join("\n");
}

/** A code fence longer than any run of backticks in `text`. */
function fenceFor(text: string): string {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * The whole basket as one markdown prompt: an intro line, then per file its items with a diff and
 * the note. `pathPrefix` (the open folder's place in its git repo) makes the paths repo-relative,
 * which is where an agent usually runs. `quick` (one change copied on its own, with the instruction typed
 * after pasting) leaves out the intro and the default note.
 */
export function buildPrompt(items: readonly BasketItem[], pathPrefix = "", quick = false): string {
  const out = quick ? [] : [PROMPT_INTRO];
  let n = 0;
  for (const g of groupByFile(items)) {
    out.push("", `## ${pathPrefix}${g.path}`);
    for (const it of g.items) {
      n++;
      const body = diffBody(it.before, it.after);
      const fence = fenceFor(body);
      out.push("", `### ${n}. ${it.location} (${CHANGE_WORD[it.change]})`, "", `${fence}diff`, body, fence);
      const cut = [
        it.beforeMore ? `${plural(it.beforeMore, "more line")} of the old text` : null,
        it.afterMore ? `${plural(it.afterMore, "more line")} of the new text` : null,
      ].filter(Boolean);
      if (cut.length) out.push(`(Not shown: ${cut.join(", ")}.)`);
      const note = it.note.trim();
      if (note || !quick) out.push("", note ? `Note: ${note}` : "Note: none; check this change and fix anything wrong.");
    }
  }
  return `${out.join("\n").replace(/^\n/, "")}\n`;
}
