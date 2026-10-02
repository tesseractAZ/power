/**
 * v1.187.0 (review) — the night scorer's column assembly, driven through its query seam.
 *
 * `scoreNightRow` assembled the on-peak span query, the superseded-row skip, the cost span
 * and its coverage gate, the delivered-energy span and the PV set-aside inline in index.ts,
 * and those lines were guarded only by source pins: move `costStart` to the window close,
 * count an export as negative import, or grade the set-aside against another device map,
 * and every test still passed. `assembleNightLedgerColumns` (nightLedgerScoring.ts) now
 * decides all of it from a `query(metric, start, end)` stub; these tests drive it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleNightLedgerColumns, ledgerSpansForWindow, windowlessLedgerColumns, realizedCostOutcome,
  governedOnPeakSpan, unpricedTariffPeriods, SCORE_SPAN_AFTER_CLOSE_MS, LEDGER_SPAN_MIN_COVERAGE,
  type LedgerMetric, type NightLedgerColumnsInput,
} from '../src/nightLedgerScoring.js';
import { buildApsREvModel, rateAt, type TariffModel } from '../src/tariff.js';
import { LEGACY_REVERT_LAG_MS } from '../src/nightChargeActuator.js';

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
const SNS = ['COREXXX00XXX0001', 'COREXXX00XXX0002', 'COREXXX00XXX0003'];

/** The live 2026-09-28 night: window Mon 23:00 → Tue 05:00 MST. */
const WS = phx(2026, 9, 28, 23);
const WE = phx(2026, 9, 29, 5);
const spansOf = (we: number, model: TariffModel = REV) => ledgerSpansForWindow(
  we, (t) => rateAt(model, t).isOnPeak, (t) => rateAt(model, t).periodId === 'overnight',
);

type Pt = { ts: number; value: number };
/** `w(t)` watts sampled every minute over [from, to]. */
const series = (from: number, to: number, w: (t: number) => number): Pt[] => {
  const out: Pt[] = [];
  for (let t = from; t <= to; t += MIN) out.push({ ts: t, value: w(t) });
  return out;
};

/** A recorder stub: inclusive bounds (recorder.ts `ts >= ? AND ts <= ?`), every call logged. */
function recorderStub(data: Partial<Record<LedgerMetric, Pt[]>>) {
  const calls: Array<{ metric: LedgerMetric; a: number; b: number }> = [];
  const query = (metric: LedgerMetric, a: number, b: number) => {
    calls.push({ metric, a, b });
    return (data[metric] ?? []).filter((p) => p.ts >= a && p.ts <= b);
  };
  return { query, calls };
}

/** The house: 15 kW through the window, 1.3 kW on grid after it, until the next evening. */
const houseGrid = (from = WS, to = WE + 17 * HOUR) => series(from, to, (t) => (t < WE ? 15_000 : 1_300));
const houseLoad = (from = WS, to = WE + 17 * HOUR) => series(from, to, () => 1_300);
/** v1.187.3 — the three source channels, each `w(t)` watts (+ = the panel charging that Core). */
const channels = (from: number, to: number, w: (t: number) => number) => ({
  src1_w: series(from, to, w), src2_w: series(from, to, w), src3_w: series(from, to, w),
});

function input(o: Partial<NightLedgerColumnsInput> & { data?: Partial<Record<LedgerMetric, Pt[]>> } = {}) {
  const stub = recorderStub(o.data ?? { grid_home_w: houseGrid(), panel_load: houseLoad() });
  const s = spansOf(WE);
  const i: NightLedgerColumnsInput = {
    row: {
      plan_date: '2026-09-28', issued_at_ms: phx(2026, 9, 28, 21, 30),
      actuation_applied_at_ms: null, actuation_reverted_at_ms: null, pv_model_sns: SNS.join(','),
    },
    actuated: false,
    windowStartMs: WS,
    windowEndMs: WE,
    scoreSpanEndMs: s.scoreSpanEndMs,
    onpeak: s.onpeak,
    supersededBy: null,
    query: stub.query,
    rateAt: (t) => rateAt(REV, t),
    homeSns: SNS,
    sourceChannels: [1, 2, 3],
    ...o,
  };
  return { cols: assembleNightLedgerColumns(i), calls: stub.calls, i };
}

/* ── spans ───────────────────────────────────────────────────────────────── */

test('the weekday spans: governed on-peak the next day 16-19, completion at close + 16 h', () => {
  const s = spansOf(WE);
  assert.deepEqual(s.onpeak, { startMs: phx(2026, 9, 29, 16), endMs: phx(2026, 9, 29, 19) });
  assert.equal(s.scoreSpanEndMs, WE + SCORE_SPAN_AFTER_CLOSE_MS);
  assert.equal(s.completeMs, s.scoreSpanEndMs, 'under R-EV the on-peak closes inside the span');
});

