"use client";

// Find in the open file: the shortcuts (Cmd/Ctrl+F, Cmd/Ctrl+G, Shift+Cmd/Ctrl+G, F3) and the
// desktop menu's FIND_EVENT, always loaded; the bar itself (find-bar.tsx) loads on first use.
// While editing, the keys are left to CodeMirror's own search panel.

import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { findKeyAction, isMacPlatform, menuEchoFilter, seedFromSearch, seedFromSelection } from "@/lib/find/keys";
import { FIND_EVENT, type FindAction } from "@/lib/find/registry";

// made again after a failed load (lazy keeps its first outcome), so the next Cmd/Ctrl+F retries
const lazyBar = () => lazy(() => import("./find-bar").then((m) => ({ default: m.FindBar })));

/** How long keys typed before the bar's chunk arrives are held for it (a chunk that never comes). */
const EARLY_MS = 3000;

/** The bar's chunk failed to load (the UI was rebuilt under an open tab, offline): no bar, not a broken app. */
class LoadBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** A modal (the "/" search, an unsaved-changes prompt) is open, or the key comes from one: its keys are its own. */
function inModal(target: EventTarget | null): boolean {
  if (target instanceof Element && target.closest("[role=dialog],[role=alertdialog]")) return true;
  return !!document.querySelector("[role=dialog][data-state=open],[role=alertdialog][data-state=open]");
}

export interface FindCommand {
  action: FindAction;
  /** the query to start from (the selected text), for "open" */
  seed: string | null;
  /** the seed is what was typed while the bar loaded: keep the caret at its end */
  typed?: boolean;
  n: number;
}

const inBar = (n: Node | null) => !!n && !!(n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement)?.closest("[data-find-bar]");

export function FindController({
  enabled,
  fileKey,
  searchTerm,
}: {
  enabled: boolean;
  fileKey: string;
  /** the global search's query highlighted in the page ("/"), the query to start from */
  searchTerm?: string;
}) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [command, setCommand] = useState<FindCommand | null>(null);
  const [FindBar, setFindBar] = useState(lazyBar);
  const returnFocus = useRef<HTMLElement | null>(null);
  const count = useRef(0);
  const term = useRef({ current: "", used: "" });
  // Keys typed between the first Cmd/Ctrl+F and the bar's chunk arriving go into the query.
  const ready = useRef(false);
  const early = useRef<string | null>(null);
  useEffect(() => {
    term.current.current = searchTerm ?? "";
  }, [searchTerm]);

  const run = useCallback((action: FindAction) => {
    const active = document.activeElement as HTMLElement | null;
    if (!inBar(active)) returnFocus.current = active && active !== document.body ? active : null;
    let seed: string | null = null;
    if (action === "open") {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && !inBar(sel.anchorNode)) seed = seedFromSelection(sel.toString());
      // no selection: the global search's term, once per search (then the bar keeps its own query)
      const t = term.current;
      if (!seed && t.current && t.current !== t.used) seed = seedFromSearch(t.current);
      t.used = t.current;
    }
    if (!ready.current && early.current === null) {
      early.current = "";
      // bounded: a chunk that never arrives must not keep eating keys
      setTimeout(() => {
        if (!ready.current) early.current = null;
      }, EARLY_MS);
    }
    setLoaded(true);
    setOpen(true);
    setCommand({ action, seed, n: ++count.current });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const mac = isMacPlatform();
    const echo = menuEchoFilter();
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      // the editor (CodeMirror) has its own find
      if (e.target instanceof Element && e.target.closest(".cm-editor")) return;
      if (inModal(e.target)) return;
      if (early.current !== null && !e.metaKey && !e.ctrlKey && !e.altKey && (e.key.length === 1 || e.key === "Backspace")) {
        e.preventDefault();
        early.current = e.key === "Backspace" ? early.current.slice(0, -1) : early.current + e.key;
        return;
      }
      const action = findKeyAction(e, mac);
      if (!action) return;
      e.preventDefault();
      echo.key(action);
      run(action);
    };
    const onMenu = (e: Event) => {
      const action = (e as CustomEvent<unknown>).detail;
      if ((action === "open" || action === "next" || action === "prev") && !inModal(null) && echo.menu(action)) run(action);
    };
    // capture: before a viewer's own handlers, and before the browser's find opens
    window.addEventListener("keydown", onKey, true);
    window.addEventListener(FIND_EVENT, onMenu);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener(FIND_EVENT, onMenu);
    };
  }, [enabled, run]);

  const onReady = useCallback(() => {
    ready.current = true;
    const typed = early.current;
    early.current = null;
    if (typed) setCommand({ action: "open", seed: typed, typed: true, n: ++count.current });
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    const el = returnFocus.current;
    returnFocus.current = null;
    if (el?.isConnected) el.focus({ preventScroll: true });
  }, []);

  // Editing (CodeMirror's find takes over): the bar closes, and stays closed after (the next
  // open records where focus returns to again).
  const [wasEnabled, setWasEnabled] = useState(enabled);
  if (wasEnabled !== enabled) {
    setWasEnabled(enabled);
    if (!enabled) setOpen(false);
  }
  const shown = open && enabled;

  const onLoadError = useCallback(() => {
    early.current = null;
    setOpen(false);
    setLoaded(false);
    setFindBar(lazyBar);
  }, []);

  if (!loaded) return null;
  return (
    <LoadBoundary onError={onLoadError}>
      <Suspense fallback={null}>
        <FindBar open={shown} command={command} fileKey={fileKey} onClose={close} onReady={onReady} />
      </Suspense>
    </LoadBoundary>
  );
}
