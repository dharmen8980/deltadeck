// Code outline: which files get one, and where it is computed. The
// per-language extractors (and their Lezer parsers) are only fetched by
// dynamic import() when a file of that language is opened; this module itself
// stays tiny because the code viewer imports it.
//
// In the browser the outline is computed in a module Worker (worker.ts), so a
// large file never blocks the page. Without workers (tests, or if the worker
// fails to start) it runs here, after an idle period, with the parse in short
// slices.

import { idle } from "../after-paint.ts";
import { languageFor } from "../languages.ts";
import type { OutlineSymbol } from "./common.ts";
import type { OutlineRequest, OutlineResponse, OutlineTarget } from "./run.ts";

export type { OutlineSymbol, SymbolKind } from "./common.ts";
export type { OutlineLang, OutlineTarget } from "./run.ts";

/** Files larger than this get no outline. */
export const OUTLINE_MAX_BYTES = 2 * 1024 * 1024;
/** CPU time budget of one outline (prepare + parse + extraction), in ms. */
const OUTLINE_BUDGET_MS = 1500;

export function outlineTargetFor(ext: string): OutlineTarget | null {
  return languageFor(ext)?.outline ?? null;
}

/** Resolve on the next idle period (or soon, where there is no requestIdleCallback). */
const idleSlice = () => idle({ timeout: 500 });

const abortError = () => new DOMException("Aborted", "AbortError");

/** The main-thread fallback: its own chunk, only loaded when there is no worker. */
async function computeHere(
  target: OutlineTarget,
  text: string,
  opts: { signal?: AbortSignal; budgetMs?: number; yieldFn?: () => Promise<void> },
): Promise<OutlineSymbol[] | null> {
  const { computeOnMainThread } = await import("./main-thread.ts");
  return computeOnMainThread(target, text, { budgetMs: OUTLINE_BUDGET_MS, yieldFn: idleSlice, ...opts });
}

// ---- the worker: one, started on first use; jobs keep their order ----

interface Job {
  req: OutlineRequest;
  resolve: (v: OutlineSymbol[] | null) => void;
  reject: (e: unknown) => void;
}

let worker: Worker | null = null;
/** false once the worker failed to start: from then on, outlines are computed on the main thread */
let workerUsable = typeof Worker !== "undefined";
let nextId = 1;
const jobs = new Map<number, Job>();
/** An idle worker is stopped after this long, so it holds no memory while no code file is being opened. */
const WORKER_IDLE_MS = 30_000;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleIdleStop() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (jobs.size || !worker) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (jobs.size) return;
    worker?.terminate();
    worker = null;
  }, WORKER_IDLE_MS);
}

function startWorker(): Worker | null {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (worker) return worker;
  if (!workerUsable) return null;
  try {
    const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "outline" });
    w.onmessage = (e: MessageEvent<OutlineResponse>) => {
      const job = jobs.get(e.data.id);
      if (!job) return;
      jobs.delete(e.data.id);
      scheduleIdleStop();
      if ("error" in e.data) job.reject(new Error(e.data.error));
      else job.resolve(e.data.symbols);
    };
    w.onerror = (e) => {
      // could not load (or crashed): finish the open jobs here instead
      e.preventDefault();
      workerUsable = false;
      w.terminate();
      if (worker === w) worker = null;
      runOpenJobsHere();
    };
    worker = w;
    return w;
  } catch {
    workerUsable = false;
    return null;
  }
}

/** Stop the worker (an aborted job may still be running in it) and hand the other jobs to a new one. */
function restartWorker() {
  worker?.terminate();
  worker = null;
  const w = startWorker();
  if (w) for (const job of jobs.values()) w.postMessage(job.req);
  else runOpenJobsHere();
}

/** Without a worker: finish the open jobs on this thread. */
function runOpenJobsHere() {
  const open = [...jobs.values()];
  jobs.clear();
  for (const job of open)
    computeHere(job.req.target, job.req.text, { budgetMs: job.req.budgetMs }).then(job.resolve, job.reject);
}

