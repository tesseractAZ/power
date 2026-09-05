import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pollLogLines } from '../src/snapshot.js';
import { isRevertSettling, REVERT_READBACK_GRACE_MS } from '../src/nightChargeActuator.js';
import { ENERGY_STATE_FAMILIES } from '../src/alertMonitor.js';

/**
 * v1.120.0 — the 2026-09-03 audit's "detectors that cannot fire" cluster.
 *
 * Four separate mechanisms were each gated on a condition that is a CONSTANT in
 * this deployment, so each reported "nothing to see" for a reason unrelated to
 * whether there was anything to see. A detector that cannot fire and a detector
 * that found nothing emit identical telemetry; these tests pin the difference.
 */

/* ── #16 poll latency was gated on an empty fetch-failure set ─────────────── */

test('THE DEFECT: a slow poll is reported even though four accessories always fail', () => {
  // The live steady state: 4 accessory devices reject /quota/all on EVERY poll.
  const lines = pollLogLines({
    tookMs: 10_488, failedCount: 4, lastPollFailed: false, slowMs: 5_000, pollDebug: false,
  });
  assert.ok(lines.some((l) => l.startsWith('poll slow: 10488ms')),
    `the 10,488 ms excursion must be logged; got ${JSON.stringify(lines)}`);
});

test('a fast poll with the standing failure set stays quiet', () => {
  assert.deepEqual(
    pollLogLines({ tookMs: 490, failedCount: 4, lastPollFailed: false, slowMs: 5_000, pollDebug: false }),
    [],
  );
});

test('the recovery and debug lines keep their original failure-set semantics', () => {
  assert.deepEqual(
    pollLogLines({ tookMs: 400, failedCount: 0, lastPollFailed: true, slowMs: 5_000, pollDebug: false }),
    ['poll ok in 400ms (recovered)'],
  );
  assert.deepEqual(
    pollLogLines({ tookMs: 400, failedCount: 0, lastPollFailed: false, slowMs: 5_000, pollDebug: true }),
    ['poll ok in 400ms'],
  );
  // A poll that is BOTH a recovery and slow reports both facts.
  const both = pollLogLines({ tookMs: 9_000, failedCount: 0, lastPollFailed: true, slowMs: 5_000, pollDebug: false });
  assert.equal(both.length, 2, JSON.stringify(both));
});

test('exactly at the threshold counts as slow (>=, not >)', () => {
  assert.ok(pollLogLines({ tookMs: 5_000, failedCount: 4, lastPollFailed: false, slowMs: 5_000, pollDebug: false })
    .some((l) => l.includes('slow')));
});

/* ── #1/#6/#8/#17 the revert readback race ────────────────────────────────── */

const REVERT_MS = 1_788_437_156_227;  // live: 2026-09-03 05:05:56 MST
const RAISED = { appliedAtMs: REVERT_MS - 6 * 3_600_000, revertedAtMs: REVERT_MS, priorReservePct: 16, targetPct: 50 };

test('INCIDENT REPLAY 2026-09-03 05:06: the posture holds while the device still echoes 50', () => {
  // 20 s after the cloud ACK the SHP2 still reports the raised 50 — the exact
  // window in which a pool of 49% was classified as a genuine floor breach and
  // pushed "[Medium] Backup at reserve".
  assert.equal(isRevertSettling(RAISED, 50, REVERT_MS + 20_000), true);
});

test('the posture is released the moment the readback catches up', () => {
  assert.equal(isRevertSettling(RAISED, 16, REVERT_MS + 20_000), false,
    'live now reads the owner floor — nothing left to settle');
});

test('the grace window expires, so a later owner change is never masked', () => {
  assert.equal(isRevertSettling(RAISED, 50, REVERT_MS + REVERT_READBACK_GRACE_MS + 1), false);
  assert.equal(isRevertSettling(RAISED, 50, REVERT_MS + REVERT_READBACK_GRACE_MS), true, 'boundary is inclusive');
});

