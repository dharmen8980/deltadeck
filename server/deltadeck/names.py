"""Identifier extraction for editor completion (deltadeck.search stores the result in its `words` /
`uses` / `file_words` tables).

Name-based only: definitions are found by simple per-language regexes (a `def`, `class`, `const`,
shell function...), every other identifier by one word regex; keywords are skipped, and so are
identifiers used only once in the file and hash-like tokens. Original case is kept. At most
MAX_PER_FILE names per file (definitions first, then the most used), so a minified or generated
file cannot flood the table.
"""

from __future__ import annotations

import re

MAX_PER_FILE = 500
NAME_MAX = 64
WORD_MAX = 40  # longer non-definition tokens are left out (generated, base64...)

# extension -> language family: completion ranks names from the same family higher
FAMILIES = {
    "py": "py pyi",
    "js": "js mjs cjs jsx ts mts cts tsx",
    "sh": "sh bash zsh",
    "css": "css scss less",
    "html": "html htm",
    "java": "java",
    "cs": "cs",
    "sql": "sql",
    "conf": "yaml yml toml ini cfg",
}
FAMILY_OF = {ext: fam for fam, exts in FAMILIES.items() for ext in exts.split()}


def family_exts(ext: str) -> list[str]:
    """Every extension in the family of `ext` (just `ext` when it has none)."""
    fam = FAMILY_OF.get(ext)
    return FAMILIES[fam].split() if fam else [ext]


_M = re.MULTILINE | re.ASCII
_ID = r"[A-Za-z_]\w*"
_JS_ID = r"[A-Za-z_$][\w$]*"
_JAVA_MODS = (r"(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|async"
              r"|synchronized|sealed|partial|extern|unsafe|native|default)\s+)+")
DEFS = {
    "py": [re.compile(rf"^[ \t]*(?:async[ \t]+)?def[ \t]+({_ID})", _M),
           re.compile(rf"^[ \t]*class[ \t]+({_ID})", _M),
           re.compile(rf"^({_ID})[ \t]*(?::[^=\n]*)?=(?!=)", _M)],  # module-level assignment
    "js": [re.compile(rf"\b(?:function\*?|class|interface|type|enum|namespace)\s+({_JS_ID})", _M),
           re.compile(rf"\b(?:const|let|var)\s+({_JS_ID})", _M)],
    "java": [re.compile(rf"\b(?:class|interface|enum|record|struct)\s+({_ID})", _M),
             re.compile(rf"^[ \t]*{_JAVA_MODS}[\w<>\[\],.? \t]*?[\w>\]?]\s+({_ID})\s*\(", _M)],
    "sh": [re.compile(rf"^[ \t]*function[ \t]+({_ID})", _M),
           re.compile(rf"^[ \t]*({_ID})[ \t]*\([ \t]*\)", _M)],
    "css": [re.compile(r"(--[A-Za-z_][\w-]*)\s*:", _M)],  # custom properties
    "sql": [re.compile(rf"(?i)\bcreate\s+(?:or\s+replace\s+)?(?:temp(?:orary)?\s+)?"
                       rf"(?:table|view|function|procedure|index|type)\s+(?:if\s+not\s+exists\s+)?({_ID})", _M)],
}
DEFS["cs"] = DEFS["java"]
_WORD = re.compile(r"(?<!\w)[A-Za-z_][A-Za-z0-9_]{2,63}(?!\w)", re.ASCII)  # "$HOME": HOME
_JS_WORD = re.compile(r"(?<![\w$])[A-Za-z_$][A-Za-z0-9_$]{2,63}(?![\w$])", re.ASCII)

_HEXLIKE = re.compile(r"(?=\D*\d)[0-9a-fA-F]{8,}", re.ASCII)  # a hash or id: deadbeef01, a3f9c2d1

KEYWORDS = frozenset("""
and as assert async await break case catch class const continue debugger def default del delete do
elif else enum except export extends false finally for from function global goto if implements
import in instanceof interface is lambda let new nonlocal none not null of or package pass private
protected public raise return self static super switch this throw throws true try type typeof
undefined var void while with yield None True False abstract boolean byte char double final float
int long native short synchronized transient volatile string bool object decimal sbyte uint ulong
ushort internal override virtual sealed readonly ref out params namespace using struct record
event operator implicit explicit checked unchecked fixed unsafe lock base foreach then fi esac done
local echo elif declare export readonly unset shift function select from where insert update into
values create table drop alter index view order group by having join left right inner outer limit
""".split())


def extract(text: str, ext: str) -> list[tuple[str, bool, int]]:
    """(name, is definition, occurrences) for the identifiers in a code file's text."""
    fam = FAMILY_OF.get(ext, "")
    word = _JS_WORD if fam == "js" else _WORD
    fold = fam == "sql"  # SQL keywords are written in any case
    counts: dict[str, int] = {}
    for m in word.finditer(text):
        w = m.group()
        if (w.lower() if fold else w) not in KEYWORDS:
            counts[w] = counts.get(w, 0) + 1
    defs: set[str] = set()
    for rx in DEFS.get(fam, ()):
        for m in rx.finditer(text):
            n = m.group(1)
            if 2 <= len(n) <= NAME_MAX and n not in KEYWORDS:
                defs.add(n)
                counts.setdefault(n, 1)
    kept = [(n, c) for n, c in counts.items()
            if n in defs or (c >= 2 and len(n) <= WORD_MAX and not _HEXLIKE.fullmatch(n))]
    kept.sort(key=lambda kv: (kv[0] not in defs, -kv[1], kv[0]))
    return [(n, n in defs, c) for n, c in kept[:MAX_PER_FILE]]
