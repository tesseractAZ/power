#!/usr/bin/env python3
"""
build-docs-docx.py — assemble the project's documentation into one printable Microsoft Word
(.docx) file.

Used two ways:
  * CI (.github/workflows/ci.yml)        — build on every PR and upload the result, so a
    document that no longer converts fails the PR instead of the release.
  * Release (.github/workflows/images.yml) — build at the tagged ref and attach the .docx (and the
    .pdf LibreOffice renders from it) to the GitHub Release.

WHAT IS PRINTED, IN ORDER
  1. README.md                                   (the tour)
  2. GUIDE_PAGES: the operator guide (ecoflow_panel/DOCS.md), then docs/guide/your-home.md,
     docs/guide/options.md and docs/guide/entities.md, each with its own level-1 heading
  3. SECURITY.md
  4. a synthetic "# Engineering reference" heading and the reference index's preamble (the index
     text between its title and its chapter list)
  5. every reference file the manifest in docs/reference/README.md lists, in that order, with a
     page break before each chapter start (a part-2 file continues its chapter)
The index's chapter list and moved-sections table, and everything in docs/history/, are not
printed. A listed file that is missing, a reference file the manifest does not list, a guide page
not in GUIDE_PAGES, or a manifest entry listed twice ends the build with exit 1: the printable is
attached to an immutable Release, so it must not silently lose a chapter.

LINKS. Every source is scanned with a fence-aware CommonMark block scanner (a port of
scripts/lib/markdownScan.mjs: fences, indented code, HTML blocks, quotes and list containers,
code spans, escapes), so text inside code is never rewritten. Each link is resolved:
  * into a printed file (relative, `#…` within the file, or an absolute
    https://github.com/tesseractAZ/power/(blob|tree)/main/… URL) → `#id` of the target heading in
    the merged document; a link without a fragment goes to the file's first heading. The target's
    GitHub slug must be unique in the merged document, or the build exits 1 naming file:line;
  * into a file that is not printed → https://github.com/tesseractAZ/power/blob/<--ref>/<path>
    (tree/ for a directory), so it opens the version the document was built from; "--ref local"
    (the default) links main;
  * images keep a path, made relative to the repository root, which pandoc reads through
    --resource-path.
Every heading carries an explicit `{#id}`: the id GitHub's slugger gives it in the merged
document. Pandoc's own gfm_auto_identifiers turns `--` into an en dash first (smart typography)
and so would disagree with GitHub's ids; explicit ids make the links resolve by construction.

GitHub alert blockquotes (`> [!WARNING]`) become `> **Warning.** …`: pandoc's markdown reader has
no alerts extension and would print the marker.

Pandoc runs with --fail-if-warnings (a missing image or a duplicate id fails the build rather than
shipping a broken document) and --resource-path=<repo root>. `-f markdown` (not gfm) keeps the
`{=openxml}` raw blocks that carry the Word page breaks; `+task_lists` keeps `- [ ]` checkboxes;
`+gfm_auto_identifiers` is the fallback for any heading without an explicit id.

FLAGS THAT DO NOT NEED PANDOC (checked before pandoc is looked for)
  --list-sources       print the printed sources in order, one "<role>\\t<path>" per line
  --assemble-only      write the assembled Markdown to --output (or stdout) and stop
  --print-pandoc-argv  print the pandoc command line as JSON and stop

Run with `python3 -I -B`. Requires the `pandoc` binary on PATH for a real build (CI installs
it; `brew install pandoc` locally).
"""

from __future__ import annotations

import argparse
import json
import os
import posixpath
import re
import shutil
import subprocess
import sys
import unicodedata
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

TITLE = "Power (ecoflow-panel) — Complete Documentation"
SUBTITLE_TMPL = "Time-of-use arbitrage planning, forecasting, battery analytics and life-safety alarms for EcoFlow off-grid homes — v{version}"

# A Word hard page break, expressed as a Pandoc raw-openxml block.
PAGE_BREAK = '\n\n```{=openxml}\n<w:p><w:r><w:br w:type="page"/></w:r></w:p>\n```\n\n'

README = "README.md"
SECURITY = "SECURITY.md"
GUIDE_DIR = "docs/guide"
GUIDE_PAGES = ("ecoflow_panel/DOCS.md", "docs/guide/your-home.md", "docs/guide/options.md", "docs/guide/entities.md")
REFERENCE_DIR = "docs/reference"
REFERENCE_INDEX = "docs/reference/README.md"
HISTORY_DIR = "docs/history"
SYNTHETIC_H1 = "Engineering reference"
MANIFEST_START = "<!-- chapters:start -->"
MANIFEST_END = "<!-- chapters:end -->"

REPO_HOST = "github.com"
REPO_OWNER = "tesseractaz"
REPO_NAME = "power"
REPO_URL = "https://github.com/tesseractAZ/power"
PANDOC_FROM = "markdown+task_lists+gfm_auto_identifiers"

ALERT_LABELS = {
    "NOTE": "Note.",
    "TIP": "Tip.",
    "IMPORTANT": "Important.",
    "WARNING": "Warning.",
    "CAUTION": "Caution.",
}
ALERT_LINE = re.compile(r"( {0,3}> ?)\[!([A-Za-z]+)\][ \t]*")
REF_NAME = re.compile(r"(\d\d)-(?:(\d)-)?[a-z][a-z0-9-]*\.md")
APPENDIX_NAME = re.compile(r"[A-Z]-[a-z][a-z0-9-]*\.md")
SAFE_REF = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,99}")


class BuildError(Exception):
    """A problem in the sources: reported as `file:line: message`, exit 1."""


# ─────────────────────────────── character classes ───────────────────────────────

ASCII_PUNCT = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"
# JavaScript's \s (what markdownScan.mjs tests with), not Python's str.isspace()
JS_SPACE = set("\t\n\v\f\r       　﻿") | {
    chr(c) for c in range(0x2000, 0x200B)
}


def at(s: str, i: int) -> str:
    """s[i], or '' outside the string (JavaScript's undefined; never Python's s[-1])."""
    return s[i] if 0 <= i < len(s) else ""


def is_ascii_punct(c: str) -> bool:
    return c != "" and c in ASCII_PUNCT


def is_ws(c: str) -> bool:
    return c == "" or c in JS_SPACE


def is_punct(c: str) -> bool:
    return c != "" and unicodedata.category(c)[0] in "PS"


def is_ascii_letter(c: str) -> bool:
    return ("A" <= c <= "Z" or "a" <= c <= "z") if c != "" else False


def is_ascii_digit(c: str) -> bool:
    return "0" <= c <= "9" if c != "" else False


def is_ascii_alnum(c: str) -> bool:
    return is_ascii_letter(c) or is_ascii_digit(c)


def js_trim(s: str) -> str:
    start, end = 0, len(s)
    while start < end and s[start] in JS_SPACE:
        start += 1
    while end > start and s[end - 1] in JS_SPACE:
        end -= 1
    return s[start:end]


def js_trim_start_len(s: str) -> int:
    n = 0
    while n < len(s) and s[n] in JS_SPACE:
        n += 1
    return n


# ─────────────────────────────── slugger ───────────────────────────────


# Kept besides letters and marks: decimal digits, letter numbers (Ⅻ) and connector punctuation.
# Other numbers (superscripts, subscripts, fractions) are deleted, as GitHub does.
SLUG_KEEP_CATEGORIES = ("Nd", "Nl", "Pc")
# Zero-width non-joiner and joiner: format characters GitHub keeps in an id.
SLUG_KEEP_JOINERS = ("\u200c", "\u200d")


