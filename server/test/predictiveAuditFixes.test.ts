/**
 * v0.41.0 — Predictive Insights accuracy-audit fixes.
 *
 * (1) forecast-runtime alert: the trailing-3h backup-% decline projected a FALSE overnight
 *     depletion (it ignores dawn solar recovery). It must now be gated on the depletion-aware
 *     day forecast — only fire when forecast.minProjectedSoc <= reserve.
 * (2) string-mismatch ratio: compare each DPU to the LEAVE-ONE-OUT median of the OTHER
 *     connected DPUs, never including itself (the self-including median pulls every ratio
 *     toward 1.0 and is degenerate at n=2).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeForecastAlerts,
  resetForecastAlertsCache,
  computeStringMismatch,
  resetStringMismatchCache,
} from '../src/analytics.js';
import type { Recorder } from '../src/recorder.js';
import type { DeviceSnapshot } from '../src/snapshot.js';
import type { DayForecast } from '../src/analytics.js';

/* ─── (1) forecast-runtime depletion gate ─────────────────────────────────── */

function shp2Draining(): Record<string, DeviceSnapshot> {
  return {
    'SN-SHP2': {
      sn: 'SN-SHP2', deviceName: 'Smart Home Panel 2', online: true, lastSeenMs: Date.now(),
      projection: { kind: 'shp2', backupBatPercent: 50, backupReserveSoc: 10, backupFullCapWh: 92_160 } as any,
    } as any,
  };
}
/** Recorder whose backup_pct query returns a clean DECLINING series (≈ −3 %/h).
 *  ≥8 points — linregress returns null below that (thin-trend guard). */
function decliningRecorder(): Recorder {
  const now = Date.now();
  const pts = Array.from({ length: 13 }, (_, i) => ({ ts: now - (12 - i) * 900_000, value: 60 - i * (10 / 12) }));
  return {
    insertSnapshot: () => {}, query: (_sn, metric) => (metric === 'backup_pct' ? pts : []),
    queryMulti: () => new Map(), listMetrics: () => [], listLifetimeKeys: () => [],
    close: () => {}, rollupLifetime: () => {}, getLifetimeTotals: () => ({}),
  } as unknown as Recorder;
}
const fc = (minProjectedSoc: number | null): DayForecast => ({ minProjectedSoc, reserveSoc: 10 } as unknown as DayForecast);
const hasRuntimeAlert = (alerts: { id: string }[]) => alerts.some((a) => a.id.startsWith('forecast-runtime-'));

test('forecast-runtime alert SUPPRESSED when the diurnal forecast projects no depletion', () => {
  resetForecastAlertsCache();
  // Backup % is declining now, but the day forecast says the pool only dips to 30% (> 10% reserve)
  // because solar recovers it at dawn → the trailing-3h false positive must NOT fire.
  const alerts = computeForecastAlerts(shp2Draining(), decliningRecorder(), fc(30));
  assert.equal(hasRuntimeAlert(alerts), false, 'no runtime alert when forecast min SoC stays above reserve');
});

test('forecast-runtime alert FIRES when the diurnal forecast also projects reaching reserve', () => {
  resetForecastAlertsCache();
  const alerts = computeForecastAlerts(shp2Draining(), decliningRecorder(), fc(5)); // 5% <= 10% reserve
  assert.equal(hasRuntimeAlert(alerts), true, 'runtime alert fires when the forecast confirms depletion');
});

test('forecast-runtime alert SUPPRESSED when no forecast is supplied (defensive)', () => {
  resetForecastAlertsCache();
  const alerts = computeForecastAlerts(shp2Draining(), decliningRecorder(), undefined);
  assert.equal(hasRuntimeAlert(alerts), false, 'no depletion confirmation available → do not emit');
});

test('forecast-runtime gate is STRICTLY below reserve — touching the floor exactly does not fire (matches the forecast card)', () => {
  // getDayForecast's own depletion alert uses `minProjectedSoc < reserveSoc`. The runtime
  // gate must use the same strict comparison, or at the exact boundary the forecast card
  // reads "stays above the reserve floor" while this alert fires → cross-card contradiction.
  resetForecastAlertsCache();
  const alerts = computeForecastAlerts(shp2Draining(), decliningRecorder(), fc(10)); // == reserve (10)
  assert.equal(hasRuntimeAlert(alerts), false, 'minProjectedSoc == reserve → not strictly below → suppressed');
});

