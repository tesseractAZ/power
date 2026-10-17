/**
 * v1.188.1 — the night-charge ledger does not score a row whose PV/load span includes held
 * telemetry, and repairs a row captured on held readings.
 *
 * The 2026-10-14 internet outage (23:53 → 01:55) left every Core offline in the EcoFlow cloud for
 * about 20 h and the panel until 04:16. Before v1.188.1 the recorder restated each device's last
 * reading every 5 minutes, so the per-Core PV coverage gate (0.9) counted the held rows as
 * coverage: the 10-14 row, captured at 10-15 21:31, integrated a held 0 W of PV over the day the
 * pool charged to ~96 % on solar. These tests drive the pure pieces (nightLedgerScoring.ts) with
 * that row's own timestamps; the scorer and sweep wiring in index.ts is pinned at the end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  heldMsWithin, heldLedgerVerdict, heldLedgerNote, heldLedgerRepair, heldResetColumns, heldTagNote,
  heldIntegratedActuals, heldCapturedClause, basisIncompleteNote, BASIS_INCOMPLETE_NOTE,
  forecastSpanResetColumns, forecastSpanRecaptureHorizonMs, coverageFrac, integrateWh,
  HELD_LEDGER_MIN_OVERLAP_MS, HELD_TELEMETRY_MARKER, FORECAST_SPAN_MS, type LedgerHeldSpan,
} from '../src/nightLedgerScoring.js';

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const phx = (y: number, mo: number, d: number, h: number, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h + 7, mi, s);

const CORES = ['COREXXX00XXX0001', 'COREXXX00XXX0002', 'COREXXX00XXX0005'];
const PANEL = 'PANEXXX00XXX0001';
const name = (sn: string) => (sn === PANEL ? 'Smart Home Panel 2' : `Core ${sn.slice(-1)}`);

const LAST_FRESH = phx(2026, 10, 14, 23, 53);
const PANEL_BACK = phx(2026, 10, 15, 4, 16);
const DEPLOY = phx(2026, 10, 16, 20, 30);
/** What the scan and the gate log for the incident: each Core held from its last fresh reading
 *  to the deploy (moved stretches), the panel to 04:16 (a moved stretch ending at its last restatement). */
const SPANS: LedgerHeldSpan[] = [
  ...CORES.map((sn) => ({ sn, startMs: LAST_FRESH, endMs: DEPLOY - 2 * MIN })),
  { sn: PANEL, startMs: LAST_FRESH, endMs: PANEL_BACK - 5 * MIN },
];

/** The 10-14 row as captured at 10-15 21:31 by v1.188.0 (issued 21:30, window 23:00 → 05:00). */
const ROW_1014 = {
  plan_date: '2026-10-14',
  issued_at_ms: phx(2026, 10, 14, 21, 30, 20),
  window_start_ms: phx(2026, 10, 14, 23),
  window_end_ms: phx(2026, 10, 15, 5),
  outcome_captured_at_ms: phx(2026, 10, 15, 21, 31, 5) as number | null,
  score_notes: 'not scored — overnight grid_home_w coverage 66% < 90% (MNAR-excluded).' as string | null,
  pv_model_sns: CORES.join(','),
  delivered_kwh: null as number | null,
  delivered_basis: null as string | null,
  // As v1.188.0 captured them: PV integrated from the held 0 W, load from the held panel rows.
  actual_pv_kwh: 0 as number | null,
  actual_load_kwh: 45.61 as number | null,
};
const HORIZON = forecastSpanRecaptureHorizonMs(30, 60);
/** index.ts PV_LEDGER_MIN_CORE_COVERAGE (pinned against the source below). */
const PV_LEDGER_MIN_CORE_COVERAGE_FOR_TEST = 0.9;

