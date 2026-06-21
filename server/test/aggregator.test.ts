import { test } from 'node:test';
import assert from 'node:assert/strict';
import { integrateWh, startOfLocalDayMs, circuitHistoryByDay, computeTotals } from '../src/aggregator.js';
import type { Recorder } from '../src/recorder.js';
import type { SnapshotStore } from '../src/snapshot.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

/**
 * Tests for the trapezoidal kWh integrator + gap behavior. This function
 * underlies every kWh number the dashboard shows (round-trip efficiency,
 * lifetime accumulator, per-circuit history, dispatch planner). A bug
 * here corrupts ALL of those, so the coverage here is deliberately
 * thorough.
 *
 * Note: integrateWh has a `maxGapMs` parameter (default 10 min) — pairs
 * of samples spaced wider than that are NOT integrated (the function
 * refuses to extrapolate over an unknown period). Tests use samples
 * spaced 5 min apart unless they're specifically exercising gap behavior.
 */

const FIVE_MIN = 5 * 60_000;
const ONE_HOUR = 60 * 60_000;

/** Evenly-spaced samples between [t0, t1] at `step` ms, with optional value(ts) function. */
function evenSamples(t0: number, t1: number, step: number, value: number | ((ts: number) => number)) {
  const fn = typeof value === 'function' ? value : () => value;
  const out: Array<{ ts: number; value: number }> = [];
  for (let t = t0; t <= t1; t += step) out.push({ ts: t, value: fn(t) });
  return out;
}

test('integrateWh — empty input returns zero Wh with full gap', () => {
  const r = integrateWh([], 0, ONE_HOUR);
  assert.equal(r.wh, 0);
  assert.equal(r.coverageMs, 0);
  assert.equal(r.gapMs, ONE_HOUR);
  assert.equal(r.samples, 0);
});

test('integrateWh — constant 1000 W over 1 hour = 1000 Wh', () => {
  const r = integrateWh(evenSamples(0, ONE_HOUR, FIVE_MIN, 1000), 0, ONE_HOUR);
  assert.equal(Math.round(r.wh), 1000);
  assert.equal(r.coverageMs, ONE_HOUR);
});

test('integrateWh — trapezoidal: linear ramp 0→2000 W over 1 hour ≈ 1000 Wh', () => {
  const r = integrateWh(
    evenSamples(0, ONE_HOUR, FIVE_MIN, (ts) => (ts / ONE_HOUR) * 2000),
    0,
    ONE_HOUR,
  );
  // Trapezoidal area under a linear ramp from 0 to 2000W over 1h = 1000 Wh.
  assert.equal(Math.round(r.wh), 1000);
});

test('integrateWh — gap larger than maxGapMs (default 10 min) is NOT integrated', () => {
  // Two samples 30 minutes apart at 1000 W. The single trapezoid spans
  // 30 min > 10-min maxGap, so the function refuses to integrate it.
  const r = integrateWh(
    [
      { ts: 0, value: 1000 },
      { ts: 30 * 60_000, value: 1000 },
    ],
    0,
    30 * 60_000,
  );
  assert.equal(r.wh, 0);
  assert.equal(r.coverageMs, 0);
});

test('integrateWh — leading anchor extends value into window when within maxGapMs', () => {
  // Anchor sample 5 min before window (within default 10-min maxGap), then
  // closely-spaced samples inside the window at constant 500 W. The anchor
  // should hold the value to window-start so the leading bucket integrates.
  const points = [
    { ts: -FIVE_MIN, value: 500 },
    ...evenSamples(0, ONE_HOUR, FIVE_MIN, 500),
  ];
  const r = integrateWh(points, 0, ONE_HOUR);
  // 500 W constant for 1 hour = 500 Wh
  assert.equal(Math.round(r.wh), 500);
  assert.equal(r.coverageMs, ONE_HOUR);
});

