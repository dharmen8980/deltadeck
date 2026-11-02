"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, CopyIcon, PlusIcon } from "lucide-react";
import { isTypingTarget } from "@/lib/keys";
import { toast } from "sonner";
import { copyText } from "@/lib/clipboard";
import { buildPrompt, type HunkTarget } from "@/lib/review-basket";
import { cn } from "@/lib/utils";
import { addWithToast, useBasket, type FileReview } from "./basket-context";

/**
 * Marked changes on screen, in all views alike: highlighted markdown / .docx blocks and their
 * removal markers (lib/rehype-change-marks.ts), marked code and text lines, the line a pure
 * removal is anchored on and the removal markers (lib/code-marks-dom.ts, the text viewer).
 */
const TARGET =
  ".markdown-body > [data-change-lines], .markdown-body > [data-removed-before], .code-removed[data-removed-before], .code-lines .line[data-change], .code-lines .line[data-change-hunk], .text-line[data-change], .text-line[data-change-hunk]";
/** The first element of each change (keyboard: the current change is the first one below the header). */
const FIRSTS = ".markdown-body > [data-change-lines], .markdown-body > [data-removed-before], [data-change-hunk]";
/** The sticky header and banner cover the top of the view. */
const TOP = 96;

/** What a marked element says about its change (lib/review-basket.ts hunkFinder). */
function targetOf(el: HTMLElement): HunkTarget | null {
  const before = el.dataset.removedBefore;
  if (before !== undefined) return { removedBefore: before === "end" ? null : Number(before) };
  const lines = el.dataset.changeLines;
  if (lines) {
    const [s, e] = lines.split("-").map(Number);
    return { lines: [s, e] };
  }
  const n = el.dataset.line ?? (el.id.startsWith("L") ? el.id.slice(1) : undefined);
  return n ? { line: Number(n) } : null;
}

/** The visible right edge of a code line (its scroll box), or the element's own. */
function rightEdge(el: HTMLElement): number {
  const box = el.closest<HTMLElement>(".code-lines, .text-lines");
  return Math.min(el.getBoundingClientRect().right, box ? box.getBoundingClientRect().right : Infinity);
}

/** Whether a button at `top` is on screen (below the header). */
const inView = (top: number) => top > TOP - 40 && top < window.innerHeight;

/**
 * The viewer's container with the review basket's affordance: hovering a highlighted change (or
 * moving to it with n / p, or focusing it) shows a small button at its top right that adds it to
 * the basket or takes it out again, and one that copies just that change for AI; `b` and `c` do the
 * same for that change, or else the first one below the header. Changes in the basket get a mark.
 */
