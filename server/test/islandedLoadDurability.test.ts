import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parsePersistedIslandedLoad } from '../src/nightChargeAdvisor.js';

/**
 * v1.129.0 — the islanded load must survive a restart, and must not depend on a
 * web request being made.
 *
 * THE DEFECT: v1.125.1 populated the cache as a side effect of the /api/ha-state
 * handler. Observed live on 2026-09-05 — more than an hour after the v1.128.1
 * deploy the plan still read `cushionBasis: legacy-pct`, and priming ha-state by
 * hand did not flip it because the plan only recomputes every 30 minutes. So the
 * outage cushion silently reverted to its legacy flat band after every deploy,
 * for an unbounded period, because safety-relevant sizing rested on an unrelated
 * route happening to be hit.
 */

/* ── the persisted seed ───────────────────────────────────────────────────── */

test('a good seed round-trips', () => {
  assert.deepEqual(parsePersistedIslandedLoad({ kw: 4.47, atMs: 1_788_000_000_000 }),
    { kw: 4.47, atMs: 1_788_000_000_000 });
});

test('a corrupt or half-written sidecar seeds NOTHING rather than nonsense', () => {
  for (const bad of [
    null, undefined, 42, 'x', [],
    {}, { kw: 4.47 }, { atMs: 1 },
    { kw: 0, atMs: 1 }, { kw: -1, atMs: 1 }, { kw: Number.NaN, atMs: 1 },
    { kw: Number.POSITIVE_INFINITY, atMs: 1 },
    { kw: 4.47, atMs: 0 }, { kw: 4.47, atMs: Number.NaN },
    { kw: '4.47', atMs: 1 }, { kw: 4.47, atMs: '1' },
  ]) {
    assert.equal(parsePersistedIslandedLoad(bad), null,
      `${JSON.stringify(bad)} must not seed safety-relevant sizing`);
  }
});

/* ── the wiring: MORE THAN ONE path must refresh it ───────────────────────── */

const IDX = readFileSync(resolve(import.meta.dirname, '../src/index.ts'), 'utf8');

