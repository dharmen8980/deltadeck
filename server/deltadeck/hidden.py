"""Hidden files: what git ignores below the root, the topmost hidden items of the tree
(HiddenEntry, listed by the Hidden files dialog), the lazy listing of one hidden folder
(/api/hidden) and bounded file counts below hidden items (/api/hiding/count).

Every path gets one verdict (PathGuard.classify): visible, partial (a folder an ignore-list entry
or git would hide, kept visible because it holds a tracked or shown path; its other children stay
hidden) or hidden. A hidden item has a reason: "deny" (the deny list: protected, shown read-only on
request only), "ignore" (the viewer's ignore list), "user" (a pattern or a per-path hide choice of
this folder, hiding.py) or "git" (git ignores it and does not track it; only while the folder hides
git-ignored files). Hidden folders are never walked, stat'ed or indexed; their children are listed
only when asked for. `.git`, `.deltadeck-tmp-*` and the data dir are never listed ("never")."""

from __future__ import annotations

import logging
import os
import stat as stat_mod
import threading
import time
import unicodedata
from dataclasses import dataclass
from typing import Callable

from .git import GitError, GitRepo
from .paths import DENIED, PathError, PathGuard, Verdict, ext_of, fold_rel, kind_of

log = logging.getLogger("deltadeck")

IGNORED_TIMEOUT = 10.0  # full query
SCOPED_TIMEOUT = 5.0  # query for new paths
SCOPED_MAX = 200  # more new scopes than this: one full query instead
HIDDEN_LIST_MAX = 2000  # entries of one /api/hidden listing
LISTING_EVERY_S = 5.0  # refresh_for_listing asks git at most this often
COUNT_CAP = 10_000  # files counted below one hidden item ("10,000+")
COUNT_BUDGET_ENTRIES = 100_000  # directory entries one /api/hiding/count request may read
COUNT_BUDGET_S = 1.5


@dataclass(frozen=True)
class HiddenEntry:
    path: str
    name: str
    dir: bool
    reason: str
    rule: str | None = None  # the user pattern or ignore entry hiding this very item
    extra: bool = False  # rule is an --ignore pattern
    choice: str | None = None  # "hide": the folder's per-path choice hides it

    def to_json(self) -> dict:
        out = {"path": self.path, "name": self.name, "dir": self.dir, "reason": self.reason}
        if self.rule is not None:
            out["rule"] = self.rule
        if self.extra:
            out["extra"] = True
        if self.choice is not None:
            out["choice"] = self.choice
        if not self.dir:
            out["kind"] = kind_of(self.name)
            out["ext"] = ext_of(self.name)
        return out


def _nfc(rel: str) -> str:
    return rel if rel.isascii() else unicodedata.normalize("NFC", rel)


