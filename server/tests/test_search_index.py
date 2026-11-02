"""The on-disk, contentless search index (deltadeck.search): rows in and out, snippets from disk,
persistence and incremental restarts, rebuilds of unusable databases, caps and their status, where
the database lives, cleanup on stop and path safety."""

import os
import sqlite3
import tempfile

import pytest
from conftest import make_store, running, write

from deltadeck import search as searchmod
from deltadeck.config import Settings, canonical_path, settings_from_args
from deltadeck.paths import PathGuard
from deltadeck.search import (SearchIndex, index_file, match_lines, needles_for, plan_selection, prune_indexes,
                           root_key, selection_key)
from deltadeck.store import Entry, Store

MB = 1024 * 1024


def make_index(root, index_dir, *, store=None, build=True, **kw):
    store = store or make_store(root)
    idx = SearchIndex(store, kw.pop("max_bytes", MB), index_dir=None if index_dir is None else str(index_dir), **kw)
    if build:
        idx.build()
    return idx


def paths(idx, q, **kw):
    return [h["path"] for h in idx.search(q, **kw)["content"]]


def rescan(idx):
    ch = idx.store.full_scan()
    if ch is not None:
        idx.apply_change(ch.to_json())
    idx.flush()  # a re-plan runs in the background: wait for it
    return ch


def bump(path, text):
    """Rewrite with a different size or mtime so the store sees a change."""
    st = os.stat(path)
    path.write_text(text)
    os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))


@pytest.fixture
def idir(tmp_path):
    return tmp_path / "data" / "search"


# -- contentless rows -----------------------------------------------------------------------------

@pytest.mark.parametrize("delete_mode", [True, False], ids=["contentless_delete", "tombstone"])
def test_insert_update_delete_rename(root, idir, delete_mode):
    if delete_mode and not searchmod.CONTENTLESS_DELETE:
        pytest.skip("SQLite < 3.43")
    write(root / "a.md", "# A\nzqalpha here\n")
    write(root / "sub/b.py", "x = 'zqbeta'\n")
    idx = make_index(root, idir, contentless_delete=delete_mode)
    try:
        assert paths(idx, "zqalpha") == ["a.md"] and paths(idx, "zqbeta") == ["sub/b.py"]
        # the index holds no text: the FTS table is contentless
        db = sqlite3.connect(idx.db_path)
        assert db.execute("SELECT body FROM docs").fetchall() == [(None,), (None,)]
        assert db.execute("SELECT count(*) FROM sqlite_master WHERE name = 'docs_content'").fetchone() == (0,)
        db.close()
        bump(root / "a.md", "# A\nzqgamma now\n")
        rescan(idx)
        assert paths(idx, "zqalpha") == [] and paths(idx, "zqgamma") == ["a.md"]
        os.rename(root / "sub/b.py", root / "sub/c.py")
        ch = rescan(idx)
        assert ch.renames == [{"from": "sub/b.py", "to": "sub/c.py"}]
        assert paths(idx, "zqbeta") == ["sub/c.py"]
        os.unlink(root / "a.md")
        rescan(idx)
        assert paths(idx, "zqgamma") == []
        assert idx.status()["indexed_files"] == 1
        if not delete_mode:
            assert idx._dead == 3  # unlinked rows, never matched again
    finally:
        idx.stop()


def test_tombstones_rebuilt_when_too_many(root, idir, monkeypatch):
    monkeypatch.setattr(searchmod, "TOMBSTONE_REBUILD_MIN", 2)
    for i in range(3):
        write(root / f"f{i}.md", f"zqdead{i}\n")
    write(root / "keep.md", "zqkeep\n")
    idx = make_index(root, idir, contentless_delete=False)
    try:
        for i in range(3):
            os.unlink(root / f"f{i}.md")
        rescan(idx)
        assert idx._dead == 0  # the FTS table was recreated and the survivors indexed again
        assert paths(idx, "zqkeep") == ["keep.md"] and paths(idx, "zqdead0") == []
    finally:
        idx.stop()


# -- snippets come from disk ----------------------------------------------------------------------

