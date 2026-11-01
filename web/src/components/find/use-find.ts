"use client";

// The find bar's engine: which view to search (the registry's active source), running the
// query on it (debounced), the current match, and searching again when the content changes.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { step as stepIndex, type FindOptions } from "@/lib/find/core";
import { activeFindSource, subscribeFindSources, type FindSource } from "@/lib/find/registry";
import { fallbackSource, targetFor, type FindStatus } from "@/lib/find/targets";

/** Typing waits this long before searching; a content change (a live update) less. */
const TYPE_DELAY_MS = 120;
const CHANGE_DELAY_MS = 60;

/** Views that register no source (folder listing, git views): the main area's text. */
const FALLBACK = fallbackSource(() => document.querySelector<HTMLElement>("[data-find-root]"));

export interface FindState {
  /** the source searched; `kind: "none"` says why there is nothing to search */
  source: FindSource | null;
  status: FindStatus | null;
  index: number;
  busy: boolean;
}

interface Request {
  query: string;
  options: FindOptions;
  source: FindSource | null;
  content: number;
}

interface Result {
  /** the request this answers (a newer one: busy) */
  req: Request | null;
  status: FindStatus | null;
  index: number;
}

const NO_RESULT: Result = { req: null, status: null, index: -1 };

export function useFind(open: boolean, query: string, options: FindOptions, fileKey: string, onWrap?: (dir: 1 | -1) => void) {
  const onWrapRef = useRef(onWrap);
  useEffect(() => {
    onWrapRef.current = onWrap;
  });
  /** steps asked for while a search was running (+1 next, -1 previous each): taken once it is done */
  const pendingStep = useRef(0);
  const [source, setSource] = useState<FindSource | null>(null);
  const [content, setContent] = useState(0);
  const [res, setRes] = useState<Result>(NO_RESULT);
  const indexRef = useRef(-1);
  const sourceRef = useRef<FindSource | null>(null);
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);
  const last = useRef<{ query: string; options: FindOptions; source: FindSource | null } | null>(null);

  // The source to search: picked again when views (un)register, or another file opens.
  useEffect(() => {
    if (!open) return;
    const pick = () => {
      const s = activeFindSource() ?? FALLBACK;
      const el = s.root();
      // the same source on a new element (a tab, the data loaded): watch and search that one
      if (s === sourceRef.current && el !== rootRef.current) setContent((c) => c + 1);
      sourceRef.current = s;
      rootRef.current = el;
      setSource(s);
      setRoot(el);
    };
    pick();
    // a view mounting after the file opened, a tab shown: registration comes later than the route
    const late = setTimeout(pick, 300);
    const stop = subscribeFindSources((changed) => {
      if (changed === null) pick();
      else if (changed === sourceRef.current) setContent((c) => c + 1);
    });
    return () => {
      clearTimeout(late);
      stop();
    };
  }, [open, fileKey]);

  const target = source ? targetFor(source) : null;

  // The page re-rendered the content (a live update, a chunk loaded): search again.
  useEffect(() => {
    if (!open || !target) return;
    return target.watch(() => setContent((c) => c + 1));
  }, [open, target, root]);

  const req = useMemo<Request>(() => ({ query, options, source, content }), [query, options, source, content]);
  const active = open && target !== null && query !== "";

  useEffect(() => {
    if (!open || !target) {
      target?.clear();
      indexRef.current = -1;
      pendingStep.current = 0;
      last.current = null;
      return;
    }
    if (!query) {
      target.clear();
      indexRef.current = -1;
      pendingStep.current = 0;
      last.current = { query, options, source };
      return;
    }
    const prev = last.current;
    const sameQuery = prev !== null && prev.query === query && prev.options === options;
    // fresh: the query changed (go to the first match from the top of the page, scrolling);
    // switched: another view (no scroll); kept: the content changed (stay near the same place)
    const why = !sameQuery ? "fresh" : prev.source !== source ? "switched" : "kept";
    const keepAt = why === "kept" && indexRef.current >= 0 ? target.posOf(indexRef.current) : null;
    let cancelled = false;
    const timer = setTimeout(
      async () => {
        const st = await target.search({ query, options });
        if (cancelled || st.stale) return;
        last.current = { query, options, source };
        let index = -1;
        if (st.total) index = keepAt !== null ? target.indexAt(keepAt) : target.firstVisible();
        let pending = pendingStep.current;
        pendingStep.current = 0;
        const scroll = why === "fresh" || pending !== 0;
        // Enter while typing: a new query lands on its first match (that is the first step forward)
        if (why === "fresh" && pending > 0) pending--;
        for (; pending !== 0 && index >= 0; pending -= Math.sign(pending)) {
          const dir = pending > 0 ? 1 : -1;
          const s = stepIndex(index, st.total, dir);
          index = s.index;
          if (s.wrapped) onWrapRef.current?.(dir);
        }
        indexRef.current = index;
        setRes({ req, status: st, index });
        target.show(index, scroll);
      },
      why === "kept" ? CHANGE_DELAY_MS : TYPE_DELAY_MS,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, target, source, query, options, req]);

  // Closing (or leaving the page) removes the highlights.
  useEffect(() => () => target?.clear(), [target]);

  /** Go to the next / previous match; returns whether it wrapped around. */
  const busy = active && res.req !== req;
  const go = useCallback(
    (dir: 1 | -1): boolean => {
      if (!target) return false;
      if (busy) {
        // remembered, not dropped: Enter right after typing (or during a live update) still steps
        pendingStep.current += dir;
        return false;
      }
      const total = res.status?.total ?? 0;
      if (!total) return false;
      const { index, wrapped } = stepIndex(indexRef.current, total, dir);
      indexRef.current = index;
      setRes((r) => ({ ...r, index }));
      target.show(index, true);
      if (wrapped) onWrapRef.current?.(dir);
      return wrapped;
    },
    [target, busy, res.status],
  );

  const state: FindState = active ? { source, status: res.status, index: res.index, busy } : { source, status: null, index: -1, busy: false };
  return { state, go };
}
