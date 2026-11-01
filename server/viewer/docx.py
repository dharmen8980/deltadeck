"""Read-only .docx conversion: one pipeline, two outputs.

    convert_cached(real, images=)     -> DocxResult for a file on disk (cached by path, mtime, size)
    convert_blob_cached(oid, read)    -> DocxResult without images for a git blob (cached by object id)
    convert_docx(real|bytes, images=) -> uncached DocxResult: sanitized HTML (images as data: URIs,
                                         or none), markdown for search / change tracking / agents,
                                         the block line map and the warnings

mammoth turns the document into HTML; that HTML is then parsed (html.parser) into a small tree
that keeps only an allowlist of tags and attributes, and the same tree is serialised back to HTML
and converted to markdown. Before mammoth sees the file, the zip's directory is checked (sizes,
ratios, member count) and every part that looks like XML - by its content, not its name, since
mammoth follows the relationships to any part - is size-checked and scanned for DOCTYPE / ENTITY
declarations, so mammoth (xml.dom.minidom) never parses a zip bomb, an oversized DOM or an
entity-expansion attack. Results are cached by (real path, mtime, size), git blobs by object id."""

from __future__ import annotations

import base64
import collections
import html
import io
import os
import re
import threading
import typing
import zipfile
import zlib
from dataclasses import dataclass, field
from html.parser import HTMLParser

from .errors import HttpError
from .readers import CONTENT_MAX, MB

DOCX_MAX = 20 * MB  # the .docx file itself
UNCOMPRESSED_MAX = 128 * MB  # sum of the declared uncompressed sizes of every zip member
XML_PART_MAX = 8 * MB  # one XML part (minidom builds a DOM of it)
XML_TOTAL_MAX = 24 * MB  # all XML parts together (mammoth parses up to six of them)
XML_TOTAL_BACKGROUND_MAX = 12 * MB  # search indexing skips bigger documents
BUSY_TIMEOUT = 30.0  # seconds a request waits for a running conversion, then 503
RATIO_MAX = 200  # uncompressed / compressed, for members over RATIO_MIN
RATIO_MIN = 1 * MB
MEMBERS_MAX = 10_000
IMAGE_MAX = 5 * MB  # one embedded image
IMAGES_TOTAL_MAX = 16 * MB  # all embedded images of a document
IMAGES_COUNT_MAX = 200
HTML_MAX = 4 * MB  # the markup without image data
MARKDOWN_MAX = CONTENT_MAX  # UTF-8 bytes; fits /api/content-sized snapshots and the search limit
WARNINGS_MAX = 20
CACHE_ENTRIES = 16
CACHE_BYTES = 96 * MB

IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"}
OLE_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"  # encrypted .docx and old .doc files


class DocxError(HttpError):
    pass


@dataclass
class DocxResult:
    html: str | None  # None: converted without images (markdown only)
    markdown: str
    blocks: list[list[int]]  # 1-based [start, end] markdown lines of each top-level HTML element
    warnings: list[str] = field(default_factory=list)
    truncated: bool = False
    images: int = 0  # embedded as data: URIs
    images_dropped: int = 0  # over the limits or an unsupported format (alt text kept)

    def nbytes(self) -> int:
        return len(self.html or "") + len(self.markdown) + 64 * len(self.blocks)


# --- zip and XML checks --------------------------------------------------------------------------
_DECL = re.compile(rb"<!\s*(DOCTYPE|ENTITY)", re.IGNORECASE)


