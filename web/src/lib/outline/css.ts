// CSS outline (Lezer): rule selectors (nested rules under their parent),
// @media / @supports / @container / @layer groups with the rules inside,
// @keyframes and @font-face. Declarations and keyframe stops are not listed.
// .scss / .less are best-effort: the CSS parser does not know them, so line
// comments, `$var:` / `@var:` declarations, LESS mixin calls and `#{}` / `@{}`
// interpolation are blanked out (same length, so offsets and names stay
// right) before parsing.

import type { SyntaxNode, Tree } from "@lezer/common";
import { parser } from "@lezer/css";
import { Budget, cleanName, LineIndex, NO_BUDGET, parseWithBudget, type OutlineSymbol, type SymbolKind } from "./common.ts";

export type CssVariant = "css" | "scss" | "less";

export function parserFor(): typeof parser {
  return parser;
}

const blank = (s: string) => s.replace(/[^\n]/g, " ");

export function prepare(text: string, variant: string, budget: Budget = NO_BUDGET): string {
  return preprocess(text, variant as CssVariant, budget);
}

const isSpace = (c: string) => c === " " || c === "\n" || c === "\t" || c === "\r" || c === "\f";

/** The last non-whitespace character of `s`, or `prev` when it has none. */
function lastSignificant(s: string, prev: string): string {
  for (let k = s.length - 1; k >= 0; k--) if (!isSpace(s[k])) return s[k];
  return prev;
}

