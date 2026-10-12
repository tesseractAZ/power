/**
 * v1.187.20 — the charge-curve report is served while it is rebuilt, never rebuilt in a request.
 *
 * Log 2026-10-12: "analytics: 'report:chargeCurve' timed out — retrying once" at every start (7 of 7,
 * 2026-10-10..12) and at 10:10:09, an hour after the 09:06 start; 10:10:16 '/api/charge-curve 200
 * 36874 ms', the Supervisor ingress stream already closed. The report caches for 60 min and the
 * worker's warm pass (every 4 min) rebuilt it only AFTER expiry, so a dashboard request landing in
 * the gap paid the 200-day, every-pack scan itself (~32 s on 24 packs).
 *
 * Now (analytics.ts computeChargeCurveFingerprint):
 *  - once a value exists, a request past its refresh point gets it at once and ONE background
 *    rebuild replaces it (single-flight per basis generation);
 *  - the warm pass reaches the refresh point before expiry (TTL − 2 × the warm interval);
 *  - a device-basis reset (v1.187.18) nulls the cache, so there is no stale value to serve on the new
 *    basis, and a rebuild that straddles the reset writes nothing (its basis generation is gone).
 * Device ids are made up.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRecorderStub } from './helpers/recorderStub.js';

const TMP = mkdtempSync(join(tmpdir(), 'charge-curve-swr-'));
process.env.DATA_DIR = TMP;
process.env.LIGHTING_POSTURE_STATE_PATH = join(TMP, 'lp.json');
process.env.NWS_ENABLED = 'false';
after(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

// A frozen clock, stepped only on purpose (before the modules load, as the flight bookkeeping reads it).
const T0 = Date.UTC(2026, 9, 12, 16, 6, 53);
let clock = T0;
Date.now = () => clock;

const analytics = await import('../src/analytics.js');
const reports = await import('../src/reports.js');
const fleet = await import('../src/analytics/fleet.js');
const flightBasis = await import('../src/analytics/flightBasis.js');
const { WARM_INTERVAL_MS } = await import('../src/analytics/warmCadence.js');

type Any = any;
const MIN = 60_000;
const TTL = analytics.CHARGE_CURVE_TTL_MS;

/** Every query is counted; `failing` makes the recorder throw (a scan that fails). */
let queries = 0;
let failing = false;
const recorder = makeRecorderStub({
  queryMulti: (_sn, metrics) => {
    if (failing) throw new Error('database is locked');
    queries++;
    return new Map(metrics.map((m) => [m, []]));
  },
});

const core = (sn: string, name: string, packs: number, projected: boolean): Any => ({
  sn, deviceName: name, productName: 'DELTA Pro Ultra', online: true,
  ...(projected ? { projection: { kind: 'dpu', packs: Array.from({ length: packs }, (_, i) => ({ num: i + 1 })) } } : {}),
});
/** Core B listed but not yet projected (a boot-time partial map): 2 packs. */
const PARTIAL = (): Record<string, Any> => ({ COREA: core('COREA', 'Core 1', 2, true), COREB: core('COREB', 'Core 2', 3, false) });
/** Both Cores projected: 5 packs. Core B ARRIVES — the chokepoint resets the worker's caches. */
const FULL = (): Record<string, Any> => ({ COREA: core('COREA', 'Core 1', 2, true), COREB: core('COREB', 'Core 2', 3, true) });

const logs: string[] = [];
const ctx = (devices: Record<string, Any>) => ({ recorder, snapshot: { generatedAt: clock, devices } as Any, log: (m: string) => logs.push(m) });
const ask = (devices: Record<string, Any>) => reports.buildReport('chargeCurve', ctx(devices)) as Promise<Any>;
const K = (devices: Record<string, Any>) => fleet.reportBasisKey(devices);

/** Wait out every background rebuild (one may replace another). Stops on a slot that does not
 *  change after it settles, so a slot that never frees fails an assertion instead of hanging. */
