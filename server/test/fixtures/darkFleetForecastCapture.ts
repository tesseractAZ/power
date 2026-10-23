/**
 * v1.191.2 — one day-forecast build on a fixed dark-fleet fixture, for darkFleetForecastSingleRead.test.ts.
 *
 *   node --import tsx test/fixtures/darkFleetForecastCapture.ts      (cwd server/, TZ=America/Phoenix)
 *
 * Writes {"forecast": …, "queries": {key: count}} to stdout. The fixture: the house panel projected,
 * listing three home Cores as connected, every Core cloud-dark (listed offline, no projection), 30 days
 * of 5-min PV per Core (one with a two-day gap, one with only 20 days), a diurnal panel load, recorded
 * and cached weather, all generated from a fixed instant. The clock is frozen at that instant before the
 * analytics module loads, so two captures of one tree are identical to the byte.
 *
 * darkFleetForecast.golden.json is this script's forecast on v1.191.1 (dabedbf8), whose build read each
 * Core's 30-day pv_total twice; the test holds the current tree's forecast to it. Re-capture only on a
 * tree whose forecast is meant to change, never to make the test pass. Test serials are placeholders.
 */
const NOW = 1_792_375_500_000; // 2026-10-19T02:05:00Z
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...a: unknown[]) {
    if (a.length === 0) super(NOW);
    else super(...(a as [number]));
  }
  static override now(): number { return NOW; }
}
(globalThis as { Date: DateConstructor }).Date = FrozenDate as unknown as DateConstructor;

const { makeRecorderStub } = await import('../helpers/recorderStub.js');
const { getDayForecast, resetForecastCachesForTesting } = await import('../../src/analytics.js');
const { setWeatherCacheForTesting } = await import('../../src/weather.js');

type Any = any;
const H = 3_600_000;
const D = 24 * H;
const STEP = 300_000;
const PANEL = 'PANEXXX00XXX0001';
const A = 'COREXXX00XXX0001';
const B = 'COREXXX00XXX0002';
const C = 'COREXXX00XXX0003';
const SINCE = NOW - 30 * D;

/** A fixed pseudo-random fraction of an integer (no state, no Math.random). */
const frac = (n: number): number => { const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };
/** The fixture's site hour (Phoenix, UTC-7 all year), fractional. */
const siteHourF = (ts: number): number => (((ts - 7 * H) % D) + D) % D / H;
const dayIndex = (ts: number): number => Math.floor((ts - 7 * H) / D);
const clearSky = (ts: number): number => { const h = siteHourF(ts); return h > 6 && h < 18.5 ? 960 * Math.sin(Math.PI * (h - 6) / 12.5) : 0; };
const dayClearness = (ts: number): number => 0.5 + 0.5 * frac(dayIndex(ts));
const ghi = (ts: number): number => clearSky(ts) * dayClearness(ts);
const cloudPct = (ts: number): number => Math.round(100 * (1 - dayClearness(ts)));

const range = (from: number, to: number, step: number): number[] => {
  const out: number[] = [];
  for (let t = Math.ceil(from / step) * step; t <= to; t += step) out.push(t);
  return out;
};
const pv = (scale: number, phase: number) => (ts: number): number =>
  Math.max(0, scale * ghi(ts) * (1 + 0.04 * Math.sin(ts / 7_000_000 + phase)) - 20 * frac(ts / STEP + phase));
