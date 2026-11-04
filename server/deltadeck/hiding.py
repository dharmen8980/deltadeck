"""Per-folder hidden-file settings: the user's hide patterns, per-path show and hide choices and
whether git-ignored files are hidden (hide_git), kept in <data dir>/roots/<key>/hiding.json
(never in the folder; also in --read-only mode, like the changes history).

Rules are gitignore-like, without negation or "**": a rule with no "/" is a name glob tested on
every path component ("*.log", "fixtures"); a rule with a leading or inner "/" is anchored to the
root and matched component by component ("/docs/old", "packages/*/dist"). A match hides that path
and everything below it. Matching folds case and Unicode (config.fold), like the deny and ignore
lists. User rules only hide: files they hide stay readable and editable, like git-ignored ones.

Choices are exact root-relative paths, matched folded. Which one wins (PathGuard.classify): a denied
name always hides; then the path's own choice; then its ignore-list entry, a pattern, what its
folder inherited and git. A built-in entry never hides a file git tracks (tracked_keep), and a show
choice keeps the folders above it visible (only that path shows, the rest stays hidden); a folder
hidden by a pattern or a hide choice hides everything in it.

Rule parsing and UserRules import nothing but config (paths.py imports them); Hiding, which
drives the store, imports paths lazily."""

from __future__ import annotations

import asyncio
import fnmatch
import json
import logging
import os
import re
import threading
import time
import unicodedata
from collections import Counter
from dataclasses import dataclass, field

from .config import fold, write_private_json

log = logging.getLogger("deltadeck")

HIDING_FILE = "hiding.json"
MAX_RULES = 500  # per folder
MAX_RULE_LEN = 512
MAX_ADD = 100  # add_rules in one update
MAX_PATHS = 500  # show + hide paths in one update
MAX_CHOICES = 5000  # show + hide paths stored per folder
APPLIED_MAX = 1000  # paths listed in "applied" (each side)
ITEMS_MAX = 5000  # rows of /api/hiding/items
TRACKED_MAX = 200_000  # kept paths of tracked_keep
TRACKED_TIMEOUT = 10.0
TRACKED_EVERY_S = 5.0  # refresh_tracked asks git at most this often (unless forced)
SETTLE_WAIT_S = 0.02  # an update waits this long for the tree to follow (else it answers "pending")
SETTLE_WAIT_ITEMS = 10_000  # a bigger tree takes longer to settle: the update does not wait

_LOCK = threading.Lock()  # every update re-reads, merges and writes hiding.json under it
_MAGIC = re.compile(r"[*?\[]")
_ESCAPED = re.compile(r"\[([\[*?\s])\]")  # escape_path's literal "[", "*", "?" (and trailing whitespace)


class RuleError(ValueError):
    pass


@dataclass(frozen=True)
class Rule:
    text: str  # normalised spelling (as stored and shown)
    kind: str  # "name" | "anchored"
    parts: tuple[str, ...]  # folded components (one for a name glob)


def parse_rule(raw: object) -> Rule:
    if not isinstance(raw, str):
        raise RuleError("a rule must be a string")
    if len(raw) > MAX_RULE_LEN:
        raise RuleError(f"a rule is at most {MAX_RULE_LEN} characters")
    if "\0" in raw or "\\" in raw or any(unicodedata.category(c) == "Cc" for c in raw):
        raise RuleError("a rule must not contain NUL, backslash or control characters")
    text = raw.strip()
    if text.startswith("./"):
        text = text[2:]
    if text.endswith("/") and text != "/":
        text = text[:-1]
    if not text:
        raise RuleError("a rule must not be empty")
    if text == "/":
        raise RuleError("a rule cannot hide the folder itself")
    if text.startswith("!"):
        raise RuleError("'!' (negation) is not supported")
    anchored = "/" in text
    parts = (text[1:] if text.startswith("/") else text).split("/")
    if any(p in ("", ".", "..") for p in parts):
        raise RuleError("a rule must not have empty, '.' or '..' parts")
    if any(p == "**" for p in parts):
        raise RuleError("'**' is not supported; use a name rule (no '/') to match at any depth")
    if parts == ["*"]:
        raise RuleError("this rule would hide everything")
    return Rule(text, "anchored" if anchored else "name", tuple(fold(p) for p in parts))