class GitIgnored:
    """Paths git ignores below the root (root-relative, NFC, topmost only; a directory stands for
    everything below it): the last known answer. Kept up to date whether or not they are hidden
    (Hidden files lists them, the tree dims the visible ones): at startup, at each backstop pass,
    on a .gitignore change and for new paths. enabled is the folder's hide_git: only then does the
    store hide them (the default shows them). Empty when git is off or missing, the query failed
    or timed out, or the root itself is ignored."""

    def __init__(self, repo_fn: Callable[[], GitRepo | None], guard: PathGuard | None = None, *,
                 enabled: bool = False):
        self.repo_fn = repo_fn  # GitLink.repo: never raises
        self.guard = guard
        self.enabled = enabled
        self.paths: frozenset[str] = frozenset()  # swapped whole: readers need no lock
        self._lock = threading.Lock()  # one git query at a time (held while git runs)
        self._state_lock = threading.Lock()  # enabled flips: never held while git runs
        self._failing = False
        self._root_ignored = False
        self._listed_at: float | None = None  # monotonic time of the last query (refresh_for_listing)

    # --- lookups ------------------------------------------------------------
    def contains(self, rel: str) -> bool:
        """rel itself is ignored (the walker: its ancestors were pruned already)."""
        paths = self.paths
        return bool(paths) and _nfc(rel) in paths

    def covers(self, rel: str) -> bool:
        """rel or one of its ancestors is ignored."""
        paths = self.paths
        if not paths or not rel:
            return False
        rel = _nfc(rel)
        if rel in paths:
            return True
        i = rel.find("/")
        while i != -1:
            if rel[:i] in paths:
                return True
            i = rel.find("/", i + 1)
        return False

    def is_rule_path(self, rel: str) -> bool:
        """A file whose change may change what git ignores."""
        if rel.rpartition("/")[2] == ".gitignore":
            return True
        if rel == ".git/info/exclude":
            repo = self.repo_fn()
            return repo is not None and repo.prefix == ""
        return False

    # --- queries ------------------------------------------------------------
    def _query(self, repo: GitRepo, specs: list[str], timeout: float) -> set[str] | None:
        """Root-relative ignored paths for these pathspecs; None if the root itself is ignored."""
        out = repo.run(["--literal-pathspecs", "ls-files", "-z", "--others", "--ignored", "--exclude-standard",
                        "--directory", "--", *specs], timeout=timeout)
        prefix = repo.prefix
        listed = {os.fsdecode(raw) for raw in out.split(b"\0") if raw}
        # A folder git lists together with files below it is not ignored itself (git does that
        # for a folder whose untracked files are all ignored): only those files are.
        has_below: set[str] = set()
        for p in listed:
            i = p.find("/")
            while 0 <= i < len(p) - 1:
                has_below.add(p[:i + 1])
                i = p.find("/", i + 1)
        found: set[str] = set()
        for p in listed:
            if p in has_below:
                continue
            if prefix and prefix.startswith(p if p.endswith("/") else p + "/"):
                return None  # the root or one of its ancestors is ignored
            if not p.startswith(prefix):
                continue
            rel = _nfc(p[len(prefix):].rstrip("/"))
            if not rel or any(c in ("", ".", "..") for c in rel.split("/")):
                continue
            if self.guard is not None and any(self.guard.is_always_hidden(c) for c in rel.split("/")):
                continue
            found.add(rel)
        return {p for p in found if not _below_any(p, found)}

    def _failed(self, e: Exception) -> None:
        if not self._failing:
            log.warning("git: could not list ignored files (%s); showing them until the next try", e)
        self._failing = True

    def refresh(self) -> set[str]:
        """Full query; swaps self.paths. Returns the paths that became or stopped being ignored
        (while enabled they need a rescan; either way the tree's dimmed items change)."""
        with self._lock:
            return self._refresh_locked()

    def _refresh_locked(self) -> set[str]:
        self._listed_at = time.monotonic()
        repo = self.repo_fn()
        if repo is None:
            return set()
        specs = [repo.prefix.rstrip("/")] if repo.prefix else []
        try:
            found = self._query(repo, specs, IGNORED_TIMEOUT)
        except (GitError, OSError) as e:
            self._failed(e)
            return set()
        self._failing = False
        if found is None:
            if not self._root_ignored:
                log.info("git: the folder itself is ignored by git; git hides nothing in it")
            self._root_ignored = True
            found = set()
        else:
            self._root_ignored = False
        new = frozenset(found)
        changed = set(new ^ self.paths)
        self.paths = new
        return changed

    def refresh_for_listing(self, force: bool = False) -> set[str]:
        """The Hidden files dialog: a full query (like refresh), at most once per LISTING_EVERY_S
        unless forced. Returns the changed paths."""
        with self._lock:
            last = self._listed_at
            if not force and last is not None and time.monotonic() - last < LISTING_EVERY_S:
                return set()
            return self._refresh_locked()

    def set_enabled(self, on: bool, refresh: bool = True) -> set[str]:
        """Turn git hiding on (asks git unless refresh=False: the caller just did) or off (the
        paths are kept for listing); returns the paths that became or stopped being hidden. Does
        not wait for a git query running meanwhile unless it asks git itself (an update must not)."""
        with self._state_lock:
            if on == self.enabled:
                return set()
            self.enabled = on
            old = self.paths
            if not on or not refresh:
                return set(old)
        with self._lock:
            self._refresh_locked()
        return set(old | self.paths)

    def refresh_paths(self, rels) -> None:
        """Scoped query for paths not seen yet (a new folder is classified before it is walked)."""
        rels = [r for r in rels if r]
        if not rels:
            return
        with self._lock:
            if self._root_ignored:
                return
            repo = self.repo_fn()
            if repo is None:
                return
            try:
                found = self._query(repo, [repo.prefix + r for r in rels], SCOPED_TIMEOUT)
            except (GitError, OSError) as e:
                self._failed(e)
                return
            if found is None:
                return
            queried = [_nfc(r) for r in rels]
            keep = {p for p in self.paths if not any(p == q or p.startswith(q + "/") for q in queried)}
            keep |= found
            self.paths = frozenset(p for p in keep if not _below_any(p, keep))


def _below_any(p: str, paths) -> bool:
    i = p.find("/")
    while i != -1:
        if p[:i] in paths:
            return True
        i = p.find("/", i + 1)
    return False


