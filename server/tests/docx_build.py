"""Tiny .docx builder for the tests: a zip with hand-written WordprocessingML, no python-docx.

    make_docx(path, body_xml, rels=..., footnotes=..., media=..., extra=...)

`body_xml` is the content of <w:body>; the helpers below build the common pieces."""

from __future__ import annotations

import io
import zipfile
from xml.sax.saxutils import escape

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS = (f'xmlns:w="{W}" xmlns:r="{R}" '
      'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
      'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
      'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"')
REL_BASE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Default Extension="emf" ContentType="image/x-emf"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"""

ROOT_RELS = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="{REL_BASE}/officeDocument" Target="word/document.xml"/>
</Relationships>"""

STYLES = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="{W}">
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/></w:style>
</w:styles>"""

NUMBERING = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="{W}">
<w:abstractNum w:abstractNumId="0">
<w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl>
</w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>"""


def run(text: str, *, bold=False, italic=False) -> str:
    props = ("<w:b/>" if bold else "") + ("<w:i/>" if italic else "")
    rpr = f"<w:rPr>{props}</w:rPr>" if props else ""
    return f'<w:r>{rpr}<w:t xml:space="preserve">{escape(text)}</w:t></w:r>'


def para(*runs: str, style: str | None = None, num: tuple[int, int] | None = None) -> str:
    ppr = ""
    if style or num:
        ppr = "<w:pPr>"
        if style:
            ppr += f'<w:pStyle w:val="{style}"/>'
        if num:
            ppr += f'<w:numPr><w:ilvl w:val="{num[1]}"/><w:numId w:val="{num[0]}"/></w:numPr>'
        ppr += "</w:pPr>"
    body = "".join(r if r.startswith("<") else run(r) for r in runs)
    return f"<w:p>{ppr}{body}</w:p>"


def heading(text: str, level: int = 1) -> str:
    return para(text, style=f"Heading{level}")


def link(rid: str, text: str) -> str:
    return f'<w:hyperlink r:id="{rid}">{run(text)}</w:hyperlink>'


def anchor_link(anchor: str, text: str) -> str:
    return f'<w:hyperlink w:anchor="{anchor}">{run(text)}</w:hyperlink>'


def footnote_ref(n: int) -> str:
    return f'<w:r><w:footnoteReference w:id="{n}"/></w:r>'


def table(rows: list[list[str]]) -> str:
    out = "<w:tbl>"
    for row in rows:
        out += "<w:tr>" + "".join(f"<w:tc>{para(c)}</w:tc>" for c in row) + "</w:tr>"
    return out + "</w:tbl>"


def image(rid: str, alt: str = "", name: str = "pic") -> str:
    return (f'<w:r><w:drawing><wp:inline><wp:extent cx="100" cy="100"/>'
            f'<wp:docPr id="1" name="{name}" descr="{escape(alt)}"/>'
            f'<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
            f'<pic:pic><pic:blipFill><a:blip r:embed="{rid}"/></pic:blipFill></pic:pic>'
            f'</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>')


def external_image(rid: str, alt: str = "") -> str:
    return image(rid, alt).replace("r:embed=", "r:link=")


PNG_1PX = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cf"
    "c0f01f0005000201a5f6c5b10000000049454e44ae426082")


def make_docx(path=None, body: str = "", *, rels: dict[str, tuple[str, str, bool]] | None = None,
              footnotes: dict[int, str] | None = None, media: dict[str, bytes] | None = None,
              extra: dict[str, bytes | str] | None = None, document: str | None = None,
              compression=zipfile.ZIP_DEFLATED) -> bytes:
    """rels: id -> (type suffix, target, external). Returns the bytes (and writes `path` if given)."""
    rels = dict(rels or {})
    rels.setdefault("rIdStyles", ("styles", "styles.xml", False))
    rels.setdefault("rIdNumbering", ("numbering", "numbering.xml", False))
    if footnotes:
        rels.setdefault("rIdFootnotes", ("footnotes", "footnotes.xml", False))
    rel_xml = "".join(
        f'<Relationship Id="{rid}" Type="{REL_BASE}/{typ}" Target="{escape(target, {chr(34): "&quot;"})}"'
        f'{" TargetMode=" + chr(34) + "External" + chr(34) if ext else ""}/>'
        for rid, (typ, target, ext) in rels.items())
    files: dict[str, bytes | str] = {
        "[Content_Types].xml": CONTENT_TYPES,
        "_rels/.rels": ROOT_RELS,
        "word/_rels/document.xml.rels":
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{rel_xml}'
            "</Relationships>",
        "word/document.xml": document if document is not None else
            f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document {NS}><w:body>{body}</w:body></w:document>',
        "word/styles.xml": STYLES,
        "word/numbering.xml": NUMBERING,
    }
    if footnotes:
        notes = "".join(f'<w:footnote w:id="{n}">{para(t)}</w:footnote>' for n, t in footnotes.items())
        files["word/footnotes.xml"] = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                                       f'<w:footnotes {NS}>{notes}</w:footnotes>')
    for name, data in (media or {}).items():
        files[f"word/media/{name}"] = data
    files.update(extra or {})
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression) as z:
        for name, data in files.items():
            z.writestr(name, data)
    out = buf.getvalue()
    if path is not None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(out)
    return out
