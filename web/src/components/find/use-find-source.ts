"use client";

import { useCallback, useEffect, useRef, useState, type DependencyList } from "react";
import { registerFindSource, type FindSource } from "@/lib/find/registry";

/**
 * Make this view searchable by the find bar while it is mounted. `make` should read the
 * content through refs, so the source is registered once; returns `changed()`, to call when
 * the content changed (the bar searches again and keeps its place).
 */
export function useFindSource(make: () => FindSource | null, deps: DependencyList): () => void {
  const changedRef = useRef<(() => void) | null>(null);
  const live = useRef<{ src: FindSource; relink: () => void; root: HTMLElement | null } | null>(null);
  useEffect(() => {
    const src = make();
    if (!src) return;
    const h = registerFindSource(src);
    changedRef.current = h.changed;
    live.current = { src, relink: h.relink, root: src.root() };
    return () => {
      changedRef.current = null;
      live.current = null;
      h.unregister();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  // The root mounts after the data loads, or is replaced (a tab): the bar picks the source again.
  useEffect(() => {
    const l = live.current;
    if (!l) return;
    const root = l.src.root();
    if (root === l.root) return;
    l.root = root;
    l.relink();
  });
  return useCallback(() => changedRef.current?.(), []);
}

let ids = 0;

/** A name for this view's text, unique in the page (part of a lines/cells source's key). */
export function useFindId(): string {
  const [id] = useState(() => `f${++ids}`);
  return id;
}
