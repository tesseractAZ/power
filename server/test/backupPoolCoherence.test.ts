import { test } from 'node:test';
import assert from 'node:assert/strict';

import { coherentBackupPool, BACKUP_POOL_COHERENCE_SLACK_PCT } from '../src/ecoflow/project.js';

/* v0.54.4 — the SHP2 backup-pool coherence gate. backupBatPer / backupFullCap /
 * backupDischargeRmainBatCap all come from the SAME backupIncreInfo aggregate, so a real
 * reading is self-consistent (pct ≈ remain/full × 100). On a cloud reconnect a stale/zero
 * member appears while the pool is fine — 2026-06-21 18:12 laddered the whole 50→2 % SoC-alarm
 * cascade off a transient 0.0 %. The gate returns all-null ("unknown") when the trio disagrees
 * so no consumer (SoC alarm, reserve alert, runway, MQTT, recorder) acts on the bogus value. */

const NULL3 = { pct: null, fullCapWh: null, remainWh: null };

test('coherentBackupPool — a real, self-consistent reading passes through unchanged', () => {
  // Live fleet sample: 28 % vs 25497.6 / 92160 = 27.7 % → within slack → trusted.
  assert.deepEqual(coherentBackupPool(28, 92160, 25497.6), { pct: 28, fullCapWh: 92160, remainWh: 25497.6 });
});

test('coherentBackupPool — the incident signature (0 % vs ~63 % capacity) is rejected to all-null', () => {
  // backupBatPer momentarily 0 while remain/full still report the real ~63 % pool → incoherent.
  assert.deepEqual(coherentBackupPool(0, 92160, 58000), NULL3);
});

test('coherentBackupPool — fields null together (full cloud-offline) → all-null', () => {
  assert.deepEqual(coherentBackupPool(0, null, null), NULL3);
  assert.deepEqual(coherentBackupPool(null, null, null), NULL3);
});

test('coherentBackupPool — a missing capacity member makes the percent untrusted', () => {
  assert.deepEqual(coherentBackupPool(63, 92160, null), NULL3); // no remain to cross-check
  assert.deepEqual(coherentBackupPool(63, null, 58000), NULL3); // no full to cross-check
  assert.deepEqual(coherentBackupPool(63, 0, 0), NULL3); // zero capacity is not a real pool
});

test('coherentBackupPool — a genuine empty pool (coherent zero) passes (engine guard owns this case)', () => {
  // All three ~0 together is indistinguishable from a real empty pool by a stateless check;
  // it passes here and the SoC alarm's single-tick plausibility guard is the backstop.
  assert.deepEqual(coherentBackupPool(0, 92160, 0), { pct: 0, fullCapWh: 92160, remainWh: 0 });
});

test('coherentBackupPool — boundary: exactly on the slack edge is trusted, just past it is rejected', () => {
  // derived = 27648/92160*100 = 30.0; |30-30| = 0 → trusted.
  assert.deepEqual(coherentBackupPool(30, 92160, 27648), { pct: 30, fullCapWh: 92160, remainWh: 27648 });
  // derived ≈ 30.0 but reported 20 → |20-30| = 10 > 5 → rejected.
  assert.deepEqual(coherentBackupPool(20, 92160, 27648), NULL3);
  assert.equal(BACKUP_POOL_COHERENCE_SLACK_PCT, 5);
});
