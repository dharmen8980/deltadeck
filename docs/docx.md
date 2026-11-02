# Word documents (.docx)

`.docx` files open in a lightweight, **view-only** reader that looks like the
markdown viewer: the same typography, table of contents, heading links, search
highlights, "changed since you last looked" highlights, print and **Download
PDF**. It does not try to look like Word. The file is never edited or written,
even with editing on (saving a `.docx` through `/api/edit/file` answers
415).

## What is shown

The server converts the document with [mammoth](https://pypi.org/project/mammoth/)
into plain, semantic content:

- headings (from the Heading styles; Title as a top-level heading and
  Subtitle as a second-level one), paragraphs, quotes (Quote and Intense
  Quote styles), bold, italic, underline, strikethrough, sub- and superscript,
  code (HTML Preformatted and HTML Code styles);
- bulleted and numbered lists, nested;
- tables (merged cells keep their `colspan` / `rowspan`; in the markdown the
  cells they cover are left empty, so the columns stay aligned);
- web and `mailto:` links, links to bookmarks inside the document (Word's
  own table of contents and cross-references jump to their target);
- footnotes and endnotes, listed at the end;
- embedded PNG, JPEG, GIF, WebP and BMP images.

Page layout, fonts, colours, sizes, alignment, headers and footers, comments,
tracked changes, text boxes, shapes, charts, equations and fields are not shown.
Images that are linked rather than embedded, larger than the limits below or in
a format a browser cannot show (EMF, WMF, TIFF, ...) appear as a small
"image not shown" placeholder with their alt text. The header of the document
says when something was left out ("N conversion notes", with the details on
hover) and when a long document was cut short. Paragraph and run styles
without a mapping (most custom styles) are shown as plain paragraphs and text
and are not listed as notes. A numbered list that Word continues after an
ordinary paragraph starts again at 1 (the converter starts a new list).

Old `.doc` files and password-protected documents are not supported (422).

## Markdown

The same conversion also produces markdown: headings as `#`, lists, GFM
tables, `[links](url)`, images as `![alt]()` (no data), and footnotes as
`[^1]` with `[^1]: text` at the end. The markdown is what search indexes,
what the change history snapshots and diffs (see [Changes](changes.md)), and
what "since last commit" compares with the last commit's version, which is
converted the same way (see [Git](git.md)). It is also meant for agents that
read the folder later.

## `GET /api/docx`

`GET /api/docx?path=<path>&format=html|markdown` (default `html`) returns

```json
{"path": "...", "html": "...", "markdown": "...", "blocks": [[1, 1], [3, 5]],
 "warnings": [], "truncated": false, "images": 1, "images_dropped": 0,
 "size": 12345, "mtime": 1767225600.0}
```

`html` is left out with `format=markdown` (which also skips the images).
`blocks` maps each top-level HTML element to its 1-based line range in
`markdown`, so the viewer can place the change highlights. The usual path
checks apply (403 outside the root or denied, 404 missing); a file that is not
`.docx` or an unknown format is 400, a file over the size limit is 413, and a
document that cannot be read is 422 with the reason.

Results are cached in memory by (path, mtime, size), the last commit's
version by its git blob id: 16 documents, 96 MB at most. Search indexing
only fills spare room in the cache, so it does not push out the documents you
opened. One request conversion runs at a time (a request that waits more than
30 s for it gets 503, "busy, try again"), and search indexing runs its own,
one at a time, alongside.

## Limits

| Limit | Value | Over it |
|---|---|---|
| The `.docx` file | 20 MB | 413 |
| Sum of the uncompressed parts | 128 MB | 413 |
| One XML part (any part that is XML, whatever its name) | 8 MB | 413 |
| All XML parts | 24 MB | 413 |
| All XML parts, for search indexing | 12 MB | not content-indexed |
| Compression ratio of a part over 1 MB | 200:1 | 413 |
| Parts in the zip | 10,000 | 422 |
| One embedded image | 5 MB | placeholder |
| All embedded images | 16 MB, 200 images | placeholder |
| HTML, without image data | 4 MB | cut at a block, `truncated` |
| Markdown | 2 MB (UTF-8) | cut at a block, `truncated` |
| Conversion notes | 20 | the rest are not listed |

How the file is checked and the HTML is sanitized is described in
[Security model](security.md#word-documents).
