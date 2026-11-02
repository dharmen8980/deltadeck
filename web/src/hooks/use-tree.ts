"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage, type TreeResponse } from "@/lib/api";

export interface TreeState {
  tree: TreeResponse | null;
  loading: boolean;
  error: string | null;
  /** reload the tree; resolves once it is loaded (or the request was superseded) */
  refresh: () => Promise<void>;
}

/** `showHidden`: also list hidden items (`/api/tree?hidden=1`); the tree reloads when it changes. */
export function useTree(showHidden = false): TreeState {
  const [tree, setTree] = useState<TreeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    inflight.current?.abort();
    const ctrl = new AbortController();
    inflight.current = ctrl;
    try {
      const t = await api.tree(ctrl.signal, { hidden: showHidden });
      if (ctrl.signal.aborted) return;
      setTree(t);
      setError(null);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setError(errorMessage(e));
    } finally {
      if (inflight.current === ctrl) {
        inflight.current = null;
        setLoading(false);
      }
    }
  }, [showHidden]);

  useEffect(() => {
    // Initial fetch of the tree (external system sync).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    return () => inflight.current?.abort();
  }, [load]);

  return { tree, loading, error, refresh: load };
}
