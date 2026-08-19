import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dayWindow, unwrapDataRows, parseFlowTotalWh, parseBatteryDualWh,
  parseCircuitDayWh, driftPct,
} from '../src/energyHistory.js';

/* ═══════════════════════════════════════════════════════════════════════════
 * energyHistory — parsers for the PD303 historical-data endpoint (v1.82.0).
 * Every fixture below is VERBATIM from the vendor documentation (2026-08-17),
 * because the endpoint's double-nested envelope and string-numeral rows are
 * exactly the shapes a hand-rolled parser gets wrong silently.
 * ═════════════════════════════════════════════════════════════════════════ */

test('dayWindow formats device-local bounds and rejects garbage', () => {
  assert.deepEqual(dayWindow('2026-08-16'), {
    beginTime: '2026-08-16 00:00:00', endTime: '2026-08-16 23:59:59',
  });
  assert.throws(() => dayWindow('16/08/2026'));
  assert.throws(() => dayWindow('2026-8-16'));
});

// The rest client strips the OUTER envelope; what the parser sees is the inner
// {code,message,data:[...]} object — the doc's response nested one level down.
const FLOW_INNER = { code: '0', message: 'Success', data: [
  { indexName: 'master_data', indexValue: 53134, unit: 'wh' },
] };

test('flow total: the doc example parses to 53134 Wh', () => {
  assert.equal(parseFlowTotalWh(FLOW_INNER), 53134);
});

test('flow total: tolerates being handed the full double envelope too', () => {
  assert.equal(parseFlowTotalWh({ code: '0', message: 'Success', data: FLOW_INNER }), 53134);
});

test('flow total: an inner failure code yields null, never a number', () => {
  assert.equal(parseFlowTotalWh({ code: '1', message: 'err', data: [] }), null);
  assert.equal(parseFlowTotalWh(null), null);
  assert.equal(parseFlowTotalWh({}), null);
});

test('battery dual: extra "1" is input, "2" is output (doc example)', () => {
  const resp = { code: '0', message: 'Success', data: [
    { indexName: 'master_data', indexValue: 9971, unit: 'wh', extra: '2' },
    { indexName: 'master_data', indexValue: 11990, unit: 'wh', extra: '1' },
  ] };
  assert.deepEqual(parseBatteryDualWh(resp), { inWh: 11990, outWh: 9971 });
});

test('circuit rows: STRING numerals summed across day rows (doc example shape)', () => {
  const resp = { code: '0', message: 'Success', data: [
    { detailGrid: '120', detailBattery: '30', detailGenerator: '0', time: '2026-08-16' },
    { detailGrid: '80', detailBattery: '10.5', detailGenerator: '0', time: '2026-08-16' },
    { detailGrid: 'garbage', detailBattery: '', detailGenerator: '0', time: '2026-08-16' },
  ] };
  assert.deepEqual(parseCircuitDayWh(resp, 7), {
    circuit: 7, gridWh: 200, generatorWh: 0, batteryWh: 40.5,
  });
});

test('driftPct: like-basis only, noise-floored, signed toward the vendor', () => {
  assert.equal(driftPct(55_200, 54_100), 2);
  assert.equal(driftPct(50_000, 50_000), 0);
  assert.equal(driftPct(null, 50_000), null);
  assert.equal(driftPct(50_000, null), null);
  assert.equal(driftPct(50, 40), null, 'near-zero days produce noise, not drift');
});

/* ═══ v1.85.0 — backfill day selection + empirical RTE (advisory) ═══════════ */

import { prevYmd, missingDays, isIncompleteDay, computeEmpiricalRte, MIN_RTE_SAMPLE_DAYS, RTE_MIN_DAY_IN_WH } from '../src/energyHistory.js';

