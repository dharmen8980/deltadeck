"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon, GitCommitHorizontalIcon, GitCompareIcon, HistoryIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DiffView } from "@/components/diff/diff-view";
import { type FileKind } from "@/lib/api";
import { hasLineMarks, isMarkdownText, isTracked } from "@/lib/change-rules";
import { sectionCount, summarizeChange } from "@/lib/diff";
import { formatRelative } from "@/lib/format";
import { isTypingTarget } from "@/lib/keys";
import type { GitCompareState } from "@/components/git/git-context";
import { cn } from "@/lib/utils";
import type { FileChangeState } from "./changes-context";
import { SummaryText, summaryDetail, type SummaryDetail } from "./change-summary";

/**
 * The marked changes on screen: highlighted blocks and removal markers, the first line of
 * each run of changed code lines (and a removal at its end), or diff hunks.
 */
const TARGETS =
  ".markdown-body > [data-change], .markdown-body > .md-removed, .markdown-body > .md-removed-end, [data-change-hunk], [data-diff-hunk]";
/** Matches the scroll-margin-top of the targets (globals.css, DiffView). */
const TOP = 96;

/** Scrolls to the next (1) or previous (-1) change below/above the top of the view. */
function jumpToChange(dir: 1 | -1, first = false): boolean {
  const els = Array.from(document.querySelectorAll<HTMLElement>(TARGETS)).filter((el) => el.getClientRects().length > 0);
  if (!els.length) return false;
  const target = first
    ? els[0]
    : dir > 0
      ? els.find((el) => el.getBoundingClientRect().top > TOP + 2)
      : els.findLast((el) => el.getBoundingClientRect().top < TOP - 2);
  (target ?? (dir > 0 ? els[0] : els[els.length - 1])).scrollIntoView({ block: "start" });
  return true;
}

/** What changed, in a few words (most specific first). */
function detail(state: FileChangeState, kind: FileKind): SummaryDetail {
  const { markdownDiff, lineDiff, baseText, currentText, sizeDelta, tooLarge } = state;
  if (state.diffPending) return { text: "comparing…" };
  return summaryDetail(
    summarizeChange({
      markdown: isMarkdownText(kind),
      textKind: isTracked(kind),
      baseText,
      currentText,
      lineDiff,
      markdownDiff,
      sizeDelta,
      tooLarge,
      lineMarks: hasLineMarks(kind),
    }),
  );
}

const sameDetail = (a: SummaryDetail, b: SummaryDetail) =>
  a.text === b.text && JSON.stringify(a.parts ?? null) === JSON.stringify(b.parts ?? null);

/** The git variant's detail: the file against the last commit. */
function gitDetailOf(g: GitCompareState, kind: FileKind): SummaryDetail {
  if (g.error) return { text: g.error };
  if (g.loading) return { text: "loading the last commit's version..." };
  if (g.isDeleted) return { text: "deleted since the last commit" };
  if (g.noText) return { text: g.head?.head?.binary ? "binary file, not compared" : "too large to compare" };
  if (g.same) return { text: "no changes since the last commit" };
  const d = detail(g, kind);
  return g.isNew ? { ...d, text: `not in the last commit · ${d.text}`, parts: d.parts } : d;
}

/** Which comparison the banner shows: since the last visit, or since the last commit. */
export type BannerMode = "seen" | "git";

function ModeSwitch({ mode, onMode }: { mode: BannerMode; onMode: (m: BannerMode) => void }) {
  return (
    <span role="tablist" aria-label="Compare with" className="inline-flex rounded-md border border-sky-500/30 p-px">
      {(
        [
          ["seen", "Since last viewed"],
          ["git", "Since last commit"],
        ] as const
      ).map(([m, label]) => (
        <button
          key={m}
          type="button"
          role="tab"
          aria-selected={mode === m}
          className={cn(
            "cursor-pointer rounded-[5px] px-1.5 py-px",
            mode === m ? "bg-sky-500/15 font-medium" : "text-sky-800/70 hover:text-sky-900 dark:text-sky-300/70 dark:hover:text-sky-100",
          )}
          onClick={() => onMode(m)}
        >
          {label}
        </button>
      ))}
    </span>
  );
}

/**
 * Slim notice under the file header (sticky below it): the file changed since it was last viewed,
 * or (with `git`) how it differs from the last commit. `onMode` shows the switch between the two.
 */