test('forecast-runtime cache keys on the depletion verdict — a warm suppress-cache must not block a real fire (v0.41.0 Copilot)', () => {
  // The ~10-min cache is time-based; the runtime alert now depends on `forecast`. Without
  // keying the cache on the depletion gate, a call carrying a suppressing forecast caches
  // an empty result that a later depleting-forecast call would wrongly reuse (and vice
  // versa). Exercise the exact sequence WITHOUT resetting the cache between calls.
  resetForecastAlertsCache();
  const rec = decliningRecorder();
  const devs = shp2Draining();
  assert.equal(hasRuntimeAlert(computeForecastAlerts(devs, rec, fc(30))), false, 'warms the cache under gate=false (no depletion)');
  assert.equal(
    hasRuntimeAlert(computeForecastAlerts(devs, rec, fc(5))),
    true,
    'gate flips false→true within the TTL — must recompute and fire, not return the stale suppression',
  );
  assert.equal(
    hasRuntimeAlert(computeForecastAlerts(devs, rec, fc(30))),
    false,
    'gate flips true→false — must recompute and suppress, not return the stale fire alert',
  );
});

/* ─── (2) string-mismatch leave-one-out median ────────────────────────────── */

function pvSamples(value: number): Array<{ ts: number; value: number }> {
  const base = 1_700_000_000_000;
  const out: Array<{ ts: number; value: number }> = [];
  for (const h of [10, 11, 12, 13]) for (let k = 0; k < 3; k++) out.push({ ts: base + h * 3_600_000 + k * 60_000, value });
  return out;
}
function twoDpuFleet(): Record<string, DeviceSnapshot> {
  const dpu = (sn: string): DeviceSnapshot => ({ sn, deviceName: sn, online: true, lastSeenMs: Date.now(), projection: { kind: 'dpu' } as any } as any);
  return {
    'SN-A': dpu('SN-A'),
    'SN-B': dpu('SN-B'),
    'SN-SHP2': { sn: 'SN-SHP2', deviceName: 'SHP2', online: true, lastSeenMs: Date.now(),
      projection: { kind: 'shp2', sources: [{ isConnected: true, sn: 'SN-A' }, { isConnected: true, sn: 'SN-B' }] } as any } as any,
  };
}
function pvRecorder(perSn: Record<string, number>): Recorder {
  return {
    insertSnapshot: () => {}, query: (sn, metric) => (metric === 'pv_total' && perSn[sn] != null ? pvSamples(perSn[sn]) : []),
    queryMulti: () => new Map(), listMetrics: () => [], listLifetimeKeys: () => [],
    close: () => {}, rollupLifetime: () => {}, getLifetimeTotals: () => ({}),
  } as unknown as Recorder;
}

test('string-mismatch ratio is LEAVE-ONE-OUT (self excluded), not self-including', () => {
  resetStringMismatchCache();
  // Core A produces 2000 W, Core B 1000 W. Leave-one-out: A is compared to B alone → ×2.0,
  // B to A alone → ×0.5. The old self-including median([2000,1000])=1500 would give ×1.33 / ×0.67.
  const rep = computeStringMismatch(twoDpuFleet(), pvRecorder({ 'SN-A': 2000, 'SN-B': 1000 }));
  const a = rep.devices.find((d) => d.sn === 'SN-A');
  const b = rep.devices.find((d) => d.sn === 'SN-B');
  assert.ok(a && a.ratio != null && Math.abs(a.ratio - 2.0) < 0.01, `Core A ratio should be ~2.0 (leave-one-out), got ${a?.ratio}`);
  assert.ok(b && b.ratio != null && Math.abs(b.ratio - 0.5) < 0.01, `Core B ratio should be ~0.5 (leave-one-out), got ${b?.ratio}`);
  assert.equal(a!.fleetMedianW, 1000, 'A is compared to B (1000 W), not the all-devices median (1500)');
  assert.equal(b!.fleetMedianW, 2000, 'B is compared to A (2000 W)');
});