def test_snippets_read_from_disk_with_diacritics(root, idir):
    write(root / "cv.md", "intro\nMy Résumé is here\nresume again\n")
    write(root / "nfd.md", "plain\nCafé au lait\n")
    write(root / "ascii.md", "the resume line\n")
    idx = make_index(root, idir)
    try:
        res = idx.search("resume")
        hits = {h["path"]: h for h in res["content"]}
        assert set(hits) == {"cv.md", "ascii.md"}
        m = hits["cv.md"]["matches"]
        assert [x["line"] for x in m] == [2, 3] and hits["cv.md"]["match_count"] == 2
        assert m[0]["text"] == "My Résumé is here" and m[0]["ranges"] == [[3, 9]]
        assert m[0]["offset"] == len(b"intro\n")
        # an accented query finds the plain spelling too, and NFD text (combining accent)
        assert {h["path"] for h in idx.search("résumé")["content"]} == {"cv.md", "ascii.md"}
        h = idx.search("café")["content"]
        assert [x["path"] for x in h] == ["nfd.md"]
        line = h[0]["matches"][0]
        s, e = line["ranges"][0]
        assert line["text"][s:e] == "Café"
    finally:
        idx.stop()


def test_match_lines_folding_unit():
    lines, n = match_lines("ÉCOLE x\nnaïve\nNAIVE\n", needles_for("ecole naive"), ["ecole", "naive"])
    assert n == 3 and lines[0]["ranges"] == [[0, 5]]
    assert [x["text"] for x in lines] == ["ÉCOLE x", "naïve", "NAIVE"]
    lines, n = match_lines("Straße\n", needles_for("strasse"))
    assert n == 0  # FTS does not fold ß either


def test_snippets_follow_changed_and_deleted_files(root, idir):
    write(root / "a.md", "zqchanged first\n")
    write(root / "b.md", "zqchanged second\n")
    idx = make_index(root, idir)
    try:
        # edited on disk, not yet seen by the store: the current text gives the lines
        (root / "a.md").write_text("new top\nstill zqchanged here\n")
        os.unlink(root / "b.md")
        res = idx.search("zqchanged")
        assert [h["path"] for h in res["content"]] == ["a.md"]
        assert res["content"][0]["matches"][0] == {"line": 2, "offset": 8, "text": "still zqchanged here",
                                                   "ranges": [[6, 15]]}
        # store knows the new version but the index still has the old one: a stale hit with no
        # match left is dropped
        bump(root / "a.md", "nothing left\n")
        idx.store.full_scan()
        assert idx.search("zqchanged")["content"] == []
    finally:
        idx.stop()


def test_snippets_are_path_guarded(root, idir, tmp_path):
    write(tmp_path / "outside.md", "zqoutside secret\n")
    write(root / "a.md", "zqoutside inside\n")
    idx = make_index(root, idir)
    try:
        # the indexed file is swapped for a symlink to a file outside the root
        os.unlink(root / "a.md")
        os.symlink(tmp_path / "outside.md", root / "a.md")
        assert idx.search("zqoutside")["content"] == []
    finally:
        idx.stop()
    write(root / "ok.md", "zqdenied\n")
    write(root / "other.md", "zqdenied\n")
    idx = make_index(root, idir)
    try:
        idx.store.guard.deny = (*idx.store.guard.deny, "ok.md")  # denied after it was indexed
        assert paths(idx, "zqdenied") == ["other.md"]
    finally:
        idx.stop()


def test_docx_snippets_from_cache_and_budget(root, idir, monkeypatch):
    from docx_build import make_docx, para

    from deltadeck import docx as docxmod

    make_docx(root / "r.docx", para("zqdocxsnip line"))
    docxmod.cache_clear()
    idx = make_index(root, idir)
    try:
        h = idx.search("zqdocxsnip")["content"]
        assert h[0]["path"] == "r.docx" and h[0]["matches"][0]["text"] == "zqdocxsnip line"
        docxmod.cache_clear()
        monkeypatch.setattr(searchmod, "SNIPPET_BUDGET", -1.0)  # no time to convert: listed without lines
        h = idx.search("zqdocxsnip")["content"]
        assert h == [{"path": "r.docx", "kind": "docx", "score": h[0]["score"], "matches": [], "match_count": 0}]
    finally:
        idx.stop()
        docxmod.cache_clear()


# -- persistence ----------------------------------------------------------------------------------

