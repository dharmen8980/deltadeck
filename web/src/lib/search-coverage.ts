import type { SearchResponse } from "@/lib/api";

const n = (x: number) => x.toLocaleString("en-US");

/** The note shown in the search dialog when content search does not cover every file (a cap in
 *  --search-max-files / --search-max-total-mb was reached, or the index could not be written),
 *  or null. Not shown while the first build is still running. */
export function searchCoverageNotice(data: SearchResponse | null | undefined): string | null {
  if (!data || data.indexing || !data.limit_reached) return null;
  const covered = data.indexed_files ?? 0;
  const total = data.indexable_files ?? 0;
  const why =
    data.limit_reason === "disk" ? "disk full" : data.limit_reason === "error" ? "index write failed" : "limit reached";
  return `Search covers ${n(Math.min(covered, total))} of ${n(total)} files - ${why}`;
}

/** The notice's tooltip: which files were chosen, and how to index more where that is possible
 *  (the desktop app starts its server without command-line options). */
export function searchCoverageHint(data: SearchResponse | null | undefined, desktop: boolean): string | null {
  if (!searchCoverageNotice(data)) return null;
  if (data?.limit_reason === "disk" || data?.limit_reason === "error") {
    return "The files indexed so far stay searchable; indexing tries again later";
  }
  const order = "Documents are indexed first, then text, code and data; shallower and smaller files first";
  return desktop ? order : `${order}. Raise --search-max-files / --search-max-total-mb to index more`;
}
