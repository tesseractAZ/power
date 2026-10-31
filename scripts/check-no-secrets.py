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

This file is public, so it holds SHAPE rules only. A detector that lists the
values it guards publishes them: an earlier version of this file carried the
home subnets, a surname, an email local part and the VoIP number as patterns.
Those concrete values now live outside the repository, in an optional private
pattern file (see PRIVATE_PATTERNS_ENV) and in a maintainer-side pre-push gate.

Flagged by shape:
  * Addresses in 192.168.0.0/16 outside the example subnets 192.168.0.x and
    192.168.1.x. Residential routers hand out this range, so any other third
    octet is treated as a real LAN (see LAN_EXAMPLE_THIRD_OCTETS).
  * Email-shaped tokens outside the documentation, placeholder and public
    project domains (see EMAIL_ALLOWED_DOMAINS and EMAIL_ALLOWED_TLDS).
  * Phone numbers (NANP with separators, or +1 E.164) outside the fictional
    555-0100 to 555-0199 range, and voip.ms credential shapes.
  * EcoFlow device serial SHAPES that are not placeholders (see SERIAL_SHAPE).
    This rule also scans this file, which holds no real serial.
Flagged by value, only where the private pattern file is configured:
  * Every entry of that file. A hit prints file:line and the entry's label,
    never the matched text. CI has no such file and runs the shape rules alone.

Every rule scans every tracked text file, this one included. No rule echoes
the text it matched, so a CI log cannot republish what the check found.