test('★ THE DEFECT: the islanded load is refreshed from more than one path', () => {
  // The whole failure was a single population path that a restart emptied and
  // only an unrelated HTTP handler could refill. One call site is the bug.
  // Count CALLS, not the declaration. A first cut of this test matched
  // `function noteIslandedLoadKw(` too, so removing a real call site still left
  // three matches and the mutant survived — the assertion was counting itself.
  const sites = (IDX.match(/(?<!function )noteIslandedLoadKw\(/g) ?? []).length;
  assert.equal(sites, 3,
    `expected exactly the ha-state handler, the recompute tick and the boot seed; found ${sites}`);
});

test('it is refreshed on the same timer that recomputes the plan consuming it', () => {
  // Anchor on the tick body: the refresh must sit beside scoreCompletedNights,
  // not in a request handler.
  const tick = IDX.slice(IDX.indexOf('scoreCompletedNights(Date.now())'));
  assert.match(tick.slice(0, 1600), /noteIslandedLoadKw\(/,
    'the 30-minute night-charge recompute tick must refresh it');
});

test('it is persisted, so a restart does not silently drop to the legacy band', () => {
  assert.match(IDX, /ISLANDED_LOAD_PATH/, 'a sidecar path must exist');
  assert.match(IDX, /atomicWriteFileSync\(ISLANDED_LOAD_PATH/, 'writes must be atomic like the other sidecars');
  assert.match(IDX, /parsePersistedIslandedLoad\(JSON\.parse\(readFileSync\(ISLANDED_LOAD_PATH/,
    'and it must be seeded from disk at module init');
});

test('staleness still fails CLOSED to the legacy band', () => {
  // The seed can be old; the 6 h ceiling is what stops an ancient value being
  // used as though it were a measurement.
  assert.match(IDX, /ISLANDED_LOAD_MAX_AGE_MS/);
  const fn = IDX.slice(IDX.indexOf('function islandedLoadKwNow'));
  assert.match(fn.slice(0, 400), /Date\.now\(\) - islandedLoadKwCache\.atMs > ISLANDED_LOAD_MAX_AGE_MS/);
  assert.match(fn.slice(0, 400), /return null/);
});

/* ══════════════════════════════════════════════════════════════════════════
 * v1.129.0 — the other three items from the verified open queue.
 * ════════════════════════════════════════════════════════════════════════ */

import { coherentRunwayPair } from '../src/nightChargeAdvisor.js';
import { holdResolveForQuietHours } from '../src/alertMonitor.js';
import { shp2ConnectedDpuSns, allShp2s } from '../src/shp2Membership.js';

/* ── runway coherence: empty can never precede reserve ────────────────────── */

test('THE 08-05 REPORT: "empty 1 h / reserve 20.5 h" is repaired above the floor', () => {
  const r = coherentRunwayPair({ hoursToReserve: 20.5, hoursToEmpty: 1, belowFloor: false });
  assert.equal(r.clamped, true);
  assert.equal(r.hoursToReserve, 1, 'reserve is pulled back to empty — the floor arrives no later');
  assert.equal(r.hoursToEmpty, 1, 'empty is never lengthened');
});

test('BELOW the floor the same pair is legitimate and untouched', () => {
  // The reserve detector only arms above the floor, so under it the reserve
  // figure is the NEXT crossing after a modelled recharge — genuinely later.
  const r = coherentRunwayPair({ hoursToReserve: 20.5, hoursToEmpty: 1, belowFloor: true });
  assert.equal(r.clamped, false);
  assert.equal(r.hoursToReserve, 20.5);
});

test('★ the repair can only SHORTEN the runway, never lengthen it', () => {
  for (const hr of [null, 0, 1, 5, 20.5, 100]) {
    for (const he of [null, 0, 1, 5, 20.5, 100]) {
      for (const belowFloor of [true, false]) {
        const r = coherentRunwayPair({ hoursToReserve: hr, hoursToEmpty: he, belowFloor });
        if (hr != null && r.hoursToReserve != null) {
          assert.ok(r.hoursToReserve <= hr + 1e-9, `reserve lengthened: ${hr} -> ${r.hoursToReserve}`);
        }
        assert.equal(r.hoursToEmpty, he, 'empty is never modified');
        // A finite projection must never become null — that would drop an alarm.
        if (hr != null) assert.notEqual(r.hoursToReserve, null);
      }
    }
  }
});

test('a coherent pair is left exactly alone', () => {
  const r = coherentRunwayPair({ hoursToReserve: 3, hoursToEmpty: 9, belowFloor: false });
  assert.deepEqual(r, { hoursToReserve: 3, hoursToEmpty: 9, clamped: false });
});

test('nulls and non-finites pass through without clamping', () => {
  for (const [hr, he] of [[null, 5], [5, null], [null, null], [Number.NaN, 5], [5, Number.NaN]] as const) {
    assert.equal(coherentRunwayPair({ hoursToReserve: hr, hoursToEmpty: he, belowFloor: false }).clamped, false);
  }
});

/* ── the quiet-hours resolve hold, now testable ───────────────────────────── */

test('THE v1.78.0 RULE, finally pinned: an owed resolve is HELD in quiet hours', () => {
  assert.equal(holdResolveForQuietHours(true, true), true, 'owed + quiet -> hold');
  assert.equal(holdResolveForQuietHours(true, false), false, 'owed + open window -> send');
  assert.equal(holdResolveForQuietHours(false, true), false,
    'NOT owed -> never hold, or the entry would never retire');
  assert.equal(holdResolveForQuietHours(false, false), false);
});

test('the orphan sweep honours the same rule and DEFERS rather than drops', () => {
  const src = readFileSync(resolve(import.meta.dirname, '../src/alertMonitor.ts'), 'utf8');
  const sweep = src.slice(src.indexOf('orphanSweepDone && now - bootMs'));
  const head = sweep.slice(0, 1200);
  assert.match(head, /inQuietWindow\(nowDate, QUIET_WINDOW\)/,
    'the once-per-boot orphan sweep must consult the quiet window too');
  // It must NOT latch orphanSweepDone on the held branch, or the resolves are dropped.
  const heldIdx = head.indexOf('orphan resolve sweep held');
  const latchIdx = head.indexOf('orphanSweepDone = true');
  assert.ok(heldIdx !== -1 && latchIdx !== -1 && heldIdx < latchIdx,
    'the hold must come BEFORE the latch, so the sweep re-runs when the window opens');
  assert.ok(!/return;\s*\n\s*}\s*\n\s*orphanSweepDone = true/.test(head),
    'must not early-return past `firstRun = false`');
});

/* ── the second SHP2 ──────────────────────────────────────────────────────── */

const panel = (sn: string, sources: Array<{ sn: string; isConnected: boolean }>) => ({
  sn, deviceName: sn, online: true,
  projection: { kind: 'shp2' as const, sources },
});
const fleet = (...ps: ReturnType<typeof panel>[]) =>
  Object.fromEntries(ps.map((p) => [p.sn, p])) as never;

test('THE SILENT-UNMONITORING BUG: a SECOND panel\'s DPUs are now in the roster', () => {
  const two = fleet(
    panel('SHP2-A', [{ sn: 'CORE1', isConnected: true }, { sn: 'CORE2', isConnected: true }]),
    panel('SHP2-B', [{ sn: 'CORE-EV', isConnected: true }, { sn: 'CORE-GARAGE', isConnected: true }]),
  );
  const sns = shp2ConnectedDpuSns(two);
  // Before v1.129.0 this was find()-first-match: panel B's bank was invisible, so
  // advanceOffPanelStreaks demoted it to annunciate:false after three ticks.
  assert.ok(sns.has('CORE-EV'), 'the second panel\'s DPUs must be seen');
  assert.ok(sns.has('CORE-GARAGE'));
  assert.equal(sns.size, 4);
});

test('single-panel behaviour is byte-identical — no regression for today', () => {
  const one = fleet(panel('SHP2-A', [
    { sn: 'CORE1', isConnected: true }, { sn: 'CORE2', isConnected: true }, { sn: 'OFF', isConnected: false },
  ]));
  assert.deepEqual([...shp2ConnectedDpuSns(one)].sort(), ['CORE1', 'CORE2']);
  assert.equal(allShp2s(one).length, 1);
});

test('no panel at all still returns empty (the DPU-only fallback contract)', () => {
  assert.equal(shp2ConnectedDpuSns({} as never).size, 0);
  assert.equal(allShp2s({} as never).length, 0);
});

test('a panel with no sources subtree cannot throw', () => {
  const partial = { P: { sn: 'P', deviceName: 'P', online: true, projection: { kind: 'shp2' } } } as never;
  assert.equal(shp2ConnectedDpuSns(partial).size, 0);
});