test('string-mismatch ratio is null when there is no OTHER connected DPU to compare against', () => {
  resetStringMismatchCache();
  const devs: Record<string, DeviceSnapshot> = {
    'SN-A': { sn: 'SN-A', deviceName: 'SN-A', online: true, lastSeenMs: Date.now(), projection: { kind: 'dpu' } as any } as any,
    'SN-SHP2': { sn: 'SN-SHP2', deviceName: 'SHP2', online: true, lastSeenMs: Date.now(),
      projection: { kind: 'shp2', sources: [{ isConnected: true, sn: 'SN-A' }] } as any } as any,
  };
  const rep = computeStringMismatch(devs, pvRecorder({ 'SN-A': 2000 }));
  const a = rep.devices.find((d) => d.sn === 'SN-A');
  assert.equal(a?.ratio, null, 'a single connected DPU has no peer → ratio null (UI shows —)');
});

/* ─── (3) v0.54.3 — forecast-soh false-decline gate ───────────────────────────
 * The "State of health declining" predictive alert regressed an OLS line over the
 * raw pack SoH series. On a near-new fleet (packs at 97–100 %), the BMS settling
 * its measured fullCap over the first weeks reads as a confident multi-%/month
 * "fade" → projected EOL in ~1.5 months. v0.54.3 hardens the firing gate four ways:
 *   (a) ≥45-day span (was 5) — no EOL call from a fortnight of early-life settling;
 *   (b) ≤10 %/yr rate ceiling — a faster slope is settling/noise, not real LFP fade;
 *   (c) the dated-EOL path's BMS-recalibration guards (sohStepDominated /
 *       sohSignalBelowFloor) now apply here too;
 *   (d) R² ≥ 0.5 (was 0.25). The fade must STILL fire on a genuine, sustained,
 *       physically-plausible decline (no over-suppression). */

const DAY_MS = 86_400_000;
const hasSohAlert = (alerts: { id: string }[]) => alerts.some((a) => a.id.startsWith('forecast-soh-'));

/** One online DPU (Core 1, one pack at `curSoh`) + a recorder whose pack1_soh
 *  query returns `series` spread evenly across `spanDays`. The mock ignores the
 *  query's from/to bounds, so the observed span is exactly `spanDays`. */
function dpuSoh(series: number[], curSoh: number, spanDays: number): { devs: Record<string, DeviceSnapshot>; rec: Recorder } {
  const now = Date.now();
  const n = series.length;
  const pts = series.map((value, i) => ({ ts: now - spanDays * DAY_MS * (1 - i / (n - 1)), value }));
  const devs: Record<string, DeviceSnapshot> = {
    'SN-CORE1': {
      sn: 'SN-CORE1', deviceName: 'Core 1', online: true, lastSeenMs: now,
      projection: { kind: 'dpu', packs: [{ num: 1, actSoh: curSoh, soh: Math.round(curSoh) }] } as any,
    } as any,
  };
  const rec = {
    insertSnapshot: () => {},
    query: (_sn: string, metric: string) => (metric === 'pack1_soh' ? pts : []),
    queryMulti: () => new Map(), listMetrics: () => [], listLifetimeKeys: () => [],
    close: () => {}, rollupLifetime: () => {}, getLifetimeTotals: () => ({}),
  } as unknown as Recorder;
  return { devs, rec };
}
/** Clean linear SoH decline from `start` to `end` across `n` evenly-spaced samples. */
const linDecline = (start: number, end: number, n: number) =>
  Array.from({ length: n }, (_, i) => start + (end - start) * (i / (n - 1)));

test('forecast-soh — the live false-positive shape (97% pack, ~14 days, ~3%/mo fit) does NOT fire (span gate)', () => {
  resetForecastAlertsCache();
  // This is exactly what filled the Predictive tab: a near-new pack with a fortnight
  // of settling that OLS reads as "→85% in ~6 months". 14 days < the 45-day floor.
  const { devs, rec } = dpuSoh(linDecline(98.5, 97.1, 14), 97.1, 14);
  assert.equal(hasSohAlert(computeForecastAlerts(devs, rec, undefined)), false, 'a fortnight of data is too short to project battery EOL');
});

