#!/usr/bin/env python3
"""Fail CI if a home-network address or personal identifier reaches a public repo.

WHY THIS EXISTS
---------------
This is the SECOND leak of personal data into this public repository.

  * Around v0.10 a real email address was filter-repo'd out of history and
    replaced with `redacted@example.com` (the scrub is still visible in commit
    subjects be05b36 / 1aa6323 and in c6ac3b0 "scrub personal info").
  * Then v0.15.0 (57243a0) introduced `maintainer: tesseractAZ <a personal
    address>` into repository.yaml — fresh, in a brand-new file. It sat there
    for 258 of the next 422 commits before v1.54.0 removed it.
  * Separately v0.72.0 / v0.91.0 / v1.47.3 published five real LAN addresses on
    the two home subnets, in DOCS.md, translations/en.yaml and a test fixture.
  * Device serial numbers belong to the same class: a realistic fixture or doc
    example copied from the hardware in front of you.

A history rewrite fixes the past exactly once. Without an automated gate the
same thing happens a third time, because the leak is never deliberate — it is
someone writing a realistic-looking example using the machine in front of them.

WHAT IT CHECKS
--------------
Only the CURRENT tracked tree (history is the rewrite's problem, not CI's).

Flagged:
  * 192.168.5.x / 192.168.6.x — the two REAL home subnets.
  * The known personal email addresses.
  * The VoIP DID in any separator format, and voip.ms credential shapes.
  * EcoFlow device serial SHAPES that are not placeholders (see SERIAL_SHAPE).
    This rule also scans this file, which holds no real serial.

Deliberately NOT flagged, because they are legitimate and appear at HEAD today:
  * 172.30.32.0/23 — the Home Assistant Supervisor hassio-network. Public,
    product-documented, and load-bearing in the ingress-source pin
    (server/src/auth.ts). Flagging it would make this gate un-passable.
  * 192.168.1.x, 10.0.0.x, 172.16.5.5 — placeholder/fixture addresses, including
    the sanitised replacements installed by the earlier hygiene passes.
  * 33.4484 / -112.074 — the Phoenix city-centre geocode shipped as the
    FORECAST_LAT/LON default. A city centroid is not a residence.

Keep that distinction. A checker that cries wolf gets disabled, and a disabled
checker is how this happens a third time.
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# (regex, human-readable reason)
PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"192\.168\.[56]\.\d{1,3}"),
     "real home LAN subnet (192.168.5.x / 192.168.6.x) — use 192.168.1.x for examples"),
    (re.compile(r"\b[A-Za-z0-9._%+-]*paschal[A-Za-z0-9._%+-]*@(?!users\.noreply\.github\.com)"
                r"[A-Za-z0-9.-]+\.[A-Za-z]{2,}", re.I),
     "personal email address — use the GitHub profile URL or the noreply address"),
    (re.compile(r"\bphs-az@", re.I),
     "personal email address"),
    (re.compile(r"\+?1?[\s.\-()]*520[\s.\-()]*485[\s.\-()]*5554"),
     "the VoIP DID"),
    # NB: matches CREDENTIALS, not the bare service name. The first version of
    # this rule flagged any occurrence of "voip.ms" and immediately failed CI on
    # the CHANGELOG entry describing this very script. Prose naming the provider
    # is fine; an account identifier or a secret next to it is not.
    (re.compile(r"[\w.-]+:[^\s@/]{3,}@[\w.-]*voip\.?ms", re.I),
     "VoIP.ms credentials embedded in a URI"),
    (re.compile(r"voip\.?ms[^\n]{0,60}?(?:pass(?:word|wd)?|secret|api[_-]?key|auth[_-]?token)\s*[:=]\s*\S",
                re.I),
     "a secret assigned next to a VoIP.ms reference"),
    (re.compile(r"(?:pass(?:word|wd)?|secret|api[_-]?key|auth[_-]?token)\s*[:=]\s*\S[^\n]{0,60}?voip\.?ms",
                re.I),
     "a secret assigned next to a VoIP.ms reference"),
    # The sub-account half must contain a LETTER. Without that this collides with
    # JavaScript numeric separators — `172800_000` (172.8 M ms) in battery.test.ts
    # matched a digits-only version of this rule.
    (re.compile(r"\b\d{6}_(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{2,}\b"),
     "a VoIP.ms sub-account identifier (<account>_<subaccount>)"),
]

# EcoFlow device serials. A serial is 16 uppercase alphanumerics: a public
# 4-character model code (Y711, HD31, ...) and a 12-character identifier that
# names one physical unit.
#
# The rule is SHAPE-based and lists no real serial, on purpose: a detector in a
# public repo must not contain what it guards. The concrete values, their
# lowercase entity-id forms and their partial tails are checked by a private
# pre-push gate that is not part of this repository.
#
# Placeholders keep the model code and the letter/digit shape, with every letter
# as X and every digit as 0 except a two-digit index, e.g. Y711XXX00XXX0015. The
# older TEST... and DEADBEEF... fixture forms are accepted too.
SERIAL_SHAPE = re.compile(r"(?<![A-Za-z0-9])[A-Z0-9]{16}(?![A-Za-z0-9])")
PLACEHOLDER_TAIL = re.compile(r"[X0]{10}[0-9]{2}")

# OPEN: these runtime sites still hold device serials, because replacing them
# changes live behaviour (the bench-spare alarm mute, a shipped device alias, an
# API default). They await a policy decision. Each count is pinned EXACTLY: a
# new serial in the file fails, and so does fixing the site without deleting its
# entry here.
SERIAL_EXEMPT_COUNTS: dict[str, int] = {
    "server/device-aliases.json": 1,
    "server/src/index.ts": 1,
    "server/src/shp2Membership.ts": 2,
}


def is_serial_shaped(tok: str) -> bool:
    return any(c.isalpha() for c in tok) and any(c.isdigit() for c in tok)


def is_placeholder_serial(tok: str) -> bool:
    return bool(PLACEHOLDER_TAIL.fullmatch(tok[4:])) or tok.startswith(("TEST", "DEADBEEF"))


def serial_self_test() -> None:
    """A detector that cannot fire reports "clean" forever, so prove it fires first."""
    synthetic = "Y711ABC12" "DEF3456"  # split so this file does not match itself
    ok = (
        [m.group(0) for m in SERIAL_SHAPE.finditer(f"id={synthetic};")] == [synthetic]
        and is_serial_shaped(synthetic)
        and not is_placeholder_serial(synthetic)
        and is_placeholder_serial("Y711XXX00XXX0015")
        and not SERIAL_SHAPE.search(synthetic + "7")
    )
    if not ok:
        raise SystemExit("check-no-secrets: serial detector self-test FAILED; refusing to report clean")


def serial_problems(found: dict[str, list[tuple[int, str]]]) -> list[str]:
    out: list[str] = []
    for rel in sorted(set(found) | set(SERIAL_EXEMPT_COUNTS)):
        hits = found.get(rel, [])
        pinned = SERIAL_EXEMPT_COUNTS.get(rel, 0)
        if len(hits) == pinned:
            continue
        if len(hits) < pinned:
            out.append(f"  {rel}: {len(hits)} serial-shaped token(s) where SERIAL_EXEMPT_COUNTS pins "
                       f"{pinned}; the site changed, so update or delete its entry")
            continue
        # Never echo the token: the model code is public, the rest identifies a unit.
        for lineno, model in hits:
            out.append(f"  {rel}:{lineno}: serial-shaped token (model code {model}); "
                       f"use a placeholder such as {model}XXX00XXX0001")
    return out


# This file necessarily contains the patterns it hunts for.
SELF = Path(__file__).name


def tracked_files() -> list[str]:
    out = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True)
    return [f for f in out.stdout.splitlines() if f]


def main() -> int:
    problems: list[str] = []
    scanned = 0

    serial_self_test()
    serials: dict[str, list[tuple[int, str]]] = {}

    for rel in tracked_files():
        path = ROOT / rel
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue  # binary or unreadable — nothing to match
        scanned += 1
        is_self = Path(rel).name == SELF
        # split("\n"), not splitlines(): splitlines() also breaks on U+2028 and
        # form feeds, which shifts reported line numbers away from the editor's.
        for lineno, line in enumerate(text.split("\n"), 1):
            for m in SERIAL_SHAPE.finditer(line):
                tok = m.group(0)
                if is_serial_shaped(tok) and not is_placeholder_serial(tok):
                    serials.setdefault(rel, []).append((lineno, tok[:4]))
            if is_self:
                continue
            for pat, why in PATTERNS:
                m = pat.search(line)
                if m:
                    problems.append(f"  {rel}:{lineno}: {m.group(0)!r} — {why}")

    problems.extend(serial_problems(serials))

    if problems:
        print("check-no-secrets: FAILED — personal data must not reach a public repo",
              file=sys.stderr)
        for p in problems:
            print(p, file=sys.stderr)
        print("\nIf a hit is a false positive, narrow the pattern — do NOT add a blanket "
              "skip, and do NOT disable this check.", file=sys.stderr)
        return 1

    pinned = sum(SERIAL_EXEMPT_COUNTS.values())
    print(f"check-no-secrets: OK — {scanned} tracked text files clean "
          f"({pinned} serial-shaped token(s) pinned in {len(SERIAL_EXEMPT_COUNTS)} file(s), pending removal)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
