# Development

Running from source, the dev server, and the tests.

## Prerequisites

- [uv](https://docs.astral.sh/uv/). It provides Python 3.13 (sqlite with FTS5).
- Node.js and npm. Built and tested with Node 26 and Next.js 16.4.
- Google Chrome, only for PDF export. The system install is used
  (`/Applications/Google Chrome.app` or `~/Applications/...` on macOS,
  `google-chrome` on Linux, or the `DOCS_VIEWER_CHROME` env var pointing at the
  executable). The `playwright` Python package drives it; **never run
  `playwright install`**, no browser is downloaded.

## Install

```sh
git clone https://github.com/dharmen8980/local-docs-viewer.git
cd local-docs-viewer
uv sync                 # Python deps into .venv
cd web && npm ci        # JS deps (all assets are bundled; nothing loads from a CDN)
```

If the default uv cache is not writable, use
`UV_CACHE_DIR=$PWD/.cache/uv uv sync`.

## Build and run

```sh
cd web && npm run build        # writes web/out (static export)
cd .. && uv run viewer         # http://127.0.0.1:8765/  (choose a folder in the browser)
uv run viewer --root ~/notes   # or start on a given folder
```

If `web/out` is missing, the server still serves `/api/*`. It prints a hint to
run `npm run build`, and `/` returns a 503 JSON message.

## Dev mode (hot reload for the UI)

```sh
uv run viewer                  # backend on 127.0.0.1:8765
cd web && npm run dev          # Next dev server on http://127.0.0.1:3000
```

In the development phase, `next.config.ts` proxies `/api/*` to
`http://127.0.0.1:${DOCS_VIEWER_PORT:-8765}`. It also turns off gzip so the SSE
stream is not buffered. The production build is a plain `output: 'export'` with
no rewrites. Both npm scripts set `NEXT_TELEMETRY_DISABLED=1`, and the dev
server binds to 127.0.0.1 only.

Dev mode keeps the DNS-rebinding defence: the `/api` rewrite only applies when
the browser's `Host` is `127.0.0.1` or `localhost` (any other Host gets a 404),
and FastAPI also rejects requests whose `X-Forwarded-Host` / `Forwarded: host=`
is not loopback. `next dev` sends the same CSP, `Referrer-Policy` and `nosniff`
headers as production, with `'unsafe-eval'` and a same-host websocket added
because React refresh and HMR need them.

## Idle cost

These numbers come from an Apple Silicon Mac. Idle CPU is the server process's
CPU time over 120 s, with one live-update stream open unless the scenario says
otherwise. The synthetic tree has 50,000 files in 5,611 folders.

| Scenario | Before (rescan every 10 s) | After |
|---|---|---|
| `docs/` (11 files), idle | 0.46 % | 0.29 % |
| `~/Desktop` (64k files, 13.7k folders), idle | 12.3 % | 0.35 % (plus about 0.1 % from the backstop timers on average) |
| Synthetic tree, idle | 8.3 % | 0.33 % |
| Synthetic tree, watcher failing on every start, idle | n/a | 0.43 % |
| Synthetic tree, watcher silently dead, idle | 7.9 % | 1.4 % (directory pass every 20 s, full pass every 60 s) |
| Create / edit / rename / delete | 0.12 / 0.15 / 0.89 / 0.12 s | 0.14 / 0.14 / 0.14 / 0.15 s (the first event after startup takes about 1.7 s) |
| Folder of 20 files moved in / folder renamed | 0.13 / 0.17 s | 0.15 / 0.13 s |
| 5k files created / then edited (burst) | 0.52 / 23.2 s (24.7 s CPU) | 0.52 / 0.60 s (0.63 s CPU, plus the follow-up full pass) |
| Create / edit, watcher failing | n/a | 30 / 120 s (bounds 30 s and 5 min) |
| Create / edit, watcher silently dead | 10.8 / 10.9 s | 6 / 40 s (with 20 s and 60 s timers; the defaults bound them at 5 min and 30 min) |
| Volume holding the root ejected / remounted after an edit made elsewhere (disk image) | not seen / 10 s | 0.6 / 0.7 s |

Most of the remaining floor is not the viewer's: a bare uvicorn server costs
about 0.2 % (its main loop wakes every 0.1 s), and `watchfiles` about 0.05 %
(it checks for events every 100 ms; that step adds up to 0.1 s of latency).

Cost of one backstop pass on `~/Desktop`:

| Pass | CPU time |
|---|---|
| Directory pass | 0.09 to 0.11 s (each changed directory is listed once) |
| Full pass | 1.1 to 1.9 s, spread over about 2.2 s (utility QoS and the pauses keep it near half a core) |
| Startup scan | 3.1 to 3.5 s |

A directory pass over a folder of 20,000 files after one new file costs about
0.07 s (it was 2.4 s when every file was rescanned on its own).

## Tests

```sh
uv run pytest -q
```

The tests use pytest `tmp_path` fixtures only and never touch the real root.
They cover path safety, the deny list, symlinks, large-file chunking, search,
security headers and live updates (watcher, reconcile, renames, SSE).
`test_reconcile.py` covers change detection without polling:
- updates driven by the watcher alone, with every backstop timer off;
- the watcher restarting after an error or an unexpected end, and asking for a
  full pass each time;
- a large batch asking for a directory pass and then a full one (a possible
  overflow, at most one per minute), a root event asking for a directory pass
  rather than a full one, and an unknown path asking for a full pass;
- small batches not resolving every path;
- the backstop timers, `0` turning them off, and the shorter timers while the
  watcher is down (injected clocks, no sleeps);
- wake and clock jumps (a directory pass on a local volume, a full pass on a
  network one), and the root's volume going away and coming back;
- pausing without clients, resuming on an HTTP request or a live-update
  stream, and `--rescan-when-idle`;
- the directory pass, which catches creates, deletes, renames, mkdir plus move,
  directory moves and removed trees, re-lists only the changed directories,
  always re-lists racy ones but trusts far-future ones, respects deny and
  ignore, misses an in-place edit that the full pass catches, and lists a
  20,000-file directory once (one create in it costs well under 0.5 s);
- case-only renames of a file and a folder leaving no duplicate, whether the
  watcher, a directory pass or a full pass sees them;
- a cancelled pass (shutdown, folder switch) committing nothing;
- the full pass matching a fresh scan;
- the one-regex hidden-name test matching `is_hidden`;
- 5000 file scopes applied in well under 3 s;
- the network-volume defaults, including Linux `fuse.*` mounts;
- the CLI and env options.
`test_pdf.py` checks that `/api/pdf` refuses traversal, denied and
non-markdown paths and cross-site requests, that the request-blocking route
and WebSocket handlers abort external URLs, the idle-close deadline and the
stale-profile sweep, and (only when Chrome and `web/out` exist, otherwise skipped) renders a
real PDF end to end on a free port and checks the temporary profile is removed.
`test_edit_*.py` cover editing: off by default (every endpoint 403, nothing
changes), token/Origin/Sec-Fetch-Site/Host/content-type checks, traversal and
symlink refusals, denied and ignored names, atomic saves and 409 conflicts,
history pruning and restore, trash, uploads, and that the tree, search and SSE
see each change exactly once. `test_roots.py` covers folder switching: startup
resolution (CLI > env > `state.json`), the no-folder mode, pick (with a fake
dialog), cancel, switch only to recent folders, forget, the token / Origin /
Sec-Fetch-Site / content-type gate, `--lock-root`, edit mode per folder and
the data-dir overlap refusal, the old app's SSE streams and background tasks
ending after a switch, and serialised concurrent switches. No test opens a
real dialog. All of them use `tmp_path` roots and data dirs.
`test_seen.py` covers the changes history (`/api/seen*`): commit / get /
snapshot / mark / rename / clear, commits by SHA-256 (match, file changed
again, missing file, over 2 MB, malformed digest), snapshot and record limits with oldest-first
pruning (and a full disk keeping the record without text), file and folder
renames, namespacing by root and refusal of a stale root after a switch,
`--lock-root` (history writes still allowed while `/api/roots` POSTs get
403) and no-folder mode, the token / Origin / Sec-Fetch-Site / Host /
content-type gate and body limit, path traversal and denied names, the
data-dir overlap and unwritable data dir turning it off, and the `seen` SSE
event. `test_search_index.py` covers the on-disk search index: contentless
insert / update / delete / rename (with and without `contentless_delete`, and
the tombstone rebuild), snippets read from disk (diacritics, NFD text, files
changed or deleted since indexing, `.docx` from the cache and its time
budget), persistence and an incremental restart that reads only changed files,
schema / tokenizer / root / mode mismatch and corrupt, foreign, truncated or
symlinked databases being rebuilt, caps with the status in `/api/search` and
the deterministic selection, the CLI / env options, a full disk, the data dir
inside the root (temp file, nothing written in the root) or the temp dir inside
it (memory), two roots sharing a data dir, the same root opened twice (temp
file), `stop()` cleanup, pruning, sweeping abandoned temporary indexes, and denied or symlinked hits giving no
snippet. Also: damaged FTS pages found on restart (quick_check) or by a query
(one reset, then a rebuild), unreadable files and failed `.docx` conversions
taking no cap slot and not being read again until they change (also across a
restart), changes under a cap applied without a full re-plan (and the result
matching `plan_selection`), re-plans running throttled on their own thread,
a failed write retried by a later change, the old-SQLite tombstone rebuild by
dead bytes in the background, a hit whose file changed on disk before the
watcher saw it, and a `.lock` file unlinked between open and flock. `test_git.py` (skipped when git is missing) builds real temporary
repositories: status with M/A/D/R/?? and line counts, denied and ignored names
hidden, a root in a subfolder of the repository, the last commit's version
(unchanged, new, deleted, renamed, binary), a denied file in history, a rename
away from a denied name and a symlink to one refused, blame and its size limit, a malicious repository config
(`core.fsmonitor`, `diff.external`, `textconv`, clean/smudge and `process`
filters, hooks, pager) pointing at a script that would create a marker file
and never does, nothing written inside the repository, not a repository and
`--git off` turning git off, a root inside `.git`, cross-site requests and
other methods refused, timeouts killing git, the output cap, finding git and
the setting, and an unborn `HEAD`. `test_docx.py` covers `.docx` (documents built by `docx_build.py`, no
python-docx): headings, lists, tables, links, footnotes and images in both
the HTML and the markdown, markdown escaping, the server sanitizer
(script/style/`on*`/`javascript:`/external images), an embedded style map
being ignored, DOCTYPE/ENTITY refusal (also UTF-16, and in a main part with
a non-`.xml` name), zip bombs, part count, per-part and total XML size
limits, merged-cell (rowspan) column alignment in the markdown, the style map
(Title, Subtitle, Quote, underline) and quiet style notes, bookmark anchors,
the 503 when a conversion is busy, indexing's own lock and cache priority,
the git blob cache, corrupt, non-zip and OLE files, image limits, truncation at
a block, `/api/docx` (formats, 400/403/404/413/422), cache invalidation and
bounds, search indexing and reindexing on change, the seen digest of the
markdown, view-only (415 on save and create), `/api/pdf` accepting `.docx`
and git's last-commit version as markdown.
`test_desktop.py` covers desktop mode against a fake bridge: picker success,
cancel, 409, timeout and token refusal; PDF success, the payload (same-origin
`/print` URL and query, templates, margins, timeouts) and every error-status
mapping; the CLI refusing `--desktop` without the bridge env, printing
`LDV_READY` once it accepts connections, exiting on stdin EOF; and that
playwright is never imported.

Frontend checks: `cd web && npm run lint && npx tsc --noEmit`.

Frontend unit tests: `cd web && npm test`. They use `node --test`, which runs the
TypeScript files in `web/test/` directly (Node 23.6 or newer), and cover the
diff engine and the change summary (`src/lib/diff.ts`), the change rules (`src/lib/change-rules.ts`),
the What's new list and its lazy summary loader (`src/lib/whats-new.ts`: order,
cache keys, bounded concurrency, LRU, retry after a failure),
the markdown change marks (`src/lib/rehype-change-marks.ts`), the `.docx`
tree and its client-side sanitizing (`src/lib/docx-hast.ts`, including
bookmark targets) and the
server-backed history client (`src/lib/seen-store.ts`, against a fake
`fetch`: the keepalive cap and the digest fallback, clear) and the git views'
pure parts (`src/lib/git.ts`: Uncommitted rows and details, blame grouping
and chunk merging), the search dialog's coverage notice
(`src/lib/search-coverage.ts`), and the code outline (`src/lib/outline/`: one test file
per language against realistic samples in `web/test/fixtures/outline/`,
asserting exact names, kinds, lines and nesting; plus the loader, the size
cap, the time budget, abort, the cache, the active-symbol search, the worker's
one-budget run (`run.ts`) and the SCSS / LESS preprocessing staying linear).
The code and text change marks (`src/lib/line-marks.ts`) are covered too:
added, modified and removed lines at the start, middle and end, CRLF and the
final newline, whitespace-only edits, the word-highlight caps and time budget,
the cap on removed lines kept inline, which outline symbols hold a change
(including a Python body's last line removed and the last function of a file
removed), the changes in an unloaded part of a large file, and the
whitespace-only summary with its line counts.
The panel sizes (`src/lib/panel-size.ts`, `test/panel-size.test.ts`): clamping
to the limits and to a share of the window, drag direction per edge, the
keyboard steps, Home / End / Enter, and parsing saved widths and the reading width.
Find in the file (`src/lib/find/`, `test/find.test.ts`) is covered too: query
compiling (match case, whole word, regex and its errors), the match cap and
time budget, the worker's hard timeout, offsets to lines and to table cells,
next / previous with wrap-around, the counter, the shortcuts, the selection and
search-term seeds, the desktop menu's echo filter and the viewer registry.
The worker itself (`worker.ts`) only runs in a browser; the tests use the
main-thread fallback. CI runs them
in the desktop-release workflow (`package.json` declares `engines.node >=23.6`).