def github_slug(text: str) -> str:
    """GitHub's base slug (github-slugger): lower-case, keep letters, marks, decimal digits, letter
    numbers, connector punctuation, the zero-width joiners, spaces and hyphens, then each space
    becomes a hyphen. scripts/lib/markdownScan.mjs carries the Node copy."""
    out = []
    for ch in text.lower():
        if ch == " " or ch == "-":
            out.append("-")
            continue
        cat = unicodedata.category(ch)
        if cat[0] in "LM" or cat in SLUG_KEEP_CATEGORIES or ch in SLUG_KEEP_JOINERS:
            out.append(ch)
    return "".join(out)


class Slugger:
    """github-slugger's per-document dedupe: the first use of a base keeps it, the next gets -1,
    then -2, and a suffixed form never collides with an id already handed out."""

    def __init__(self) -> None:
        self.occurrences: dict[str, int] = {}

    def __call__(self, text: str) -> str:
        base = github_slug(text)
        result = base
        while result in self.occurrences:
            n = self.occurrences[base] + 1
            self.occurrences[base] = n
            result = f"{base}-{n}"
        self.occurrences[result] = 0
        return result


# ─────────────────────────────── entities and escapes ───────────────────────────────

NAMED_ENTITIES = {
    "amp": "&", "lt": "<", "gt": ">", "quot": '"', "apos": "'", "nbsp": " ", "copy": "©",
    "reg": "®", "trade": "™", "hellip": "…", "mdash": "—", "ndash": "–", "lsquo": "‘",
    "rsquo": "’", "ldquo": "“", "rdquo": "”", "bull": "•", "middot": "·", "times": "×",
    "divide": "÷", "deg": "°", "plusmn": "±", "micro": "µ", "para": "¶", "sect": "§",
    "larr": "←", "rarr": "→", "uarr": "↑", "darr": "↓", "harr": "↔", "le": "≤", "ge": "≥",
    "ne": "≠", "asymp": "≈", "minus": "−", "eacute": "é", "egrave": "è", "aacute": "á",
    "iacute": "í", "oacute": "ó", "uacute": "ú", "ntilde": "ñ", "uuml": "ü", "ouml": "ö",
    "auml": "ä", "ccedil": "ç", "shy": "­", "zwj": "‍", "zwnj": "‌",
}
HEX_DIGITS = set("0123456789abcdefABCDEF")
DEC_DIGITS = set("0123456789")


def code_point(n: int) -> str:
    if n == 0 or n > 0x10FFFF or 0xD800 <= n <= 0xDFFF:
        return "�"
    return chr(n)


def decode_entities(s: str) -> str:
    if "&" not in s:
        return s
    out = []
    i = 0
    while i < len(s):
        amp = s.find("&", i)
        if amp < 0:
            out.append(s[i:])
            break
        out.append(s[i:amp])
        semi = s.find(";", amp + 1)
        if semi < 0 or semi - amp > 33:
            out.append("&")
            i = amp + 1
            continue
        body = s[amp + 1:semi]
        decoded = None
        if body.startswith("#x") or body.startswith("#X"):
            hx = body[2:]
            if 1 <= len(hx) <= 6 and all(c in HEX_DIGITS for c in hx):
                decoded = code_point(int(hx, 16))
        elif body.startswith("#"):
            dec = body[1:]
            if 1 <= len(dec) <= 7 and all(c in DEC_DIGITS for c in dec):
                decoded = code_point(int(dec, 10))
        elif body in NAMED_ENTITIES:
            decoded = NAMED_ENTITIES[body]
        if decoded is None:
            out.append("&")
            i = amp + 1
            continue
        out.append(decoded)
        i = semi + 1
    return "".join(out)


def unescape_markdown(s: str) -> str:
    if "\\" not in s:
        return s
    out = []
    i = 0
    while i < len(s):
        if s[i] == "\\" and is_ascii_punct(at(s, i + 1)):
            out.append(s[i + 1])
            i += 2
            continue
        out.append(s[i])
        i += 1
    return "".join(out)


# ─────────────────────────────── inline: tags and autolinks ───────────────────────────────


def tag_name_char(c: str) -> bool:
    return is_ascii_alnum(c) or c == "-"


def attr_start(c: str) -> bool:
    return is_ascii_letter(c) or c in ("_", ":")


def attr_char(c: str) -> bool:
    return is_ascii_alnum(c) or c in ("_", ".", ":", "-")


def html_ws(c: str) -> bool:
    return c in (" ", "\t", "\n")


def read_html_tag(s: str, i: int):
    """A raw HTML construct at s[i] == '<' (CommonMark 6.6): (end, tag, close, comment) or None."""
    if at(s, i) != "<":
        return None
    c1 = at(s, i + 1)
    if c1 == "!" and s.startswith("<!--", i):
        if s.startswith("<!-->", i):
            return (i + 5, "!--", False, True)
        if s.startswith("<!--->", i):
            return (i + 6, "!--", False, True)
        close = s.find("-->", i + 4)
        return None if close < 0 else (close + 3, "!--", False, True)
    if c1 == "!" and s.startswith("<![CDATA[", i):
        close = s.find("]]>", i + 9)
        return None if close < 0 else (close + 3, "![cdata[", False, False)
    if c1 == "!" and is_ascii_letter(at(s, i + 2)):
        close = s.find(">", i + 2)
        if close < 0:
            return None
        word = re.split(r"\s", s[i + 2:close], maxsplit=1)[0]
        return (close + 1, "!" + word.lower(), False, False)
    if c1 == "?":
        close = s.find("?>", i + 2)
        return None if close < 0 else (close + 2, "?", False, False)
    j = i + 1
    close = False
    if at(s, j) == "/":
        close = True
        j += 1
    if not is_ascii_letter(at(s, j)):
        return None
    name_start = j
    while j < len(s) and tag_name_char(s[j]):
        j += 1
    tag = s[name_start:j].lower()
    if close:
        while html_ws(at(s, j)):
            j += 1
        return (j + 1, tag, True, False) if at(s, j) == ">" else None
    while True:
        ws_start = j
        while html_ws(at(s, j)):
            j += 1
        if at(s, j) == ">":
            return (j + 1, tag, False, False)
        if at(s, j) == "/" and at(s, j + 1) == ">":
            return (j + 2, tag, False, False)
        if j == ws_start or not attr_start(at(s, j)):
            return None
        while j < len(s) and attr_char(s[j]):
            j += 1
        k = j
        while html_ws(at(s, k)):
            k += 1
        if at(s, k) != "=":
            continue
        k += 1
        while html_ws(at(s, k)):
            k += 1
        q = at(s, k)
        if q in ('"', "'"):
            end_q = s.find(q, k + 1)
            if end_q < 0:
                return None
            j = end_q + 1
        else:
            v_start = k
            while k < len(s) and s[k] not in " \t\n\"'=<>`":
                k += 1
            if k == v_start:
                return None
            j = k


def read_autolink(s: str, i: int):
    """An autolink `<scheme:…>` or `<user@host>` at s[i] == '<': (end, url) or None."""
    if at(s, i) != "<":
        return None
    close = s.find(">", i + 1)
    if close < 0:
        return None
    body = s[i + 1:close]
    if body == "":
        return None
    for ch in body:
        if ch == " " or ch == "<" or ord(ch) <= 0x20:
            return None
    colon = body.find(":")
    if 2 <= colon <= 32 and is_ascii_letter(body[0]):
        if all(is_ascii_alnum(c) or c in "+.-" for c in body[1:colon]):
            return (close + 1, body)
    atpos = body.find("@")
    if 0 < atpos < len(body) - 1 and body.find("@", atpos + 1) < 0 and "\\" not in body:
        return (close + 1, "mailto:" + body)
    return None


