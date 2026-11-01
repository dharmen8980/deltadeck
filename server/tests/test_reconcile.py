"""Change detection without periodic full rescans: the watcher drives updates, the Reconciler runs
backstop passes only when needed (watcher restart or failure, large or ambiguous batches, wake,
slow timers while someone is connected), and the directory pass is correct."""

import asyncio
import os
import time

import pytest

from conftest import case_insensitive, make_store, running, wait_until, write
from viewer import reconcile as reconcile_mod
from viewer import store as store_mod
from viewer.config import Settings, settings_from_args
from viewer.paths import PathGuard
from viewer.store import Reconciler, _apply_batch, backstop_intervals, watch_loop


def tree(s):
    snap = s.snapshot()
    return {f["path"] for f in snap["files"]}, set(snap["dirs"])


class Clock:
    def __init__(self, t=1000.0):
        self.t = t
        self.w = 1_700_000_000.0

    def mono(self):
        return self.t

    def wall(self):
        return self.w

    def advance(self, s, wall=None):
        self.t += s
        self.w += s if wall is None else wall


class FakeStore:
    def __init__(self):
        self.calls = []
        self.subscribers = 0
        self.root = "/nonexistent"

    def subscriber_count(self):
        return self.subscribers

    def quick_check(self, pace=None):
        self.calls.append("quick")

    def sweep(self, pace=None):
        self.calls.append("full")


async def _noop(ch):
    pass


def rec_for(clock, quick=300.0, full=1800.0, store=None, **kw):
    st = store or FakeStore()
    r = Reconciler(st, _noop, quick_interval=quick, full_interval=full, monotonic=clock.mono,
                   wall=clock.wall, pace=False, **kw)
    r.reset()
    return r, st


def step(r):
    return asyncio.run(r.run_once())


# --- watcher-driven updates ---------------------------------------------------

def test_watcher_updates_without_any_backstop_timer(root):
    write(root / "a.md", "a")
    with running(root, watch=True, reconcile_interval=0, full_reconcile_interval=0) as c:
        rec = c.app.state.reconciler
        time.sleep(0.5)
        write(root / "new.md", "x")
        (root / "sub").mkdir()
        write(root / "sub" / "b.md", "b")
        paths = lambda: {f["path"] for f in c.get("/api/tree").json()["files"]}
        wait_until(lambda: {"new.md", "sub/b.md"} <= paths(), timeout=10)
        (root / "a.md").unlink()
        wait_until(lambda: "a.md" not in paths(), timeout=10)
        assert all(reason != "timer" for _, reason, _, _ in rec.history)


def test_watch_loop_restarts_after_error_and_requests_full_pass(root):
    write(root / "a.md", "a")
    s = make_store(root)
    clock = Clock()
    r, _ = rec_for(clock, store=s, watching=True)
    seen_up = []
    asked = []
    real_request = r.request
    r.request = lambda kind, reason, delay=0.0: (asked.append((kind, reason)), real_request(kind, reason, delay))

    def fake_awatch(*a, stop_event, **kw):
        n = len(seen_up)
        seen_up.append(r.watcher_up)

        async def gen():
            if n == 0:
                raise RuntimeError("watcher overflow")
            write(root / "b.md", "b")
            yield {(1, str(root / "b.md"))}
            stop_event.set()

        return gen()

    async def main():
        stop = asyncio.Event()
        changes = []

        async def on_change(ch):
            changes.append(ch)

        await asyncio.wait_for(watch_loop(s, on_change, stop, r, awatch=fake_awatch, retry_max=0.01), 5)
        return changes

    changes = asyncio.run(main())
    assert seen_up == [True, True]
    assert r.watcher_up is False  # down once the loop ended
    assert asked == [("full", "watcher started"), ("full", "watcher restarted")]
    assert "full" not in r._requests  # both attempts ended at once: the degraded timers cover it
    assert any("b.md" in ch.added for ch in changes)


