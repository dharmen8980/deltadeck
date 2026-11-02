// Typed client for the local FastAPI backend. Every request is a relative
// same-origin `/api/...` URL; nothing in here ever talks to another host.

import type { ProjectNames } from "@/lib/complete";

export type FileKind =
  | "markdown"
  | "mermaid"
  | "image"
  | "pdf"
  | "json"
  | "csv"
  | "xlsx"
  | "docx"
  | "code"
  | "text"
  | "binary";

export interface AppConfig {
  /** basename of the root; null when no folder is selected */
  root_name: string | null;
  /** full canonical path of the root; null when no folder is selected */
  root_path?: string | null;
  /** true when the server runs without a root: only /api/config and /api/roots* work */
  no_root?: boolean;
  /** the folder can be switched from the UI (false with --lock-root) */
  root_switch_enabled?: boolean;
  /** Per-launch token for mutating /api/roots/* and /api/seen/* (same-site requests only). */
  root_token?: string;
  /** the server keeps the "changed since you last looked" history for this folder (/api/seen*) */
  seen_enabled?: boolean;
  /** the folder is inside a git work tree and git is usable: /api/git/* (read-only) */
  git_enabled?: boolean;
  repo_prefix: string;
  search_max_bytes: number;
  /** served by the desktop app (its server takes no command-line options) */
  desktop?: boolean;
  version: string | number;
  /** Tier 3 (opt-in editing). Absent on older/read-only servers: treat as false. */
  edit_enabled?: boolean;
  /** Per-launch token for /api/edit/*, only present when editing is enabled. */
  edit_token?: string;
  deny_patterns?: string[];
  ignore_patterns?: string[];
  upload_ext?: string[];
  upload_max_bytes?: number;
  /** largest file the editor opens and saves (absent on older servers: EDIT_MAX_BYTES) */
  edit_max_bytes?: number;
  /** protected (deny-list) files can be shown read-only on request (false with --no-reveal) */
  reveal_enabled?: boolean;
}

/** Why a file or folder is hidden: git ignores it, the viewer's ignore list, or the deny list. */
export type HiddenReason = "git" | "ignore" | "deny";

export interface FileEntry {
  path: string;
  name: string;
  size: number;
  mtime: number;
  kind: FileKind;
  ext: string;
  /** only on rows built from hidden entries */
  hidden?: HiddenReason;
}

/** A hidden file or folder (/api/tree?hidden=1, /api/hidden). Folders are listed when opened. */
export interface HiddenEntry {
  path: string;
  name: string;
  dir: boolean;
  reason: HiddenReason;
  kind?: FileKind;
  ext?: string;
  size?: number;
  mtime?: number;
}

export interface TreeResponse {
  files: FileEntry[];
  dirs: string[];
  version: number;
  /** only with hidden=1: the topmost hidden children of visible folders */
  hidden?: HiddenEntry[];
}

export interface HiddenListResponse {
  path: string;
  reason: HiddenReason;
  entries: HiddenEntry[];
  truncated: boolean;
}

export interface FileInfo extends FileEntry {
  mime: string;
}

export interface ContentResponse {
  path: string;
  text: string;
  size: number;
  truncated: boolean;
}

export interface TextSegment {
  start: number;
  end: number;
  start_line: number;
  text: string;
}

export interface TextGap {
  start: number;
  end: number;
}

export interface TextResponse {
  path: string;
  size: number;
  segments: TextSegment[];
  gaps: TextGap[];
}

export interface CsvResponse {
  header: string[];
  rows: string[][];
  total_rows: number;
  truncated: boolean;
}

export interface XlsxSheet {
  name: string;
  rows: string[][];
  total_rows: number;
  truncated: boolean;
}

export interface XlsxResponse {
  sheets: XlsxSheet[];
}

/** /api/docx: a Word document converted on the server (view-only, sanitized). */
export interface DocxResponse {
  path: string;
  /** sanitized HTML, one top-level element per line; only with format=html */
  html?: string;
  /** the same content as markdown: searched, snapshotted and diffed */
  markdown: string;
  /** [startLine, endLine] (1-based) in `markdown` of each top-level HTML element */
  blocks: [number, number][];
  /** what the conversion left out (unsupported content, dropped images) */
  warnings: string[];
  /** the document was cut at a block boundary (size limit) */
  truncated: boolean;
  images: number;
  images_dropped: number;
  size: number;
  mtime: number;
}

export interface NameHit {
  path: string;
  name: string;
  kind: FileKind;
}

export interface ContentMatch {
  line: number;
  offset: number;
  text: string;
  ranges: [number, number][];
}

export interface ContentHit {
  path: string;
  kind: FileKind;
  score: number;
  matches: ContentMatch[];
  match_count: number;
}

