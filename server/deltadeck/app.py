"""FastAPI application factory."""

from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
import logging
import os

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import __version__
from .config import Settings
from .edit import Editor
from .edit_routes import DEV_UI_PORT, MAX_UPLOAD_FILES, EditGate, is_edit_path, register_edit_routes
from .errors import register_error_handler
from .events import register_event_routes
from .file_routes import PDF_CSP, SVG_CSP, register_file_routes  # noqa: F401 - CSPs re-exported
from .git import GitLink
from .git_routes import register_git_routes
from .hidden import GitIgnored, list_hidden_dir
from .hiding import Hiding, HidingPrefs, load_prefs
from .http_common import (  # noqa: F401 - prefixes and path tests re-exported for older imports
    ALLOWED_HOSTS,
    HIDING_PREFIX,
    ROOTS_PREFIX,
    SEEN_PREFIX,
    forwarded_hosts_ok,
    is_gated_path,
    is_hiding_path,
    is_roots_path,
    is_seen_path,
    same_site_request,
)
from .names import NAME_MAX
from .paths import PathGuard
from .pdf import PdfRenderer
from .reconcile import Reconciler, backstop_intervals, watch_loop
from .search import INDEX_DIR, MAX_COMPLETE, SearchIndex
from .store import Change, Store

log = logging.getLogger("deltadeck")

CSP = ("default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
       "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; "
       "object-src 'none'; base-uri 'none'; form-action 'none'")
ALLOWED_METHODS = {"GET", "HEAD"}


class SecurityMiddleware:
    """Pure ASGI: refuse non-GET/HEAD (except below /api/edit, which EditGate guards, and, with
    roots=True, below /api/roots, /api/seen and /api/hiding, which RootGate guards), add security
    headers to every response."""

    def __init__(self, app, *, roots: bool = False):
        self.app = app
        self.roots = roots

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        if (scope["method"] not in ALLOWED_METHODS and not is_edit_path(scope["path"])
                and not (self.roots and is_gated_path(scope["path"]))):
            body = b'{"detail":"Method Not Allowed"}'
            await send({"type": "http.response.start", "status": 405, "headers": [
                (b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()),
                (b"allow", b"GET, HEAD"), (b"content-security-policy", CSP.encode()),
                (b"referrer-policy", b"no-referrer"), (b"x-content-type-options", b"nosniff")]})
            await send({"type": "http.response.body", "body": body})
            return

        if not forwarded_hosts_ok(scope):
            body = b'{"detail":"Invalid forwarded host"}'
            await send({"type": "http.response.start", "status": 400, "headers": [
                (b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()),
                (b"content-security-policy", CSP.encode()),
                (b"referrer-policy", b"no-referrer"), (b"x-content-type-options", b"nosniff")]})
            await send({"type": "http.response.body", "body": body})
            return

        async def wrapped(message):
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                names = {k.lower() for k, _ in headers}
                if b"content-security-policy" not in names:
                    headers.append((b"content-security-policy", CSP.encode()))
                if b"referrer-policy" not in names:
                    headers.append((b"referrer-policy", b"no-referrer"))
                if b"x-content-type-options" not in names:
                    headers.append((b"x-content-type-options", b"nosniff"))
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, wrapped)


class ActivityMiddleware:
    """Pure ASGI: each HTTP request (other than the live-update stream, which counts while it is
    open) tells the reconciler someone is using the viewer."""

    def __init__(self, app, *, reconciler: Reconciler):
        self.app = app
        self.reconciler = reconciler

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope["path"] != "/api/events":
            self.reconciler.touch()
        await self.app(scope, receive, send)


def find_repo_prefix(root: str) -> str:
    cur = root
    while True:
        if os.path.lexists(os.path.join(cur, ".git")):
            rel = os.path.relpath(root, cur)
            return "" if rel == "." else rel.replace(os.sep, "/") + "/"
        parent = os.path.dirname(cur)
        if parent == cur:
            return ""
        cur = parent


def config_payload(settings: Settings, *, root_present: bool, editor: Editor | None, git_enabled: bool,
                   repo_prefix: str = "", hiding: Hiding | None = None) -> dict:
    """The /api/config body shared by a root's app and the no-folder app (RootSwitcher); the
    caller adds the request-dependent tokens. hiding: the folder's hidden-file settings (whether
    they can be changed). ignore_patterns: the client's pre-check of new names (the server's
    path-aware check decides)."""
    root = settings.root if root_present else None
    ignore = list(settings.ignore)
    deny_lifted, _ = settings.deny_split()
    return {"root_name": os.path.basename(root) if root else None, "repo_prefix": repo_prefix,
            "search_max_bytes": settings.search_max_bytes, "version": __version__,
            "edit_enabled": editor is not None, "edit_off_reason": settings.edit_off_reason or None,
            "deny_patterns": list(settings.deny), "deny_except_patterns": list(settings.deny_except),
            "deny_lifted_patterns": list(deny_lifted),
            "ignore_patterns": ignore, "upload_ext": list(settings.upload_ext),
            "upload_max_bytes": settings.upload_max_bytes, "edit_max_bytes": settings.edit_max_bytes,
            "upload_max_files": MAX_UPLOAD_FILES, "root_path": root, "no_root": not root_present,
            "root_switch_enabled": False, "git_enabled": git_enabled, "desktop": settings.desktop,
            "reveal_enabled": settings.allow_reveal,
            "hiding_enabled": hiding.enabled if hiding is not None else False}


