// C# outline, by rules over a small tokenizer (no grammar): namespaces (block
// and file-scoped), classes, structs, interfaces, records and enums, with
// their methods, constructors, operators, properties, indexers and nested
// types. Comments, strings (regular, verbatim, interpolated, raw), char
// literals and preprocessor lines are skipped, so braces inside them do not
// count. Member bodies are skipped whole, so statements, calls, control flow
// and lambdas are never listed. A member is a declaration only when a type
// precedes its name (or it is named like its class: a constructor).
// Heuristic: unusual code (e.g. #if branches with unbalanced braces) can
// confuse it. The line is the line of the name, not of the [attributes].

import { Budget, cleanName, NO_BUDGET, type OutlineSymbol, type SymbolKind } from "./common.ts";

interface Tok {
  t: string;
  /** identifier, punctuation, literal */
  k: "id" | "p" | "lit";
  line: number;
}

const ID_START = /[\p{L}_@]/u;
const ID_PART = /[\p{L}\p{N}_]/u;
const PUNCT2 = new Set(["=>", "==", "!=", "<=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "??", "?.", "::", "->", "++", "--", "&&", "||"]);

/** Tokens of C# source, without comments, strings' contents and preprocessor lines. */
export function tokenize(text: string, budget: Budget = NO_BUDGET): Tok[] {
  const toks: Tok[] = [];
  const n = text.length;
  let i = 0;
  let line = 1;
  let lineStart = true; // only whitespace so far on this line

  const skipString = (j: number): number => {
    // text[j] is the opening quote of a regular string
    j++;
    while (j < n && text[j] !== '"' && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
    return Math.min(n, j + 1);
  };
  const skipVerbatim = (j: number): number => {
    // text[j] is the opening quote of @"..."
    j++;
    for (; j < n; j++) {
      if (text[j] === '"') {
        if (text[j + 1] === '"') j++;
        else return j + 1;
      }
    }
    return n;
  };
  const skipRaw = (j: number): number => {
    // text[j..] starts with 3+ quotes; ends at the same number of quotes
    let q = 0;
    while (text[j + q] === '"') q++;
    const close = '"'.repeat(q);
    const end = text.indexOf(close, j + q);
    return end === -1 ? n : end + q;
  };
  const skipChar = (j: number): number => {
    // text[j] is "'"
    let k = j + 1;
    while (k < n && k - j < 12 && text[k] !== "'" && text[k] !== "\n") k += text[k] === "\\" ? 2 : 1;
    return text[k] === "'" ? k + 1 : j + 1;
  };
  /** An interpolated string: holes are code (which can contain strings and braces). */
  const skipInterpolated = (j: number, verbatim: boolean): number => {
    j++;
    while (j < n) {
      const c = text[j];
      if (c === '"') {
        if (verbatim && text[j + 1] === '"') {
          j += 2;
          continue;
        }
        return j + 1;
      }
      if (!verbatim && c === "\\") {
        j += 2;
        continue;
      }
      if (!verbatim && c === "\n") return j;
      if (c === "{") {
        if (text[j + 1] === "{") {
          j += 2;
          continue;
        }
        let depth = 1;
        j++;
        while (j < n && depth > 0) {
          const d = text[j];
          if (d === "{") depth++;
          else if (d === "}") depth--;
          else if (d === '"') {
            j = skipString(j);
            continue;
          } else if (d === "'") {
            j = skipChar(j);
            continue;
          } else if (d === "@" && text[j + 1] === '"') {
            j = skipVerbatim(j + 1);
            continue;
          }
          j++;
        }
        continue;
      }
      j++;
    }
    return n;
  };
  const countLines = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (text.charCodeAt(k) === 10) line++;
  };

  while (i < n) {
    budget.tick();
    const c = text[i];
    if (c === "\n") {
      line++;
      i++;
      lineStart = true;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || c === "\f" || c === "\v" || c === "﻿") {
      i++;
      continue;
    }
    const wasLineStart = lineStart;
    lineStart = false;
    if (c === "#" && wasLineStart) {
      // preprocessor directive: #region, #if, #pragma ...
      const e = text.indexOf("\n", i);
      i = e === -1 ? n : e;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      const e = text.indexOf("\n", i);
      i = e === -1 ? n : e;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const e = text.indexOf("*/", i + 2);
      const j = e === -1 ? n : e + 2;
      countLines(i, j);
      i = j;
      continue;
    }
    let strEnd = -1;
    if (c === '"') strEnd = text.startsWith('"""', i) ? skipRaw(i) : skipString(i);
    else if (c === "'") strEnd = skipChar(i);
    else if ((c === "$" || c === "@") && /^(\$+@?|@\$+|@)"/.test(text.slice(i, i + 6))) {
      const m = /^(\$+@?|@\$+|@)/.exec(text.slice(i, i + 6))!;
      const prefix = m[1];
      const q = i + prefix.length;
      if (text.startsWith('"""', q)) strEnd = skipRaw(q);
      else if (prefix === "@") strEnd = skipVerbatim(q);
      else strEnd = skipInterpolated(q, prefix.includes("@"));
    }
    if (strEnd !== -1) {
      toks.push({ t: '""', k: "lit", line });
      countLines(i, strEnd);
      i = strEnd;
      continue;
    }
    if (ID_START.test(c)) {
      let j = i + 1;
      while (j < n && ID_PART.test(text[j])) j++;
      toks.push({ t: c === "@" ? text.slice(i + 1, j) : text.slice(i, j), k: "id", line });
      i = j;
      continue;
    }
    if (c >= "0" && c <= "9") {
      let j = i + 1;
      while (j < n && /[\w.]/.test(text[j])) j++;
      toks.push({ t: text.slice(i, j), k: "lit", line });
      i = j;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (text.startsWith("??=", i)) {
      toks.push({ t: "??=", k: "p", line });
      i += 3;
    } else if (PUNCT2.has(two)) {
      toks.push({ t: two, k: "p", line });
      i += 2;
    } else {
      toks.push({ t: c, k: "p", line });
      i++;
    }
  }
  return toks;
}

const MODIFIERS = new Set([
  "public", "private", "protected", "internal", "static", "readonly", "sealed", "abstract", "virtual",
  "override", "extern", "unsafe", "new", "partial", "async", "const", "volatile", "ref", "required", "file",
]);
const TYPE_WORDS: Record<string, SymbolKind> = {
  class: "class",
  struct: "struct",
  interface: "interface",
  enum: "enum",
  record: "record",
};
/** Words that can never be a member name or a return type. */
const NOT_NAMES = new Set([
  "if", "else", "for", "foreach", "while", "do", "switch", "case", "default", "catch", "try", "finally", "using",
  "lock", "fixed", "checked", "unchecked", "return", "throw", "yield", "await", "goto", "break", "continue",
  "nameof", "typeof", "sizeof", "stackalloc", "when", "in", "is", "as", "out", "var", "base", "this", "new",
  "namespace", "delegate", "event", "operator", "where", "select", "from", "let", "get", "set", "init", "add",
  "remove", "true", "false", "null",
]);
const ASSIGN = new Set(["=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "??="]);
const OPEN: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

export function outlineCSharp(text: string, budget: Budget = NO_BUDGET): OutlineSymbol[] {
  const toks = tokenize(text, budget);
  const n = toks.length;
  let i = 0;

  /** Index just past the group opened at `j` (balanced (), [], {}). */
  const skipGroup = (j: number): number => {
    const stack: string[] = [];
    for (; j < n; j++) {
      budget.tick();
      const t = toks[j].t;
      if (toks[j].k !== "p") continue;
      if (OPEN[t]) stack.push(OPEN[t]);
      else if (t === ")" || t === "]" || t === "}") {
        // tolerate mismatches: pop until the matching opener
        while (stack.length && stack[stack.length - 1] !== t) stack.pop();
        stack.pop();
        if (!stack.length) return j + 1;
      }
    }
    return n;
  };

  /** Skip to just past the next `;` that is not nested (an initializer or expression body). */
  const skipStatement = (j: number): number => {
    while (j < n) {
      const t = toks[j];
      if (t.k === "p" && OPEN[t.t]) {
        j = skipGroup(j);
        continue;
      }
      if (t.k === "p" && t.t === "}") return j; // leave the scope's brace to the scope
      j++;
      if (t.k === "p" && t.t === ";") return j;
    }
    return n;
  };

  const isTypeEnd = (tk: Tok) => tk.k === "id" || [">", "]", "?", "*", ")"].includes(tk.t);

  /** Name of a member whose parameter list opens at head[p]; null when it is not a declaration. */
  const memberAt = (
    head: Tok[],
    p: number,
    modsEnd: number,
    typeName: string | null,
  ): { name: string; line: number; kind: SymbolKind } | null => {
    let k = p - 1;
    if (k < modsEnd) return null;
    // generic method: M<T>(
    if (head[k].t === ">") {
      let depth = 0;
      for (; k >= modsEnd; k--) {
        if (head[k].t === ">") depth++;
        else if (head[k].t === "<") {
          depth--;
          if (depth === 0) break;
        }
      }
      k--;
      if (k < modsEnd) return null;
    }
    const nameTok = head[k];
    if (nameTok.k !== "id" || NOT_NAMES.has(nameTok.t) || MODIFIERS.has(nameTok.t)) return null;
    let name = nameTok.t;
    // explicit interface implementation: void IDisposable.Dispose()
    let q = k - 1;
    while (q - 1 >= modsEnd && (head[q].t === "." || head[q].t === "::") && head[q - 1].k === "id") {
      name = `${head[q - 1].t}${head[q].t}${name}`;
      q -= 2;
    }
    // what precedes the (qualified) name: the return type, or nothing (constructor), or "~" (finalizer)
    const before = q >= modsEnd ? head[q] : null;
    if (!before) {
      if (typeName && name === typeName) return { name, line: nameTok.line, kind: "constructor" };
      return null;
    }
    if (before.t === "~" && q === modsEnd && typeName && name === typeName)
      return { name: `~${name}`, line: nameTok.line, kind: "method" };
    if (!isTypeEnd(before)) return null;
    const first = head[modsEnd];
    if (first.k !== "id" && first.t !== "(") return null;
    if (first.k === "id" && NOT_NAMES.has(first.t)) return null;
    return { name, line: nameTok.line, kind: "method" };
  };

  type Decl =
    | { type: "namespace"; name: string; line: number }
    | { type: "type"; kind: SymbolKind; name: string; line: number }
    | { type: "member"; kind: SymbolKind; name: string; line: number }
    | null;

  const classify = (head: Tok[], scope: "file" | "namespace" | "type", typeName: string | null, term: string): Decl => {
    let s = 0;
    // leading [attributes]
    while (s < head.length && head[s].t === "[") {
      let depth = 0;
      for (; s < head.length; s++) {
        if (head[s].t === "[") depth++;
        else if (head[s].t === "]" && --depth === 0) break;
      }
      s++;
    }
    if (s >= head.length) return null;
    if (head[s].t === "namespace") {
      let name = "";
      let line = head[s].line;
      for (let j = s + 1; j < head.length && (head[j].k === "id" || head[j].t === "."); j++) {
        if (!name) line = head[j].line;
        name += head[j].t;
      }
      return name ? { type: "namespace", name, line } : null;
    }
    let m = s;
    let isEvent = false;
    while (m < head.length && head[m].k === "id" && (MODIFIERS.has(head[m].t) || head[m].t === "event")) {
      if (head[m].t === "event") isEvent = true;
      m++;
    }
    if (m >= head.length) return null;
    const w = head[m].t;
    if (head[m].k === "id" && TYPE_WORDS[w]) {
      let j = m + 1;
      if (w === "record" && (head[j]?.t === "class" || head[j]?.t === "struct")) j++;
      const nameTok = head[j];
      if (!nameTok || nameTok.k !== "id") return null;
      return { type: "type", kind: TYPE_WORDS[w], name: nameTok.t, line: nameTok.line };
    }
    if (head[m].t === "delegate" || isEvent) return null;
    if (scope === "namespace") return null; // only types live directly in a namespace
    // operators: public static Vec operator +(Vec a, Vec b) / implicit operator int(X x)
    for (let j = m; j < head.length; j++) {
      if (head[j].t === "(") break;
      if (head[j].k === "id" && head[j].t === "operator") {
        let op = "";
        for (let k = j + 1; k < head.length && head[k].t !== "("; k++) op += head[k].t;
        const name = `operator ${op}`;
        const conv = j > m && (head[j - 1].t === "implicit" || head[j - 1].t === "explicit") ? `${head[j - 1].t} ` : "";
        return { type: "member", kind: "method", name: conv + name, line: head[j].line };
      }
    }
    // methods / constructors: a top-level "(" preceded by a declared name (a
    // tuple return type's "(" is preceded by nothing, a call's by a qualifier)
    let depth = 0;
    let angle = 0;
    for (let j = m; j < head.length; j++) {
      const t = head[j].t;
      if (depth === 0 && t === "<") angle++;
      else if (depth === 0 && t === ">") angle = Math.max(0, angle - 1);
      else if (t === "(" || t === "[") {
        if (depth === 0 && angle === 0 && t === "(") {
          const mem = memberAt(head, j, m, scope === "type" ? typeName : null);
          if (mem) return { type: "member", ...mem };
        }
        depth++;
      } else if (t === ")" || t === "]") depth = Math.max(0, depth - 1);
    }
    if (head.some((t, j) => j >= m && t.t === "(")) return null;
    // properties and indexers: `Type Name {` / `Type Name =>`
    if (scope !== "type" || term === ";") return null;
    const last = head[head.length - 1];
    if (last.t === "]") {
      // indexer: Type this[int i]
      for (let j = head.length - 1; j > m; j--)
        if (head[j].t === "[" && head[j - 1].t === "this") return { type: "member", kind: "property", name: "this[]", line: head[j - 1].line };
      return null;
    }
    if (last.k !== "id" || NOT_NAMES.has(last.t) || MODIFIERS.has(last.t)) return null;
    let q = head.length - 2;
    let name = last.t;
    while (q - 1 >= m && head[q].t === "." && head[q - 1].k === "id") {
      name = `${head[q - 1].t}.${name}`;
      q -= 2;
    }
    if (q < m || !isTypeEnd(head[q])) return null;
    if (head[m].k !== "id" && head[m].t !== "(") return null;
    if (head[m].k === "id" && NOT_NAMES.has(head[m].t)) return null;
    return { type: "member", kind: "property", name, line: last.line };
  };

  const parseScope = (scope: "file" | "namespace" | "type", typeName: string | null, into: OutlineSymbol[]) => {
    let out = into;
    while (i < n) {
      budget.tick();
      const head: Tok[] = [];
      let term = "";
      let assigned = false;
      while (i < n) {
        const tk = toks[i];
        if (tk.k === "p") {
          if (tk.t === "{" || tk.t === ";" || tk.t === "}" || tk.t === "=>") {
            term = tk.t;
            break;
          }
          if (ASSIGN.has(tk.t)) {
            assigned = true;
            break;
          }
          if (tk.t === "(" || tk.t === "[") {
            const end = skipGroup(i);
            for (let j = i; j < end; j++) head.push(toks[j]);
            i = end;
            continue;
          }
        }
        head.push(tk);
        i++;
      }
      if (i >= n) return;
      if (assigned) {
        i = skipStatement(i);
        continue;
      }
      if (term === "}") return; // the caller consumes it
      const termTok = toks[i];
      const decl = head.length ? classify(head, scope, typeName, term) : null;
      const sym: OutlineSymbol | null = decl ? { name: cleanName(decl.name), kind: decl.type === "namespace" ? "namespace" : decl.kind, line: decl.line, children: [] } : null;
      if (sym) out.push(sym);
      if (term === ";") {
        i++;
        if (decl?.type === "namespace" && scope === "file") {
          out = sym!.children; // file-scoped namespace: runs to the end of the file
          sym!.endLine = toks[n - 1].line;
        } else if (sym) sym.endLine = termTok.line;
        continue;
      }
      if (term === "=>") {
        i = skipStatement(i + 1);
        if (sym) sym.endLine = toks[Math.max(0, i - 1)].line;
        continue;
      }
      // term === "{"
      if (decl?.type === "namespace" || (decl?.type === "type" && decl.kind !== "enum")) {
        i++;
        parseScope(decl.type === "namespace" ? "namespace" : "type", decl.type === "type" ? decl.name : null, sym!.children);
        if (i < n) {
          sym!.endLine = toks[i].line;
          i++; // "}"
        }
      } else {
        const end = skipGroup(i);
        if (sym) sym.endLine = toks[Math.max(0, end - 1)].line;
        i = end;
      }
    }
  };

  const out: OutlineSymbol[] = [];
  while (i < n) {
    parseScope("file", null, out);
    i++; // a stray "}" at file level
  }
  return out;
}
