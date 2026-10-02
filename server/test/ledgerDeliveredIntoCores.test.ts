/**
 * v1.187.3 — `delivered_kwh` is the energy INTO the home Cores over the hold, measured on the
 * house panel's per-Core source channels (`src{n}_w` > 0), not window import minus house load.
 *
 * 2026-09-30: the pool opened at 74% against the 50% reserve, so the SHP2 carried the house
 * from the pack from 23:00 until the just-in-time force-charge at 03:18 and again after its
 * 04:32 OFF. Import − load over the hold subtracted 15.5 kWh of load the grid never carried:
 * 4.71 kWh recorded against ~20.3 kWh into the Cores. These tests drive that shape, the
 * bypass shape the old estimate got right, and every reason the column is withheld.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deliveredIntoCores, connectedSourceSlots, assembleNightLedgerColumns, integrateWh,
  LEDGER_SPAN_MIN_COVERAGE, DELIVERED_IMPORT_SLACK_FRAC, DELIVERED_IMPORT_SLACK_KWH,
  type LedgerMetric, type NightLedgerColumnsInput, type TimeSpan,
} from '../src/nightLedgerScoring.js';
import { DELIVERED_BASIS } from '../src/nightChargeAdvisor.js';
import { buildApsREvModel, rateAt } from '../src/tariff.js';

const MIN = 60_000;
const HOUR = 3_600_000;
/** UTC ms of a Phoenix wall time (UTC-7, no DST). */
const phx = (y: number, mo: number, d: number, h: number, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h + 7, mi, s);
const REV = buildApsREvModel({
  confirmed: true,
  onPeak: { summer: 44.2, winter: 30 },
  offPeak: { summer: 16.91, winter: 12 },
  overnight: { summer: 12.59, winter: 12.59 },
  superOffPeak: { summer: null, winter: 5 },
});

/* The 2026-09-30 night: window 23:00 → 05:00, reserve written 23:00:49 and restored 05:00:49;
 * force-charge ON 03:18:49, OFF 04:32:49 at the target. */
const WS = phx(2026, 9, 30, 23);
const WE = phx(2026, 10, 1, 5);
const APPLIED = WS + 49_000;
const REVERTED = WE + 49_000;
const ON = phx(2026, 10, 1, 3, 18, 49);
const OFF = phx(2026, 10, 1, 4, 32, 49);
/** The hold deliveredHoldSpan gives this row: the open to the restore + the device settle. */
const HOLD: TimeSpan = { startMs: WS, endMs: REVERTED + MIN };

type Pt = { ts: number; value: number };
type Data = Partial<Record<LedgerMetric, Pt[]>>;
const series = (from: number, to: number, w: (t: number) => number): Pt[] => {
  const out: Pt[] = [];
  for (let t = from; t <= to; t += MIN) out.push({ ts: t, value: w(t) });
  return out;
};
const FROM = WS - HOUR;
const TO = WE + 17 * HOUR;
const charging = (t: number) => t >= ON && t < OFF;
/** House load: 3.4 kW before the force-charge, 2.5 kW during it, 2.0 kW after. */
const load = (t: number) => (t < ON ? 3_400 : t < OFF ? 2_500 : 2_000);
/** The meter: nothing while the pack carries the house; 19.1 kW during the force-charge. */
const grid = (t: number) => (charging(t) ? 19_100 : 0);
/** Each of three channels: the pack's share of the house (negative), or its share of the charge. */
const channel = (t: number) => (charging(t) ? (19_100 - 2_500) / 3 : -load(t) / 3);

const night0930 = (): Data => ({
  grid_home_w: series(FROM, TO, grid),
  panel_load: series(FROM, TO, load),
  src1_w: series(FROM, TO, channel),
  src2_w: series(FROM, TO, channel),
  src3_w: series(FROM, TO, channel),
});

function stub(data: Data) {
  const calls: Array<{ metric: LedgerMetric; a: number; b: number }> = [];
  const query = (metric: LedgerMetric, a: number, b: number) => {
    calls.push({ metric, a, b });
    return (data[metric] ?? []).filter((p) => p.ts >= a && p.ts <= b);
  };
  return { query, calls };
}
const kwh = (pts: Pt[] | undefined, positive: boolean) =>
  integrateWh((pts ?? []).filter((p) => p.ts >= HOLD.startMs && p.ts <= HOLD.endMs), positive) / 1000;
const deliver = (data: Data, channels: readonly number[] = [1, 2, 3], hold: TimeSpan = HOLD) =>
  deliveredIntoCores({ hold, channels, query: stub(data).query });

