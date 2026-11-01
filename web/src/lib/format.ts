// Display formatting shared by the viewer: sizes, times and counts.
// No `@/` imports: unit tested with node --test.

/** "3 lines", "1 line" */
export const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return "?";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatTime(mtime: number): string {
  const d = new Date(mtime * 1000);
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatRelative(mtime: number): string {
  const diff = Date.now() / 1000 - mtime;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(mtime * 1000).toLocaleDateString();
}

/** Epoch milliseconds from seconds, milliseconds or an ISO string (NaN if unknown). */
export function whenMs(v: number | string | undefined | null): number {
  if (v === undefined || v === null || v === "") return NaN;
  if (typeof v === "number") return v > 1e12 ? v : v * 1000;
  const n = Number(v);
  return Number.isFinite(n) ? (n > 1e12 ? n : n * 1000) : Date.parse(v);
}

export function formatWhen(v: number | string | undefined | null): string {
  if (v === undefined || v === null || v === "") return "";
  const ms = whenMs(v);
  if (!Number.isFinite(ms)) return String(v);
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