test('integrateWh — coverage reflects partial-window samples', () => {
  // Closely-spaced samples covering only the middle 20 min of a 60-min
  // window. Should integrate ~200 Wh (600 W × 20 min) with coverage
  // ~ 30 min (20 min spanned by samples + ~10 min held to window-end if
  // tail is within maxGap... actually 60 - 40 = 20 min > 10 min, so no
  // tail extension; coverage should be ~ 20 min).
  const r = integrateWh(
    evenSamples(20 * 60_000, 40 * 60_000, FIVE_MIN, 600),
    0,
    ONE_HOUR,
  );
  // 600W × (20min/60min) of the hour = 200 Wh
  assert.equal(Math.round(r.wh), 200);
  // Coverage = the 20-min span; no leading anchor, no trailing extend (20min
  // gap to untilMs is over maxGap).
  assert.equal(r.coverageMs, 20 * 60_000);
  assert.equal(r.gapMs, ONE_HOUR - 20 * 60_000);
});

test('integrateWh — trailing sample extends to window end when within maxGapMs', () => {
  // Samples cover only the first ~30 min, last sample is 5 min before
  // window end — within maxGap, so value should be held to window-end.
  const points = evenSamples(0, ONE_HOUR - FIVE_MIN, FIVE_MIN, 1000);
  const r = integrateWh(points, 0, ONE_HOUR);
  // 1000 W constant for the full hour (held to end) = 1000 Wh
  assert.equal(Math.round(r.wh), 1000);
});

test('startOfLocalDayMs — returns midnight of the local day', () => {
  const ms = startOfLocalDayMs();
  const d = new Date(ms);
  assert.equal(d.getHours(), 0);
  assert.equal(d.getMinutes(), 0);
  assert.equal(d.getSeconds(), 0);
  assert.equal(d.getMilliseconds(), 0);
});

test('startOfLocalDayMs(specific date) — operates on supplied date, not now', () => {
  const input = new Date(2026, 4, 15, 14, 32, 17); // May 15 2026, 2:32:17 PM local
  const ms = startOfLocalDayMs(input);
  const d = new Date(ms);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 4); // May
  assert.equal(d.getDate(), 15);
  assert.equal(d.getHours(), 0);
});

/* ─── circuitHistoryByDay metric override (v0.9.8) ─────────────────────── */

/**
 * Minimal mock Recorder. We only care that `circuitHistoryByDay` queries the
 * right metric — the actual integration math is exercised by the integrateWh
 * tests above, so we just record which (sn, metric) was asked for.
 */
function mockRecorder(byMetric: Record<string, Array<{ ts: number; value: number }>>): Recorder & { lastMetric: string | null } {
  let lastMetric: string | null = null;
  return {
    insertSnapshot: () => {},
    query: (_sn, metric, sinceMs, untilMs) => {
      lastMetric = metric;
      const pts = byMetric[metric] ?? [];
      return pts.filter((p) => p.ts >= sinceMs && p.ts <= untilMs);
    },
    listMetrics: () => Object.keys(byMetric),
    close: () => {},
    rollupLifetime: () => {},
    getLifetimeTotals: () => ({}),
    get lastMetric() { return lastMetric; },
  } as Recorder & { lastMetric: string | null };
}

test('circuitHistoryByDay — defaults to ch${ch}_w metric', () => {
  const rec = mockRecorder({});
  circuitHistoryByDay(rec, 'SN', 10, 1);
  assert.equal(rec.lastMetric, 'ch10_w');
});

test('circuitHistoryByDay — metric override uses pair${primaryCh}_w for paired circuits', () => {
  // Same primary channel (10) but we want the *combined* paired series.
  // This is the v0.9.8 fix that lets CircuitModal show 240 V loads in full.
  const rec = mockRecorder({});
  circuitHistoryByDay(rec, 'SN', 10, 1, 'pair10_w');
  assert.equal(rec.lastMetric, 'pair10_w');
});