/* ── the 09-30 shape ─────────────────────────────────────────────────────── */

test('★★★ 09-30: the house on the pack around a just-in-time charge — ~20.5 kWh into the Cores, not ~4.9', () => {
  const d = night0930();
  const out = deliver(d);
  // 74 min at 3 × 5.53 kW into the Cores.
  const expected = 3 * ((19_100 - 2_500) / 3 / 1000) * ((OFF - ON) / HOUR);
  assert.ok(out.kwh != null && Math.abs(out.kwh - expected) < 0.3, `delivered ${out.kwh}, expected ~${expected.toFixed(2)}`);
  assert.equal(out.basis, DELIVERED_BASIS);
  assert.match(out.note, /^Delivered: [\d.]+ kWh into the Cores \(charging part of source channels 1\/2\/3 over the hold\)$/);
  // The shape reproduces the defect: import − load over the same hold is ~4.9.
  const oldEstimate = kwh(d.grid_home_w, true) - kwh(d.panel_load, false);
  assert.ok(oldEstimate > 4 && oldEstimate < 6, `import − load ${oldEstimate.toFixed(2)}`);
  assert.ok(out.kwh! > 4 * oldEstimate, 'the hours the pack carried the house cost nothing here');
});

test('★★★ only the charging part counts: a channel carrying the house adds nothing, it does not subtract', () => {
  const d = night0930();
  const chargeOnly = deliver({
    ...d,
    src1_w: series(FROM, TO, (t) => Math.max(0, channel(t))),
    src2_w: series(FROM, TO, (t) => Math.max(0, channel(t))),
    src3_w: series(FROM, TO, (t) => Math.max(0, channel(t))),
  });
  assert.equal(deliver(d).kwh, chargeOnly.kwh, '15.5 kWh of discharge must not net against the charge');
});

test('★★ the bypass shape (house on the grid all window): the measurement agrees with import − load', () => {
  // 09-24-like: the pool parked at its reserve, the house on the grid, the Cores charging 6 h.
  const houseW = 2_800;
  const intoW = 4_000; // per Core
  const d: Data = {
    grid_home_w: series(FROM, TO, (t) => (t >= WS && t < WE ? houseW + 3 * intoW : houseW)),
    panel_load: series(FROM, TO, () => houseW),
    src1_w: series(FROM, TO, (t) => (t >= WS && t < WE ? intoW : 0)),
    src2_w: series(FROM, TO, (t) => (t >= WS && t < WE ? intoW : 0)),
    src3_w: series(FROM, TO, (t) => (t >= WS && t < WE ? intoW : 0)),
  };
  const out = deliver(d);
  const oldEstimate = kwh(d.grid_home_w, true) - kwh(d.panel_load, false);
  assert.ok(out.kwh != null && Math.abs(out.kwh - oldEstimate) < 0.1, `${out.kwh} vs ${oldEstimate.toFixed(2)}`);
  assert.ok(Math.abs(out.kwh! - 72) < 0.2, '3 × 4 kW × 6 h');
});

test('★★ the channels are read over the hold span, one query each, for the channels given', () => {
  const s = stub(night0930());
  deliveredIntoCores({ hold: HOLD, channels: [1, 3], query: s.query });
  const src = s.calls.filter((c) => c.metric.startsWith('src'));
  assert.deepEqual(src.map((c) => c.metric), ['src1_w', 'src3_w'], 'a slot with no connected Core is not read');
  for (const c of s.calls) assert.deepEqual([c.a, c.b], [HOLD.startMs, HOLD.endMs]);
});

/* ── withheld, with the reason ───────────────────────────────────────────── */

test('★★★ one channel dark for two hours ⇒ NULL, never a third-short total, and the note names it', () => {
  const d = night0930();
  const holed = { ...d, src2_w: d.src2_w!.filter((p) => !(p.ts >= phx(2026, 10, 1, 1) && p.ts < phx(2026, 10, 1, 3))) };
  const out = deliver(holed);
  assert.equal(out.kwh, null);
  assert.equal(out.basis, null);
  assert.match(out.note, /^Delivered: unmeasured \(source channel 2 coverage 6\d% < 90%\)$/);
});

test('★★★ the gate is the WORST channel: a dark third channel beside two healthy ones ⇒ NULL', () => {
  const d = night0930();
  const out = deliver({ ...d, src3_w: [] });
  assert.equal(out.kwh, null, 'the mean coverage (0.67) or the first channel (1.0) would pass a two-thirds total');
  assert.match(out.note, /source channel 3 coverage 0% < 90%/);
});

