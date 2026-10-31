""".docx support (viewer.docx, /api/docx): conversion to sanitized HTML and markdown, the sanitiser,
zip and XML safety, limits, errors, the cache, search, the seen digest, git HEAD and view-only."""

import hashlib
import io
import os
import subprocess
import zipfile

import pytest
from conftest import editing, running, wait_until, write
from docx_build import (PNG_1PX, REL_BASE, STYLES, anchor_link, external_image, footnote_ref, heading, image,
                        link, make_docx, para, run, table)

from viewer import docx as docxmod
from viewer.docx import DocxError, convert_cached, convert_docx, safe_href, sanitize, to_html


@pytest.fixture(autouse=True)
def fresh_cache():
    docxmod.cache_clear()
    yield
    docxmod.cache_clear()


RICH_BODY = (
    heading("Project plan") + heading("Goals", 2)
    + para("Ship ", run("fast", bold=True), " and ", run("well", italic=True), footnote_ref(1))
    + para("one", num=(1, 0)) + para("nested", num=(1, 1)) + para("two", num=(1, 0))
    + para("first", num=(2, 0)) + para("second", num=(2, 0))
    + table([["Name", "Value"], ["a|b", "2"]])
    + para(link("rIdWeb", "the site"), " and ", link("rIdJs", "bad link"), " and ", anchor_link("_Toc1", "jump"))
    + para(image("rIdImg", "a tiny dot")) + para(external_image("rIdExt", "remote picture"))
)
RICH_RELS = {"rIdWeb": ("hyperlink", "https://example.com/?a=1&b=2", True),
             "rIdJs": ("hyperlink", "javascript:alert(1)", True),
             "rIdImg": ("image", "media/dot.png", False),
             "rIdExt": ("image", "http://example.com/x.png", True)}


def rich(path=None):
    return make_docx(path, RICH_BODY, rels=RICH_RELS, footnotes={1: "The footnote text."},
                     media={"dot.png": PNG_1PX})


# -- conversion -----------------------------------------------------------------------------------

def test_html_and_markdown():
    r = convert_docx(rich())
    h = r.html
    assert "<h1>Project plan</h1>" in h and "<h2>Goals</h2>" in h
    assert "<strong>fast</strong>" in h and "<em>well</em>" in h
    assert "<ul><li>one<ul><li>nested</li></ul></li><li>two</li></ul>" in h
    assert "<table>" in h and "<td><p>a|b</p></td>" in h
    assert '<a href="https://example.com/?a=1&amp;b=2">the site</a>' in h
    assert "javascript" not in h and "bad link" in h  # the link is gone, its text stays
    assert '<a href="#_Toc1">jump</a>' in h
    assert '<img src="data:image/png;base64,' in h and 'alt="a tiny dot"' in h
    assert '<img alt="remote picture">' in h and "example.com/x.png" not in h
    assert '<li id="footnote-1">' in h and 'href="#footnote-1"' in h
    assert r.images == 1 and r.images_dropped == 1

    md = r.markdown
    assert md.startswith("# Project plan\n\n## Goals\n\nShip **fast** and *well*[^1]\n")
    assert "- one\n  - nested\n- two\n" in md
    assert "1. first\n2. second\n" in md
    assert "| Name | Value |\n| --- | --- |\n| a\\|b | 2 |" in md
    assert "[the site](https://example.com/?a=1&b=2) and bad link and [jump](#_Toc1)" in md
    assert "![a tiny dot]()" in md and "![remote picture]()" in md
    assert "data:" not in md and "base64" not in md
    assert md.rstrip().endswith("[^1]: The footnote text.")
    # one [start, end] markdown line range per top-level HTML element
    lines = md.split("\n")
    assert len(r.blocks) == h.count("\n") + 1
    assert lines[r.blocks[0][0] - 1] == "# Project plan"
    s, e = r.blocks[3]
    assert lines[s - 1:e] == ["- one", "  - nested", "- two"]


def test_markdown_escapes_and_consecutive_lists():
    body = (para("# not a heading, *not* emphasis, snake_case, _under_, [x] <b> &amp;")
            + para("a", num=(1, 0)) + para("between") + para("b", num=(1, 0)))
    md = convert_docx(make_docx(None, body)).markdown
    assert md.startswith("\\# not a heading, \\*not\\* emphasis, snake_case, \\_under\\_, \\[x\\] \\<b> \\&amp;")
    assert "- a\n\nbetween\n\n- b" in md


