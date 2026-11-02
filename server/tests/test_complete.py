"""Editor completion from the search index: identifier extraction (deltadeck.names), the names tables
kept in step with the indexed files, the schema bump that rebuilds old indexes, and /api/complete
(ranking, validation)."""

import os
import sqlite3

import pytest
from conftest import running, write
from test_search_index import bump, make_index, rescan

from deltadeck import names as namesmod
from deltadeck import search as searchmod
from deltadeck.names import extract


def by_name(rows):
    return {n: (d, c) for n, d, c in rows}


def complete(idx, prefix, **kw):
    return [r["name"] for r in idx.complete(prefix, **kw)["names"]]


def name_rows(idx):
    db = sqlite3.connect(idx.db_path)
    try:
        return db.execute("SELECT f.path, w.name FROM uses u JOIN words w ON w.id = u.word_id"
                          " JOIN files f ON f.id = u.file_id ORDER BY 1, 2").fetchall()
    finally:
        db.close()


def word_count(idx):
    db = sqlite3.connect(idx.db_path)
    try:
        return db.execute("SELECT count(*) FROM words").fetchone()[0]
    finally:
        db.close()


# -- extraction -----------------------------------------------------------------------------------

def test_extract_python():
    got = by_name(extract("import os\n\nclass FooBar:\n    def do_thing(self):\n        return os.path or os.path\n"
                          "async def runIt(): pass\nMAX_SIZE: int = 3\nx == y\n", "py"))
    assert got["FooBar"] == (True, 1) and got["do_thing"][0] and got["runIt"][0] and got["MAX_SIZE"][0]
    assert got["path"] == (False, 2)
    assert "FooBar" in by_name(extract("class FooBar: pass", "py"))  # a definition is kept even if used once
    for kw in ("class", "def", "self", "return", "import", "async", "pass"):
        assert kw not in got
    assert "os" not in got and "x" not in got  # under 3 letters and not a definition


def test_extract_js_ts():
    src = ("export function makeThing() {}\nexport const $store = 1; let counter = 2\n"
           "interface Shape {}\ntype Alias = string\nenum Color { Red }\nclass Widget extends Base {}\n"
           "makeThing(); makeThing()\n// 0xdeadbeef 123abc 0xdeadbeef 123abc\n")
    got = by_name(extract(src, "ts"))
    for n in ("makeThing", "$store", "counter", "Shape", "Alias", "Color", "Widget"):
        assert got[n][0], n
    assert got["makeThing"] == (True, 3) and "Base" not in got  # used once, not defined here
    assert "xdeadbeef" not in got and "abc" not in got and "function" not in got
    # hash-like tokens are left out, hex-looking words are not
    assert set(by_name(extract("a3f9c2d1e0 a3f9c2d1e0 add2 add2 decade decade", "js"))) == {"add2", "decade"}
    # case is kept: two spellings are two names
    assert set(by_name(extract("fooBar FooBar fooBar FooBar", "js"))) == {"fooBar", "FooBar"}


def test_extract_java_cs_shell_css_sql():
    java = by_name(extract("public class Greeter {\n  private static String greet(String who) {\n"
                           "    return who;\n  }\n  record Point(int x) {}\n}\n", "java"))
    assert java["Greeter"][0] and java["greet"][0] and java["Point"][0] and not java["who"][0]
    cs = by_name(extract("public sealed class Repo {\n    public async Task<int> LoadAll() { }\n}", "cs"))
    assert cs["Repo"][0] and cs["LoadAll"][0]
    sh = by_name(extract("build_all() {\n  echo $HOME $HOME\n}\nfunction deploy_it {\n}\n", "sh"))
    assert sh["build_all"][0] and sh["deploy_it"][0] and sh["HOME"] == (False, 2) and "$HOME" not in sh
    css = by_name(extract(":root { --main-color: red; }\n.btn { color: var(--main-color) }", "css"))
    assert css["--main-color"][0]
    sql = by_name(extract("CREATE TABLE IF NOT EXISTS users (id int);\nSELECT name FROM users", "sql"))
    assert sql["users"] == (True, 2) and "SELECT" not in sql and "FROM" not in sql
    # any other code file (yaml, Dockerfile...): plain words only
    assert by_name(extract("services:\n  web_app: {}\nweb_app\n", "yml")) == {"web_app": (False, 2)}


