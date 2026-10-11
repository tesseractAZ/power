/**
 * v1.187.18 — the degradation report is not served from a boot-time partial device map.
 *
 * 2026-10-11 12:23 (a restart): the analytics worker's first warm pass built the degradation report
 * on a map where one bench Core had a projection, the panel was listed online but not yet projected
 * (so the empty-membership fallback tagged that Core home), and the home Cores were listed online
 * with no projection. computeDegradation cached it for its full 30-min TTL: /api/degradation and HA
 * read degradation_packs_total 4 (of 24), projecting 0 (of 2) and no soonest EOL (1.5 yr) from
 * 12:23:26 to 12:53:55.
 *
 * Now the cached report carries its basis (every projected pack, and whether panel membership was
 * known) and is served only while it covers the current map; a report built while an online-listed
 * Core or panel had no projection is flagged basisPending, cached only DEGRADE_PENDING_TTL_MS, and
 * its six HA fields publish null. Device and pack ids are made up.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { makeRecorderStub } from './helpers/recorderStub.js';

const TMP = mkdtempSync(join(tmpdir(), 'degr-boot-basis-'));
process.env.DATA_DIR = TMP;
process.env.LIGHTING_POSTURE_STATE_PATH = join(TMP, 'lp.json');
after(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const realNow = Date.now.bind(Date);
let offset = 0;
Date.now = () => realNow() + offset;

const A = await import('../src/analytics.js');
const { computeDegradation, degradationBasis, degradationCacheCovers, degradationBasisPending,
  resetDegradationCacheForTesting, DEGRADE_PENDING_TTL_MS, HOME_BASIS_PENDING_MAX_MS } = A;
const { publishReadiness, withholdUnready, READINESS_FIELDS } = await import('../src/publishReadiness.js');

type Any = any;
const fresh = () => { resetDegradationCacheForTesting(); offset = 0; };

const PANEL = 'PANEXXX00XXX0001';
const C = ['COREXXX00XXX0001', 'COREXXX00XXX0002', 'COREXXX00XXX0003', 'COREXXX00XXX0004', 'COREXXX00XXX0005'];
const HOME = [C[0], C[1], C[4]];
function core(i: number, opts: { online?: boolean; projected?: boolean; packs?: number } = {}): Any {
  const { online = true, projected = true, packs = 5 } = opts;
  return {
    sn: C[i], deviceName: `Core ${i + 1}`, productName: 'DELTA Pro Ultra', online, lastUpdated: Date.now(),
    ...(projected ? { projection: { kind: 'dpu', soc: 80, packs: Array.from({ length: packs }, (_, k) => ({
      num: k + 1, soc: 80, soh: 98, actSoh: 98, cycles: 150, temp: 25, packSn: `PACKXXX00XXX0${i}${k}`, designCapMah: 60000, fullCapMah: 59000,
    })) } } : {}),
  };
}
function panel(opts: { online?: boolean; projected?: boolean } = {}): Any {
  const { online = true, projected = true } = opts;
  return {
    sn: PANEL, deviceName: 'Smart Home Panel 2', productName: 'Smart Home Panel 2', online, lastUpdated: Date.now(),
    ...(projected ? { projection: { kind: 'shp2', circuits: [], sources: HOME.map((sn, k) => ({ slot: k + 1, sn, isConnected: true })) } } : {}),
  };
}
/** The hydrated map: the panel and five Cores, 24 packs (Core 4 has four). */
const fullMap = (): Any => ({ [PANEL]: panel(), ...Object.fromEntries(C.map((sn, i) => [sn, core(i, { packs: i === 3 ? 4 : 5 })])) });
/** 12:23:26 live: the panel listed online and unprojected, Core 4 (a bench spare) alone projected,
 *  the other Cores listed online. */
const bootMap = (): Any => ({ [PANEL]: panel({ projected: false }), ...Object.fromEntries(C.map((sn, i) => [sn, core(i, { projected: i === 3, packs: 4 })])) });

let scans = 0;
const rec = makeRecorderStub({
  query: () => [],
  queryMulti: (_sn: string, metrics: string[]) => { scans++; return new Map(metrics.map((m) => [m, []])); },
});
const homeSns = (r: Any): string[] => [...new Set<string>(r.packs.filter((p: Any) => p.home).map((p: Any) => p.sn))].sort();

test('★★★ the 12:23 boot map is pending, and its report is not served once the map fills', async () => {
  fresh();
  const r1 = await computeDegradation(bootMap(), rec);
  assert.equal(r1.packs.length, 4, 'one bench Core\'s packs');
  assert.equal(r1.basisPending, true);
  offset += 1_000;
  const r2 = await computeDegradation(fullMap(), rec);
  assert.equal(r2.packs.length, 24, 'every Core\'s packs, a second later — not the cached one-Core report');
  assert.equal(r2.basisPending, false);
  assert.deepEqual(homeSns(r2), [...HOME].sort(), 'home = the panel\'s sources, not every Core');
});

