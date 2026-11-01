// Find in the open file: the small pieces viewers import eagerly (what is never searched, where
// the reader's page starts). Kept apart from dom.ts so that loads only with the find bar.

import { CHANGE_UI } from "../code-marks-dom.ts";

/** Never searched: the marks UI (labels, removed lines), scripts, styles, hidden parts, and anything marked `.no-find`. */
export const FIND_SKIP = `script,style,template,noscript,[hidden],.no-find,.${CHANGE_UI},.sr-only,.mermaid-print`;

/** Rendered documents (markdown, docx, diagrams): also their controls (copy, zoom, anchors), which never print. */
export const DOC_SKIP = `${FIND_SKIP},.no-print,button`;

/**
 * Height of what covers the top of the page: the sticky header and a viewer toolbar under it,
 * and the find bar unless `bar` is false (where the reader's page starts, for the first match).
 */
export function topInset(bar = true): number {
  const header = document.querySelector("header.sticky");
  const base = header ? Math.max(0, header.getBoundingClientRect().bottom) + 40 : 56;
  const el = bar ? document.querySelector("[data-find-bar]") : null;
  return el ? Math.max(base, el.getBoundingClientRect().bottom + 8) : base;
}

/** The first line element (`sel`, in document order under `root`) not above the top of the visible page. */
export function lineAtViewportTop(root: Element, sel: string): Element | null {
  const els = root.querySelectorAll(sel);
  const y = topInset(false);
  let lo = 0;
  let hi = els.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (els[mid].getBoundingClientRect().bottom <= y) lo = mid + 1;
    else hi = mid;
  }
  return els[lo] ?? null;
}
