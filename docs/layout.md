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

The sidebar leaves out a short built-in list (`.git`, `.DS_Store`,
`node_modules`, `__pycache__`, `.venv`, `venv`), protected files (`.env` and
`.env.*`, such as `.env.local`, and `*.pem` / `*.key` keys; templates like `.env.example` show) and
anything you hide. Build output such as `dist` or `build` shows; right-click
it and choose **Hide** if you do not want it. Files git tracks are never hidden
by the built-in list: in a committed `node_modules/` folder, the tracked files
show and the untracked files around them stay hidden. Files git ignores are shown by
default, dimmed (with everything inside an ignored folder) in the sidebar, the
folder pages, search results and What's new; hover one to see "ignored by
git". The
full list and the rule syntax are in
[Configuration](configuration.md#hidden-files).

- The **Hidden files** button (the eye, left of Folder settings) shows how
  many items are hidden and opens a list of them, grouped as Built-in,
  Git-ignored, Hidden by you and Protected. A checked item shows; uncheck it
  to hide it. Each group has a checkbox for all its items.
- Unchecking the Git-ignored group hides every git-ignored item, also ones
  created later. Checking it shows them again.
- A change applies at once: a hidden item leaves the sidebar straight away.
  A shown big folder (a `node_modules` of thousands of files) fills into the
  sidebar a moment later, and into search after that. Quick clicks are sent
  in order, so the last one wins.
- Checking an item you hid removes your rule; it does not add another one.
- Folder sizes show as a file count (up to "10,000+"). A hidden folder lists
  its contents when you expand it, so a big `node_modules` costs nothing until
  then. You can show one item inside it.
- Click a file to open it. Click a folder to expand it.
- **Hide a pattern...** at the bottom adds a rule such as `*.log`.
- Right-click any file or folder > **Hide** (also in read-only mode).
  **Undo** in the toast brings it back.
- Hidden files open with a short note above them. They have no change
  highlights and cannot go in the review basket. Files on the ignore list are
  read-only; git-ignored files and files you hid can be edited.
- A protected file first asks you to confirm, because it may contain secrets.
  It is then shown as read-only text, without download, PDF or copy for AI.
  The answer is kept for the tab's session only.

## Where it is saved

In the browser's `localStorage` (the desktop app has its own), under
`viewer.sidebarWidth`, `viewer.tocWidth` and `viewer.readingWidth`. A
default value removes the key. Hide rules, the items you show or hide and the
git-ignored choice are per folder, stored by the server in its data dir
(`roots/<key>/hiding.json`), shared by every browser on that server.
