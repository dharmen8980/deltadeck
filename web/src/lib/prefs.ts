"use client";

import { useSyncExternalStore } from "react";

// Saved UI prefs in localStorage. Every read and write is guarded: where storage is blocked or
// full, a pref reads as its default and a change still applies for this session. A pref is
// shared by every component that shows it (read once, then kept in memory).

type Listener = () => void;

export interface Pref<T> {
  get(): T;
  set(v: T): void;
  subscribe(l: Listener): () => void;
}

export function readItem(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Save `value` under `key`; null removes it. */
export function writeItem(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // storage full or blocked: the value still applies for this session
  }
}

/**
 * A pref saved under `key`. `parse` turns the saved string (null: none) into a value, so it
 * also supplies the default; `serialize` returns the string to save, or null to remove it.
 */
export function createPref<T>(key: string, parse: (raw: string | null) => T, serialize: (v: T) => string | null): Pref<T> {
  const listeners = new Set<Listener>();
  let value: { v: T } | null = null;
  return {
    get: () => (value ??= { v: parse(readItem(key)) }).v,
    set(v: T) {
      value = { v };
      writeItem(key, serialize(v));
      listeners.forEach((l) => l());
    },
    subscribe(l: Listener) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
}

/** The pref's value; `serverValue` while rendering on the server and hydrating. */
export function usePref<T>(pref: Pref<T>, serverValue: T): T {
  return useSyncExternalStore(pref.subscribe, pref.get, () => serverValue);
}