def test_watcher_that_stays_up_keeps_its_full_pass_request(root, monkeypatch):
    s = make_store(root)
    r, _ = rec_for(Clock(), store=s, watching=True)
    monkeypatch.setattr(reconcile_mod, "WATCH_SETTLE_S", 0.05)

    def fake_awatch(*a, stop_event, **kw):
        async def gen():
            await asyncio.sleep(0.1)
            stop_event.set()
            return
            yield

        return gen()

    asyncio.run(asyncio.wait_for(watch_loop(s, _noop, asyncio.Event(), r, awatch=fake_awatch, retry_max=0.01), 5))
    assert r._requests["full"][1] == "watcher started"


def test_watcher_that_ends_is_restarted(root):
    s = make_store(root)
    r, _ = rec_for(Clock(), store=s, watching=True)
    starts = []

    def fake_awatch(*a, stop_event, **kw):
        starts.append(1)

        async def gen():
            if len(starts) >= 3:
                stop_event.set()
            return
            yield

        return gen()

    asyncio.run(asyncio.wait_for(watch_loop(s, _noop, asyncio.Event(), r, awatch=fake_awatch, retry_max=0.01), 5))
    assert len(starts) == 3


def test_watcher_down_shortens_the_directory_pass():
    clock = Clock()
    r, st = rec_for(clock, watching=True)
    r.watcher_up = False
    r.last_activity = clock.t
    clock.advance(store_mod.DEGRADED_RESCAN_S)
    step(r)
    assert st.calls == ["quick"]
    r.watcher_up = True
    clock.advance(store_mod.DEGRADED_RESCAN_S)
    step(r)
    assert st.calls == ["quick"]  # watcher back: the normal 300 s timer
    r.watcher_up = False
    clock.advance(store_mod.DEGRADED_FULL_RESCAN_S - store_mod.DEGRADED_RESCAN_S)
    step(r)
    assert st.calls == ["quick", "full"]  # in-place edits too, every 5 min while down


def test_large_batch_requests_a_directory_pass_then_a_full_one(root):
    s = make_store(root)
    clock = Clock()
    r, _ = rec_for(clock, store=s)
    batch = {(1, str(root / f"f{i}.md")) for i in range(store_mod.BIG_BATCH)}
    asyncio.run(_apply_batch(s, _noop, batch, r))
    assert r._requests["quick"] == (clock.t + store_mod.BIG_BATCH_DELAY_S, "large batch")
    # the watcher may have dropped events (overflow): in-place edits need a full pass. The startup
    # scan was just now, so it waits out the minimum gap between such passes.
    assert r._requests["full"] == (clock.t + store_mod.BIG_BATCH_FULL_GAP_S, "large batch")
    r._requests.clear()
    clock.advance(1000)
    asyncio.run(_apply_batch(s, _noop, batch, r))
    assert r._requests["full"] == (clock.t + store_mod.BIG_BATCH_FULL_DELAY_S, "large batch")
    clock.advance(5)
    asyncio.run(_apply_batch(s, _noop, batch, r))  # the same burst: still the first request
    assert r._requests["full"][0] == clock.t - 5 + store_mod.BIG_BATCH_FULL_DELAY_S


def test_small_batch_does_not_resolve_every_path(root, monkeypatch):
    s = make_store(root)
    r, _ = rec_for(Clock(), store=s)
    calls = []
    real = os.path.realpath
    monkeypatch.setattr(store_mod.os.path, "realpath", lambda p, **kw: (calls.append(p), real(p, **kw))[1])
    batch = {(1, str(root / f"f{i}.md")) for i in range(50)}
    asyncio.run(_apply_batch(s, _noop, batch, r))
    assert not [p for p in calls if p.endswith(".md")]


def test_root_event_requests_a_directory_pass_not_a_full_one(root):
    write(root / "a.md", "a")
    s = make_store(root)
    r, _ = rec_for(Clock(), store=s)
    asyncio.run(_apply_batch(s, _noop, {(2, str(root))}, r))
    assert r._requests["quick"][1] == "root changed"
    assert "full" not in r._requests


