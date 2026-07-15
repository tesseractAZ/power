import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseShedCandidates, NEVER_SHED_KEYWORDS } from '../src/loadShedRegistry.js';
import { extractEntityWatts } from '../src/haStateCache.js';
import {
  computeRunwayWithShedOffset,
  buildLoadComposition,
  computeAdvisory,
  advisoryStateFields,
  type LoadCompositionEntry,
  type RunwayLike,
} from '../src/loadShedAdvisor.js';
import type { CachedEntity } from '../src/haStateCache.js';

/**
 * Phase-1 load-shedding advisor — pin the pure decision logic. The advisor never
 * actuates; these tests guard the recommendation math + the allowlist-only safety
 * posture (keywords WARN but do not gate; empty allowlist = no recommendation).
 */

// ── loadShedRegistry.parseShedCandidates ──────────────────────────────────────

test('parseShedCandidates: empty/undefined → []', () => {
  assert.deepEqual(parseShedCandidates(''), []);
  assert.deepEqual(parseShedCandidates(undefined), []);
  assert.deepEqual(parseShedCandidates(null), []);
});

test('parseShedCandidates: parses fields and sorts shed-first (priority asc, watts desc)', () => {
  const c = parseShedCandidates('switch.pool_pump:2:Pool pump:400:5,switch.irrigation:1:Irrigation:200');
  assert.equal(c.length, 2);
  // priority 1 (irrigation) sorts before priority 2 (pool pump)
  assert.equal(c[0].entityId, 'switch.irrigation');
  assert.equal(c[0].priority, 1);
  assert.equal(c[0].shp2Ch, null);
  assert.equal(c[1].entityId, 'switch.pool_pump');
  assert.equal(c[1].label, 'Pool pump');
  assert.equal(c[1].estimatedWatts, 400);
  assert.equal(c[1].shp2Ch, 5);
});

test('parseShedCandidates: within a priority tier, higher watts shed first', () => {
  const c = parseShedCandidates('switch.a:1:A:100,switch.b:1:B:900');
  assert.deepEqual(c.map((x) => x.entityId), ['switch.b', 'switch.a']);
});

test('parseShedCandidates: drops malformed entity ids (must be domain.object)', () => {
  const c = parseShedCandidates('notanentity:1:Bad:100,switch.ok:1:OK:50');
  assert.deepEqual(c.map((x) => x.entityId), ['switch.ok']);
});

test('parseShedCandidates: flags protected keywords (WARNING only — still included)', () => {
  const c = parseShedCandidates('switch.well_pump:1:Well pump:1200,switch.lamp:2:Lamp:60');
  const well = c.find((x) => x.entityId === 'switch.well_pump');
  assert.ok(well, 'protected entity is still parsed (allowlist is the gate, not the keyword)');
  assert.equal(well!.flaggedKeyword, 'well_pump');
  const lamp = c.find((x) => x.entityId === 'switch.lamp');
  assert.equal(lamp!.flaggedKeyword, null);
  assert.ok(NEVER_SHED_KEYWORDS.includes('well_pump'));
});

// ── haStateCache.extractEntityWatts ───────────────────────────────────────────

test('extractEntityWatts: explicit power attribute wins', () => {
  assert.equal(extractEntityWatts({ state: 'on', attributes: { current_power: 412 } }), 412);
  assert.equal(extractEntityWatts({ state: 'on', attributes: { power: '88.5' } }), 88.5);
});

test('extractEntityWatts: power sensor uses state, honoring kW', () => {
  assert.equal(extractEntityWatts({ state: '750', attributes: { device_class: 'power', unit_of_measurement: 'W' } }), 750);
  assert.equal(extractEntityWatts({ state: '1.2', attributes: { device_class: 'power', unit_of_measurement: 'kW' } }), 1200);
});