test('heldMsWithin — the union of a device\'s spans, clipped', () => {
  const s: LedgerHeldSpan[] = [
    { sn: 'A', startMs: 0, endMs: 10 }, { sn: 'A', startMs: 5, endMs: 20 }, { sn: 'A', startMs: 30, endMs: 40 }, { sn: 'B', startMs: 0, endMs: 100 },
  ];
  assert.equal(heldMsWithin(s, 'A', 0, 100), 30, 'a gate span and a moved stretch overlapping count once');
  assert.equal(heldMsWithin(s, 'A', 8, 35), 17);
  assert.equal(heldMsWithin(s, 'C', 0, 100), 0);
});

test('★★★ the 10-14 row: every Core held ~21.6 h of its span (no PV actual), the panel ~4.3 h (no load actual)', () => {
  const span = { startMs: ROW_1014.issued_at_ms, endMs: ROW_1014.issued_at_ms + FORECAST_SPAN_MS };
  const v = heldLedgerVerdict({ spans: SPANS, coreSns: CORES, panelSn: PANEL, span });
  assert.ok(v);
  assert.deepEqual(v.pv.map((p) => p.sn), [...CORES].sort());
  for (const p of v.pv) assert.ok(Math.abs(p.heldMs - (span.endMs - LAST_FRESH)) < MIN, `${p.sn}: ${p.heldMs / H} h`);
  assert.equal(v.load.length, 1);
  assert.ok(Math.abs(v.load[0].heldMs - (PANEL_BACK - 5 * MIN - LAST_FRESH)) < MIN);
  const note = heldLedgerNote(v, name);
  assert.ok(note.startsWith(`not scored — ${HELD_TELEMETRY_MARKER}: `), note);
  assert.match(note, /PV — Core 1 21\.\d h/);
  assert.match(note, /load — Smart Home Panel 2 4\.\d h/);
  assert.match(note, /PV and load actuals are left empty rather than integrated from held readings/);
  // The 10-15 row (captured ≥ 10-16 21:30): the Cores held the whole span, the panel none of it.
  const v15 = heldLedgerVerdict({ spans: SPANS, coreSns: CORES, panelSn: PANEL, span: { startMs: phx(2026, 10, 15, 21, 30), endMs: phx(2026, 10, 16, 21, 30) } })!;
  assert.equal(v15.pv.length, CORES.length);
  assert.deepEqual(v15.load, [], 'the panel was fresh: the load actual stands');
  assert.match(heldLedgerNote(v15, name), /the PV actual is left empty/);
});

test('★★ the threshold: an hour of hold inside the span is refused; less is bridged by the trapezoid', () => {
  const span = { startMs: 0, endMs: DAY };
  const at = (ms: number) => heldLedgerVerdict({ spans: [{ sn: CORES[0], startMs: 5 * H, endMs: 5 * H + ms }], coreSns: CORES, panelSn: PANEL, span });
  assert.equal(HELD_LEDGER_MIN_OVERLAP_MS, H);
  assert.ok(at(H), '★ exactly an hour: refused');
  assert.equal(at(H - 1), null, 'under an hour: integrated across, between two real readings');
  assert.equal(heldLedgerVerdict({ spans: [{ sn: CORES[0], startMs: -3 * H, endMs: 30 * MIN }], coreSns: CORES, panelSn: PANEL, span }), null,
    'only the part inside the span counts');
  assert.equal(heldLedgerVerdict({ spans: [{ sn: 'COREXXX00XXX0009', startMs: 0, endMs: DAY }], coreSns: CORES, panelSn: PANEL, span }), null,
    'a Core the panel does not connect (a bench spare) is not this row\'s PV');
});