test('forecast-soh — an implausibly-fast fade (>10%/yr) does NOT fire even with ample span (rate ceiling)', () => {
  resetForecastAlertsCache();
  // 99.5 → 93 across 60 days = ~40 %/yr. Span (60d) and R² (clean line) both pass; the
  // rate ceiling is what rejects it — real LFP fades ~2–3 %/yr, this is settling/noise.
  const { devs, rec } = dpuSoh(linDecline(99.5, 93, 30), 93, 60);
  assert.equal(hasSohAlert(computeForecastAlerts(devs, rec, undefined)), false, 'slope implies an impossible fade rate → suppressed');
});

test('forecast-soh — a long-flat-then-step BMS recalibration staircase does NOT fire (sohStepDominated wired)', () => {
  resetForecastAlertsCache();
  // 50 samples flat at 99, then a recalibration step down. Net 3pt / 120d ≈ 9 %/yr (within
  // the ceiling) and EOL would project < 3yr, so ONLY the step guard stops the false fire.
  const series = [...Array(50).fill(99), ...Array(6).fill(97.5), ...Array(4).fill(96)];
  const { devs, rec } = dpuSoh(series, 96, 120);
  assert.equal(hasSohAlert(computeForecastAlerts(devs, rec, undefined)), false, 'a quantization staircase is not a measurable trend');
});

test('forecast-soh — a genuine, sustained, plausible fade STILL fires (no over-suppression)', () => {
  resetForecastAlertsCache();
  // 99 → 96 across 120 days = ~9 %/yr (≤ ceiling), 3pt net (clears the noise floor),
  // clean line (R²≈1), span 120d (≥45). Projects to 85% in ~14 months → must alert.
  const { devs, rec } = dpuSoh(linDecline(99, 96, 60), 96, 120);
  assert.equal(hasSohAlert(computeForecastAlerts(devs, rec, undefined)), true, 'a real multi-month decline within plausible bounds must still surface');
});

/* v0.54.3 — regression lock for the Issue-2 fix: the SoH tightening must NOT bleed into the
 * cell-imbalance forecast, which is a faster signal that must keep its 5-day early-warning span.
 * (forecast-imbalance had no test before; this pins the short-span behavior the SoH gate must not
 * inherit. If someone re-merges the SoH and shared span/R² constants, this fails.) */
const hasImbAlert = (alerts: { id: string }[]) => alerts.some((a) => a.id.startsWith('forecast-imbalance-'));

test('forecast-imbalance — a fast cell-spread rise STILL fires at a ~7-day span (SoH 45-day gate must not bleed in)', () => {
  resetForecastAlertsCache();
  const now = Date.now();
  const SPAN_D = 7; // > the imbalance 5-day floor, but well under the SoH 45-day floor
  const vals = linDecline(18, 30, 12).map((v) => v); // 18 → 30 mV, clean rise
  const pts = vals.map((value, i) => ({ ts: now - SPAN_D * DAY_MS * (1 - i / (vals.length - 1)), value }));
  const devs: Record<string, DeviceSnapshot> = {
    'SN-CORE1': {
      sn: 'SN-CORE1', deviceName: 'Core 1', online: true, lastSeenMs: now,
      projection: { kind: 'dpu', packs: [{ num: 1, maxVolDiffMv: 30 }] } as any,
    } as any,
  };
  const rec = {
    insertSnapshot: () => {},
    query: (_sn: string, metric: string) => (metric === 'pack1_vol_diff_mv' ? pts : []),
    queryMulti: () => new Map(), listMetrics: () => [], listLifetimeKeys: () => [],
    close: () => {}, rollupLifetime: () => {}, getLifetimeTotals: () => ({}),
  } as unknown as Recorder;
  assert.equal(hasImbAlert(computeForecastAlerts(devs, rec, undefined)), true, 'imbalance early-warning must survive the SoH-only tightening');
});