def test_markdown_only_skips_images():
    r = convert_docx(rich(), images=False)
    assert r.html is None and r.images == 0 and "![a tiny dot]()" in r.markdown
    assert r.markdown == convert_docx(rich()).markdown


# -- sanitiser ------------------------------------------------------------------------------------

def test_sanitizer_strips_dangerous_markup():
    dirty = ('<p onclick="x()" style="color:red" class="c">hi<script>alert(1)</script>'
             '<style>p{}</style><a href="javascript:alert(1)">js</a> <a href=" JaVa\tscript:x">js2</a>'
             '<a href="file:///etc/passwd">file</a> <a href="other.docx">rel</a> <a href="data:text/html,x">data</a>'
             '<a href="mailto:a@b.c">mail</a> <a href="#frag">frag</a> <a href="HTTPS://ok.example">ok</a>'
             '<img src="http://evil/x.png" alt="ext" onerror="x()"><img src="data:image/svg+xml;base64,PHN2Zz4=" alt="svg">'
             '<iframe src="x">inner</iframe><svg><text>svgtext</text></svg><span>kept</span>'
             '<td colspan="2" rowspan="x">c</td></p><table><tr><td colspan="3" rowspan="2" style="x">t</td></tr></table>')
    h = "".join(to_html(c) for c in sanitize(dirty).children)
    for bad in ("onclick", "style", "class", "script", "alert", "javascript", "file:", "other.docx",
                "data:text", "evil", "onerror", "svg+xml", "iframe", "inner", "svgtext"):
        assert bad not in h.lower(), bad
    assert '<a href="mailto:a@b.c">mail</a>' in h and '<a href="#frag">frag</a>' in h
    assert '<a href="HTTPS://ok.example">ok</a>' in h
    assert '<img alt="ext">' in h and '<img alt="svg">' in h
    assert "kept" in h and ">js<" not in h and "js2" in h and "rel" in h
    assert '<td colspan="3" rowspan="2">t</td>' in h


def test_safe_href():
    assert safe_href("http://x") == "http://x" and safe_href("mailto:x@y") == "mailto:x@y"
    for bad in ("javascript:x", "vbscript:x", "data:x", "file:///x", "../x.md", "x.docx", "#", "# x", "//x"):
        assert safe_href(bad) is None, bad


def test_mammoth_style_map_in_the_document_is_ignored():
    # a document can carry its own mammoth style map; it must not be able to produce markup
    data = make_docx(None, para("text", style="Heading1"),
                     extra={"mammoth/style-map": "p[style-name='heading 1'] => script"})
    r = convert_docx(data)
    assert r.html == "<h1>text</h1>"


# -- zip and XML safety, errors -------------------------------------------------------------------

def test_entity_declarations_refused():
    lol = ('<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]>'
           f'<w:document xmlns:w="{"http://schemas.openxmlformats.org/wordprocessingml/2006/main"}">'
           "<w:body><w:p><w:r><w:t>&lol2;</w:t></w:r></w:p></w:body></w:document>")
    with pytest.raises(DocxError) as e:
        convert_docx(make_docx(None, document=lol))
    assert e.value.status == 422 and "entities" in e.value.detail
    xxe = '<?xml version="1.0"?><!DOCTYPE x SYSTEM "file:///etc/passwd"><x/>'
    with pytest.raises(DocxError):
        convert_docx(make_docx(None, para("x"), extra={"word/settings.xml": xxe}))
    utf16 = ('<?xml version="1.0" encoding="UTF-16"?><!DOCTYPE x [<!ENTITY a "b">]><x/>').encode("utf-16")
    with pytest.raises(DocxError):
        convert_docx(make_docx(None, para("x"), extra={"customXml/item1.xml": utf16}))


def test_zip_bomb_refused(monkeypatch):
    bomb = make_docx(None, para("x"), extra={"word/media/zeros.bin": b"\0" * (3 * 1024 * 1024)})
    with pytest.raises(DocxError) as e:
        convert_docx(bomb)
    assert e.value.status == 413 and "expands" in e.value.detail
    monkeypatch.setattr(docxmod, "UNCOMPRESSED_MAX", 64 * 1024)
    stored = make_docx(None, para("x"), extra={"word/media/a.bin": os.urandom(80 * 1024)},
                       compression=zipfile.ZIP_STORED)
    with pytest.raises(DocxError) as e:
        convert_docx(stored)
    assert e.value.status == 413 and "uncompressed" in e.value.detail