test('★★ completion waits for a governed on-peak that closes AFTER close + 16 h', () => {
  // A calendar whose on-peak runs 15-18 h after the close: capturing at +16 h would freeze
  // a two-thirds on-peak import into a never-pruned ledger.
  const T = WE;
  const late = ledgerSpansForWindow(T, (t) => t >= T + 15 * HOUR && t < T + 18 * HOUR, () => false);
  assert.deepEqual(late.onpeak, { startMs: T + 15 * HOUR, endMs: T + 18 * HOUR });
  assert.equal(late.completeMs, T + 18 * HOUR);
  const none = ledgerSpansForWindow(T, () => false, () => false);
  assert.equal(none.onpeak, null);
  assert.equal(none.completeMs, T + SCORE_SPAN_AFTER_CLOSE_MS);
});

/* ── the plan of record ──────────────────────────────────────────────────── */

test('★★ the plan of record: on-peak measured over the governed span, cost over [open, close + 16 h)', () => {
  const { cols, calls } = input();
  assert.equal(cols.onpeak.basis, 'governed');
  assert.equal(cols.onpeak.importKwh, 3.9, '1.3 kW × 3 h');
  assert.ok(calls.some((c) => c.metric === 'grid_home_w' && c.a === phx(2026, 9, 29, 16) && c.b === phx(2026, 9, 29, 19)));
  assert.deepEqual(cols.costSpan, { startMs: WS, endMs: WE + 16 * HOUR });
  // 6 h × 15 kW overnight + 11 h off-peak + 3 h on-peak + 2 h off-peak at 1.3 kW (+ the 1-min step).
  const expect = 6 * 15 * 12.59 + 13 * 1.3 * 16.91 + 3 * 1.3 * 44.2;
  assert.ok(cols.cost.cents != null && Math.abs(cols.cost.cents - expect) < 3, `got ${cols.cost.cents}, ~${expect}`);
  assert.match(cols.cost.note, /^Cost: [\d.]+¢ of metered import/);
  assert.match(cols.cost.note, /not a bill/);
  assert.equal(cols.hold, null, 'not actuated: no delivered span');
  assert.equal(cols.deliveredKwh, null);
  assert.equal(cols.deliveredBasis, null);
  assert.ok(!calls.some((c) => c.metric.startsWith('src')), 'an advisory night reads no source channel');
  assert.equal(cols.pvSetAside, null);
  assert.equal(cols.notes, `${cols.onpeak.note}. ${cols.cost.note}.`);
});

test('★★ an export is not a credit: the cost integrates IMPORT only', () => {
  // Midday export of 5 kW on the covered span must not lower the cost below the import alone.
  const g = houseGrid().map((p) => (p.ts >= phx(2026, 9, 29, 10) && p.ts < phx(2026, 9, 29, 14) ? { ...p, value: -5_000 } : p));
  const exporting = input({ data: { grid_home_w: g, panel_load: houseLoad() } }).cols.cost.cents!;
  const zeroed = input({
    data: { grid_home_w: g.map((p) => ({ ...p, value: Math.max(0, p.value) })), panel_load: houseLoad() },
  }).cols.cost.cents!;
  assert.equal(exporting, zeroed);
});

test('★★★ a SUPERSEDED row gets null on-peak and null cost, and queries neither span', () => {
  const { cols, calls } = input({ supersededBy: '2026-09-29' });
  assert.equal(cols.onpeak.basis, 'superseded');
  assert.equal(cols.onpeak.importKwh, null);
  assert.equal(cols.cost.cents, null);
  assert.match(cols.cost.note, /carried by the 2026-09-29 plan/);
  assert.equal(calls.length, 0, 'the shared on-peak and the shared cost are read once, by the later row');
  assert.match(cols.notes, /On-peak: carried by the 2026-09-29 plan.*Cost: carried by the 2026-09-29 plan/);
});

test('★★★ 85% grid_home_w coverage ⇒ null cost, and the note says so', () => {
  // A 200-minute hole in the morning: 224 of 264 five-minute buckets covered.
  const holed = houseGrid().filter((p) => !(p.ts >= phx(2026, 9, 29, 6) && p.ts < phx(2026, 9, 29, 9, 20)));
  const { cols } = input({ data: { grid_home_w: holed, panel_load: houseLoad() } });
  assert.equal(cols.cost.cents, null, 'a deflated total is never written');
  assert.match(cols.cost.note, /Cost: unmeasured \(grid_home_w coverage 85% < 90%\)/);
  assert.equal(cols.onpeak.importKwh, 3.9, 'the on-peak span itself is fully covered and still measured');
  assert.ok(0.85 < LEDGER_SPAN_MIN_COVERAGE);
});

