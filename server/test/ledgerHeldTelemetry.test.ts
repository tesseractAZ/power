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
  const cols = heldResetColumns(r!.verdict, name);
  const { score_notes: a, ...resetA } = cols;
  const { score_notes: b, ...resetB } = forecastSpanResetColumns(0);
  assert.deepEqual(resetA, resetB, 'exactly the outcome columns the forecast-span reset clears (capture stamp first)');
  assert.equal(cols.outcome_captured_at_ms, null);
  assert.equal(cols.scored, 0);
  assert.match(String(a), /^reset — the PV\/load actuals had been integrated from held readings \(/);
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

test('★★ the span the repair reads is the one the row was captured over', () => {
  // Captured 2 h after issue (a capture can never be this early now; the clip is what matters):
  // a hold starting after the capture is not in its actuals.
  const early = { ...ROW_1014, outcome_captured_at_ms: ROW_1014.issued_at_ms + 2 * H };
  assert.equal(heldLedgerRepair(early, { spans: SPANS, coreSns: CORES, panelSn: PANEL, nowMs: DEPLOY, horizonMs: HORIZON }), null);
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
  assert.ok(fix.includes('recorder.recordNightOutcome(String(y.plan_date), heldResetColumns(r.verdict, nameOf));'));
  assert.ok(fix.includes('const coreSns = [...shp2ConnectedDpuSns(store.get().devices)];'), 'the same Cores the capture reads');
});

test('★★ SOURCE PIN: the scorer withholds a held actual and states the reason before any coverage reason', () => {
  const score = fnBody('function scoreNightRow(');
  assert.ok(score.includes('spans: recorder.heldSpans?.(fcSpanStart, fcSpanEnd) ?? [],'));
  assert.ok(score.includes('coreSns: [...homeSns], panelSn: shp2Sn, span: { startMs: fcSpanStart, endMs: fcSpanEnd },'));
  assert.ok(score.includes('actualPvKwh = worstCov >= PV_LEDGER_MIN_CORE_COVERAGE && !pvHeld ? round2(pvWh / 1000) : null;'));
  assert.ok(score.includes('const actualLoadKwh = loadPts.length && !(heldVerdict != null && heldVerdict.load.length > 0) ? round2(integrateWh(loadPts, false) / 1000) : null;'));
  const basis = score.indexOf("scoreNotes = 'not scored — plan basis was incomplete (no trajectory to score).';");
  const held = score.indexOf('} else if (heldVerdict != null) {\n    scoreNotes = heldLedgerNote(heldVerdict, deviceNameOf);');
  const cov = score.indexOf('} else if (!covOk) {');
  assert.ok(basis > 0 && held > basis && cov > held, `${basis} < ${held} < ${cov}`);
});
