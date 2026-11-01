// The find worker: runs regex searches (and searches of large texts) off the main thread, so a
// slow pattern cannot freeze the page; run.ts terminates it past a hard timeout. It keeps the
// last text it was sent, so typing a query does not copy a large file again.

import { compileFind, findInText, type FindOptions, type FindResult } from "./core.ts";

export interface FindWorkerRequest {
  id: number;
  key: string;
  /** sent when the worker does not have `key` yet */
  text?: string;
  query: string;
  options: FindOptions;
  max: number;
  budgetMs: number;
}

export type FindWorkerResponse = { id: number; result: FindResult } | { id: number; error: string };

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<FindWorkerRequest>) => void) | null;
  postMessage(msg: FindWorkerResponse): void;
};

let held: { key: string; text: string } | null = null;

scope.onmessage = (e) => {
  const { id, key, text, query, options, max, budgetMs } = e.data;
  if (text !== undefined) held = { key, text };
  if (!held || held.key !== key) {
    scope.postMessage({ id, error: "no text" });
    return;
  }
  const c = compileFind(query, options);
  if (!c || !c.ok) {
    scope.postMessage({ id, error: c ? c.error : "empty query" });
    return;
  }
  scope.postMessage({ id, result: findInText(held.text, c.re, { max, budgetMs }) });
};