test('★★ a null cost names WHY: unconfirmed rates, or a period with no rate this season', () => {
  const unconfirmed = buildApsREvModel({ onPeak: { summer: 44.2, winter: 30 } });
  const u = input({ rateAt: (t) => rateAt(unconfirmed, t) }).cols.cost;
  assert.equal(u.cents, null);
  assert.match(u.note, /rates unconfirmed/);
  // Winter weekday, confirmed table with no super-off-peak winter rate (the option's default ""):
  // the 10:00-15:00 hours of the day after the window cannot be priced.
  const noSop = buildApsREvModel({
    confirmed: true, onPeak: { summer: 44.2, winter: 30 }, offPeak: { summer: 16.91, winter: 12 },
    overnight: { summer: 12.59, winter: 12.59 },
  });
  const ws = phx(2026, 11, 2, 23);
  const we = phx(2026, 11, 3, 5);
  const s = ledgerSpansForWindow(we, (t) => rateAt(noSop, t).isOnPeak, (t) => rateAt(noSop, t).periodId === 'overnight');
  const w = input({
    windowStartMs: ws, windowEndMs: we, scoreSpanEndMs: s.scoreSpanEndMs, onpeak: s.onpeak,
    rateAt: (t) => rateAt(noSop, t),
    data: { grid_home_w: series(ws, we + 17 * HOUR, () => 1_000) },
  }).cols.cost;
  assert.equal(w.cents, null);
  assert.match(w.note, /no winter rate configured for Super Off-Peak/);
});

test('no samples at all: cost unmeasured, never $0', () => {
  const c = realizedCostOutcome({ span: { startMs: WS, endMs: WE }, supersededBy: null, pts: [], rateAt: (t) => rateAt(REV, t) });
  assert.equal(c.cents, null);
  assert.match(c.note, /coverage 0% < 90%/);
});

/* ── the delivered-energy span ───────────────────────────────────────────── */

test('★★★ a LEGACY row applied at 22:55 (no revert stamp): cost from 22:55, hold to close + 5 min', () => {
  const applied = WS - 5 * MIN;
  const { cols, calls } = input({
    actuated: true,
    row: { plan_date: '2026-09-28', issued_at_ms: phx(2026, 9, 28, 21, 30), actuation_applied_at_ms: applied, actuation_reverted_at_ms: null, pv_model_sns: null },
    data: {
      grid_home_w: houseGrid(applied), panel_load: houseLoad(applied),
      ...channels(applied, WE + 17 * HOUR, (t) => (t < WE ? 4_500 : -400)),
    },
  });
  assert.equal(cols.costSpan.startMs, applied, 'the early write is priced (at its off-peak rate)');
  assert.deepEqual(cols.hold, { startMs: applied, endMs: WE + LEGACY_REVERT_LAG_MS, basis: 'legacy-schedule' });
  for (const ch of ['src1_w', 'src2_w', 'src3_w']) {
    assert.ok(calls.some((c) => c.metric === ch && c.a === applied && c.b === WE + 5 * MIN), `${ch} over the hold`);
  }
  assert.ok(cols.deliveredKwh != null && cols.deliveredKwh > 0);
});

test('★★★ THE TAIL: a night still charging at the close counts what it bought until the restore landed', () => {
  // Applied at the open (the current schedule); the restore lands at 05:00:28 and the Cores
  // stop ~30 s later. 15 kW import vs a 1.3 kW house, 4.5 kW into each of three Cores,
  // through the 05:01 sample; then the house alone, partly from the pack.
  const reverted = WE + 28_000;
  const grid = series(WS, WE + 17 * HOUR, (t) => (t <= WE + MIN ? 15_000 : 1_300));
  const into = channels(WS, WE + 17 * HOUR, (t) => (t <= WE + MIN ? 4_500 : -150));
  const run = (revertedAt: number | null) => input({
    actuated: true,
    row: { plan_date: '2026-09-28', issued_at_ms: phx(2026, 9, 28, 21, 30), actuation_applied_at_ms: WS + 28_000, actuation_reverted_at_ms: revertedAt, pv_model_sns: null },
    data: { grid_home_w: grid, panel_load: houseLoad(), ...into },
  }).cols;
  const stamped = run(reverted);
  assert.deepEqual(stamped.hold, { startMs: WS, endMs: reverted + 60_000, basis: 'revert-stamp' });
  // What the first cut of v1.187.0 integrated: exactly the window.
  const upToClose = (pts: Pt[]) => pts.filter((p) => p.ts <= WE);
  const windowOnly = input({
    actuated: true, windowEndMs: WE,
    row: { plan_date: '2026-09-28', issued_at_ms: 0, actuation_applied_at_ms: WS, actuation_reverted_at_ms: WE - 1 * HOUR, pv_model_sns: null },
    data: {
      grid_home_w: upToClose(grid), panel_load: upToClose(houseLoad()),
      src1_w: upToClose(into.src1_w), src2_w: upToClose(into.src2_w), src3_w: upToClose(into.src3_w),
    },
  }).cols.deliveredKwh!;
  assert.ok(stamped.deliveredKwh! > windowOnly + 0.2,
    `the ~1 min at 13.5 kW into the Cores past the close is delivered energy (${stamped.deliveredKwh} vs ${windowOnly})`);
  // No stamp on the current schedule: close + one actuator tick + the device settle.
  assert.deepEqual(run(null).hold, { startMs: WS, endMs: WE + 2 * MIN, basis: 'close-plus-tick' });
});

