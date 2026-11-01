// Plain parts of the line-numbered code views (code, text, JSON and markdown code blocks).
// No `@/` imports: unit tested with node --test.

/** Above this size we do not syntax highlight; the plain/large-file viewer is used instead. */
export const HIGHLIGHT_MAX_BYTES = 300 * 1024;

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

/** The un-highlighted lines, shaped like Shiki output (one `.line` span per line, `#L<n>` ids). */
export function plainHtml(code: string): string {
  const lines = code.endsWith("\n") ? code.slice(0, -1).split("\n") : code.split("\n");
  const body = lines
    .map((l, i) => `<span class="line" data-line="${i + 1}" id="L${i + 1}">${escapeHtml(l)}</span>`)
    .join("\n");
  return `<pre class="shiki"><code>${body}</code></pre>`;
}

/** The line of a `#L<n>` hash, or null. */
export function parseLineHash(hash: string): number | null {
  const m = /^L(\d+)$/.exec(hash);
  return m ? Number(m[1]) : null;
}
