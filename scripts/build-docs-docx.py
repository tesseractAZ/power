#!/usr/bin/env python3
"""
build-docs-docx.py — assemble the project's Markdown docs into one printable
Microsoft Word (.docx) file.

Used two ways:
  * CI (.github/workflows/ci.yml)      — build on every PR, upload as an artifact
    so a DOCS.md that no longer converts cleanly fails the PR instead of the
    release.
  * Release (.github/workflows/images.yml) — build at the tagged ref and attach
    to the GitHub Release, so every published version carries an always-current,
    offline-printable manual.

It concatenates, in reading order:
    README.md            (the tour)
    SECURITY.md          (reporting + posture)
    ecoflow_panel/DOCS.md (the full engine reference)
with a hard page break between each, strips DOCS.md's hand-maintained
"## Table of Contents" (Pandoc's generated Word TOC is the single source of
navigation), and runs Pandoc with a title block + depth-2 TOC.

Pandoc notes:
  * `-f markdown` (NOT `gfm`) so the `{=openxml}` raw blocks that carry the
    Word page breaks pass through verbatim — the `raw_attribute` extension is
    off in strict GFM. `+task_lists` keeps `- [ ]` checkboxes rendering as
    checkboxes rather than literal brackets. `+gfm_auto_identifiers` gives
    headings GitHub-style ids so the README's cross-references (written as
    GitHub anchors) resolve as internal links once `internalize_links()` has
    stripped their in-repo path prefixes.
  * The visible title-block "date" is the version + source ref rather than a
    wall-clock timestamp, so the human-facing header is stable across rebuilds.
    (The file is not byte-for-byte reproducible: Pandoc still writes real
    creation/modification timestamps into docProps/core.xml.)

Requires the `pandoc` binary on PATH (CI installs it; `brew install pandoc`
locally).
"""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
from pathlib import Path

TITLE = "Power (ecoflow-panel) — Complete Documentation"
SUBTITLE_TMPL = "EcoFlow off-grid monitoring, forecasting & life-safety alarm — v{version}"

# A Word hard page break, expressed as a Pandoc raw-openxml block.
PAGE_BREAK = '\n\n```{=openxml}\n<w:p><w:r><w:br w:type="page"/></w:r></w:p>\n```\n\n'


def read_version(repo_root: Path) -> str:
    """Parse the add-on version from ecoflow_panel/config.yaml (same regex the
    release workflows use)."""
    cfg = (repo_root / "ecoflow_panel" / "config.yaml").read_text(encoding="utf-8")
    m = re.search(r'^version:\s*"?([^"#\s]+)"?', cfg, re.M)
    if not m:
        raise SystemExit("could not parse version from ecoflow_panel/config.yaml")
    return m.group(1)


def strip_manual_toc(docs: str) -> str:
    """Remove DOCS.md's hand-maintained '## Table of Contents' block so it does
    not duplicate Pandoc's generated one. Cuts from that heading up to the first
    numbered chapter heading ('## 1. ...'); title-agnostic so it survives
    chapter renames. If either anchor is missing, leaves the text untouched."""
    m_toc = re.search(r'^## Table of Contents\b', docs, re.M)
    m_ch1 = re.search(r'^## \d+\.\s', docs, re.M)
    if m_toc and m_ch1 and m_ch1.start() > m_toc.start():
        return docs[: m_toc.start()].rstrip() + "\n\n" + docs[m_ch1.start():]
    return docs


