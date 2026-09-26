import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeChargeCurveFingerprint, resetChargeCurveCacheForTesting } from '../src/analytics.js';

/**
 * v1.171.0 — the hourly pack scan is BUCKETED.
 *
 * Log audit 2026-09-20: computeChargeCurveFingerprint read every raw sample of three
 * metrics, per pack, per Core, over 200 days, and pinned the single analytics worker for
 * 16-20 s every hour. An alert-monitor tick landing in that stall waited it out and the
 * next tick was dropped by the re-entrancy guard, so alarm latency doubled to ~40 s.
 *
 * v1.186.0 — the bucket alone did not remove the stall (it is a SQL GROUP BY; SQLite still
 * reads every raw row), so the scan is now read in week-long slices with a yield between
 * them. Every slice still asks for the bucket, and the slices together cover the same
 * 200-day window exactly (analyticsWorker.test.ts proves the rows are identical).
 */

const calls: Array<{ sn: string; metrics: string[]; sinceMs: number; untilMs: number; bucketSec?: number }> = [];
const recorder = {
  queryMulti: (sn: string, metrics: string[], sinceMs: number, untilMs: number, bucketSec?: number) => {
    calls.push({ sn, metrics, sinceMs, untilMs, bucketSec });
    return new Map(metrics.map((m) => [m, []]));
  },
} as never;

const devices = {
  SN1: {
    sn: 'SN1', deviceName: 'Core 1', productName: 'DELTA Pro Ultra',
    projection: { kind: 'dpu', packs: [{ num: 1 }, { num: 2 }] },
  },
} as never;

test('★★★ the 200-day pack scan asks the recorder to bucket — never raw samples', async () => {
  calls.length = 0;
  resetChargeCurveCacheForTesting();
  await computeChargeCurveFingerprint(devices, recorder);
  assert.ok(calls.length >= 1, 'the scan ran');
  for (const c of calls) {
    assert.equal(c.bucketSec, 60, `queryMulti(${c.metrics.join(',')}) must pass the bucket — unbucketed is the 16-20 s stall`);
    assert.equal(c.metrics.length, 3, 'still one round-trip per slice for soc + vol_max_mv + pack_in');
  }
  // v1.186.0 — per pack, the slices are contiguous and span the unchanged 200-day window.
  for (const packNum of [1, 2]) {
    const mine = calls.filter((c) => c.metrics[0] === `pack${packNum}_soc`);
    assert.ok(mine.length > 1, `pack ${packNum}: read in slices, got ${mine.length} query`);
    for (let i = 1; i < mine.length; i++) assert.equal(mine[i].sinceMs, mine[i - 1].untilMs + 1, 'no gap, no overlap');
    const spanDays = (mine[mine.length - 1].untilMs - mine[0].sinceMs) / 86_400_000;
    assert.ok(Math.abs(spanDays - 200) < 0.01, `span stays 200 days, got ${spanDays}`);
  }
  resetChargeCurveCacheForTesting();
});