const PV_SERIES: Record<string, Array<{ ts: number; value: number }>> = {
  [A]: range(SINCE, NOW, STEP).map((ts) => ({ ts, value: pv(9.4, 0)(ts) })),
  // B: only the last 20 days were recorded.
  [B]: range(NOW - 20 * D, NOW, STEP).map((ts) => ({ ts, value: pv(8.1, 1.3)(ts) })),
  // C: a two-day gap a week ago.
  [C]: range(SINCE, NOW, STEP).filter((ts) => ts < NOW - 9 * D || ts >= NOW - 7 * D).map((ts) => ({ ts, value: pv(6.7, 2.1)(ts) })),
};
const loadW = (ts: number): number => {
  const h = siteHourF(ts);
  const evening = h >= 17 && h < 22 ? 1400 : 0;
  const dow = ((dayIndex(ts) % 7) + 7) % 7;
  return 1700 + evening + (dow === 3 || dow === 4 ? 350 : 0) + 500 * Math.sin(Math.PI * h / 12) + 120 * frac(ts / STEP);
};
const LOAD = range(SINCE, NOW, STEP).map((ts) => ({ ts, value: loadW(ts) }));
const HOURS = range(SINCE, NOW, H);
const WX_GHI = HOURS.map((ts) => ({ ts, value: ghi(ts) }));
const WX_REALIZED = HOURS.filter((ts) => ts >= NOW - 12 * D).map((ts) => ({ ts, value: ghi(ts) * 0.97 }));
const WX_CLOUD = HOURS.map((ts) => ({ ts, value: cloudPct(ts) }));

const within = (pts: Array<{ ts: number; value: number }>, since: number, until: number) => pts.filter((p) => p.ts >= since && p.ts <= until);
const queries: Record<string, number> = {};
const recorder = makeRecorderStub({
  query: (sn: string, metric: string, since: number, until: number, bucket?: number) => {
    const key = `${sn}|${metric}|${since - NOW}|${until - NOW}|${bucket ?? ''}`;
    queries[key] = (queries[key] ?? 0) + 1;
    if (metric === 'pv_total' && PV_SERIES[sn]) return within(PV_SERIES[sn], since, until);
    if (sn === PANEL && metric === 'panel_load') return within(LOAD, since, until);
    if (sn === 'weather' && metric === 'ghi_wm2') return within(WX_GHI, since, until);
    if (sn === 'weather' && metric === 'ghi_wm2_realized') return within(WX_REALIZED, since, until);
    if (sn === 'weather' && metric === 'cloud_pct') return within(WX_CLOUD, since, until);
    return [];
  },
  queryMulti: (_sn: string, metrics: string[]) => new Map(metrics.map((m) => [m, []])),
  listMetrics: () => [],
} as Any);

const fullWh = 92_160;
const remainWh = 58_900;
const devices: Any = {
  [PANEL]: {
    sn: PANEL, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: true, lastUpdated: NOW, lastQuotaAtMs: NOW,
    projection: {
      kind: 'shp2', backupBatPercent: Math.round(100 * remainWh / fullWh), backupFullCapWh: fullWh, backupRemainWh: remainWh, backupReserveSoc: 16,
      circuits: [{ ch: 1, watts: 2300 }], pairedCircuits: [],
      sources: [A, B, C].map((sn, i) => ({ slot: i + 1, sn, isConnected: true })), sourceWatts: [],
    },
  },
  ...Object.fromEntries([A, B, C].map((sn) => [sn, { sn, deviceName: `Core ${sn.slice(-1)}`, productName: 'DELTA Pro Ultra', online: false, lastUpdated: 0 }])),
};

setWeatherCacheForTesting({
  fetchedAt: NOW - 10 * 60_000, lat: 0, lon: 0, ensembleSourcesCount: 1,
  hours: range(NOW - 7 * D, NOW + 3 * D, H).map((ts) => ({ ts, cloudCoverPct: cloudPct(ts), radiationWm2: ghi(ts), tempC: 24 + 8 * Math.sin(Math.PI * siteHourF(ts) / 24), ensembleSources: 1 })),
} as Any);
resetForecastCachesForTesting();
const forecast = await getDayForecast(devices, recorder, () => {});
process.stdout.write(JSON.stringify({ forecast, queries }, null, 1) + '\n');

// A module (top-level await); every import above is dynamic, so it runs after the clock is frozen.
export {};