def _escape(name: str) -> str:
    return "".join(f"[{c}]" if c in "[*?" else c for c in name)


def _escape_path(rel: str) -> str:
    """The anchored rule that hid exactly this root-relative path in v1 (fnmatch specials escaped;
    trailing whitespace bracketed so parse_rule's strip keeps it). Tests write v1 files with it."""
    text = "/" + "/".join(_escape(c) for c in rel.split("/"))
    body = text.rstrip()
    return body + "".join(f"[{c}]" for c in text[len(body):])


def _literal(part: str) -> str | None:
    """part as a plain name if it has no glob (escape_path's "[[]", "[*]", "[?]" count as literal)."""
    plain = _ESCAPED.sub("", part)
    return _ESCAPED.sub(r"\1", part) if not _MAGIC.search(plain) else None


def _fold_parts(rel: str) -> list[str]:
    return [fold(c) for c in rel.split("/")]


class UserRules:
    """The compiled user rules of one folder (immutable: PathGuard swaps it whole)."""

    __slots__ = ("rules", "name_rx", "name_src", "literal", "globs_by_depth")

    def __init__(self, rules=()):
        self.rules: tuple[Rule, ...] = tuple(rules)
        names = [r for r in self.rules if r.kind == "name"]
        self.name_rx = re.compile("|".join(f"(?:{fnmatch.translate(r.parts[0])})" for r in names)) if names else None
        self.name_src = [(re.compile(fnmatch.translate(r.parts[0])), r.text) for r in names]
        self.literal: dict[str, str] = {}
        self.globs_by_depth: dict[int, list[tuple[tuple, str]]] = {}
        for r in self.rules:
            if r.kind != "anchored":
                continue
            lits = [_literal(p) for p in r.parts]
            if all(x is not None for x in lits):
                self.literal.setdefault("/".join(lits), r.text)
            else:
                rxs = tuple(re.compile(fnmatch.translate(p)) for p in r.parts)
                self.globs_by_depth.setdefault(len(r.parts), []).append((rxs, r.text))

    def empty(self) -> bool:
        return not self.rules

    def match_at(self, parts) -> str | None:
        """The rule that hides this path prefix itself (folded components), or None."""
        last = parts[-1]
        if self.name_rx is not None and self.name_rx.match(last):
            for rx, text in self.name_src:
                if rx.match(last):
                    return text
        if self.literal:
            hit = self.literal.get("/".join(parts))
            if hit is not None:
                return hit
        for rxs, text in self.globs_by_depth.get(len(parts), ()):
            if all(rx.match(p) for rx, p in zip(rxs, parts)):
                return text
        return None

    def covers(self, rel: str) -> str | None:
        """The rule that hides rel or one of its ancestors (topmost first), or None."""
        if not self.rules or not rel:
            return None
        parts = _fold_parts(rel)
        for n in range(1, len(parts) + 1):
            hit = self.match_at(parts[:n])
            if hit is not None:
                return hit
        return None

    def rule_for(self, rel: str) -> str | None:
        """The rule that hides rel itself (its ancestors are not tested)."""
        if not self.rules or not rel:
            return None
        return self.match_at(_fold_parts(rel))


EMPTY_RULES = UserRules()


# -- preferences ---------------------------------------------------------------------------------

@dataclass(frozen=True)
class HidingPrefs:
    hide_git: bool = False
    rules: tuple[str, ...] = ()
    show: tuple[str, ...] = ()  # exact root-relative paths (NFC), shown although a default hides them
    hide: tuple[str, ...] = ()  # exact paths hidden by the user
    file_version: int = field(default=2, compare=False)  # 1: read from a v1 file (rewritten on update)


def hiding_disabled_reason(settings) -> str | None:
    """Like seen_disabled_reason: never write the settings inside the browsed folder."""
    if settings.root is None:
        return "no folder selected"
    if settings.data_dir_overlaps_root():
        return "hidden-file settings are off: the data dir overlaps the folder"
    return None


def prefs_path(settings) -> str:
    return os.path.join(settings.store_dir, HIDING_FILE)


def _always_hidden(name: str) -> bool:
    from .paths import ALWAYS_HIDDEN

    low = fold(name)
    return any(fnmatch.fnmatchcase(low, fold(p)) for p in ALWAYS_HIDDEN)


