"use client";

import { useEffect, useMemo, useState } from "react";
import { diffLineRows, normalizeText, SYNC_MAX_CHARS, SYNC_TIMEOUT_MS, type LineDiff } from "@/lib/diff";
import { afterPaint } from "@/lib/after-paint";
import { lineMarks, type LineMarks } from "@/lib/line-marks";
import { useFileChange } from "./changes-context";

/** A lone CR on screen splits a line for the diff (normalizeText) but not there: line numbers would not match. */
const LONE_CR = /\r(?!\n)/;
// JSON's own diff (`base`) of texts up to SYNC_MAX_CHARS runs in render with SYNC_TIMEOUT_MS first.

type Source = { diff: LineDiff } | { base: string; shown: string };

/**
 * The open file's changes since it was last viewed, as line marks on the text on
 * screen (lib/line-marks.ts), or null: nothing changed, the diff is not ready or
 * gave up, or `shown` is not the text the banner compared.
 *
 * - `shown`: the text on screen; undefined = the file as fetched by the change
 *   tracker (the chunked text viewer shows the file itself, never another text).
 * - `base`: compare `shown` with this text instead of the banner's diff (JSON's
 *   pretty-printed view compares the two versions pretty-printed).
 * - `words`: word highlights in modified lines (off for the large-file views).
 * - `skip`: not wanted (the caller has its marks from elsewhere).
 *
 * The marks of the banner's diff are computed with it (lineMarks is cheap and time-boxed; the
 * diff of a large file itself comes after paint, use-version-diffs.ts). A diff of its own
 * (`base`) runs in render when small and quick, otherwise after paint.
 */
export function useLineMarks(shown: string | undefined, opts: { base?: string | null; words?: boolean; skip?: boolean } = {}): LineMarks | null {
  const fc = useFileChange();
  const words = opts.words !== false;
  const changed = Boolean(fc?.changed) && !opts.skip;
  const currentText = fc?.currentText ?? null;
  const lineDiff = fc?.lineDiff ?? null;
  const override = opts.base !== undefined;
  const base = opts.base ?? null;

  // What is compared: the banner's diff when the text on screen is the one it compared.
  // (A lone CR in the earlier version only shifts its line numbers: fine.)
  const source = useMemo<Source | null>(() => {
    if (!changed) return null;
    if (override) {
      if (base === null || shown === undefined || LONE_CR.test(shown)) return null;
      return { base, shown };
    }
    if (!lineDiff || currentText === null || LONE_CR.test(currentText)) return null;
    if (shown !== undefined && shown !== currentText && normalizeText(shown) !== normalizeText(currentText)) return null;
    return { diff: lineDiff };
  }, [changed, override, base, shown, lineDiff, currentText]);

  /** Marks computed in render: from the banner's diff, or a small diff of its own that finished in time. */
  const sync = useMemo<{ marks: LineMarks | null } | null>(() => {
    if (!source) return null;
    if ("diff" in source) return { marks: source.diff.hunks.length ? lineMarks(source.diff, { words }) : null };
    if (source.base.length + source.shown.length > SYNC_MAX_CHARS) return null;
    const d = diffLineRows(source.base, source.shown, { normalize: true, timeoutMs: SYNC_TIMEOUT_MS });
    return d ? { marks: d.hunks.length ? lineMarks(d, { words }) : null } : null;
  }, [source, words]);

  const [state, setState] = useState<{ source: Source; words: boolean; marks: LineMarks | null } | null>(null);
  useEffect(() => {
    if (!source || sync || "diff" in source) return;
    return afterPaint(() => {
      const diff = diffLineRows(source.base, source.shown, { normalize: true });
      setState({ source, words, marks: diff && diff.hunks.length ? lineMarks(diff, { words }) : null });
    });
  }, [source, sync, words]);

  if (!source) return null;
  if (sync) return sync.marks;
  return state && state.source === source && state.words === words ? state.marks : null;
}
