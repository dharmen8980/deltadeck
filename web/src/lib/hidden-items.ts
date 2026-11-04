// The Hidden files dialog's pure helpers (no DOM, no React, no "@/" value imports): unit tested
// with node --test. Rows come from GET /api/hiding/items; a row's checkbox means "visible".
import type { HiddenCount, HiddenGroup, HiddenReason, HiddenRow } from "@/lib/api";

export const GROUPS: { id: HiddenGroup; title: string }[] = [
  { id: "builtin", title: "Built-in" },
  { id: "git", title: "Git-ignored" },
  { id: "user", title: "Hidden by you" },
  { id: "deny", title: "Protected" },
];

const GROUP_ORDER: Record<HiddenGroup, number> = { builtin: 0, git: 1, user: 2, deny: 3 };

/** NFKC plus lower case: close to the server's path folding (NFKC + casefold). */
export const foldPath = (p: string) => p.normalize("NFKC").toLowerCase();

/** The server's order: group, then folded path. */
export function compareRows(a: HiddenRow, b: HiddenRow): number {
  const g = GROUP_ORDER[a.group] - GROUP_ORDER[b.group];
  if (g) return g;
  const fa = foldPath(a.path);
  const fb = foldPath(b.path);
  return fa < fb ? -1 : fa > fb ? 1 : 0;
}

/** Protected rows have no checkbox. */
export const hasCheckbox = (row: Pick<HiddenRow, "group">) => row.group !== "deny";

/** Rows hidden by the user (an exact hide choice or one of their patterns): nothing below such a
 * folder can be shown on its own (the server answers 400). */
export const isUserHidden = (r: HiddenRow) => !r.visible && (r.choice === "hide" || isPatternRow(r));

/** The nearest of `path`'s folders in `byPath`, or undefined. */
function hiddenAncestor(path: string, byPath: ReadonlyMap<string, HiddenRow>): HiddenRow | undefined {
  for (let i = path.lastIndexOf("/"); i > 0; i = path.lastIndexOf("/", i - 1)) {
    const hit = byPath.get(path.slice(0, i));
    if (hit) return hit;
  }
  return undefined;
}

/** The listing: the server's rows plus `sticky` ones (rows the user changed this session, with
 * `visible` as the user last set it) that the server no longer returns, so a just-checked row
 * stays listed until the dialog closes. Sorted by group, then folded path. A sticky row inside a
 * folder the server lists as hidden is hidden too (nothing in it shows): it is listed unchecked,
 * or left out when the user hid that folder (it can only be shown with the folder). */
export function mergeSticky(sticky: ReadonlyMap<string, HiddenRow>, next: HiddenRow[]): HiddenRow[] {
  const seen = new Set(next.map((r) => r.path));
  const hiddenDirs = new Map(next.filter((r) => r.dir && !r.visible).map((r) => [r.path, r]));
  const out = [...next];
  for (const [path, row] of sticky) {
    if (seen.has(path)) continue;
    const above = hiddenDirs.size ? hiddenAncestor(path, hiddenDirs) : undefined;
    if (!above) out.push(row);
    else if (!isUserHidden(above)) out.push({ ...row, visible: false, choice: undefined });
  }
  return out.sort(compareRows);
}

export type HeaderState = "checked" | "unchecked" | "mixed";

/** A group or sub-group checkbox: all visible, none, or some. Rows without a checkbox do not count. */
export function headerState(rows: Pick<HiddenRow, "group" | "visible">[]): HeaderState {
  let on = 0;
  let n = 0;
  for (const r of rows) {
    if (!hasCheckbox(r)) continue;
    n++;
    if (r.visible) on++;
  }
  if (!n || !on) return "unchecked";
  return on === n ? "checked" : "mixed";
}

export type BuiltinItem = { kind: "row"; row: HiddenRow } | { kind: "rule"; rule: string; rows: HiddenRow[] };

/** More than SUBGROUP_MIN rows with the same rule (e.g. 5 `__pycache__` folders) collapse into one
 * expandable sub-group, placed where its first row was; other rows stay flat. Give it every row of
 * the group and page the items it returns (pageItems): a sub-group then covers all its rows. */
export const SUBGROUP_MIN = 3;

export function groupRules(rows: HiddenRow[]): BuiltinItem[] {
  const byRule = new Map<string, HiddenRow[]>();
  for (const r of rows) {
    if (!r.rule) continue;
    const list = byRule.get(r.rule);
    if (list) list.push(r);
    else byRule.set(r.rule, [r]);
  }
  const out: BuiltinItem[] = [];
  const placed = new Set<string>();
  for (const r of rows) {
    const list = r.rule ? byRule.get(r.rule) : undefined;
    if (r.rule && list && list.length > SUBGROUP_MIN) {
      if (placed.has(r.rule)) continue;
      placed.add(r.rule);
      out.push({ kind: "rule", rule: r.rule, rows: list });
    } else out.push({ kind: "row", row: r });
  }
  return out;
}

/** The first `limit` items (a page); a sub-group counts as one item and keeps all its rows. */
export function pageItems<T>(items: T[], limit: number): T[] {
  return items.length > limit ? items.slice(0, limit) : items;
}

/** The rows the listed items show: flat rows, and the rows of the sub-groups in `open`. */
export function listedRows(items: BuiltinItem[], open: (rule: string) => boolean): HiddenRow[] {
  return items.flatMap((it) => (it.kind === "row" ? [it.row] : open(it.rule) ? it.rows : []));
}

/** A batch failed after earlier ones were applied: the message says how far it got. */
export function partialMessage(done: number, total: number, message: string): string {
  if (!done) return message;
  return `${message} (${done.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} were changed first)`;
}

/** "812 files", "1 file", "10,000+" (the server stops counting there); "" while not known. */
export function formatCount(c: HiddenCount | undefined): string {
  if (!c) return "";
  if (c.more) return `${c.files.toLocaleString("en-US")}+`;
  return `${c.files.toLocaleString("en-US")} file${c.files === 1 ? "" : "s"}`;
}

/** Rows hidden by one of the user's patterns (not by an exact choice). */
export const isPatternRow = (r: HiddenRow) => r.group === "user" && !r.choice && Boolean(r.rule);

/** Each of the user's patterns with the rows it hides (a pattern that matches nothing has none). */
export function patternRows(rules: string[], rows: HiddenRow[]): { rule: string; rows: HiddenRow[] }[] {
  const byRule = new Map<string, HiddenRow[]>();
  for (const r of rows) {
    if (!isPatternRow(r)) continue;
    const k = foldPath(r.rule!);
    const list = byRule.get(k);
    if (list) list.push(r);
    else byRule.set(k, [r]);
  }
  return rules.map((rule) => ({ rule, rows: byRule.get(foldPath(rule)) ?? [] }));
}

/** Why a file is hidden, for notices and tooltips. */
export function hiddenLabel(reason: HiddenReason, rule?: string): string {
  if (reason === "git") return "Ignored by git";
  if (reason === "user") return rule ? `Hidden by you (${rule})` : "Hidden by you";
  if (reason === "ignore") return rule ? `On the viewer's ignore list (${rule})` : "On the viewer's ignore list";
  return "Protected: may contain secrets";
}
