/**
 * v1.191.3 — the self-consumption report is cached while every home Core is cloud-dark and only the house
 * panel is projected, and the entry is served only on the basis it was built on.
 *
 * 2026-10-22: with every home Core listed offline in the EcoFlow cloud after a restart, no Core had a
 * projection, and computeSelfConsumption cached only with a projected DPU (v0.15.13: a structurally
 * complete fleet, at least one DPU and the panel). It was rebuilt on every read, and the carbon report,
 * which reads it, rebuilt it again: about 4.4 rebuilds a minute, beside the tariff's 2.2.
 *
 * The entry is now written in the known-dark state too (v1.191.2's notion: the panel lists restored
 * Cores, homeRestoredSns, and none of them is pending, homeBasisPending) and keyed on the house panel,
 * the Cores integrated live (homeModelSns) and the Cores restored from their record (homeRestoredSns).
 * Each case asserts, after each transition, that what is served equals a fresh build on the same map.
 * Never cached, as before: a fleet with no projection, a DPU with no panel (v0.15.13), and, while no
 * Core is projected, a panel that lists no Core or a Core listed online before its first quota inside
 * HOME_BASIS_PENDING_MAX_MS of the worker's start.
 *
 * Two fleets: F-dark (the panel and three dark Cores) and F-spare (F-dark plus a projected bench spare
 * that the panel does not list), which v1.191.2 already cached under the key 'd7'. Red on v1.191.2:
 * A1, A2, A3, the F-spare halves of A7, A8 and A10, A9 and the F-spare half of A12. scripts/mutate-v1191-3.mjs.
 *
 * The clock is node:test's mocked Date, advanced by hand, so a fresh build on the same map is identical
 * to the last field. Test serials are placeholders.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { makeRecorderStub } from './helpers/recorderStub.js';
import type { SelfConsumption } from '../src/analytics.js';

const {
  computeSelfConsumption, computeCarbonReport, resetSelfConsumptionCache, resetDailyEnergyCache,
  resetForecastCachesForTesting, resetWorkerReportCaches, HOME_BASIS_PENDING_MAX_MS,
} = await import('../src/analytics.js');
const reports = await import('../src/reports.js');

type Any = any;
const MIN = 60_000;
const PANEL = 'PANEXXX00XXX0001';
const PANEL2 = 'PANEXXX00XXX0002';
const A = 'COREXXX00XXX0001';
const B = 'COREXXX00XXX0002';
const C = 'COREXXX00XXX0003';
const SPARE = 'COREXXX00XXX0009';
const CORES = [A, B, C];
const T0 = Date.now();

// Each Core's own recorded energy differs, so the figures say which Cores they summed; each panel's load
// differs, so they say which panel they read.
const W: Record<string, Record<string, number>> = {
  [A]: { pv_total: 1500, ac_in: 120, pack1_in: 400, pack1_out: 300 },
  [B]: { pv_total: 1100, ac_in: 80, pack1_in: 300, pack1_out: 250 },
  [C]: { pv_total: 700, ac_in: 40, pack1_in: 200, pack1_out: 150 },
  [SPARE]: { pv_total: 400, ac_in: 900, pack1_in: 100, pack1_out: 100 },
  [PANEL]: { panel_load: 2700, grid_home_w: 900 },
  [PANEL2]: { panel_load: 1900, grid_home_w: 600 },
};
const series = (w: number, since: number, until: number) => {
  const out: Array<{ ts: number; value: number }> = [];
  for (let ts = Math.ceil(since / 300_000) * 300_000; ts <= until; ts += 300_000) out.push({ ts, value: w });
  return out;
};
/** Recorder reads, per SN. */
const reads = new Map<string, number>();
const note = (sn: string) => reads.set(sn, (reads.get(sn) ?? 0) + 1);
const total = () => [...reads.values()].reduce((s, n) => s + n, 0);
const coreReads = () => [...reads.entries()].filter(([sn]) => sn.startsWith('CORE')).reduce((s, [, n]) => s + n, 0);
const history = makeRecorderStub({
  query: (sn: string, metric: string, since: number, until: number) => { note(sn); return series(W[sn]?.[metric] ?? 0, since, until); },
  queryMulti: (sn: string, metrics: string[], since: number, until: number) => {
    note(sn);
    return new Map(metrics.map((m) => [m, W[sn]?.[m] != null ? series(W[sn][m], since, until) : []]));
  },
  listMetrics: (sn: string) => { note(sn); return Object.keys(W[sn] ?? {}).sort(); },
} as Any);
const ctxOf = (devices: Any): Any => ({ recorder: history, snapshot: { generatedAt: Date.now(), devices }, log: () => {} });

