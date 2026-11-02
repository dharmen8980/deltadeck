// Pure helpers for the editor's completions (components/edit/completions.ts): the client
// cache of project names from /api/complete, and markdown link targets (relative paths
// from the tree, heading slugs as rehype-slug makes them for the preview and its TOC).

import GithubSlugger from "github-slugger";
import { dirname, normalize } from "./paths.ts";

/** One row of /api/complete. */
export interface ProjectName {
  name: string;
  def: boolean;
  files: number;
}

/** /api/complete: `capped` says the server stopped reading the prefix's rows (a longer one may find more). */
export interface ProjectNames {
  names: ProjectName[];
  capped: boolean;
}

/** what the editor asks /api/complete for (the server's maximum) */
export const NAME_LIMIT = 50;

/**
 * Answers per prefix, kept for a minute (the index changes as files are saved). A prefix
 * whose shorter prefix came back complete (under the limit, not capped) is answered by filtering that,
 * without a request: typing "sea", "sear", "searc" costs one fetch.
 */
export class NameCache {
  private map = new Map<string, { at: number; names: ProjectName[]; complete: boolean }>();
  private max: number;
  private ttlMs: number;
  private now: () => number;
  constructor(max = 64, ttlMs = 60_000, now: () => number = () => Date.now()) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  /** `complete`: these are all the names with this prefix (none were cut by the limit) */
  get(prefix: string): { names: ProjectName[]; complete: boolean } | null {
    const key = prefix.toLowerCase();
    const t = this.now();
    for (let n = key.length; n >= 1; n--) {
      const hit = this.map.get(key.slice(0, n));
      if (!hit || t - hit.at > this.ttlMs) continue;
      if (n === key.length) return { names: hit.names, complete: hit.complete };
      if (hit.complete) return { names: hit.names.filter((r) => r.name.toLowerCase().startsWith(key)), complete: true };
    }
    return null;
  }

