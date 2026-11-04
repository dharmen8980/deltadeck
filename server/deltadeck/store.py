"""In-memory tree of the root, rename inference, pub/sub, and the directory / full backstop passes
that deltadeck.reconcile schedules (the watcher and the Reconciler live there).

A directory pass stats only the known directories and re-lists those whose (mtime, ctime, inode)
changed: that catches entries created, deleted or renamed anywhere, not a file edited in place (a
write leaves its directory alone). A full pass stats every file, for edits the watcher missed
(network volumes, a dead watcher). Both walk the disk without holding the scan lock, then rescan
under it only what differs.
"""

from __future__ import annotations

import asyncio
import logging
import os
import posixpath
import stat as stat_mod
import threading
import time
from dataclasses import dataclass, field

from .hidden import SCOPED_MAX, GitIgnored, HiddenEntry
from .paths import PathGuard, Verdict, ext_of, fold, fold_rel, kind_of

log = logging.getLogger("deltadeck.store")

RACY_NS = 3_000_000_000  # a directory modified this recently may change again within its mtime tick
FUTURE_SKEW_NS = 60_000_000_000  # dated further ahead than this (a server clock ahead): trusted anyway
PACE_EVERY = 512  # backstop passes sleep briefly every this many stats, so they never hog a core
PACE_SLEEP_S = 0.002
_INSIDE = ("inside",)  # Store._ctx: the folder lies inside a hidden one (or is hidden itself)


def _dir_sig(st: os.stat_result, now_ns: int) -> tuple[int, int, int] | None:
    """What a directory pass compares: (mtime, ctime, inode). ctime cannot be set back by tools that
    restore mtimes (tar, rsync -t). None (always re-list) while the directory is too fresh to trust:
    a change within the same mtime tick would not show (FAT has 2 s ticks). A directory dated more
    than FUTURE_SKEW_NS ahead (a file server whose clock runs ahead) is trusted, or it would be
    re-listed on every pass until the local clock caught up; its next change still moves its mtime."""
    age = now_ns - max(st.st_mtime_ns, st.st_ctime_ns)
    if -FUTURE_SKEW_NS < age < RACY_NS:
        return None
    return (st.st_mtime_ns, st.st_ctime_ns, st.st_ino)


class Cancelled(Exception):
    """A backstop pass was stopped (shutdown or folder switch) before it finished."""


def _pacer(every: int = PACE_EVERY, pause: float = PACE_SLEEP_S, cancel: threading.Event | None = None):
    """Called once per stat by a backstop pass: sleeps `pause` every `every` calls, and raises
    Cancelled once `cancel` is set."""
    n = 0

    def tick() -> None:
        nonlocal n
        n += 1
        if n % 64 == 0 and cancel is not None and cancel.is_set():
            raise Cancelled
        if pause and n % every == 0:
            time.sleep(pause)

    return tick


@dataclass(frozen=True)
class Entry:
    path: str
    name: str
    size: int
    mtime_ns: int
    kind: str
    ext: str

    @property
    def sig(self) -> tuple[int, int]:
        return (self.size, self.mtime_ns)

    def to_json(self) -> dict:
        return {
            "path": self.path, "name": self.name, "size": self.size,
            "mtime": self.mtime_ns / 1e9, "kind": self.kind, "ext": self.ext,
        }


@dataclass
class Change:
    version: int = 0
    added: list[str] = field(default_factory=list)
    modified: list[str] = field(default_factory=list)
    deleted: list[str] = field(default_factory=list)
    renames: list[dict] = field(default_factory=list)
    dirs_changed: bool = False
    hidden_changed: bool = False  # the topmost hidden items (Store.hidden, the Hidden files dialog) changed
    ignored_changed: bool = False  # which visible items git ignores (the tree's dimmed ones) changed

    def empty(self) -> bool:
        return not (self.added or self.modified or self.deleted or self.renames or self.dirs_changed
                    or self.hidden_changed or self.ignored_changed)

    def to_json(self) -> dict:
        return {
            "version": self.version, "added": self.added, "modified": self.modified,
            "deleted": self.deleted, "renames": self.renames, "dirs_changed": self.dirs_changed,
            "hidden_changed": self.hidden_changed, "ignored_changed": self.ignored_changed,
        }


def _under(path: str, scope: str) -> bool:
    return scope == "" or path == scope or path.startswith(scope + "/")


def _scope_test(scopes):
    """p -> is p one of scopes or below one: O(depth) per path, however many scopes."""
    if "" in scopes:
        return lambda p: True
    if len(scopes) <= 4:
        return lambda p: any(_under(p, s) for s in scopes)
    ss = set(scopes)

    def test(p: str) -> bool:
        if p in ss:
            return True
        i = p.find("/")
        while i != -1:
            if p[:i] in ss:
                return True
            i = p.find("/", i + 1)
        return False

    return test


def minimal_scopes(scopes) -> list[str]:
    """Drop scopes covered by an ancestor scope."""
    out: list[str] = []
    for s in sorted(set(scopes)):
        if out and _under(s, out[-1]):
            continue
        out.append(s)
    return out


