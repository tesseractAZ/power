/**
 * v1.177.0 — the display next-24 h PV (published to Home Assistant) equals the dashboard's
 * alarm-basis figure whenever every Core is reporting.
 *
 * v0.78.0 promised it ("with no missing SNs this refits an identical map → equals
 * solarModel"). Two changes had broken it: v0.93.0 bias-corrected only the alarm series, and
 * the F11 gate fits the alarm model on full-coverage hours while the display model refit the
 * UNGATED map. After any partial-fleet day in the 30-day window the two diverged on a fully
 * reporting fleet (this fixture: 79.4 vs 76.7 kWh). Setup adapted from an adversarial
 * reviewer's reproduction.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDayForecast, resetForecastCachesForTesting, resetRunwayCache } from '../src/analytics.js';
import { setWeatherCacheForTesting } from '../src/weather.js';
import { makeRecorderStub } from './helpers/recorderStub.js';

const H = 3_600_000;
const now = Date.now();
const since = now - 31 * 24 * H;
const ghiAt = (ts: number) => { const h = new Date(ts).getHours(); return h >= 6 && h <= 18 ? Math.max(0, 1000 * Math.sin(Math.PI * (h - 5.5) / 14)) : 0; };
const COEFF = 3;
/** Core B missed three days, 10-13 days ago — enough to arm the F11 full-coverage gate. */
const missing = (sn: string, ts: number) => sn === 'B' && ts >= now - 13 * 24 * H && ts < now - 10 * 24 * H;
const dpu = (sn: string): any => ({ sn, deviceName: sn, online: true, lastSeenMs: now, projection: { kind: 'dpu', soc: 80, pvTotalWatts: 0, acInWatts: 0, acOutWatts: 0, packs: [] } });
const shp2 = (sns: string[]): any => ({ sn: 'SHP2', deviceName: 'SHP2', online: true, lastSeenMs: now, projection: { kind: 'shp2', backupBatPercent: 60, backupFullCapWh: 92000, backupRemainWh: 60000, backupReserveSoc: 15, circuits: [], pairedCircuits: [], sources: sns.map((sn, i) => ({ slot: i + 1, sn, isConnected: true })), sourceWatts: [], strategy: {} } });
function series(fn: (ts: number) => number | null, from: number, to: number) {
  const out: Array<{ ts: number; value: number }> = [];
  for (let t = Math.ceil(Math.max(from, since) / H) * H; t <= to; t += H) { const v = fn(t); if (v != null) out.push({ ts: t, value: v }); }
  return out;
}
const pvFn = (sn: string) => (ts: number) => (missing(sn, ts) ? null : COEFF * ghiAt(ts));
const rec = makeRecorderStub({
  query: (sn: string, metric: string, from: number, to: number) => {
    if (sn === 'weather' && metric === 'ghi_wm2') return series(ghiAt, from, to);
    if (sn === 'weather' && metric === 'cloud_pct') return series(() => 10, from, to);
    if (metric === 'panel_load') return series(() => 2000, from, to);
    if (metric === 'pv_total' && ['A', 'B', 'C'].includes(sn)) return series(pvFn(sn), from, to);
    return [];
  },
  queryMulti: (sn: string, metrics: string[], from: number, to: number) => {
    const m = new Map<string, Array<{ ts: number; value: number }>>();
    for (const k of metrics) m.set(k, k === 'pv_total' && ['A', 'B', 'C'].includes(sn) ? series(pvFn(sn), from, to) : []);
    return m;
  },
} as any);

test('★★ every Core reporting, F11 gate active: Home Assistant’s figure equals the dashboard’s', async () => {
  const startHour = Math.ceil(now / H) * H;
  setWeatherCacheForTesting({ fetchedAt: now, lat: 33.4, lon: -112, hours: Array.from({ length: 30 }, (_, k) => ({ ts: startHour - 2 * H + k * H, cloudCoverPct: 10, radiationWm2: ghiAt(startHour - 2 * H + k * H), tempC: 25 })) } as any);
  resetForecastCachesForTesting();
  resetRunwayCache();
  const logs: string[] = [];
  const fc = await getDayForecast({ SHP2: shp2(['A', 'B', 'C']), A: dpu('A'), B: dpu('B'), C: dpu('C') } as any, rec, (m) => logs.push(m));
  assert.ok(logs.some((l) => /full-coverage hours \(F11 gate/.test(l)), 'the fixture really arms the F11 gate');
  assert.ok(fc.forecastPvWhNext24 > 0);
  assert.equal(fc.forecastPvWhNext24Display, fc.forecastPvWhNext24, 'HA (display) and the dashboard (alarm) publish one number');
  assert.equal(fc.restoredSolarModel, (fc as any).solarModel, 'with no Core missing, the display model IS the alarm model');
});