def test_persists_and_restarts_incrementally(root, idir, monkeypatch):
    for i in range(5):
        write(root / f"f{i}.md", f"zqpersist{i}\n")
    idx = make_index(root, idir)
    db_path = idx.db_path
    assert idx.location == "data" and db_path == index_file(str(idir), idx.root)
    assert oct(os.stat(db_path).st_mode & 0o777) == "0o600"
    idx.stop()
    bump(root / "f1.md", "zqpersistchanged\n")
    os.unlink(root / "f2.md")
    write(root / "new.md", "zqpersistnew\n")
    reads = []
    real = SearchIndex._read
    monkeypatch.setattr(SearchIndex, "_read", lambda self, e: reads.append(e.path) or real(self, e))
    idx = make_index(root, idir)
    try:
        assert idx.db_path == db_path
        assert sorted(reads) == ["f1.md", "new.md"]  # only what changed is read again
        assert paths(idx, "zqpersist0") == ["f0.md"] and paths(idx, "zqpersist2") == []
        assert paths(idx, "zqpersistchanged") == ["f1.md"] and paths(idx, "zqpersistnew") == ["new.md"]
        assert idx.status()["indexed_files"] == 5
    finally:
        idx.stop()


@pytest.mark.parametrize("key,value", [("schema", "0"), ("tokenize", "porter"), ("root", "/elsewhere"),
                                       ("mode", "other")])
def test_mismatched_db_is_rebuilt(root, idir, key, value):
    write(root / "a.md", "zqrebuild\n")
    idx = make_index(root, idir)
    path = idx.db_path
    idx.stop()
    db = sqlite3.connect(path)
    db.execute("UPDATE info SET value = ? WHERE key = ?", (value, key))
    db.commit()
    db.close()
    idx = make_index(root, idir)
    try:
        assert idx.location == "data" and idx.db_path == path
        assert paths(idx, "zqrebuild") == ["a.md"]
        db = sqlite3.connect(path)
        assert dict(db.execute("SELECT key, value FROM info").fetchall())[key] != value
        db.close()
    finally:
        idx.stop()


@pytest.mark.parametrize("kind", ["garbage", "foreign", "truncated"])
def test_corrupt_or_foreign_db_is_rebuilt(root, idir, kind):
    write(root / "a.md", "zqcorrupt\n")
    idx = make_index(root, idir)
    path = idx.db_path
    idx.stop()
    if kind == "garbage":
        with open(path, "wb") as f:
            f.write(b"this is not a database" * 100)
    elif kind == "foreign":
        os.unlink(path)
        db = sqlite3.connect(path)
        db.execute("CREATE TABLE something (x)")
        db.commit()
        db.close()
    else:
        with open(path, "r+b") as f:
            f.truncate(1024)
    idx = make_index(root, idir)
    try:
        assert idx.location == "data" and paths(idx, "zqcorrupt") == ["a.md"]
    finally:
        idx.stop()


def test_symlinked_db_is_not_followed(root, idir, tmp_path):
    write(root / "a.md", "zqlinkdb\n")
    victim = write(tmp_path / "victim.txt", "keep me")
    idir.mkdir(parents=True)
    store = make_store(root)
    os.symlink(victim, index_file(str(idir), store.root))
    idx = make_index(root, idir, store=store)
    try:
        assert paths(idx, "zqlinkdb") == ["a.md"]
        assert victim.read_text() == "keep me"
        assert not os.path.islink(idx.db_path)
    finally:
        idx.stop()


def test_corruption_while_running_resets(root, idir):
    write(root / "a.md", "zqrun\n")
    idx = make_index(root, idir)
    try:
        calls = []
        real = idx._reset
        idx._reset = lambda: calls.append(1) or real()
        upsert = idx.upsert

        def broken_once(e, commit=True):
            del idx.upsert
            raise sqlite3.DatabaseError("malformed")
        idx.upsert = broken_once
        write(root / "b.md", "zqrun2\n")
        rescan(idx)  # waits for the rebuild it starts
        assert calls == [1] and idx.upsert == upsert and not idx.indexing
        assert sorted(paths(idx, "zqrun*")) == ["a.md", "b.md"]
    finally:
        idx.stop()


# -- caps -----------------------------------------------------------------------------------------

def E(path, kind="markdown", size=10):
    return Entry(path, path.rsplit("/", 1)[-1], size, 0, kind, path.rsplit(".", 1)[-1])


