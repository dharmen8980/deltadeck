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
from collections.abc import Callable, Container, Mapping
from dataclasses import dataclass

# fold: re-exported for store/edit
from .config import DEFAULT_DENY_EXCEPT, Settings, canonical_path, fold, path_within
from .errors import HttpError
from .hiding import EMPTY_RULES, UserRules

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
# never listed nor served in any mode (also when a user's ignore list lacks them); .ldv-tmp-*:
# leftover temporary files from the app's former name
ALWAYS_HIDDEN = (".git", ".deltadeck-tmp-*", ".ldv-tmp-*")

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


@dataclass(frozen=True)
class Verdict:
    """What one path is, after hiding.Hiding's rules (PathGuard.classify): "never" (.git, temp
    files, the data dir: never listed nor shown), "visible", "partial" (a folder or file a default
    hides, kept visible because git tracks something in it or a shown path lies below it; its
    children inherit (reason, rule)) or "hidden". reason: "deny" | "ignore" | "user" | "git";
    rule: the ignore entry or user pattern; choice: the per-path "show" or "hide" choice applied."""
    kind: str
    reason: str | None = None
    rule: str | None = None
    choice: str | None = None


NEVER = Verdict("never")
VISIBLE = Verdict("visible")
SHOWN = Verdict("visible", choice="show")
DENIED = Verdict("hidden", "deny")
HIDE_CHOICE = Verdict("hidden", "user", None, "hide")
_STOP = ("never", "hidden")


def fold_rel(rel: str) -> str:
    """A root-relative path folded component by component (how choices and kept paths are keyed)."""
    return fold(rel) if "/" not in rel else "/".join(fold(c) for c in rel.split("/"))


def ancestors(frel: str):
    """The proper ancestors of a (folded) root-relative path, nearest last ("a", "a/b" for a/b/c)."""
    i = frel.find("/")
    while i != -1:
        yield frel[:i]
        i = frel.find("/", i + 1)


@dataclass(frozen=True)
class _Rules:
    """The per-folder rules in effect; PathGuard swaps the whole object (one assignment), so
    concurrent readers always see one consistent set. Keys are fold_rel paths."""
    user: UserRules
    show: Mapping[str, str]  # "show" choices: folded path -> spelling
    hide: Mapping[str, str]  # "hide" choices
    show_keep: Container[str]  # ancestors of every show choice: lifts ignore-list and git defaults
    tracked: frozenset[str]  # hiding.tracked_keep: lifts built-in ignore entries only
    choice_dirs: Container[str]  # the parent of every choice ("" = the root): the walker's fast path