test('★★ coverage at the line: 90% passes, just under fails', () => {
  const d = night0930();
  // The hold is 6 h 1 min 49 s → 73 five-minute buckets. Drop 7 (66/73 = 0.904) and 8 (65/73 = 0.89).
  const drop = (n: number) => ({ ...d, src1_w: d.src1_w!.filter((p) => !(p.ts >= WS + HOUR && p.ts < WS + HOUR + n * 5 * MIN)) });
  assert.ok(deliver(drop(7)).kwh != null);
  assert.equal(deliver(drop(8)).kwh, null);
  assert.equal(LEDGER_SPAN_MIN_COVERAGE, 0.9);
});

test('★★★ no connected Core known on the house panel ⇒ NULL, not 0, and no channel is read', () => {
  const s = stub(night0930());
  const out = deliveredIntoCores({ hold: HOLD, channels: [], query: s.query });
  assert.deepEqual(out, { kwh: null, basis: null, note: 'Delivered: unmeasured (no connected Core known on the house panel)' });
  assert.equal(s.calls.length, 0);
});

test('★★★ more into the Cores than the meter imported ⇒ withheld (a discharge read as charge)', () => {
  // The house on the pack all night with the channel sign inverted: +1.13 kW "into" each Core
  // while the meter reads 0. Counted, this is ~20 kWh of phantom delivery for the learner.
  const d = night0930();
  const flipped: Data = {
    ...d,
    grid_home_w: series(FROM, TO, () => 0),
    src1_w: series(FROM, TO, (t) => load(t) / 3),
    src2_w: series(FROM, TO, (t) => load(t) / 3),
    src3_w: series(FROM, TO, (t) => load(t) / 3),
  };
  const out = deliver(flipped);
  assert.equal(out.kwh, null);
  assert.equal(out.basis, null);
  assert.match(out.note, /^Delivered: withheld \([\d.]+ kWh into the Cores exceeds the 0 kWh metered import over the hold; overnight the grid is their only source\)$/);
});

test('★★ the import bound has slack for two clocks: inside it the value stands, past it it is withheld', () => {
  // Import 20 kWh over the hold (3.32 kW flat for the 6 h 1.8 min).
  const span = (HOLD.endMs - HOLD.startMs) / HOUR;
  const impW = 20_000 / span;
  const withInto = (totalKwh: number): Data => ({
    grid_home_w: series(HOLD.startMs, HOLD.endMs, () => impW),
    src1_w: series(HOLD.startMs, HOLD.endMs, () => (totalKwh * 1000) / span),
  });
  const imp = kwh(withInto(0).grid_home_w, true);
  const limit = imp * (1 + DELIVERED_IMPORT_SLACK_FRAC) + DELIVERED_IMPORT_SLACK_KWH;
  assert.ok(limit > 21.4 && limit < 21.6, `limit ${limit}`);
  const inside = deliver(withInto(21.2), [1]);
  assert.ok(inside.kwh != null, `21.2 kWh against ${imp.toFixed(2)} imported is two clocks' disagreement: ${inside.note}`);
  const fracOnly = deliver(withInto(20.8), [1]);
  assert.ok(fracOnly.kwh != null, '4% over the import is inside the slack');
  assert.equal(deliver(withInto(21.8), [1]).kwh, null, 'past 5% + 0.5 kWh');
});

test('★★ the import bound applies only when the meter itself is covered', () => {
  // grid_home_w missing for half the hold: its total is deflated, so it cannot bound anything.
  const d = night0930();
  const holedGrid = { ...d, grid_home_w: d.grid_home_w!.filter((p) => !(p.ts >= WS && p.ts < WS + 3 * HOUR + 30 * MIN)) };
  const out = deliver(holedGrid);
  assert.ok(out.kwh != null && out.kwh > 19, `the channels are covered: ${out.note}`);
  assert.equal(out.basis, DELIVERED_BASIS);
});

/* ── the house panel's channels ──────────────────────────────────────────── */