test('★★★ panel late: every Core projected, membership arriving alone re-tags home', async () => {
  fresh();
  const m = fullMap();
  m[PANEL] = panel({ projected: false });
  const r1 = await computeDegradation(m, rec);
  assert.equal(r1.packs.filter((p: Any) => p.home).length, 24, 'the empty-membership fallback: every pack home');
  assert.equal(r1.basisPending, true, 'the panel is listed online and unprojected');
  offset += 1_000;
  const r2 = await computeDegradation(fullMap(), rec);
  assert.equal(r2.packs.filter((p: Any) => p.home).length, 15, 'three Cores\' packs');
});

test('★★★ panel late and listed OFFLINE: not pending (cached the full TTL), yet re-tagged the moment membership is known', async () => {
  fresh();
  const m = fullMap();
  m[PANEL] = panel({ online: false, projected: false });
  const r1 = await computeDegradation(m, rec);
  assert.equal(r1.basisPending, false);
  offset += 10 * 60_000;
  assert.equal((await computeDegradation(m, rec)).generatedAt, r1.generatedAt, 'the same map: cached');
  const r2 = await computeDegradation(fullMap(), rec);
  assert.notEqual(r2.generatedAt, r1.generatedAt, 'membership became known: rebuilt');
  assert.equal(r2.packs.filter((p: Any) => p.home).length, 15);
});

test('★★ no thrash: a Core or pack that LEAVES the map does not force a rescan; a complete report caches 30 min', async () => {
  fresh();
  await computeDegradation(fullMap(), rec);
  const before = scans;
  offset += 60_000;
  const m = fullMap();
  delete m[C[2]];                   // Core 3 gone from the map
  m[C[0]] = core(0, { packs: 4 });  // a pack dropped from Core 1
  const r = await computeDegradation(m, rec);
  assert.equal(scans, before, 'served from cache');
  assert.equal(r.packs.length, 24);
  offset += 60_000;
  await computeDegradation(fullMap(), rec); // back again: still covered
  assert.equal(scans, before);
});

test('★★ a Core arriving later in the process life (cloud-dark at the restart, back later) rescans', async () => {
  fresh();
  const m = fullMap();
  m[C[2]] = core(2, { online: false, projected: false });
  const r1 = await computeDegradation(m, rec);
  assert.equal(r1.packs.length, 19);
  assert.equal(r1.basisPending, false, 'a Core listed OFFLINE is not pending: the report caches for the full TTL');
  offset += 10 * 60_000;
  const r2 = await computeDegradation(fullMap(), rec);
  assert.equal(r2.packs.length, 24, 'its packs appear the moment it projects, not up to 30 min later');
});

test('★★ a pack that ARRIVES on a Core already in the basis rescans', async () => {
  fresh();
  const m = fullMap();
  m[C[0]] = core(0, { packs: 4 });
  assert.equal((await computeDegradation(m, rec)).packs.length, 23);
  offset += 60_000;
  assert.equal((await computeDegradation(fullMap(), rec)).packs.length, 24);
});

test('★★ an online Core whose quota keeps failing: the pending report expires on the short TTL, not 30 min', async () => {
  fresh();
  const m = fullMap();
  m[C[2]] = core(2, { projected: false });
  const r1 = await computeDegradation(m, rec);
  assert.equal(r1.basisPending, true);
  offset += DEGRADE_PENDING_TTL_MS - 1_000;
  assert.equal((await computeDegradation(m, rec)).generatedAt, r1.generatedAt, 'inside the short TTL: cached');
  offset += 2_000;
  assert.notEqual((await computeDegradation(m, rec)).generatedAt, r1.generatedAt, 'past it: rebuilt');
});

test('★★ degradationBasisPending — online-unprojected Core or panel only; offline (wedged) is not; an accessory never; bounded', () => {
  const t = Date.now();
  assert.equal(degradationBasisPending(bootMap(), t, t), true);
  assert.equal(degradationBasisPending(fullMap(), t, t), false);
  const corePending = fullMap(); corePending[C[2]] = core(2, { projected: false });
  assert.equal(degradationBasisPending(corePending, t, t), true, 'a Core alone');
  const panelPending = fullMap(); panelPending[PANEL] = panel({ projected: false });
  assert.equal(degradationBasisPending(panelPending, t, t), true, 'the panel alone');
  const wedged = fullMap();
  wedged[C[2]] = core(2, { online: false, projected: false });
  wedged[PANEL] = panel({ online: false, projected: false });
  assert.equal(degradationBasisPending(wedged, t, t), false);
  const acc = fullMap();
  acc.EVSEXXX00XXX0001 = { sn: 'EVSEXXX00XXX0001', productName: 'EVSE', online: true, deviceName: 'EVSE' };
  assert.equal(degradationBasisPending(acc, t, t), false, 'an accessory listed online never projects and never counts');
  assert.equal(degradationBasisPending({}, t, t), true, 'no device list yet: nothing is known (not "0 packs")');
  assert.equal(degradationBasisPending(bootMap(), t, t - HOME_BASIS_PENDING_MAX_MS - 1), false, 'bounded by the worker\'s life');
});