class PathGuard:
    def __init__(self, settings: Settings):
        self.root = settings.root
        self.deny = settings.deny
        self.deny_except: tuple[str, ...] = tuple(getattr(settings, "deny_except", DEFAULT_DENY_EXCEPT))
        # the built-in deny patterns (their exceptions, the .env templates, apply) and the rest
        self._deny_lifted, self._deny_strict = settings.deny_split()
        self.ignore: tuple[str, ...] = tuple(settings.ignore)  # built-in + --ignore, folded
        self.extra: tuple[str, ...] = tuple(getattr(settings, "ignore_extra", ()))  # --ignore
        self._extra_set = frozenset(self.extra)
        always = {fold(p) for p in ALWAYS_HIDDEN}
        self.builtin: tuple[str, ...] = tuple(dict.fromkeys(
            p for p in self.ignore if p not in self._extra_set and p not in always))
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
        # (same result as is_hidden: fnmatchcase is re.match of fnmatch.translate; the deny
        # exceptions are a lookahead in front of the built-in deny patterns)
        def alt(ps) -> str:
            return "|".join(f"(?:{fnmatch.translate(p)})" for p in ps)

        lifted = self._deny_lifted
        parts = [alt(list(self._deny_strict) + list(self.ignore) + list(ALWAYS_HIDDEN))]
        if lifted:
            parts.append(f"(?!{alt(self.deny_except)})(?:{alt(lifted)})")
        rx = "|".join(p for p in parts if p)
        self._hidden_rx = re.compile(rx) if rx else None
        self._rules = _Rules(EMPTY_RULES, {}, {}, frozenset(), frozenset(), frozenset())

    @property
    def rules(self) -> _Rules:
        return self._rules

    @property
    def user_rules(self) -> UserRules:
        return self._rules.user

    @property
    def tracked_keep(self) -> frozenset[str]:
        return self._rules.tracked

    @staticmethod
    def make_rules(user: UserRules, show: Mapping[str, str], hide: Mapping[str, str],
                   show_keep: Container[str] | None = None, tracked: frozenset[str] = frozenset(),
                   choice_dirs: Container[str] | None = None) -> _Rules:
        """A rule set (show and hide keyed by fold_rel). show_keep and choice_dirs are derived
        unless given (hiding.update passes live containers while it computes a change)."""
        if show_keep is None:
            show_keep = frozenset(a for k in show for a in ancestors(k))
        if choice_dirs is None:
            choice_dirs = frozenset(k.rpartition("/")[0] for k in (*show, *hide))
        return _Rules(user, show, hide, show_keep, tracked, choice_dirs)

    def set_rules(self, user: UserRules | None = None, show=(), hide=()) -> None:
        """A folder's hiding settings (hiding.Hiding): the user's patterns and the per-path show and
        hide choices (spellings; a path in both counts as hidden)."""
        hide_d = {fold_rel(p): p for p in hide}
        show_d = {k: p for p in show if (k := fold_rel(p)) not in hide_d}
        self._rules = self.make_rules(user if user is not None else EMPTY_RULES, show_d, hide_d,
                                      tracked=self._rules.tracked)

    def set_keep(self, tracked) -> None:
        """hiding.tracked_keep: the folded paths built-in entries never hide (git tracks them or
        something below them)."""
        r = self._rules
        self._rules = _Rules(r.user, r.show, r.hide, r.show_keep, frozenset(tracked), r.choice_dirs)

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
        """A deny pattern matches; the built-in ones not for their exceptions (.env.example)."""
        low = fold(name)
        if any(fnmatch.fnmatchcase(low, p) for p in self.deny if p not in self._deny_lifted):
            return True
        return (any(fnmatch.fnmatchcase(low, p) for p in self._deny_lifted)
                and not any(fnmatch.fnmatchcase(low, p) for p in self.deny_except))

    def is_ignored(self, name: str) -> bool:
        """The name is on the ignore list (it may still be shown: a tracked file, a show choice)."""
        return self._match(name, self.ignore)

    def ignore_rule(self, name: str) -> str | None:
        """The ignore entry that matches name: an --ignore pattern first (never lifted for tracked
        files), else the first built-in one."""
        low = fold(name)
        for pats in (self.extra, self.ignore):
            hit = next((p for p in pats if fnmatch.fnmatchcase(low, p)), None)
            if hit is not None:
                return hit
        return None

    def is_extra(self, rule: str | None) -> bool:
        """rule is an --ignore pattern (not a built-in entry)."""
        return rule in self._extra_set

    def user_rule(self, rel: str) -> str | None:
        """The user pattern hiding rel or one of its ancestors."""
        return self._rules.user.covers(rel)

    def is_hidden(self, name: str) -> bool:
        """Denied or on the ignore list, by name alone (paths are judged by verdict)."""
        return self.is_denied(name) or self.is_ignored(name)

    def is_always_hidden(self, name: str) -> bool:
        return self._match(name, ALWAYS_HIDDEN)

    def is_hidden_fast(self, name: str) -> bool:
        """is_hidden with one regex match (for the walker, which tests every name in the tree)."""
        rx = self._hidden_rx
        return rx is not None and rx.match(fold(name)) is not None

    def name_reason(self, name: str) -> str | None:
        """What a name alone says: "always" (.git, .deltadeck-tmp-*), "deny", "ignore" or None.
        The walker's fast path; whether the path is hidden is classify's call."""
        if not self.is_hidden_fast(name):
            return None
        if self.is_always_hidden(name):
            return "always"
        return "deny" if self.is_denied(name) else "ignore" if self.is_ignored(name) else None

    # --- verdicts -----------------------------------------------------------
    def classify(self, rel: str, name: str, inherited: tuple[str, str | None] | None = None,
                 git: Callable[[str], bool] | None = None, *, rules: _Rules | None = None,
                 fparent: str | None = None, keep: bool = False, skip_choice: bool = False) -> Verdict:
        """One path whose parent is visible or partial (inherited: the partial parent's (reason,
        rule)). Precedence: never > deny > the path's own show/hide choice > a user pattern >
        its ignore entry > inherited > git (git(rel), passed only while git-ignored files are
        hidden). A hiding default is lifted to "partial" when the path is kept: tracked (built-in
        entries only) or an ancestor of a show choice (ignore and git; never "user").
        fparent: the folded parent path if known; keep: treat rel as an ancestor of a show choice;
        skip_choice: the default verdict (rel's own choice left out)."""
        r = self._rules if rules is None else rules
        nr = self.name_reason(name)
        if nr == "always":
            return NEVER
        if nr == "deny":
            return DENIED
        fr = None
        if not skip_choice and (r.show or r.hide):
            fr = self._fold_child(rel, name, fparent)
            if fr in r.hide:
                return HIDE_CHOICE
            if fr in r.show:
                return SHOWN
        if r.user.rules:  # a user pattern beats the ignore list and is never lifted
            if fr is None:
                fr = self._fold_child(rel, name, fparent)
            rule = r.user.match_at(fr.split("/"))
            if rule is not None:
                return Verdict("hidden", "user", rule)
        if nr == "ignore":
            reason, rule = "ignore", self.ignore_rule(name)
        else:
            rule = None
            if inherited is not None:
                reason, rule = inherited
            elif git is not None and git(rel):
                reason = "git"
            else:
                return VISIBLE
        if reason == "user":
            return Verdict("hidden", "user", rule)
        if keep:
            return Verdict("partial", reason, rule)
        if (reason == "ignore" and r.tracked and rule not in self._extra_set) or r.show_keep:
            if fr is None:
                fr = self._fold_child(rel, name, fparent)
            if reason == "ignore" and rule not in self._extra_set and fr in r.tracked:
                return Verdict("partial", reason, rule)
            if fr in r.show_keep:
                return Verdict("partial", reason, rule)
        return Verdict("hidden", reason, rule)

    @staticmethod
    def _fold_child(rel: str, name: str, fparent: str | None) -> str:
        if fparent is None:
            return fold_rel(rel)
        return f"{fparent}/{fold(name)}" if fparent else fold(name)

    def verdict_at(self, rel: str, git: Callable[[str], bool] | None = None, *, rules: _Rules | None = None,
                   assume_show: bool = False) -> tuple[Verdict, str]:
        """(verdict, where it was decided): classify for each component, top-down from the root;
        the first "never" or "hidden" hides everything below it. assume_show: as if rel had a
        show choice (its ancestors kept). O(depth)."""
        comps = [c for c in rel.split("/") if c and c != "."]
        if not comps:
            return VISIBLE, ""
        if self.excluded and self.is_excluded(os.path.join(self.root, *comps)):
            return NEVER, rel
        r = self._rules if rules is None else rules
        inherited = None
        prefix = fprefix = ""
        v = VISIBLE
        last = len(comps) - 1
        for i, c in enumerate(comps):
            prefix = f"{prefix}/{c}" if prefix else c
            if assume_show and i == last:
                v = self.classify(prefix, c, inherited, git, rules=r, fparent=fprefix, keep=True)
                return (v if v.kind == "never" or v.reason == "deny" else SHOWN), prefix
            v = self.classify(prefix, c, inherited, git, rules=r, fparent=fprefix, keep=assume_show)
            if v.kind in _STOP:
                if v.kind == "hidden" and v.reason != "deny":  # a denied or never-shown name below still wins
                    for c2 in comps[i + 1:]:
                        prefix = f"{prefix}/{c2}"
                        nr = self.name_reason(c2)
                        if nr == "always":
                            return NEVER, prefix
                        if nr == "deny":
                            return DENIED, prefix
                    prefix = "/".join(comps[:i + 1])
                return v, prefix
            inherited = (v.reason, v.rule) if v.kind == "partial" else None
            fc = fold(c)
            fprefix = f"{fprefix}/{fc}" if fprefix else fc
        return v, prefix

    def verdict(self, rel: str, git: Callable[[str], bool] | None = None, *, rules: _Rules | None = None) -> Verdict:
        return self.verdict_at(rel, git, rules=rules)[0]

    def hidden_reason(self, rel: str) -> str | None:
        """"always" for a never-shown path, the reason of a hidden one ("deny", "ignore", "user";
        "git" only from Store.hidden_reason), None if visible."""
        v = self.verdict(rel)
        return "always" if v.kind == "never" else v.reason if v.kind == "hidden" else None

    def _ignore_hidden(self, rel: str) -> bool:
        v = self.verdict(rel)
        return v.kind == "hidden" and v.reason == "ignore"

    def _refused(self, allow: str):
        """name -> refused, for resolve(allow=...)."""
        if allow in ("none", "ignored"):
            return lambda n: self.is_denied(n) or self.is_always_hidden(n)
        if allow == "denied":
            return self.is_always_hidden
        raise ValueError(allow)

    def rel_hidden(self, rel: str) -> bool:
        """True if a root-relative POSIX path is never shown or hidden (names, patterns, choices;
        what git ignores is Store.rel_hidden's)."""
        return self.verdict(rel).kind in _STOP

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
        return names is None or self.rel_hidden("/".join(names))

    def inside(self, real: str) -> bool:
        try:
            return os.path.commonpath([self.root, real]) == self.root
        except ValueError:
            return False

    def rel_of(self, abs_path: str) -> str:
        rel = os.path.relpath(abs_path, self.root)
        return "" if rel == "." else rel.replace(os.sep, "/")

    # --- the gate ---------------------------------------------------------
    def resolve(self, rel: str | None, allow: str = "none") -> Resolved:
        """allow: "none" refuses denied names and paths the ignore list hides (not a tracked file in
        node_modules/, nor a shown one), "ignored" lets those through, "denied" denied ones too (the
        read-only reveal); always-hidden names are refused in every mode."""
        refused = self._refused(allow)
        strict = allow == "none"

        def rel_refused(p: str) -> bool:
            return any(refused(c) for c in p.split("/") if c and c not in (".", ".."))

        if rel is None or rel.strip() == "":
            raise PathError(400, "path is required")
        if "\0" in rel:
            raise PathError(400, "invalid path")
        if rel.startswith("/") or rel.startswith("\\") or os.path.isabs(rel):
            raise PathError(403, "absolute paths are not allowed")
        if rel_refused(rel):
            raise PathError(403, "path is not allowed")
        if strict and self._ignore_hidden(rel):
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
        if rel_refused(self.rel_of(real)):
            raise PathError(403, "path is not allowed")
        # Never go through a symlinked directory (the walker never descends them).
        parent = os.path.dirname(joined)
        if os.path.realpath(parent) != parent:
            raise PathError(403, "path is not allowed")
        if not os.path.exists(real):
            raise PathError(404, "not found")
        # Check the names exactly as they exist on disk (requested path and resolved target).
        names = self.disk_names(norm)
        if names is None or any(refused(n) for n in names):
            raise PathError(403, "path is not allowed")
        real_names = self.disk_names(self.rel_of(real))
        if real_names is None or any(refused(n) for n in real_names):
            raise PathError(403, "path is not allowed")
        canon = "/".join(names)
        if strict and (self._ignore_hidden(canon) or self._ignore_hidden("/".join(real_names))):
            raise PathError(403, "path is not allowed")
        joined = os.path.join(self.root, *names)
        return Resolved(rel=canon, abs=joined, real=real)

    def resolve_file(self, rel: str | None, allow: str = "none") -> tuple[Resolved, os.stat_result]:
        r = self.resolve(rel, allow)
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
                if (not self.inside(real) or (self.excluded and self.is_excluded(real))
                        or self.rel_hidden(self.rel_of(real)) or self.disk_hidden(self.rel_of(real))):
                    return None
                st = os.stat(real)
            else:
                st = lst
        except OSError:
            return None
        return st if stat_mod.S_ISREG(st.st_mode) else None