def mount_ui(app: FastAPI, ui_dir: str) -> None:
    """/print + the static export at /, or a 503 hint on / when the UI is not built."""
    def get(path: str):
        return app.api_route(path, methods=["GET", "HEAD"])

    if os.path.isdir(ui_dir):
        # The static export writes /print as print.html; StaticFiles does not add ".html".
        @get("/print")
        def ui_print():
            f = os.path.join(ui_dir, "print.html")
            if not os.path.isfile(f):
                return JSONResponse({"detail": "print page not built; run 'npm run build'"}, status_code=404)
            return FileResponse(f, media_type="text/html", headers={"Cache-Control": "no-cache"})

        app.mount("/", StaticFiles(directory=ui_dir, html=True), name="ui")
    else:
        msg = (f"UI build not found at {ui_dir}. Run 'npm run build' in the web/ "
               "directory; the API is still available under /api.")
        log.warning(msg)

        @get("/")
        def ui_missing():
            return JSONResponse({"detail": msg}, status_code=503)


def make_pdf_renderer(settings: Settings):
    """--desktop: rendered by the Electron shell over its bridge; else Playwright + system Chrome
    (playwright itself is only imported on the first export)."""
    if settings.desktop:
        from .desktop import BridgeClient, BridgePdfRenderer  # local: desktop imports roots imports app

        return BridgePdfRenderer(settings.port, BridgeClient(settings.bridge_url, settings.bridge_token))
    return PdfRenderer(settings.port)


def search_index_dir(settings: Settings) -> str | None:
    """<data_dir>/search, or None when the data dir overlaps the root (read-only mode never writes
    inside the browsed folder; the index then goes to a temporary file, see deltadeck.search)."""
    if settings.data_dir_overlaps_root():
        return None
    return os.path.join(settings.data_dir, INDEX_DIR)


