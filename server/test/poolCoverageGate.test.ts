import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SPARE_DPU_SNS, homeCoreCoverage } from '../src/shp2Membership.js';
import { resolveGridBackstop } from '../src/gridState.js';

/* ===================================================================
 * v1.3.0 (audit rank 3) — the pool-discharge floor guard was blind to a wedged Core.
 *
 * `aggregateFleetFlow.fleetBatteryNet` sums only DPUs that are BOTH cloud-online and
 * SHP2-connected. A home Core that is cloud-wedged — a documented recurring event on this
 * fleet — drops out of the sum while it keeps physically discharging. The v0.98.0 guard
 * then read "net < 50 W, so the pool is not draining" and handed a stale/declared grid the
 * at-floor downgrade it exists to withhold, muting a real emergency.
 *
 * We can PROVE discharge from a partial sum. We can never DISPROVE it. So an incomplete
 * roster resolves toward "discharging" — the direction that keeps the alarm audible.
 * =================================================================== */

const [SPARE_CORE_4] = [...SPARE_DPU_SNS] as [string];
// Read from the literal rather than restated here.

function dpu(sn: string, online: boolean, packNetW = 0): any {
  return {
    sn, online, productName: 'Delta Pro Ultra', lastTelemetryAtMs: Date.now() - 10_000, contentChangedAtMs: Date.now() - 10_000, // v1.179.0 / v1.181.0
    projection: { kind: 'dpu', acInWatts: 0, packs: [{ inputWatts: packNetW < 0 ? -packNetW : 0, outputWatts: packNetW > 0 ? packNetW : 0 }] },
  };
}
/** sources carry isConnected, as the real SHP2 projection does (unlike older fixtures). */
function shp2(connectedSns: string[], gridConnected: boolean | null = true, online = true): any {
  return {
    sn: 'SHP2', online, productName: 'Smart Home Panel 2',
    lastQuotaAtMs: Date.now() - 20_000, // v1.179.0 — a fresh readback
    projection: {
      kind: 'shp2', chargeWattPower: 0, gridWatt: 0, gridConnected, circuits: [],
      sources: connectedSns.map((sn, i) => ({ slot: i + 1, sn, isConnected: true })),
    },
  };
}
const fleet = (...devs: any[]) => Object.fromEntries(devs.map((d) => [d.sn, d]));
const NO_DECL = { gridEntityConfigured: false, gridAvailableFallback: false, entityPresent: null } as any;

/* ── coverage ─────────────────────────────────────────────────────── */

test('coverage is complete when every SHP2-connected Core is reporting', () => {
  const f = fleet(shp2(['A', 'B', 'C']), dpu('A', true), dpu('B', true), dpu('C', true));
  assert.deepEqual(homeCoreCoverage(f), { connected: 3, reporting: 3, complete: true });
});

test('a cloud-wedged home Core makes coverage INCOMPLETE', () => {
  const f = fleet(shp2(['A', 'B', 'C']), dpu('A', true), dpu('B', true), dpu('C', false));
  assert.deepEqual(homeCoreCoverage(f), { connected: 3, reporting: 2, complete: false });
});

test('with no SHP2 roster we fall back to non-spare DPUs — and still notice an offline one', () => {
  // A cloud-offline SHP2 can lose sources[].isConnected. The roster path would then see an
  // EMPTY set and miss the wedged Core entirely; the spare-aware fallback still catches it.
  const f = fleet(dpu('A', true), dpu('B', false));
  assert.deepEqual(homeCoreCoverage(f), { connected: 2, reporting: 1, complete: false });
});

test('an offline BENCH SPARE never makes coverage incomplete', () => {
  const f = fleet(dpu('A', true), dpu(SPARE_CORE_4, false));
  assert.deepEqual(homeCoreCoverage(f), { connected: 1, reporting: 1, complete: true });
});

test('no home Cores at all → nothing to observe, coverage is vacuously complete', () => {
  // There is no pool, so there is no pool drain we are failing to see. This is NOT the
  // "empty set looks fine" trap: the subjects are absent, not the observations.
  assert.deepEqual(homeCoreCoverage(fleet(shp2([]))), { connected: 0, reporting: 0, complete: true });
});

/* ── the guard ────────────────────────────────────────────────────── */

test('gridSta=OK at the floor with ALL Cores reporting and packs idle → still backstopping', () => {
  const g = resolveGridBackstop({
    devices: fleet(shp2(['A', 'B']), dpu('A', true, 0), dpu('B', true, 0)),
    ...NO_DECL, atReserveFloor: true,
  });
  assert.equal(g.backstopping, true, 'full coverage + no observed drain → the v0.89.0 burst-gap fix still holds');
});

test('gridSta=OK at the floor while a home Core is WEDGED → NOT backstopping (the fix)', () => {
  // Core B is wedged and invisible. The visible net is 0 W — under the 50 W threshold — so
  // pre-v1.3.0 this downgraded a real at-floor critical to a low advisory and muted audibles.
  const g = resolveGridBackstop({
    devices: fleet(shp2(['A', 'B']), dpu('A', true, 0), dpu('B', false, 4000)),
    ...NO_DECL, atReserveFloor: true,
  });
  assert.equal(g.backstopping, false, 'an unobservable pool at the reserve floor must not be backstopped');
  assert.match(g.reason, /1\/2 home Cores are reporting/);
  assert.match(g.reason, /unobservable/);
});

