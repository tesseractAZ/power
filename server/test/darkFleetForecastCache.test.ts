/**
 * v1.191.2 — the day forecast is cached when every home Core is cloud-dark and only the house panel
 * is projected, and the entry is served only on the dark-Core basis it was built on.
 *
 * 2026-10-22: every home Core had been listed offline in the EcoFlow cloud for days and the add-on had
 * restarted since, so no Core had a projection (projections live in memory only; a Core the cloud lists
 * offline is never polled). computeDayForecastUncached cached only with a projected DPU, so the
 * complete forecast built on the panel's load and each connected Core's own recorded PV was rebuilt by
 * every getDayForecast: about 1.6 s per call on the Pi, about 13 rebuilds a minute from the alarm
 * feeds, MQTT, the runway ticks and the self-warm, about a third of a core.
 *
 * Three transitions of such a fleet are invisible to the solarModelSns check, which is empty on both
 * sides: P1 a dark Core leaves the panel's source list (the report chokepoint never resets on a
 * departure), P3 a dark Core is listed online before its first quota inside the 10-min
 * homeBasisPending bound (the basis key does not move), and P5 a dark Core returns to the source list
 * inside the chokepoint's 5-min re-arrival window (the reset is deferred). v1.191.1 rebuilt on every
 * call there; each case here rebuilds, and what it serves equals a fresh build on the same map. Each
 * fails against the cache clause alone, without the basis on the entry (restoredSns, basisPending).
 * P4 (a restart with every Core listed online before its first quota) is negative-cached on the same
 * pending map, as an incomplete forecast with a projected DPU always was. scripts/mutate-v1191-2.mjs.
 *
 * The clock is node:test's mocked Date, advanced by hand, so a fresh build on the same map is
 * identical to the last field. Test serials are placeholders.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { makeRecorderStub } from './helpers/recorderStub.js';
import type { DayForecast } from '../src/analytics.js';
import { forecastArchivable } from '../src/forecastArchiveGate.js';

const { getDayForecast, resetForecastCachesForTesting, resetWorkerReportCaches, computeProbabilisticForecast } = await import('../src/analytics.js');
const { setWeatherCacheForTesting, clearWeatherTestOverride } = await import('../src/weather.js');
const reports = await import('../src/reports.js');

type Any = any;
const H = 3_600_000;
const PANEL = 'PANEXXX00XXX0001';
const A = 'COREXXX00XXX0001';
const B = 'COREXXX00XXX0002';
const C = 'COREXXX00XXX0003';
const CORES = [A, B, C];
// Each Core's own recorded PV differs, so the restored display figures say which Cores they summed.
const PV_W: Record<string, number> = { [A]: 1500, [B]: 1100, [C]: 700 };
const T0 = Date.now();

const panel = (connected: string[], fullWh = 92_160, remainWh = 65_400): Any => ({
  sn: PANEL, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: true, lastUpdated: T0,
  lastQuotaAtMs: T0,
  projection: {
    kind: 'shp2', backupBatPercent: Math.round(100 * remainWh / fullWh), backupFullCapWh: fullWh, backupRemainWh: remainWh, backupReserveSoc: 16,
    circuits: [{ ch: 1, watts: 2400 }], pairedCircuits: [],
    sources: CORES.map((sn, i) => ({ slot: i + 1, sn, isConnected: connected.includes(sn) })), sourceWatts: [],
  },
});
/** A Core: `projected` it has a quota in memory; `online` is what the cloud's device list says. */
const core = (sn: string, projected: boolean, online = projected): Any => ({
  sn, deviceName: `Core ${sn.slice(-1)}`, productName: 'DELTA Pro Ultra', online, lastUpdated: projected ? T0 : 0,
  ...(projected ? { projection: { kind: 'dpu', soc: 71, pvTotalWatts: 0, packs: [] } } : {}),
});
const darkFleet = (connected: string[] = CORES, pool?: [number, number]): Any => ({
  [PANEL]: pool ? panel(connected, ...pool) : panel(connected),
  [A]: core(A, false), [B]: core(B, false), [C]: core(C, false),
});

const series = (w: number) => Array.from({ length: 72 }, (_, k) => ({ ts: T0 - (72 - k) * H, value: w }));
let pvScans = 0;
const history = makeRecorderStub({
  query: (sn: string, metric: string) => {
    if (metric === 'pv_total' && CORES.includes(sn)) { pvScans++; return series(PV_W[sn]); }
    return metric === 'panel_load' ? series(2700) : [];
  },
  queryMulti: (sn: string, metrics: string[]) => new Map(metrics.map((m) => [m, m === 'pv_total' && CORES.includes(sn) ? series(PV_W[sn]) : []])),
  listMetrics: () => [],
} as Any);
const ctxOf = (devices: Any): Any => ({ recorder: history, snapshot: { generatedAt: Date.now(), devices }, log: () => {} });

