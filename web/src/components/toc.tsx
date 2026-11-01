"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRightIcon, ListIcon } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ResizeHandle, useTocWidth } from "@/components/resize-handle";
import { TOC_SPEC } from "@/lib/panel-size";
import { cn } from "@/lib/utils";

export interface TocHeading {
  id: string;
  text: string;
  level: number;
  /** short label shown before the text (e.g. the kind of a code symbol) */
  badge?: string;
  badgeTitle?: string;
  /** tooltip; defaults to the text */
  title?: string;
}

const NO_HEADINGS: TocHeading[] = [];
const NO_IDS: ReadonlySet<string> = new Set();
/** Rows rendered at first (a large file can have tens of thousands of symbols); more on request. */
const ROWS_STEP = 500;

function useActiveHeading(headings: TocHeading[]): string | null {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (!headings.length) return;
    const els = headings
      .map((h) => document.getElementById(h.id))
      .filter((e): e is HTMLElement => Boolean(e));
    const visible = new Map<string, number>();
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.set(e.target.id, e.boundingClientRect.top);
          else visible.delete(e.target.id);
        }
        if (visible.size) {
          const top = [...visible.entries()].sort((a, b) => a[1] - b[1])[0][0];
          setActive(top);
        }
      },
      { rootMargin: "-64px 0px -60% 0px" },
    );
    els.forEach((e) => obs.observe(e));
    return () => obs.disconnect();
  }, [headings]);
  return active;
}

/** Index of each heading's parent (the nearest earlier heading with a lower level), or -1. */
function parentsOf(headings: TocHeading[]): number[] {
  const parents: number[] = [];
  const stack: number[] = [];
  headings.forEach((h, i) => {
    while (stack.length && headings[stack[stack.length - 1]].level >= h.level) stack.pop();
    parents.push(stack.length ? stack[stack.length - 1] : -1);
    stack.push(i);
  });
  return parents;
}

interface ListOptions {
  /** children can be folded under their parent */
  collapsible?: boolean;
  /** case-insensitive filter; matches are shown with their parents */
  query?: string;
  /** ids of entries holding a change since the last view (code outline): a dot after them */
  changed?: ReadonlySet<string>;
}

/** Arrow keys on a row: Up/Down move between rows, Right/Left unfold/fold (tree-like). */
function onRowKey(e: React.KeyboardEvent<HTMLAnchorElement>, toggle: ((open: boolean) => void) | null) {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    const list = e.currentTarget.closest("ul");
    if (!list) return;
    const links = [...list.querySelectorAll<HTMLAnchorElement>("a[data-toc-link]")];
    const next = links[links.indexOf(e.currentTarget) + (e.key === "ArrowDown" ? 1 : -1)];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  } else if (toggle && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
    e.preventDefault();
    toggle(e.key === "ArrowRight");
  }
}

