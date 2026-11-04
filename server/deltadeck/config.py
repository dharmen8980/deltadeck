"""Runtime settings: CLI flags > environment variables > defaults; the remembered root (state.json)."""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
import secrets
import sys
import unicodedata
from dataclasses import dataclass, field, replace
from pathlib import Path

HOST = "127.0.0.1"  # hardcoded on purpose: never configurable
DEFAULT_PORT = 8765
# Protected (deny-list) names: .env files and private keys, which hold credentials. Never searched, tracked or
# edited; opened read-only on request.
DEFAULT_DENY = (".env", ".env.*", "*.pem", "*.key")
# Templates meant to be read and committed (.env.example, .env.local.sample, ...): the built-in deny
# patterns above do not cover them (a --deny pattern does). Gone with --no-default-deny.
DEFAULT_DENY_EXCEPT = (".env*.example", ".env*.sample", ".env*.template")
# Built-in ignore list, kept basic: git's own folder, macOS litter, dependency folders, Python caches
# and the editor's temporary files (.ldv-tmp-*: under the app's former name; leftovers stay hidden).
# Hide anything else yourself: right-click Hide, a pattern in the Hidden files dialog, or --ignore.
# An entry never hides a file git tracks: the folders on the path to a tracked file stay visible and
# only the untracked files around it are hidden (hiding.tracked_keep). Any item can be shown per path
# in the Hidden files dialog.
DEFAULT_IGNORE = (".git", ".DS_Store", "node_modules", "__pycache__", ".venv", "venv", ".deltadeck-tmp-*",
                  ".ldv-tmp-*")
DEFAULT_SEARCH_MAX_MB = 2.0
DEFAULT_SEARCH_MAX_FILES = 100_000  # files content-indexed in all (deltadeck.search)
DEFAULT_SEARCH_MAX_TOTAL_MB = 2048.0  # their sizes added up
_PKG_DIR = Path(__file__).resolve().parent
# server/deltadeck/config.py -> <repo>; only meaningful in a source checkout (or editable install)
_REPO_DIR = _PKG_DIR.parents[1]


def in_source_checkout(repo: Path = _REPO_DIR) -> bool:
    return (repo / "pyproject.toml").is_file() and (repo / "server" / "deltadeck").is_dir()


def find_ui_dir(pkg: Path = _PKG_DIR, repo: Path = _REPO_DIR) -> str:
    """The built UI: <package>/ui in a wheel (pip / uvx install), else the checkout's web/out.
    When neither exists, web/out is returned so the 'UI not built' hint names it."""
    bundled = pkg / "ui"
    if (bundled / "index.html").is_file():
        return str(bundled)
    return str(repo / "web" / "out")


def default_data_dir(repo: Path = _REPO_DIR) -> str:
    """.data in a source checkout; else a per-user folder (an installed package dir, e.g. a uvx
    cache, is no place for history and trash)."""
    if in_source_checkout(repo):
        return str(repo / ".data")
    base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return str(Path(base) / "deltadeck")


DEFAULT_UI_DIR = find_ui_dir()
# editing (tier 3, on unless --read-only)
DEFAULT_DATA_DIR = default_data_dir()
DEFAULT_HISTORY_KEEP = 50
DEFAULT_UPLOAD_MAX_MB = 25.0
DEFAULT_UPLOAD_EXT = ("png", "jpg", "jpeg", "gif", "webp", "svg", "pdf", "md", "mmd", "txt", "csv",
                      "json", "yaml", "yml", "py", "sh", "log")
EDIT_MAX_BYTES = 2 * 1024 * 1024  # text saves
STATE_FILE = "state.json"  # <data_dir>/state.json: {"last_root", "recent"}
RECENT_MAX = 10


class ConfigError(ValueError):
    pass


def fold(name: str) -> str:
    """Canonical form for name matching: NFKC + casefold (so e.g. U+017F 'long s' == 's',
    NFD == NFC). APFS is case- and normalisation-insensitive, so plain .lower() is not enough."""
    if name.isascii():
        return name.lower()  # the same result, without the two normalisations (the walker's hot path)
    return unicodedata.normalize("NFKC", unicodedata.normalize("NFKC", name).casefold())


def root_key(root: str) -> str:
    """Short stable name for a canonical root path (recovery store dir, search index file)."""
    return hashlib.sha256(root.encode("utf-8")).hexdigest()[:24]


