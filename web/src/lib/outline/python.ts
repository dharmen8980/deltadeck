// Python outline (Lezer): classes and their methods, functions (def / async
// def, also nested ones), decorated definitions. The line is the `def` /
// `class` line, not the decorator's.

import type { SyntaxNode, Tree } from "@lezer/common";
import { parser } from "@lezer/python";
import { Budget, LineIndex, NO_BUDGET, parseWithBudget, type OutlineSymbol } from "./common.ts";

export function parserFor(): typeof parser {
  return parser;
}

export function extract(tree: Tree, text: string, budget: Budget = NO_BUDGET): OutlineSymbol[] {
  const lines = new LineIndex(text);

  const visit = (node: SyntaxNode, out: OutlineSymbol[], inClass: boolean) => {
    for (let ch = node.firstChild; ch; ch = ch.nextSibling) {
      budget.tick();
      let def = ch;
      if (def.name === "DecoratedStatement") {
        const inner = def.getChild("FunctionDefinition") ?? def.getChild("ClassDefinition");
        if (!inner) continue;
        def = inner;
      }
      if (def.name === "FunctionDefinition" || def.name === "ClassDefinition") {
        const nameNode = def.getChild("VariableName");
        const body = def.getChild("Body");
        if (!nameNode) continue;
        const isClass = def.name === "ClassDefinition";
        const sym: OutlineSymbol = {
          name: text.slice(nameNode.from, nameNode.to),
          kind: isClass ? "class" : inClass ? "method" : "function",
          line: lines.line(nameNode.from),
          endLine: lines.line(Math.max(def.from, def.to - 1)),
          children: [],
        };
        out.push(sym);
        if (body) visit(body, sym.children, isClass);
        continue;
      }
      // Definitions inside if/try/with/for/match blocks at this level (e.g. `if TYPE_CHECKING:`).
      if (/Statement$|Clause$|Body$/.test(ch.name) && ch.firstChild) visit(ch, out, inClass);
    }
  };

  const out: OutlineSymbol[] = [];
  visit(tree.topNode, out, false);
  return out;
}

export function outlinePython(text: string, budget: Budget = NO_BUDGET): OutlineSymbol[] {
  return extract(parseWithBudget(parser, text, budget), text, budget);
}