// Sticky: matched at `lastIndex` in the whole text, no slicing.
const VAR_DECL = /[$@][\w-]+\s*:[^;{}]*;?/y;
const MIXIN_CALL = /[.#][\w-]+(?:\s*>?\s*[.#][\w-]+)*\s*(?:\([^(){};]*\))?\s*(?:!important\s*)?;/y;
const LESS_EXTEND = /&:extend\([^(){};]*\)\s*;/y;
const GUARD = /when\s*\(/y;

function stickyMatch(re: RegExp, text: string, at: number): string | null {
  re.lastIndex = at;
  const m = re.exec(text);
  return m ? m[0] : null;
}

/**
 * Make SCSS / LESS digestible for the CSS parser without moving any offset.
 * Linear: unchanged runs are copied as slices, and "at a statement start" is
 * the last non-whitespace character emitted so far (one of `;{}`, or none).
 */
export function preprocess(text: string, variant: CssVariant, budget: Budget = NO_BUDGET): string {
  if (variant === "css") return text;
  const pieces: string[] = [];
  let runStart = 0; // start of the run copied unchanged, not yet in `pieces`
  let last = ""; // last non-whitespace character of the output so far
  const atStatement = () => last === "" || last === ";" || last === "{" || last === "}";
  /** Replace text[i, j) by `repl` (same length). */
  const replace = (i: number, j: number, repl: string) => {
    if (i > runStart) pieces.push(text.slice(runStart, i));
    pieces.push(repl);
    runStart = j;
    last = lastSignificant(repl, last);
  };
  let i = 0;
  const n = text.length;
  while (i < n) {
    budget.tick();
    const c = text[i];
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const j = end === -1 ? n : end + 2;
      last = lastSignificant(text.slice(Math.max(i, j - 2), j), last);
      i = j;
    } else if (c === "/" && text[i + 1] === "/" && (i === 0 || /[\s;{}]/.test(text[i - 1]))) {
      const end = text.indexOf("\n", i);
      const j = end === -1 ? n : end;
      replace(i, j, blank(text.slice(i, j)));
      i = j;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      j = Math.min(n, j + 1);
      last = lastSignificant(text.slice(i, j), last);
      i = j;
    } else if ((c === "#" || (c === "@" && variant === "less")) && text[i + 1] === "{") {
      const end = text.indexOf("}", i);
      const j = end === -1 ? n : end + 1;
      replace(i, j, "_".repeat(j - i));
      i = j;
    } else if (c === "$" || (c === "@" && variant === "less")) {
      // `$x: 1px;` / `@x: 1px;` -> blank; `$x` in a value -> `_x`
      const m = atStatement() ? stickyMatch(VAR_DECL, text, i) : null;
      if (m) {
        replace(i, i + m.length, blank(m));
        i += m.length;
      } else if (c === "$") {
        replace(i, i + 1, "_");
        i++;
      } else {
        // a LESS `@var` in a value is not an at-rule; one at a statement start (`@media`) is
        if (atStatement()) last = c;
        else replace(i, i + 1, "_");
        i++;
      }
    } else if (variant === "less" && (c === "." || c === "#") && atStatement()) {
      // a mixin call `.mixin(1px);` / `#ns > .m();` -> blank; anything else is a selector
      const m = stickyMatch(MIXIN_CALL, text, i);
      if (m) {
        replace(i, i + m.length, blank(m));
        i += m.length;
      } else {
        last = c;
        i++;
      }
    } else if (variant === "less" && c === "&" && text[i + 1] === ":" && atStatement() && stickyMatch(LESS_EXTEND, text, i)) {
      // `&:extend(.foo all);` -> blank
      const m = stickyMatch(LESS_EXTEND, text, i)!;
      replace(i, i + m.length, blank(m));
      i += m.length;
    } else if (variant === "less" && c === "w" && isSpace(text[i - 1] ?? "") && stickyMatch(GUARD, text, i)) {
      // a mixin guard `.m when (@a > 0) {` -> blank up to the block
      const end = text.indexOf("{", i);
      const j = end === -1 ? n : end;
      replace(i, j, blank(text.slice(i, j)));
      i = j;
    } else if (variant === "scss" && c === "%" && /[\w-]/.test(text[i + 1] ?? "") && atStatement()) {
      // a placeholder selector `%name {`
      replace(i, i + 1, "_");
      i++;
    } else if (c === "&" && /[\w-]/.test(text[i + 1] ?? "")) {
      replace(i, i + 1, "_");
      i++;
    } else {
      if (!isSpace(c)) last = c;
      i++;
    }
  }
  if (runStart === 0) return text;
  if (runStart < n) pieces.push(text.slice(runStart));
  return pieces.join("");
}

const CONTROL_AT_RULES = new Set(["@if", "@else", "@each", "@for", "@while", "@include"]);

function atKind(keyword: string): SymbolKind | null {
  switch (keyword.toLowerCase()) {
    case "@media":
      return "media";
    case "@supports":
      return "supports";
    case "@container":
      return "container";
    case "@keyframes":
    case "@-webkit-keyframes":
      return "keyframes";
    case "@font-face":
      return "font-face";
    case "@layer":
      return "layer";
    default:
      return null;
  }
}

/** Symbols of a parsed stylesheet. `text` is the original source (names are taken from it). */
export function extract(tree: Tree, text: string, budget: Budget = NO_BUDGET, variant = "css"): OutlineSymbol[] {
  const lines = new LineIndex(text);
  const less = variant === "less";
  const sym = (node: SyntaxNode, kind: SymbolKind, nameEnd: number): OutlineSymbol => ({
    // a LESS guard (`.m when (iscolor(@c))`) is not part of the name
    name: cleanName(less ? text.slice(node.from, nameEnd).replace(/\s+when\s*\([\s\S]*$/, "") : text.slice(node.from, nameEnd)),
    kind,
    line: lines.line(node.from),
    endLine: lines.line(Math.max(node.from, node.to - 1)),
    children: [],
  });

  const visit = (parent: SyntaxNode, into: OutlineSymbol[]) => {
    for (let ch = parent.firstChild; ch; ch = ch.nextSibling) {
      budget.tick();
      const block = ch.getChild("Block") ?? ch.getChild("KeyframeList");
      if (!block) continue;
      let kind: SymbolKind | null = null;
      switch (ch.name) {
        case "RuleSet":
          kind = "selector";
          break;
        case "MediaStatement":
          kind = "media";
          break;
        case "SupportsStatement":
          kind = "supports";
          break;
        case "KeyframesStatement":
          kind = "keyframes";
          break;
        case "AtRule": {
          const kw = ch.getChild("AtKeyword");
          const word = kw ? text.slice(kw.from, kw.to) : "";
          if (CONTROL_AT_RULES.has(word.toLowerCase())) {
            // SCSS control flow: not a symbol, but the rules inside are.
            visit(block, into);
            continue;
          }
          kind = atKind(word) ?? "at-rule";
          break;
        }
        default:
          continue;
      }
      const s = sym(ch, kind, block.from);
      if (!s.name) continue;
      into.push(s);
      if (kind !== "keyframes" && kind !== "font-face") visit(block, s.children);
    }
  };

  const out: OutlineSymbol[] = [];
  visit(tree.topNode, out);
  return out;
}

export function outlineCss(text: string, variant: CssVariant = "css", budget: Budget = NO_BUDGET): OutlineSymbol[] {
  const tree = parseWithBudget(parser, preprocess(text, variant, budget), budget);
  return extract(tree, text, budget, variant);
}
