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

/* ─── v1.90.0 (B7) — the digest ledger line ──────────────────────────────── */

import { vendorDigestLine, latestVendorDay, computeLocalPackRte, type VendorDayRecord } from '../src/energyHistory.js';

function digestRec(over: Partial<VendorDayRecord> = {}): VendorDayRecord {
  return {
    day: '2026-08-18', fetchedAtMs: 1, homeWh: 61_400, gridWh: 2_100, solarWh: 48_300,
    generatorWh: null, batteryInWh: 1_900, batteryOutWh: 22_700, circuits: [],
    local: null, driftHomePct: 1.3, driftSolarPct: null, impliedDarkPvWh: 19_800,
    ...over,
  } as VendorDayRecord;
}

test('vendorDigestLine renders kWh, signed drift, and the dark-core estimate', () => {
  const line = vendorDigestLine(digestRec(), '2026-08-19');  // record is 08-18 => genuinely yesterday
  assert.equal(
    line,
    'Yesterday per the EcoFlow ledger: home 61.4 kWh (home drift +1.3%), solar 48.3, grid 2.1, battery out 22.7 / grid-charge 1.9; dark-core PV ≈ 19.8 kWh.',
  );
});

test('vendorDigestLine is null when the record is missing or empty — the digest must not carry a hollow line', () => {
  assert.equal(vendorDigestLine(null), null);
  assert.equal(vendorDigestLine(undefined), null);
  assert.equal(vendorDigestLine(digestRec({ homeWh: null, solarWh: null, gridWh: null })), null);
});

test('vendorDigestLine omits optional clauses without leaving stubs', () => {
  const line = vendorDigestLine(digestRec({ driftHomePct: null, impliedDarkPvWh: null }), '2026-08-19');
  assert.equal(
    line,
    'Yesterday per the EcoFlow ledger: home 61.4 kWh, solar 48.3, grid 2.1, battery out 22.7 / grid-charge 1.9.',
  );
});

/* ══════════════════════════════════════════════════════════════════════════
 * v1.100.0 — the digest ledger line had NEVER rendered.
 *
 * The digest fires at NOTIFY_DIGEST_HOUR (06:00 local); the vendor ledger job is
 * gated to 06:35-09:00 Phoenix — deliberately AFTER the digest, so yesterday's
 * record does not exist yet when the digest is assembled. Keyed strictly to
 * prevYmd(today), the lookup missed every single morning and `vendorDigestLine`
 * silently returned null. Two consecutive days were confirmed live.
 * ═══════════════════════════════════════════════════════════════════════ */

test('latestVendorDay — returns the newest day that actually carries numbers', () => {
  const state: any = { lastRunDay: null, days: {
    '2026-08-18': digestRec({ day: '2026-08-18' }),
    '2026-08-20': digestRec({ day: '2026-08-20' }),
    '2026-08-21': digestRec({ day: '2026-08-21', homeWh: null, solarWh: null, gridWh: null }), // empty
  } };
  assert.equal(latestVendorDay(state)!.day, '2026-08-20', 'skips the empty newest day');
  assert.equal(latestVendorDay({ lastRunDay: null, days: {} } as any), null);
  assert.equal(latestVendorDay(null), null);
});

test('vendorDigestLine — says "Yesterday" only when the record really IS yesterday', () => {
  const rec = digestRec({ day: '2026-08-21' });
  assert.match(vendorDigestLine(rec, '2026-08-22')!, /^Yesterday per the EcoFlow ledger:/);
});

test('vendorDigestLine — names the date when the newest stored day is older than yesterday', () => {
  // The live case: at 06:00 the ledger job has not yet fetched yesterday, so the
  // newest stored day is the day before. The line must still render, and must NOT
  // claim to be yesterday.
  const rec = digestRec({ day: '2026-08-20' });
  const line = vendorDigestLine(rec, '2026-08-22')!;
  assert.match(line, /^Per the EcoFlow ledger \(2026-08-20\):/);
  assert.doesNotMatch(line, /Yesterday/, 'must never mislabel an older day as yesterday');
  assert.match(line, /home 61\.4 kWh/, 'still carries the real numbers');
});

test('vendorDigestLine — with no todayYmd it names the date rather than guessing', () => {
  assert.match(vendorDigestLine(digestRec({ day: '2026-08-19' }))!, /^Per the EcoFlow ledger \(2026-08-19\):/);
});

/* ══════════════════════════════════════════════════════════════════════════
 * v1.103.0 — the pack-DC RTE excludes days whose pool membership moved.
 *
 * After the 2026-08-20 swap this accumulated 77,218 Wh in against 92,676 Wh out
 * — a round-trip "efficiency" of 1.20, physically impossible, because the two
 * legs of the same day were measured over DIFFERENT sets of batteries. Nothing
 * was published (packDcRte stays null below MIN_RTE_SAMPLE_DAYS), but every
 * accumulating sample was poison.
 * ═══════════════════════════════════════════════════════════════════════ */

function rteDayFor(day: string, chg: number, dsg: number): VendorDayRecord {
  return {
    day, fetchedAtMs: 1, homeWh: 1, gridWh: 1, solarWh: 1, generatorWh: null,
    batteryInWh: 1, batteryOutWh: 1, circuits: [],
    local: { panelLoadWh: 1, pvWh: 1, batteryChargeWh: chg, batteryDischargeWh: dsg },
    driftHomePct: null, driftSolarPct: null,
  } as VendorDayRecord;
}

test('pack RTE — a membership-unstable day is EXCLUDED, not averaged in', () => {
  const days = [
    rteDayFor('2026-08-18', 10_000, 8_600),
    rteDayFor('2026-08-19', 10_000, 8_600),
    rteDayFor('2026-08-20', 10_000, 25_000),   // the swap day: impossible ratio
  ];
  const stable = (d: string) => d !== '2026-08-20';
  const r = computeLocalPackRte(days, stable);
  assert.equal(r.sampleDays, 2, 'the swap day is dropped');
  assert.equal(r.excludedDays, 1, 'and the exclusion is reported, not silent');
  assert.equal(r.chargeWh, 20_000);
  assert.equal(r.dischargeWh, 17_200, 'the impossible discharge leg never enters the sum');
});

test('pack RTE — with no membership gate the old behaviour is preserved', () => {
  const days = [rteDayFor('2026-08-18', 10_000, 8_600), rteDayFor('2026-08-20', 10_000, 25_000)];
  const r = computeLocalPackRte(days);
  assert.equal(r.sampleDays, 2, 'callers that pass no gate are unchanged');
  assert.equal(r.excludedDays, 0);
});

test('pack RTE — an UNKNOWN-membership day is refused too (never assumed clean)', () => {
  const days = [rteDayFor('2026-07-01', 10_000, 8_600), rteDayFor('2026-08-19', 10_000, 8_600)];
  // A day predating the membership record returns false from the gate.
  const gate = (d: string) => d >= '2026-08-01';
  const r = computeLocalPackRte(days, gate);
  assert.equal(r.sampleDays, 1);
  assert.equal(r.excludedDays, 1, 'unrecorded history is not evidence of stability');
});
