import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRoundTripEfficiency, resetRteCache } from '../src/analytics.js';
import { startOfLocalDayMs } from '../src/aggregator.js';
import type { Recorder } from '../src/recorder.js';
import type { DeviceSnapshot } from '../src/snapshot.js';

// v0.65.0 — extended-lookback backstop for round-trip efficiency. On a sustained
// net-discharge stretch (the live drawdown: SoC→29%, 7-day discharge 334.78 > charge
// 311.93 kWh) EVERY day falls outside the [0.80, 1.05] round-trip band, so the gated
// 7-day aggregate is null and the HA sensor reads 'unknown' while the home is plainly
// still cycling. Rather than fabricate a number (this stack publishes null over a guess),
// the lookback extends to find the most recent REAL balanced cycles. These tests pin both
// the extension firing AND the healthy case staying unextended.

/* ─── fixtures (mirrors analyticsHealthFixes.test.ts; helpers are file-local there) ─── */

function oneDpuOnePack(sn = 'SN-RTE-EXT'): Record<string, DeviceSnapshot> {
  return {
    [sn]: {
      sn,
      deviceName: 'DELTA-PRO-ULTRA-1',
      online: true,
      lastSeenMs: Date.now(),
      projection: {
        kind: 'dpu',
        soc: 80,
        pvTotalWatts: 0, pvHighWatts: 0, pvLowWatts: 0,
        pvHighVolts: 0, pvHighAmps: 0, pvLowVolts: 0, pvLowAmps: 0,
        acInWatts: 0, acOutWatts: 0, totalInWatts: 0, totalOutWatts: 0,
        batVol: 0, batAmp: 0, mpptHvTemp: 0, mpptLvTemp: 0,
        packs: [{
          num: 1, soc: 80, temp: 25, inputWatts: 0, outputWatts: 0,
          maxCellTemp: 25, minCellTemp: 25, soh: 100, cycles: 50,
        }],
      } as any,
    } as any,
  };
}

function recorderFor(series: Record<string, Array<{ ts: number; value: number }>>): Recorder {
  return {
    insertSnapshot: () => {},
    query: (_sn: string, metric: string) => series[metric] ?? [],
    queryMulti: (_sn: string, metrics: string[]) => {
      const m = new Map<string, Array<{ ts: number; value: number }>>();
      for (const k of metrics) m.set(k, series[k] ?? []);
      return m;
    },
    listMetrics: () => [],
    close: () => {},
    rollupLifetime: () => {},
    getLifetimeTotals: () => ({}),
  } as unknown as Recorder;
}

function flat(startMs: number, spanMs: number, watts: number, stepMin = 5): Array<{ ts: number; value: number }> {
  const out: Array<{ ts: number; value: number }> = [];
  const step = stepMin * 60_000;
  for (let t = startMs; t <= startMs + spanMs; t += step) out.push({ ts: t, value: watts });
  return out;
}

const DAY = 86_400_000;

test('computeRoundTripEfficiency — extends the lookback when the primary window is all net-discharge', () => {
  resetRteCache();
  const todayStart = startOfLocalDayMs();
  // 30 days of data: the most recent 7 (days 0..6) net-DRAIN (discharge 1200 W vs
  // charge 1000 W → ratio 1.20, outside the band on EVERY day) so a 7-day window finds
  // NO balanced day → effPct null (the live defect). Days 7..29 are balanced round-trips
  // (discharge 950 vs charge 1000 → ~95%).
  const inSamples: Array<{ ts: number; value: number }> = [];
  const outSamples: Array<{ ts: number; value: number }> = [];
  for (let d = 29; d >= 0; d--) {
    const dayStart = todayStart - d * DAY;
    inSamples.push(...flat(dayStart, DAY, 1000));
    outSamples.push(...flat(dayStart, DAY, d <= 6 ? 1200 : 950));
  }
  const rte = computeRoundTripEfficiency(
    oneDpuOnePack(),
    recorderFor({ pack1_in: inSamples, pack1_out: outSamples }),
    7,
  );

  assert.notEqual(rte.efficiencyPct, null, 'RTE must not go dead while the home is still cycling');
  assert.equal(rte.windowDays, 30, 'the result is labelled with the extended (30-day) window');
  assert.ok(
    rte.efficiencyPct! > 90 && rte.efficiencyPct! <= 100,
    `extended RTE reflects the real ~95% balanced cycles, never >100%, got ${rte.efficiencyPct}`,
  );
});

test('computeRoundTripEfficiency — does NOT extend when the primary window already has a balanced day', () => {
  resetRteCache();
  const todayStart = startOfLocalDayMs();
  // One balanced day inside the 3-day primary window → gated aggregate is non-null, so
  // the extended-lookback backstop stays dormant and windowDays is the requested 3.
  const balDay = todayStart - 1 * DAY;
  const rte = computeRoundTripEfficiency(
    oneDpuOnePack(),
    recorderFor({ pack1_in: flat(balDay, DAY, 1000), pack1_out: flat(balDay, DAY, 950) }),
    3,
  );
  assert.equal(rte.windowDays, 3, 'a healthy primary window is NOT extended');
  assert.ok(
    rte.efficiencyPct != null && rte.efficiencyPct > 90 && rte.efficiencyPct <= 100,
    `~95% preserved, got ${rte.efficiencyPct}`,
  );
});

test('computeRoundTripEfficiency — stays honestly null when NO balanced day exists even in the wide window', () => {
  resetRteCache();
  const todayStart = startOfLocalDayMs();
  // 30 days of pure net-drain (ratio 1.20 every day) → no balanced day anywhere → the
  // extended window also finds nothing → honest null (never a fabricated number).
  const inSamples: Array<{ ts: number; value: number }> = [];
  const outSamples: Array<{ ts: number; value: number }> = [];
  for (let d = 29; d >= 0; d--) {
    const dayStart = todayStart - d * DAY;
    inSamples.push(...flat(dayStart, DAY, 1000));
    outSamples.push(...flat(dayStart, DAY, 1200));
  }
  const rte = computeRoundTripEfficiency(
    oneDpuOnePack(),
    recorderFor({ pack1_in: inSamples, pack1_out: outSamples }),
    7,
  );
  assert.equal(rte.efficiencyPct, null, 'with no balanced day anywhere, RTE is honestly null — not fabricated');
});
