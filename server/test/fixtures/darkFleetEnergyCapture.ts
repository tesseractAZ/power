/**
 * v1.191.3 — the self-consumption, carbon and tariff reports on a fixed fixture, for
 * darkFleetEnergyIdentity.test.ts.
 *
 *   node --import tsx test/fixtures/darkFleetEnergyCapture.ts      (cwd server/, TZ=America/Phoenix)
 *
 * Writes {"captures": [{at, fleet, selfConsumption, carbon, tariff}, …]} to stdout: each report built
 * from cold caches on two fleets (the house panel projected and listing three home Cores, every Core
 * cloud-dark; and every Core projected) at two instants (minute-aligned, and 17.345 s past a minute).
 * The recorder stub buckets 60-s samples the way the recorder's SQL does (bucket start = floor, the
 * bucket's mean, ascending), so the tariff's hourly windows start ON a sample at the aligned instant and
 * between two samples at the other. A load and grid spike sits on every hour boundary of the aligned
 * instant's window, a 12-min and a 5-min gap straddle two of them, and one Core charges from AC: the
 * sample before an hour, the sample at its end and the gap rule each change the figures. The clock is
 * frozen before the analytics module loads, so two captures of one tree are identical to the byte.
 *
 * darkFleetEnergy.golden.json is this script's output on v1.191.2 (ddd6fb09), before the
 * self-consumption cache and the per-hour tariff slices; the test holds the current tree to it.
 * Re-capture only on a tree whose figures are meant to change, never to make the test pass. Test
 * serials are placeholders.
 */
const NOW_ALIGNED = 1_792_375_500_000; // 2026-10-19T02:05:00Z
const NOW_UNALIGNED = NOW_ALIGNED + 17_345;
let now = NOW_ALIGNED;
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...a: unknown[]) {
    if (a.length === 0) super(now);
    else super(...(a as [number]));
  }
  static override now(): number { return now; }
}
(globalThis as { Date: DateConstructor }).Date = FrozenDate as unknown as DateConstructor;

const { makeRecorderStub } = await import('../helpers/recorderStub.js');
const { computeSelfConsumption, computeCarbonReport, computeTariffReport, resetWorkerSampleCaches } = await import('../../src/analytics.js');

type Any = any;
type Pt = { ts: number; value: number };
const MIN = 60_000;
const H = 3_600_000;
const D = 24 * H;
const PANEL = 'PANEXXX00XXX0001';
const A = 'COREXXX00XXX0001';
const B = 'COREXXX00XXX0002';
const C = 'COREXXX00XXX0003';
const CORES = [A, B, C];
const PACKS = [1, 2];

/** A fixed pseudo-random fraction of a number (no state, no Math.random). */
const frac = (n: number): number => { const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };
/** The fixture's site hour (Phoenix, UTC-7 all year), fractional. */
const siteHourF = (ts: number): number => (((ts - 7 * H) % D) + D) % D / H;
const sun = (ts: number): number => { const h = siteHourF(ts); return h > 6 && h < 18.5 ? Math.sin(Math.PI * (h - 6) / 12.5) : 0; };
/** On every hour boundary of the aligned instant's 7-day window. */
const onBoundary = (ts: number): boolean => (((ts - NOW_ALIGNED) % H) + H) % H === 0;
/** No sample at all inside the two gaps (a 12-min one and a 5-min one, each centred on a boundary). */
const GAPS: Array<[number, number]> = [
  [NOW_ALIGNED - 50 * H - 6 * MIN, NOW_ALIGNED - 50 * H + 6 * MIN],
  [NOW_ALIGNED - 101 * H - 150_000, NOW_ALIGNED - 101 * H + 150_000],
];
const inGap = (ts: number): boolean => GAPS.some(([s, e]) => ts > s && ts < e);

const PV_SCALE: Record<string, number> = { [A]: 3_100, [B]: 2_400, [C]: 1_800 };
const value = (sn: string, metric: string, ts: number): number | null => {
  const n = ts / MIN;
  const spike = onBoundary(ts);
  if (sn === PANEL) {
    if (metric === 'panel_load') return 1_600 + 700 * Math.sin(Math.PI * siteHourF(ts) / 12) + 400 * frac(n) + (spike ? 9_000 : 0);
    if (metric === 'grid_home_w') return Math.max(0, 900 - 1_200 * sun(ts)) + 250 * frac(n + 0.37) + (spike ? 4_000 : 0);
    return null;
  }
  if (!CORES.includes(sn)) return null;
  const k = CORES.indexOf(sn);
  if (metric === 'pv_total') return Math.max(0, PV_SCALE[sn] * sun(ts) * (0.8 + 0.2 * frac(n + k)) - 15 * frac(n + 3 * k));
  // One Core charges from AC overnight; the others never do.
  if (metric === 'ac_in') return sn === A ? (sun(ts) === 0 ? 1_100 + 300 * frac(n + 0.11) : 40 * frac(n + 0.11)) + (spike ? 2_500 : 0) : 0;
  const pack = /^pack(\d+)_(in|out)$/.exec(metric);
  if (pack && PACKS.includes(Number(pack[1]))) {
    const p = Number(pack[1]);
    const day = sun(ts);
    return pack[2] === 'in'
      ? 500 * day * (0.6 + 0.4 * frac(n + p + k))
      : (day === 0 ? 350 : 60) * (0.7 + 0.3 * frac(n + 2 * p + k));
  }
  return null;
};

