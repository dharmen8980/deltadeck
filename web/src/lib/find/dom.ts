// Find in the open file: the DOM side. Highlights are CSS custom highlights ("find-hl" for every
// match, "find-current" for the current one), like the global search's "search-hl"
// (hooks/use-highlight.ts): no element is added or changed, so React-owned and Shiki-owned
// nodes stay untouched and both kinds of highlight can be shown at once.

import { clearHighlight, hasHighlight, highlightsSupported, setHighlight } from "../highlights.ts";
import { FIND_SKIP, topInset } from "./skip.ts";

export { DOC_SKIP, FIND_SKIP, lineAtViewportTop, topInset } from "./skip.ts";

// the list "find-hl" was last built from: a step only replaces "find-current", which paints over it
let lastAll: readonly (Range | null)[] | null = null;

export function setFindHighlights(all: readonly (Range | null)[], current: Range | null): void {
  if (!highlightsSupported()) return;
  if (all !== lastAll || !hasHighlight("findAll")) {
    lastAll = all;
    setHighlight("findAll", all.filter((r): r is Range => r !== null));
  }
  setHighlight("findCurrent", current ? [current] : []);
}

export function clearFindHighlights(): void {
  lastAll = null;
  clearHighlight("findAll");
  clearHighlight("findCurrent");
}

const BLOCKS = new Set([
  "P", "LI", "TD", "TH", "TR", "H1", "H2", "H3", "H4", "H5", "H6", "PRE", "BLOCKQUOTE", "DT", "DD", "DIV",
  "FIGCAPTION", "SECTION", "ARTICLE", "SUMMARY", "DETAILS", "UL", "OL", "DL", "TABLE", "THEAD", "TBODY",
  "HEADER", "FOOTER", "ASIDE", "NAV", "FIGURE", "BR", "HR", "text", "foreignObject",
]);

/** The rendered text of a subtree, with a line break between blocks, and where each text node starts in it. */
export interface FlatText {
  text: string;
  nodes: Text[];
  starts: number[];
}

function blockOf(el: Element | null, root: Element, cache: Map<Element, Element>): Element {
  const path: Element[] = [];
  let cur = el;
  let found: Element = root;
  while (cur && cur !== root) {
    const c = cache.get(cur);
    if (c) {
      found = c;
      break;
    }
    path.push(cur);
    if (BLOCKS.has(cur.tagName) || cur.classList.contains("line")) {
      found = cur;
      break;
    }
    cur = cur.parentElement;
  }
  for (const p of path) cache.set(p, found);
  return found;
}

/** Whether whitespace in `el` is kept as written (`pre`, `textarea`, `white-space: pre*`, which inherits). */
function preformatted(el: Element | null, cache: Map<Element, boolean>): boolean {
  if (!el) return false;
  let res = cache.get(el);
  if (res === undefined) {
    const ws = typeof getComputedStyle === "function" ? getComputedStyle(el).whiteSpace || "" : "";
    res = ws.startsWith("pre") || ws === "break-spaces" || !!el.closest("pre,textarea");
    cache.set(el, res);
  }
  return res;
}

/** Text nodes under `root` (minus FIND_SKIP subtrees) joined, blocks on their own lines. */
export function flattenDom(root: Element, skip = FIND_SKIP): FlatText {
  return joinFlat(walkFlat(root, skip));
}

/** One piece of a flattened subtree: a `<br>`, or a text node with its block and whether it is preformatted. */
export type FlatItem = { br: true } | { br?: false; node: Text; text: string; block: unknown; pre: boolean };

function* walkFlat(root: Element, skip: string): Generator<FlatItem> {
  const cache = new Map<Element, Element>();
  const pre = new Map<Element, boolean>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (n.nodeType === Node.ELEMENT_NODE) {
        if ((n as Element).matches(skip)) return NodeFilter.FILTER_REJECT;
        return (n as Element).tagName === "BR" ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.ELEMENT_NODE) {
      yield { br: true };
      continue;
    }
    const text = n.nodeValue ?? "";
    if (!text) continue;
    const p = /[\n\r\t]/.test(text) && preformatted(n.parentElement, pre);
    yield { node: n as Text, text, block: blockOf(n.parentElement, root, cache), pre: p };
  }
}

