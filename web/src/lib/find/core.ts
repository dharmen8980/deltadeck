// Find in the open file: the pure part (compiling the query, finding the matches in a text or
// in table cells, mapping offsets to lines). No DOM here; the bar (components/find/) and the
// viewers' find targets use it, and so does the find worker (find/worker.ts).
//
// Semantics: case-insensitive by default (Unicode case folding, accents are NOT folded:
// "e" does not find "é"); whole word means no letter, digit or "_" on either side; matches
// never span lines (or cells); zero-length matches (`^`, `a*` on "b") are skipped; matches do
// not overlap ("aa" finds 2 in "aaaa"). At most `max` matches are kept (the counter then says
// "5,000+"), and the search stops after `budgetMs` (checked between matches and lines).

export interface FindOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export const DEFAULT_FIND_OPTIONS: FindOptions = { caseSensitive: false, wholeWord: false, regex: false };

/** Most matches kept (and highlighted); the counter says "5,000+" past it. */
export const FIND_MAX_MATCHES = 5000;
/** Time budget of one search (checked between matches; the worker also has a hard timeout). */
export const FIND_BUDGET_MS = 400;

export type CompiledFind = { ok: true; re: RegExp } | { ok: false; error: string };

const WORD_U = "[\\p{L}\\p{N}\\p{M}_]";
const WORD_ASCII = "[A-Za-z0-9_\\u00C0-\\u024F]";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

function shortError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  // "Invalid regular expression: /(/giu: Unterminated group" -> "Unterminated group"
  const m = /^Invalid regular expression: \/[\s\S]*\/[a-z]*: ([\s\S]*)$/.exec(msg);
  return (m ? m[1] : msg).slice(0, 120);
}

/** The query as a global RegExp, or an error for an invalid pattern; null for an empty query. */
export function compileFind(query: string, o: FindOptions): CompiledFind | null {
  if (!query) return null;
  const body = o.regex ? query : escapeRegExp(query);
  const flags = `g${o.caseSensitive ? "" : "i"}`;
  const wrap = (src: string, word: string) => (o.wholeWord ? `(?<!${word})(?:${src})(?!${word})` : src);
  try {
    return { ok: true, re: new RegExp(wrap(body, WORD_U), `${flags}u`) };
  } catch (first) {
    if (!o.regex) return { ok: false, error: shortError(first) };
    // Unicode mode is stricter (`\-`, `{`, lone `]`): accept what a plain JS regex accepts.
    try {
      return { ok: true, re: new RegExp(wrap(body, WORD_ASCII), flags) };
    } catch {
      return { ok: false, error: shortError(first) };
    }
  }
}

export interface FindResult {
  /** match offsets in the text (UTF-16), ascending, non-overlapping, never empty */
  starts: number[];
  ends: number[];
  /** stopped at `max` matches: there are more */
  capped: boolean;
  /** stopped by the time budget: there may be more */
  timedOut: boolean;
}

export interface FindRunOptions {
  max?: number;
  budgetMs?: number;
  now?: () => number;
}

const clock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Matches of `re` (global) in one string, appended to `out`; returns false when stopped. */
function scan(
  s: string,
  base: number,
  re: RegExp,
  out: FindResult,
  max: number,
  deadline: number,
  now: () => number,
): boolean {
  re.lastIndex = 0;
  let n = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const len = m[0].length;
    if (len === 0) {
      // zero-length: skip it, one code point on
      const i = re.lastIndex;
      const c = s.charCodeAt(i);
      re.lastIndex = i + (re.unicode && c >= 0xd800 && c <= 0xdbff ? 2 : 1);
      if (re.lastIndex > s.length) break;
    } else {
      if (out.starts.length >= max) {
        out.capped = true;
        return false;
      }
      out.starts.push(base + m.index);
      out.ends.push(base + m.index + len);
    }
    if (++n % 256 === 0 && now() > deadline) {
      out.timedOut = true;
      return false;
    }
  }
  return true;
}

/**
 * All matches of `re` (a global RegExp from compileFind) in `text`, line by line: `^` and `$`
 * are line starts and ends, and no match spans a line break (block boundaries in rendered text
 * are line breaks too, see find/dom.ts).
 */
export function findInText(text: string, re: RegExp, opts: FindRunOptions = {}): FindResult {
  const max = opts.max ?? FIND_MAX_MATCHES;
  const now = opts.now ?? clock;
  const deadline = now() + (opts.budgetMs ?? FIND_BUDGET_MS);
  const out: FindResult = { starts: [], ends: [], capped: false, timedOut: false };
  let pos = 0;
  let lines = 0;
  while (pos <= text.length) {
    let nl = text.indexOf("\n", pos);
    if (nl < 0) nl = text.length;
    // a CRLF line ends before its "\r" (so `$` matches there; offsets are unchanged)
    const end = nl > pos && text.charCodeAt(nl - 1) === 13 ? nl - 1 : nl;
    if (end > pos && !scan(text.slice(pos, end), pos, re, out, max, deadline, now)) break;
    pos = nl + 1;
    if (++lines % 64 === 0 && now() > deadline) {
      out.timedOut = pos <= text.length;
      break;
    }
  }
  return out;
}

export interface CellMatch {
  row: number;
  col: number;
  start: number;
  end: number;
}