def test_path_outside_root_requests_full_pass(root, tmp_path):
    s = make_store(root)
    r, _ = rec_for(Clock(), store=s)
    asyncio.run(_apply_batch(s, _noop, {(2, str(tmp_path / "elsewhere" / "x"))}, r))
    assert r._requests["full"][1] == "path outside the root"


# --- timers, wake, pause ------------------------------------------------------

def test_backstop_intervals_are_honoured():
    clock = Clock()
    r, st = rec_for(clock, quick=300, full=1800, pause_idle=False)
    clock.advance(299)
    step(r)
    assert st.calls == []
    assert r.next_wait() == pytest.approx(1)
    clock.advance(1)
    step(r)
    assert st.calls == ["quick"]
    clock.advance(1500)  # t=1800 since the startup scan
    step(r)
    assert st.calls == ["quick", "full"]
    clock.advance(299)  # a full pass also counts as a directory pass
    step(r)
    assert st.calls == ["quick", "full"]


def test_zero_intervals_turn_the_timers_off():
    clock = Clock()
    r, st = rec_for(clock, quick=0, full=0, pause_idle=False)
    clock.advance(10 ** 6, wall=10 ** 6)
    step(r)
    assert st.calls == []
    assert r.next_wait() == store_mod.WAKE_CHECK_S  # only the wake check left


def test_requests_run_when_due():
    clock = Clock()
    r, st = rec_for(clock, quick=0, full=0)
    r.request("full", "watcher started", delay=3)
    r.request("quick", "large batch")
    step(r)
    assert st.calls == ["quick"]
    step(r)
    assert st.calls == ["quick"]
    clock.advance(3)
    step(r)
    assert st.calls == ["quick", "full"]


def test_wake_or_clock_jump_triggers_a_pass():
    clock = Clock()
    r, st = rec_for(clock, quick=0, full=0)
    r.last_activity = clock.t
    clock.advance(1, wall=3600)  # the monotonic clock stood still while asleep
    step(r)
    assert st.calls == ["quick"]  # a local volume: nothing changed while asleep but what the watcher saw
    clock.advance(1, wall=1)  # no jump: nothing
    step(r)
    assert st.calls == ["quick"]
    r.remote = True  # a network volume: others may have edited files meanwhile
    clock.advance(1, wall=3600)
    step(r)
    assert st.calls == ["quick", "full"]


def test_wake_while_idle_runs_when_a_client_returns():
    clock = Clock()
    r, st = rec_for(clock, quick=300, full=1800, remote=True)
    clock.advance(store_mod.ACTIVE_WINDOW_S + 1)
    step(r)
    clock.advance(1, wall=7200)
    step(r)
    assert st.calls == []  # nobody looking
    st.subscribers = 1
    step(r)
    assert st.calls == ["full"]


def test_root_volume_gone_and_back_triggers_passes(tmp_path):
    vol = tmp_path / "vol"
    vol.mkdir()
    clock = Clock()
    st = FakeStore()
    st.root = str(vol)
    r, _ = rec_for(clock, quick=0, full=0, store=st)
    r.last_activity = clock.t
    step(r)
    assert st.calls == []
    vol.rmdir()  # ejected
    step(r)
    assert st.calls == ["quick"]  # the directory pass empties the tree
    vol.mkdir()  # mounted again (another inode): files may have been edited elsewhere
    step(r)
    assert st.calls == ["quick", "full"]
    step(r)
    assert st.calls == ["quick", "full"]


def test_timers_pause_without_clients_and_resume():
    clock = Clock()
    r, st = rec_for(clock, quick=300, full=1800)
    clock.advance(store_mod.ACTIVE_WINDOW_S + 400)
    step(r)
    assert st.calls == []  # idle: paused
    assert r.next_wait() == store_mod.WAKE_CHECK_S
    r.touch()  # an HTTP request
    step(r)
    assert st.calls == ["quick"]
    clock.advance(store_mod.ACTIVE_WINDOW_S + 400)
    st.subscribers = 1  # an open live-update stream also counts
    step(r)
    assert st.calls == ["quick", "full"]  # the full timer fell due meanwhile