# ─────────────────────────────── inline: tokenizer and links ───────────────────────────────

MASK = ""


def tokenize_inline(text: str):
    """Code spans, escapes, autolinks and raw HTML, leftmost first. Returns the tokens and a
    same-length copy of the text with those constructs masked."""
    tokens = []
    masked = []
    i = 0
    text_start = 0

    def flush(end: int) -> None:
        if end > text_start:
            tokens.append({"type": "text", "start": text_start, "end": end})
            masked.append(text[text_start:end])

    while i < len(text):
        c = text[i]
        if c == "\\" and is_ascii_punct(at(text, i + 1)):
            flush(i)
            tokens.append({"type": "escape", "start": i, "end": i + 2, "ch": text[i + 1]})
            masked.append(MASK * 2)
            i += 2
            text_start = i
            continue
        if c == "`":
            n = 0
            while at(text, i + n) == "`":
                n += 1
            j = i + n
            close_at = -1
            while j < len(text):
                k = text.find("`", j)
                if k < 0:
                    break
                m = 0
                while at(text, k + m) == "`":
                    m += 1
                if m == n:
                    close_at = k
                    break
                j = k + m
            if close_at < 0:
                i += n
                continue
            flush(i)
            content = text[i + n:close_at].replace("\n", " ")
            if len(content) >= 2 and content.startswith(" ") and content.endswith(" ") and js_trim(content) != "":
                content = content[1:-1]
            tokens.append({"type": "code", "start": i, "end": close_at + n, "content": content})
            masked.append(MASK * (close_at + n - i))
            i = close_at + n
            text_start = i
            continue
        if c == "<":
            auto = read_autolink(text, i)
            if auto:
                flush(i)
                tokens.append({"type": "autolink", "start": i, "end": auto[0], "url": auto[1]})
                masked.append(MASK * (auto[0] - i))
                i = auto[0]
                text_start = i
                continue
            tag = read_html_tag(text, i)
            if tag:
                flush(i)
                tokens.append({"type": "html", "start": i, "end": tag[0], "tag": tag[1]})
                masked.append(MASK * (tag[0] - i))
                i = tag[0]
                text_start = i
                continue
        i += 1
    flush(len(text))
    return tokens, "".join(masked)


def normalize_label(label: str) -> str:
    return " ".join(label.split()).lower()


def read_inline_dest(text: str, i: int):
    """An inline link destination (and optional title) just after `(` at text[i]. Returns
    (dest, end, raw_start, raw_end) — end is the index after `)`, raw_* bound the destination as
    written (angle brackets included) — or None."""

    def ws(c: str) -> bool:
        return c in (" ", "\t", "\n")

    j = i
    while j < len(text) and ws(text[j]):
        j += 1
    if at(text, j) == "<":
        k = j + 1
        while k < len(text) and text[k] != ">":
            if text[k] in ("\n", "<"):
                return None
            if text[k] == "\\" and is_ascii_punct(at(text, k + 1)):
                k += 1
            k += 1
        if at(text, k) != ">":
            return None
        dest = text[j + 1:k]
        raw_start, raw_end = j, k + 1
        j = k + 1
    else:
        depth = 0
        start = j
        while j < len(text):
            c = text[j]
            if c == "\\" and is_ascii_punct(at(text, j + 1)):
                j += 2
                continue
            if ws(c) or ord(c) < 0x20:
                break
            if c == "(":
                depth += 1
            if c == ")":
                if depth == 0:
                    break
                depth -= 1
            j += 1
        if depth != 0:
            return None
        dest = text[start:j]
        raw_start, raw_end = start, j
    while j < len(text) and ws(text[j]):
        j += 1
    q = at(text, j)
    if q in ('"', "'", "("):
        closer = ")" if q == "(" else q
        k = j + 1
        while k < len(text) and text[k] != closer:
            if text[k] == "\\" and is_ascii_punct(at(text, k + 1)):
                k += 1
            k += 1
        if k >= len(text):
            return None
        j = k + 1
        while j < len(text) and ws(text[j]):
            j += 1
    if at(text, j) != ")":
        return None
    return (decode_entities(unescape_markdown(dest)), j + 1, raw_start, raw_end)


def match_bracket(masked: str, open_at: int) -> int:
    depth = 0
    for j in range(open_at, len(masked)):
        c = masked[j]
        if c == "[":
            depth += 1
        elif c == "]":
            depth -= 1
            if depth == 0:
                return j
    return -1


def find_links(text: str, masked: str, definitions: dict, frm: int = 0, to: int | None = None):
    """Inline and reference links and images. Each is a dict with start, end, text_start,
    text_end, image, kind, dest, and (inline links only) raw_start / raw_end."""
    if to is None:
        to = len(masked)
    links = []

    def push_with_images(link):
        links.append(link)
        for inner in find_links(text, masked, definitions, link["text_start"], link["text_end"]):
            if inner["image"]:
                links.append(inner)

    i = frm
    while i < to:
        open_at = masked.find("[", i)
        if open_at < 0 or open_at >= to:
            break
        image = open_at > 0 and masked[open_at - 1] == "!"
        close = match_bracket(masked, open_at)
        if close < 0 or close >= to:
            i = open_at + 1
            continue
        start = open_at - 1 if image else open_at
        label = text[open_at + 1:close]
        if at(masked, close + 1) == "(":
            d = read_inline_dest(text, close + 2)
            if d and d[1] <= to:
                push_with_images({"start": start, "end": d[1], "text_start": open_at + 1, "text_end": close,
                                  "image": image, "kind": "inline", "dest": d[0],
                                  "raw_start": d[2], "raw_end": d[3]})
                i = d[1]
                continue
        if at(masked, close + 1) == "[":
            ref_close = masked.find("]", close + 2)
            if 0 < ref_close < to:
                ref_label = text[close + 2:ref_close]
                key = normalize_label(label if ref_label == "" else ref_label)
                if key in definitions:
                    push_with_images({"start": start, "end": ref_close + 1, "text_start": open_at + 1,
                                      "text_end": close, "image": image, "kind": "reference",
                                      "dest": definitions[key]})
                    i = ref_close + 1
                    continue
        key = normalize_label(label)
        if key != "" and key in definitions and close < to:
            push_with_images({"start": start, "end": close + 1, "text_start": open_at + 1, "text_end": close,
                              "image": image, "kind": "reference", "dest": definitions[key]})
            i = close + 1
            continue
        i = open_at + 1
    return links


def strip_emphasis(s: str) -> str:
    """Remove paired `*`, `_`, `~` delimiter runs by CommonMark flanking rules."""
    runs = []
    i = 0
    while i < len(s):
        c = s[i]
        if c in ("*", "_", "~"):
            n = 0
            while at(s, i + n) == c:
                n += 1
            prev = at(s, i - 1)
            nxt = at(s, i + n)
            left = not is_ws(nxt) and (not is_punct(nxt) or is_ws(prev) or is_punct(prev))
            right = not is_ws(prev) and (not is_punct(prev) or is_ws(nxt) or is_punct(nxt))
            can_open, can_close = left, right
            if c == "_":
                can_open = left and (not right or is_punct(prev))
                can_close = right and (not left or is_punct(nxt))
            runs.append({"c": c, "i": i, "n": n, "open": can_open, "close": can_close, "remove": 0})
            i += n
        else:
            i += 1
    stack = []
    for r in runs:
        if r["close"]:
            for k in range(len(stack) - 1, -1, -1):
                o = stack[k]
                if o["c"] != r["c"]:
                    continue
                used = min(o["n"] - o["remove"], r["n"] - r["remove"])
                if used <= 0:
                    continue
                o["remove"] += used
                r["remove"] += used
                del stack[k:]
                break
        if r["open"] and r["remove"] < r["n"]:
            stack.append(r)
    out = []
    last = 0
    for r in runs:
        if r["remove"] == 0:
            continue
        out.append(s[last:r["i"]] + r["c"] * (r["n"] - r["remove"]))
        last = r["i"] + r["n"]
    out.append(s[last:])
    return "".join(out)


