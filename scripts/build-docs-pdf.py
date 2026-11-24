#!/usr/bin/env python3
"""
build-docs-pdf.py — render the printable documentation (.docx) to a .pdf with LibreOffice, its
table of contents updated first, so the PDF lists every level-1 and level-2 heading with the page
it starts on.

Used by both workflows, so the pull request's check renders the PDF the way the release does:
  * CI (.github/workflows/ci.yml, job docs-docx)  — on every PR; a hard gate.
  * Release (.github/workflows/images.yml)        — the .pdf attached to the GitHub Release;
    best-effort there (continue-on-error), like the .docx.

WHY NOT `libreoffice --convert-to pdf`. A plain conversion does not update a document's indexes.
The .docx's contents is a Word TOC field; build-docs-docx.py caches one entry per level-1 and
level-2 heading in it, without page numbers (only a layout engine knows them). A plain conversion
prints those cached entries with no numbers, and, before they were cached, it printed the heading
"Table of Contents" over nothing at all, and exited 0 either way.

WHAT IT DOES
  1. reads the .docx, before LibreOffice starts, for the number of entries the PDF's contents must
     list: the entries build-docs-docx.py cached in the document's one TOC field (it writes them
     only once they match the assembled Markdown's level-1 and level-2 headings). The field must
     list levels 1-2 (`\\o "1-2"`), cache at least one entry, and cache as many as the document
     has paragraphs styled Heading1 or Heading2. The number never comes from LibreOffice;
  2. copies the .docx into a new temporary work directory, which also holds LibreOffice's profile
     (-env:UserInstallation), its TMPDIR, and the lock file it writes beside a document it opens:
     nothing is written beside the caller's .docx, so a stopped run cannot leave a lock there
     that makes the next run on that file wait;
  3. starts LibreOffice once with the new profile and --terminate_after_init. On its first start
     with a new profile LibreOffice rewrites user/basic/Standard/script.xlb, so a macro module
     written before that start is never registered, and the conversion then does nothing and
     exits 0;
  4. writes a Basic module (DocsPdf) into that profile and registers it in script.xlb;
  5. runs it: load the copy hidden, update every document index twice (the first update can move
     the pages its entries name), export the PDF, and write a report holding the text of each
     table of contents after the update; a .docx that does not load, or a Basic error, is written
     to the report instead. Every way out of the macro writes the report, closes the document if
     it loaded and ends LibreOffice, rather than relying on a headless office to exit once its
     last document closes;
  6. checks the result. No report: the macro did not run. The PDF must exist, be non-empty and
     start with %PDF-. The entries of the contents that end in a page number must number exactly
     the entries counted in (1), and their pages must never go back and must end above where
     they start (a contents that was never laid out names one page, or none).
A failure is one line on stderr, `build-docs-pdf: …` (where LibreOffice's own output may say why,
its last lines follow, each prefixed `libreoffice: `), and exit 1; a run stopped by a signal is one
line and exit 128 + the signal. Either way the output path holds a PDF only once every check has
passed: a PDF from an earlier run is removed as soon as the arguments are read, before the .docx
and LibreOffice are looked for.

LibreOffice gets DEADLINE_SECONDS in all (--deadline), under the 240 s `timeout` both workflows
run this script in: past it the script stops LibreOffice and fails with a line saying so, rather
than leaving the caller's timeout to end the step with no reason given. SIGTERM (the caller's
`timeout`) and SIGINT print one line and raise SystemExit, so the finally blocks run, and a second
signal is ignored, so it cannot cut them short. On every way out LibreOffice's process group is
ended (SIGTERM while LibreOffice runs, SIGKILL after GRACE_SECONDS, and SIGKILL to whatever is left
of the group), and the work directory is removed in a finally.

  python3 -I -B scripts/build-docs-pdf.py Power-Documentation.docx [--output OUT.pdf] [--deadline S]

The PDF goes beside the .docx with a .pdf suffix unless --output names it. Exit 0: written and
checked; 1: the render or a check failed; 2: neither `libreoffice` (the command Ubuntu installs)
nor `soffice` is on PATH, or the arguments are wrong. Run with `python3 -I -B`.
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

LIBREOFFICE_COMMANDS = ("libreoffice", "soffice")
MODULE = "DocsPdf"
# The contents lists the level-1 and level-2 headings: build-docs-docx.py's TOC_DEPTH.
TOC_DEPTH = 2
# LibreOffice's time in all (its two starts), under the workflows' `timeout -k 10 240`.
DEADLINE_SECONDS = 200
# From SIGTERM to SIGKILL, for LibreOffice's process group.
GRACE_SECONDS = 3
# The last lines of LibreOffice's output printed after a failure's line.
LOG_TAIL = 20
STOP_SIGNALS = (signal.SIGTERM, signal.SIGINT)
# The field's instruction (pandoc's, kept by build-docs-docx.py): `TOC \o "1-2" \h \z \u`.
TOC_INSTRUCTION = re.compile(r'<w:instrText(?: [^>]*)?>\s*TOC \\o (?:&quot;|")1-(\d)(?:&quot;|")')
FIELD_CHAR = re.compile(r'<w:fldChar w:fldCharType="(begin|separate|end)"')
# A cached entry of the contents: a hyperlink to its heading's bookmark (Word's own entries too).
CACHED_ENTRY = re.compile(r'<w:hyperlink w:anchor="[^"]+"')
HEADING_STYLE = re.compile(r'<w:pStyle w:val="Heading(\d)"\s*/>')
# An entry of an updated contents, as LibreOffice gives its text: the heading, a tab, the page.
PAGED_ENTRY = re.compile(r"[^\t]*\t([1-9][0-9]*)")

# The Basic module the conversion runs. The report: "indexes <n>", then each table of contents'
# text between a "contents" line and an "end" line; or one "error <what>" line. Every way out goes
# through Done, after the error handler has left error mode (Resume): a call that fails while a
# handler runs ends the Sub, which would leave LibreOffice running with no report.
MACRO = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE script:module PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "module.dtd">
<script:module xmlns:script="http://openoffice.org/2000/script" script:name="DocsPdf" script:language="StarBasic">
Sub Convert(inUrl As String, outUrl As String, reportUrl As String)
  Dim doc As Object, idx As Object, report As String, i As Integer, pass As Integer
  On Error GoTo Failed
  Dim load(0) As New com.sun.star.beans.PropertyValue
  load(0).Name = &quot;Hidden&quot; : load(0).Value = True
  doc = StarDesktop.loadComponentFromURL(inUrl, &quot;_blank&quot;, 0, load())
  If IsNull(doc) Then
    report = &quot;error LibreOffice did not load the .docx&quot; &amp; Chr(10)
    GoTo Done
  End If
  idx = doc.getDocumentIndexes()
  For pass = 1 To 2
    For i = 0 To idx.getCount() - 1
      idx.getByIndex(i).update()
    Next i
  Next pass
  Dim export(0) As New com.sun.star.beans.PropertyValue
  export(0).Name = &quot;FilterName&quot; : export(0).Value = &quot;writer_pdf_Export&quot;
  doc.storeToURL(outUrl, export())
  report = &quot;indexes &quot; &amp; idx.getCount() &amp; Chr(10)
  For i = 0 To idx.getCount() - 1
    If idx.getByIndex(i).supportsService(&quot;com.sun.star.text.ContentIndex&quot;) Then
      report = report &amp; &quot;contents&quot; &amp; Chr(10) &amp; idx.getByIndex(i).getAnchor().getString() &amp; Chr(10) &amp; &quot;end&quot; &amp; Chr(10)
    End If
  Next i
  GoTo Done
Failed:
  report = &quot;error Basic error &quot; &amp; Err &amp; &quot; at line &quot; &amp; Erl &amp; &quot;: &quot; &amp; Error$ &amp; Chr(10)
  Resume Done
Done:
  On Error Resume Next
  WriteReport(reportUrl, report)
  If Not IsNull(doc) Then doc.close(True)
  StarDesktop.terminate()
End Sub

Sub WriteReport(url As String, text As String)
  Dim out As Object
  out = createUnoService(&quot;com.sun.star.io.TextOutputStream&quot;)
  out.setOutputStream(createUnoService(&quot;com.sun.star.ucb.SimpleFileAccess&quot;).openFileWrite(url))
  out.setEncoding(&quot;UTF-8&quot;)
  out.writeString(text)
  out.closeOutput()
End Sub
</script:module>
"""


