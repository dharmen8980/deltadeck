"""HTTP routes for the read-only git views (deltadeck.git): /api/git/status, /file, /blame."""

from __future__ import annotations

from fastapi import FastAPI, Query, Request
from fastapi.responses import JSONResponse

from .git import BLAME_CHUNK, BLAME_MAX_CHUNK, GitError
from .paths import PathError


def register_git_routes(app: FastAPI, repo_of, same_site) -> None:
    """GET /api/git/status, /api/git/file, /api/git/blame on the per-root app. `repo_of()` -> the
    GitRepo or None (git off for this folder). Cross-site requests are refused (each call starts
    git processes), as for /api/pdf."""
    headers = {"Cache-Control": "no-store"}

    def guarded(request: Request):
        if not same_site(request):
            return JSONResponse({"detail": "cross-site git requests are refused"}, status_code=403)
        repo = repo_of()
        if repo is None:
            return JSONResponse({"detail": "git is not enabled for this folder"}, status_code=404)
        return repo

    def answer(fn):
        try:
            return JSONResponse(fn(), headers=headers)
        except (PathError, GitError) as e:
            return JSONResponse({"detail": e.detail}, status_code=e.status, headers=headers)

    def get(path: str):
        return app.api_route(path, methods=["GET", "HEAD"])

    @get("/api/git/status")
    def git_status(request: Request):
        repo = guarded(request)
        return repo if isinstance(repo, JSONResponse) else answer(repo.status)

    @get("/api/git/file")
    def git_file(request: Request, path: str | None = None):
        repo = guarded(request)
        return repo if isinstance(repo, JSONResponse) else answer(lambda: repo.file(path))

    @get("/api/git/blame")
    def git_blame(request: Request, path: str | None = None, start: int = Query(1, ge=1),
                  count: int = Query(BLAME_CHUNK, ge=1, le=BLAME_MAX_CHUNK)):
        repo = guarded(request)
        return repo if isinstance(repo, JSONResponse) else answer(lambda: repo.blame(path, start, count))