const panel = (connected: string[], sn = PANEL, extra: Any = {}): Any => ({
  sn, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: true, lastUpdated: T0, lastQuotaAtMs: T0, ...extra,
  projection: {
    kind: 'shp2', backupBatPercent: 70, backupFullCapWh: 92_160, backupRemainWh: 64_500, backupReserveSoc: 16,
    circuits: [{ ch: 1, watts: 2400 }], pairedCircuits: [],
    sources: CORES.map((s, i) => ({ slot: i + 1, sn: s, isConnected: connected.includes(s) })), sourceWatts: [],
  },
});
/** A Core: `projected` it has a quota in memory; `online` is what the cloud's device list says. */
const core = (sn: string, projected: boolean, online = projected): Any => ({
  sn, deviceName: `Core ${sn.slice(-1)}`, productName: 'DELTA Pro Ultra', online, lastUpdated: projected ? T0 : 0,
  ...(projected ? { projection: { kind: 'dpu', soc: 71, pvTotalWatts: 0, packs: [{ num: 1, soc: 71, soh: 98, temp: 26 }] } } : {}),
});
const darkFleet = (connected: string[] = CORES): Any => ({
  [PANEL]: panel(connected), [A]: core(A, false), [B]: core(B, false), [C]: core(C, false),
});
const withSpare = (devices: Any): Any => ({ ...devices, [SPARE]: core(SPARE, true) });
const FLEETS: Array<[string, (d: Any) => Any]> = [['F-dark', (d) => d], ['F-spare', withSpare]];

/** A fresh worker: every result cache, the per-day energy memo, the chokepoint's basis memory. */
const freshWorker = () => {
  resetForecastCachesForTesting();
  resetWorkerReportCaches();
  resetDailyEnergyCache();
  reports.resetReportBasisForTesting();
};
const setup = (t: TestContext) => {
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  freshWorker();
  t.after(freshWorker);
  return (ms = 1_000) => t.mock.timers.tick(ms);
};
const encode = (v: SelfConsumption): unknown => JSON.parse(JSON.stringify(v));
/** What a build on `devices` from a cold self-consumption cache serves at this instant. Afterwards the
 *  cache holds that map's entry again when it is cacheable (a call on the same map refills it). */
const freshBuild = (devices: Any): unknown => {
  resetSelfConsumptionCache();
  const v = encode(computeSelfConsumption(devices, history));
  resetSelfConsumptionCache();
  computeSelfConsumption(devices, history);
  return v;
};
const sc = (devices: Any) => computeSelfConsumption(devices, history);
const viaReport = async (devices: Any) => await reports.buildReport('selfConsumption', ctxOf(devices)) as SelfConsumption;
/** Served from the cache: the same object, and no recorder read. */
const assertCached = (got: SelfConsumption, prev: SelfConsumption, before: number, what: string) => {
  assert.equal(got, prev, `${what}: the cached value`);
  assert.equal(total(), before, `${what}: no recorder read`);
};
/** Rebuilt: a new object, which read the recorder (a map with no panel and no projected Core reads nothing:
 *  `reads` false). */
const assertRebuilt = (got: SelfConsumption, prev: SelfConsumption, before: number, what: string, reads = true) => {
  assert.notEqual(got, prev, `${what}: not the entry built on the previous map`);
  if (reads) assert.ok(total() > before, `${what}: rebuilt`);
};

test('★★★ A1 every home Core dark, the panel projected: self-consumption is built once, then served from the cache', (t) => {
  const tick = setup(t);
  const dark = darkFleet();
  const r0 = total();
  const first = sc(dark);
  assert.ok(total() > r0, 'the build read the recorder');
  assert.equal(first.homeDpusReporting, 0, 'every Core dark');
  assert.equal(first.homeDpusConnected, 3);
  assert.equal(first.pvKwh, Math.round((1500 + 1100 + 700) * 7 * 24) / 1000, 'each connected Core\'s own recorded PV is summed');
  tick(60_000);
  const r1 = total();
  assertCached(sc(dark), first, r1, 'the second call');
  tick(13 * MIN);
  assertCached(sc(dark), first, r1, 'inside the 15-min TTL');
  tick(2 * MIN);
  const third = sc(dark);
  assertRebuilt(third, first, r1, 'past the TTL');
  assert.deepEqual(encode(third), freshBuild(dark), 'what is served equals a fresh build on the same map');
});