test('an owner who sets some OTHER value during the window is believed immediately', () => {
  assert.equal(isRevertSettling(RAISED, 30, REVERT_MS + 20_000), false,
    '30 is neither our target nor the prior floor — that is a real external change');
});

test('settling never applies before a revert, or with no raise at all', () => {
  assert.equal(isRevertSettling({ ...RAISED, revertedAtMs: null }, 50, REVERT_MS), false);
  assert.equal(isRevertSettling({ ...RAISED, appliedAtMs: null }, 50, REVERT_MS), false);
  assert.equal(isRevertSettling({ ...RAISED, targetPct: 16 }, 16, REVERT_MS + 1_000), false,
    'target === prior means nothing was raised');
  assert.equal(isRevertSettling(RAISED, 50, REVERT_MS - 1_000), false, 'clock went backwards — do not latch');
});

/* ── #3 msg-rate-floor was auto-tune demoted to "[Low] no action expected" ── */

test('THE DEFECT: msg-rate-floor is exempt from churn auto-tune, like its sibling families', () => {
  assert.ok(ENERGY_STATE_FAMILIES.has('msg-rate-floor'),
    'the third connectivity family — the only detector that sees "barely reporting while still fresh"');
  // Its siblings, for context: the v1.8.0 rationale covers all three.
  assert.ok(ENERGY_STATE_FAMILIES.has('offline'));
  assert.ok(ENERGY_STATE_FAMILIES.has('stale'));
  // Spare-device churn is still auto-tunable — that exemption is deliberate.
  assert.ok(!ENERGY_STATE_FAMILIES.has('offline-spare'));
  assert.ok(!ENERGY_STATE_FAMILIES.has('stale-spare'));
});

/* ── #15 the clock-reject logger was registered inside another callback ───── */

test('THE DEFECT: setClockRejectLogger is registered at module scope, not inside a callback', () => {
  const src = readFileSync(resolve(import.meta.dirname, '../src/index.ts'), 'utf8').split('\n');
  const idx = src.findIndex((l) => l.includes('setClockRejectLogger(') && !l.trimStart().startsWith('import'));
  assert.notEqual(idx, -1, 'the registration must exist');
  assert.ok(/^setClockRejectLogger\(/.test(src[idx]),
    `must start at column 0 (module scope); found: ${JSON.stringify(src[idx].slice(0, 60))}`);
  // It must not sit between setClockOffsetLogger's opening and closing lines.
  const openIdx = src.findIndex((l) => l.startsWith('setClockOffsetLogger('));
  if (openIdx !== -1) {
    assert.ok(idx < openIdx,
      'registering it inside the offset-logger body made it reachable only AFTER a first adoption');
  }
});

/* ── #10 the notify transport was the one uncapped HTTP call ──────────────── */

test('THE DEFECT: every notify HTTP call carries an explicit timeout', () => {
  // v1.124.0 — the ntfy / Pushover / webhook transports were REMOVED, so the raw
  // `request()` count dropped from four to one (persistent_notification). The
  // invariant is unchanged and still exactly as strict: nothing in this module
  // may reach the network on undici's 300 s defaults, because sendNotification is
  // awaited inline inside the alarm evaluator's re-entrancy latch.
  const src = readFileSync(resolve(import.meta.dirname, '../src/notify.ts'), 'utf8');
  const calls = (src.match(/await request\(/g) ?? []).length;
  assert.ok(calls >= 1, `expected at least the persistent_notification call, found ${calls}`);
  const headers = (src.match(/headersTimeout:/g) ?? []).length;
  const bodies = (src.match(/bodyTimeout:/g) ?? []).length;
  assert.equal(headers, calls, 'every request() must cap headersTimeout (undici defaults to 300 s)');
  assert.equal(bodies, calls, 'every request() must cap bodyTimeout');
  // And the push half, which goes through haService rather than raw undici, must
  // pass its budget explicitly instead of inheriting that module's defaults.
  assert.match(src, /callHaService\('notify', target, payload, \{\s*\n?\s*headersTimeoutMs: NOTIFY_HEADERS_TIMEOUT_MS,/,
    'the mobile push must carry the same explicit budget');
});