def canonical_path(path: str) -> str:
    """realpath, then (on macOS) the on-disk spelling of the longest existing prefix.

    os.path.realpath resolves symlinks but keeps the requested letter case and Unicode
    normalisation, while APFS treats 'ROOT' and 'root' (or NFD and NFC) as the same folder. The
    kernel's F_GETPATH on an open descriptor returns the name as stored on disk."""
    real = os.path.realpath(path)
    head, tail = real, []
    while not os.path.lexists(head):
        nh, t = os.path.split(head)
        if nh == head:
            break
        tail.append(t)
        head = nh
    if sys.platform == "darwin":
        try:
            import fcntl

            fd = os.open(head, os.O_RDONLY)
            try:
                buf = fcntl.fcntl(fd, fcntl.F_GETPATH, bytes(1024))
            finally:
                os.close(fd)
            got = os.fsdecode(buf.split(b"\0", 1)[0])
            if got and os.path.isabs(got):
                head = got
        except (OSError, AttributeError, ImportError):
            pass
    return os.path.join(head, *reversed(tail)) if tail else head


def _str_within(child: str, parent: str) -> bool:
    try:
        return os.path.commonpath([child, parent]) == parent
    except ValueError:
        return False


def _id_within(child: str, parent: str) -> bool:
    """Identity check: is `parent` (by st_dev/st_ino) `child` itself or one of its existing
    ancestors? Independent of spelling, case and normalisation."""
    try:
        pst = os.stat(parent)
    except OSError:
        return False
    cur = os.path.realpath(child)
    while True:
        try:
            if os.path.samestat(os.stat(cur), pst):
                return True
        except OSError:
            pass
        nxt = os.path.dirname(cur)
        if nxt == cur:
            return False
        cur = nxt


def path_within(child: str, parent: str) -> bool:
    """True if child is parent or below it, robust to case/normalisation variants (APFS) and to
    symlinks. Errs towards True (folded string comparison) because it guards the recovery store."""
    c, p = canonical_path(child), canonical_path(parent)
    return _str_within(c, p) or _str_within(fold(c), fold(p)) or _id_within(c, p)



