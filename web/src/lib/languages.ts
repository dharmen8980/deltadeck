// One table of file extensions and their languages: the Shiki grammar of the highlighted view
// (none: shown as plain text), the CodeMirror language of the editor, and the code outline's
// extractor (none: no outline). Keep the server's kinds (server/deltadeck/paths.py EXT_KINDS) in
// mind when adding a row: only "code" files reach the highlighted view.
// No `@/` imports (relative `.ts` ones are fine): unit tested with node --test.

import type { OutlineTarget } from "./outline/run.ts";

/** The Shiki grammars in the bundle (lib/shiki.ts loads exactly these). */
export type ShikiLang =
  | "python"
  | "shellscript"
  | "json"
  | "yaml"
  | "toml"
  | "typescript"
  | "javascript"
  | "tsx"
  | "sql"
  | "ini"
  | "html"
  | "css"
  | "dockerfile"
  | "markdown";

export type EditorLang =
  | "markdown"
  | "json"
  | "python"
  | "yaml"
  | "shell"
  | "javascript"
  | "jsx"
  | "typescript"
  | "tsx"
  | "css"
  | "html"
  | "xml"
  | "toml"
  | "sql"
  | "dockerfile"
  | "go"
  | "rust"
  | "diff"
  | "ini"
  | "plain";

export interface LanguageRow {
  shiki?: ShikiLang;
  editor: EditorLang;
  outline?: OutlineTarget;
}

const PY: OutlineTarget = { lang: "python", variant: "" };
const SH: OutlineTarget = { lang: "shell", variant: "" };
const JSX: OutlineTarget = { lang: "javascript", variant: "jsx" };
const TS: OutlineTarget = { lang: "javascript", variant: "ts" };
const HTML: OutlineTarget = { lang: "html", variant: "" };

const row = (editor: EditorLang, shiki?: ShikiLang, outline?: OutlineTarget): LanguageRow => ({ shiki, editor, outline });

/** By lower-case extension (no dot). */
export const LANGUAGES: Readonly<Record<string, LanguageRow>> = {
  md: row("markdown", "markdown"),
  markdown: row("markdown", "markdown"),
  mdx: row("markdown"),
  json: row("json", "json"),
  jsonl: row("json"),
  ipynb: row("json"),
  py: row("python", "python", PY),
  pyi: row("python", "python", PY),
  yaml: row("yaml", "yaml"),
  yml: row("yaml", "yaml"),
  sh: row("shell", "shellscript", SH),
  bash: row("shell", "shellscript", SH),
  zsh: row("shell", "shellscript", SH),
  env: row("shell"),
  js: row("javascript", "javascript", JSX),
  mjs: row("javascript", "javascript", JSX),
  cjs: row("javascript", "javascript", JSX),
  jsx: row("jsx", "javascript", JSX),
  ts: row("typescript", "typescript", TS),
  mts: row("typescript", "typescript", TS),
  cts: row("typescript", "typescript", TS),
  tsx: row("tsx", "tsx", { lang: "javascript", variant: "tsx" }),
  css: row("css", "css", { lang: "css", variant: "css" }),
  scss: row("css", undefined, { lang: "css", variant: "scss" }),
  less: row("css", undefined, { lang: "css", variant: "less" }),
  html: row("html", "html", HTML),
  htm: row("html", "html", HTML),
  xml: row("xml"),
  svg: row("xml"),
  toml: row("toml", "toml"),
  sql: row("sql", "sql"),
  go: row("go"),
  rs: row("rust"),
  diff: row("diff"),
  patch: row("diff"),
  ini: row("ini", "ini"),
  cfg: row("ini", "ini"),
  conf: row("ini"),
  properties: row("ini"),
  java: row("plain", undefined, { lang: "java", variant: "" }),
  cs: row("plain", undefined, { lang: "csharp", variant: "" }),
};

export function languageFor(ext: string): LanguageRow | undefined {
  const e = ext.toLowerCase();
  return Object.hasOwn(LANGUAGES, e) ? LANGUAGES[e] : undefined;
}

/** "Dockerfile", "Dockerfile.dev", "app.dockerfile" (any case). */
export function isDockerfile(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "dockerfile" || lower.startsWith("dockerfile.") || lower.endsWith(".dockerfile");
}
