import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeChargeCurveFingerprint } from '../src/analytics.js';

/**
 * v1.171.0 — the hourly pack scan is BUCKETED.
 *
 * Log audit 2026-09-20: computeChargeCurveFingerprint read every raw sample of three
 * metrics, per pack, per Core, over 200 days, and pinned the single analytics worker for
 * 16-20 s every hour. An alert-monitor tick landing in that stall waited it out and the
 * next tick was dropped by the re-entrancy guard, so alarm latency doubled to ~40 s.
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

test('★★★ the 200-day pack scan asks the recorder to bucket — never raw samples', () => {
  calls.length = 0;
  computeChargeCurveFingerprint(devices, recorder);
  assert.ok(calls.length >= 1, 'the scan ran');
  for (const c of calls) {
    assert.equal(c.bucketSec, 60, `queryMulti(${c.metrics.join(',')}) must pass the bucket — unbucketed is the 16-20 s stall`);
    assert.equal(c.metrics.length, 3, 'still one round-trip for soc + vol_max_mv + pack_in');
  }
  assert.equal(calls.length, 2, 'one query per pack');
  // The scan window is unchanged — this release only changes HOW the rows are read.
  const spanDays = (calls[0].untilMs - calls[0].sinceMs) / 86_400_000;
  assert.ok(Math.abs(spanDays - 200) < 0.01, `span stays 200 days, got ${spanDays}`);
});
