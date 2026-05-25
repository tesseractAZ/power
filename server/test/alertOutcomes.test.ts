import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

// Path override is read by alertOutcomes.ts at module-load via process.env.
// We set the env BEFORE importing so the module picks up the temp dir.
const tmp = mkdtempSync(resolve(tmpdir(), 'outcomes-test-'));
process.env.ALERT_OUTCOMES_PATH = resolve(tmp, 'alert-outcomes.jsonl');

const { appendAlertOutcome, tailAlertOutcomes, computeFamilyStats, familyOf } =
  await import('../src/alertOutcomes.js');

test('familyOf — strips trailing device serial', () => {
  assert.equal(familyOf('pack-hot-Y711ZAB59GBC0314-3'), 'pack-hot');
  assert.equal(familyOf('cell-imbalance-Y711ZABA9H3T0489'), 'cell-imbalance');
  // Lowercase suffix should NOT be stripped — only ALL-CAPS serial-looking blocks.
  assert.equal(familyOf('simple-id'), 'simple-id');
});

test('appendAlertOutcome + tail — round-trips a single entry', () => {
  appendAlertOutcome({
    ts: 1_700_000_000_000,
    alertId: 'pack-hot-Y711ZAB59GBC0314-3',
    outcome: 'ack',
    source: { ip: '127.0.0.1', ua: 'test' },
  });
  const recent = tailAlertOutcomes(10);
  assert.equal(recent.length, 1);
  assert.equal(recent[0].alertId, 'pack-hot-Y711ZAB59GBC0314-3');
  assert.equal(recent[0].outcome, 'ack');
});

test('computeFamilyStats — precision = (ack + failed) / (ack + failed + dismiss)', () => {
  // Add: 2 ack + 1 dismiss + 1 failed → precision 3/4 = 0.75
  appendAlertOutcome({
    ts: 1_700_000_100_000, alertId: 'pack-hot-AAA-1',
    outcome: 'ack', source: {}, category: 'Thermal', severity: 'critical',
  });
  appendAlertOutcome({
    ts: 1_700_000_200_000, alertId: 'pack-hot-BBB-2',
    outcome: 'dismiss', source: {}, category: 'Thermal', severity: 'critical',
  });
  appendAlertOutcome({
    ts: 1_700_000_300_000, alertId: 'pack-hot-CCC-3',
    outcome: 'failed', source: {}, category: 'Thermal', severity: 'critical',
  });
  const stats = computeFamilyStats();
  const hot = stats.find((s) => s.family === 'pack-hot');
  assert.ok(hot, 'pack-hot family should be present');
  // 1 ack from earlier test + 2 ack/failed here = 3 real; 1 dismiss = 1 fp
  assert.equal(hot.ack, 2);
  assert.equal(hot.dismiss, 1);
  assert.equal(hot.failed, 1);
  assert.ok(hot.precision != null);
  assert.equal(hot.precision, (2 + 1) / (2 + 1 + 1));   // 0.75
});

test('computeFamilyStats — resolved outcomes excluded from precision', () => {
  appendAlertOutcome({
    ts: 1_700_000_400_000, alertId: 'flap-DDD',
    outcome: 'resolved', source: {},
  });
  appendAlertOutcome({
    ts: 1_700_000_500_000, alertId: 'flap-EEE',
    outcome: 'resolved', source: {},
  });
  const stats = computeFamilyStats();
  const flap = stats.find((s) => s.family === 'flap');
  assert.ok(flap);
  assert.equal(flap.resolved, 2);
  assert.equal(flap.precision, null);  // no decided outcomes
});

test('cleanup tmp dir', () => {
  rmSync(tmp, { recursive: true, force: true });
  assert.ok(true);
});
