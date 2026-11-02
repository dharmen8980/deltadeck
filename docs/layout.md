# Layout

## Resizing the panels

The file sidebar and the right-hand panel (**On this page** for markdown and
`.docx`, **Outline** for source code) can be made wider or narrower by
dragging their inner edge. The cursor changes on the edge.

| Panel | Default | Range |
|---|---|---|
| File sidebar | 20rem (320px) | 12rem to 40rem, and at most half of the window |
| Contents / outline | 15rem (240px) | 10rem to 28rem, and at most 35% of the window |

- Double-click an edge to go back to the default width.
- Keyboard: Tab to the edge (it is a separator with its width announced), then
  Left / Right move it 16px (Shift: 64px), Home / End go to the smallest /
  largest width and Enter resets.
- The two panels together always leave the document at least 480px: with a
  wide sidebar open, the contents panel gets what is left (down to its
  minimum).
- When the window gets narrower a wide panel shrinks to fit; it comes back to
  the chosen width when the window is wide enough again.
- Collapsing the sidebar (Cmd/Ctrl+B or the button in the header) keeps its
  width. There are no handles on narrow screens (the sidebar is an overlay
  there and the contents panel moves above the text) or in print.

## Reading width

The **Reading width** button in the header of a markdown or `.docx` file sets
the maximum width of the text column: Narrow (42rem), Medium (56rem), Wide
(72rem) or Full width (the default). It applies to every document, not only
the open one. The editor's preview stays at 56rem.

Documents are laid out like source code: the text starts at the left edge
of the viewer, and the **On this page** panel is docked to the right edge
(with a border, like the code **Outline**). With a width other than Full,
the text stays on the left and the spare space sits between it and the
panel. The panel scrolls on its own, with its scrollbar hidden like the
file sidebar's.

## Hidden files

When the folder is inside a git repository, files and folders that git
ignores are left out of the sidebar, search and What's new. Files git tracks
stay visible even if an ignore pattern matches them. The viewer's own ignore
list (`node_modules`, `.venv`, `__pycache__`, ...) and protected files
(`.env`, `*.pem`, `*token*`, ...) are left out too.

**Show hidden files** in the sidebar's filter menu lists them, dimmed:

- Hover a row to see why it is hidden: ignored by git, on the viewer's ignore
  list, or protected. Protected files have a lock icon.
- A hidden folder is listed when you open it, so a big `node_modules` costs
  nothing until then.
- Hidden files open like any other file, with a short note above them. They
  have no change highlights and cannot go in the review basket. Files on the
  ignore list are read-only; git-ignored files can be edited as before.
- A protected file first asks you to confirm, because it may contain secrets.
  It is then shown as read-only text, without download, PDF or copy for AI.
  The answer is kept for the tab's session only.
- Hidden items are not shown while a file type or **Changed since viewed**
  filter is on.

## Where it is saved

In the browser's `localStorage` (the desktop app has its own), under
`viewer.sidebarWidth`, `viewer.tocWidth`, `viewer.readingWidth` and
`viewer.showHidden`. A default value removes the key. Nothing is stored on the
server.
