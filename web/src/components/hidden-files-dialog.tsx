"use client";

// Hidden files (the eye button in the sidebar): what is hidden in the open folder, from
// GET /api/hiding/items, grouped as Built-in, Git-ignored, Hidden by you and Protected. A checkbox
// means "visible": checking shows that exact path, unchecking hides it (POST /api/hiding/update).
// Only the topmost hidden items are listed; a hidden folder lists its children when expanded
// (/api/hidden), and file counts come lazily and bounded (/api/hiding/count). Works in read-only
// and desktop mode: the server writes only to its data dir.

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ChevronRightIcon, FolderIcon, LockIcon, PlusIcon } from "lucide-react";
import { toast } from "sonner";
import { FileKindIcon } from "@/components/file-icon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  api,
  errorMessage,
  noteHidden,
  type HiddenCount,
  type HiddenEntry,
  type HiddenGroup,
  type HiddenItems,
  type HiddenRow,
  type HidingState,
  type HidingUpdateResult,
} from "@/lib/api";
import {
  foldPath,
  formatCount,
  GROUPS,
  groupRules,
  headerState,
  hiddenLabel,
  isPatternRow,
  listedRows,
  mergeSticky,
  pageItems,
  patternRows,
  type HeaderState,
} from "@/lib/hidden-items";
import {
  addRule,
  appliedSummary,
  getCounts,
  getHiding,
  getItems,
  hidePaths,
  hidingClientId,
  mergeApplied,
  onHiddenChanged,
  ownUpdateRecent,
  setHideGit,
  setHidingState,
  showPaths,
  updateHiding,
  useHiding,
} from "@/lib/hiding-api";
import { dirname } from "@/lib/paths";
import { cn } from "@/lib/utils";

const DOCS_URL = "https://github.com/dharmen8980/deltadeck/blob/main/docs/configuration.md#hidden-files";
/** rows rendered per group before "Show N more" */
const PAGE = 200;
const RELOAD_DEBOUNCE_MS = 300;
const COUNT_RETRY_MS = 500;
const COUNT_TRIES = 5;
const ADD_BATCH = 100; // the server's max_add

export function HiddenFilesDialog({
  root,
  open,
  onOpenChange,
  onOpen,
  children,
}: {
  root: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpen: (path: string, isDir: boolean) => void;
  /** the DialogTrigger (focus returns to it on close) */
  children?: ReactNode;
}) {
  const openPath = useCallback(
    (path: string, isDir: boolean) => {
      onOpenChange(false);
      onOpen(path, isDir);
    },
    [onOpen, onOpenChange],
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {children}
      <DialogContent className="flex max-h-[85svh] flex-col gap-3 sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Hidden files</DialogTitle>
          <DialogDescription>
            Checked items show in the sidebar, search and change tracking. Unchecked items are hidden.
          </DialogDescription>
          <p className="text-xs text-muted-foreground">
            Saved for this folder in DeltaDeck&apos;s data dir, never in the folder.{" "}
            <a href={DOCS_URL} target="_blank" rel="noreferrer" className="underline underline-offset-2">
              How hiding works
            </a>
          </p>
        </DialogHeader>
        {/* mounted while open only: the sticky rows and caches start fresh each time */}
        {open ? <Body root={root} onOpen={openPath} /> : null}
      </DialogContent>
    </Dialog>
  );
}

// ---------- a tree of rows with a roving tabindex ----------

interface CheckSpec {
  checked: boolean;
  mixed?: boolean;
  disabled: boolean;
  busy: boolean;
  label: string;
  onChange: (visible: boolean) => void;
}

interface TNode {
  key: string;
  check?: CheckSpec;
  icon: ReactNode;
  name: ReactNode;
  /** dimmed after the name (the parent folder) */
  sub?: string;
  hint?: string;
  title?: string;
  /** Enter or a click on the name */
  onActivate?: () => void;
  expanded?: boolean;
  /** set: the row expands (Right / Left) */
  onExpand?: (open: boolean) => void;
  children?: TNode[];
  /** a message line (loading, error, truncated) */
  note?: string;
  noteError?: boolean;
}

function Check({
  spec,
  describedBy,
  tabIndex = -1,
}: {
  spec: CheckSpec;
  describedBy?: string;
  /** -1 in a row tree (the treeitem takes Space); 0 for a group header */
  tabIndex?: number;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = Boolean(spec.mixed);
  }, [spec.mixed]);
  return (
    <input
      ref={ref}
      type="checkbox"
      tabIndex={tabIndex}
      className="size-4 shrink-0 accent-primary disabled:opacity-50"
      checked={spec.checked}
      disabled={spec.disabled}
      aria-busy={spec.busy || undefined}
      aria-label={spec.label}
      aria-describedby={describedBy}
      onChange={(e) => spec.onChange(e.target.checked)}
    />
  );
}