class RenderError(Exception):
    """A failed render or check: one line on stderr, then the tail of `log` (LibreOffice's
    output), exit 1."""

    def __init__(self, message: str, log: str = "") -> None:
        super().__init__(message)
        self.log = log


class Progress:
    """What the run is doing, and since when: for the line a stop prints."""

    def __init__(self) -> None:
        self.started = time.monotonic()
        self.doing = "checking the .docx"

    def seconds(self) -> int:
        return round(time.monotonic() - self.started)


PROGRESS = Progress()


class Deadline:
    """LibreOffice's time in all (--deadline): its two starts share it."""

    def __init__(self, seconds: int) -> None:
        self.seconds = seconds
        self.ends = time.monotonic() + seconds

    def left(self) -> float:
        return max(0.0, self.ends - time.monotonic())


def find_libreoffice() -> str | None:
    """`libreoffice` (Ubuntu's command), else `soffice` (macOS, and LibreOffice's own name)."""
    for name in LIBREOFFICE_COMMANDS:
        path = shutil.which(name)
        if path:
            return path
    return None


def field_result(xml: str, start: int) -> str | None:
    """The part of the field whose instruction ends at `start` between its separator and its own
    end: its cached result. A field nested in it (a PAGEREF in each entry, as Word stores an
    updated contents) is passed over. None if the field has no separator or no end."""
    depth, result = 1, None
    for m in FIELD_CHAR.finditer(xml, start):
        kind = m.group(1)
        if kind == "begin":
            depth += 1
        elif kind == "separate":
            if depth == 1 and result is None:
                result = m.end()
        else:
            depth -= 1
            if depth == 0:
                return None if result is None else xml[result:m.start()]
    return None