@dataclass
class Settings:
    root: str | None  # None: no folder selected yet (the UI offers the folder picker)
    port: int = DEFAULT_PORT
    deny: tuple[str, ...] = DEFAULT_DENY
    # names the built-in deny patterns leave out (templates); --deny patterns still match them
    deny_except: tuple[str, ...] = DEFAULT_DENY_EXCEPT
    # --deny: never lifted by deny_except, also when its text equals a built-in pattern
    deny_extra: tuple[str, ...] = ()
    ignore: tuple[str, ...] = DEFAULT_IGNORE  # the base list: DEFAULT_IGNORE + ignore_extra
    # --ignore: always applied, also to tracked files; a single item can still be shown per path
    ignore_extra: tuple[str, ...] = ()
    search_max_bytes: int = int(DEFAULT_SEARCH_MAX_MB * 1024 * 1024)
    search_max_files: int = DEFAULT_SEARCH_MAX_FILES
    search_max_total_bytes: int = int(DEFAULT_SEARCH_MAX_TOTAL_MB * 1024 * 1024)
    ui_dir: str = DEFAULT_UI_DIR
    # backstop rescans (seconds; None = default, 0 = off): directory pass / full pass
    reconcile_interval: float | None = None
    full_reconcile_interval: float | None = None
    rescan_when_idle: bool = False  # keep the backstop running while no client is connected
    watch: bool = True
    allow_edit: bool = False  # the CLI turns it on unless --read-only / DELTADECK_READ_ONLY=1
    edit_off_reason: str = ""  # why editing is off for this root although allowed (see editable())
    data_dir: str = DEFAULT_DATA_DIR
    history_keep: int = DEFAULT_HISTORY_KEEP
    upload_max_bytes: int = int(DEFAULT_UPLOAD_MAX_MB * 1024 * 1024)
    upload_ext: tuple[str, ...] = DEFAULT_UPLOAD_EXT
    edit_max_bytes: int = EDIT_MAX_BYTES
    lock_root: bool = False  # --lock-root: the browser cannot switch folders
    root_source: str = ""  # "cli" | "env" | "state" | "" (none)
    # --desktop: run under the Electron shell; folder dialog + PDF go through its loopback bridge
    desktop: bool = False
    bridge_url: str = ""  # DELTADECK_BRIDGE_URL, http://127.0.0.1:<port>
    bridge_token: str = field(default="", repr=False)  # DELTADECK_BRIDGE_TOKEN (never logged)
    git: str = ""  # --git / DELTADECK_GIT: "" = find git, "off" = no git features, else the git executable
    allow_reveal: bool = True  # --no-reveal / DELTADECK_NO_REVEAL=1: denied files are never shown, nor listed

    def __post_init__(self) -> None:
        self.root = canonical_path(self.root) if self.root is not None else None
        self.data_dir = canonical_path(self.data_dir)
        self.upload_ext = tuple(sorted({e.strip().lower().lstrip(".") for e in self.upload_ext if e.strip()}))
        self.history_keep = max(1, int(self.history_keep))
        self.deny = tuple(fold(p) for p in self.deny)
        self.deny_except = tuple(fold(p) for p in self.deny_except)
        self.deny_extra = tuple(fold(p) for p in self.deny_extra)
        self.ignore = tuple(fold(p) for p in self.ignore)
        self.ignore_extra = tuple(fold(p) for p in self.ignore_extra)

    def deny_split(self) -> tuple[tuple[str, ...], tuple[str, ...]]:
        """(lifted, strict): the built-in deny patterns, which deny_except lifts, and the rest
        (--deny entries stay strict even when their text equals a built-in one)."""
        builtin = {fold(p) for p in DEFAULT_DENY} if self.deny_except else set()
        extra = set(self.deny_extra)
        lifted = tuple(dict.fromkeys(p for p in self.deny if p in builtin and p not in extra))
        strict = tuple(dict.fromkeys(p for p in self.deny if p not in lifted))
        return lifted, strict

    def data_dir_overlaps_root(self) -> bool:
        return path_within(self.data_dir, self.root) or path_within(self.root, self.data_dir)

    def data_dir_inside_root(self) -> bool:
        return path_within(self.data_dir, self.root)

    @property
    def root_key(self) -> str:
        return root_key(self.root)

    @property
    def store_dir(self) -> str:
        """Per-root recovery store: history, trash and audit of one root never mix with another
        root's (several viewers may share the default data dir)."""
        return os.path.join(self.data_dir, "roots", self.root_key)

    def editable(self) -> "Settings":
        """This root's settings: a folder that holds the data dir (or sits inside it) opens read-only,
        so history and trash never land in the browsed tree."""
        if self.allow_edit and self.root is not None and self.data_dir_overlaps_root():
            return replace(self, allow_edit=False, edit_off_reason=(
                f"the data dir {self.data_dir} overlaps this folder; pass --data-dir elsewhere to edit"))
        return self

    def validate(self) -> None:
        """Refuse configurations that would let the recovery store leak into the browsed tree."""
        if self.allow_edit and self.data_dir_overlaps_root():
            raise ConfigError(f"data dir {self.data_dir} must not be inside the root {self.root} "
                              "(nor the root inside the data dir)")

    @classmethod
    def make(
        cls,
        root: str | None,
        *,
        deny: list[str] | None = None,
        ignore: list[str] | None = None,
        no_default_deny: bool = False,
        **kw,
    ) -> "Settings":
        d = [] if no_default_deny else list(DEFAULT_DENY)
        d += list(deny or [])
        i = list(DEFAULT_IGNORE) + list(ignore or [])
        kw.setdefault("deny_except", () if no_default_deny else DEFAULT_DENY_EXCEPT)
        return cls(root=root, deny=tuple(d), deny_extra=tuple(deny or []), ignore=tuple(i),
                   ignore_extra=tuple(ignore or []), **kw)


