import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRunway, RUNWAY_DISCHARGE_EFFICIENCY, resetRunwayCache } from '../src/analytics.js';
import type { Recorder } from '../src/recorder.js';
import type { DeviceSnapshot } from '../src/snapshot.js';
import type { DayForecast } from '../src/analytics.js';

/* ═══════════════════════════════════════════════════════════════════════════
 * runwayDischargeEfficiency — the v1.26.0 (accuracy-audit) ALARM-SAFETY contract.
 *
 * The depletion sim tracks the DC battery POOL but was subtracting the DELIVERED
 * home load, ignoring the DC→AC discharge conversion loss. To deliver 1 kWh at the
 * panel the pack gives up 1/η_dis kWh, so the pool drains ~6% faster than the raw
 * load implies — the pre-v1.26 sim read the runway LONG (optimistic), the unsafe
 * direction for an islanding countdown. Live-confirmed 2026-07-14: the pack drew
 * 6.22 kW gross for 5.88 kW delivered — ratio 0.945, the pack-terminal→AC
 * discharge-conversion LEG (v1.32.0: NOT the pack-plane RTE, which it merely
 * numerically coincided with that day; see rteIntegrity.test.ts).
 *
 * This pins: (1) η is in the conservative sub-unity band; (2) an overnight
 * (PV≈0) deficit reaches reserve/empty FASTER by exactly the η factor vs a naive
 * pool/load; (3) the adjustment only ever SHORTENS the countdown — a strict safety
 * improvement, never optimistic.
 * ═════════════════════════════════════════════════════════════════════════ */

const HOUR = 3_600_000;

function shp2(remainingKwh: number, reserveKwh: number, fullKwh: number): Record<string, DeviceSnapshot> {
  const reservePct = Math.round((reserveKwh / fullKwh) * 100);
  return {
    'SN-SHP2': {
      sn: 'SN-SHP2', deviceName: 'Smart Home Panel 2', online: true, lastSeenMs: 0,
      projection: {
        kind: 'shp2',
        backupRemainWh: remainingKwh * 1000,
        backupFullCapWh: fullKwh * 1000,
        backupReserveSoc: reservePct,
        circuits: [],
      } as any,
    } as any,
  };
}

/** Recorder whose panel_load window is a constant loadW (≥2 pts so it is trusted
 *  and the leading-hour observed-load blend is a no-op against the forecast). */
function loadRecorder(loadW: number): Recorder {
  const pts = [{ ts: -HOUR / 2, value: loadW }, { ts: -1, value: loadW }];
  return {
    insertSnapshot: () => {}, query: (_sn, metric) => (metric === 'panel_load' ? pts : []),
    queryMulti: () => new Map(), listMetrics: () => [], listLifetimeKeys: () => [],
    close: () => {}, rollupLifetime: () => {}, getLifetimeTotals: () => ({}),
  } as unknown as Recorder;
}

/** Islanded forecast with constant PV (DC) and delivered load (AC) every hour. */
function islanded(pvW: number, loadW: number): DayForecast {
  const hours = Array.from({ length: 24 }, (_, k) => ({
    ts: k * HOUR,
    forecastPvW: pvW,
    forecastLoadW: loadW,
    projectedSocPct: null,
  }));
  return { minProjectedSoc: 0, reserveSoc: 25, hours } as unknown as DayForecast;
}
const overnight = (loadW: number) => islanded(0, loadW);

test('v1.26.0 — RUNWAY_DISCHARGE_EFFICIENCY is a conservative sub-unity constant in [0.80,1.0)', () => {
  assert.ok(RUNWAY_DISCHARGE_EFFICIENCY > 0.8 && RUNWAY_DISCHARGE_EFFICIENCY < 1.0,
    `η must be in the guarded band and < 1 so the loss actually shortens the countdown (got ${RUNWAY_DISCHARGE_EFFICIENCY})`);
});

test('v1.26.0 — an overnight deficit reaches reserve by the η factor sooner than naive pool/load', () => {
  resetRunwayCache();
  // 40 kWh usable above reserve; reserve 23.04 of 92.16 full; 4 kW delivered overnight.
  const full = 92.16, reserve = 23.04, remaining = 63.04;
  const loadKw = 4;
  const r = computeRunway(shp2(remaining, reserve, full), loadRecorder(loadKw * 1000), overnight(loadKw * 1000));
  assert.ok(r.hoursToReserve != null, 'reserve crossing must be found within the horizon');
  const naive = (remaining - reserve) / loadKw;           // 10.0 h at 100% efficiency
  const expected = naive * RUNWAY_DISCHARGE_EFFICIENCY;    // 10 · η
  assert.ok(Math.abs(r.hoursToReserve! - expected) < 0.15,
    `hoursToReserve should be ~${expected.toFixed(2)}h (naive ${naive}h × η); got ${r.hoursToReserve}`);
  assert.ok(r.hoursToReserve! < naive,
    `corrected runway must be SHORTER than the naive optimistic ${naive}h (got ${r.hoursToReserve})`);
});

