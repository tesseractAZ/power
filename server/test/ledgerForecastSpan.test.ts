/**
 * v1.187.10 — the PV/load actuals cover the forecast's own 24 h before a row is captured.
 *
 * The P50 that `load_err_frac`, `pv_err_frac` and (through the planner-sizing basis)
 * `buy_err_kwh` grade against sums the 24 hourly slots of the forecast issued with the plan,
 * and the actuals are integrated over [issued_at, issued_at + 24 h] clipped to the capture
 * instant. The capture was gated only on the night's completion (window close + 16 h). A
 * Friday 1 h window closes Saturday 00:00 and completes Saturday 16:00, ~5.4 h before
 * issue + 24 h: the 2026-10-02 row was captured at 16:08:08 on 18.6 h of load (39.62 kWh)
 * against an 81.8 kWh forecast — load_err −0.52, buy_err +51.09 kWh, frozen in the
 * never-pruned ledger the readiness gate reads its HARD under-buy evidence from.
 *
 * These tests drive the sweep's selection (`ledgerRowsDueForCapture`), the span the scorer
 * integrates (`forecastActualsSpan`) and the one-time repair (`forecastSpanRepair`) with the
 * real tariff and the live rows' timestamps.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ledgerSpansForWindow, ledgerCaptureDueMs, ledgerRowsDueForCapture, forecastActualsSpan,
  forecastSpanRepair, forecastSpanRecaptureHorizonMs, forecastSpanResetColumns, forecastSpanTagNote,
  integrateWh, FORECAST_SPAN_MS, FORECAST_SPAN_REPAIR_MIN_SHORT_MS, FORECAST_SPAN_TAG_MARKER,
  FORECAST_SPAN_RECAPTURE_MARGIN_DAYS,
} from '../src/nightLedgerScoring.js';
import { buildApsREvModel, rateAt } from '../src/tariff.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** UTC ms of a Phoenix wall time (UTC-7, no DST). */
const phx = (y: number, mo: number, d: number, h: number, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h + 7, mi, s);
const REV = buildApsREvModel({
  confirmed: true,
  onPeak: { summer: 44.2, winter: 30 },
  offPeak: { summer: 16.91, winter: 12 },
  overnight: { summer: 12.59, winter: 12.59 },
  superOffPeak: { summer: null, winter: 5 },
});
/** index.ts nightSpansForRow for a row with a stored window, on the R-EV calendar. */
const spansFor = (row: { window_end_ms: number }) => ledgerSpansForWindow(
  row.window_end_ms, (t) => rateAt(REV, t).isOnPeak, (t) => rateAt(REV, t).periodId === 'overnight',
);

/** The live 2026-10-02 (Friday) row: issued 21:30:54, window Fri 23:00 → Sat 00:00. */
const FRI = {
  plan_date: '2026-10-02',
  issued_at_ms: phx(2026, 10, 2, 21, 30, 54),
  window_start_ms: phx(2026, 10, 2, 23),
  window_end_ms: phx(2026, 10, 3, 0),
  outcome_captured_at_ms: null as number | null,
  score_notes: null as string | null,
};
/** The live 2026-10-01 (Thursday) row: issued 21:30:17, window Thu 23:00 → Fri 05:00. */
const THU = {
  plan_date: '2026-10-01',
  issued_at_ms: phx(2026, 10, 1, 21, 30, 17),
  window_start_ms: phx(2026, 10, 1, 23),
  window_end_ms: phx(2026, 10, 2, 5),
  outcome_captured_at_ms: null as number | null,
  score_notes: null as string | null,
};

/* ══ the capture gate ═══════════════════════════════════════════════════════ */

test('★★★ a Friday 1 h window completes Saturday 16:00 — and is NOT captured until issue + 24 h', () => {
  const s = spansFor(FRI);
  assert.equal(s.completeMs, phx(2026, 10, 3, 16), 'the night itself completes at close + 16 h (unchanged)');
  assert.equal(s.onpeak, null, 'a Friday governs no on-peak');
  // The live capture moment: the 30-min tick at 16:08:08.
  assert.deepEqual(ledgerRowsDueForCapture([FRI], phx(2026, 10, 3, 16, 8, 8), spansFor), [],
    'captured at 16:08 the load span is 18.6 h against a 24 h forecast');
  assert.deepEqual(ledgerRowsDueForCapture([FRI], FRI.issued_at_ms + FORECAST_SPAN_MS - 1, spansFor), []);
  const due = ledgerRowsDueForCapture([FRI], FRI.issued_at_ms + FORECAST_SPAN_MS, spansFor);
  assert.equal(due.length, 1, 'due the moment the forecast span has elapsed');
  assert.equal(due[0].row, FRI);
  assert.equal(due[0].spans.completeMs, s.completeMs, 'the spans handed to the scorer are the night\'s own');
});

