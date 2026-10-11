/**
 * v1.187.18 — no worker report built on a boot-time partial device map is served on the full one.
 *
 * 2026-10-11 12:23 (a restart): the analytics worker's first warm pass ran on a map where one bench
 * Core had a projection and the panel had none. computeDegradation cached its 4-pack report for the
 * full 30-min TTL (HA degradation_packs_total 4 of 24, projecting 0, no soonest EOL until 12:53), and
 * a sweep found 13 of the 25 worker reports could latch a partial basis the same way. The v1.186.3
 * hydration guard clears only the main thread's 20 s cache; and a request on the full map JOINED a
 * degradation flight that had started on the partial one (4/4/4 packs where 4/24/24 is right).
 *
 * The matrix: for every warm report, a build on a partial map followed by a build on the full map
 * must equal a cold build on the full map (scenario "spare-first": the 12:23 map; "panel-late":
 * every Core projected, the panel listed online but not yet projected). The mechanism is the report
 * chokepoint (reports.ts buildReport + resetWorkerReportCaches), exercised directly below.
 * Device and pack ids are made up.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRecorderStub } from './helpers/recorderStub.js';

const TMP = mkdtempSync(join(tmpdir(), 'boot-partial-basis-'));
process.env.DATA_DIR = TMP;
process.env.LIGHTING_POSTURE_STATE_PATH = join(TMP, 'lp.json');
process.env.NWS_ENABLED = 'false';
after(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

// A frozen clock: the same instant for the cold build and the partial-then-full build, so a report
// that varies with time cannot differ between them for that reason. Steps forward only on purpose.
const NOW0 = Math.floor(Date.now() / 3_600_000) * 3_600_000 + 30 * 60_000;
let clock = NOW0;
Date.now = () => clock;

const weatherMod = await import('../src/weather.js');
const analytics = await import('../src/analytics.js');
const reports = await import('../src/reports.js');
const fleet = await import('../src/analytics/fleet.js');
const flightBasis = await import('../src/analytics/flightBasis.js');

type Any = any;
const H = 3_600_000;
const SN = {
  H1: 'COREXXX00XXX0001', H2: 'COREXXX00XXX0002', H3: 'COREXXX00XXX0003',
  S4: 'COREXXX00XXX0004', S5: 'COREXXX00XXX0005', P: 'PANEXXX00XXX0001',
};
const HOME = [SN.H1, SN.H2, SN.H3];

// ── synthetic weather (past 8 d + next 3 d) ────────────────────────────────────────────────────
const sunFrac = (ts: number) => {
  const h = new Date(ts).getHours() + new Date(ts).getMinutes() / 60;
  return h > 6 && h < 18 ? Math.sin((Math.PI * (h - 6)) / 12) : 0;
};
const wxHours: Any[] = [];
for (let t = Math.floor((NOW0 - 8 * 24 * H) / H) * H; t < NOW0 + 3 * 24 * H; t += H) {
  wxHours.push({ ts: t, cloudCoverPct: 10, radiationWm2: Math.round(850 * sunFrac(t)), tempC: 25 + 8 * sunFrac(t), ensembleSources: 1 });
}
weatherMod.setWeatherCacheForTesting({ fetchedAt: NOW0, hours: wxHours } as Any);

// ── synthetic recorder: every (sn, metric) a deterministic series ─────────────────────────────
/** The panel writes no panel_load row (a panel whose channels report no watts). */
let panelSilent = false;
const peakPv = (sn: string) => (HOME.includes(sn) ? 3000 + 300 * HOME.indexOf(sn) : sn === SN.S4 ? 400 : 0);
function val(sn: string, metric: string, ts: number): number | null {
  const s = sunFrac(ts);
  const ageDays = (NOW0 - ts) / (24 * H);
  if (sn === 'weather') {
    if (metric.startsWith('ghi_wm2')) return Math.round(850 * s);
    if (metric === 'cloud_pct') return 10;
    return null;
  }
  if (sn === SN.P) {
    if (metric === 'panel_load') return panelSilent ? null : 1500 + 500 * s;
    if (metric === 'backup_pct') return 70;
    if (metric === 'grid_home_w') return 300;
    if (/^pair\d+_w$/.test(metric)) return 0;
    return 100;
  }
  if (metric === 'pv_total') return peakPv(sn) * s;
  if (metric === 'pv_high' || metric === 'pv_low') return (peakPv(sn) * s) / 2;
  if (metric === 'soc') return 60 + 30 * s;
  if (metric === 'chg_max_soc') return 100;
  if (metric === 'ac_in') return 0;
  if (metric === 'total_in') return peakPv(sn) * s;
  if (metric === 'total_out') return 800;
  if (metric === 'bat_vol') return 52 + 2 * s;
  if (metric === 'bat_amp') return 20 * s - 8;
  let m: RegExpExecArray | null;
  if ((m = /^pack(\d+)_soh$/.exec(metric))) return 99 - Number(m[1]) * 0.1 - ageDays * 0.01;
  if ((m = /^pack(\d+)_temp$/.exec(metric))) return 28 + 6 * s + Number(m[1]) * 0.2;
  if ((m = /^pack(\d+)_in$/.exec(metric))) return 600 * s;
  if ((m = /^pack(\d+)_out$/.exec(metric))) return s > 0 ? 0 : 250;
  if ((m = /^pack(\d+)_vol_diff_mv$/.exec(metric))) return 10;
  if ((m = /^pack(\d+)_vol$/.exec(metric))) return 53000 + 1500 * s;
  if ((m = /^pack(\d+)_soc$/.exec(metric))) return 60 + 30 * s;
  return 50 + 10 * s;
}
function series(sn: string, metric: string, since: number, until: number, bucketSec?: number) {
  const step = Math.max(300, bucketSec ?? 300) * 1000;
  const out: Array<{ ts: number; value: number }> = [];
  const start = Math.max(since, NOW0 - 45 * 24 * H);
  for (let t = Math.ceil(start / step) * step; t <= until; t += step) {
    const v = val(sn, metric, t);
    if (v != null) out.push({ ts: t, value: v });
  }
  return out;
}
let scans = 0;
const recorder = makeRecorderStub({
  query: (sn, metric, since, until, bucketSec) => { scans++; return series(sn, metric, since, until, bucketSec); },
  queryMulti: (sn, metrics, since, until, bucketSec) => {
    scans++;
    const m = new Map<string, Array<{ ts: number; value: number }>>();
    for (const k of metrics) m.set(k, series(sn, k, since, until, bucketSec));
    return m;
  },
  listMetrics: () => [],
});

