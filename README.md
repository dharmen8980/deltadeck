# DeltaDeck

Every change, stacked for review. DeltaDeck is a local-only viewer for one
folder of documents and code. It is **read-only by
default**; editing and file management can be switched on with `--allow-edit`
(see [Editing](docs/editing.md)). The folder is given with `--root` /
`DOCS_VIEWER_ROOT`, or chosen in the browser with the native folder dialog and
switched at runtime from a list of recent folders (see [Choosing and switching
folders](docs/configuration.md#choosing-and-switching-folders)). A FastAPI server (`server/viewer/`)
reads the folder and serves a static Next.js single-page app (`web/`, built to
`web/out`) on `http://127.0.0.1:8765/`.

What it does:

- A file tree with sorting by name or modified time, a filter box and a
  "Recently changed" list.
- Files git ignores are hidden like the viewer's own ignore list. **Show
  hidden files** lists them dimmed; protected files like `.env` open read-only
  after a confirmation. See [Layout](docs/layout.md#hidden-files).
- Viewers for each file type:
  - Markdown: GFM, a table of contents, mermaid diagrams, shiki highlighting,
    and relative links and images that resolve inside the folder.
  - `.mmd` diagrams and source code with line anchors.
  - A code outline next to source code (Python, JavaScript / TypeScript,
    CSS / SCSS / LESS, HTML, Java, C#, shell): classes, functions, methods,
    selectors, headings and so on, with jump-to-line; see [Code
    outline](docs/outline.md).
  - JSON as a tree or as source.
  - CSV and xlsx as sortable tables.
  - Word `.docx`, view-only: converted on the server (mammoth) to sanitized
    HTML in the markdown typography, with a table of contents, search,
    change highlights and PDF export. Layout and styling are not kept; see
    [Word documents](docs/docx.md).
  - Images and PDFs.
  - Large logs, loaded in chunks with real line numbers. The whole file is
    never loaded.
- Full-text search (SQLite FTS5, a contentless index on disk) with folder and type filters.
  Match lines are ranked (whole phrase, then most distinct terms, then
  whole-word hits). Choosing a markdown/mermaid match opens
  `/?p=...&hl=<query>&hll=<match line>` and scrolls to the rendered block that
  best matches that line.
- Live updates through Server-Sent Events: new, modified, renamed and deleted
  files and folders.
- Changed since you last looked: files that changed since you last opened them
  get a dot in the sidebar (and their folders too). Opening one shows what
  changed, with highlighted markdown blocks or a line diff. A **What's new**
  feed in the sidebar lists them all, newest first, with what changed in each.
  The history is kept in the server's data dir, never in the folder; see
  [Changes](docs/changes.md).
- Read-only git awareness, when the folder is inside a git repository: what
  changed since the last commit (same banner, highlights and diff), an
  **Uncommitted** list in What's new with M/A/D/R/?? and +/- lines, and blame.
  Nothing is ever written to the repository; see [Git](docs/git.md).
- Find in the open file (Cmd/Ctrl+F, also in the desktop Edit menu): live
  matches with match case, whole word and regex, across the whole text of large
  files, every CSV cell and rendered markdown; see [Find in the file](docs/find.md).
- Deep links (`/?p=<path>#<heading>` or `#L<line>`), light/dark themes and a
  print stylesheet for markdown.
- Resizable panels: drag (or use the arrow keys on) the edge of the file sidebar
  and of the contents / outline panel; double-click resets. A **Reading width**
  menu (Narrow, Medium, Wide, Full width; Full is the default) sets the markdown
  and `.docx` column. Both are remembered; see [Layout](docs/layout.md).
- **Download PDF** for markdown, `.mmd` and `.docx` files: a properly paginated PDF
  rendered by headless Google Chrome on the server (see [PDF export](docs/pdf-export.md)).
- Opt-in editing (`--allow-edit`): a CodeMirror editor with live preview, file
  management (new, rename, move, duplicate, upload, delete to Trash), version
  history and undo (see [Editing](docs/editing.md)).

## Get it

**Desktop app (macOS, Linux):** download the `.dmg`, `.AppImage` or `.deb` from
[Releases](https://github.com/dharmen8980/local-docs-viewer/releases). The app
is unsigned for now: on macOS, right-click it and choose **Open** the first
time. Details in [docs/desktop.md](docs/desktop.md).

**From source** (needs [uv](https://docs.astral.sh/uv/) and Node.js):

```sh
git clone https://github.com/dharmen8980/local-docs-viewer.git
cd local-docs-viewer
uv sync
cd web && npm ci && npm run build && cd ..
uv run viewer                  # http://127.0.0.1:8765/ (choose a folder in the browser)
uv run viewer --root ~/notes   # or start on a given folder
```

## Documentation

| Topic | |
|---|---|
| [Development](docs/development.md) | Prerequisites, install, build and run, dev mode with hot reload, tests |
| [Configuration](docs/configuration.md) | Flags and environment variables; choosing and switching folders; `/api/roots` |
| [Editing](docs/editing.md) | `--allow-edit`, history, trash, the recovery data dir, backups, limits, how writes are protected |
| [Changes](docs/changes.md) | "Changed since you last looked": dots, the filter, the What's new feed, the banner, highlights, where the history is kept |
| [Review basket](docs/review.md) | Picking highlighted changes, a note each, and copying them as one prompt for an AI agent |
| [Git](docs/git.md) | Read-only git views: since last commit, the Uncommitted list, blame; which git is used; `/api/git/*` |
| [Find in the file](docs/find.md) | Cmd/Ctrl+F: shortcuts, what each viewer searches, the editor's search panel, limits |
| [Code outline](docs/outline.md) | The symbols panel for source code: languages, what is listed, how and when it is computed, bundle size |
| [Layout](docs/layout.md) | Resizing the sidebar and the contents / outline panel, keyboard, reading width, where it is saved |
| [Word documents](docs/docx.md) | How `.docx` files are converted and shown, `/api/docx`, its limits |
| [PDF export](docs/pdf-export.md) | How **Download PDF** renders markdown, mermaid and `.docx` |
| [Desktop app](docs/desktop.md) | Installing, first launch, data and logs, building the app, desktop mode |
| [Security model](docs/security.md) | What the server allows, refuses and why |
| [Known limits](docs/known-limits.md) | Things that do not work (yet) |

## License

[MIT](LICENSE)