test('★★ connectedSourceSlots: connected slots with a serial, sorted, once each', () => {
  const sn = (n: number) => `COREXXX00XXX000${n}`;
  assert.deepEqual(connectedSourceSlots([
    { slot: 3, sn: sn(3), isConnected: true },
    { slot: 1, sn: sn(1), isConnected: true },
    { slot: 2, sn: sn(2), isConnected: false },
  ]), [1, 3]);
  assert.deepEqual(connectedSourceSlots([{ slot: 2, sn: null, isConnected: true }]), [], 'no serial: not a known Core');
  assert.deepEqual(connectedSourceSlots([{ slot: 1, sn: sn(1), isConnected: true }, { slot: 1, sn: sn(1), isConnected: true }]), [1]);
  assert.deepEqual(connectedSourceSlots([{ slot: 0, sn: sn(1), isConnected: true }, { slot: 1.5, sn: sn(2), isConnected: true }]), []);
  assert.deepEqual(connectedSourceSlots(null), []);
  assert.deepEqual(connectedSourceSlots(undefined), []);
});

/* ── through the scorer's assembly ───────────────────────────────────────── */

function assemble(o: Partial<NightLedgerColumnsInput> & { data?: Data } = {}) {
  const s = stub(o.data ?? night0930());
  const i: NightLedgerColumnsInput = {
    row: {
      plan_date: '2026-09-30', issued_at_ms: phx(2026, 9, 30, 21, 30),
      actuation_applied_at_ms: APPLIED, actuation_reverted_at_ms: REVERTED, pv_model_sns: null,
    },
    actuated: true,
    windowStartMs: WS,
    windowEndMs: WE,
    scoreSpanEndMs: WE + 16 * HOUR,
    onpeak: { startMs: phx(2026, 10, 1, 16), endMs: phx(2026, 10, 1, 19) },
    supersededBy: null,
    query: s.query,
    rateAt: (t) => rateAt(REV, t),
    homeSns: ['COREXXX00XXX0001', 'COREXXX00XXX0002', 'COREXXX00XXX0003'],
    sourceChannels: [1, 2, 3],
    ...o,
  };
  return { cols: assembleNightLedgerColumns(i), calls: s.calls };
}

test('★★★ the assembly writes the 09-30 night on the new basis over the hold, and says so', () => {
  const { cols, calls } = assemble();
  assert.deepEqual(cols.hold, { startMs: WS, endMs: REVERTED + MIN, basis: 'revert-stamp' });
  assert.ok(cols.deliveredKwh != null && cols.deliveredKwh > 20 && cols.deliveredKwh < 21, `${cols.deliveredKwh}`);
  assert.equal(cols.deliveredBasis, DELIVERED_BASIS);
  assert.ok(calls.some((c) => c.metric === 'src2_w' && c.a === WS && c.b === REVERTED + MIN));
  assert.ok(!calls.some((c) => c.metric === 'panel_load'), 'house load is no longer part of the measurement');
  assert.match(cols.notes, /\. Delivered: [\d.]+ kWh into the Cores \(charging part of source channels 1\/2\/3 over the hold\)\.$/);
});

test('★★★ a withheld delivery leaves delivered_basis NULL beside it, and the note says why', () => {
  const d = night0930();
  const { cols } = assemble({ data: { ...d, src1_w: [] } });
  assert.equal(cols.deliveredKwh, null);
  assert.equal(cols.deliveredBasis, null, 'the basis is written exactly when the value is');
  assert.match(cols.notes, /Delivered: unmeasured \(source channel 1 coverage 0% < 90%\)\./);
});

test('★★ the house panel\'s channels are the ones read', () => {
  const { calls, cols } = assemble({ sourceChannels: [2] });
  assert.deepEqual([...new Set(calls.filter((c) => c.metric.startsWith('src')).map((c) => c.metric))], ['src2_w']);
  assert.ok(cols.deliveredKwh != null && cols.deliveredKwh > 6.5 && cols.deliveredKwh < 7.2, 'one Core\'s third');
  const none = assemble({ sourceChannels: [] }).cols;
  assert.equal(none.deliveredKwh, null);
  assert.match(none.notes, /Delivered: unmeasured \(no connected Core known on the house panel\)\./);
});

test('★ a PV set-aside still closes the notes, after the delivered clause', () => {
  const { cols } = assemble({
    row: {
      plan_date: '2026-09-30', issued_at_ms: phx(2026, 9, 30, 21, 30),
      actuation_applied_at_ms: APPLIED, actuation_reverted_at_ms: REVERTED, pv_model_sns: 'COREXXX00XXX0001',
    },
  });
  assert.ok(cols.pvSetAside);
  assert.ok(cols.notes.endsWith(`${cols.pvSetAside}.`));
  assert.ok(cols.notes.indexOf('Delivered:') < cols.notes.indexOf(cols.pvSetAside!));
});
