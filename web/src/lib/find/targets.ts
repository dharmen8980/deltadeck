// Search targets: what the find bar runs a query on, made from a viewer's find source
// (registry.ts). Each keeps its matches, paints them as CSS highlights (dom.ts) and scrolls to
// the current one. Loaded with the bar, not with the viewers.

import { textRanges } from "../code-marks-dom.ts";
import { cellMatches, cellsText, lineStarts, lowerBound, matchesToLines, shiftPos, type CellMatch, type CellsText, type LineMatch } from "./core.ts";
import {
  clearFindHighlights,
  firstVisibleRange,
  flatRanges,
  flattenDom,
  revealNode,
  scrollRangeIntoView,
  scrollRectIntoView,
  setFindHighlights,
  type FlatText,
} from "./dom.ts";
import type { CellsSource, DomSource, FindQuery, FindSource, LinesSource } from "./registry.ts";
import { runFind, type FindOutcome } from "./run.ts";

export interface FindStatus {
  total: number;
  capped: boolean;
  timedOut: boolean;
  error?: string;
  /** e.g. "Searched the first 32 MB" */
  note?: string;
  /** a newer search started meanwhile: ignore this one */
  stale?: boolean;
}

export interface FindTarget {
  search(q: FindQuery): Promise<FindStatus>;
  /** paint every match and make `index` current (-1: none); scroll it into view when `scroll` */
  show(index: number, scroll: boolean): void;
  /** the first match at or below the top of the page */
  firstVisible(): number;
  /** where match `index` is (to find the same place after the content changed) */
  posOf(index: number): FindMark;
  /** the first match at or after a place, followed through the edits since */
  indexAt(mark: FindMark): number;
  clear(): void;
  /** the content changed in the page (re-search); returns the stop */
  watch(onChange: () => void): () => void;
}

/** A place in the searched text, with that text (to follow it through an edit). */
export interface FindMark {
  pos: number;
  text: string;
}

const NONE: FindStatus = { total: 0, capped: false, timedOut: false };
let uid = 0;

function status(r: FindOutcome, note?: string): FindStatus {
  return { total: r.starts.length, capped: r.capped, timedOut: r.timedOut, error: r.error, note };
}

/** Observe content changes under `root`, coalesced. */
function observe(root: HTMLElement, cb: () => void, delay: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const obs = new MutationObserver(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(cb, delay);
  });
  obs.observe(root, { childList: true, subtree: true, characterData: true });
  return () => {
    obs.disconnect();
    if (timer) clearTimeout(timer);
  };
}

// ---------- rendered text ----------

class DomTarget implements FindTarget {
  private id = ++uid;
  private flat: FlatText | null = null;
  private flatRoot: HTMLElement | null = null;
  private version = 0;
  private stale = true;
  private seq = 0;
  private starts: number[] = [];
  private ends: number[] = [];
  private ranges: (Range | null)[] | null = null;

  constructor(private src: DomSource) {}

  async search(q: FindQuery): Promise<FindStatus> {
    const root = this.src.root();
    if (!root) return NONE;
    if (this.stale || !this.flat || root !== this.flatRoot) {
      this.flat = flattenDom(root, this.src.skip);
      this.flatRoot = root;
      this.stale = false;
      this.version++;
    }
    const my = ++this.seq;
    const r = await runFind(`dom:${this.id}:${this.version}`, this.flat.text, q.query, q.options);
    if (my !== this.seq) return { ...NONE, stale: true };
    this.starts = r.starts;
    this.ends = r.ends;
    this.ranges = null;
    const note = this.src.note && !r.error ? await this.src.note(q, r.starts.length) : undefined;
    if (my !== this.seq) return { ...NONE, stale: true };
    return status(r, note);
  }

  private all(): (Range | null)[] {
    if (!this.ranges) this.ranges = this.flat ? flatRanges(this.flat, this.starts, this.ends) : [];
    return this.ranges;
  }

  show(index: number, scroll: boolean) {
    const all = this.all();
    const cur = all[index] ?? null;
    // opening a <details> changes no text: the ranges stay valid
    if (cur && scroll) revealNode(cur.startContainer);
    setFindHighlights(all, cur);
    if (cur && scroll) scrollRangeIntoView(cur);
  }

  firstVisible() {
    return firstVisibleRange(this.all());
  }

  posOf(index: number): FindMark {
    return { pos: this.starts[index] ?? 0, text: this.flat?.text ?? "" };
  }

  indexAt(mark: FindMark) {
    const i = lowerBound(this.starts, shiftPos(mark.text, this.flat?.text ?? "", mark.pos));
    return i < this.starts.length ? i : this.starts.length - 1;
  }

  clear() {
    this.seq++;
    clearFindHighlights();
  }