def test_plan_selection_is_deterministic():
    es = [E("deep/x/a.md"), E("b.py", "code"), E("c.md", size=50), E("d.md"), E("e.json", "json"),
          E("f.txt", "text"), E("img.png", "image"), E("big.md", size=10 * MB)]
    allowed, total, reason = plan_selection(es, MB, 3, 10**9)
    assert total == 6 and reason == "files"  # the image and the over-size file are not indexable
    assert allowed == {"d.md", "c.md", "deep/x/a.md"}
    assert plan_selection(list(reversed(es)), MB, 3, 10**9)[0] == allowed
    assert [e.path for e in sorted(es[:6], key=selection_key)] == ["d.md", "c.md", "deep/x/a.md", "f.txt", "b.py",
                                                                   "e.json"]
    allowed, _, reason = plan_selection(es, MB, 100, 75)
    assert reason == "bytes" and allowed == {"d.md", "c.md", "deep/x/a.md"}  # 10 + 50 + 10, no 10 more fits
    assert plan_selection(es, MB, 100, 10**9) == (None, 6, "")
    allowed, _, reason = plan_selection(es, MB, 100, 65)
    assert reason == "bytes" and allowed == {"d.md", "c.md"}
    allowed, _, reason = plan_selection(es, MB, 100, 25)
    assert allowed == {"d.md", "deep/x/a.md"}  # the 50-byte file is skipped, smaller ones still fit


def test_caps_and_status(root, idir):
    write(root / "a.md", "zqcap\n")
    write(root / "b.md", "zqcap\n")
    write(root / "deep/c.md", "zqcap\n")
    write(root / "x.py", "zqcap = 1\n")
    idx = make_index(root, idir, max_files=2)
    try:
        st = idx.status()
        assert st == {"indexing": False, "indexed_files": 2, "indexable_files": 4, "limit_reached": True,
                      "limit_reason": "files"}
        res = idx.search("zqcap")
        assert sorted(h["path"] for h in res["content"]) == ["a.md", "b.md"]
        assert res["indexed_files"] == 2 and res["limit_reached"] is True
        # a chosen file goes: the next one in line takes its place
        os.unlink(root / "a.md")
        rescan(idx)
        assert sorted(paths(idx, "zqcap")) == ["b.md", "deep/c.md"]
        os.unlink(root / "b.md")
        rescan(idx)
        assert sorted(paths(idx, "zqcap")) == ["deep/c.md", "x.py"]
        assert idx.status()["limit_reached"] is False
        # a new document outranks the code file
        write(root / "top.md", "zqcap\n")
        rescan(idx)
        assert sorted(paths(idx, "zqcap")) == ["deep/c.md", "top.md"]
    finally:
        idx.stop()
    idx = make_index(root, idir, max_total_bytes=len("zqcap\n") + 2)
    try:
        assert idx.status()["limit_reason"] == "bytes" and len(paths(idx, "zqcap")) == 1
    finally:
        idx.stop()


def test_cap_options_from_cli_and_env(root):
    s = settings_from_args(["--root", str(root), "--search-max-files", "7", "--search-max-total-mb", "1.5"], env={})
    assert s.search_max_files == 7 and s.search_max_total_bytes == int(1.5 * MB)
    s = settings_from_args(["--root", str(root)], env={"DELTADECK_SEARCH_MAX_FILES": "9",
                                                       "DELTADECK_SEARCH_MAX_TOTAL_MB": "3"})
    assert s.search_max_files == 9 and s.search_max_total_bytes == 3 * MB
    s = settings_from_args(["--root", str(root)], env={})
    assert s.search_max_files == 100_000 and s.search_max_total_bytes == 2048 * MB


def test_api_reports_coverage(root, data_dir):
    for n in "abc":
        write(root / f"{n}.md", "zqapi\n")
    with running(root, data_dir=str(data_dir), search_max_files=2) as c:
        res = c.get("/api/search?q=zqapi").json()
        assert res["indexed_files"] == 2 and res["indexable_files"] == 3
        assert res["limit_reached"] is True and res["limit_reason"] == "files"
        assert len(res["content"]) == 2
        assert os.path.isfile(index_file(str(data_dir / "search"), c.app.state.settings.root))
        assert c.get("/api/config").json()["desktop"] is False  # the UI then names the cap options