/** Join flattened pieces: a line break between blocks and for each `<br>`; elsewhere source line breaks read as spaces. */
export function joinFlat(items: Iterable<FlatItem>): FlatText {
  const out: FlatText = { text: "", nodes: [], starts: [] };
  const parts: string[] = [];
  let pos = 0;
  let prevBlock: unknown = null;
  const brk = () => {
    if (parts.length && !parts[parts.length - 1].endsWith("\n")) {
      parts.push("\n");
      pos += 1;
    }
  };
  for (const it of items) {
    if (it.br) {
      brk();
      continue;
    }
    if (prevBlock !== null && it.block !== prevBlock) brk();
    prevBlock = it.block;
    // outside preformatted text a line break in the source (a hard-wrapped paragraph) shows as
    // a space; same length, so the node offsets stay valid
    const v = it.pre ? it.text : it.text.replace(/[\n\r\t]/g, " ");
    out.nodes.push(it.node);
    out.starts.push(pos);
    parts.push(v);
    pos += v.length;
  }
  out.text = parts.join("");
  return out;
}

/** DOM ranges of the matches [starts[k], ends[k]) of a FlatText (null where the nodes are gone). */
export function flatRanges(flat: FlatText, starts: readonly number[], ends: readonly number[]): (Range | null)[] {
  const out: (Range | null)[] = [];
  let i = 0;
  const n = flat.nodes.length;
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k];
    const e = ends[k];
    while (i + 1 < n && flat.starts[i + 1] <= s) i++;
    let j = i;
    while (j + 1 < n && flat.starts[j + 1] < e) j++;
    const a = flat.nodes[i];
    const b = flat.nodes[j];
    if (!a || !b || !a.isConnected || !b.isConnected) {
      out.push(null);
      continue;
    }
    try {
      const r = document.createRange();
      r.setStart(a, Math.min(s - flat.starts[i], a.length));
      r.setEnd(b, Math.min(e - flat.starts[j], b.length));
      out.push(r);
    } catch {
      out.push(null);
    }
  }
  return out;
}

function scrollable(el: Element, axis: "x" | "y"): boolean {
  const cs = getComputedStyle(el);
  const o = axis === "x" ? cs.overflowX : cs.overflowY;
  if (o !== "auto" && o !== "scroll") return false;
  return axis === "x" ? el.scrollWidth > el.clientWidth + 1 : el.scrollHeight > el.clientHeight + 1;
}

/**
 * Bring a rectangle (a match) into view: inner scroll boxes first (code blocks scroll
 * sideways, the editor's preview vertically), then the page, which centers it. Never moves focus.
 */
export function scrollRectIntoView(getRect: () => DOMRect | null, from: Element | null): void {
  for (let el = from?.parentElement ?? null; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    const rect = getRect();
    if (!rect) return;
    const box = el.getBoundingClientRect();
    if (scrollable(el, "x") && (rect.left < box.left + 24 || rect.right > box.right - 24)) {
      el.scrollLeft += rect.left - box.left - Math.max(24, (box.width - rect.width) / 2);
    }
    if (scrollable(el, "y") && (rect.top < box.top || rect.bottom > box.bottom)) {
      el.scrollTop += rect.top - box.top - Math.max(0, (box.height - rect.height) / 2);
    }
  }
  const rect = getRect();
  if (!rect) return;
  const inset = topInset();
  if (rect.top < inset || rect.bottom > window.innerHeight - 16 || rect.top > window.innerHeight * 0.75) {
    const top = window.scrollY + rect.top - Math.max(inset, (window.innerHeight - rect.height) / 2);
    window.scrollTo({ top: Math.max(0, top) });
  }
}

export function scrollRangeIntoView(range: Range): void {
  const rect = () => {
    const r = range.getBoundingClientRect();
    return r.width || r.height ? r : null;
  };
  const start = range.startContainer;
  scrollRectIntoView(rect, start.nodeType === Node.ELEMENT_NODE ? (start as Element) : start.parentElement);
}

/** Open the closed `<details>` around a node (a match inside a collapsed section); true if any was opened. */
export function revealNode(node: Node | null): boolean {
  let opened = false;
  for (let el = node?.parentElement ?? null; el; el = el.parentElement) {
    if (el instanceof HTMLDetailsElement && !el.open) {
      // the summary itself shows while closed
      const summary = el.querySelector(":scope > summary");
      if (summary && summary.contains(node)) continue;
      el.open = true;
      opened = true;
    }
  }
  return opened;
}

/** Index of the first range at or below the top of the visible page (ranges in document order). */
export function firstVisibleRange(ranges: readonly (Range | null)[]): number {
  // at the top of the page nothing is above what the reader sees (a title under the toolbar)
  if (window.scrollY <= 0) return 0;
  const inset = topInset(false);
  let lo = 0;
  let hi = ranges.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const r = ranges[mid];
    const top = r ? r.getBoundingClientRect().top : -Infinity;
    if (top < inset) lo = mid + 1;
    else hi = mid;
  }
  return lo < ranges.length ? lo : 0;
}