test('★★★ A2 through the report chokepoint: self-consumption is served with no read, and carbon reads no Core series', async (t) => {
  const tick = setup(t);
  const dark = darkFleet();
  const first = await viaReport(dark); // the first sight of every element resets the caches
  tick();
  const r1 = total();
  assertCached(await viaReport(dark), first, r1, 'the second request');
  const c0 = coreReads();
  const carbon = await reports.buildReport('carbon', ctxOf(dark)) as Any;
  assert.equal(coreReads(), c0, 'carbon\'s own self-consumption read hits the cache: no Core series is read');
  assert.equal(carbon.basisComplete, false, 'carbon\'s published basis is unchanged: no Core projected');
  tick();
  const c1 = coreReads();
  computeCarbonReport(dark, history);
  assert.equal(coreReads(), c1, 'and again: carbon itself is not cached while no Core is projected, its self-consumption read is');
});

test('★★★ A3 a Core still listed online with no projection once HOME_BASIS_PENDING_MAX_MS has passed is known dark: cached', (t) => {
  const tick = setup(t);
  tick(HOME_BASIS_PENDING_MAX_MS + MIN); // the bound is counted from the analytics module's load
  const stuck = { ...darkFleet(), [A]: core(A, false, true) };
  const first = sc(stuck);
  assert.deepEqual(encode(first), freshBuild(stuck));
  const cached = sc(stuck); // freshBuild refilled the entry
  tick();
  const r1 = total();
  assertCached(sc(stuck), cached, r1, 'the second call');
});

test('★★★ A4 inside the pending bound: a Core listed online before its first quota (P3), or every Core so (P4), is rebuilt on every call', (t) => {
  const tick = setup(t);
  for (const pending of [{ ...darkFleet(), [A]: core(A, false, true) }, { [PANEL]: panel(CORES), [A]: core(A, false, true), [B]: core(B, false, true), [C]: core(C, false, true) }]) {
    resetSelfConsumptionCache();
    const first = sc(pending);
    tick();
    const r1 = total();
    const second = sc(pending);
    assertRebuilt(second, first, r1, 'a pending map is never latched');
    assert.deepEqual(encode(second), freshBuild(pending));
  }
  // Its value is the dark map's (a Core with no projection is restored from its record either way), so
  // an entry built on the dark map is served on it, and equals a fresh build there.
  resetSelfConsumptionCache();
  tick();
  const dark = darkFleet();
  const darkEntry = sc(dark);
  const pending = { ...dark, [A]: core(A, false, true) };
  const r2 = total();
  assertCached(sc(pending), darkEntry, r2, 'the dark entry on the P3 map');
  assert.deepEqual(encode(darkEntry), freshBuild(pending), 'equal to a fresh build on the pending map at that instant');
});

test('★★★ A5 a panel listing no Core, and a fleet with no projection at all: rebuilt on every call', (t) => {
  const tick = setup(t);
  for (const [map, reads] of [[darkFleet([]), true], [{ [A]: core(A, false), [B]: core(B, false), [C]: core(C, false) }, false]] as Array<[Any, boolean]>) {
    resetSelfConsumptionCache();
    const first = sc(map);
    tick();
    const r1 = total();
    const second = sc(map);
    assertRebuilt(second, first, r1, 'never latched', reads);
    assert.deepEqual(encode(second), freshBuild(map));
  }
});

