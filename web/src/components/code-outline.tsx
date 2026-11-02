"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { TOC_DOCKED_CLASS, TocInline, TocPanel, type TocHeading } from "@/components/toc";
import { useRoute } from "@/hooks/use-route";
import { api, type FileInfo } from "@/lib/api";
import { isTypingTarget } from "@/lib/keys";
import { changedSymbols, type LineMarks } from "@/lib/line-marks";
import {
  activeSymbol,
  byLine,
  cachedOutline,
  cacheOutline,
  computeOutline,
  flattenOutline,
  outlineCacheKey,
  outlineTargetFor,
  OUTLINE_MAX_BYTES,
  type FlatSymbol,
  type SymbolKind,
} from "@/lib/outline";

const KIND_BADGE: Record<SymbolKind, string> = {
  package: "pkg",
  namespace: "ns",
  module: "mod",
  class: "cls",
  interface: "ifc",
  struct: "st",
  record: "rec",
  enum: "enum",
  annotation: "@",
  type: "type",
  function: "fn",
  method: "m",
  constructor: "new",
  getter: "get",
  setter: "set",
  property: "prop",
  field: "fld",
  variable: "var",
  test: "test",
  suite: "desc",
  selector: "{}",
  media: "@m",
  supports: "@s",
  container: "@c",
  keyframes: "@k",
  "font-face": "@f",
  layer: "@l",
  "at-rule": "@",
  heading: "h",
  landmark: "<>",
  element: "#",
  script: "js",
  style: "css",
  section: "§",
};

/**
 * The symbol around the line at the top of the viewport inside `root`
 * (one measurement per animation frame while scrolling). Only a change of
 * the symbol is a state update, so scrolling within one does not re-render.
 */
function useScrollSymbol(root: React.RefObject<HTMLElement | null>, flat: FlatSymbol[] | null, order: number[]): string | null {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (!flat || !flat.length) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const el = root.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > window.innerHeight) return;
      // Below the sticky app header (3.5rem) and any toolbar of the viewer.
      const y = Math.min(Math.max(rect.top + 4, 88), window.innerHeight - 1);
      // inside the line elements (the code block has padding), at their gutter
      const first = el.querySelector<HTMLElement>('[id^="L"]');
      const x = (first ? first.getBoundingClientRect().left : rect.left + 16) + 4;
      for (const hit of document.elementsFromPoint(x, y)) {
        const lineEl = (hit as HTMLElement).closest?.<HTMLElement>('[id^="L"]');
        if (!lineEl || !el.contains(lineEl)) continue;
        const n = Number(lineEl.id.slice(1));
        if (Number.isFinite(n)) {
          const idx = activeSymbol(flat, order, n);
          const id = idx >= 0 ? flat[idx].id : null;
          setActive((prev) => (prev === id ? prev : id));
          return;
        }
      }
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [root, flat, order]);
  return flat && flat.length ? active : null;
}

/** Keys that scroll the page (when not typed into a field or used inside the outline). */
const SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "]);

function flash(el: HTMLElement) {
  el.classList.remove("outline-flash");
  void el.offsetWidth; // restart the animation
  el.classList.add("outline-flash");
  window.setTimeout(() => el.classList.remove("outline-flash"), 1300);
}

/**
 * Code with an outline of its symbols: a side panel on wide screens, a
 * collapsible block above the code otherwise. The outline is computed after
 * the code is on screen (idle time, lazily loaded parser) and cached per
 * path + mtime + size. Without `text` (files too large to highlight), the
 * text is fetched once for the outline when it is at most 2 MB. `changes`: the
 * lines changed since the last view; symbols holding one get a dot.
 */