/** A fresh worker: every cache, the chokepoint's basis memory, no weather. */
const freshWorker = () => {
  resetForecastCachesForTesting();
  resetWorkerReportCaches();
  reports.resetReportBasisForTesting();
  setWeatherCacheForTesting(null);
};
const setup = (t: TestContext) => {
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  freshWorker();
  t.after(() => { clearWeatherTestOverride(); freshWorker(); });
  return (ms = 1_000) => t.mock.timers.tick(ms);
};
const encode = (f: DayForecast): unknown => JSON.parse(JSON.stringify(f));
/** What a build on `devices` from cold caches serves at this instant (the caches are cold afterwards). */
const freshBuild = async (devices: Any): Promise<unknown> => {
  resetForecastCachesForTesting();
  try { return encode(await getDayForecast(devices, history, () => {})); } finally { resetForecastCachesForTesting(); }
};

test('★★★ every home Core dark, the panel projected: the complete forecast is built once, then served from the cache', async (t) => {
  const tick = setup(t);
  const dark = darkFleet();
  const scans0 = pvScans;
  // Through the report chokepoint, as every worker report reads it (its first sight resets the caches).
  const first = await reports.buildReport('forecast', ctxOf(dark)) as DayForecast;
  assert.equal(first.structurallyIncomplete, false, 'the control: a complete forecast');
  assert.equal(first.homeDpusConnected, 3);
  assert.deepEqual(first.solarModelSns, [], 'no Core is projected: the model check is empty on both sides');
  assert.equal(first.forecastPvWhNext24Display, 24 * (1500 + 1100 + 700), 'the display figures re-add each connected Core\'s own recorded PV');
  assert.equal(forecastArchivable(first), false, 'v1.191.4: the dark-fleet forecast is short of the display figure and is not archived');
  const scans = pvScans;
  assert.ok(scans > scans0, 'the build read each connected Core\'s own recorded PV');
  tick(60_000);
  const second = await getDayForecast(dark, history, () => {});
  assert.equal(second, first, 'the second call is the cached value');
  assert.equal(pvScans, scans, 'and scans nothing');
  tick(60_000);
  assert.equal(await reports.buildReport('forecast', ctxOf(dark)), first, 'the forecast report serves the cached value too');
  assert.equal(pvScans, scans);
});

test('★★★ a Core that gains a projection is rebuilt at once and never served the dark-fleet forecast', async (t) => {
  const tick = setup(t);
  const dark = darkFleet();
  const first = await getDayForecast(dark, history, () => {});
  tick();
  const back = { ...dark, [A]: core(A, true) };
  const scans = pvScans;
  const third = await getDayForecast(back, history, () => {});
  assert.notEqual(third, first, 'a returning Core is never served the dark-fleet forecast');
  assert.ok(pvScans > scans, 'rebuilt');
  assert.deepEqual(third.solarModelSns, [A]);
  assert.deepEqual(encode(third), await freshBuild(back), 'what is served equals a fresh build on the same map');
  assert.equal(forecastArchivable(third), false, 'v1.191.4: two Cores still dark, so the PV sum is short and not archived');
  tick();
  const all = await getDayForecast({ ...back, [B]: core(B, true), [C]: core(C, true) }, history, () => {});
  assert.equal(all.forecastPvWhNext24, all.forecastPvWhNext24Display, 'every Core projected: the two sums agree by contract');
  assert.equal(forecastArchivable(all), true, 'v1.191.4: and the forecast is archived');
});

test('★★ a fleet with no projection at all (the boot device list) still does not latch', async (t) => {
  const tick = setup(t);
  const empty = { [A]: core(A, false), [B]: core(B, false), [C]: core(C, false) };
  const a = await getDayForecast(empty, history, () => {});
  tick();
  const b = await getDayForecast(empty, history, () => {});
  assert.notEqual(b, a, 'rebuilt: nothing to anchor the forecast to');
  assert.equal(b.structurallyIncomplete, true, 'the control: no panel, no SoC basis');
});

test('★★★ P1 a dark connected Core LEAVES the panel source list: rebuilt (through the report chokepoint), equal to a fresh build', async (t) => {
  const tick = setup(t);
  const before = darkFleet();
  const f1 = await reports.buildReport('forecast', ctxOf(before)) as DayForecast;
  assert.equal(f1.homeDpusConnected, 3);
  tick();
  // The panel drops the source and its pool shrinks with it; no element arrives, so no reset.
  const after = darkFleet([A, B], [61_440, 43_600]);
  const scans = pvScans;
  const f2 = await reports.buildReport('forecast', ctxOf(after)) as DayForecast;
  assert.notEqual(f2, f1, 'the dark-fleet forecast built on three restored Cores is not served on two');
  assert.ok(pvScans > scans, 'rebuilt');
  assert.equal(f2.homeDpusConnected, 2);
  assert.equal(f2.forecastPvWhNext24Display, 24 * (1500 + 1100), 'the departed Core\'s PV is no longer summed');
  assert.deepEqual(encode(f2), await freshBuild(after), 'what is served equals a fresh build on the same map');
});