def test_extract_caps_per_file(monkeypatch):
    monkeypatch.setattr(namesmod, "MAX_PER_FILE", 50)
    src = "".join(f"word{i} " * (i % 3 + 1) for i in range(500)) + "\ndef zz_defined(): pass\n"
    got = extract(src, "py")
    assert len(got) == 50 and got[0] == ("zz_defined", True, 1)  # definitions first, then most used
    assert all(c == 3 for _, d, c in got[1:])
    # long tokens: only definitions past WORD_MAX, none past NAME_MAX
    src = f"{'a' * 65} {'b' * 41} {'c' * 40} " * 2 + f"\ndef {'d' * 64}(): pass\ndef {'e' * 65}(): pass\n"
    assert sorted(n for n, *_ in extract(src, "py")) == ["c" * 40, "d" * 64]


# -- the names table ------------------------------------------------------------------------------

@pytest.mark.parametrize("delete_mode", [True, False], ids=["contentless_delete", "tombstone"])
def test_names_follow_files(root, tmp_path, delete_mode):
    if delete_mode and not searchmod.CONTENTLESS_DELETE:
        pytest.skip("SQLite < 3.43")
    write(root / "a.py", "def zqAlpha(): pass\n")
    write(root / "sub/b.js", "const zqBeta = 1\n")
    write(root / "notes.md", "zqMarkdownWord\n")  # documents carry no names
    idx = make_index(root, tmp_path / "data" / "search", contentless_delete=delete_mode)
    try:
        assert name_rows(idx) == [("a.py", "zqAlpha"), ("sub/b.js", "zqBeta")]
        bump(root / "a.py", "def zqGamma(): pass\n")
        rescan(idx)
        assert complete(idx, "zq") == ["zqBeta", "zqGamma"]
        os.rename(root / "sub/b.js", root / "sub/c.js")
        rescan(idx)
        assert name_rows(idx) == [("a.py", "zqGamma"), ("sub/c.js", "zqBeta")]
        os.unlink(root / "a.py")
        rescan(idx)
        assert name_rows(idx) == [("sub/c.js", "zqBeta")] and word_count(idx) == 1  # no orphan names
        if not delete_mode:
            idx._rebuild_tombstoned()
            assert name_rows(idx) == []
    finally:
        idx.stop()


def test_old_schema_is_rebuilt(root, tmp_path):
    idir = tmp_path / "data" / "search"
    write(root / "a.py", "def zqOld(): pass\n")
    idx = make_index(root, idir)
    path = idx.db_path
    idx.stop()
    db = sqlite3.connect(path)  # what a version 2 index looks like: no names table
    db.executescript("DROP TABLE words; UPDATE info SET value = '2' WHERE key = 'schema';")
    db.close()
    idx = make_index(root, idir)
    try:
        assert idx.db_path == path and not idx._reused and complete(idx, "zqo") == ["zqOld"]
    finally:
        idx.stop()


def test_complete_ranking(root, tmp_path):
    write(root / "app/main.py", "def zqDefined(): pass\nzqLocal + zqLocal\n")
    write(root / "app/util.py", "zqLocal(zqLocal)\n")
    write(root / "web/x.ts", "zqUsedJs(); zqUsedJs(); zqUsedJs(); zqUsedJs(); zqUsedJs(); zqWeb(zqWeb)\n")
    write(root / "web/deep/y.ts", "zqDeep(zqDeep)\n")
    idx = make_index(root, tmp_path / "d")
    try:
        # definitions first, then the most used, then the shorter
        assert complete(idx, "ZQ") == ["zqDefined", "zqUsedJs", "zqLocal", "zqWeb", "zqDeep"]
        assert idx.complete("zqloc") == {"names": [{"name": "zqLocal", "def": False, "files": 2}], "capped": False}
        # same language, then the same folder, then the same top folder
        assert complete(idx, "zq", path="app/new.py")[:2] == ["zqDefined", "zqLocal"]
        assert complete(idx, "zq", path="web/deep/z.tsx")[1:] == ["zqDeep", "zqUsedJs", "zqWeb", "zqLocal"]
        assert complete(idx, "zq", path="web/q.js")[1:3] == ["zqUsedJs", "zqWeb"]
        assert complete(idx, "zq", limit=2) == ["zqDefined", "zqUsedJs"]
        # an odd path only ranks: refused paths are ignored, never an error
        for p in ("../etc/passwd", "/abs/x.py", "a//b.py", ".git/x.py"):
            assert complete(idx, "zq", path=p) == complete(idx, "zq")
        assert complete(idx, "nothing") == [] and complete(idx, "x" * 65) == []
    finally:
        idx.stop()



def test_complete_scan_cap(root, tmp_path, monkeypatch):
    # more uses in the prefix range than one query reads: the definitions further on still come
    # back (their own index), and the answer says it was capped so the client asks again
    monkeypatch.setattr(searchmod, "COMPLETE_SCAN", 5)
    write(root / "a.js", " ".join(f"zqa{i:02d} zqa{i:02d}" for i in range(10)) + "\nfunction zqzLate() {}\n")
    idx = make_index(root, tmp_path / "d")
    try:
        r = idx.complete("zq")
        assert r["capped"] and r["names"][0] == {"name": "zqzLate", "def": True, "files": 1}
        assert [n["name"] for n in r["names"][1:]] == [f"zqa{i:02d}" for i in range(5)]
        assert idx.complete("zqz") == {"names": [{"name": "zqzLate", "def": True, "files": 1}], "capped": False}
    finally:
        idx.stop()


