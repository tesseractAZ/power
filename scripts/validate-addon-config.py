#!/usr/bin/env python3
"""Validate the add-on manifest against its translation file.

WHY THIS EXISTS
---------------
Home Assistant renders the Configuration page's labels and help text from
`ecoflow_panel/translations/en.yaml`. If that file fails to parse, HA does not
error visibly — it silently renders the page with NO descriptions at all, for
every option. There is no log line the operator would notice.

That happened: a description written as an unquoted YAML scalar contained a
colon-space (`... works: switching ...`), which terminates a plain scalar and
made the whole document invalid. Every config description was blank for a week
before anyone looked at the page. A second instance was introduced later by an
edit that inserted an apostrophe into a single-quoted scalar without doubling it.

Neither was caught by `tsc`, by the 1,756-test suite, or by the Dockerfile smoke
build — none of them parse this file. Hence this check, wired into CI so it runs
on every pull request.

Checks:
  1. both YAML files parse
  2. every key in config.yaml `options:` has a translation entry, and vice versa
  3. every translation entry has a non-empty `name` and `description`
"""
from __future__ import annotations

import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    sys.exit("validate-addon-config: PyYAML is required (pip install pyyaml)")

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "ecoflow_panel" / "config.yaml"
TRANS = ROOT / "ecoflow_panel" / "translations" / "en.yaml"


def load(path: Path) -> dict:
    try:
        with path.open(encoding="utf-8") as fh:
            data = yaml.safe_load(fh)
    except yaml.YAMLError as exc:
        # The message carries line/column — surface it verbatim; that is the
        # single most useful thing when a scalar quoting slip breaks the file.
        sys.exit(f"validate-addon-config: {path.relative_to(ROOT)} does not parse\n{exc}")
    if not isinstance(data, dict):
        sys.exit(f"validate-addon-config: {path.relative_to(ROOT)} is not a mapping")
    return data


def main() -> int:
    cfg = load(CONFIG)
    trans = load(TRANS)

    options = cfg.get("options") or {}
    entries = trans.get("configuration") or {}
    problems: list[str] = []

    missing = sorted(set(options) - set(entries))
    orphan = sorted(set(entries) - set(options))
    if missing:
        problems.append(
            "options with no translation (HA shows the raw KEY as the label): "
            + ", ".join(missing)
        )
    if orphan:
        problems.append(
            "translations for options that no longer exist (dead text): " + ", ".join(orphan)
        )

    for key in sorted(entries):
        entry = entries[key] or {}
        if not str(entry.get("name") or "").strip():
            problems.append(f"{key}: missing `name`")
        if not str(entry.get("description") or "").strip():
            problems.append(f"{key}: missing `description`")

    if problems:
        print("validate-addon-config: FAILED", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        return 1

    print(f"validate-addon-config: OK — {len(options)} options, all named and described")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