test('★★★ at the moment the sweep captures, the actuals span is the forecast\'s 24 h', () => {
  for (const row of [FRI, THU]) {
    const s = spansFor(row);
    // The first instant ledgerRowsDueForCapture lets the row through.
    const dueAt = ledgerCaptureDueMs(s.completeMs, row.issued_at_ms);
    assert.equal(ledgerRowsDueForCapture([row], dueAt, spansFor).length, 1);
    const span = forecastActualsSpan(row.issued_at_ms, dueAt);
    assert.equal(span.startMs, row.issued_at_ms);
    assert.equal(span.endMs - span.startMs, FORECAST_SPAN_MS, `${row.plan_date}: actual span == forecast span`);
  }
});

test('★★ the integrated load at capture covers the whole forecast span (the 10-02 shape)', () => {
  // A flat 2.2 kW house from the issue until well after the span: the Friday row captured at
  // the night's completion integrated 18.6 h of it; captured when due it integrates 24 h.
  const pts: Array<{ ts: number; value: number }> = [];
  for (let t = FRI.issued_at_ms; t <= FRI.issued_at_ms + 30 * HOUR; t += MIN) pts.push({ ts: t, value: 2200 });
  const loadOver = (nowMs: number) => {
    const sp = forecastActualsSpan(FRI.issued_at_ms, nowMs);
    return integrateWh(pts.filter((p) => p.ts >= sp.startMs && p.ts <= sp.endMs), false) / 1000;
  };
  const oldCapture = phx(2026, 10, 3, 16, 8, 8);
  assert.ok(Math.abs(loadOver(oldCapture) - 2.2 * 18.62) < 0.1, `the defect: ${loadOver(oldCapture).toFixed(2)} kWh`);
  const dueAt = ledgerCaptureDueMs(spansFor(FRI).completeMs, FRI.issued_at_ms);
  assert.ok(Math.abs(loadOver(dueAt) - 2.2 * 24) < 0.05, `full span: ${loadOver(dueAt).toFixed(2)} kWh`);
});

test('★★ a weekday row waits for issue + 24 h too (21:00 completion, ~21:30 issue)', () => {
  const s = spansFor(THU);
  assert.equal(s.completeMs, phx(2026, 10, 2, 21), 'close 05:00 + 16 h');
  // The live capture moment, 6 min before issue + 24 h.
  assert.deepEqual(ledgerRowsDueForCapture([THU], phx(2026, 10, 2, 21, 23, 55), spansFor), []);
  assert.equal(ledgerRowsDueForCapture([THU], phx(2026, 10, 2, 21, 30, 17), spansFor).length, 1);
});

test('★ a row whose forecast span ended before its night completed still waits for the night', () => {
  // A Saturday plan arming Monday's 00:00-05:00 window completes Monday 21:00, 47 h after issue.
  const sat = {
    ...FRI, plan_date: '2026-10-03', issued_at_ms: phx(2026, 10, 3, 21, 30),
    window_start_ms: phx(2026, 10, 5, 0), window_end_ms: phx(2026, 10, 5, 5),
  };
  assert.equal(spansFor(sat).completeMs, phx(2026, 10, 5, 21));
  assert.deepEqual(ledgerRowsDueForCapture([sat], phx(2026, 10, 5, 20, 59), spansFor), []);
  assert.equal(ledgerRowsDueForCapture([sat], phx(2026, 10, 5, 21), spansFor).length, 1);
  // Captured 47.5 h after issue, its actuals still cover exactly the forecast's 24 h.
  const span = forecastActualsSpan(sat.issued_at_ms, phx(2026, 10, 5, 21));
  assert.deepEqual(span, { startMs: sat.issued_at_ms, endMs: sat.issued_at_ms + 24 * HOUR });
});

