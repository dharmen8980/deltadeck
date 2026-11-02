"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { toast } from "sonner";
import type { FileChangeState } from "@/components/changes/changes-context";
import type { LineDiff, MarkdownBlockDiff } from "@/lib/diff";
import { plural } from "@/lib/format";
import { cachedOutline, computeOutline, flattenOutline, outlineCacheKey, outlineTargetFor, type FlatSymbol } from "@/lib/outline";
import {
  basketItem,
  hunkFinder,
  hunkOccurrences,
  lineHunks,
  lineLocation,
  markdownHunks,
  markdownLocation,
  type BasketItem,
  type HunkTarget,
  type ReviewHunk,
} from "@/lib/review-basket";

/**
 * The review basket: changes picked while reviewing (lib/review-basket.ts), for one prompt to
 * an AI agent. Session-only on purpose: kept in memory for the tab, never saved anywhere.
 */
export interface Basket {
  items: BasketItem[];
  ids: ReadonlySet<string>;
  /** adds the ones not in yet; returns how many were added */
  add(items: BasketItem[]): number;
  remove(id: string): void;
  setNote(id: string, note: string): void;
  /** empties it; returns what it held (for an undo) */
  clear(): BasketItem[];
  /** puts items back (undo of a clear), keeping any added since */
  restore(items: BasketItem[]): void;
  /** the open folder's place in its git repo ("" or "sub/dir/"): paths are shown and copied from the repo root */
  pathPrefix: string;
}

const BasketContext = createContext<Basket | null>(null);
export const useBasket = () => useContext(BasketContext);

export function BasketProvider({ pathPrefix = "", children }: { pathPrefix?: string; children: React.ReactNode }) {
  const [items, setItems] = useState<BasketItem[]>([]);
  // Same set while only notes change (views that mark basket changes re-mark on a new set).
  const idKey = items.map((i) => i.id).join("\n");
  const ids = useMemo(() => new Set(idKey ? idKey.split("\n") : []), [idKey]);
  const add = useCallback(
    (more: BasketItem[]) => {
      const fresh = more.filter((m, i) => !ids.has(m.id) && more.findIndex((x) => x.id === m.id) === i);
      if (fresh.length) setItems((cur) => [...cur, ...fresh.filter((m) => !cur.some((c) => c.id === m.id))]);
      return fresh.length;
    },
    [ids],
  );
  const remove = useCallback((id: string) => setItems((cur) => cur.filter((i) => i.id !== id)), []);
  const setNote = useCallback(
    (id: string, note: string) => setItems((cur) => cur.map((i) => (i.id === id ? { ...i, note } : i))),
    [],
  );
  const clear = useCallback(() => {
    setItems([]);
    return items;
  }, [items]);
  const restore = useCallback(
    (back: BasketItem[]) => setItems((cur) => [...back, ...cur.filter((c) => !back.some((b) => b.id === c.id))]),
    [],
  );
  const value = useMemo<Basket>(
    () => ({ items, ids, add, remove, setNote, clear, restore, pathPrefix }),
    [items, ids, add, remove, setNote, clear, restore, pathPrefix],
  );
  return <BasketContext.Provider value={value}>{children}</BasketContext.Provider>;
}

/** Kinds whose highlighted changes can be put in the basket (the same in all of them). */
export const basketKind = (kind: string) => kind === "markdown" || kind === "docx" || kind === "code" || kind === "text";

/** The changes the views highlight: the block diff for markdown and .docx, the line diff for code and text. */
export function reviewHunksOf(kind: string, d: { lineDiff: LineDiff | null; markdownDiff: MarkdownBlockDiff | null }): ReviewHunk[] {
  if (kind === "markdown" || kind === "docx") return d.markdownDiff ? markdownHunks(d.markdownDiff) : [];
  if (kind === "code" || kind === "text") return d.lineDiff ? lineHunks(d.lineDiff) : [];
  return [];
}

/**
 * A file's hunks as basket items (`hunks`: all of the file's, for telling identical changes
 * apart). `symbols`: the code outline, when known (the location names the symbol).
 */
export function itemsFor(
  file: { path: string; kind: string },
  hunks: readonly ReviewHunk[],
  markdownDiff: MarkdownBlockDiff | null,
  symbols?: FlatSymbol[] | null,
  currentText?: string | null,
): BasketItem[] {
  const occ = hunkOccurrences(hunks);
  const at = itemAt(file, hunks, markdownDiff, symbols, currentText);
  return hunks.map((h, i) => at(i, occ[i]));
}