def test_too_many_parts_and_large_xml(monkeypatch):
    monkeypatch.setattr(docxmod, "MEMBERS_MAX", 8)
    with pytest.raises(DocxError):
        convert_docx(make_docx(None, para("x"), extra={f"x/{i}.bin": b"1" for i in range(10)}))
    monkeypatch.setattr(docxmod, "MEMBERS_MAX", 10_000)
    monkeypatch.setattr(docxmod, "XML_PART_MAX", 1000)
    with pytest.raises(DocxError) as e:
        convert_docx(make_docx(None, para("x" * 2000)))
    assert e.value.status == 413


def _main_part_named(name: str, document: str) -> bytes:
    """A package whose _rels/.rels points mammoth at `name` (not word/document.xml)."""
    rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            f'<Relationship Id="rId1" Type="{REL_BASE}/officeDocument" Target="{name}"/></Relationships>')
    return make_docx(None, para("decoy"), extra={"_rels/.rels": rels, name: document})


W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def test_xml_checks_follow_content_not_names(monkeypatch):
    # mammoth reads the part _rels/.rels names, whatever its extension: the checks must too
    lol = ('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "AAAA"><!ENTITY b "&a;&a;&a;&a;">]>'
           f'<w:document xmlns:w="{W_NS}"><w:body><w:p><w:r><w:t>hello &b;</w:t></w:r></w:p></w:body></w:document>')
    with pytest.raises(DocxError) as e:
        convert_docx(_main_part_named("word/main.bin", lol))
    assert e.value.status == 422 and "entities" in e.value.detail
    with pytest.raises(DocxError) as e:  # leading whitespace and a BOM do not hide it
        convert_docx(_main_part_named("word/main.dat", "\ufeff  \n" + lol))
    assert e.value.status == 422
    with pytest.raises(DocxError) as e:  # nor UTF-16 without a BOM
        convert_docx(_main_part_named("word/main.dat", lol.encode("utf-16-le")))
    assert e.value.status == 422
    ok = f'<w:document xmlns:w="{W_NS}"><w:body>{para("real body " + "x" * 2000)}</w:body></w:document>'
    assert "real body" in convert_docx(_main_part_named("word/main.bin", ok)).markdown
    monkeypatch.setattr(docxmod, "XML_PART_MAX", 1000)
    with pytest.raises(DocxError) as e:  # the per-part limit applies to it as well
        convert_docx(_main_part_named("word/main.bin", ok))
    assert e.value.status == 413
    # binary media do not count as XML
    monkeypatch.setattr(docxmod, "XML_PART_MAX", 8 * 1024 * 1024)
    monkeypatch.setattr(docxmod, "XML_TOTAL_MAX", 20_000)
    assert convert_docx(make_docx(None, para("x"), media={"big.png": PNG_1PX + os.urandom(64 * 1024)})).markdown


def test_total_xml_limit(monkeypatch):
    big = para("y" * 6000)
    data = make_docx(None, big, footnotes={1: "z" * 6000})
    monkeypatch.setattr(docxmod, "XML_TOTAL_MAX", 10_000)
    with pytest.raises(DocxError) as e:
        convert_docx(data)
    assert e.value.status == 413 and "XML" in e.value.detail
    monkeypatch.setattr(docxmod, "XML_TOTAL_MAX", 1_000_000)
    assert convert_docx(data).markdown
    with pytest.raises(DocxError):
        convert_docx(data, xml_total_max=10_000)  # the indexer's lower limit


def _tc(text: str, vmerge: str | None = None) -> str:
    pr = {None: "", "restart": '<w:tcPr><w:vMerge w:val="restart"/></w:tcPr>',
          "continue": "<w:tcPr><w:vMerge/></w:tcPr>"}[vmerge]
    return f"<w:tc>{pr}{para(text) if text else para()}</w:tc>"


def test_rowspan_keeps_markdown_columns():
    rows = [[_tc("A"), _tc("B"), _tc("C")],
            [_tc("tall", "restart"), _tc("x1"), _tc("x2")],
            [_tc("", "continue"), _tc("y"), _tc("z")],
            [_tc("a"), _tc("b"), _tc("c")]]
    body = "<w:tbl>" + "".join("<w:tr>" + "".join(r) + "</w:tr>" for r in rows) + "</w:tbl>"
    r = convert_docx(make_docx(None, body))
    assert 'rowspan="2"' in r.html
    assert r.markdown == ("| A | B | C |\n| --- | --- | --- |\n| tall | x1 | x2 |\n|  | y | z |\n| a | b | c |\n")
    # a span in the middle column, and one in the last column
    h = docxmod._table(sanitize('<table><tr><td>1</td><td rowspan="3">m</td><td rowspan="2">r</td></tr>'
                                "<tr><td>2</td></tr><tr><td>3</td><td>r3</td></tr></table>").children[0])
    assert h.split("\n")[2:] == ["| 2 |  |  |", "| 3 |  | r3 |"]


