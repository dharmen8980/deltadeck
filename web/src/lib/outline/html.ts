// HTML outline (Lezer): the document structure. Headings h1-h6 (with their
// text), landmark elements (header, nav, main, section, article, aside,
// footer, or any element with a landmark role), other elements that have an id, and <script> / <style> blocks
// whose children are the JavaScript symbols / CSS rules inside them (parsed
// with the JavaScript and CSS extractors). Everything else is transparent:
// its listed descendants show up under the nearest listed ancestor.

import type { SyntaxNode, Tree } from "@lezer/common";
import { parser } from "@lezer/html";
import { Budget, cleanName, LineIndex, NO_BUDGET, parseWithBudget, shiftLines, type OutlineSymbol } from "./common.ts";
import { extract as extractCss, parserFor as cssParser } from "./css.ts";
import { extract as extractJs, parserFor as jsParser, type JsVariant } from "./javascript.ts";

export function parserFor(): typeof parser {
  return parser;
}

const LANDMARKS = new Set(["header", "nav", "main", "section", "article", "aside", "footer"]);
/** ARIA landmark roles: any element with one counts as a landmark. */
const LANDMARK_ROLES = new Set(["banner", "navigation", "main", "region", "complementary", "contentinfo", "search", "form"]);
const HEADING = /^h[1-6]$/;
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** JavaScript dialect for a <script>, or null when it is not JavaScript (JSON, templates...). */
function scriptVariant(type: string | undefined, lang: string | undefined): JsVariant | null {
  const l = (lang ?? "").toLowerCase();
  if (l === "ts" || l === "typescript") return "ts";
  if (l === "tsx") return "tsx";
  const t = (type ?? "").toLowerCase().trim();
  if (!t || t === "module" || /^(text|application)\/(x-)?(java|ecma)script$/.test(t)) return "js";
  if (t === "text/babel" || t === "text/jsx") return "jsx";
  return null;
}

export function extract(tree: Tree, text: string, budget: Budget = NO_BUDGET): OutlineSymbol[] {
  const lines = new LineIndex(text);
  const slice = (n: SyntaxNode) => text.slice(n.from, n.to);

  const attrs = (tag: SyntaxNode): Map<string, string> => {
    const m = new Map<string, string>();
    for (let a = tag.firstChild; a; a = a.nextSibling) {
      if (a.name !== "Attribute") continue;
      const n = a.getChild("AttributeName");
      if (!n) continue;
      const v = a.getChild("AttributeValue") ?? a.getChild("UnquotedAttributeValue");
      let value = v ? slice(v) : "";
      if (v?.name === "AttributeValue" && /^["']/.test(value)) value = value.slice(1, value.endsWith(value[0]) && value.length > 1 ? -1 : undefined);
      m.set(slice(n).toLowerCase(), decodeEntities(value));
    }
    return m;
  };

  /** Symbols of an embedded block, re-based to the file's lines. */
  const embedded = (node: SyntaxNode, kind: "js" | "css", variant: JsVariant): OutlineSymbol[] => {
    const src = slice(node);
    if (!src.trim()) return [];
    const delta = lines.line(node.from) - 1;
    const syms =
      kind === "css"
        ? extractCss(parseWithBudget(cssParser(), src, budget), src, budget)
        : extractJs(parseWithBudget(jsParser(variant), src, budget), src, budget, variant);
    return shiftLines(syms, delta);
  };

  const visit = (node: SyntaxNode, into: OutlineSymbol[]) => {
    for (let el = node.firstChild; el; el = el.nextSibling) {
      budget.tick();
      if (el.name !== "Element") continue;
      const tag = el.getChild("OpenTag") ?? el.getChild("SelfClosingTag");
      const tagName = tag?.getChild("TagName");
      if (!tag || !tagName) {
        visit(el, into);
        continue;
      }
      const name = slice(tagName).toLowerCase();
      const line = lines.line(tag.from);
      const endLine = lines.line(Math.max(el.from, el.to - 1));
      const a = attrs(tag);
      const id = a.get("id");

      if (HEADING.test(name)) {
        const close = el.getChild("CloseTag");
        const inner = text.slice(tag.to, close ? close.from : el.to).replace(/<[^>]*>/g, " ");
        into.push({ name: cleanName(decodeEntities(inner)) || `<${name}>`, kind: "heading", line, endLine, children: [] });
        continue;
      }
      if (name === "script") {
        const variant = scriptVariant(a.get("type"), a.get("lang"));
        const src = a.get("src");
        const type = a.get("type");
        const label = `script${src ? ` ${src}` : ""}${type && type !== "module" && !variant ? ` (${type})` : type === "module" ? " (module)" : ""}`;
        const body = el.getChild("ScriptText");
        const children = body && variant ? embedded(body, "js", variant) : [];
        into.push({ name: cleanName(label), kind: "script", line, endLine, children });
        continue;
      }
      if (name === "style") {
        const body = el.getChild("StyleText");
        into.push({ name: "style", kind: "style", line, endLine, children: body ? embedded(body, "css", "js") : [] });
        continue;
      }
      const landmark = LANDMARKS.has(name) || LANDMARK_ROLES.has((a.get("role") ?? "").toLowerCase());
      if (landmark || id) {
        const label = a.get("aria-label");
        const sym: OutlineSymbol = {
          name: cleanName(id ? `${name}#${id}` : label ? `${name} "${label}"` : name),
          kind: landmark ? "landmark" : "element",
          line,
          endLine,
          children: [],
        };
        into.push(sym);
        visit(el, sym.children);
        continue;
      }
      visit(el, into);
    }
  };

  const out: OutlineSymbol[] = [];
  visit(tree.topNode, out);
  return out;
}

export function outlineHtml(text: string, budget: Budget = NO_BUDGET): OutlineSymbol[] {
  return extract(parseWithBudget(parser, text, budget), text, budget);
}