def expected_entries(docx: Path) -> int:
    """The entries the PDF's contents must list, from the .docx alone: those build-docs-docx.py
    cached in its one TOC field, which must list levels 1-TOC_DEPTH, cache at least one entry, and
    cache one per Heading1 … Heading(TOC_DEPTH) paragraph."""
    try:
        with zipfile.ZipFile(docx) as z:
            xml = z.read("word/document.xml").decode("utf-8")
    except (OSError, zipfile.BadZipFile, KeyError, UnicodeDecodeError) as e:
        raise RenderError(f"{docx}: not a readable .docx ({e})") from None
    instructions = list(TOC_INSTRUCTION.finditer(xml))
    if len(instructions) != 1:
        raise RenderError(f"{docx}: {len(instructions)} table-of-contents fields, not 1 — nothing to check the PDF's contents against")
    depth = int(instructions[0].group(1))
    if depth != TOC_DEPTH:
        raise RenderError(f"{docx}: the table-of-contents field lists levels 1-{depth}, not 1-{TOC_DEPTH}")
    result = field_result(xml, instructions[0].end())
    if result is None:
        raise RenderError(f"{docx}: the table-of-contents field has no separator or no end")
    cached = len(CACHED_ENTRY.findall(result))
    if cached == 0:
        raise RenderError(f"{docx}: the table-of-contents field caches no entries (build-docs-docx.py writes one per "
                          f"level-1 and level-2 heading) — nothing to check the PDF's contents against")
    headings = sum(1 for level in HEADING_STYLE.findall(xml) if 1 <= int(level) <= TOC_DEPTH)
    if headings != cached:
        raise RenderError(f"{docx}: the table-of-contents field caches {cached} entries and the document has {headings} "
                          f"level-1 and level-2 headings — not a .docx as build-docs-docx.py writes it")
    return cached


def paged_entries(report: str) -> list[int]:
    """The page numbers of the report's table-of-contents entries that end in one, in order."""
    pages: list[int] = []
    inside = False
    for line in report.splitlines():
        if not inside:
            inside = line == "contents"
        elif line == "end":
            inside = False
        else:
            m = PAGED_ENTRY.fullmatch(line)
            if m:
                pages.append(int(m.group(1)))
    return pages