const TocList = memo(function TocList({
  headings,
  active,
  onSelect,
  collapsible = false,
  query = "",
  changed,
}: {
  headings: TocHeading[];
  active: string | null;
  onSelect: (id: string) => void;
} & ListOptions) {
  const minLevel = useMemo(() => {
    let m = Infinity;
    for (const h of headings) if (h.level < m) m = h.level;
    return m;
  }, [headings]);
  // Folds belong to one list of headings: new headings (the file changed) start unfolded.
  const [fold, setFold] = useState<{ of: TocHeading[]; ids: ReadonlySet<string> }>({ of: headings, ids: NO_IDS });
  const collapsed = fold.of === headings ? fold.ids : NO_IDS;
  const setCollapsed = (id: string, open: boolean) =>
    setFold((prev) => {
      const ids = new Set(prev.of === headings ? prev.ids : NO_IDS);
      if (open) ids.delete(id);
      else ids.add(id);
      return { of: headings, ids };
    });
  const parents = useMemo(() => (collapsible || query ? parentsOf(headings) : null), [headings, collapsible, query]);
  const [more, setMore] = useState<{ of: TocHeading[]; limit: number }>({ of: headings, limit: ROWS_STEP });
  const limit = more.of === headings ? more.limit : ROWS_STEP;

  // Which rows are shown: with a query, matches and their parents; otherwise
  // everything not inside a collapsed parent.
  const shown = useMemo(() => {
    if (!parents) return null;
    const vis = new Array<boolean>(headings.length).fill(!query);
    if (query) {
      const q = query.toLowerCase();
      headings.forEach((h, i) => {
        if (!h.text.toLowerCase().includes(q)) return;
        for (let j = i; j !== -1 && !vis[j]; j = parents[j]) vis[j] = true;
      });
    } else if (collapsed.size) {
      headings.forEach((_, i) => {
        for (let p = parents[i]; p !== -1; p = parents[p])
          if (collapsed.has(headings[p].id)) {
            vis[i] = false;
            break;
          }
      });
    }
    return vis;
  }, [headings, parents, query, collapsed]);

  // A folded-away active row lights up its nearest shown parent.
  let activeShown = active;
  if (active && shown && parents) {
    let i = headings.findIndex((h) => h.id === active);
    while (i !== -1 && !shown[i]) i = parents[i];
    activeShown = i === -1 ? null : headings[i].id;
  }

  const hasChildren = (i: number) => i + 1 < headings.length && headings[i + 1].level > headings[i].level;

  const total = shown ? shown.reduce((n, v) => (v ? n + 1 : n), 0) : headings.length;
  if (total === 0) return <p className="px-2 py-1 text-xs text-muted-foreground">No matches</p>;

  const rows: React.ReactNode[] = [];
  for (let i = 0; i < headings.length && rows.length < limit; i++) {
    if (shown && !shown[i]) continue;
    const h = headings[i];
    const foldable = collapsible && hasChildren(i) && !query;
    const isOpen = !collapsed.has(h.id);
    rows.push(
      <li key={h.id} className={collapsible ? "flex items-center" : undefined} data-toc-id={h.id}>
        {collapsible ? (
          foldable ? (
            <button
              type="button"
              tabIndex={-1}
              aria-label={isOpen ? `Collapse ${h.text}` : `Expand ${h.text}`}
              aria-expanded={isOpen}
              className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              style={{ marginLeft: `${(h.level - minLevel) * 0.75}rem` }}
              onClick={() => setCollapsed(h.id, !isOpen)}
            >
              <ChevronRightIcon className={cn("size-3 transition-transform", isOpen && "rotate-90")} />
            </button>
          ) : (
            <span className="size-4 shrink-0" style={{ marginLeft: `${(h.level - minLevel) * 0.75}rem` }} />
          )
        ) : null}
        <a
          href={`#${encodeURIComponent(h.id)}`}
          data-toc-link=""
          onClick={(e) => {
            e.preventDefault();
            onSelect(h.id);
          }}
          onKeyDown={collapsible ? (e) => onRowKey(e, foldable ? (open) => setCollapsed(h.id, open) : null) : undefined}
          className={cn(
            "block truncate rounded px-2 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground",
            collapsible && "min-w-0 flex-1 pl-1",
            activeShown === h.id && "bg-muted font-medium text-foreground",
          )}
          style={collapsible ? undefined : { paddingLeft: `${0.5 + (h.level - minLevel) * 0.75}rem` }}
          title={h.title ?? h.text}
          aria-current={activeShown === h.id ? "location" : undefined}
          aria-expanded={foldable ? isOpen : undefined}
        >
          {h.badge ? (
            <span
              className="mr-1.5 inline-block w-6 font-mono text-[10px] font-normal text-muted-foreground/70"
              title={h.badgeTitle}
            >
              {h.badge}
            </span>
          ) : null}
          {h.text}
          {changed?.has(h.id) ? <span className="sr-only"> (changed since you last viewed it)</span> : null}
        </a>
        {changed?.has(h.id) ? (
          <span
            className="mr-1 size-1.5 shrink-0 rounded-full bg-amber-500"
            data-toc-changed=""
            title="Changed since you last viewed it"
            aria-hidden
          />
        ) : null}
      </li>,
    );
  }

  return (
    <>
      <ul className="space-y-0.5 text-sm">{rows}</ul>
      {total > rows.length ? (
        <p className="px-2 pt-1 text-xs text-muted-foreground">
          First {rows.length.toLocaleString()} of {total.toLocaleString()}.{" "}
          <button
            type="button"
            className="underline underline-offset-2 hover:text-foreground"
            onClick={() => setMore({ of: headings, limit: limit + 4 * ROWS_STEP })}
          >
            Show more
          </button>
        </p>
      ) : null}
    </>
  );
});

function wordLabel(words: number): string {
  return `${words.toLocaleString()} word${words === 1 ? "" : "s"}`;
}

function FilterBox({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <input
      type="search"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && value) {
          e.stopPropagation();
          onChange("");
        }
      }}
      placeholder="Filter"
      aria-label={label}
      className="mb-2 h-7 w-full rounded-md border bg-transparent px-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
    />
  );
}