function itemAt(
  file: { path: string; kind: string },
  hunks: readonly ReviewHunk[],
  markdownDiff: MarkdownBlockDiff | null,
  symbols?: FlatSymbol[] | null,
  currentText?: string | null,
): (i: number, occurrence: number) => BasketItem {
  const md = Boolean(markdownDiff && (file.kind === "markdown" || file.kind === "docx"));
  const lines = !md && symbols?.length && currentText ? currentText.split("\n") : null;
  const lineText = lines ? (n: number) => lines[n - 1] : undefined;
  return (i, occurrence) => {
    const h = hunks[i];
    const location = md ? markdownLocation(markdownDiff!.newBlocks, h) : lineLocation(h, symbols, lineText);
    return basketItem(file.path, file.kind, h, location, occurrence);
  };
}

/** The outline cache key of a version of a code file (hashes the text: compute once per version). */
const symbolsKey = (file: { path: string; mtime: number; size: number }, text: string) =>
  outlineCacheKey(file.path, file.mtime, file.size, text);

/** The outline of a version of a code file the outline panel already computed (cached), else null. */
export function cachedSymbols(file: { path: string; mtime: number; size: number }, text: string | null): FlatSymbol[] | null {
  if (text === null) return null;
  const s = cachedOutline(symbolsKey(file, text));
  return s ? flattenOutline(s) : null;
}

/** The outline of a code text, from the cache or computed now (null: no outline for the language, too large, gave up). */
export async function symbolsOf(
  file: { path: string; mtime: number; size: number; ext: string },
  text: string,
): Promise<FlatSymbol[] | null> {
  const cached = cachedSymbols(file, text);
  if (cached) return cached;
  const target = outlineTargetFor(file.ext);
  if (!target) return null;
  try {
    const s = await computeOutline(target, text);
    return s ? flattenOutline(s) : null;
  } catch {
    return null;
  }
}

export interface FileReview {
  hunks: ReviewHunk[];
  /** the basket item of hunk i (location from the outline when the panel computed it) */
  item(i: number): BasketItem;
  /** the index of the hunk of a marked element, or -1 (lib/review-basket.ts findHunk) */
  find(t: HunkTarget): number;
}

/** The open file's changes as basket items, or null (nothing changed, kind not supported, no diff). */
export function useFileReview(
  file: { path: string; kind: string; mtime: number; size: number } | null,
  state: FileChangeState | null,
): FileReview | null {
  const changed = Boolean(state?.changed);
  const lineDiff = state?.lineDiff ?? null;
  const markdownDiff = state?.markdownDiff ?? null;
  const currentText = state?.currentText ?? null;
  const kind = file?.kind ?? "";
  const hunks = useMemo(
    () => (changed && basketKind(kind) ? reviewHunksOf(kind, { lineDiff, markdownDiff }) : []),
    [changed, kind, lineDiff, markdownDiff],
  );
  return useMemo(() => {
    if (!file || !hunks.length) return null;
    // Items are made on demand and kept: the text is hashed and split once per version, and
    // again only while the outline panel has not computed the outline yet.
    const occ = hunkOccurrences(hunks);
    const items: (BasketItem | undefined)[] = new Array(hunks.length);
    const key = kind === "code" && currentText !== null ? symbolsKey(file, currentText) : null;
    let at: ((i: number, occurrence: number) => BasketItem) | null = null;
    const make = () => {
      if (at) return at;
      const s = key ? cachedOutline(key) : undefined;
      const fresh = itemAt(file, hunks, markdownDiff, s ? flattenOutline(s) : null, currentText);
      if (!key || s) at = fresh;
      return fresh;
    };
    return {
      hunks,
      item: (i: number) => {
        const had = at;
        const it = items[i] ?? make()(i, occ[i]);
        if (had || at) items[i] = it;
        return it;
      },
      find: hunkFinder(hunks),
    };
  }, [file, hunks, markdownDiff, kind, currentText]);
}

/** Adds items and says so (a toast): `what` names them ("this change", "3 changes in a.md"). */
export function addWithToast(basket: Basket, items: BasketItem[], what: string): void {
  const n = basket.add(items);
  if (!items.length) toast("No highlighted changes to add");
  else if (!n) toast("Already in the review basket", { description: what });
  else
    toast(`Added ${n === 1 && items.length === 1 ? "to" : `${plural(n, "change")} to`} the review basket`, {
      description: `${what} · ${plural(basket.items.length + n, "item")} in the basket`,
    });
}