def clean_path(raw: object) -> str | None:
    """A choice path as stored (NFC), or None: not a normalised root-relative path (check_rel,
    PATH_MAX) or with an always-hidden component."""
    from .paths import check_rel

    if not isinstance(raw, str):
        return None
    p = check_rel(unicodedata.normalize("NFC", raw), lambda _p: False)
    if p is None or any(_always_hidden(c) for c in p.split("/")):
        return None
    return p


def _fold_rel(rel: str) -> str:
    return "/".join(fold(c) for c in rel.split("/"))


def _v1_hide_path(rule: Rule) -> str | None:
    """The exact path of a v1 anchored literal rule ("/docs/old", escape_path output), or None."""
    if rule.kind != "anchored" or not rule.text.startswith("/"):
        return None
    lits = [_literal(p) for p in rule.text[1:].split("/")]
    return "/".join(lits) if all(x is not None for x in lits) else None


def load_prefs(settings) -> HidingPrefs:
    """The folder's saved settings; anything missing, malformed or written for another root reads
    as the defaults. Invalid rules and paths are dropped. A v1 file is migrated in memory: exact
    (anchored literal) rules become hide paths, the built-in switches are dropped."""
    path = prefs_path(settings)
    try:
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
    except FileNotFoundError:
        return HidingPrefs()
    except (OSError, ValueError) as e:
        log.warning("hidden-file settings %s unreadable (%s); using the defaults", path, e)
        return HidingPrefs()
    if not isinstance(raw, dict) or raw.get("root") != settings.root:
        return HidingPrefs()
    v1 = raw.get("version") in (None, 1)
    rules: list[str] = []
    keys: set[str] = set()
    hide: dict[str, str] = {}
    show: dict[str, str] = {}
    raw_rules = raw.get("rules")
    for r in raw_rules if isinstance(raw_rules, list) else ():
        try:
            rule = parse_rule(r)
        except RuleError as e:
            log.info("hidden-file settings: dropping rule %r (%s)", r, e)
            continue
        if v1 and (p := clean_path(_v1_hide_path(rule))) is not None:
            hide.setdefault(_fold_rel(p), p)
            continue
        k = fold(rule.text)
        if k not in keys and len(rules) < MAX_RULES:
            keys.add(k)
            rules.append(rule.text)
    if v1 and (raw.get("builtin_off") or raw.get("builtin_on")):
        log.info("hiding: per-entry built-in switches are gone; built-ins now never hide tracked files")

    def paths(key: str, into: dict[str, str]) -> None:
        got = raw.get(key)
        for p in got if isinstance(got, list) else ():
            c = clean_path(p)
            if c is None:
                log.info("hidden-file settings: dropping %s path %r", key, p)
                continue
            into.setdefault(_fold_rel(c), c)

    if not v1:
        paths("hide", hide)
        paths("show", show)
    show = {k: p for k, p in show.items() if k not in hide}  # in both: hidden
    total = list(hide.items()) + list(show.items())
    if len(total) > MAX_CHOICES:
        log.warning("hidden-file settings: more than %d shown or hidden paths; the rest are dropped", MAX_CHOICES)
        keep = {k for k, _ in total[:MAX_CHOICES]}
        hide = {k: p for k, p in hide.items() if k in keep}
        show = {k: p for k, p in show.items() if k in keep}
    return HidingPrefs(raw.get("hide_git") is True, tuple(rules), tuple(show.values()), tuple(hide.values()),
                       file_version=1 if v1 else 2)


def save_prefs(settings, prefs: HidingPrefs) -> None:
    write_private_json(prefs_path(settings), {
        "version": 2, "root": settings.root, "hide_git": prefs.hide_git, "rules": list(prefs.rules),
        "show": list(prefs.show), "hide": list(prefs.hide)})


def _glob_escape(text: str) -> str:
    return re.sub(r"([*?\[\\])", r"\\\1", text)


def _nfc(rel: str) -> str:
    return rel if rel.isascii() else unicodedata.normalize("NFC", rel)


