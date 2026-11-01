// Find in the open file: the keyboard side, pure (tested in test/find.test.ts).

import type { FindAction } from "./registry.ts";

export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** the physical key ("KeyF"), for layouts whose F key types another letter */
  code?: string;
}

/** macOS (and iPadOS): Cmd is the shortcut modifier; elsewhere Ctrl. */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const p = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? "";
  return /mac|iphone|ipad|ipod/i.test(p);
}

/**
 * The find action of a key press: Cmd/Ctrl+F opens, Cmd/Ctrl+G and F3 go to the next match,
 * with Shift to the previous one. On a Mac only Cmd counts (Ctrl+F moves the caret in text fields).
 */
export function findKeyAction(e: KeyLike, mac: boolean): FindAction | null {
  if (e.altKey) return null;
  // a Latin letter as typed; otherwise (a Cyrillic or Greek layout) the key in the F / G position
  const key = /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() : e.code === "KeyF" ? "f" : e.code === "KeyG" ? "g" : e.key;
  if (key === "F3" && !e.metaKey && !e.ctrlKey) return e.shiftKey ? "prev" : "next";
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod) return null;
  if (key === "f" && !e.shiftKey) return "open";
  if (key === "g") return e.shiftKey ? "prev" : "next";
  return null;
}

/** Longest query taken from the selection. */
export const SEED_MAX = 200;

/**
 * The query to start from, from the selected text: its first non-blank line, trimmed (matches
 * never span lines), or null when there is nothing usable.
 */
export function seedFromSelection(text: string | null | undefined): string | null {
  if (!text) return null;
  const line = text.split(/\r?\n/).find((l) => l.trim());
  if (!line) return null;
  const s = line.trim();
  return s.length > SEED_MAX ? s.slice(0, SEED_MAX) : s;
}

/**
 * The query to start from after a global search ("/", hooks/use-highlight.ts): its words without
 * the quotes and wildcards of the search syntax, as one phrase; null when nothing is left.
 */
export function seedFromSearch(q: string | null | undefined): string | null {
  if (!q) return null;
  const words = q
    .split(/\s+/)
    .map((t) => t.replace(/^["'*]+|["'*]+$/g, ""))
    .filter(Boolean);
  return seedFromSelection(words.join(" "));
}

/** How long after a find shortcut the same desktop menu command is taken as its echo. */
export const MENU_ECHO_MS = 400;

/**
 * The desktop menu has the same shortcuts as the page: where both see one key press, the menu's
 * FIND_EVENT is an echo of the key the page already handled. `key()` records a handled shortcut;
 * `menu()` says whether a menu command should run (false for such an echo).
 */
export function menuEchoFilter(now: () => number = () => Date.now()) {
  let last: { action: FindAction; t: number } | null = null;
  return {
    key(action: FindAction) {
      last = { action, t: now() };
    },
    menu(action: FindAction): boolean {
      const echo = !!last && last.action === action && now() - last.t < MENU_ECHO_MS;
      last = null;
      return !echo;
    },
  };
}