test('★★ the revert stamp is bounded: never before the close, never past close + 30 min', () => {
  const at = (revertedAt: number) => input({
    actuated: true,
    row: { plan_date: '2026-09-28', issued_at_ms: 0, actuation_applied_at_ms: WS, actuation_reverted_at_ms: revertedAt, pv_model_sns: null },
  }).cols.hold!;
  assert.equal(at(WS + 3 * HOUR).endMs, WE + MIN, 'an owner cancel at 02:00 keeps the window (as before), plus the settle');
  assert.equal(at(WE + 3 * HOUR).endMs, WE + 30 * MIN + MIN, 'a restore hours late does not integrate the solar morning');
  assert.equal(at(WE + 10 * MIN).endMs, WE + 11 * MIN, 'a late restore inside the bound is followed');
});

/* ── PV evidence ─────────────────────────────────────────────────────────── */

test('★★ the set-aside is graded against the Cores the actuals sum, and the known row is tagged', () => {
  const oneCore = input({ row: { plan_date: '2026-09-28', issued_at_ms: 0, actuation_applied_at_ms: null, actuation_reverted_at_ms: null, pv_model_sns: SNS[0] } }).cols;
  assert.match(oneCore.pvSetAside!, /different set of Cores \(1\) than the actual PV sums \(3\)/);
  assert.ok(oneCore.notes.endsWith(`${oneCore.pvSetAside}.`), 'the reason is in score_notes');
  const sameCores = input({ homeSns: [...SNS].reverse() }).cols;
  assert.equal(sameCores.pvSetAside, null);
  const otherMap = input({ homeSns: [SNS[0], SNS[1], 'COREXXX00XXX0009'] }).cols;
  assert.ok(otherMap.pvSetAside, 'the device map the actuals are summed over is the one compared');
  const known = input({
    row: { plan_date: '2026-09-27', issued_at_ms: 1790569855336, actuation_applied_at_ms: null, actuation_reverted_at_ms: null, pv_model_sns: null },
  }).cols;
  assert.match(known.pvSetAside!, /partial-map/);
});

/* ── rows with no window ─────────────────────────────────────────────────── */

test('★ a plan with no window by design records onpeak_basis none; an unpairable legacy row stays NULL', () => {
  const byDesign = windowlessLedgerColumns(true);
  assert.equal(byDesign.onpeakBasis, 'none');
  assert.match(byDesign.notes, /On-peak: none governed \(no charge window\)/);
  assert.match(byDesign.notes, /Cost: none recorded/);
  const legacy = windowlessLedgerColumns(false);
  assert.equal(legacy.onpeakBasis, null, 'NULL = not measured on the governed basis, never "none governed"');
});

test('the governed span itself is unchanged by the assembly (same tariff, same answer)', () => {
  const direct = governedOnPeakSpan(WE, (t) => rateAt(REV, t).isOnPeak, (t) => rateAt(REV, t).periodId === 'overnight');
  assert.deepEqual(input().cols.onpeak.span, direct);
});

test('★ the boot names a confirmed table\'s unpriced periods (the winter super-off-peak default ""), and only in season', () => {
  const noSop = buildApsREvModel({
    confirmed: true, onPeak: { summer: 44.2, winter: 30 }, offPeak: { summer: 16.91, winter: 12 },
    overnight: { summer: 12.59, winter: 12.59 },
  });
  assert.deepEqual(unpricedTariffPeriods(noSop), ['Super Off-Peak (10am–3pm Mon–Fri, winter) (winter)'],
    'a winter-only period is never reported for summer');
  assert.deepEqual(unpricedTariffPeriods(REV), [], 'a complete table');
  assert.deepEqual(unpricedTariffPeriods(buildApsREvModel()), [], 'unconfirmed: null by design, not a gap');
});