function computeInWorker(
  w: Worker,
  target: OutlineTarget,
  text: string,
  budgetMs: number,
  signal?: AbortSignal,
): Promise<OutlineSymbol[] | null> {
  return new Promise((resolve, reject) => {
    const req: OutlineRequest = { id: nextId++, target, text, budgetMs };
    const done = () => signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (!jobs.delete(req.id)) return;
      reject(abortError());
      if (jobs.size) restartWorker();
      else {
        // nothing else waiting: just stop it (the aborted job may still be running); the next job starts a new one
        worker?.terminate();
        worker = null;
      }
    };
    jobs.set(req.id, {
      req,
      resolve: (v) => {
        done();
        resolve(v);
      },
      reject: (e) => {
        done();
        reject(e);
      },
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    w.postMessage(req);
  });
}

/**
 * The outline of `text`, computed off the critical path: in the outline
 * worker when there is one, else on this thread in idle time. Resolves to null
 * when the file is too large or the time budget runs out; rejects with an
 * AbortError when `signal` aborts.
 */
export async function computeOutline(
  target: OutlineTarget,
  text: string,
  opts: { signal?: AbortSignal; budgetMs?: number; yieldFn?: () => Promise<void> } = {},
): Promise<OutlineSymbol[] | null> {
  if (text.length > OUTLINE_MAX_BYTES) return null;
  if (opts.signal?.aborted) throw abortError();
  const w = startWorker();
  if (w) return computeInWorker(w, target, text, opts.budgetMs ?? OUTLINE_BUDGET_MS, opts.signal);
  return computeHere(target, text, opts);
}

// ---- cache: by path + mtime + size, a few recent files ----

const CACHE_MAX = 24;
const cache = new Map<string, OutlineSymbol[]>();

/** FNV-1a over the UTF-16 code units: catches a change that kept mtime and size. */
function textHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

export function outlineCacheKey(path: string, mtime: number | null | undefined, size: number, text: string): string {
  return `${path}\u0000${mtime ?? ""}\u0000${size}\u0000${text.length}:${textHash(text)}`;
}

export function cachedOutline(key: string): OutlineSymbol[] | undefined {
  const v = cache.get(key);
  if (v) {
    cache.delete(key);
    cache.set(key, v);
  }
  return v;
}

export function cacheOutline(key: string, symbols: OutlineSymbol[]): void {
  cache.delete(key);
  cache.set(key, symbols);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
}

// ---- flat view for the panel: preorder, with depth and parent ----

export interface FlatSymbol {
  id: string;
  name: string;
  kind: OutlineSymbol["kind"];
  line: number;
  endLine?: number;
  depth: number;
  parent: number;
  hasChildren: boolean;
}

export function flattenOutline(symbols: OutlineSymbol[]): FlatSymbol[] {
  const out: FlatSymbol[] = [];
  const walk = (list: OutlineSymbol[], depth: number, parent: number) => {
    for (const s of list) {
      const idx = out.length;
      out.push({
        id: `o${idx}`,
        name: s.name,
        kind: s.kind,
        line: s.line,
        endLine: s.endLine,
        depth,
        parent,
        hasChildren: s.children.length > 0,
      });
      walk(s.children, depth + 1, idx);
    }
  };
  walk(symbols, 0, -1);
  return out;
}

/** Entries sorted by line (stable: preorder for ties), for activeSymbol(). */
export function byLine(flat: FlatSymbol[]): number[] {
  return flat.map((_, i) => i).sort((a, b) => flat[a].line - flat[b].line || a - b);
}

/**
 * The innermost symbol containing `line`: binary search for the last one
 * starting at or before it, then up the parents while it already ended. In a
 * gap between top-level symbols, the one above.
 */
export function activeSymbol(flat: FlatSymbol[], order: number[], line: number): number {
  let lo = 0;
  let hi = order.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (flat[order[mid]].line <= line) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found === -1) return -1;
  // past the end of everything around it: the outermost of them (the nearest top-level symbol above)
  let idx = order[found];
  while (flat[idx].endLine !== undefined && flat[idx].endLine! < line && flat[idx].parent !== -1) idx = flat[idx].parent;
  return idx;
}