def test_no_pause_when_configured():
    clock = Clock()
    r, st = rec_for(clock, quick=300, full=0, pause_idle=False)
    clock.advance(store_mod.ACTIVE_WINDOW_S + 400)
    step(r)
    assert st.calls == ["quick"]


def test_http_requests_count_as_activity(root):
    with running(root) as c:
        rec = c.app.state.reconciler
        rec.last_activity = float("-inf")
        assert not rec.active()
        c.get("/api/tree")
        assert rec.active()


# --- the directory pass -------------------------------------------------------

@pytest.fixture
def trusted_sigs(monkeypatch):
    monkeypatch.setattr(store_mod, "RACY_NS", 0)  # trust fresh directories (tests run fast)


def test_directory_pass_catches_create_delete_rename_and_moves(root, trusted_sigs):
    write(root / "a" / "one.md", "1")
    write(root / "a" / "two.md", "22")
    write(root / "b" / "deep" / "x.md", "x")
    write(root / "c" / "keep.md", "k")
    s = make_store(root)
    time.sleep(0.01)
    write(root / "a" / "new.md", "n")
    (root / "a" / "two.md").unlink()
    os.rename(root / "a" / "one.md", root / "a" / "uno.md")
    (root / "m").mkdir()
    write(root / "m" / "inner" / "f.md", "f")
    os.rename(root / "m", root / "c" / "m")  # mkdir + move into a known directory
    os.rename(root / "b" / "deep", root / "c" / "deep")  # directory move across parents
    ch = s.quick_check()
    files, dirs = tree(s)
    assert files == {"a/new.md", "a/uno.md", "c/keep.md", "c/m/inner/f.md", "c/deep/x.md"}
    assert dirs == {"a", "b", "c", "c/m", "c/m/inner", "c/deep"}
    assert {"from": "a/one.md", "to": "a/uno.md"} in ch.renames
    assert {"from": "b/deep/x.md", "to": "c/deep/x.md"} in ch.renames
    assert ch.deleted == ["a/two.md"]


def test_directory_pass_misses_in_place_edit_full_pass_catches_it(root, trusted_sigs):
    f = write(root / "d" / "f.md", "one")
    s = make_store(root)
    old = s.get("d/f.md")
    f.write_text("three")
    os.utime(f, ns=(old.mtime_ns + 10 ** 9, old.mtime_ns + 10 ** 9))
    assert s.quick_check() is None  # the directory did not change
    ch = s.sweep()
    assert ch.modified == ["d/f.md"]
    assert s.get("d/f.md").size == 5


def test_directory_pass_relists_only_changed_directories(root, trusted_sigs, monkeypatch):
    for i in range(20):
        write(root / f"d{i}" / "f.md", "x")
    s = make_store(root)
    time.sleep(0.01)
    write(root / "d7" / "g.md", "g")
    listed = []
    real = os.scandir
    monkeypatch.setattr(store_mod.os, "scandir", lambda p: (listed.append(p), real(p))[1])
    ch = s.quick_check()
    assert ch.added == ["d7/g.md"]
    assert listed == [str(root / "d7")]
    listed.clear()
    assert s.quick_check() is None
    assert listed == []


def test_racy_directories_are_always_relisted(root):
    write(root / "d" / "f.md", "x")
    s = make_store(root)  # everything was just modified: too fresh to trust
    assert s._dir_sigs["d"] is None and s._dir_sigs[""] is None
    write(root / "d" / "g.md", "g")
    assert s.quick_check().added == ["d/g.md"]


def test_dir_sig_racy_window():
    from types import SimpleNamespace

    st = SimpleNamespace(st_mtime_ns=10 ** 9 * 100, st_ctime_ns=10 ** 9 * 100, st_ino=7)
    assert store_mod._dir_sig(st, 10 ** 9 * 101) is None
    assert store_mod._dir_sig(st, 10 ** 9 * 104) == (10 ** 9 * 100, 10 ** 9 * 100, 7)
    assert store_mod._dir_sig(st, 10 ** 9 * 99) is None  # a little ahead (clock skew): still racy
    # far in the future (a file server's clock runs ahead): trusted, not re-listed on every pass
    assert store_mod._dir_sig(st, 10 ** 9 * 20) == (10 ** 9 * 100, 10 ** 9 * 100, 7)


