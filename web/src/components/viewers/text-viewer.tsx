"use client";

import { createContext, Fragment, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, Loader2Icon, WrapTextIcon } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useRoute } from "@/hooks/use-route";
import { api, errorMessage, rawText, type TextResponse, type TextSegment } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useLineMarks } from "@/components/changes/use-line-marks";
import { useFindId, useFindSource } from "@/components/find/use-find-source";
import { lineAtViewportTop } from "@/lib/find/skip";
import { HIGHLIGHT_MAX_BYTES, parseLineHash } from "@/lib/code-lines";
import { CHANGE_UI, clearWordHighlights, setWordHighlights, textRanges } from "@/lib/code-marks-dom";
import { anchorsBetween, removedLabel, type LineMarks, type RemovedRun } from "@/lib/line-marks";
import { ViewerError, ViewerLoading, type ViewerProps } from "./common";

const CHUNK = 256 * 1024;
export const MAX_CHUNK = 1024 * 1024; // server caps length at 1 MB
/** Changes in unloaded lines: the chunks around this many are loaded right away (the rest on request). */
const AUTO_CHANGE_LOADS = 4;
/** Find in a file not all loaded reads this much of it (the bar says so when there is more). */
const FIND_TEXT_MAX = 32 * 1024 * 1024;

export interface Seg extends TextSegment {
  lines: string[];
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function toSeg(s: TextSegment): Seg {
  const body = s.text.endsWith("\n") ? s.text.slice(0, -1) : s.text;
  return { ...s, lines: s.text.length === 0 ? [] : body.split("\n") };
}

/** Merge segments by byte offset. Segment boundaries are always line boundaries. */
export function mergeSegments(existing: Seg[], incoming: TextSegment[]): Seg[] {
  const all = [...existing, ...incoming.map(toSeg)].sort((a, b) => a.start - b.start);
  const out: Seg[] = [];
  for (const cur of all) {
    const last = out[out.length - 1];
    if (!last || cur.start > last.end) {
      out.push(cur);
      continue;
    }
    if (cur.end <= last.end) continue; // fully contained
    const tailBytes = enc.encode(cur.text).subarray(last.end - cur.start);
    out[out.length - 1] = toSeg({
      start: last.start,
      end: cur.end,
      start_line: last.start_line,
      text: last.text + dec.decode(tailBytes),
    });
  }
  return out;
}

export function computeGaps(segs: Seg[], size: number): { start: number; end: number }[] {
  const gaps: { start: number; end: number }[] = [];
  let pos = 0;
  for (const s of segs) {
    if (s.start > pos) gaps.push({ start: pos, end: s.start });
    pos = Math.max(pos, s.end);
  }
  if (pos < size) gaps.push({ start: pos, end: size });
  return gaps;
}

/** The changes since the last view, as the segments draw them. */
interface SegMarks {
  marks: LineMarks;
  /** by beforeLine (null: at the end), with the run's index */
  removedAt: Map<number | null, number>;
  anchors: Set<number>;
  /** tints and openable removals (otherwise gutter bars and removal ticks only) */
  full: boolean;
}

/** The opened removals (a context, so opening one re-renders its marker only, not every line). */
const OpenRunsCtx = createContext<{ open: ReadonlySet<number>; onToggle: (run: number) => void }>({
  open: new Set(),
  onToggle: () => {},
});

/** A removal between two lines: zero-height until opened, like the highlighted code view's (lib/code-marks-dom.ts). */
function RemovedLines({ run, index, cm }: { run: RemovedRun; index: number; cm: SegMarks }) {
  const { open: opened, onToggle } = useContext(OpenRunsCtx);
  const label = removedLabel(run);
  const open = cm.full && opened.has(index);
  const atEnd = run.beforeLine === null;
  return (
    <div
      className={cn(CHANGE_UI, "code-removed", atEnd && "code-removed-end", open && "is-open")}
      data-change-hunk={atEnd ? "" : undefined}
      data-removed-before={atEnd ? "end" : run.beforeLine}
      title={cm.full ? undefined : label}
    >
      {cm.full ? (
        <button
          type="button"
          className="code-removed-toggle"
          aria-expanded={open}
          aria-label={`${label}. ${open ? "Hide" : "Show"} them`}
          title={`${label}: click to ${open ? "hide" : "show"} them`}
          onClick={() => onToggle(index)}
        >
          −{run.count.toLocaleString()}
        </button>
      ) : (
        <span className="sr-only">{label}</span>
      )}
      {open ? (
        <div className="code-removed-lines" role="group" aria-label={`${label} (not in the current version)`}>
          {run.lines.map((t, i) => (
            <div key={i} className="code-removed-line" data-old-line={run.oldStart + i}>
              {t || " "}
            </div>
          ))}
          {run.count > run.lines.length ? (
            <div className="code-removed-more">
              … {(run.count - run.lines.length).toLocaleString()} more (Show changes has them all)
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const SegmentView = memo(function SegmentView({
  seg,
  target,
  onLineClick,
  cm,
  last,
}: {
  seg: Seg;
  target: number | null;
  onLineClick: (n: number) => void;
  cm: SegMarks | null;
  /** the segment ends the file (a removal at the end goes after it) */
  last: boolean;
}) {
  const endRun = last ? cm?.removedAt.get(null) : undefined;
  return (
    <div className="py-1">
      {seg.lines.map((line, i) => {
        const n = seg.start_line + i;
        const kind = cm?.marks.kinds.get(n);
        const run = cm?.removedAt.get(n);
        return (
          <Fragment key={n}>
            {cm && run !== undefined ? <RemovedLines run={cm.marks.removed[run]} index={run} cm={cm} /> : null}
            <div
              id={`L${n}`}
              data-change={kind}
              data-change-hunk={cm?.anchors.has(n) ? "" : undefined}
              className={cn(
                "text-line flex hover:bg-muted/50",
                n === target && "is-target bg-yellow-200/60 dark:bg-yellow-500/25",
              )}
            >
              <span
                className="text-line-no sticky left-0 min-w-[var(--gutter)] shrink-0 cursor-pointer select-none bg-background pr-3 pl-2 text-right text-muted-foreground/70 hover:text-foreground"
                onClick={() => onLineClick(n)}
              >
                {n}
              </span>
              <span className="text-line-body pr-4">
                {kind ? <span className={cn(CHANGE_UI, "sr-only select-none")}>{kind} line: </span> : null}
                {line || " "}
              </span>
            </div>
          </Fragment>
        );
      })}
      {cm && endRun !== undefined ? <RemovedLines run={cm.marks.removed[endRun]} index={endRun} cm={cm} /> : null}
    </div>
  );
});

/**
 * The chunked text view. `marks`: the changes since the last view when the caller has them
 * (the code viewer's large-file path); otherwise they are taken from the open file's state.
 */
export function TextViewer({ file, reloadKey, marks: given }: ViewerProps & { marks?: LineMarks | null }) {
  const { hash, setHash } = useRoute();
  const target = parseLineHash(hash);
  // `gen`: a new text (the first load, a reload), not a part of the same one loaded
  const [state, setState] = useState<{ path: string; size: number; segs: Seg[]; gen: number } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [wrap, setWrap] = useState(false);
  const requestedLines = useRef(new Set<number>());

  const applyResponse = useCallback((r: TextResponse, replace: boolean) => {
    setState((prev) => {
      const base = !replace && prev && prev.path === r.path ? prev.segs : [];
      const gen = (prev?.gen ?? 0) + (replace || !prev || prev.path !== r.path ? 1 : 0);
      return { path: r.path, size: r.size, segs: mergeSegments(base, r.segments), gen };
    });
  }, []);

  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Initial load. When the file changes on disk (reloadKey), reload in place:
  // fetch head+tail again and re-request every byte range the reader had
  // loaded, so "Load 256 KB" chunks and #L jumps survive (e.g. a growing log).
  // Only if the file shrank do we start over.
  useEffect(() => {
    const ctrl = new AbortController();
    const prev = stateRef.current && stateRef.current.path === file.path ? stateRef.current : null;
    (async () => {
      const r = await api.textInitial(file.path, ctrl.signal);
      if (!prev || r.size < prev.size) {
        requestedLines.current.clear();
        setError(null);
        applyResponse(r, true);
        return;
      }
      const have = mergeSegments([], r.segments);
      const covered = (pos: number) => have.find((sg) => sg.start <= pos && pos < sg.end);
      const extra: TextSegment[] = [];
      let budget = 16 * MAX_CHUNK; // never re-fetch more than this in one reload
      for (const seg of prev.segs) {
        let pos = seg.start;
        while (pos < seg.end && budget > 0) {
          const c = covered(pos);
          if (c) {
            pos = c.end;
            continue;
          }
          // start one byte early so the server's snap-forward lands exactly on `pos`
          const from = Math.max(0, pos - 1);
          const length = Math.min(MAX_CHUNK, seg.end - from);
          const rr = await api.textRange(file.path, from, length, ctrl.signal);
          const got = rr.segments[0];
          if (!got || got.end <= pos) break;
          extra.push(got);
          budget -= got.end - got.start;
          pos = got.end;
        }
      }
      setError(null);
      applyResponse({ ...r, segments: [...r.segments, ...extra] }, true);
    })().catch((e) => {
      if ((e as Error).name !== "AbortError") setError(e);
    });
    return () => ctrl.abort();
  }, [file.path, reloadKey, applyResponse]);

  const current = state && state.path === file.path ? state : null;
  const gaps = useMemo(() => (current ? computeGaps(current.segs, current.size) : []), [current]);

  const targetLoaded = useMemo(() => {
    if (!current || target === null) return true;
    return current.segs.some((s) => target >= s.start_line && target < s.start_line + s.lines.length);
  }, [current, target]);

  // '#L<n>' pointing into an unloaded region: fetch the chunk around that line.
  useEffect(() => {
    if (!current || target === null || targetLoaded || gaps.length === 0) return;
    if (requestedLines.current.has(target)) return;
    requestedLines.current.add(target);
    const ctrl = new AbortController();
    api
      .textLine(file.path, target, ctrl.signal)
      .then((r) => applyResponse(r, false))
      .catch((e) => {
        if ((e as Error).name !== "AbortError") toast.error(`Could not load line ${target}: ${errorMessage(e)}`);
      });
    return () => ctrl.abort();
  }, [current, target, targetLoaded, gaps.length, file.path, applyResponse]);

  // Scroll to the target line once it is rendered (once per target, so live
  // reloads keep the reader's scroll position).
  const scrolledTo = useRef("");
  useEffect(() => {
    if (target === null || !targetLoaded) return;
    const key = `${file.path}#${target}`;
    if (scrolledTo.current === key) return;
    const el = document.getElementById(`L${target}`);
    if (!el) return;
    scrolledTo.current = key;
    el.scrollIntoView({ block: "center" });
  }, [target, targetLoaded, current?.segs, file.path]);

  const loadRange = async (key: string, start: number, end: number) => {
    setBusy(key);
    try {
      const length = Math.min(MAX_CHUNK, Math.max(1, end - start));
      const r = await api.textRange(file.path, start, length);
      applyResponse(r, false);
    } catch (e) {
      toast.error(`Could not load more text: ${errorMessage(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const onLineClick = useCallback((n: number) => setHash(`L${n}`, true), [setHash]);

  // ---------- changes since the last view ----------
  const full = file.size <= HIGHLIGHT_MAX_BYTES;
  const own = useLineMarks(undefined, { words: full, skip: given !== undefined });
  const marks = given !== undefined ? given : own;
  const [opened, setOpened] = useState<{ of: LineMarks | null; runs: ReadonlySet<number> }>({ of: null, runs: new Set() });
  const openRuns = opened.of === marks ? opened.runs : null;
  const onToggle = useCallback(
    (run: number) =>
      setOpened((o) => {
        const runs = new Set(o.of === marks ? o.runs : []);
        if (!runs.delete(run)) runs.add(run);
        return { of: marks, runs };
      }),
    [marks],
  );
  const cm = useMemo<SegMarks | null>(() => {
    if (!marks) return null;
    const removedAt = new Map<number | null, number>();
    marks.removed.forEach((r, i) => removedAt.set(r.beforeLine, i));
    return { marks, removedAt, anchors: new Set(marks.anchors), full };
  }, [marks, full]);
  const openCtx = useMemo(() => ({ open: openRuns ?? new Set<number>(), onToggle }), [openRuns, onToggle]);

  // Lines of each gap (between the loaded segments), and the changes in them.
  const gapLines = useMemo(() => {
    const out = new Map<number, { from: number; to: number; anchors: number[] }>();
    if (!current || !marks) return out;
    for (const g of gaps) {
      const prev = current.segs.findLast((sg) => sg.end <= g.start);
      const next = current.segs.find((sg) => sg.start >= g.end);
      const from = prev ? prev.start_line + prev.lines.length : 1;
      const to = next ? next.start_line - 1 : marks.lineCount;
      out.set(g.start, { from, to, anchors: anchorsBetween(marks.anchors, from, to) });
    }
    return out;
  }, [current, gaps, marks]);

  // Changes in unloaded lines: load the chunks around the first few (one at a time), so they are
  // marked and n / p reach them; the others' gaps say so and load on request.
  const autoLoaded = useRef<{ of: LineMarks | null; lines: Set<number> }>({ of: null, lines: new Set() });
  useEffect(() => {
    if (!marks) return;
    if (autoLoaded.current.of !== marks) autoLoaded.current = { of: marks, lines: new Set() };
    const done = autoLoaded.current.lines;
    if (done.size >= AUTO_CHANGE_LOADS) return;
    let line: number | undefined;
    for (const g of gapLines.values()) {
      line = g.anchors.find((n) => !done.has(n));
      if (line !== undefined) break;
    }
    if (line === undefined) return;
    done.add(line);
    const ctrl = new AbortController();
    api
      .textLine(file.path, line, ctrl.signal)
      .then((r) => applyResponse(r, false))
      .catch((e) => {
        if ((e as Error).name === "AbortError") done.delete(line);
      });
    return () => ctrl.abort();
  }, [marks, gapLines, file.path, applyResponse]);

  const loadChangeAt = async (key: string, line: number) => {
    setBusy(key);
    try {
      applyResponse(await api.textLine(file.path, line), false);
    } catch (e) {
      toast.error(`Could not load line ${line}: ${errorMessage(e)}`);
    } finally {
      setBusy(null);
    }
  };
  const linesRef = useRef<HTMLDivElement>(null);
  const segs = current?.segs;

  // Find in the file (components/find/): the whole text, also the parts not loaded (read in one
  // go from /api/raw); going to a match there loads its chunk.
  const findId = useFindId();
  const findChanged = useFindSource(
    () => ({
      kind: "lines",
      root: () => linesRef.current,
      key: () => {
        const st = stateRef.current;
        return `${findId}:${st ? st.gen : "-"}`;
      },
      text: async (signal) => {
        const st = stateRef.current;
        if (!st) return { text: "" };
        if (computeGaps(st.segs, st.size).length === 0) return { text: st.segs.map((sg) => sg.text).join("") };
        const r = await rawText(file.path, FIND_TEXT_MAX, signal);
        return { text: r.text, note: r.truncated ? `Searched the first ${formatBytes(FIND_TEXT_MAX)} of ${formatBytes(st.size)}` : undefined };
      },
      lines: (root) => {
        const map = new Map<number, HTMLElement>();
        root.querySelectorAll<HTMLElement>(".text-line").forEach((el) => {
          const body = el.querySelector<HTMLElement>(".text-line-body");
          if (body) map.set(Number(el.id.slice(1)), body);
        });
        return (n) => map.get(n) ?? null;
      },
      lineAtTop: (root) => {
        const el = lineAtViewportTop(root, ".text-line");
        return el ? Number(el.id.slice(1)) || null : null;
      },
      ensureLine: async (n) => {
        applyResponse(await api.textLine(file.path, n), false);
      },
    }),
    [findId, file.path, applyResponse],
  );
  const gen = current?.gen;
  useEffect(() => {
    if (gen !== undefined) findChanged();
  }, [gen, findChanged]);
  // Changed words: CSS custom highlights over the rendered lines (no extra elements).
  useEffect(() => {
    const root = linesRef.current;
    if (!root || !marks || !full || !marks.words.size || !segs) return;
    const owner = {};
    const ranges: Range[] = [];
    for (const [n, spans] of marks.words) {
      const body = root.querySelector<HTMLElement>(`[id="L${n}"] .text-line-body`);
      if (body) ranges.push(...textRanges(body, spans));
    }
    setWordHighlights(owner, ranges);
    return () => clearWordHighlights(owner);
  }, [marks, full, segs]);

  if (!current) {
    if (error) return <ViewerError message={errorMessage(error)} file={file} />;
    return <ViewerLoading />;
  }

  const loadedBytes = current.segs.reduce((n, s) => n + (s.end - s.start), 0);
  const lastSeg = current.segs[current.segs.length - 1];
  const maxLine = lastSeg ? lastSeg.start_line + lastSeg.lines.length : 1;
  const gutter = `calc(${String(maxLine).length}ch + 1.25rem)`;
  const items: React.ReactNode[] = [];
  const order = [
    ...current.segs.map((s) => ({ type: "seg" as const, start: s.start, seg: s })),
    ...gaps.map((g) => ({ type: "gap" as const, start: g.start, gap: g })),
  ].sort((a, b) => a.start - b.start);

  for (const it of order) {
    if (it.type === "seg") {
      items.push(
        <SegmentView
          key={`s${it.seg.start}`}
          seg={it.seg}
          target={target}
          onLineClick={onLineClick}
          cm={cm}
          last={it.seg.end >= current.size}
        />,
      );
    } else {
      const g = it.gap;
      const gapSize = g.end - g.start;
      const k = `g${g.start}`;
      // Requests start one byte early so the server's "snap forward past the
      // next newline" lands exactly on the gap start.
      const fromStart = Math.max(0, g.start - 1);
      // Changes in these lines: a stop for n / p, and a button that loads the first of them.
      const inGap = gapLines.get(g.start)?.anchors ?? [];
      items.push(
        <div
          key={k}
          data-change-hunk={inGap.length ? "" : undefined}
          className="text-gap no-print sticky left-0 my-2 flex flex-wrap items-center gap-2 border-y border-dashed bg-muted/40 px-3 py-2 font-sans text-xs text-muted-foreground"
        >
          <span>
            {formatBytes(gapSize)} not loaded
            {target !== null && !targetLoaded ? " (loading target line...)" : ""}
          </span>
          {inGap.length ? (
            <Button
              size="sm"
              variant="outline"
              className="border-amber-500/50"
              disabled={busy !== null}
              onClick={() => loadChangeAt(`${k}-change`, inGap[0])}
              title={`Changed since your last visit: line${inGap.length === 1 ? "" : "s"} ${inGap.slice(0, 5).join(", ")}${inGap.length > 5 ? ", …" : ""}`}
            >
              {busy === `${k}-change` ? <Loader2Icon className="animate-spin" /> : <span className="size-1.5 rounded-full bg-amber-500" aria-hidden />}
              {inGap.length === 1 ? "1 change" : `${inGap.length.toLocaleString()} changes`} in these lines: load
            </Button>
          ) : null}
          {g.start > 0 ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => loadRange(`${k}-down`, fromStart, Math.min(g.end, g.start + CHUNK))}
            >
              {busy === `${k}-down` ? <Loader2Icon className="animate-spin" /> : <ArrowDownIcon />}
              Load 256 KB below
            </Button>
          ) : null}
          {g.end < current.size ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                loadRange(`${k}-up`, Math.max(fromStart, g.end - CHUNK - 1), g.end)
              }
            >
              {busy === `${k}-up` ? <Loader2Icon className="animate-spin" /> : <ArrowUpIcon />}
              Load 256 KB above
            </Button>
          ) : null}
          {gapSize <= MAX_CHUNK - 2 ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => loadRange(`${k}-all`, fromStart, g.end + 1)}
            >
              Load all {formatBytes(gapSize)}
            </Button>
          ) : null}
        </div>,
      );
    }
  }

  return (
    <div className="flex flex-col">
      <div className="no-print sticky top-[var(--header-h,3.5rem)] z-10 flex items-center gap-2 border-b bg-background/95 px-4 py-1.5 text-xs text-muted-foreground backdrop-blur">
        <span>
          {gaps.length === 0
            ? `Whole file loaded (${formatBytes(current.size)})`
            : `Showing ${formatBytes(loadedBytes)} of ${formatBytes(current.size)}`}
        </span>
        {gaps.length > 0 ? <Badge variant="secondary">large file</Badge> : null}
        <div className="ml-auto">
          <Button
            size="sm"
            variant={wrap ? "secondary" : "ghost"}
            onClick={() => setWrap((w) => !w)}
            aria-pressed={wrap}
          >
            <WrapTextIcon /> Wrap
          </Button>
        </div>
      </div>
      <div
        ref={linesRef}
        className={cn(
          "text-lines overflow-x-auto font-mono text-[13px] leading-[1.55]",
          wrap ? "[&_.text-line-body]:whitespace-pre-wrap [&_.text-line-body]:break-all" : "[&_.text-line-body]:whitespace-pre",
          cm && !full && "code-marks-bars",
        )}
      >
        <div
          className={cn(!wrap && "w-max min-w-full")}
          style={{ ["--gutter" as string]: gutter }}
        >
          <OpenRunsCtx.Provider value={openCtx}>{items}</OpenRunsCtx.Provider>
        </div>
      </div>
    </div>
  );
}
