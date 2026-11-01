// "Changed since you last looked" for code and text: which lines of the new text
// are added or modified, where lines were removed, and the changed words of the
// modified lines. Pure (no DOM, no React) so it is unit tested with node --test.

import { diffWordsInLine, type LineDiff } from "./diff.ts";
import { plural } from "./format.ts";

export type LineChangeKind = "added" | "modified";

/** Removed lines, shown between two lines of the new text. */
export interface RemovedRun {
  /** new-text line the removal sits before; null = after the last line */
  beforeLine: number | null;
  /** 1-based line of the first removed line in the old text */
  oldStart: number;
  /** total removed lines in the run */
  count: number;
  /** their text (at most REMOVED_KEEP_LINES; `count` says how many there were) */
  lines: string[];
}

export interface LineMarks {
  /** new-text line number -> kind (unchanged lines are absent) */
  kinds: Map<number, LineChangeKind>;
  /** sorted by position, null (at the end) last */
  removed: RemovedRun[];
  /** first line of each run of changes (the line a pure removal sits before), sorted: prev/next navigation */
  anchors: number[];
  /** a removal after the last line has no line of its own to anchor on */
  removedAtEnd: boolean;
  /** changed character ranges [start, end) in modified lines (offsets in the line's text) */
  words: Map<number, [number, number][]>;
  counts: { added: number; modified: number; removed: number };
  /** lines in the new text */
  lineCount: number;
  /** the word highlights were cut short somewhere (caps or time budget) */
  partial: boolean;
}

export interface LineMarksOptions {
  /** compute word highlights (default true) */
  words?: boolean;
  /** time budget of the word highlights, ms */
  budgetMs?: number;
  /** at most this many modified lines get word highlights */
  maxPairs?: number;
  /** a run of changes with more modified lines than this gets none (a rewrite, not an edit) */
  maxRunPairs?: number;
  /** lines longer than this get none */
  maxLineChars?: number;
  /** more changed lines than this in all: no word highlights at all */
  maxChangedLines?: number;
  now?: () => number;
}

/** Removed lines kept per run for the inline view; "Show changes" has them all. */
export const REMOVED_KEEP_LINES = 500;

const DEFAULTS = {
  budgetMs: 100,
  maxPairs: 2000,
  maxRunPairs: 400,
  maxLineChars: 1000,
  maxChangedLines: 20000,
};

/** Changed ranges of the new side of a word diff, adjacent ones merged. */
function changedRanges(segs: { text: string; changed: boolean }[]): [number, number][] {
  const out: [number, number][] = [];
  let pos = 0;
  for (const s of segs) {
    const end = pos + s.text.length;
    if (s.changed && s.text.length) {
      const last = out[out.length - 1];
      if (last && last[1] === pos) last[1] = end;
      else out.push([pos, end]);
    }
    pos = end;
  }
  return out;
}

/**
 * Marks of a line diff (diffLineRows, normalized as the banner's) on the new
 * text. In each run of changes the k-th removed line pairs with the k-th added
 * one as "modified" (the block diff pairs blocks the same way); extra added lines
 * are "added", extra removed ones a RemovedRun after the run's last new line.
 */
export function lineMarks(diff: LineDiff, opts: LineMarksOptions = {}): LineMarks {
  const o = { ...DEFAULTS, ...opts };
  const now = opts.now ?? Date.now;
  const kinds = new Map<number, LineChangeKind>();
  const removed: RemovedRun[] = [];
  const anchors: number[] = [];
  const words = new Map<number, [number, number][]>();
  const counts = { added: 0, modified: 0, removed: 0 };
  let lineCount = 0;
  for (const r of diff.rows) if (r.type === "ctx" || r.type === "add") lineCount++;
  const changedLines = diff.added + diff.removed;
  let wantWords = opts.words !== false && changedLines <= o.maxChangedLines;
  let partial = opts.words !== false && !wantWords;
  const until = now() + o.budgetMs;
  let pairs = 0;
  let removedAtEnd = false;

  const rows = diff.rows;
  let nextNew = 1; // new line number of the next unchanged or added line
  for (let i = 0; i < rows.length; ) {
    const r = rows[i];
    if (r.type !== "del" && r.type !== "add") {
      if (r.newNo !== undefined) nextNew = r.newNo + 1;
      i++;
      continue;
    }
    // One run of changes: its removed and added rows, in order.
    const dels: { text: string; oldNo: number }[] = [];
    const adds: { text: string; newNo: number }[] = [];
    for (; i < rows.length && (rows[i].type === "del" || rows[i].type === "add"); i++) {
      const x = rows[i];
      if (x.type === "del") dels.push({ text: x.text, oldNo: x.oldNo ?? 0 });
      else {
        adds.push({ text: x.text, newNo: x.newNo ?? nextNew });
        nextNew = (x.newNo ?? nextNew) + 1;
      }
    }
    const m = Math.min(dels.length, adds.length);
    const runPairsOk = m <= o.maxRunPairs;
    if (m > 0 && !runPairsOk && wantWords) partial = true;
    for (let k = 0; k < adds.length; k++) {
      const n = adds[k].newNo;
      if (k < m) {
        kinds.set(n, "modified");
        counts.modified++;
        if (!wantWords || !runPairsOk) continue;
        if (pairs >= o.maxPairs || now() > until) {
          wantWords = false;
          partial = true;
          continue;
        }
        const a = dels[k].text;
        const b = adds[k].text;
        if (a.length > o.maxLineChars || b.length > o.maxLineChars) {
          partial = true;
          continue;
        }
        pairs++;
        const w = diffWordsInLine(a, b);
        if (!w) continue;
        const ranges = changedRanges(w.new);
        if (ranges.length) words.set(n, ranges);
      } else {
        kinds.set(n, "added");
        counts.added++;
      }
    }
    const firstNew = adds.length ? adds[0].newNo : nextNew;
    if (dels.length > m) {
      const extra = dels.slice(m);
      const before = nextNew;
      const atEnd = before > lineCount;
      if (atEnd) removedAtEnd = true;
      removed.push({
        beforeLine: atEnd ? null : before,
        oldStart: extra[0].oldNo,
        count: extra.length,
        lines: extra.slice(0, REMOVED_KEEP_LINES).map((d) => d.text),
      });
      counts.removed += extra.length;
    }
    if (firstNew <= lineCount) anchors.push(firstNew);
  }
  return { kinds, removed, anchors, removedAtEnd, words, counts, lineCount, partial };
}

