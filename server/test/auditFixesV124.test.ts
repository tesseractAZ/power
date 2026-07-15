import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeForecastAlerts, resetForecastAlertsCache } from '../src/analytics.js';
import type { Recorder } from '../src/recorder.js';
import type { DeviceSnapshot } from '../src/snapshot.js';
import type { DayForecast } from '../src/analytics.js';

/* ===================================================================
 * v1.24.0 — system-audit fix: the forecast-runtime card's displayed
 * time-to-reserve is BOUNDED by the daily-cycle forecast's own reserve
 * crossing, so a flat trailing-3h-slope extrapolation across the solar
 * boundary can no longer read ~4x the authoritative runway (live: the
 * card showed 17h39m vs /api/runway 4.2h — an under-warning contradiction
 * on the same page).
 * =================================================================== */

const now = Date.now();

function shp2(): Record<string, DeviceSnapshot> {
  return {
    'SN-SHP2': {
      sn: 'SN-SHP2', deviceName: 'Smart Home Panel 2', online: true, lastSeenMs: now,
      projection: { kind: 'shp2', backupBatPercent: 50, backupReserveSoc: 10, backupFullCapWh: 92_160 } as any,
    } as any,
  };
}
/** backup_pct declining ~-3.3%/h (60→50 over 3h) → trailing extrapolation
 *  (50-10)/3.33 ≈ 12h; >=8 pts so linregress is not thin-trend-nulled. */
function decliningRecorder(): Recorder {
  const pts = Array.from({ length: 13 }, (_, i) => ({ ts: now - (12 - i) * 900_000, value: 60 - i * (10 / 12) }));
  return {
    insertSnapshot: () => {}, query: (_sn, metric) => (metric === 'backup_pct' ? pts : []),
    queryMulti: () => new Map(), listMetrics: () => [], listLifetimeKeys: () => [],
    close: () => {}, rollupLifetime: () => {}, getLifetimeTotals: () => ({}),
  } as unknown as Recorder;
}
/** A DayForecast whose projectedSocPct first dips to/below the 10% reserve at
 *  `crossHour` hours out, bottoming at `minSoc`. */
function forecastCrossing(crossHour: number, minSoc: number): DayForecast {
  const hours = Array.from({ length: 24 }, (_, k) => ({
    ts: now + k * 3_600_000,
    projectedSocPct: k < crossHour ? 50 - (40 * k) / crossHour : Math.max(minSoc, 10 - (k - crossHour) * 0.5),
    forecastPvW: 0,
    forecastLoadW: 1_000,
  }));
  return { minProjectedSoc: minSoc, reserveSoc: 10, hours } as unknown as DayForecast;
}
const runtimeAlert = (alerts: Array<{ id: string; title?: string; severity?: string }>) =>
  alerts.find((a) => a.id.startsWith('forecast-runtime-'));

test('v1.24.0 — the card is BOUNDED by the diurnal crossing (4h), not the ~12h trailing slope', () => {
  resetForecastAlertsCache();
  // Diurnal forecast crosses reserve at hour 4; trailing slope alone says ~12h.
  const a = runtimeAlert(computeForecastAlerts(shp2(), decliningRecorder(), forecastCrossing(4, 5)));
  assert.ok(a, 'the runtime alert still fires (bounding never suppresses)');
  assert.match(a!.title!, /≈ 4h 0m to reserve/, `bounded to the 4h diurnal crossing; got "${a!.title}"`);
  assert.doesNotMatch(a!.title!, /1[0-9]h/, 'must NOT show the ~12h trailing extrapolation');
});

test('v1.24.0 — when the diurnal crossing is LATER than the trailing slope, the sooner (trailing) still wins', () => {
  resetForecastAlertsCache();
  // Crossing at hour 20 (> the ~12h trailing) → min() keeps the trailing value; the
  // bound only ever SHORTENS the displayed time, never lengthens it.
  const a = runtimeAlert(computeForecastAlerts(shp2(), decliningRecorder(), forecastCrossing(20, 8)));
  assert.ok(a);
  assert.match(a!.title!, /≈ 12h/, `unbounded trailing value retained when it is the sooner; got "${a!.title}"`);
});

test('v1.24.0 — a forecast with no hours[] falls back to the trailing value (defensive, no throw)', () => {
  resetForecastAlertsCache();
  // The old fixture shape (minProjectedSoc + reserveSoc only, no hours) must not throw
  // and must reproduce pre-v1.24 behavior (trailing extrapolation).
  const legacyFc = { minProjectedSoc: 5, reserveSoc: 10 } as unknown as DayForecast;
  const a = runtimeAlert(computeForecastAlerts(shp2(), decliningRecorder(), legacyFc));
  assert.ok(a, 'still fires on the legacy no-hours forecast');
  assert.match(a!.title!, /≈ 12h/, 'no crossing available → trailing value');
});