def list_hidden_dir(store, guard: PathGuard, rel: str | None, *, include_denied: bool) -> dict:
    """The /api/hidden body: the direct children of one hidden folder, dirs first, then files.
    Each child is judged as if its folder were partial (deny > its own choice > its own ignore
    entry > a user pattern > the folder's reason); rule is left out when it is the folder's."""
    r = guard.resolve(rel, allow="denied" if include_denied else "ignored")
    try:
        lst = os.lstat(r.abs)
    except OSError:
        raise PathError(404, "not found")
    if stat_mod.S_ISLNK(lst.st_mode) or not stat_mod.S_ISDIR(lst.st_mode):
        raise PathError(400, "not a directory")
    v = store.verdict(r.rel)
    if v.kind != "hidden":
        raise PathError(400, "not a hidden folder")
    reason, rule = v.reason, v.rule
    inherited = (reason, rule)
    git = store.git_fn()
    rules = guard.rules
    fparent = fold_rel(r.rel)
    found: list[tuple] = []  # (is file, folded name, name, verdict, path, is symlink)
    try:
        it = os.scandir(r.abs)
    except OSError:
        raise PathError(404, "not found")
    with it:
        for de in it:
            name = de.name
            if guard.excluded and guard.is_excluded(de.path):
                continue
            child = f"{r.rel}/{name}"
            cv = guard.classify(child, name, inherited, git, rules=rules, fparent=fparent)
            if cv.kind == "never":
                continue
            if reason == "deny" and cv.reason != "deny":
                cv = DENIED  # everything in a protected folder is protected
            elif cv.kind != "hidden":
                cv = Verdict("hidden", reason, rule, cv.choice)  # shown or kept: still inside a hidden folder
            if cv.reason == "deny" and not include_denied:
                continue
            try:
                is_dir, is_link = de.is_dir(), de.is_symlink()
            except OSError:
                continue
            if is_dir and is_link:
                continue  # symlinked directories are never descended
            found.append((not is_dir, name.casefold(), name, cv, de.path, is_link))
    found.sort(key=lambda t: t[:3])
    entries: list[dict] = []
    truncated = False
    for is_file, _, name, cv, path, is_link in found:
        if len(entries) >= HIDDEN_LIST_MAX:
            truncated = True
            break
        crule = None if (cv.reason, cv.rule) == inherited else cv.rule
        extra = cv.reason == "ignore" and guard.is_extra(crule)
        e = HiddenEntry(f"{r.rel}/{name}", name, not is_file, cv.reason, crule, extra, cv.choice).to_json()
        if is_file:
            if is_link:
                st = guard.file_ok(path)
            else:
                try:
                    st = os.lstat(path)
                except OSError:
                    st = None
                if st is not None and not stat_mod.S_ISREG(st.st_mode):
                    st = None
            if st is None:
                continue
            e["size"] = st.st_size
            e["mtime"] = st.st_mtime_ns / 1e9
        entries.append(e)
    return {"path": r.rel, "reason": reason, "truncated": truncated, "entries": entries}


def count_files(guard: PathGuard, paths, *, reveal: bool) -> dict:
    """The /api/hiding/count body: regular files and file symlinks below each path (1 for a file),
    up to COUNT_CAP ("more"). Symlinked folders are not followed; .git, temp files and the data
    dir are not counted, denied names neither without reveal. The request reads at most
    COUNT_BUDGET_ENTRIES directory entries or runs COUNT_BUDGET_S: paths not finished by then
    are null (ask again). Missing or refused paths are left out."""
    counts: dict[str, dict | None] = {}
    budget = COUNT_BUDGET_ENTRIES
    deadline = time.monotonic() + COUNT_BUDGET_S
    out_of_budget = False
    for rel in paths:
        if rel in counts:
            continue
        try:
            r = guard.resolve(rel, allow="denied" if reveal else "ignored")
            lst = os.lstat(r.abs)
        except (PathError, OSError):
            continue
        if not stat_mod.S_ISDIR(lst.st_mode):
            if stat_mod.S_ISREG(lst.st_mode) or stat_mod.S_ISLNK(lst.st_mode):
                counts[rel] = {"files": 1, "more": False}
            continue
        if out_of_budget:
            counts[rel] = None
            continue
        files = 0
        more = False
        stack = [r.abs]
        while stack and not more:
            d = stack.pop()
            try:
                it = os.scandir(d)
            except OSError:
                continue
            with it:
                for de in it:
                    budget -= 1
                    if budget < 0 or (budget % 1000 == 0 and time.monotonic() > deadline):
                        out_of_budget = True
                        break
                    name = de.name
                    if guard.is_always_hidden(name) or (not reveal and guard.is_denied(name)):
                        continue
                    if guard.excluded and guard.is_excluded(de.path):
                        continue
                    try:
                        if de.is_dir(follow_symlinks=False):
                            stack.append(de.path)
                        elif de.is_file(follow_symlinks=False) or (de.is_symlink() and de.is_file()):
                            files += 1
                            if files > COUNT_CAP:
                                more = True
                                break
                    except OSError:
                        continue
            if out_of_budget:
                break
        if out_of_budget and not more:
            counts[rel] = None
        else:
            counts[rel] = {"files": min(files, COUNT_CAP), "more": more}
    return {"counts": counts}