  set(prefix: string, names: ProjectName[], limit = NAME_LIMIT, capped = false): void {
    const key = prefix.toLowerCase();
    this.map.delete(key);
    this.map.set(key, { at: this.now(), names, complete: !capped && names.length < limit });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
}

// ---------- markdown links ----------

export type LinkTarget = { kind: "path"; typed: string } | { kind: "anchor"; file: string; typed: string };

/** The link target being typed at the end of `before` (the line up to the cursor): after "](". */
export function linkTargetAt(before: string): LinkTarget | null {
  const m = /\]\(([^\s()<>"']*)$/.exec(before);
  if (!m) return null;
  const typed = m[1];
  const hash = typed.indexOf("#");
  if (hash < 0) return { kind: "path", typed };
  return { kind: "anchor", file: typed.slice(0, hash), typed: typed.slice(hash + 1) };
}

/** `to` relative to the directory `fromDir` ("" is the root): "../b/c.md". */
export function relativePath(fromDir: string, to: string): string {
  const from = fromDir ? fromDir.split("/") : [];
  const parts = to.split("/");
  let i = 0;
  while (i < from.length && i < parts.length - 1 && from[i] === parts[i]) i++;
  return [...Array<string>(from.length - i).fill(".."), ...parts.slice(i)].join("/");
}

/** A path as written in a markdown link: what would end it, start an anchor or be decoded ("%") is escaped. */
export function encodeLinkPath(p: string): string {
  return p.replace(/[% ()#<>"']/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** The root-relative file a link target names, seen from the document `fromPath`. */
export function resolveLinkFile(fromPath: string, file: string): string | null {
  let f = file;
  try {
    f = decodeURIComponent(file);
  } catch {
    /* keep it as written */
  }
  if (f.startsWith("/")) return normalize(f);
  const dir = dirname(fromPath);
  return normalize(dir ? `${dir}/${f}` : f);
}

function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (let j = 0; i < needle.length && j < hay.length; j++) if (hay[j] === needle[i]) i++;
  return i === needle.length;
}

export interface PathOption {
  /** the text to insert (relative, or root-relative when the typed text starts with "/") */
  label: string;
  markdown: boolean;
  /** how many ".." it takes */
  up: number;
}

/**
 * Link targets for the document `fromPath` among `files`, keeping those the typed text could
 * still match (its characters in order, as the completion list filters). At most `cap`:
 * markdown first, then the nearest. `capped` says some were left out.
 */
export function linkPathOptions(
  files: readonly { path: string; kind: string }[],
  fromPath: string,
  typed: string,
  cap = 300,
): { options: PathOption[]; capped: boolean } {
  const rooted = typed.startsWith("/");
  const dir = dirname(fromPath);
  const needle = typed.toLowerCase();
  const out: PathOption[] = [];
  for (const f of files) {
    if (f.path === fromPath) continue;
    const label = encodeLinkPath(rooted ? `/${f.path}` : relativePath(dir, f.path));
    if (needle && !isSubsequence(needle, label.toLowerCase())) continue;
    const up = rooted ? 0 : (/^(\.\.\/)*/.exec(label)?.[0].length ?? 0) / 3;
    out.push({ label, markdown: f.kind === "markdown", up });
  }
  out.sort(
    (a, b) =>
      Number(b.markdown) - Number(a.markdown) || a.up - b.up || a.label.split("/").length - b.label.split("/").length || (a.label < b.label ? -1 : 1),
  );
  return { options: out.slice(0, cap), capped: out.length > cap };
}

// ---------- headings ----------

/** Rough plain text of a heading's inline markdown (what rehype-slug sees as its text). */
function headingText(raw: string): string {
  return raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\](\([^)]*\)|\[[^\]]*\])/g, "$1")
    .replace(/<([a-z][a-z0-9+.-]*:[^\s<>]*|[^\s<>@]+@[^\s<>]+)>/gi, "$1") // autolinks keep their text
    .replace(/<[^>]+>/g, "")
    .replace(/`+/g, "")
    .replace(/(\*\*|__|\*|~~)(?=\S)([^*~]*?\S)\1/g, "$2")
    .replace(/(^|\W)_(?=\S)(.*?\S)_(?=\W|$)/g, "$1$2")
    .replace(/\\([!-/:-@[-`{-~])/g, "$1")
    .replace(/&(amp|lt|gt|quot|#(\d{1,7})|#x([\da-f]{1,6}));/gi, (m, name: string, dec?: string, hex?: string) => {
      const code = dec ? Number(dec) : hex ? parseInt(hex, 16) : -1;
      if (code >= 0) return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
      return { amp: "&", lt: "<", gt: ">", quot: '"' }[name.toLowerCase()] ?? m;
    })
    .trim();
}

export interface Heading {
  text: string;
  slug: string;
  level: number;
}

/** ATX and setext headings outside fenced code, with the ids the preview gives them. */
export function markdownHeadings(md: string): Heading[] {
  const slugger = new GithubSlugger();
  const out: Heading[] = [];
  let fence: { ch: string; len: number } | null = null;
  let prev: string | null = null; // the paragraph so far, when it could be a setext heading's text
  for (const line of md.split(/\r\n?|\n/)) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (f && f[1][0] === fence.ch && f[1].length >= fence.len && !line.slice(f[0].length).trim()) fence = null;
      continue;
    }
    if (f) {
      fence = { ch: f[1][0], len: f[1].length };
      prev = null;
      continue;
    }
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (atx) {
      const text = headingText(atx[2] ?? "");
      out.push({ text, slug: slugger.slug(text), level: atx[1].length });
      prev = null;
      continue;
    }
    const setext = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
    if (setext && prev !== null) {
      const text = headingText(prev);
      out.push({ text, slug: slugger.slug(text), level: setext[1][0] === "=" ? 1 : 2 });
      prev = null;
      continue;
    }
    const t = line.trim();
    const plain: boolean = !!t && !/^ {0,3}([>|*+-]|\d+[.)])/.test(line) && (prev !== null || !/^ {4}/.test(line));
    prev = plain ? (prev === null ? t : `${prev} ${t}`) : null;
  }
  return out;
}