def register_module(profile: Path, first_start: int) -> None:
    """Write the module into the profile's Standard library and list it in script.xlb. The profile
    must already exist: LibreOffice's first start would rewrite script.xlb."""
    standard = profile / "user" / "basic" / "Standard"
    xlb = standard / "script.xlb"
    if not xlb.is_file():
        raise RenderError(f"LibreOffice did not initialise its profile (its first start exited {first_start}; {xlb} is missing) — the conversion macro cannot be registered")
    text = xlb.read_text(encoding="utf-8")
    if "</library:library>" not in text:
        raise RenderError(f"{xlb}: no </library:library> to register the conversion macro before")
    (standard / f"{MODULE}.xba").write_text(MACRO, encoding="utf-8")
    entry = f' <library:element library:name="{MODULE}"/>\n'
    xlb.write_text(text.replace("</library:library>", entry + "</library:library>", 1), encoding="utf-8")


def signal_group(proc: subprocess.Popen, sig: int) -> None:
    try:
        os.killpg(proc.pid, sig)
    except (ProcessLookupError, PermissionError):
        pass


def stop_group(proc: subprocess.Popen) -> None:
    """End LibreOffice's process group: SIGTERM while it runs, SIGKILL after GRACE_SECONDS, and
    SIGKILL to whatever is left of the group even when LibreOffice exited by itself."""
    if proc.poll() is None:
        signal_group(proc, signal.SIGTERM)
        try:
            proc.wait(timeout=GRACE_SECONDS)
        except subprocess.TimeoutExpired:
            pass
    signal_group(proc, signal.SIGKILL)
    proc.wait()


def run_libreoffice(binary: str, work: Path, deadline: Deadline, doing: str, *args: str) -> tuple[int, str]:
    """One LibreOffice run on the work directory's profile and TMPDIR, in a process group of its
    own, which stop_group ends on the way out whatever happened. Still running at the deadline: it
    is stopped, and the run fails."""
    PROGRESS.doing = f"LibreOffice was {doing}"
    proc = subprocess.Popen(
        [binary, "--headless", "--norestore", f"-env:UserInstallation={(work / 'profile').as_uri()}", *args],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True,
        env=dict(os.environ, TMPDIR=str(work / "tmp")))
    try:
        try:
            out, _ = proc.communicate(timeout=deadline.left())
        except subprocess.TimeoutExpired:
            stop_group(proc)
            try:
                out, _ = proc.communicate(timeout=GRACE_SECONDS)
            except subprocess.TimeoutExpired:
                out = b""
            raise RenderError(f"LibreOffice was still {doing} when its {deadline.seconds} s (--deadline) ran out; it was stopped",
                              out.decode("utf-8", "replace")) from None
    finally:
        stop_group(proc)
    return proc.returncode, out.decode("utf-8", "replace")