  watch(onChange: () => void) {
    const root = this.src.root();
    if (!root) return () => {};
    return observe(
      root,
      () => {
        this.stale = true;
        onChange();
      },
      200,
    );
  }
}

// ---------- line-based text (code, plain text, large files) ----------

class LinesTarget implements FindTarget {
  private model: { key: string; text: string; starts: number[]; note?: string } | null = null;
  private loading: { key: string; promise: Promise<void>; ctrl: AbortController } | null = null;
  private seq = 0;
  private offsets: number[] = [];
  private matches: LineMatch[] = [];
  private ranges: (Range | null)[] | null = null;
  private current = -1;
  /** a match to scroll to once its line is rendered */
  private pendingScroll = -1;

  constructor(private src: LinesSource) {}

  private async load(key: string) {
    if (this.model?.key === key) return;
    if (this.loading?.key !== key) {
      this.loading?.ctrl.abort();
      const ctrl = new AbortController();
      const promise = Promise.resolve(this.src.text(ctrl.signal)).then((t) => {
        if (ctrl.signal.aborted) return;
        this.model = { key, text: t.text, starts: lineStarts(t.text), note: t.note };
      });
      this.loading = { key, promise, ctrl };
    }
    const loading = this.loading;
    try {
      await loading.promise;
    } finally {
      // done (or failed: the next search tries again)
      if (this.loading === loading) this.loading = null;
    }
  }

