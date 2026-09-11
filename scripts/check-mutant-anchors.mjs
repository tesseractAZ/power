#!/usr/bin/env node
/**
 * v1.129.0 — anchor validation for the committed mutation harnesses.
 *
 * WHY THIS EXISTS. Every `scripts/mutate-*.mjs` pins its mutants to literal
 * source strings and ABORTS when one no longer matches exactly once. That abort
 * is correct and loud — but nothing runs the harnesses, so nobody sees it.
 *
 * `mutate-pool-membership.mjs` was dead from v1.117.0 to v1.129.0 for exactly
 * this reason: that release split a one-line ternary into three lines to insert
 * the last-known-roster tier, which orphaned four of its six anchors. The
 * harness did not fail — it stopped running, and an aborted harness reads
 * exactly like a clean one unless someone reads the output. The guarantee it
 * holds (the 2026-08-20 roster defect, which had already caused a real audible
 * incident) was uncovered that whole time.
 *
 * Running the harnesses themselves in CI is too slow — each one runs the full
 * 2000-test suite once per mutant. Validating that their ANCHORS still resolve
 * is nearly free and catches the entire failure mode: a refactor that moves the
 * code out from under a mutant now fails CI instead of silently disarming it.
 *
 * This deliberately does NOT check that mutants still get killed. It checks that
 * they can still be APPLIED. A harness whose anchors resolve can be run on
 * demand; one whose anchors do not is not a weak test, it is no test.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = join(ROOT, 'scripts');
const SERVER = join(ROOT, 'server');

/**
 * Source files a harness may target, resolved once.
 *
 * v1.146.0 — keyed on an ABSOLUTE path, and resolved against either base. This
 * checker previously understood only `resolve(SERVER, '...')`, so a harness
 * targeting anything outside `server/` was invisible to it: not "0 anchors", but
 * silently uncounted. `mutate-web-parity.mjs` targets three files under `web/`,
 * and the checker reported 5 of its 6 anchors unresolvable while the harness
 * itself ran them all cleanly.
 *
 * That is this project's own recurring defect applied to its meta-tooling — a
 * guard that cannot see part of the domain it claims to cover reads exactly like
 * a guard finding nothing wrong.
 */
const targetCache = new Map();
const readTarget = (abs) => {
  if (!targetCache.has(abs)) {
    try { targetCache.set(abs, readFileSync(abs, 'utf8')); }
    catch { targetCache.set(abs, null); }
  }
  return targetCache.get(abs);
};

let checked = 0, bad = 0;
const harnesses = readdirSync(SCRIPTS).filter((f) => /^mutate-.*\.mjs$/.test(f)).sort();

for (const h of harnesses) {
  const src = readFileSync(join(SCRIPTS, h), 'utf8');
  // Every `resolve(SERVER, '...')` OR `resolve(REPO|ROOT, '...')` is a candidate
  // target. Both bases are in use; missing one makes whole harnesses invisible.
  const targets = [
    ...[...src.matchAll(/resolve\(SERVER,\s*'([^']+)'\)/g)].map((m) => join(SERVER, m[1])),
    // `.filter` because every harness also writes `const SERVER = resolve(REPO,
    // 'server')` — a BASE definition, not a target. Require a path separator and
    // a source extension so a base can never be mistaken for a file.
    ...[...src.matchAll(/resolve\((?:REPO|ROOT),\s*'([^']+)'\)/g)]
      .map((m) => m[1])
      .filter((rel) => rel.includes('/') && /\.(ts|tsx|mjs|js)$/.test(rel))
      .map((rel) => join(ROOT, rel)),
  ];
  if (targets.length === 0) { console.log(`  skip   ${h} (no resolvable target)`); continue; }
  const unreadable = targets.filter((t) => readTarget(t) == null);
  if (unreadable.length) {
    // A target path that does not exist would otherwise present as "every anchor
    // in this harness is dead", sending the reader after the anchors instead of
    // the path.
    console.log(`  DEAD   ${h} — ${unreadable.length} target file(s) unreadable:`);
    for (const u of unreadable) console.log(`           ${u.replace(ROOT + '/', '')}`);
    bad += unreadable.length;
    continue;
  }

  // Each mutant's `find:` literal must appear EXACTLY ONCE in one of them —
  // the same condition the harness itself enforces before mutating.
  // SINGLE PASS, deliberately. Unescaping sequentially -- quote-escapes, then
  // backslash-escapes, then newline-escapes -- re-processes the backslashes an
  // earlier step produced. An anchor containing an escaped backslash followed by
  // "n" would come out as a real newline, stop matching, and this checker would
  // then report a LIVE harness as dead. (CodeQL js/double-escaping caught exactly
  // that here.) One regex, each escape consumed exactly once, left to right.
  const unescape = (lit) => lit.replace(/\\(.)/gs, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
  const finds = [...src.matchAll(/\n\s*find:\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => unescape(m[1]));
  if (finds.length === 0) { console.log(`  skip   ${h} (no literal find: anchors)`); continue; }

  const misses = [];
  for (const f of finds) {
    checked += 1;
    const hits = targets.reduce((n, t) => n + ((readTarget(t) ?? '').split(f).length - 1), 0);
    if (hits !== 1) misses.push({ f, hits });
  }
  if (misses.length) {
    bad += misses.length;
    console.log(`  DEAD   ${h} — ${misses.length}/${finds.length} anchors do not resolve:`);
    for (const m of misses) console.log(`           (${m.hits} matches) ${m.f.trim().slice(0, 96)}`);
  } else {
    console.log(`  ok     ${h} (${finds.length} anchors)`);
  }
}

console.log(`\n${checked - bad}/${checked} mutant anchors resolve across ${harnesses.length} harnesses.`);
if (bad > 0) {
  console.error(
    `\nFAIL: ${bad} anchor(s) no longer match their source. The mutant cannot be applied, so the\n` +
    `guarantee it holds is UNCOVERED — the harness will abort rather than fail. Repoint the\n` +
    `anchor at the code's current shape (do not delete the mutant; the property it protects did\n` +
    `not go away just because the line moved).`,
  );
  process.exit(1);
}