async function settle(): Promise<void> {
  let last: Promise<void> | null = null;
  for (let p = analytics.chargeCurveRefreshForTesting(); p && p !== last; p = analytics.chargeCurveRefreshForTesting()) {
    last = p;
    await p;
  }
}

/** A fresh worker: no basis seen, nothing cached, no rebuild left running from an earlier case. */
async function coldWorker(): Promise<void> {
  await settle();
  reports.resetReportBasisForTesting();
  analytics.resetWorkerReportCaches();
  clock = T0;
  queries = 0;
  failing = false;
  logs.length = 0;
}

/** Queries one full-map build issues (5 packs × ~29 week slices). */
let fullBuild = 0;

test('the refresh window: two warm intervals ahead of the 60-min TTL; stale for at most one more TTL', () => {
  assert.equal(WARM_INTERVAL_MS, 4 * MIN);
  assert.equal(TTL, 60 * MIN);
  assert.equal(analytics.CHARGE_CURVE_REFRESH_AHEAD_MS, 8 * MIN);
  assert.equal(analytics.CHARGE_CURVE_REFRESH_AHEAD_MS, 2 * WARM_INTERVAL_MS, 'derived from the cadence the worker runs');
  assert.equal(analytics.CHARGE_CURVE_STALE_MAX_MS, 60 * MIN);
  // Last resort, labelled: the worker's timer is the shared interval, not a local copy of it.
  const w = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/analyticsWorker.ts'), 'utf8');
  assert.match(w, /^import \{ WARM_INTERVAL_MS \} from '\.\/analytics\/warmCadence\.js';$/m);
  assert.match(w, /setInterval\(\(\) => \{ void warm\(\); \}, WARM_INTERVAL_MS\)/);
  assert.doesNotMatch(w, /^const WARM_INTERVAL_MS\b/m);
});

test('★★★ an expired value is returned AT ONCE while ONE background rebuild replaces it', async () => {
  await coldWorker();
  const v0 = await ask(FULL());
  fullBuild = queries;
  assert.ok(fullBuild >= 5 * 29, `a cold build scans every pack (${fullBuild} queries)`);
  assert.equal(v0.generatedAt, T0);
  assert.equal(v0.packs.length, 5);

  clock = T0 + TTL + MIN; // the 10:09:39 dashboard request: just past the TTL
  const q0 = queries;
  const v1 = await ask(FULL());
  assert.equal(v1.generatedAt, T0, 'the previous value, not a 32 s scan');
  assert.ok(queries - q0 < fullBuild / 2, `answered before the rebuild finished (${queries - q0} of ${fullBuild} queries)`);
  assert.ok(analytics.chargeCurveRefreshForTesting(), 'a background rebuild is running');

  // A second request (and a warm pass) while it runs: the same value, and no second rebuild.
  const v2 = await ask(FULL());
  await reports.warmReports((n) => reports.buildReport(n, ctx(FULL())), (n, e) => assert.fail(`${n}: ${e}`), ['chargeCurve']);
  assert.equal(v2.generatedAt, T0);
  await settle();
  assert.equal(queries - q0, fullBuild, 'three callers, one rebuild');

  const q1 = queries;
  const v3 = await ask(FULL());
  assert.equal(v3.generatedAt, T0 + TTL + MIN, 'the rebuilt value replaced it');
  assert.equal(v3.packs.length, 5);
  assert.equal(queries, q1, 'and is served from cache');
  assert.equal(analytics.chargeCurveRefreshForTesting(), null);
});

