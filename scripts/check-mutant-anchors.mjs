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

/** Source files a harness may target, resolved once. */
const targetCache = new Map();
const readTarget = (rel) => {
  if (!targetCache.has(rel)) {
    try { targetCache.set(rel, readFileSync(join(SERVER, rel), 'utf8')); }
    catch { targetCache.set(rel, null); }
  }
  return targetCache.get(rel);
};

let checked = 0, bad = 0;
const harnesses = readdirSync(SCRIPTS).filter((f) => /^mutate-.*\.mjs$/.test(f)).sort();

for (const h of harnesses) {
  const src = readFileSync(join(SCRIPTS, h), 'utf8');
  // Every `resolve(SERVER, 'src/...')` in the harness is a candidate target.
  const targets = [...src.matchAll(/resolve\(SERVER,\s*'([^']+)'\)/g)].map((m) => m[1]);
  if (targets.length === 0) { console.log(`  skip   ${h} (no SERVER target)`); continue; }

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
