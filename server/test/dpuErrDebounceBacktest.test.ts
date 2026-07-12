/**
 * v1.11.0 — engine-review fixes F8 (dpu-err reconnect debounce) + F24 (honest
 * backtest integration + real-model scoring).
 *
 * F8: an SHP2/DPU cloud reconnect blips sysErrCode nonzero for 20-160s then
 * clears (07-02 fired two false CRITICAL "Inverter error code" alerts → HA
 * critical_alerts sensor stepped to 2). computeAlerts now holds the CRITICAL
 * until the SAME code has stood for DPU_ERR_DEBOUNCE_MS (3 min).
 *
 * F24: backtestPvForecast dropped production across >10-min gaps, under-counting
 * actuals and inflating the reported over-forecast bias; this pins that a gap is
 * now trapezoid-integrated (no zero-fill).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAlerts, type Alert } from '../src/alerts.js';
import { backtestPvForecast } from '../src/backtest.js';
import type { DeviceSnapshot } from '../src/snapshot.js';
import type { Recorder } from '../src/recorder.js';

const now = Date.now();
const MIN = 60_000;

function dpu(sysErrCode: number): Record<string, DeviceSnapshot> {
  return {
    'DPU-1': {
      sn: 'DPU-1', deviceName: 'Core 1', productName: 'Delta Pro Ultra',
      online: true, lastUpdated: now,
      projection: {
        kind: 'dpu', soc: 95, packs: [],
        pvHighWatts: 0, pvLowWatts: 0, pvTotalWatts: 0,
        pvHighVolts: 0, pvHighAmps: 0, pvLowVolts: 0, pvLowAmps: 0,
        pvHighErrCode: 0, pvLowErrCode: 0,
        acInWatts: 0, acOutWatts: 0, totalInWatts: 0, totalOutWatts: 0,
        batVol: 53, batAmp: 0, mpptHvTemp: 35, mpptLvTemp: 35,
        splitPhase: { L11: null, L12: null, L14: null, L21: null, L22: null },
        sysErrCode, emsParaVolMaxMv: 58_000, emsParaVolMinMv: 42_000,
        chgMaxSoc: 100, dsgMinSoc: 10,
      } as any,
    } as DeviceSnapshot,
  };
}

function conn(dpuErrOnsetBySn: Map<string, { code: number; sinceMs: number }>) {
  return { lastDeviceListAttemptAt: now, lastDeviceListSuccessAt: now, perDevice: new Map(), dpuErrOnsetBySn };
}

const dpuErr = (a: Alert[]) => a.find((x) => x.id === 'dpu-err-DPU-1');

/* ── F8: dpu-err debounce ──────────────────────────────────────────────── */

test('dpu-err — a fresh error (< 3 min) is SUPPRESSED (reconnect blip never reaches HA criticals)', () => {
  const alerts = computeAlerts(dpu(1), conn(new Map([['DPU-1', { code: 1, sinceMs: now - 30_000 }]])));
  assert.equal(dpuErr(alerts), undefined);
});

test('dpu-err — a SUSTAINED error (> 3 min) fires the CRITICAL', () => {
  const alerts = computeAlerts(dpu(1), conn(new Map([['DPU-1', { code: 1, sinceMs: now - 4 * MIN }]])));
  const a = dpuErr(alerts);
  assert.ok(a);
  assert.equal(a!.severity, 'critical');
});

test('dpu-err — a code CHANGE re-baselines: the new code must serve its own debounce', () => {
  // Store tracked code 1 since 10 min ago, but the live projection now shows code 7.
  // The onset.code (1) ≠ live code (7) → not debounced-eligible → treated as a
  // fresh appearance the store will re-baseline; the alert holds until it does.
  const alerts = computeAlerts(dpu(7), conn(new Map([['DPU-1', { code: 7, sinceMs: now - 10_000 }]])));
  assert.equal(dpuErr(alerts), undefined, 'the newly-appeared code 7 is still within its own debounce');
});

test('dpu-err — no onset context (older callers/tests) fires immediately — never silently loses a real fault', () => {
  const alerts = computeAlerts(dpu(1)); // no connectivity arg at all
  assert.ok(dpuErr(alerts), 'back-compat: unguarded path still fires');
});

test('dpu-err — sysErrCode 0 never fires regardless of context', () => {
  assert.equal(dpuErr(computeAlerts(dpu(0), conn(new Map()))), undefined);
});

/* ── F24: backtest no longer zero-fills gaps ───────────────────────────── */

/** A minimal Recorder stub returning a fixed pv_total series. */
function recorderWith(series: Array<{ ts: number; value: number }>): Recorder {
  return {
    query: (_sn: string, metric: string) => (metric === 'pv_total' ? series : []),
  } as unknown as Recorder;
}

test('backtestPvForecast — a >10-min intra-hour gap is trapezoid-integrated, NOT scored as zero production', () => {
  // One hour: a steady 1000 W reading at :00 and :30 (a 30-min gap between them).
  // Old gap-skip: the 30-min interval > 10 min was dropped → actual 0 Wh.
  // Fixed: trapezoid 1000 W × 0.5 h = 500 Wh.
  // The backtest hour windows are [now - h·1h, now - h·1h + 1h] (relative to
  // `now`, not epoch-aligned), so anchor the fixture the same way.
  const hourStart = now - 2 * 3_600_000;
  const series = [
    { ts: hourStart + 60_000, value: 1000 },
    { ts: hourStart + 31 * MIN, value: 1000 },
  ];
  const score = backtestPvForecast({
    recorder: recorderWith(series),
    dpuSns: ['DPU-1'],
    hoursBack: 3,
    predict: () => 0, // predict 0 so `bias = pred − act = −actual` exposes the actual
    nowMs: now,
  });
  // The gap hour's actual ≈ 500 Wh (1000 W × 0.5 h). With predict=0, bias =
  // mean(pred − act) is NEGATIVE and MAE is nonzero. Under the OLD gap-skip that
  // hour scored 0 Wh, so mae/bias would be 0 across all three sampled hours.
  assert.ok(score.mae > 100, `gap production recovered into actuals (mae=${score.mae.toFixed(0)}, was 0 under the old skip)`);
  assert.ok(score.bias < -100, `over-forecast bias no longer inflated by dropped production (bias=${score.bias.toFixed(0)})`);
});
