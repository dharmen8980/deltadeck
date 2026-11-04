"use client";

// The visible git-ignored paths of the open folder (from /api/tree marks), for rows that are not
// built from the tree: search results and What's new. Set by the shell on each tree load.

import { useSyncExternalStore } from "react";
import type { TreeResponse } from "@/lib/api";
import { ignoredPaths } from "@/lib/tree";

const EMPTY: ReadonlySet<string> = new Set();
let current: ReadonlySet<string> = EMPTY;
const listeners = new Set<() => void>();

export function setGitIgnored(tree: TreeResponse | null) {
  const next = tree ? ignoredPaths(tree) : EMPTY;
  if (next.size === 0 && current.size === 0) return;
  current = next;
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => void listeners.delete(l);
}

/** The visible git-ignored files and folders (folder-relative paths). */
export function useGitIgnored(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => current, () => EMPTY);
}
