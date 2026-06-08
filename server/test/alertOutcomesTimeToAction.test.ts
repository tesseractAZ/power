import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/**
 * v0.13.2 — time-to-action semantics (audit P2-6).
 *
 * `medianTimeToActionMs` is meant to capture operator RESPONSE latency. For
 * continuously-active / persistent families (offline, grid-offgrid),
 * alertFiredAt is stamped once at the first-ever fire and never refreshed, so
 * `ts - alertFiredAt` measures condition-age, not response time — the audit
 * saw 9.44 days (offline) and 13.18 days (grid-offgrid). computeFamilyStats
 * now returns null for those families. Transient families keep a real median.
 *
 * Path override (ALERT_OUTCOMES_PATH) is read by alertOutcomes.ts at
 * module-load, so it MUST be set before the dynamic import. Mirrors
 * alertOutcomes.test.ts.
 */

const tmp = mkdtempSync(resolve(tmpdir(), 'outcomes-tta-test-'));
process.env.ALERT_OUTCOMES_PATH = resolve(tmp, 'alert-outcomes.jsonl');

const { appendAlertOutcome, computeFamilyStats } =
  await import('../src/alertOutcomes.js');

const DAY_MS = 24 * 60 * 60 * 1000;

test('persistent family (offline) → medianTimeToActionMs is null', () => {
  // A continuously-active condition: fired ~9 days before the operator acted.
  const firedAt = 1_700_000_000_000;
  appendAlertOutcome({
    ts: firedAt + 9 * DAY_MS,
    alertId: 'offline-Y711ZAB59GBC0314',
    alertFiredAt: firedAt,
    outcome: 'ack',
    source: {},
  });

  const stats = computeFamilyStats();
  const offline = stats.find((s) => s.family === 'offline');
  assert.ok(offline, 'offline family should be present');
  assert.equal(
    offline.medianTimeToActionMs,
    null,
    'persistent family must report null time-to-action, not condition-age',
  );
});

test('persistent family (grid-offgrid) → medianTimeToActionMs is null', () => {
  const firedAt = 1_700_100_000_000;
  appendAlertOutcome({
    ts: firedAt + 13 * DAY_MS,
    alertId: 'grid-offgrid',
    alertFiredAt: firedAt,
    outcome: 'ack',
    source: {},
  });

  const stats = computeFamilyStats();
  const grid = stats.find((s) => s.family === 'grid-offgrid');
  assert.ok(grid, 'grid-offgrid family should be present');
  assert.equal(grid.medianTimeToActionMs, null);
});

test('transient family (soc-low) → keeps a real median time-to-action', () => {
  const firedAt = 1_700_200_000_000;
  // Operator acted ~10 minutes after the transient fire.
  const tta = 10 * 60 * 1000;
  appendAlertOutcome({
    ts: firedAt + tta,
    alertId: 'soc-low-Y711ZABA9H3T0489-2',
    alertFiredAt: firedAt,
    outcome: 'ack',
    source: {},
  });

  const stats = computeFamilyStats();
  const soc = stats.find((s) => s.family === 'soc-low');
  assert.ok(soc, 'soc-low family should be present');
  assert.equal(
    soc.medianTimeToActionMs,
    tta,
    'transient family must still report the real response latency',
  );
});
