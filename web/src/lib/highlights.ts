// The CSS custom highlights (CSS.highlights) the viewer paints with: one table of their names
// and priorities. The names must match the `::highlight(...)` rules in app/globals.css. A
// higher priority paints over a lower one where ranges overlap. No element is added or
// changed, so React-owned and Shiki-owned nodes stay untouched.

export const HIGHLIGHTS = {
  /** Global search matches (hooks/use-highlight.ts). */
  search: { name: "search-hl", priority: 0 },
  /** Changed words of "Changed since you last looked" (code-marks-dom.ts). */
  changeWord: { name: "change-word", priority: 0 },
  /** Every find-in-file match: above the search's and the change marks' highlights. */
  findAll: { name: "find-hl", priority: 1 },
  /** The current find-in-file match: above every other highlight. */
  findCurrent: { name: "find-current", priority: 2 },
} as const;

export type HighlightId = keyof typeof HIGHLIGHTS;

type HighlightRegistry = Map<string, unknown>;
const registry = (): HighlightRegistry | undefined =>
  typeof CSS !== "undefined" ? (CSS as unknown as { highlights?: HighlightRegistry }).highlights : undefined;

/** Whether this browser can paint custom highlights. */
export function highlightsSupported(): boolean {
  return !!registry() && typeof Highlight !== "undefined";
}

export function hasHighlight(id: HighlightId): boolean {
  return !!registry()?.has(HIGHLIGHTS[id].name);
}

/** Paint `ranges` as highlight `id` (replacing what it painted before); no ranges: clear it. */
export function setHighlight(id: HighlightId, ranges: readonly Range[]): void {
  const reg = registry();
  if (!reg || typeof Highlight === "undefined") return;
  const { name, priority } = HIGHLIGHTS[id];
  if (!ranges.length) {
    reg.delete(name);
    return;
  }
  const h = new Highlight(...ranges);
  if (priority) (h as unknown as { priority: number }).priority = priority;
  reg.set(name, h);
}

export function clearHighlight(id: HighlightId): void {
  registry()?.delete(HIGHLIGHTS[id].name);
}
