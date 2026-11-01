// The outline worker: computes outlines off the main thread, so neither the
// parse nor the extraction of a large file can block scrolling. Loads each
// language's outliner on first use, like the main-thread fallback.

import { Budget, OutlineTimeout } from "./common.ts";
import { loadOutliner, runOutliner, type OutlineRequest, type OutlineResponse } from "./run.ts";

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<OutlineRequest>) => void) | null;
  postMessage(msg: OutlineResponse): void;
};

scope.onmessage = async (e) => {
  const { id, target, text, budgetMs } = e.data;
  try {
    const loaded = await loadOutliner(target.lang);
    let symbols = null;
    try {
      symbols = runOutliner(loaded, target.variant, text, new Budget(Date.now() + budgetMs));
    } catch (err) {
      if (!(err instanceof OutlineTimeout)) throw err;
    }
    scope.postMessage({ id, symbols });
  } catch (err) {
    scope.postMessage({ id, error: String(err) });
  }
};
