// Shell (.sh / .bash / .zsh) outline, by line rules: functions in all three
// syntaxes (`name() {`, `function name {`, `function name() {`) and section
// comment headers (`# ---- Name ----`, `### Name`, or a `# Name` line framed by
// two `# -----` rule lines). Functions after a header are listed under it.
// Heredoc bodies and multi-line quoted strings are skipped, so `foo() {` text
// inside them is not a function. Heuristic: nested functions are listed flat.

import { Budget, cleanName, NO_BUDGET, type OutlineSymbol } from "./common.ts";

const FN_KEYWORD = /^\s*function\s+([^\s(){}|&;<>"'`$]+)\s*(?:\(\s*\))?\s*(?:\{|\(|\[\[|#|$)/;
const FN_POSIX = /^\s*([A-Za-z_][\w:.@+-]*)\s*\(\s*\)\s*(?:\{|\(|\[\[|#|$)/;
const RULE = /^\s*#+\s*[-=*~#_]{3,}\s*#*\s*$/;
const HEADER_RULED = /^\s*#+\s*[-=*~_]{3,}\s*(.*?[^\s\-=*~_#].*?)\s*[-=*~_]*\s*#*\s*$/;
const HEADER_HASHES = /^\s*#{3,}\s+(.*?\S)\s*#*\s*$/;
const BANNER_TEXT = /^\s*#+\s+(\S.*?)\s*#*\s*$/;

interface Heredoc {
  delim: string;
  stripTabs: boolean;
}

/** Whether `line[i]` is inside `(( ... ))` / `$(( ... ))`, where `<<` is a shift. */
function inArithmetic(line: string, i: number): boolean {
  return line.lastIndexOf("((", i) > line.lastIndexOf("))", i);
}

/** Scan one line for quote state changes and heredoc starts; returns the state at its end. */
function scanLine(line: string, quote: "" | "'" | '"', heredocs: Heredoc[]): "" | "'" | '"' {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote === "'") {
      if (c === "'") quote = "";
      continue;
    }
    if (quote === '"') {
      if (c === "\\") i++;
      else if (c === '"') quote = "";
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      // $'...' is also single-quoted (with escapes, close enough)
      quote = c;
      continue;
    }
    if (c === "#" && (i === 0 || /[\s;&|(]/.test(line[i - 1]))) return quote; // comment to end of line
    if (c === "<" && line[i + 1] === "<" && line[i + 2] !== "<" && line[i - 1] !== "<" && !inArithmetic(line, i)) {
      const m = /^<<(-?)\s*(\\?)(['"]?)([A-Za-z0-9_.\-+!@%]+)\3/.exec(line.slice(i));
      if (m) {
        heredocs.push({ delim: m[4], stripTabs: m[1] === "-" });
        i += m[0].length - 1;
      }
    }
  }
  return quote;
}

export function outlineShell(text: string, budget: Budget = NO_BUDGET): OutlineSymbol[] {
  const lines = text.split("\n");
  const out: OutlineSymbol[] = [];
  let section: OutlineSymbol | null = null;
  let quote: "" | "'" | '"' = "";
  let pending: Heredoc[] = [];

  const add = (name: string, line: number) => {
    const sym: OutlineSymbol = { name: cleanName(name), kind: "function", line, children: [] };
    (section ? section.children : out).push(sym);
  };
  const addSection = (name: string, line: number) => {
    section = { name: cleanName(name), kind: "section", line, children: [] };
    out.push(section);
  };

  for (let i = 0; i < lines.length; i++) {
    budget.tick();
    const raw = lines[i].endsWith("\r") ? lines[i].slice(0, -1) : lines[i];
    if (quote) {
      quote = scanLine(raw, quote, pending);
      continue;
    }
    const lineNo = i + 1;
    // Section headers (comment lines only, so they cannot be inside a heredoc or string here).
    if (/^\s*#/.test(raw) && !(i === 0 && raw.startsWith("#!"))) {
      if (RULE.test(raw)) {
        const mid = lines[i + 1];
        const close = lines[i + 2];
        const t = mid !== undefined ? BANNER_TEXT.exec(mid) : null;
        if (t && !RULE.test(mid) && close !== undefined && RULE.test(close)) {
          addSection(t[1], i + 2);
          i += 2;
        }
        continue;
      }
      const h = HEADER_RULED.exec(raw) ?? HEADER_HASHES.exec(raw);
      if (h) addSection(h[1].replace(/[\s\-=*~_#]+$/, ""), lineNo);
      continue;
    }
    const fn = FN_KEYWORD.exec(raw) ?? FN_POSIX.exec(raw);
    if (fn) add(fn[1], lineNo);
    quote = scanLine(raw, "", pending);
    // Heredoc bodies start on the next line; skip them (several on one line run one after another).
    while (pending.length && !quote) {
      const doc = pending.shift()!;
      for (i++; i < lines.length; i++) {
        let l = lines[i].endsWith("\r") ? lines[i].slice(0, -1) : lines[i];
        if (doc.stripTabs) l = l.replace(/^\t+/, "");
        if (l === doc.delim) break;
      }
    }
    if (quote) pending = [];
  }
  return out;
}