export function BasketTargets({
  review,
  hidden,
  children,
}: {
  review: FileReview | null;
  hidden?: boolean;
  children: React.ReactNode;
}) {
  const basket = useBasket();
  const rootRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ el: HTMLElement; hunk: number; top: number; left: number } | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const active = Boolean(basket && review && !hidden);

  const resolve = useCallback(
    (el: HTMLElement): number => {
      if (!review) return -1;
      const t = targetOf(el);
      return t ? review.find(t) : -1;
    },
    [review],
  );
  const place = useCallback(
    (el: HTMLElement, hunk: number) => {
      const r = el.getBoundingClientRect();
      // Removal markers are a line: the button sits on it.
      const top = el.dataset.removedBefore !== undefined ? r.top - 10 : r.top + 2;
      setHover({ el, hunk, top, left: rightEdge(el) - 26 });
    },
    [],
  );
  const cancelHide = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = null;
  };
  const hideSoon = useCallback(() => {
    cancelHide();
    hideTimer.current = setTimeout(() => setHover(null), 250);
  }, []);
  useEffect(() => cancelHide, []);

  /** The button is portaled to the body, but React still bubbles its events through this tree. */
  const fromButton = (e: React.SyntheticEvent) => (e.target as HTMLElement).closest("[data-basket-toggle]") !== null;

  const onOver = (e: React.PointerEvent) => {
    if (!active) return;
    if (fromButton(e)) return cancelHide();
    const el = (e.target as HTMLElement).closest<HTMLElement>(TARGET);
    const hunk = el && rootRef.current?.contains(el) ? resolve(el) : -1;
    if (!el || hunk < 0) return hideSoon();
    cancelHide();
    if (hover?.el !== el) place(el, hunk);
  };

  // Scrolling moves the change: follow it, hide it under the header.
  const hoverEl = hover?.el;
  useEffect(() => {
    if (!hoverEl) return;
    const onScroll = () => {
      if (!hoverEl.isConnected) return setHover(null);
      setHover((h) => (h ? { ...h, top: hoverEl.getBoundingClientRect().top + (hoverEl.dataset.removedBefore !== undefined ? -10 : 2), left: rightEdge(hoverEl) - 26 } : h));
    };
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, [hoverEl]);

  const idOf = useCallback((hunk: number) => (review ? review.item(hunk).id : ""), [review]);
  const toggle = useCallback(
    (hunk: number, viaKey = false) => {
      if (!basket || !review) return;
      const item = review.item(hunk);
      if (basket.ids.has(item.id)) {
        // The basket's copy (with its note), for the undo.
        const held = basket.items.find((i) => i.id === item.id) ?? item;
        basket.remove(item.id);
        if (viaKey)
          toast("Taken out of the review basket", {
            description: item.location,
            action: { label: "Undo", onClick: () => basket.restore([held]) },
          });
        return;
      }
      if (viaKey) addWithToast(basket, [item], item.location);
      else basket.add([item]);
    },
    [basket, review],
  );
  /** Copies one change as its own prompt; the basket is left alone. */
  const copyOne = useCallback(
    async (hunk: number) => {
      if (!basket || !review) return;
      const item = review.item(hunk);
      // The basket's copy carries its note.
      const held = basket.items.find((i) => i.id === item.id) ?? item;
      if (!(await copyText(buildPrompt([held], basket.pathPrefix, true)))) {
        toast.error("Could not copy to clipboard");
        return;
      }
      toast.success("Copied this change for AI", { description: item.location });
    },
    [basket, review],
  );

  /** The current change: the first one below the header that resolves to a hunk (skips unloaded parts of a large text). */
  const current = useCallback((): { el: HTMLElement; hunk: number } | null => {
    const root = rootRef.current;
    if (!root) return null;
    for (const el of root.querySelectorAll<HTMLElement>(FIRSTS)) {
      if (!el.getClientRects().length) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom <= TOP - 2) continue;
      if (r.top >= window.innerHeight) break;
      const hunk = resolve(el);
      if (hunk >= 0) return { el, hunk };
    }
    return null;
  }, [resolve]);

  // b: add (or take out) the change with the button, else the first one below the header; c: copy it.
  // n / p (change-banner.tsx) move to a change: the button follows, for keyboard use.
  useEffect(() => {
    if (!active) return;
    let frame = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      if (e.key === "n" || e.key === "p") {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          const c = current();
          if (c) {
            cancelHide();
            place(c.el, c.hunk);
          }
        });
        return;
      }
      if ((e.key !== "b" && e.key !== "c") || e.repeat) return;
      let hunk = hover && hover.el.isConnected && inView(hover.top) ? hover.hunk : -1;
      if (hunk < 0) {
        const c = current();
        if (c) place(c.el, c.hunk);
        hunk = c ? c.hunk : -1;
      }
      if (hunk < 0) return;
      e.preventDefault();
      if (e.key === "c") void copyOne(hunk);
      else toggle(hunk, true);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      cancelAnimationFrame(frame);
    };
  }, [active, hover, current, place, toggle, copyOne]);

  // Focus inside a change (a link in a highlighted block, say) shows its button too.
  const onFocus = (e: React.FocusEvent) => {
    if (!active || fromButton(e)) return;
    const el = (e.target as HTMLElement).closest<HTMLElement>(TARGET);
    const hunk = el && rootRef.current?.contains(el) ? resolve(el) : -1;
    if (!el || hunk < 0) return;
    cancelHide();
    if (hover?.el !== el) place(el, hunk);
  };

  // Mark the changes in the basket (again after the view re-renders its marks).
  // On the id set, not the basket: typing a note changes the items, not the ids.
  const ids = basket?.ids;
  const inBasket = useMemo(() => {
    const out = new Set<number>();
    if (!ids?.size || !review) return out;
    const prefix = `${review.item(0).path}\u0000`;
    if (![...ids].some((id) => id.startsWith(prefix))) return out;
    review.hunks.forEach((_, i) => {
      if (ids.has(review.item(i).id)) out.add(i);
    });
    return out;
  }, [ids, review]);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const apply = () => {
      root.querySelectorAll<HTMLElement>("[data-in-basket]").forEach((el) => el.removeAttribute("data-in-basket"));
      if (!inBasket.size) return;
      root.querySelectorAll<HTMLElement>(TARGET).forEach((el) => {
        const h = resolve(el);
        if (h >= 0 && inBasket.has(h)) el.setAttribute("data-in-basket", "");
      });
    };
    apply();
    if (!inBasket.size) return;
    let frame = 0;
    const obs = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(apply);
    });
    obs.observe(root, { childList: true, subtree: true });
    return () => {
      obs.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [inBasket, resolve]);

  const shown = active && hover && hover.el.isConnected && inView(hover.top);
  const added = shown ? basket!.ids.has(idOf(hover.hunk)) : false;
  return (
    <div ref={rootRef} hidden={hidden} onPointerOver={onOver} onPointerLeave={hideSoon} onFocus={onFocus}>
      {children}
      {shown
        ? createPortal(
            <div
              className="no-print fixed z-10 flex gap-0.5"
              style={{ top: hover.top, left: hover.left - 22 }}
              onPointerEnter={cancelHide}
              onPointerLeave={hideSoon}
              data-basket-toggle=""
            >
              <button
                type="button"
                className="flex size-5 cursor-pointer items-center justify-center rounded-md border border-sky-500/40 bg-background text-sky-700 shadow-sm transition-colors hover:bg-sky-50 dark:text-sky-300 dark:hover:bg-sky-950"
                onClick={() => void copyOne(hover.hunk)}
                aria-label="Copy this change for AI (c)"
                title="Copy this change for AI (c)"
              >
                <CopyIcon className="size-3" />
              </button>
              <button
                type="button"
                className={cn(
                  "flex size-5 cursor-pointer items-center justify-center rounded-md border shadow-sm transition-colors",
                  added
                    ? "border-sky-600 bg-sky-600 text-white hover:bg-sky-700"
                    : "border-sky-500/40 bg-background text-sky-700 hover:bg-sky-50 dark:text-sky-300 dark:hover:bg-sky-950",
                )}
                onClick={() => toggle(hover.hunk)}
                aria-pressed={added}
                aria-label={added ? "In the review basket: click or press b to take it out" : "Add this change to the review basket (b)"}
                title={added ? "In the review basket (click or b to remove)" : "Add to the review basket (b)"}
              >
                {added ? <CheckIcon className="size-3.5" /> : <PlusIcon className="size-3.5" />}
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
