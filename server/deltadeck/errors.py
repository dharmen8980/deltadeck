"""The shared HTTP error type: modules raise a subclass of HttpError with the status to answer and
a user-facing detail; a route either catches it or lets the app's handler turn it into
{"detail": ...} with that status."""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

NO_STORE = {"Cache-Control": "no-store"}


class HttpError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


def error_response(e: HttpError, headers: dict | None = None) -> JSONResponse:
    return JSONResponse({"detail": e.detail}, status_code=e.status, headers=headers)


def register_error_handler(app: FastAPI) -> None:
    """An uncaught HttpError answers {"detail": e.detail} with e.status (instead of a 500)."""

    @app.exception_handler(HttpError)
    async def _http_error(request: Request, e: HttpError):
        return error_response(e)


def no_store_json(data: dict, status: int = 200) -> JSONResponse:
    return JSONResponse(data, status_code=status, headers=NO_STORE)