test('v1.26.0 — time-to-empty is also shortened by the discharge loss (never optimistic)', () => {
  resetRunwayCache();
  const full = 92.16, reserve = 0, remaining = 24;        // run all the way to 0
  const loadKw = 4;
  const r = computeRunway(shp2(remaining, reserve, full), loadRecorder(loadKw * 1000), overnight(loadKw * 1000));
  assert.ok(r.hoursToEmpty != null, 'empty crossing must be found');
  const naive = remaining / loadKw;                        // 6.0 h at 100% efficiency
  assert.ok(r.hoursToEmpty! < naive + 1e-6,
    `time-to-empty must not exceed the naive ${naive}h (got ${r.hoursToEmpty})`);
  assert.ok(Math.abs(r.hoursToEmpty! - naive * RUNWAY_DISCHARGE_EFFICIENCY) < 0.15,
    `time-to-empty should be ~${(naive * RUNWAY_DISCHARGE_EFFICIENCY).toFixed(2)}h; got ${r.hoursToEmpty}`);
});

/* ── PV>0 deficit: the pool drains on the DC-bus balance pv − load/η, NOT the
 *    seductive (pv−load)/η that also divides the PV credit by η. These cases
 *    only fire when PV>0 (the all-zero cases above cannot distinguish them). ── */

test('v1.26.0 — pv==load still DRAINS (the pack pays the inverter tax); (pv−load)/η would wrongly read flat/never-empty', () => {
  resetRunwayCache();
  // pv (DC) == load (AC) == 10 kW. Real DC-bus drain = pv − load/η = 10·(1 − 1/η)
  // ≈ −0.638 kW/h. The rejected (pv−load)/η formula gives 0 ⇒ pool flat ⇒ hoursToEmpty
  // null (a fully suppressed depletion crossing) — the exact optimism this pins out.
  const full = 92.16, reserve = 0, remaining = 10;
  const kw = 10;
  const r = computeRunway(shp2(remaining, reserve, full), loadRecorder(kw * 1000), islanded(kw * 1000, kw * 1000));
  assert.ok(r.hoursToEmpty != null, 'pv==load MUST still project depletion — not null (that is the suppressed-crossing bug)');
  const drainKw = kw / RUNWAY_DISCHARGE_EFFICIENCY - kw;    // load/η − pv
  const expected = remaining / drainKw;                    // ≈ 15.7 h
  assert.ok(Math.abs(r.hoursToEmpty! - expected) < 0.3,
    `hoursToEmpty should be ~${expected.toFixed(1)}h (drain = load/η − pv); got ${r.hoursToEmpty}`);
});

test('v1.26.0 — daytime partial-cloud deficit uses pv − load/η, not (pv−load)/η (PV not over-credited)', () => {
  resetRunwayCache();
  // Islanded, partial cloud: PV 2 kW (DC), load 5 kW (AC). 30 kWh above reserve.
  const full = 92.16, reserve = 23.04, remaining = 53.04;  // 30 kWh usable
  const r = computeRunway(shp2(remaining, reserve, full), loadRecorder(5000), islanded(2000, 5000));
  assert.ok(r.hoursToReserve != null, 'a daytime deficit still crosses reserve');
  const correctDrainKw = 5 / RUNWAY_DISCHARGE_EFFICIENCY - 2;   // load/η − pv ≈ 3.319
  const correct = 30 / correctDrainKw;                          // ≈ 9.0 h
  const buggyDrainKw = (5 - 2) / RUNWAY_DISCHARGE_EFFICIENCY;    // (load−pv)/η ≈ 3.191
  const buggy = 30 / buggyDrainKw;                              // ≈ 9.4 h (optimistic)
  assert.ok(Math.abs(r.hoursToReserve! - correct) < 0.3,
    `hoursToReserve should be ~${correct.toFixed(1)}h (drain load/η − pv); got ${r.hoursToReserve}`);
  assert.ok(r.hoursToReserve! < buggy - 0.15,
    `must be shorter than the (pv−load)/η value ${buggy.toFixed(1)}h that over-credits PV; got ${r.hoursToReserve}`);
});
