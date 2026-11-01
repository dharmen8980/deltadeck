"use client";

import { useSyncExternalStore } from "react";
import {
  clampWidth,
  parseReadingWidth,
  parseWidth,
  READING_WIDTH_KEY,
  type PanelSpec,
  type ReadingWidth,
} from "@/lib/panel-size";
import { createPref, usePref, type Pref } from "@/lib/prefs";

/** Saved layout prefs (panel widths, reading width) in localStorage, shared by every component that shows them. */

type Listener = () => void;

const widthStores = new Map<string, Pref<number | null>>();

function widthStore(spec: PanelSpec) {
  let s = widthStores.get(spec.key);
  if (!s) {
    s = createPref<number | null>(spec.key, (raw) => parseWidth(raw, spec), (v) => (v === null ? null : String(v)));
    widthStores.set(spec.key, s);
  }
  return s;
}

/** Saves a panel width; the default (or null) clears the saved value. */
export function setPanelWidth(spec: PanelSpec, width: number | null) {
  widthStore(spec).set(width === null || width === spec.def ? null : width);
}

// The window width, for the "never more than a share of the window" limit.
const viewportListeners = new Set<Listener>();
let viewportWidth = 0;
let viewportFrame = 0;
function onWindowResize() {
  if (viewportFrame) return;
  viewportFrame = requestAnimationFrame(() => {
    viewportFrame = 0;
    viewportWidth = window.innerWidth;
    viewportListeners.forEach((l) => l());
  });
}
function subscribeViewport(l: Listener) {
  if (!viewportListeners.size) window.addEventListener("resize", onWindowResize);
  viewportListeners.add(l);
  return () => {
    viewportListeners.delete(l);
    if (!viewportListeners.size) window.removeEventListener("resize", onWindowResize);
  };
}
function getViewport() {
  return viewportWidth || (viewportWidth = window.innerWidth);
}

export function useViewportWidth(): number {
  return useSyncExternalStore(subscribeViewport, getViewport, () => 0);
}

/**
 * The width to show: the saved one (or the default), kept inside the limits of this window.
 * `reserved`: the width another panel already takes beside it (see maxWidth).
 */
export function usePanelWidth(spec: PanelSpec, reserved = 0): number {
  const saved = usePref(widthStore(spec), null);
  const viewport = useViewportWidth();
  return clampWidth(saved ?? spec.def, spec, viewport, reserved);
}

const readingStore = createPref<ReadingWidth>(READING_WIDTH_KEY, parseReadingWidth, (v) => (v === "default" ? null : v));

export function useReadingWidth(): ReadingWidth {
  return usePref(readingStore, "default");
}

export function setReadingWidth(v: ReadingWidth) {
  readingStore.set(v);
}