def tracked_keep(repo, entries) -> dict[str, str]:
    """The paths built-in entries must not hide because git tracks them: for each tracked file
    below the root, every path from its first component matching an entry down to the file
    (a/build/x/y.png keeps a/build, a/build/x and a/build/x/y.png). folded path -> spelling (NFC).
    One `git ls-files` whose pathspecs only list the matching files; at most TRACKED_MAX paths.
    Raises GitError or OSError (a failed or timed-out query)."""
    pats = sorted(set(entries))
    if not pats:
        return {}
    pre = _glob_escape(repo.prefix)
    specs = [s for p in pats for s in (f":(glob,icase){pre}**/{p}", f":(glob,icase){pre}**/{p}/**")]
    env = repo._env(repo._repo_overrides())
    env.pop("GIT_LITERAL_PATHSPECS", None)  # the specs above are ours, with glob magic
    from .git import OUTPUT_MAX

    rc, out, err = repo._call(["ls-files", "-z", "--cached", "--", *specs], env,
                              timeout=TRACKED_TIMEOUT, limit=OUTPUT_MAX)
    if rc != 0:
        raise OSError(f"git ls-files failed: {os.fsdecode(err[:200]).strip()}")
    rx = re.compile("|".join(f"(?:{fnmatch.translate(p)})" for p in pats))
    keep: dict[str, str] = {}
    prefix = repo.prefix
    for raw in out.split(b"\0"):
        path = os.fsdecode(raw)
        if not raw or not path.startswith(prefix):
            continue
        comps = _nfc(path[len(prefix):]).split("/")
        folded = [fold(c) for c in comps]
        first = next((i for i, c in enumerate(folded) if rx.match(c)), None)
        if first is None:
            continue
        cur = "/".join(comps[:first])
        fcur = "/".join(folded[:first])
        for c, fc in zip(comps[first:], folded[first:]):
            cur = f"{cur}/{c}" if cur else c
            fcur = f"{fcur}/{fc}" if fcur else fc
            if fcur in keep:
                continue
            if len(keep) >= TRACKED_MAX:
                log.warning("git tracks more than %d files in ignore-list folders; the rest stay hidden "
                            "(show them in Hidden files)", TRACKED_MAX)
                return keep
            keep[fcur] = cur
    return keep


def topmost(paths) -> list[str]:
    """The paths that have no ancestor among them."""
    s = set(paths)
    out = []
    for p in s:
        i = p.find("/")
        while i != -1 and p[:i] not in s:
            i = p.find("/", i + 1)
        if i == -1:
            out.append(p)
    return sorted(out)


# -- live state ----------------------------------------------------------------------------------

class HidingError(Exception):
    def __init__(self, status: int, detail: str, rule: str | None = None, path: str | None = None):
        super().__init__(detail)
        self.status = status
        self.detail = detail
        self.rule = rule
        self.path = path

    def to_json(self) -> dict:
        out = {"detail": self.detail}
        if self.rule is not None:
            out["rule"] = self.rule
        if self.path is not None:
            out["path"] = self.path
        return out


def _key(text: str) -> str:
    """remove_rules match a stored rule by its folded, normalised text."""
    try:
        return fold(parse_rule(text).text)
    except RuleError:
        return fold(text.strip()) if isinstance(text, str) else ""


def _capped(paths) -> tuple[list[str], bool]:
    out = sorted(set(paths))
    return out[:APPLIED_MAX], len(out) > APPLIED_MAX


def applied_of(changes) -> dict:
    """An update's "applied": the files its changes hid and showed (at most APPLIED_MAX each)."""
    hidden, shown = [], []
    for c in changes:
        hidden += [*c.deleted, *(r["from"] for r in c.renames)]
        shown += [*c.added, *(r["to"] for r in c.renames)]
    h, ht = _capped(hidden)
    s, st = _capped(shown)
    applied = {"hidden": h, "shown": s}
    if ht or st:
        applied["truncated"] = True
    return applied


_GROUPS = {"ignore": "builtin", "git": "git", "user": "user", "deny": "deny"}
_GROUP_ORDER = {"builtin": 0, "git": 1, "user": 2, "deny": 3}


