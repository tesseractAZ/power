import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * v1.191.0 (S1) — the goldens are frozen.
 *
 * server/test/golden/FROZEN.sha256 lists the sha256 of every golden file. A golden pins the
 * behaviour of the owner's install, so changing one must be a visible decision in review: the
 * manifest line changes in the same diff, and the reviewer reads both. Nothing re-baselines
 * silently — not a re-run of the capture script, not a merge.
 */
const GOLDEN = resolve(dirname(fileURLToPath(import.meta.url)), 'golden');
const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

function manifest(): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of readFileSync(resolve(GOLDEN, 'FROZEN.sha256'), 'utf8').split('\n')) {
    const m = /^([0-9a-f]{64})\s{2}(G\d+\.json)$/.exec(line.trim());
    if (m) out.set(m[2], m[1]);
  }
  return out;
}

test('★ every golden file matches FROZEN.sha256', () => {
  const pins = manifest();
  assert.ok(pins.size >= 8, `FROZEN.sha256 lists ${pins.size} goldens (expected the eight groups)`);
  for (const [file, pin] of pins) {
    const actual = sha256(readFileSync(resolve(GOLDEN, file)));
    assert.equal(actual, pin, `${file} changed: sha256 ${actual}, pinned ${pin} — a golden describes the owner's install; `
      + 'if the change is intended, re-capture with scripts/golden-capture.mts and commit the new manifest line in the same diff');
  }
});

test('every golden file is pinned', () => {
  const pins = manifest();
  const files = readdirSync(GOLDEN).filter((f) => /^G\d+\.json$/.test(f)).sort();
  assert.deepEqual(files, [...pins.keys()].sort(), 'a golden without a manifest line is unfrozen');
});

test('a golden carries placeholder ids only', () => {
  // The bench-spare literal is imported and replaced by <SPARE_n> before capture (groups.ts
  // redactSpares); any other serial-shaped token must be a placeholder (…XXX00XXX00NN) or a hash.
  for (const file of readdirSync(GOLDEN).filter((f) => /^G\d+\.json$/.test(f))) {
    const text = readFileSync(resolve(GOLDEN, file), 'utf8');
    for (const tok of text.match(/\b[A-Z0-9]{4}[A-Z0-9]{12}\b/g) ?? []) {
      if (/^[A-F0-9]{16}$/i.test(tok) && !/[G-Z]/i.test(tok)) continue; // a hash fragment
      if (!/^[A-Z0-9]{4}[A-Z]{3}/.test(tok)) continue; // not serial-shaped
      assert.match(tok.slice(4), /^[X0]{10}[0-9]{2}$/, `${file}: ${tok.slice(0, 4)}… is not a placeholder serial`);
    }
  }
});