test('the coverage gate is FLOOR-SCOPED — a wedged Core away from the floor changes nothing', () => {
  const g = resolveGridBackstop({
    devices: fleet(shp2(['A', 'B']), dpu('A', true, 0), dpu('B', false, 4000)),
    ...NO_DECL, atReserveFloor: false,
  });
  assert.equal(g.backstopping, true, 'normal daily cycling with a wedged Core must not nuisance-escalate');
});

test('an OBSERVED drain at the floor still reports the observed-discharge reason, not coverage', () => {
  const g = resolveGridBackstop({
    devices: fleet(shp2(['A', 'B']), dpu('A', true, 3000), dpu('B', true, 3000)),
    ...NO_DECL, atReserveFloor: true,
  });
  assert.equal(g.backstopping, false);
  assert.match(g.reason, /still discharging at the reserve floor/);
  assert.ok(!/unobservable/.test(g.reason), 'a proven drain must not be reported as a coverage gap');
});

test('a live measured import overrides everything — a wedged Core cannot fake an outage', () => {
  const wedged = dpu('B', false, 4000);
  const importing = dpu('A', true, 0);
  importing.projection.acInWatts = 3000;
  const g = resolveGridBackstop({
    devices: fleet(shp2(['A', 'B']), importing, wedged), ...NO_DECL, atReserveFloor: true,
  });
  assert.equal(g.importLive, true);
  assert.equal(g.backstopping, true, 'proven grid flow is proof; coverage cannot veto it');
});

/* ── v1.188.1 review: a Core listed online on a FROZEN meter is not reporting ── */

/** A Core listed online whose readings stopped changing `agoMs` ago (its quota keeps failing, or
 *  the cloud replays its cached body): its pack figures are the held ones. */
function frozenDpu(sn: string, packNetW = 0, agoMs = 30 * 60_000): any {
  const d = dpu(sn, true, packNetW);
  d.lastTelemetryAtMs = Date.now() - agoMs;
  d.contentChangedAtMs = Date.now() - agoMs;
  return d;
}

test('★★★ coverage with a clock: a Core listed online on a frozen meter is NOT reporting (the timers, the bridge and the sensors already read it so)', () => {
  const f = fleet(shp2(['A', 'B', 'C']), frozenDpu('A'), dpu('B', true), dpu('C', true));
  assert.deepEqual(homeCoreCoverage(f, undefined, Date.now()), { connected: 3, reporting: 2, complete: false });
  // A Core whose content has not changed since a restart is not vouched for either.
  const boot = dpu('A', true);
  delete boot.contentChangedAtMs;
  assert.equal(homeCoreCoverage(fleet(shp2(['A']), boot), undefined, Date.now()).complete, false);
  // Without a clock the roster-only answer is unchanged (the console's quality flag).
  assert.deepEqual(homeCoreCoverage(f), { connected: 3, reporting: 3, complete: true });
});

test('★★★ gridSta=OK at the floor with a home Core listed online on a FROZEN meter (held pack net 0 W) → NOT backstopping', () => {
  // The review case: 23:00, the reserve floor, the panel fresh with gridSta=1 and its main at 0 W,
  // CORE A frozen for 30 min with a held pack net of 0 W while its slot delivers 1.1 kW. The timers
  // and the Battery Net sensor read that Core from its slot (a 1.2 kW drain); the guard read "every
  // Core reporting, 0 W" and downgraded the at-floor critical to a low advisory.
  const g = resolveGridBackstop({
    devices: fleet(shp2(['A', 'B', 'C']), frozenDpu('A', 0), dpu('B', true, 0), dpu('C', true, 0)),
    ...NO_DECL, atReserveFloor: true,
  });
  assert.equal(g.backstopping, false, 'the frozen 0 W does not disprove the drain');
  assert.match(g.reason, /only 2\/3 home Cores are reporting at the reserve floor/);
});

test('★★★ every home Core frozen online at the floor (the reconnection’s first list cycle) → NOT backstopping, as with them offline', () => {
  const frozen = resolveGridBackstop({
    devices: fleet(shp2(['A', 'B', 'C']), frozenDpu('A'), frozenDpu('B'), frozenDpu('C')),
    ...NO_DECL, atReserveFloor: true,
  });
  const offline = resolveGridBackstop({
    devices: fleet(shp2(['A', 'B', 'C']), dpu('A', false), dpu('B', false), dpu('C', false)),
    ...NO_DECL, atReserveFloor: true,
  });
  assert.equal(offline.backstopping, false, 'control: the same Cores offline');
  assert.equal(frozen.backstopping, false, 'frozen online reads the same as offline');
  // Away from the floor nothing changes (normal cycling with a frozen Core does not escalate).
  const away = resolveGridBackstop({
    devices: fleet(shp2(['A', 'B', 'C']), frozenDpu('A'), dpu('B', true), dpu('C', true)),
    ...NO_DECL, atReserveFloor: false,
  });
  assert.equal(away.backstopping, true);
});

test('a Core that changed 4 min ago is on a fresh meter: full coverage, the v0.89.0 burst-gap backstop holds', () => {
  const g = resolveGridBackstop({
    devices: fleet(shp2(['A', 'B']), frozenDpu('A', 0, 4 * 60_000), dpu('B', true, 0)),
    ...NO_DECL, atReserveFloor: true,
  });
  assert.equal(g.backstopping, true);
});