/** Table cells as one text, one cell per line (line breaks and CRs in a cell become spaces). */
export interface CellsText {
  text: string;
  /** offset of each non-empty cell's text, ascending */
  starts: number[];
  rows: number[];
  cols: number[];
}

export function cellsText(rows: readonly (readonly string[])[], cols?: number): CellsText {
  const parts: string[] = [];
  const out: CellsText = { text: "", starts: [], rows: [], cols: [] };
  let pos = 0;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const width = cols ?? row.length;
    for (let c = 0; c < width; c++) {
      const cell = row[c];
      if (!cell) continue;
      out.starts.push(pos);
      out.rows.push(r);
      out.cols.push(c);
      parts.push(/[\r\n]/.test(cell) ? cell.replace(/[\r\n]/g, " ") : cell);
      pos += cell.length + 1;
    }
  }
  out.text = parts.join("\n");
  return out;
}

/** Text matches (from findInText on `ct.text`) as cell matches. */
export function cellMatches(ct: CellsText, r: Pick<FindResult, "starts" | "ends">): CellMatch[] {
  const out: CellMatch[] = new Array(r.starts.length);
  let k = 0;
  for (let i = 0; i < r.starts.length; i++) {
    const s = r.starts[i];
    while (k + 1 < ct.starts.length && ct.starts[k + 1] <= s) k++;
    const base = ct.starts[k];
    out[i] = { row: ct.rows[k], col: ct.cols[k], start: s - base, end: r.ends[i] - base };
  }
  return out;
}

export interface CellFindResult {
  matches: CellMatch[];
  capped: boolean;
  timedOut: boolean;
}

/** Matches in table cells (row-major, in the given row order); a match never spans cells. */
export function findInCells(
  rows: readonly (readonly string[])[],
  re: RegExp,
  opts: FindRunOptions & { cols?: number } = {},
): CellFindResult {
  const ct = cellsText(rows, opts.cols);
  const r = findInText(ct.text, re, opts);
  return { matches: cellMatches(ct, r), capped: r.capped, timedOut: r.timedOut };
}

/** Offsets where each line starts (line n starts at result[n - 1]). */
export function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) out.push(i + 1);
  return out;
}

/** First index i with sorted[i] >= value (sorted.length when none). */
export function lowerBound(sorted: ArrayLike<number>, value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The 1-based line holding `offset`. */
export function lineAt(starts: ArrayLike<number>, offset: number): number {
  return Math.max(1, lowerBound(starts, offset + 1));
}

export interface LineMatch {
  /** 1-based line (plus `firstLine - 1`) */
  line: number;
  /** offsets within the line */
  start: number;
  end: number;
}

/** Matches as (line, column span), for views that render one element per line. */
export function matchesToLines(starts: ArrayLike<number>, r: Pick<FindResult, "starts" | "ends">, firstLine = 1): LineMatch[] {
  const out: LineMatch[] = new Array(r.starts.length);
  let li = 0;
  for (let k = 0; k < r.starts.length; k++) {
    const s = r.starts[k];
    while (li + 1 < starts.length && starts[li + 1] <= s) li++;
    out[k] = { line: li + firstLine, start: s - starts[li], end: r.ends[k] - starts[li] };
  }
  return out;
}

/** Group line matches by line: line -> [start, end][] (for highlighting one line at a time). */
export function spansByLine(matches: readonly LineMatch[], from = 0, to = matches.length): Map<number, [number, number][]> {
  const out = new Map<number, [number, number][]>();
  for (let k = from; k < to; k++) {
    const m = matches[k];
    let list = out.get(m.line);
    if (!list) out.set(m.line, (list = []));
    list.push([m.start, m.end]);
  }
  return out;
}

/** "3 of 17", "1 of 5,000+", "No results"; `total` 0 with a query. */
export function counterLabel(current: number, total: number, capped: boolean): string {
  if (total === 0) return "No results";
  const t = `${total.toLocaleString("en-US")}${capped ? "+" : ""}`;
  return current >= 0 ? `${(current + 1).toLocaleString("en-US")} of ${t}` : `${t} found`;
}

/** The next index from `i` by `dir`, wrapping; `wrapped` when it went past an end. */
export function step(i: number, total: number, dir: 1 | -1): { index: number; wrapped: boolean } {
  if (total <= 0) return { index: -1, wrapped: false };
  if (i < 0) return { index: dir > 0 ? 0 : total - 1, wrapped: false };
  const n = i + dir;
  if (n >= total) return { index: 0, wrapped: true };
  if (n < 0) return { index: total - 1, wrapped: true };
  return { index: n, wrapped: false };
}

/**
 * Where offset `pos` of `before` is in `after` (the same text after an edit): unchanged before the
 * edit, shifted by the edit's length change after it, the start of the edit inside it.
 */
export function shiftPos(before: string, after: string, pos: number): number {
  if (before === after) return pos;
  const min = Math.min(before.length, after.length);
  let p = 0;
  while (p < min && before.charCodeAt(p) === after.charCodeAt(p)) p++;
  if (pos < p) return pos;
  let s = 0;
  while (s < min - p && before.charCodeAt(before.length - 1 - s) === after.charCodeAt(after.length - 1 - s)) s++;
  if (pos >= before.length - s) return pos + (after.length - before.length);
  return p;
}
