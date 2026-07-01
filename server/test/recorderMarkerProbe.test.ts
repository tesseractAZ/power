import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { markerPresentProbe } from '../src/recorder.js';

/* v0.79.0 — fail-safe direction of the one-time reset marker probe.
 *
 * The v0.79.0 TOCTOU hardening replaced existsSync with a readFileSync probe;
 * the adversarial review caught that a bare catch treated a PRESENT-but-
 * UNREADABLE marker (EIO from a corrupted inode after an unclean power-off —
 * this host's dominant reboot cause) as "not claimed", which would re-run the
 * destructive lifetime-counter reset on EVERY boot (the wx re-write EEXISTs
 * silently and never repairs it). These tests pin the fix: only a confirmed-
 * absent marker (ENOENT) reads as "not yet claimed"; ANY other failure reads
 * as claimed, so the reset is skipped — the old existsSync gate's safe
 * direction. */

const root = mkdtempSync(join(tmpdir(), 'marker-probe-test-'));

test('markerPresentProbe — absent marker (ENOENT) reads NOT claimed', () => {
  assert.equal(markerPresentProbe(join(root, 'nope.flag')), false);
});

test('markerPresentProbe — a normal marker file reads claimed', () => {
  const p = join(root, 'claimed.flag');
  writeFileSync(p, 'reset at 2026-07-01\n');
  assert.equal(markerPresentProbe(p), true);
});

test('markerPresentProbe — present-but-unreadable marker reads CLAIMED (never re-run the reset)', () => {
  // A directory at the marker path makes readFileSync throw EISDIR — a stand-in
  // for any non-ENOENT read failure (EIO/EACCES): something occupies the path.
  const p = join(root, 'occupied.flag');
  mkdirSync(p);
  assert.equal(markerPresentProbe(p), true, 'non-ENOENT read failure must NOT re-trigger the destructive reset');
});

test.after(() => {
  rmSync(root, { recursive: true, force: true });
});
