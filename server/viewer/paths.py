"""Path safety (the single gate used by every endpoint), kind detection and the walker."""

from __future__ import annotations

import contextlib
import fnmatch
import mimetypes
import os
import posixpath
import re
import stat as stat_mod
import threading
from dataclasses import dataclass

from .config import Settings, canonical_path, fold, path_within  # fold: re-exported for store/edit
from .errors import HttpError

EXT_KINDS: dict[str, str] = {}
for _kind, _exts in {
    "markdown": "md markdown",
    "mermaid": "mmd mermaid",
    "image": "png jpg jpeg gif webp svg",
    "pdf": "pdf",
    "json": "json",
    "csv": "csv tsv",
    "xlsx": "xlsx",
    "docx": "docx",
    "code": "py pyi sh bash zsh js mjs cjs jsx ts mts cts tsx yaml yml toml sql ini cfg html htm css scss less "
            "java cs",
    "text": "log out txt jsonl ndjson",
}.items():
    for _e in _exts.split():
        EXT_KINDS[_e] = _kind

PATH_MAX = 4096  # longest stored root-relative path check_rel accepts

INLINE_MIME = {
    "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif",
    "webp": "image/webp", "svg": "image/svg+xml", "pdf": "application/pdf",
}


class PathError(HttpError):
    pass


def check_rel(rel: object, hidden) -> str | None:
    """Lexical path check for stored paths (the file may no longer exist: deleted or renamed).
    The path must be a normalised root-relative POSIX path with no denied/ignored component
    (`hidden(rel)`, PathGuard.rel_hidden). Returns the path, or None if it is refused."""
    if not isinstance(rel, str) or not rel or len(rel) > PATH_MAX or "\0" in rel or "\\" in rel:
        return None
    if rel.startswith("/") or os.path.isabs(rel) or posixpath.normpath(rel) != rel:
        return None
    if any(c in ("", ".", "..") for c in rel.split("/")):
        return None
    try:
        rel.encode("utf-8")
    except UnicodeEncodeError:  # lone surrogates
        return None
    if hidden(rel):
        return None
    return rel


@dataclass(frozen=True)
class Resolved:
    rel: str  # normalised POSIX path relative to root, as requested
    abs: str  # root-joined path (may be an in-root symlink)
    real: str  # realpath, guaranteed inside root


def ext_of(name: str) -> str:
    base = name.lstrip(".")
    return base.rsplit(".", 1)[1].lower() if "." in base else ""


def is_binary_file(path: str) -> bool:
    try:
        with open(path, "rb") as f:
            return b"\0" in f.read(8192)
    except OSError:
        return True


def is_dockerfile(name: str) -> bool:
    """"Dockerfile", "Dockerfile.dev", "app.dockerfile" (any case), like the UI's isDockerfile."""
    lower = name.lower()
    return lower == "dockerfile" or lower.startswith("dockerfile.") or lower.endswith(".dockerfile")


def kind_of(name: str, real_path: str | None = None) -> str:
    ext = ext_of(name)
    kind = EXT_KINDS.get(ext) if ext else None
    if kind:
        return kind  # a known extension wins: Dockerfile.md stays markdown
    if is_dockerfile(name) and (not ext or real_path is None or not is_binary_file(real_path)):
        return "code"  # bare "Dockerfile" skips the binary check, as before
    if not ext:
        return "text"
    if real_path is not None and is_binary_file(real_path):
        return "binary"
    return "text"


def mime_of(name: str, kind: str) -> str:
    ext = ext_of(name)
    if ext in INLINE_MIME:
        return INLINE_MIME[ext]
    if kind in ("markdown", "mermaid", "code", "text", "csv"):
        return {"markdown": "text/markdown", "csv": "text/csv"}.get(kind, "text/plain")
    if kind == "json":
        return "application/json"
    return mimetypes.guess_type(name)[0] or "application/octet-stream"