export function CodeWithOutline({
  file,
  text,
  changes = null,
  children,
}: {
  file: FileInfo;
  text: string | null;
  changes?: LineMarks | null;
  children: ReactNode;
}) {
  const { setHash } = useRoute();
  const rootRef = useRef<HTMLDivElement>(null);
  const target = useMemo(() => outlineTargetFor(file.ext), [file.ext]);
  const [result, setResult] = useState<{ key: string; flat: FlatSymbol[]; src: string } | null>(null);

  const sizeOk = file.size <= OUTLINE_MAX_BYTES;
  const baseKey = `${file.path}\u0000${file.mtime ?? ""}\u0000${file.size}`;

  useEffect(() => {
    if (!target || !sizeOk) return;
    const ctrl = new AbortController();
    (async () => {
      let src = text;
      if (src === null) {
        await new Promise((r) => setTimeout(r, 300)); // let the text viewer load first
        if (ctrl.signal.aborted) return;
        src = (await api.content(file.path, ctrl.signal)).text;
      }
      const key = outlineCacheKey(file.path, file.mtime, file.size, src);
      let symbols = cachedOutline(key);
      if (!symbols) {
        const computed = await computeOutline(target, src, { signal: ctrl.signal });
        if (!computed) return;
        symbols = computed;
        cacheOutline(key, symbols);
      }
      if (!ctrl.signal.aborted) setResult({ key: baseKey, flat: flattenOutline(symbols), src });
    })().catch(() => {
      /* no outline: aborted, too large, or the fetch failed */
    });
    return () => ctrl.abort();
  }, [target, sizeOk, text, file.path, file.mtime, file.size, baseKey]);

  const flat = result && result.key === baseKey ? result.flat : null;
  const src = result && result.key === baseKey ? result.src : null;
  const headings = useMemo<TocHeading[]>(
    () =>
      (flat ?? []).map((s) => ({
        id: s.id,
        text: s.name,
        level: s.depth + 1,
        badge: KIND_BADGE[s.kind],
        badgeTitle: s.kind,
        title: `${s.name} (${s.kind}, line ${s.line})`,
      })),
    [flat],
  );
  // Separate from the headings, so a live change does not reset the folds of the list.
  const changedIds = useMemo<ReadonlySet<string> | undefined>(() => {
    if (!flat || !changes) return undefined;
    // The outlined text, for the indentation of removed lines (a body's tail, or a sibling removed after it).
    const srcLines = src !== null && !/\r(?!\n)/.test(src) ? src.replace(/\r\n/g, "\n").split("\n") : null;
    const idx = changedSymbols(flat, changes, srcLines ? (n) => srcLines[n - 1] : undefined);
    return idx.size ? new Set([...idx].map((i) => flat[i].id)) : undefined;
  }, [flat, src, changes]);
  const order = useMemo(() => (flat ? byLine(flat) : []), [flat]);
  const scrolled = useScrollSymbol(rootRef, flat, order);
  // A clicked entry stays active (its line is centred, not at the top) until the user scrolls.
  const [pinned, setPinned] = useState<{ key: string; id: string } | null>(null);
  useEffect(() => {
    if (pinned === null) return;
    const unpin = () => setPinned(null);
    const onKey = (e: KeyboardEvent) => {
      if (!SCROLL_KEYS.has(e.key)) return;
      if (isTypingTarget(e.target) || (e.target as HTMLElement | null)?.closest?.("nav")) return;
      unpin();
    };
    const opts = { capture: true, passive: true } as const;
    window.addEventListener("wheel", unpin, opts);
    window.addEventListener("touchmove", unpin, opts);
    window.addEventListener("keydown", onKey, opts);
    return () => {
      window.removeEventListener("wheel", unpin, opts);
      window.removeEventListener("touchmove", unpin, opts);
      window.removeEventListener("keydown", onKey, opts);
    };
  }, [pinned]);
  const active = pinned && pinned.key === baseKey ? pinned.id : scrolled;

  const onSelect = useCallback(
    (id: string) => {
      const sym = flat?.find((s) => s.id === id);
      if (!sym) return;
      // replace, like a click on a line number: stepping through symbols does not fill the history
      setHash(`L${sym.line}`, true);
      setPinned({ key: baseKey, id });
      // Scrolled here too: the hash effect of the highlighted view does not run
      // when the hash is unchanged, and the large-file text viewer has none.
      const el = document.getElementById(`L${sym.line}`);
      if (el) {
        el.scrollIntoView({ block: "center" });
        flash(el);
      }
    },
    [flat, setHash, baseKey],
  );

  // The same tree with or without an outline, so the code is not remounted when it arrives.
  return (
    <div className="flex gap-2">
      <div ref={rootRef} className="min-w-0 flex-1">
        <TocInline
          headings={headings}
          onSelect={onSelect}
          title="Outline"
          minItems={1}
          filterFrom={16}
          collapsible
          changed={changedIds}
          className="mx-3 mt-3 mb-2"
        />
        {children}
      </div>
      <TocPanel
        headings={headings}
        onSelect={onSelect}
        title="Outline"
        label="Code outline"
        active={active}
        minItems={1}
        filterFrom={16}
        collapsible
        changed={changedIds}
        className={TOC_DOCKED_CLASS}
      />
    </div>
  );
}
