// A folder's hidden-file settings (/api/hiding*, server/deltadeck/hiding.py): the user's patterns,
// the exact paths they showed or hid, and whether git-ignored files are hidden. Kept by the server
// in its data dir (never in the folder), shared by every tab and browser on that server, and
// allowed in read-only mode. Writes go through the roots gate (X-Root-Token, JSON body), like
// /api/seen. Every request names the root it is for; the server answers 409 after a folder switch.

import { useSyncExternalStore } from "react";
import { ApiError, type HiddenCount, type HiddenItems, type HidingState, type HidingUpdate, type HidingUpdateResult } from "@/lib/api";
import { partialMessage } from "@/lib/hidden-items";
import { request } from "@/lib/roots-api";

/** Sent with every update and echoed in the SSE "hiding" event. */
export const hidingClientId =
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `tab-${Math.random().toString(36).slice(2)}`;

/** Paths per POST (the server takes at most limits.max_paths, 500). */
const PATH_BATCH = 200;
/** Paths per /api/hiding/count request (the server takes 1 to 50). */
const COUNT_BATCH = 50;

const rootQs = (root: string) => `root=${encodeURIComponent(root)}`;

export function getHiding(root: string, signal?: AbortSignal): Promise<HidingState> {
  return request<HidingState>("GET", `/api/hiding?${rootQs(root)}`, undefined, signal);
}

/** Updates are sent one at a time, in order: quick clicks (hide, then show again) reach the server
 * as made, so the last click wins. A batched change holds its place in the queue for all its
 * requests, so another click's request never lands between them. */
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const p = queue.then(fn);
  queue = p.catch(() => undefined);
  return p;
}

/** From sending an update of ours until this long after its answer, "change" events (they carry no
 * client id, and can arrive before the answer) are most likely its echo: the Hidden files dialog
 * keeps its file counts (unaffected by showing or hiding other items) rather than ask them all again. */
const OWN_ECHO_MS = 3000;
let ownUntil = 0;

export function ownUpdateRecent(): boolean {
  return Date.now() < ownUntil;
}

async function send(root: string, body: HidingUpdate): Promise<HidingUpdateResult> {
  ownUntil = Number.POSITIVE_INFINITY; // in flight
  try {
    const res = await request<HidingUpdateResult>("POST", "/api/hiding/update", { ...body, root, client: hidingClientId });
    const { applied: _applied, ...state } = res;
    setHidingState(state);
    return res;
  } finally {
    ownUntil = Date.now() + OWN_ECHO_MS;
  }
}

/** Applies the update and stores the returned state. Throws ApiError (400: the message names the problem). */
export function updateHiding(root: string, body: HidingUpdate): Promise<HidingUpdateResult> {
  return enqueue(() => send(root, body));
}

/** Several updates' applied lists as one (pending if any was). */
export function mergeApplied(list: HidingUpdateResult["applied"][]): HidingUpdateResult["applied"] {
  const hidden = list.flatMap((a) => a.hidden);
  const shown = list.flatMap((a) => a.shown);
  const truncated = list.some((a) => a.truncated);
  const pending = list.some((a) => a.pending);
  return { hidden, shown, ...(truncated ? { truncated } : {}), ...(pending ? { pending } : {}) };
}

/** show or hide many paths, PATH_BATCH per request, in order and in one queue slot; the last state
 * plus every batch's applied. A failed batch stops the rest; its error says how many were changed. */
function batched(root: string, key: "show" | "hide", paths: string[]): Promise<HidingUpdateResult> {
  return enqueue(async () => {
    let last: HidingUpdateResult | null = null;
    const applied: HidingUpdateResult["applied"][] = [];
    for (let i = 0; i === 0 || i < paths.length; i += PATH_BATCH) {
      try {
        last = await send(root, { [key]: paths.slice(i, i + PATH_BATCH) });
      } catch (e) {
        if (i && e instanceof ApiError) throw new ApiError(e.status, partialMessage(i, paths.length, e.message), e.body);
        throw e;
      }
      applied.push(last.applied);
    }
    return { ...last!, applied: mergeApplied(applied) };
  });
}

/** Hides `paths`; the sidebar drops them at once (optimistic), before the server's change event. */
export function hidePaths(root: string, paths: string[]): Promise<HidingUpdateResult> {
  const token = optimisticHide(paths);
  return settleOptimistic(token, batched(root, "hide", paths));
}

export function showPaths(root: string, paths: string[]): Promise<HidingUpdateResult> {
  unhideOptimistic(paths);
  return batched(root, "show", paths);
}

/** Turns hiding git-ignored files on or off. `visible`: the git-ignored items the sidebar lists
 * now that hiding them drops (not ones the user showed: a show choice can outlive it); they leave
 * the sidebar at once, each until the tree no longer lists it. */
export function setHideGit(root: string, on: boolean, visible: string[] = []): Promise<HidingUpdateResult> {
  if (!on) {
    unhideOptimistic(visible);
    return updateHiding(root, { hide_git: on });
  }
  return settleOptimistic(optimisticHide(visible), updateHiding(root, { hide_git: on }));
}
export const addRule = (root: string, pattern: string) => updateHiding(root, { add_rules: [pattern] });
export const removeRule = (root: string, pattern: string) => updateHiding(root, { remove_rules: [pattern] });

/** The Hidden files dialog's rows. The server asks git first (throttled). */
export function getItems(root: string, signal?: AbortSignal): Promise<HiddenItems> {
  return request<HiddenItems>("GET", `/api/hiding/items?${rootQs(root)}`, undefined, signal);
}