export interface SearchResponse {
  indexing: boolean;
  /** content-search coverage (older servers omit these) */
  indexed_files?: number;
  indexable_files?: number;
  limit_reached?: boolean;
  limit_reason?: "files" | "bytes" | "disk" | "error" | null;
  names: NameHit[];
  content: ContentHit[];
}

export interface ChangeEvent {
  version: number;
  added: string[];
  modified: string[];
  deleted: string[];
  renames: { from: string; to: string }[];
  dirs_changed: boolean;
  /** the set of hidden tree items changed */
  hidden_changed?: boolean;
}

/** M modified, A added (staged, not in HEAD), D deleted, R renamed, ?? untracked, U conflict. */
export type GitStatusCode = "M" | "A" | "D" | "R" | "??" | "U";

export interface GitStatusFile {
  path: string;
  status: GitStatusCode;
  /** renames: the path in the last commit (only when it is visible in this folder) */
  origPath: string | null;
  /** lines against the last commit; null when binary or not counted (too large, too many files) */
  added: number | null;
  removed: number | null;
  binary: boolean;
  kind: FileKind | null;
  /** null for deleted files */
  mtime: number | null;
  size: number | null;
}

export interface GitStatusResponse {
  /** abbreviated HEAD commit; null before the first commit */
  head: string | null;
  branch: string | null;
  /** the root inside the work tree, "" or "sub/dir/" */
  prefix: string;
  /** newest change first; deleted files last */
  files: GitStatusFile[];
  /** more changed files than the server lists */
  truncated: boolean;
}

export interface GitHeadBlob {
  oid: string;
  size: number;
  /** null when binary or too large */
  text: string | null;
  binary: boolean;
  tooLarge: boolean;
}

export interface GitFileResponse {
  path: string;
  /** null: no uncommitted change */
  status: GitStatusCode | null;
  origPath: string | null;
  /** the version in the last commit; null when the file is not in it */
  head: GitHeadBlob | null;
  headCommit: string | null;
  exists: boolean;
}

export interface GitBlameCommit {
  short: string;
  author: string;
  /** unix seconds */
  authorTime: number;
  summary: string;
  /** the line is not committed yet */
  uncommitted: boolean;
}

export interface GitBlameLine {
  line: number;
  commit: string;
  text: string;
}

export interface GitBlameResponse {
  path: string;
  start: number;
  /** lines in the file */
  total: number;
  /** false: the file is not in any commit yet */
  tracked: boolean;
  lines: GitBlameLine[];
  commits: Record<string, GitBlameCommit>;
}

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { signal, cache: "no-store", credentials: "same-origin" });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, "Cannot reach the viewer server. Is `uv run viewer` running?", null);
  }
  if (!res.ok) {
    let body: unknown = null;
    let message = `${res.status} ${res.statusText}`;
    try {
      body = await res.json();
      const detail = (body as { detail?: unknown })?.detail;
      if (typeof detail === "string") message = `${res.status}: ${detail}`;
    } catch {
      /* not JSON */
    }
    if (res.status === 403) message = `Access refused (403)${message.includes(":") ? message.slice(message.indexOf(":")) : ""}`;
    if (res.status === 404) message = "File not found (404). It may have been deleted or moved.";
    throw new ApiError(res.status, message, body);
  }
  return (await res.json()) as T;
}

export const rawUrl = (path: string) => `/api/raw${qs({ path })}`;

/**
 * The first `maxBytes` of a file as UTF-8 text (invalid bytes replaced, like /api/text), cut at
 * the last line break when there was more. For find in a large file whose text is not all loaded.
 */
export async function rawText(path: string, maxBytes: number, signal?: AbortSignal): Promise<{ text: string; truncated: boolean }> {
  let res: Response;
  try {
    res = await fetch(rawUrl(path), { signal, cache: "no-store", credentials: "same-origin" });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, "Cannot reach the viewer server.", null);
  }
  if (!res.ok || !res.body) throw new ApiError(res.status, `Could not read the file (${res.status})`, null);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const parts: string[] = [];
  let got = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const take = Math.min(value.length, maxBytes - got);
    parts.push(dec.decode(value.subarray(0, take), { stream: true }));
    got += take;
    if (take < value.length || got >= maxBytes) {
      truncated = take < value.length || !(await reader.read()).done;
      void reader.cancel().catch(() => undefined);
      break;
    }
  }
  let text = parts.join("") + dec.decode();
  if (truncated) {
    const nl = text.lastIndexOf("\n");
    text = nl >= 0 ? text.slice(0, nl + 1) : "";
  }
  return { text, truncated };
}

export interface PdfOptions {
  paper: "a4" | "letter";
  orientation: "auto" | "portrait" | "landscape";
  toc: boolean;
}

export const pdfUrl = (path: string, o: PdfOptions) =>
  `/api/pdf${qs({ path, paper: o.paper, orientation: o.orientation, toc: o.toc ? 1 : 0 })}`;

