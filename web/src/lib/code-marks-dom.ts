// "Changed since you last looked" marks on the highlighted code view (CodeLines): its lines
// are Shiki HTML set with dangerouslySetInnerHTML, so the marks are applied to that DOM
// after it is in place and removed again before the next text or set of marks. Nothing
// here changes the layout: line marks are attributes (CSS draws bars and tints), removal
// markers are zero-height until opened, and the changed words are CSS custom highlights.

import { clearHighlight, highlightsSupported, setHighlight } from "./highlights.ts";
import { removedLabel, type LineMarks, type RemovedRun } from "./line-marks.ts";

/** Elements added for the marks: never part of the code (skipped when copying and measuring). */
export const CHANGE_UI = "code-change-ui";
const LINE_ATTRS = ["data-change", "data-change-hunk"];

/** Whose word highlights are registered (one view at a time; a newer one replaces them). */
let highlightOwner: object | null = null;

export function setWordHighlights(owner: object, ranges: Range[]): void {
  if (!highlightsSupported()) return;
  highlightOwner = owner;
  setHighlight("changeWord", ranges);
}

export function clearWordHighlights(owner: object): void {
  if (highlightOwner !== owner) return;
  highlightOwner = null;
  clearHighlight("changeWord");
}

/** DOM ranges of the character spans [start, end) of `el`'s text (marks UI skipped). */
export function textRanges(el: HTMLElement, spans: readonly [number, number][]): Range[] {
  const out: Range[] = [];
  if (!spans.length) return out;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(`.${CHANGE_UI}`) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  let pos = 0;
  let k = 0;
  let range: Range | null = null;
  for (let node = walker.nextNode(); node && k < spans.length; node = walker.nextNode()) {
    const len = node.nodeValue?.length ?? 0;
    const end = pos + len;
    while (k < spans.length) {
      const [s, e] = spans[k];
      if (!range) {
        if (s >= end) break;
        range = document.createRange();
        range.setStart(node, Math.max(0, s - pos));
      }
      if (e > end) break;
      range.setEnd(node, e - pos);
      out.push(range);
      range = null;
      k++;
    }
    pos = end;
  }
  // A range still open ran past the text (the line is shorter than the diff said): dropped.
  return out;
}

/** A visually hidden "added" / "modified" for screen readers, not copied with the code. */
function srLabel(text: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = `${CHANGE_UI} sr-only select-none`;
  s.textContent = text;
  return s;
}

/** The marker of a removal: a dashed line and a button that shows the removed lines in place. */
function removedMarker(run: RemovedRun, interactive: boolean): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = `${CHANGE_UI} code-removed`;
  if (run.beforeLine === null) wrap.classList.add("code-removed-end");
  const label = removedLabel(run);
  if (!interactive) {
    wrap.title = label;
    wrap.append(srLabel(label));
    return wrap;
  }
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "code-removed-toggle";
  btn.setAttribute("aria-expanded", "false");
  btn.setAttribute("aria-label", `${label}. Show them`);
  btn.title = `${label}: click to show them`;
  btn.textContent = `−${run.count.toLocaleString()}`;
  wrap.append(btn);
  return wrap;
}

/** Opens or closes a removal marker (fills in its lines the first time). */
export function toggleRemoved(btn: HTMLElement, run: RemovedRun): void {
  const wrap = btn.closest<HTMLElement>(".code-removed");
  if (!wrap) return;
  const open = btn.getAttribute("aria-expanded") !== "true";
  btn.setAttribute("aria-expanded", String(open));
  btn.setAttribute("aria-label", `${removedLabel(run)}. ${open ? "Hide" : "Show"} them`);
  wrap.classList.toggle("is-open", open);
  let body = wrap.querySelector<HTMLElement>(".code-removed-lines");
  if (open && !body) {
    body = document.createElement("span");
    body.className = "code-removed-lines";
    body.setAttribute("role", "group");
    body.setAttribute("aria-label", `${removedLabel(run)} (not in the current version)`);
    run.lines.forEach((text, i) => {
      const l = document.createElement("span");
      l.className = "code-removed-line";
      l.dataset.oldLine = String(run.oldStart + i);
      l.textContent = text || " ";
      body!.append(l);
    });
    if (run.count > run.lines.length) {
      const more = document.createElement("span");
      more.className = "code-removed-more";
      more.textContent = `… ${(run.count - run.lines.length).toLocaleString()} more (Show changes has them all)`;
      body.append(more);
    }
    wrap.append(body);
  }
  if (body) body.hidden = !open;
}

/**
 * Applies `marks` to the line elements in `root` (`.line[data-line]`, 1-based). `full`: tints and
 * word highlights and openable removals; otherwise (large files) gutter bars and plain removal ticks.
 * Returns the cleanup.
 */
export function applyCodeMarks(root: HTMLElement, marks: LineMarks, full: boolean): () => void {
  const owner = {};
  const lines = root.querySelectorAll<HTMLElement>(".line[data-line]");
  const at = (n: number) => lines[n - 1] as HTMLElement | undefined;
  for (const [n, kind] of marks.kinds) {
    const el = at(n);
    if (!el) continue;
    el.setAttribute("data-change", kind);
    el.prepend(srLabel(kind === "added" ? "added line: " : "modified line: "));
  }
  for (const n of marks.anchors) at(n)?.setAttribute("data-change-hunk", "");
  marks.removed.forEach((run, i) => {
    const marker = removedMarker(run, full);
    marker.dataset.run = String(i);
    // Which change it shows (the review basket finds the hunk by it).
    marker.dataset.removedBefore = run.beforeLine === null ? "end" : String(run.beforeLine);
    if (run.beforeLine === null) {
      marker.setAttribute("data-change-hunk", "");
      // After the last line of the text (Shiki adds an empty one after a final newline).
      const last = at(marks.lineCount) ?? lines[lines.length - 1];
      if (last) last.after(marker);
      return;
    }
    const host = at(run.beforeLine);
    // Before the host line, after the newline that ends the previous one (a block there adds no empty line).
    if (host) host.before(marker);
  });
  if (full && marks.words.size) {
    const ranges: Range[] = [];
    for (const [n, spans] of marks.words) {
      const el = at(n);
      if (el) ranges.push(...textRanges(el, spans));
    }
    setWordHighlights(owner, ranges);
  }
  return () => {
    clearWordHighlights(owner);
    root.querySelectorAll(`.${CHANGE_UI}`).forEach((el) => el.remove());
    root.querySelectorAll<HTMLElement>("[data-change], [data-change-hunk]").forEach((el) => {
      for (const a of LINE_ATTRS) el.removeAttribute(a);
    });
  };
}

/**
 * The selected text without the marks UI (labels, removed lines), or null when the selection
 * holds none of it (the browser's own copy is then fine).
 */
export function copyWithoutMarks(root: HTMLElement, sel: Selection | null): string | null {
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const ui = Array.from(root.querySelectorAll(`.${CHANGE_UI}`));
  if (!ui.some((el) => range.intersectsNode(el))) return null;
  const frag = range.cloneContents();
  frag.querySelectorAll(`.${CHANGE_UI}`).forEach((el) => el.remove());
  return frag.textContent ?? "";
}