def test_disk_full_keeps_what_was_indexed(root, idir):
    write(root / "a.md", "zqdisk\n")
    idx = make_index(root, idir)
    try:
        idx._write_failed(sqlite3.OperationalError("database or disk is full"))
        assert idx.status()["limit_reason"] == "disk" and paths(idx, "zqdisk") == ["a.md"]
        write(root / "b.md", "zqdisk\n")
        rescan(idx)
        assert paths(idx, "zqdisk") == ["a.md"]  # not added while the disk is full
        idx.sync_with_store()  # the next full sync tries again
        assert sorted(paths(idx, "zqdisk")) == ["a.md", "b.md"] and not idx.status()["limit_reached"]
    finally:
        idx.stop()


# -- where the database lives ---------------------------------------------------------------------

def test_data_dir_inside_root_uses_temp_file(root):
    from deltadeck.app import search_index_dir

    write(root / "a.md", "zqtemp\n")
    before = sorted(os.listdir(root))
    settings = Settings.make(canonical_path(str(root)), data_dir=canonical_path(str(root / ".data")))
    assert search_index_dir(settings) is None
    store = Store(PathGuard(settings))
    store.full_scan()
    idx = make_index(root, None, store=store)
    tmp = idx._tmp_dir
    try:
        assert idx.location == "temp" and os.path.isdir(tmp) and idx.db_path.startswith(tmp)
        assert paths(idx, "zqtemp") == ["a.md"]
        assert sorted(os.listdir(root)) == before  # nothing written inside the root
    finally:
        idx.stop()
    assert not os.path.exists(tmp)


def test_temp_dir_inside_root_uses_memory(root, monkeypatch):
    write(root / "a.md", "zqmem\n")
    monkeypatch.setattr(tempfile, "tempdir", str(root / "tmp"))
    idx = make_index(root, None)
    try:
        assert idx.location == "memory" and idx._tmp_dir is None
        assert paths(idx, "zqmem") == ["a.md"]
        assert sorted(os.listdir(root)) == ["a.md"]
    finally:
        idx.stop()


def test_unwritable_data_dir_falls_back_to_temp(root, tmp_path):
    write(root / "a.md", "zqro\n")
    blocker = write(tmp_path / "file-not-dir", "x")
    idx = make_index(root, blocker / "search")
    try:
        assert idx.location == "temp" and paths(idx, "zqro") == ["a.md"]
    finally:
        idx.stop()


def test_two_roots_share_a_data_dir(tmp_path, idir):
    r1, r2 = tmp_path / "one", tmp_path / "two"
    write(r1 / "a.md", "zqshared one\n")
    write(r2 / "a.md", "zqshared two\n")
    i1 = make_index(r1, idir)
    i2 = make_index(r2, idir)
    try:
        assert i1.location == i2.location == "data" and i1.db_path != i2.db_path
        assert i1.search("zqshared")["content"][0]["matches"][0]["text"] == "zqshared one"
        assert i2.search("zqshared")["content"][0]["matches"][0]["text"] == "zqshared two"
        assert sorted(os.listdir(idir)) == sorted(
            f"{root_key(i.root)}.sqlite3{s}" for i in (i1, i2) for s in ("", "-shm", "-wal", ".lock"))
    finally:
        i1.stop()
        i2.stop()


def test_same_root_twice_second_uses_temp(root, idir):
    write(root / "a.md", "zqtwice\n")
    i1 = make_index(root, idir)
    i2 = make_index(root, idir)  # another viewer of the same folder: the lock is taken
    try:
        assert i1.location == "data" and i2.location == "temp"
        assert paths(i1, "zqtwice") == paths(i2, "zqtwice") == ["a.md"]
    finally:
        i2.stop()
        i1.stop()
    i3 = make_index(root, idir, build=False)
    try:
        assert i3.location == "data"  # released on stop
    finally:
        i3.stop()


def test_stop_closes_and_releases(root, idir):
    write(root / "a.md", "zqstop\n")
    idx = make_index(root, idir, build=False)
    idx.stop()
    assert idx._db is None and idx._lock_fd is None
    assert idx.search("zqstop")["content"] == []
    idx.build()  # a build after stop does nothing
    idx.apply_change({"added": ["a.md"], "modified": [], "deleted": [], "renames": []})
    assert os.path.exists(idx.db_path)  # a data-dir index persists