// ── device maps ────────────────────────────────────────────────────────────────────────────────
function pack(num: number): Any {
  return {
    num, soc: 80, soh: 99, actSoh: 99 - num * 0.1, inputWatts: 0, outputWatts: 0, temp: 30, cycles: 150,
    remainTimeMin: null, packSn: `PACKXXX00XX${num}`, designCapMah: 60_000, fullCapMah: 59_000, remainCapMah: 47_000,
    accuChgMah: 9_000_000, accuDsgMah: 8_700_000, maxVolDiffMv: 10, maxCellTemp: 31, minCellTemp: 29,
  };
}
function dpu(sn: string, name: string, nPacks: number, projected: boolean): Any {
  return {
    sn, deviceName: name, productName: 'DELTA Pro Ultra', online: true, lastUpdated: NOW0, lastQuotaAtMs: NOW0,
    ...(projected ? { projection: {
      kind: 'dpu', soc: 80, packCount: nPacks, packs: Array.from({ length: nPacks }, (_, i) => pack(i + 1)),
      pvHighWatts: 1000, pvLowWatts: 1000, pvTotalWatts: 2000, acInWatts: 0, acOutWatts: 800, batVol: 53, batAmp: 5,
      totalInWatts: 2000, totalOutWatts: 800, chgMaxSoc: 100, dsgMinSoc: 10, mpptHvTemp: 40, mpptLvTemp: 40,
      splitPhase: { L11: null, L12: null, L14: null, L21: null, L22: null },
    } } : {}),
  };
}
function panel(projected: boolean): Any {
  return {
    sn: SN.P, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online: true, lastUpdated: NOW0, lastQuotaAtMs: NOW0,
    ...(projected ? { projection: {
      kind: 'shp2', area: null, backupBatPercent: 70, backupFullCapWh: 92_200, backupRemainWh: 64_540,
      backupReserveSoc: 16, circuits: [{ ch: 1, name: 'House', watts: 1500, setAmp: 50, linkCh: null, linkMark: false, loadPriority: 1, loadIsEnable: true }],
      pairedCircuits: [{ primaryCh: 1, secondaryCh: null, name: 'House', watts: 1500, breakerAmps: 50 }],
      sources: HOME.map((sn, i) => ({ slot: i + 1, sn, batteryPercentage: 70, isConnected: true, isAcOpen: true, fullCap: 30_000, ratePower: 7200, emsBatTemp: 30, hwConnect: true, errorCodeNum: 0 })),
      sourceWatts: [], gridWatt: 0, gridSta: 1, gridConnected: true, strategy: {},
    } } : {}),
  };
}
type Proj = { P: boolean; H1: boolean; H2: boolean; H3: boolean; S4: boolean; S5: boolean };
function map(p: Proj): Record<string, Any> {
  return {
    [SN.P]: panel(p.P),
    [SN.H1]: dpu(SN.H1, 'Core 1', 5, p.H1),
    [SN.H2]: dpu(SN.H2, 'Core 2', 5, p.H2),
    [SN.H3]: dpu(SN.H3, 'Core 3', 5, p.H3),
    [SN.S4]: dpu(SN.S4, 'Core 4', 5, p.S4),
    [SN.S5]: dpu(SN.S5, 'Core 5', 4, p.S5),
  };
}
const FULL = () => map({ P: true, H1: true, H2: true, H3: true, S4: true, S5: true });
const PARTIAL: Record<string, () => Record<string, Any>> = {
  /** 12:23:26 live: the bench Core alone projected; the panel and the home Cores listed online. */
  spareFirst: () => map({ P: false, H1: false, H2: false, H3: false, S4: false, S5: true }),
  /** every Core projected, the panel listed online but not yet projected (membership unknown). */
  panelLate: () => map({ P: false, H1: true, H2: true, H3: true, S4: true, S5: true }),
};

