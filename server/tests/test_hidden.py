"""Hidden files: git-ignored paths are shown by default and left out like ignored ones while the
folder hides them (hide_git), the store's topmost hidden items and /api/hidden,
reading ignored files and revealing denied ones on request."""

import asyncio
import os
import subprocess

import pytest
from conftest import running, wait_until, write, write_hiding

from deltadeck import git as gitmod
from deltadeck import hidden as hidden_mod
from deltadeck.config import Settings, canonical_path, settings_from_args
from deltadeck.git import GitError, GitLink
from deltadeck.hidden import GitIgnored
from deltadeck.paths import PathGuard
from deltadeck.reconcile import Reconciler, _apply_batch
from deltadeck.store import Store

GIT = gitmod.find_git("")
pytestmark = pytest.mark.skipif(GIT is None, reason="git (2.32+) not available")


@pytest.fixture(autouse=True)
def _no_user_excludes(tmp_path, monkeypatch):
    """The viewer's git calls see HOME: keep the user's own global ignore file out of the tests."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))


def g(repo, *args):
    e = {"PATH": "/usr/bin:/bin", "HOME": str(repo), "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
         "GIT_AUTHOR_NAME": "A", "GIT_AUTHOR_EMAIL": "a@example.com",
         "GIT_COMMITTER_NAME": "A", "GIT_COMMITTER_EMAIL": "a@example.com"}
    return subprocess.run([GIT, *args], cwd=repo, env=e, check=True, capture_output=True).stdout.decode()


@pytest.fixture
def repo(tmp_path):
    r = tmp_path / "repo"
    r.mkdir()
    g(r, "init", "-q", "-b", "main")
    write(r / ".gitignore", "gen/\n*.log\nobjs/*.o\n")
    write(r / "a.md", "# A zqvisibleword\n")
    write(r / "keep.log", "tracked although ignored\n")
    g(r, "add", "-A")
    g(r, "add", "-f", "keep.log")
    g(r, "commit", "-q", "-m", "first")
    write(r / "gen" / "gen.md", "zqignoredword\n")
    write(r / "gen" / "deep" / "x.py", "def zqignoredname():\n    pass\n")
    write(r / "a.log", "log zqignoredword\n")
    write(r / "objs" / "m.o", "obj\n")
    write(r / "objs" / "m.c", "int main;\n")
    write(r / "node_modules" / "pkg" / "index.js", "zqnodeword\n")
    write(r / "node_modules" / "x.js", "x\n")
    write(r / "node_modules" / ".env", "NODE=1\n")
    write(r / ".env", "SECRET=zqsecretvalue\n")
    write(r / ".deltadeck-tmp-x", "tmp\n")
    return r


def tree(c, hidden=False):
    """(files, dirs, {path: entry} of the store's topmost hidden items; the tree only counts them)."""
    t = c.get("/api/tree").json()
    store, reveal = c.app.state.store, c.app.state.settings.allow_reveal
    with store._state_lock:
        hid = {h.path: h.to_json() for h in store.hidden.values() if reveal or h.reason != "deny"}
    assert "hidden" not in t and t["hidden_count"] == len(hid)
    hid = hid if hidden else {}
    return {f["path"] for f in t["files"]}, set(t["dirs"]), hid


def scanned_store(root, **kw):
    settings = Settings.make(canonical_path(str(root)), data_dir=canonical_path(str(root.parent / "d")), **kw)
    guard = PathGuard(settings)
    ignored = GitIgnored(GitLink(settings, guard).repo, guard, enabled=True)  # "Hide git-ignored files" on
    store = Store(guard, ignored)
    ignored.refresh()
    store.full_scan()
    return store


def test_git_ignored_shown_by_default(repo):
    write(repo / ".data" / "x.md", "data\n")
    # (a data dir inside the folder also turns the hidden-file settings off: the defaults apply)
    with running(repo, data_dir=str(repo / ".data")) as c:
        files, dirs, hid = tree(c, hidden=True)
        assert files == {".gitignore", "a.md", "keep.log", "a.log", "gen/gen.md", "gen/deep/x.py", "objs/m.o",
                         "objs/m.c"}, files
        assert dirs == {"gen", "gen/deep", "objs"}
        assert set(hid) == {"node_modules", ".env"}, set(hid)
        assert c.get("/api/search?q=zqignoredword").json()["content"] != []
        assert "hidden" not in c.get("/api/file?path=gen/gen.md").json()
        cfg = c.get("/api/config").json()
        assert "hide_git" not in cfg and cfg["hiding_enabled"] is False


def test_git_ignored_hidden_and_listed(repo):
    with running(repo, hide_git=True) as c:
        files, dirs, hid = tree(c)
        assert files == {".gitignore", "a.md", "keep.log", "objs/m.c"}, files
        assert dirs == {"objs"} and hid == {}
        files2, dirs2, hid = tree(c, hidden=True)
        assert (files2, dirs2) == (files, dirs)
        assert set(hid) == {"gen", "a.log", "objs/m.o", "node_modules", ".env"}, set(hid)
        assert hid["gen"] == {"path": "gen", "name": "gen", "dir": True, "reason": "git"}
        assert hid["a.log"] == {"path": "a.log", "name": "a.log", "dir": False, "reason": "git",
                                "kind": "text", "ext": "log"}
        assert hid["node_modules"] == {"path": "node_modules", "name": "node_modules", "dir": True,
                                       "reason": "ignore", "rule": "node_modules"}
        assert hid[".env"]["reason"] == "deny" and "rule" not in hid[".env"]
        cfg = c.get("/api/config").json()
        assert cfg["reveal_enabled"] is True and "hide_git" not in cfg and cfg["hiding_enabled"] is True
        # search and completion never see ignored files
        assert c.get("/api/search?q=zqignoredword").json()["content"] == []
        assert c.get("/api/search?q=zqvisibleword").json()["content"][0]["path"] == "a.md"
        assert c.get("/api/complete", params={"prefix": "zqignored", "path": "gen/deep/x.py"}).json()["names"] == []
        # opened, a git-ignored file is shown and marked
        meta = c.get("/api/file?path=gen/gen.md").json()
        assert meta["hidden"] == "git"
        assert c.get("/api/content?path=a.log").json()["text"].startswith("log")
        assert "hidden" not in c.get("/api/file?path=a.md").json()
        assert "hidden" not in c.get("/api/file?path=keep.log").json()


def test_subfolder_root_and_ignored_root(repo):
    write(repo / "docs" / "n.md", "n\n")
    write(repo / "docs" / "n.log", "n\n")
    with running(repo / "docs", hide_git=True) as c:
        files, _, hid = tree(c, hidden=True)
        assert files == {"n.md"} and set(hid) == {"n.log"}
    with running(repo / "gen", hide_git=True) as c:  # the folder itself is ignored: git hides nothing in it
        files, dirs, hid = tree(c, hidden=True)
        assert files == {"gen.md", "deep/x.py"} and hid == {}


def test_no_git_or_git_failing(repo, monkeypatch):
    with running(repo, git="off", hide_git=True) as c:  # the toggle has no effect without git
        files, _, hid = tree(c, hidden=True)
        assert {"a.log", "gen/gen.md", "objs/m.o"} <= files
        assert set(hid) == {"node_modules", ".env"}

    def boom(self, args, **kw):
        if "ls-files" in args:
            raise GitError(504, "git took too long")
        return orig(self, args, **kw)

    orig = gitmod.GitRepo.run
    monkeypatch.setattr(gitmod.GitRepo, "run", boom)
    with running(repo, hide_git=True) as c:
        files, _, _ = tree(c)
        assert {"a.log", "gen/gen.md"} <= files


def test_gitignore_edit_hides_and_shows(repo):
    write(repo / "notes.md", "n\n")  # untracked
    store = scanned_store(repo)
    assert "notes.md" in store.entries
    write(repo / ".gitignore", "gen/\n*.log\nobjs/*.o\n*.md\n")
    ch = asyncio.run(_batch(store, [repo / ".gitignore"]))
    hc = [c for c in ch if c.hidden_changed]
    assert hc and hc[0].deleted == ["notes.md"]  # a.md is tracked: it stays
    assert "notes.md" not in store.entries and store.hidden["notes.md"].reason == "git"
    assert "a.md" in store.entries
    write(repo / ".gitignore", "*.log\nobjs/*.o\n")
    ch = asyncio.run(_batch(store, [repo / ".gitignore"]))
    added = {p for c in ch for p in c.added}
    assert {"notes.md", "gen/gen.md", "gen/deep/x.py"} <= added
    assert "gen" not in store.hidden and "gen/deep" in store.dirs


async def _batch(store, paths):
    got = []

    async def on_change(ch):
        got.append(ch)

    await _apply_batch(store, on_change, [(1, str(p)) for p in paths], None)
    return got


def test_new_ignored_folder_not_walked(repo):
    store = scanned_store(repo)
    write(repo / "sub" / "gen" / "big" / "f.md", "x\n")  # a new build output below a new folder
    write(repo / "sub" / "ok.md", "x\n")
    ch = store.apply_scopes(["sub"])
    assert ch is not None and ch.hidden_changed and ch.added == ["sub/ok.md"]
    assert store.hidden["sub/gen"].reason == "git"
    assert not any(p.startswith("sub/gen") for p in store.entries) and "sub/gen" not in store.dirs
    write(repo / "new.log", "x\n")  # a new ignored file reported by the watcher
    asyncio.run(_batch(store, [repo / "new.log"]))
    assert "new.log" not in store.entries and store.hidden["new.log"].reason == "git"
    # events inside hidden folders are dropped
    write(repo / "gen" / "late.md", "x\n")
    assert asyncio.run(_batch(store, [repo / "gen" / "late.md", repo / "node_modules" / "x.js"])) == []


def test_gitignore_inside_hidden_folder_not_asked(repo, monkeypatch):
    store = scanned_store(repo)
    asked = []
    monkeypatch.setattr(store, "refresh_ignored", lambda: asked.append(1))
    write(repo / "node_modules" / "pkg" / ".gitignore", "*\n")
    write(repo / "gen" / ".gitignore", "*\n")
    asyncio.run(_batch(store, [repo / "node_modules" / "pkg" / ".gitignore", repo / "gen" / ".gitignore"]))
    assert asked == []
    asyncio.run(_batch(store, [repo / ".gitignore"]))
    asyncio.run(_batch(store, [repo / ".git" / "info" / "exclude"]))  # inside .git, but git reads it
    assert asked == [1, 1]


def test_backstop_pass_picks_up_parent_gitignore(repo):
    write(repo / "docs" / "gen.txt", "x\n")
    store = scanned_store(repo / "docs")
    assert "gen.txt" in store.entries
    write(repo / ".gitignore", "docs/gen.txt\n")
    got = []

    async def on_change(ch):
        got.append(ch)

    rec = Reconciler(store, on_change, quick_interval=0, full_interval=0, pace=False)
    rec.request("quick", "test")
    asyncio.run(rec.run_once())
    assert any("gen.txt" in c.deleted and c.hidden_changed for c in got)
    assert store.hidden["gen.txt"].reason == "git"


def test_seen_refuses_git_ignored(repo, tmp_path):
    from test_roots import canon, outer, post

    write_hiding(repo, tmp_path / "seen-data", hide_git=True)
    with outer(repo, tmp_path / "seen-data") as c:
        root = canon(repo)
        r = post(c, "/api/seen/commit", {"root": root, "path": "a.log", "mtime": 1, "size": 1})
        assert r.status_code == 403, r.text
        r = post(c, "/api/seen/commit", {"root": root, "path": "a.md", "mtime": 1, "size": 1})
        assert r.status_code == 200, r.text
        r = post(c, "/api/seen/get", {"root": root, "paths": ["a.log", "gen/gen.md", "a.md"]})
        assert [x["path"] for x in r.json()["records"]] == ["a.md"]


def test_hidden_listing(repo, monkeypatch):
    with running(repo, hide_git=True) as c:
        r = c.get("/api/hidden?path=node_modules").json()
        assert r["path"] == "node_modules" and r["reason"] == "ignore" and r["truncated"] is False
        ents = {e["name"]: e for e in r["entries"]}
        assert [e["name"] for e in r["entries"]] == ["pkg", ".env", "x.js"]
        assert ents["pkg"] == {"path": "node_modules/pkg", "name": "pkg", "dir": True, "reason": "ignore"}  # inherited
        assert ents[".env"]["reason"] == "deny" and ents["x.js"]["size"] == 2 and "mtime" in ents["x.js"]
        r = c.get("/api/hidden?path=gen").json()
        assert r["reason"] == "git" and {e["name"]: e["reason"] for e in r["entries"]} == {"deep": "git",
                                                                                          "gen.md": "git"}
        assert c.get("/api/hidden?path=gen/deep").json()["entries"][0]["path"] == "gen/deep/x.py"
        assert c.get("/api/hidden?path=objs").status_code == 400  # visible
        assert c.get("/api/hidden?path=.git").status_code == 403
        assert c.get("/api/hidden?path=nope").status_code == 404
        assert c.get("/api/hidden").status_code == 400
        monkeypatch.setattr(hidden_mod, "HIDDEN_LIST_MAX", 2)
        r = c.get("/api/hidden?path=node_modules").json()
        assert r["truncated"] is True and [e["name"] for e in r["entries"]] == ["pkg", ".env"]



def test_hidden_listing_inherited_and_choices(repo, tmp_path):
    write(repo / "node_modules" / "__pycache__" / "d.js", "d\n")
    dd = tmp_path / "data"
    write_hiding(repo, dd, hide_git=True, hide=["gen/gen.md"])
    with running(repo, data_dir=str(dd), ignore=["*.js"]) as c:
        ents = {e["name"]: e for e in c.get("/api/hidden?path=node_modules").json()["entries"]}
        assert ents["pkg"] == {"path": "node_modules/pkg", "name": "pkg", "dir": True, "reason": "ignore"}
        # an item's own entry is named; one the folder passes down is not
        assert ents["__pycache__"] == {"path": "node_modules/__pycache__", "name": "__pycache__", "dir": True,
                                       "reason": "ignore", "rule": "__pycache__"}
        assert ents["x.js"]["rule"] == "*.js" and ents["x.js"]["extra"] is True
        ents = {e["name"]: e for e in c.get("/api/hidden?path=gen").json()["entries"]}
        assert ents["deep"] == {"path": "gen/deep", "name": "deep", "dir": True, "reason": "git"}
        assert ents["gen.md"]["reason"] == "user" and ents["gen.md"]["choice"] == "hide"

def test_reveal(repo):
    with running(repo) as c:
        assert c.get("/api/content?path=.env").status_code == 403
        r = c.get("/api/content?path=.env&reveal=1")
        assert r.status_code == 200 and "zqsecretvalue" in r.json()["text"]
        assert r.headers["cache-control"] == "no-store"
        r = c.get("/api/file?path=.env&reveal=1")
        assert r.json()["hidden"] == "deny" and r.headers["cache-control"] == "no-store"
        assert c.get("/api/text?path=.env&reveal=1").status_code == 200
        assert c.get("/api/content?path=node_modules/.env&reveal=1").status_code == 200
        cross = {"Sec-Fetch-Site": "cross-site"}
        assert c.get("/api/content?path=.env&reveal=1", headers=cross).status_code == 403
        for ep in ("/api/raw", "/api/csv", "/api/docx", "/api/pdf", "/api/xlsx"):
            r = c.get(ep, params={"path": ".env", "reveal": "1"})
            assert r.status_code == 403 and b"zqsecretvalue" not in r.content, ep
        # ignore-list files are readable without reveal
        assert c.get("/api/file?path=node_modules/x.js").json()["hidden"] == "ignore"
        assert c.get("/api/raw?path=node_modules/x.js").status_code == 200
        assert c.get("/api/content?path=.git/config").status_code == 403
        assert c.get("/api/content?path=.git/config&reveal=1").status_code == 403
        assert c.get("/api/content?path=.deltadeck-tmp-x&reveal=1").status_code == 403
    with running(repo, allow_reveal=False) as c:
        assert c.get("/api/config").json()["reveal_enabled"] is False
        assert c.get("/api/content?path=.env&reveal=1").status_code == 403
        _, _, hid = tree(c, hidden=True)
        assert ".env" not in hid and "node_modules" in hid
        names = {e["name"] for e in c.get("/api/hidden?path=node_modules").json()["entries"]}
        assert names == {"pkg", "x.js"}


def test_edit_refuses_hidden(repo, tmp_path):
    from conftest import editing

    with editing(repo, tmp_path / "edit-data", hide_git=True) as c:
        for rel in (".env", "node_modules/x.js"):
            r = c.put("/api/edit/file", json={"path": rel, "content": "x", "base_sha256": None})
            assert r.status_code == 403, (rel, r.status_code, r.text)
        r = c.put("/api/edit/file", json={"path": "a.log", "content": "x", "base_sha256": None})
        assert r.status_code != 403  # git-ignored files stay editable


def test_no_reveal_flag():
    s = settings_from_args(["--no-reveal"], env={})
    assert s.allow_reveal is False
    assert settings_from_args([], env={"DELTADECK_NO_REVEAL": "1"}).allow_reveal is False
    assert settings_from_args([], env={}).allow_reveal is True


def test_watch_follows_gitignore(repo):
    write(repo / "notes.md", "n\n")
    with running(repo, watch=True, hide_git=True) as c:
        assert "notes.md" in tree(c)[0]
        write(repo / ".gitignore", "gen/\n*.log\nobjs/*.o\nnotes.md\n")
        wait_until(lambda: "notes.md" not in tree(c)[0], timeout=15)
        assert tree(c, hidden=True)[2]["notes.md"]["reason"] == "git"


def test_folder_of_ignored_files_stays_visible(repo):
    write(repo / "logs" / "only.log", "x\n")  # git lists "logs/" and "logs/only.log" for this
    store = scanned_store(repo)
    assert "logs" in store.dirs and store.hidden["logs/only.log"].reason == "git"
    write(repo / "logs" / "new.md", "x\n")
    ch = asyncio.run(_batch(store, [repo / "logs" / "new.md"]))
    assert ch and ch[0].added == ["logs/new.md"]


def test_set_enabled_does_not_wait_for_a_git_query():
    """An update flips hide_git while a git query runs (the dialog's listing, a scoped query for new
    paths): it must not wait for git."""
    import threading
    import time

    ig = GitIgnored(lambda: None)
    ig.paths = frozenset({"logs"})
    with ig._lock:  # a query in progress
        t0 = time.monotonic()
        out: list = []
        th = threading.Thread(target=lambda: out.append(ig.set_enabled(True, refresh=False)))
        th.start()
        th.join(1.0)
        assert out == [{"logs"}] and time.monotonic() - t0 < 0.5
    assert ig.enabled
    assert ig.set_enabled(True, refresh=False) == set()
    assert ig.set_enabled(False) == {"logs"}