def parse_inline(text: str, definitions: dict):
    all_tokens, masked = tokenize_inline(text)
    links = find_links(text, masked, definitions)

    def in_dest(t) -> bool:
        return any(t["start"] > l["text_end"] and t["end"] <= l["end"] for l in links)

    tokens = [t for t in all_tokens if t["type"] == "text" or not in_dest(t)]
    return tokens, links


def render_inline_text(text: str, definitions: dict) -> str:
    """The plain text GitHub computes a heading id from."""
    tokens, links = parse_inline(text, definitions)
    token_at = {t["start"]: t for t in tokens if t["type"] != "text"}
    link_at = {l["start"]: l for l in links}

    def render_range(frm: int, to: int) -> str:
        out = []
        pending = []

        def flush() -> None:
            out.append(strip_emphasis(decode_entities("".join(pending))))
            pending.clear()

        p = frm
        while p < to:
            link = link_at.get(p)
            if link and link["end"] <= to:
                flush()
                if not link["image"]:
                    out.append(render_range(link["text_start"], link["text_end"]))
                p = link["end"]
                continue
            t = token_at.get(p)
            if t and t["end"] <= to:
                flush()
                if t["type"] == "code":
                    out.append(t["content"])
                elif t["type"] == "escape":
                    out.append(t["ch"])
                elif t["type"] == "autolink":
                    out.append(text[t["start"] + 1:t["end"] - 1])
                p = t["end"]
                continue
            pending.append(text[p])
            p += 1
        flush()
        return "".join(out)

    return render_range(0, len(text))


# ─────────────────────────────── block scanner ───────────────────────────────

HTML_BLOCK6 = set(
    (
        "address article aside base basefont blockquote body caption center col colgroup dd details "
        "dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html "
        "iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table "
        "tbody td tfoot th thead title tr track ul"
    ).split(" ")
)
HTML_BLOCK1 = ("script", "pre", "style", "textarea")


def indent_of(s: str):
    col = 0
    i = 0
    while i < len(s):
        if s[i] == " ":
            col += 1
        elif s[i] == "\t":
            col += 4 - (col % 4)
        else:
            break
        i += 1
    return col, i


def strip_quotes(line: str, maximum: float = float("inf")):
    rest = line
    depth = 0
    while depth < maximum:
        col, idx = indent_of(rest)
        if col > 3 or at(rest, idx) != ">":
            break
        rest = rest[idx + 1:]
        if at(rest, 0) in (" ", "\t"):
            rest = rest[1:]
        depth += 1
    return depth, rest


def fence_open(content: str):
    c = at(content, 0)
    if c not in ("`", "~"):
        return None
    n = 0
    while at(content, n) == c:
        n += 1
    if n < 3:
        return None
    info = content[n:]
    if c == "`" and "`" in info:
        return None
    return {"char": c, "len": n}


def is_fence_close(content: str, fence: dict) -> bool:
    n = 0
    while at(content, n) == fence["char"]:
        n += 1
    if n < fence["len"]:
        return False
    return js_trim(content[n:]) == ""


def is_thematic(content: str) -> bool:
    c = at(content, 0)
    if c not in ("*", "-", "_"):
        return False
    n = 0
    for ch in content:
        if ch == c:
            n += 1
        elif ch not in (" ", "\t"):
            return False
    return n >= 3


def atx_heading(content: str):
    """(level, text, text_offset) of an ATX heading line's content, or None."""
    n = 0
    while at(content, n) == "#":
        n += 1
    if n < 1 or n > 6:
        return None
    after = at(content, n)
    if after not in ("", " ", "\t"):
        return None
    tail = content[n:]
    lead = js_trim_start_len(tail)
    text = js_trim(tail)
    end = len(text)
    while end > 0 and text[end - 1] == "#":
        end -= 1
    if end == 0:
        text = ""
    elif end < len(text) and text[end - 1] in (" ", "\t"):
        text = js_trim(text[:end])
    return n, text, n + lead


def setext_level(content: str) -> int:
    c = at(content, 0)
    if c not in ("=", "-"):
        return 0
    i = 0
    while at(content, i) == c:
        i += 1
    if js_trim(content[i:]) != "":
        return 0
    return 1 if c == "=" else 2


def list_marker(content: str):
    c = at(content, 0)
    w = 0
    if c in ("-", "+", "*"):
        w = 1
    else:
        while w < 9 and is_ascii_digit(at(content, w)):
            w += 1
        if w == 0 or at(content, w) not in (".", ")"):
            return None
        w += 1
    after = at(content, w)
    if after not in ("", " ", "\t"):
        return None
    return w


def html_block_start(content: str, para_open: bool):
    if at(content, 0) != "<":
        return None
    lower = content.lower()
    for t in HTML_BLOCK1:
        if lower.startswith("<" + t):
            after = at(lower, len(t) + 1)
            if after in ("", " ", "\t", ">"):
                return (1, "</" + t + ">")
    if content.startswith("<!--"):
        return (2, "-->")
    if content.startswith("<?"):
        return (3, "?>")
    if content.startswith("<![CDATA["):
        return (5, "]]>")
    if content.startswith("<!") and is_ascii_letter(at(content, 2)):
        return (4, ">")
    j = 1
    if at(content, j) == "/":
        j += 1
    ns = j
    while j < len(content) and tag_name_char(content[j]):
        j += 1
    name = lower[ns:j]
    if name and name in HTML_BLOCK6:
        after = at(content, j)
        if after in ("", " ", "\t", ">") or content.startswith("/>", j):
            return (6, "blank")
    if not para_open:
        tag = read_html_tag(content, 0)
        if (tag and not tag[3] and tag[1][0] != "!" and tag[1] != "?"
                and js_trim(content[tag[0]:]) == "" and tag[1] not in HTML_BLOCK1):
            return (7, "blank")
    return None


def is_delimiter_row(content: str) -> bool:
    t = js_trim(content)
    if "-" not in t:
        return False
    cells = t.split("|")
    if js_trim(cells[0]) == "":
        cells = cells[1:]
    if cells and js_trim(cells[-1]) == "":
        cells = cells[:-1]
    if not cells:
        return False
    if len(cells) == 1 and "|" not in t:
        return False
    return all(re.fullmatch(r":?-+:?", js_trim(c)) for c in cells)


def read_definition(content: str):
    """A reference definition `[label]: dest "title"`: (label, dest, raw_start, raw_end) or None."""
    if at(content, 0) != "[":
        return None
    j = 1
    while j < len(content) and content[j] != "]":
        if content[j] == "[":
            return None
        if content[j] == "\\":
            j += 1
        j += 1
    if at(content, j) != "]" or at(content, j + 1) != ":" or j == 1 or j > 1000:
        return None
    label = content[1:j]
    k = j + 2
    while at(content, k) in (" ", "\t") and k < len(content):
        k += 1
    if at(content, k) == "<":
        close = content.find(">", k + 1)
        if close < 0:
            return None
        dest = content[k + 1:close]
        raw_start, raw_end = k, close + 1
        k = close + 1
    else:
        s = k
        while k < len(content) and content[k] not in (" ", "\t"):
            k += 1
        dest = content[s:k]
        raw_start, raw_end = s, k
        if dest == "":
            return None
    rest = js_trim(content[k:])
    if rest != "":
        q = rest[0]
        closer = ")" if q == "(" else q
        if q not in ('"', "'", "(") or rest[-1] != closer or len(rest) < 2:
            return None
    return normalize_label(label), decode_entities(unescape_markdown(dest)), raw_start, raw_end