test('extractEntityWatts: no power signal → null', () => {
  assert.equal(extractEntityWatts({ state: 'on', attributes: {} }), null);
  assert.equal(extractEntityWatts({ state: 'on', attributes: { friendly_name: 'Lamp' } }), null);
});

// ── loadShedAdvisor.computeRunwayWithShedOffset ───────────────────────────────

test('computeRunwayWithShedOffset: shedding extends hoursToReserve (upper bound)', () => {
  // 10 kWh above reserve, 3 h to reserve → 3.33 kW pool-drain rate. v1.26.0: shedding
  // 2 kW DELIVERED removes 2/η ≈ 2.13 kW from the pool drain (both on the pool basis)
  // → 1.21 kW → ~8.3 h. (Pre-v1.26 subtracted 2 kW directly → ~7.5 h, under-counting.)
  const out = computeRunwayWithShedOffset(
    { backupRemainingKwh: 20, backupReserveKwh: 10, hoursToReserve: 3, hoursToEmpty: 6 },
    2000,
  );
  assert.ok(out.hoursToReserve! > 8 && out.hoursToReserve! < 8.6, `got ${out.hoursToReserve}`);
});

test('computeRunwayWithShedOffset: shedding ≥ net draw → null (no depletion)', () => {
  const out = computeRunwayWithShedOffset(
    { backupRemainingKwh: 20, backupReserveKwh: 10, hoursToReserve: 3, hoursToEmpty: 6 },
    5000, // 5 kW > 3.33 kW net
  );
  assert.equal(out.hoursToReserve, null);
});

test('computeRunwayWithShedOffset: null hoursToReserve stays null', () => {
  const out = computeRunwayWithShedOffset(
    { backupRemainingKwh: 50, backupReserveKwh: 10, hoursToReserve: null, hoursToEmpty: null },
    1000,
  );
  assert.equal(out.hoursToReserve, null);
  assert.equal(out.hoursToEmpty, null);
});

// ── loadShedAdvisor.buildLoadComposition ──────────────────────────────────────

test('buildLoadComposition: watt-source precedence shp2 > ha sensor > estimate', () => {
  const cand = parseShedCandidates(
    'switch.pool:1:Pool:400:5,switch.plug:2:Plug:111,switch.guess:3:Guess:77',
  );
  const ha = (id: string): CachedEntity | null => {
    if (id === 'switch.pool') return { entityId: id, state: 'on', attributes: {}, watts: 999, fetchedAt: 0 };
    if (id === 'switch.plug') return { entityId: id, state: 'on', attributes: {}, watts: 111, fetchedAt: 0 };
    return null; // switch.guess unknown to HA
  };
  const circ = (ch: number): number | null => (ch === 5 ? 420 : null);
  const comp = buildLoadComposition(cand, ha, circ);
  const byId = Object.fromEntries(comp.map((c) => [c.entityId, c]));
  assert.equal(byId['switch.pool'].source, 'shp2_circuit'); // ch 5 wins over HA watts 999
  assert.equal(byId['switch.pool'].measuredWatts, 420);
  assert.equal(byId['switch.plug'].source, 'ha_power_sensor');
  assert.equal(byId['switch.plug'].measuredWatts, 111);
  assert.equal(byId['switch.guess'].source, 'estimated');
  assert.equal(byId['switch.guess'].measuredWatts, 77);
  assert.equal(byId['switch.guess'].currentlyOn, null); // HA had no state
  assert.equal(byId['switch.pool'].currentlyOn, true);
});

// ── loadShedAdvisor.computeAdvisory ───────────────────────────────────────────

const HEALTHY: RunwayLike = {
  generatedAt: 1000, hoursToReserve: null, hoursToEmpty: null, unavailable: null,
  backupRemainingKwh: 80, backupReserveKwh: 10,
};
const LOW: RunwayLike = {
  generatedAt: 1000, hoursToReserve: 3, hoursToEmpty: 6, unavailable: null,
  backupRemainingKwh: 20, backupReserveKwh: 10,
};
const comp = (on: boolean, watts: number): LoadCompositionEntry[] => [
  { entityId: 'switch.evse', label: 'EVSE', priority: 1, currentlyOn: on, measuredWatts: watts, source: 'estimated', flaggedKeyword: null },
];