def test_style_map_and_quiet_style_notes():
    styles = STYLES.replace("</w:styles>", (
        '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>'
        '<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/></w:style>'
        '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/></w:style>'
        '<w:style w:type="paragraph" w:styleId="Odd"><w:name w:val="Odd Style"/></w:style></w:styles>'))
    under = '<w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>under</w:t></w:r>'
    body = (para("The title", style="Title") + para("The sub", style="Subtitle") + para("wise words", style="Quote")
            + para("odd", style="Odd") + para("plain ", under))
    r = convert_docx(make_docx(None, body, extra={"word/styles.xml": styles}))
    assert r.html == ("<h1>The title</h1>\n<h2>The sub</h2>\n<blockquote><p>wise words</p></blockquote>\n"
                      "<p>odd</p>\n<p>plain <u>under</u></p>")
    assert r.markdown.startswith("# The title\n\n## The sub\n\n> wise words\n")
    assert r.warnings == []  # "Unrecognised paragraph style: Odd Style" is not listed


def test_bookmark_anchor_kept():
    body = ('<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:bookmarkStart w:id="0" w:name="_Toc1"/>'
            + run("Intro") + '<w:bookmarkEnd w:id="0"/></w:p>' + para(anchor_link("_Toc1", "go")))
    r = convert_docx(make_docx(None, body))
    assert r.html == '<h1><a id="_Toc1"></a>Intro</h1>\n<p><a href="#_Toc1">go</a></p>'
    assert r.markdown == "# Intro\n\n[go](#_Toc1)\n"


def test_corrupt_and_unsupported_files():
    for data, word in [(b"not a zip at all", "not a zip"),
                       (docxmod.OLE_MAGIC + b"\0" * 600, "password-protected"),
                       (make_docx(None, para("x"))[:200], "not a zip"),
                       (_zip({"hello.txt": "hi"}), "not a .docx")]:
        with pytest.raises(DocxError) as e:
            convert_docx(data)
        assert e.value.status == 422 and word in e.value.detail, (word, e.value.detail)
    broken = make_docx(None, document="<w:document><unclosed")
    with pytest.raises(DocxError) as e:
        convert_docx(broken)
    assert e.value.status == 422


def _zip(files):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for k, v in files.items():
            z.writestr(k, v)
    return buf.getvalue()


def test_image_limits(monkeypatch):
    monkeypatch.setattr(docxmod, "IMAGES_COUNT_MAX", 1)
    body = para(image("rIdA", "first")) + para(image("rIdB", "second"))
    data = make_docx(None, body, rels={"rIdA": ("image", "media/a.png", False), "rIdB": ("image", "media/b.png", False)},
                     media={"a.png": PNG_1PX, "b.png": PNG_1PX})
    r = convert_docx(data)
    assert r.images == 1 and r.images_dropped == 1
    assert r.html.count("data:image/png") == 1 and '<img alt="second">' in r.html
    monkeypatch.setattr(docxmod, "IMAGES_COUNT_MAX", 200)
    monkeypatch.setattr(docxmod, "IMAGE_MAX", 10)
    r = convert_docx(data)
    assert r.images == 0 and r.images_dropped == 2 and "data:" not in r.html
    # formats a browser cannot show (EMF) are dropped too, alt text kept
    monkeypatch.setattr(docxmod, "IMAGE_MAX", 5 * 1024 * 1024)
    emf = make_docx(None, para(image("rIdE", "vector")), rels={"rIdE": ("image", "media/e.emf", False)},
                    media={"e.emf": b"\x01\0\0\0" * 10})
    r = convert_docx(emf)
    assert r.images_dropped == 1 and '<img alt="vector">' in r.html


def test_truncation_at_a_block(monkeypatch):
    monkeypatch.setattr(docxmod, "MARKDOWN_MAX", 60)
    r = convert_docx(make_docx(None, "".join(para(f"paragraph number {i}") for i in range(10))))
    assert r.truncated and 0 < len(r.blocks) < 10
    assert r.html.count("<p>") == len(r.blocks) == r.markdown.count("paragraph number")


