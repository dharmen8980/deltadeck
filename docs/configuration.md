# Configuration

Flags, environment variables, and how the docs folder is chosen and switched.

## Options

Precedence is CLI flag, then environment variable, then default. The root
folder has no built-in default: without `--root` / `DOCS_VIEWER_ROOT` the
viewer reopens the folder used last (`last_root` in `<data dir>/state.json`, if
it still exists) and otherwise starts with no folder selected.

| Setting | Flag | Env | Default |
|---|---|---|---|
| Root folder | `--root PATH` | `DOCS_VIEWER_ROOT` | the last folder chosen (from `state.json`), else none: choose one in the browser (resolved with realpath at startup); a given folder that does not exist is a startup error |
| Lock the root | `--lock-root` | `DOCS_VIEWER_LOCK_ROOT=1` | off (the browser may switch folders); needs a root |
| Port | `--port N` | `DOCS_VIEWER_PORT` | `8765` |
| Host | none | none | always `127.0.0.1` (hardcoded, not configurable) |
| Deny patterns (add) | `--deny PATTERN` (repeatable) | `DOCS_VIEWER_DENY` (comma-separated) | `.env`, `.env*`, `*token*`, `*secret*`, `*credential*`, `*.pem`, `*.key` |
| Drop default deny list | `--no-default-deny` | none | off |
| Never show denied files | `--no-reveal` | `DOCS_VIEWER_NO_REVEAL=1` | off: a denied file can be shown read-only on request; see [Hidden files](#hidden-files) |
| Ignore patterns (add) | `--ignore PATTERN` (repeatable) | `DOCS_VIEWER_IGNORE` (comma-separated) | `__pycache__`, `*.pyc`, `.DS_Store`, `node_modules`, `.venv`, `.git`, `.ldv-tmp-*` |
| Search size limit | `--search-max-mb N` | `DOCS_VIEWER_SEARCH_MAX_MB` | `2` (larger files are not indexed for content search) |
| Search: files indexed in all | `--search-max-files N` | `DOCS_VIEWER_SEARCH_MAX_FILES` | `100000` (see [Search index](#search-index)) |
| Search: total size indexed | `--search-max-total-mb N` | `DOCS_VIEWER_SEARCH_MAX_TOTAL_MB` | `2048` (the indexed files' sizes added up; a `.docx` counts its file size) |
| UI directory | `--ui-dir PATH` | none | `web/out` next to this README |
| Editing | `--allow-edit` | `DOCS_VIEWER_ALLOW_EDIT=1` | off (read-only) |
| Data dir (history, trash, audit, `state.json`) | `--data-dir PATH` | `DOCS_VIEWER_DATA_DIR` | `.data` next to this README |
| Versions kept per file | `--history-keep N` | none | `50` |
| Upload size limit per file | `--upload-max-mb N` | none | `25` |
| Upload extensions | `--upload-ext EXT` (repeatable or comma-separated; replaces the list) | none | `png jpg jpeg gif webp svg pdf md mmd txt csv json yaml yml py sh log` |
| Git views | `--git PATH\|off` | `DOCS_VIEWER_GIT` | found on `PATH`, then `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin` (never the macOS stub); `off` turns them off; see [Git](git.md#which-git) |
| Backstop directory pass | `--rescan-interval SECONDS` | `DOCS_VIEWER_RESCAN_INTERVAL` | `300` (`60` on a network volume); `0` = off; see [Change detection](#change-detection) |
| Backstop full pass | `--full-rescan-interval SECONDS` | `DOCS_VIEWER_FULL_RESCAN_INTERVAL` | `1800` (`600` on a network volume); `0` = off |
| Backstop while nobody is connected | `--rescan-when-idle` | `DOCS_VIEWER_RESCAN_WHEN_IDLE=1` | off: the timers pause, and a pass that fell due runs when a browser connects |
| Desktop mode (set by the desktop app) | `--desktop` | `DOCS_VIEWER_DESKTOP=1` | off; see [Desktop app](desktop.md) |

Deny and ignore patterns are case-insensitive `fnmatch` globs. Names and
patterns are compared after Unicode NFKC normalisation and case folding (so
NFD spellings and look-alikes such as U+017F `ſ` for `s` match too, as they do
on APFS). They are checked against every path component, both of the requested
path and of its realpath-resolved form, and against the names as they actually
exist on disk (each component is matched to its real directory entry). A denied path is refused with 403, except for the
read-only view described below. An ignored path is just hidden noise: it is not
listed, searched or tracked, but it opens when asked for by path.

Example:

```sh
uv run viewer --root ~/notes --port 9000 --deny '*.sqlite' --ignore 'dist'
```

`.ldv-tmp-*` (the editor's temporary files during an atomic save) is on the
default ignore list, so it never shows in the tree or search.

## Hidden files

Three kinds of items are hidden from the tree, search, What's new and change
events:

- **Git-ignored.** When the folder is inside a git repository, files and
  folders git ignores (`.gitignore`, `.git/info/exclude`, the global excludes
  file) are hidden like ignored ones. Files git tracks stay visible, even when
  an ignore pattern matches them. Outside a repository, or with `--git off`,
  nothing is hidden this way.
- **Ignored.** Names on the ignore list.
- **Denied.** Names on the deny list. These are protected.

With "Show hidden files" in the sidebar filter menu, hidden items show in the
tree, dimmed. Hidden folders are never scanned, and changes inside them are
ignored; their contents are listed when you expand them. Hidden files open with
a note that they are hidden. Git-ignored files open normally; ignore-list files
open read-only. A denied file asks first and then shows read-only.
`--no-reveal` turns that off, and denied names are then not listed either.

`.git`, `.ldv-tmp-*` and the data dir are never shown.

A change to a `.gitignore` in the folder applies at the next watcher event.
Rules from elsewhere (a `.gitignore` above the folder, global excludes) apply
at the next backstop pass.

## Change detection

The file watcher (`watchfiles`: FSEvents on macOS, inotify on Linux) is the
source of live updates. The tree is scanned in full once at startup. After
that the server does not poll. Backstop passes run on a low-priority thread
(utility QoS on macOS, which keeps them on the efficiency cores, and nice 10 on
Linux) and pause briefly every 512 stats. Each pass walks the disk without
holding the scan lock and then rescans only what differs. A pass still running
at shutdown or a folder switch stops at its next pause.

- A **directory pass** stats every known directory and re-lists those whose
  mtime, ctime or inode changed. Each changed directory is listed once; only
  its new or vanished subfolders are scanned further. It catches entries
  created, deleted or renamed anywhere, including folder moves and case-only
  renames. It does not catch a file edited in place, because that leaves the
  directory alone. A directory changed within the last 3 s is always re-listed,
  since a second change within the same mtime tick would not show. A directory
  dated more than a minute in the future (a file server whose clock runs ahead)
  is trusted rather than re-listed on every pass.
- A **full pass** stats every file, so it also catches in-place edits.

A pass runs:

| When | Pass |
|---|---|
| The watcher starts or restarts (3 s later, for what changed while nothing listened) | full |
| The watcher fails or ends (it restarts with a 1, 2, 4 ... s backoff, up to 10 min) | while it is down: directory pass every 30 s, full pass every 5 min |
| A watcher batch of 2000 or more paths (git checkout, unpacking, possibly an overflow) | directory pass 2 s later, and a full pass 10 s later (at most one such full pass per minute) |
| An event for the root itself | directory pass (not a full rescan) |
| An event outside the root (unknown spelling) | full |
| Wake from sleep or a clock jump (the wall clock and monotonic clock disagree by over 30 s; checked every 60 s) | directory pass on a local volume (nothing changed there while asleep but what the watcher saw); full on a network volume |
| The root's volume goes away or comes back, or the root is replaced (its device and inode, checked every 60 s) | directory pass when it is gone (the tree empties); full when it is back |
| `--rescan-interval` / `--full-rescan-interval` timers | directory / full |

Network volumes (smbfs, nfs, afpfs, webdav, cifs, 9p, macFUSE, and any Linux
`fuse.*` mount such as sshfs or rclone, as detected from the mount table) get
the shorter defaults, because the watcher
sees only this machine's changes there. The timers run only while someone uses
the viewer: a live-update stream is open, or an HTTP request came in during the
last 10 minutes. With nobody looking they pause. Requests from the watcher and
wake still run. The startup log line names the intervals in use.

## Search index

Content search uses an SQLite FTS5 index kept on disk, one file per folder:
`<data dir>/search/<key>.sqlite3` (plus `-wal`, `-shm` and a `.lock`; `<key>` =
first 24 hex chars of sha256(canonical root path), the same key as the edit
store). It is *contentless*: it holds the words (tokens) of each file and its
path, size and mtime, never a copy of the text. Snippets are read from the
files themselves when you search (a `.docx` from its cached conversion).

- **Restarts are incremental.** The index survives restarts and folder
  switches; on start only files whose size or mtime changed are read again
  (about 2-4 s for 60 000 files instead of a full rebuild).
- **Disk use** is roughly a quarter to a third of the indexed text: about
  315 MB for 55 000 files / 1.3 GB, about 700 MB-1 GB for 2-2.8 GB of text. The
  server's memory no longer grows with it (the SQLite page cache is capped at
  8 MB). The write-ahead log stays under about 20 MB while building (commits
  every 500 files or 4 MB of text) and is truncated when a build ends.
- **Caps.** At most `--search-max-files` files and `--search-max-total-mb` MB
  of files are indexed. Over a cap the files are chosen deterministically:
  markdown, mermaid and `.docx` first, then other text, code, then JSON and
  CSV; within each, shallower paths first, then smaller files, then by path.
  `/api/search` reports `indexed_files`, `indexable_files`, `limit_reached` and
  `limit_reason` (`files`, `bytes`, `disk` when the disk is full, `error`), and
  the search dialog shows "Search covers N of M files - limit reached". File
  names are always searched in full. A file change that cannot alter the
  choice (a file that is not chosen and sorts after the last chosen one, or a
  chosen file saved at the same size under the file cap) is applied on its
  own; any other re-plans in the background, at most every 5 s.
- **Files that cannot be indexed** (a broken, encrypted or Office lock-file
  `.docx`, a document whose markdown is over the size limit, a file that
  cannot be read) are skipped until their size or mtime changes; they take no
  place under the caps and do not count in `indexable_files`. Conversion
  failures are remembered across restarts, read errors (permissions) are
  tried again on the next start.
- **Names for completion.** For code files the index also keeps their
  identifiers: every definition (found by simple per-language patterns),
  other names only when used at least twice in the file and not hash-like
  or longer than 40 characters, at most 500 names per file (definitions
  first, then the most used). Each distinct name is stored once, so this
  stays a small part of the index (about 18 MB of 70 MB for 10,000 code
  files). The editor's completion asks for them through
  `/api/complete?prefix=&path=&limit=` (`{names: [{name, def, files}],
  capped}`, at most 50; one query reads at most 20000 uses of a prefix plus
  as many definitions, and `capped` says it stopped there).
  Like the rest of the index it holds no text, and it is empty until the index
  is built.
- **Failed writes.** When a write fails (disk full, the database locked) the
  files indexed so far stay searchable and `limit_reason` says `disk` or
  `error`; a later file change tries again (at most once a minute).
- **Where else it can go.** If the data dir overlaps the folder, or the index
  file is unusable, or another viewer process has the same folder open (the
  `.lock` is held), the index goes to a private temporary file in the OS temp
  dir, deleted when the viewer stops or switches folder (one left behind by a
  killed viewer is deleted by the next one that needs a temporary index). Only if the temp dir
  itself lies inside the folder is it kept in memory. Nothing is ever written
  inside the folder in read-only mode.
- **Rebuilds.** A corrupt file, a file from another version (schema or
  tokenizer) or one recorded for another folder is deleted and rebuilt. An
  index reused from an earlier run is checked (`PRAGMA quick_check`, a few
  seconds per few hundred MB, on its own connection while searches go on)
  after the start-up catch-up, and a query that finds the database damaged
  starts a rebuild too.
- **Cleanup.** Indexes of folders that are no longer current or recent (see
  below) are deleted when the recent list changes, unless another viewer is
  using them. Deleting `<data dir>/search/` (with the viewer stopped) is always
  safe; it is rebuilt on the next start.

## Choosing and switching folders

The folder name in the sidebar header opens a menu with the current folder's
full path, the recent folders (click to switch, or forget one) and **Choose
folder...**, which opens the operating system's folder dialog on the machine
running the server (macOS: `osascript` `choose folder`; Linux: `zenity
--file-selection --directory` if installed; elsewhere only recent folders and
`--root` are available). The dialog may open behind the browser window. When
no folder is selected the page shows the same choices in its centre. After a
switch the page reloads on the new folder (it asks first if the editor has
unsaved changes); the server keeps running.

The server builds a fresh app for the new folder (tree scan, search index,
watcher, edit store), starts it, swaps it in and then shuts the old one down;
open live-update streams of the old folder end and the browser reconnects.
Switches are serialised, and only one folder dialog can be open at a time.
With `--allow-edit` each folder gets its own recovery store (keyed by its
path) and a new edit token; a folder that contains the data dir (or lies
inside it) is refused with 400 and the current folder stays.

The last folder and up to 10 recent folders (canonical paths, most recent
first) are remembered in `<data dir>/state.json`
(`{"last_root": ..., "recent": [...]}`, written atomically, mode 0600). A
folder given with `--root` / `DOCS_VIEWER_ROOT` is recorded there too; folders
that no longer exist are dropped from the list. In read-only mode nothing is
written if the data dir lies inside the folder being viewed.

`--lock-root` (or `DOCS_VIEWER_LOCK_ROOT=1`) pins the folder given at startup:
the menu is hidden and every `POST /api/roots/*` returns 403. The changes
history (`/api/seen/*`, see [Security model](security.md#the-apiseen-endpoints))
keeps working, writes and **Clear history…** included: it lives in the data dir
and never changes which folder is shown or anything inside it.

### The /api/roots endpoints and their security model

| Request | Result |
|---|---|
| `GET /api/roots` | `{"current", "recent", "picker_available", "switch_enabled"}` |
| `POST /api/roots/pick` `{}` | opens the folder dialog (up to 10 minutes; 409 if one is open, 501 if no dialog is available); `{"cancelled": true}` or `{"cancelled": false, "current": path}` |
| `POST /api/roots/switch` `{"path"}` | switches, but **only to a path in the recent list** (exact match, else 403) |
| `POST /api/roots/forget` `{"path"}` | removes a recent folder (400 for the current one) |

All answers are JSON with `Cache-Control: no-store`. A browser request can
never name an arbitrary folder: new folders enter only through the native
dialog (a person at this machine clicking) or `--root` / `DOCS_VIEWER_ROOT`.
The mutating requests are guarded like `/api/edit/*`: a per-launch random
`X-Root-Token` (from `/api/config` as `root_token`, only for same-site
requests; it survives folder switches), `Sec-Fetch-Site: same-origin` or no
such header, no `Origin` or a loopback viewer/dev-server origin,
`Content-Type: application/json` and a small body; anything else gets 403. The
Host allowlist, forwarded-host check, CSP and other headers apply as
everywhere. With no folder selected `/api/config` returns `"no_root": true`
(with `root_name` / `root_path` null), the UI and `/api/roots` are served, and
every other `/api/*` answers 409 `{"detail":"no folder selected"}`.
`/api/config` also reports `root_path` (full canonical path) and
`root_switch_enabled`.
