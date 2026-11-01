"use client";

// The find bar (find in the open file): loaded on first use by find-controller.tsx. The query
// and options outlive closing the bar and switching files; the engine is use-find.ts.

import { useEffect, useId, useRef, useState } from "react";
import { CaseSensitiveIcon, ChevronDownIcon, ChevronUpIcon, RegexIcon, RepeatIcon, WholeWordIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";
import { counterLabel, DEFAULT_FIND_OPTIONS, type FindOptions } from "@/lib/find/core";
import { cn } from "@/lib/utils";
import type { FindCommand } from "./find-controller";
import { useFind } from "./use-find";

const WRAP_CUE_MS = 1200;
/** The screen-reader counter waits for typing to pause this long (a step announces at once). */
const ANNOUNCE_MS = 500;

export function FindBar({
  open,
  command,
  fileKey,
  onClose,
  onReady,
}: {
  open: boolean;
  /** the latest shortcut / menu command (a new `n` each time) */
  command: FindCommand | null;
  /** the open file: another one keeps the query and searches again */
  fileKey: string;
  onClose: () => void;
  /** the bar is loaded and mounted */
  onReady?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<FindOptions>(DEFAULT_FIND_OPTIONS);
  const [wrapped, setWrapped] = useState<{ dir: 1 | -1; n: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const msgId = useId();
  const { state, go } = useFind(open, query, options, fileKey, (dir) => setWrapped((w) => ({ dir, n: (w?.n ?? 0) + 1 })));
  const [announced, setAnnounced] = useState("");
  const stepped = useRef(false);

  const step = (dir: 1 | -1) => {
    stepped.current = true;
    go(dir);
  };
  const stepRef = useRef(step);
  useEffect(() => {
    stepRef.current = step;
  });

  // A command: open (take the selection as the query, focus, select), next or previous.
  const [seeded, setSeeded] = useState(0);
  if (command && open && command.n !== seeded) {
    setSeeded(command.n);
    if (command.action === "open" && command.seed) setQuery(command.seed);
  }
  const readyRef = useRef(onReady);
  useEffect(() => readyRef.current?.(), []);
  const handled = useRef(0);
  useEffect(() => {
    if (!command || !open || command.n === handled.current) return;
    handled.current = command.n;
    if (command.action === "open") {
      const input = inputRef.current;
      input?.focus();
      // after the seeded value is in: selected, or the caret after what was typed meanwhile
      const typed = command.typed;
      requestAnimationFrame(() => (typed ? input?.setSelectionRange(input.value.length, input.value.length) : input?.select()));
    } else stepRef.current(command.action === "next" ? 1 : -1);
  }, [command, open]);

  useEffect(() => {
    if (!wrapped) return;
    const t = setTimeout(() => setWrapped(null), WRAP_CUE_MS);
    return () => clearTimeout(t);
  }, [wrapped]);

  const { source, status, index, busy } = state;
  const none = source?.kind === "none" ? source.message : null;
  const error = status?.error;
  const counter = !query || none ? "" : error ? "" : !status ? (busy ? "…" : "") : counterLabel(index, status.total, status.capped || status.timedOut);
  const message = none ?? error ?? status?.note ?? (status?.timedOut && !error ? "Stopped early: the search took too long" : undefined);

  // What a screen reader hears: the counter (or the error) once typing pauses, a step at once,
  // so typing a query does not queue stale counts.
  const spoken = busy ? null : [wrapped ? (wrapped.dir > 0 ? "Wrapped to the top." : "Wrapped to the bottom.") : "", counter === "…" ? "" : counter, error ?? ""].filter(Boolean).join(" ");
  useEffect(() => {
    if (spoken === null) return;
    if (stepped.current) {
      stepped.current = false;
      setAnnounced(spoken);
      return;
    }
    const t = setTimeout(() => setAnnounced(spoken), ANNOUNCE_MS);
    return () => clearTimeout(t);
  }, [spoken]);

  if (!open) return null;
  const toggle = (k: keyof FindOptions) => setOptions((o) => ({ ...o, [k]: !o[k] }));
  const canStep = !none && !error && (status?.total ?? 0) > 0;

  const onKeyDown = (e: React.KeyboardEvent) => {
    // composing (an IME): Esc cancels the composition, Enter commits it (229: Safari)
    const composing = e.nativeEvent.isComposing || e.keyCode === 229;
    if (e.key === "Escape" && !composing) {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === "Enter" && e.target === inputRef.current && !composing) {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
      return;
    }
    // Alt+C / Alt+W / Alt+R: the options (by key position: Option+C types "ç" on a Mac)
    if (e.altKey && !e.metaKey && !e.ctrlKey) {
      const k = e.code === "KeyC" ? "caseSensitive" : e.code === "KeyW" ? "wholeWord" : e.code === "KeyR" ? "regex" : null;
      if (k) {
        e.preventDefault();
        toggle(k);
      }
    }
  };

  return (
    <div
      role="search"
      aria-label="Find in file"
      data-find-bar
      onKeyDown={onKeyDown}
      className="no-print fixed top-[calc(var(--header-h,3.5rem)+2.75rem)] right-3 z-40 w-[min(32rem,calc(100vw-1.5rem))] rounded-lg border bg-popover p-1.5 text-popover-foreground shadow-md"
    >
      <div className="flex flex-wrap items-center gap-1">
        <Input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          // nothing to search: still focusable, so Esc closes the bar
          readOnly={none !== null}
          aria-disabled={none !== null || undefined}
          placeholder="Find in file"
          aria-label="Find in file"
          aria-invalid={error ? true : undefined}
          aria-describedby={message ? msgId : undefined}
          spellCheck={false}
          autoComplete="off"
          className={cn("h-7 min-w-32 flex-1 basis-32 font-mono text-[13px] md:text-[13px]", none !== null && "text-muted-foreground")}
        />
        <span aria-hidden className="flex shrink-0 items-center gap-1 px-1 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
          {wrapped ? <RepeatIcon className="size-3 motion-safe:animate-pulse" /> : null}
          <span className={cn(status?.total === 0 && query && "text-destructive")}>{counter}</span>
        </span>
        <span role="status" aria-live="polite" aria-atomic className="sr-only">
          {announced}
        </span>
        {/* narrow screens: the options get a row of their own, the query keeps its room */}
        <div className="order-last flex basis-full items-center gap-1 sm:order-none sm:basis-auto">
          <Toggle size="sm" className="px-1.5" pressed={options.caseSensitive} disabled={none !== null} onPressedChange={() => toggle("caseSensitive")} aria-label="Match case" title="Match case (Alt+C)">
            <CaseSensitiveIcon />
          </Toggle>
          <Toggle size="sm" className="px-1.5" pressed={options.wholeWord} disabled={none !== null} onPressedChange={() => toggle("wholeWord")} aria-label="Whole word" title="Whole word (Alt+W)">
            <WholeWordIcon />
          </Toggle>
          <Toggle size="sm" className="px-1.5" pressed={options.regex} disabled={none !== null} onPressedChange={() => toggle("regex")} aria-label="Regular expression" title="Regular expression (Alt+R)">
            <RegexIcon />
          </Toggle>
        </div>
        <span className="mx-0.5 hidden h-4 w-px shrink-0 bg-border sm:block" aria-hidden />
        <Button size="icon-sm" variant="ghost" disabled={!canStep} onClick={() => step(-1)} aria-label="Previous match" title="Previous match (Shift+Enter)">
          <ChevronUpIcon />
        </Button>
        <Button size="icon-sm" variant="ghost" disabled={!canStep} onClick={() => step(1)} aria-label="Next match" title="Next match (Enter)">
          <ChevronDownIcon />
        </Button>
        <Button size="icon-sm" variant="ghost" onClick={onClose} aria-label="Close find bar" title="Close (Esc)">
          <XIcon />
        </Button>
      </div>
      {message ? (
        <p id={msgId} className={cn("truncate px-1 pt-1 text-xs", error ? "text-destructive" : "text-muted-foreground")} title={message}>
          {message}
        </p>
      ) : null}
    </div>
  );
}