# -- the endpoint ---------------------------------------------------------------------------------

def test_api_docx(root):
    rich(root / "docs" / "plan.docx")
    write(root / "notes.md", "# hi\n")
    write(root / "broken.docx", b"PK\3\4garbage")
    write(root / "secret" / ".env", "x")
    make_docx(root / ".env.docx", para("hidden"))
    with running(root) as c:
        f = c.get("/api/file?path=docs/plan.docx").json()
        assert f["kind"] == "docx"
        kinds = {x["path"]: x["kind"] for x in c.get("/api/tree").json()["files"]}
        assert kinds["docs/plan.docx"] == "docx"
        r = c.get("/api/docx?path=docs/plan.docx")
        assert r.status_code == 200
        j = r.json()
        assert j["path"] == "docs/plan.docx" and "<h1>Project plan</h1>" in j["html"]
        assert j["markdown"].startswith("# Project plan") and j["blocks"] and j["truncated"] is False
        assert j["images"] == 1 and j["images_dropped"] == 1 and isinstance(j["warnings"], list)
        m = c.get("/api/docx?path=docs/plan.docx&format=markdown").json()
        assert "html" not in m and m["markdown"] == j["markdown"]
        assert c.get("/api/docx?path=docs/plan.docx&format=pdf").status_code == 400
        assert c.get("/api/docx?path=notes.md").status_code == 400
        bad = c.get("/api/docx?path=broken.docx")
        assert bad.status_code == 422 and bad.json()["detail"]
        assert c.get("/api/docx?path=.env.docx").status_code in (403, 404)
        assert c.get("/api/docx?path=../x.docx").status_code == 403
        assert c.get("/api/docx?path=missing.docx").status_code == 404
        assert c.get("/api/docx").status_code in (400, 403, 404, 422)


def test_api_docx_size_limit(root, monkeypatch):
    rich(root / "big.docx")
    monkeypatch.setattr("viewer.app.DOCX_MAX", 100)
    with running(root) as c:
        assert c.get("/api/docx?path=big.docx").status_code == 413


def test_cache_invalidated_on_change(root):
    p = root / "a.docx"
    make_docx(p, para("version one"))
    r1 = convert_cached(str(p))
    assert convert_cached(str(p)) is r1
    make_docx(p, para("version two, longer"))
    os.utime(p, ns=(os.stat(p).st_atime_ns, os.stat(p).st_mtime_ns + 10_000_000))
    r2 = convert_cached(str(p))
    assert r2 is not r1 and "version two" in r2.markdown
    # markdown-only results are upgraded when HTML is wanted
    docxmod.cache_clear()
    m = convert_cached(str(p), images=False)
    assert m.html is None and convert_cached(str(p), images=False) is m
    assert convert_cached(str(p)).html == "<p>version two, longer</p>"


def test_cache_is_bounded(root, monkeypatch):
    monkeypatch.setattr(docxmod, "CACHE_ENTRIES", 2)
    for i in range(4):
        make_docx(root / f"{i}.docx", para(f"doc {i}"))
        convert_cached(str(root / f"{i}.docx"))
    assert len(docxmod._cache) == 2


def test_busy_conversion_answers_503_and_indexing_has_its_own_lock(root, monkeypatch):
    p = root / "a.docx"
    make_docx(p, para("hello"))
    monkeypatch.setattr(docxmod, "BUSY_TIMEOUT", 0.05)
    with docxmod._convert_lock:
        with pytest.raises(DocxError) as e:
            convert_cached(str(p))
        assert e.value.status == 503
        # the indexer is not held up by a foreground conversion
        assert convert_cached(str(p), images=False, background=True).markdown == "hello\n"


def test_background_results_do_not_evict(root, monkeypatch):
    monkeypatch.setattr(docxmod, "CACHE_ENTRIES", 2)
    for i in range(4):
        make_docx(root / f"{i}.docx", para(f"doc {i}"))
    a = convert_cached(str(root / "0.docx"))
    b = convert_cached(str(root / "1.docx"))
    convert_cached(str(root / "2.docx"), images=False, background=True)
    convert_cached(str(root / "3.docx"), images=False, background=True)
    assert convert_cached(str(root / "0.docx")) is a and convert_cached(str(root / "1.docx")) is b


def test_blob_conversion_is_cached():
    calls = []

    def read():
        calls.append(1)
        return make_docx(None, para("from git"))

    assert docxmod.convert_blob_cached("abc123", read).markdown == "from git\n"
    assert docxmod.convert_blob_cached("abc123", read).markdown == "from git\n"
    assert len(calls) == 1