def internalize_links(md: str) -> str:
    """Rewrite in-repo cross-file Markdown links so the *merged* document links
    within itself instead of at relative paths that don't exist next to the
    distributed .docx.

    Two cases:
      * `](ecoflow_panel/DOCS.md#anchor)` / `](SECURITY.md#anchor)` — strip the
        path prefix so the link becomes an internal `](#anchor)`. Combined with
        Pandoc's `gfm_auto_identifiers`, these resolve to the matching heading.
      * whole-file links (no anchor) and the link to DOCS.md's stripped manual
        `#table-of-contents` — those targets don't survive into the merged doc,
        so demote them to plain text rather than advertise a dead link. The
        Word TOC Pandoc generates (with page numbers) is the real navigation.

    Operates on raw Markdown text (fence-unaware): it assumes the in-repo
    cross-file link forms above appear only in prose, never inside a fenced
    code block. That holds for these three docs (the README/SECURITY/DOCS
    corpus documents no literal Markdown links in code samples); if that ever
    changes, scope the substitutions to non-fenced regions.
    """
    # Demote links whose target does not survive the merge (do this BEFORE the
    # generic prefix-strip, which would otherwise turn them into bare anchors).
    md = re.sub(r'\[([^\]]+)\]\(ecoflow_panel/DOCS\.md#table-of-contents\)', r'\1', md)
    md = re.sub(r'\[([^\]]+)\]\(ecoflow_panel/DOCS\.md\)', r'\1', md)
    md = re.sub(r'\[([^\]]+)\]\(SECURITY\.md\)', r'\1', md)
    md = re.sub(r'\[([^\]]+)\]\(README\.md\)', r'\1', md)
    # Remaining cross-file links → internal anchors.
    md = md.replace('](ecoflow_panel/DOCS.md#', '](#')
    md = md.replace('](SECURITY.md#', '](#')
    return md


def assemble(repo_root: Path) -> str:
    readme = (repo_root / "README.md").read_text(encoding="utf-8").strip()
    security = (repo_root / "SECURITY.md").read_text(encoding="utf-8").strip()
    docs = strip_manual_toc((repo_root / "ecoflow_panel" / "DOCS.md").read_text(encoding="utf-8").strip())
    return internalize_links(readme + PAGE_BREAK + security + PAGE_BREAK + docs)


def main() -> int:
    ap = argparse.ArgumentParser(description="Assemble project docs into a .docx")
    ap.add_argument("--repo-root", default=None,
                    help="repo root (default: parent of this script's dir)")
    ap.add_argument("--version", default=None,
                    help="version string for title/filename (default: read from config.yaml)")
    ap.add_argument("--ref", default="local",
                    help="source ref/SHA to stamp into the title block")
    ap.add_argument("--output", default=None,
                    help="output .docx path (default: EcoFlow-Panel-Documentation-v<version>.docx in CWD)")
    args = ap.parse_args()

    if not shutil.which("pandoc"):
        print("error: pandoc not found on PATH (CI installs it; locally: brew install pandoc)",
              file=sys.stderr)
        return 2

    repo_root = Path(args.repo_root).resolve() if args.repo_root \
        else Path(__file__).resolve().parent.parent
    version = args.version or read_version(repo_root)
    output = Path(args.output).resolve() if args.output \
        else Path.cwd() / f"EcoFlow-Panel-Documentation-v{version}.docx"

    combined = assemble(repo_root)
    combined_path = output.with_suffix(".combined.md")
    combined_path.write_text(combined, encoding="utf-8")

    cmd = [
        "pandoc", str(combined_path), "-o", str(output),
        "-f", "markdown+task_lists+gfm_auto_identifiers",
        "--standalone", "--toc", "--toc-depth=2",
        "--metadata", f"title={TITLE}",
        "--metadata", f"subtitle={SUBTITLE_TMPL.format(version=version)}",
        "--metadata", f"date=Version {version} · source ref {args.ref}",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    # Clean up the intermediate regardless of outcome.
    combined_path.unlink(missing_ok=True)

    if proc.returncode != 0:
        sys.stderr.write(proc.stderr)
        return proc.returncode
    if proc.stderr.strip():
        # Pandoc warnings are non-fatal but worth surfacing in the CI log.
        sys.stderr.write(proc.stderr)

    size = output.stat().st_size
    print(f"wrote {output} ({size:,} bytes) — v{version} @ {args.ref}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