class Heading:
    __slots__ = ("line", "level", "raw", "text", "base", "slug", "setext", "id", "unique", "col")

    def __init__(self, line: int, level: int, raw: str, text: str, setext: bool, col: int = 0) -> None:
        self.line = line
        self.col = col  # an ATX heading: the column of its first '#' in the raw line
        self.level = level
        self.raw = raw
        self.text = text
        self.base = github_slug(text)
        self.slug = ""
        self.setext = setext
        self.id = ""
        self.unique = False


class Link:
    __slots__ = ("line", "kind", "image", "dest", "span")

    def __init__(self, line: int, kind: str, image: bool, dest: str, span) -> None:
        self.line = line
        self.kind = kind
        self.image = image
        self.dest = dest
        # (line, start_col, end_col) of the destination as written, or None
        self.span = span


class Scan:
    def __init__(self) -> None:
        self.lines: list[str] = []
        self.kinds: list[str] = []
        self.headings: list[Heading] = []
        self.links: list[Link] = []
        self.unclosed_fence: int | None = None


def scan_markdown(src: str) -> Scan:
    """Port of markdownScan.mjs scanMarkdown: headings (with GitHub slugs), links (with the raw
    position of each destination), per-line kinds and the first unclosed fence."""
    lines = src.split("\n")
    kinds = ["para"] * len(lines)
    blocks = []  # {kind, text, line, segs: [(offset, line, col)], level?, setext?}
    definitions: dict[str, str] = {}
    def_links: list[Link] = []
    st = {"fence": None, "html": None, "para": None, "in_code": False}
    lists: list[int] = []

    def seg_block(kind, entries, **extra):
        texts = []
        segs = []
        off = 0
        for e in entries:
            segs.append((off, e["line"], e["col"]))
            texts.append(e["text"])
            off += len(e["text"]) + 1
        block = {"kind": kind, "text": "\n".join(texts), "line": entries[0]["line"], "segs": segs}
        block.update(extra)
        return block

    def close_para() -> None:
        para = st["para"]
        if not para:
            return
        if para["kind"] == "table":
            for l in para["lines"]:
                blocks.append(seg_block("row", [l]))
        elif para["lines"]:
            blocks.append(seg_block("para", para["lines"]))
        st["para"] = None

    def entry(text: str, line_no: int, raw: str):
        return {"text": text, "line": line_no, "col": len(raw) - len(text)}

    for n, raw in enumerate(lines):
        line_no = n + 1
        fence = st["fence"]
        if fence:
            q_depth, q_rest = strip_quotes(raw, fence["depth"])
            if q_depth < fence["depth"]:
                st["fence"] = None
            else:
                col, idx = indent_of(q_rest)
                content = q_rest[idx:]
                if content != "" and col < fence["base"]:
                    st["fence"] = None
                else:
                    if col - fence["base"] <= 3 and is_fence_close(content, fence):
                        kinds[n] = "fence-close"
                        st["fence"] = None
                    else:
                        kinds[n] = "fence-body"
                    continue

        depth, rest = strip_quotes(raw)

        html = st["html"]
        if html:
            if html == "blank":
                if js_trim(rest) == "":
                    st["html"] = None
                    kinds[n] = "blank"
                    continue
                kinds[n] = "html"
                continue
            kinds[n] = "html"
            if html in rest.lower():
                st["html"] = None
            continue

        if js_trim(rest) == "":
            close_para()
            kinds[n] = "code" if st["in_code"] else "blank"
            continue

        indent, idx = indent_of(rest)
        content = rest[idx:]

        def starts_block(c: str) -> bool:
            return bool(fence_open(c) or atx_heading(c) or is_thematic(c) or list_marker(c) is not None
                        or html_block_start(c, True) or at(c, 0) == ">")

        para = st["para"]
        top_list = lists[-1] if lists else 0
        if (para and para["kind"] != "table" and (depth < para["depth"] or indent < top_list)
                and not starts_block(content) and indent < 4 + top_list):
            if depth <= para["depth"]:
                para["lines"].append(entry(content, line_no, raw))
                kinds[n] = "para"
                continue

        if para and depth != para["depth"]:
            close_para()
        while lists and indent < lists[-1]:
            lists.pop()
        para = st["para"]
        if para and para["list_depth"] > len(lists):
            close_para()

        base = lists[-1] if lists else 0
        st["in_code"] = False
        while True:
            para = st["para"]
            rel = indent - base
            if rel >= 4:
                if para and para["kind"] != "table":
                    para["lines"].append(entry(content, line_no, raw))
                    kinds[n] = "para"
                else:
                    close_para()
                    kinds[n] = "code"
                    st["in_code"] = True
                break
            f = fence_open(content)
            if f:
                close_para()
                st["fence"] = {"char": f["char"], "len": f["len"], "depth": depth, "base": base, "open": line_no}
                kinds[n] = "fence-open"
                break
            h = atx_heading(content)
            if h:
                close_para()
                hash_col = len(raw) - len(content)
                blocks.append({"kind": "heading", "text": h[1], "line": line_no, "segs": [(0, line_no, hash_col + h[2])],
                               "level": h[0], "setext": False, "hash_col": hash_col})
                kinds[n] = "heading"
                break
            sl = setext_level(content)
            if (sl and para and para["kind"] == "para" and para["lines"] and para["depth"] == depth
                    and para["list_depth"] == len(lists)):
                entries = []
                for l in para["lines"]:
                    lead = js_trim_start_len(l["text"])
                    entries.append({"text": js_trim(l["text"]), "line": l["line"], "col": l["col"] + lead})
                    kinds[l["line"] - 1] = "heading"
                st["para"] = None
                blocks.append(seg_block("heading", entries, level=sl, setext=True))
                kinds[n] = "setext"
                break
            if is_thematic(content):
                close_para()
                kinds[n] = "hr"
                break
            hb = html_block_start(content, bool(para))
            if hb:
                close_para()
                kinds[n] = "html"
                if hb[1] != "blank" and content.lower().find(hb[1], 4 if hb[0] == 2 else 1) < 0:
                    st["html"] = hb[1]
                elif hb[1] == "blank":
                    st["html"] = "blank"
                break
            lm = list_marker(content)
            interrupts = lm is not None and (
                not para or para["kind"] == "table"
                or (js_trim(content[lm:]) != "" and (not is_ascii_digit(at(content, 0)) or int(content[:lm - 1]) == 1))
            )
            if lm is not None and interrupts:
                close_para()
                after = content[lm:]
                sp_col, sp_idx = indent_of(after)
                content_indent = indent + lm + 1 if (js_trim(after) == "" or sp_col >= 5) else indent + lm + sp_col
                lists.append(content_indent)
                base = content_indent
                if js_trim(after) == "":
                    kinds[n] = "para"
                    break
                content = after[sp_idx:]
                indent = content_indent
                continue
            if para and para["depth"] == depth and para["kind"] != "def":
                if (para["kind"] == "para" and len(para["lines"]) == 1 and is_delimiter_row(content)
                        and "|" in para["lines"][0]["text"]):
                    para["kind"] = "table"
                para["lines"].append(entry(content, line_no, raw))
                kinds[n] = "para"
                break
            d = read_definition(content)
            if d and (not para or para["kind"] == "def"):
                if d[0] not in definitions:
                    definitions[d[0]] = d[1]
                col = len(raw) - len(content)
                def_links.append(Link(line_no, "definition", False, d[1], (line_no, col + d[2], col + d[3])))
                if not para:
                    st["para"] = {"kind": "def", "depth": depth, "list_depth": len(lists), "lines": []}
                kinds[n] = "para"
                break
            if para and para["kind"] == "def":
                para["kind"] = "para"
            if not para:
                para = {"kind": "para", "depth": depth, "list_depth": len(lists), "lines": []}
                st["para"] = para
            para["lines"].append(entry(content, line_no, raw))
            kinds[n] = "para"
            break
    close_para()

    scan = Scan()
    scan.lines = lines
    scan.kinds = kinds
    scan.unclosed_fence = st["fence"]["open"] if st["fence"] else None
    scan.links = list(def_links)

    def locate(block, offset: int):
        line, col = block["segs"][0][1], block["segs"][0][2]
        for seg_off, seg_line, seg_col in block["segs"]:
            if seg_off <= offset:
                line, col = seg_line, seg_col + (offset - seg_off)
        return line, col

    slug = Slugger()
    for b in blocks:
        tokens, links = parse_inline(b["text"], definitions)
        for t in tokens:
            if t["type"] == "autolink":
                line, col = locate(b, t["start"])
                _, col_end = locate(b, t["end"])
                scan.links.append(Link(line, "autolink", False, t["url"], (line, col, col_end)))
        for l in links:
            line, _ = locate(b, l["start"])
            span = None
            if l["kind"] == "inline":
                s_line, s_col = locate(b, l["raw_start"])
                e_line, e_col = locate(b, l["raw_end"])
                span = (s_line, s_col, e_col) if s_line == e_line else ("split", s_line, e_line)
            scan.links.append(Link(line, l["kind"], l["image"], l["dest"], span))
        if b["kind"] == "heading":
            text = js_trim(render_inline_text(b["text"], definitions))
            h = Heading(b["line"], b["level"], b["text"], text, b["setext"], b.get("hash_col", 0))
            h.slug = slug(text)
            scan.headings.append(h)
    scan.links.sort(key=lambda l: (l.line, l.span[1] if l.span and l.span[0] != "split" else 0))
    return scan