test('computeAdvisory: healthy runway → no recommendation', () => {
  const a = computeAdvisory({ now: 1, runway: HEALTHY, composition: comp(true, 2000), thresholdHours: 4, restoreMarginHours: 2 });
  assert.equal(a.band, null);
  assert.equal(a.actionable, false);
  assert.equal(a.recommended.length, 0);
});

test('computeAdvisory: empty allowlist → inactive note, nothing recommended', () => {
  const a = computeAdvisory({ now: 1, runway: LOW, composition: [], thresholdHours: 4, restoreMarginHours: 2 });
  assert.equal(a.recommended.length, 0);
  assert.match(a.note, /No sheddable loads configured/);
});

test('computeAdvisory: actionable band below threshold + ON load → recommends it and extends runway', () => {
  // LOW: hoursToEmpty 6 → classifyRunway 'high' (empty ≤8h escalates above the medium reserve band).
  const a = computeAdvisory({ now: 1, runway: LOW, composition: comp(true, 2000), thresholdHours: 4, restoreMarginHours: 2 });
  assert.equal(a.band, 'high');
  assert.equal(a.actionable, true);
  assert.deepEqual(a.recommended.map((r) => r.entityId), ['switch.evse']);
  assert.equal(a.totalRecommendedWatts, 2000);
  assert.ok(a.projectedAfterShed.hoursToReserve! > a.current.hoursToReserve!);
  assert.equal(a.isUpperBound, true);
});

test('computeAdvisory: an OFF load is never recommended (only shed what is on)', () => {
  const a = computeAdvisory({ now: 1, runway: LOW, composition: comp(false, 2000), thresholdHours: 4, restoreMarginHours: 2 });
  assert.equal(a.recommended.length, 0);
  assert.equal(a.actionable, false);
});

test('computeAdvisory: greedy stops once the counterfactual clears threshold+margin', () => {
  // Two big loads on; the first (2 kW) already lifts runway past 6 h target, so only one is recommended.
  const two: LoadCompositionEntry[] = [
    { entityId: 'switch.a', label: 'A', priority: 1, currentlyOn: true, measuredWatts: 2000, source: 'estimated', flaggedKeyword: null },
    { entityId: 'switch.b', label: 'B', priority: 2, currentlyOn: true, measuredWatts: 2000, source: 'estimated', flaggedKeyword: null },
  ];
  const a = computeAdvisory({ now: 1, runway: LOW, composition: two, thresholdHours: 4, restoreMarginHours: 2 });
  assert.equal(a.recommended.length, 1, 'one load already clears the target');
  assert.equal(a.recommended[0].entityId, 'switch.a');
});

// ── advisoryStateFields ───────────────────────────────────────────────────────

test('advisoryStateFields: null advisory → safe defaults', () => {
  const f = advisoryStateFields(null);
  assert.equal(f.load_shed_recommended, false);
  assert.equal(f.load_shed_recommended_count, 0);
  assert.equal(f.load_shed_recommended_watts, 0);
  assert.equal(f.runway_to_reserve_if_shed_hours, null);
});

test('advisoryStateFields: populated from a live recommendation', () => {
  const a = computeAdvisory({ now: 1, runway: LOW, composition: comp(true, 2000), thresholdHours: 4, restoreMarginHours: 2 });
  const f = advisoryStateFields(a);
  assert.equal(f.load_shed_recommended, true);
  assert.equal(f.load_shed_recommended_count, 1);
  assert.equal(f.load_shed_recommended_watts, 2000);
  assert.ok((f.runway_to_reserve_if_shed_hours ?? 0) > 6);
});