test('the sweep still skips captured rows and rows with no derivable spans; no issue time keeps the night\'s boundary', () => {
  const later = FRI.issued_at_ms + 2 * DAY;
  assert.deepEqual(ledgerRowsDueForCapture([{ ...FRI, outcome_captured_at_ms: later - HOUR }], later, spansFor), []);
  assert.deepEqual(ledgerRowsDueForCapture([FRI], later, () => null), []);
  assert.equal(ledgerCaptureDueMs(1_000, null), 1_000);
  assert.equal(ledgerCaptureDueMs(1_000, Number.NaN), 1_000);
  assert.equal(ledgerCaptureDueMs(1_000, 0), FORECAST_SPAN_MS, 'issue + 24 h when that is later');
  assert.equal(ledgerCaptureDueMs(FORECAST_SPAN_MS + 5, 0), FORECAST_SPAN_MS + 5, 'the night when that is later');
  assert.equal(FORECAST_SPAN_MS, 24 * HOUR);
});

/* ══ the one-time repair ════════════════════════════════════════════════════ */

const FRI_CAPTURED = { ...FRI, outcome_captured_at_ms: phx(2026, 10, 3, 16, 8, 8), score_notes: 'scored — …' };
const NOW = phx(2026, 10, 3, 18);

test('★★★ the 10-02 row (5.4 h short) is reset for re-capture inside the horizon', () => {
  const horizon = forecastSpanRecaptureHorizonMs(30, 60);
  const r = forecastSpanRepair(FRI_CAPTURED, NOW, horizon);
  assert.ok(r, 'the live defect row is repaired');
  assert.equal(r.action, 'recapture');
  assert.ok(Math.abs(r.shortMs - (FRI.issued_at_ms + FORECAST_SPAN_MS - FRI_CAPTURED.outcome_captured_at_ms)) < 1);
  assert.ok(r.shortMs > 5.3 * HOUR && r.shortMs < 5.4 * HOUR);
});

test('★★ the reset clears the capture stamp and every column the re-capture rewrites', () => {
  const cols = forecastSpanResetColumns(5.38 * HOUR);
  assert.equal(cols.outcome_captured_at_ms, null, 'a null capture is what lets the sweep capture it again');
  for (const k of ['actual_pv_kwh', 'actual_load_kwh', 'pv_err_frac', 'pv_in_band', 'load_err_frac', 'load_in_band',
    'buy_err_kwh', 'soc_min_err_pct', 'actual_window_import_kwh', 'realized_cost_cents', 'onpeak_basis'] as const) {
    assert.ok(k in cols && cols[k] === null, `${k} reset`);
  }
  assert.equal(cols.scored, 0, 'not evidence until re-captured');
  assert.match(String(cols.score_notes), /5\.4 h before issue \+ 24 h/);
  // And, once re-captured under the gate, the row is not repaired again.
  const recaptured = { ...FRI, outcome_captured_at_ms: FRI.issued_at_ms + FORECAST_SPAN_MS + 7 * MIN };
  assert.equal(forecastSpanRepair(recaptured, NOW + DAY, forecastSpanRecaptureHorizonMs(30, 60)), null);
  assert.equal(forecastSpanRepair({ ...FRI, outcome_captured_at_ms: null }, NOW, forecastSpanRecaptureHorizonMs(30, 60)), null,
    'a reset row awaiting the sweep is left alone');
});

test('★★ weekday rows stopped 0.1-0.5 h short are left as captured (below the 1 h threshold)', () => {
  const horizon = forecastSpanRecaptureHorizonMs(30, 60);
  // The live 10-01 row: captured 10-02 21:23:55, 0.11 h short.
  const thu = { ...THU, outcome_captured_at_ms: phx(2026, 10, 2, 21, 23, 55) };
  assert.equal(forecastSpanRepair(thu, NOW, horizon), null);
  assert.equal(FORECAST_SPAN_REPAIR_MIN_SHORT_MS, HOUR);
  // The 09-29 shape: 0.46 h short.
  assert.equal(forecastSpanRepair({ ...THU, outcome_captured_at_ms: THU.issued_at_ms + FORECAST_SPAN_MS - 0.46 * HOUR }, NOW, horizon), null);
  // An evening job delayed to ~22:45 (1.75 h short) is repaired.
  assert.equal(forecastSpanRepair({ ...THU, outcome_captured_at_ms: THU.issued_at_ms + FORECAST_SPAN_MS - 1.75 * HOUR }, NOW, horizon)?.action, 'recapture');
});

test('★ a row with no stored window (no actuals were measured) is never touched', () => {
  const windowless = { ...FRI_CAPTURED, window_start_ms: null, window_end_ms: null };
  assert.equal(forecastSpanRepair(windowless, NOW, forecastSpanRecaptureHorizonMs(30, 60)), null);
});

