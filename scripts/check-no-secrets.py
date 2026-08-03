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
    (re.compile(r"voip\.?ms", re.I),
     "VoIP.ms reference — credentials or account identifiers must not be committed"),
]

# This file necessarily contains the patterns it hunts for.
SELF = Path(__file__).name


def tracked_files() -> list[str]:
    out = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True)
    return [f for f in out.stdout.splitlines() if f]


def main() -> int:
    problems: list[str] = []
    scanned = 0

    for rel in tracked_files():
        if Path(rel).name == SELF:
            continue
        path = ROOT / rel
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue  # binary or unreadable — nothing to match
        scanned += 1
        for lineno, line in enumerate(text.splitlines(), 1):
            for pat, why in PATTERNS:
                m = pat.search(line)
                if m:
                    problems.append(f"  {rel}:{lineno}: {m.group(0)!r} — {why}")

    if problems:
        print("check-no-secrets: FAILED — personal data must not reach a public repo",
              file=sys.stderr)
        for p in problems:
            print(p, file=sys.stderr)
        print("\nIf a hit is a false positive, narrow the pattern — do NOT add a blanket "
              "skip, and do NOT disable this check.", file=sys.stderr)
        return 1

    print(f"check-no-secrets: OK — {scanned} tracked text files clean")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