# ─────────────────────────────── sources ───────────────────────────────


class Source:
    """One printed piece: a file (or the index preamble), its text and its scan."""

    def __init__(self, role: str, rel: str, text: str, line_offset: int = 0) -> None:
        self.role = role
        self.rel = rel
        self.text = text
        self.line_offset = line_offset  # the preamble is a slice: report the index's own lines
        self.scan = scan_markdown(text)
        self.by_slug = {h.slug: h for h in self.scan.headings}

    def where(self, line: int) -> str:
        return f"{self.rel}:{line + self.line_offset}"


def read_text(root: Path, rel: str) -> str:
    """Read a source once; a missing file is a build error, not a skipped chapter."""
    try:
        buf = (root / rel).read_bytes()
    except FileNotFoundError:
        raise BuildError(f"{rel}: missing — the printable would silently lose it") from None
    except IsADirectoryError:
        raise BuildError(f"{rel}: is a directory, not a Markdown file") from None
    try:
        return buf.decode("utf-8")
    except UnicodeDecodeError as e:
        raise BuildError(f"{rel}: not UTF-8 ({e.reason} at byte {e.start})") from None


def markdown_files(root: Path, rel_dir: str) -> list[str]:
    """The *.md files directly in a directory (symlinks skipped), sorted."""
    names = []
    try:
        with os.scandir(root / rel_dir) as it:
            for e in it:
                if e.is_symlink() or not e.is_file(follow_symlinks=False):
                    continue
                if e.name.endswith(".md"):
                    names.append(e.name)
    except FileNotFoundError:
        raise BuildError(f"{rel_dir}/: missing") from None
    return sorted(names)


def reference_kind(name: str) -> str:
    """'chapter' for a file that starts a chapter (NN-, NN-1- or an appendix), 'part' for a later
    part of a split chapter."""
    m = REF_NAME.fullmatch(name)
    if m:
        return "part" if m.group(2) and int(m.group(2)) >= 2 else "chapter"
    if APPENDIX_NAME.fullmatch(name):
        return "chapter"
    raise BuildError(f"{REFERENCE_DIR}/{name}: not a reference file name (NN-slug.md, NN-k-slug.md or X-slug.md)")


def read_manifest(index_text: str, index_scan: Scan) -> list[str]:
    """The reference files listed between the chapters markers of the index, in order."""
    lines = index_text.split("\n")
    stripped = [l.strip() for l in lines]
    if MANIFEST_START not in stripped or MANIFEST_END not in stripped:
        raise BuildError(f"{REFERENCE_INDEX}: no {MANIFEST_START} … {MANIFEST_END} manifest")
    start = stripped.index(MANIFEST_START) + 1  # 1-based line of the start marker
    end = stripped.index(MANIFEST_END) + 1
    if end < start:
        raise BuildError(f"{REFERENCE_INDEX}:{end}: the manifest's end marker comes before its start")
    listed = []
    for l in index_scan.links:
        if l.line <= start or l.line >= end or l.image:
            continue
        name = l.dest.split("#", 1)[0]
        if name.startswith("./"):
            name = name[2:]
        if name == "" or "/" in name:
            raise BuildError(f"{REFERENCE_INDEX}:{l.line}: manifest entry {json.dumps(l.dest)} is not a file in {REFERENCE_DIR}")
        if name in listed:
            raise BuildError(f"{REFERENCE_INDEX}:{l.line}: {name} is listed twice")
        listed.append(name)
    if not listed:
        raise BuildError(f"{REFERENCE_INDEX}: the manifest lists no reference files")
    return listed


def index_preamble(index_text: str, index_scan: Scan):
    """The index text between its title (the first heading, level 1) and the heading of the
    section that holds the chapter list. Returns (text, line_offset)."""
    heads = index_scan.headings
    if not heads or heads[0].level != 1:
        raise BuildError(f"{REFERENCE_INDEX}: must open with a level-1 title")
    lines = index_text.split("\n")
    marker = [l.strip() for l in lines].index(MANIFEST_START) + 1
    holder = [h for h in heads if h.line < marker]
    if len(holder) < 2:
        raise BuildError(f"{REFERENCE_INDEX}: the chapter list must sit under its own heading, after the title")
    first, last = heads[0].line, holder[-1].line  # 1-based
    return "\n".join(lines[first:last - 1]), first


def plan_sources(root: Path):
    """[(role, rel)] in print order, checking the guide directory and the reference manifest."""
    guide_names = markdown_files(root, GUIDE_DIR)
    for name in guide_names:
        if f"{GUIDE_DIR}/{name}" not in GUIDE_PAGES:
            raise BuildError(f"{GUIDE_DIR}/{name}: a guide page not in GUIDE_PAGES — it would not be printed")
    index_text = read_text(root, REFERENCE_INDEX)
    index_scan = scan_markdown(index_text)
    manifest = read_manifest(index_text, index_scan)
    present = [n for n in markdown_files(root, REFERENCE_DIR) if f"{REFERENCE_DIR}/{n}" != REFERENCE_INDEX]
    for name in present:
        if name not in manifest:
            raise BuildError(f"{REFERENCE_DIR}/{name}: not listed in the manifest ({REFERENCE_INDEX}) — it would not be printed")
    for name in manifest:
        if name not in present:
            raise BuildError(f"{REFERENCE_INDEX}: lists {name}, which is missing from {REFERENCE_DIR}/")
    plan = [("readme", README)]
    plan += [("guide", rel) for rel in GUIDE_PAGES]
    plan.append(("security", SECURITY))
    plan.append(("preamble", REFERENCE_INDEX))
    for name in manifest:
        plan.append((reference_kind(name), f"{REFERENCE_DIR}/{name}"))
    for role, rel in plan:
        if rel == HISTORY_DIR or rel.startswith(HISTORY_DIR + "/"):
            raise BuildError(f"{rel}: the frozen history is not printed")
    return plan, index_text, index_scan