# -- search, seen, git, editing -------------------------------------------------------------------

def test_search_indexes_docx_and_reindexes(root):
    make_docx(root / "report.docx", heading("Quarterly") + para("zqdocxword appears here"))
    with running(root, watch=True) as c:
        hits = c.get("/api/search?q=zqdocxword").json()["content"]
        assert [h["path"] for h in hits] == ["report.docx"] and hits[0]["kind"] == "docx"
        assert hits[0]["matches"][0]["text"] == "zqdocxword appears here"
        assert c.get("/api/search?q=zqdocxword&types=docx").json()["content"]
        make_docx(root / "report.docx", para("zqfreshdocx replaced"))
        wait_until(lambda: c.get("/api/search?q=zqfreshdocx").json()["content"])
        wait_until(lambda: not c.get("/api/search?q=zqdocxword").json()["content"])


def test_corrupt_docx_not_indexed(root):
    write(root / "bad.docx", b"garbage")
    with running(root) as c:
        assert c.get("/api/search?q=garbage").json()["content"] == []
        assert c.get("/api/search?q=bad").json()["names"][0]["path"] == "bad.docx"


def test_seen_digest_uses_markdown(tmp_path):
    from test_roots import canon, outer, post

    a = tmp_path / "a"
    make_docx(a / "d.docx", para("snapshotted text"))
    with outer(a, tmp_path / "data") as c:
        md = c.get("/api/docx?path=d.docx&format=markdown").json()
        st = os.stat(a / "d.docx")
        body = {"root": canon(a), "path": "d.docx", "mtime": st.st_mtime_ns / 1e9, "size": st.st_size,
                "textSha256": hashlib.sha256(md["markdown"].encode()).hexdigest()}
        assert post(c, "/api/seen/commit", body).status_code == 200
        snap = c.get("/api/seen/snapshot", params={"root": canon(a), "path": "d.docx"}).json()["snapshot"]
        assert snap["text"] == md["markdown"]
        body["textSha256"] = "0" * 64
        assert post(c, "/api/seen/commit", body).status_code == 200
        snap = c.get("/api/seen/snapshot", params={"root": canon(a), "path": "d.docx"}).json()["snapshot"]
        assert snap is None or snap["text"] is None  # a digest of the zip, not the markdown: no text kept


def test_docx_not_editable(root, tmp_path):
    p = make_docx(root / "doc.docx", para("keep me"))
    before = (root / "doc.docx").read_bytes()
    with editing(root, tmp_path / "data") as c:
        cur = c.get("/api/content?path=doc.docx").json()
        r = c.put("/api/edit/file", json={"path": "doc.docx", "content": "overwritten", "base_sha256": cur["sha256"]})
        assert r.status_code == 415
        r = c.put("/api/edit/file", json={"path": "new.docx", "content": "x", "base_sha256": None, "create": True})
        assert r.status_code == 415
    assert (root / "doc.docx").read_bytes() == before == p and not (root / "new.docx").exists()


def test_pdf_export_accepts_docx_only_same_site(root):
    make_docx(root / "d.docx", para("x"))
    with running(root) as c:
        r = c.get("/api/pdf?path=d.docx", headers={"Sec-Fetch-Site": "cross-site"})
        assert r.status_code == 403
        r = c.get("/api/pdf?path=d.docx")  # no UI build in the tests: past the kind check
        assert r.status_code == 503


GIT = subprocess.run(["sh", "-c", "command -v git"], capture_output=True).returncode == 0


@pytest.mark.skipif(not GIT, reason="git not available")
def test_git_head_docx_is_converted(tmp_path):
    from test_git import GIT as GITEXE, g

    if GITEXE is None:
        pytest.skip("git (2.32+) not available")
    r = tmp_path / "repo"
    r.mkdir()
    g(r, "init", "-q", "-b", "main")
    make_docx(r / "spec.docx", heading("Spec") + para("old text"))
    write(r / "bad.docx", b"garbage")
    g(r, "add", "-A")
    g(r, "commit", "-q", "-m", "c1")
    make_docx(r / "spec.docx", heading("Spec") + para("new text"))
    with running(r) as c:
        head = c.get("/api/git/file?path=spec.docx").json()["head"]
        assert head["text"] == "# Spec\n\nold text\n" and head["binary"] is False
        bad = c.get("/api/git/file?path=bad.docx").json()["head"]
        assert bad["text"] is None and bad["binary"] is True