def create_app(settings: Settings) -> FastAPI:
    if settings.root is None:
        raise ValueError("create_app needs a root (RootSwitcher serves the no-folder mode)")
    settings.validate()  # ConfigError: data dir overlaps the root while editing is enabled
    guard = PathGuard(settings)
    git = GitLink(settings, guard)  # detected on first use (off: not a repo, no git, --git off)
    ignored = GitIgnored(git.repo, guard)
    store = Store(guard, ignored)
    # the folder's hide rules and git toggle (data dir, never the folder), before the first scan
    hiding = Hiding(settings, guard, ignored, store, lambda: git.repo() is not None)
    hiding.install(load_prefs(settings) if hiding.enabled else HidingPrefs())
    store.hiding = hiding  # refresh_ignored also refreshes what git tracks in ignore-list folders
    editor = Editor(settings, guard, store) if settings.allow_edit else None
    index = SearchIndex(store, settings.search_max_bytes, index_dir=search_index_dir(settings),
                        max_files=settings.search_max_files, max_total_bytes=settings.search_max_total_bytes)
    repo_prefix = find_repo_prefix(settings.root)
    pdf = make_pdf_renderer(settings)
    closing = asyncio.Event()  # set on lifespan shutdown: ends this app's SSE streams (root switch)

    # the search index applies changes one at a time, in the order they were published
    index_pool = concurrent.futures.ThreadPoolExecutor(1, thread_name_prefix="search-apply")

    def index_done(fut: concurrent.futures.Future) -> None:
        if not fut.cancelled() and fut.exception() is not None:
            log.error("search index: applying a change failed", exc_info=fut.exception())

    async def on_change(ch: Change, wait: bool = True) -> None:
        """Publish ch ("change" SSE event) and update the search index; wait=False: the index
        follows in the background (a hide or show answers before a large folder is read)."""
        data = ch.to_json()
        store.publish(ch)
        try:
            fut = index_pool.submit(index.apply_change, data)
        except RuntimeError:  # shut down (the app is closing)
            return
        if wait:
            await asyncio.wrap_future(fut)
        else:
            fut.add_done_callback(index_done)

    def index_flush(timeout: float | None = None) -> None:
        """Block until the changes published so far are in the search index (tests)."""
        index_pool.submit(lambda: None).result(timeout)

    hiding.on_change = on_change
    quick_s, full_s, remote = backstop_intervals(settings)
    reconciler = Reconciler(store, on_change, quick_interval=quick_s, full_interval=full_s,
                            watching=settings.watch, pause_idle=not settings.rescan_when_idle, remote=remote)
    store.on_subscribe = reconciler.client_connected

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI):
        store.bind_loop(asyncio.get_running_loop())
        # files git tracks in ignore-list folders stay visible (a committed node_modules/patched.js)
        await asyncio.to_thread(hiding.refresh_tracked, True)
        # (also while the folder shows them, the default: the tree dims them)
        await asyncio.to_thread(ignored.refresh)  # failing: shown as before, asked again at the next pass
        await asyncio.to_thread(store.full_scan)
        reconciler.reset()
        index.start_background_build()
        stop = asyncio.Event()
        tasks = [asyncio.create_task(reconciler.run(stop))]
        if settings.watch:
            tasks.append(asyncio.create_task(watch_loop(store, on_change, stop, reconciler)))
        log.info("change detection: %s; directory pass %s, full pass %s%s",
                 "file watcher" if settings.watch else "no file watcher",
                 f"every {quick_s:g} s" if quick_s else "off", f"every {full_s:g} s" if full_s else "off",
                 " (network volume)" if remote else "")
        try:
            yield
        finally:
            closing.set()
            store.close_streams()
            stop.set()
            hiding.close()
            index.stop()
            index_pool.shutdown(wait=False, cancel_futures=True)
            for t in tasks:
                t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            await pdf.close()

    app = FastAPI(
        title="DeltaDeck", version=__version__, lifespan=lifespan,
        docs_url=None, redoc_url=None, openapi_url=None,
        telemetry={"tracing": False, "metrics": False, "logs": False,
                   "operation_spans": False, "auto_configure": False},
    )
    register_error_handler(app)  # PathError, DocxError, PdfError, ...: {"detail"} with their status
    app.state.settings = settings
    app.state.store = store
    app.state.index = index
    app.state.pdf = pdf
    app.state.editor = editor
    app.state.closing = closing
    app.state.git = git
    app.state.reconciler = reconciler
    app.state.hiding = hiding
    app.state.on_change = on_change
    app.state.index_flush = index_flush
    app.state.config_extra = None  # RootSwitcher: request -> {"root_switch_enabled", "root_token"?}

    def get(path: str):
        return app.api_route(path, methods=["GET", "HEAD"])

    @get("/api/config")
    def api_config(request: Request):
        out = config_payload(settings, root_present=True, editor=editor, git_enabled=git.repo() is not None,
                             repo_prefix=repo_prefix, hiding=hiding)
        if editor is not None and same_site_request(request):
            out["edit_token"] = editor.token
        if app.state.config_extra is not None:
            out.update(app.state.config_extra(request))
        return JSONResponse(out, headers={"Cache-Control": "no-store"})

    @get("/api/tree")
    def api_tree():
        return store.snapshot(denied=settings.allow_reveal)

    @get("/api/hidden")
    def api_hidden(path: str | None = None):
        """The children of one hidden folder, listed when it is expanded (Hidden files)."""
        return list_hidden_dir(store, guard, path, include_denied=settings.allow_reveal)

    register_file_routes(app, settings, guard, pdf, repo_prefix, store)

    @get("/api/search")
    def api_search(q: str = "", folder: str = "", types: str = "", limit: int = 50):
        return index.search(q, folder=folder, types=types, limit=limit)

    @get("/api/complete")
    def api_complete(prefix: str = "", path: str = "", limit: int = MAX_COMPLETE):
        """Project-wide identifiers for editor completion, from the search index:
        {"names": [{name, def, files}], "capped": bool}."""
        if not 1 <= len(prefix) <= NAME_MAX:
            return JSONResponse({"detail": f"prefix must be 1 to {NAME_MAX} characters"}, status_code=400)
        if not 1 <= limit <= MAX_COMPLETE:
            return JSONResponse({"detail": f"limit must be 1 to {MAX_COMPLETE}"}, status_code=400)
        return index.complete(prefix, path=path, limit=limit)

    register_event_routes(app, store, closing)

    if editor is not None:
        register_edit_routes(app, editor, on_change)

    register_git_routes(app, git.repo, same_site_request)

    @get("/api/{rest:path}")
    def api_not_found(rest: str):
        return JSONResponse({"detail": "Not Found"}, status_code=404)

    mount_ui(app, settings.ui_dir)

    origins = {f"http://{h}:{p}" for h in ALLOWED_HOSTS for p in (settings.port, DEV_UI_PORT)}
    app.add_middleware(EditGate, token=editor.token if editor else None, origins=origins,
                       json_max=settings.edit_max_bytes * 6 + 64 * 1024,
                       upload_max=settings.upload_max_bytes * MAX_UPLOAD_FILES + 1024 * 1024)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=ALLOWED_HOSTS)
    app.add_middleware(ActivityMiddleware, reconciler=reconciler)
    app.add_middleware(SecurityMiddleware)  # outermost: also covers TrustedHost rejections
    return app