const ctx = (devices: Record<string, Any>) => ({ recorder, snapshot: { generatedAt: clock, devices } as Any, log: () => {} });
const NAMES = [...reports.WARM_REPORTS, 'baselineAlerts', 'forecastAlerts', 'curtailmentAlerts'];

/** A fresh worker: no basis seen, no cached result, no runway hysteresis carried over. */
function coldWorker(): void {
  reports.resetReportBasisForTesting();
  analytics.resetWorkerReportCaches();
  analytics.resetRunwayCache();
}

async function buildAll(devices: Record<string, Any>): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const n of NAMES) {
    try { out[n] = await reports.buildReport(n, ctx(devices)); }
    catch (e: any) { out[n] = { __error: String(e?.message ?? e) }; }
  }
  return out;
}

/** Structural diff with a 2 % numeric tolerance; time stamps are not compared. */
const TIME_KEYS = new Set(['generatedAt', 'ts', 'minProjectedSocTs', 'reserveAtMs', 'emptyAtMs', 'troughAtMs', 'eolDate',
  'kalmanEolDate', 'predictedPeakAtMs', 'frozenAtMs', 'weatherFetchedAtMs']);
function diff(a: unknown, b: unknown, path: string, out: string[]): void {
  if (out.length > 4) return;
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = a as Record<string, unknown>;
    const kb = b as Record<string, unknown>;
    for (const k of [...new Set([...Object.keys(ka), ...Object.keys(kb)])].sort()) {
      if (TIME_KEYS.has(k)) continue;
      if (!(k in ka) || !(k in kb)) { out.push(`${path}.${k}: only in ${k in ka ? 'got' : 'truth'}`); continue; }
      diff(ka[k], kb[k], `${path}.${k}`, out);
    }
  } else if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) { out.push(`${path}: length ${a.length} vs ${b.length}`); return; }
    a.forEach((x, i) => diff(x, b[i], `${path}[${i}]`, out));
  } else if (typeof a === 'number' && typeof b === 'number') {
    if (Math.abs(a - b) > 0.02 * Math.max(1, Math.abs(a), Math.abs(b))) out.push(`${path}: ${a} vs ${b}`);
  } else if (a !== b) {
    out.push(`${path}: ${JSON.stringify(a)?.slice(0, 60)} vs ${JSON.stringify(b)?.slice(0, 60)}`);
  }
}