# ─────────────────────────────── links ───────────────────────────────


class Document:
    def __init__(self, root: Path, link_ref: str) -> None:
        self.root = root
        self.link_ref = link_ref
        self.errors: list[str] = []
        plan, index_text, index_scan = plan_sources(root)
        self.sources: list[Source] = []
        for role, rel in plan:
            if role == "preamble":
                text, offset = index_preamble(index_text, index_scan)
                self.sources.append(Source(role, rel, text, offset))
            else:
                self.sources.append(Source(role, rel, read_text(root, rel)))
        # the files a link can land in (the index's preamble is printed, the index is not)
        self.files = {s.rel: s for s in self.sources if s.role != "preamble"}
        for s in self.sources:
            if s.scan.unclosed_fence is not None:
                self.errors.append(f"{s.where(s.scan.unclosed_fence)}: code fence opened here is never closed")
        self.assign_ids()

    def assign_ids(self) -> None:
        """Every heading's id in the merged document (GitHub's slugger over the whole thing), and
        whether its base slug is unique there."""
        slug = Slugger()
        counts: dict[str, int] = {}
        self.synthetic_id = ""
        for s in self.sources:
            if s.role == "preamble":
                self.synthetic_id = slug(SYNTHETIC_H1)
                counts[github_slug(SYNTHETIC_H1)] = counts.get(github_slug(SYNTHETIC_H1), 0) + 1
            for h in s.scan.headings:
                h.id = slug(h.text)
                counts[h.base] = counts.get(h.base, 0) + 1
        for s in self.sources:
            for h in s.scan.headings:
                h.unique = counts[h.base] == 1 and h.id == h.base and h.id != ""

    def internal(self, src: Source, line: int, target_rel: str, frag: str | None, dest: str) -> str | None:
        target = self.files[target_rel]
        if frag:
            h = target.by_slug.get(frag)
            if h is None:
                self.errors.append(f"{src.where(line)}: {json.dumps(dest)} — #{frag} matches no heading in {target_rel}")
                return None
        else:
            if not target.scan.headings:
                self.errors.append(f"{src.where(line)}: {json.dumps(dest)} — {target_rel} has no heading to link to")
                return None
            h = target.scan.headings[0]
        if not h.unique:
            self.errors.append(
                f"{src.where(line)}: {json.dumps(dest)} — the target heading \"{h.text}\" ({target.where(h.line)}) "
                f"does not have a unique id in the printed document; rename it or link another heading")
            return None
        return "#" + h.id

    def blob(self, path: str, frag: str | None, directory: bool) -> str:
        kind = "tree" if directory else "blob"
        url = f"{REPO_URL}/{kind}/{self.link_ref}/{quote(path, safe='/')}"
        return url + ("#" + frag if frag else "")

    def resolve(self, src: Source, link: Link) -> str | None:
        """The new destination for a link, or None to leave it as written."""
        dest = link.dest
        if dest == "" or link.kind == "reference":
            return None  # an empty destination stays; a reference link is rewritten at its definition
        if link.image:
            return self.resolve_image(src, link)
        if dest.startswith("#"):
            frag = unquote(dest[1:])
            if frag == "":
                return None  # a bare `#` names no heading; left as written
            if src.rel in self.files:
                return self.internal(src, link.line, src.rel, frag, dest)
            return self.blob(src.rel, frag, False)
        parts = urlsplit(dest)
        if parts.scheme or dest.startswith("//"):
            return self.resolve_absolute(src, link, parts)
        if parts.query:
            self.errors.append(f"{src.where(link.line)}: {json.dumps(dest)} — a relative link with a query string")
            return None
        rel_path = unquote(parts.path)
        joined = rel_path.lstrip("/") if rel_path.startswith("/") else posixpath.join(posixpath.dirname(src.rel), rel_path)
        target = posixpath.normpath(joined) if joined else src.rel
        if target == ".." or target.startswith("../"):
            self.errors.append(f"{src.where(link.line)}: {json.dumps(dest)} — points outside the repository")
            return None
        frag = unquote(parts.fragment) if parts.fragment else None
        if target in self.files:
            return self.internal(src, link.line, target, frag, dest)
        if target == ".":
            return f"{REPO_URL}/tree/{self.link_ref}"
        full = self.root / target
        if not os.path.lexists(full):
            self.errors.append(f"{src.where(link.line)}: {json.dumps(dest)} — {target} does not exist")
            return None
        return self.blob(target, frag, rel_path.endswith("/") or full.is_dir())

    def resolve_absolute(self, src: Source, link: Link, parts) -> str | None:
        """A link into this repository on github.com: into a printed file → internal; a blob or
        tree link on main → the same path at --ref; anything else is left alone."""
        try:
            port = parts.port
        except ValueError:
            return None
        if parts.scheme != "https" or (parts.hostname or "") != REPO_HOST or port is not None:
            return None
        segs = parts.path.split("/")
        if len(segs) < 6 or segs[0] != "" or segs[1].lower() != REPO_OWNER or segs[2].lower() != REPO_NAME:
            return None
        if segs[3] not in ("blob", "tree") or segs[4] != "main" or segs[5] == "" or parts.query:
            return None
        path = posixpath.normpath(unquote("/".join(segs[5:])))
        if path in (".", "..") or path.startswith("../"):
            return None
        frag = unquote(parts.fragment) if parts.fragment else None
        if path in self.files:
            return self.internal(src, link.line, path, frag, link.dest)
        return self.blob(path, frag, segs[3] == "tree")

    def resolve_image(self, src: Source, link: Link) -> str | None:
        parts = urlsplit(link.dest)
        if parts.scheme or link.dest.startswith("//"):
            return None
        target = posixpath.normpath(posixpath.join(posixpath.dirname(src.rel), unquote(parts.path)))
        if target == ".." or target.startswith("../") or not (self.root / target).is_file():
            self.errors.append(f"{src.where(link.line)}: image {json.dumps(link.dest)} — {target} is not a file in the repository")
            return None
        return quote(target, safe="/")

    # ─────────────── assembly ───────────────

    def render(self, src: Source) -> str:
        """The source with links resolved, explicit heading ids and alerts converted."""
        lines = list(src.scan.lines)
        edits: dict[int, list] = {}
        for link in src.scan.links:
            new = self.resolve(src, link)
            if new is None or new == link.dest:
                continue
            if link.span is None or link.span[0] == "split":
                self.errors.append(f"{src.where(link.line)}: {json.dumps(link.dest)} — a link destination split across lines cannot be rewritten")
                continue
            line, start, end = link.span
            if link.kind == "autolink":
                inner = lines[line - 1][start + 1:end - 1]
                new = f"<{new}>" if new.startswith("http") else f"[{inner}]({new})"
            elif " " in new or "(" in new or ")" in new:
                new = f"<{new}>"
            edits.setdefault(line, []).append((start, end, new))
        for line, items in edits.items():
            text = lines[line - 1]
            for start, end, new in sorted(items, reverse=True):
                text = text[:start] + new + text[end:]
            lines[line - 1] = text
        heading_at = {h.line: h for h in src.scan.headings}
        out: list[str] = []
        n = 0
        while n < len(lines):
            raw = lines[n]
            kind = src.scan.kinds[n]
            h = heading_at.get(n + 1)
            if h is not None and kind == "heading" and not h.setext:
                out.append(self.heading_line(raw, h, out))
            elif h is not None and h.setext:
                # a setext heading: the id goes after its last text line
                last = n
                while src.scan.kinds[last + 1] == "heading":
                    last += 1
                out.extend(lines[n:last])
                out.append(lines[last] + (f" {{#{h.id}}}" if h.id else ""))
                n = last + 1
                continue
            elif kind == "para" and self.alert(raw) and (n == 0 or not self.quoted(lines[n - 1])):
                out.extend(self.convert_alert(raw, lines[n + 1] if n + 1 < len(lines) else ""))
            else:
                out.append(raw)
            n += 1
        return "\n".join(out).strip("\n")

    @staticmethod
    def heading_line(raw: str, h: Heading, out: list[str]) -> str:
        """An ATX heading line rebuilt with its id: container prefix, hashes, text (closing hashes
        dropped, links already rewritten), ` {#id}`."""
        prefix = raw[:h.col]
        parsed = atx_heading(raw[h.col:])
        text = parsed[1] if parsed else h.raw
        line = f"{prefix}{'#' * h.level} {text}" + (f" {{#{h.id}}}" if h.id else "")
        # pandoc's markdown needs a blank line before a heading; CommonMark does not
        if prefix == "" and out and out[-1].strip() != "":
            line = "\n" + line
        return line

    @staticmethod
    def quoted(line: str) -> bool:
        _, idx = indent_of(line)
        return idx <= 3 and at(line, idx) == ">"

    @staticmethod
    def alert(line: str):
        m = ALERT_LINE.fullmatch(line)
        if m and m.group(2).upper() in ALERT_LABELS:
            return m
        return None

    def convert_alert(self, raw: str, nxt: str) -> list[str]:
        m = self.alert(raw)
        prefix = m.group(1)
        label = f"{prefix}**{ALERT_LABELS[m.group(2).upper()]}**"
        _, rest = strip_quotes(nxt, 1)
        _, idx = indent_of(rest)
        content = rest[idx:]
        if self.quoted(nxt) and content != "" and (
                fence_open(content) or atx_heading(content) or is_thematic(content) or list_marker(content) is not None
                or at(content, 0) in (">", "|") or idx >= 4):
            return [label, prefix.rstrip()]
        return [label]

    def assemble(self) -> str:
        pieces: list[str] = []
        for s in self.sources:
            body = self.render(s)
            if s.role == "preamble":
                body = f"# {SYNTHETIC_H1} {{#{self.synthetic_id}}}\n\n{body}"
            if not pieces:
                pieces.append(body)
            elif s.role == "part":
                pieces.append("\n\n" + body)
            else:
                pieces.append(PAGE_BREAK + body)
        if self.errors:
            raise BuildError("\n".join(self.errors))
        return "".join(pieces) + "\n"


