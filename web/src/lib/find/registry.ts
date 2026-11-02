// What the find bar can search: each viewer registers a small description of its content (a
// "find source"); the bar (components/find/find-bar.tsx, loaded on first use) turns the visible
// one into a search target (targets.ts). This module stays tiny because every viewer imports it.

import type { FindOptions } from "./core.ts";

export interface FindQuery {
  query: string;
  options: FindOptions;
}

interface Base {
  /** the element holding the content; the bar searches the visible source with the highest priority */
  root(): HTMLElement | null;
}

/** Rendered text (markdown, docx, mermaid, the JSON tree, anything else): searched in the DOM. */
export interface DomSource extends Base {
  kind: "dom";
  /** subtrees never searched (default dom.ts FIND_SKIP; a viewer adds its own UI chrome) */
  skip?: string;
  /** a line for the bar (e.g. "12 more in collapsed nodes") */
  note?(q: FindQuery, total: number): Promise<string | undefined> | string | undefined;
}

/** Text shown one element per line (code, plain text, large files): searched in the text itself. */
export interface LinesSource extends Base {
  kind: "lines";
  /** names the current text: a new key means a new text (searched again) */
  key(): string;
  /** the whole text (or as much as is searched, with a note saying so) */
  text(signal: AbortSignal): Promise<{ text: string; note?: string }> | { text: string; note?: string };
  /** a lookup for the text element of line n (1-based); null when that line is not rendered */
  lines(root: HTMLElement): (n: number) => HTMLElement | null;
  /** the rendered line at the top of the page, for starting at what the reader sees */
  lineAtTop(root: HTMLElement): number | null;
  /** render line n (a large file's unloaded part) */
  ensureLine?(n: number): Promise<void>;
}

/** A table (CSV, a sheet): searched in its cells, in the order shown. */
export interface CellsSource extends Base {
  kind: "cells";
  key(): string;
  /** rows in display order; row 0 is the header */
  rows(): { rows: readonly (readonly string[])[]; width: number };
  /** a lookup of cell elements (row 0 is the header; null when not rendered), made once per paint */
  cells(root: HTMLElement): (row: number, col: number) => HTMLElement | null;
  /** row (as in rows()) at the top of the page */
  rowAtTop(root: HTMLElement): number | null;
}

/** Nothing to search here (PDF, images): the bar says why. */
export interface NoSource extends Base {
  kind: "none";
  message: string;
}

export type FindSource = DomSource | LinesSource | CellsSource | NoSource;

const PRIORITY: Record<FindSource["kind"], number> = { none: 3, lines: 2, cells: 2, dom: 1 };

interface Entry {
  src: FindSource;
  seq: number;
}

const entries: Entry[] = [];
const listeners = new Set<(changed: FindSource | null) => void>();
let seq = 0;

const emit = (changed: FindSource | null) => listeners.forEach((l) => l(changed));

/**
 * Register a source; `changed()` says its content changed (search again), `relink()` that its
 * root element appeared or was replaced (pick the source again), `unregister()` removes it.
 */
export function registerFindSource(src: FindSource): { changed: () => void; relink: () => void; unregister: () => void } {
  const e = { src, seq: ++seq };
  entries.push(e);
  emit(null);
  return {
    changed: () => emit(src),
    relink: () => emit(null),
    unregister: () => {
      const i = entries.indexOf(e);
      if (i >= 0) entries.splice(i, 1);
      emit(null);
    },
  };
}

/** `null`: the set of sources changed; a source: its content changed. */
export function subscribeFindSources(cb: (changed: FindSource | null) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function visible(el: HTMLElement): boolean {
  if (!el.isConnected || el.closest("[hidden]")) return false;
  const check = (el as HTMLElement & { checkVisibility?: () => boolean }).checkVisibility;
  return check ? check.call(el) : el.getClientRects().length > 0;
}

/** The source the bar searches: visible, highest priority, registered last. */
export function activeFindSource(): FindSource | null {
  let best: Entry | null = null;
  for (const e of entries) {
    const root = e.src.root();
    if (!root || !visible(root)) continue;
    if (!best || PRIORITY[e.src.kind] > PRIORITY[best.src.kind] || (PRIORITY[e.src.kind] === PRIORITY[best.src.kind] && e.seq > best.seq))
      best = e;
  }
  return best?.src ?? null;
}

/** Desktop menu (desktop/src/main.ts) -> page: `detail` is "open", "next" or "prev". */
export const FIND_EVENT = "deltadeck:find";
export type FindAction = "open" | "next" | "prev";
