// Client pre-check of new file names (mirrors the server's deny/ignore name rules; the server
// stays authoritative). Kept free of runtime imports so node:test can load it.
import type { AppConfig } from "@/lib/api";

export function utf8Length(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

// ---------- name validation (mirrors the server; the server stays authoritative) ----------

// server/deltadeck/config.py DEFAULT_DENY, DEFAULT_DENY_EXCEPT and DEFAULT_IGNORE: only fallbacks when
// /api/config has no patterns. The server's path-aware check decides (a tracked file inside
// node_modules is visible and editable).
const DEFAULT_DENY = [".env", ".env.*", "*.pem", "*.key"];
const DEFAULT_DENY_EXCEPT = [".env*.example", ".env*.sample", ".env*.template"];
const DEFAULT_IGNORE = [".git", ".DS_Store", "node_modules", "__pycache__", ".venv", "venv", ".deltadeck-tmp-*", ".ldv-tmp-*"];

/** NFKC + case folding, like the server's name folding (approximation of str.casefold). */
export function foldName(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/ß/g, "ss").replace(/ſ/g, "s").normalize("NFKC");
}

const reCache = new Map<string, RegExp>();

/** Python fnmatch.translate equivalent (full match). */
function fnmatchRegex(pattern: string): RegExp {
  const hit = reCache.get(pattern);
  if (hit) return hit;
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      let j = i + 1;
      if (pattern[j] === "!") j++;
      if (pattern[j] === "]") j++;
      while (j < pattern.length && pattern[j] !== "]") j++;
      if (j >= pattern.length) re += "\\[";
      else {
        let stuff = pattern.slice(i + 1, j).replace(/\\/g, "\\\\");
        if (stuff.startsWith("!")) stuff = `^${stuff.slice(1)}`;
        else if (stuff.startsWith("^")) stuff = `\\${stuff}`;
        re += `[${stuff}]`;
        i = j;
      }
    } else re += c.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
  }
  const out = new RegExp(`^(?:${re})$`, "s");
  reCache.set(pattern, out);
  return out;
}

function matchesAny(name: string, patterns: string[]): string | null {
  const n = foldName(name);
  for (const p of patterns) if (fnmatchRegex(foldName(p)).test(n)) return p;
  return null;
}

export interface NameRules {
  deny: string[];
  /** names the lifted deny patterns leave out (.env templates) */
  denyExcept: string[];
  /** the deny patterns denyExcept applies to (the server's built-in ones); the rest stay strict */
  denyLifted: string[];
  ignore: string[];
}

export function nameRules(config: AppConfig | null): NameRules {
  return {
    deny: config?.deny_patterns ?? DEFAULT_DENY,
    denyExcept: config?.deny_except_patterns ?? (config?.deny_patterns ? [] : DEFAULT_DENY_EXCEPT),
    denyLifted: config?.deny_lifted_patterns ?? (config?.deny_patterns ? [] : DEFAULT_DENY),
    ignore: config?.ignore_patterns ?? DEFAULT_IGNORE,
  };
}

/** Problem with a single path component, or null when it looks acceptable. */
export function validateName(name: string, rules: NameRules): string | null {
  if (!name) return "Enter a name.";
  if (name === "." || name === "..") return "That name is reserved.";
  if (/[/\\]/.test(name)) return "Names cannot contain / or \\.";
  if (/[\u0000-\u001f\u007f]/.test(name)) return "Names cannot contain control characters.";
  if (utf8Length(name) > 255) return "That name is too long (max 255 bytes).";
  if (/[ .]$/.test(name)) return "Names cannot end with a space or a dot.";
  if (/^\s/.test(name)) return "Names cannot start with whitespace.";
  const lifted = new Set(rules.denyLifted.map(foldName));
  const strict = rules.deny.filter((p) => !lifted.has(foldName(p)));
  const denied = matchesAny(name, strict)
    ?? (matchesAny(name, rules.denyExcept) ? null : matchesAny(name, rules.denyLifted));
  if (denied) return `Matches the deny list (${denied}); the viewer would refuse it.`;
  const ignored = matchesAny(name, rules.ignore);
  if (ignored) return `Matches the ignore list (${ignored}); it would be hidden.`;
  return null;
}

/** Validate every component of a root-relative path. */
export function validatePath(path: string, rules: NameRules): string | null {
  if (!path) return "Enter a path.";
  if (path.startsWith("/")) return "Use a path relative to the root (no leading /).";
  for (const part of path.split("/")) {
    const err = validateName(part, rules);
    if (err) return part ? `"${part}": ${err}` : "Paths cannot contain empty segments (//).";
  }
  return null;
}
