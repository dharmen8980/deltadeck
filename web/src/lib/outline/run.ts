// Loading and running one language's outliner. Shared by the outline worker
// (worker.ts) and the main-thread fallback in index.ts. The extractors (and
// their Lezer parsers) are only fetched by dynamic import() when a file of
// that language is opened.

import type { Parser, Tree } from "@lezer/common";
import { Budget, parseWithBudget, type OutlineSymbol } from "./common.ts";

export type OutlineLang = "python" | "javascript" | "css" | "html" | "java" | "csharp" | "shell";

export interface OutlineTarget {
  lang: OutlineLang;
  /** dialect within the language: js/jsx/ts/tsx, css/scss/less */
  variant: string;
}

/** A message to the outline worker, and its answer. */
export interface OutlineRequest {
  id: number;
  target: OutlineTarget;
  text: string;
  budgetMs: number;
}

export type OutlineResponse = { id: number; symbols: OutlineSymbol[] | null } | { id: number; error: string };

export interface LezerModule {
  parserFor(variant: string): Parser;
  prepare?(text: string, variant: string, budget: Budget): string;
  extract(tree: Tree, text: string, budget: Budget, variant: string): OutlineSymbol[];
}

export type Loaded =
  | { kind: "lezer"; mod: LezerModule }
  | { kind: "sync"; run: (text: string, budget: Budget) => OutlineSymbol[] };

export async function loadOutliner(lang: OutlineLang): Promise<Loaded> {
  switch (lang) {
    case "python":
      return { kind: "lezer", mod: (await import("./python.ts")) as unknown as LezerModule };
    case "javascript":
      return { kind: "lezer", mod: (await import("./javascript.ts")) as unknown as LezerModule };
    case "css":
      return { kind: "lezer", mod: (await import("./css.ts")) as unknown as LezerModule };
    case "html":
      return { kind: "lezer", mod: (await import("./html.ts")) as unknown as LezerModule };
    case "java":
      return { kind: "lezer", mod: (await import("./java.ts")) as unknown as LezerModule };
    case "csharp":
      return { kind: "sync", run: (await import("./csharp.ts")).outlineCSharp };
    case "shell":
      return { kind: "sync", run: (await import("./shell.ts")).outlineShell };
  }
}

/** The whole outline in one go (prepare, parse, extract), all within `budget`. Throws OutlineTimeout past it. */
export function runOutliner(loaded: Loaded, variant: string, text: string, budget: Budget): OutlineSymbol[] {
  if (loaded.kind === "sync") return loaded.run(text, budget);
  const { mod } = loaded;
  const input = mod.prepare ? mod.prepare(text, variant, budget) : text;
  return mod.extract(parseWithBudget(mod.parserFor(variant), input, budget), text, budget, variant);
}
