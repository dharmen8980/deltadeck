# Find in the file

A find bar for the open file, the same in the browser and in the desktop app.
It replaces the browser's own find, which misses the unloaded parts of large
files and the parts of a page that are not drawn.

## Shortcuts

| Keys (Ctrl instead of Cmd outside macOS) | |
|---|---|
| Cmd+F | Open the bar, or focus it and select its text. Starts from the selected text, or after a global search ("/") from that search's words |
| Enter, Cmd+G, F3 | Next match |
| Shift+Enter, Shift+Cmd+G, Shift+F3 | Previous match |
| Alt+C / Alt+W / Alt+R | Match case / whole word / regular expression |
| Esc | Close the bar, clear the highlights and give the focus back |

In the desktop app the **Edit** menu has **Find…**, **Find Next** and **Find
Previous** with the same shortcuts.

## Behaviour

- The bar searches as you type (after a short pause). Every match is
  highlighted, the current one stands out and is scrolled to the middle of the
  page; the focus stays in the bar. The counter says "3 of 17", "5,000+" or
  "No results" and is announced to screen readers.
- Next and previous wrap around at the ends; a small icon shows when they do.
  The first search starts at the first match on screen. Enter pressed before a
  search has finished is not lost: it applies once the results are in.
- Matches stay within one line. In rendered documents a line break inside a
  paragraph's source reads as a space (as it is shown), while `<br>` and block
  ends are line breaks. In CRLF files `$` matches before the `\r`.
- While a dialog is open (the `/` search, an unsaved-changes prompt) the find
  shortcuts are left to it.
- A regular expression that does not compile shows its error under the field.
  A pattern that takes too long (over about 2 s, in a worker) stops with a note.
- Case is ignored unless **Match case** is on. Accents are not folded: `e` does
  not find `é`.
- Opening another file keeps the query and searches the new file. When the open
  file changes on disk (live updates) the search runs again and stays on the
  same match where it can.

## What is searched

| Viewer | Searched |
|---|---|
| Code, plain text, JSON source, large logs | The whole text, not just what is drawn: a match in a part of a large file that is not loaded yet loads that part. Change marks, removed-line blocks and the gutter are never matched |
| JSON tree | The visible tree (keys and values); collapsed nodes are not searched, and the bar says so |
| Markdown, Word `.docx` | The rendered text, with tables, code blocks and diagrams; a match inside a collapsed `<details>` opens it. Buttons, anchors and other controls are skipped |
| Mermaid | The diagram's labels; on the Source tab the source text |
| CSV, xlsx | Every cell of the loaded rows (header included), in the order shown, so a sort changes the order. The current cell is outlined (a truncated cell shows its full text on hover) |
| PDF, images, other files | Nothing: the bar says why. In a PDF click into it and use its own find |
| Folder listings, diffs, blame | The text on the page |
| Editor (`--allow-edit`) | CodeMirror's own search panel (with replace); the shortcuts and the desktop menu open it |

## Limits

See the "Find in the file" entry in [Known limits](known-limits.md).