def test_directory_pass_respects_deny_and_ignore(root, trusted_sigs):
    write(root / "a.md", "a")
    s = make_store(root)
    time.sleep(0.01)
    write(root / "node_modules" / "x.js", "x")
    write(root / ".env", "SECRET=1")
    write(root / "ok.md", "ok")
    ch = s.quick_check()
    assert ch.added == ["ok.md"]
    files, dirs = tree(s)
    assert files == {"a.md", "ok.md"} and dirs == set()


def test_directory_pass_handles_a_removed_tree(root, trusted_sigs):
    write(root / "x" / "y" / "z.md", "z")
    write(root / "k.md", "k")
    s = make_store(root)
    import shutil

    shutil.rmtree(root / "x")
    ch = s.quick_check()
    assert ch.deleted == ["x/y/z.md"]
    assert tree(s) == ({"k.md"}, set())
    assert "x" not in s._dir_sigs and "x/y" not in s._dir_sigs


@pytest.mark.parametrize("how", ["watcher", "directory pass", "full pass"])
def test_case_only_rename_leaves_no_ghost(root, trusted_sigs, how):
    write(root / "d" / "a.md", "a")
    write(root / "d" / "Docs" / "n.md", "n")
    write(root / "k.md", "k")
    s = make_store(root)
    time.sleep(0.01)
    os.rename(root / "d" / "a.md", root / "d" / "A.md")
    os.rename(root / "d" / "Docs", root / "d" / "docs")
    if how == "watcher":  # the watcher reports both spellings, in any order
        s.apply_scopes(["d/A.md", "d/a.md"])
        s.apply_scopes(["d/Docs", "d/docs/n.md"])
        s.apply_scopes(["d/Docs/n.md"])
    elif how == "directory pass":
        s.quick_check()
    else:
        s.sweep()
    assert tree(s) == ({"d/A.md", "d/docs/n.md", "k.md"}, {"d", "d/docs"})
    # whatever runs next keeps it that way
    s.apply_scopes(["d/a.md", "d/Docs/n.md"])
    assert s.quick_check() is None and s.sweep() is None
    assert tree(s) == ({"d/A.md", "d/docs/n.md", "k.md"}, {"d", "d/docs"})


def test_old_spelling_alone_finds_the_renamed_entry(root):
    if not case_insensitive(root):
        pytest.skip("case-sensitive filesystem")
    write(root / "a.md", "a")
    s = make_store(root)
    os.rename(root / "a.md", root / "A.md")
    ch = s.apply_scopes(["a.md"])  # only the old spelling was reported
    assert tree(s)[0] == {"A.md"}
    assert ch.renames == [{"from": "a.md", "to": "A.md"}]


def test_large_directory_pass_with_one_create_is_cheap(root, trusted_sigs):
    big = root / "a" / "b" / "c" / "d" / "big"
    big.mkdir(parents=True)
    for i in range(20000):
        (big / f"f{i}.md").write_bytes(b"x")
    s = make_store(root)
    time.sleep(0.01)
    write(big / "new.md", "n")
    t0 = time.process_time()
    ch = s.quick_check()
    spent = time.process_time() - t0
    assert ch.added == ["a/b/c/d/big/new.md"]
    assert spent < 0.5, spent  # one listing of the directory, not a rescan per file


def test_cancelled_pass_commits_nothing(root):
    import threading

    write(root / "a.md", "a")
    s = make_store(root)
    for i in range(300):
        write(root / f"n{i}.md", "n")
    cancel = threading.Event()
    cancel.set()
    pace = store_mod._pacer(pause=0, cancel=cancel)
    assert s.sweep(pace) is None
    assert tree(s)[0] == {"a.md"}
    assert s.sweep() is not None  # not cancelled: the new files show


