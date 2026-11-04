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

export function useTree(): TreeState {
  const [tree, setTree] = useState<TreeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);
  const inflight = useRef<Promise<void> | null>(null);
  const queued = useRef<Promise<void> | null>(null);

  const fetchOnce = useCallback(async () => {
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    try {
      const t = await api.tree(ctrl.signal);
      if (ctrl.signal.aborted) return;
      setTree(t);
      setError(null);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setError(errorMessage(e));
    } finally {
      if (ctrlRef.current === ctrl) ctrlRef.current = null;
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }, []);

  // One request at a time; calls while one is in flight share one follow-up request. Aborting and
  // restarting instead would starve the tree during a burst of change events (a big folder
  // filling in), so it would only update once the burst ends.
  const load = useCallback((): Promise<void> => {
    const start = () => {
      const p = fetchOnce().finally(() => {
        if (inflight.current === p) inflight.current = null;
      });
      inflight.current = p;
      return p;
    };
    if (!inflight.current) return start();
    queued.current ??= inflight.current.then(() => {
      queued.current = null;
      return start();
    });
    return queued.current;
  }, [fetchOnce]);

  useEffect(() => {
    // Initial fetch of the tree (external system sync).
    void load();
    return () => ctrlRef.current?.abort();
  }, [load]);

  return { tree, loading, error, refresh: load };
}