interface TocProps extends ListOptions {
  headings: TocHeading[];
  /** word count of the document, shown next to the title */
  words?: number;
  onSelect: (id: string) => void;
  /** heading of the panel (default "On this page") / the inline block (default "Contents") */
  title?: string;
  /** accessible name of the nav (default "Table of contents") */
  label?: string;
  /** the active row, when the caller tracks it (otherwise headings in view, by id) */
  active?: string | null;
  /** fewest rows for the panel to show (default 2) */
  minItems?: number;
  /** show a filter box above the list from this many rows on (default: never) */
  filterFrom?: number;
  className?: string;
}

/** Sticky side panel on wide screens. */
export function TocPanel({
  headings,
  words,
  onSelect,
  title = "On this page",
  label = "Table of contents",
  active: activeProp,
  minItems = 2,
  filterFrom,
  collapsible,
  changed,
  className,
}: TocProps) {
  const observed = useActiveHeading(activeProp === undefined ? headings : NO_HEADINGS);
  const active = activeProp === undefined ? observed : activeProp;
  const { width: tocWidth, reserved: tocReserved } = useTocWidth();
  const [query, setQuery] = useState("");
  const navRef = useRef<HTMLElement>(null);

  // Keep the active row in view inside the panel (never scrolls the page).
  useEffect(() => {
    const nav = navRef.current;
    if (!nav || !active || activeProp === undefined) return;
    const row = nav.querySelector<HTMLElement>(`[data-toc-id="${CSS.escape(active)}"]`);
    if (!row) return;
    const r = row.getBoundingClientRect();
    const n = nav.getBoundingClientRect();
    if (r.top < n.top + 32) nav.scrollTop -= n.top + 32 - r.top;
    else if (r.bottom > n.bottom - 8) nav.scrollTop += r.bottom - n.bottom + 8;
  }, [active, activeProp]);

  if (headings.length < minItems) return null;
  const filter = filterFrom !== undefined && headings.length >= filterFrom;
  return (
    // The width comes from --toc-width (set here, changed with the handle on the left edge).
    <div
      style={{ ["--toc-width" as string]: `${tocWidth}px` }}
      className={cn(
        "no-print sticky top-20 hidden max-h-[calc(100svh-6rem)] w-[var(--toc-width,15rem)] shrink-0 flex-col xl:flex",
        className,
      )}
    >
      <ResizeHandle
        spec={TOC_SPEC}
        cssVar="--toc-width"
        dir={-1}
        label={`Resize ${title.toLowerCase()}`}
        className="-left-1"
        scope="parent"
        reserved={tocReserved}
      />
      <nav ref={navRef} aria-label={label} className="min-h-0 flex-1 overflow-y-auto pb-6">
        <div className="mb-2 flex items-center gap-1.5 px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <ListIcon className="size-3.5" /> {title}
          {words ? (
            <span className="ml-auto font-normal tracking-normal normal-case">{wordLabel(words)}</span>
          ) : null}
        </div>
        {filter ? <FilterBox value={query} onChange={setQuery} label={`Filter ${title.toLowerCase()}`} /> : null}
        <TocList
          headings={headings}
          active={active}
          onSelect={onSelect}
          collapsible={collapsible}
          query={filter ? query : ""}
          changed={changed}
        />
      </nav>
    </div>
  );
}

/** Collapsible block shown above the article on narrower screens. */
export function TocInline({
  headings,
  words,
  onSelect,
  title = "Contents",
  minItems = 2,
  filterFrom,
  collapsible,
  changed,
  className,
}: TocProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  if (headings.length < minItems) return null;
  const filter = filterFrom !== undefined && headings.length >= filterFrom;
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={cn("no-print mb-4 rounded-lg border xl:hidden", className)}>
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-3 py-2 text-sm font-medium">
        <ChevronRightIcon className={cn("size-4 transition-transform", open && "rotate-90")} />
        {title}
        <span className="text-muted-foreground">({headings.length})</span>
        {words ? <span className="ml-auto text-xs font-normal text-muted-foreground">{wordLabel(words)}</span> : null}
      </CollapsibleTrigger>
      <CollapsibleContent className="max-h-80 overflow-y-auto border-t px-1 py-2">
        {filter ? (
          <div className="px-1">
            <FilterBox value={query} onChange={setQuery} label={`Filter ${title.toLowerCase()}`} />
          </div>
        ) : null}
        <TocList
          headings={headings}
          active={null}
          onSelect={onSelect}
          collapsible={collapsible}
          query={filter ? query : ""}
          changed={changed}
        />
      </CollapsibleContent>
    </Collapsible>
  );
}
