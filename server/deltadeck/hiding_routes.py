"""/api/hiding*: a folder's hidden-file settings (hiding.py), served by the RootSwitcher's control
app behind RootGate (X-Root-Token, same-origin, JSON, ROOTS_JSON_MAX), like /api/seen. Allowed in
--read-only mode and with --lock-root: they only write <data dir>/roots/<key>/hiding.json."""

from __future__ import annotations

import asyncio
from collections.abc import Callable

from fastapi import FastAPI, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StrictBool

from .errors import no_store_json
from .hidden import count_files
from .hiding import MAX_ADD, MAX_RULES, HidingError
from .http_common import HIDING_PREFIX, same_site_request

CLIENT_ID_MAX = 64
COUNT_PATHS_MAX = 50  # paths per /api/hiding/count request


class HidingUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")  # an old client's hide_paths or builtin: 422
    root: str
    client: str | None = Field(None, max_length=CLIENT_ID_MAX)  # echoed in the "hiding" SSE event
    hide_git: StrictBool | None = None
    add_rules: list[str] | None = Field(None, max_length=MAX_ADD)
    remove_rules: list[str] | None = Field(None, max_length=MAX_RULES)
    # show + hide: at most MAX_PATHS together, checked by Hiding.update (400; the body is <= 64 KB)
    show: list[str] | None = None
    hide: list[str] | None = None


def register_hiding_routes(app: FastAPI, current: Callable[[], object | None]) -> None:
    """`current()` -> the inner app wrapper (`.app.state.hiding`, `.settings`) or None. Every
    request names the root it was made for; a mismatch (the folder was switched since) is a 409.
    The control app's RequestValidationError handler (seen.py) answers bad bodies with 422."""
    j = no_store_json

    def ctx(root: str | None):
        inner = current()
        if inner is None:
            return j({"detail": "no folder selected"}, 409)
        if root != inner.settings.root:
            return j({"detail": "folder changed"}, 409)
        return inner.app.state.hiding

    @app.api_route(HIDING_PREFIX, methods=["GET", "HEAD"])
    async def hiding_get(request: Request, root: str | None = None):
        if not same_site_request(request):
            return j({"detail": "cross-site requests are refused"}, 403)
        hiding = ctx(root)
        if isinstance(hiding, JSONResponse):
            return hiding
        return j(await asyncio.to_thread(hiding.state))  # state() may detect git (a subprocess)

    @app.api_route(HIDING_PREFIX + "/items", methods=["GET", "HEAD"])
    async def hiding_items(request: Request, root: str | None = None):
        """What is hidden in the folder (the Hidden files dialog); asks git first (throttled)."""
        if not same_site_request(request):
            return j({"detail": "cross-site requests are refused"}, 403)
        hiding = ctx(root)
        if isinstance(hiding, JSONResponse):
            return hiding
        reveal = current().settings.allow_reveal
        # a pending update settles first, in order with every other settle (its "change" goes out
        # before a later update's)
        await hiding.settle()
        body, changes = await asyncio.to_thread(hiding.items, reveal=reveal, settle=False)
        if changes:
            await hiding.publish(changes, state=False)
        return j(body)

    @app.api_route(HIDING_PREFIX + "/count", methods=["GET", "HEAD"])
    async def hiding_count(request: Request, root: str | None = None, path: list[str] = Query(default=[])):
        """Bounded file counts below hidden items (hidden.count_files)."""
        if not same_site_request(request):
            return j({"detail": "cross-site requests are refused"}, 403)
        hiding = ctx(root)
        if isinstance(hiding, JSONResponse):
            return hiding
        if not 1 <= len(path) <= COUNT_PATHS_MAX:
            return j({"detail": f"give 1 to {COUNT_PATHS_MAX} paths"}, 400)
        reveal = current().settings.allow_reveal
        return j(await asyncio.to_thread(count_files, hiding.guard, path, reveal=reveal))

    @app.post(HIDING_PREFIX + "/update")
    async def hiding_update(b: HidingUpdate):
        hiding = ctx(b.root)
        if isinstance(hiding, JSONResponse):
            return hiding
        before = hiding.version
        try:
            # in a worker thread: it reads and writes hiding.json (no git, no scan)
            state = await asyncio.to_thread(
                hiding.update, hide_git=b.hide_git, add_rules=b.add_rules or (), remove_rules=b.remove_rules or (),
                show=b.show or (), hide=b.hide or ())
        except HidingError as e:
            return j(e.to_json(), e.status)
        # the tree follows: "change" (tree; the search index in the background), then "hiding"; a
        # big change answers "pending" and its "change" comes later
        applied = await hiding.settle_after_update()
        await hiding.publish((), b.client, state=hiding.version != before)
        return j({**state, "applied": applied})

    @app.api_route(HIDING_PREFIX + "/{rest:path}", methods=["GET", "HEAD", "POST"])
    async def hiding_not_found(rest: str):
        return j({"detail": "Not Found"}, 404)