/** Paths last listed as protected (deny-list): opening one asks for its metadata with reveal
 * straight away, instead of after a refused request. */
const protectedPaths = new Set<string>();
const noteHidden = (entries: HiddenEntry[] | undefined) => {
  for (const e of entries ?? []) {
    if (!e.dir && e.reason === "deny") protectedPaths.add(e.path);
    else protectedPaths.delete(e.path);
  }
};
export const isKnownProtected = (path: string) => protectedPaths.has(path);
export const noteProtected = (path: string) => void protectedPaths.add(path);

export const api = {
  config: (signal?: AbortSignal) => getJson<AppConfig>("/api/config", signal),
  tree: (signal?: AbortSignal, opts?: { hidden?: boolean }) =>
    getJson<TreeResponse>(`/api/tree${qs({ hidden: opts?.hidden ? 1 : undefined })}`, signal).then((t) => {
      noteHidden(t.hidden);
      return t;
    }),
  /** the direct children of one hidden folder */
  hidden: (path: string, signal?: AbortSignal) =>
    getJson<HiddenListResponse>(`/api/hidden${qs({ path })}`, signal).then((r) => {
      noteHidden(r.entries);
      return r;
    }),
  /** reveal: metadata of a protected (deny-list) file, which is refused (403) without it */
  file: (path: string, signal?: AbortSignal, opts?: { reveal?: boolean }) =>
    getJson<FileInfo>(`/api/file${qs({ path, reveal: opts?.reveal ? 1 : undefined })}`, signal),
  content: (path: string, signal?: AbortSignal) =>
    getJson<ContentResponse>(`/api/content${qs({ path })}`, signal),
  textInitial: (path: string, signal?: AbortSignal) =>
    getJson<TextResponse>(`/api/text${qs({ path })}`, signal),
  textRange: (path: string, start: number, length: number, signal?: AbortSignal) =>
    getJson<TextResponse>(`/api/text${qs({ path, start, length })}`, signal),
  textLine: (path: string, line: number, signal?: AbortSignal) =>
    getJson<TextResponse>(`/api/text${qs({ path, line })}`, signal),
  /** a protected file's text, only after the user confirmed (read-only view) */
  revealedText: (path: string, signal?: AbortSignal) =>
    getJson<TextResponse>(`/api/text${qs({ path, reveal: 1 })}`, signal),
  revealedTextRange: (path: string, start: number, length: number, signal?: AbortSignal) =>
    getJson<TextResponse>(`/api/text${qs({ path, start, length, reveal: 1 })}`, signal),
  csv: (path: string, signal?: AbortSignal) => getJson<CsvResponse>(`/api/csv${qs({ path })}`, signal),
  xlsx: (path: string, signal?: AbortSignal) => getJson<XlsxResponse>(`/api/xlsx${qs({ path })}`, signal),
  docx: (path: string, signal?: AbortSignal) => getJson<DocxResponse>(`/api/docx${qs({ path })}`, signal),
  docxMarkdown: (path: string, signal?: AbortSignal) =>
    getJson<DocxResponse>(`/api/docx${qs({ path, format: "markdown" })}`, signal),
  /** The text "changed since viewed" and git compare: a .docx is tracked as its markdown. */
  trackedText: (path: string, kind: string, signal?: AbortSignal): Promise<string> =>
    kind === "docx"
      ? getJson<DocxResponse>(`/api/docx${qs({ path, format: "markdown" })}`, signal).then((r) => r.markdown)
      : getJson<ContentResponse>(`/api/content${qs({ path })}`, signal).then((r) => r.text),
  gitStatus: (signal?: AbortSignal) => getJson<GitStatusResponse>("/api/git/status", signal),
  gitFile: (path: string, signal?: AbortSignal) => getJson<GitFileResponse>(`/api/git/file${qs({ path })}`, signal),
  gitBlame: (path: string, start: number, count: number, signal?: AbortSignal) =>
    getJson<GitBlameResponse>(`/api/git/blame${qs({ path, start, count })}`, signal),
  search: (
    params: { q: string; folder?: string; types?: string[]; limit?: number },
    signal?: AbortSignal,
  ) =>
    getJson<SearchResponse>(
      `/api/search${qs({
        q: params.q,
        folder: params.folder || undefined,
        types: params.types && params.types.length ? params.types.join(",") : undefined,
        limit: params.limit,
      })}`,
      signal,
    ),
  /** names from the search index starting with `prefix`; `path` (the open file) only ranks them */
  complete: (params: { prefix: string; path?: string; limit?: number }, signal?: AbortSignal) =>
    getJson<ProjectNames>(`/api/complete${qs({ prefix: params.prefix, path: params.path || undefined, limit: params.limit })}`, signal),
};

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
