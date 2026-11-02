"""Full-text search: an on-disk, contentless SQLite FTS5 index plus file-name search.

The index holds tokens only, never the text: the files are already on disk, so snippets and
highlights are made at query time by reading the few files returned (a .docx through its cached
markdown conversion). It lives in <data_dir>/search/<root key>.sqlite3 and survives restarts:
on start only files whose (size, mtime) changed are read again. Totals are capped (files and
bytes); over a cap the files that get indexed are chosen deterministically (`selection_key`).
Code files also leave their identifiers (viewer.names) in the `words` / `uses` / `file_words`
tables, for editor completion (`complete`).

Where the database goes (`SearchIndex(index_dir=...)`): the data dir unless it overlaps the root
(the caller passes None then), else - or when that file is unusable or held by another viewer
process - a private temporary file in the OS temp dir, deleted on stop(). Only when the temp dir
itself lies inside the browsed folder (read-only mode never writes there) is the index in memory.
"""

from __future__ import annotations

import contextlib
import fcntl
import logging
import os
import re
import shutil
import sqlite3
import tempfile
import threading
import time
import unicodedata

from .config import DEFAULT_SEARCH_MAX_FILES, DEFAULT_SEARCH_MAX_TOTAL_MB, path_within, root_key
from .docx import DOCX_MAX, DocxError, convert_cached
from .names import NAME_MAX, extract, family_exts
from .paths import PathError, check_rel, ext_of
from .store import Entry, Store

log = logging.getLogger("viewer.search")

INDEXED_KINDS = {"markdown", "mermaid", "code", "json", "csv", "text", "docx"}
MAX_FILES = 50
MAX_NAMES = 20
MAX_LINES = 5
MAX_COMPLETE = 50
COMPLETE_SCAN = 20000  # uses rows read per completion query at most (a 1-2 letter prefix)
LINE_CHARS = 300
_SUBTOKEN = re.compile(r"[^\W_]+", re.UNICODE)

INDEX_DIR = "search"  # <data_dir>/search/<root key>.sqlite3 (+ -wal, -shm, .lock)
SCHEMA_VERSION = "5"  # 5: names for editor completion (words/uses/file_words)
TOKENIZE = "unicode61 remove_diacritics 2"
# files indexed in all, and the bytes of those files in all (a .docx counts its file size)
DEFAULT_MAX_FILES, DEFAULT_MAX_TOTAL_MB = DEFAULT_SEARCH_MAX_FILES, DEFAULT_SEARCH_MAX_TOTAL_MB
CACHE_KIB = 8 * 1024  # SQLite page cache of the index connection
BATCH_FILES = 500  # build: commit after this many files or BATCH_BYTES of text
BATCH_BYTES = 4 * 1024 * 1024  # (the WAL cannot be checkpointed inside a batch: keeps it small)
SNIPPET_BUDGET = 2.0  # s per query for .docx conversions (cache misses) to make snippets
TOMBSTONE_REBUILD_MIN = 5000  # old SQLite (no contentless_delete): rebuild when this many dead rows
# and more dead rows than live ones, or when the dead rows' files add up to this many bytes and more
# than the live ones (one large file saved over and over)
TOMBSTONE_REBUILD_BYTES = 64 * 1024 * 1024
REPLAN_INTERVAL = 5.0  # s: a cap is in force and a change may alter the choice: re-plan in the
# background at most this often (a full pass over every file), never in the change handler
RETRY_INTERVAL = 60.0  # s: after a failed write (disk full, locked) try again on a change this often
# Which files are indexed first when a cap is reached: documents, then text, code, data.
KIND_RANK = {"markdown": 0, "mermaid": 0, "docx": 0, "text": 1, "code": 2, "json": 3, "csv": 3}
# SQLite 3.43+: a contentless table can delete rows. Older: rows are only unlinked (tombstones).
CONTENTLESS_DELETE = sqlite3.sqlite_version_info >= (3, 43, 0)


def build_match_query(q: str) -> str | None:
    """Turn user input into a safe FTS5 query: quoted terms ANDed, last one a prefix."""
    terms = [t for t in q.split() if t]
    if not terms:
        return None
    parts = ['"' + t.replace('"', '""') + '"' for t in terms]
    parts[-1] += "*"
    return " AND ".join(parts)


def needles_for(q: str) -> list[str]:
    out: set[str] = set()
    for t in q.split():
        t = t.strip()
        if t:
            out.add(t.lower())
            out.update(s.lower() for s in _SUBTOKEN.findall(t))
    return sorted(out, key=len, reverse=True)


def _types_filter(types: str | None) -> set[str] | None:
    if not types:
        return None
    out = set()
    for t in types.split(","):
        t = t.strip().lower().lstrip(".")
        if t:
            out.add("" if t == "(none)" else t)
    return out or None


def _folder_ok(path: str, folder: str) -> bool:
    folder = folder.strip("/")
    return not folder or path == folder or path.startswith(folder + "/")


def merge_ranges(spans: list[tuple[int, int]]) -> list[list[int]]:
    out: list[list[int]] = []
    for s, e in sorted(spans):
        if out and s <= out[-1][1]:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return out


# --- diacritic folding, like the tokenizer's remove_diacritics -------------------------------------

_MARKS = "\u0300-\u036f"  # combining diacritical marks (NFD text): the tokenizer drops them
_HAS_MARK = re.compile(f"[{_MARKS}]")
_fold_table: dict[int, str] | None = None
_variants: dict[str, str] = {}  # ASCII base letter -> every Latin letter that folds to it


def _fold_tables() -> dict[int, str]:
    global _fold_table
    if _fold_table is None:
        table: dict[int, str] = {}
        groups: dict[str, set[str]] = {}
        for cp in (*range(0xC0, 0x250), *range(0x1E00, 0x1F00)):
            ch = chr(cp)
            base = "".join(c for c in unicodedata.normalize("NFD", ch) if not unicodedata.combining(c))
            if len(base) == 1 and base != ch and base.isascii() and base.isalpha():
                table[cp] = base
                groups.setdefault(base.lower(), set()).update((ch, ch.lower(), ch.upper()))
        for b, chars in groups.items():
            _variants[b] = "".join(sorted({c for c in chars if len(c) == 1} | {b, b.upper()}))
        _fold_table = table
    return _fold_table


def fold_diacritics(s: str) -> str:
    """Lower case without Latin diacritics, same length as `s` (combining marks are kept)."""
    return s.translate(_fold_tables()).lower()


def _loose(s: str) -> str:
    """Lower case without diacritics (any length): for comparing lines with query terms."""
    return s.lower() if s.isascii() else _HAS_MARK.sub("", unicodedata.normalize("NFD", s)).lower()


