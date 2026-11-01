// JavaScript / TypeScript outline (Lezer, with the JSX / TS / TSX dialects):
// classes and their methods, getters, setters, constructors and
// function-valued fields; function declarations; const/let/var bound to an
// arrow or function expression (also through memo()/forwardRef()); object
// literals with methods; `export default`; interfaces, type aliases, enums,
// namespaces; and describe()/it()/test() blocks with their name. Calls and
// callbacks themselves are not listed, but declarations inside them are.
// TypeScript overload signatures are folded into one entry (the first line).

import type { SyntaxNode, Tree } from "@lezer/common";
import { parser as baseParser } from "@lezer/javascript";
import type { LRParser } from "@lezer/lr";
import { Budget, cleanName, LineIndex, NO_BUDGET, parseWithBudget, type OutlineSymbol, type SymbolKind } from "./common.ts";

/** Which dialect: by file extension. */
export type JsVariant = "js" | "jsx" | "ts" | "tsx";

const parsers = new Map<JsVariant, LRParser>();

export function parserFor(variant: JsVariant = "js"): LRParser {
  let p = parsers.get(variant);
  if (!p) {
    const dialect = variant === "ts" ? "ts" : variant === "tsx" ? "ts jsx" : variant === "jsx" ? "jsx" : "";
    p = dialect ? baseParser.configure({ dialect }) : baseParser;
    parsers.set(variant, p);
  }
  return p;
}

const TEST_SUITES = new Set(["describe", "suite", "context", "fdescribe", "xdescribe"]);
const TEST_CASES = new Set(["it", "test", "specify", "fit", "xit", "bench"]);
const COMPONENT_WRAPPERS = new Set(["memo", "forwardRef", "observer"]);
const FUNCTION_NODES = new Set(["ArrowFunction", "FunctionExpression"]);

function stringValue(text: string): string {
  const q = text[0];
  if ((q === '"' || q === "'" || q === "`") && text.endsWith(q) && text.length >= 2) return text.slice(1, -1);
  return text;
}

/** Skip a TypeScript type-argument wrapper: `memo<P>` -> `memo`. */
function unwrapInstantiation(node: SyntaxNode | null): SyntaxNode | null {
  return node && node.name === "InstantiationExpression" ? node.firstChild : node;
}

/** Modifiers allowed between a test function and its call: `it.only`, `test.describe.serial`, `it.each([..])`. */
const TEST_MODIFIERS = new Set([
  "each",
  "skip",
  "only",
  "todo",
  "concurrent",
  "sequential",
  "serial",
  "parallel",
  "fixme",
  "fails",
  "failing",
  "runIf",
  "skipIf",
  "describe",
]);

/**
 * A test call's callee: `describe.each([1])` / it.each`table` / test.describe.only
 * -> its base identifier and the properties after it. Null for anything else
 * (e.g. `context.log`, whose property is not a test modifier).
 */
function testCallee(node: SyntaxNode | null, text: string): { base: string; props: string[] } | null {
  const props: string[] = [];
  while (node) {
    switch (node.name) {
      case "VariableName":
        return { base: text.slice(node.from, node.to), props: props.reverse() };
      case "MemberExpression": {
        const last = node.lastChild;
        if (!last || last.name !== "PropertyName") return null;
        const prop = text.slice(last.from, last.to);
        if (!TEST_MODIFIERS.has(prop)) return null;
        props.push(prop);
        node = node.firstChild;
        break;
      }
      case "CallExpression":
      case "TaggedTemplateExpression":
      case "InstantiationExpression":
        node = node.firstChild;
        break;
      default:
        return null;
    }
  }
  return null;
}

/** The last property of a callee (`React.memo` -> `memo`, `memo<P>` -> `memo`). */
function calleeLast(node: SyntaxNode | null, text: string): string | null {
  node = unwrapInstantiation(node);
  if (!node) return null;
  if (node.name === "VariableName") return text.slice(node.from, node.to);
  if (node.name === "MemberExpression") {
    const last = node.lastChild;
    return last && last.name === "PropertyName" ? text.slice(last.from, last.to) : null;
  }
  return null;
}

function argFunction(args: SyntaxNode | null): SyntaxNode | null {
  for (let a = args?.firstChild ?? null; a; a = a.nextSibling) if (FUNCTION_NODES.has(a.name)) return a;
  return null;
}

