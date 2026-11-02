"""HTTP pieces shared by the per-root app (app.py), the outer RootSwitcher (roots.py) and the
route modules: path prefixes, the loopback host allowlist, the same-site check and a raw ASGI
JSON reply. Kept free of viewer imports so any module can use it without an import cycle."""

from __future__ import annotations

import json
from urllib.parse import urlsplit

from fastapi import Request

ALLOWED_HOSTS = ["127.0.0.1", "localhost"]
ROOTS_PREFIX = "/api/roots"  # folder switching; served by the outer RootSwitcher (roots.py), RootGate-guarded
SEEN_PREFIX = "/api/seen"  # "changed since you last looked" history (seen.py); same outer app and gate


def is_roots_path(path: str) -> bool:
    return path == ROOTS_PREFIX or path.startswith(ROOTS_PREFIX + "/")


def is_seen_path(path: str) -> bool:
    return path == SEEN_PREFIX or path.startswith(SEEN_PREFIX + "/")


def is_gated_path(path: str) -> bool:
    """Paths the outer RootSwitcher serves itself, behind RootGate."""
    return is_roots_path(path) or is_seen_path(path)


def host_only(value: str) -> str:
    value = value.strip().lower()
    if value.startswith("["):
        return value.split("]", 1)[0] + "]"
    return value.rsplit(":", 1)[0] if value.count(":") == 1 else value


def forwarded_hosts_ok(scope) -> bool:
    """DNS-rebinding defence behind the `next dev` proxy: the proxy rewrites Host to
    127.0.0.1 but reports the browser's Host in X-Forwarded-Host, so check that too."""
    for k, v in scope.get("headers", []):
        if k.lower() in (b"x-forwarded-host", b"forwarded"):
            text = v.decode("latin-1")
            if k.lower() == b"forwarded":
                vals = [p.split("=", 1)[1].strip('"') for part in text.split(",")
                        for p in part.split(";") if p.strip().lower().startswith("host=")]
            else:
                vals = text.split(",")
            if any(host_only(h) not in ALLOWED_HOSTS for h in vals if h.strip()):
                return False
    return True


def same_site_request(request: Request) -> bool:
    """True unless the browser says the request came from another site: Sec-Fetch-Site must be
    absent, 'same-origin' or 'none' (typed URL), and Origin absent or a loopback origin (the
    viewer itself or the `next dev` server on another loopback port)."""
    sfs = request.headers.get("sec-fetch-site")
    if sfs is not None and sfs.strip().lower() not in ("same-origin", "none"):
        return False
    origin = request.headers.get("origin")
    if origin is not None:
        try:
            u = urlsplit(origin.strip())
            ok = u.scheme == "http" and (u.hostname or "") in ALLOWED_HOSTS and not u.path.strip("/")
            u.port  # noqa: B018 - raises on a malformed port
        except ValueError:
            return False
        if not ok:
            return False
    return True


async def send_json(send, status: int, data: dict, extra_headers=()) -> None:
    """A complete no-store JSON response from pure ASGI code (the gates)."""
    body = json.dumps(data).encode()
    await send({"type": "http.response.start", "status": status, "headers": [
        (b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()),
        (b"cache-control", b"no-store"), *extra_headers]})
    await send({"type": "http.response.body", "body": body})
