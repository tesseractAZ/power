import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { nextPollDelayMs } from '../src/snapshot.js';
import { familyPrecision } from '../src/alertOutcomes.js';

/**
 * v1.123.0 — reports that were saying something they could not support.
 */

/* ── #20 poll period drifted with vendor latency ──────────────────────────── */

test('THE DEFECT: the poll period no longer absorbs the poll duration', () => {
  // Measured live: 3,626-3,638 s against a 3,600 s nominal hour.
  assert.equal(nextPollDelayMs(3_600_000, 27_000), 3_573_000);
  assert.equal(nextPollDelayMs(3_600_000, 0), 3_600_000);
});

test('a poll slower than the interval schedules immediately, never negative', () => {
  assert.equal(nextPollDelayMs(60_000, 90_000), 0);
});

test('a nonsense duration falls back to the full interval', () => {
  assert.equal(nextPollDelayMs(60_000, Number.NaN), 60_000);
  assert.equal(nextPollDelayMs(60_000, -5), 60_000);
});

test('the compensated period holds constant across varying poll durations', () => {
  // 24 hourly polls of wildly different duration must still cover ~24 h.
  const durations = [400, 10_488, 1_085, 490, 3_200, 800];
  for (const d of durations) {
    assert.equal(nextPollDelayMs(3_600_000, d) + d, 3_600_000, `period drifted for a ${d}ms poll`);
  }
});

/* ── #18 per-family precision was 1.0 by construction ─────────────────────── */

test('THE DEFECT: a one-class all-ack stream is not a measurement', () => {
  // The live shape: 47 labelled outcomes, every family precision 1, dismiss 0.
  assert.equal(familyPrecision({ ack: 8, dismiss: 0, failed: 0 }), null,
    'nobody ever pressing dismiss is not evidence of a perfect alarm engine');
  assert.equal(familyPrecision({ ack: 33, dismiss: 0, failed: 0 }), null,
    'the live 33 batch-acks pinned this at a fake permanent 1.0');
});

test('precision IS reported once the stream carries the informative class', () => {
  assert.equal(familyPrecision({ ack: 3, dismiss: 1, failed: 0 }), 0.75, '3 real of 4 decided');
  assert.equal(familyPrecision({ ack: 2, dismiss: 1, failed: 1 }), 0.75, 'failed counts as real');
});

test('a single dismissal below the decided floor still withholds the claim', () => {
  assert.equal(familyPrecision({ ack: 1, dismiss: 1, failed: 0 }), null,
    'anti-flap: 2 decided is under the floor of 3');
  assert.equal(familyPrecision({ ack: 2, dismiss: 1, failed: 0 }), 2 / 3, 'at the floor it measures');
});

test('a genuine precision collapse is never hidden by the guard', () => {
  assert.equal(familyPrecision({ ack: 0, dismiss: 5, failed: 0 }), 0,
    'an all-dismiss family reports 0, loudly');
});

/* ── #19 the cleared-alert ledger mislabelled the opening state ───────────── */

const AM = readFileSync(resolve(import.meta.dirname, '../src/alertMonitor.ts'), 'utf8');

test('THE DEFECT: the permanent record is built from the OPENING body', () => {
  assert.match(AM, /openingAlert: \{ \.\.\.a \},/,
    'an immutable copy must be frozen when the alert is first tracked');
  assert.match(AM, /const opening = t\.openingAlert \?\? t\.alert;/,
    'the retirement path must use it (with a fallback for pre-v1.123.0 persisted state)');
  assert.match(AM, /const recordedAlert = peak !== opening\.severity/,
    'and the peak-severity repair must apply to the opening body, not the last tick');
});

test('#19: the closing state is preserved, not discarded', () => {
  assert.match(AM, /closedAs: \{ title: t\.alert\.title, detail: t\.alert\.detail, severity: t\.alert\.severity \}/,
    'nothing is lost — it is simply no longer mislabelled as the opening state');
});

/* ── readiness measurability ──────────────────────────────────────────────── */

const GATE = readFileSync(resolve(import.meta.dirname, '../src/nightChargeGate.ts'), 'utf8');

test('the gate publishes MEASURABILITY beside the measurements', () => {
  assert.match(GATE, /underBuyMeasurable:/);
  assert.match(GATE, /strikesMeasurable:/);
  assert.match(GATE, /UNREACHABLE, not merely thin/,
    'the blocking line must not read like a temporary data shortage');
});

test('the gate is made visible, NOT loosened', () => {
  // The exemptions themselves are untouched: re-scoping the cushion is an owner
  // policy call, so fail-closed remains the posture.
  assert.match(GATE, /const underBuyPool = actuated\.filter\(\(r\) => !truthy\(r\.cushion_shortfall\)\);/,
    'the under-buy exemption must still be in force');
  assert.match(GATE, /if \(truthy\(r\.cushion_shortfall\)\) return false; \/\/ disclosed — physics, not fault/,
    'the strike exemption must still be in force');
});

/* ── the notify channel's own description must not promise a push ─────────── */

test('the config text no longer implies the ha channel reaches a phone', () => {
  const y = readFileSync(resolve(import.meta.dirname, '../../ecoflow_panel/translations/en.yaml'), 'utf8');
  const i = y.indexOf('NOTIFY_CHANNEL:');
  const block = y.slice(i, i + 1400);
  assert.match(block, /does NOT send a phone push/i,
    'persistent_notification raises no OS push — the description must say so');
  assert.match(block, /ntfy/, 'and must point at the channels that do');
});
