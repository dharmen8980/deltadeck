# Known limits

- Live updates come from `watchfiles`. There is no periodic rescan. Backstop
  passes run after a watcher restart, failure or large burst, after wake from
  sleep, and on slow timers (see [Change detection](configuration.md#change-detection)).
  A change the watcher misses therefore shows up late:
  - a create, delete or rename within 5 min (1 min on a network volume, 30 s
    while the watcher is down);
  - an in-place edit within 30 min (10 min on a network volume, 5 min while the
    watcher is down).
  - The timers pause while no browser is connected. The pass runs when one
    connects. A hidden but open desktop window still counts as connected.
  - A watcher that stops reporting without raising an error looks healthy. It
    is covered only by the timers above.
  - `watchfiles` does not pass on the backend's "events were dropped, rescan"
    signal (FSEvents `MustScanSubDirs`, inotify queue overflow; Linux queues
    16384 events by default). A burst of 2000 or more paths is therefore
    treated as a possible overflow and followed by a full pass within 10 s to
    1 min. An overflow that delivers no large batch at all is covered only by
    the timers.
  - On a local volume a wake from sleep gets a directory pass, not a full one:
    nothing on it changes while the machine sleeps. A volume ejected and
    remounted (also with the same root path) gets a full pass within a minute.
- Renames are inferred within one batch of changes, in two ways:
  - The same size, mtime and basename means a move, which includes folder
    renames.
  - A unique same-directory match on size and mtime means an in-place rename.
  - If a rename is split across two batches, it shows up as a delete plus an
    add. The UI then shows a "deleted or moved" notice.
- `/api/content` refuses files over 2 MB with 413; viewers fall back to the
  chunked text viewer. Code highlighting is limited to files under 300 KB.
- Chunks snap to line boundaries. With very long lines (one line in
  `runtime.log` is about 107 KB), a head or tail chunk can be much smaller than
  128 KB.
- Search offsets are computed from the decoded text, so they can be slightly off
  in files with invalid UTF-8. Files larger than the search limit are not
  content-indexed (their names are still searchable).
- Content search covers at most 100 000 files and 2 GB of files by default
  (`--search-max-files`, `--search-max-total-mb`); over a cap documents come
  first, then other text, code and data, shallower and smaller files first (see
  [Search index](configuration.md#search-index)). The dialog then says "Search
  covers N of M files - limit reached" (its tooltip names the options, except
  in the desktop app, which has no setting for them). Over a cap, a change
  that may alter which files are chosen takes effect within about 5 s (a
  background re-plan). A file that changed after it was
  indexed is matched on its old words until it is reindexed (a second or so;
  its snippet already shows the new text, and a hit with no matching line left
  is dropped, also before the watcher has seen the change). Files that cannot
  be read or converted are not content-indexed until they change (a read error
  is tried again on the next start). A `.docx` hit whose conversion is not cached gets snippets only
  while a 2 s budget per search lasts; later ones are listed without lines.
  Diacritic folding of snippets covers Latin letters, like the index (`ß` is
  not `ss`).
- After the first full index build of a large folder the server process may
  keep 70-170 MB more resident memory than after a restart: the allocator
  (macOS especially) holds on to freed memory. It does not grow with the
  folder.
- CSV previews show the first 5000 rows, and xlsx the first 1000 rows per
  sheet, with values stringified.
- Word `.docx` files are shown as plain content, not as Word lays them out:
  page layout, fonts, colours, alignment, headers and footers, comments,
  tracked changes, text boxes, shapes, charts and equations are not shown. A
  numbered list that Word continues after an ordinary paragraph starts again
  at 1. Documents with more than 8 MB of XML in one part (24 MB in all) are
  refused, and over 12 MB in all are not content-indexed. Linked images, images over 5 MB (16 MB or 200 in
  total) and EMF/WMF/TIFF images are placeholders. Documents over 20 MB, `.doc`
  files and password-protected documents are refused; very long documents are
  cut at 2 MB of markdown. They are view-only, even with `--allow-edit`. See
  [Word documents](docx.md).
- Find in the file (see [Find in the file](find.md)):
  - At most 5000 matches are counted and highlighted ("5,000+"). Large files
    are searched in their first 32 MB, and with the bar open each live change to
    such a file reads it again.
  - Accents are not folded and a match never spans lines (or table cells).
  - The JSON tree searches only expanded nodes; use the Source tab for all of it.
    CSV and xlsx search the loaded rows only (see above); a match in the hidden
    part of a truncated cell is counted but only shown when it is the current one.
  - In a zoomed-in diagram, matches outside the zoomed area are not scrolled
    into view. Browsers other than Chrome may not highlight matches in plain SVG
    diagram text (the counter and navigation still work).
  - Opening the bar from the desktop menu right after following a "/" search
    match: the search's scroll-to-match can pull the page back for a couple of
    seconds, until a key or a click.
- Code outline (see [Code outline](outline.md)):
  - Only Python, JavaScript / TypeScript, CSS / SCSS / LESS, HTML, Java, C#
    and shell. Go, Rust, C, C++, Ruby, PHP, Kotlin, Swift, SQL, YAML, TOML,
    JSON, Vue / Svelte single-file components and others get none, and files
    without an extension are not recognised by their shebang.
  - C# and shell are heuristic (rules over tokens and lines, no grammar):
    unusual code, such as `#if` branches with unbalanced braces, can confuse
    the C# outline, which also lists no fields, events or delegates. Nested
    shell functions are listed flat, and only `# ---- Name ----`, `### Name`
    and banner comments count as sections.
  - SCSS and LESS are read by the CSS grammar after blanking what it does not
    know (`//` comments, variables, mixin calls, guards, interpolation), so
    unusual syntax can drop or misplace rules. `@if` / `@each` / `@include`
    are not listed (the rules inside them are).
  - TypeScript `declare module "x" { }` blocks and plain class fields are not
    listed, and nor are assignments other than `exports.x = ...`,
    `module.exports = ...` and `X.prototype.y = ...`.
  - Java and C# overloads are separate entries; TypeScript overloads are one.
    Enum members, anonymous classes, local classes and lambdas are not listed.
  - Files over 2 MB, or whose outline takes more than 1.5 s of work (in the
    outline worker), get none; without a worker, more than 100 ms in one step.
    Large outlines show 500 entries at first ("Show more" adds more; the
    filter searches all). The outline is not shown in the editor.
- In dark mode each mermaid diagram is rendered twice (dark for the screen, a
  light copy that only `@media print` shows), so printing uses light colours.
- PDF export: diagrams wider than the page are scaled down to the page width.
  Very wide or very large diagrams inside a markdown document can print with
  tiny labels (2-3pt) in portrait; for diagram-heavy documents choose
  Landscape. Standalone `.mmd` files pick landscape automatically (*Auto*), but
  extremely wide ones (5:1 and more) are still limited by the page width. External images (including
  mermaid `img:` icons from a CDN) print as placeholders. Diagrams are not
  rasterised, so text in the PDF stays selectable.
- Changed since you last looked:
  - A `.docx` is compared as its converted markdown, so a change of
    formatting only (fonts, colours, layout) counts as "same text" and is seen
    right away.
  - Files over 2 MB (`.docx` over 20 MB) get a dot and a banner, but no highlights or diff, because
    neither the earlier copy nor the current text is available.
  - The history lives in the server's data dir (`seen.sqlite3`) and is shared
    by every browser on that server; a viewer started with another data dir
    starts fresh. It is off when the data dir overlaps the browsed folder.
  - Closing or reloading the tab sends the version on screen with a
    `keepalive` request, which browsers limit to 64 KB. A larger text is sent
    as its SHA-256 instead; if the file changed again before the server reads
    it, the version is recorded without a saved copy, and the next change to
    that file gets a size-only banner with no highlights or diff. If the tab
    closes in the moment before the hash is ready, or the page is not a secure
    context (no `crypto.subtle`), the larger version may still not be recorded.
  - Two viewer processes sharing one data dir share the history file, but a
    tab only hears about changes made through its own server.
  - Very large rewrites can hit the 1 s diff budget; the banner then reads "too
    many changes to compare quickly" and offers no diff.
  - Code and text marks (see [Changes](changes.md#code-and-text-highlights)):
    a file with a lone carriage return (old Mac line ends) gets none, as its
    line numbers would not match. Changed words are highlighted only in
    browsers with the CSS Custom Highlight API, for lines up to 1,000
    characters, up to 2,000 modified lines (none at all past 20,000 changed
    lines), not in a run of more than 400 modified lines (a rewrite) and within
    0.1 s. Removals keep 500 lines for the inline view. Files over 300 KB get
    bars only. With JSON pretty-print on, the marks compare the pretty-printed
    versions, so their count can differ from the banner's (which compares the
    file text). CSV tables get no marks. In text files over 256 KB, only the
    parts around the first four changes outside the start and end are loaded
    on their own; later ones are a stop on the "not loaded" bar until you load
    that part.
  - Outline dots for removed lines right after a symbol's last line use the
    indentation of the removed text: deeper than the symbol's first line
    counts as the tail of its body (dot), otherwise as a sibling removed after
    it (no dot), so a removed blank line or closing brace alone gets no dot.
  - The What's new summaries are computed in the browser like the banner's (a
    content fetch, a snapshot fetch and a diff per row on screen, three at a
    time), so scrolling quickly through hundreds of large changed files takes a
    moment to fill in. Each diff of a row gets 0.2 s instead of the banner's
    1 s, so a large rewrite can read "too many changes to compare quickly" in
    the list while its banner shows the full summary. A row whose fetch failed
    keeps its placeholder and is tried again every few seconds. **Undo** after marking files as seen restores which
    version counts as seen, but not the open file's banner.
- Git views:
  - Read-only, and only against the last commit (`HEAD`): no other commits,
    branches or history browsing, and staged and unstaged changes are not told
    apart (`M` covers both).
  - Commits, checkouts and stages change only `.git`, which the viewer does not
    watch: the Uncommitted list catches up on window focus or within 30 s.
  - Submodules are skipped. Files git ignores are not listed. Line counts of
    new and untracked files are only computed for the first 1,000 of them and
    for files up to 2 MB; the list stops at 5,000 files.
  - Blame and the last commit's text are limited to 2 MB, like
    `/api/content`. Blame loads 2,000 lines at a time and does not follow
    copies or moves between files (`-C`/`-M`).
  - Repository config such as filters and textconv drivers is ignored on
    purpose (see [Security model](security.md#git)), so a repository that
    relies on a clean filter (git-lfs, git-crypt, …) can show every such file
    as changed, or compare against the pointer or encrypted text.
  - Git detection runs once per folder (a timeout is retried every 30 s);
    install git and restart the viewer (or switch folders) to turn the views on. Git older than 2.32 is not used,
    and partial clones need git 2.45 or newer.
  - `.gitattributes` in the work tree is not read (attributes come from the
    empty tree, git 2.40+), so `eol` / `text` settings there do not apply and
    a file normalised by them can show as changed. `.git/info/attributes` is
    still read.
  - Untracked files are listed one by one (`--untracked-files=all`) before the
    viewer's ignore list is applied, so a huge untracked tree that git does not
    ignore can make the Uncommitted list slow, time out (20 s) or exceed the
    32 MB output cap (413). Add it to `.gitignore` or `--ignore` it.
- Folders that contain only hidden symlinks still appear as empty folders.
- macOS and Linux only: the write path relies on POSIX `dir_fd`/`O_NOFOLLOW`
  file operations, so native Windows is not supported (WSL should work).
