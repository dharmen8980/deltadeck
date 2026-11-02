"""Hidden files: what git ignores below the root, the hidden items the tree lists with
"Show hidden files" (HiddenEntry) and the lazy listing of one hidden folder (/api/hidden).

A hidden item has a reason: "deny" (the deny list: protected, shown read-only on request only),
"ignore" (the viewer's ignore list) or "git" (git ignores it and does not track it). Hidden
folders are never walked, stat'ed or indexed; their children are listed only when asked for.
`.git`, `.ldv-tmp-*` and the data dir are never listed (PathGuard.name_reason "always")."""

from __future__ import annotations

import logging
import os
import stat as stat_mod
import threading
import unicodedata
from dataclasses import dataclass
from typing import Callable

from .git import GitError, GitRepo
from .paths import PathError, PathGuard, ext_of, kind_of

log = logging.getLogger("viewer")

IGNORED_TIMEOUT = 10.0  # full query
SCOPED_TIMEOUT = 5.0  # query for new paths
SCOPED_MAX = 200  # more new scopes than this: one full query instead
HIDDEN_LIST_MAX = 2000  # entries of one /api/hidden listing


@dataclass(frozen=True)
class HiddenEntry:
    path: str
    name: str
    dir: bool
    reason: str

    def to_json(self) -> dict:
        out = {"path": self.path, "name": self.name, "dir": self.dir, "reason": self.reason}
        if not self.dir:
            out["kind"] = kind_of(self.name)
            out["ext"] = ext_of(self.name)
        return out


def _nfc(rel: str) -> str:
    return rel if rel.isascii() else unicodedata.normalize("NFC", rel)


class GitIgnored:
    """Paths git ignores below the root (root-relative, NFC; a directory stands for everything
    below it). Empty (nothing hidden) while git is off or missing, the query failed or timed out,
    or the root itself is ignored."""

    def __init__(self, repo_fn: Callable[[], GitRepo | None], guard: PathGuard | None = None):
        self.repo_fn = repo_fn  # GitLink.repo: never raises
        self.guard = guard
        self.paths: frozenset[str] = frozenset()  # swapped whole: readers need no lock
        self._lock = threading.Lock()
        self._failing = False
        self._root_ignored = False

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
        """Full query; swaps self.paths. Returns the paths that became or stopped being ignored."""
        with self._lock:
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
    """The /api/hidden body: the direct children of one hidden folder, dirs first, then files."""
    r = guard.resolve(rel, allow="denied" if include_denied else "ignored")
    try:
        lst = os.lstat(r.abs)
    except OSError:
        raise PathError(404, "not found")
    if stat_mod.S_ISLNK(lst.st_mode) or not stat_mod.S_ISDIR(lst.st_mode):
        raise PathError(400, "not a directory")
    reason = store.hidden_reason(r.rel)
    if reason is None:
        raise PathError(400, "not a hidden folder")
    found: list[tuple] = []  # (is file, folded name, name, reason, path, is symlink)
    try:
        it = os.scandir(r.abs)
    except OSError:
        raise PathError(404, "not found")
    with it:
        for de in it:
            name = de.name
            nr = guard.name_reason(name)
            if nr == "always" or (guard.excluded and guard.is_excluded(de.path)):
                continue
            child = "deny" if reason == "deny" or nr == "deny" else "ignore" if nr == "ignore" else reason
            if child == "deny" and not include_denied:
                continue
            try:
                is_dir, is_link = de.is_dir(), de.is_symlink()
            except OSError:
                continue
            if is_dir and is_link:
                continue  # symlinked directories are never descended
            found.append((not is_dir, name.casefold(), name, child, de.path, is_link))
    found.sort()
    entries: list[dict] = []
    truncated = False
    for is_file, _, name, child, path, is_link in found:
        if len(entries) >= HIDDEN_LIST_MAX:
            truncated = True
            break
        e = HiddenEntry(f"{r.rel}/{name}", name, not is_file, child).to_json()
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