def test_sweep_and_full_scan_agree(root):
    for i in range(30):
        write(root / f"d{i % 4}" / f"s{i % 3}" / f"f{i}.md", "x" * i)
    s = make_store(root)
    write(root / "d1" / "new.md", "n")
    (root / "d2" / "s2" / "f2.md").unlink()
    s.sweep()
    fresh = make_store(root)
    assert tree(s) == tree(fresh)
    assert s.sweep() is None


def test_hidden_fast_matches_is_hidden(root):
    g = PathGuard(Settings.make(str(root), ignore=["*.tmp", "Build?"], deny=["secret*"]))
    for name in [".env", ".env.local", "node_modules", "a.md", "X.TMP", "build1", "Build12", "secret.txt",
                 "Secret.TXT", "id_rsa", "notes.pem", ".git", ".DS_Store", "café.md", "[x].md", ""]:
        assert g.is_hidden_fast(name) == g.is_hidden(name), name


def test_many_file_scopes_apply_quickly(root):
    for i in range(50):
        d = root / f"d{i}"
        d.mkdir()
        for j in range(100):
            (d / f"f{j}.md").write_text("x")
    s = make_store(root)
    for i in range(50):
        for j in range(100):
            (root / f"d{i}" / f"f{j}.md").write_text("yy")
    scopes = [f"d{i}/f{j}.md" for i in range(50) for j in range(100)]
    t0 = time.monotonic()
    ch = s.apply_scopes(scopes)
    assert len(ch.modified) == 5000
    assert time.monotonic() - t0 < 3


# --- configuration ------------------------------------------------------------

def test_backstop_intervals_defaults_and_remote(monkeypatch, root):
    monkeypatch.setattr(reconcile_mod, "mount_type", lambda p: "apfs")
    s = Settings.make(str(root))
    assert backstop_intervals(s) == (store_mod.DEFAULT_RESCAN_S, store_mod.DEFAULT_FULL_RESCAN_S, False)
    monkeypatch.setattr(reconcile_mod, "mount_type", lambda p: "smbfs")
    assert backstop_intervals(s) == (store_mod.REMOTE_RESCAN_S, store_mod.REMOTE_FULL_RESCAN_S, True)
    monkeypatch.setattr(reconcile_mod, "mount_type", lambda p: "fuse.mergerfs")  # any Linux FUSE mount
    assert backstop_intervals(s)[2] is True
    monkeypatch.setattr(reconcile_mod, "mount_type", lambda p: "fuseblk")  # ntfs-3g: a local disk
    assert backstop_intervals(s)[2] is False
    s = Settings.make(str(root), reconcile_interval=0, full_reconcile_interval=90)
    assert backstop_intervals(s) == (0.0, 90.0, False)


def test_mount_type_of_the_root_filesystem():
    assert store_mod.mount_type("/") not in ("", None) or os.name != "posix"


def test_rescan_options_from_cli_and_env(tmp_path):
    base = ["--root", str(tmp_path), "--data-dir", str(tmp_path / "data")]
    s = settings_from_args(base, env={})
    assert (s.reconcile_interval, s.full_reconcile_interval, s.rescan_when_idle) == (None, None, False)
    s = settings_from_args(base + ["--rescan-interval", "20", "--full-rescan-interval", "0", "--rescan-when-idle"],
                           env={})
    assert (s.reconcile_interval, s.full_reconcile_interval, s.rescan_when_idle) == (20.0, 0.0, True)
    env = {"DOCS_VIEWER_RESCAN_INTERVAL": "45", "DOCS_VIEWER_FULL_RESCAN_INTERVAL": "600",
           "DOCS_VIEWER_RESCAN_WHEN_IDLE": "1"}
    s = settings_from_args(base, env=env)
    assert (s.reconcile_interval, s.full_reconcile_interval, s.rescan_when_idle) == (45.0, 600.0, True)
    s = settings_from_args(base + ["--rescan-interval", "5"], env=env)  # flag beats env
    assert s.reconcile_interval == 5.0
    s = settings_from_args(base + ["--rescan-interval", "-3"], env={})
    assert s.reconcile_interval == 0.0
