import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { computeInternalResistance, resetIrCache } from '../src/analytics.js';
import type { Recorder } from '../src/recorder.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/* ===================================================================
 * v1.22.0 — engine-review F27: internal-resistance trend honesty.
 *
 * The live report published −74.46 mΩ/mo from 10 samples under a
 * 'tracking' label. Three defects fixed here:
 *  1. Math.abs() coerced wrong-signed dV/dI pairs (bus voltage moving
 *     AGAINST the current step — OCV drift / snap races, not resistance)
 *     into plausible positive R samples → now REJECTED (bat_amp is
 *     into-battery-positive, so genuine Ohmic response has dV/dI > 0).
 *  2. The OLS slope published raw — the only trend engine with no fit
 *     gate → now requires r² ≥ 0.3, span ≥ 14 d, and |slope| ≤ 5 mΩ/mo
 *     (physical plausibility ceiling; risk factor saturates at 3).
 *     trendR2 publishes alongside as a diagnostic.
 *  3. At 10 samples the "baseline" slice was the whole series (recent
 *     included) — it compared the data to itself → baseline now draws
 *     only from pre-recent (>7 d old) samples, ≥ 5 of them or null.
 * =================================================================== */

const DAY = 86_400_000;

/** One accepted dV/dI event: two (V,A) samples 60 s apart with a +10 A
 *  charge step and dV chosen to encode `rMilli`. Events are spaced far
 *  apart, so each contributes exactly one candidate pair and the ±3 s
 *  steady windows around both endpoints are empty (= steady). */
function events(
  list: Array<{ ts: number; rMilli: number }>,
): { vol: Array<{ ts: number; value: number }>; amp: Array<{ ts: number; value: number }> } {
  const vol: Array<{ ts: number; value: number }> = [];
  const amp: Array<{ ts: number; value: number }> = [];
  for (const e of list) {
    const dI = 10; // +10 A into the battery (charging step)
    const dV = (e.rMilli * dI) / 1000; // sign of dV carries the pair's dV/dI sign
    vol.push({ ts: e.ts, value: 51.2 });
    amp.push({ ts: e.ts, value: 2 });
    vol.push({ ts: e.ts + 60_000, value: 51.2 + dV });
    amp.push({ ts: e.ts + 60_000, value: 2 + dI });
  }
  return { vol, amp };
}

function mockRecorder(data: Record<string, Record<string, Array<{ ts: number; value: number }>>>): Recorder {
  return {
    queryMulti: (sn: string, metrics: string[]) => {
      const out = new Map<string, Array<{ ts: number; value: number }>>();
      for (const m of metrics) out.set(m, data[sn]?.[m] ?? []);
      return out;
    },
    query: () => [],
    listMetrics: () => [],
    insert: () => {},
    close: () => {},
    rollupLifetime: () => {},
    getLifetimeTotals: () => ({}),
  } as unknown as Recorder;
}

function dpu(sn: string): Record<string, DeviceSnapshot> {
  return {
    [sn]: {
      sn, deviceName: `DELTA-PRO-ULTRA-${sn}`, productName: 'Delta Pro Ultra',
      online: true, lastUpdated: Date.now(),
      projection: { kind: 'dpu', packs: [] },
    } as unknown as DeviceSnapshot,
  };
}

function run(sn: string, evts: Array<{ ts: number; rMilli: number }>) {
  const { vol, amp } = events(evts);
  const rec = mockRecorder({ [sn]: { bat_vol: vol, bat_amp: amp } });
  const report = computeInternalResistance(dpu(sn), rec);
  return report.devices[0];
}

/** n events, evenly spread from `fromDaysAgo` to `toDaysAgo`, rMilli from fn. */
function spread(n: number, fromDaysAgo: number, toDaysAgo: number, r: (i: number) => number) {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => ({
    ts: now - fromDaysAgo * DAY + ((fromDaysAgo - toDaysAgo) * DAY * i) / Math.max(1, n - 1),
    rMilli: r(i),
  }));
}

beforeEach(() => resetIrCache());

test('F27 — wrong-signed dV/dI pairs are rejected, not abs()-coerced into the sample set', () => {
  // 15 events whose bus voltage DROPS on a +10 A charge step (dV/dI < 0):
  // OCV drift / snap races, not resistance. Pre-fix: 15 "samples" at 8 mΩ,
  // status tracking. Post-fix: 0 samples.
  const row = run('SN-F27-NEG', spread(15, 25, 2, () => -8));
  assert.equal(row.samples, 0, 'negative-signed pairs must not become samples');
  assert.notEqual(row.status, 'tracking');
  assert.equal(row.recentMilliohms, null);
});

test('F27 — mixed series: only the correctly-signed pairs survive and set the medians', () => {
  const now = Date.now();
  const good = spread(12, 25, 2, () => 8);
  const bad = Array.from({ length: 6 }, (_, i) => ({ ts: now - 20 * DAY + i * DAY + 3_600_000, rMilli: -30 }));
  const row = run('SN-F27-MIX', [...good, ...bad].sort((a, b) => a.ts - b.ts));
  assert.equal(row.samples, 12, 'exactly the 12 good pairs');
  assert.equal(row.status, 'tracking');
  assert.ok(Math.abs((row.recentMilliohms ?? 0) - 8) < 0.5, `medians from good pairs only (${row.recentMilliohms})`);
});

