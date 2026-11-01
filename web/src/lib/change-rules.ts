// Pure rules for "Changed since you last looked" (no `@/` imports: unit tested with node --test).

/** File kinds whose text is fetched, snapshotted and diffed. */
export const TEXT_KINDS: ReadonlySet<string> = new Set(["markdown", "mermaid", "code", "text", "json", "csv"]);

/** Mirrors the server's readers.CONTENT_MAX: /api/content answers 413 above it. */
export const CONTENT_MAX = 2 * 1024 * 1024;

/** Mirrors the server's docx.DOCX_MAX: /api/docx answers 413 above it. */
export const DOCX_MAX = 20 * 1024 * 1024;

/**
 * Kinds tracked through a text converted on the server rather than the file's own text:
 * a .docx is snapshotted and diffed as its markdown (/api/docx?format=markdown).
 */
const CONVERTED_KINDS: ReadonlySet<string> = new Set(["docx"]);

/** Kinds with a tracked text: the file's own (TEXT_KINDS) or a converted one (CONVERTED_KINDS). */
export const isTracked = (kind: string) => TEXT_KINDS.has(kind) || CONVERTED_KINDS.has(kind);

/** Above this size the tracked text is not fetched (the server would answer 413). */
export const trackedMax = (kind: string) => (CONVERTED_KINDS.has(kind) ? DOCX_MAX : CONTENT_MAX);

/** The tracked text is markdown: block diffs and in-place highlights. */
export const isMarkdownText = (kind: string) => kind === "markdown" || kind === "docx";

/**
 * Kinds whose own view marks changes line by line in place (the code and text viewers,
 * JSON's source view). csv is tracked but shown as a table, so it gets the banner only.
 */
const LINE_MARK_KINDS: ReadonlySet<string> = new Set(["code", "text", "json"]);
export const hasLineMarks = (kind: string) => LINE_MARK_KINDS.has(kind);

/**
 * true when a file seen before has another mtime or size now (|Δmtime| > 1 ms).
 * Never viewed (undefined) -> false. `!==` rather than `>`: a file restored from
 * an older backup counts as changed too.
 */
export function isChangedSince(
  cur: { mtime: number; size: number },
  seen: { mtime: number; size: number } | undefined,
): boolean {
  if (!seen) return false;
  return Math.abs(cur.mtime - seen.mtime) > 0.001 || cur.size !== seen.size;
}

/** p itself or below `from` -> moved path, else null. */
export function remapPath(p: string, from: string, to: string): string | null {
  if (p === from) return to;
  if (p.startsWith(`${from}/`)) return `${to}${p.slice(from.length)}`;
  return null;
}

/** All ancestor folders ("" excluded) of the given file paths -> how many of the files they contain. */
export function changedDirsOf(paths: Iterable<string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of paths) {
    for (let i = p.lastIndexOf("/"); i > 0; i = p.lastIndexOf("/", i - 1)) {
      const d = p.slice(0, i);
      out.set(d, (out.get(d) ?? 0) + 1);
    }
  }
  return out;
}