def test_names_storage(root, tmp_path):
    keys = [0, 1, 127, 128, 300, 2 ** 21, 2 ** 40]
    assert searchmod._unpack(searchmod._pack(reversed(keys))) == keys and searchmod._pack([]) == b""
    write(root / "a.py", "def zqKept(): pass\n")
    write(root / "b.py", "def zqOther(): pass\n")
    idx = make_index(root, tmp_path / "d")
    try:
        # completion reads index ranges only, and removing a file seeks its rows: no table scans
        seen = []
        idx._db.set_trace_callback(seen.append)
        assert complete(idx, "zq", path="a.py") == ["zqKept", "zqOther"]
        os.unlink(root / "a.py")
        rescan(idx)
        idx._db.set_trace_callback(None)
        db = sqlite3.connect(idx.db_path)
        plans = {q: " | ".join(r[3] for r in db.execute("EXPLAIN QUERY PLAN " + q))
                 for q in seen if "words" in q or "uses" in q}
        db.close()
        assert any("JOIN files" in q for q in plans) and any(q.startswith("DELETE FROM uses") for q in plans)
        for q, plan in plans.items():
            assert not any(w.startswith(("SCAN w", "SCAN u")) for w in plan.split(" | ")), (q, plan)
    finally:
        idx.stop()


def test_complete_prefix_is_literal(root, tmp_path):
    write(root / "a.py", "zq_under = zqXunder = 1\n")
    idx = make_index(root, tmp_path / "d")
    try:
        assert complete(idx, "zq_") == ["zq_under"]  # "_" is no wildcard
        assert complete(idx, "zq%") == []
    finally:
        idx.stop()


def test_complete_extensionless_files_get_no_language_boost(root, tmp_path):
    write(root / "Dockerfile", "RUN zqDocker zqDocker zqDocker\n")
    write(root / "a.py", "zqPy zqPy\n")
    idx = make_index(root, tmp_path / "d")
    try:
        for p in ("", "../x", "Makefile.py/../README"):  # no path, refused, no extension
            assert complete(idx, "zq", path=p) == ["zqDocker", "zqPy"], p
        assert complete(idx, "zq", path="b.py") == ["zqPy", "zqDocker"]
    finally:
        idx.stop()


def test_reset_and_broken_clear_names(root, tmp_path):
    write(root / "a.py", "def zqKept(): pass\n")
    idx = make_index(root, tmp_path / "d")
    try:
        idx._reset()  # a fresh database: no names left over
        assert idx.complete("zq")["names"] == [] and name_rows(idx) == []
        idx.build()
        assert name_rows(idx) == [("a.py", "zqKept")]
        idx._broken(idx._gen)  # starts over and rebuilds: the names once, not twice
        idx.flush()
        assert name_rows(idx) == [("a.py", "zqKept")]
    finally:
        idx.stop()

def test_complete_without_index(root, tmp_path):
    write(root / "a.py", "def zqAny(): pass\n")
    idx = make_index(root, tmp_path / "d", build=False)  # not built yet
    try:
        assert idx.complete("zq") == {"names": [], "capped": False}
        idx._close()  # stopped / gone
        assert idx.complete("zq") == {"names": [], "capped": False}
    finally:
        idx.stop()


def test_api_complete(root, data_dir):
    write(root / "src/a.py", "def zqApiName(): pass\nzqApiOther(zqApiOther)\n")
    with running(root, data_dir=str(data_dir)) as c:
        r = c.get("/api/complete", params={"prefix": "zqapi", "path": "src/b.py"})
        assert r.status_code == 200
        assert r.json() == {"names": [{"name": "zqApiName", "def": True, "files": 1},
                                      {"name": "zqApiOther", "def": False, "files": 1}], "capped": False}
        assert c.get("/api/complete", params={"prefix": "zqapi", "limit": 1}).json()["names"][0]["name"] == "zqApiName"
        for params in ({"prefix": ""}, {"prefix": "a" * 65}, {"prefix": "zq", "limit": 0},
                       {"prefix": "zq", "limit": 51}):
            assert c.get("/api/complete", params=params).status_code == 400, params
        assert c.get("/api/complete", params={"prefix": "zq", "limit": "x"}).status_code == 422
        assert c.get("/api/complete", params={"prefix": "zq", "path": "../../x"}).status_code == 200