def render(binary: str, docx: Path, output: Path, work: Path, seconds: int) -> str:
    """Render and check; the checked PDF is moved to `output`. Returns the summary line."""
    expected = expected_entries(docx)
    source = work / "docx" / docx.name
    pdf = work / "out.pdf"
    report = work / "report.txt"
    source.parent.mkdir()
    (work / "tmp").mkdir()
    shutil.copyfile(docx, source)
    deadline = Deadline(seconds)
    first_start, _ = run_libreoffice(binary, work, deadline, "making its profile (its first start)", "--terminate_after_init")
    register_module(work / "profile", first_start)
    macro = f'macro:///Standard.{MODULE}.Convert("{source.as_uri()}","{pdf.as_uri()}","{report.as_uri()}")'
    code, log = run_libreoffice(binary, work, deadline, "converting the .docx", macro)
    PROGRESS.doing = "checking the PDF"
    if not report.is_file():
        raise RenderError(f"the conversion macro did not run (LibreOffice exited {code} and wrote no report)", log)
    text = report.read_text(encoding="utf-8", errors="replace")
    if text.startswith("error "):
        raise RenderError(f"the conversion macro failed: {text[len('error '):].strip()}", log)
    if not pdf.is_file() or pdf.stat().st_size == 0:
        raise RenderError("LibreOffice wrote no PDF, or an empty one", log)
    with pdf.open("rb") as f:
        if f.read(5) != b"%PDF-":
            raise RenderError("LibreOffice wrote a file that is not a PDF", log)
    pages = paged_entries(text)
    if len(pages) != expected:
        raise RenderError(
            f"the PDF's contents lists {len(pages)} entries with a page number; the document has {expected} "
            f"headings its contents must list")
    for i in range(1, len(pages)):
        if pages[i] < pages[i - 1]:
            raise RenderError(f"the PDF's contents goes back from page {pages[i - 1]} to page {pages[i]} at entry {i + 1} — "
                              f"its pages were not laid out")
    if len(pages) > 1 and pages[-1] <= pages[0]:
        raise RenderError(f"the PDF's contents names page {pages[0]} for its first entry and page {pages[-1]} for its last — "
                          f"its pages were not laid out")
    staged = output.with_name(f".{output.name}.partial")
    try:
        shutil.copyfile(pdf, staged)
        os.replace(staged, output)
    finally:
        staged.unlink(missing_ok=True)
    return (f"wrote {output} ({output.stat().st_size:,} bytes): the contents lists {len(pages)} entries, "
            f"each with its page number (pages {pages[0]} to {pages[-1]})")


def stop(signum, _frame):
    """SIGTERM (the caller's `timeout`) or SIGINT: one line, then unwind, so the finally blocks
    stop LibreOffice and remove the work directory. A second signal is ignored: it would cut them
    short (the caller's `timeout -k` still ends the run)."""
    for s in STOP_SIGNALS:
        signal.signal(s, signal.SIG_IGN)
    print(f"build-docs-pdf: stopped by {signal.Signals(signum).name} after {PROGRESS.seconds()} s, while {PROGRESS.doing}",
          file=sys.stderr)
    raise SystemExit(128 + signum)


def usage(message: str) -> int:
    print(f"build-docs-pdf: {message}", file=sys.stderr)
    return 2


def seconds_arg(text: str) -> int:
    value = int(text)
    if value <= 0:
        raise argparse.ArgumentTypeError(f"{text}: not a positive number of seconds")
    return value


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Render the documentation .docx to a .pdf with its contents updated")
    ap.add_argument("docx", help="the .docx build-docs-docx.py wrote")
    ap.add_argument("--output", default=None, help="the PDF (default: beside the .docx, with a .pdf suffix)")
    ap.add_argument("--deadline", type=seconds_arg, default=DEADLINE_SECONDS, metavar="SECONDS",
                    help=f"LibreOffice's time in all; past it the run stops it and fails (default {DEADLINE_SECONDS})")
    args = ap.parse_args(argv)
    for s in STOP_SIGNALS:
        signal.signal(s, stop)

    docx = Path(args.docx).resolve()
    output = Path(args.output).resolve() if args.output else docx.with_suffix(".pdf")
    if output == docx:
        return usage(f"{output}: the PDF would replace the .docx")
    if not output.parent.is_dir():
        return usage(f"{output.parent}: no such directory for the PDF")
    # a PDF left by an earlier run must not pass for this one's, whatever this run's exit from here
    try:
        output.unlink(missing_ok=True)
    except OSError as e:
        return usage(f"{output}: the PDF already there cannot be removed ({e.strerror or e})")
    if not docx.is_file():
        return usage(f"{docx}: no such file")
    binary = find_libreoffice()
    if binary is None:
        return usage("neither libreoffice nor soffice is on PATH (CI installs libreoffice-writer)")

    work = Path(tempfile.mkdtemp(prefix="docs-pdf-"))
    try:
        print(render(binary, docx, output, work, args.deadline))
        return 0
    except (RenderError, OSError) as e:
        print(f"build-docs-pdf: {e}", file=sys.stderr)
        for line in getattr(e, "log", "").strip().splitlines()[-LOG_TAIL:]:
            print(f"libreoffice: {line}", file=sys.stderr)
        return 1
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