/** Bounded file counts below hidden items, COUNT_BATCH paths per request. Missing or refused paths are left out. */
export async function getCounts(root: string, paths: string[], signal?: AbortSignal): Promise<Record<string, HiddenCount>> {
  const out: Record<string, HiddenCount> = {};
  for (let i = 0; i < paths.length; i += COUNT_BATCH) {
    const qs = paths.slice(i, i + COUNT_BATCH).map((p) => `&path=${encodeURIComponent(p)}`).join("");
    const res = await request<{ counts: Record<string, HiddenCount> }>("GET", `/api/hiding/count?${rootQs(root)}${qs}`, undefined, signal);
    Object.assign(out, res.counts);
  }
  return out;
}

/** "3 items hidden, 1 shown" (null when nothing changed). */
export function appliedSummary(applied: HidingUpdateResult["applied"]): string | null {
  const n = (k: number) => `${k.toLocaleString()}${applied.truncated ? "+" : ""} item${k === 1 ? "" : "s"}`;
  const parts: string[] = [];
  if (applied.hidden.length) parts.push(`${n(applied.hidden.length)} hidden`);
  if (applied.shown.length) parts.push(`${n(applied.shown.length)} shown`);
  return parts.length ? parts.join(", ") : null;
}

// The latest state for the open folder: set from responses and from the SSE "hiding" event.
let current: HidingState | null = null;
const listeners = new Set<() => void>();

/** Keeps the newest state: an update's response can arrive after the SSE event of a later update
 * (from another tab), so an older `version` of the same folder is dropped. `force` (a fresh GET)
 * always wins: a restarted server counts versions from 0 again. null resets (folder switch). */
export function setHidingState(state: HidingState | null, force = false) {
  if (state && current && !force && state.root === current.root && state.version < current.version) return;
  current = state;
  for (const l of listeners) l();
}

export function hidingState(): HidingState | null {
  return current;
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useHiding(): HidingState | null {
  return useSyncExternalStore(subscribe, hidingState, () => null);
}

// "Something about the hidden items changed": a "hiding" event (any tab; `client` names it) or a
// "change" with hidden_changed. The open Hidden files dialog listens to refetch its rows.
const hiddenListeners = new Set<(client: string | null) => void>();

export function emitHiddenChanged(client: string | null = null) {
  for (const l of hiddenListeners) l(client);
}

export function onHiddenChanged(l: (client: string | null) => void): () => void {
  hiddenListeners.add(l);
  return () => void hiddenListeners.delete(l);
}

// Hides in flight, left out of the sidebar at once: the server answers quickly but the tree only
// drops the paths with the following "change" event (a moment later for a big folder). An entry
// goes when the tree no longer lists it (pruneOptimistic), when it is shown again, when its update
// fails, or OPTIMISTIC_MAX_MS after the update answered (the server changed nothing, say).
const OPTIMISTIC_MAX_MS = 15_000;

export interface OptimisticHidden {
  paths: ReadonlySet<string>;
}

const NONE: OptimisticHidden = { paths: new Set() };
let optimistic: OptimisticHidden = NONE;
/** per path: the newest hide's token; a stale timer or failure leaves newer hides alone */
const tokens = new Map<string, number>();
let nextToken = 0;
const optListeners = new Set<() => void>();

function setOptimistic(next: OptimisticHidden) {
  optimistic = next.paths.size ? next : NONE;
  for (const l of optListeners) l();
}

function optimisticHide(paths: string[]): { token: number; keys: string[] } {
  const token = ++nextToken;
  for (const k of paths) tokens.set(k, token);
  setOptimistic({ paths: new Set([...optimistic.paths, ...paths]) });
  return { token, keys: paths };
}

/** Drops these optimistic hides (only the ones still owned by `token`, if given). */
function unhideOptimistic(paths: string[], token?: number) {
  const keys = paths.filter((k) => tokens.has(k) && (token === undefined || tokens.get(k) === token));
  if (!keys.length) return;
  for (const k of keys) tokens.delete(k);
  const drop = new Set(keys);
  setOptimistic({ paths: new Set([...optimistic.paths].filter((p) => !drop.has(p))) });
}

function settleOptimistic(t: { token: number; keys: string[] }, p: Promise<HidingUpdateResult>): Promise<HidingUpdateResult> {
  const drop = () => unhideOptimistic(t.keys, t.token);
  return p.then(
    (res) => {
      setTimeout(drop, OPTIMISTIC_MAX_MS);
      return res;
    },
    (e: unknown) => {
      drop();
      throw e;
    },
  );
}

/** A tree arrived: optimistic hides it no longer lists are done (the server applied them). */
export function pruneOptimistic(tree: { files: { path: string }[]; dirs: string[] }) {
  if (optimistic === NONE) return;
  const listed = new Set(tree.dirs);
  for (const f of tree.files) listed.add(f.path);
  const done = [...optimistic.paths].filter((p) => !listed.has(p));
  if (done.length) unhideOptimistic(done);
}

/** Folder switch: nothing in flight applies any more. */
export function clearOptimistic() {
  tokens.clear();
  setOptimistic(NONE);
}

function subscribeOptimistic(l: () => void) {
  optListeners.add(l);
  return () => void optListeners.delete(l);
}

export function useOptimisticHidden(): OptimisticHidden {
  return useSyncExternalStore(subscribeOptimistic, () => optimistic, () => NONE);
}