def _looks_like_xml(z: zipfile.ZipFile, info: zipfile.ZipInfo) -> bool:
    """True when the part could be parsed as XML, whatever its name: mammoth follows the
    relationships (any Target), not the extension. A part is XML unless its first significant
    character (after a BOM and whitespace, UTF-16 decoded) is something other than '<'."""
    if info.file_size == 0:
        return False
    with z.open(info) as f:
        head = f.read(4096)
    if head[:3] == b"\xef\xbb\xbf":
        head = head[3:]
    if head[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return True
    if head[:1] == b"\0" or head[1:2] == b"\0":  # UTF-16 without a BOM
        text = head[:len(head) & ~1].decode("utf-16-be" if head[:1] == b"\0" else "utf-16-le", errors="ignore")
        text = text.lstrip(" \t\r\n")
        return not text or text[0] == "<"
    head = head.lstrip(b" \t\r\n")
    return not head or head[:1] == b"<"  # all whitespace so far: count it as XML


def _xml_declares_entities(z: zipfile.ZipFile, info: zipfile.ZipInfo) -> bool:
    """True when the part has a DOCTYPE or ENTITY declaration (never present in a real docx).
    UTF-16 parts are checked decoded; read in chunks with an overlap so no match is split."""
    tail = b""
    first = True
    utf16 = None
    with z.open(info) as f:
        while True:
            chunk = f.read(1 * MB)
            if not chunk:
                return False
            if first:
                first = False
                if chunk[:2] in (b"\xff\xfe", b"\xfe\xff") or b"\0" in chunk[:64]:
                    utf16 = "utf-16-be" if chunk[:2] == b"\xfe\xff" or chunk[:1] == b"\0" else "utf-16-le"
            if utf16:
                chunk = chunk.decode(utf16, errors="ignore").encode("utf-8")
            data = tail + chunk
            if _DECL.search(data):
                return True
            tail = data[-32:]


def check_package(z: zipfile.ZipFile, *, xml_total_max: int | None = None) -> None:
    """Refuse zip bombs, oversized XML and entity declarations before mammoth reads anything.
    Every part that looks like XML counts (see _looks_like_xml), not only *.xml / *.rels."""
    infos = z.infolist()
    if len(infos) > MEMBERS_MAX:
        raise DocxError(422, "not a usable .docx: too many parts")
    total = 0
    for i in infos:
        if i.flag_bits & 0x1:
            raise DocxError(422, "the document is encrypted")
        total += i.file_size
        if i.file_size > RATIO_MIN and i.file_size > RATIO_MAX * max(i.compress_size, 1):
            raise DocxError(413, "refused: a part of the document expands too much (zip bomb?)")
    if total > UNCOMPRESSED_MAX:
        raise DocxError(413, f"document too large when uncompressed ({total} bytes)")
    names = {i.filename for i in infos}
    # mammoth finds the main part through _rels/.rels (some writers name it word/document2.xml),
    # else falls back to word/document.xml
    if "word/document.xml" not in names and "_rels/.rels" not in names:
        raise DocxError(422, "not a .docx document (no word/document.xml)")
    xml_max = XML_TOTAL_MAX if xml_total_max is None else xml_total_max
    xml = [i for i in infos if _looks_like_xml(z, i)]
    xml_total = 0
    for i in xml:
        if i.file_size > XML_PART_MAX:
            raise DocxError(413, f"document part too large to read ({i.file_size} bytes)")
        xml_total += i.file_size
        if xml_total > xml_max:
            raise DocxError(413, f"document too large to read (over {xml_max // MB} MB of XML)")
    for i in xml:
        if _xml_declares_entities(z, i):
            raise DocxError(422, "refused: the document declares XML entities (DOCTYPE)")


def _open(source: str | bytes) -> tuple[bytes, zipfile.ZipFile]:
    if isinstance(source, bytes):
        data = source
    else:
        with open(source, "rb") as f:
            data = f.read(DOCX_MAX + 1)
    if len(data) > DOCX_MAX:
        raise DocxError(413, f"document larger than {DOCX_MAX // MB} MB")
    if data[:8] == OLE_MAGIC:
        raise DocxError(422, "password-protected document, or an old .doc file (not supported)")
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except (zipfile.BadZipFile, OSError, ValueError):
        raise DocxError(422, "not a .docx document (not a zip file)") from None
    return data, z


# --- sanitising ----------------------------------------------------------------------------------
BLOCK_TAGS = {"h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "li", "table", "thead", "tbody",
              "tfoot", "tr", "th", "td", "blockquote", "pre", "hr"}
INLINE_TAGS = {"br", "strong", "b", "em", "i", "u", "s", "sub", "sup", "a", "img", "code"}
ALLOWED = BLOCK_TAGS | INLINE_TAGS
VOID = {"br", "hr", "img"}
DROP_WITH_CONTENT = {"script", "style", "template", "iframe", "object", "embed", "svg", "math", "noscript",
                     "textarea", "title", "head", "select", "option", "frameset", "frame", "noembed", "xmp"}
TOP_BLOCKS = {"h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "table", "blockquote", "pre", "hr"}
_ID = re.compile(r"[A-Za-z_][A-Za-z0-9_.:-]{0,127}\Z")
_SPAN = re.compile(r"[1-9][0-9]{0,2}\Z")
_DATA_IMG = re.compile(r"data:(image/(?:png|jpeg|gif|webp|bmp));base64,[A-Za-z0-9+/=]+\Z")
_CTRL = re.compile(r"[\x00-\x20\x7f]+")


def safe_href(href: str) -> str | None:
    """http(s), mailto and in-document #fragments; anything else is refused (None)."""
    h = href.strip()
    if h.startswith("#"):
        return h if _ID.match(h[1:]) else None
    probe = _CTRL.sub("", h).lower()
    if probe.startswith(("http://", "https://", "mailto:")):
        return h if not any(c in h for c in "\x00\r\n\t") else None
    return None


class Node:
    __slots__ = ("tag", "attrs", "children")

    def __init__(self, tag: str, attrs: dict[str, str] | None = None):
        self.tag = tag
        self.attrs = attrs or {}
        self.children: list[Node | str] = []


def _clean_attrs(tag: str, attrs: list[tuple[str, str | None]]) -> dict[str, str] | None:
    """The allowed attributes of `tag`; None means 'drop the element, keep its children'."""
    a = {k.lower(): (v or "") for k, v in attrs}
    out: dict[str, str] = {}
    if tag == "a":
        href = safe_href(a["href"]) if "href" in a else None
        if href is not None:
            out["href"] = href
        if "id" in a and _ID.match(a["id"]):
            out["id"] = a["id"]
        return out or None
    if tag == "img":
        if _DATA_IMG.match(a.get("src", "")):
            out["src"] = a["src"]
        out["alt"] = a.get("alt", "")
        return out
    if tag in ("td", "th"):
        for k in ("colspan", "rowspan"):
            if k in a and _SPAN.match(a[k].strip()):
                out[k] = a[k].strip()
        return out
    if tag == "li" and "id" in a and _ID.match(a["id"]):
        out["id"] = a["id"]
    return out


class _Sanitizer(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("#root")
        # open elements: (tag, node); node None for an element that was dropped but whose children are kept
        self.open: list[tuple[str, Node | None]] = []
        self.skip = 0  # depth inside a DROP_WITH_CONTENT element

    def _parent(self) -> Node:
        for _tag, node in reversed(self.open):
            if node is not None:
                return node
        return self.root

    def handle_starttag(self, tag, attrs):
        if self.skip:
            if tag in DROP_WITH_CONTENT:
                self.skip += 1
            return
        if tag in DROP_WITH_CONTENT:
            self.skip = 1
            return
        clean = _clean_attrs(tag, attrs) if tag in ALLOWED else None
        node = Node(tag, clean) if clean is not None else None
        if node is not None:
            self._parent().children.append(node)
        if tag not in VOID:
            self.open.append((tag, node))

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID and not self.skip:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if self.skip:
            if tag in DROP_WITH_CONTENT:
                self.skip -= 1
            return
        for i in range(len(self.open) - 1, -1, -1):
            if self.open[i][0] == tag:
                del self.open[i:]
                return

    def handle_data(self, data):
        if not self.skip and data:
            self._parent().children.append(data)


def sanitize(markup: str) -> Node:
    """Parse `markup` into a tree of allowed elements only (top-level inline content wrapped in <p>)."""
    p = _Sanitizer()
    p.feed(markup)
    p.close()
    out = Node("#root")
    loose: list[Node | str] = []

    def flush():
        if any(isinstance(c, Node) or c.strip() for c in loose):
            para = Node("p")
            para.children = list(loose)
            out.children.append(para)
        loose.clear()

    for c in p.root.children:
        if isinstance(c, Node) and c.tag in TOP_BLOCKS:
            flush()
            out.children.append(c)
        elif isinstance(c, Node) and c.tag in BLOCK_TAGS:  # stray li/tr/td...: keep the text
            flush()
            para = Node("p")
            para.children = [_text_of(c)]
            out.children.append(para)
        else:
            loose.append(c)
    flush()
    return out


def _text_of(n: Node | str) -> str:
    return n if isinstance(n, str) else "".join(_text_of(c) for c in n.children)


def to_html(n: Node | str) -> str:
    if isinstance(n, str):
        return html.escape(n, quote=False)
    attrs = "".join(f' {k}="{html.escape(v, quote=True)}"' for k, v in n.attrs.items())
    if n.tag in VOID:
        return f"<{n.tag}{attrs}>"
    return f"<{n.tag}{attrs}>{''.join(to_html(c) for c in n.children)}</{n.tag}>"


def _markup_len(n: Node | str) -> int:
    """HTML length without image data."""
    if isinstance(n, str):
        return len(n)
    return 16 + sum(len(k) + len(v) for k, v in n.attrs.items() if k != "src") + sum(map(_markup_len, n.children))


# --- markdown ------------------------------------------------------------------------------------
_NOTE_ID = re.compile(r"(footnote|endnote)-(?!ref-)(.+)\Z")
_NOTE_REF_ID = re.compile(r"(footnote|endnote)-ref-(.+)\Z")
_WS = re.compile(r"[ \t\r\n\f\v]+")
_BR = "\x00"
_LINE_START = re.compile(r"^([#>+=|-]|\d+[.)])", re.MULTILINE)


def _note_label(kind: str, ident: str) -> str:
    ident = re.sub(r"[^\w-]", "", ident) or "x"
    return ident if kind == "footnote" else f"e{ident}"


def md_escape(s: str) -> str:
    s = re.sub(r"([\\`*\[\]<~])", r"\\\1", s)
    s = re.sub(r"(?<![^\W_])_|_(?![^\W_])", r"\\_", s)
    return re.sub(r"&(?=#?[A-Za-z0-9]+;)", r"\\&", s)


def _wrap(mark: str, inner: str) -> str:
    core = inner.strip()
    if not core:
        return inner
    lead = inner[:len(inner) - len(inner.lstrip())]
    trail = inner[len(inner.rstrip()):]
    return f"{lead}{mark}{core}{mark}{trail}"


def _code_span(text: str) -> str:
    text = _WS.sub(" ", text)
    if not text.strip():
        return text
    n = max((len(m) for m in re.findall(r"`+", text)), default=0) + 1
    pad = " " if text.startswith("`") or text.endswith("`") else ""
    return f"{'`' * n}{pad}{text}{pad}{'`' * n}"


def _inline(n: Node | str) -> str:
    if isinstance(n, str):
        return md_escape(_WS.sub(" ", n))
    t = n.tag
    if t == "br":
        return _BR
    if t == "img":
        return f"![{md_escape(n.attrs.get('alt', '')).strip()}]()"
    if t == "code":
        return _code_span(_text_of(n))
    if t == "a":
        href = n.attrs.get("href")
        if href and href.startswith("#"):
            m = _NOTE_ID.match(href[1:])
            if m:
                return f"[^{_note_label(m.group(1), m.group(2))}]"
            if _NOTE_REF_ID.match(href[1:]):
                return ""  # the "back to the text" arrow of a note
        inner = "".join(map(_inline, n.children))
        if not href:
            return inner
        dest = href.replace(" ", "%20").replace("(", "%28").replace(")", "%29").replace("<", "%3C").replace(">", "%3E")
        return f"[{inner.strip() or md_escape(href)}]({dest})"
    inner = "".join(map(_inline, n.children))
    if t == "sup" and len(n.children) == 1 and isinstance(n.children[0], Node) and n.children[0].tag == "a":
        href = n.children[0].attrs.get("href", "")
        if _NOTE_ID.match(href[1:] if href.startswith("#") else ""):
            return inner  # a note reference: [^1], not ^[^1]
    if t in ("strong", "b"):
        return _wrap("**", inner)
    if t in ("em", "i"):
        return _wrap("*", inner)
    if t == "s":
        return _wrap("~~", inner)
    if t in BLOCK_TAGS:  # a block inside inline content (a table cell's paragraphs)
        return f" {inner} "
    return inner  # u, sub, sup: no markdown for them


def _paragraph(nodes: list[Node | str], *, breaks: str = "\\\n") -> str:
    text = "".join(map(_inline, nodes))
    text = re.sub(r" *\x00 *", _BR, text)
    text = _WS.sub(" ", text.replace("\n", " ")).strip(" " + _BR)
    text = text.replace(_BR, breaks)
    if breaks != "\\\n":
        return text
    return _LINE_START.sub(r"\\\1", text)


def _indent(text: str, pad: str) -> str:
    return "\n".join((pad + ln) if ln else ln for ln in text.split("\n"))


def _is_note_list(n: Node) -> bool:
    items = [c for c in n.children if isinstance(c, Node)]
    return n.tag == "ol" and bool(items) and all(c.tag == "li" and _NOTE_ID.match(c.attrs.get("id", "")) for c in items)


def _list(n: Node, bullet: str) -> str:
    out = []
    num = 0
    for li in n.children:
        if not isinstance(li, Node):
            continue
        num += 1
        marker = f"{num}{bullet} " if n.tag == "ol" else f"{bullet} "
        body = _blocks_of(li.children if li.tag == "li" else [li], tight=True)
        first, _, rest = body.partition("\n")
        item = marker + first
        if rest:
            item += "\n" + _indent(rest, " " * len(marker))
        out.append(item.rstrip())
    return "\n".join(out)


def _blocks_of(children: list[Node | str], *, tight: bool = False) -> str:
    """Markdown of mixed content (a list item or a note): inline runs become paragraphs."""
    parts: list[str] = []
    run: list[Node | str] = []

    def flush():
        if run:
            p = _paragraph(run)
            if p:
                parts.append(p)
            run.clear()

    for c in children:
        if isinstance(c, Node) and c.tag in BLOCK_TAGS:
            flush()
            b = _block(c, bullet="-")
            if b:
                parts.append(b)
        else:
            run.append(c)
    flush()
    if not tight:
        return "\n\n".join(parts)
    # a nested list follows its text directly; further paragraphs are separated by a blank line
    out = ""
    for i, p in enumerate(parts):
        if i == 0:
            out = p
        elif re.match(r"([-*+]|\d+[.)]) ", p):
            out += "\n" + p
        else:
            out += "\n\n" + p
    return out


def _rows(n: Node) -> list[Node]:
    rows = []
    for c in n.children:
        if isinstance(c, Node):
            if c.tag == "tr":
                rows.append(c)
            elif c.tag in ("thead", "tbody", "tfoot"):
                rows.extend(r for r in c.children if isinstance(r, Node) and r.tag == "tr")
    return rows


def _table(n: Node) -> str:
    grid: list[list[str]] = []
    pending: dict[int, int] = {}  # column -> rows still covered by a rowspan from above
    for tr in _rows(n):
        row: list[str] = []

        def skip_covered():
            while pending.get(len(row), 0) > 0:
                row.append("")

        for cell in tr.children:
            if not isinstance(cell, Node) or cell.tag not in ("td", "th"):
                continue
            skip_covered()
            text = _paragraph(cell.children, breaks=" ").replace("|", "\\|")
            colspan = min(int(cell.attrs.get("colspan", "1")), 100)
            rowspan = min(int(cell.attrs.get("rowspan", "1")), 100)
            for c in range(len(row), len(row) + colspan):
                if rowspan > 1:
                    pending[c] = rowspan  # decremented below, together with the others
            row.append(text)
            row.extend([""] * (colspan - 1))
        skip_covered()
        for c in [c for c in pending if c >= len(row)]:  # covered columns right of the last cell
            while len(row) <= c:
                row.append("")
        for c in list(pending):
            pending[c] -= 1
            if pending[c] <= 0:
                del pending[c]
        grid.append(row)
    if not grid:
        return ""
    cols = max(1, max(len(r) for r in grid))
    grid = [r + [""] * (cols - len(r)) for r in grid]
    lines = ["| " + " | ".join(grid[0]) + " |", "|" + "|".join(" --- " for _ in range(cols)) + "|"]
    lines += ["| " + " | ".join(r) + " |" for r in grid[1:]]
    return "\n".join(lines)


def _block(n: Node, *, bullet: str = "-") -> str:
    t = n.tag
    if t in ("h1", "h2", "h3", "h4", "h5", "h6"):
        text = _paragraph(n.children, breaks=" ")
        return f"{'#' * int(t[1])} {text}" if text else ""
    if t == "p":
        return _paragraph(n.children)
    if t == "hr":
        return "---"
    if t == "pre":
        code = _text_of(n).strip("\n")
        fence = "`" * max(3, max((len(m) for m in re.findall(r"`+", code)), default=0) + 1)
        return f"{fence}\n{code}\n{fence}"
    if t == "blockquote":
        inner = _blocks_of(n.children)
        return "\n".join(("> " + ln) if ln else ">" for ln in inner.split("\n")) if inner else ""
    if t == "table":
        return _table(n)
    if t in ("ul", "ol"):
        if _is_note_list(n):
            notes = []
            for li in n.children:
                if isinstance(li, Node):
                    m = _NOTE_ID.match(li.attrs["id"])
                    assert m is not None
                    body = _blocks_of(li.children)
                    first, _, rest = body.partition("\n")
                    item = f"[^{_note_label(m.group(1), m.group(2))}]: {first}"
                    if rest:
                        item += "\n" + _indent(rest, "    ")
                    notes.append(item.rstrip())
            return "\n".join(notes)
        return _list(n, bullet)
    return _paragraph([n])


# --- conversion ----------------------------------------------------------------------------------
@dataclass
class _Images:
    embed: bool
    count: int = 0
    total: int = 0
    dropped: int = 0


def _convert_image(state: _Images):
    import mammoth

    def convert(image) -> dict:
        if not state.embed:
            return {}
        ctype = (image.content_type or "").lower()
        if ctype not in IMAGE_TYPES or state.count >= IMAGES_COUNT_MAX:
            state.dropped += 1
            return {}
        try:
            with image.open() as f:
                data = f.read(IMAGE_MAX + 1)
        except Exception:  # missing part
            state.dropped += 1
            return {}
        if len(data) > IMAGE_MAX or state.total + len(data) > IMAGES_TOTAL_MAX:
            state.dropped += 1
            return {}
        state.count += 1
        state.total += len(data)
        return {"src": f"data:{ctype};base64,{base64.b64encode(data).decode('ascii')}"}

    return mammoth.images.img_element(convert)


# Common Word styles mammoth does not map by default; the sanitizer and the markdown converter
# already handle these tags.
STYLE_MAP = """\
p[style-name='Title'] => h1:fresh
p[style-name='Subtitle'] => h2:fresh
p[style-name='Quote'] => blockquote > p:fresh
p[style-name='Intense Quote'] => blockquote > p:fresh
p[style-name='HTML Preformatted'] => pre:separator('\\n')
r[style-name='HTML Code'] => code
u => u"""
# mammoth notes every paragraph or run style it has no mapping for; nearly every real document
# has some, and they only mean "shown as a plain paragraph", so they are not listed.
_UNRECOGNISED_STYLE = re.compile(r"Unrecognised (paragraph|run|table) style")


def convert_docx(source: str | bytes, *, images: bool = True, xml_total_max: int | None = None) -> DocxResult:
    """Convert a .docx (a path or its bytes). Raises DocxError (413 too large, 422 unreadable).
    `xml_total_max` lowers the limit on the XML mammoth may parse (search indexing)."""
    import mammoth

    data, z = _open(source)
    with z:
        try:
            check_package(z, xml_total_max=xml_total_max)
        except (zipfile.BadZipFile, zlib.error, OSError, ValueError, EOFError, RuntimeError, NotImplementedError):
            raise DocxError(422, "the document is damaged (could not read the zip)") from None
    state = _Images(embed=images)
    try:
        res = mammoth.convert_to_html(io.BytesIO(data), convert_image=_convert_image(state),
                                      style_map=STYLE_MAP, include_embedded_style_map=False, external_file_access=False)
    except DocxError:
        raise
    except KeyError:
        raise DocxError(422, "not a .docx document (a required part is missing)") from None
    except Exception as e:  # malformed XML, damaged zip, unexpected structure
        raise DocxError(422, f"the document is damaged or not a .docx ({type(e).__name__})") from None
    tree = sanitize(res.value)
    html_parts: list[str] = []
    md_parts: list[str] = []
    blocks: list[list[int]] = []
    line = 1
    html_len = md_len = 0
    truncated = False
    bullets = {"ul": "-", "ol": "."}
    prev_tag = None
    for n in tree.children:
        assert isinstance(n, Node)
        bullet = "-"
        if n.tag in ("ul", "ol") and not _is_note_list(n):
            # two lists in a row would merge in markdown: alternate the marker
            if prev_tag == n.tag:
                bullets[n.tag] = {"-": "*", "*": "-", ".": ")", ")": "."}[bullets[n.tag]]
            else:
                bullets[n.tag] = "-" if n.tag == "ul" else "."
            bullet = bullets[n.tag]
        md = _block(n, bullet=bullet).strip("\n")
        if not md.strip():
            continue
        prev_tag = n.tag
        h = to_html(n)
        mlen = len(md.encode("utf-8")) + 2
        hlen = _markup_len(n)
        if md_len + mlen > MARKDOWN_MAX or html_len + hlen > HTML_MAX:
            truncated = True
            break
        md_len += mlen
        html_len += hlen
        nlines = md.count("\n") + 1
        blocks.append([line, line + nlines - 1])
        line += nlines + 1
        md_parts.append(md)
        html_parts.append(h)
    warnings = []
    for m in res.messages:
        text = str(getattr(m, "message", m))
        if _UNRECOGNISED_STYLE.match(text):
            continue
        if text not in warnings:
            warnings.append(text)
        if len(warnings) >= WARNINGS_MAX:
            break
    return DocxResult(html="\n".join(html_parts) if images else None,
                      markdown="\n\n".join(md_parts) + ("\n" if md_parts else ""),
                      blocks=blocks, warnings=warnings, truncated=truncated,
                      images=state.count, images_dropped=state.dropped)


# --- cache ---------------------------------------------------------------------------------------
_cache: collections.OrderedDict[tuple, DocxResult] = collections.OrderedDict()
_cache_lock = threading.Lock()
# At most one foreground conversion (a request: the viewer, the change history, git's HEAD copy)
# and one background conversion (search indexing) run at a time: that bounds memory and CPU, and
# indexing a folder full of documents never makes the user's document wait.
_convert_lock = threading.Lock()
_background_lock = threading.Lock()


def cache_clear() -> None:
    with _cache_lock:
        _cache.clear()


def _cache_get(key: tuple, need_html: bool) -> DocxResult | None:
    with _cache_lock:
        r = _cache.get(key)
        if r is None or (need_html and r.html is None):
            return None
        _cache.move_to_end(key)
        return r


def _cache_put(key: tuple, r: DocxResult, *, recent: bool = True) -> None:
    """recent=False (indexing) stores the result as the least recently used entry, so it only
    fills spare room and never pushes out the documents the user has looked at - unless an
    older version of the same file is cached, which it then replaces as usual."""
    with _cache_lock:
        if r.nbytes() > CACHE_BYTES // 2:
            return
        if not recent and any(k[:2] == key[:2] for k in _cache):
            recent = True
        _cache[key] = r
        _cache.move_to_end(key, last=recent)
        while len(_cache) > CACHE_ENTRIES or sum(v.nbytes() for v in _cache.values()) > CACHE_BYTES:
            _cache.popitem(last=False)


def _locked(background: bool, wait: float | None = None):
    """The conversion lock of the caller: a request waits BUSY_TIMEOUT (or `wait`) at most, then
    gets 503 (it must not hold a worker thread for minutes); the indexer simply waits its turn."""
    if background:
        _background_lock.acquire()
        return _background_lock
    if not _convert_lock.acquire(timeout=BUSY_TIMEOUT if wait is None else max(0.0, wait)):
        raise DocxError(503, "busy converting another document, try again")
    return _convert_lock


def convert_cached(real: str, *, images: bool = True, st: os.stat_result | None = None,
                   background: bool = False, wait: float | None = None,
                   recent: bool | None = None) -> DocxResult:
    """convert_docx(real) cached by (real path, mtime, size). A markdown-only result (images=False)
    is upgraded when HTML is asked for later. background=True (search indexing) uses the
    background lock, the lower XML limit and does not push other documents out of the cache.
    wait: how long a foreground caller waits for a running conversion (default BUSY_TIMEOUT; 0:
    only a cached result, else 503); recent=False caches like indexing does (search snippets)."""
    st = st or os.stat(real)
    if st.st_size > DOCX_MAX:
        raise DocxError(413, f"document larger than {DOCX_MAX // MB} MB")
    key = ("file", real, st.st_mtime_ns, st.st_size)
    r = _cache_get(key, images)
    if r is not None:
        return r
    if wait is not None and wait <= 0:  # cache only
        raise DocxError(503, "busy converting another document, try again")
    lock = _locked(background, wait)
    try:
        r = _cache_get(key, images)
        if r is not None:
            return r
        r = convert_docx(real, images=images, xml_total_max=XML_TOTAL_BACKGROUND_MAX if background else None)
        after = os.stat(real)
        if (after.st_mtime_ns, after.st_size) == key[2:]:  # not changed while reading
            _cache_put(key, r, recent=not background if recent is None else recent)
        return r
    finally:
        lock.release()


def convert_blob_cached(oid: str, read: typing.Callable[[], bytes]) -> DocxResult:
    """The markdown-only conversion of a .docx held elsewhere (a git blob), cached by its object
    id and run under the same foreground lock as convert_cached. `read` is called on a miss."""
    key = ("git", oid)
    r = _cache_get(key, False)
    if r is not None:
        return r
    lock = _locked(False)
    try:
        r = _cache_get(key, False)
        if r is not None:
            return r
        r = convert_docx(read(), images=False)
        _cache_put(key, r)
        return r
    finally:
        lock.release()
