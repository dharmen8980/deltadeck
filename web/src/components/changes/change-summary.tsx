
import type { ChangeSummary } from "@/lib/diff";
import { formatBytes, plural } from "@/lib/format";
import { cn } from "@/lib/utils";

export type SummaryDetail = {
  text: string;
  parts?: { n: number; label: string; dot: string }[];
  /** shown before the parts */
  lead?: string;
};

/** Lines by kind, in the colours of the marks in the code. */
const lineParts = (k: { added: number; modified: number; removed: number }) =>
  [
    { n: k.added, label: "added", dot: "bg-emerald-500" },
    { n: k.modified, label: "edited", dot: "bg-amber-500" },
    { n: k.removed, label: "removed", dot: "bg-red-500" },
  ].filter((p) => p.n > 0);

/** What changed, in a few words (shared by the banner and the What's new feed). */
export function summaryDetail(s: ChangeSummary): SummaryDetail {
  switch (s.type) {
    case "blocks":
      // Same colours as the marks in the article; "blocks" = paragraphs, headings, lists, tables, code.
      return {
        text: `${plural(s.total, "block")} changed`,
        parts: [
          { n: s.added, label: "added", dot: "bg-emerald-500" },
          { n: s.modified, label: "edited", dot: "bg-amber-500" },
          { n: s.removed, label: "removed", dot: "bg-red-500" },
        ].filter((p) => p.n > 0),
      };
    case "lines": {
      const text = `${plural(s.changes, "change")}, +${s.added} −${s.removed} lines`;
      if (!s.kinds) return { text };
      // Code and text: lines by kind, in the colours of the marks in the code.
      return { text, parts: lineParts(s.kinds) };
    }
    case "whitespace":
      // Code and text mark whitespace-only lines too (indentation matters): the counts match them.
      return s.kinds
        ? { text: "only whitespace changed", lead: "only whitespace changed ·", parts: lineParts(s.kinds) }
        : { text: "only whitespace changed" };
    case "same":
      return { text: "same text, only rewritten" };
    case "too-many":
      return { text: "too many changes to compare quickly" };
    case "size": {
      const size = s.delta === 0 ? "size unchanged" : `${s.delta > 0 ? "grew by" : "shrank by"} ${formatBytes(Math.abs(s.delta))}`;
      if (s.tooLarge) return { text: `${size} · too large to compare` };
      return { text: s.noCopy ? `${size} · no earlier copy saved to compare` : size };
    }
  }
}

/** The detail as shown: coloured dots per block kind, or the plain text. */
export function SummaryText({ detail, className }: { detail: SummaryDetail; className?: string }) {
  if (!detail.parts) return <span className={className}>{detail.text}</span>;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-x-2", className)}>
      {detail.lead ? <span aria-hidden>{detail.lead}</span> : null}
      {detail.parts.map((p) => (
        <span key={p.label} className="inline-flex items-center gap-1">
          <span className={cn("size-1.5 rounded-full", p.dot)} aria-hidden />
          {p.n.toLocaleString()} {p.label}
        </span>
      ))}
      <span className="sr-only">({detail.text})</span>
    </span>
  );
}