test('circuitHistoryByDay — paired metric integrates to combined kWh', () => {
  // Build a 1-hour window of data at 2000 W (~Pool Pump on both legs) for
  // YESTERDAY at midnight → 1 AM. We request days=2 so days[0] is yesterday
  // (with the data) and days[1] is today (empty).
  //
  // v0.9.36 — Using yesterday avoids the "test runs between UTC midnight and
  // 1 AM" failure where today's data window is clipped by `now`, producing
  // partial integration (e.g. 0.899 kWh instead of 2.0). The CI failure on
  // 2026-05-26 00:25 UTC was exactly this — the v0.9.35 release was blocked
  // because of timing.
  const todayStart = startOfLocalDayMs();
  const yesterdayStart = todayStart - 86_400_000;
  const oneHour = 60 * 60_000;
  const fiveMin = 5 * 60_000;
  const pts: Array<{ ts: number; value: number }> = [];
  for (let t = yesterdayStart; t <= yesterdayStart + oneHour; t += fiveMin) {
    pts.push({ ts: t, value: 2000 });
  }
  const rec = mockRecorder({ pair10_w: pts });
  const h = circuitHistoryByDay(rec, 'SN', 10, 2, 'pair10_w');
  assert.equal(h.days.length, 2);
  // days[0] = yesterday (has the data), days[1] = today (empty).
  // ~2 kWh from 2000 W × 1 h. Allow ±0.05 kWh for rounding + clock drift.
  assert.ok(Math.abs(h.days[0].kwh - 2) < 0.05, `expected yesterday ~2 kWh, got ${h.days[0].kwh}`);
  assert.equal(h.days[0].peakW, 2000);
  assert.equal(h.ch, 10); // still keyed by primary leg
});

/* ─── computeTotals fleet.pvCoverage (v0.44.0) ─────────────────────────────
 *
 * The Solar page's "% measured" tile must reflect coverage of the PV series
 * (`pv_total`) ALONE, not the unweighted mean of every recorder metric (grid,
 * load, battery, temps…). This pins that fleet.pvCoverage filters to `pv_total`
 * and therefore diverges from fleet.coverage whenever the non-PV metrics have
 * different coverage. No SHP2 in the snapshot ⇒ membership-unknown fallback
 * counts the lone DPU into the fleet rollup (see shp2Membership.ts).
 */
function oneDpuStore(): SnapshotStore {
  const sn = 'SN-PVCOV';
  const devices: Record<string, DeviceSnapshot> = {
    [sn]: {
      sn,
      deviceName: 'Core 1',
      online: true,
      lastSeenMs: Date.now(),
      projection: {
        kind: 'dpu',
        soc: 80,
        packs: [{ num: 1, soc: 80 }],
      } as any,
    } as any,
  };
  return { get: () => ({ devices }) } as unknown as SnapshotStore;
}

test('computeTotals — fleet.pvCoverage reflects ONLY the PV metric, not the all-metric mean', () => {
  const since = startOfLocalDayMs() - ONE_HOUR; // a clean closed 1-hour window
  const until = startOfLocalDayMs();
  // PV (`pv_total`): dense samples across the WHOLE window → ~full coverage.
  const pvPts = evenSamples(since, until, FIVE_MIN, 1000);
  // Every NON-PV metric computeTotals ingests for a 1-pack DPU: cover only the
  // first half of the window, then stop. integrateWh won't hold the tail to
  // `until` (it's 30 min away, > the 10-min maxGap) → ~0.5 coverage each.
  const halfPts = evenSamples(since, since + ONE_HOUR / 2, FIVE_MIN, 1000);
  const rec = mockRecorder({
    pv_total: pvPts,
    ac_out: halfPts,
    total_in: halfPts,
    total_out: halfPts,
    pack1_in: halfPts,
    pack1_out: halfPts,
  });

  const r = computeTotals(oneDpuStore(), rec, since, until);

  // PV-only coverage tracks the dense pv_total series → ~1.0.
  assert.ok(r.fleet.pvCoverage > 0.98, `pvCoverage ${r.fleet.pvCoverage} should be ~1.0 (PV densely covered)`);
  // All-metric coverage is dragged DOWN by the five half-covered non-PV metrics
  // (mean of [~1.0, 0.5, 0.5, 0.5, 0.5, 0.5] ≈ 0.58) → must be well below pvCoverage.
  assert.ok(r.fleet.coverage < 0.75, `coverage ${r.fleet.coverage} should be diluted by the half-covered non-PV metrics`);
  assert.ok(
    r.fleet.pvCoverage - r.fleet.coverage > 0.2,
    `pvCoverage (${r.fleet.pvCoverage}) must materially exceed all-metric coverage (${r.fleet.coverage}) — proving PV-only filtering`,
  );
});

