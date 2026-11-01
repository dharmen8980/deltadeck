type IdleGlobal = {
  requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};

/** Runs `fn` on the next idle period (at most `timeout` ms away), or after `fallbackMs` where
 * there is no requestIdleCallback; returns a cancel function. */
function onIdle(fn: () => void, timeout: number, fallbackMs: number): () => void {
  const g = globalThis as IdleGlobal;
  if (g.requestIdleCallback) {
    const id = g.requestIdleCallback(fn, { timeout });
    return () => g.cancelIdleCallback?.(id);
  }
  const id = setTimeout(fn, fallbackMs);
  return () => clearTimeout(id);
}

/** Runs `fn` once the page is idle (after the code is on screen); returns a cancel function. */
export function afterPaint(fn: () => void): () => void {
  return onIdle(fn, 300, 16);
}

/** Resolves on the next idle period (at most `timeout` ms away), or after `fallbackMs` where
 * there is no requestIdleCallback. */
export function idle({ timeout, fallbackMs = 0 }: { timeout: number; fallbackMs?: number }): Promise<void> {
  return new Promise((resolve) => onIdle(() => resolve(), timeout, fallbackMs));
}