/** The changes (marks.anchors, sorted) in lines [from, to]: those in a part of a large file not loaded yet. */
export function anchorsBetween(anchors: readonly number[], from: number, to: number): number[] {
  let lo = 0;
  let hi = anchors.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (anchors[mid] < from) lo = mid + 1;
    else hi = mid;
  }
  const out: number[] = [];
  for (let i = lo; i < anchors.length && anchors[i] <= to; i++) out.push(anchors[i]);
  return out;
}

/** "3 lines removed" / "1 line removed at the end" */
export const removedLabel = (r: RemovedRun) => `${plural(r.count, "line")} removed${r.beforeLine === null ? " at the end" : ""}`;

// ---------- outline: symbols containing a change ----------

/** What changedSymbols needs of an outline entry (lib/outline FlatSymbol, preorder). */
export interface SymbolRange {
  line: number;
  endLine?: number;
  depth: number;
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

/** Indentation of the first non-blank removed line; null when all of them are blank. */
function removedIndent(run: Pick<RemovedRun, "lines">): number | null {
  for (const l of run.lines) if (l.trim()) return indentOf(l);
  return null;
}

/**
 * Indexes of the symbols whose line range holds a change: a changed line, or a
 * removal inside it or right after its last line (so a deleted tail of a body
 * counts), unless a symbol of the same or a shallower depth starts where the
 * removal sits (a whole function removed between two others marks neither, but
 * its class). Symbols without an end line extend to the line before the next
 * symbol at the same or a shallower depth (or to the end of the file).
 *
 * With `lineText` (1-based lines of the new text), a removal right after a
 * symbol's last line counts for it only when the removed text is indented deeper
 * than the symbol's own first line: the tail of its body (Python's last
 * `return`, even when the next def follows directly), not a sibling removed
 * after it (the last function of a file).
 */
export function changedSymbols(
  flat: readonly SymbolRange[],
  marks: Pick<LineMarks, "kinds" | "removed" | "lineCount">,
  lineText?: (n: number) => string | undefined,
): Set<number> {
  const out = new Set<number>();
  if (!flat.length) return out;
  const lines = [...marks.kinds.keys()].sort((a, b) => a - b);
  // A removal before line b sits between b - 1 and b; at the end, after the last line (lineCount + 1).
  const runs = marks.removed
    .map((r) => ({ at: r.beforeLine ?? marks.lineCount + 1, indent: removedIndent(r) }))
    .sort((a, b) => a.at - b.at);
  const cuts = runs.map((r) => r.at);
  if (!lines.length && !cuts.length) return out;
  /** line -> the shallowest depth of a symbol starting there */
  const starts = new Map<number, number>();
  for (const s of flat) starts.set(s.line, Math.min(starts.get(s.line) ?? s.depth, s.depth));
  // Implicit ends (preorder: a later entry at the same or a shallower depth closes the open ones).
  const ends = new Array<number>(flat.length).fill(Number.POSITIVE_INFINITY);
  const open: number[] = [];
  for (let i = 0; i < flat.length; i++) {
    while (open.length && flat[open[open.length - 1]].depth >= flat[i].depth) ends[open.pop()!] = flat[i].line - 1;
    open.push(i);
  }
  /** first index in `a` with a[i] >= x */
  const lower = (a: number[], x: number) => {
    let lo = 0;
    let hi = a.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  for (let i = 0; i < flat.length; i++) {
    const s = flat[i];
    const end = Math.max(s.line, s.endLine ?? ends[i]);
    const li = lower(lines, s.line);
    if (li < lines.length && lines[li] <= end) {
      out.add(i);
      continue;
    }
    const last = Math.min(end, marks.lineCount);
    const head = lineText?.(s.line);
    for (let ci = lower(cuts, s.line + 1); ci < cuts.length && cuts[ci] <= last + 1; ci++) {
      const c = cuts[ci];
      let hit: boolean;
      if (c <= last || head === undefined) hit = !((starts.get(c) ?? Number.POSITIVE_INFINITY) <= s.depth);
      else {
        const ri = runs[ci].indent;
        hit = ri !== null && ri > indentOf(head);
      }
      if (hit) {
        out.add(i);
        break;
      }
    }
  }
  return out;
}