function keysOf(nodes: TNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.note) continue;
    out.push(n.key);
    if (n.expanded && n.children) keysOf(n.children, out);
  }
  return out;
}

function findNode(nodes: TNode[], key: string): TNode | null {
  for (const n of nodes) {
    if (n.key === key) return n;
    if (n.expanded && n.children) {
      const hit = findNode(n.children, key);
      if (hit) return hit;
    }
  }
  return null;
}

function RowTree({ label, nodes }: { label: string; nodes: TNode[] }) {
  const [active, setActive] = useState<string | null>(null);
  const ref = useRef<HTMLUListElement>(null);
  const keys = keysOf(nodes);
  const activeKey = active && keys.includes(active) ? active : (keys[0] ?? null);

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const li = e.target as HTMLElement;
    if (li.getAttribute("role") !== "treeitem" || !ref.current) return;
    const node = findNode(nodes, li.dataset.key ?? "");
    if (!node) return;
    const all = Array.from(ref.current.querySelectorAll<HTMLElement>('[role="treeitem"]'));
    const i = all.indexOf(li);
    const focus = (el: HTMLElement | null | undefined) => el?.focus();
    switch (e.key) {
      case "ArrowDown":
        focus(all[i + 1]);
        break;
      case "ArrowUp":
        focus(all[i - 1]);
        break;
      case "Home":
        focus(all[0]);
        break;
      case "End":
        focus(all[all.length - 1]);
        break;
      case "ArrowRight":
        if (node.onExpand && !node.expanded) node.onExpand(true);
        else if (node.expanded) focus(all[i + 1]);
        break;
      case "ArrowLeft":
        if (node.onExpand && node.expanded) node.onExpand(false);
        else focus(li.parentElement?.closest<HTMLElement>('[role="treeitem"]'));
        break;
      case " ":
        if (node.check && !node.check.disabled) node.check.onChange(!node.check.checked || Boolean(node.check.mixed));
        break;
      case "Enter":
        node.onActivate?.();
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const render = (list: TNode[], level: number): ReactNode =>
    list.map((n) => {
      if (n.note) {
        return (
          <li
            key={n.key}
            role="none"
            className={cn("py-1 text-xs", n.noteError ? "text-destructive" : "text-muted-foreground italic")}
            style={{ paddingLeft: `${level * 1.25 + 0.5}rem` }}
          >
            {n.note}
          </li>
        );
      }
      const hintId = n.hint ? `${n.key}-hint` : undefined;
      return (
        <li
          key={n.key}
          role="treeitem"
          aria-level={level + 1}
          aria-expanded={n.onExpand ? Boolean(n.expanded) : undefined}
          aria-selected={false}
          aria-label={[n.title ?? (typeof n.name === "string" ? n.name : ""), n.hint].filter(Boolean).join(", ")}
          data-key={n.key}
          tabIndex={n.key === activeKey ? 0 : -1}
          onFocus={(e) => {
            if (e.target === e.currentTarget) setActive(n.key);
          }}
          className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div
            className="flex min-h-7 items-center gap-2 rounded-md pr-1 hover:bg-muted/60"
            style={{ paddingLeft: `${level * 1.25 + 0.5}rem` }}
          >
            {n.check ? <Check spec={n.check} describedBy={hintId && safeId(hintId)} /> : <span className="size-4 shrink-0" />}
            <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">{n.icon}</span>
            <button
              type="button"
              tabIndex={-1}
              title={n.title}
              className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
              onClick={n.onActivate}
            >
              <span className="min-w-0 truncate">
                {n.name}
                {n.sub ? <span className="ml-1.5 text-xs text-muted-foreground">{n.sub}</span> : null}
              </span>
              {n.hint ? (
                <span id={safeId(hintId!)} className="ml-auto shrink-0 pl-2 text-xs text-muted-foreground">
                  {n.hint}
                </span>
              ) : (
                <span className="ml-auto" />
              )}
              {n.onExpand ? (
                <ChevronRightIcon
                  className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", n.expanded && "rotate-90")}
                  aria-hidden
                />
              ) : (
                <span className="size-3.5 shrink-0" />
              )}
            </button>
          </div>
          {n.expanded && n.children ? <ul role="group">{render(n.children, level + 1)}</ul> : null}
        </li>
      );
    });

  return (
    <ul ref={ref} role="tree" aria-label={label} className="space-y-px" onKeyDown={onKeyDown}>
      {render(nodes, 0)}
    </ul>
  );
}

/** A DOM id from a row key (paths can hold any character). */
const safeId = (key: string) => `hf-${encodeURIComponent(key).replace(/[^A-Za-z0-9_-]/g, "_")}`;

// ---------- the dialog body ----------

/** stale: listed before a change; shown until the refetch lands */
type ChildList = { entries: HiddenEntry[]; truncated: boolean; stale?: boolean } | { error: string } | "loading";

const markStale = (m: Map<string, ChildList>) =>
  new Map(
    [...m].flatMap(([k, v]): [string, ChildList][] =>
      typeof v === "object" && "entries" in v ? [[k, { ...v, stale: true }]] : [],
    ),
  );

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function kindWord(rows: HiddenRow[]): string {
  if (rows.every((r) => r.dir)) return "folder";
  if (rows.every((r) => !r.dir)) return "file";
  return "item";
}

function rowIcon(r: { dir: boolean; kind?: HiddenRow["kind"] }, locked: boolean) {
  if (locked) return <LockIcon className="size-3.5" aria-label="protected" />;
  if (r.dir) return <FolderIcon className="size-4" />;
  return <FileKindIcon kind={r.kind ?? "binary"} className="size-4" />;
}

function combine(results: HidingUpdateResult[]): HidingUpdateResult | null {
  const last = results[results.length - 1];
  return last ? { ...last, applied: mergeApplied(results.map((r) => r.applied)) } : null;
}

function Body({ root, onOpen }: { root: string; onOpen: (path: string, isDir: boolean) => void }) {
  const shared = useHiding();
  const [fetched, setFetched] = useState<HidingState | null>(null);
  const [stateError, setStateError] = useState<string | null>(null);
  const [stateReload, setStateReload] = useState(0);
  // the shared store follows other tabs (SSE); a fresh GET on open covers a store not loaded yet
  const state = shared && shared.root === root ? shared : fetched;
  const [items, setItems] = useState<HiddenItems | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  /** rows the user changed this session, with `visible` as they set it: listed until close */
  const [sticky, setSticky] = useState<Map<string, HiddenRow>>(() => new Map());
  /** patterns the user removed (or re-added) this session, with the rows they matched */
  const [stickyPatterns, setStickyPatterns] = useState<Map<string, HiddenRow[]>>(() => new Map());
  /** checkbox values of changes in flight (`done`: applied, until the rows are refetched); dropped on error */
  const [pending, setPending] = useState<Map<string, { v: boolean; done: boolean }>>(() => new Map());
  /** changes in flight per key (a row's path, "group:git"...); rows stay clickable, updates queue in order */
  const [busy, setBusy] = useState<Map<string, number>>(() => new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [children, setChildren] = useState<Map<string, ChildList>>(() => new Map());
  const [limit, setLimit] = useState<Record<HiddenGroup, number>>({ builtin: PAGE, git: PAGE, user: PAGE, deny: PAGE });
  const [counts, setCounts] = useState<Map<string, HiddenCount>>(() => new Map());
  const countCache = useRef(new Map<string, HiddenCount | "none">());
  const [countEpoch, setCountEpoch] = useState(0);
  const [input, setInput] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const inputErrorId = useId();
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleReload = useCallback(() => {
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => setReload((n) => n + 1), RELOAD_DEBOUNCE_MS);
  }, []);
  useEffect(
    () => () => {
      if (reloadTimer.current) clearTimeout(reloadTimer.current);
    },
    [],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    getHiding(root, ctrl.signal).then(
      (s) => {
        setFetched(s);
        setStateError(null);
        setHidingState(s, true);
      },
      (e: unknown) => {
        if ((e as Error).name !== "AbortError") setStateError(errorMessage(e));
      },
    );
    return () => ctrl.abort();
  }, [root, stateReload]);

  useEffect(() => {
    const ctrl = new AbortController();
    getItems(root, ctrl.signal).then(
      (res) => {
        setItems(res);
        setLoadError(null);
        noteHidden(res.rows.map((r) => ({ path: r.path, dir: r.dir, reason: r.group === "deny" ? "deny" : "ignore" })));
        setPending((p) => new Map([...p].filter(([, x]) => !x.done)));
      },
      (e: unknown) => {
        if ((e as Error).name !== "AbortError") setLoadError(errorMessage(e));
      },
    );
    return () => ctrl.abort();
  }, [root, reload]);

  // Other tabs (a "hiding" event; our own echo is skipped) and the watcher (hidden_changed).
  useEffect(
    () =>
      onHiddenChanged((client) => {
        if (client !== hidingClientId) scheduleReload();
        if (client === hidingClientId || (client === null && ownUpdateRecent())) return;
        countCache.current = new Map();
        setCounts(new Map());
        setCountEpoch((n) => n + 1);
        setChildren(markStale);
      }),
    [scheduleReload],
  );

  const enabled = Boolean(state?.enabled);
  const rows = useMemo(() => (items ? mergeSticky(sticky, items.rows) : []), [items, sticky]);
  const byPath = useMemo(() => new Map(rows.map((r) => [r.path, r])), [rows]);
  // sub-groups from every built-in row, then paged: a sub-group's checkbox covers all its rows
  const builtinRows = useMemo(() => rows.filter((r) => r.group === "builtin"), [rows]);
  const builtinItems = useMemo(() => groupRules(builtinRows), [builtinRows]);
  const pend = (key: string) => pending.get(key)?.v;
  const vis = (r: HiddenRow) => pend(r.path) ?? r.visible;

  // ---------- changes ----------
  const run = async (
    busyKey: string,
    optimistic: [string, boolean][],
    fn: () => Promise<HidingUpdateResult | null>,
    after?: () => void,
  ) => {
    setBusy((b) => new Map(b).set(busyKey, (b.get(busyKey) ?? 0) + 1));
    setPending((p) => {
      const next = new Map(p);
      for (const [k, v] of optimistic) next.set(k, { v, done: false });
      return next;
    });
    try {
      const res = await fn();
      after?.();
      setPending((p) => {
        const next = new Map(p);
        for (const [k, v] of optimistic) if (next.get(k)?.v === v) next.set(k, { v, done: true });
        return next;
      });
      const summary = res ? appliedSummary(res.applied) : null;
      if (summary) toast(summary);
    } catch (e) {
      setPending((p) => {
        const next = new Map(p);
        for (const [k, v] of optimistic) if (next.get(k)?.v === v) next.delete(k);
        return next;
      });
      toast.error("Could not change the hidden files", { description: errorMessage(e) });
    } finally {
      setBusy((b) => {
        const next = new Map(b);
        const n = (next.get(busyKey) ?? 1) - 1;
        if (n > 0) next.set(busyKey, n);
        else next.delete(busyKey);
        return next;
      });
      setChildren(markStale);
      scheduleReload();
    }
  };

  const stick = (list: HiddenRow[]) =>
    setSticky((prev) => {
      const next = new Map(prev);
      for (const r of list) next.set(r.path, r);
      return next;
    });

  /** show or hide these rows (each exact path) */
  const setRows = (busyKey: string, list: HiddenRow[], visible: boolean, extraSticky: HiddenRow[] = [], unstick: string[] = []) => {
    const change = list.filter((r) => vis(r) !== visible);
    if (!change.length) return;
    const paths = change.map((r) => r.path);
    void run(
      busyKey,
      paths.map((p) => [p, visible]),
      () => (visible ? showPaths(root, paths) : hidePaths(root, paths)),
      () => {
        stick([...extraSticky, ...change.map((r) => ({ ...r, visible }))]);
        if (unstick.length)
          setSticky((prev) => {
            const next = new Map(prev);
            for (const p of unstick) next.delete(p);
            return next;
          });
      },
    );
  };

  // ---------- groups ----------
  const gitRows = rows.filter((r) => r.group === "git");
  const userRows = rows.filter((r) => r.group === "user");
  const denyRows = rows.filter((r) => r.group === "deny");
  const exactUser = userRows.filter((r) => !isPatternRow(r));

  const rules = state?.rules ?? [];
  const inRules = new Set(rules.map(foldPath));
  const patterns = patternRows(
    [...rules, ...[...stickyPatterns.keys()].filter((p) => !inRules.has(foldPath(p)))],
    userRows,
  ).map((p) => ({ rule: p.rule, rows: p.rows.length ? p.rows : (stickyPatterns.get(p.rule) ?? []) }));
  const patternKey = (rule: string) => `pattern:${rule}`;
  const patternVisible = (rule: string) => pend(patternKey(rule)) ?? !inRules.has(foldPath(rule));

  const setPatterns = (busyKey: string, list: { rule: string; rows: HiddenRow[] }[], visible: boolean, alsoRows: HiddenRow[] = []) => {
    const change = list.filter((p) => patternVisible(p.rule) !== visible);
    const rowChange = alsoRows.filter((r) => vis(r) !== visible);
    if (!change.length && !rowChange.length) return;
    const pats = change.map((p) => p.rule);
    const paths = rowChange.map((r) => r.path);
    void run(
      busyKey,
      [...pats.map((p): [string, boolean] => [patternKey(p), visible]), ...paths.map((p): [string, boolean] => [p, visible])],
      async () => {
        const results: HidingUpdateResult[] = [];
        if (visible) {
          if (pats.length) results.push(await updateHiding(root, { remove_rules: pats }));
          if (paths.length) results.push(await showPaths(root, paths));
        } else {
          for (let i = 0; i < pats.length; i += ADD_BATCH) results.push(await updateHiding(root, { add_rules: pats.slice(i, i + ADD_BATCH) }));
          if (paths.length) results.push(await hidePaths(root, paths));
        }
        return combine(results);
      },
      () => {
        setStickyPatterns((prev) => {
          const next = new Map(prev);
          for (const p of change) next.set(p.rule, p.rows);
          return next;
        });
        stick(rowChange.map((r) => ({ ...r, visible })));
      },
    );
  };

  const addPattern = async () => {
    const v = input.trim();
    if (!v || adding) return;
    setAdding(true);
    try {
      const res = await addRule(root, v);
      setInput("");
      setInputError(null);
      const summary = appliedSummary(res.applied);
      if (summary) toast(summary);
      scheduleReload();
    } catch (e) {
      setInputError(errorMessage(e));
    } finally {
      setAdding(false);
    }
  };

  // ---------- expansion of hidden folders (lazy, /api/hidden) ----------
  // Expanded folders not listed yet, or listed before a change (stale), are fetched (again).
  const inflight = useRef(new Set<string>());
  useEffect(() => {
    for (const key of expanded) {
      const m = /^(?:row|child):([\s\S]*)$/.exec(key);
      if (!m) continue;
      const path = m[1];
      const have = children.get(path);
      if ((have && !(typeof have === "object" && "stale" in have && have.stale)) || inflight.current.has(path)) continue;
      inflight.current.add(path);
      api
        .hidden(path)
        .then(
          (res) => setChildren((c) => new Map(c).set(path, { entries: res.entries, truncated: res.truncated })),
          (e: unknown) => setChildren((c) => new Map(c).set(path, { error: errorMessage(e) })),
        )
        .finally(() => inflight.current.delete(path));
    }
  }, [expanded, children]);
  const setOpen = (key: string, open: boolean) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });

  // ---------- counts (lazy, bounded; null = ask again) ----------
  const countPaths = useMemo(() => {
    const out: string[] = [];
    const listed = [
      ...listedRows(pageItems(builtinItems, limit.builtin), (rule) => expanded.has(`rule:${rule}`)),
      ...(["git", "user", "deny"] as const).flatMap((g) => rows.filter((x) => x.group === g).slice(0, limit[g])),
    ];
    for (const r of listed) if (r.dir && !r.visible) out.push(r.path);
    return out;
  }, [rows, builtinItems, expanded, limit]);
  const countKey = countPaths.join("\n");
  useEffect(() => {
    const cache = countCache.current;
    let need = countKey ? countKey.split("\n").filter((p) => !cache.has(p)) : [];
    if (!need.length) return;
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    const step = () => {
      getCounts(root, need, ctrl.signal).then(
        (res) => {
          const again: string[] = [];
          for (const p of need) {
            const c = res[p];
            if (c === null) again.push(p);
            else cache.set(p, c ?? "none"); // left out: missing or refused
          }
          const shown = new Map<string, HiddenCount>();
          for (const [p, c] of cache) if (c !== "none") shown.set(p, c);
          setCounts(shown);
          need = again;
          if (need.length && ++tries < COUNT_TRIES) timer = setTimeout(step, COUNT_RETRY_MS);
        },
        () => undefined, // counts are a nicety: leave them blank
      );
    };
    step();
    return () => {
      ctrl.abort();
      if (timer) clearTimeout(timer);
    };
  }, [root, countKey, countEpoch]);

  // ---------- nodes ----------
  const groupBusy = (g: string) => busy.has(`group:${g}`);

  const childNodes = (folder: string, group: HiddenGroup, checkable: boolean, level: string): TNode[] => {
    const list = children.get(folder);
    if (!list || list === "loading") return [{ key: `${level}:loading`, icon: null, name: "", note: "Loading..." }];
    if ("error" in list) return [{ key: `${level}:error`, icon: null, name: "", note: list.error, noteError: true }];
    const nodes: TNode[] = list.entries.map((e) => {
      const key = `child:${e.path}`;
      const locked = e.reason === "deny";
      const known = byPath.get(e.path);
      const visible = pend(e.path) ?? sticky.get(e.path)?.visible ?? known?.visible ?? false;
      const asRow: HiddenRow = {
        path: e.path,
        name: e.name,
        dir: e.dir,
        group,
        visible,
        ...(e.rule ? { rule: e.rule } : {}),
        ...(e.kind ? { kind: e.kind } : {}),
        ...(e.ext !== undefined ? { ext: e.ext } : {}),
      };
      const canExpand = e.dir && !visible;
      return {
        key,
        icon: rowIcon(e, locked),
        name: e.name,
        hint: locked ? "Protected" : hiddenLabel(e.reason, e.rule),
        title: e.path,
        check:
          checkable && !locked
            ? {
                checked: visible,
                disabled: !enabled || groupBusy(group),
                busy: busy.has(e.path),
                label: `Show ${e.path}`,
                // the folder becomes partly shown and leaves the listing (its other items get their own rows)
                onChange: (v) => setRows(e.path, [asRow], v, [], [folder]),
              }
            : undefined,
        onActivate: canExpand ? () => setOpen(key, !expanded.has(key)) : () => onOpen(e.path, e.dir),
        ...(canExpand
          ? {
              expanded: expanded.has(key),
              onExpand: (o: boolean) => setOpen(key, o),
              children: expanded.has(key) ? childNodes(e.path, group, checkable, key) : undefined,
            }
          : {}),
      };
    });
    if (!nodes.length) nodes.push({ key: `${level}:empty`, icon: null, name: "", note: "Empty" });
    if (list.truncated) nodes.push({ key: `${level}:more`, icon: null, name: "", note: "Only the first 2000 are listed" });
    return nodes;
  };

  const rowNode = (r: HiddenRow, checkable: boolean): TNode => {
    const key = `row:${r.path}`;
    const visible = vis(r);
    const locked = r.group === "deny";
    const hint = [
      r.dir && !visible ? formatCount(counts.get(r.path)) : "",
      locked ? "Protected" : r.extra ? "from --ignore" : r.choice === "show" ? "shown by you" : r.choice === "hide" ? "hidden by you" : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const canExpand = r.dir && !visible;
    const parent = dirname(r.path);
    return {
      key,
      icon: rowIcon(r, locked),
      name: r.name,
      sub: parent || undefined,
      hint: hint || undefined,
      title: r.path,
      check:
        checkable && !locked
          ? {
              checked: visible,
              disabled: !enabled || groupBusy(r.group),
              busy: busy.has(r.path),
              label: `Show ${r.path}`,
              onChange: (v) => setRows(r.path, [r], v),
            }
          : undefined,
      onActivate: canExpand ? () => setOpen(key, !expanded.has(key)) : () => onOpen(r.path, r.dir),
      ...(canExpand
        ? {
            expanded: expanded.has(key),
            onExpand: (o: boolean) => setOpen(key, o),
            children: expanded.has(key)
              ? childNodes(
                  r.path,
                  r.group,
                  // nothing below a folder you hid can be shown (the server answers 400)
                  checkable && (r.group === "builtin" || r.group === "git") && r.choice !== "hide",
                  key,
                )
              : undefined,
          }
        : {}),
    };
  };

  const triState = (s: HeaderState) => ({ checked: s === "checked", mixed: s === "mixed" });
  const withVis = (list: HiddenRow[]) => list.map((r) => ({ group: r.group, visible: vis(r) }));

  const builtinNodes: TNode[] = pageItems(builtinItems, limit.builtin).map((item) => {
    if (item.kind === "row") return rowNode(item.row, true);
    const key = `rule:${item.rule}`;
    const s = headerState(withVis(item.rows));
    return {
      key,
      icon: <FolderIcon className="size-4" />,
      name: <code className="text-xs">{item.rule}</code>,
      title: `Everything hidden by ${item.rule}`,
      hint: plural(item.rows.length, kindWord(item.rows)),
      check: {
        ...triState(s),
        disabled: !enabled || groupBusy("builtin"),
        busy: busy.has(key),
        label: `Show every ${item.rule}`,
        onChange: (v) => setRows(key, item.rows, v),
      },
      onActivate: () => setOpen(key, !expanded.has(key)),
      expanded: expanded.has(key),
      onExpand: (o) => setOpen(key, o),
      children: expanded.has(key) ? item.rows.map((r) => rowNode(r, true)) : undefined,
    };
  });

  const userItems: ({ kind: "pattern"; rule: string; rows: HiddenRow[] } | { kind: "row"; row: HiddenRow })[] = [
    ...patterns.map((p) => ({ kind: "pattern" as const, ...p })),
    ...exactUser.map((row) => ({ kind: "row" as const, row })),
  ];
  const userNodes: TNode[] = userItems.slice(0, limit.user).map((item) => {
    if (item.kind === "row") return rowNode(item.row, true);
    const key = patternKey(item.rule);
    const visible = patternVisible(item.rule);
    return {
      key,
      icon: <span className="font-mono text-[10px]">*</span>,
      name: <code className="text-xs">{item.rule}</code>,
      title: `Your pattern ${item.rule}`,
      hint: plural(item.rows.length, "item"),
      check: {
        checked: visible,
        disabled: !enabled || groupBusy("user"),
        busy: busy.has(key),
        label: `Show everything ${item.rule} hides`,
        onChange: (v) => setPatterns(key, [item], v),
      },
      onActivate: item.rows.length ? () => setOpen(key, !expanded.has(key)) : undefined,
      ...(item.rows.length
        ? {
            expanded: expanded.has(key),
            onExpand: (o: boolean) => setOpen(key, o),
            children: expanded.has(key) ? item.rows.map((r) => rowNode(r, false)) : undefined,
          }
        : {}),
    };
  });

  const gitNodes = gitRows.slice(0, limit.git).map((r) => rowNode(r, true));
  const denyNodes = denyRows.slice(0, limit.deny).map((r) => rowNode(r, false));

  // ---------- group headers ----------
  // the shared store is version-ordered and updated by every change; items may lag a refetch
  const hideGit = state?.hide_git ?? items?.hide_git ?? false;
  const gitAvailable = items?.git_available ?? state?.git_available ?? false;
  const gitAllVisible = !hideGit && gitRows.every((r) => vis(r));
  const gitState: HeaderState = gitAllVisible ? "checked" : gitRows.some((r) => vis(r)) ? "mixed" : "unchecked";
  const onGitHeader = (visible: boolean) => {
    const key = "group:git";
    if (!visible) {
      // all of them and future ones hidden; per-path choices on git-ignored items are cleared
      // they leave the sidebar at once; shown ones may keep their choice (also on the ignore list)
      const visibleNow = gitRows.filter((r) => vis(r) && r.choice !== "show").map((r) => r.path);
      void run(key, gitRows.map((r) => [r.path, false]), () => setHideGit(root, true, visibleNow), () =>
        stick(gitRows.map((r) => ({ ...r, visible: false, choice: undefined }))),
      );
    } else if (hideGit) {
      void run(key, gitRows.map((r) => [r.path, true]), () => setHideGit(root, false, gitRows.map((r) => r.path)), () =>
        stick(gitRows.map((r) => ({ ...r, visible: true, choice: undefined }))),
      );
    } else setRows(key, gitRows, true);
  };

  const userState = headerState([
    ...patterns.map((p) => ({ group: "user" as const, visible: patternVisible(p.rule) })),
    ...withVis(exactUser),
  ]);

  type Section = {
    id: HiddenGroup;
    title: string;
    count: number;
    nodes: TNode[];
    total: number;
    header?: { state: HeaderState; onChange: (v: boolean) => void; disabled?: boolean; title?: string };
    help?: string;
    empty?: string;
  };
  const sections: Section[] = [];
  for (const g of GROUPS) {
    if (g.id === "builtin" && builtinRows.length) {
      sections.push({
        id: g.id,
        title: g.title,
        count: builtinRows.length,
        total: builtinItems.length,
        nodes: builtinNodes,
        header: { state: headerState(withVis(builtinRows)), onChange: (v) => setRows("group:builtin", builtinRows, v) },
      });
    } else if (g.id === "git" && (gitRows.length || gitAvailable)) {
      sections.push({
        id: g.id,
        title: g.title,
        count: gitRows.length,
        total: gitRows.length,
        nodes: gitNodes,
        header: {
          state: gitState,
          onChange: onGitHeader,
          disabled: !gitAvailable,
          title: gitAvailable ? undefined : "This folder is not in a git work tree, or git is not available.",
        },
        help: hideGit ? "New git-ignored files are hidden" : "New git-ignored files are shown",
        empty: "No git-ignored files",
      });
    } else if (g.id === "user" && userItems.length) {
      sections.push({
        id: g.id,
        title: g.title,
        count: userItems.length,
        total: userItems.length,
        nodes: userNodes,
        header: { state: userState, onChange: (v) => setPatterns("group:user", patterns, v, exactUser) },
      });
    } else if (g.id === "deny" && denyRows.length) {
      sections.push({ id: g.id, title: g.title, count: denyRows.length, total: denyRows.length, nodes: denyNodes });
    }
  }

  const nothing = items && !rows.length && !patterns.length;

  return (
    <>
      {!state && stateError ? (
        <div className="flex items-center gap-2 text-xs text-destructive">
          <span className="min-w-0 flex-1">Could not load the hiding settings: {stateError}</span>
          <Button size="sm" variant="outline" onClick={() => setStateReload((n) => n + 1)}>
            Retry
          </Button>
        </div>
      ) : null}
      {items && loadError ? (
        <div className="flex items-center gap-2 text-xs text-destructive">
          <span className="min-w-0 flex-1">Could not refresh the list: {loadError}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setLoadError(null);
              setReload((n) => n + 1);
            }}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {state && !state.enabled ? (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs">
          Hiding settings are off for this folder{state.disabled_reason ? `: ${state.disabled_reason}` : "."}
        </p>
      ) : null}
      <div className="-mx-1 min-h-0 flex-1 space-y-4 overflow-y-auto px-1">
        {!items ? (
          loadError ? (
            <div className="flex items-center gap-2 text-sm text-destructive">
              <span className="min-w-0 flex-1">{loadError}</span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setLoadError(null);
                  setReload((n) => n + 1);
                }}
              >
                Retry
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Loading...</p>
          )
        ) : (
          <>
            {nothing ? <p className="text-sm text-muted-foreground">Nothing is hidden in this folder.</p> : null}
            {sections.map((s) => (
              <GroupSection
                key={s.id}
                section={s}
                enabled={enabled}
                busy={groupBusy(s.id)}
                shown={limit[s.id]}
                onMore={() => setLimit((l) => ({ ...l, [s.id]: l[s.id] + PAGE }))}
              />
            ))}
            {items.truncated ? <p className="text-xs text-muted-foreground">Only the first 5000 items are listed.</p> : null}
          </>
        )}
      </div>
      <div className="space-y-1.5 border-t pt-3">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void addPattern();
          }}
        >
          <Input
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setInputError(null);
            }}
            placeholder="*.log, fixtures, /docs/old"
            maxLength={state?.limits.max_rule_len}
            disabled={!enabled || adding}
            aria-label="Pattern to hide"
            aria-invalid={!!inputError}
            aria-describedby={inputError ? inputErrorId : undefined}
            className="font-mono text-xs"
          />
          <Button type="submit" size="sm" disabled={!enabled || adding || !input.trim()}>
            <PlusIcon /> Add
          </Button>
        </form>
        {inputError ? (
          <p id={inputErrorId} className="text-xs text-destructive">
            {inputError}
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Hide a pattern: a name or <code>*.ext</code> hides it at any depth; <code>/path</code> or <code>a/b/c</code> is
          relative to the folder; a trailing <code>/</code> is optional. Case does not matter.
        </p>
        <p className="text-xs text-muted-foreground">
          .git, temp files and DeltaDeck&apos;s data dir are never shown. Protected files open read-only after you
          confirm.
        </p>
      </div>
    </>
  );
}