test('★★★ what v1.188.0 captured for the 10-14 row, and what v1.188.1 captures', () => {
  // A Core's pv_total as v1.188.0 recorded it: night 0 W until 23:53, nothing during the outage,
  // then its last reading (0 W) restated every 5 min from 01:55 — through the solar day.
  const issued = ROW_1014.issued_at_ms;
  const end = issued + FORECAST_SPAN_MS;
  const pre: Array<{ ts: number; value: number }> = [];
  for (let t = issued; t <= LAST_FRESH; t += 5 * MIN) pre.push({ ts: t, value: 0 });
  const heldRows: Array<{ ts: number; value: number }> = [];
  for (let t = phx(2026, 10, 15, 1, 55); t <= end; t += 5 * MIN) heldRows.push({ ts: t, value: 0 });
  const v1880 = [...pre, ...heldRows];
  const cov = coverageFrac(v1880, issued, end);
  assert.ok(cov >= PV_LEDGER_MIN_CORE_COVERAGE_FOR_TEST, `★★★ v1.188.0: the held rows passed the 0.9 per-Core gate (${cov.toFixed(2)})`);
  assert.equal(integrateWh(v1880, true), 0, '…and an actual PV of 0 kWh was integrated: pv_err_frac −1, pv_in_band 0');
  // v1.188.1: the held rows are moved out (or never written) — the gate now sees the gap — and
  // the verdict refuses the row with its reason.
  assert.ok(coverageFrac(pre, issued, end) < PV_LEDGER_MIN_CORE_COVERAGE_FOR_TEST);
  assert.ok(heldLedgerVerdict({ spans: SPANS, coreSns: CORES, panelSn: PANEL, span: { startMs: issued, endMs: end } })?.pv.length === CORES.length);
});