/** The function a component wrapper wraps, also through nested ones: memo(forwardRef(fn)). */
function wrappedFunction(call: SyntaxNode, text: string, depth = 0): SyntaxNode | null {
  const last = calleeLast(call.firstChild, text);
  if (!last || !COMPONENT_WRAPPERS.has(last)) return null;
  const args = call.getChild("ArgList");
  const fn = argFunction(args);
  if (fn || depth > 3) return fn;
  const inner = args?.getChild("CallExpression");
  return inner ? wrappedFunction(inner, text, depth + 1) : null;
}

/** `exports.x` / `module.exports.x` / `module.exports` / `A.prototype.x`: the name to list, or null. */
function exportTarget(left: SyntaxNode, text: string): string | null {
  if (left.name !== "MemberExpression") return null;
  const src = text.slice(left.from, left.to).replace(/\s+/g, "");
  if (src === "module.exports") return "module.exports";
  const m = /^(?:module\.)?exports\.([\w$]+)$/.exec(src);
  if (m) return m[1];
  if (/^[\w$]+(?:\.[\w$]+)*\.prototype\.[\w$]+$/.test(src)) return src;
  return null;
}

export function extract(tree: Tree, text: string, budget: Budget = NO_BUDGET, variant: JsVariant = "js"): OutlineSymbol[] {
  const lines = new LineIndex(text);
  const ts = variant === "ts" || variant === "tsx";
  const slice = (n: SyntaxNode) => text.slice(n.from, n.to);
  const endOf = (n: SyntaxNode) => lines.line(Math.max(n.from, n.to - 1));

  const make = (name: string, kind: SymbolKind, at: SyntaxNode, whole: SyntaxNode): OutlineSymbol => ({
    name: cleanName(name),
    kind,
    line: lines.line(at.from),
    endLine: endOf(whole),
    children: [],
  });

  /** Symbols of a function's body (nested declarations). */
  const body = (fn: SyntaxNode, into: OutlineSymbol[]) => {
    const block = fn.getChild("Block");
    if (block) visit(block, into);
  };

  const classBody = (cls: SyntaxNode, into: OutlineSymbol[]) => {
    const cb = cls.getChild("ClassBody");
    if (!cb) return;
    for (let m = cb.firstChild; m; m = m.nextSibling) {
      budget.tick();
      if (m.name === "MethodDeclaration") {
        const nameNode =
          m.getChild("PropertyDefinition") ??
          m.getChild("PrivatePropertyDefinition") ??
          m.getChild("String") ??
          m.getChild("Number");
        let name: string;
        let at: SyntaxNode;
        if (nameNode) {
          name = nameNode.name === "String" ? stringValue(slice(nameNode)) : slice(nameNode);
          at = nameNode;
        } else {
          const open = m.getChild("[");
          const close = m.getChild("]");
          if (!open || !close) continue;
          name = text.slice(open.from, close.to);
          at = open;
        }
        const kind: SymbolKind =
          name === "constructor" ? "constructor" : m.getChild("get") ? "getter" : m.getChild("set") ? "setter" : "method";
        const sym = make(name, kind, at, m);
        into.push(sym);
        body(m, sym.children);
      } else if (m.name === "PropertyDeclaration") {
        const nameNode = m.getChild("PropertyDefinition") ?? m.getChild("PrivatePropertyDefinition");
        const fn = m.getChild("ArrowFunction") ?? m.getChild("FunctionExpression");
        if (!nameNode || !fn) continue;
        const sym = make(slice(nameNode), "method", nameNode, m);
        into.push(sym);
        body(fn, sym.children);
      }
    }
  };

  /** Methods of an object literal; nested objects with methods too (Vue's `methods: { save() {} }`). */
  const objectMembers = (obj: SyntaxNode, depth = 0): OutlineSymbol[] => {
    const methods: OutlineSymbol[] = [];
    for (let p = obj.firstChild; p; p = p.nextSibling) {
      budget.tick();
      if (p.name !== "Property") continue;
      const pn = p.getChild("PropertyDefinition") ?? p.getChild("PropertyName") ?? p.getChild("String");
      if (!pn) continue;
      const pname = pn.name === "String" ? stringValue(slice(pn)) : slice(pn);
      const kind: SymbolKind = p.getChild("get") ? "getter" : p.getChild("set") ? "setter" : "method";
      if (p.getChild("ParamList")) {
        const sym = make(pname, kind, pn, p);
        methods.push(sym);
        body(p, sym.children);
        continue;
      }
      const fn = p.getChild("ArrowFunction") ?? p.getChild("FunctionExpression");
      if (fn) {
        const sym = make(pname, "method", pn, p);
        methods.push(sym);
        body(fn, sym.children);
        continue;
      }
      const inner = depth < 4 ? p.getChild("ObjectExpression") : null;
      const children = inner ? objectMembers(inner, depth + 1) : [];
      if (children.length) {
        const sym = make(pname, "property", pn, p);
        sym.children = children;
        methods.push(sym);
      }
    }
    return methods;
  };

  /** A value bound to a name: emit a symbol if it is function-like, a class or an object with methods. */
  const bound = (
    nameNode: SyntaxNode,
    value: SyntaxNode | null,
    whole: SyntaxNode,
    into: OutlineSymbol[],
    name = slice(nameNode),
  ): boolean => {
    if (!value) return false;
    if (FUNCTION_NODES.has(value.name)) {
      const sym = make(name, "function", nameNode, whole);
      into.push(sym);
      body(value, sym.children);
      return true;
    }
    if (value.name === "ClassExpression") {
      const sym = make(name, "class", nameNode, whole);
      into.push(sym);
      classBody(value, sym.children);
      return true;
    }
    if (value.name === "CallExpression") {
      const fn = wrappedFunction(value, text);
      if (fn) {
        const sym = make(name, "function", nameNode, whole);
        into.push(sym);
        body(fn, sym.children);
        return true;
      }
      return false;
    }
    if (value.name === "ObjectExpression") {
      const methods = objectMembers(value);
      if (!methods.length) return false;
      const sym = make(name, "variable", nameNode, whole);
      sym.children = methods;
      into.push(sym);
      return true;
    }
    return false;
  };

  const testCall = (call: SyntaxNode, into: OutlineSymbol[]): boolean => {
    const callee = testCallee(call.firstChild, text);
    if (!callee) return false;
    const { base, props } = callee;
    const suite = TEST_SUITES.has(base) || props.includes("describe");
    if (!suite && !TEST_CASES.has(base)) return false;
    const args = call.getChild("ArgList");
    const first = args?.firstChild?.nextSibling; // after "("
    if (!first || first.name === ")") return false;
    const fn = argFunction(args);
    let label: string;
    if (first.name === "String" || first.name === "TemplateString") label = stringValue(slice(first));
    // describe(MyClass, () => {}): a name, but only with a callback
    else if (fn && suite && (first.name === "VariableName" || first.name === "MemberExpression")) label = slice(first);
    else return false;
    // mocha's `context(...)`: also a common variable name, so only with a callback
    if (base === "context" && !fn) return false;
    const sym = make(label, suite ? "suite" : "test", call, call);
    into.push(sym);
    if (fn) body(fn, sym.children);
    return true;
  };

  const visit = (node: SyntaxNode, into: OutlineSymbol[], exportDefault = false) => {
    for (let ch = node.firstChild; ch; ch = ch.nextSibling) {
      budget.tick();
      switch (ch.name) {
        case "ExportDeclaration": {
          const def = ch.getChild("default");
          const fn = def && (ch.getChild("ArrowFunction") ?? ch.getChild("FunctionExpression"));
          const cls = def && ch.getChild("ClassExpression");
          const obj = def && ch.getChild("ObjectExpression");
          if (def && obj && bound(def, obj, ch, into, "default")) continue;
          if (def && fn) {
            const sym = make("default", "function", def, ch);
            into.push(sym);
            body(fn, sym.children);
          } else if (def && cls) {
            const sym = make("default", "class", def, ch);
            into.push(sym);
            classBody(cls, sym.children);
          } else visit(ch, into, Boolean(def));
          continue;
        }
        case "AmbientDeclaration":
          visit(ch, into, exportDefault);
          continue;
        case "FunctionDeclaration":
        case "AmbientFunctionDeclaration": {
          const nameNode = ch.getChild("VariableDefinition");
          if (!nameNode && !exportDefault) continue;
          const sym = make(nameNode ? slice(nameNode) : "default", "function", nameNode ?? ch.getChild("function") ?? ch, ch);
          into.push(sym);
          body(ch, sym.children);
          continue;
        }
        case "ClassDeclaration": {
          let nameNode = ch.getChild("VariableDefinition");
          if (nameNode && nameNode.from === nameNode.to) nameNode = null; // error recovery: an empty name
          // `export default class extends Base {`: the parser may take `Base` for the name (after an error node)
          for (let k = ch.firstChild; nameNode && k && k.from < nameNode.from; k = k.nextSibling)
            if (k.type.isError && /\bextends\b/.test(slice(k))) nameNode = null;
          if (!nameNode) {
            // also `export default class {` (the parser gives up on the body) or a decorator it could not attach
            if (!exportDefault) continue;
            const sym = make("default", "class", ch.getChild("class") ?? ch, ch);
            into.push(sym);
            classBody(ch, sym.children);
            continue;
          }
          const sym = make(slice(nameNode), "class", nameNode, ch);
          into.push(sym);
          classBody(ch, sym.children);
          continue;
        }
        case "InterfaceDeclaration":
        case "TypeAliasDeclaration":
        case "EnumDeclaration": {
          const nameNode = ch.getChild("TypeDefinition");
          if (!nameNode) continue;
          const kind: SymbolKind =
            ch.name === "InterfaceDeclaration" ? "interface" : ch.name === "EnumDeclaration" ? "enum" : "type";
          into.push(make(slice(nameNode), kind, nameNode, ch));
          continue;
        }
        case "NamespaceDeclaration": {
          const nameNode = ch.getChild("VariableDefinition") ?? ch.getChild("String");
          const block = ch.getChild("Block");
          if (!nameNode) continue;
          const name = text.slice(nameNode.from, block ? block.from : nameNode.to);
          const kw = ch.getChild("module") ? "module" : "namespace";
          const sym = make(nameNode.name === "String" ? stringValue(name.trim()) : name, kw === "module" ? "module" : "namespace", nameNode, ch);
          into.push(sym);
          if (block) visit(block, sym.children);
          continue;
        }
        case "VariableDeclaration": {
          for (let v = ch.firstChild; v; v = v.nextSibling) {
            if (v.name !== "VariableDefinition") continue;
            let value = v.nextSibling;
            if (value?.name === "TypeAnnotation") value = value.nextSibling;
            if (value?.name !== "Equals") continue;
            value = value.nextSibling;
            // Not a definition itself: still look inside, e.g. useMemo(() => { function f() {} }).
            if (value && !bound(v, value, ch, into)) visit(value, into);
          }
          continue;
        }
        case "CallExpression":
          if (testCall(ch, into)) continue;
          break;
        case "AssignmentExpression": {
          // CommonJS / prototype definitions: exports.handler = async () => {}, module.exports = {...}
          const left = ch.firstChild;
          const eq = ch.getChild("Equals");
          const name = left && eq ? exportTarget(left, text) : null;
          const value = eq?.nextSibling ?? null;
          if (name && left && value && bound(left, value, ch, into, name)) continue;
          break;
        }
      }
      if (ch.firstChild) visit(ch, into);
    }
  };

  const out: OutlineSymbol[] = [];
  visit(tree.topNode, out);
  if (ts) foldOverloads(out);
  return out;
}

/** Fold `f(a: string): void; f(a: any) {}` (same name and kind, adjacent) into the first entry, at every level. */
function foldOverloads(list: OutlineSymbol[]): void {
  for (const s of list) foldOverloads(s.children);
  for (let i = list.length - 1; i > 0; i--) {
    const a = list[i - 1];
    const b = list[i];
    if (
      a.name === b.name &&
      a.kind === b.kind &&
      (a.kind === "function" || a.kind === "method" || a.kind === "constructor")
    ) {
      a.endLine = Math.max(a.endLine ?? a.line, b.endLine ?? b.line);
      a.children = a.children.concat(b.children);
      list.splice(i, 1);
    }
  }
}

export function outlineJavaScript(text: string, variant: JsVariant = "js", budget: Budget = NO_BUDGET): OutlineSymbol[] {
  return extract(parseWithBudget(parserFor(variant), text, budget), text, budget, variant);
}
