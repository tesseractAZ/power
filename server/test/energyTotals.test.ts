import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRoundTripEfficiency, resetRteCache } from '../src/analytics.js';
import { integrateWh } from '../src/aggregator.js';
import type { Recorder } from '../src/recorder.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/**
 * v0.44.0 — round-trip-efficiency data-quality regression tests.
 *
 * Bug pinned: `computeRoundTripEfficiency` could publish an RTE > 100%
 * (energy_out / energy_in over the window). A battery can never deliver more
 * than it stored, so the surfaced efficiency must sit in (0, 100]%.
 *
 * Root cause (verified): the integration itself (trapezoidal `integrateWh`)
 * is CORRECT — the inclusive [dayStart, dayEnd] day boundary is shared as a
 * sample ENDPOINT, so no interval is double-counted across adjacent days (see
 * the "boundary counted once" test below). The leak was a MISSING CLAMP: the
 * round-trip band intentionally admits days up to RTE_ROUNDTRIP_MAX_FRAC
 * (1.05) so a genuine round trip with an in-flight charge/discharge interval
 * at the window edge isn't discarded, but neither the per-day `efficiencyPct`
 * nor the aggregate `effPct` was clamped to ≤100 before publishing. Fix:
 * `Math.min(100, …)` on both, plus the pre-existing zero-charge → null guard.
 */

/**
 * Mock recorder whose `queryMulti` returns a constant-watt series for every
 * `pack{n}_in` / `pack{n}_out` metric, dense enough to integrate cleanly over
 * the whole RTE window. `inW` drives charge, `outW` drives discharge.
 */
function fixedWattRecorder(inW: number, outW: number): Recorder {
  return {
    insertSnapshot: () => {},
    query: () => [],
    queryMulti: (_sn, metrics, since, until) => {
      const m = new Map<string, Array<{ ts: number; value: number }>>();
      const step = 5 * 60_000; // 5-min cadence, well under integrateWh's 10-min maxGap
      for (const k of metrics) {
        const w = k.endsWith('_in') ? inW : k.endsWith('_out') ? outW : 0;
        const arr: Array<{ ts: number; value: number }> = [];
        // Pad one step beyond each edge so the window is fully anchored.
        for (let t = since - step; t <= until + step; t += step) arr.push({ ts: t, value: w });
        m.set(k, arr);
      }
      return m;
    },
    listMetrics: () => [],
    close: () => {},
    rollupLifetime: () => {},
    getLifetimeTotals: () => ({}),
  } as unknown as Recorder;
}

function emptyRecorder(): Recorder {
  return {
    insertSnapshot: () => {},
    query: () => [],
    queryMulti: (_sn, metrics) => {
      const m = new Map<string, Array<{ ts: number; value: number }>>();
      for (const k of metrics) m.set(k, []);
      return m;
    },
    listMetrics: () => [],
    close: () => {},
    rollupLifetime: () => {},
    getLifetimeTotals: () => ({}),
  } as unknown as Recorder;
}

function oneDpu(packs = 1): Record<string, DeviceSnapshot> {
  const sn = 'SN-RTE';
  return {
    [sn]: {
      sn,
      deviceName: 'DPU',
      online: true,
      lastSeenMs: Date.now(),
      projection: {
        kind: 'dpu',
        soc: 80,
        packs: Array.from({ length: packs }, (_, i) => ({ num: i + 1, soc: 80 })),
      } as any,
    } as any,
  };
}

test('RTE — discharge > charge per day clamps the SURFACED efficiency to ≤100% (not 103%)', () => {
  resetRteCache();
  // Each day: discharge/charge = 1030/1000 = 1.03, inside the 0.8..1.05 band so
  // the day COUNTS, but 103% is physically impossible to publish.
  const rec = fixedWattRecorder(1000, 1030);
  const r = computeRoundTripEfficiency(oneDpu(), rec, 7);
  assert.equal(r.efficiencyPct, 100, 'aggregate efficiency must be clamped to 100%');
  for (const d of r.perDay) {
    if (d.efficiencyPct != null) {
      assert.ok(d.efficiencyPct <= 100, `per-day efficiency ${d.efficiencyPct} must be ≤ 100`);
    }
  }
  // The raw kWh totals are NOT clamped — only the efficiency ratio is — so the
  // data-quality signal (discharge slightly above charge) stays visible.
  assert.ok(
    r.totalDischargedKwh > r.totalChargedKwh,
    'raw totals preserved (efficiency clamp does not rewrite the kWh)',
  );
});

test('RTE — normal window where out < in yields a sane <100% efficiency', () => {
  resetRteCache();
  // discharge/charge = 950/1000 = 0.95 → a healthy LFP round trip.
  const rec = fixedWattRecorder(1000, 950);
  const r = computeRoundTripEfficiency(oneDpu(), rec, 7);
  assert.ok(r.efficiencyPct != null, 'efficiency should be defined for a covered window');
  assert.ok(r.efficiencyPct! < 100, `efficiency ${r.efficiencyPct} must be < 100`);
  assert.ok(
    Math.abs(r.efficiencyPct! - 95) < 0.5,
    `efficiency ${r.efficiencyPct} should be ~95% for a 0.95 round trip`,
  );
});

test('RTE — zero charge in the window → null efficiency (never Infinity/NaN)', () => {
  resetRteCache();
  // No charge anywhere: integrateWh returns 0 Wh for every pack_in series.
  const rec = fixedWattRecorder(0, 0);
  const r = computeRoundTripEfficiency(oneDpu(), rec, 7);
  assert.equal(r.efficiencyPct, null, 'zero-charge window must report null, not Infinity/NaN');
  // Also true when there are literally no samples at all.
  resetRteCache();
  const r2 = computeRoundTripEfficiency(oneDpu(), emptyRecorder(), 7);
  assert.equal(r2.efficiencyPct, null, 'empty window must report null');
});

test('RTE integration — a sample exactly on the day boundary is counted ONCE, not double', () => {
  // This pins root-cause (a) as NOT-APPLICABLE: integrateWh shares the boundary
  // sample as an endpoint between [.., T] and [T, ..], so the two adjacent-day
  // integrals sum to the continuous truth — the boundary interval is never
  // double-counted. (If it WERE, the sum below would exceed the truth.)
  const MIN = 60_000;
  const T = 86_400_000; // a day boundary (local midnight in ms terms)
  const W = 1000; // constant 1000 W
  const pts = [
    { ts: T - 5 * MIN, value: W },
    { ts: T, value: W }, // exactly on the boundary
    { ts: T + 5 * MIN, value: W },
  ];
  const dayA = integrateWh(pts, T - 60 * MIN, T); // window ENDS at the boundary
  const dayB = integrateWh(pts, T, T + 60 * MIN); // window STARTS at the boundary
  // Continuous truth over [T-5min, T+5min] at 1000 W = 1000 * (10/60) Wh.
  const truth = (W * 10) / 60;
  assert.ok(
    Math.abs(dayA.wh + dayB.wh - truth) < 1e-6,
    `adjacent-day integrals must sum to the continuous truth (${(dayA.wh + dayB.wh).toFixed(4)} vs ${truth.toFixed(4)}); a double-count would overshoot`,
  );
  // Each side carries exactly its own 5-min interval — the boundary is shared,
  // not duplicated.
  assert.ok(Math.abs(dayA.wh - truth / 2) < 1e-6, 'left day carries [T-5min, T] only');
  assert.ok(Math.abs(dayB.wh - truth / 2) < 1e-6, 'right day carries [T, T+5min] only');
});