def _needle_pattern(needle: str, marks: bool) -> str:
    """A regex for `needle` that, like FTS5's remove_diacritics, ignores Latin accents (and, in
    NFD text, the combining marks after each letter). Used with re.IGNORECASE."""
    _fold_tables()
    out = []
    for ch in needle:
        b = fold_diacritics(ch)
        alts = _variants.get(b)
        out.append(f"[{re.escape(alts)}]" if alts else re.escape(ch))
        if marks:
            out.append(f"[{_MARKS}]*")
    return "".join(out)


def match_lines(body: str, needles: list[str], terms: list[str] | None = None) -> tuple[list[dict], int]:
    """Up to MAX_LINES matching lines (1-based line, byte offset of line start) and the total
    number of matching lines.

    Lines are ranked so that the ones the user most likely wants come first: the whole query
    as a phrase, then the number of distinct query terms present, then whole-word/prefix hits,
    then document order. Matching ignores case and Latin diacritics, like the index."""
    if not needles:
        return [], 0
    plain = body.isascii()  # then only the unaccented letters can match: plain needles (fast)
    marks = not plain and bool(_HAS_MARK.search(body))
    alts = (dict.fromkeys(re.escape(fold_diacritics(n)) for n in needles) if plain
            else (_needle_pattern(n, marks) for n in needles))
    pat = re.compile("|".join(alts), re.IGNORECASE)
    terms = [_loose(t) for t in (terms or needles) if t]
    phrase = " ".join(terms) if len(terms) > 1 else None
    word_pats = [re.compile(r"(?<![^\W_])" + re.escape(t) + ("" if i == len(terms) - 1 else r"(?![^\W_])"),
                            re.IGNORECASE) for i, t in enumerate(terms)]
    n = len(body)
    cands: list[tuple[tuple, int, int, int]] = []  # (rank, ls, le, line_no)
    count = 0
    pos = 0
    line_no = 1
    counted_to = 0
    while pos <= n:
        m = pat.search(body, pos)
        if not m:
            break
        ls = body.rfind("\n", 0, m.start()) + 1
        le = body.find("\n", m.start())
        if le == -1:
            le = n
        count += 1
        line_no += body.count("\n", counted_to, ls)
        counted_to = ls
        low = body[ls:le].lower() if plain else _loose(body[ls:le])
        distinct = sum(1 for t in terms if t in low)
        words = sum(1 for wp in word_pats if wp.search(low))
        rank = (1 if phrase and phrase in low else 0, distinct, words)
        cands.append((rank, ls, le, line_no))
        pos = le + 1
    # best first; ties keep document order (sort is stable)
    best = sorted(cands, key=lambda c: c[0], reverse=True)[:MAX_LINES]
    results: list[dict] = []
    for _rank, ls, le, ln in best:
        line = body[ls:le].rstrip("\r")
        spans = [(x.start(), x.end()) for x in pat.finditer(line)]
        start = 0
        if len(line) > LINE_CHARS and spans and spans[0][1] > LINE_CHARS:
            start = max(0, spans[0][0] - LINE_CHARS // 3)
        text = line[start:start + LINE_CHARS]
        ranges = [(max(s - start, 0), min(e - start, len(text)))
                  for s, e in spans if e > start and s < start + len(text)]
        results.append({"line": ln, "offset": len(body[:ls].encode("utf-8")), "text": text,
                        "ranges": merge_ranges(ranges)})
    return results, count


# --- which files are indexed ---------------------------------------------------------------------

def selection_key(e: Entry) -> tuple:
    """Over a cap, files are indexed in this order until it is reached: documents (markdown,
    mermaid, .docx), then other text, code, JSON / CSV; within a kind shallower paths first, then
    smaller files, then by path."""
    return (KIND_RANK.get(e.kind, 9), e.path.count("/"), e.size, e.path)


def plan_selection(entries, max_bytes: int, max_files: int, max_total: int, skip=None):
    """(allowed paths or None for all, number of indexable files, cap reached: "" | "files" |
    "bytes"). Indexable: a searchable kind within the per-file limit; skip(entry) -> True leaves
    a file out (it could not be read or converted)."""
    return _plan(entries, max_bytes, max_files, max_total, skip)[:3]


def _plan(entries, max_bytes: int, max_files: int, max_total: int, skip=None):
    """plan_selection plus the selection_key of the last file let in (None: no cap) and the
    bytes they use: what SearchIndex.apply_change needs to judge a change without a new plan."""
    cands = [e for e in entries if indexable(e, max_bytes) and not (skip and skip(e))]
    total = sum(e.size for e in cands)
    if len(cands) <= max_files and total <= max_total:
        return None, len(cands), "", None, total
    cands.sort(key=selection_key)
    allowed: set[str] = set()
    used = 0
    reason = ""
    cutoff = None
    for e in cands:
        if len(allowed) >= max_files:
            reason = reason or "files"
            break
        if used + e.size > max_total:
            reason = "bytes"
            continue  # a smaller file further on may still fit
        allowed.add(e.path)
        used += e.size
        cutoff = e
    return allowed, len(cands), reason or "files", None if cutoff is None else selection_key(cutoff), used


def indexable(e: Entry, max_bytes: int) -> bool:
    if e.kind == "docx":
        return e.size <= DOCX_MAX
    return e.kind in INDEXED_KINDS and e.size <= max_bytes


def index_file(index_dir: str, root: str) -> str:
    return os.path.join(index_dir, root_key(root) + ".sqlite3")


_DB_SUFFIXES = ("", "-wal", "-shm", "-journal")


def _unlink_db(path: str) -> None:
    for s in _DB_SUFFIXES:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(path + s)


def _try_lock(path: str) -> int | None:
    """An exclusive, non-blocking flock on `path` (created 0600). The fd, or None if another
    process (or another index in this one) holds it."""
    for _ in range(3):
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(fd)
            return None
        # prune_indexes may have unlinked the file between our open and flock: a lock on that
        # inode guards nothing (the next opener creates a new file), so take the current one
        try:
            st, now = os.fstat(fd), os.stat(path, follow_symlinks=False)
            if (st.st_dev, st.st_ino) == (now.st_dev, now.st_ino):
                return fd
        except FileNotFoundError:
            pass
        os.close(fd)
    return None


def prune_indexes(index_dir: str, keep_roots) -> list[str]:
    """Delete the index files of roots not in `keep_roots` (the recent folders), unless another
    viewer is using them. Returns the keys removed."""
    keep = {root_key(r) for r in keep_roots if r}
    removed = []
    try:
        names = os.listdir(index_dir)
    except OSError:
        return removed
    for name in sorted(names):
        if not name.endswith(".sqlite3") or name[:-8] in keep:
            continue
        key = name[:-8]
        if not re.fullmatch(r"[0-9a-f]{24}", key):
            continue
        db = os.path.join(index_dir, name)
        try:
            fd = _try_lock(db + ".lock")
        except OSError:
            continue
        if fd is None:
            continue  # in use
        try:
            _unlink_db(db)
            with contextlib.suppress(OSError):
                os.unlink(db + ".lock")
            removed.append(key)
        finally:
            os.close(fd)
    return removed


TEMP_PREFIX = "ldv-search-"  # <temp dir>/ldv-search-XXXX/index.sqlite3 (+ .lock): the fallback index
TEMP_SWEEP_AGE = 60.0  # s: a temporary index dir this old whose .lock nobody holds is a leftover


def sweep_temp(tmp: str) -> list[str]:
    """Delete temporary indexes left behind by viewers that did not stop cleanly (killed): dirs
    named TEMP_PREFIX* in `tmp`, older than TEMP_SWEEP_AGE, whose .lock no process holds."""
    removed = []
    try:
        names = os.listdir(tmp)
    except OSError:
        return removed
    now = time.time()
    for name in names:
        if not name.startswith(TEMP_PREFIX):
            continue
        d = os.path.join(tmp, name)
        try:
            st = os.lstat(d)
            if not os.path.isdir(d) or os.path.islink(d) or st.st_uid != os.getuid():
                continue
            if now - st.st_mtime < TEMP_SWEEP_AGE:
                continue  # may be being created right now
            fd = _try_lock(os.path.join(d, ".lock"))
        except OSError:
            continue
        if fd is None:
            continue  # in use
        try:
            shutil.rmtree(d, ignore_errors=True)
            removed.append(name)
        finally:
            os.close(fd)
    return removed


_NO_TIME = object()  # SearchIndex._snippet_text: no time left to convert a .docx


def _pack(keys) -> bytes:
    """Distinct non-negative ints, sorted and delta-coded as varints (about 2 bytes each)."""
    out, prev = bytearray(), 0
    for k in sorted(keys):
        d, prev = k - prev, k
        while d > 0x7F:
            out.append(d & 0x7F | 0x80)
            d >>= 7
        out.append(d)
    return bytes(out)


def _unpack(data: bytes) -> list[int]:
    keys, cur, d, shift = [], 0, 0, 0
    for b in data:
        d |= (b & 0x7F) << shift
        if b & 0x80:
            shift += 7
        else:
            cur += d
            keys.append(cur)
            d = shift = 0
    return keys


class _Stale(Exception):
    """The database is unusable (corrupt, foreign, old schema): delete and rebuild."""


class SearchIndex:
    def __init__(self, store: Store, max_bytes: int, *, index_dir: str | None = None,
                 max_files: int = DEFAULT_MAX_FILES, max_total_bytes: int = int(DEFAULT_MAX_TOTAL_MB * 1024 * 1024),
                 contentless_delete: bool | None = None):
        self.store = store
        self.root = store.root
        self.max_bytes = max_bytes
        self.max_files = max(1, int(max_files))
        self.max_total_bytes = max(1, int(max_total_bytes))
        self.delete_mode = CONTENTLESS_DELETE if contentless_delete is None else contentless_delete
        self.indexing = True
        self._stopped = threading.Event()  # set when the owning app shuts down (root switch): ends a build
        self._lock = threading.RLock()  # the connection and the counters
        self._sync_lock = threading.Lock()  # one sync_with_store at a time
        self._index_dir = index_dir
        self._lock_fd: int | None = None
        self._tmp_dir: str | None = None
        self.db_path = ":memory:"
        self.location = "memory"  # "data" | "temp" | "memory"
        # cap state (plan_selection)
        self._allowed: set[str] | None = None
        self._indexable = 0
        self._limit = ""  # "", "files", "bytes", "disk"
        self._replan = False
        self._disk_full = False
        self._count = 0  # rows / file bytes indexed (committed or pending)
        self._bytes = 0
        self._pending = 0
        self._pending_bytes = 0
        self._in_tx = False
        self._dead = 0  # old SQLite: unlinked rows and their files' bytes
        self._dead_bytes = 0
        # files that could not be read or converted, path -> (size, mtime_ns, kept in the db): not
        # read again until they change, and left out of the plan so they take no slot. Conversion
        # failures are kept in the `skipped` table across restarts, I/O errors (permissions) only
        # until the next start.
        self._failed: dict[str, tuple[int, int, bool]] = {}
        self._cutoff: tuple | None = None  # plan: selection_key of the last file let in
        self._planned = 0  # plan: bytes of the files let in
        self._indexable_dirty = False  # recount indexable files on the next status()
        self._last_sync = float("-inf")  # time.monotonic() of the last full sync
        self._reused = False  # the database was there already (checked in the build thread)
        self._gen = 0  # bumped by _reset: one reset per broken database
        self._threads = threading.Lock()  # starting the build / re-plan threads
        self._builder: threading.Thread | None = None
        self._replanner: threading.Thread | None = None
        self._db: sqlite3.Connection | None = self._open()

    # --- the database -------------------------------------------------------
    def _open(self) -> sqlite3.Connection:
        if self._index_dir is not None:
            try:
                db = self._open_data(self._index_dir)
                if db is not None:
                    return db
            except (OSError, sqlite3.Error) as e:
                log.warning("search index: %s unusable (%s); using a temporary file", self._index_dir, e)
                self._release_lock()
        return self._open_temp()

    def _open_data(self, index_dir: str) -> sqlite3.Connection | None:
        os.makedirs(index_dir, mode=0o700, exist_ok=True)
        path = index_file(index_dir, self.root)
        fd = _try_lock(path + ".lock")
        if fd is None:
            log.info("search index %s is used by another viewer; using a temporary file", path)
            return None
        self._lock_fd = fd
        try:
            db = self._connect(path)
        except _Stale as e:
            log.info("search index %s: %s; rebuilding", path, e)
            _unlink_db(path)
            db = self._connect(path)
        self.db_path, self.location = path, "data"
        return db

    def _open_temp(self) -> sqlite3.Connection:
        tmp = tempfile.gettempdir()
        if not path_within(tmp, self.root):
            sweep_temp(tmp)
            try:
                self._tmp_dir = tempfile.mkdtemp(prefix=TEMP_PREFIX)
                # held while in use, so that sweep_temp in another process leaves it alone
                self._lock_fd = _try_lock(os.path.join(self._tmp_dir, ".lock"))
                path = os.path.join(self._tmp_dir, "index.sqlite3")
                db = self._connect(path)
                self.db_path, self.location = path, "temp"
                return db
            except (OSError, sqlite3.Error) as e:
                log.warning("search index: no temporary file (%s); keeping it in memory", e)
                self._release_lock()
                self._remove_tmp()
        # the only place left would be inside the browsed folder
        db = self._connect(":memory:")
        self.db_path, self.location = ":memory:", "memory"
        return db

    def _connect(self, path: str) -> sqlite3.Connection:
        if path != ":memory:":
            try:
                st = os.lstat(path)
                if not os.path.isfile(path) or os.path.islink(path):
                    raise _Stale("not a regular file")
                fresh = st.st_size == 0
            except FileNotFoundError:
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                os.close(fd)
                fresh = True
            if fresh:  # an empty file: no leftover journal may replay into it
                for suffix in _DB_SUFFIXES[1:]:
                    with contextlib.suppress(FileNotFoundError):
                        os.unlink(path + suffix)
        else:
            fresh = True
        db = sqlite3.connect(path, timeout=5.0, check_same_thread=False, isolation_level=None)
        try:
            db.execute(f"PRAGMA cache_size=-{CACHE_KIB}")
            db.execute("PRAGMA mmap_size=0")
            db.execute("PRAGMA temp_store=FILE")
            if path != ":memory:":
                db.execute("PRAGMA journal_mode=WAL")
                db.execute("PRAGMA synchronous=NORMAL")
                db.execute(f"PRAGMA journal_size_limit={BATCH_BYTES * 2}")
            want = {"schema": SCHEMA_VERSION, "tokenize": TOKENIZE, "root": self.root,
                    "mode": "delete" if self.delete_mode else "tombstone"}
            if not fresh:
                try:
                    have = dict(db.execute("SELECT key, value FROM info").fetchall())
                    db.execute("SELECT id, path, size, mtime_ns, ext FROM files LIMIT 1").fetchall()
                    db.execute("SELECT rowid FROM docs LIMIT 1").fetchall()
                    db.execute("SELECT id, name FROM words LIMIT 1").fetchall()
                    db.execute("SELECT word_id, def, file_id, n FROM uses LIMIT 1").fetchall()
                    db.execute("SELECT file_id, ids FROM file_words LIMIT 1").fetchall()
                    failed = db.execute("SELECT path, size, mtime_ns FROM skipped").fetchall()
                except sqlite3.DatabaseError as e:
                    raise _Stale(str(e)) from None
                if any(have.get(k) != v for k, v in want.items()):
                    raise _Stale("built by another version or for another folder")
                self._dead = int(have.get("dead") or 0)
                self._dead_bytes = int(have.get("dead_bytes") or 0)
                self._failed = {p: (size, mtime, True) for p, size, mtime in failed}
            else:
                opts = ", contentless_delete=1" if self.delete_mode else ""
                db.executescript(
                    "BEGIN;"
                    "CREATE TABLE info (key TEXT PRIMARY KEY, value TEXT NOT NULL);"
                    "CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE,"
                    " size INTEGER NOT NULL, mtime_ns INTEGER NOT NULL, ext TEXT NOT NULL);"
                    "CREATE TABLE skipped (path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime_ns INTEGER NOT NULL);"
                    f"CREATE VIRTUAL TABLE docs USING fts5(body, content=''{opts}, tokenize='{TOKENIZE}');"
                    # identifiers of code files (viewer.names), for editor completion. Each
                    # distinct name once (prefix lookups in any case: NOCASE, identifiers are
                    # ASCII), its uses keyed by (name, definition or not, file) so definitions
                    # are read first, and per file the packed list of its use keys (_pack) so
                    # removing a file seeks its rows instead of keeping a second index
                    "CREATE TABLE words (id INTEGER PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE);"
                    "CREATE INDEX words_name ON words(name);"
                    "CREATE TABLE uses (word_id INTEGER NOT NULL, def INTEGER NOT NULL, file_id INTEGER NOT NULL,"
                    " n INTEGER NOT NULL, PRIMARY KEY (word_id, def, file_id)) WITHOUT ROWID;"
                    "CREATE TABLE file_words (file_id INTEGER PRIMARY KEY, ids BLOB NOT NULL);"
                    "COMMIT;")
                db.executemany("INSERT INTO info VALUES (?, ?)",
                               list(want.items()) + [("dead", "0"), ("dead_bytes", "0")])
                self._dead = self._dead_bytes = 0
                self._failed = {}
            self._reused = not fresh
            self._count, self._bytes = db.execute("SELECT count(*), coalesce(sum(size), 0) FROM files").fetchone()
        except _Stale:
            db.close()
            raise
        except sqlite3.DatabaseError as e:
            db.close()
            if fresh:
                raise
            raise _Stale(str(e)) from None
        return db

    def _release_lock(self) -> None:
        if self._lock_fd is not None:
            with contextlib.suppress(OSError):
                os.close(self._lock_fd)  # closing drops the flock
            self._lock_fd = None

    def _remove_tmp(self) -> None:
        if self._tmp_dir is not None:
            shutil.rmtree(self._tmp_dir, ignore_errors=True)
            self._tmp_dir = None

    def _close(self) -> None:
        if self._db is not None:
            with contextlib.suppress(sqlite3.Error):
                if self._in_tx:
                    self._db.execute("COMMIT")
            self._db.close()
            self._db = None
        self._in_tx = False
        self._pending = self._pending_bytes = 0

    def _reset(self) -> None:
        """The database broke while in use (corruption): start over with an empty one."""
        with self._lock:
            self._gen += 1
            path = self.db_path
            with contextlib.suppress(sqlite3.Error):
                self._close()
            if self.location != "memory":
                _unlink_db(path)
            try:
                self._db = self._connect(path)
            except (OSError, sqlite3.Error, _Stale):
                self._release_lock()
                self._remove_tmp()
                self._db = self._open_temp()

    def _begin(self) -> sqlite3.Connection:
        assert self._db is not None
        if not self._in_tx:
            self._db.execute("BEGIN")
            self._in_tx = True
        return self._db

    def commit(self) -> None:
        with self._lock:
            if self._db is not None and self._in_tx:
                try:
                    self._db.execute("COMMIT")
                except sqlite3.OperationalError as e:
                    self._write_failed(e)
                    return
                finally:
                    self._pending = self._pending_bytes = 0
                self._in_tx = False

    def _maybe_commit(self) -> None:
        if self._pending >= BATCH_FILES or self._pending_bytes >= BATCH_BYTES:
            self.commit()

    def _write_failed(self, e: sqlite3.Error) -> None:
        """A write failed (disk full, I/O error, locked): drop the batch, keep what was committed
        and stop adding files until the next full sync, which apply_change starts after
        RETRY_INTERVAL (it also redoes the batch's deletes). Corruption is handled by the caller
        (_reset)."""
        if not isinstance(e, sqlite3.OperationalError):
            raise e
        log.warning("search index: %s; the files indexed so far stay searchable", e)
        if self._db is not None:
            with contextlib.suppress(sqlite3.Error):
                self._db.execute("ROLLBACK")
            self._in_tx = False
            self._pending = self._pending_bytes = 0
            with contextlib.suppress(sqlite3.Error):
                self._count, self._bytes = self._db.execute(
                    "SELECT count(*), coalesce(sum(size), 0) FROM files").fetchone()
            with contextlib.suppress(sqlite3.Error, ValueError):  # the rolled back batch's unlinked rows
                info = dict(self._db.execute("SELECT key, value FROM info WHERE key IN ('dead', 'dead_bytes')"))
                self._dead, self._dead_bytes = int(info.get("dead") or 0), int(info.get("dead_bytes") or 0)
        self._disk_full = True
        self._limit = "disk" if "full" in str(e).lower() else "error"

    # --- maintenance --------------------------------------------------------
    def _read(self, e: Entry) -> tuple[str | None, bool]:
        """(text, False), or (None, lasting): lasting = the file cannot be indexed as it is (a
        conversion error, too large); else an I/O error (a permission), tried again next start."""
        if e.kind == "docx":
            return self._read_docx(e)
        if e.kind not in INDEXED_KINDS or e.size > self.max_bytes:
            return None, True
        # Entries come from the store, which only holds vetted in-root paths.
        try:
            with open(os.path.join(self.root, *e.path.split("/")), "rb") as f:
                data = f.read(self.max_bytes + 1)
        except OSError:
            return None, False
        if len(data) > self.max_bytes:
            return None, False  # grew since the scan: the change that follows reads it again
        return data.decode("utf-8", errors="replace"), False

    def _read_docx(self, e: Entry) -> tuple[str | None, bool]:
        """The document's markdown (viewer.docx, cached), up to the search limit. Converted under
        the background lock and a lower XML limit, so indexing never holds up a viewer request."""
        if e.size > DOCX_MAX:
            return None, True
        try:
            text = convert_cached(os.path.join(self.root, *e.path.split("/")), images=False,
                                  background=True).markdown
        except DocxError:
            return None, True  # broken, encrypted, an Office lock file (~$x.docx), too large
        except OSError:
            return None, False
        if len(text.encode("utf-8")) > self.max_bytes:
            return None, True
        return text, False

    def _row(self, path: str):
        """(id, size, mtime_ns) of the indexed version of `path`, or None. Lock held."""
        if self._db is None:
            return None
        return self._db.execute("SELECT id, size, mtime_ns FROM files WHERE path = ?", (path,)).fetchone()

    def _delete_row(self, row) -> None:
        db = self._begin()
        db.execute("DELETE FROM files WHERE id = ?", (row[0],))
        self._delete_names(db, row[0])
        if self.delete_mode:
            db.execute("DELETE FROM docs WHERE rowid = ?", (row[0],))
        else:
            # Without contentless_delete the tokens cannot be removed: the row is only unlinked
            # (queries join on `files`, ids are never reused) and the index rebuilt when too many.
            self._dead += 1
            self._dead_bytes += row[1]
            db.executemany("UPDATE info SET value = ? WHERE key = ?",
                           ((str(self._dead), "dead"), (str(self._dead_bytes), "dead_bytes")))
        self._count -= 1
        self._bytes -= row[1]
        self._pending += 1

    @staticmethod
    def _insert_names(db, file_id: int, names) -> None:
        keys = []
        for name, isdef, _ in names:
            r = db.execute("SELECT id FROM words WHERE name = ? AND name = ? COLLATE BINARY", (name, name)).fetchone()
            keys.append((r[0] if r else db.execute("INSERT INTO words(name) VALUES (?)", (name,)).lastrowid) * 2 + isdef)
        db.executemany("INSERT INTO uses VALUES (?, ?, ?, ?)",
                       ((k >> 1, k & 1, file_id, n) for k, (*_, n) in zip(keys, names)))
        db.execute("INSERT INTO file_words VALUES (?, ?)", (file_id, _pack(keys)))

    @staticmethod
    def _delete_names(db, file_id: int) -> None:
        r = db.execute("SELECT ids FROM file_words WHERE file_id = ?", (file_id,)).fetchone()
        if r is None:
            return
        keys = _unpack(r[0])
        db.executemany("DELETE FROM uses WHERE word_id = ? AND def = ? AND file_id = ?",
                       ((k >> 1, k & 1, file_id) for k in keys))
        # names no other file uses go too
        db.executemany("DELETE FROM words WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM uses WHERE word_id = ?1)",
                       ((w,) for w in {k >> 1 for k in keys}))
        db.execute("DELETE FROM file_words WHERE file_id = ?", (file_id,))

    def _is_failed(self, e: Entry) -> bool:
        f = self._failed.get(e.path)
        return f is not None and (f[0], f[1]) == e.sig

    def _mark_failed(self, e: Entry, lasting: bool) -> None:
        """This version of the file could not be read or converted: skip it until it changes.
        Lock held."""
        self._failed[e.path] = (e.size, e.mtime_ns, lasting)
        if lasting:
            self._begin().execute("INSERT OR REPLACE INTO skipped VALUES (?, ?, ?)", (e.path, e.size, e.mtime_ns))
            self._pending += 1
        if self._allowed is not None and e.path in self._allowed:
            self._replan = True  # its slot can go to the next file in line

    def _unfail(self, path: str) -> None:
        """Lock held."""
        f = self._failed.pop(path, None)
        if f is not None and f[2] and self._db is not None:
            self._begin().execute("DELETE FROM skipped WHERE path = ?", (path,))
            self._pending += 1

    def _too_many_dead(self) -> bool:
        return not self.delete_mode and (self._dead >= max(TOMBSTONE_REBUILD_MIN, self._count + 1)
                                         or self._dead_bytes >= max(TOMBSTONE_REBUILD_BYTES, self._bytes + 1))

    def _rebuild_tombstoned(self) -> None:
        """Old SQLite only: recreate the FTS table and forget every row; the next sync re-reads."""
        with self._lock:
            if self._db is None:
                return
            self.commit()
            db = self._db
            db.executescript(
                "BEGIN; DROP TABLE docs; DELETE FROM files; DELETE FROM words; DELETE FROM uses;"
                "DELETE FROM file_words;"
                f"CREATE VIRTUAL TABLE docs USING fts5(body, content='', tokenize='{TOKENIZE}');"
                "UPDATE info SET value = '0' WHERE key IN ('dead', 'dead_bytes'); COMMIT;")
            self._dead = self._dead_bytes = self._count = self._bytes = 0

    def _wanted(self, e: Entry) -> bool:
        return indexable(e, self.max_bytes) and (self._allowed is None or e.path in self._allowed)

    def _flush_writes(self, commit: bool) -> None:
        if commit:
            self.commit()
        else:
            self._maybe_commit()

    def remove(self, path: str, *, commit: bool = True) -> None:
        with self._lock:
            if self._db is None:
                return
            try:
                row = self._row(path)
                if row is not None:
                    self._delete_row(row)
                self._unfail(path)
                if commit:
                    self.commit()
            except sqlite3.OperationalError as e:
                self._write_failed(e)

    def upsert(self, e: Entry, *, commit: bool = True) -> None:
        with self._lock:
            if self._db is None or self._stopped.is_set():
                return
            cur = self._row(e.path)
        if cur is not None and (cur[1], cur[2]) == e.sig:
            return
        if not self._wanted(e):
            if cur is not None:
                self.remove(e.path, commit=commit)
            return
        if self._is_failed(e) or (cur is None and self._disk_full):
            return
        body, lasting = self._read(e)
        # code files: their identifiers, for completion (outside the lock: a regex pass over the text)
        names = extract(body, e.ext) if body is not None and e.kind == "code" else ()
        with self._lock:
            if self._stopped.is_set() or self._db is None:
                return
            # the file may have been removed/changed while reading
            live = self.store.get(e.path)
            if live is not None and live.sig != e.sig:
                return  # we hold a stale Entry; the upsert for the live version owns the row
            try:
                row = self._row(e.path)
                if row is not None and live is not None and (row[1], row[2]) == live.sig:
                    return  # someone already indexed exactly this version
                if row is not None:
                    self._delete_row(row)
                if live is not None:
                    if body is None:
                        self._mark_failed(e, lasting)
                    elif self._count + 1 > self.max_files or self._bytes + e.size > self.max_total_bytes:
                        self._replan = True  # over a cap now: choose again
                    else:
                        self._unfail(e.path)
                        db = self._begin()
                        c = db.execute("INSERT INTO files(path, size, mtime_ns, ext) VALUES (?, ?, ?, ?)",
                                       (e.path, e.size, e.mtime_ns, e.ext))
                        db.execute("INSERT INTO docs(rowid, body) VALUES (?, ?)", (c.lastrowid, body))
                        if names:
                            self._insert_names(db, c.lastrowid, names)
                        self._count += 1
                        self._bytes += e.size
                        self._pending += 1
                        self._pending_bytes += len(body)
                self._flush_writes(commit)
            except sqlite3.OperationalError as err:
                self._write_failed(err)

    def _changes_choice(self, e: Entry, allowed: set[str]) -> bool:
        """A cap is in force: True when this added or changed file may change which files are
        chosen (then a full re-plan). A file that sorts after the last one chosen is let in right
        here if there is room left, as the plan would."""
        cutoff = self._cutoff
        if e.path in allowed:
            if not indexable(e, self.max_bytes):
                return True  # its slot opens up
            with self._lock:
                row = self._row(e.path)
            if row is not None and row[1] == e.size:
                return False  # same size: same place in line, same bytes
            return self._limit == "bytes" or cutoff is None or selection_key(e) > cutoff
        if not indexable(e, self.max_bytes) or self._is_failed(e):
            return False
        key = selection_key(e)
        if cutoff is None or key < cutoff:
            return True  # it outranks a chosen file
        if len(allowed) < self.max_files and self._planned + e.size <= self.max_total_bytes:
            allowed.add(e.path)
            self._planned += e.size
            self._cutoff = key
        return False

    def apply_change(self, change_json: dict) -> None:
        """Bring the index up to date with one change; the work is proportional to the files in
        it. When a cap is in force and the change may alter the choice of files, the full re-plan
        runs in the background (at most every REPLAN_INTERVAL s): the change handler never waits."""
        if self._stopped.is_set():
            return
        gen = self._gen
        try:
            replan = False
            allowed = self._allowed
            for p in [*change_json["deleted"], *(r["from"] for r in change_json["renames"])]:
                if allowed is not None and p in allowed:
                    replan = True  # a slot and its bytes opened up: the next file in line gets them
                self.remove(p, commit=False)
            for p in [*change_json["added"], *change_json["modified"], *(r["to"] for r in change_json["renames"])]:
                e = self.store.get(p)
                if e is None:
                    continue
                if allowed is not None and self._changes_choice(e, allowed):
                    replan = True
                self.upsert(e, commit=False)
            self.commit()
            self._indexable_dirty = True
            if self._too_many_dead():
                self._request_build()  # old SQLite: recreate the FTS table and read everything again
            elif replan or self._replan or (self._limit in ("disk", "error")
                                            and time.monotonic() - self._last_sync >= RETRY_INTERVAL):
                self._schedule_replan()
        except sqlite3.DatabaseError:
            log.exception("search index broken; rebuilding")
            self._broken(gen)

    def _broken(self, gen: int) -> None:
        """A query or write hit a corrupt database: start over (once per database) and rebuild."""
        with self._lock:
            if gen != self._gen or self._stopped.is_set():
                return  # already reset
            self._reset()
        self._request_build()

    def _request_build(self) -> None:
        """Rebuild or catch up in the background (corruption, old SQLite's tombstones); a build
        that is running picks the request up."""
        with self._threads:
            if self._stopped.is_set():
                return
            self._replan = True
            if self._builder is not None:
                return
            self.indexing = True
            self._builder = threading.Thread(target=self.build, name="search-index", daemon=True)
            self._builder.start()

    def _schedule_replan(self) -> None:
        with self._threads:
            self._replan = True
            if self._replanner is None and not self._stopped.is_set():
                self._replanner = threading.Thread(target=self._replan_loop, name="search-replan", daemon=True)
                self._replanner.start()

    def _replan_loop(self) -> None:
        try:
            while not self._stopped.is_set():
                wait = self._last_sync + REPLAN_INTERVAL - time.monotonic()
                if wait > 0 and self._stopped.wait(wait):
                    break
                with self._sync_lock:
                    if self._replan and not self._stopped.is_set():
                        gen = self._gen
                        try:
                            self._sync_locked()
                        except sqlite3.DatabaseError:
                            log.exception("search index broken; rebuilding")
                            self._broken(gen)
                with self._threads:
                    if not self._replan or self._stopped.is_set():
                        self._replanner = None
                        return
        except Exception:  # pragma: no cover
            log.exception("search re-plan failed")
        with self._threads:
            self._replanner = None

    def flush(self) -> None:
        """Wait for a running build, then run a pending re-plan now (tests, shutdown-free callers)."""
        t = self._builder
        if t is not None:
            t.join()
        with self._sync_lock:
            if self._replan and not self._stopped.is_set():
                self._sync_locked()

    def stop(self) -> None:
        """App shut down (root switch): abandon any background build (the thread cannot be killed;
        it checks the flag), close the database (a temporary one is deleted) and release it for
        the next viewer of this folder."""
        self._stopped.set()
        with self._lock:
            self._close()
            self._release_lock()
            self._remove_tmp()

    def _sync_locked(self) -> None:
        if self._too_many_dead():
            self._rebuild_tombstoned()
        self._replan = False
        self._disk_full = False  # try again (a write that fails sets it anew)
        entries = self.store.all_entries()
        allowed, total, reason, cutoff, used = _plan(entries, self.max_bytes, self.max_files, self.max_total_bytes,
                                                     self._is_failed)
        self._allowed, self._indexable, self._cutoff, self._planned = allowed, total, cutoff, used
        self._indexable_dirty = False
        self._limit = reason
        with self._lock:  # forget the failures of files that are gone or changed
            if self._db is None:
                return
            for p, (size, mtime, _lasting) in list(self._failed.items()):
                e = self.store.get(p)
                if e is None or e.sig != (size, mtime):
                    self._unfail(p)
        # drop rows of files that are gone or no longer chosen, a page at a time; note the ones
        # that are up to date (the store's own path strings: no copies), which need no upsert
        current: set[str] = set()
        last = 0
        while not self._stopped.is_set():
            with self._lock:
                if self._db is None:
                    return
                page = self._db.execute("SELECT id, path, size, mtime_ns FROM files WHERE id > ? ORDER BY id"
                                        " LIMIT 1000", (last,)).fetchall()
            if not page:
                break
            last = page[-1][0]
            for _id, p, size, mtime in page:
                e = self.store.get(p)
                if e is None or not self._wanted(e):
                    self.remove(p, commit=False)
                elif e.sig == (size, mtime):
                    current.add(e.path)
            self._maybe_commit()
        entries = [e for e in entries if e.path not in current and (allowed is None or e.path in allowed)]
        del current
        entries.sort(key=selection_key)  # documents first: searchable soonest
        for e in entries:
            if self._stopped.is_set():
                return
            self.upsert(e, commit=False)
        self.commit()
        self._last_sync = time.monotonic()

    def sync_with_store(self) -> None:
        with self._sync_lock:
            self._sync_locked()

    def _check(self) -> bool:
        """Is the database that was there on start sound? PRAGMA quick_check on a second, read-only
        connection, so searches go on meanwhile. Damage it misses shows when a query fails (then
        search() resets)."""
        if self.location == "memory":
            return True
        try:
            c = sqlite3.connect(self.db_path, timeout=5.0, isolation_level=None)
        except sqlite3.Error:
            return False
        try:
            c.execute("PRAGMA query_only=1")
            c.execute(f"PRAGMA cache_size=-{CACHE_KIB // 4}")
            c.execute("PRAGMA mmap_size=0")
            rows = c.execute("PRAGMA quick_check(1)").fetchall()
            return rows == [("ok",)]
        except sqlite3.OperationalError as e:
            log.info("search index check skipped: %s", e)
            return True  # busy or the like: cannot tell
        except sqlite3.DatabaseError:
            return False
        finally:
            c.close()

    def _checkpoint(self) -> None:
        """After a build: fold the WAL into the database and truncate it."""
        if self.location == "memory":
            return
        with self._lock:
            if self._db is not None and not self._in_tx:
                with contextlib.suppress(sqlite3.Error):
                    self._db.execute("PRAGMA wal_checkpoint(TRUNCATE)")

    def _sync_all(self) -> None:
        for attempt in range(2):
            try:
                self.sync_with_store()
                self.sync_with_store()  # catch anything that changed during the first pass
                for _ in range(3):  # a change pushed it over a cap, or a chosen file failed: again
                    if not self._replan or self._stopped.is_set():
                        break
                    self.sync_with_store()
                return
            except sqlite3.DatabaseError:
                if attempt or self._stopped.is_set():
                    raise
                log.exception("search index broken; rebuilding")
                self._reset()

    def build(self) -> None:
        try:
            self._sync_all()
            self._checkpoint()
            if self._reused and not self._stopped.is_set():
                # a database from an earlier run: check it now, searchable meanwhile (a few
                # seconds for a few hundred MB, on its own connection)
                self._reused = False
                self.indexing = False
                if not self._check() and not self._stopped.is_set():
                    log.warning("search index %s is damaged; rebuilding", self.db_path)
                    self._reset()
                    self.indexing = True
                    self._sync_all()
                    self._checkpoint()
        except Exception:  # pragma: no cover
            log.exception("search index build failed")
        finally:
            with self._threads:
                self._builder = None
                self.indexing = False
            if self._replan and not self._stopped.is_set():
                self._schedule_replan()  # asked for while the build was finishing

    def start_background_build(self) -> threading.Thread:
        with self._threads:
            t = threading.Thread(target=self.build, name="search-index", daemon=True)
            self._builder = t
            self.indexing = True
            t.start()
        return t

    def status(self) -> dict:
        if self._indexable_dirty and not self.indexing:  # files came or went since the last plan
            self._indexable_dirty = False
            self._indexable = sum(1 for e in self.store.all_entries()
                                  if indexable(e, self.max_bytes) and not self._is_failed(e))
        return {"indexing": self.indexing, "indexed_files": max(0, self._count),
                "indexable_files": self._indexable, "limit_reached": bool(self._limit),
                "limit_reason": self._limit or None}

    # --- querying -----------------------------------------------------------
    def _snippet_text(self, e: Entry, deadline: float):
        """The current text of a hit, read from disk through the path guard (the file may have
        changed or gone since it was indexed): at most the per-file limit; a .docx's markdown
        from the conversion cache, converted only while the per-query budget lasts. None: gone or
        unreadable; _NO_TIME: a .docx not converted in time. With the file's (size, mtime_ns)."""
        try:
            r, st = self.store.guard.resolve_file(e.path)
        except PathError:
            return None, None
        sig = (st.st_size, st.st_mtime_ns)
        if e.kind == "docx":
            left = deadline - time.monotonic()
            if st.st_size > DOCX_MAX:
                return None, sig
            try:
                return convert_cached(r.real, images=False, st=st, wait=left, recent=False).markdown, sig
            except DocxError as err:
                return (_NO_TIME if err.status == 503 else None), sig
            except OSError:
                return None, sig
        try:
            with open(r.real, "rb") as f:
                data = f.read(self.max_bytes)
        except OSError:
            return None, sig
        return data.decode("utf-8", errors="replace"), sig

    def search(self, q: str, folder: str = "", types: str | None = None, limit: int = MAX_FILES) -> dict:
        q = (q or "").strip()
        out = {**self.status(), "names": [], "content": []}
        if not q:
            return out
        tset = _types_filter(types)
        folder = (folder or "").strip("/")
        limit = max(1, min(int(limit or MAX_FILES), MAX_FILES))

        # file names
        terms = [t.lower() for t in q.split()]
        hits = []
        for e in self.store.all_entries():
            lp = e.path.lower()
            if not all(t in lp for t in terms):
                continue
            if not _folder_ok(e.path, folder) or (tset is not None and e.ext not in tset):
                continue
            ln = e.name.lower()
            hits.append((0 if all(t in ln for t in terms) else 1, len(e.path), e.path, e))
        hits.sort(key=lambda h: h[:3])
        out["names"] = [{"path": e.path, "name": e.name, "kind": e.kind} for *_, e in hits[:MAX_NAMES]]

        # content: FTS first (CROSS JOIN keeps that order), then the file rows
        mq = build_match_query(q)
        if mq is None:
            return out
        sql = ("SELECT f.path, f.size, f.mtime_ns, bm25(docs) FROM docs CROSS JOIN files f ON f.id = docs.rowid"
               " WHERE docs MATCH ?")
        args: list = [mq]
        if folder:
            sql += " AND (f.path = ? OR substr(f.path, 1, ?) = ?)"
            args += [folder, len(folder) + 1, folder + "/"]
        if tset is not None:
            sql += f" AND f.ext IN ({','.join('?' * len(tset))})"
            args += sorted(tset)
        sql += " ORDER BY bm25(docs) LIMIT ?"
        args.append(limit)
        gen = self._gen
        try:
            with self._lock:
                if self._db is None:
                    return out
                rows = self._db.execute(sql, args).fetchall()
        except sqlite3.OperationalError:  # busy, or a query FTS5 rejects
            return out
        except sqlite3.DatabaseError:  # corrupt (the old in-memory index could not be)
            log.exception("search index broken; rebuilding")
            self._broken(gen)
            out.update(self.status())
            return out
        needles = needles_for(q)
        deadline = time.monotonic() + SNIPPET_BUDGET
        with self.store.guard.cached_listings():  # the hits share directories
            for path, size, mtime_ns, score in rows:
                hit = self._hit(path, (size, mtime_ns), score, needles, q, deadline)  # one text at a time
                if hit is not None:
                    out["content"].append(hit)
        return out

    def _hit(self, path: str, sig: tuple[int, int], score: float, needles: list[str], q: str,
             deadline: float) -> dict | None:
        e = self.store.get(path)
        if e is None:
            return None
        body, now = self._snippet_text(e, deadline)
        # changed since indexed (on disk, maybe not yet seen by the watcher): its reindex is on the way
        stale = e.sig != sig or now != sig
        if body is None or (body is _NO_TIME and stale):
            return None  # gone, unreadable or changed
        if body is _NO_TIME:
            matches, count = [], 0  # a .docx past the snippet budget: listed without lines
        else:
            matches, count = match_lines(body, needles, q.split())
            if stale and not count:
                return None
        return {"path": path, "kind": e.kind, "score": -score, "matches": matches, "match_count": count}

    def complete(self, prefix: str, path: str = "", limit: int = MAX_COMPLETE) -> dict:
        """Identifiers of the indexed code files that start with `prefix` (any case), for editor
        completion: definitions first, then names used in files of the same language as `path`,
        in its folder, in its top folder, then the most used. `path` only ranks (it is never read).
        {"names": [{name, def, files}], "capped": the prefix has more rows than one query reads
        (a longer prefix may find names left out here)}. Empty while there is no index yet, or
        when the query fails."""
        empty = {"names": [], "capped": False}
        limit = max(1, min(int(limit or MAX_COMPLETE), MAX_COMPLETE))
        lp = prefix.lower()
        if not lp or len(lp) > NAME_MAX:
            return empty
        rel = check_rel(path, self.store.guard.rel_hidden) if path else None
        exts, d, top = ["\0"], "\0", "\0"  # nothing matches the placeholders (not even ext '')
        if rel is not None:
            ext = ext_of(rel.rsplit("/", 1)[-1])
            if ext:
                exts = family_exts(ext)
            if "/" in rel:
                d, top = rel.rsplit("/", 1)[0] + "/", rel.split("/", 1)[0] + "/"
        # prefix ranges, no table scan: the names in the prefix range (words_name), their
        # definitions, then their other uses (the uses key), at most COMPLETE_SCAN rows each;
        # the window sums say whether either hit its cap
        sql = ("SELECT x.name, max(x.def), count(*), sum(x.n),"
               f" max(f.ext IN ({','.join('?' * len(exts))})), max(substr(f.path, 1, ?) = ?),"
               " max(substr(f.path, 1, ?) = ?),"
               " sum(sum(x.def)) OVER (), sum(count(*) - sum(x.def)) OVER ()"
               " FROM (SELECT * FROM (SELECT w.id, w.name, u.file_id, u.def, u.n FROM words w CROSS JOIN uses u"
               "  ON u.word_id = w.id AND u.def = 1 WHERE w.name >= ? AND w.name < ? LIMIT ?)"
               " UNION ALL SELECT * FROM (SELECT w.id, w.name, u.file_id, u.def, u.n FROM words w CROSS JOIN uses u"
               "  ON u.word_id = w.id AND u.def = 0 WHERE w.name >= ? AND w.name < ? LIMIT ?)) x"
               " JOIN files f ON f.id = x.file_id GROUP BY x.id"
               " ORDER BY 2 DESC, 5 DESC, 6 DESC, 7 DESC, 4 DESC, length(x.name), x.name COLLATE BINARY LIMIT ?")
        hi = lp + "\U0010ffff"
        args = [*exts, len(d), d, len(top), top, lp, hi, COMPLETE_SCAN, lp, hi, COMPLETE_SCAN, limit]
        gen = self._gen
        try:
            with self._lock:
                if self._db is None:
                    return empty
                rows = self._db.execute(sql, args).fetchall()
        except sqlite3.OperationalError:  # busy
            return empty
        except sqlite3.DatabaseError:
            log.exception("search index broken; rebuilding")
            self._broken(gen)
            return empty
        capped = bool(rows) and max(rows[0][7], rows[0][8]) >= COMPLETE_SCAN
        return {"names": [{"name": n, "def": bool(isdef), "files": files} for n, isdef, files, *_ in rows],
                "capped": capped}