test('★★★ the repair: the captured 10-14 row is reset for re-capture; the re-captured row is left alone', () => {
  const nowMs = DEPLOY + 5 * MIN;
  const r = heldLedgerRepair(ROW_1014, { spans: SPANS, coreSns: CORES, panelSn: PANEL, nowMs, horizonMs: HORIZON });
  assert.equal(r?.action, 'recapture');
  const cols = heldResetColumns(r!.verdict, name, ROW_1014);
  const { score_notes: a, ...resetA } = cols;
  const { score_notes: b, ...resetB } = forecastSpanResetColumns(0);
  assert.deepEqual(resetA, resetB, 'exactly the outcome columns the forecast-span reset clears (capture stamp first)');
  assert.equal(cols.outcome_captured_at_ms, null);
  assert.equal(cols.scored, 0);
  assert.match(String(a), /^reset — the PV and load actuals had been integrated from held readings \(PV — Core 1 /);
  assert.ok(!String(a).toLowerCase().includes(HELD_TELEMETRY_MARKER), 'the reset note is not the verdict');
  assert.ok(b);
  // After the re-capture the row carries the verdict: idempotent.
  const recaptured = { ...ROW_1014, outcome_captured_at_ms: nowMs + 30 * MIN, score_notes: `${heldLedgerNote(r!.verdict, name)} on-peak: none.` };
  assert.equal(heldLedgerRepair(recaptured, { spans: SPANS, coreSns: CORES, panelSn: PANEL, nowMs, horizonMs: HORIZON }), null);
  assert.equal(heldLedgerRepair({ ...ROW_1014, outcome_captured_at_ms: null }, { spans: SPANS, coreSns: CORES, panelSn: PANEL, nowMs, horizonMs: HORIZON }), null,
    'an uncaptured row is the capture\'s, not the repair\'s');
  assert.equal(heldLedgerRepair({ ...ROW_1014, window_start_ms: null as unknown as number }, { spans: SPANS, coreSns: CORES, panelSn: PANEL, nowMs, horizonMs: HORIZON }), null,
    'no window, no actuals measured');
  assert.equal(heldLedgerRepair(ROW_1014, { spans: [], coreSns: CORES, panelSn: PANEL, nowMs, horizonMs: HORIZON }), null, 'no hold, no repair');
});

test('★★★ an incomplete-basis row on held telemetry is reset once, not on every sweep', () => {
  // A plan recorded with no trajectory (SoC unavailable, climatology only: the outage at plan time
  // causes both) still keeps its window and its model Cores, so its PV/load actuals are captured
  // and the repair reads it. The scorer states the basis reason first; before v1.188.1's review it
  // stated ONLY that, without the marker, and the repair found the re-captured row owing a repair
  // again: reset and re-captured on every 30-min tick for the 28-day horizon.
  const issued = phx(2026, 10, 15, 22, 45);
  const noBasis = {
    ...ROW_1014,
    plan_date: '2026-10-15',
    issued_at_ms: issued,
    window_start_ms: phx(2026, 10, 15, 23),
    window_end_ms: phx(2026, 10, 16, 5),
    outcome_captured_at_ms: null as number | null,
    score_notes: null as string | null,
  };
  const spans: LedgerHeldSpan[] = CORES.map((sn) => ({ sn, startMs: LAST_FRESH, endMs: issued + 18 * H }));
  const verdict = heldLedgerVerdict({ spans, coreSns: CORES, panelSn: PANEL, span: { startMs: issued, endMs: issued + FORECAST_SPAN_MS } });
  assert.ok(verdict && verdict.pv.length === CORES.length && verdict.load.length === 0);
  const note = basisIncompleteNote(verdict, name);
  assert.ok(note.startsWith(BASIS_INCOMPLETE_NOTE), '★ the basis reason still comes first');
  assert.ok(note.toLowerCase().includes(HELD_TELEMETRY_MARKER), '★★★ and the held verdict carries the marker');
  assert.match(note, /PV — Core 1 18\.0 h/);
  assert.match(note, /the PV actual is left empty rather than integrated from held readings\.$/);
  assert.equal(basisIncompleteNote(null, name), BASIS_INCOMPLETE_NOTE, 'no hold: the note is unchanged');
  assert.ok(!BASIS_INCOMPLETE_NOTE.toLowerCase().includes(HELD_TELEMETRY_MARKER));

  // The sweep, tick by tick: repair (reset) → capture (the scorer's note) → the next tick.
  const sweep = (row: typeof noBasis, nowMs: number, capNote: (v: typeof verdict) => string) => {
    let resets = 0;
    let r = row;
    for (let tick = 0; tick < 6; tick++) {
      const at = nowMs + tick * 30 * MIN;
      const fix = heldLedgerRepair(r, { spans, coreSns: CORES, panelSn: PANEL, nowMs: at, horizonMs: HORIZON });
      if (fix) {
        assert.equal(fix.action, 'recapture');
        resets++;
        r = { ...r, ...heldResetColumns(fix.verdict, name, r) } as typeof noBasis;
      }
      if (r.outcome_captured_at_ms == null) r = { ...r, outcome_captured_at_ms: at, score_notes: `${capNote(verdict)} On-peak: none.` };
    }
    return resets;
  };
  const due = issued + FORECAST_SPAN_MS + 10 * MIN;
  // A row v1.188.0 captured on the held rows: reset once, then re-captured with the marker.
  const v1880 = { ...noBasis, outcome_captured_at_ms: due, score_notes: `${BASIS_INCOMPLETE_NOTE} On-peak: none.` };
  assert.equal(sweep(v1880, due + H, (v) => basisIncompleteNote(v, name)), 1, '★★★ reset exactly once');
  // A row first captured by v1.188.1 is never reset.
  assert.equal(sweep(noBasis, due, (v) => basisIncompleteNote(v, name)), 0, '★★ captured with the marker: never reset');
  // The defect, for the record: the basis note alone resets the row on every tick but the first.
  assert.equal(sweep(noBasis, due, () => BASIS_INCOMPLETE_NOTE), 5, 'without the marker: a reset every 30 min');
});

test('★★ the span the repair reads is the one the row was captured over', () => {
  // Captured 2 h after issue (a capture can never be this early now; the clip is what matters):
  // a hold starting after the capture is not in its actuals.
  const early = { ...ROW_1014, outcome_captured_at_ms: ROW_1014.issued_at_ms + 2 * H };
  assert.equal(heldLedgerRepair(early, { spans: SPANS, coreSns: CORES, panelSn: PANEL, nowMs: DEPLOY, horizonMs: HORIZON }), null);
});

/* ══ v1.188.1 dry run: the notes say what was integrated, and only that ═══════════ */

test('★★ the reset note names only the actuals that were integrated over the hold (captured non-null, side held)', () => {
  const both = heldLedgerVerdict({ spans: SPANS, coreSns: CORES, panelSn: PANEL, span: { startMs: ROW_1014.issued_at_ms, endMs: ROW_1014.issued_at_ms + FORECAST_SPAN_MS } })!;
  assert.ok(both.pv.length === CORES.length && both.load.length === 1, 'precondition: PV and load both held');
  assert.deepEqual(heldIntegratedActuals(both, { actual_pv_kwh: 0, actual_load_kwh: 45.61 }), ['PV', 'load']);
  assert.deepEqual(heldIntegratedActuals(both, { actual_pv_kwh: null, actual_load_kwh: 45.61 }), ['load'], 'a PV captured empty was never integrated');
  assert.deepEqual(heldIntegratedActuals(both, { actual_pv_kwh: 12.3, actual_load_kwh: null }), ['PV']);
  // The 10-15 row: every Core held ~21 h, the panel not (its 2.4 h hold fell in the 10-14 span);
  // PV captured null (the coverage gate refused it), load 55.42 kWh from fresh panel rows.
  const pvOnly = { pv: both.pv, load: [] };
  assert.deepEqual(heldIntegratedActuals(pvOnly, { actual_pv_kwh: null, actual_load_kwh: 55.42 }), [], '★★ nothing was integrated from held readings');
  const note = String(heldResetColumns(pvOnly, name, { actual_pv_kwh: null, actual_load_kwh: 55.42 }).score_notes);
  assert.match(note, /^reset — the held PV actual had been captured empty, so nothing had been integrated from held readings \(PV — Core 1 /, note);
  assert.doesNotMatch(note, /actuals had been integrated/);
  assert.doesNotMatch(note, /load actual/, 'the load was not held: it is not named');
  assert.equal(heldCapturedClause(pvOnly, { actual_pv_kwh: 7.5, actual_load_kwh: 55.42 }), 'the PV actual had been integrated from held readings');
  assert.equal(heldCapturedClause(both, { actual_pv_kwh: 0, actual_load_kwh: 45.61 }), 'the PV and load actuals had been integrated from held readings');
  assert.equal(heldCapturedClause(both, { actual_pv_kwh: null, actual_load_kwh: null }), 'the held PV and load actuals had been captured empty, so nothing had been integrated from held readings');
});

test('★★ the tag note says the span had no fresh readings (held or missing), never that the actuals were integrated from held readings', () => {
  // The 08-18 / 08-19 rows: Core 2 wrote NO rows at all on those days (a 9.8-day silence), so
  // nothing held was integrated into their actuals.
  const v = { pv: [{ sn: CORES[1], heldMs: 23.5 * H }], load: [] };
  const note = heldTagNote(v, name);
  assert.equal(note, 'Telemetry held: PV — Core 2 23.5 h of the 24 h span had no fresh readings (held or missing); '
    + 'the raw telemetry is past the re-capture horizon, so the row is kept as captured.');
  assert.doesNotMatch(note, /integrated/);
  assert.ok(note.toLowerCase().includes(HELD_TELEMETRY_MARKER), 'still the marker: the repair stays idempotent');
});

test('★★ past the horizon, or not re-capturable on today\'s devices: tagged, once', () => {
  const old = { ...ROW_1014, issued_at_ms: ROW_1014.issued_at_ms - 29 * DAY, outcome_captured_at_ms: ROW_1014.outcome_captured_at_ms! - 29 * DAY };
  const shifted = SPANS.map((s) => ({ ...s, startMs: s.startMs - 29 * DAY, endMs: s.endMs - 29 * DAY }));
  const r = heldLedgerRepair(old, { spans: shifted, coreSns: CORES, panelSn: PANEL, nowMs: DEPLOY, horizonMs: HORIZON });
  assert.equal(r?.action, 'tag');
  const tagged = { ...old, score_notes: `${old.score_notes} ${heldTagNote(r!.verdict, name)}` };
  assert.equal(heldLedgerRepair(tagged, { spans: shifted, coreSns: CORES, panelSn: PANEL, nowMs: DEPLOY, horizonMs: HORIZON }), null, 'the tag carries the marker');
  const noModel = heldLedgerRepair({ ...ROW_1014, pv_model_sns: '' }, { spans: SPANS, coreSns: CORES, panelSn: PANEL, nowMs: DEPLOY, horizonMs: HORIZON });
  assert.equal(noModel?.action, 'tag', 'no recorded model Cores: the forecast-span repair\'s own rule');
});

/* ══ wiring pins (index.ts has no seam a unit test can drive) ════════════════
 * Source pins, labelled as such: the behaviour is tested above; these only pin that the
 * scorer and the sweep call the functions tested, in the order that matters. */
const INDEX = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf8');
const fnBody = (sig: string) => { const i = INDEX.indexOf(sig); assert.ok(i > 0, sig); return INDEX.slice(i, INDEX.indexOf('\n}\n', i)); };

test('SOURCE PIN: the per-Core PV coverage gate the replay above uses', () => {
  assert.ok(INDEX.includes(`export const PV_LEDGER_MIN_CORE_COVERAGE = ${PV_LEDGER_MIN_CORE_COVERAGE_FOR_TEST};`));
});

test('★★ SOURCE PIN: the sweep waits for the first held-sample scan, then repairs before it captures', () => {
  const sweep = fnBody('function scoreCompletedNights(');
  const wait = sweep.indexOf('if (!(recorder.heldSamplesReady?.() ?? true)) {');
  const repair = sweep.indexOf('if (repairHeldNightOutcomes(rows, shp2Sn, nowMs)) rows = recorder.readNightLedger(LEDGER_BACKFILL_SWEEP_DAYS);');
  const capture = sweep.indexOf('for (const { row: y, spans: s } of ledgerRowsDueForCapture(rows, nowMs, nightSpansForRow)) {');
  assert.ok(wait > 0 && repair > wait && capture > repair, `${wait} < ${repair} < ${capture}`);
  const fix = fnBody('function repairHeldNightOutcomes(');
  assert.ok(fix.includes('const r = heldLedgerRepair(y, { spans, coreSns, panelSn: shp2Sn, nowMs, horizonMs });'));
  assert.ok(fix.includes('recorder.recordNightOutcome(String(y.plan_date), heldResetColumns(r.verdict, nameOf, y));'), 'the row as captured names its own actuals');
  assert.ok(fix.includes('night-charge: reset ${y.plan_date} for re-capture — ${heldCapturedClause(r.verdict, y)} ('), 'and the log line says the same');
  assert.ok(!fix.includes('actuals were integrated from held readings'), 'the tag line does not claim an integration');
  assert.ok(fix.includes('const coreSns = [...shp2ConnectedDpuSns(store.get().devices)];'), 'the same Cores the capture reads');
});

test('★★ SOURCE PIN: the scorer withholds a held actual and states the reason before any coverage reason', () => {
  const score = fnBody('function scoreNightRow(');
  assert.ok(score.includes('spans: recorder.heldSpans?.(fcSpanStart, fcSpanEnd) ?? [],'));
  assert.ok(score.includes('coreSns: [...homeSns], panelSn: shp2Sn, span: { startMs: fcSpanStart, endMs: fcSpanEnd },'));
  assert.ok(score.includes('actualPvKwh = worstCov >= PV_LEDGER_MIN_CORE_COVERAGE && !pvHeld ? round2(pvWh / 1000) : null;'));
  assert.ok(score.includes('const actualLoadKwh = loadPts.length && !(heldVerdict != null && heldVerdict.load.length > 0) ? round2(integrateWh(loadPts, false) / 1000) : null;'));
  const basis = score.indexOf('    scoreNotes = basisIncompleteNote(heldVerdict, deviceNameOf);\n  } else if (heldVerdict != null) {');
  const held = score.indexOf('} else if (heldVerdict != null) {\n    scoreNotes = heldLedgerNote(heldVerdict, deviceNameOf);');
  const cov = score.indexOf('} else if (!covOk) {');
  assert.ok(basis > 0 && held > basis && cov > held, `${basis} < ${held} < ${cov}`);
});