## Search index memory

Measured on macOS (Apple silicon, SQLite 3.53) with `/usr/bin/time -l`, before
(in-memory FTS5 with the text stored) and after (on-disk contentless index,
default caps). Footprint is the steady-state process footprint after indexing.

| Folder | Version | Index build | Restart | Peak footprint | Steady footprint | Index on disk |
|---|---|---|---|---|---|---|
| `docs/` (small) | before | 0.3 s | 0.3 s | 42 MB | 42 MB | none |
| `docs/` (small) | after | 0.5 s | incremental | 41 MB | 42 MB | 0.1 MB |
| ~/Desktop, 64k files (55k indexable, 1.3 GB) | before | 28 s | 25 s (full) | 2415 MB | 2409 MB | none |
| same | after (50 000 files indexed) | 32 s | 3.7 s | 284 MB | 283 MB cold, 111 MB after restart | 291 MB |
| same | after review fixes (all 55 218 indexed, 100k cap) | 34 s | 0.5 s after the tree scan | 239 MB RSS | 158 MB cold, 107-123 MB after restart | 313 MB |
| synthetic, 60k files, 2.8 GB | before | 125 s | 125 s (full) | 6078 MB | 6076 MB | none |
| same | after (47 798 files, 2 GB cap) | 113 s | 2.1 s | 130 MB | 116 MB cold, 95 MB after restart | 982 MB |
| synthetic, 45k files, 3.1 GB | after review fixes (33 780 files, 2 GB cap) | 63 s | 0.1 s after the tree scan | 134 MB RSS | 103 MB cold, 83 MB after restart | 695 MB |

The cold-build footprint above a restart's is allocator retention (freed
memory macOS keeps), not index data. Query latency stayed in the same range
(tens of ms; up to about 200 ms for very common words, which read 50 hit files
for snippets). With a cap in force a file change costs about 15 ms of CPU
(the full re-plan, about 70-100 ms, runs in the background at most every
5 s); the write-ahead log peaked at 19 MB during the synthetic build.
