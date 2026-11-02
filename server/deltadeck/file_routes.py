"""The per-file read routes of a root's app: metadata, content, text chunks, raw bytes, csv,
xlsx, docx and PDF export. Path errors (PathError) and docx/PDF errors are HttpErrors, answered
by the app's handler (deltadeck.errors)."""

from __future__ import annotations

import hashlib
import logging
import os
from urllib.parse import quote

from fastapi import FastAPI, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response

from .config import Settings
from .docx import DOCX_MAX, convert_cached
from .http_common import same_site_request
from .paths import INLINE_MIME, PathGuard, ext_of, kind_of, mime_of
from .pdf import ORIENTATIONS, PAPERS, PdfJob
from .readers import CONTENT_MAX, read_content, read_csv, read_xlsx, text_chunks

log = logging.getLogger("deltadeck")

SVG_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:"
PDF_CSP = "default-src 'none'; object-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"


def register_file_routes(app: FastAPI, settings: Settings, guard: PathGuard, pdf, repo_prefix: str,
                         store=None) -> None:
    """Ignored and git-ignored files are readable by every route here. Denied files only by
    /api/file, /api/content and /api/text, with reveal=1 on a same-site request while reveal is
    enabled (read-only, no-store); every other route refuses them."""
    def get(path: str):
        return app.api_route(path, methods=["GET", "HEAD"])

    def hidden_reason(rel: str) -> str | None:
        return store.hidden_reason(rel) if store is not None else guard.hidden_reason(rel)

    def gate(request: Request, path: str | None, reveal: str):
        """(Resolved, stat, revealed): revealed when a denied file is shown on request."""
        want = reveal in ("1", "true") and settings.allow_reveal and same_site_request(request)
        r, st = guard.resolve_file(path, allow="denied" if want else "ignored")
        revealed = want and "deny" in (guard.hidden_reason(r.rel), guard.hidden_reason(guard.rel_of(r.real)))
        if revealed:
            log.info("showing protected file %s on request", r.rel)
        return r, st, revealed

    def reply(body: dict, revealed: bool):
        return JSONResponse(body, headers={"Cache-Control": "no-store"}) if revealed else body

    def meta(rel, real, st, revealed=False):
        name = os.path.basename(rel)
        kind = kind_of(name, real)
        out = {"path": rel, "name": name, "size": st.st_size, "mtime": st.st_mtime_ns / 1e9,
               "kind": kind, "ext": ext_of(name), "mime": mime_of(name, kind)}
        if (h := "deny" if revealed else hidden_reason(rel)) is not None:
            out["hidden"] = h
        return out

    @get("/api/file")
    def api_file(request: Request, path: str | None = None, reveal: str = "0"):
        r, st, revealed = gate(request, path, reveal)
        return reply(meta(r.rel, r.real, st, revealed), revealed)

    @get("/api/content")
    def api_content(request: Request, path: str | None = None, reveal: str = "0"):
        r, st, revealed = gate(request, path, reveal)
        if st.st_size > CONTENT_MAX:
            return JSONResponse({"detail": "file too large for full content; use /api/text",
                                 "size": st.st_size}, status_code=413)
        data, text = read_content(r.real)
        if text is None:
            return JSONResponse({"detail": "file too large", "size": len(data)}, status_code=413)
        return reply({"path": r.rel, "text": text,
                      "size": len(data), "truncated": False, "sha256": hashlib.sha256(data).hexdigest(),
                      "mtime": st.st_mtime_ns / 1e9}, revealed)

    @get("/api/text")
    def api_text(request: Request, path: str | None = None, start: int | None = Query(None, ge=0),
                 length: int | None = Query(None, ge=0), line: int | None = Query(None, ge=1), reveal: str = "0"):
        r, st, revealed = gate(request, path, reveal)
        res = text_chunks(r.real, st.st_size, start=start, length=length, line=line)
        out = {"path": r.rel, **res}
        if line is not None:
            out["line"] = line
        return reply(out, revealed)

    @get("/api/raw")
    def api_raw(path: str | None = None):
        r, st = guard.resolve_file(path, allow="ignored")
        name = os.path.basename(r.rel)
        ext = ext_of(name)
        headers = {"X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache"}
        if ext in INLINE_MIME:
            if ext == "svg":
                headers["Content-Security-Policy"] = SVG_CSP
            elif ext == "pdf":
                headers["Content-Security-Policy"] = PDF_CSP
            return FileResponse(r.real, media_type=INLINE_MIME[ext], filename=name,
                                content_disposition_type="inline", headers=headers, stat_result=st)
        return FileResponse(r.real, media_type="application/octet-stream", filename=name,
                            content_disposition_type="attachment", headers=headers, stat_result=st)

    @get("/api/csv")
    def api_csv(path: str | None = None):
        r, st = guard.resolve_file(path, allow="ignored")
        ext = ext_of(r.rel)
        if ext not in ("csv", "tsv"):
            return JSONResponse({"detail": "not a csv/tsv file"}, status_code=400)
        return {"path": r.rel, **read_csv(r.real, ext)}

    @get("/api/xlsx")
    def api_xlsx(path: str | None = None):
        r, st = guard.resolve_file(path, allow="ignored")
        if ext_of(r.rel) != "xlsx":
            return JSONResponse({"detail": "not an xlsx file"}, status_code=400)
        try:
            return {"path": r.rel, **read_xlsx(r.real)}
        except Exception as e:  # corrupt workbook
            return JSONResponse({"detail": f"could not read workbook: {type(e).__name__}"}, status_code=422)

    @get("/api/docx")
    def api_docx(path: str | None = None, fmt: str = Query("html", alias="format")):
        """A .docx converted once (cached): sanitized HTML for display plus markdown (search, change
        tracking). format=markdown skips the HTML and the images (the change tracker's fetch)."""
        r, st = guard.resolve_file(path, allow="ignored")
        if ext_of(r.rel) != "docx":
            return JSONResponse({"detail": "not a .docx file"}, status_code=400)
        if fmt not in ("html", "markdown"):
            return JSONResponse({"detail": "format must be html or markdown"}, status_code=400)
        if st.st_size > DOCX_MAX:
            return JSONResponse({"detail": f"document larger than {DOCX_MAX // (1024 * 1024)} MB",
                                 "size": st.st_size}, status_code=413)
        try:
            res = convert_cached(r.real, images=fmt == "html", st=st)
        except OSError:
            return JSONResponse({"detail": "could not read the file"}, status_code=404)
        out = {"path": r.rel, "markdown": res.markdown, "blocks": res.blocks, "warnings": res.warnings,
               "truncated": res.truncated, "images": res.images, "images_dropped": res.images_dropped,
               "size": st.st_size, "mtime": st.st_mtime_ns / 1e9}
        if fmt == "html":
            out["html"] = res.html
        return out

    @app.head("/api/pdf")
    def api_pdf_head():
        # HEAD would have to render to report the real length; answer it without a render.
        return JSONResponse({"detail": "Method Not Allowed"}, status_code=405, headers={"Allow": "GET"})

    @app.get("/api/pdf")
    async def api_pdf(request: Request, path: str | None = None, paper: str = "a4",
                      orientation: str = "portrait", toc: str = "0"):
        # Each export drives a headless Chrome: refuse cross-site triggers (e.g. an <img> on
        # some web page pointing here). The response is unreadable cross-origin anyway.
        if not same_site_request(request):
            return JSONResponse({"detail": "cross-site PDF export requests are refused"}, status_code=403)
        r, st = guard.resolve_file(path, allow="ignored")
        name = os.path.basename(r.rel)
        kind = kind_of(name, r.real)
        if kind not in ("markdown", "mermaid", "docx"):
            return JSONResponse({"detail": "PDF export is only available for markdown, mermaid and docx files"},
                                status_code=400)
        paper, orientation = paper.lower(), orientation.lower()
        if paper not in PAPERS or orientation not in ORIENTATIONS or toc not in ("0", "1", "true", "false"):
            return JSONResponse({"detail": "paper must be a4|letter, orientation portrait|landscape, toc 0|1"},
                                status_code=400)
        if st.st_size > (DOCX_MAX if kind == "docx" else CONTENT_MAX):
            return JSONResponse({"detail": "file too large to export", "size": st.st_size}, status_code=413)
        if not os.path.isfile(os.path.join(settings.ui_dir, "print.html")):
            return JSONResponse({"detail": "UI build not found; run 'npm run build' in web/"}, status_code=503)
        job = PdfJob(path=r.rel, display_path=f"{repo_prefix}{r.rel}", title=name, paper=paper,
                     orientation=orientation, toc=toc in ("1", "true"))
        data, errors = await pdf.render(job)
        stem = name.rsplit(".", 1)[0] if "." in name.lstrip(".") else name
        fname = f"{stem}.pdf"
        ascii_name = "".join(c if c.isascii() and c.isprintable() and c not in '"\\;' else "_" for c in fname)
        headers = {"Content-Disposition": f'attachment; filename="{ascii_name}"; '
                                          f"filename*=UTF-8''{quote(fname, safe='')}",
                   "Cache-Control": "no-store",
                   "X-PDF-Mermaid-Errors": str(int(errors.get("mermaid", 0) or 0)),
                   "X-PDF-Image-Errors": str(int(errors.get("images", 0) or 0)),
                   "X-PDF-Orientation": str(errors.get("orientation") or orientation)}
        return Response(content=data, media_type="application/pdf", headers=headers)
