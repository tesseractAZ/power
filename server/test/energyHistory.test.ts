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