# ─────────────────────────────── CLI ───────────────────────────────


def read_version(repo_root: Path) -> str:
    """Parse the add-on version from ecoflow_panel/config.yaml (same regex the release workflows
    use)."""
    cfg = read_text(repo_root, "ecoflow_panel/config.yaml")
    m = re.search(r'^version:\s*"?([^"#\s]+)"?', cfg, re.M)
    if not m:
        raise BuildError("ecoflow_panel/config.yaml: could not parse version")
    return m.group(1)


def link_ref_for(ref: str) -> str:
    """The ref the printable's repository links point at: the tag or SHA it was built from, or
    main for a local build."""
    if ref == "local":
        return "main"
    if not SAFE_REF.fullmatch(ref):
        raise BuildError(f"--ref {json.dumps(ref)}: not a tag, branch or SHA")
    return ref


def pandoc_argv(repo_root: Path, combined_path: Path, output: Path, version: str, ref: str) -> list[str]:
    return [
        "pandoc", str(combined_path), "-o", str(output),
        "-f", PANDOC_FROM,
        "--standalone", "--toc", "--toc-depth=2",
        "--fail-if-warnings",
        f"--resource-path={repo_root}",
        "--metadata", f"title={TITLE}",
        "--metadata", f"subtitle={SUBTITLE_TMPL.format(version=version)}",
        "--metadata", f"date=Version {version} · source ref {ref}",
    ]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Assemble the project documentation into a .docx")
    ap.add_argument("--repo-root", default=None,
                    help="repo root (default: parent of this script's dir)")
    ap.add_argument("--version", default=None,
                    help="version string for title/filename (default: read from config.yaml)")
    ap.add_argument("--ref", default="local",
                    help="source ref (tag or SHA) stamped into the title block; links to files that "
                         "are not printed point at it (default 'local': they point at main)")
    ap.add_argument("--output", default=None,
                    help="output path (default: EcoFlow-Panel-Documentation-v<version>.docx in CWD; "
                         "with --assemble-only, default stdout)")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--list-sources", action="store_true",
                      help="print the printed sources in order (<role>\\t<path>) and stop")
    mode.add_argument("--assemble-only", action="store_true",
                      help="write the assembled Markdown (to --output, or stdout) and stop; no pandoc")
    mode.add_argument("--print-pandoc-argv", action="store_true",
                      help="print the pandoc command line as JSON and stop")
    args = ap.parse_args(argv)

    repo_root = Path(args.repo_root).resolve() if args.repo_root \
        else Path(__file__).resolve().parent.parent
    try:
        link_ref = link_ref_for(args.ref)
        if args.list_sources:
            plan, _, _ = plan_sources(repo_root)
            for role, rel in plan:
                print(f"{role}\t{rel}")
            return 0
        version = args.version or read_version(repo_root)
        if args.print_pandoc_argv:
            output = Path(args.output).resolve() if args.output \
                else Path.cwd() / f"EcoFlow-Panel-Documentation-v{version}.docx"
            print(json.dumps(pandoc_argv(repo_root, output.with_suffix(".combined.md"), output, version, args.ref)))
            return 0
        combined = Document(repo_root, link_ref).assemble()
    except BuildError as e:
        for line in str(e).split("\n"):
            print(f"build-docs-docx: {line}", file=sys.stderr)
        return 1

    if args.assemble_only:
        data = combined.encode("utf-8")
        if args.output:
            Path(args.output).write_bytes(data)
            print(f"wrote {args.output} ({len(data):,} bytes, assembled Markdown)", file=sys.stderr)
        else:
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
        return 0

    if not shutil.which("pandoc"):
        print("error: pandoc not found on PATH (CI installs it; locally: brew install pandoc)",
              file=sys.stderr)
        return 2

    output = Path(args.output).resolve() if args.output \
        else Path.cwd() / f"EcoFlow-Panel-Documentation-v{version}.docx"
    combined_path = output.with_suffix(".combined.md")
    try:
        combined_path.write_text(combined, encoding="utf-8")
        proc = subprocess.run(pandoc_argv(repo_root, combined_path, output, version, args.ref),
                              capture_output=True, text=True)
    finally:
        # the intermediate goes whatever the outcome
        combined_path.unlink(missing_ok=True)

    if proc.stderr.strip():
        sys.stderr.write(proc.stderr)
    if proc.returncode != 0:
        print(f"build-docs-docx: pandoc exited {proc.returncode} (warnings fail the build: --fail-if-warnings)",
              file=sys.stderr)
        return proc.returncode

    size = output.stat().st_size
    print(f"wrote {output} ({size:,} bytes) — v{version} @ {args.ref}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
