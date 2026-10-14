#!/usr/bin/env python3
"""Fail a pull request whose title and version change disagree, before it merges.

Home Assistant offers whatever `version:` ecoflow_panel/config.yaml declares on
main: Supervisor's need_update is `version != latest_version`, so a LOWER
version is offered too (a downgrade), and auto-update installs it.
`tag-release.yml` runs on every push to main and tags that version, or fails
when it cannot be published, but by then the version is already offered. This
check reports the same mistakes while the PR can still be fixed.

It compares the version before and after the merge: on a `pull_request` checkout
HEAD is GitHub's test-merge commit, HEAD^1 is main as merged against and HEAD is
main after the merge. Comparing the PR's own base and head instead would read a
branch cut before the last release as a downgrade. It fails when:

  - the version changed, but the title is not "Release v<new version>";
  - a one-commit PR whose commit subject starts "Release v" names another version, or
    names one when the version does not change: GitHub's squash default for a one-commit
    PR is the commit's subject, not the title, and tag-release.yml judges that subject;
  - the title is "Release vX", but the merge does not change the version
    (v1.130.0, PR #387, 2026-09-05: the code and CHANGELOG section landed,
    config.yaml stayed at 1.129.2, and nothing was released);
  - the new version is not strict X.Y.Z (no leading zeros, no suffix), or
    config.yaml declares `version:` more than once (this reads the first line,
    a YAML loader keeps the last);
  - the new version is not above the old one (a downgrade), is already tagged
    (a Release tag cannot be reused), or is below the highest vX.Y.Z tag;
  - ecoflow_panel/CHANGELOG.md has no `## X.Y.Z` section, matched with the
    exact regex images.yml extracts the Release notes with, so a heading this
    accepts cannot fail the publish after the tag exists. That regex also
    accepts `## vX.Y.Z`, but the heading to write is the bare version:
    server/test/changelogSize.test.ts fails any other, because Home Assistant's
    update dialog shows only the new notes when the heading is exactly the
    version (v1.187.22).

A PR that changes no version passes when neither its title nor (for a one-commit
PR) its commit's subject is a release subject. A rebase merge lands every commit's
own subject; this check does not read those (main is squash-merged).

It fails closed when HEAD is not a merge commit (a shallow or non-merge
checkout). Set BASE_REV to compare against another revision instead: release.yml
runs it with BASE_REV=origin/main before it opens its PR, because CI does not
run on a PR opened with GITHUB_TOKEN; a local run can do the same.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG = "ecoflow_panel/config.yaml"
CHANGELOG = "ecoflow_panel/CHANGELOG.md"

TITLE_RE = re.compile(r"^Release v(\d+\.\d+\.\d+)\b")
SEMVER_RE = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
# The first top-level `version:` line, quoted or not (tag-release.yml reads it the same way).
VERSION_RE = re.compile(r"""^version:\s*["']?([^"'#\s]+)["']?""")


def git(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True)


def show(rev: str, path: str) -> str | None:
    r = git("show", f"{rev}:{path}")
    return r.stdout if r.returncode == 0 else None


def parse_version(text: str | None) -> str | None:
    for line in (text or "").splitlines():
        m = VERSION_RE.match(line)
        if m:
            return m.group(1)
    return None


def version_lines(text: str | None) -> int:
    return sum(1 for line in (text or "").splitlines() if line.startswith("version:"))


def key(v: str) -> tuple[int, ...]:
    return tuple(int(x) for x in v.split("."))


def released() -> list[str]:
    r = git("tag", "-l", "v*")
    if r.returncode:
        raise SystemExit(f"::error::git tag -l failed: {r.stderr.strip()}")
    return [t[1:] for t in r.stdout.split() if SEMVER_RE.match(t[1:])]


def squash_subject() -> str | None:
    """The subject a squash merge of this PR lands with when GitHub does not use the PR title.

    The repository's squash default (COMMIT_OR_PR_TITLE) takes a one-commit PR's subject from that
    commit, not from the PR title, and tag-release.yml judges the subject that lands. With more than
    one commit (or no merge commit to read the PR head from) the squash subject is the PR title.
    """
    r = git("rev-list", "--count", "HEAD^1..HEAD^2")
    if r.returncode or r.stdout.strip() != "1":
        return None
    s = git("log", "-1", "--format=%s", "HEAD^2")
    return s.stdout.strip() if s.returncode == 0 else None


def main() -> int:
    title = os.environ.get("PR_TITLE", "").strip()
    base_rev = os.environ.get("BASE_REV") or "HEAD^1"
    if not os.environ.get("BASE_REV") and git("rev-parse", "-q", "--verify", "HEAD^2").returncode:
        print(
            "::error::HEAD is not a merge commit, so there is no 'before' to compare. Run this on a "
            "pull_request checkout with fetch-depth: 0, or set BASE_REV."
        )
        return 1

    head_cfg = show("HEAD", CONFIG)
    base, new = parse_version(show(base_rev, CONFIG)), parse_version(head_cfg)
    m = TITLE_RE.match(title)
    title_v = m.group(1) if m else None
    subject = squash_subject()
    sm = TITLE_RE.match(subject or "")
    subject_v = sm.group(1) if sm else None
    changed = base != new

    if not changed and title_v is None and subject_v is None:
        print(f"version unchanged ({new!r}) and not a release title — nothing to check")
        return 0

    failures: list[str] = []
    if not changed:
        if title_v is not None:
            failures.append(
                f"titled 'Release v{title_v}', but config.yaml's version is {new!r} before and after "
                f"this merge.\n    Merging it releases nothing. Bump `version:` in {CONFIG}, or retitle the PR."
            )
        if subject_v is not None:
            failures.append(
                f"this PR's one commit is '{subject}', and a squash merge of a one-commit PR lands with "
                f"that subject, not the PR title.\n    tag-release.yml would report a release of "
                f"v{subject_v} that changes no version ({new!r}). Reword the commit."
            )
    elif new is None or not SEMVER_RE.match(new):
        failures.append(
            f"{CONFIG} declares version {new!r}, which is not X.Y.Z (no leading zeros, no suffix).\n"
            f"    Home Assistant would offer it, but tag-release.yml cannot tag or publish it."
        )
    else:
        if version_lines(head_cfg) != 1:
            failures.append(
                f"{CONFIG} has {version_lines(head_cfg)} top-level `version:` lines; this check and "
                f"tag-release.yml read the first, a YAML loader keeps the last."
            )
        if base and SEMVER_RE.match(base) and key(new) <= key(base):
            failures.append(
                f"the version goes from {base} to {new}. Home Assistant offers any version that "
                f"differs from the installed one, so this is a downgrade offered to every install."
            )
        tags = released()
        if not tags:
            failures.append("no vX.Y.Z tags are visible, so reuse and the floor cannot be checked; fetch the tags (fetch-depth: 0).")
        if new in tags:
            failures.append(f"v{new} is already tagged. A Release tag cannot be reused: pick a version above it.")
        top = max(tags, key=key, default=None)
        if top and key(new) < key(top):
            failures.append(f"{new} is below the highest release tag, v{top}.")
        if title_v != new:
            failures.append(f"this PR changes the version to {new}; title it 'Release v{new} — …'.")
        if subject_v is not None and subject_v != new:
            failures.append(
                f"this PR's one commit is '{subject}', and a squash merge of a one-commit PR lands with "
                f"that subject, not the PR title.\n    It names v{subject_v} while config.yaml says {new}; "
                f"reword the commit to 'Release v{new} …'."
            )
        notes = show("HEAD", CHANGELOG) or ""
        if not re.search(rf"^## v?{re.escape(new)}\b", notes, re.MULTILINE):
            failures.append(
                f"{CHANGELOG} has no '## {new}' section.\n"
                f"    images.yml extracts the GitHub Release notes from that heading and fails "
                f"without it, after the tag has already been created. Write the bare version "
                f"(no 'v', no date): Home Assistant's update dialog needs it exactly."
            )

    if failures:
        print("Release PR check FAILED:\n")
        for f in failures:
            print(f"  - {f}\n")
        return 1

    print(f"Release PR check OK — {base} -> {new}, titled and documented.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