/** The recorder's bucketed read: 60-s samples in [since, until], grouped by floor(ts / bucket), the mean. */
const queries: Record<string, number> = {};
const read = (sn: string, metric: string, since: number, until: number, bucketSec = 60): Pt[] => {
  const key = `${sn}|${metric}`;
  queries[key] = (queries[key] ?? 0) + 1;
  const bucketMs = bucketSec * 1000;
  const groups = new Map<number, { sum: number; n: number }>();
  for (let ts = Math.ceil(since / MIN) * MIN; ts <= until; ts += MIN) {
    if (inGap(ts)) continue;
    const v = value(sn, metric, ts);
    if (v == null) continue;
    const b = Math.floor(ts / bucketMs) * bucketMs;
    const g = groups.get(b);
    if (g) { g.sum += v; g.n++; } else groups.set(b, { sum: v, n: 1 });
  }
  return [...groups.entries()].sort((x, y) => x[0] - y[0]).map(([ts, g]) => ({ ts, value: g.sum / g.n }));
};
const recorder = makeRecorderStub({
  query: (sn: string, metric: string, since: number, until: number, bucketSec?: number) => read(sn, metric, since, until, bucketSec),
  queryMulti: (sn: string, metrics: string[], since: number, until: number, bucketSec?: number) =>
    new Map(metrics.map((m) => [m, read(sn, m, since, until, bucketSec)])),
  listMetrics: (sn: string) => (CORES.includes(sn) ? ['ac_in', ...PACKS.flatMap((p) => [`pack${p}_in`, `pack${p}_out`]), 'pv_total'] : sn === PANEL ? ['grid_home_w', 'panel_load'] : []),
  getLifetimeTotals: () => ({ fleet_pv_wh: { persistedWh: 48_765_432, pendingWh: 1_234, watermarkMs: NOW_ALIGNED - 5 * MIN } }),
} as Any);

const panel = (): Any => ({
  sn: PANEL, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: true, lastUpdated: now, lastQuotaAtMs: now,
  projection: {
    kind: 'shp2', backupBatPercent: 64, backupFullCapWh: 92_160, backupRemainWh: 58_900, backupReserveSoc: 16,
    circuits: [{ ch: 1, watts: 2300 }], pairedCircuits: [],
    sources: CORES.map((sn, i) => ({ slot: i + 1, sn, isConnected: true })), sourceWatts: [],
  },
});
const core = (sn: string, projected: boolean): Any => ({
  sn, deviceName: `Core ${sn.slice(-1)}`, productName: 'DELTA Pro Ultra', online: projected, lastUpdated: projected ? now : 0,
  ...(projected ? { projection: { kind: 'dpu', soc: 64, pvTotalWatts: 0, packs: PACKS.map((num) => ({ num, soc: 64, soh: 98, temp: 26 })) } } : {}),
});
const fleet = (projected: boolean): Any => ({ [PANEL]: panel(), ...Object.fromEntries(CORES.map((sn) => [sn, core(sn, projected)])) });

const captures: unknown[] = [];
for (const at of [NOW_ALIGNED, NOW_UNALIGNED]) {
  now = at;
  for (const name of ['dark', 'projected'] as const) {
    const devices = fleet(name === 'projected');
    resetWorkerSampleCaches();
    const selfConsumption = computeSelfConsumption(devices, recorder);
    const carbon = computeCarbonReport(devices, recorder);
    const tariff = computeTariffReport(devices, recorder);
    captures.push({ at: at - NOW_ALIGNED, fleet: name, selfConsumption, carbon, tariff });
  }
}
resetWorkerSampleCaches();
process.stdout.write(JSON.stringify({ captures, queries }, null, 1) + '\n');

// A module (top-level await); every import above is dynamic, so it runs after the clock is frozen.
export {};