test('★★★ P3 a dark Core is listed ONLINE before its first quota (homeBasisPending): rebuilt as pending, equal to a fresh build', async (t) => {
  const tick = setup(t);
  const dark = darkFleet();
  const f1 = await reports.buildReport('forecast', ctxOf(dark)) as DayForecast;
  assert.equal(f1.homeBasisPending, false);
  tick();
  const onlineNoQuota = { ...dark, [A]: core(A, false, true) };
  const scans = pvScans;
  const f2 = await reports.buildReport('forecast', ctxOf(onlineNoQuota)) as DayForecast;
  assert.notEqual(f2, f1, 'an entry built while no first reading was pending is not served on a pending map');
  assert.ok(pvScans > scans, 'rebuilt');
  assert.equal(f2.homeBasisPending, true, 'built now, the forecast is pending ...');
  assert.equal(f2.structurallyIncomplete, true, '... and incomplete (the publishers withhold it)');
  assert.deepEqual(encode(f2), await freshBuild(onlineNoQuota), 'what is served equals a fresh build on the same map');
});

test('★★★ P5 a dark Core RETURNS to the source list inside the re-arrival window (reset deferred): rebuilt, equal to a fresh build', async (t) => {
  const tick = setup(t);
  const full = darkFleet();
  const dip = darkFleet([A, B]);
  await reports.buildReport('forecast', ctxOf(full)); // first sight of every element: reset, build
  // A first dip-and-return takes the re-arrival allowance: that return resets at once.
  tick();
  await reports.buildReport('forecast', ctxOf(dip));
  tick();
  await reports.buildReport('forecast', ctxOf(full));
  // A second dip whose forecast is in the cache when the source returns (as when the entry from
  // before the dip expired during it) ...
  resetForecastCachesForTesting();
  tick();
  const fDip = await reports.buildReport('forecast', ctxOf(dip)) as DayForecast;
  assert.equal(fDip.homeDpusConnected, 2);
  tick();
  // ... and the source returns inside BASIS_REARRIVAL_RESET_MIN_MS of the last reset: deferred.
  const scans = pvScans;
  const fBack = await reports.buildReport('forecast', ctxOf(full)) as DayForecast;
  assert.notEqual(fBack, fDip, 'the forecast built during the dip is not served after the source returned');
  assert.ok(pvScans > scans, 'rebuilt');
  assert.equal(fBack.homeDpusConnected, 3);
  assert.equal(fBack.forecastPvWhNext24Display, 24 * (1500 + 1100 + 700));
  assert.deepEqual(encode(fBack), await freshBuild(full), 'what is served equals a fresh build on the same map');
});

test('★★ P4 boot: every Core listed ONLINE before its first quota: the pending forecast is negative-cached, and the first quota rebuilds it', async (t) => {
  const tick = setup(t);
  const boot = { [PANEL]: panel(CORES), [A]: core(A, false, true), [B]: core(B, false, true), [C]: core(C, false, true) };
  const f1 = await getDayForecast(boot, history, () => {});
  assert.equal(f1.homeBasisPending, true);
  assert.equal(f1.structurallyIncomplete, true, 'incomplete: the short negative-cache TTL');
  tick(30_000);
  const scans = pvScans;
  assert.equal(await getDayForecast(boot, history, () => {}), f1, 'served on the same pending map inside that TTL, not rebuilt per call');
  assert.equal(pvScans, scans);
  tick(30_000);
  const hydrating = { ...boot, [A]: core(A, true) };
  const f3 = await getDayForecast(hydrating, history, () => {});
  assert.notEqual(f3, f1, 'a Core whose first quota landed is never served the forecast built without it');
  assert.deepEqual(encode(f3), await freshBuild(hydrating), 'what is served equals a fresh build on the same map');
});

test('★★ downstream caches keyed on the forecast now hit while it is cached, and still follow it when it is rebuilt (v1.186.5 forecastTs)', async (t) => {
  const tick = setup(t);
  const dark = darkFleet();
  const f1 = await getDayForecast(dark, history, () => {});
  const band1 = await computeProbabilisticForecast(f1, null);
  tick();
  const fAgain = await getDayForecast(dark, history, () => {});
  assert.equal(fAgain, f1);
  assert.equal(await computeProbabilisticForecast(fAgain, null), band1, 'the band built on the cached forecast is reused with it');
  tick();
  const after = darkFleet([A, B], [61_440, 43_600]);
  const f2 = await getDayForecast(after, history, () => {});
  assert.notEqual(f2.generatedAt, f1.generatedAt, 'the P1 departure rebuilt the forecast');
  assert.notEqual(await computeProbabilisticForecast(f2, null), band1, 'a band built on the superseded forecast is not served with the new one');
});
