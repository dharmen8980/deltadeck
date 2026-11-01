"""Change detection around the Store: the file watcher and the Reconciler that schedules backstop
passes (viewer.store runs them).

The file watcher (watchfiles: FSEvents on macOS, inotify on Linux) reports changes as they happen.
The tree is scanned in full on startup; after that a Reconciler runs backstop passes only when
needed: after the watcher (re)starts or fails, after a large burst or an ambiguous event, after the
machine wakes (or the clock jumps), and on slow timers.
"""

from __future__ import annotations

import asyncio
import collections
import concurrent.futures
import logging
import os
import subprocess
import sys
import threading
import time

from .store import Change, Store, _pacer

log = logging.getLogger("viewer.store")

# Backstop timers (seconds; Settings.reconcile_interval / full_reconcile_interval override them).
DEFAULT_RESCAN_S = 300.0  # directory pass: entries created, deleted or renamed behind the watcher's back
DEFAULT_FULL_RESCAN_S = 1800.0  # full pass: also files edited in place
REMOTE_RESCAN_S = 60.0  # the same on a network volume, where the watcher sees only this machine's changes
REMOTE_FULL_RESCAN_S = 600.0
DEGRADED_RESCAN_S = 30.0  # directory pass while the watcher is down (it restarts with a backoff)
DEGRADED_FULL_RESCAN_S = 300.0  # full pass while the watcher is down: in-place edits too
WAKE_CHECK_S = 60.0  # how often the reconciler compares the wall clock with the monotonic clock
WAKE_JUMP_S = 30.0  # they drifted apart by more than this: the machine slept or the clock was set
ACTIVE_WINDOW_S = 600.0  # an HTTP request this recent counts as someone using the viewer
WATCH_SETTLE_S = 3.0  # after the watcher (re)starts: one full pass for what changed before it listened
WATCH_RETRY_MAX_S = 600.0  # the watcher's restart backoff (1, 2, 4 ... s) stops growing here
WATCH_STEP_MS = 100  # how often watchfiles' Rust side wakes to check for events and the stop flag
BIG_BATCH = 2000  # a watcher batch this large (checkout, unpacking): a directory pass shortly after
BIG_BATCH_DELAY_S = 2.0
# ... and a full pass a little later: the watcher may have dropped events (watchfiles does not pass on
# the backend's overflow / rescan signal), and only a full pass sees in-place edits. At most one per
# BIG_BATCH_FULL_GAP_S, so a long build does not cause back-to-back full passes.
BIG_BATCH_FULL_DELAY_S = 10.0
BIG_BATCH_FULL_GAP_S = 60.0
REMOTE_FS = frozenset({"smbfs", "nfs", "nfs4", "afpfs", "webdav", "cifs", "smb3", "smb2", "ftp", "9p", "sshfs",
                       "fuse.sshfs", "fuse.rclone", "davfs", "fuse.davfs2", "osxfuse", "macfuse", "fuse.s3fs"})


def is_remote_fs(fstype: str | None) -> bool:
    """A network volume, or a FUSE mount ('fuse.*' on Linux), where the watcher may miss changes."""
    t = (fstype or "").lower()
    return t in REMOTE_FS or t.startswith("fuse.")


def mount_type(path: str) -> str | None:
    """Filesystem type of the mount holding path (`mount` on macOS, /proc/self/mounts on Linux), or
    None if unknown. Best effort: used only to pick the backstop timers."""
    mounts: list[tuple[str, str]] = []
    try:
        if sys.platform == "darwin":
            out = subprocess.run(["/sbin/mount"], capture_output=True, text=True, timeout=5).stdout
            for line in out.splitlines():
                head, sep, opts = line.rpartition(" (")
                if sep and " on " in head:
                    mounts.append((head.split(" on ", 1)[1], opts.split(",", 1)[0].strip(" )")))
        elif sys.platform.startswith("linux"):
            with open("/proc/self/mounts", encoding="utf-8", errors="replace") as f:
                for line in f:
                    parts = line.split()
                    if len(parts) >= 3:
                        mounts.append((parts[1].encode().decode("unicode_escape"), parts[2]))
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    best, kind = "", None
    for mnt, fstype in mounts:
        m = mnt.rstrip("/") or "/"
        if (path == m or path.startswith(m.rstrip("/") + "/")) and len(m) >= len(best):
            best, kind = m, fstype
    return kind