test('F27 — a noise fit (r² ≈ 0) keeps its medians but publishes NO trend; trendR2 says why', () => {
  // 20 events over 23 days alternating 6/10 mΩ — no time structure at all.
  const row = run('SN-F27-NOISE', spread(20, 25, 2, (i) => (i % 2 ? 10 : 6)));
  assert.equal(row.status, 'tracking');
  assert.ok(row.recentMilliohms != null, 'medians still publish');
  assert.equal(row.trendMilliohmsPerMonth, null, 'a noise slope must not publish');
  assert.ok(row.trendR2 != null && row.trendR2 < 0.3, `diagnostic r² shows the gate reason (${row.trendR2})`);
});

test('F27 — a genuine, physical trend still publishes (regression)', () => {
  // 6 → 8 mΩ linearly over 23 days ≈ +2.6 mΩ/mo, r² ≈ 1, span ≥ 14 d.
  const row = run('SN-F27-REAL', spread(20, 25, 2, (i) => 6 + (2 * i) / 19));
  assert.equal(row.status, 'tracking');
  assert.ok(row.trendR2 != null && row.trendR2 > 0.9, `clean fit (${row.trendR2})`);
  assert.ok(
    row.trendMilliohmsPerMonth != null && row.trendMilliohmsPerMonth > 2 && row.trendMilliohmsPerMonth < 3.5,
    `expected ≈ +2.6 mΩ/mo, got ${row.trendMilliohmsPerMonth}`,
  );
});

test('F27 — the plausibility ceiling nulls a perfect-fit but unphysical POSITIVE slope', () => {
  // 10 → 60 mΩ over 20 days = +75 mΩ/mo at r² ≈ 1 — a regime change, not aging.
  const row = run('SN-F27-CEIL', spread(20, 22, 2, (i) => 10 + (50 * i) / 19));
  assert.equal(row.trendMilliohmsPerMonth, null, 'unphysical +slope must not publish');
  assert.ok(row.trendR2 != null && row.trendR2 > 0.9, 'r² alone did not gate it — the ceiling did');
});

test('F27 — the ceiling nulls a NEGATIVE unphysical slope too (the exact live −74.46 mΩ/mo defect)', () => {
  // 60 → 10 mΩ over 20 days = −75 mΩ/mo, r² ≈ 1. The live bug that motivated
  // F27 was a NEGATIVE slope; the ceiling must be two-sided (Math.abs), not a
  // one-directional >5 test. Mutation M5 (dropping the abs) survives every
  // POSITIVE-slope ceiling fixture — this is the guard that kills it.
  const row = run('SN-F27-CEIL-NEG', spread(20, 22, 2, (i) => 60 - (50 * i) / 19));
  assert.equal(row.trendMilliohmsPerMonth, null, 'unphysical −slope must not publish either');
  assert.ok(row.trendR2 != null && row.trendR2 > 0.9, 'r² is high — only the two-sided ceiling gates it');
});

test('F27 — a one-burst cluster (span < 14 d) with a PLAUSIBLE slope is gated by span alone', () => {
  // 6 → 6.5 mΩ over 5 days ≈ +3 mΩ/mo: within the ±5 ceiling and r² ≈ 1, so
  // ONLY the 14-day span gate can null it. (The earlier +9 mΩ/mo fixture was
  // dead-covered by the ceiling — mutation M4 survived it; this isolates span.)
  const row = run('SN-F27-SPAN', spread(15, 6, 1, (i) => 6 + (0.5 * i) / 14));
  assert.equal(row.status, 'tracking');
  assert.ok(row.trendR2 != null && row.trendR2 > 0.9, 'clean fit — not gated by r²');
  assert.equal(row.trendMilliohmsPerMonth, null, 'a 5-day burst must not publish a /month slope');
});

test('F27 — baseline requires pre-recent samples: an all-recent series reads baseline null', () => {
  // All 16 events inside the last 6 days — the old first-30%-floor-10 slice
  // would have called the same points "baseline" and compared them to themselves.
  // (16 events = 32 raw V/A points, clearing the 30-point no-data floor.)
  const row = run('SN-F27-SELF', spread(16, 6, 1, () => 8));
  assert.equal(row.status, 'tracking');
  assert.ok(row.recentMilliohms != null);
  assert.equal(row.baselineMilliohms, null, 'no pre-recent data → no baseline');
});

test('F27 — baseline comes from the OLD cohort only, so drift is measurable', () => {
  // Old cohort (25-15 d ago) at 6 mΩ; recent cohort (last 5 d) at 10 mΩ.
  const evts = [...spread(10, 25, 15, () => 6), ...spread(10, 5, 1, () => 10)];
  const row = run('SN-F27-DRIFT', evts);
  assert.ok(Math.abs((row.baselineMilliohms ?? 0) - 6) < 0.5, `baseline from the old cohort (${row.baselineMilliohms})`);
  assert.ok(Math.abs((row.recentMilliohms ?? 0) - 10) < 0.5, `recent from the new cohort (${row.recentMilliohms})`);
});

test('F27 — the IR_BASELINE_MIN_SAMPLES floor rejects a 1-4 pre-recent cohort (boundary)', () => {
  // EXACTLY 4 pre-recent samples + 11 recent: enough total to reach 'tracking'
  // (15 events = 30 raw points, 15 accepted ≥ 10), but the old cohort is below
  // IR_BASELINE_MIN_SAMPLES=5, so a 1-point baseline must NOT be published.
  // (Mutation M7 — dropping the floor to 0 — survives the 0-pre-recent and
  //  10-pre-recent tests; only this 1-4 boundary exercises the gate itself.)
  const evts = [...spread(4, 25, 15, () => 6), ...spread(11, 5, 1, () => 10)];
  const row = run('SN-F27-BASE4', evts);
  assert.equal(row.status, 'tracking');
  assert.ok(row.recentMilliohms != null, 'the 11 recent samples still set recent R');
  assert.equal(row.baselineMilliohms, null, '4 pre-recent samples (< 5) must not form a baseline');
});
