import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyClearDuration } from '../src/alertMonitor.js';
import {
  computeLearnedAlerts,
  bumpPeerHit,
  prunePeerHitCounts,
  _resetPeerHitCounts,
} from '../src/analytics.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/* ===================================================================
 * v0.13.2 — alert-hygiene fixes from the verified 7-day audit.
 *
 * P1-3: short-clear accounting defeated auto-demote. recordClear was
 *       gated on `duration >= DEBOUNCE_MS`, so a sub-60s flap (the MOST
 *       transient outcome) NEVER incremented shortClearsCount — capping
 *       the short-clear fraction below DEMOTE_WARN_SHORT_FRAC (0.8) so
 *       warning→info auto-demote could structurally never fire.
 *
 * P1-4: the learned peer-outlier path flapped 1103× on normal parallel-
 *       pack SoC rebalancing — floor too low (5%), the MAD-zero shortcut
 *       forced a bare floor-cross to z=Z_WARN (warning), and the path had
 *       no hysteresis. Fixes: floor 5→8, MAD-zero fallback Z_WARN→Z_INFO,
 *       and a >=3-consecutive-cycle emit gate.
 * =================================================================== */

/* ── P1-3: short-clear accounting ─────────────────────────────────── */

test('classifyClearDuration — a sub-60s clear counts as a shortClear (P1-3)', () => {
  // The bug: a <60s flap was dropped entirely (gated on duration ≥ 60s),
  // so it never reached shortClearsCount. A 30s clear is the most transient
  // outcome and MUST be classified as a short clear.
  const c = classifyClearDuration(30_000);
  assert.equal(c.shortClear, true, '30s clear must be a short clear');
  assert.equal(c.longActive, false, '30s clear is not a long-active clear');
});

test('classifyClearDuration — exactly DEBOUNCE-sized (60s) clear is still short', () => {
  const c = classifyClearDuration(60_000);
  assert.equal(c.shortClear, true);
  assert.equal(c.longActive, false);
});

test('classifyClearDuration — boundary at the 10-min short-clear threshold', () => {
  const tenMin = 10 * 60 * 1000;
  assert.equal(classifyClearDuration(tenMin).shortClear, true, '≤10min is short (inclusive)');
  assert.equal(classifyClearDuration(tenMin + 1).shortClear, false, '>10min is not short');
});

test('classifyClearDuration — a ≥4h clear is longActive, not short', () => {
  const c = classifyClearDuration(4 * 60 * 60 * 1000);
  assert.equal(c.shortClear, false);
  assert.equal(c.longActive, true);
});

test('classifyClearDuration — a mid-range clear (1h) is neither short nor long', () => {
  const c = classifyClearDuration(60 * 60 * 1000);
  assert.equal(c.shortClear, false);
  assert.equal(c.longActive, false);
});

/* ── P1-4: learned peer-outlier hysteresis ────────────────────────── */

/**
 * Build a single online DPU whose packs are identical except one pack's
 * SoC is offset by `socDelta` from the others. Identical siblings →
 * MAD≈0 on every metric, so SoC is the only metric that can flag and its
 * peer MAD is zero (exercising the MAD-zero fallback path directly).
 */
function dpuWithSocOutlier(socDelta: number, sn = 'SN-DPU-0'): Record<string, DeviceSnapshot> {
  const base = { temp: 25, maxCellTemp: 25, minCellTemp: 25, soh: 100, actSoh: 100, maxVolDiffMv: 20, inputWatts: 0, outputWatts: 0, cycles: 50 };
  const packs = [
    { num: 1, soc: 80, ...base },
    { num: 2, soc: 80, ...base },
    { num: 3, soc: 80, ...base },
    { num: 4, soc: 80, ...base },
    { num: 5, soc: 80 + socDelta, ...base },
  ];
  return {
    [sn]: {
      sn,
      deviceName: 'Core 1',
      online: true,
      lastSeenMs: Date.now(),
      projection: { kind: 'dpu', soc: 80, packs } as any,
    } as any,
  };
}

/** Run N consecutive eval cycles on the same fixture; return the per-cycle alert lists. */
function runCycles(devices: Record<string, DeviceSnapshot>, n: number): ReturnType<typeof computeLearnedAlerts>[] {
  const out = [];
  for (let i = 0; i < n; i++) out.push(computeLearnedAlerts(devices));
  return out;
}