  async search(q: FindQuery): Promise<FindStatus> {
    const my = ++this.seq;
    const key = this.src.key();
    try {
      await this.load(key);
    } catch (e) {
      if (my !== this.seq) return { ...NONE, stale: true };
      return { ...NONE, error: `Could not read the file: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (my !== this.seq) return { ...NONE, stale: true };
    const m = this.model;
    if (!m || m.key !== key) return { ...NONE, stale: true };
    const r = await runFind(`lines:${key}`, m.text, q.query, q.options);
    if (my !== this.seq || this.model !== m) return { ...NONE, stale: true };
    this.offsets = r.starts;
    this.matches = matchesToLines(m.starts, r);
    this.ranges = null;
    return status(r, m.note);
  }

  private all(): (Range | null)[] {
    if (this.ranges) return this.ranges;
    const root = this.src.root();
    const out: (Range | null)[] = new Array(this.matches.length).fill(null);
    if (root && this.matches.length) {
      const lineEl = this.src.lines(root);
      let k = 0;
      while (k < this.matches.length) {
        const line = this.matches[k].line;
        let j = k;
        while (j < this.matches.length && this.matches[j].line === line) j++;
        const el = lineEl(line);
        if (el) {
          const spans = this.matches.slice(k, j).map((m) => [m.start, m.end] as [number, number]);
          const rs = textRanges(el, spans);
          for (let i = 0; i < rs.length && k + i < j; i++) out[k + i] = rs[i];
        }
        k = j;
      }
    }
    this.ranges = out;
    return out;
  }

  show(index: number, scroll: boolean) {
    this.current = index;
    const all = this.all();
    const cur = all[index] ?? null;
    setFindHighlights(all, cur);
    if (!scroll || index < 0) return;
    if (cur) {
      this.pendingScroll = -1;
      scrollRangeIntoView(cur);
      return;
    }
    // not rendered: load its part of the file, then scroll (see watch)
    const m = this.matches[index];
    const root = this.src.root();
    if (!m || !root) return;
    const el = this.src.lines(root)(m.line);
    if (el) {
      scrollRectIntoView(() => el.getBoundingClientRect(), el);
      return;
    }
    this.pendingScroll = index;
    void this.src.ensureLine?.(m.line).catch(() => undefined);
  }

  firstVisible() {
    const root = this.src.root();
    const n = root ? this.src.lineAtTop(root) : null;
    if (n === null || !this.matches.length) return 0;
    let lo = 0;
    let hi = this.matches.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.matches[mid].line < n) lo = mid + 1;
      else hi = mid;
    }
    return lo < this.matches.length ? lo : 0;
  }

  posOf(index: number): FindMark {
    return { pos: this.offsets[index] ?? 0, text: this.model?.text ?? "" };
  }

  indexAt(mark: FindMark) {
    const i = lowerBound(this.offsets, shiftPos(mark.text, this.model?.text ?? "", mark.pos));
    return i < this.offsets.length ? i : this.offsets.length - 1;
  }

  clear() {
    this.seq++;
    this.pendingScroll = -1;
    this.current = -1;
    clearFindHighlights();
  }

  watch(onChange: () => void) {
    const root = this.src.root();
    if (!root) return () => {};
    // The lines were re-rendered (Shiki's HTML replacing the plain one, a chunk loaded, change
    // marks applied): paint again; a different text comes through the source's changed().
    let raf = 0;
    const stop = observe(
      root,
      () => {
        if (this.src.key() !== this.model?.key) {
          onChange();
          return;
        }
        this.ranges = null;
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          if (this.current < 0) return;
          const pending = this.pendingScroll === this.current;
          this.show(this.current, pending);
        });
      },
      30,
    );
    return () => {
      cancelAnimationFrame(raf);
      stop();
    };
  }
}

// ---------- table cells ----------

class CellsTarget implements FindTarget {
  private model: { key: string; ct: CellsText } | null = null;
  private seq = 0;
  private offsets: number[] = [];
  private matches: CellMatch[] = [];
  private ranges: (Range | null)[] | null = null;
  private currentCell: HTMLElement | null = null;
  private current = -1;

  constructor(private src: CellsSource) {}

  async search(q: FindQuery): Promise<FindStatus> {
    const my = ++this.seq;
    const key = this.src.key();
    if (this.model?.key !== key) {
      const { rows, width } = this.src.rows();
      this.model = { key, ct: cellsText(rows, width) };
    }
    const m = this.model;
    const r = await runFind(`cells:${key}`, m.ct.text, q.query, q.options);
    if (my !== this.seq || this.model !== m) return { ...NONE, stale: true };
    this.offsets = r.starts;
    this.matches = cellMatches(m.ct, r);
    this.ranges = null;
    return status(r);
  }

  private all(): (Range | null)[] {
    if (this.ranges) return this.ranges;
    const root = this.src.root();
    const out: (Range | null)[] = new Array(this.matches.length).fill(null);
    if (root && this.matches.length) {
      const cellEl = this.src.cells(root);
      let k = 0;
      while (k < this.matches.length) {
        const { row, col } = this.matches[k];
        let j = k;
        while (j < this.matches.length && this.matches[j].row === row && this.matches[j].col === col) j++;
        const el = cellEl(row, col);
        if (el) {
          const rs = textRanges(el, this.matches.slice(k, j).map((m) => [m.start, m.end] as [number, number]));
          for (let i = 0; i < rs.length && k + i < j; i++) out[k + i] = rs[i];
        }
        k = j;
      }
    }
    this.ranges = out;
    return out;
  }

  private markCell(el: HTMLElement | null) {
    if (this.currentCell === el) return;
    this.currentCell?.removeAttribute("data-find-current");
    this.currentCell = el;
    el?.setAttribute("data-find-current", "");
  }

  show(index: number, scroll: boolean) {
    this.current = index;
    const all = this.all();
    const cur = all[index] ?? null;
    const m = this.matches[index];
    const root = this.src.root();
    const cell = m && root ? this.src.cells(root)(m.row, m.col) : null;
    this.markCell(cell);
    setFindHighlights(all, cur);
    if (!scroll || !cell) return;
    cell.scrollIntoView({ block: "center", inline: "nearest" });
    if (cur) scrollRangeIntoView(cur);
  }

  firstVisible() {
    const root = this.src.root();
    const row = root ? this.src.rowAtTop(root) : null;
    if (row === null) return 0;
    const i = this.matches.findIndex((m) => m.row >= row);
    return i < 0 ? 0 : i;
  }

  posOf(index: number): FindMark {
    return { pos: this.offsets[index] ?? 0, text: this.model?.ct.text ?? "" };
  }

  indexAt(mark: FindMark) {
    const i = lowerBound(this.offsets, shiftPos(mark.text, this.model?.ct.text ?? "", mark.pos));
    return i < this.offsets.length ? i : this.offsets.length - 1;
  }

  clear() {
    this.seq++;
    this.current = -1;
    this.markCell(null);
    clearFindHighlights();
  }

  watch(onChange: () => void) {
    const root = this.src.root();
    if (!root) return () => {};
    let raf = 0;
    const stop = observe(
      root,
      () => {
        if (this.src.key() !== this.model?.key) {
          onChange();
          return;
        }
        this.ranges = null;
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          if (this.current >= 0) this.show(this.current, false);
        });
      },
      30,
    );
    return () => {
      cancelAnimationFrame(raf);
      stop();
    };
  }
}

const cache = new WeakMap<FindSource, FindTarget>();

/** The target of a source (one per source); null for a source with nothing to search. */
export function targetFor(src: FindSource): FindTarget | null {
  if (src.kind === "none") return null;
  let t = cache.get(src);
  if (!t) {
    t = src.kind === "dom" ? new DomTarget(src) : src.kind === "lines" ? new LinesTarget(src) : new CellsTarget(src);
    cache.set(src, t);
  }
  return t;
}

/** The fallback for views that register nothing (folder listing, diff, blame): the main area's text. */
export function fallbackSource(root: () => HTMLElement | null): DomSource {
  return { kind: "dom", root };
}