function GroupSection({
  section: s,
  enabled,
  busy,
  shown,
  onMore,
}: {
  section: {
    id: HiddenGroup;
    title: string;
    count: number;
    total: number;
    nodes: TNode[];
    header?: { state: HeaderState; onChange: (v: boolean) => void; disabled?: boolean; title?: string };
    help?: string;
    empty?: string;
  };
  enabled: boolean;
  busy: boolean;
  shown: number;
  onMore: () => void;
}) {
  const id = useId();
  const label = `${s.title} (${s.count.toLocaleString()})`;
  return (
    <section aria-labelledby={id} className="space-y-1">
      {s.header ? (
        <label className="flex items-center gap-2 text-sm font-medium" title={s.header.title}>
          <Check
            tabIndex={0}
            spec={{
              checked: s.header.state === "checked",
              mixed: s.header.state === "mixed",
              disabled: !enabled || busy || Boolean(s.header.disabled),
              busy,
              label,
              onChange: s.header.onChange,
            }}
          />
          <span id={id}>{label}</span>
        </label>
      ) : (
        <h3 id={id} className="flex items-center gap-2 text-sm font-medium">
          <LockIcon className="size-4 text-muted-foreground" aria-hidden /> {label}
        </h3>
      )}
      {s.help ? <p className="pl-6 text-xs text-muted-foreground">{s.help}</p> : null}
      {s.nodes.length ? (
        <RowTree label={s.title} nodes={s.nodes} />
      ) : s.empty ? (
        <p className="pl-6 text-xs text-muted-foreground">{s.empty}</p>
      ) : null}
      {s.total > shown ? (
        <Button variant="ghost" size="xs" className="ml-6" onClick={onMore}>
          Show {Math.min(PAGE, s.total - shown).toLocaleString()} more
        </Button>
      ) : null}
    </section>
  );
}
