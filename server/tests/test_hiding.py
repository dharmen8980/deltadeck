"""Per-folder hidden-file settings (hiding.py, /api/hiding*): rule syntax, persistence in the data
dir (never the folder, v1 files migrated), the gate, per-path show and hide choices and how they
rank against the ignore list, user patterns, git and the deny list, built-in entries never hiding
tracked files, the git-ignored group, the Hidden files listing and counts, live changes, and how
user-hidden files behave elsewhere."""

import asyncio
import json
import os
import stat
import subprocess

import pytest
from conftest import snapshot_fs, wait_until, write, write_hiding, write_hiding_v1
from test_roots import canon, outer, post

from deltadeck import git as gitmod
from deltadeck import hidden as hidden_mod
from deltadeck import hiding as hiding_mod
from deltadeck.app import create_app
from deltadeck.config import DEFAULT_IGNORE, Settings
from deltadeck.hiding import (
    HIDING_FILE,
    MAX_CHOICES,
    MAX_PATHS,
    MAX_RULES,
    HidingPrefs,
    RuleError,
    UserRules,
    load_prefs,
    parse_rule,
    prefs_path,
)
from deltadeck.hiding import _escape_path as escape_path
from deltadeck.reconcile import _apply_batch

GIT = gitmod.find_git("")
needs_git = pytest.mark.skipif(GIT is None, reason="git (2.32+) not available")