test('computeTotals — empty pv_total series over a real window ⇒ pvCoverage = 0 (genuine 0% PV, not NaN)', () => {
  const since = startOfLocalDayMs() - ONE_HOUR;
  const until = startOfLocalDayMs();
  const halfPts = evenSamples(since, since + ONE_HOUR / 2, FIVE_MIN, 1000);
  // No pv_total samples, but the window is real, so the DPU's pv_total ingest
  // contributes a 0-coverage observation: that's a true "PV produced no
  // measured data" reading, and pvCoverage should be 0 — NOT carried away by
  // the half-covered non-PV metrics, and never NaN.
  const rec = mockRecorder({
    ac_out: halfPts,
    total_in: halfPts,
    total_out: halfPts,
    pack1_in: halfPts,
    pack1_out: halfPts,
  });

  const r = computeTotals(oneDpuStore(), rec, since, until);

  assert.ok(Number.isFinite(r.fleet.pvCoverage), 'pvCoverage must be finite, never NaN');
  assert.equal(r.fleet.pvCoverage, 0, 'empty pv_total over a real window ⇒ 0% PV coverage');
  // And it still differs from the all-metric coverage (which the non-PV metrics lift above 0).
  assert.ok(r.fleet.coverage > 0, 'all-metric coverage is non-zero (non-PV metrics have data)');
});

test('computeTotals — degenerate zero-width window ⇒ pvCoverage falls back to coverage (both 0, no NaN)', () => {
  // totalMs === 0 ⇒ no metric pushes a coverage observation ⇒ both accums empty.
  // The guard makes pvCoverage fall back to coverage (0) rather than 0/0 = NaN.
  const t = startOfLocalDayMs();
  const rec = mockRecorder({ pv_total: [], ac_out: [], pack1_in: [], pack1_out: [], total_in: [], total_out: [] });
  const r = computeTotals(oneDpuStore(), rec, t, t);
  assert.ok(Number.isFinite(r.fleet.pvCoverage), 'pvCoverage must be finite (guard prevents 0/0 NaN)');
  assert.equal(r.fleet.coverage, 0, 'degenerate window ⇒ all-metric coverage 0');
  assert.equal(r.fleet.pvCoverage, r.fleet.coverage, 'degenerate guard ⇒ pvCoverage === coverage');
});

test('computeTotals — a non-SHP2-connected spare DPU does NOT dilute pvCoverage (Copilot #88)', () => {
  // fleet.pvWh counts only SHP2-connected DPUs; pvCoverage must use the SAME
  // membership. A bench spare with sparse pv_total would otherwise drag the
  // Solar "% measured" tile down below the real (connected) array's coverage.
  const since = startOfLocalDayMs() - ONE_HOUR;
  const until = startOfLocalDayMs();
  const dense = evenSamples(since, until, FIVE_MIN, 1000);                 // ~1.0 coverage
  const half = evenSamples(since, since + ONE_HOUR / 2, FIVE_MIN, 1000);   // ~0.5 coverage
  // Per-SN recorder: connected 'SN-HOME' has dense pv_total; spare 'SN-SPARE' half.
  const rec = {
    insertSnapshot() {}, listMetrics() { return ['pv_total']; }, close() {},
    rollupLifetime() {}, getLifetimeTotals() { return {}; },
    query(sn: string, metric: string, s: number, u: number) {
      const pts = metric === 'pv_total' ? (sn === 'SN-SPARE' ? half : dense) : [];
      return pts.filter((p) => p.ts >= s && p.ts <= u);
    },
  } as unknown as Recorder;
  // SHP2 lists ONLY SN-HOME as a source ⇒ SN-SPARE is a non-connected bench spare.
  const store = {
    get: () => ({
      devices: {
        'SN-HOME': { sn: 'SN-HOME', deviceName: 'Core 1', online: true, projection: { kind: 'dpu', packs: [] } },
        'SN-SPARE': { sn: 'SN-SPARE', deviceName: 'Core 5', online: true, projection: { kind: 'dpu', packs: [] } },
        SHP2: { sn: 'SHP2', deviceName: 'SHP2', online: true, projection: { kind: 'shp2', sources: [{ sn: 'SN-HOME', isConnected: true }], pairedCircuits: [] } },
      },
    }),
  } as unknown as SnapshotStore;
  const r = computeTotals(store, rec, since, until);
  // pvCoverage must track ONLY the connected core's dense pv_total (~1.0), NOT
  // the mean with the spare's 0.5 (which would land ~0.75).
  assert.ok(
    r.fleet.pvCoverage > 0.98,
    `pvCoverage ${r.fleet.pvCoverage} must reflect only the SHP2-connected core (~1.0), not be diluted by the spare`,
  );
});
