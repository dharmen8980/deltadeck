"""The live-update stream of a root's app: /api/events (server-sent events from the Store)."""

from __future__ import annotations

import asyncio
import json

import anyio
from fastapi import FastAPI
from sse_starlette.sse import EventSourceResponse, ServerSentEvent

from .store import STREAM_CLOSED, Store


def register_event_routes(app: FastAPI, store: Store, closing: asyncio.Event) -> None:
    """`closing` is set when the app shuts down (folder switch): every open stream then ends."""

    @app.get("/api/events")
    async def api_events():
        q = store.subscribe()
        shutdown = anyio.Event()  # set by sse-starlette when the server starts shutting down

        async def gen():
            try:
                # flush headers immediately (proxies such as `next dev` hold
                # them until the first byte) and set the client retry delay
                yield ServerSentEvent(comment="connected", retry=3000)
                while not shutdown.is_set() and not closing.is_set():
                    data = None
                    # closing (folder switch) queues STREAM_CLOSED; on server shutdown sse-starlette
                    # sets `shutdown` and cancels this after its grace period: no need to wake often
                    with anyio.move_on_after(5):
                        data = await q.get()
                    if data is None:
                        continue
                    if data is STREAM_CLOSED:
                        break
                    event, data = data if isinstance(data, tuple) else ("change", data)
                    yield {"event": event, "data": json.dumps(data)}
            finally:
                store.unsubscribe(q)

        return EventSourceResponse(gen(), ping=15, shutdown_event=shutdown, shutdown_grace_period=1.0,
                                   headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