test('★★★ the warm pass refreshes AHEAD of expiry, and only inside the window', async () => {
  await coldWorker();
  const warm = () => reports.warmReports((n) => reports.buildReport(n, ctx(FULL())), (n, e) => assert.fail(`${n}: ${e}`), ['chargeCurve']);
  await warm(); // the boot pass: cold
  const q0 = queries;

  clock = T0 + TTL - 2 * WARM_INTERVAL_MS - 30_000; // one pass before the window: nothing to do
  await warm();
  assert.equal(queries, q0, 'a value outside the window is not rebuilt early');
  assert.equal(analytics.chargeCurveRefreshForTesting(), null);

  clock = T0 + TTL - 2 * WARM_INTERVAL_MS + 30_000; // the next pass: inside the window, 7.5 min before expiry
  await warm();
  assert.ok(analytics.chargeCurveRefreshForTesting(), 'the pass started a rebuild before the value expired');
  assert.ok(queries - q0 < fullBuild / 2, 'and did not wait for it');
  await settle();
  const v = await ask(FULL());
  assert.equal(v.generatedAt, T0 + TTL - 2 * WARM_INTERVAL_MS + 30_000);
});

test('★★★ with the warm loop running, no request ever meets a value past its TTL (3 h, a pass skipped every 7)', async () => {
  await coldWorker();
  const warm = () => reports.warmReports((n) => reports.buildReport(n, ctx(FULL())), (n, e) => assert.fail(`${n}: ${e}`), ['chargeCurve']);
  await warm();
  const served: number[] = [];
  let builds = 1;
  for (let m = 1; m <= 180; m++) {
    clock = T0 + m * MIN;
    if (m % 4 === 0 && (m / 4) % 7 !== 3) await warm(); // a pass still running when its tick fires is skipped
    const before = queries;
    const v = await ask(FULL());
    assert.ok(queries - before < fullBuild / 2, `minute ${m}: the request ran no scan of its own`);
    served.push(clock - v.generatedAt);
    if (analytics.chargeCurveRefreshForTesting()) builds++;
    await settle(); // a rebuild (~32 s live) finishes inside the minute
  }
  const oldest = Math.max(...served);
  assert.ok(oldest < TTL, `the oldest value served was ${oldest / MIN} min old`);
  assert.ok(builds >= 3 && builds <= 5, `about one rebuild an hour (${builds})`);
});

test('★★★ after a device-basis reset NO stale value is served: the first request on the new basis builds cold', async () => {
  for (const age of [TTL + MIN, TTL - MIN]) { // expired, and inside the refresh window
    await coldWorker();
    const vP = await ask(PARTIAL());
    assert.equal(vP.packs.length, 2, 'built on the boot-time partial map');
    clock = T0 + age;
    const gen = flightBasis.basisGeneration();
    const vF = await ask(FULL()); // Core B arrives: the chokepoint resets the caches
    assert.equal(flightBasis.basisGeneration(), gen + 1, 'the arrival reset the caches');
    assert.equal(vF.packs.length, 5, `age ${age / MIN} min: not the partial map's report`);
    assert.equal(vF.generatedAt, clock, 'computed now, on the new basis');
    assert.equal(analytics.chargeCurveRefreshForTesting(), null, 'a cold build, not a stale answer plus a rebuild');
  }
});

test('★★★ a background rebuild that straddles a basis reset leaves nothing behind (its write is dropped)', async () => {
  await coldWorker();
  await ask(PARTIAL());
  clock = T0 + TTL + MIN;
  const stale = await ask(PARTIAL()); // stale, and a rebuild on the partial map starts …
  assert.equal(stale.generatedAt, T0);
  const rebuild = analytics.chargeCurveRefreshForTesting();
  assert.ok(rebuild);
  reports.noteReportBasis(K(FULL()), clock); // … Core B arrives with another report's request
  await rebuild; // the partial rebuild finishes AFTER the reset
  const q0 = queries;
  const vF = await ask(FULL());
  assert.equal(vF.packs.length, 5, 'the partial rebuild was not served on the full map');
  assert.ok(queries - q0 >= fullBuild, 'a cold build: the cache was empty');
});

