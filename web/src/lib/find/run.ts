// Running one search: on this thread for short plain queries, in the find worker for regular
// expressions and large texts, with a hard timeout that terminates the worker: the guard against
// catastrophic patterns such as `(a+)+$`, which no budget checked between matches can stop.

import {
  compileFind,
  FIND_BUDGET_MS,
  FIND_MAX_MATCHES,
  findInText,
  type FindOptions,
  type FindResult,
} from "./core.ts";
import type { FindWorkerRequest, FindWorkerResponse } from "./worker.ts";

export interface FindOutcome extends FindResult {
  /** invalid pattern, or a pattern that took too long */
  error?: string;
}

/** Plain queries on texts up to this size run on this thread (no copy to the worker). */
const MAIN_THREAD_MAX = 1024 * 1024;
/** A search still running after this long stops the worker and is reported as too slow. */
const FIND_HARD_TIMEOUT_MS = 2000;
const WORKER_IDLE_MS = 30_000;

export const TOO_SLOW = "This pattern takes too long; try a simpler one";

const empty = (error?: string): FindOutcome => ({ starts: [], ends: [], capped: false, timedOut: false, error });

interface Pending {
  req: FindWorkerRequest;
  text: string;
  timer: ReturnType<typeof setTimeout> | null;
  done: (r: FindWorkerResponse | null) => void;
}

let worker: Worker | null = null;
/** the text the worker holds */
let workerKey: string | null = null;
let workerUsable = typeof Worker !== "undefined";
let nextId = 1;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const pending = new Map<number, Pending>();

function finish(id: number, r: FindWorkerResponse | null) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (p.timer) clearTimeout(p.timer);
  p.done(r);
}

function stopWorker() {
  worker?.terminate();
  worker = null;
  workerKey = null;
}

function getWorker(): Worker | null {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (worker || !workerUsable) return worker;
  try {
    const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "find" });
    w.onmessage = (e: MessageEvent<FindWorkerResponse>) => {
      finish(e.data.id, e.data);
      if (!pending.size) idleTimer = setTimeout(stopWorker, WORKER_IDLE_MS);
    };
    w.onerror = (e) => {
      // could not start (or crashed): from now on, search on this thread
      e.preventDefault();
      workerUsable = false;
      stopWorker();
      for (const id of [...pending.keys()]) finish(id, null);
    };
    worker = w;
    return w;
  } catch {
    workerUsable = false;
    return null;
  }
}

/** Send a job; its timeout runs from here (a job queued behind a slow one is re-sent, see below). */
function post(w: Worker, p: Pending) {
  const req = { ...p.req };
  if (workerKey !== req.key) {
    req.text = p.text;
    workerKey = req.key;
  } else delete req.text;
  if (p.timer) clearTimeout(p.timer);
  p.timer = setTimeout(() => {
    // the oldest job is the one running: it is the slow one
    const first = pending.keys().next().value;
    if (first !== undefined) restartWithout(first);
  }, FIND_HARD_TIMEOUT_MS);
  w.postMessage(req);
}

/** `slow` took too long: stop the worker and give the jobs queued behind it a new one. */
function restartWithout(slow: number) {
  finish(slow, null);
  stopWorker();
  if (!pending.size) return;
  const w = getWorker();
  for (const p of pending.values()) {
    if (w) post(w, p);
  }
  if (!w) for (const id of [...pending.keys()]) finish(id, null);
}

function here(text: string, query: string, options: FindOptions, max: number): FindOutcome {
  const c = compileFind(query, options);
  if (!c) return empty();
  if (!c.ok) return empty(c.error);
  return findInText(text, c.re, { max, budgetMs: FIND_BUDGET_MS });
}

/**
 * The matches of `query` in `text`. `key` names the text (same key, same text), so the worker
 * keeps it between queries. Never rejects: an invalid or too slow pattern gives `error`.
 */
export async function runFind(
  key: string,
  text: string,
  query: string,
  options: FindOptions,
  max = FIND_MAX_MATCHES,
): Promise<FindOutcome> {
  const c = compileFind(query, options);
  if (!c) return empty();
  if (!c.ok) return empty(c.error);
  if (!options.regex && text.length <= MAIN_THREAD_MAX) return findInText(text, c.re, { max, budgetMs: FIND_BUDGET_MS });
  const w = getWorker();
  if (!w) return here(text, query, options, max);
  const id = nextId++;
  const res = await new Promise<FindWorkerResponse | null>((resolve) => {
    const p: Pending = { req: { id, key, query, options, max, budgetMs: FIND_BUDGET_MS }, text, timer: null, done: resolve };
    pending.set(id, p);
    post(w, p);
  });
  if (!res) return workerUsable ? { ...empty(TOO_SLOW), timedOut: true } : here(text, query, options, max);
  if ("error" in res) {
    if (res.error === "no text") {
      workerKey = null;
      return runFind(key, text, query, options, max);
    }
    return empty(res.error);
  }
  return res.result;
}