def _split_env(value: str | None) -> list[str]:
    return [p.strip() for p in (value or "").split(",") if p.strip()]


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="deltadeck",
        description="DeltaDeck: browse, review and edit a folder of docs (always binds 127.0.0.1).",
    )
    p.add_argument("--root", help="folder to browse (env DELTADECK_ROOT; default: the last folder chosen "
                                  "in the browser, else none - choose one in the browser)")
    p.add_argument("--port", type=int, help=f"port (env DELTADECK_PORT, default {DEFAULT_PORT})")
    p.add_argument("--deny", action="append", default=[], metavar="PATTERN",
                   help="extra deny (protected) pattern, besides the built-in .env and .env.* (repeatable; "
                        "env DELTADECK_DENY comma-separated)")
    p.add_argument("--no-default-deny", action="store_true",
                   help="drop the built-in deny patterns (.env, .env.*)")
    p.add_argument("--ignore", action="append", default=[], metavar="PATTERN",
                   help="extra ignore pattern, always applied, besides the built-in .git, .DS_Store, node_modules, "
                        "__pycache__, .venv and venv (repeatable; env DELTADECK_IGNORE comma-separated)")
    p.add_argument("--search-max-mb", type=float,
                   help="max file size indexed for search, MB (env DELTADECK_SEARCH_MAX_MB, default 2)")
    p.add_argument("--search-max-files", type=int,
                   help=f"max files content-indexed in all (env DELTADECK_SEARCH_MAX_FILES, "
                        f"default {DEFAULT_SEARCH_MAX_FILES})")
    p.add_argument("--search-max-total-mb", type=float,
                   help="max total size of the content-indexed files, MB (env DELTADECK_SEARCH_MAX_TOTAL_MB, "
                        f"default {DEFAULT_SEARCH_MAX_TOTAL_MB:g})")
    p.add_argument("--ui-dir", help=f"built UI directory (default {DEFAULT_UI_DIR})")
    p.add_argument("--read-only", action="store_true", default=None,
                   help="turn off editing and file management (env DELTADECK_READ_ONLY=1; default: files open read-only, with an Edit button)")
    p.add_argument("--allow-edit", action="store_true", default=None, help=argparse.SUPPRESS)  # default now
    p.add_argument("--data-dir", help=f"history/trash/audit store (env DELTADECK_DATA_DIR, default {DEFAULT_DATA_DIR})")
    p.add_argument("--history-keep", type=int, help=f"versions kept per file (default {DEFAULT_HISTORY_KEEP})")
    p.add_argument("--upload-max-mb", type=float, help=f"max upload size per file, MB (default {DEFAULT_UPLOAD_MAX_MB:g})")
    p.add_argument("--upload-ext", action="append", default=None, metavar="EXT",
                   help="allowed upload extension (repeatable or comma-separated; replaces the default list)")
    p.add_argument("--lock-root", action="store_true", default=None,
                   help="do not let the browser switch folders (env DELTADECK_LOCK_ROOT=1; needs a root)")
    p.add_argument("--desktop", action="store_true", default=None,
                   help="run as the desktop app's server (env DELTADECK_DESKTOP=1; needs DELTADECK_BRIDGE_URL "
                        "and DELTADECK_BRIDGE_TOKEN; prints DELTADECK_READY <url> and exits when stdin closes)")
    p.add_argument("--rescan-interval", type=float, metavar="SECONDS",
                   help="backstop directory pass, catches creates/deletes/renames the watcher missed "
                        "(env DELTADECK_RESCAN_INTERVAL; default 300, 60 on a network volume; 0 = off)")
    p.add_argument("--full-rescan-interval", type=float, metavar="SECONDS",
                   help="backstop full pass, also catches in-place edits the watcher missed "
                        "(env DELTADECK_FULL_RESCAN_INTERVAL; default 1800, 600 on a network volume; 0 = off)")
    p.add_argument("--rescan-when-idle", action="store_true", default=None,
                   help="keep the backstop passes running while no browser is connected "
                        "(env DELTADECK_RESCAN_WHEN_IDLE=1; default: paused, one pass on reconnect)")
    p.add_argument("--git", metavar="PATH|off",
                   help="git executable for the read-only git views, or 'off' (env DELTADECK_GIT; "
                        "default: found on PATH and the usual install locations)")
    p.add_argument("--no-reveal", action="store_true", default=None,
                   help="never show deny-listed files, not even on request, and leave them out of the "
                        "hidden-files listing (env DELTADECK_NO_REVEAL=1)")
    return p


def truthy(v: object) -> bool:
    """An env var or form field that says yes ("1", "true", "yes", "on"); anything else, None
    or a non-string (an uploaded file) is False."""
    return isinstance(v, str) and v.strip().lower() in ("1", "true", "yes", "on")


ENV_PREFIX = "DELTADECK_"
LEGACY_ENV_PREFIX = "DOCS_VIEWER_"  # the app's former name, still read as a fallback


def env_var(env, name: str) -> str | None:
    """DELTADECK_<name>, else the former DOCS_VIEWER_<name> (the new name wins when both are set)."""
    v = env.get(ENV_PREFIX + name)
    return v if v is not None else env.get(LEGACY_ENV_PREFIX + name)


def _float_env(env, name: str) -> float | None:
    v = (env_var(env, name) or "").strip()
    return float(v) if v else None


def _state_path(data_dir: str) -> str:
    return os.path.join(data_dir, STATE_FILE)


def load_state(data_dir: str) -> dict:
    """{"last_root": str|None, "recent": [str]} from <data_dir>/state.json; anything malformed
    reads as empty (the file only holds conveniences, never permissions beyond 'recent')."""
    try:
        with open(_state_path(data_dir), encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError):
        raw = {}
    raw = raw if isinstance(raw, dict) else {}
    last = raw.get("last_root")
    recent = [p for p in raw.get("recent") or [] if isinstance(p, str) and os.path.isabs(p)]
    return {"last_root": last if isinstance(last, str) and os.path.isabs(last) else None,
            "recent": list(dict.fromkeys(recent))[:RECENT_MAX]}


