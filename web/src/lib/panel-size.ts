/** Pure sizing rules of the resizable panels (file sidebar, contents/outline panel) and the reading width. */

export interface PanelSpec {
  /** localStorage key of the saved width */
  key: string;
  /** default width, px */
  def: number;
  min: number;
  max: number;
  /** never wider than this share of the window */
  maxShare: number;
}

export const SIDEBAR_SPEC: PanelSpec = { key: "viewer.sidebarWidth", def: 320, min: 192, max: 640, maxShare: 0.5 };
export const TOC_SPEC: PanelSpec = { key: "viewer.tocWidth", def: 240, min: 160, max: 448, maxShare: 0.35 };

/** Arrow keys move the handle this far (Shift: the big step). */
const KEY_STEP = 16;
const KEY_STEP_BIG = 64;

/** The document column keeps at least this much room next to the panels. */
export const MIN_CONTENT = 480;

/**
 * The widest the panel may be in a window this wide (never below `min`). `reserved` is the
 * width the other panel takes (the open file sidebar, for the contents panel), so that both
 * together still leave MIN_CONTENT for the document.
 */
export function maxWidth(spec: PanelSpec, viewport: number, reserved = 0): number {
  if (!(viewport > 0)) return spec.max;
  return Math.max(
    spec.min,
    Math.min(spec.max, Math.floor(viewport * spec.maxShare), viewport - reserved - MIN_CONTENT),
  );
}

export function clampWidth(width: number, spec: PanelSpec, viewport: number, reserved = 0): number {
  const max = maxWidth(spec, viewport, reserved);
  if (!Number.isFinite(width)) return Math.min(spec.def, max);
  return Math.round(Math.min(max, Math.max(spec.min, width)));
}

/** A saved width, or null (use the default) when missing or not a sane number. */
export function parseWidth(raw: string | null | undefined, spec: PanelSpec): number | null {
  if (raw == null || !/^\d{2,4}$/.test(raw.trim())) return null;
  const n = Number(raw);
  return n >= spec.min && n <= spec.max ? n : null;
}

/**
 * What a key does on a separator. `dir` is +1 when moving the handle right grows the
 * panel (handle on its right edge), -1 when it shrinks it (handle on its left edge).
 * Returns the new width, "reset" for the default, or null when the key is not ours.
 */
export function keyResize(
  key: string,
  shift: boolean,
  width: number,
  spec: PanelSpec,
  viewport: number,
  dir: 1 | -1,
  reserved = 0,
): number | "reset" | null {
  const step = shift ? KEY_STEP_BIG : KEY_STEP;
  switch (key) {
    case "ArrowLeft":
      return clampWidth(width - step * dir, spec, viewport, reserved);
    case "ArrowRight":
      return clampWidth(width + step * dir, spec, viewport, reserved);
    case "Home":
      return spec.min;
    case "End":
      return maxWidth(spec, viewport, reserved);
    case "Enter":
      return "reset";
    default:
      return null;
  }
}

/** The width after dragging the handle `dx` px from where the drag started. */
export function dragWidth(
  start: number,
  dx: number,
  spec: PanelSpec,
  viewport: number,
  dir: 1 | -1,
  reserved = 0,
): number {
  return clampWidth(start + dx * dir, spec, viewport, reserved);
}

export const READING_WIDTHS = ["narrow", "default", "wide", "full"] as const;
export type ReadingWidth = (typeof READING_WIDTHS)[number];
export const READING_WIDTH_KEY = "viewer.readingWidth";
/** The reading width when none is saved. */
export const READING_DEFAULT: ReadingWidth = "full";

/** CSS max-width of the document column of markdown and Word files. */
export const READING_MAX: Record<ReadingWidth, string> = {
  narrow: "42rem",
  default: "56rem",
  wide: "72rem",
  full: "none",
};

export const READING_LABELS: Record<ReadingWidth, string> = {
  narrow: "Narrow",
  default: "Medium",
  wide: "Wide",
  full: "Full width",
};

export function parseReadingWidth(raw: string | null | undefined): ReadingWidth {
  return (READING_WIDTHS as readonly string[]).includes(raw ?? "") ? (raw as ReadingWidth) : READING_DEFAULT;
}