def test_prune_indexes(tmp_path, idir):
    r1, r2 = tmp_path / "one", tmp_path / "two"
    write(r1 / "a.md", "x\n")
    write(r2 / "a.md", "x\n")
    i1 = make_index(r1, idir)
    i2 = make_index(r2, idir)
    i2.stop()
    write(idir / "notes.sqlite3", "not ours")
    try:
        # r1 is in use: kept even though not listed; r2 is gone from the recent list
        assert prune_indexes(str(idir), []) == [root_key(i2.root)]
        assert not os.path.exists(i2.db_path) and os.path.exists(i1.db_path)
        assert os.path.exists(idir / "notes.sqlite3")
    finally:
        i1.stop()
    assert prune_indexes(str(idir), [i1.root]) == []
    assert prune_indexes(str(idir), []) == [root_key(i1.root)]
    assert prune_indexes(str(tmp_path / "missing"), []) == []


def test_sweep_temp_removes_only_abandoned(root, tmp_path, monkeypatch):
    tmp = tmp_path / "systmp"
    tmp.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(tmp))
    write(root / "a.md", "zqsweep\n")
    live = make_index(root, None)  # a running viewer's temporary index: locked
    old = write(tmp / "deltadeck-search-dead" / "index.sqlite3", "x").parent  # a killed viewer's leftover
    young = write(tmp / "deltadeck-search-new" / "index.sqlite3", "x").parent
    other = write(tmp / "unrelated" / "f", "x").parent
    past = os.stat(old).st_mtime - 3600
    for d in (old, other, live._tmp_dir):
        os.utime(d, (past, past))
    try:
        assert live.location == "temp"
        assert searchmod.sweep_temp(str(tmp)) == ["deltadeck-search-dead"]
        assert not old.exists() and young.exists() and other.exists() and os.path.isdir(live._tmp_dir)
        assert paths(live, "zqsweep") == ["a.md"]
    finally:
        live.stop()


# -- review round 2: damage, failed files, cheap changes under a cap, retries, lock files ---------