test('prevYmd: month/year boundaries without Intl', () => {
  assert.equal(prevYmd('2026-08-17'), '2026-08-16');
  assert.equal(prevYmd('2026-08-01'), '2026-07-31');
  assert.equal(prevYmd('2026-01-01'), '2025-12-31');
  assert.equal(prevYmd('2028-03-01'), '2028-02-29', 'leap year');
});

test('missingDays: walks backward from yesterday, skips stored, honors horizon + cap', () => {
  const stored = new Set(['2026-08-16', '2026-08-14']);
  assert.deepEqual(missingDays(stored, '2026-08-17', 5, 10),
    ['2026-08-15', '2026-08-13', '2026-08-12']);
  assert.deepEqual(missingDays(stored, '2026-08-17', 5, 1), ['2026-08-15'], 'cap bounds each run');
  assert.deepEqual(missingDays(new Set(), '2026-08-17', 2, 10), ['2026-08-16', '2026-08-15']);
});

const rteDay = (inWh: number | null, outWh: number | null): any => ({
  day: 'x', fetchedAtMs: 0, homeWh: null, gridWh: null, solarWh: null, generatorWh: null,
  batteryInWh: inWh, batteryOutWh: outWh, circuits: [], local: null,
  driftHomePct: null, driftSolarPct: null,
});

test('empirical RTE: only meaningful-charge days qualify; null until the sample floor', () => {
  // Four qualifying days (floor is 5) → rte stays null however clean the math.
  const four = Array.from({ length: 4 }, () => rteDay(10_000, 8_600));
  assert.equal(computeEmpiricalRte(four).rte, null);
  // Five qualifying days → 43_000/50_000 = 0.86.
  const five = [...four, rteDay(10_000, 8_600)];
  const r = computeEmpiricalRte(five);
  assert.equal(r.sampleDays, MIN_RTE_SAMPLE_DAYS);
  assert.equal(r.rte, 0.86);
  assert.equal(r.interpretation, 'rte');
  // The 08-16 shape (batteryIn=0 on a sunny day) never qualifies — vendor
  // "in" semantics are unproven and a zero-in day would explode the ratio.
  const withZero = [...five, rteDay(0, 57_810)];
  assert.equal(computeEmpiricalRte(withZero).sampleDays, MIN_RTE_SAMPLE_DAYS, 'the zero-in day is excluded');
  assert.equal(RTE_MIN_DAY_IN_WH, 1_000);
  // Null-in days (fetch failure) are excluded, never treated as zero.
  assert.equal(computeEmpiricalRte([rteDay(null, 5_000)]).sampleDays, 0);
});

test('v1.85.1 — the LIVE 25-day shape: out/in 2.41 is named grid-only, never an efficiency', () => {
  // The real backfill numbers: 445.7 kWh in, 1074.3 kWh out. An "efficiency"
  // above 1 is the vendor counting only grid-sourced charging as "in".
  const days = Array.from({ length: 15 }, () => rteDay(29_710, 71_619));
  const r = computeEmpiricalRte(days);
  assert.ok(r.rte! > 2.3 && r.rte! < 2.5);
  assert.equal(r.interpretation, 'vendor-in-is-grid-only');
  assert.equal(computeEmpiricalRte([]).interpretation, 'insufficient-data');
});

test('v1.86.0 — incomplete stored days are retried; complete days are not', () => {
  const stored = new Set(['2026-08-16', '2026-08-15']);
  const incomplete = new Set(['2026-08-15']);
  assert.deepEqual(missingDays(stored, '2026-08-17', 3, 10, incomplete),
    ['2026-08-15', '2026-08-14'], 'the null-field day comes back; the complete day does not');
  const full = rteDay(10_000, 8_600); full.homeWh = 1; full.solarWh = 1; full.gridWh = 1;
  assert.equal(isIncompleteDay(full), false);
  assert.equal(isIncompleteDay(rteDay(null, 5_000)), true);
  assert.equal(isIncompleteDay({ ...rteDay(1, 1), homeWh: null }), true);
});