def backstop_intervals(settings) -> tuple[float, float, bool]:
    """(directory pass, full pass, remote volume) in seconds; 0 turns a timer off. Unset settings get
    the defaults, shorter on a network volume."""
    quick, full = settings.reconcile_interval, settings.full_reconcile_interval
    remote = is_remote_fs(mount_type(settings.root))
    if quick is None:
        quick = REMOTE_RESCAN_S if remote else DEFAULT_RESCAN_S
    if full is None:
        full = REMOTE_FULL_RESCAN_S if remote else DEFAULT_FULL_RESCAN_S
    return max(0.0, float(quick)), max(0.0, float(full)), remote


def _lower_priority() -> None:
    """Backstop worker thread: utility QoS on macOS (efficiency cores), nice 10 on Linux."""
    try:
        if sys.platform == "darwin":
            import ctypes

            ctypes.CDLL(None).pthread_set_qos_class_self_np(0x11, 0)  # QOS_CLASS_UTILITY
        elif sys.platform.startswith("linux"):
            os.setpriority(os.PRIO_PROCESS, threading.get_native_id(), 10)  # per thread on Linux
    except (OSError, AttributeError, ValueError):
        pass


async def _wait_any(events, timeout: float) -> None:
    waits = [asyncio.ensure_future(e.wait()) for e in events]
    try:
        await asyncio.wait(waits, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for w in waits:
            w.cancel()


class Reconciler:
    """Decides when a backstop pass runs (see the module docstring) and runs it on a low-priority
    thread. Requests (watcher restart or failure, a large or ambiguous batch, a wake) run as soon as
    they are due; the timers only while someone uses the viewer (a live-update stream is open, or an
    HTTP request came in during ACTIVE_WINDOW_S): with nobody looking they pause, and the pass that
    fell due runs as soon as a client is back. A full pass also counts as a directory pass.

    The clocks are injectable (tests); run_once() is one decision plus at most one pass."""

    def __init__(self, store: Store, on_change, *, quick_interval: float, full_interval: float,
                 watching: bool = False, pause_idle: bool = True, pace: bool = True, remote: bool = False,
                 monotonic=time.monotonic, wall=time.time):
        self.store = store
        self.on_change = on_change
        self.quick_interval = quick_interval
        self.full_interval = full_interval
        self.watching = watching  # a watcher is meant to run (its being down shortens the timer)
        self.watcher_up = False
        self.pause_idle = pause_idle
        self.pace = pace
        self.remote = remote  # a network volume: changes can happen while this machine sleeps
        self._mono = monotonic
        self._wall = wall
        now = monotonic()
        self.last_quick = self.last_full = now
        self.last_activity = now
        self._clock = (now, wall())
        self._root_id = self._stat_root()
        self._cancel = threading.Event()  # set when run() ends: a pass in the worker thread stops
        self._requests: dict[str, tuple[float, str]] = {}  # kind -> (due at, reason)
        self._kick = asyncio.Event()
        self._executor: concurrent.futures.ThreadPoolExecutor | None = None
        self.passes: collections.Counter = collections.Counter()  # "quick" / "full" passes run
        self.history: collections.deque = collections.deque(maxlen=50)  # (kind, reason, seconds, changed)

    # --- inputs -------------------------------------------------------------
    def reset(self) -> None:
        """The tree was just scanned in full (startup)."""
        self.last_quick = self.last_full = self._mono()

    def request(self, kind: str, reason: str, delay: float = 0.0) -> None:
        """Ask for a 'quick' (directory) or 'full' pass within delay seconds; event loop thread."""
        at = self._mono() + delay
        cur = self._requests.get(kind)
        if cur is None or at < cur[0]:
            self._requests[kind] = (at, reason)
        self._kick.set()

    def cancel(self, kind: str, reason: str) -> None:
        """Drop a pending request, if it is still the one made for this reason."""
        cur = self._requests.get(kind)
        if cur is not None and cur[1] == reason:
            del self._requests[kind]

    def touch(self) -> None:
        """An HTTP request: someone is using the viewer."""
        now = self._mono()
        idle = not self.active(now)
        self.last_activity = now
        if idle:
            self._kick.set()

    def client_connected(self) -> None:
        self._kick.set()

    def active(self, now: float | None = None) -> bool:
        now = self._mono() if now is None else now
        return (not self.pause_idle or self.store.subscriber_count() > 0
                or now - self.last_activity < ACTIVE_WINDOW_S)

    def _stat_root(self) -> tuple[int, int] | None:
        try:
            st = os.stat(self.store.root)
        except OSError:
            return None
        return (st.st_dev, st.st_ino)

    def check_clock(self) -> bool:
        """True if the wall clock moved unlike the monotonic one since the last look (the machine
        slept: macOS's and Linux's monotonic clocks stop during sleep; or the clock was set), or the
        root's volume went away or came back (eject, remount).

        On a local volume nothing changes while the machine sleeps, so a wake gets a directory
        pass; on a network volume (others may have written meanwhile) and after a remount, a full
        pass."""
        m, w = self._mono(), self._wall()
        m0, w0 = self._clock
        self._clock = (m, w)
        rid = self._stat_root()
        kind = reason = None
        if rid != self._root_id:
            kind, reason = ("quick" if rid is None else "full"), "root volume changed"
            self._root_id = rid
        if abs((w - w0) - (m - m0)) > WAKE_JUMP_S:
            if kind != "full":
                kind, reason = ("full" if self.remote else "quick"), "wake or clock change"
        if kind is None:
            return False
        if self.active(m):
            self.request(kind, reason)
        else:  # nobody looking: due as soon as someone is
            self.last_quick = float("-inf")
            if kind == "full":
                self.last_full = float("-inf")
        return True

    # --- decisions ----------------------------------------------------------
    def _degraded(self) -> bool:
        return self.watching and not self.watcher_up

    def _quick_every(self) -> float:
        q = self.quick_interval
        if self._degraded():
            q = min(q, DEGRADED_RESCAN_S) if q > 0 else DEGRADED_RESCAN_S
        return q

    def _full_every(self) -> float:
        f = self.full_interval
        if self._degraded():
            f = min(f, DEGRADED_FULL_RESCAN_S) if f > 0 else DEGRADED_FULL_RESCAN_S
        return f

    def next_action(self) -> tuple[str, str] | None:
        now = self._mono()
        for kind in ("full", "quick"):
            req = self._requests.get(kind)
            if req is not None and req[0] <= now:
                return kind, req[1]
        if not self.active(now):
            return None
        f = self._full_every()
        if f > 0 and now - self.last_full >= f:
            return "full", "timer"
        q = self._quick_every()
        if q > 0 and now - self.last_quick >= q:
            return "quick", "timer"
        return None

    def next_wait(self) -> float:
        now = self._mono()
        waits = [WAKE_CHECK_S] + [at - now for at, _ in self._requests.values()]
        if self.active(now):
            f = self._full_every()
            if f > 0:
                waits.append(self.last_full + f - now)
            q = self._quick_every()
            if q > 0:
                waits.append(self.last_quick + q - now)
        return max(0.0, min(waits))

    # --- running ------------------------------------------------------------
    async def run_once(self) -> Change | None:
        self.check_clock()
        act = self.next_action()
        if act is None:
            return None
        kind, reason = act
        self._requests.pop(kind, None)
        if kind == "full":
            self._requests.pop("quick", None)
        fn = self.store.sweep if kind == "full" else self.store.quick_check
        pace = _pacer(cancel=self._cancel) if self.pace else _pacer(pause=0, cancel=self._cancel)
        t0 = time.monotonic()
        if self._executor is not None:
            ch = await asyncio.get_running_loop().run_in_executor(self._executor, fn, pace)
        else:
            ch = await asyncio.to_thread(fn, pace)
        now = self._mono()
        self.last_quick = now
        if kind == "full":
            self.last_full = now
        self.passes[kind] += 1
        self.history.append((kind, reason, round(time.monotonic() - t0, 3), ch is not None))
        if ch is not None:
            log.info("%s pass (%s) found changes the watcher had not reported", kind, reason)
            await self.on_change(ch)
        return ch

    def request_full_after_burst(self) -> None:
        """A large watcher batch: a full pass BIG_BATCH_FULL_DELAY_S later (later batches of the
        same burst coalesce into it), but not sooner than BIG_BATCH_FULL_GAP_S after the last one."""
        now = self._mono()
        delay = max(BIG_BATCH_FULL_DELAY_S, self.last_full + BIG_BATCH_FULL_GAP_S - now)
        self.request("full", "large batch", delay=delay)

    async def run(self, stop: asyncio.Event) -> None:
        self._cancel.clear()
        self._executor = concurrent.futures.ThreadPoolExecutor(1, thread_name_prefix="reconcile",
                                                               initializer=_lower_priority)
        try:
            while not stop.is_set():
                self._kick.clear()
                try:
                    await self.run_once()
                except asyncio.CancelledError:
                    raise
                except Exception:  # pragma: no cover
                    log.exception("reconcile failed")
                if self.next_action() is not None:
                    continue
                await _wait_any((stop, self._kick), self.next_wait())
        finally:
            self._cancel.set()  # a pass still walking in the worker thread stops at its next tick
            self._executor.shutdown(wait=False, cancel_futures=True)
            self._executor = None


async def _apply_batch(store: Store, on_change, batch, reconciler: Reconciler | None) -> None:
    paths = [os.path.normpath(p) for _, p in batch]
    if reconciler is not None:
        if len(paths) >= BIG_BATCH:  # where a busy watcher drops or coalesces events
            reconciler.request("quick", "large batch", delay=BIG_BATCH_DELAY_S)
            reconciler.request_full_after_burst()
        base = os.path.basename(store.root)
        root_hit = [p for p in paths if p == store.root
                    or (os.path.basename(p) == base and os.path.realpath(p) == store.root)]
        if root_hit:  # the root's own metadata: re-list what changed, not a full rescan
            reconciler.request("quick", "root changed")
            paths = [p for p in paths if p not in root_hit]
    scopes = store.scopes_for_paths(paths)
    if reconciler is not None and "" in scopes:
        reconciler.request("full", "path outside the root")  # differently spelled, unknown: check all
        scopes = [s for s in scopes if s]
    if not scopes:
        return
    ch = await asyncio.to_thread(store.apply_scopes, scopes)
    if ch is not None:
        await on_change(ch)


async def watch_loop(store: Store, on_change, stop: asyncio.Event, reconciler: Reconciler | None = None, *,
                     awatch=None, retry_max: float = WATCH_RETRY_MAX_S) -> None:
    """watchfiles-based watcher; on_change(Change) is awaited for each non-empty diff.

    If the watcher fails or ends it is restarted (backoff 1, 2, 4 ... s up to retry_max); each start
    asks the reconciler for a full pass WATCH_SETTLE_S later, for what changed while nothing was
    listening (also the gap between the startup scan and the first start). A start that fails
    before then withdraws its request: while the watcher is down the degraded timers cover it,
    and a watcher failing on every start does not cause a full pass per attempt."""
    if awatch is None:
        from watchfiles import awatch
    failures = 0
    started = False
    while not stop.is_set():
        reason = "watcher restarted" if started else "watcher started"
        if reconciler is not None:
            reconciler.request("full", reason, delay=WATCH_SETTLE_S)
            reconciler.watcher_up = True
        started = True
        t_start = time.monotonic()
        try:
            async for batch in awatch(store.root, recursive=True, watch_filter=None,
                                      stop_event=stop, debounce=400, step=WATCH_STEP_MS):
                failures = 0
                await _apply_batch(store, on_change, batch, reconciler)
            if stop.is_set():
                return
            failures += 1
            log.warning("file watcher ended; restarting it")
        except asyncio.CancelledError:
            raise
        except Exception as e:
            failures += 1
            if failures == 1:
                log.warning("file watcher failed (%s); restarting it, backstop passes meanwhile", e, exc_info=True)
            else:
                log.warning("file watcher failed again (%s)", e)
        finally:
            if reconciler is not None:
                reconciler.watcher_up = False
                if time.monotonic() - t_start < WATCH_SETTLE_S:
                    reconciler.cancel("full", reason)
        try:
            await asyncio.wait_for(stop.wait(), timeout=min(retry_max, 2.0 ** (failures - 1)))
            return
        except TimeoutError:
            pass