class PathGuard:
    def __init__(self, settings: Settings):
        self.root = settings.root
        self.deny = settings.deny
        self.ignore = settings.ignore
        # The recovery store (history/trash) is never browsable. Editing refuses to start when it
        # overlaps the root; in read-only mode an in-root data dir is simply hidden. The check is
        # by identity and by folded spelling, so 'ROOT/.data' or an NFD variant cannot slip by.
        dd = getattr(settings, "data_dir", None)
        self.excluded: tuple[str, ...] = ()
        self._excluded_fold: tuple[str, ...] = ()
        if dd and path_within(dd, self.root):
            cdd = canonical_path(dd)
            self.excluded = (cdd,)
            self._excluded_fold = (fold(cdd),)
        self._listings = threading.local()  # see cached_listings
        # every deny and ignore pattern as one regex: the tree walker tests each name once
        # (same result as is_hidden: fnmatchcase is re.match of fnmatch.translate)
        pats = tuple(self.deny) + tuple(self.ignore)
        self._hidden_rx = re.compile("|".join(f"(?:{fnmatch.translate(p)})" for p in pats)) if pats else None

    @contextlib.contextmanager
    def cached_listings(self):
        """Within the block (this thread only), disk_names lists each directory once. For batches
        such as git status, which resolve thousands of paths that share directories."""
        prev = getattr(self._listings, "dirs", None)
        if prev is None:
            self._listings.dirs = {}
        try:
            yield
        finally:
            self._listings.dirs = prev

    def _listdir(self, path: str) -> list[str]:
        cache = getattr(self._listings, "dirs", None)
        if cache is None:
            return os.listdir(path)
        entries = cache.get(path)
        if entries is None:
            entries = cache[path] = os.listdir(path)
        return entries

    @staticmethod
    def _is_within(child: str, parent: str) -> bool:
        try:
            return os.path.commonpath([child, parent]) == parent
        except ValueError:
            return False

    def _excluded_one(self, p: str) -> bool:
        if any(self._is_within(p, x) for x in self.excluded):
            return True
        fp = fold(p)
        if any(self._is_within(fp, x) for x in self._excluded_fold):
            return True
        # identity: the data dir (if it exists) is p or one of p's ancestors inside the root
        for x in self.excluded:
            try:
                xst = os.stat(x)
            except OSError:
                continue
            cur = p
            while self._is_within(cur, self.root) and cur != self.root:
                try:
                    if os.path.samestat(os.lstat(cur), xst):
                        return True
                except OSError:
                    pass
                cur = os.path.dirname(cur)
        return False

    def is_excluded(self, abs_path: str) -> bool:
        if not self.excluded:
            return False
        return self._excluded_one(abs_path) or self._excluded_one(os.path.realpath(abs_path))

    # --- name rules -------------------------------------------------------
    def _match(self, name: str, patterns: tuple[str, ...]) -> bool:
        low = fold(name)
        return any(fnmatch.fnmatchcase(low, p) for p in patterns)

    def is_denied(self, name: str) -> bool:
        return self._match(name, self.deny)

    def is_ignored(self, name: str) -> bool:
        return self._match(name, self.ignore)

    def is_hidden(self, name: str) -> bool:
        return self.is_denied(name) or self.is_ignored(name)

    def is_hidden_fast(self, name: str) -> bool:
        """is_hidden with one regex match (for the walker, which tests every name in the tree)."""
        return self._hidden_rx is not None and self._hidden_rx.match(fold(name)) is not None

    def rel_hidden(self, rel: str) -> bool:
        """True if any component of a root-relative POSIX path is denied/ignored."""
        return any(self.is_hidden_fast(c) for c in rel.split("/") if c and c not in (".", ".."))

    def disk_names(self, rel: str) -> list[str] | None:
        """Map each component of a root-relative path to the name(s) that really exist on disk.

        Returns one canonical name per component, or None if some component cannot be matched
        to a directory entry (or is ambiguous). Deny checks must run on these names, because a
        case/normalisation-insensitive filesystem may open 'secret.txt' for a request spelled
        differently (for example with U+017F)."""
        cur = self.root
        out: list[str] = []
        for c in rel.split("/"):
            if not c or c == ".":
                continue
            try:
                entries = self._listdir(cur)
            except OSError:
                return None
            if c in entries:
                name = c
            else:
                k = fold(c)
                cands = [e for e in entries if fold(e) == k]
                if len(cands) != 1:
                    return None
                name = cands[0]
            out.append(name)
            cur = os.path.join(cur, name)
        return out

    def disk_hidden(self, rel: str) -> bool:
        """True if the on-disk spelling of rel is hidden, or rel cannot be mapped to disk."""
        names = self.disk_names(rel)
        return names is None or any(self.is_hidden(n) for n in names)

    def inside(self, real: str) -> bool:
        try:
            return os.path.commonpath([self.root, real]) == self.root
        except ValueError:
            return False

    def rel_of(self, abs_path: str) -> str:
        rel = os.path.relpath(abs_path, self.root)
        return "" if rel == "." else rel.replace(os.sep, "/")

    # --- the gate ---------------------------------------------------------
    def resolve(self, rel: str | None) -> Resolved:
        if rel is None or rel.strip() == "":
            raise PathError(400, "path is required")
        if "\0" in rel:
            raise PathError(400, "invalid path")
        if rel.startswith("/") or rel.startswith("\\") or os.path.isabs(rel):
            raise PathError(403, "absolute paths are not allowed")
        if self.rel_hidden(rel):
            raise PathError(403, "path is not allowed")
        norm = posixpath.normpath(rel)
        if norm == "." or norm == ".." or norm.startswith("../"):
            raise PathError(403, "path is outside the root")
        joined = os.path.join(self.root, *norm.split("/"))
        real = os.path.realpath(joined)
        if not self.inside(real) or real == self.root:
            raise PathError(403, "path is outside the root")
        if self.excluded and (self.is_excluded(joined) or self.is_excluded(real)):
            raise PathError(403, "path is not allowed")
        if self.rel_hidden(self.rel_of(real)):
            raise PathError(403, "path is not allowed")
        # Never go through a symlinked directory (the walker never descends them).
        parent = os.path.dirname(joined)
        if os.path.realpath(parent) != parent:
            raise PathError(403, "path is not allowed")
        if not os.path.exists(real):
            raise PathError(404, "not found")
        # Check the names exactly as they exist on disk (requested path and resolved target).
        names = self.disk_names(norm)
        if names is None or any(self.is_hidden(n) for n in names):
            raise PathError(403, "path is not allowed")
        if self.disk_hidden(self.rel_of(real)):
            raise PathError(403, "path is not allowed")
        canon = "/".join(names)
        joined = os.path.join(self.root, *names)
        return Resolved(rel=canon, abs=joined, real=real)

    def resolve_file(self, rel: str | None) -> tuple[Resolved, os.stat_result]:
        r = self.resolve(rel)
        try:
            st = os.stat(r.real)
        except OSError:
            raise PathError(404, "not found")
        if not stat_mod.S_ISREG(st.st_mode):
            raise PathError(400, "not a regular file")
        return r, st

    # --- walker -----------------------------------------------------------
    def file_ok(self, abs_path: str) -> os.stat_result | None:
        """stat for a candidate file found by the walker, or None if it must be hidden."""
        try:
            lst = os.lstat(abs_path)
            if stat_mod.S_ISLNK(lst.st_mode):
                real = os.path.realpath(abs_path)
                if (not self.inside(real) or (self.excluded and self.is_excluded(real)) or self.rel_hidden(self.rel_of(real))
                        or self.disk_hidden(self.rel_of(real))):
                    return None
                st = os.stat(real)
            else:
                st = lst
        except OSError:
            return None
        return st if stat_mod.S_ISREG(st.st_mode) else None

    def walk(self, start_abs: str):
        """Yield ('dir', rel) and ('file', rel, abs, stat) under start_abs (exclusive)."""
        for dirpath, dirnames, filenames in os.walk(start_abs, followlinks=False):
            keep = []
            for d in dirnames:
                full = os.path.join(dirpath, d)
                if self.is_hidden(d) or os.path.islink(full) or (self.excluded and self.is_excluded(full)):
                    continue
                keep.append(d)
                yield ("dir", self.rel_of(full))
            dirnames[:] = keep
            for fn in filenames:
                if self.is_hidden(fn):
                    continue
                full = os.path.join(dirpath, fn)
                st = self.file_ok(full)
                if st is not None:
                    yield ("file", self.rel_of(full), full, st)
