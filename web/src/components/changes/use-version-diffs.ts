"use client";

import { useEffect, useMemo, useState } from "react";
import { diffVersions, SYNC_MAX_CHARS, SYNC_TIMEOUT_MS } from "@/lib/diff";
import { afterPaint } from "@/lib/after-paint";

type Diffs = ReturnType<typeof diffVersions>;

/**
 * The diffs of two versions (diffVersions, pure and time-boxed), for the banner and the marks.
 * Markdown's are computed in render (its marks are part of the rendered tree). The others are
 * too when the texts are small and the diff is quick (no flicker on a live change: the marks of
 * the new version arrive with it); otherwise after paint with the full budget, so the code is on
 * screen before a large file is diffed (`pending` meanwhile).
 */
export function useVersionDiffs(
  baseText: string | null,
  currentText: string | null,
  active: boolean,
  markdown: boolean,
): { diffs: Diffs | null; pending: boolean } {
  const both = active && baseText !== null && currentText !== null;
  const small = both && (baseText as string).length + (currentText as string).length <= SYNC_MAX_CHARS;
  const sync = useMemo<Diffs | null>(() => {
    if (!both) return null;
    if (markdown) return diffVersions(baseText as string, currentText as string, true);
    if (!small) return null;
    const d = diffVersions(baseText as string, currentText as string, false, { timeoutMs: SYNC_TIMEOUT_MS });
    // Gave up within the short budget: the full one runs after paint.
    return d.lineDiff ? d : null;
  }, [both, small, baseText, currentText, markdown]);
  const [late, setLate] = useState<{ base: string; cur: string; d: Diffs } | null>(null);
  const lateOk = Boolean(late && late.base === baseText && late.cur === currentText);
  const needLate = both && !markdown && !sync && !lateOk;
  useEffect(() => {
    if (!needLate) return;
    const b = baseText as string;
    const c = currentText as string;
    return afterPaint(() => setLate({ base: b, cur: c, d: diffVersions(b, c, false) }));
  }, [needLate, baseText, currentText]);
  const diffs = !both ? null : sync ?? (lateOk ? late!.d : null);
  return { diffs, pending: needLate };
}
