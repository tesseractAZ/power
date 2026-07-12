import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backtestPvForecast, sliceByTsInclusive, scoreForecast, type BacktestScore } from '../src/backtest.js';

/* ===================================================================
 * v0.21.0 — proof that batching the backtest N+1 query loop is
 * BIT-IDENTICAL to the old one-query-per-hour loop.
 *
 * The new backtestPvForecast fetches each DPU's full pv_total series
 * once and slices each hour with sliceByTsInclusive (inclusive both
 * ends, mirroring the recorder's `ts >= ? AND ts <= ?`). This test
 * reimplements the OLD per-hour loop verbatim as a reference and
 * asserts the two produce deep-equal scores on synthetic data that
 * exercises the tricky cases: samples exactly on hour boundaries,
 * gaps > 10 min, and hours with < 2 samples.
 * =================================================================== */

const HOUR = 3_600_000;
const MIN = 60_000;

type Pt = { ts: number; value: number };

/** A recorder whose query() reproduces the real recorder's inclusive bounds. */
function mockRecorder(seriesBySn: Record<string, Pt[]>) {
  return {
    query(sn: string, _metric: string, start: number, end: number): Pt[] {
      return (seriesBySn[sn] ?? []).filter((p) => p.ts >= start && p.ts <= end); // already ts-ASC
    },
  } as any;
}

/** Verbatim copy of the PRE-v0.21.0 per-hour loop — the reference. */
function backtestOld(inputs: {
  recorder: any; dpuSns: string[]; hoursBack?: number; predict: (hs: number) => number; nowMs: number;
}): BacktestScore {
  const hoursBack = inputs.hoursBack ?? 168;
  const now = inputs.nowMs;
  const data: { ts: number; predicted: number; actual: number }[] = [];
  for (let h = hoursBack; h >= 1; h--) {
    const hourStartMs = now - h * HOUR;
    const hourEndMs = hourStartMs + HOUR;
    let actualWh = 0;
    for (const sn of inputs.dpuSns) {
      const pts = inputs.recorder.query(sn, 'pv_total', hourStartMs, hourEndMs) as Pt[];
      if (pts.length < 2) continue;
      for (let i = 1; i < pts.length; i++) {
        const dtMs = pts[i].ts - pts[i - 1].ts;
        // v1.11.0 (review F24) — the gap-skip was removed from backtestPvForecast
        // (it under-counted actuals over recorder gaps → inflated over-forecast
        // bias). This reference mirrors the corrected full-trapezoid integration.
        const avg = (pts[i].value + pts[i - 1].value) / 2;
        actualWh += (avg * dtMs) / HOUR;
      }
    }
    const predictedWh = inputs.predict(hourStartMs);
    if (Number.isFinite(predictedWh) && Number.isFinite(actualWh)) {
      data.push({ ts: hourStartMs, predicted: predictedWh, actual: actualWh });
    }
  }
  return scoreForecast(data);
}

test('sliceByTsInclusive matches a filter reference (incl. boundaries + empty)', () => {
  const pts: Pt[] = [10, 20, 30, 40, 50].map((t) => ({ ts: t, value: t }));
  const ref = (a: number, b: number) => pts.filter((p) => p.ts >= a && p.ts <= b);
  for (const [a, b] of [[0, 100], [20, 40], [20, 20], [25, 35], [50, 50], [60, 70], [0, 5]] as const) {
    assert.deepEqual(sliceByTsInclusive(pts, a, b), ref(a, b), `[${a},${b}]`);
  }
  assert.deepEqual(sliceByTsInclusive([], 0, 10), []);
});

test('backtestPvForecast (batched) === the old per-hour loop, bit-for-bit', () => {
  // nowMs aligned to an hour so boundary timestamps are clean multiples.
  const now = 100_000 * HOUR;
  const A: Pt[] = [
    { ts: now - 6 * HOUR + 10 * MIN, value: 100 }, // h6
    { ts: now - 6 * HOUR + 20 * MIN, value: 120 }, // h6
    { ts: now - 5 * HOUR, value: 200 },            // BOUNDARY: last of h6 AND first of h5
    { ts: now - 5 * HOUR + 30 * MIN, value: 220 }, // h5  (gap to next is 80min >10min)
    { ts: now - 4 * HOUR + 50 * MIN, value: 300 }, // h4  (only sample in h4 → <2 → skipped)
    { ts: now - 3 * HOUR + 5 * MIN, value: 400 },  // h3
    { ts: now - 3 * HOUR + 15 * MIN, value: 420 }, // h3
    { ts: now - 1 * HOUR + 30 * MIN, value: 500 }, // h1  (h2 empty)
    { ts: now, value: 540 },                        // BOUNDARY at the very end (last of h1)
  ];
  const B: Pt[] = [
    { ts: now - 5 * HOUR, value: 1000 },           // shares the h6/h5 boundary
    { ts: now - 5 * HOUR + 10 * MIN, value: 1100 },
    { ts: now - 5 * HOUR + 20 * MIN, value: 1150 },
  ];
  const recorder = mockRecorder({ A, B });
  const predict = (hs: number) => 50 + ((hs / HOUR) % 7) * 37; // deterministic, varied
  const inputs = { recorder, dpuSns: ['A', 'B'], hoursBack: 6, predict, nowMs: now };

  const fresh = backtestPvForecast(inputs);
  const ref = backtestOld(inputs);
  assert.deepEqual(fresh, ref, 'batched score must equal the per-hour reference exactly');
  assert.ok(fresh.n > 0, 'sanity: the fixture produced scored hours');
});

test('backtestPvForecast — a DPU with no series and the empty fleet behave identically', () => {
  const now = 100_000 * HOUR;
  const recorder = mockRecorder({});
  const predict = (hs: number) => (hs / HOUR) % 3;
  const inputs = { recorder, dpuSns: ['X'], hoursBack: 4, predict, nowMs: now };
  assert.deepEqual(backtestPvForecast(inputs), backtestOld(inputs));
});
