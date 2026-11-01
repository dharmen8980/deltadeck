// The outline on the main thread, for when there is no worker (tests, or the
// worker failed to start): after an idle period, with the parse in short
// slices between idle callbacks. Loaded lazily by index.ts.

import { Budget, OutlineTimeout, parseCooperative, type OutlineSymbol } from "./common.ts";
import { loadOutliner, type OutlineTarget } from "./run.ts";

/** The most one uninterrupted step (a scanner, the SCSS / LESS preprocessing, an extraction) may take. */
const MAIN_THREAD_STEP_MS = 100;

const abortError = () => new DOMException("Aborted", "AbortError");

/** On this thread: after an idle period, the parse in short slices between idle callbacks. */
export async function computeOnMainThread(
  target: OutlineTarget,
  text: string,
  opts: { signal?: AbortSignal; budgetMs: number; yieldFn: () => Promise<void> },
): Promise<OutlineSymbol[] | null> {
  const { signal, budgetMs, yieldFn } = opts;
  const abortIf = () => {
    if (signal?.aborted) throw abortError();
  };
  await yieldFn();
  abortIf();
  const loaded = await loadOutliner(target.lang);
  abortIf();
  await yieldFn();
  abortIf();
  // Without slices, the sync steps (C# / shell scanners, SCSS / LESS
  // preprocessing, extraction) are each one task: each gets a small budget,
  // and a file that needs more gets no outline rather than a frozen page.
  const step = () => new Budget(Date.now() + Math.min(budgetMs, MAIN_THREAD_STEP_MS));
  try {
    if (loaded.kind === "sync") return loaded.run(text, step());
    const { mod } = loaded;
    const start = Date.now();
    const input = mod.prepare ? mod.prepare(text, target.variant, step()) : text;
    const prepMs = Date.now() - start;
    const { tree } = await parseCooperative(mod.parserFor(target.variant), input, budgetMs - prepMs, yieldFn, signal);
    abortIf();
    await yieldFn();
    abortIf();
    return mod.extract(tree, text, step(), target.variant);
  } catch (e) {
    if (e instanceof OutlineTimeout) return null;
    throw e;
  }
}