const socAlerts = (alerts: ReturnType<typeof computeLearnedAlerts>) =>
  alerts.filter((a) => a.id.startsWith('peer-soc-'));

test('computeLearnedAlerts — a 6% SoC deviation with zero peer MAD does NOT warn; emits INFO only after 3 cycles (P1-4)', () => {
  _resetPeerHitCounts();
  // 6% is past the OLD 5% floor (would have flapped) but the new 8% floor
  // suppresses it entirely as normal rebalance scatter.
  const cycles = runCycles(dpuWithSocOutlier(6), 4);
  for (const [i, c] of cycles.entries()) {
    assert.equal(socAlerts(c).length, 0, `6% deviation is below the 8% floor — no peer-SoC alert (cycle ${i + 1})`);
  }
});

test('computeLearnedAlerts — a 9% SoC deviation with zero peer MAD: suppressed for <3 cycles, then emits INFO (not warning) (P1-4)', () => {
  _resetPeerHitCounts();
  const devices = dpuWithSocOutlier(9); // past the new 8% floor, MAD=0 across siblings
  const cycles = runCycles(devices, 4);

  // Hysteresis: first two cycles emit nothing (need ≥3 consecutive hits).
  assert.equal(socAlerts(cycles[0]).length, 0, 'cycle 1 — gated by hysteresis, no emit');
  assert.equal(socAlerts(cycles[1]).length, 0, 'cycle 2 — gated by hysteresis, no emit');

  // Cycle 3 reaches the threshold and emits.
  const emitted = socAlerts(cycles[2]);
  assert.equal(emitted.length, 1, 'cycle 3 — hysteresis satisfied, one peer-SoC alert');
  // MAD-zero fallback is now Z_INFO, so a bare floor-cross with no sibling
  // scatter surfaces as INFO, not WARNING (the old bug forced it to warning).
  assert.equal(emitted[0].severity, 'info', 'MAD-zero floor-cross is INFO, never warning');
  // Still firing on the 4th consecutive cycle.
  assert.equal(socAlerts(cycles[3]).length, 1, 'cycle 4 — continues to emit while sustained');
});

test('computeLearnedAlerts — a single hit followed by a clear resets the gate (no slow accumulation) (P1-4)', () => {
  _resetPeerHitCounts();
  const outlier = dpuWithSocOutlier(9);
  const normal = dpuWithSocOutlier(0); // all packs equal — nothing crosses the floor

  // Two non-consecutive hits separated by a clean cycle must NOT reach 3.
  assert.equal(socAlerts(computeLearnedAlerts(outlier)).length, 0); // hit 1
  assert.equal(socAlerts(computeLearnedAlerts(normal)).length, 0);  // clean → prune resets the counter
  assert.equal(socAlerts(computeLearnedAlerts(outlier)).length, 0); // hit 1 again, not 3
  assert.equal(socAlerts(computeLearnedAlerts(outlier)).length, 0); // hit 2
  assert.equal(socAlerts(computeLearnedAlerts(outlier)).length, 1); // hit 3 → emit
});

test('bumpPeerHit / prunePeerHitCounts — smallest hysteresis unit (P1-4)', () => {
  _resetPeerHitCounts();
  const k = 'soc-SN-X-5';
  assert.deepEqual(bumpPeerHit(k), { count: 1, emit: false });
  assert.deepEqual(bumpPeerHit(k), { count: 2, emit: false });
  assert.deepEqual(bumpPeerHit(k), { count: 3, emit: true }, '3rd consecutive hit reaches the emit threshold');

  // A cycle where this key is NOT seen drops it back to zero.
  prunePeerHitCounts(new Set());
  assert.deepEqual(bumpPeerHit(k), { count: 1, emit: false }, 'pruned key restarts from 1');

  // A cycle where the key IS seen preserves its running count.
  prunePeerHitCounts(new Set([k]));
  assert.deepEqual(bumpPeerHit(k), { count: 2, emit: false }, 'seen key keeps accumulating');
});

test('computeLearnedAlerts — peer-SoC alert detail/facts unchanged on the emitted alert (P1-4 is presentational-safe)', () => {
  _resetPeerHitCounts();
  const devices = dpuWithSocOutlier(9);
  runCycles(devices, 2);
  const [a] = socAlerts(computeLearnedAlerts(devices));
  assert.ok(a, 'an alert is emitted on the 3rd cycle');
  assert.equal(a.source, 'learned');
  assert.equal(a.packNum, 5);
  assert.match(a.detail, /state of charge/);
});