`--stdin` (v1.193.0) applies the same rules to text on standard input instead
of the tree: the README screenshot tool pipes the text of each page it renders
through it, because a tracked image is a file this scan cannot read. With no
flag (CI's run) the behaviour is unchanged.

Deliberately NOT flagged, because they are legitimate and appear at HEAD today:
  * 172.30.32.0/23 — the Home Assistant Supervisor hassio-network. Public,
    product-documented, and load-bearing in the ingress-source pin
    (server/src/auth.ts). Flagging it would make this gate un-passable.
  * 192.168.1.x, 10.0.0.x, 172.16.5.5 — placeholder/fixture addresses, including
    the sanitised replacements installed by the earlier hygiene passes. Only
    192.168.0.0/16 is checked: 10.0.0.0/8 and 172.16.0.0/12 hold the container
    and Supervisor networks that the tests exercise.
  * 33.4484 / -112.074 — the Phoenix city-centre geocode shipped as the
    FORECAST_LAT/LON default. A city centroid is not a residence.

Keep that distinction. A checker that cries wolf gets disabled, and a disabled
checker is how this happens a third time.
"""
from __future__ import annotations

import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# ── shape rules ──────────────────────────────────────────────────────────────
# None of these names a real value: each describes a SHAPE, and the allowlists
# hold only documentation, placeholder and public-project forms.

# 192.168.N.* with N outside the factory-default example subnets.
LAN_SHAPE = re.compile(r"(?<![\d.])192\.168\.(\d{1,3})(?!\d)")
LAN_EXAMPLE_THIRD_OCTETS = frozenset({0, 1})

EMAIL_SHAPE = re.compile(
    r"(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})(?![A-Za-z0-9-])")
# A domain is allowed when it equals one of these or is a subdomain of one.
EMAIL_ALLOWED_DOMAINS = (
    "example.com", "example.org", "example.net",  # RFC 2606 documentation domains
    "github.com",                                  # GitHub noreply and git@ SSH identities
    "home-assistant.io",                           # upstream identities, e.g. the base-image signer
)
EMAIL_ALLOWED_TLDS = frozenset({"example", "invalid", "test", "localhost", "local", "internal", "lan", "arpa"})

# NANP numbers: (NXX) NXX-XXXX, NXX-NXX-XXXX (any of space . -), optional +1 / 1
# prefix, or +1NXXNXXXXXX. Exchange 555 with a line number of 01xx is the
# fictional range set aside for examples and is never flagged.
PHONE_SHAPE = re.compile(
    r"(?<![\w.+-])(?:\+?1[\s.-]?)?(?:\(([2-9]\d{2})\)\s?|([2-9]\d{2})[\s.-])([2-9]\d{2})[\s.-](\d{4})(?!\w)"
    r"|(?<![\w+])\+1([2-9]\d{2})([2-9]\d{2})(\d{4})(?!\d)")


def email_allowed(domain: str) -> bool:
    d = domain.lower()
    return d.rsplit(".", 1)[-1] in EMAIL_ALLOWED_TLDS or any(d == a or d.endswith("." + a) for a in EMAIL_ALLOWED_DOMAINS)


def phone_is_fictional(m: re.Match[str]) -> bool:
    exchange = m.group(3) or m.group(6)
    line = m.group(4) or m.group(7)
    return exchange == "555" and line.startswith("01")


# (regex, human-readable reason) — rules with no allowlist.
PATTERNS: list[tuple[re.Pattern[str], str]] = [
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


def line_problems(line: str) -> list[tuple[int, str]]:
    """(1-based column, reason) for every shape hit on one line."""
    out: list[tuple[int, str]] = []
    for m in LAN_SHAPE.finditer(line):
        if int(m.group(1)) not in LAN_EXAMPLE_THIRD_OCTETS:
            out.append((m.start() + 1, "a private LAN address outside the example subnets — use 192.168.1.x"))
    for m in EMAIL_SHAPE.finditer(line):
        if not email_allowed(m.group(1)):
            out.append((m.start() + 1, "an email address — use an example.com address or the GitHub noreply address"))
    for m in PHONE_SHAPE.finditer(line):
        if not phone_is_fictional(m):
            out.append((m.start() + 1, "a phone number — use the fictional 555-0100 to 555-0199 range"))
    for pat, why in PATTERNS:
        m = pat.search(line)
        if m:
            out.append((m.start() + 1, why))
    return out


def shape_self_test() -> None:
    """Each shape rule must fire on a seeded sample and stay quiet on its placeholders."""
    lan = "192.168." + "7.20"
    mail = "jane.doe" + "@" + "mailhost.co"
    phone = "-".join(["602", "555", "02" + "87"])
    e164 = "+1" + "602555" + "0287"

    def fires(s: str) -> int:
        return len(line_problems(s))

    ok = (
        fires(f"gw {lan};") == 1 and fires(f"to {mail}.") == 1
        and fires(f"tel {phone}") == 1 and fires(f"sip:{e164}") == 1
        and fires("192.168.1.20 192.168.0.1 10.0.0.5 172.30.32.1") == 0
        and fires("a@example.com x@users.noreply.github.com t@x.invalid") == 0
        and fires("602-555-0142 (602) 555-0199 2026-10-17 v1.188.0") == 0
    )
    if not ok:
        raise SystemExit("check-no-secrets: shape self-test FAILED; refusing to report clean")


# ── value rules (optional, owner-side) ───────────────────────────────────────
# The concrete values (home subnets, personal addresses, phone numbers) stay
# OUT of this public file. Point PRIVATE_PATTERNS_ENV at a private JSON list of
# {"why": label, "re": Python regex, "probe": a sample it must match} entries,
# chmod 600, or keep that list as the gitignored PRIVATE_PATTERNS_LOCAL at the
# repository root. Patterns match case-insensitively. CI sets neither.
PRIVATE_PATTERNS_ENV = "CHECK_NO_SECRETS_PRIVATE_PATTERNS"
PRIVATE_PATTERNS_LOCAL = ".no-secrets-private.json"


def load_private_rules() -> list[tuple[re.Pattern[str], str]]:
    """The private value rules, or [] when none is configured. Messages never name a value or path."""
    env = os.environ.get(PRIVATE_PATTERNS_ENV, "").strip()
    path = Path(env).expanduser() if env else ROOT / PRIVATE_PATTERNS_LOCAL
    where = PRIVATE_PATTERNS_ENV if env else PRIVATE_PATTERNS_LOCAL
    if not env and not path.exists():
        return []

    def fail(msg: str) -> SystemExit:
        return SystemExit(f"check-no-secrets: private pattern file ({where}) {msg}")

    try:
        mode = path.stat().st_mode
    except OSError:
        raise fail("is missing or unreadable")
    if os.name == "posix" and mode & (stat.S_IRWXG | stat.S_IRWXO):
        raise fail("is readable by group/other; chmod 600 it")
    try:
        entries = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise fail("is not a JSON list")
    rules: list[tuple[re.Pattern[str], str]] = []
    for i, e in enumerate(entries if isinstance(entries, list) else [], 1):
        if not (isinstance(e, dict) and isinstance(e.get("re"), str) and e["re"]
                and isinstance(e.get("probe"), str) and e["probe"]):
            raise fail(f"entry {i} needs non-empty 're' and 'probe' strings")
        try:
            rx = re.compile(e["re"], re.I)
        except re.error:
            raise fail(f"entry {i} does not compile")
        why = str(e.get("why") or f"entry {i}")
        if not rx.search(e["probe"]):
            raise fail(f"entry {i} ({why}) does not match its own probe; refusing to report clean")
        rules.append((rx, why))
    if not rules:
        raise fail("lists no patterns; an empty list cannot detect anything")
    return rules


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


def tracked_files() -> list[str]:
    out = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True)
    return [f for f in out.stdout.splitlines() if f]


def stdin_problems(text: str, private: list[tuple[re.Pattern[str], str]]) -> list[str]:
    """v1.193.0 — the shape rules (and the private value rules) on text read from standard input.

    The tree scan below skips any file that is not UTF-8 text, so nothing in it can see inside an
    image. scripts/screenshots/capture.mts pipes the text of the page it is about to photograph
    through this mode. Every non-placeholder serial is a problem here: SERIAL_EXEMPT_COUNTS pins
    tracked files, and text on stdin is none of them. Lines are reported as <stdin>:N; no token is
    echoed beyond a serial's public model code.
    """
    out: list[str] = []
    for lineno, line in enumerate(text.split("\n"), 1):
        for m in SERIAL_SHAPE.finditer(line):
            tok = m.group(0)
            if is_serial_shaped(tok) and not is_placeholder_serial(tok):
                out.append(f"  <stdin>:{lineno}: serial-shaped token (model code {tok[:4]})")
        for col, why in line_problems(line):
            out.append(f"  <stdin>:{lineno}:{col}: {why}")
        for rx, why in private:
            if rx.search(line):
                out.append(f"  <stdin>:{lineno}: private pattern ({why})")
    return out


def main_stdin() -> int:
    serial_self_test()
    shape_self_test()
    private = load_private_rules()
    problems = stdin_problems(sys.stdin.buffer.read().decode("utf-8", errors="replace"), private)
    if problems:
        print("check-no-secrets: FAILED — personal data in the text on standard input", file=sys.stderr)
        for p in problems:
            print(p, file=sys.stderr)
    else:
        extra = f"; {len(private)} private value pattern(s)" if private else "; shape rules only"
        print(f"check-no-secrets: OK — standard input clean{extra}")
    return 1 if problems else 0


def main() -> int:
    if "--stdin" in sys.argv[1:]:
        return main_stdin()
    problems: list[str] = []
    scanned = 0

    serial_self_test()
    shape_self_test()
    private = load_private_rules()
    serials: dict[str, list[tuple[int, str]]] = {}

    for rel in tracked_files():
        path = ROOT / rel
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue  # binary or unreadable — nothing to match
        scanned += 1
        # split("\n"), not splitlines(): splitlines() also breaks on U+2028 and
        # form feeds, which shifts reported line numbers away from the editor's.
        for lineno, line in enumerate(text.split("\n"), 1):
            for m in SERIAL_SHAPE.finditer(line):
                tok = m.group(0)
                if is_serial_shaped(tok) and not is_placeholder_serial(tok):
                    serials.setdefault(rel, []).append((lineno, tok[:4]))
            for col, why in line_problems(line):
                problems.append(f"  {rel}:{lineno}:{col}: {why}")
            for rx, why in private:
                if rx.search(line):
                    problems.append(f"  {rel}:{lineno}: private pattern ({why})")

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
    extra = f"; {len(private)} private value pattern(s)" if private else "; shape rules only"
    print(f"check-no-secrets: OK — {scanned} tracked text files clean "
          f"({pinned} serial-shaped token(s) pinned in {len(SERIAL_EXEMPT_COUNTS)} file(s), pending removal{extra})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