let truth: Record<string, unknown> = {};

test('a cold build on the full map (the reference)', { timeout: 120_000 }, async () => {
  coldWorker();
  truth = await buildAll(FULL());
  const deg = truth.degradation as Any;
  assert.equal(deg.packs.length, 24, 'every Core\'s packs');
  assert.equal(deg.packs.filter((p: Any) => p.home).length, 15, 'home = the panel\'s three Cores');
  for (const n of NAMES) assert.ok(!(truth[n] as Any)?.__error, `${n}: ${(truth[n] as Any)?.__error}`);
});

for (const scenario of Object.keys(PARTIAL)) {
  test(`★★★ ${scenario}: every report built on the partial map, then asked on the full map, equals the cold full-map build`, { timeout: 120_000 }, async () => {
    coldWorker();
    const partial = await buildAll(PARTIAL[scenario]());
    if (scenario === 'spareFirst') assert.equal((partial.degradation as Any).packs.length, 4, 'the 12:23 report: one bench Core');
    const got = await buildAll(FULL());
    const poisoned: string[] = [];
    for (const n of NAMES) {
      const d: string[] = [];
      diff(got[n], truth[n], n, d);
      if (d.length) poisoned.push(`${n} ← ${d.slice(0, 3).join(' | ')}`);
    }
    assert.deepEqual(poisoned, [], `served from the partial basis:\n  ${poisoned.join('\n  ')}`);
  });
}

test('★★★ race: a full-map request does not JOIN a degradation flight that started on the partial map (4 / 24 / 24)', { timeout: 60_000 }, async () => {
  coldWorker();
  const count = (r: unknown) => (r as Any).packs.length;
  // 1) a degradation flight starts on the spare-first map (it yields after every pack) …
  const pA = reports.buildReport('degradation', ctx(PARTIAL.spareFirst()));
  // 2) … the hydrated map lands while it is in flight, and the HA publish asks again …
  await new Promise<void>((r) => setImmediate(r));
  const pB = reports.buildReport('degradation', ctx(FULL()));
  const [a, b] = await Promise.all([pA, pB]);
  // 3) … and a later request on the full map (inside the 30-min TTL).
  const c = await reports.buildReport('degradation', ctx(FULL()));
  assert.deepEqual([count(a), count(b), count(c)], [4, 24, 24]);
});

test('★★★ race: a full-map forecast request does not join the partial map\'s forecast scan (the inner flight is per basis too)', { timeout: 60_000 }, async () => {
  coldWorker();
  const pA = reports.buildReport('forecast', ctx(PARTIAL.panelLate()));
  const pB = reports.buildReport('runway', ctx(FULL()));
  const [, runway] = await Promise.all([pA, pB]);
  const fc = await reports.buildReport('forecast', ctx(FULL()));
  const d: string[] = [];
  diff(fc, truth.forecast, 'forecast', d);
  assert.deepEqual(d, []);
  const r: string[] = [];
  diff(runway, truth.runway, 'runway', r);
  assert.deepEqual(r, [], 'the runway on the full map was computed on the full map\'s forecast');
});

test('★★★ a flight that straddles the basis change cannot leave its partial result behind (its writes are dropped)', { timeout: 60_000 }, async () => {
  coldWorker();
  // chargeCurve starts on the partial map; the full map arrives with ANOTHER report's request
  // (its reset runs before chargeCurve has written anything) …
  const pA = reports.buildReport('chargeCurve', ctx(PARTIAL.spareFirst()));
  const pB = reports.buildReport('thermalEvents', ctx(FULL()));
  const [a] = await Promise.all([pA, pB]);
  assert.equal((a as Any).packs.length, 4, 'the partial request is answered on its own basis');
  // … so the partial result was written AFTER the reset. It must not be served on the full map.
  const c = await reports.buildReport('chargeCurve', ctx(FULL()));
  const d: string[] = [];
  diff(c, truth.chargeCurve, 'chargeCurve', d);
  assert.deepEqual(d, []);
});