test('★★ degradationCacheCovers — arrivals invalidate, departures do not; membership known invalidates an unknown basis', () => {
  const b = (pairs: string[], membershipKnown = true) => ({ pairs, membershipKnown });
  assert.equal(degradationCacheCovers(b(['a#1', 'a#2']), b(['a#1', 'a#2'])), true);
  assert.equal(degradationCacheCovers(b(['a#1', 'a#2']), b(['a#1'])), true, 'a pack left: still covered');
  assert.equal(degradationCacheCovers(b(['a#1']), b(['a#1', 'a#2'])), false, 'a pack arrived');
  assert.equal(degradationCacheCovers(b(['a#1'], false), b(['a#1'], true)), false, 'membership became known');
  assert.equal(degradationCacheCovers(b(['a#1'], true), b(['a#1'], false)), true, 'membership lost: what was built knowing it stands');
  const boot = degradationBasis(bootMap());
  assert.deepEqual(boot.pairs, [1, 2, 3, 4].map((n) => `${C[3]}#${n}`));
  assert.equal(boot.membershipKnown, false);
  assert.equal(degradationBasis(fullMap()).pairs.length, 24);
  assert.equal(degradationBasis(fullMap()).membershipKnown, true);
  assert.equal(degradationBasis({ [C[0]]: core(0) }).membershipKnown, true, 'no panel at all (a DPU-only install): known');
});

test('★★★ both publishers withhold the six degradation fields while pending, publish them once full', () => {
  assert.deepEqual([...READINESS_FIELDS.degradation].sort(), [
    'degradation_packs_projecting', 'degradation_packs_total', 'degradation_peer_outliers',
    'degradation_soonest_eol_date', 'degradation_soonest_eol_pack', 'degradation_soonest_eol_years',
  ]);
  const state = () => ({
    degradation_packs_total: 4, degradation_packs_projecting: 0, degradation_soonest_eol_years: null,
    degradation_soonest_eol_date: null, degradation_soonest_eol_pack: null, degradation_peer_outliers: 0, panel_load_watts: 1,
  });
  const base: Any = {
    devices: fullMap(), alerts: [], alertsComplete: true, speakerLastProbeAt: 1, forecast: {}, runway: {},
    clipping: { arrayPeakW: 1 }, curtailment: { basisComplete: true }, carbon: {}, tariff: {},
  };
  const held = withholdUnready(state(), publishReadiness({ ...base, degradation: { basisPending: true } }));
  for (const k of READINESS_FIELDS.degradation) assert.equal((held as Any)[k], null, k);
  const pub = withholdUnready(state(), publishReadiness({ ...base, degradation: { basisPending: false } }));
  assert.equal(pub.degradation_packs_total, 4);
  assert.equal(pub.degradation_peer_outliers, 0);
  const none = withholdUnready(state(), publishReadiness({ ...base, degradation: null }));
  assert.equal(none.degradation_packs_total, null, 'no report this cycle: null');
});

test('both publishers hand the degradation report to publishReadiness', () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const src = (f: string) => readFileSync(resolve(dir, '../src', f), 'utf8');
  for (const f of ['index.ts', 'mqttDiscovery.ts']) {
    const s = src(f);
    const at = s.lastIndexOf('publishReadiness({');
    assert.ok(at > 0, f);
    assert.match(s.slice(at, s.indexOf('}))', at)), /\bdegradation: deg\b/, `${f}: the report reaches the readiness gate`);
  }
});

test('★★★ real worker: the report after the map fills covers every Core (the v1.186.3 guard alone did not)', { timeout: 60_000 }, async () => {
  const keep = setInterval(() => {}, 1000);
  const dbPath = join(TMP, 'w.db');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE samples (ts INTEGER, sn TEXT, metric TEXT, value REAL); CREATE INDEX idx ON samples (sn, metric, ts);');
  db.close();
  const { createAnalyticsClient } = await import('../src/analyticsClient.js');
  const client = createAnalyticsClient(dbPath, () => {}, { firstSnapshotWaitMs: 10 });
  try {
    client.pushSnapshot({ generatedAt: Date.now(), devices: bootMap() });
    const r1 = await client.report<Any>('degradation');
    assert.equal(r1.packs.length, 4);
    assert.equal(r1.basisPending, true);
    client.pushSnapshot({ generatedAt: Date.now(), devices: fullMap() });
    client.flushSnapshot();
    await new Promise((r) => setTimeout(r, 1000));
    const r2 = await client.report<Any>('degradation');
    assert.equal(r2.packs.length, 24);
    assert.equal(r2.basisPending, false);
    assert.deepEqual(homeSns(r2), [...HOME].sort());
  } finally { client.stop(); clearInterval(keep); }
});
