# Code outline

Source files open with an **Outline** of their symbols next to the code: a
side panel on wide screens, a collapsible block above the code otherwise, like
the markdown table of contents. Clicking an entry jumps to its line
(`#L<line>`) and briefly flashes it. While you scroll, the entry around the top
line of the code is highlighted. With 16 or more entries a filter box appears;
entries with children can be folded (also with the arrow keys: Up / Down move
between entries, Right / Left unfold / fold). Jumping replaces the `#L<line>`
in the address like a click on a line number, so Back leaves the file rather
than stepping through the symbols. A very large outline shows its first 500
entries, with a "Show more" button; the filter searches all of them. Files
without any symbols get no outline.

## Languages

| Language | Extensions | What is listed |
|---|---|---|
| Python | `.py` `.pyi` | classes with their methods, functions, nested functions and classes (also inside `if` / `try` blocks); decorated ones at the line of the `def`, not the decorator |
| JavaScript / TypeScript | `.js` `.mjs` `.cjs` `.jsx` `.ts` `.mts` `.cts` `.tsx` | classes with constructors, methods, getters / setters and arrow-function fields; functions; `const` arrow functions and function expressions (also wrapped in `memo` / `forwardRef` / `observer`, with or without type arguments); objects with methods (nested objects with methods too, e.g. Vue's `methods: {}`); `export default` (functions, classes, `class extends Base`, objects); CommonJS `exports.x = ...` / `module.exports = ...` and `X.prototype.y = function`; interfaces, type aliases, enums, namespaces; `describe` / `it` / `test` blocks with their names (also `.only` / `.skip` / `.each` / `test.describe(...)` and the other usual modifiers; hooks such as `beforeEach` and `test.step` are not listed). TypeScript overloads are one entry |
| CSS, SCSS, LESS | `.css` `.scss` `.less` | rule selectors (nested rules under their parent); `@media`, `@supports`, `@container` and `@layer` groups with the rules inside; `@keyframes`; `@font-face`; other block at-rules such as `@mixin` and `@function`. SCSS and LESS are best-effort |
| HTML | `.html` `.htm` | `h1`-`h6` with their text, landmarks (`header`, `nav`, `main`, `section`, `article`, `aside`, `footer`, or a landmark `role`), other elements with an `id`, and `<script>` / `<style>` blocks with the JavaScript symbols / CSS rules inside them |
| Java | `.java` | the package; classes, interfaces, enums, records and annotation types with their constructors, methods, fields and nested types |
| C# | `.cs` | namespaces (block and file-scoped); classes, structs, interfaces, records and enums with their constructors, finalizers, methods, operators, properties, indexers and nested types. Heuristic |
| Shell | `.sh` `.bash` `.zsh` | functions (`name() {`, `function name {`), grouped under section comments (`# ---- Name ----`, `### Name`, or a `# Name` line between two `# -----` lines). Heuristic |

Lines are 1-based and point at the symbol's name (not at decorators,
annotations or attributes above it). Statements, calls, variables and control
flow are not listed, and nor are enum members.

The outline is shown in the viewer only: not in the editor,
and not for `.docx`, markdown or other file types.

## How it works

- Python, JavaScript / TypeScript, CSS and HTML are parsed with the Lezer
  grammars the editor already uses; Java with `@lezer/java`. C# and shell use
  small rule-based scanners (no grammar). There is no tree-sitter, language
  server or Monaco.
- Each language's code is a separate chunk, downloaded the first time a file of
  that language is opened. Nothing language-specific is in the initial bundle.
- The outline is computed in a Web Worker after the code is on screen, so
  neither the parse nor the extraction blocks the page. The worker starts on
  the first code file and stops after 30 s without work. Files over 2 MB get no
  outline, and one that takes more than 1.5 s of work in the worker is given
  up. What stays on the page is receiving the result and drawing the panel:
  for a 1.8 MB LESS file with 52,000 rules that is one task of about 0.2 s,
  mostly layout of the large page; for ordinary files it is unnoticeable.
- Without workers (or if the worker cannot start) the outline is computed on
  the page instead, after an idle period with the parse in short slices; the
  other steps (C# / shell scanning, SCSS / LESS preprocessing, extraction) are
  each limited to 100 ms, and a file that needs more gets no outline.
- Files too large to highlight (300 KB-2 MB, shown by the chunked text
  viewer) fetch their text once more for the outline.
- Outlines are cached in the tab per path, modified time and size (and a hash
  of the text), for the 24 most recent files.

## Bundle size

Measured on `web/out` (`npm run build`), against `main` before the outline:

- Initial page JavaScript and CSS: +12.5 KB raw, +4.1 KB gzipped (the panel,
  the language table and the worker glue). `web/out` in all: +361 KB.
- Loaded on the first outline of a session: the worker, 4.3 KB / 2.1 KB.
- Loaded on first use of a language (raw / gzipped):
  - Lezer runtime, shared by the Lezer-based languages: 61 KB / 20 KB, once per
    session.
  - Python: 41 KB / 17 KB.
  - JavaScript / TypeScript: 87 KB / 33 KB.
  - CSS / SCSS / LESS: 23 KB / 10 KB.
  - HTML: 125 KB / 49 KB (this includes the JavaScript grammar).
  - Java: 51 KB / 20 KB.
  - C#: 7 KB / 3 KB.
  - Shell: 2 KB / 1 KB.