test('★★★ a flight on the CURRENT basis that overlaps a superseded one keeps what it cached (no chained resets)', { timeout: 60_000 }, async () => {
  coldWorker();
  // A starts on the 12:23 map; one turn later the hydrated map arrives with B, C and D.
  const pA = reports.buildReport('degradation', ctx(PARTIAL.spareFirst()));
  await new Promise<void>((r) => setImmediate(r));
  const rest = ['chargeCurve', 'thermalEvents', 'internalResistance'].map((n) => reports.buildReport(n, ctx(FULL())));
  const gen = flightBasis.basisGeneration();
  await Promise.all([pA, ...rest]);
  assert.equal(flightBasis.basisGeneration(), gen, 'A settling on the superseded basis resets nothing');
  const before = scans;
  await reports.buildReport('chargeCurve', ctx(FULL()));
  await reports.buildReport('internalResistance', ctx(FULL()));
  assert.equal(scans, before, 'B and D are served from cache: no rescan');
});

test('★★ the flight key carries the basis: same basis joins, a different basis does not', async () => {
  coldWorker();
  let started = 0;
  const flights = reports.keyedSingleFlight();
  const slow = () => { started++; return new Promise((r) => setTimeout(() => r(started), 20)); };
  const k = (devs: Record<string, Any>) => `${reports.buildFlightKey('x', {})} @${fleet.reportBasisKey(devs)}`;
  await Promise.all([flights.run(k(FULL()), slow), flights.run(k(FULL()), slow), flights.run(k(PARTIAL.spareFirst()), slow)]);
  assert.equal(started, 2);
  // and buildReport uses it: two concurrent requests on one basis scan once
  analytics.resetWorkerReportCaches();
  const before = scans;
  await Promise.all([reports.buildReport('chargeCurve', ctx(FULL())), reports.buildReport('chargeCurve', ctx(FULL()))]);
  const one = scans - before;
  analytics.resetWorkerReportCaches();
  const mid = scans;
  await Promise.all([reports.buildReport('chargeCurve', ctx(FULL())), reports.buildReport('chargeCurve', ctx(PARTIAL.panelLate()))]);
  assert.ok(scans - mid > one, 'a request on a different basis runs its own scan');
});

test('reportBasisKey — projected Cores | projected panels | panel-listed Cores; pack numbers are not part of it', () => {
  assert.equal(fleet.reportBasisKey({}), '||');
  assert.equal(fleet.reportBasisKey(PARTIAL.spareFirst()), `${SN.S5}||`);
  assert.equal(fleet.reportBasisKey(FULL()), `${[SN.H1, SN.H2, SN.H3, SN.S4, SN.S5].join(',')}|${SN.P}|${HOME.join(',')}`);
  const fewerPacks = FULL();
  fewerPacks[SN.H1].projection.packs.pop();
  assert.equal(fleet.reportBasisKey(fewerPacks), fleet.reportBasisKey(FULL()), 'a pack hidden by one payload does not move the key');
});

/* ── the chokepoint's reset rule ────────────────────────────────────────────────────────────── */

const K = (devs: Record<string, Any>) => fleet.reportBasisKey(devs);
const withoutSource = (): Record<string, Any> => {
  const m = FULL();
  m[SN.P].projection.sources = m[SN.P].projection.sources.filter((s: Any) => s.sn !== SN.H3);
  return m;
};

test('★★★ an ARRIVING element resets at once; the same key does not; a LEAVING element does not', () => {
  coldWorker();
  const e0 = reports.noteReportBasis(K({}), clock);
  const e1 = reports.noteReportBasis(K(PARTIAL.spareFirst()), clock);
  assert.equal(e1, e0 + 1, 'the first projection: reset');
  const e2 = reports.noteReportBasis(K(FULL()), clock);
  assert.equal(e2, e1 + 1, 'the hydrated map: reset');
  assert.equal(reports.noteReportBasis(K(FULL()), clock), e2, 'unchanged: no reset');
  assert.equal(reports.noteReportBasis(K(withoutSource()), clock), e2, 'a source leaving: no reset (no thrash)');
});

