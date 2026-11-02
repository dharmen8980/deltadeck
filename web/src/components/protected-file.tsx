"use client";

// Hidden files opened from the tree: a slim notice for git-ignored and ignore-list files, and a
// confirm-then-read-only view for protected (deny-list) files. Protected files are never
// searched, tracked, edited, exported or copied for AI; their text is fetched with reveal=1 only
// after the user said so.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { EyeOffIcon, LockIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { computeGaps, MAX_CHUNK, mergeSegments, type Seg } from "@/components/viewers/text-viewer";
import { ViewerError, ViewerLoading } from "@/components/viewers/common";
import { navigate } from "@/hooks/use-route";
import { api, errorMessage, type FileInfo, type HiddenReason } from "@/lib/api";
import { dirname } from "@/lib/paths";

/** Protected files the user chose to see, for this session only (never saved). */
const confirmed = new Set<string>();

const NOTICES: Record<Exclude<HiddenReason, "deny">, string> = {
  git: "Ignored by git: not searched and not tracked for changes.",
  ignore: "On the viewer's ignore list: read-only, not searched or tracked.",
};

const NO_TEXT_KINDS = new Set(["image", "pdf", "xlsx", "docx", "binary"]);

export function HiddenNotice({ reason }: { reason: Exclude<HiddenReason, "deny"> }) {
  return (
    <div className="no-print flex items-center gap-2 border-b bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground">
      <EyeOffIcon className="size-3.5 shrink-0" aria-hidden />
      {NOTICES[reason]}
    </div>
  );
}

export function ProtectedFileView({ file, reloadKey }: { file: FileInfo; reloadKey: number }) {
  const [shown, setShown] = useState(() => confirmed.has(file.path));
  if (!shown) {
    return (
      <div className="p-6">
        <Alert>
          <LockIcon />
          <AlertTitle>This file may contain secrets</AlertTitle>
          <AlertDescription>
            <p>
              <code className="text-xs">{file.path}</code> matches the deny list, so it is never searched, tracked or
              copied. Show it read-only?
            </p>
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                onClick={() => {
                  confirmed.add(file.path);
                  setShown(true);
                }}
              >
                Show contents
              </Button>
              <Button
                size="sm"
                variant="outline"
                // opened from a pasted link or a new tab: no page to go back to, so show its folder
                onClick={() => (window.history.length > 1 ? window.history.back() : navigate(dirname(file.path)))}
              >
                Back
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      </div>
    );
  }
  if (NO_TEXT_KINDS.has(file.kind)) {
    return <ViewerError title="Cannot show this file" message="Protected files are shown as text only, and this one is not text." />;
  }
  return <RevealedText key={`${file.path}:${reloadKey}`} file={file} />;
}

function RevealedText({ file }: { file: FileInfo }) {
  const [state, setState] = useState<{ segs: Seg[]; size: number } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const ctrl = new AbortController();
    api.revealedText(file.path, ctrl.signal).then(
      (r) => setState({ segs: mergeSegments([], r.segments), size: r.size }),
      (e) => {
        if ((e as Error).name !== "AbortError") setError(e);
      },
    );
    return () => ctrl.abort();
  }, [file.path]);
  const gaps = useMemo(() => (state ? computeGaps(state.segs, state.size) : []), [state]);
  const loadGap = useCallback(
    async (start: number, end: number) => {
      setBusy(true);
      try {
        const r = await api.revealedTextRange(file.path, start, Math.min(MAX_CHUNK, Math.max(1, end - start)));
        setState((st) => (st ? { ...st, segs: mergeSegments(st.segs, r.segments) } : st));
      } catch (e) {
        setError(e);
      } finally {
        setBusy(false);
      }
    },
    [file.path],
  );
  if (error) return <ViewerError message={errorMessage(error)} />;
  if (!state) return <ViewerLoading />;
  const rows: ReactNode[] = [];
  let pos = 0;
  const gapRow = (g: { start: number; end: number }) => (
    <div key={`gap-${g.start}`} className="my-1 px-2">
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void loadGap(g.start, g.end)}>
        Load more ({(g.end - g.start).toLocaleString()} bytes)
      </Button>
    </div>
  );
  for (const s of state.segs) {
    const gap = gaps.find((g) => g.start === pos && g.end === s.start);
    if (gap) rows.push(gapRow(gap));
    s.lines.forEach((line, i) =>
      rows.push(
        <div key={`${s.start}-${i}`} className="flex">
          <span className="sticky left-0 min-w-12 shrink-0 bg-background pr-3 pl-2 text-right text-muted-foreground/70 select-none">
            {s.start_line + i}
          </span>
          <span className="pr-4 whitespace-pre">{line}</span>
        </div>,
      ),
    );
    pos = Math.max(pos, s.end);
  }
  const tail = gaps.find((g) => g.start === pos);
  if (tail) rows.push(gapRow(tail));
  return (
    <div>
      <div className="no-print flex items-center gap-2 border-b bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground">
        <LockIcon className="size-3.5 shrink-0" aria-hidden />
        Protected file, shown read-only: not searched, tracked or copied.
      </div>
      <pre className="overflow-x-auto py-3 font-mono text-[13px] leading-5">{rows}</pre>
    </div>
  );
}