class Hiding:
    """One folder's hiding settings, installed into its PathGuard (user patterns, choices, the
    tracked keep set) and GitIgnored (hide_git). update() saves them and reapplies them to the live
    tree; items() lists what is hidden for the Hidden files dialog."""

    def __init__(self, settings, guard, ignored, store, git_available_fn):
        self.settings = settings
        self.guard = guard
        self.ignored = ignored
        self.store = store
        self.git_available_fn = git_available_fn
        self.disabled_reason = hiding_disabled_reason(settings)
        self.enabled = self.disabled_reason is None
        self.prefs = HidingPrefs()
        self.version = 0
        self.on_change = None  # async (Change) -> None: the app's change publisher (SSE + search index)
        self._tracked: dict[str, str] = {}  # tracked_keep: folded path -> spelling
        self._tracked_lock = threading.Lock()
        self._tracked_at: float | None = None
        self._tracked_failing = False
        self._settle_lock = asyncio.Lock()  # one settle at a time (they coalesce: see settle)
        self._tasks: set[asyncio.Task] = set()  # settles still running after their update answered

    def _install_rules(self, prefs: HidingPrefs) -> None:
        self.guard.set_rules(UserRules(parse_rule(r) for r in prefs.rules), prefs.show, prefs.hide)
        self.prefs = prefs

    def install(self, prefs: HidingPrefs) -> None:
        """At create_app time (before the first scan): no rescan."""
        self._install_rules(prefs)
        if self.ignored is not None:
            self.ignored.enabled = prefs.hide_git

    def refresh_tracked(self, force: bool = False) -> list[str] | None:
        """Ask git which files it tracks in ignore-list folders (at most once per TRACKED_EVERY_S
        unless forced) and install the keep set. Returns the topmost paths whose keep changed (for
        the store to rescan; Store.refresh_ignored calls this, then takes its scan lock), else
        None. A failed query keeps the previous set."""
        repo_fn = self.ignored.repo_fn if self.ignored is not None else None
        with self._tracked_lock:
            now = time.monotonic()
            if not force and self._tracked_at is not None and now - self._tracked_at < TRACKED_EVERY_S:
                return None
            self._tracked_at = now
            repo = repo_fn() if repo_fn is not None else None
            if repo is None:
                new: dict[str, str] = {}
            else:
                try:
                    new = tracked_keep(repo, self.guard.builtin)
                except Exception as e:  # GitError, timeout, OSError: keep what we had
                    if not self._tracked_failing:
                        log.warning("git: could not list tracked files in ignore-list folders (%s); "
                                    "trying again at the next pass", e)
                    self._tracked_failing = True
                    return None
                self._tracked_failing = False
            old = self._tracked
            if new.keys() == old.keys():
                return None
            self._tracked = new
            self.guard.set_keep(new.keys())
            return topmost(new.get(k) or old[k] for k in new.keys() ^ old.keys())

    def git_available(self) -> bool:
        try:
            return bool(self.git_available_fn())
        except Exception:  # never let git detection break the settings
            return False

    def state(self) -> dict:
        return {
            "root": self.settings.root, "enabled": self.enabled, "disabled_reason": self.disabled_reason,
            "version": self.version, "hide_git": self.prefs.hide_git, "git_available": self.git_available(),
            "rules": list(self.prefs.rules), "show": list(self.prefs.show), "hide": list(self.prefs.hide),
            "extra": list(self.settings.ignore_extra), "always": [*self._always()],
            "deny": list(self.settings.deny),
            "limits": {"max_rules": MAX_RULES, "max_rule_len": MAX_RULE_LEN, "max_add": MAX_ADD,
                       "max_paths": MAX_PATHS, "max_choices": MAX_CHOICES},
        }

    @staticmethod
    def _always() -> tuple[str, ...]:
        from .paths import ALWAYS_HIDDEN

        return ALWAYS_HIDDEN

    @staticmethod
    def _validate(add_rules, remove_rules, show, hide):
        if len(add_rules) > MAX_ADD:
            raise HidingError(400, f"at most {MAX_ADD} rules per update")
        if len(show) + len(hide) > MAX_PATHS:
            raise HidingError(400, f"at most {MAX_PATHS} paths per update")
        adds: list[Rule] = []
        for r in add_rules:
            try:
                adds.append(parse_rule(r))
            except RuleError as e:
                raise HidingError(400, str(e), r if isinstance(r, str) else None) from None

        def paths(raw) -> list[str]:
            out = []
            for p in raw:
                from .paths import check_rel

                if not isinstance(p, str) or check_rel(unicodedata.normalize("NFC", p), lambda _p: False) is None:
                    raise HidingError(400, "not a folder-relative path", path=p if isinstance(p, str) else None)
                out.append(unicodedata.normalize("NFC", p))
            return out

        show_p, hide_p = paths(show), paths(hide)
        both = {_fold_rel(p) for p in show_p} & {_fold_rel(p) for p in hide_p}
        if both:
            p = next(p for p in show_p if _fold_rel(p) in both)
            raise HidingError(400, "the same path is in show and hide", path=p)
        removes = {_key(r) for r in remove_rules if isinstance(r, str)}
        return adds, removes, show_p, hide_p

    def update(self, hide_git: bool | None = None, add_rules=(), remove_rules=(), show=(), hide=()) -> dict:
        """Validate, save and install; applied in order: hide_git, remove_rules, add_rules, hide,
        show (all or nothing), then show choices that no longer show anything are dropped. Returns the new state. The tree follows in settle (Store.begin_hiding:
        verdicts and reads follow the new settings at once). Uses what git was last found to ignore
        and track (kept up to date by the watcher and the passes; asked again after the update):
        no git runs here. HidingError: nothing changed."""
        from .paths import PathGuard, ancestors

        if not self.enabled:
            raise HidingError(409, self.disabled_reason or "hidden-file settings are off")
        add_rules, remove_rules = list(add_rules or ()), list(remove_rules or ())
        show, hide = list(show or ()), list(hide or ())
        if hide_git is None and not (add_rules or remove_rules or show or hide):
            raise HidingError(400, "nothing to change")
        adds, removes, show_p, hide_p = self._validate(add_rules, remove_rules, show, hide)
        guard, ig = self.guard, self.ignored
        with _LOCK:
            cur = load_prefs(self.settings)  # another viewer sharing the data dir may have written it
            shows = {_fold_rel(p): p for p in cur.show}
            hides = {_fold_rel(p): p for p in cur.hide}
            # 1. hide_git: the group header means "all of them, also future ones"
            git_on = cur.hide_git if hide_git is None else bool(hide_git)
            if git_on != cur.hide_git and ig is not None and ig.paths:
                gpaths = {_fold_rel(p) for p in ig.paths}
                # without choices or git: a path the ignore list or a pattern hides keeps its choice
                bare = PathGuard.make_rules(UserRules(parse_rule(r) for r in cur.rules), {}, {},
                                            frozenset(), guard.tracked_keep, frozenset())

                def git_only(k: str, p: str) -> bool:
                    if not (k in gpaths or any(a in gpaths for a in ancestors(k))):
                        return False
                    return guard.verdict(p, None, rules=bare).kind == "visible"

                shows = {k: p for k, p in shows.items() if not git_only(k, p)}
                hides = {k: p for k, p in hides.items() if not git_only(k, p)}
            # 2., 3. patterns
            rules = [r for r in cur.rules if fold(r) not in removes]
            keys = {fold(r) for r in rules}
            for r in adds:
                k = fold(r.text)
                if k not in keys:
                    keys.add(k)
                    rules.append(r.text)
            if len(rules) > MAX_RULES:
                raise HidingError(400, f"at most {MAX_RULES} rules per folder")
            keep = Counter(a for k in shows for a in ancestors(k))
            rset = PathGuard.make_rules(UserRules(parse_rule(r) for r in rules), shows, hides, keep,
                                        guard.tracked_keep, ())
            git = ig.contains if ig is not None and git_on else None

            def drop(k: str) -> None:
                if shows.pop(k, None) is not None:
                    for a in ancestors(k):
                        keep[a] -= 1
                        if keep[a] <= 0:
                            del keep[a]
                hides.pop(k, None)

            # 4. hide: the path, and nothing below it keeps a choice
            for p in hide_p:
                k = _fold_rel(p)
                below = k + "/"
                for c in [c for c in (*shows, *hides) if c == k or c.startswith(below)]:
                    drop(c)
                if guard.verdict(p, git, rules=rset).kind in ("visible", "partial"):
                    hides[k] = p
            # 5. show: only what is still hidden, and never past a folder the user hid
            for p in show_p:
                k = _fold_rel(p)
                drop(k)
                v, at = guard.verdict_at(p, git, rules=rset)
                if v.kind == "visible" or v.kind == "partial":
                    continue
                v, at = guard.verdict_at(p, git, rules=rset, assume_show=True)
                if v.kind == "never":
                    raise HidingError(400, f"{p} is never shown", path=p)
                if v.reason == "deny":
                    raise HidingError(400, f"{p} is protected", path=p)
                if v.kind == "hidden":
                    raise HidingError(400, f"{p} is inside {at}, hidden by your rule; show that first",
                                      rule=v.rule or at, path=p)
                shows[k] = p
                for a in ancestors(k):
                    keep[a] += 1
            # 6. show choices nothing hides any more (a built-in entry or a pattern gone) are dropped:
            # the path is visible without them. Like items(), a git-ignored path keeps its choice.
            for k, p in sorted(shows.items()):
                parent, _, name = p.rpartition("/")
                pv = guard.verdict(parent, git, rules=rset) if parent else None
                if pv is not None and pv.kind not in ("visible", "partial"):
                    continue  # inside a hidden folder: kept for when that folder shows again
                inherited = (pv.reason, pv.rule) if pv is not None and pv.kind == "partial" else None
                dv = guard.classify(p, name, inherited, git, rules=rset, skip_choice=True)
                if dv.kind == "visible" and not (ig is not None and ig.covers(p)):
                    drop(k)
            if len(shows) + len(hides) > MAX_CHOICES:
                raise HidingError(400, f"too many hidden or shown paths ({MAX_CHOICES})")
            new = HidingPrefs(git_on, tuple(rules), tuple(shows.values()), tuple(hides.values()))
            if new != cur or cur.file_version != 2:
                try:
                    save_prefs(self.settings, new)
                except OSError as e:
                    log.warning("could not save %s: %s", prefs_path(self.settings), e)
                    raise HidingError(500, "could not save hidden-file settings") from None
            if new != self.prefs or (ig is not None and ig.enabled != git_on):
                def swap():
                    self._install_rules(new)
                    if ig is None or ig.enabled == git_on:
                        return set()
                    return ig.set_enabled(git_on, refresh=False)  # never waits for a git query

                self.store.begin_hiding(swap)
                self.version += 1
        return self.state()

    def _settle_sync(self) -> Change | None:
        return self.store.settle_hiding()

    async def settle(self) -> list:
        """Bring the tree in line with the installed settings (Store.settle_hiding, in a worker
        thread) and publish the change. One at a time: updates made meanwhile are settled by the
        next one together, later ones find nothing to do. Returns the changes."""
        async with self._settle_lock:
            if not self.store.hiding_pending():
                return []
            ch = await asyncio.to_thread(self._settle_sync)
            changes = [ch] if ch is not None else []
            await self.publish(changes, state=False)  # in order: before the next settle's
        return changes

    async def settle_after_update(self, wait: float | None = None) -> dict:
        """The "applied" of an update's answer: settle, waiting at most `wait` s (SETTLE_WAIT_S;
        not at all in a tree of more than SETTLE_WAIT_ITEMS items, where settling takes longer and
        would hold up the event loop thread). A bigger change (a large folder to walk) goes on in
        the background: "pending", and its "change" events follow. Then git is asked again
        (throttled) what it tracks in ignore-list folders (a commit since the last pass), also in
        the background."""
        if wait is None:
            wait = SETTLE_WAIT_S if self.store.known_count() <= SETTLE_WAIT_ITEMS else 0.0
        task = asyncio.create_task(self.settle())
        self._keep(task)
        follow = asyncio.create_task(self._after(task))
        self._keep(follow)
        done, _ = await asyncio.wait({task}, timeout=wait) if wait > 0 else (set(), None)
        if not done or task.cancelled() or task.exception() is not None:
            return {"hidden": [], "shown": [], "pending": True}
        return applied_of(task.result())

    async def _after(self, task: asyncio.Task) -> None:
        await asyncio.wait({task})
        ch = await asyncio.to_thread(lambda: self.store.refresh_ignored(force_tracked=False, git=False))
        if ch is not None:
            await self.publish(ch, state=False)

    def _keep(self, task: asyncio.Task) -> None:
        self._tasks.add(task)
        task.add_done_callback(self._done)

    def _done(self, task: asyncio.Task) -> None:
        self._tasks.discard(task)
        if not task.cancelled() and task.exception() is not None:
            log.error("hidden files: applying the settings failed", exc_info=task.exception())

    def close(self) -> None:
        """The app is shutting down: stop waiting for settles (a worker thread finishes its scan)."""
        for t in list(self._tasks):
            t.cancel()

    def items(self, *, reveal: bool, settle: bool = True):
        """The /api/hiding/items body and the changes (Change list) settling the last update (unless
        settle=False: the route settles first, through the one ordered settle path) and a refresh of
        git's answers caused (for the caller to publish). Rows: the store's topmost hidden items,
        the shown paths and, while git-ignored files are shown, the visible git-ignored ones.
        Hidden folders are never walked."""
        store, guard, ig = self.store, self.guard, self.ignored
        ch = [c for c in (store.settle_hiding() if settle else None,
                          store.refresh_ignored(force_tracked=False, listing=True)) if c is not None]
        with store._state_lock:
            hidden = list(store.hidden.values())
            dirs = set(store.dirs)
            files = set(store.entries)
        rules = guard.rules
        rows: list[dict] = []

        def row(path: str, is_dir: bool, group: str, visible: bool, rule=None, extra=False, choice=None) -> dict:
            out = {"path": path, "name": path.rpartition("/")[2], "dir": is_dir, "group": group, "visible": visible}
            if rule is not None:
                out["rule"] = rule
            if extra:
                out["extra"] = True
            if choice is not None:
                out["choice"] = choice
            if not is_dir:
                from .paths import ext_of, kind_of

                out["kind"] = kind_of(out["name"])
                out["ext"] = ext_of(out["name"])
            return out

        for h in hidden:
            if h.reason == "deny" and not reveal:
                continue
            group = _GROUPS.get(h.reason, "user")
            if h.choice == "hide" and ig is not None and ig.covers(h.path):
                group = "git"
            rows.append(row(h.path, h.dir, group, False, h.rule, h.extra, h.choice))
        git = store.git_fn()
        for p in rules.show.values():
            if p not in dirs and p not in files:
                continue
            parent, _, name = p.rpartition("/")
            pv = guard.verdict(parent, git, rules=rules) if parent else None
            inherited = (pv.reason, pv.rule) if pv is not None and pv.kind == "partial" else None
            dv = guard.classify(p, name, inherited, git, rules=rules, skip_choice=True)
            if dv.reason is None:
                if not (ig is not None and ig.covers(p)):
                    continue
                group = "git"
            else:
                group = _GROUPS.get(dv.reason, "user")
            rows.append(row(p, p in dirs, group, True, dv.rule, dv.reason == "ignore" and guard.is_extra(dv.rule),
                            "show"))
        if ig is not None and not ig.enabled:
            for p in ig.paths:
                parent = p.rpartition("/")[0]
                if (p not in dirs and p not in files) or (parent and parent not in dirs):
                    continue
                k = _fold_rel(p)
                if k in rules.show or k in rules.hide:
                    continue
                if guard.verdict(p, None, rules=rules).kind != "visible":
                    continue  # partial for the ignore list (tracked or shown inside): not a git row
                rows.append(row(p, p in dirs, "git", True))
        rows.sort(key=lambda r: (_GROUP_ORDER[r["group"]], _fold_rel(r["path"])))
        truncated = len(rows) > ITEMS_MAX
        body = {"root": self.settings.root, "version": self.version, "hide_git": self.prefs.hide_git,
                "git_available": self.git_available(), "rows": rows[:ITEMS_MAX], "truncated": truncated}
        return body, ch

    async def publish(self, changes, client: str | None = None, state: bool = True) -> None:
        """On the event loop: the "change" events (the search index follows in the background),
        then "hiding" (unless state=False)."""
        if changes is not None and not isinstance(changes, (list, tuple)):
            changes = [changes]
        for change in changes or ():
            if change is not None and self.on_change is not None:
                await self.on_change(change, wait=False)
        if not state:
            return
        data = self.state()
        if client:
            data["client"] = client
        self.store.publish_event("hiding", data)