test('★★★ a source that flickers resets at most once per window; a deferred reset fires at the window, never dropped', () => {
  coldWorker();
  reports.noteReportBasis(K(FULL()), clock);
  const e0 = reports.noteReportBasis(K(withoutSource()), clock);
  const e1 = reports.noteReportBasis(K(FULL()), clock + 1_000);
  assert.equal(e1, e0 + 1, 'the first return: reset at once');
  // the source flickers for the rest of the window: no further reset inside it
  let e = e1;
  for (let t = 2_000; t < reports.BASIS_REARRIVAL_RESET_MIN_MS; t += 30_000) {
    e = reports.noteReportBasis(K(withoutSource()), clock + t);
    e = reports.noteReportBasis(K(FULL()), clock + t + 15_000);
  }
  assert.equal(e, e1, 'a flapping source costs one cold pass per window, not one per flap');
  // the deferred reset fires on the first request past the window, on the same key
  const e2 = reports.noteReportBasis(K(FULL()), clock + 1_000 + reports.BASIS_REARRIVAL_RESET_MIN_MS);
  assert.equal(e2, e1 + 1, 'what was built during a dip is served for at most one window');
  assert.equal(reports.noteReportBasis(K(FULL()), clock + 2_000 + reports.BASIS_REARRIVAL_RESET_MIN_MS), e2, 'and only once');
  // … and the pending flag is cleared by it: the same key, windows later, never resets again
  for (const w of [2, 3, 4]) {
    assert.equal(reports.noteReportBasis(K(FULL()), clock + 1_000 + w * reports.BASIS_REARRIVAL_RESET_MIN_MS), e2,
      `${w} windows later: still no reset (a stuck pending flag would reset every window for the life of the worker)`);
  }
});

test('★★ a FIRST sighting resets at once even inside a re-arrival window (a Core new to the account)', () => {
  coldWorker();
  reports.noteReportBasis(K(FULL()), clock);
  reports.noteReportBasis(K(withoutSource()), clock);
  const e1 = reports.noteReportBasis(K(FULL()), clock + 1_000);
  const plus = FULL();
  plus.COREXXX00XXX0006 = dpu('COREXXX00XXX0006', 'Core 6', 5, true);
  assert.equal(reports.noteReportBasis(K(plus), clock + 2_000), e1 + 1);
});

test('★★ a basis change clears the worker\'s cached reports (resetWorkerReportCaches is what runs)', async () => {
  coldWorker();
  await reports.buildReport('thermalEvents', ctx(PARTIAL.spareFirst()));
  const before = scans;
  await reports.buildReport('thermalEvents', ctx(PARTIAL.spareFirst()));
  assert.equal(scans, before, 'same basis: served from cache');
  await reports.buildReport('thermalEvents', ctx(FULL()));
  assert.ok(scans > before, 'new basis: recomputed');
});

test('the worker warms only on a snapshot with a projection, not on the bare device list (load hygiene)', async () => {
  const { readFileSync } = await import('node:fs');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const w = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/analyticsWorker.ts'), 'utf8');
  assert.match(w, /const hasProjections = \(\) => Object\.values\(snapshot\.devices\)\.some\(\(d\) => d\?\.projection != null\);/);
  assert.match(w, /if \(warming \|\| !hasProjections\(\)\) return;/, 'every warm pass, not only the first');
  assert.match(w, /if \(hasProjections\(\)\) \{ clearInterval\(firstWarm\); void warm\(\); \}/);
});

/* ── the runway's carried load survives a basis reset ───────────────────────────────────────── */

test('★★★ a basis reset during a panel-load gap keeps the runway on its carried load (the alarm does not go quiet)', { timeout: 60_000 }, async () => {
  coldWorker();
  const silentPanel = (m: Record<string, Any>) => { for (const c of m[SN.P].projection.circuits) c.watts = null; return m; };
  try {
    const r0 = await reports.buildReport('runway', ctx(FULL())) as Any;
    assert.equal(r0.recentLoadBasis, 'hour-mean');
    // the panel goes silent: no panel_load row, no channel watts
    panelSilent = true;
    clock += 65 * 60_000;
    const r1 = await reports.buildReport('runway', ctx(silentPanel(FULL()))) as Any;
    assert.equal(r1.recentLoadBasis, 'carried');
    assert.equal(r1.recentLoadWatts, r0.recentLoadWatts);
    // a Core seen for the first time (cloud-dark at the restart, back now): a basis reset
    const gen = flightBasis.basisGeneration();
    const plus = silentPanel(FULL());
    plus.COREXXX00XXX0006 = dpu('COREXXX00XXX0006', 'Core 6', 5, true);
    clock += 60_000;
    const r2 = await reports.buildReport('runway', ctx(plus)) as Any;
    assert.equal(flightBasis.basisGeneration(), gen + 1, 'the arrival reset the caches');
    assert.equal(r2.unavailable, null, 'not "panel-load history insufficient"');
    assert.equal(r2.recentLoadBasis, 'carried');
    assert.equal(r2.recentLoadWatts, r0.recentLoadWatts, 'the same carried watts');
    assert.ok(r2.hoursToReserve != null || r2.hoursToEmpty != null || r2.endKwh != null, 'a numeric runway');
  } finally {
    panelSilent = false;
    clock = NOW0;
  }
});