def _damage_pages(path, n=40):
    """Overwrite n pages in the middle of the database with garbage (FTS segment pages)."""
    pages = os.path.getsize(path) // 4096
    with open(path, "r+b") as f:
        for k in range(n):
            f.seek((pages // 2 + k) * 4096)
            f.write(os.urandom(4096))


def test_damaged_segments_are_found_on_restart(root, idir):
    words = [f"zqw{i:04d}" for i in range(400)]
    for i in range(300):
        write(root / f"f{i}.md", " ".join(words[(i * 7 + j) % 400] for j in range(200)) + "\n")
    idx = make_index(root, idir)
    path = idx.db_path
    idx.stop()
    _damage_pages(path)
    idx = make_index(root, idir)  # the build checks a reused database first
    try:
        assert idx._gen == 1  # found and started over
        assert idx.location == "data" and idx.status()["indexed_files"] == 300
        for w in words:
            assert len(paths(idx, w, limit=50)) > 0
        db = sqlite3.connect(path)
        assert db.execute("PRAGMA quick_check").fetchall() == [("ok",)]
        db.close()
    finally:
        idx.stop()


class _BrokenDb:
    """Wraps the index connection: full-text queries fail as on a damaged database."""

    def __init__(self, db):
        self.db = db

    def execute(self, sql, *a):
        if "MATCH" in sql:
            raise sqlite3.DatabaseError("database disk image is malformed")
        return self.db.execute(sql, *a)

    def __getattr__(self, name):
        return getattr(self.db, name)


def test_damage_found_by_a_query_rebuilds_once(root, idir):
    write(root / "a.md", "zqdamaged\n")
    idx = make_index(root, idir)
    try:
        resets = []
        real = idx._reset
        idx._reset = lambda: resets.append(1) or real()
        idx._db = _BrokenDb(idx._db)
        res = idx.search("zqdamaged")
        assert res["content"] == [] and res["indexing"] is True
        idx.search("zqdamaged")  # the second query runs on the fresh database
        idx.flush()
        assert resets == [1] and not idx.indexing and paths(idx, "zqdamaged") == ["a.md"]
        assert idx.search('zq"x')["content"] == []  # a query error is not damage
        assert resets == [1]
    finally:
        idx.stop()


def test_unreadable_files_take_no_slot_and_are_not_reread(root, idir, monkeypatch):
    for i in range(3):
        os.chmod(write(root / f"a{i}.md", "zqlocked\n"), 0)  # sort first, cannot be read
    for i in range(3):
        write(root / f"deep/b{i}.md", "zqopen\n")
    write(root / "deep/z.py", "zqcode = 1\n")
    reads = []
    real = SearchIndex._read
    monkeypatch.setattr(SearchIndex, "_read", lambda self, e: reads.append(e.path) or real(self, e))
    idx = make_index(root, idir, max_files=3)
    try:
        assert sorted(paths(idx, "zqopen")) == ["deep/b0.md", "deep/b1.md", "deep/b2.md"]  # 3 slots used
        st = idx.status()
        assert st["indexed_files"] == 3 and st["indexable_files"] == 4 and st["limit_reason"] == "files"
        assert reads.count("a0.md") == 1
        reads.clear()
        bump(root / "deep/b0.md", "zqopen again, longer\n")
        rescan(idx)
        assert reads == ["deep/b0.md"]  # the change alone; the unreadable files are not tried again
        os.chmod(root / "a0.md", 0o644)
        bump(root / "a0.md", "zqlocked no more\n")  # changed: tried again, and now it takes a slot
        rescan(idx)
        assert paths(idx, "zqlocked") == ["a0.md"] and len(paths(idx, "zqopen")) == 2
    finally:
        idx.stop()
        for i in range(3):
            os.chmod(root / f"a{i}.md", 0o644)


def test_failed_conversions_are_remembered_across_restarts(root, idir, monkeypatch):
    write(root / "broken.docx", b"PK not really a zip")
    write(root / "~$lock.docx", b"\x00" * 162)
    write(root / "a.md", "zqfine\n")
    idx = make_index(root, idir)
    assert idx.status()["indexable_files"] == 1 and paths(idx, "zqfine") == ["a.md"]
    idx.stop()
    reads = []
    real = SearchIndex._read
    monkeypatch.setattr(SearchIndex, "_read", lambda self, e: reads.append(e.path) or real(self, e))
    idx = make_index(root, idir)
    try:
        assert reads == []  # neither document is converted again
        write(root / "broken.docx", b"PK still not a zip, longer")
        rescan(idx)
        assert reads == ["broken.docx"]  # changed: tried again
        os.unlink(root / "broken.docx")
        rescan(idx)
        db = sqlite3.connect(idx.db_path)
        assert db.execute("SELECT path FROM skipped").fetchall() == [("~$lock.docx",)]
        db.close()
    finally:
        idx.stop()


def test_changes_under_a_cap_avoid_a_full_replan(root, idir, monkeypatch):
    write(root / "a.md", "zqcut\n")
    write(root / "b.md", "zqcut\n")
    write(root / "deep/c.py", "zqcut = 1\n")
    idx = make_index(root, idir, max_files=2)
    try:
        syncs = []
        real = idx._sync_locked
        idx._sync_locked = lambda: syncs.append(1) or real()
        bump(root / "deep/c.py", "zqcut = 22\n")  # not chosen and sorts after the last chosen file
        rescan(idx)
        bump(root / "a.md", "zqcuu\n")  # chosen, same size
        rescan(idx)
        write(root / "deep/d.json", '{"zqcut": 1}')
        rescan(idx)
        assert syncs == [] and idx._replanner is None and not idx._replan
        assert sorted(paths(idx, "zqcut")) == ["b.md"] and idx.status()["indexable_files"] == 4
        write(root / "0.md", "zqcut\n")  # outranks a chosen file: re-planned (in the background)
        ch = idx.store.full_scan()
        idx.apply_change(ch.to_json())
        assert syncs == [] and idx._replan
        idx.flush()
        assert syncs == [1] and sorted(paths(idx, "zqcu*")) == ["0.md", "a.md"]
        os.unlink(root / "a.md")  # a chosen file goes: its slot is handed on
        rescan(idx)
        assert sorted(paths(idx, "zqcut")) == ["0.md", "b.md"]
        allowed, _, _ = plan_selection(idx.store.all_entries(), MB, 2, 10**9)
        assert allowed == {"0.md", "b.md"}
    finally:
        idx.stop()


def test_room_under_a_byte_cap_is_used_without_a_replan(root, idir):
    write(root / "a.md", "zqroom\n")
    write(root / "big.md", "zqroom" + "x" * 100 + "\n")
    idx = make_index(root, idir, max_total_bytes=60)
    try:
        assert idx.status()["limit_reason"] == "bytes" and paths(idx, "zqroom") == ["a.md"]
        syncs = []
        real = idx._sync_locked
        idx._sync_locked = lambda: syncs.append(1) or real()
        write(root / "z/small.py", "zqroom = 1\n")  # sorts last and fits
        rescan(idx)
        write(root / "z/huge.py", "zqroom = 1" + "#" * 100 + "\n")  # sorts last, does not fit
        rescan(idx)
        assert syncs == [] and sorted(paths(idx, "zqroom")) == ["a.md", "z/small.py"]
        assert plan_selection(idx.store.all_entries(), MB, 10**6, 60)[0] == {"a.md", "z/small.py"}
    finally:
        idx.stop()


def test_replans_are_throttled_and_off_the_change_handler(root, idir, monkeypatch):
    import threading

    monkeypatch.setattr(searchmod, "REPLAN_INTERVAL", 0.3)
    write(root / "a.md", "zqthr\n")
    write(root / "b.md", "zqthr\n")
    idx = make_index(root, idir, max_files=1)
    try:
        threads = []
        real = idx._sync_locked
        idx._sync_locked = lambda: threads.append(threading.current_thread().name) or real()
        for i in range(5):
            write(root / f"{i}.md", "zqthr\n")  # each outranks the chosen file
            ch = idx.store.full_scan()
            idx.apply_change(ch.to_json())
        t = idx._replanner
        assert t is not None
        t.join(5)
        assert threads and len(threads) <= 2 and set(threads) == {"search-replan"}
        assert paths(idx, "zqthr") == ["0.md"]
    finally:
        idx.stop()


def test_failed_write_is_retried_on_a_later_change(root, idir, monkeypatch):
    monkeypatch.setattr(searchmod, "RETRY_INTERVAL", 0.0)
    write(root / "a.md", "zqretry\n")
    idx = make_index(root, idir)
    try:
        idx._write_failed(sqlite3.OperationalError("database is locked"))
        assert idx.status()["limit_reason"] == "error"
        write(root / "b.md", "zqretry\n")
        rescan(idx)
        assert sorted(paths(idx, "zqretry")) == ["a.md", "b.md"] and not idx.status()["limit_reached"]
    finally:
        idx.stop()


def test_tombstones_rebuilt_by_bytes_in_the_background(root, idir, monkeypatch):
    monkeypatch.setattr(searchmod, "TOMBSTONE_REBUILD_BYTES", 1000)
    write(root / "keep.md", "zqkeep\n")
    write(root / "big.md", "zqbig " + "y" * 600 + "\n")
    idx = make_index(root, idir, contentless_delete=False)
    try:
        bump(root / "big.md", "zqbig " + "z" * 650 + "\n")
        rescan(idx)
        assert idx._dead == 1 and idx._dead_bytes > 600
        builds = []
        real = idx.build
        idx.build = lambda: builds.append(idx.indexing) or real()
        bump(root / "big.md", "zqbig " + "w" * 700 + "\n")
        rescan(idx)  # waits for the background build
        assert builds == [True] and idx._dead == 0 and idx._dead_bytes == 0
        assert paths(idx, "zqbig") == ["big.md"] and paths(idx, "zqkeep") == ["keep.md"]
    finally:
        idx.stop()


def test_hit_changed_on_disk_before_the_watcher_saw_it(root, idir):
    write(root / "c.md", "zqfoo here\n")
    write(root / "d.md", "zqfoo too\n")
    idx = make_index(root, idir)
    try:
        bump(root / "c.md", "nothing now\n")  # the store has not seen it yet
        assert paths(idx, "zqfoo") == ["d.md"]
    finally:
        idx.stop()


def test_lock_on_an_unlinked_lock_file_is_not_taken(tmp_path, monkeypatch):
    path = str(tmp_path / "x.lock")
    real = searchmod.fcntl.flock
    calls = []

    def flock(fd, op):
        if not calls:  # a prune removes the file between our open and flock
            os.unlink(path)
        calls.append(1)
        return real(fd, op)
    monkeypatch.setattr(searchmod.fcntl, "flock", flock)
    fd = searchmod._try_lock(path)
    try:
        assert fd is not None and len(calls) == 2
        assert os.fstat(fd).st_ino == os.stat(path).st_ino
        assert searchmod._try_lock(path) is None  # held: the file on disk is the locked one
    finally:
        os.close(fd)