test('★★★ a rebuild started OUTSIDE any flight is still pinned to its basis generation', async () => {
  await coldWorker();
  reports.noteReportBasis(K(PARTIAL()), clock);
  await analytics.computeChargeCurveFingerprint(PARTIAL(), recorder); // a direct call: no flight context
  clock = T0 + TTL + MIN;
  await analytics.computeChargeCurveFingerprint(PARTIAL(), recorder);
  const rebuild = analytics.chargeCurveRefreshForTesting();
  assert.ok(rebuild);
  reports.noteReportBasis(K(FULL()), clock);
  await rebuild;
  const vF = await ask(FULL());
  assert.equal(vF.packs.length, 5, 'its write was dropped like any superseded flight\'s');
});

test('★★ a rebuild from a SUPERSEDED generation does not block the current basis\'s refresh', async () => {
  await coldWorker();
  reports.noteReportBasis(K(PARTIAL()), clock);
  await analytics.computeChargeCurveFingerprint(PARTIAL(), recorder);
  clock = T0 + TTL + MIN;
  // A long rebuild on the partial map (day slices: ~400 turns) …
  await analytics.computeChargeCurveFingerprint(PARTIAL(), recorder, { sliceMs: 24 * 60 * MIN });
  const old = analytics.chargeCurveRefreshForTesting();
  assert.ok(old);
  // … the full map arrives, and its cold build (~150 turns) finishes while the old rebuild still runs.
  const t1 = clock;
  const vF = await ask(FULL());
  assert.equal(vF.generatedAt, t1);
  assert.equal(analytics.chargeCurveRefreshForTesting(), old, 'the superseded rebuild is still running');
  // An hour on, the full map's value is past its TTL: a rebuild on the CURRENT generation starts.
  clock = t1 + TTL + MIN;
  const stale = await ask(FULL());
  assert.equal(stale.generatedAt, t1);
  assert.notEqual(analytics.chargeCurveRefreshForTesting(), old, 'not left to the superseded rebuild, which can write nothing');
  await settle();
  await old;
  const fresh = await ask(FULL());
  assert.equal(fresh.generatedAt, t1 + TTL + MIN, 'refreshed on the current basis');
  assert.equal(fresh.packs.length, 5);
});

test('★★ a superseded flight never starts a rebuild (the map it carries is the old one)', async () => {
  await coldWorker();
  const g1 = reports.noteReportBasis(K(PARTIAL()), clock);
  reports.noteReportBasis(K(FULL()), clock); // the arrival: generation g1 is superseded
  await analytics.computeChargeCurveFingerprint(FULL(), recorder);
  clock = T0 + TTL + MIN;
  // A flight asked on the partial map before the reset reads the (expired) full-map value …
  const v = await flightBasis.runInBasisGeneration(g1, () => analytics.computeChargeCurveFingerprint(PARTIAL(), recorder));
  assert.equal(v.packs.length, 5);
  assert.equal(analytics.chargeCurveRefreshForTesting(), null, '… and starts no rebuild on its own map');
  await settle();
  const vF = await ask(FULL());
  assert.equal(vF.packs.length, 5, 'the current cache still holds the full map\'s report');
});

test('★★ a rebuild that keeps failing is logged, and past the stale bound the request computes (and fails) itself', async () => {
  await coldWorker();
  await ask(FULL());
  failing = true;
  clock = T0 + TTL + MIN;
  const stale = await ask(FULL());
  assert.equal(stale.generatedAt, T0, 'served while the rebuild runs');
  await settle();
  assert.ok(logs.some((l) => l.includes('chargeCurve background rebuild failed') && l.includes('database is locked')), logs.join(' | '));
  clock = T0 + TTL + analytics.CHARGE_CURVE_STALE_MAX_MS - MIN;
  assert.equal((await ask(FULL())).generatedAt, T0, 'inside the bound: still the previous value');
  await settle();
  clock = T0 + TTL + analytics.CHARGE_CURVE_STALE_MAX_MS;
  await assert.rejects(ask(FULL()), /database is locked/, 'a value two hours old is not served: the failure surfaces');
  failing = false;
  const v = await ask(FULL());
  assert.equal(v.generatedAt, clock, 'the next request builds in the foreground');
});
