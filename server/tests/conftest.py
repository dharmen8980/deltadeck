import contextlib
import os
import socket
import threading
import time

import pytest
import uvicorn
from fastapi.testclient import TestClient

from deltadeck.app import create_app
from deltadeck.config import Settings, canonical_path
from deltadeck.paths import PathGuard
from deltadeck.store import Store


@contextlib.contextmanager
def running(root, *, watch=False, reconcile_interval=0, **kw):
    settings = Settings.make(str(root), watch=watch, reconcile_interval=reconcile_interval,
                             ui_dir=str(root) + "-no-ui", **kw)
    app = create_app(settings)
    with TestClient(app, base_url="http://127.0.0.1") as client:
        wait_until(lambda: not app.state.index.indexing, timeout=10)
        yield client


def wait_until(pred, timeout=15.0, interval=0.1):
    deadline = time.monotonic() + timeout
    while True:
        result = pred()
        if result:
            return result
        if time.monotonic() > deadline:
            raise AssertionError("condition not met within timeout")
        time.sleep(interval)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start_server(app, port, **config) -> tuple[uvicorn.Server, threading.Thread]:
    """A real uvicorn server for `app` on a background thread (for SSE and lifespan tests); wait for
    `server.started`, then stop it with stop_server."""
    config.setdefault("timeout_graceful_shutdown", 2)
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", **config))
    th = threading.Thread(target=server.run, daemon=True)
    th.start()
    return server, th


def stop_server(server: uvicorn.Server, th: threading.Thread, timeout: float = 10) -> None:
    server.should_exit = True
    th.join(timeout)


def case_insensitive(path) -> bool:
    """True if the file system holding the directory `path` ignores case (probed with a file)."""
    probe = path / "zqCaseProbe"
    probe.write_text("x")
    try:
        return os.path.exists(path / "zqcaseprobe")
    finally:
        probe.unlink()


def make_store(root, data_dir=None, **kw):
    """A fully scanned Store of `root` (data dir next to it unless given)."""
    settings = Settings.make(canonical_path(str(root)), data_dir=canonical_path(str(data_dir or root.parent / "d")),
                             **kw)
    store = Store(PathGuard(settings))
    store.full_scan()
    return store


def write(path, text=""):
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(text, bytes):
        path.write_bytes(text)
    else:
        path.write_text(text)
    return path


@pytest.fixture(autouse=True)
def _search_index_in_tmp(tmp_path, monkeypatch):
    """Apps made with the default data dir (the repo's .data, which a real viewer may be using)
    keep their search index under tmp_path instead."""
    from deltadeck import app as app_mod
    from deltadeck.config import DEFAULT_DATA_DIR, canonical_path

    real = app_mod.search_index_dir
    default = canonical_path(DEFAULT_DATA_DIR)

    def redirected(settings):
        d = real(settings)
        return str(tmp_path / "default-data" / "search") if d is not None and settings.data_dir == default else d

    monkeypatch.setattr(app_mod, "search_index_dir", redirected)


@pytest.fixture
def root(tmp_path):
    r = tmp_path / "root"
    r.mkdir()
    return r


@contextlib.contextmanager
def editing(root, data_dir, **kw):
    """A running app with editing enabled; the client sends the edit token on every request."""
    kw.setdefault("allow_edit", True)
    with running(root, data_dir=str(data_dir), **kw) as c:
        cfg = c.get("/api/config").json()
        c.token = cfg.get("edit_token")
        if c.token:
            c.headers["X-Edit-Token"] = c.token
        yield c


def snapshot_fs(path):
    """{relative path: (is_dir, bytes|None, mode)} for everything under path (links not followed)."""
    out = {}
    for dirpath, dirs, files in os.walk(path):
        for n in dirs + files:
            p = os.path.join(dirpath, n)
            rel = os.path.relpath(p, path)
            st = os.lstat(p)
            if os.path.islink(p):
                out[rel] = ("link", os.readlink(p), st.st_mode)
            elif os.path.isdir(p):
                out[rel] = ("dir", None, st.st_mode)
            else:
                with open(p, "rb") as f:
                    out[rel] = ("file", f.read(), st.st_mode)
    return out


@pytest.fixture
def data_dir(tmp_path):
    return tmp_path / "data"


def store_of(client):
    """The per-root recovery store (<data>/roots/<key>) of a running editing client."""
    from pathlib import Path

    return Path(client.app.state.settings.store_dir)