@pytest.fixture(autouse=True)
def _no_user_excludes(tmp_path, monkeypatch):
    """The viewer's git calls see HOME: keep the user's own global ignore file out of the tests."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))


# -- rule syntax -----------------------------------------------------------------------------------

def test_parse_rule_kinds_and_normalisation():
    r = parse_rule("  *.log ")
    assert (r.text, r.kind, r.parts) == ("*.log", "name", ("*.log",))
    assert parse_rule("fixtures/").kind == "name" and parse_rule("fixtures/").text == "fixtures"
    r = parse_rule("./docs/old/")
    assert (r.text, r.kind, r.parts) == ("docs/old", "anchored", ("docs", "old"))
    r = parse_rule("/Docs/OLD")
    assert (r.text, r.kind, r.parts) == ("/Docs/OLD", "anchored", ("docs", "old"))
    assert parse_rule("Ｄｏｃｓ").parts == ("docs",)  # NFKC + casefold
    assert parse_rule("packages/*/dist").parts == ("packages", "*", "dist")


@pytest.mark.parametrize("bad", ["", "   ", "/", "*", "/*", "*/", "./*", "a\0b", "a\\b", "a\x01b", "a\nb",
                                 ".", "..", "/a/../b", "a//b", "./", "x" * 513, "!keep", "a/**/b", 3, None])
def test_parse_rule_rejects(bad):
    with pytest.raises(RuleError):
        parse_rule(bad)


def test_escape_path_round_trip():
    rule = parse_rule(escape_path("notes/a[1]*?.md"))
    assert rule.text == "/notes/a[[]1][*][?].md"
    u = UserRules([rule])
    assert u.covers("notes/a[1]*?.md") == rule.text
    assert u.covers("NOTES/A[1]*?.MD") == rule.text  # folded like every name rule
    assert u.covers("notes/a1x.md") is None and u.covers("notes/a[1]xy.md") is None
    assert u.literal == {"notes/a[1]*?.md": rule.text}  # escaped names are plain lookups


def test_escape_path_keeps_trailing_whitespace():
    rule = parse_rule(escape_path("notes "))  # parse_rule strips typed rules; the space is bracketed
    assert rule.text == "/notes[ ]"
    u = UserRules([rule])
    assert u.covers("notes ") == rule.text and u.covers("notes") is None
    assert u.literal == {"notes ": rule.text}


def test_user_rules_matching():
    u = UserRules([parse_rule(t) for t in ("*.log", "/docs/old", "packages/*/dist", "fixtures")])
    assert u.covers("x.log") == "*.log" and u.covers("a/b/c.LOG") == "*.log"
    assert u.covers("docs/old") == "/docs/old" and u.covers("docs/old/a/b.md") == "/docs/old"
    assert u.covers("docs/older") is None and u.covers("x/docs/old") is None
    assert u.covers("packages/web/dist/a.js") == "packages/*/dist"
    assert u.covers("packages/dist") is None and u.covers("packages/a/b/dist") is None
    assert u.covers("a/fixtures/x.md") == "fixtures" and u.covers("fixtures") == "fixtures"
    assert u.rule_for("fixtures/x.md") is None and u.rule_for("fixtures") == "fixtures"
    # the topmost rule wins
    assert UserRules([parse_rule("old"), parse_rule("/docs")]).covers("docs/old/x") == "/docs"
    assert UserRules().empty() and UserRules().covers("a") is None


# -- fixtures --------------------------------------------------------------------------------------

@pytest.fixture
def tree(root):
    write(root / "a.md", "# A zqvisibleword\n")
    write(root / "docs" / "keep.md", "keep\n")
    write(root / "docs" / "old" / "x.md", "zqoldword\n")
    write(root / "docs" / "old" / "sub" / "y.py", "def zqoldname():\n    pass\n")
    write(root / "x.log", "zqlogword\n")
    write(root / "sub" / "y.log", "y\n")
    write(root / "venv" / "out.js", "zqbuildword\n")
    write(root / "node_modules" / "p.js", "p\n")
    write(root / ".env", "SECRET=1\n")
    return root


@pytest.fixture
def c(tmp_path, tree):
    with outer(tree, tmp_path / "data") as client:
        client.root = canon(tree)
        wait_until(lambda: not client.sw.app.state.index.indexing, timeout=10)
        yield client


def upd(c, body=None, **kw):
    return post(c, "/api/hiding/update", {"root": c.root, **(body or {})}, **kw)


def state(c):
    r = c.get("/api/hiding", params={"root": c.root})
    assert r.status_code == 200, r.text
    assert r.headers["cache-control"] == "no-store"
    return r.json()


def files(c):
    """(the tree's file paths, {path: entry} of the store's topmost hidden items)."""
    t = c.get("/api/tree").json()
    store = c.sw.app.state.store
    with store._state_lock:
        hid = {h.path: h.to_json() for h in store.hidden.values()}
    assert t["hidden_count"] == len(hid)
    return {f["path"] for f in t["files"]}, hid


def items(c, **headers):
    r = c.get("/api/hiding/items", params={"root": c.root}, headers=headers)
    assert r.status_code == 200, r.text
    assert r.headers["cache-control"] == "no-store"
    return r.json()


def rows(c):
    return {r["path"]: r for r in items(c)["rows"]}


def counts(c, *paths):
    r = c.get("/api/hiding/count", params={"root": c.root, "path": list(paths)})
    assert r.status_code == 200, r.text
    assert r.headers["cache-control"] == "no-store"
    return r.json()["counts"]


def search(c, q):
    c.sw.app.state.index_flush(10)  # a hide or show updates the index in the background
    return [x["path"] for x in c.get("/api/search", params={"q": q}).json()["content"]]


def drain(q):
    out = []
    while not q.empty():
        out.append(q.get_nowait())
    return out




# -- persistence -----------------------------------------------------------------------------------

def test_state_defaults(c):
    s = state(c)
    assert s["root"] == c.root and s["enabled"] is True and s["disabled_reason"] is None
    assert s["hide_git"] is False and s["rules"] == [] and s["show"] == [] and s["hide"] == []
    assert s["extra"] == [] and s["version"] == 0
    assert s["always"] == [".git", ".deltadeck-tmp-*", ".ldv-tmp-*"]
    assert "builtin" not in s and "ignore_patterns" not in s
    assert ".env" in s["deny"]
    assert s["limits"] == {"max_rules": MAX_RULES, "max_rule_len": 512, "max_add": 100,
                           "max_paths": MAX_PATHS, "max_choices": MAX_CHOICES}
    cfg = c.get("/api/config").json()
    assert cfg["hiding_enabled"] is True and "hide_git" not in cfg
    assert {"venv", ".venv", "__pycache__", "node_modules"} <= set(cfg["ignore_patterns"])
    assert not {"build", "dist", "out", "release", "*.pyc"} & set(cfg["ignore_patterns"])
    assert ".claude" not in cfg["ignore_patterns"] and ".github" not in cfg["ignore_patterns"]


def test_saved_in_the_data_dir_only(c, tmp_path, tree):
    before = snapshot_fs(tree)
    r = upd(c, {"add_rules": ["*.log"], "hide": ["docs/old"], "show": ["venv"]})
    assert r.status_code == 200, r.text
    assert snapshot_fs(tree) == before  # nothing written into the folder
    settings = c.sw.app.state.settings
    path = prefs_path(settings)
    assert path == os.path.join(settings.store_dir, HIDING_FILE)
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    assert stat.S_IMODE(os.stat(settings.store_dir).st_mode) == 0o700
    data = json.loads(open(path).read())
    assert data == {"version": 2, "root": c.root, "hide_git": False, "rules": ["*.log"],
                    "show": ["venv"], "hide": ["docs/old"]}
    assert not [n for n in os.listdir(settings.store_dir) if ".tmp-" in n]


def test_prefs_survive_a_restart_and_stale_or_bad_files(tmp_path, tree):
    dd = tmp_path / "data"
    with outer(tree, dd) as c:
        c.root = canon(tree)
        assert upd(c, {"add_rules": ["*.log"], "hide": ["docs/old"], "show": ["venv"]}).status_code == 200
    with outer(tree, dd) as c:
        c.root = canon(tree)
        s = state(c)
        assert (s["rules"], s["show"], s["hide"]) == (["*.log"], ["venv"], ["docs/old"])
        visible, _ = files(c)
        assert "x.log" not in visible and "venv/out.js" in visible and "docs/old/x.md" not in visible
    s = Settings.make(str(tree), data_dir=str(dd))
    p = prefs_path(s)
    with open(p, "w") as f:  # written for another folder (a moved data dir): ignored
        json.dump({"version": 2, "root": "/elsewhere", "rules": ["*.md"], "hide_git": True}, f)
    assert load_prefs(s) == HidingPrefs()
    for bad in ("{not json", "[]", "null"):
        with open(p, "w") as f:
            f.write(bad)
        assert load_prefs(s) == HidingPrefs()
    with open(p, "w") as f:  # invalid entries dropped, unknown keys ignored; in both lists: hidden
        json.dump({"version": 2, "root": s.root, "rules": ["*.log", "..", 7, "*.LOG", "/a"], "hide_git": "yes",
                   "show": ["venv", "../x", 3, ".git/x", "a.md", "", "venv"], "hide": ["A.md", "docs"],
                   "future": 1}, f)
    assert load_prefs(s) == HidingPrefs(False, ("*.log", "/a"), ("venv",), ("A.md", "docs"))


def test_migrate_v1(tmp_path, tree, caplog):
    dd = tmp_path / "data"
    p = write_hiding_v1(tree, dd, hide_git=True, rules=["*.log", "/docs/old", "/notes/a[[]1].md", "/x/*"],
                        builtin_off=["venv"], builtin_on=["dist"])
    raw = open(p, "rb").read()
    with caplog.at_level("INFO", logger="deltadeck"):
        with outer(tree, dd) as c:
            c.root = canon(tree)
            s = state(c)
            assert s["rules"] == ["*.log", "/x/*"]  # glob rules stay
            assert s["hide"] == ["docs/old", "notes/a[1].md"] and s["show"] == []  # literal rules: hide
            assert s["hide_git"] is True
            visible, hid = files(c)
            assert "venv/out.js" not in visible  # builtin_off dropped
            assert hid["docs/old"]["reason"] == "user" and hid["docs/old"]["choice"] == "hide"
            assert open(p, "rb").read() == raw  # opening does not rewrite it
            assert upd(c, {"add_rules": ["*.tmp"]}).status_code == 200
    assert "built-in switches are gone" in caplog.text
    data = json.loads(open(p).read())
    assert data == {"version": 2, "root": canon(tree), "hide_git": True, "rules": ["*.log", "/x/*", "*.tmp"],
                    "show": [], "hide": ["docs/old", "notes/a[1].md"]}


def test_two_apps_sharing_a_data_dir_merge(tmp_path, tree):
    dd = str(tmp_path / "data")
    a1 = create_app(Settings.make(str(tree), data_dir=dd, watch=False, ui_dir=dd + "-no-ui"))
    a2 = create_app(Settings.make(str(tree), data_dir=dd, watch=False, ui_dir=dd + "-no-ui"))
    a1.state.hiding.update(add_rules=["*.log"], hide=["docs/old"])
    a2.state.hiding.update(add_rules=["*.tmp"], show=["venv"])  # re-reads before writing
    assert load_prefs(a1.state.settings) == HidingPrefs(False, ("*.log", "*.tmp"), ("venv",), ("docs/old",))


def test_disabled_when_the_data_dir_overlaps(tmp_path, tree):
    before = snapshot_fs(tree)
    with outer(tree, tree / ".data") as c:
        c.root = canon(tree)
        s = state(c)
        assert s["enabled"] is False and "overlaps" in s["disabled_reason"] and s["rules"] == []
        assert c.get("/api/config").json()["hiding_enabled"] is False
        r = upd(c, {"add_rules": ["*.log"]})
        assert r.status_code == 409 and "overlaps" in r.json()["detail"]
        r = upd(c, {"show": ["venv"]})
        assert r.status_code == 409
        assert "venv" in rows(c)  # the GETs still work
        assert counts(c, "venv") == {"venv": {"files": 1, "more": False}}
    assert not (tree / ".data").exists() or not list((tree / ".data").rglob(HIDING_FILE))
    assert {k for k in snapshot_fs(tree) if not k.startswith(".data")} == set(before)


# -- the gate --------------------------------------------------------------------------------------

def test_gate(c, tree):
    body = {"add_rules": ["*.log"]}
    for tok in (False, "wrong"):
        assert upd(c, body, token=tok).status_code == 403
    for h in ({"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": "same-site"}, {"Origin": "http://evil.example"},
              {"Origin": "null"}, {"Content-Type": "text/plain"}):
        r = upd(c, body, **h)
        assert r.status_code == 403, h
    assert upd(c, body, Host="evil.example").status_code == 400
    h = {"Content-Type": "application/json", "X-Root-Token": c.root_token}
    big = json.dumps({"root": c.root, "add_rules": ["x" * 500] * 100, "pad": "y" * 70000})
    assert c.post("/api/hiding/update", content=big, headers=h).status_code == 413
    assert c.put("/api/hiding/update", content="{}", headers=h).status_code == 405
    for route, params in (("/api/hiding", {}), ("/api/hiding/items", {}), ("/api/hiding/count", {"path": "venv"})):
        r = c.get(route, params={"root": c.root, **params}, headers={"Sec-Fetch-Site": "cross-site"})
        assert r.status_code == 403, route
        r = c.get(route, params={"root": c.root, **params}, headers={"Origin": "http://evil.example"})
        assert r.status_code == 403, route
        assert c.get(route, params={"root": "/elsewhere", **params}).status_code == 409, route
    assert state(c)["rules"] == []  # nothing got through
    assert "x.log" in files(c)[0]
    # wrong root / no folder
    assert post(c, "/api/hiding/update", {"root": "/elsewhere", **body}).status_code == 409
    r = upd(c, body, **{"Sec-Fetch-Site": "same-origin", "Origin": "http://127.0.0.1:8765"})
    assert r.status_code == 200


def test_no_folder(tmp_path):
    with outer(None, tmp_path / "data") as c:
        for route in ("/api/hiding", "/api/hiding/items"):
            r = c.get(route, params={"root": "/x"})
            assert r.status_code == 409 and r.json()["detail"] == "no folder selected"
        assert c.get("/api/hiding/count", params={"root": "/x", "path": "a"}).status_code == 409
        r = post(c, "/api/hiding/update", {"root": "/x", "hide_git": True})
        assert r.status_code == 409 and r.json()["detail"] == "no folder selected"
        cfg = c.get("/api/config").json()
        assert cfg["hiding_enabled"] is False and "hide_git" not in cfg


def test_bad_updates(c):
    for body, frag in (({}, "nothing"), ({"add_rules": ["*"]}, "everything"), ({"add_rules": ["a/../b"]}, "'..'"),
                       ({"hide": ["."]}, "path"), ({"hide": [""]}, "path"), ({"show": ["../x"]}, "path"),
                       ({"hide": ["a\\b"]}, "path"), ({"show": ["/a.md"]}, "path")):
        r = upd(c, body)
        assert r.status_code == 400, (body, r.text)
        assert frag in r.json()["detail"], (body, r.json())
    r = upd(c, {"add_rules": ["ok", "a\0b"]})
    assert r.json()["rule"] == "a\0b" and state(c)["rules"] == []  # all or nothing
    r = upd(c, {"hide": ["a.md"], "show": ["../x"]})
    assert r.status_code == 400 and r.json()["path"] == "../x" and state(c)["hide"] == []
    assert upd(c, {"add_rules": [f"r{i}" for i in range(101)]}).status_code == 422
    assert upd(c, {"hide_git": "yes"}).status_code == 422
    assert upd(c, {"show": "venv"}).status_code == 422
    for i in range(MAX_RULES // 100):
        assert upd(c, {"add_rules": [f"zz{i}-{j}" for j in range(100)]}).status_code == 200
    r = upd(c, {"add_rules": ["one-too-many"]})
    assert r.status_code == 400 and "500" in r.json()["detail"]
    r = upd(c, {"remove_rules": ["nope"]})  # unknown: a no-op
    assert r.status_code == 200 and r.json()["applied"] == {"hidden": [], "shown": []}


@pytest.mark.parametrize("body", [{"builtin": {"venv": False}}, {"hide_paths": ["docs/old"]}, {"future": 1}])
def test_update_rejects_removed_fields(c, body):
    r = upd(c, body)
    assert r.status_code == 422, r.text
    assert state(c)["version"] == 0


def test_limits(c):
    r = upd(c, {"hide": [f"p{i}" for i in range(MAX_PATHS + 1)]})
    assert r.status_code == 400 and str(MAX_PATHS) in r.json()["detail"]
    r = upd(c, {"hide": [f"p{i}" for i in range(300)], "show": [f"q{i}" for i in range(201)]})
    assert r.status_code == 400
    r = upd(c, {"show": ["venv"], "hide": ["VENV"]})
    assert r.status_code == 400 and "show and hide" in r.json()["detail"] and r.json()["path"] == "venv"
    for i in range(MAX_CHOICES // MAX_PATHS):
        r = upd(c, {"hide": [f"n{i}-{j}.md" for j in range(MAX_PATHS)]})
        assert r.status_code == 200, r.text
    r = upd(c, {"hide": ["one-more.md"]})
    assert r.status_code == 400 and str(MAX_CHOICES) in r.json()["detail"]
    assert len(state(c)["hide"]) == MAX_CHOICES


def test_read_only_and_lock_root(tmp_path, tree):
    before = snapshot_fs(tree)
    with outer(tree, tmp_path / "data", lock_root=True) as c:  # allow_edit is off: read-only
        c.root = canon(tree)
        assert c.get("/api/config").json()["edit_enabled"] is False
        r = upd(c, {"hide": ["docs/old"], "show": ["venv"], "add_rules": ["*.log"]})
        assert r.status_code == 200, r.text
        s = state(c)
        assert s["hide"] == ["docs/old"] and s["show"] == ["venv"]
        visible, _ = files(c)
        assert "docs/old/x.md" not in visible and "venv/out.js" in visible
        assert items(c)["rows"]
    assert snapshot_fs(tree) == before


# -- live ------------------------------------------------------------------------------------------

def test_hide_and_unhide_a_folder_live(c):
    store = c.sw.app.state.store
    q = store.subscribe()
    assert search(c, "zqoldword") == ["docs/old/x.md"]
    r = upd(c, {"hide": ["docs/old"], "client": "tab-1"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["hide"] == ["docs/old"] and body["rules"] == [] and body["version"] == 1
    assert body["applied"] == {"hidden": ["docs/old/sub/y.py", "docs/old/x.md"], "shown": []}
    events = drain(q)
    change = next(e for e in events if isinstance(e, dict))
    assert sorted(change["deleted"]) == ["docs/old/sub/y.py", "docs/old/x.md"] and change["hidden_changed"]
    hiding = [e for e in events if isinstance(e, tuple) and e[0] == "hiding"]
    assert len(hiding) == 1 and hiding[0][1]["hide"] == ["docs/old"] and hiding[0][1]["client"] == "tab-1"
    assert events.index(change) < events.index(hiding[0])  # "change" first
    visible, hid = files(c)
    assert not any(p.startswith("docs/old") for p in visible) and "docs/keep.md" in visible
    assert hid["docs/old"] == {"path": "docs/old", "name": "old", "dir": True, "reason": "user", "choice": "hide"}
    assert search(c, "zqoldword") == []
    listing = c.get("/api/hidden", params={"path": "docs/old"}).json()
    assert listing["reason"] == "user"
    assert {e["name"]: (e["reason"], e.get("rule"), e.get("choice")) for e in listing["entries"]} == {
        "sub": ("user", None, None), "x.md": ("user", None, None)}
    assert rows(c)["docs/old"] == {"path": "docs/old", "name": "old", "dir": True, "group": "user",
                                   "visible": False, "choice": "hide"}
    # checked again: the choice goes away (no show is stored)
    r = upd(c, {"show": ["docs/old"]})
    assert r.json()["applied"] == {"hidden": [], "shown": ["docs/old/sub/y.py", "docs/old/x.md"]}
    assert r.json()["hide"] == [] and r.json()["show"] == []
    events = drain(q)
    change = next(e for e in events if isinstance(e, dict))
    assert sorted(change["added"]) == ["docs/old/sub/y.py", "docs/old/x.md"]
    assert "docs/old/x.md" in files(c)[0] and "docs/old" not in files(c)[1]
    assert search(c, "zqoldword") == ["docs/old/x.md"]
    assert store.dirs >= {"docs/old", "docs/old/sub"}


def test_checking_own_rule_removes_it(c):
    assert upd(c, {"hide": ["a.md"]}).json()["applied"]["hidden"] == ["a.md"]
    assert files(c)[1]["a.md"]["choice"] == "hide"
    r = upd(c, {"show": ["A.md"]})  # matched folded
    assert r.json()["hide"] == [] and r.json()["show"] == [] and r.json()["applied"]["shown"] == ["a.md"]
    assert "a.md" in files(c)[0]
    r = upd(c, {"show": ["a.md"]})  # visible already: nothing stored
    assert r.json()["show"] == [] and r.json()["applied"] == {"hidden": [], "shown": []}


def test_name_glob_rule(c, tree):
    r = upd(c, {"add_rules": ["*.log"]})
    assert r.json()["applied"]["hidden"] == ["sub/y.log", "x.log"]
    visible, hid = files(c)
    assert "x.log" not in visible and hid["x.log"]["rule"] == "*.log" and hid["sub/y.log"]["reason"] == "user"
    assert search(c, "zqlogword") == []
    write(tree / "sub" / "new.log", "n\n")
    ch = c.sw.app.state.store.apply_scopes(["sub/new.log"])  # what the watcher reports
    assert ch is not None and ch.added == [] and c.sw.app.state.store.hidden["sub/new.log"].rule == "*.log"
    assert c.get("/api/file", params={"path": "x.log"}).json()["hidden"] == "user"
    assert c.get("/api/content", params={"path": "x.log"}).json()["text"] == "zqlogword\n"  # still readable
    # one item shown although the pattern matches it
    r = upd(c, {"show": ["x.log"]})
    assert r.json()["applied"]["shown"] == ["x.log"] and r.json()["show"] == ["x.log"]
    assert rows(c)["x.log"] == {"path": "x.log", "name": "x.log", "dir": False, "group": "user", "visible": True,
                                "rule": "*.log", "choice": "show", "kind": "text", "ext": "log"}
    r = upd(c, {"remove_rules": ["*.LOG"]})  # matched by folded text
    assert r.json()["applied"]["shown"] == ["sub/new.log", "sub/y.log"] and r.json()["rules"] == []


# -- built-in entries and choices ------------------------------------------------------------------

def test_build_output_not_built_in(tmp_path, root):
    """The built-in list is kept basic: build output folders show unless you hide them."""
    for name in ("build", "dist", "out", "release", "target", "coverage", "*.pyc"):
        assert name not in DEFAULT_IGNORE
    write(root / "a.md", "a\n")
    write(root / "build" / "out.js", "b\n")
    write(root / "dist" / "main.js", "m\n")
    write(root / "pkg" / "__pycache__" / "m.cpython-312.pyc", "c\n")
    write(root / "pkg" / "m.pyc", "c\n")
    with outer(root, tmp_path / "data") as c:
        c.root = canon(root)
        visible, hid = files(c)
        assert visible == {"a.md", "build/out.js", "dist/main.js", "pkg/m.pyc"}
        assert set(hid) == {"pkg/__pycache__"} and hid["pkg/__pycache__"]["rule"] == "__pycache__"


def test_builtin_entries(c, tree):
    visible, hid = files(c)
    assert "venv/out.js" not in visible and hid["venv"] == {"path": "venv", "name": "venv", "dir": True,
                                                             "reason": "ignore", "rule": "venv"}
    assert rows(c)["venv"] == {"path": "venv", "name": "venv", "dir": True, "group": "builtin",
                                "visible": False, "rule": "venv"}
    r = upd(c, {"show": ["venv"]})
    assert r.json()["applied"]["shown"] == ["venv/out.js"] and r.json()["show"] == ["venv"]
    assert "venv" in c.get("/api/config").json()["ignore_patterns"]  # the list itself is unchanged
    assert "venv/out.js" in files(c)[0] and search(c, "zqbuildword") == ["venv/out.js"]
    assert c.get("/api/hidden", params={"path": "venv"}).status_code == 400  # visible now
    assert rows(c)["venv"] == {"path": "venv", "name": "venv", "dir": True, "group": "builtin",
                                "visible": True, "rule": "venv", "choice": "show"}
    r = upd(c, {"hide": ["VENV"]})  # unchecked: back to the default, nothing stored
    assert r.json()["applied"]["hidden"] == ["venv/out.js"] and search(c, "zqbuildword") == []
    assert r.json()["show"] == [] and r.json()["hide"] == []


def test_show_choice_beats_builtin(c, tree):
    write(tree / "node_modules" / "foo" / "i.js", "zqfooword\n")
    write(tree / "node_modules" / "bar" / "j.js", "j\n")
    store = c.sw.app.state.store
    store.full_scan()
    assert set(files(c)[1]) == {"venv", "node_modules", ".env"}
    r = upd(c, {"show": ["node_modules/foo"]})
    assert r.status_code == 200, r.text
    assert r.json()["applied"] == {"hidden": [], "shown": ["node_modules/foo/i.js"]}
    visible, hid = files(c)
    assert "node_modules/foo/i.js" in visible and "node_modules/p.js" not in visible
    assert {"node_modules", "node_modules/foo"} <= store.dirs and "node_modules/bar" not in store.dirs
    assert "node_modules" not in hid  # partial: shown with only the item
    assert hid["node_modules/bar"]["reason"] == "ignore" and hid["node_modules/p.js"]["reason"] == "ignore"
    assert search(c, "zqfooword") == ["node_modules/foo/i.js"]
    assert c.get("/api/hidden", params={"path": "node_modules"}).status_code == 400  # not a hidden folder
    rs = rows(c)
    assert rs["node_modules/foo"]["visible"] is True and rs["node_modules/foo"]["choice"] == "show"
    assert rs["node_modules/foo"]["group"] == "builtin" and rs["node_modules/bar"]["visible"] is False
    # unchecked: back to one row, no choice stored
    r = upd(c, {"hide": ["node_modules/foo"]})
    assert r.json()["applied"]["hidden"] == ["node_modules/foo/i.js"]
    assert r.json()["show"] == [] and r.json()["hide"] == []
    visible, hid = files(c)
    assert set(hid) == {"venv", "node_modules", ".env"} and not any(p.startswith("node_modules") for p in store.dirs)


def test_show_lifts_only_the_path(c, tree):
    write(tree / "venv" / "node_modules" / "q.js", "q\n")
    write(tree / "venv" / "sub" / "z.js", "z\n")
    c.sw.app.state.store.full_scan()
    r = upd(c, {"show": ["venv"]})
    assert sorted(r.json()["applied"]["shown"]) == ["venv/out.js", "venv/sub/z.js"]
    visible, hid = files(c)
    assert {"venv/out.js", "venv/sub/z.js"} <= visible and "venv/node_modules/q.js" not in visible
    assert hid["venv/node_modules"]["reason"] == "ignore" and hid["venv/node_modules"]["rule"] == "node_modules"
    assert rows(c)["venv/node_modules"]["visible"] is False


def test_show_beats_ignore_flag_at_path(tmp_path, tree):
    with outer(tree, tmp_path / "data", ignore=["venv", "*.bak"]) as c:
        c.root = canon(tree)
        assert state(c)["extra"] == ["venv", "*.bak"]
        hid = files(c)[1]
        assert hid["venv"] == {"path": "venv", "name": "venv", "dir": True, "reason": "ignore", "rule": "venv",
                                "extra": True}
        assert rows(c)["venv"]["extra"] is True
        assert "*.bak" in c.get("/api/config").json()["ignore_patterns"]
        r = upd(c, {"show": ["venv"]})
        assert r.status_code == 200 and r.json()["applied"]["shown"] == ["venv/out.js"]
        assert "venv/out.js" in files(c)[0]
        assert rows(c)["venv"] == {"path": "venv", "name": "venv", "dir": True, "group": "builtin",
                                    "visible": True, "rule": "venv", "extra": True, "choice": "show"}


def test_deny_wins(c, tree):
    r = upd(c, {"show": [".env"]})
    assert r.status_code == 400 and r.json()["detail"] == ".env is protected" and r.json()["path"] == ".env"
    write(tree / "docs" / ".env.local", "S=1\n")
    r = upd(c, {"show": ["docs"], "hide": []})  # a visible folder: no-op
    assert r.status_code == 200 and r.json()["show"] == []
    r = upd(c, {"show": ["docs/.env.local"]})
    assert r.status_code == 400 and "protected" in r.json()["detail"]
    r = upd(c, {"show": [".git"]})
    assert r.status_code == 400 and "never shown" in r.json()["detail"]
    r = upd(c, {"hide": [".env", ".git"]})  # already hidden: nothing stored
    assert r.status_code == 200 and r.json()["hide"] == [] and r.json()["applied"] == {"hidden": [], "shown": []}
    # a protected name inside a shown folder stays protected
    write(tree / "venv" / ".env.local", "k\n")
    c.sw.app.state.store.full_scan()
    assert upd(c, {"show": ["venv"]}).status_code == 200
    visible, hid = files(c)
    assert "venv/out.js" in visible and hid["venv/.env.local"]["reason"] == "deny"
    assert state(c)["version"] == 1


def test_hide_inside_shown(c):
    assert upd(c, {"show": ["venv"]}).status_code == 200
    r = upd(c, {"hide": ["venv/out.js"]})
    assert r.json()["applied"]["hidden"] == ["venv/out.js"]
    assert r.json()["show"] == ["venv"] and r.json()["hide"] == ["venv/out.js"]
    hid = files(c)[1]
    assert "venv" in c.sw.app.state.store.dirs and hid["venv/out.js"]["choice"] == "hide"
    assert rows(c)["venv/out.js"]["group"] == "user"


def test_hide_drops_choices_below(c):
    assert upd(c, {"show": ["venv"]}).status_code == 200
    assert upd(c, {"hide": ["venv/out.js", "docs/old/x.md"]}).status_code == 200
    r = upd(c, {"hide": ["venv", "docs"]})
    s = r.json()
    assert s["show"] == [] and s["hide"] == ["docs"]  # venv is hidden by default: no choice needed
    visible, hid = files(c)
    assert hid["venv"]["reason"] == "ignore" and hid["docs"]["choice"] == "hide"
    assert not any(p.startswith(("venv/", "docs/")) for p in visible)


def test_show_inside_user_hidden_folder_is_400(c):
    assert upd(c, {"hide": ["docs"]}).status_code == 200
    r = upd(c, {"show": ["docs/old/x.md"]})
    assert r.status_code == 400 and r.json()["path"] == "docs/old/x.md"
    assert r.json()["detail"] == "docs/old/x.md is inside docs, hidden by your rule; show that first"
    assert upd(c, {"show": ["docs"], "add_rules": ["old"]}).status_code == 200
    r = upd(c, {"show": ["docs/old/sub"]})
    assert r.status_code == 400 and "inside docs/old" in r.json()["detail"] and r.json()["rule"] == "old"
    assert state(c)["show"] == [] and state(c)["hide"] == []


def test_reapply_partial_rescan(c, tree, monkeypatch):
    write(tree / "venv" / "sub" / "deep.js", "zqdeepword\n")
    write(tree / "venv" / "sub2" / "z.js", "z\n")
    store = c.sw.app.state.store
    store.full_scan()
    scanned = []
    orig = os.scandir

    def counting(p=".", *a, **kw):
        scanned.append(os.fsdecode(p))
        return orig(p, *a, **kw)

    monkeypatch.setattr(os, "scandir", counting)
    r = upd(c, {"show": ["venv/sub/deep.js"]})
    monkeypatch.setattr(os, "scandir", orig)
    assert r.json()["applied"] == {"hidden": [], "shown": ["venv/sub/deep.js"]}
    root = os.path.realpath(c.root)
    rels = {os.path.relpath(os.path.realpath(p), root) for p in scanned if os.path.realpath(p).startswith(root)}
    assert rels <= {"venv", "venv/sub"}, rels  # only the new parts are walked
    visible, hid = files(c)
    assert "venv/sub/deep.js" in visible and {"venv", "venv/sub"} <= store.dirs
    assert hid["venv/out.js"]["reason"] == "ignore" and hid["venv/sub2"]["reason"] == "ignore"
    assert "venv" not in hid and "venv/sub" not in hid
    assert search(c, "zqdeepword") == ["venv/sub/deep.js"]


def _gate(monkeypatch, obj, name):
    """Hold obj.name (called in a worker thread) until the returned Event is set."""
    import threading

    gate, entered = threading.Event(), threading.Event()
    orig = getattr(obj, name)

    def held(*a, **kw):
        entered.set()
        assert gate.wait(20)
        return orig(*a, **kw)

    monkeypatch.setattr(obj, name, held)
    return gate, entered


def test_update_answers_before_the_search_index(c, monkeypatch):
    """The search index reads newly shown files in the background: the answer does not wait."""
    index = c.sw.app.state.index
    gate, entered = _gate(monkeypatch, index, "apply_change")
    try:
        r = upd(c, {"show": ["venv"]})
        assert r.status_code == 200 and r.json()["applied"] == {"hidden": [], "shown": ["venv/out.js"]}
        assert "venv/out.js" in files(c)[0]
        assert entered.wait(10)  # applying, held
        assert [x["path"] for x in c.get("/api/search", params={"q": "zqbuildword"}).json()["content"]] == []
    finally:
        gate.set()
    assert search(c, "zqbuildword") == ["venv/out.js"]


def test_update_answers_before_a_big_scan(c, monkeypatch):
    """Past SETTLE_WAIT_S the answer says "pending": the settings are saved and installed (state,
    verdicts), the tree follows with a "change" event."""
    monkeypatch.setattr(hiding_mod, "SETTLE_WAIT_S", 0.0)
    hiding, store = c.sw.app.state.hiding, c.sw.app.state.store
    q = store.subscribe()
    gate, entered = _gate(monkeypatch, hiding, "_settle_sync")
    try:
        r = upd(c, {"show": ["venv"], "client": "tab-1"})
        assert r.status_code == 200, r.text
        assert r.json()["applied"] == {"hidden": [], "shown": [], "pending": True}
        assert r.json()["show"] == ["venv"] and state(c)["show"] == ["venv"]
        assert store.verdict("venv/out.js").kind == "visible"  # reads follow at once
        assert entered.wait(10) and "venv/out.js" not in files(c)[0]
        events = drain(q)
        assert [e[1]["client"] for e in events if isinstance(e, tuple) and e[0] == "hiding"] == ["tab-1"]
        assert not any(isinstance(e, dict) for e in events)
        # a second update meanwhile: settled together with the first one
        r = upd(c, {"hide": ["docs/old"]})
        assert r.json()["applied"]["pending"] is True
    finally:
        gate.set()
    wait_until(lambda: "venv/out.js" in files(c)[0] and "docs/old/x.md" not in files(c)[0], timeout=10)
    wait_until(lambda: not store.hiding_pending() and not hiding._tasks, timeout=10)
    changes = [e for e in drain(q) if isinstance(e, dict)]
    assert sum("venv/out.js" in e["added"] for e in changes) == 1
    assert sum("docs/old/x.md" in e["deleted"] for e in changes) == 1
    assert search(c, "zqbuildword") == ["venv/out.js"] and search(c, "zqoldword") == []
    assert rows(c)["docs/old"]["visible"] is False


def test_items_settle_a_pending_update(c, monkeypatch):
    """The Hidden files dialog lists what the tree will hold, also right after a pending update."""
    monkeypatch.setattr(hiding_mod, "SETTLE_WAIT_S", 0.0)
    store = c.sw.app.state.store
    monkeypatch.setattr(hiding_mod.Hiding, "settle_after_update",
                        lambda self, wait=None: asyncio.sleep(0, {"hidden": [], "shown": [], "pending": True}))
    assert upd(c, {"hide": ["docs/old"]}).json()["applied"]["pending"] is True
    assert store.hiding_pending()
    assert rows(c)["docs/old"]["visible"] is False and not store.hiding_pending()
    assert "docs/old/x.md" not in files(c)[0]


def test_watcher_events_follow_the_rules(c, tree):
    store = c.sw.app.state.store
    assert upd(c, {"hide": ["docs/old"]}).status_code == 200
    write(tree / "docs" / "old" / "late.md", "x\n")
    assert asyncio.run(_batch(store, [tree / "docs" / "old" / "late.md"])) == []
    assert upd(c, {"show": ["docs/old"]}).json()["applied"]["shown"] == [
        "docs/old/late.md", "docs/old/sub/y.py", "docs/old/x.md"]
    write(tree / "docs" / "old" / "later.md", "y\n")
    got = asyncio.run(_batch(store, [tree / "docs" / "old" / "later.md"]))
    assert got and got[0].added == ["docs/old/later.md"]
    # inside a partial folder: the shown item is followed, the rest is not
    assert upd(c, {"show": ["venv/new"]}).status_code == 200
    write(tree / "venv" / "new" / "n.js", "n\n")
    write(tree / "venv" / "other.js", "o\n")
    got = asyncio.run(_batch(store, [tree / "venv" / "new" / "n.js", tree / "venv" / "other.js"]))
    assert [ch.added for ch in got] == [["venv/new/n.js"]]
    assert store.hidden["venv/other.js"].reason == "ignore"


# -- the tree, the listing and counts --------------------------------------------------------------

def test_tree_hidden_count(c, tmp_path, tree):
    t = c.get("/api/tree").json()
    assert t["hidden_count"] == 3 and "hidden" not in t  # venv, node_modules, .env
    assert upd(c, {"add_rules": ["*.log"]}).status_code == 200
    assert c.get("/api/tree").json()["hidden_count"] == 5
    with outer(tree, tmp_path / "data2", allow_reveal=False) as c2:
        assert c2.get("/api/tree").json()["hidden_count"] == 2  # no deny items


def test_tree_hidden_param_ignored(c):
    plain = c.get("/api/tree").json()
    t = c.get("/api/tree", params={"hidden": "1"}).json()
    assert t == plain and "hidden" not in t


def test_items_groups_and_sort(c):
    assert upd(c, {"add_rules": ["*.log"], "hide": ["docs/old"], "show": ["node_modules/p.js"]}).status_code == 200
    body = items(c)
    assert body["root"] == c.root and body["version"] == 1 and body["hide_git"] is False
    assert body["truncated"] is False and body["git_available"] is False
    got = [(r["group"], r["path"], r["visible"]) for r in body["rows"]]
    assert got == [("builtin", "node_modules/p.js", True), ("builtin", "venv", False),
                   ("user", "docs/old", False), ("user", "sub/y.log", False), ("user", "x.log", False),
                   ("deny", ".env", False)]
    r = {x["path"]: x for x in body["rows"]}
    assert r["node_modules/p.js"] == {"path": "node_modules/p.js", "name": "p.js", "dir": False, "group": "builtin",
                                      "visible": True, "rule": "node_modules", "choice": "show",
                                      "kind": "code", "ext": "js"}
    assert r["x.log"]["rule"] == "*.log" and "choice" not in r["x.log"]
    assert r[".env"] == {"path": ".env", "name": ".env", "dir": False, "group": "deny", "visible": False,
                         "kind": r[".env"]["kind"], "ext": r[".env"]["ext"]}


def test_items_no_deny_with_no_reveal(tmp_path, tree):
    with outer(tree, tmp_path / "data", allow_reveal=False) as c:
        c.root = canon(tree)
        assert {r["group"] for r in items(c)["rows"]} == {"builtin"}
        assert counts(c, ".env", "venv") == {"venv": {"files": 1, "more": False}}


def test_items_cap(c, monkeypatch):
    monkeypatch.setattr(hiding_mod, "ITEMS_MAX", 2)
    body = items(c)
    assert body["truncated"] is True and [r["path"] for r in body["rows"]] == ["node_modules", "venv"]


def test_count_cap(c, tree, monkeypatch):
    big = tree / "venv" / "big"
    big.mkdir()
    for i in range(hidden_mod.COUNT_CAP + 1):
        (big / f"f{i}").write_bytes(b"")
    assert counts(c, "venv/big", "node_modules", "venv/out.js") == {
        "venv/big": {"files": hidden_mod.COUNT_CAP, "more": True},
        "node_modules": {"files": 1, "more": False}, "venv/out.js": {"files": 1, "more": False}}
    monkeypatch.setattr(hidden_mod, "COUNT_CAP", 3)
    for n in range(3):
        write(tree / "node_modules" / f"m{n}.js", "m\n")  # 4 files
    write(tree / "venv" / "three" / "a", "")
    write(tree / "venv" / "three" / "s" / "b", "")
    write(tree / "venv" / "three" / "c", "")
    assert counts(c, "node_modules", "venv/three") == {"node_modules": {"files": 3, "more": True},
                                                        "venv/three": {"files": 3, "more": False}}


def test_count_budget_null(c, tree, monkeypatch):
    for n in range(10):
        write(tree / "node_modules" / f"m{n}.js", "m\n")
    monkeypatch.setattr(hidden_mod, "COUNT_BUDGET_ENTRIES", 5)
    assert counts(c, "node_modules", "venv", "venv/out.js") == {
        "node_modules": None, "venv": None, "venv/out.js": {"files": 1, "more": False}}


def test_count_no_symlink_follow(c, tree):
    os.symlink(tree / "docs", tree / "node_modules" / "docs-link")
    os.symlink(tree / "a.md", tree / "node_modules" / "a-link.md")
    os.symlink(tree / "missing", tree / "node_modules" / "dangling")
    assert counts(c, "node_modules") == {"node_modules": {"files": 2, "more": False}}  # p.js, a-link.md


def test_count_skips_git_dir(c, tree):
    write(tree / "venv" / ".git" / "objects" / "x", "x\n")
    write(tree / "venv" / ".deltadeck-tmp-1", "t\n")
    write(tree / "venv" / "deep" / ".git" / "HEAD", "h\n")
    write(tree / "venv" / ".env", "S=1\n")  # denied names count while they can be revealed
    assert counts(c, "venv") == {"venv": {"files": 2, "more": False}}


def test_count_refused_path_omitted(c):
    assert counts(c, ".git", "missing", "venv", "a/../b", ".deltadeck-tmp-x") == {"venv": {"files": 1, "more": False}}
    assert counts(c, ".env") == {".env": {"files": 1, "more": False}}  # reveal is on
    for params in ({"root": c.root}, {"root": c.root, "path": [f"p{i}" for i in range(51)]}):
        assert c.get("/api/hiding/count", params=params).status_code == 400


def test_hiding_on_disk_before_start(tmp_path, tree):
    write_hiding(tree, tmp_path / "data", rules=["/docs"], show=["venv"], hide=["a.md"])
    with outer(tree, tmp_path / "data") as c:
        c.root = canon(tree)
        visible, hid = files(c)
        assert "venv/out.js" in visible and not any(p.startswith("docs/") for p in visible)
        assert hid["docs"]["reason"] == "user" and hid["docs"]["rule"] == "/docs"
        assert hid["a.md"]["choice"] == "hide" and "a.md" not in visible



def test_redundant_show_choices_pruned(tmp_path, tree):
    """Show choices that no longer change anything (say, under an entry dropped from the built-in list)
    are harmless while saved and dropped on the next update."""
    write(tree / "build" / "out.js", "b\n")
    write(tree / "venv" / "lib" / "x.py", "x\n")
    show = ["build", "build/out.js", "docs/keep.md", "node_modules/p.js", "venv/lib", "x.log", "docs/old/x.md"]
    write_hiding(tree, tmp_path / "data", rules=["*.log"], show=show, hide=["docs/old"])
    with outer(tree, tmp_path / "data") as c:
        c.root = canon(tree)
        visible, hid = files(c)
        assert {"build/out.js", "docs/keep.md", "node_modules/p.js", "venv/lib/x.py", "x.log"} <= visible
        assert "docs/old/x.md" not in visible and hid["docs/old"]["choice"] == "hide"
        r = upd(c, {"add_rules": ["*.tmp"]})
        assert r.status_code == 200, r.text
        # kept: each still lifts a hide (built-in, your pattern) or waits inside a folder you hid
        assert sorted(r.json()["show"]) == ["docs/old/x.md", "node_modules/p.js", "venv/lib", "x.log"]
        assert state(c)["show"] == r.json()["show"]
        visible = files(c)[0]
        assert {"build/out.js", "docs/keep.md", "node_modules/p.js", "venv/lib/x.py", "x.log"} <= visible


# -- the git toggle ------------------------------------------------------------------------------

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
    write(r / ".gitignore", "plans/\nCLAUDE.local.md\n")
    write(r / "a.md", "a\n")
    g(r, "add", "-A")
    g(r, "commit", "-q", "-m", "first")
    write(r / "plans" / "p.md", "zqplanword\n")
    write(r / "CLAUDE.local.md", "local\n")
    write(r / ".claude" / "settings.json", "{}\n")
    write(r / "draft.md", "untracked\n")
    return r




def started(c, repo):
    c.root = canon(repo)
    wait_until(lambda: not c.sw.app.state.index.indexing, timeout=10)
    return c.sw.app.state.store


@needs_git
def test_git_ignored_files_are_tracked_by_default(tmp_path, repo):
    with outer(repo, tmp_path / "data") as c:
        started(c, repo)
        assert {"plans/p.md", "CLAUDE.local.md", ".claude/settings.json"} <= files(c)[0]
        assert search(c, "zqplanword") == ["plans/p.md"]
        assert "hidden" not in c.get("/api/file", params={"path": "plans/p.md"}).json()
        s = state(c)
        assert s["git_available"] is True and s["hide_git"] is False
        # a change inside a git-ignored folder is reported like any other
        write(repo / "plans" / "p.md", "zqplanword changed\n")
        ch = c.sw.app.state.store.apply_scopes(["plans/p.md"])
        assert ch is not None and ch.modified == ["plans/p.md"]


@needs_git
def test_git_ignored_visible_by_default_listed(tmp_path, repo, monkeypatch):
    monkeypatch.setattr(hidden_mod, "LISTING_EVERY_S", 0.0)
    with outer(repo, tmp_path / "data") as c:
        store = started(c, repo)
        rs = rows(c)
        assert rs["plans"] == {"path": "plans", "name": "plans", "dir": True, "group": "git", "visible": True}
        assert rs["CLAUDE.local.md"]["group"] == "git" and rs["CLAUDE.local.md"]["visible"] is True
        assert ".claude" not in rs and "draft.md" not in rs
        assert "plans/p.md" in files(c)[0] and files(c)[1] == {}
        # a new git-ignored folder: visible, and listed
        write(repo / ".gitignore", "plans/\nCLAUDE.local.md\nlogs/\n")
        write(repo / "logs" / "a.txt", "zqlogsword\n")
        store.apply_scopes([".gitignore", "logs"])
        assert "logs/a.txt" in files(c)[0]
        rs = rows(c)
        assert rs["logs"] == {"path": "logs", "name": "logs", "dir": True, "group": "git", "visible": True}
        # unchecked: hidden by a choice, still in the git group
        r = upd(c, {"hide": ["logs"]})
        assert r.json()["applied"]["hidden"] == ["logs/a.txt"] and r.json()["hide"] == ["logs"]
        assert rows(c)["logs"] == {"path": "logs", "name": "logs", "dir": True, "group": "git", "visible": False,
                                   "choice": "hide"}
        assert search(c, "zqlogsword") == []


@needs_git
def test_hide_git_header(tmp_path, repo):
    with outer(repo, tmp_path / "data") as c:
        store = started(c, repo)
        assert upd(c, {"hide": ["plans/p.md", "draft.md"]}).status_code == 200
        r = upd(c, {"hide_git": True})  # the header: all git-ignored items, also future ones
        assert r.status_code == 200, r.text
        assert r.json()["hide_git"] is True and r.json()["hide"] == ["draft.md"]  # choices on git items cleared
        assert r.json()["applied"]["hidden"] == ["CLAUDE.local.md"]
        hid = files(c)[1]
        assert hid["plans"] == {"path": "plans", "name": "plans", "dir": True, "reason": "git"}
        assert hid["CLAUDE.local.md"]["reason"] == "git"
        assert rows(c)["plans"]["group"] == "git" and rows(c)["plans"]["visible"] is False
        # a new git-ignored file is hidden after a refresh
        write(repo / ".gitignore", "plans/\nCLAUDE.local.md\n*.tmp\n")
        write(repo / "x.tmp", "t\n")
        store.apply_scopes(["x.tmp"])
        store.refresh_ignored()
        assert "x.tmp" not in files(c)[0] and files(c)[1]["x.tmp"]["reason"] == "git"
        # one item shown inside
        r = upd(c, {"show": ["plans/p.md"]})
        assert r.json()["applied"]["shown"] == ["plans/p.md"] and r.json()["show"] == ["plans/p.md"]
        assert rows(c)["plans/p.md"]["group"] == "git" and rows(c)["plans/p.md"]["choice"] == "show"
        # the header again: everything shown, the choice dropped
        r = upd(c, {"hide_git": False})
        assert r.json()["show"] == [] and sorted(r.json()["applied"]["shown"]) == ["CLAUDE.local.md", "x.tmp"]
        assert {"plans/p.md", "CLAUDE.local.md", "x.tmp"} <= files(c)[0]
    prefs = load_prefs(Settings.make(str(repo), data_dir=str(tmp_path / "data")))
    assert prefs == HidingPrefs(False, (), (), ("draft.md",))


@needs_git
def test_git_toggle_live(tmp_path, repo):
    with outer(repo, tmp_path / "data") as c:
        started(c, repo)
        q = c.sw.app.state.store.subscribe()
        r = upd(c, {"hide_git": True})
        assert r.status_code == 200, r.text
        assert r.json()["hide_git"] is True
        assert r.json()["applied"]["hidden"] == ["CLAUDE.local.md", "plans/p.md"]
        change = next(e for e in drain(q) if isinstance(e, dict))
        assert sorted(change["deleted"]) == ["CLAUDE.local.md", "plans/p.md"]
        visible, hid = files(c)
        assert hid["plans"]["reason"] == "git" and "rule" not in hid["plans"]
        assert ".claude/settings.json" in visible and "draft.md" in visible
        assert search(c, "zqplanword") == []
        r = upd(c, {"hide_git": False})
        assert r.json()["applied"]["shown"] == ["CLAUDE.local.md", "plans/p.md"]
        assert search(c, "zqplanword") == ["plans/p.md"]


def tree_marks(c):
    """(files /api/tree marks ignored, ignored_dirs)."""
    t = c.get("/api/tree").json()
    return {f["path"] for f in t["files"] if f.get("ignored")}, set(t["ignored_dirs"])


@needs_git
def test_tree_marks_git_ignored_items(tmp_path, repo):
    write(repo / "plans" / "deep" / "q.md", "q\n")
    with outer(repo, tmp_path / "data") as c:
        started(c, repo)
        t = c.get("/api/tree").json()
        marked, dirs = tree_marks(c)
        assert marked == {"plans/p.md", "plans/deep/q.md", "CLAUDE.local.md"}  # also inside an ignored folder
        assert dirs == {"plans", "plans/deep"}
        assert set(t["ignored_dirs"]) <= set(t["dirs"])
        assert not any("ignored" in f for f in t["files"] if f["path"] in ("a.md", "draft.md"))
        # hidden, then shown again by a choice: still marked
        assert upd(c, {"hide_git": True}).status_code == 200
        assert tree_marks(c) == (set(), set())
        assert upd(c, {"show": ["plans"]}).status_code == 200
        assert tree_marks(c) == ({"plans/p.md", "plans/deep/q.md"}, {"plans", "plans/deep"})
        assert upd(c, {"hide": ["plans"]}).status_code == 200
        assert tree_marks(c) == (set(), set())


@needs_git
def test_gitignore_change_marks_live(tmp_path, repo):
    """While git-ignored files are shown, a .gitignore change asks git again: nothing is hidden,
    the dimmed items change (a "change" with ignored_changed)."""
    with outer(repo, tmp_path / "data") as c:
        store = started(c, repo)
        v = c.get("/api/tree").json()["version"]
        write(repo / ".gitignore", "plans/\nCLAUDE.local.md\ndraft.md\n")
        got = asyncio.run(_batch(store, [repo / ".gitignore"]))
        assert "draft.md" in tree_marks(c)[0] and "draft.md" in files(c)[0]
        ch = next(ch for ch in got if ch.ignored_changed)
        assert not ch.added and not ch.deleted and ch.to_json()["ignored_changed"] is True
        assert c.get("/api/tree").json()["version"] > v
        write(repo / ".gitignore", "CLAUDE.local.md\n")
        got = asyncio.run(_batch(store, [repo / ".gitignore"]))
        assert tree_marks(c) == ({"CLAUDE.local.md"}, set())
        assert any(ch.ignored_changed for ch in got)
        # a new file git ignores is marked when it shows up
        write(repo / ".gitignore", "*.log\n")
        asyncio.run(_batch(store, [repo / ".gitignore"]))
        write(repo / "new.log", "x\n")
        asyncio.run(_batch(store, [repo / "new.log"]))
        assert "new.log" in files(c)[0] and tree_marks(c)[0] == {"new.log"}
        # a backstop pass sees a change made behind the watcher's back
        write(repo / ".gitignore", "draft.md\n")
        assert store.refresh_ignored() is not None
        assert tree_marks(c)[0] == {"draft.md"}
        assert store.refresh_ignored() is None  # nothing changed: no event


@needs_git
def test_items_queries_git_throttled(tmp_path, repo, monkeypatch):
    calls = []
    orig = hidden_mod.GitIgnored._query

    def counting(self, *a, **kw):
        calls.append(1)
        return orig(self, *a, **kw)

    monkeypatch.setattr(hidden_mod.GitIgnored, "_query", counting)
    with outer(repo, tmp_path / "data") as c:
        started(c, repo)
        assert len(calls) == 1  # at startup (the tree dims what git ignores)
        items(c)  # within LISTING_EVERY_S: the last answer
        assert len(calls) == 1
        c.sw.app.state.store.ignored._listed_at -= hidden_mod.LISTING_EVERY_S
        items(c)
        assert len(calls) == 2
        assert upd(c, {"show": ["draft.md"]}).status_code == 200  # an update never asks git
        assert len(calls) == 2
        assert c.sw.app.state.store.ignored.paths  # kept for the listing, hiding nothing
        assert files(c)[1] == {}


@needs_git
def test_git_toggle_without_git(tmp_path, repo):
    with outer(repo, tmp_path / "data", git="off") as c:
        c.root = canon(repo)
        assert state(c)["git_available"] is False
        r = upd(c, {"hide_git": True})
        assert r.status_code == 200 and r.json()["applied"] == {"hidden": [], "shown": []}
        assert "plans/p.md" in files(c)[0]
        assert items(c)["git_available"] is False


# -- built-ins and git-tracked files ---------------------------------------------------------------

@pytest.fixture
def app_repo(tmp_path):
    """desktop/venv holds committed files next to untracked ones (a vendored virtualenv)."""
    r = tmp_path / "app"
    r.mkdir()
    g(r, "init", "-q", "-b", "main")
    write(r / "a.md", "a\n")
    write(r / "desktop" / "venv" / "icon.icns", "icns\n")
    write(r / "desktop" / "venv" / "entitlements.plist", "<plist>zqentword</plist>\n")
    g(r, "add", "-A")
    g(r, "commit", "-q", "-m", "first")
    write(r / "desktop" / "venv" / "pyinstaller" / "x.toc", "zqtocword\n")
    write(r / "node_modules" / "a" / "b" / "c.js", "zqdistword\n")
    return r


@needs_git
def test_builtin_never_hides_tracked_files(tmp_path, app_repo):
    r = app_repo
    write(r / "desktop" / "venv" / "icon.icns", "icns changed\n")
    with outer(r, tmp_path / "data", allow_edit=True) as c:
        store = started(c, r)
        t = c.get("/api/tree").json()
        visible = {f["path"] for f in t["files"]}
        assert {"desktop/venv/icon.icns", "desktop/venv/entitlements.plist"} <= visible
        assert "desktop/venv" in t["dirs"] and not any("pyinstaller" in p for p in visible)
        hid = files(c)[1]
        assert hid["desktop/venv/pyinstaller"] == {"path": "desktop/venv/pyinstaller", "name": "pyinstaller",
                                                    "dir": True, "reason": "ignore", "rule": "venv"}
        assert hid["node_modules"]["rule"] == "node_modules"
        assert rows(c)["desktop/venv/pyinstaller"]["group"] == "builtin"
        assert search(c, "zqentword") == ["desktop/venv/entitlements.plist"] and search(c, "zqtocword") == []
        meta = c.get("/api/file", params={"path": "desktop/venv/icon.icns"}).json()
        assert "hidden" not in meta
        assert c.get("/api/file", params={"path": "desktop/venv/pyinstaller/x.toc"}).json()["hidden"] == "ignore"
        st = {f["path"]: f for f in c.get("/api/git/status").json()["files"]}
        assert st["desktop/venv/icon.icns"]["status"] == "M" and "desktop/venv/pyinstaller/x.toc" not in st
        head = c.get("/api/git/file", params={"path": "desktop/venv/icon.icns"}).json()
        assert head["head"]["text"] == "icns\n" and head["status"] == "M"
        # editable like any other file; a new (untracked) file there would be hidden
        tok = c.get("/api/config").json()["edit_token"]
        h = {"X-Edit-Token": tok}
        cur = c.get("/api/content", params={"path": "desktop/venv/entitlements.plist"}).json()
        resp = c.put("/api/edit/file", json={"path": "desktop/venv/entitlements.plist", "content": "<plist/>\n",
                                             "base_sha256": cur["sha256"]}, headers=h)
        assert resp.status_code == 200, resp.text
        resp = c.put("/api/edit/file", json={"path": "desktop/venv/new.txt", "content": "n\n"}, headers=h)
        assert resp.status_code == 403 and "ignore list: venv" in resp.json()["detail"]
        assert c.post("/api/edit/mkdir", json={"path": "docs/node_modules"}, headers=h).status_code == 403
        assert store.hidden["node_modules"].reason == "ignore"


@needs_git
def test_untracked_built_in_folder_hidden_whole(tmp_path, app_repo, monkeypatch):
    scanned = []
    orig = os.scandir

    def counting(p=".", *a, **kw):
        scanned.append(os.fsdecode(p))
        return orig(p, *a, **kw)

    monkeypatch.setattr(os, "scandir", counting)
    with outer(app_repo, tmp_path / "data") as c:
        store = started(c, app_repo)
        monkeypatch.setattr(os, "scandir", orig)
        hid = files(c)[1]
        assert hid["node_modules"] == {"path": "node_modules", "name": "node_modules", "dir": True, "reason": "ignore", "rule": "node_modules"}
        assert not [p for p in hid if p.startswith("node_modules/")]
        assert not [d for d in store.dirs if d == "node_modules" or d.startswith("node_modules/")]
        assert not [p for p in scanned if os.sep + "node_modules" in p], scanned  # never walked
        assert [x["path"] for x in items(c)["rows"] if x["path"].startswith("node_modules")] == ["node_modules"]


@needs_git
def test_new_commit_shows_after_pass(tmp_path, app_repo, monkeypatch):
    r = app_repo
    with outer(r, tmp_path / "data") as c:
        store = started(c, r)
        q = store.subscribe()
        write(r / "node_modules" / "keep.js", "zqkeepword\n")
        g(r, "add", "node_modules/keep.js")
        g(r, "commit", "-q", "-m", "keep")
        store.apply_scopes(["node_modules/keep.js"])  # what the watcher reports: still hidden
        assert "node_modules/keep.js" not in files(c)[0]
        items(c)  # within TRACKED_EVERY_S of the open: not asked again yet
        assert "node_modules/keep.js" not in files(c)[0]
        monkeypatch.setattr(hiding_mod, "TRACKED_EVERY_S", 0.0)
        items(c)
        visible, hid = files(c)
        assert "node_modules/keep.js" in visible and "node_modules" not in hid and hid["node_modules/a"]["reason"] == "ignore"
        change = next(e for e in drain(q) if isinstance(e, dict))
        assert change["added"] == ["node_modules/keep.js"] and change["hidden_changed"]
        # and the backstop pass (Store.refresh_ignored) notices a removal
        g(r, "rm", "-q", "--cached", "node_modules/keep.js")
        g(r, "commit", "-q", "-m", "drop")
        store.refresh_ignored()
        visible, hid = files(c)
        assert "node_modules/keep.js" not in visible and hid["node_modules"]["reason"] == "ignore"


@needs_git
def test_tracked_query_once_at_open(tmp_path, app_repo, monkeypatch):
    calls = []
    orig = hiding_mod.tracked_keep

    def counting(*a, **kw):
        calls.append(1)
        return orig(*a, **kw)

    monkeypatch.setattr(hiding_mod, "tracked_keep", counting)
    with outer(app_repo, tmp_path / "data") as c:
        store = started(c, app_repo)
        assert len(calls) == 1
        for n in range(3):
            write(app_repo / f"n{n}.md", "n\n")
            asyncio.run(_batch(store, [app_repo / f"n{n}.md", app_repo / "desktop" / "venv" / "icon.icns"]))
        assert upd(c, {"add_rules": ["*.tmp"]}).status_code == 200  # throttled too
        assert len(calls) == 1


@needs_git
def test_ignore_flag_not_lifted_by_tracked(tmp_path, app_repo):
    with outer(app_repo, tmp_path / "data", ignore=["venv"]) as c:
        started(c, app_repo)
        visible, hid = files(c)
        assert not any(p.startswith("desktop/venv/") for p in visible)  # --ignore hides tracked files too
        assert hid["desktop/venv"] == {"path": "desktop/venv", "name": "venv", "dir": True, "reason": "ignore",
                                        "rule": "venv", "extra": True}
        assert upd(c, {"show": ["desktop/venv"]}).status_code == 200  # one item can still be shown
        assert "desktop/venv/icon.icns" in files(c)[0]


# -- elsewhere -------------------------------------------------------------------------------------

@needs_git
def test_user_hidden_left_out_of_git_status_seen_and_completion(tmp_path, repo):
    write(repo / "notes" / "n.py", "def zqnotesname():\n    pass\n")
    with outer(repo, tmp_path / "data", allow_edit=True) as c:
        started(c, repo)
        assert post(c, "/api/seen/commit", {"root": c.root, "path": "draft.md", "mtime": 1, "size": 1}).status_code == 200
        assert upd(c, {"hide": ["draft.md"], "add_rules": ["notes"]}).status_code == 200
        st = {f["path"] for f in c.get("/api/git/status").json()["files"]}
        assert "draft.md" not in st and "notes/n.py" not in st and ".gitignore" not in st
        assert c.get("/api/seen", params={"root": c.root}).json()["records"] == []
        r = post(c, "/api/seen/commit", {"root": c.root, "path": "draft.md", "mtime": 1, "size": 1})
        assert r.status_code == 403
        assert c.get("/api/complete", params={"prefix": "zqnotes"}).json()["names"] == []
        # still readable and editable
        meta = c.get("/api/file", params={"path": "draft.md"}).json()
        assert meta["hidden"] == "user"
        cur = c.get("/api/content", params={"path": "draft.md"}).json()
        tok = c.get("/api/config").json()["edit_token"]
        r = c.put("/api/edit/file", json={"path": "draft.md", "content": "edited\n", "base_sha256": cur["sha256"]},
                  headers={"X-Edit-Token": tok})
        assert r.status_code == 200, r.text
        assert (repo / "draft.md").read_text() == "edited\n"
        # unhidden, the seen record comes back (it was kept)
        assert state(c)["rules"] == ["notes"] and state(c)["hide"] == ["draft.md"]
        upd(c, {"show": ["draft.md"]})
        assert [x["path"] for x in c.get("/api/seen", params={"root": c.root}).json()["records"]] == ["draft.md"]


async def _batch(store, paths):
    got = []

    async def on_change(ch):
        got.append(ch)

    await _apply_batch(store, on_change, [(1, str(p)) for p in paths], None)
    return got


# -- regressions -----------------------------------------------------------------------------------

@pytest.fixture
def nm_repo(tmp_path):
    """node_modules is both a built-in entry and in .gitignore (the usual case)."""
    r = tmp_path / "nm"
    r.mkdir()
    g(r, "init", "-q", "-b", "main")
    write(r / ".gitignore", "node_modules/\nplans/\n")
    write(r / "a.md", "a\n")
    g(r, "add", "-A")
    g(r, "commit", "-q", "-m", "first")
    write(r / "node_modules" / "foo" / "i.js", "foo\n")
    write(r / "node_modules" / "bar" / "i.js", "bar\n")
    write(r / "plans" / "p.md", "p\n")
    return r


@needs_git
@pytest.mark.parametrize("show_first", [True, False])
def test_hide_git_header_keeps_builtin_choices(tmp_path, nm_repo, show_first):
    with outer(nm_repo, tmp_path / "data") as c:
        started(c, nm_repo)
        if show_first:
            assert upd(c, {"show": ["node_modules/foo"]}).status_code == 200
        assert upd(c, {"hide_git": True}).status_code == 200
        if not show_first:
            assert upd(c, {"show": ["node_modules/foo"]}).status_code == 200
        r = upd(c, {"hide_git": False})
        assert r.status_code == 200, r.text
        assert r.json()["show"] == ["node_modules/foo"]  # a built-in exception, not a git one
        assert "node_modules/foo/i.js" in files(c)[0]


@needs_git
def test_user_pattern_beats_builtin(tmp_path, app_repo, nm_repo):
    with outer(app_repo, tmp_path / "data") as c:
        started(c, app_repo)
        assert "desktop/venv/icon.icns" in files(c)[0]
        assert upd(c, {"add_rules": ["venv"]}).status_code == 200
        visible, hid = files(c)
        assert not any(p.startswith("desktop/venv/") for p in visible)  # your pattern hides tracked files
        assert hid["desktop/venv"]["reason"] == "user" and hid["desktop/venv"]["rule"] == "venv"
        assert rows(c)["desktop/venv"]["group"] == "user"
    with outer(nm_repo, tmp_path / "data2") as c:
        started(c, nm_repo)
        assert upd(c, {"add_rules": ["node_modules"]}).status_code == 200
        r = upd(c, {"show": ["node_modules/foo"]})
        assert r.status_code == 400 and "hidden by your rule" in r.json()["detail"]
        assert "node_modules/foo/i.js" not in files(c)[0]


@needs_git
def test_partial_builtin_not_a_git_row(tmp_path, nm_repo):
    with outer(nm_repo, tmp_path / "data") as c:
        started(c, nm_repo)
        assert upd(c, {"show": ["node_modules/foo"]}).status_code == 200
        rs = rows(c)
        assert "node_modules" not in rs
        assert rs["node_modules/foo"]["group"] == "builtin" and rs["node_modules/foo"]["visible"] is True
        assert rs["node_modules/bar"]["group"] == "builtin" and rs["node_modules/bar"]["visible"] is False
        assert rs["plans"]["group"] == "git" and rs["plans"]["visible"] is True


@needs_git
def test_index_change_refreshes_tracked(tmp_path, app_repo, monkeypatch):
    import deltadeck.reconcile as reconcile_mod

    monkeypatch.setattr(reconcile_mod, "INDEX_SETTLE_S", 0.0)
    r = app_repo
    with outer(r, tmp_path / "data") as c:
        store = started(c, r)
        write(r / "node_modules" / "keep.js", "k\n")
        g(r, "add", "node_modules/keep.js")
        g(r, "commit", "-q", "-m", "keep")
        assert "node_modules/keep.js" not in files(c)[0]
        got = []

        async def go():
            async def on_change(ch):
                got.append(ch)

            await _apply_batch(store, on_change, [(1, str(r / ".git" / "index"))], None)
            assert store._index_task is not None
            await store._index_task

        asyncio.run(go())  # forced past the 5 s throttle: a commit shows within a second
        assert "node_modules/keep.js" in files(c)[0]
        assert got and got[0].added == ["node_modules/keep.js"]