for (const [name, fleet] of FLEETS) {
  test(`★★★ A7 P1 a dark Core LEAVES the panel source list (${name}): rebuilt, directly and through the chokepoint`, async (t) => {
    const tick = setup(t);
    const full = fleet(darkFleet());
    const after = fleet(darkFleet([A, B]));
    for (const call of [sc, viaReport] as Array<(d: Any) => SelfConsumption | Promise<SelfConsumption>>) {
      freshWorker();
      const s1 = await call(full);
      assert.equal(s1.homeDpusConnected, 3);
      tick();
      const r1 = total();
      const s2 = await call(after);
      assertRebuilt(s2, s1, r1, 'the departure');
      assert.equal(s2.homeDpusConnected, 2);
      assert.ok(s2.pvKwh < s1.pvKwh, 'the departed Core\'s PV is no longer summed');
      assert.deepEqual(encode(s2), freshBuild(after));
    }
  });

  test(`★★★ A8 P5 a dark Core RETURNS inside the re-arrival window, the reset deferred (${name}): rebuilt, equal to a fresh build`, async (t) => {
    const tick = setup(t);
    const full = fleet(darkFleet());
    const dip = fleet(darkFleet([A, B]));
    await viaReport(full);
    // A first dip-and-return takes the re-arrival allowance: that return resets at once.
    tick();
    await viaReport(dip);
    tick();
    await viaReport(full);
    // A second dip whose entry is in the cache when the source returns (as when the entry from before
    // the dip expired during it) ...
    resetSelfConsumptionCache();
    tick();
    const sDip = await viaReport(dip);
    assert.equal(sDip.homeDpusConnected, 2);
    tick();
    // ... and the source returns inside BASIS_REARRIVAL_RESET_MIN_MS of the last reset: deferred.
    const r1 = total();
    const sBack = await viaReport(full);
    assertRebuilt(sBack, sDip, r1, 'the deferred re-arrival');
    assert.equal(sBack.homeDpusConnected, 3);
    assert.deepEqual(encode(sBack), freshBuild(full));
  });

  test(`★★★ A10 a dark Core gains a projection (${name}): rebuilt at once`, (t) => {
    const tick = setup(t);
    const dark = fleet(darkFleet());
    const s1 = sc(dark);
    assert.equal(s1.homeDpusReporting, 0);
    tick();
    const back = { ...dark, [A]: core(A, true) };
    const r1 = total();
    const s2 = sc(back);
    assertRebuilt(s2, s1, r1, 'a returning Core');
    assert.equal(s2.homeDpusReporting, 1);
    assert.deepEqual(encode(s2), freshBuild(back));
  });

  test(`★★★ A12 the house panel moves to the other panel, every Core dark (${name}): rebuilt on that panel's load`, (t) => {
    const tick = setup(t);
    const pinned = (house: string): Any => fleet({
      [PANEL]: panel(CORES, PANEL, { housePanel: house === PANEL }),
      [PANEL2]: panel([], PANEL2, { housePanel: house === PANEL2 }),
      [A]: core(A, false), [B]: core(B, false), [C]: core(C, false),
    });
    const s1 = sc(pinned(PANEL));
    assert.equal(s1.loadKwh, Math.round(2700 * 7 * 24) / 1000);
    tick();
    const r1 = total();
    assertCached(sc(pinned(PANEL)), s1, r1, 'the same pin');
    // An operator re-pins (POST /api/house-panel): no element arrives or leaves, the source list stands.
    const moved = pinned(PANEL2);
    const s2 = sc(moved);
    assertRebuilt(s2, s1, r1, 'the moved pin');
    assert.equal(s2.loadKwh, Math.round(1900 * 7 * 24) / 1000, 'the new house panel\'s load');
    assert.deepEqual(encode(s2), freshBuild(moved));
  });
}

test('★★★ A9 Core A projected, B and C dark: A leaves the source list and returns inside the deferred window, rebuilt each time', async (t) => {
  const tick = setup(t);
  const full = { ...darkFleet(), [A]: core(A, true) };
  const dip = { ...darkFleet([B, C]), [A]: core(A, true) };
  const s1 = await viaReport(full);
  assert.equal(s1.homeDpusReporting, 1);
  tick();
  let r = total();
  const s2 = await viaReport(dip);
  assertRebuilt(s2, s1, r, 'the departure of the projected Core');
  assert.equal(s2.pvKwh, Math.round((1100 + 700) * 7 * 24) / 1000, 'A\'s PV is gone');
  assert.deepEqual(encode(s2), freshBuild(dip));
  tick();
  r = total();
  const s3 = await viaReport(full); // the first re-arrival: reset at once
  assertRebuilt(s3, s2, r, 'the first return');
  tick();
  r = total();
  const s4 = await viaReport(dip);
  assertRebuilt(s4, s3, r, 'the second departure');
  tick();
  r = total();
  const s5 = await viaReport(full); // inside BASIS_REARRIVAL_RESET_MIN_MS: the reset is deferred
  assertRebuilt(s5, s4, r, 'the deferred return');
  assert.equal(s5.pvKwh, Math.round((1500 + 1100 + 700) * 7 * 24) / 1000);
  assert.deepEqual(encode(s5), freshBuild(full));
});

test('★★ A11 every Core projected: cached on the second call, as before', (t) => {
  const tick = setup(t);
  const lit = { [PANEL]: panel(CORES), [A]: core(A, true), [B]: core(B, true), [C]: core(C, true) };
  const s1 = sc(lit);
  assert.equal(s1.homeDpusReporting, 3);
  assert.deepEqual(encode(s1), freshBuild(lit));
  const cached = sc(lit); // freshBuild refilled the entry
  tick(60_000);
  const r1 = total();
  assertCached(sc(lit), cached, r1, 'the second call');
});