STREAM_CLOSED = ("__closed__", None)  # queued by close_streams: the SSE generator ends


class Store:
    def __init__(self, guard: PathGuard, ignored: GitIgnored | None = None):
        self.guard = guard
        self.root = guard.root
        self.ignored = ignored  # what git ignores (None: no git awareness, as in tests)
        self.hiding = None  # hiding.Hiding (set by the app): refresh_ignored refreshes its tracked keep set
        self.entries: dict[str, Entry] = {}
        self.dirs: set[str] = set()
        # the topmost hidden items of visible directories (never walked): path -> HiddenEntry
        self.hidden: dict[str, HiddenEntry] = {}
        self.version = 0
        self._state_lock = threading.Lock()
        self._scan_lock = threading.Lock()
        self._kind_cache: dict[tuple[str, int, int], str] = {}
        # in-root file symlinks: link rel path -> target rel path. The watcher only reports
        # the target when it changes, so rescans of a target scope also re-stat its links.
        self._links: dict[str, str] = {}
        # directory -> _dir_sig when last listed ('' = the root): what the directory pass compares
        self._dir_sigs: dict[str, tuple[int, int, int] | None] = {}
        self._subscribers: set[asyncio.Queue] = set()
        self._loop: asyncio.AbstractEventLoop | None = None
        self.on_subscribe = None  # callable: a live-update stream opened (the reconciler resumes)
        # hiding rules installed but not applied to the tree yet (begin_hiding, settle_hiding):
        # (the rules and git callback the tree was scanned with, paths git hiding changed) or None
        self._hiding_lock = threading.Lock()
        self._hiding_base: tuple | None = None

    # --- reading ----------------------------------------------------------
    def snapshot(self, denied: bool = True) -> dict:
        """The tree, with the number of topmost hidden items ("deny" ones only if denied). Visible
        files and folders git ignores (shown by default, or by a show choice) are marked: "ignored"
        on the file, and "ignored_dirs" (every such folder, also inside one)."""
        ig = self.ignored
        gi = ig.contains if ig is not None and ig.paths else None
        memo: dict[str, bool] = {"": False}

        def covered(d: str) -> bool:  # d or a folder above it is ignored (O(1) per folder, memoised)
            hit = memo.get(d)
            if hit is None:
                hit = memo[d] = gi(d) or covered(d.rpartition("/")[0])
            return hit

        with self._state_lock:
            files = []
            for p, e in sorted(self.entries.items()):
                j = e.to_json()
                if gi is not None and (gi(p) or covered(p.rpartition("/")[0])):
                    j["ignored"] = True
                files.append(j)
            dirs = sorted(self.dirs)
            n = len(self.hidden) if denied else sum(1 for h in self.hidden.values() if h.reason != "deny")
            version = self.version
        ignored_dirs = [d for d in dirs if covered(d)] if gi is not None else []
        return {"files": files, "dirs": dirs, "ignored_dirs": ignored_dirs, "version": version, "hidden_count": n}

    def git_fn(self):
        """The git callback of PathGuard.classify: what git ignores, only while the folder hides it."""
        ig = self.ignored
        return ig.contains if ig is not None and ig.enabled else None

    def verdict(self, rel: str) -> Verdict:
        return self.guard.verdict(rel, self.git_fn())

    def rel_hidden(self, rel: str) -> bool:
        """guard.rel_hidden, plus paths git ignores (while hidden)."""
        return self.verdict(rel).kind in ("never", "hidden")

    def hidden_reason(self, rel: str) -> str | None:
        """"always", "deny", "ignore", "user", "git" or None (visible, also a partial folder)."""
        v = self.verdict(rel)
        return "always" if v.kind == "never" else v.reason if v.kind == "hidden" else None

    def in_hidden_dir(self, rel: str) -> bool:
        """rel lies inside a hidden folder (events there are not processed)."""
        parent = rel.rpartition("/")[0]
        return bool(parent) and self.rel_hidden(parent)

    def refresh_ignored(self, force_tracked: bool = True, listing: bool = False, git: bool = True) -> Change | None:
        """Ask git again what it ignores (git=True; listing: throttled, for the Hidden files dialog)
        and which files it tracks in ignore-list folders (Hiding.refresh_tracked, throttled unless
        force_tracked); rescan the paths whose verdict changed (newly hidden files are reported
        deleted, newly visible ones added; ignored_changed: the dimmed items changed). git runs
        before the scan lock is taken: a slow query never blocks a hide or show."""
        ig, hiding = self.ignored, self.hiding
        if ig is None and hiding is None:
            return None
        gchanged = (ig.refresh_for_listing() if listing else ig.refresh()) if ig is not None and git else set()
        tracked = (hiding.refresh_tracked(force_tracked) or ()) if hiding is not None else ()
        if not gchanged and not tracked:
            return None
        with self._scan_lock:
            return self._apply_scopes_locked(list(tracked), refreshed=True, git_changed=gchanged)

    def _known(self, p: str) -> bool:
        return p in self.entries or p in self.dirs

    # --- verdicts ---------------------------------------------------------
    def _ctx(self, d: str, memo: dict, git, rules):
        """What d's children inherit: None (d is visible), (reason, rule) (d is partial) or _INSIDE
        (d is hidden or inside a hidden folder). Top-down from the nearest known ancestor; memo:
        per batch, keyed ("ctx", d) (also ("fr", d): the folded path)."""
        if not d:
            return None
        hit = memo.get(("ctx", d), False)
        if hit is not False:
            return hit
        comps = d.split("/")
        i = len(comps) - 1
        ctx = None
        while i > 0:
            h = memo.get(("ctx", "/".join(comps[:i])), False)
            if h is not False:
                ctx = h
                break
            i -= 1
        prefix = "/".join(comps[:i])
        guard = self.guard
        for c in comps[i:]:
            fparent = self._fold_of(prefix, memo)
            prefix = f"{prefix}/{c}" if prefix else c
            if ctx is not _INSIDE:
                v = guard.classify(prefix, c, ctx, git, rules=rules, fparent=fparent)
                ctx = _INSIDE if v.kind in ("never", "hidden") else (v.reason, v.rule) if v.kind == "partial" else None
            memo[("ctx", prefix)] = ctx
        return ctx

    @staticmethod
    def _fold_of(d: str, memo: dict) -> str:
        if not d:
            return ""
        key = ("fr", d)
        f = memo.get(key)
        if f is None:
            f = memo[key] = fold_rel(d)
        return f

    def _judge(self, rel: str, is_dir: bool, memo: dict, git, rules):
        """A comparable state of a known item: _INSIDE, the (kind, reason, rule, choice) of a
        hidden one, else what a folder's children inherit (None for files)."""
        parent, _, name = rel.rpartition("/")
        ctx = self._ctx(parent, memo, git, rules)
        if ctx is _INSIDE:
            return _INSIDE
        v = self.guard.classify(rel, name, ctx, git, rules=rules, fparent=self._fold_of(parent, memo))
        if v.kind in ("never", "hidden"):
            return v.kind, v.reason, v.rule, v.choice
        return (v.reason, v.rule) if is_dir and v.kind == "partial" else None

    def begin_hiding(self, swap) -> None:
        """Install new hiding rules (swap() -> the paths git hiding changed) without touching the
        tree: verdicts, reads and new scans follow them at once; settle_hiding brings the tree in
        line. Several installs before a settle are settled together (from the first one's rules)."""
        with self._hiding_lock:
            base = self._hiding_base
            if base is None:
                base = (self.guard.rules, self.git_fn(), set())
            base[2].update(swap() or ())
            self._hiding_base = base

    def hiding_pending(self) -> bool:
        return self._hiding_base is not None

    def known_count(self) -> int:
        """The items settle_hiding judges (its cost)."""
        return len(self.entries) + len(self.dirs) + len(self.hidden)

    def settle_hiding(self) -> Change | None:
        """Rescan what the rules installed by begin_hiding affect, under the scan lock (None if
        nothing is pending): every known item is judged with the rules the tree was scanned with
        and the current ones (O(known items)); newly hidden paths are reported deleted, newly
        visible ones added (their folders walked), a folder whose children inherit something else
        is rescanned, with hidden_changed."""
        with self._scan_lock:
            with self._hiding_lock:
                base, self._hiding_base = self._hiding_base, None
                new_rules, new_git = self.guard.rules, self.git_fn()
            if base is None:
                return None
            old_rules, old_git, cands = base
            with self._state_lock:
                known = [*((d, True) for d in self.dirs), *((p, False) for p in self.entries),
                         *((p, h.dir) for p, h in self.hidden.items())]
            m_old: dict = {}
            m_new: dict = {}
            for p, is_dir in known:
                if self._judge(p, is_dir, m_old, old_git, old_rules) != self._judge(p, is_dir, m_new, new_git, new_rules):
                    cands.add(p)
            if not cands:
                return None
            return self._apply_scopes_locked(minimal_scopes(cands), refreshed=True)

    def reapply_hiding(self, swap) -> Change | None:
        """begin_hiding + settle_hiding in one go."""
        self.begin_hiding(swap)
        return self.settle_hiding()

    def get(self, path: str) -> Entry | None:
        with self._state_lock:
            return self.entries.get(path)

    def all_entries(self) -> list[Entry]:
        with self._state_lock:
            return list(self.entries.values())

    # --- scanning ---------------------------------------------------------
    def _entry(self, rel: str, abs_path: str, st: os.stat_result) -> Entry:
        name = posixpath.basename(rel)
        key = (rel, st.st_size, st.st_mtime_ns)
        kind = self._kind_cache.get(key)
        if kind is None:
            kind = kind_of(name, abs_path)
            self._kind_cache[key] = kind
        return Entry(rel, name, st.st_size, st.st_mtime_ns, kind, ext_of(name))

    def _abs(self, rel: str) -> str:
        return os.path.join(self.root, *rel.split("/")) if rel else self.root

    def _walk(self, start_abs: str, start_rel: str, files: dict, dirs: set, links: dict, sigs: dict,
              pace=None, recursive: bool = True, hidden_out: dict | None = None, inherited=None) -> None:
        """Everything visible below start_abs (start_rel: its root-relative path, '' for the root;
        inherited: what it passes to its children, Store._ctx), judged by PathGuard.classify:
        files -> Entry, dirs, in-root file symlinks -> target, and each listed directory's _dir_sig
        (taken before listing it, so a change made while listing shows next time). Entries whose
        size and mtime did not change are reused. recursive=False: only start_abs's own entries
        (its subdirectories go to dirs, unlisted). hidden_out: the hidden items met (HiddenEntry;
        never descended nor stat'ed)."""
        guard = self.guard
        name_reason = guard.name_reason
        classify = guard.classify
        entries = self.entries
        gi = self.git_fn()
        rules = guard.rules
        user_rules = bool(rules.user.rules)
        choice_dirs = rules.choice_dirs
        folded = user_rules or bool(rules.show or rules.hide or rules.tracked)  # classify wants fold(drel)
        if hidden_out is None:
            hidden_out = {}
        now = time.time_ns()
        stack = [(start_abs, start_rel, inherited, fold_rel(start_rel) if folded and start_rel else "")]
        while stack:
            dabs, drel, inh, fdrel = stack.pop()
            try:
                st = os.lstat(dabs)
                it = os.scandir(dabs)
            except OSError:
                continue
            sigs[drel] = _dir_sig(st, now)
            prefix = drel + "/" if drel else ""
            plain = inh is None and not user_rules and not (choice_dirs and fdrel in choice_dirs)
            with it:
                for de in it:
                    name = de.name
                    rel = prefix + name
                    if plain and name_reason(name) is None and not (gi is not None and gi(rel)):
                        v = None  # visible: the walker's hot path
                    else:
                        v = classify(rel, name, inh, gi, rules=rules, fparent=fdrel if folded else None)
                        if v.kind == "never":
                            continue
                        if v.kind == "hidden":
                            if not de.is_symlink() and not (guard.excluded and guard.is_excluded(de.path)):
                                self._hide(hidden_out, rel, name, de, v)
                            continue
                    try:
                        is_dir = de.is_dir()
                    except OSError:
                        is_dir = False
                    if is_dir:
                        if de.is_symlink():
                            continue  # symlinked directories are never descended
                        if guard.excluded and guard.is_excluded(de.path):
                            continue
                        dirs.add(rel)
                        if recursive:
                            child = (v.reason, v.rule) if v is not None and v.kind == "partial" else None
                            fchild = (f"{fdrel}/{fold(name)}" if fdrel else fold(name)) if folded else ""
                            stack.append((de.path, rel, child, fchild))
                        continue
                    if de.is_symlink():
                        fst = guard.file_ok(de.path)
                        if fst is None:
                            continue
                        links[rel] = guard.rel_of(os.path.realpath(de.path))
                    else:
                        try:
                            fst = de.stat(follow_symlinks=False)
                        except OSError:
                            continue
                        if not stat_mod.S_ISREG(fst.st_mode):
                            continue
                    old = entries.get(rel)
                    if old is not None and old.size == fst.st_size and old.mtime_ns == fst.st_mtime_ns:
                        files[rel] = old
                    else:
                        files[rel] = self._entry(rel, de.path, fst)
                    if pace is not None:
                        pace()

    def _hide(self, out: dict, rel: str, name: str, de, v: Verdict) -> None:
        try:
            is_dir = de.is_dir(follow_symlinks=False)
            if not is_dir and not de.is_file(follow_symlinks=False):
                return  # a fifo, socket or device
        except OSError:
            return
        out[rel] = self._hidden_entry(rel, name, is_dir, v)

    def _hidden_entry(self, rel: str, name: str, is_dir: bool, v: Verdict) -> HiddenEntry:
        extra = v.reason == "ignore" and self.guard.is_extra(v.rule)
        return HiddenEntry(rel, name, is_dir, v.reason, v.rule, extra, v.choice)

    def _spelling(self, rel: str, memo: dict) -> str | None:
        """How rel is spelled on disk: rel itself, a variant (case, Unicode normalisation) if only
        that exists, or None. On a case-insensitive volume (APFS, HFS+) stat and lexists accept any
        spelling, so after a case-only rename (a.md -> A.md, Docs -> docs) the old spelling would
        look alive; each component must be an entry of its parent's listing. memo: per batch, so
        each directory is listed once."""
        if not rel:
            return ""
        hit = memo.get(rel, False)
        if hit is not False:
            return hit
        parent, _, name = rel.rpartition("/")
        real_parent = self._spelling(parent, memo) if parent else ""
        out = None
        if real_parent is not None:
            key = ("ls", real_parent)
            names = memo.get(key, False)
            if names is False:
                try:
                    names = set(os.listdir(self._abs(real_parent)))
                except OSError:
                    names = None
                memo[key] = names
            if names is not None:
                if name in names:
                    out = name
                else:
                    fkey = ("fold", real_parent)
                    folded = memo.get(fkey)
                    if folded is None:
                        folded = memo[fkey] = {}
                        for n in names:
                            folded.setdefault(fold(n), []).append(n)
                    cands = folded.get(fold(name), ())
                    out = cands[0] if len(cands) == 1 else None
            if out is not None and real_parent:
                out = real_parent + "/" + out
        memo[rel] = out
        return out

    def _scan_scope(self, scope: str, memo: dict | None = None):
        """Current on-disk state under scope as (files, dirs, links, dir sigs, hidden items), or
        None if the scope must be ignored (inside a hidden folder). A scope not spelled like its
        directory entry counts as gone. A hidden scope yields only its own hidden item. memo:
        shared by the scopes of one batch (listings, parent checks)."""
        files: dict[str, Entry] = {}
        dirs: set[str] = set()
        links: dict[str, str] = {}
        sigs: dict[str, tuple | None] = {}
        hidden_out: dict[str, HiddenEntry] = {}
        if scope:
            memo = {} if memo is None else memo
            guard = self.guard
            git, rules = self.git_fn(), guard.rules
            parent_rel, _, name = scope.rpartition("/")
            if any(c in ("", ".", "..") for c in scope.split("/")):
                return None
            inherited = self._ctx(parent_rel, memo, git, rules)
            if inherited is _INSIDE:
                return None
            abs_path = self._abs(scope)
            if guard.excluded and guard.is_excluded(abs_path):
                return None
            parent = os.path.dirname(abs_path)
            key = ("linked", parent)
            linked = memo.get(key)
            if linked is None:
                linked = memo[key] = os.path.lexists(parent) and os.path.realpath(parent) != parent
            if linked:
                return None  # inside a symlinked dir: never descended
            v = guard.classify(scope, name, inherited, git, rules=rules, fparent=self._fold_of(parent_rel, memo))
            if v.kind == "never":
                return None
            if self._spelling(scope, memo) != scope:
                return files, dirs, links, sigs, hidden_out  # gone, or only a differently spelled entry exists
            if v.kind == "hidden":
                try:
                    mode = os.lstat(abs_path).st_mode
                except OSError:
                    mode = 0
                if stat_mod.S_ISDIR(mode) or stat_mod.S_ISREG(mode):  # not a symlink
                    hidden_out[scope] = self._hidden_entry(scope, name, stat_mod.S_ISDIR(mode), v)
                return files, dirs, links, sigs, hidden_out
            if os.path.isdir(abs_path) and not os.path.islink(abs_path):
                dirs.add(scope)
                self._walk(abs_path, scope, files, dirs, links, sigs, hidden_out=hidden_out,
                           inherited=(v.reason, v.rule) if v.kind == "partial" else None)
            elif os.path.lexists(abs_path):
                st = guard.file_ok(abs_path)
                if st is not None:
                    files[scope] = self._entry(scope, abs_path, st)
                    if os.path.islink(abs_path):
                        links[scope] = guard.rel_of(os.path.realpath(abs_path))
            return files, dirs, links, sigs, hidden_out
        self._walk(self.root, "", files, dirs, links, sigs, hidden_out=hidden_out)
        return files, dirs, links, sigs, hidden_out

    def apply_scopes(self, scopes, renames=None) -> Change | None:
        """Rescan the given root-relative scopes ('' = everything), commit, return the diff.

        renames: optional known (from, to) moves (files or folder prefixes), used before the
        size/mtime inference so explicit moves are always reported as renames. New paths are put
        to git before the scan lock is taken."""
        scopes = list(scopes)
        changed = self._classify_new(scopes)
        with self._scan_lock:
            return self._apply_scopes_locked(scopes, renames, refreshed=True, git_changed=changed)

    def mutate(self, fn):
        """Run fn() -> (result, scopes, renames) while holding the scan lock (so the watcher and
        reconcile cannot observe a half-done mutation), then commit those scopes. Returns
        (result, Change | None). A later watcher rescan of the same paths finds no diff."""
        with self._scan_lock:
            result, scopes, renames = fn()
            ch = self._apply_scopes_locked(scopes, renames) if scopes else None
            return result, ch

    def _commit_sigs(self, sigs) -> None:
        """Record directory sigs (state lock held); only for directories still in the tree."""
        for d, sig in sigs.items():
            if d == "" or d in self.dirs:
                self._dir_sigs[d] = sig

    def _classify_new(self, scopes) -> set[str]:
        """Ask git about paths the tree has not seen yet, so a new ignored folder (a build's
        output) is hidden (or, while git-ignored files are shown, dimmed) before it is walked. A
        git failure just shows them. Returns the paths whose answer changed when more than
        SCOPED_MAX new paths made it one full query (else set())."""
        ig = self.ignored
        if ig is None:
            return set()
        reason = self.guard.name_reason
        unknown = [s for s in scopes if s and s not in self.entries and s not in self.dirs
                   and s not in self.hidden and reason(s.rpartition("/")[2]) is None and not self.in_hidden_dir(s)]
        if not unknown:
            return set()
        if len(unknown) > SCOPED_MAX:
            return ig.refresh()
        ig.refresh_paths(minimal_scopes(unknown))
        return set()

    def _apply_scopes_locked(self, scopes, renames=None, sigs=None, listed=None,
                             refreshed: bool = False, git_changed=()) -> Change | None:
        """sigs: directory sigs to record as well (a directory pass's re-listed directories), also
        when nothing changed. listed: (dirs, files, links, hidden) from a directory pass that listed
        those directories' own entries (not their subdirectories): their direct files and hidden
        items are replaced by these, as if each had been a scope. refreshed: git was just asked
        about every path (refresh_ignored); git_changed: the paths its answer changed for (while
        git-ignored files are hidden they are rescanned; a visible one changes the dimmed items)."""
        scopes = list(scopes)
        if not refreshed:
            git_changed = {*git_changed, *self._classify_new(scopes)}
        marks = False
        if git_changed:
            with self._state_lock:
                marks = any(self._known(p) for p in git_changed)
            ig = self.ignored
            if ig is not None and ig.enabled:
                scopes += git_changed
        ch = self._apply_scopes_inner(scopes, renames, sigs, listed)
        if not marks:
            return ch
        with self._state_lock:
            if ch is None:
                self.version += 1
                ch = Change(version=self.version)
            ch.ignored_changed = True
        return ch

    def _apply_scopes_inner(self, scopes, renames, sigs, listed) -> Change | None:
        if not scopes and not listed:
            if sigs:
                with self._state_lock:
                    self._commit_sigs(sigs)
            return None
        memo: dict = {}
        shallow: set[str] = set(listed[0]) if listed else set()
        with self._state_lock:
            if self._links:
                test = _scope_test(minimal_scopes(scopes))
                scopes += [link for link, target in self._links.items()
                           if test(target) or (shallow and posixpath.dirname(target) in shallow)]
        # a path reported in another spelling than its entry's (case-only rename): scan the entry too
        scopes += [sp for sc in scopes if sc and (sp := self._spelling(sc, memo)) is not None and sp != sc]
        scopes = minimal_scopes(scopes)
        new_files: dict[str, Entry] = dict(listed[1]) if listed else {}
        new_dirs: set[str] = set()
        new_links: dict[str, str] = dict(listed[2]) if listed else {}
        new_sigs: dict[str, tuple | None] = {}
        new_hidden: dict[str, HiddenEntry] = dict(listed[3]) if listed else {}
        used: list[str] = []
        checked: set[str] = set()
        for scope in scopes:
            res = self._scan_scope(scope, memo)
            if res is None:
                continue
            used.append(scope)
            new_files.update(res[0])
            new_dirs |= res[1]
            new_links.update(res[2])
            new_sigs.update(res[3])
            new_hidden.update(res[4])
            # make sure existing ancestor dirs are known (missed dir events)
            parent = posixpath.dirname(scope)
            while parent and parent not in checked:
                checked.add(parent)
                if self._spelling(parent, memo) == parent and os.path.isdir(self._abs(parent)):
                    new_dirs.add(parent)
                parent = posixpath.dirname(parent)
        if not used and not shallow:
            if sigs:
                with self._state_lock:
                    self._commit_sigs(sigs)
            return None
        test = _scope_test(used) if used else (lambda p: False)
        with self._state_lock:
            if shallow:
                old_files = {p: e for p, e in self.entries.items()
                             if test(p) or p.rpartition("/")[0] in shallow}
                old_dirs = {d for d in self.dirs if test(d)}
            elif "" in used or any(s in self.dirs for s in used):
                old_files = {p: e for p, e in self.entries.items() if test(p)}
                old_dirs = {d for d in self.dirs if test(d)}
            else:  # only file paths (or new names): nothing known lies below them
                old_files = {s: self.entries[s] for s in used if s in self.entries}
                old_dirs = set()
            ancestors = {d for d in new_dirs if not test(d)}
            old_hidden = {p: h for p, h in self.hidden.items()
                          if test(p) or (shallow and p.rpartition("/")[0] in shallow)}
            ch = Change()
            ch.hidden_changed = old_hidden != new_hidden
            deleted = [p for p in old_files if p not in new_files]
            added = [p for p in new_files if p not in old_files]
            ch.modified = sorted(p for p in new_files if p in old_files and old_files[p].sig != new_files[p].sig)
            # rename inference: same (size, mtime_ns, basename)
            pool: dict[tuple, list[str]] = {}
            for p in sorted(deleted):
                e = old_files[p]
                pool.setdefault((e.size, e.mtime_ns, e.name), []).append(p)
            renamed_from: set[str] = set()
            renamed_to: set[str] = set()
            added_set = set(added)
            for src_root, dst_root in renames or ():
                for p in sorted(deleted):
                    if p in renamed_from or not _under(p, src_root):
                        continue
                    q = dst_root + p[len(src_root):]
                    if q in renamed_to:
                        continue
                    if q in added_set:
                        ch.renames.append({"from": p, "to": q})
                        renamed_from.add(p)
                        renamed_to.add(q)
                    elif q in new_files and q in old_files:  # moved over an existing file
                        ch.renames.append({"from": p, "to": q})
                        renamed_from.add(p)
                        renamed_to.add(q)
                        if q in ch.modified:
                            ch.modified.remove(q)
            for p in sorted(added):
                if p in renamed_to:
                    continue
                e = new_files[p]
                key = (e.size, e.mtime_ns, e.name)
                cands = [c for c in pool.get(key, ()) if c not in renamed_from]
                if cands:
                    src = cands[0]
                    pool[key].remove(src)
                    ch.renames.append({"from": src, "to": p})
                    renamed_from.add(src)
                    renamed_to.add(p)
            # second pass: an in-place file rename keeps size, mtime_ns and
            # the parent dir but changes the basename. Only pair when the
            # (dir, size, mtime_ns) key is unambiguous on both sides.
            left_del: dict[tuple, list[str]] = {}
            for p in deleted:
                if p not in renamed_from:
                    e = old_files[p]
                    left_del.setdefault((posixpath.dirname(p), e.size, e.mtime_ns), []).append(p)
            left_add: dict[tuple, list[str]] = {}
            for p in added:
                if p not in renamed_to:
                    e = new_files[p]
                    left_add.setdefault((posixpath.dirname(p), e.size, e.mtime_ns), []).append(p)
            for key, dsts in sorted(left_add.items()):
                srcs = left_del.get(key)
                if srcs and len(srcs) == 1 and len(dsts) == 1:
                    ch.renames.append({"from": srcs[0], "to": dsts[0]})
                    renamed_from.add(srcs[0])
                    renamed_to.add(dsts[0])
            ch.added = sorted(p for p in added if p not in renamed_to)
            ch.deleted = sorted(p for p in deleted if p not in renamed_from)
            ch.dirs_changed = old_dirs != (new_dirs - ancestors) or not ancestors <= self.dirs
            if ch.empty():
                self._commit_sigs({**new_sigs, **(sigs or {})})
                return None
            for p in old_hidden:
                del self.hidden[p]
            self.hidden.update(new_hidden)
            for p in old_files:
                if p not in new_files:
                    del self.entries[p]
            self.entries.update(new_files)
            for p in old_files:
                self._links.pop(p, None)
            self._links.update(new_links)
            for d in old_dirs:
                self._dir_sigs.pop(d, None)
            self.dirs -= old_dirs
            self.dirs |= new_dirs
            self._commit_sigs({**new_sigs, **(sigs or {})})
            self.version += 1
            ch.version = self.version
            if len(self._kind_cache) > 20000:
                self._kind_cache.clear()
            return ch

    def full_scan(self) -> Change | None:
        """Rescan everything under the scan lock (startup)."""
        return self.apply_scopes([""])

    def quick_check(self, pace=None) -> Change | None:
        """Directory pass: stat every known directory (no lock held) and re-list, under the scan
        lock, those whose sig changed: their files are stat'ed again, new subdirectories scanned and
        vanished ones dropped. Catches entries created, deleted or renamed anywhere; not a file
        edited in place, which leaves its directory's mtime alone (the watcher or a full pass).
        None if nothing changed or the pass was cancelled (pace raised Cancelled)."""
        with self._state_lock:
            sigs = dict(self._dir_sigs)
            dirs = ["", *self.dirs]
        changed = []
        try:
            self._stat_dirs(dirs, sigs, changed, pace)
        except Cancelled:
            return None
        if not changed:
            return None
        with self._scan_lock:
            return self._relist_locked(changed)

    def _stat_dirs(self, dirs, sigs, changed, pace) -> None:
        for d in dirs:
            old = sigs.get(d)
            if old is None:
                changed.append(d)  # never listed, or too fresh to trust when it was
                continue
            try:
                st = os.lstat(self._abs(d))
            except OSError:
                changed.append(d)
                continue
            if not stat_mod.S_ISDIR(st.st_mode) or (st.st_mtime_ns, st.st_ctime_ns, st.st_ino) != old:
                changed.append(d)
            if pace is not None:
                pace()

    def _relist_locked(self, changed: list[str]) -> Change | None:
        """List each changed directory once (its own entries, with the walker's rules), compare
        its subdirectories with the known ones: new and vanished ones become scopes, the rest stay
        as they are; its files are replaced by the listing in one go."""
        with self._state_lock:
            known_dirs: dict[str, set[str]] = {}
            for d in self.dirs:
                known_dirs.setdefault(d.rpartition("/")[0], set()).add(d)
        memo: dict = {}
        scopes: list[str] = []
        listed: list[str] = []
        files: dict[str, Entry] = {}
        links: dict[str, str] = {}
        sigs: dict[str, tuple | None] = {}
        hidden: dict[str, HiddenEntry] = {}
        git, rules = self.git_fn(), self.guard.rules
        for d in changed:
            dabs = self._abs(d)
            try:
                st = os.lstat(dabs)
            except OSError:
                st = None
            if st is None or not stat_mod.S_ISDIR(st.st_mode) or self._spelling(d, memo) != d:
                scopes.append(d)  # gone, replaced by a file or renamed (case only): rescan it whole
                continue
            inherited = self._ctx(d, memo, git, rules)
            if inherited is _INSIDE:
                scopes.append(d)  # hidden now (rules changed meanwhile): rescan it whole
                continue
            subdirs: set[str] = set()
            self._walk(dabs, d, files, subdirs, links, sigs, recursive=False, hidden_out=hidden,
                       inherited=inherited)
            listed.append(d)
            scopes += subdirs ^ known_dirs.get(d, set())
        if not scopes and not listed:
            with self._state_lock:
                self._commit_sigs(sigs)
            return None
        return self._apply_scopes_locked(scopes, sigs=sigs, listed=(listed, files, links, hidden))

    def sweep(self, pace=None) -> Change | None:
        """Full pass: walk and stat the whole tree without holding the scan lock (paced), then
        rescan under the lock only the paths whose state differs from the tree, so a watcher batch
        or an edit is never blocked for the length of a walk. None if nothing changed or the pass
        was cancelled (pace raised Cancelled)."""
        files: dict[str, Entry] = {}
        dirs: set[str] = set()
        links: dict[str, str] = {}
        sigs: dict[str, tuple | None] = {}
        hidden: dict[str, HiddenEntry] = {}
        try:
            self._walk(self.root, "", files, dirs, links, sigs, pace=pace, hidden_out=hidden)
        except Cancelled:
            return None
        with self._state_lock:
            entries = self.entries
            cand = [p for p, e in files.items() if (o := entries.get(p)) is None or o.sig != e.sig]
            cand += [p for p in entries if p not in files]
            cand += [d for d in dirs if d not in self.dirs]
            cand += [d for d in self.dirs if d not in dirs]
            cand += [p for p, t in links.items() if self._links.get(p) != t]
            cand += [p for p, h in hidden.items() if self.hidden.get(p) != h]
            cand += [p for p in self.hidden if p not in hidden]
        del files
        with self._scan_lock:
            if cand:
                return self._apply_scopes_locked(cand, sigs=sigs)
            with self._state_lock:
                self._commit_sigs(sigs)
            return None

    def scopes_for_paths(self, abs_paths) -> list[str]:
        """Map watcher-reported absolute paths to root-relative scopes."""
        return [s for p in abs_paths if (s := self.scope_of(p)) is not None]

    def scope_of(self, abs_path: str) -> str | None:
        """The root-relative scope of one watcher-reported path ("" = unknown: rescan all)."""
        p = os.path.normpath(abs_path)
        if not self.guard.inside(p):
            # FSEvents may report a differently spelled prefix (/private/var vs /var)
            parent = os.path.dirname(p)
            alt = os.path.join(os.path.realpath(parent), os.path.basename(p)) if os.path.exists(parent) else p
            if not self.guard.inside(alt):
                return ""  # unknown: fall back to a full rescan
            p = alt
        rel = self.guard.rel_of(p)
        return None if rel.startswith("..") else rel

    # --- pub/sub ----------------------------------------------------------
    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=256)
        self._subscribers.add(q)
        if self.on_subscribe is not None:
            self.on_subscribe()
        return q

    def subscriber_count(self) -> int:
        return len(self._subscribers)

    def close_streams(self) -> None:
        """End every live-update stream (the app is shutting down); event loop thread only."""
        self._put(STREAM_CLOSED)

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.discard(q)

    def publish(self, change: Change) -> None:
        """Must be called on the event loop thread."""
        self._put(change.to_json())

    def publish_event(self, event: str, data: dict) -> None:
        """Another SSE event type on the same stream (e.g. "seen"); event loop thread only."""
        self._put((event, data))

    def _put(self, data) -> None:
        for q in list(self._subscribers):
            if q.full():
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            q.put_nowait(data)


# Moved to deltadeck.reconcile; still importable from here (tests, older callers).
_RECONCILE_NAMES = frozenset({
    "DEFAULT_RESCAN_S", "DEFAULT_FULL_RESCAN_S", "REMOTE_RESCAN_S", "REMOTE_FULL_RESCAN_S",
    "DEGRADED_RESCAN_S", "DEGRADED_FULL_RESCAN_S", "WAKE_CHECK_S", "WAKE_JUMP_S", "ACTIVE_WINDOW_S",
    "WATCH_SETTLE_S", "WATCH_RETRY_MAX_S", "WATCH_STEP_MS", "BIG_BATCH", "BIG_BATCH_DELAY_S",
    "BIG_BATCH_FULL_DELAY_S", "BIG_BATCH_FULL_GAP_S", "REMOTE_FS", "is_remote_fs", "mount_type",
    "backstop_intervals", "Reconciler", "_apply_batch", "watch_loop",
})


def __getattr__(name: str):
    if name in _RECONCILE_NAMES:  # lazy: deltadeck.reconcile imports this module
        from . import reconcile

        return getattr(reconcile, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
