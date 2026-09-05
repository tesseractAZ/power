#!/usr/bin/env python3
"""Guard the one step the release pipeline cannot fail loudly on.

`tag-release.yml` triggers on `push` to main filtered to
`paths: ecoflow_panel/config.yaml`. A "Release vX.Y.Z" merge that forgets the
version bump therefore does not fail the workflow — it never evaluates it. No
tag, no image build, no GitHub Release, and Home Assistant keeps offering the
previous version. CI on main goes green because everything that ran did pass.

That happened to v1.130.0 (PR #387, 2026-09-05): the code and the CHANGELOG
section landed, `config.yaml` stayed at 1.129.2, and the release simply did not
exist until it was noticed by reading `version_latest` off the supervisor.

This check runs on pull requests whose title starts with "Release v" and asserts
the two things the pipeline will silently assume:

  1. `ecoflow_panel/config.yaml` declares exactly the version in the title.
  2. `ecoflow_panel/CHANGELOG.md` has a `## vX.Y.Z` section for it, because
     `images.yml` extracts the GitHub Release notes from that heading and a
     missing section aborts the publish AFTER the tag exists.

Non-release PRs are not the subject of this check and pass untouched.
"""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "ecoflow_panel" / "config.yaml"
CHANGELOG = ROOT / "ecoflow_panel" / "CHANGELOG.md"

TITLE_RE = re.compile(r"^Release v(\d+\.\d+\.\d+)\b")


def declared_version() -> str | None:
    for line in CONFIG.read_text(encoding="utf-8").splitlines():
        m = re.match(r'^version:\s*"?([^"#\s]+)"?', line)
        if m:
            return m.group(1)
    return None


def main() -> int:
    title = os.environ.get("PR_TITLE", "")
    m = TITLE_RE.match(title.strip())
    if not m:
        print(f"not a release PR (title: {title!r}) — nothing to check")
        return 0

    version = m.group(1)
    failures: list[str] = []

    declared = declared_version()
    if declared != version:
        failures.append(
            f"ecoflow_panel/config.yaml declares version {declared!r}, but this PR is titled "
            f"'Release v{version}'.\n"
            f"    tag-release.yml only runs when config.yaml changes, so merging this as-is "
            f"produces NO tag, NO image and NO release — silently.\n"
            f"    Fix: set `version: \"{version}\"` in ecoflow_panel/config.yaml."
        )

    heading = re.compile(rf"^##\s+v?{re.escape(version)}\b", re.MULTILINE)
    if not heading.search(CHANGELOG.read_text(encoding="utf-8")):
        failures.append(
            f"ecoflow_panel/CHANGELOG.md has no '## v{version}' section.\n"
            f"    images.yml extracts the GitHub Release notes from that heading and raises "
            f"without it — after the tag has already been created."
        )

    if failures:
        print(f"Release PR check FAILED for v{version}:\n")
        for f in failures:
            print(f"  - {f}\n")
        return 1

    print(f"Release PR check OK — v{version} is declared in config.yaml and documented in the CHANGELOG.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