export function ChangeBanner({
  state,
  kind,
  git,
  onMode,
}: {
  state: FileChangeState;
  kind: FileKind;
  git?: GitCompareState;
  onMode?: (m: BannerMode) => void;
}) {
  const { baseViewedAt, baseText, currentText, lineDiff, markdownDiff, showDiff, setShowDiff, markSeen } = state;
  const canDiff = baseText !== null && currentText !== null && lineDiff !== null && !git?.isDeleted;
  const live = git ? gitDetailOf(git, kind) : detail(state, kind);
  // While a newer version is diffed (after paint, large files), the last summary stays (no "comparing…" flash).
  const pending = Boolean((git ?? state).diffPending);
  const [kept, setKept] = useState<{ git: boolean; d: SummaryDetail } | null>(null);
  if (!pending && (!kept || kept.git !== Boolean(git) || !sameDetail(kept.d, live))) setKept({ git: Boolean(git), d: live });
  const d = pending && kept && kept.git === Boolean(git) ? kept.d : live;
  // Something to jump to: highlighted blocks in the article, marked lines in the code, or the hunks of the open diff.
  const canJump =
    ((showDiff || git?.isDeleted) && (canDiff || Boolean(git?.isDeleted))) ||
    (isMarkdownText(kind) && markdownDiff !== null && sectionCount(markdownDiff) > 0) ||
    (hasLineMarks(kind) && lineDiff !== null && lineDiff.hunks.length > 0);
  const when = git
    ? git.head?.headCommit ?? null
    : baseViewedAt !== null
      ? formatRelative(baseViewedAt / 1000)
      : null;
  const title = git ? "Since the last commit" : "Changed since your last visit";
  const sentence = `${title}${when ? ` (${when})` : ""}: ${d.text}`;
  const tooltip = (
    git
      ? [sentence, "Compared with the version in the last commit (HEAD); staged and unstaged changes both count."]
      : [
          sentence,
          state.baseIsOlder ? "Compared with the copy saved when you last opened it; you marked it as seen later." : null,
          "This version counts as seen when you leave the file, or with Mark as seen.",
        ]
  )
    .filter(Boolean)
    .join("\n");
  const Icon = git ? GitCommitHorizontalIcon : HistoryIcon;

  // Line-marked kinds whose view has no marks on screen (JSON's tree, marks not applicable): the diff instead.
  const diffInstead = hasLineMarks(kind) && canDiff && !showDiff;
  const jump = useCallback(
    (dir: 1 | -1, first = false) => {
      if (jumpToChange(dir, first)) return true;
      if (!diffInstead) return false;
      setShowDiff(true);
      return true;
    },
    [diffInstead, setShowDiff],
  );
  // n / p: next / previous change (like a pager), ignored while typing.
  useEffect(() => {
    if (!canJump) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      if (e.key !== "n" && e.key !== "p") return;
      if (jump(e.key === "n" ? 1 : -1)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canJump, jump]);

  const summary = <SummaryText detail={d} />;

  return (
    <div
      role="status"
      title={tooltip}
      className="no-print sticky top-14 z-10 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-sky-500/30 bg-sky-50/95 px-4 py-1.5 text-xs text-sky-900 backdrop-blur md:px-8 dark:border-sky-400/25 dark:bg-sky-950/80 dark:text-sky-200"
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
        <Icon className="size-3.5 shrink-0" aria-hidden />
        {onMode ? (
          <ModeSwitch mode={git ? "git" : "seen"} onMode={onMode} />
        ) : (
          <span className="font-medium">
            <span className="sm:hidden">{git ? "Since commit" : "Changed"}</span>
            <span className="hidden sm:inline">{title}</span>
          </span>
        )}
        {when ? (
          <span className={cn("text-sky-800/70 dark:text-sky-300/70", git && "font-mono")}>({when})</span>
        ) : null}
        <span className="hidden text-sky-800/60 sm:inline dark:text-sky-300/60" aria-hidden>
          ·
        </span>
        {canJump ? (
          <button
            type="button"
            className="cursor-pointer rounded-sm text-sky-800/80 underline-offset-2 hover:underline dark:text-sky-300/80"
            onClick={() => jump(1, true)}
            title="Go to the first change (n / p: next / previous)"
          >
            {summary}
          </button>
        ) : (
          <span className="text-sky-800/80 dark:text-sky-300/80">{summary}</span>
        )}
      </div>
      <div className="ml-auto flex items-center gap-1">
        {canJump ? (
          <>
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={() => jump(-1)}
              aria-label="Previous change"
              title="Previous change (p)"
            >
              <ChevronUpIcon />
            </Button>
            <Button size="icon-xs" variant="ghost" onClick={() => jump(1)} aria-label="Next change" title="Next change (n)">
              <ChevronDownIcon />
            </Button>
          </>
        ) : null}
        {canDiff ? (
          <Button
            size="xs"
            variant="outline"
            className="border-sky-500/40 bg-transparent"
            onClick={() => setShowDiff(!showDiff)}
            aria-pressed={showDiff}
            aria-label={showDiff ? "Hide changes" : "Show changes"}
            title={
              showDiff ? "Back to the file" : git ? "Line diff against the last commit" : "Line diff against the version you last viewed"
            }
          >
            <GitCompareIcon />
            <span className="hidden sm:inline">{showDiff ? "Hide changes" : "Show changes"}</span>
          </Button>
        ) : null}
        {git ? (
          <Button size="xs" variant="ghost" onClick={markSeen} aria-label="Close the comparison" title="Back to the plain view">
            <XIcon />
            <span className="hidden sm:inline">Close</span>
          </Button>
        ) : (
          <Button size="xs" variant="ghost" onClick={markSeen} aria-label="Mark as seen" title="Accept this version as seen">
            <CheckIcon />
            <span className="hidden sm:inline">Mark as seen</span>
          </Button>
        )}
      </div>
    </div>
  );
}

/** Unified line diff of the last viewed version (or, with `git`, the last commit's) against the current one. */
export function ChangesDiff({ state, git }: { state: FileChangeState; git?: GitCompareState }) {
  if (state.baseText === null || state.currentText === null) return null;
  const when = state.baseViewedAt !== null ? ` (${formatRelative(state.baseViewedAt / 1000)})` : "";
  const commit = git?.head?.headCommit ? ` (${git.head.headCommit})` : "";
  const oldLabel = git ? (git.isNew ? "not in the last commit" : `last commit${commit}`) : `as you last viewed it${when}`;
  return (
    <div className="px-4 py-4 md:px-8">
      <DiffView
        oldText={state.baseText}
        newText={state.currentText}
        diff={state.lineDiff}
        oldLabel={oldLabel}
        newLabel={git?.isDeleted ? "deleted" : "now"}
        bodyClassName="max-h-none"
        maxRows={4000}
      />
    </div>
  );
}