def save_state(data_dir: str, state: dict) -> None:
    """Atomic write (tmp + os.replace), mode 0600, data dir 0700."""
    data = {"last_root": state.get("last_root"), "recent": list(state.get("recent") or [])[:RECENT_MAX]}
    write_private_json(_state_path(data_dir), data)


def write_private_json(path: str, data) -> None:
    """Atomic JSON write: a fresh tmp file (O_EXCL, never through a symlink) at mode 0600, fsync,
    os.replace; its directory is created 0700."""
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    tmp = f"{path}.tmp-{secrets.token_hex(4)}"
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with open(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def settings_from_args(argv: list[str] | None = None, env: dict | None = None) -> Settings:
    """Root: --root > DELTADECK_ROOT > last_root of state.json (if still a folder) > None."""
    env = os.environ if env is None else env
    a = build_parser().parse_args(argv)
    data_dir = a.data_dir or env_var(env, "DATA_DIR") or DEFAULT_DATA_DIR
    root, source = a.root, "cli"
    if not root:
        root, source = env_var(env, "ROOT") or None, "env"
    if not root:
        last = load_state(canonical_path(data_dir))["last_root"]
        root, source = (last, "state") if last and os.path.isdir(last) else (None, "")
    port = a.port if a.port is not None else int(env_var(env, "PORT") or DEFAULT_PORT)
    desktop = bool(a.desktop) or truthy(env_var(env, "DESKTOP"))
    mb = a.search_max_mb if a.search_max_mb is not None else float(
        env_var(env, "SEARCH_MAX_MB") or DEFAULT_SEARCH_MAX_MB)
    max_files = a.search_max_files if a.search_max_files is not None else int(
        env_var(env, "SEARCH_MAX_FILES") or DEFAULT_SEARCH_MAX_FILES)
    total_mb = a.search_max_total_mb if a.search_max_total_mb is not None else float(
        env_var(env, "SEARCH_MAX_TOTAL_MB") or DEFAULT_SEARCH_MAX_TOTAL_MB)
    rescan = a.rescan_interval if a.rescan_interval is not None else _float_env(env, "RESCAN_INTERVAL")
    full_rescan = a.full_rescan_interval if a.full_rescan_interval is not None else _float_env(
        env, "FULL_RESCAN_INTERVAL")
    return Settings.make(
        root,
        port=port,
        reconcile_interval=None if rescan is None else max(0.0, rescan),
        full_reconcile_interval=None if full_rescan is None else max(0.0, full_rescan),
        rescan_when_idle=bool(a.rescan_when_idle) or truthy(env_var(env, "RESCAN_WHEN_IDLE")),
        deny=list(a.deny) + _split_env(env_var(env, "DENY")),
        ignore=list(a.ignore) + _split_env(env_var(env, "IGNORE")),
        no_default_deny=a.no_default_deny,
        search_max_bytes=int(mb * 1024 * 1024),
        search_max_files=max(1, max_files),
        search_max_total_bytes=max(1, int(total_mb * 1024 * 1024)),
        ui_dir=a.ui_dir or DEFAULT_UI_DIR,
        allow_edit=not (bool(a.read_only) or truthy(env_var(env, "READ_ONLY"))),
        data_dir=data_dir,
        history_keep=a.history_keep if a.history_keep is not None else DEFAULT_HISTORY_KEEP,
        upload_max_bytes=int((a.upload_max_mb if a.upload_max_mb is not None else DEFAULT_UPLOAD_MAX_MB)
                             * 1024 * 1024),
        upload_ext=tuple(e for v in a.upload_ext for e in _split_env(v)) if a.upload_ext else DEFAULT_UPLOAD_EXT,
        lock_root=bool(a.lock_root) or truthy(env_var(env, "LOCK_ROOT")),
        root_source=source,
        desktop=desktop,
        bridge_url=(env_var(env, "BRIDGE_URL") or "").strip() if desktop else "",
        bridge_token=(env_var(env, "BRIDGE_TOKEN") or "").strip() if desktop else "",
        allow_reveal=not (bool(a.no_reveal) or truthy(env_var(env, "NO_REVEAL"))),
        git=(a.git if a.git is not None else env_var(env, "GIT") or "").strip(),
    )