test('★★ past the horizon the row is TAGGED, once — never reset', () => {
  // 30-day retention: horizon 28 days. The same Friday shape issued 40 days before now.
  const old = {
    ...FRI_CAPTURED,
    issued_at_ms: FRI.issued_at_ms - 40 * DAY,
    outcome_captured_at_ms: FRI_CAPTURED.outcome_captured_at_ms - 40 * DAY,
  };
  const horizon = forecastSpanRecaptureHorizonMs(30, 60);
  assert.equal(horizon, 28 * DAY);
  const r = forecastSpanRepair(old, NOW, horizon);
  assert.equal(r?.action, 'tag', 'its telemetry is gone: a reset would re-capture it as unscored with null actuals');
  const note = forecastSpanTagNote(r!.shortMs);
  assert.ok(note.startsWith(FORECAST_SPAN_TAG_MARKER));
  assert.match(note, /cover 18\.6 h of the 24 h/);
  assert.equal(forecastSpanRepair({ ...old, score_notes: `scored — x. ${note}` }, NOW, horizon), null, 'idempotent');
  // Just inside the horizon it is re-captured.
  const inside = { ...old, issued_at_ms: NOW - 28 * DAY, outcome_captured_at_ms: NOW - 28 * DAY + 18.6 * HOUR };
  assert.equal(forecastSpanRepair(inside, NOW, horizon)?.action, 'recapture');
});

test('★★ the horizon stays inside BOTH the retention and the 60-day sweep, less the margin', () => {
  assert.equal(FORECAST_SPAN_RECAPTURE_MARGIN_DAYS, 2);
  assert.equal(forecastSpanRecaptureHorizonMs(30, 60), 28 * DAY, 'default retention');
  assert.equal(forecastSpanRecaptureHorizonMs(1825, 60), 58 * DAY,
    'multi-year retention: a row reset past the sweep would never be re-captured');
  assert.equal(forecastSpanRecaptureHorizonMs(7, 60), 5 * DAY, 'the minimum retention');
  assert.equal(forecastSpanRecaptureHorizonMs(1, 60), 0, 'never negative');
});

/* ══ wiring pins (index.ts has no seam a unit test can drive) ════════════════
 * Source pins, labelled as such: the behaviour is tested above; these only pin that the
 * scorer, its span and the boot repair call the functions tested. */
const INDEX = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf8');
const fnBody = (sig: string) => { const i = INDEX.indexOf(sig); assert.ok(i > 0, sig); return INDEX.slice(i, INDEX.indexOf('\n}\n', i)); };

test('★★ SOURCE PIN: the sweep captures through ledgerRowsDueForCapture; the scorer integrates forecastActualsSpan', () => {
  const sweep = fnBody('function scoreCompletedNights(');
  assert.ok(sweep.includes('for (const { row: y, spans: s } of ledgerRowsDueForCapture(rows, nowMs, nightSpansForRow)) {'));
  assert.ok(!/nowMs < s\.completeMs/.test(sweep), 'no second, completion-only gate');
  const score = fnBody('function scoreNightRow(');
  assert.ok(score.includes('const fcSpan = forecastActualsSpan(y.issued_at_ms, nowMs);'));
  assert.ok(score.includes("const loadPts = recorder.query(shp2Sn, 'panel_load', fcSpanStart, fcSpanEnd);"));
  assert.ok(score.includes("const pts = recorder.query(sn, 'pv_total', fcSpanStart, fcSpanEnd);"));
});

test('★★ SOURCE PIN: the boot repair runs before the warm sweep and applies the pure decision', () => {
  const repair = fnBody('function repairShortForecastSpanOutcomes(');
  assert.ok(repair.includes('const r = forecastSpanRepair(y, nowMs, horizonMs);'));
  assert.ok(repair.includes('recorder.recordNightOutcome(String(y.plan_date), forecastSpanResetColumns(r.shortMs));'));
  assert.ok(repair.includes('resolveRetentionDays(process.env.RECORDER_RETENTION_DAYS), LEDGER_BACKFILL_SWEEP_DAYS,'));
  const warm = INDEX.slice(INDEX.indexOf('const nightWarm = setTimeout('));
  const iRepair = warm.indexOf('repairShortForecastSpanOutcomes();');
  const iScore = warm.indexOf('scoreCompletedNights(Date.now());');
  assert.ok(iRepair > 0 && iScore > iRepair, 'repair first, then the sweep re-captures');
});