/* ── the race through ONE shared weather fetch ──────────────────────────────────────────────── */

/** Open-Meteo's hourly JSON for the synthetic sky (UTC labels, past 7 d + 4 d ahead). */
function openMeteoJson(): unknown {
  const time: string[] = [];
  const cc: number[] = [];
  const sw: number[] = [];
  const tp: number[] = [];
  const day0 = Math.floor(NOW0 / 86_400_000) * 86_400_000;
  for (let t = day0 - 7 * 86_400_000; t < day0 + 4 * 86_400_000; t += H) {
    time.push(new Date(t).toISOString().slice(0, 16));
    cc.push(10);
    sw.push(Math.round(850 * sunFrac(t)));
    tp.push(25 + 8 * sunFrac(t));
  }
  return { utc_offset_seconds: 0, hourly: { time, cloud_cover: cc, shortwave_radiation: sw, temperature_2m: tp } };
}

/**
 * Build `names` on `first`, then one turn later on the full map, with a COLD weather cache: every
 * flight waits on the one in-flight Open-Meteo fetch (an undici MockAgent, 300 ms), so the flights
 * on both bases resume from the same promise in one microtask drain. Returns, per name, how the
 * full-map answer differs from a cold full-map build on the same weather.
 */
async function raceThroughSharedWeather(first: Record<string, Any>, names: readonly string[]): Promise<string[]> {
  const { MockAgent, setGlobalDispatcher, getGlobalDispatcher } = await import('undici');
  const prev = getGlobalDispatcher();
  const agent = new MockAgent();
  agent.disableNetConnect();
  agent.get('https://api.open-meteo.com')
    .intercept({ path: (p: string) => p.startsWith('/v1/forecast'), method: 'GET' })
    .reply(200, openMeteoJson() as Any).delay(300).persist();
  setGlobalDispatcher(agent);
  try {
    weatherMod.clearWeatherTestOverride();
    coldWorker();
    const pFirst = Promise.all(names.map((n) => reports.buildReport(n, ctx(first))));
    await new Promise<void>((r) => setImmediate(r));
    const pFull = Promise.all(names.map((n) => reports.buildReport(n, ctx(FULL())))); // an arrival: a reset
    const [, full] = await Promise.all([pFirst, pFull]);
    coldWorker();
    const served: string[] = [];
    for (let i = 0; i < names.length; i++) {
      const ref = await reports.buildReport(names[i], ctx(FULL()));
      const d: string[] = [];
      diff(full[i], ref, names[i], d);
      if (d.length) served.push(`${names[i]} ← ${d.slice(0, 3).join(' | ')}`);
    }
    return served;
  } finally {
    setGlobalDispatcher(prev);
    await agent.close();
    weatherMod.setWeatherCacheForTesting({ fetchedAt: NOW0, hours: wxHours } as Any);
  }
}

test('★★★ race through one shared weather fetch: a full-map runway is not answered with the dip map\'s (a source returning)', { timeout: 120_000 }, async () => {
  // The panel's source list without one home Core, then with it: the dip flight's runway and
  // forecast alerts resume from the fetch one microtask ahead of the full map's.
  assert.deepEqual(await raceThroughSharedWeather(withoutSource(), ['runway', 'forecastAlerts', 'clipping']), []);
});

test('★★ race through one shared weather fetch: every warm report at once', { timeout: 120_000 }, async () => {
  assert.deepEqual(await raceThroughSharedWeather(withoutSource(), NAMES), []);
});
