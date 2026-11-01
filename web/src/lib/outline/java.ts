// Java outline (@lezer/java): the package, then classes, interfaces, enums,
// records and annotation types with their constructors, methods, fields and
// nested types. Method bodies are not entered, so anonymous and local classes
// are not listed. The line is the line of the name, not of the annotations.

import type { SyntaxNode, Tree } from "@lezer/common";
import { parser } from "@lezer/java";
import { Budget, cleanName, LineIndex, NO_BUDGET, parseWithBudget, type OutlineSymbol, type SymbolKind } from "./common.ts";

export function parserFor(): typeof parser {
  return parser;
}

const TYPE_KINDS: Record<string, SymbolKind> = {
  ClassDeclaration: "class",
  InterfaceDeclaration: "interface",
  EnumDeclaration: "enum",
  RecordDeclaration: "record",
  AnnotationTypeDeclaration: "annotation",
};

const BODIES = new Set(["ClassBody", "InterfaceBody", "EnumBody", "EnumBodyDeclarations", "RecordBody", "AnnotationTypeBody"]);

export function extract(tree: Tree, text: string, budget: Budget = NO_BUDGET): OutlineSymbol[] {
  const lines = new LineIndex(text);
  const slice = (n: SyntaxNode) => text.slice(n.from, n.to);
  const make = (name: string, kind: SymbolKind, at: SyntaxNode, whole: SyntaxNode): OutlineSymbol => ({
    name: cleanName(name),
    kind,
    line: lines.line(at.from),
    endLine: lines.line(Math.max(whole.from, whole.to - 1)),
    children: [],
  });

  const members = (body: SyntaxNode, into: OutlineSymbol[]) => {
    for (let m = body.firstChild; m; m = m.nextSibling) {
      budget.tick();
      const typeKind = TYPE_KINDS[m.name];
      if (typeKind) {
        const nameNode = m.getChild("Definition") ?? m.getChild("Identifier");
        if (!nameNode) continue;
        const sym = make(slice(nameNode), typeKind, nameNode, m);
        into.push(sym);
        for (let b = m.firstChild; b; b = b.nextSibling) if (BODIES.has(b.name)) members(b, sym.children);
        continue;
      }
      switch (m.name) {
        case "EnumBodyDeclarations":
          members(m, into);
          break;
        case "MethodDeclaration":
        case "ConstructorDeclaration":
        case "CompactConstructorDeclaration":
        case "AnnotationTypeElementDeclaration": {
          const nameNode = m.getChild("Definition") ?? m.getChild("Identifier");
          if (!nameNode) break;
          const kind: SymbolKind = m.name === "MethodDeclaration" || m.name === "AnnotationTypeElementDeclaration" ? "method" : "constructor";
          into.push(make(slice(nameNode), kind, nameNode, m));
          break;
        }
        case "FieldDeclaration":
        case "ConstantDeclaration":
          for (let d = m.firstChild; d; d = d.nextSibling) {
            if (d.name !== "VariableDeclarator") continue;
            const nameNode = d.getChild("Definition");
            if (nameNode) into.push(make(slice(nameNode), "field", nameNode, m));
          }
          break;
      }
    }
  };

  const out: OutlineSymbol[] = [];
  const top = tree.topNode;
  for (let ch = top.firstChild; ch; ch = ch.nextSibling) {
    if (ch.name === "PackageDeclaration") {
      const id = ch.getChild("ScopedIdentifier") ?? ch.getChild("Identifier");
      if (id) out.push(make(slice(id), "package", id, ch));
      break;
    }
  }
  members(top, out);
  return out;
}

export function outlineJava(text: string, budget: Budget = NO_BUDGET): OutlineSymbol[] {
  return extract(parseWithBudget(parser, text, budget), text, budget);
}
