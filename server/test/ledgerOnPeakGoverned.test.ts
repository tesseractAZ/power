/**
 * v1.187.0 — the ledger's on-peak outcome measures the on-peak period the plan GOVERNS.
 *
 * Before: `actual_onpeak_import_kwh` integrated the plan day's own 16:00-19:00 — an
 * afternoon that closes ~2.5 h before the ~21:30 plan exists — on every day of the week.
 * Live (MST): the Mon 2026-09-28 plan (window Mon 23:00 → Tue 05:00, a clean night) would
 * have been charged with Monday afternoon's 4.27 kWh on-peak buy, which followed the
 * cancelled weekend arm; the on-peak it actually governed (Tue 09-29) bought 0 kWh; and
 * the Sat/Sun rows scored their weekend afternoons (off-peak under R-EV) as "on-peak".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  governedOnPeakSpan, supersedingPlanDate, nightOnPeakOutcome,
  ONPEAK_IMPORT_OCCURRED_KWH, LEDGER_SPAN_MIN_COVERAGE,
} from '../src/nightLedgerScoring.js';
import { buildApsREvModel, rateAt, type TariffModel } from '../src/tariff.js';
import { resolveCheapWindow } from '../src/nightChargeAdvisor.js';

const HOUR = 3_600_000;
/** UTC ms of a Phoenix wall time (UTC-7, no DST). */
const phx = (y: number, mo: number, d: number, h: number) => Date.UTC(y, mo - 1, d, h + 7);

const REV = buildApsREvModel({
  confirmed: true,
  onPeak: { summer: 44.2, winter: 30 },
  offPeak: { summer: 16.91, winter: 12 },
  overnight: { summer: 12.59, winter: 12.59 },
});
const spanFor = (windowEndMs: number, model: TariffModel = REV) => governedOnPeakSpan(
  windowEndMs,
  (t) => rateAt(model, t).isOnPeak,
  (t) => rateAt(model, t).periodId === 'overnight',
);

test('★★★ THE DEFECT: the 2026-09-28 plan is graded on Tuesday 09-29 16-19, not Monday 16-19', () => {
  // The live row: window 1790661600000 (Mon 23:00) → 1790683200000 (Tue 05:00).
  assert.equal(1790661600000, phx(2026, 9, 28, 23));
  const s = spanFor(1790683200000);
  assert.deepEqual(s, { startMs: phx(2026, 9, 29, 16), endMs: phx(2026, 9, 29, 19) });
  assert.ok(s!.startMs > 1790683200000, 'the span follows the window, never precedes the plan');
});

test('★★ weekend plans govern MONDAY\'s on-peak, never their own (off-peak) afternoon', () => {
  // 09-26 (Sat) and 09-27 (Sun) both resolved Mon 00:00 → 05:00.
  assert.equal(1790578800000, phx(2026, 9, 28, 0));
  const s = spanFor(1790596800000);
  assert.deepEqual(s, { startMs: phx(2026, 9, 28, 16), endMs: phx(2026, 9, 28, 19) });
});

test('★★ a Friday plan governs NO on-peak — null, never a measured 0', () => {
  // Fri 23:00 → Sat 00:00: the weekend is off-peak and Monday belongs to the plan whose
  // window opens Monday 00:00.
  assert.equal(spanFor(phx(2026, 9, 26, 0)), null);
  const o = nightOnPeakOutcome({ span: null, supersededBy: null, importKwh: null, coverage: null });
  assert.equal(o.basis, 'none');
  assert.equal(o.importKwh, null);
  assert.equal(o.occurred, null, 'not applicable is not "no on-peak import"');
});

test('a Thursday plan governs Friday 16-19', () => {
  assert.deepEqual(spanFor(phx(2026, 9, 25, 5)), { startMs: phx(2026, 9, 25, 16), endMs: phx(2026, 9, 25, 19) });
});

test('an observed holiday has no on-peak: the next window opens first, so the plan governs none', () => {
  const holiday = buildApsREvModel({ confirmed: true, holidays: ['2026-09-29'] });
  // Mon plan, window closes Tue 05:00 on the holiday; Tue 23:00 is holiday off-peak, Wed 00:00 opens.
  assert.equal(spanFor(phx(2026, 9, 29, 5), holiday), null);
  // The day after: normal again.
  assert.deepEqual(spanFor(phx(2026, 9, 30, 5), holiday), { startMs: phx(2026, 9, 30, 16), endMs: phx(2026, 9, 30, 19) });
});

test('★ every resolved window across two weeks and both seasons: the span is on-peak, after the window, and inside the 16 h score span', () => {
  for (const from of [phx(2026, 9, 14, 12), phx(2027, 1, 11, 12)]) {
    for (let d = 0; d < 14; d++) {
      const w = resolveCheapWindow((t) => rateAt(REV, t).periodId, from + d * 24 * HOUR, 'overnight', 30);
      if (!w) continue;
      const s = spanFor(w.endMs);
      if (!s) {
        // Only a window whose close runs into the weekend governs none (Friday's).
        const dow = new Date(w.endMs - 7 * HOUR).getUTCDay();
        assert.equal(dow, 6, `a null span only after a window closing on Saturday (got dow ${dow})`);
        continue;
      }
      assert.ok(s.startMs >= w.endMs);
      for (let t = s.startMs; t < s.endMs; t += HOUR) assert.equal(rateAt(REV, t).isOnPeak, true);
      assert.equal(rateAt(REV, s.endMs).isOnPeak, false, 'the run is complete');
      // ★ completeMs = max(close + 16 h, span end) never moves a capture under R-EV.
      assert.ok(s.endMs <= w.endMs + 16 * HOUR, 'the governed on-peak closes inside the score span');
    }
  }
});

test('★★ Saturday and Sunday rows share a window: the later plan carries it, never both', () => {
  const sat = { plan_date: '2026-09-26', window_start_ms: 1790578800000, window_end_ms: 1790596800000 };
  const sun = { plan_date: '2026-09-27', window_start_ms: 1790578800000, window_end_ms: 1790596800000 };
  const mon = { plan_date: '2026-09-28', window_start_ms: 1790661600000, window_end_ms: 1790683200000 };
  const rows = [sat, sun, mon];
  assert.equal(supersedingPlanDate(sat, rows), '2026-09-27');
  assert.equal(supersedingPlanDate(sun, rows), null, 'Sunday is the plan of record');
  assert.equal(supersedingPlanDate(mon, rows), null);
  assert.equal(supersedingPlanDate({ plan_date: '2026-09-25', window_start_ms: null, window_end_ms: null }, rows), null);
  const o = nightOnPeakOutcome({ span: spanFor(sat.window_end_ms), supersededBy: '2026-09-27', importKwh: 4.27, coverage: 1 });
  assert.equal(o.basis, 'superseded');
  assert.equal(o.importKwh, null, 'the Monday import is recorded once, on the Sunday row');
  assert.match(o.note, /2026-09-27/);
});

test('governed: measured only over a covered span; the occurred flag keeps its 0.05 kWh threshold', () => {
  const span = { startMs: 0, endMs: 3 * HOUR };
  const ok = nightOnPeakOutcome({ span, supersededBy: null, importKwh: 4.2731, coverage: 1 });
  assert.deepEqual([ok.basis, ok.importKwh, ok.occurred], ['governed', 4.27, 1]);
  assert.equal(nightOnPeakOutcome({ span, supersededBy: null, importKwh: 0, coverage: 1 }).occurred, 0);
  assert.equal(nightOnPeakOutcome({ span, supersededBy: null, importKwh: ONPEAK_IMPORT_OCCURRED_KWH, coverage: 1 }).occurred, 0);
  const thin = nightOnPeakOutcome({ span, supersededBy: null, importKwh: 1, coverage: LEDGER_SPAN_MIN_COVERAGE - 0.01 });
  assert.deepEqual([thin.basis, thin.importKwh, thin.occurred], ['governed', null, null], 'a deflated total is not written');
  assert.equal(nightOnPeakOutcome({ span, supersededBy: null, importKwh: null, coverage: 0 }).importKwh, null);
  assert.deepEqual(ok.span, span, 'the span measured is recorded with the value');
});

/* ══ integration pins (index.ts has no seam a unit test can drive) ══ */
const INDEX = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.ts'), 'utf8');
const fnBody = (sig: string) => { const i = INDEX.indexOf(sig); assert.ok(i > 0, sig); return INDEX.slice(i, INDEX.indexOf('\n}\n', i)); };

test('★★ nightSpansForRow resolves the spans from the tariff (completion is ledgerSpansForWindow\'s)', () => {
  // v1.187.0 (review) — completion waiting for the governed on-peak is tested behaviourally
  // in ledgerScorerAssembly.test.ts; this pins only that the row's spans come from it.
  const b = fnBody('function nightSpansForRow(');
  assert.ok(b.includes('const spans = ledgerSpansForWindow('));
  assert.ok(b.includes('(t) => rateAt(tariff, t).isOnPeak,'));
  assert.ok(b.includes('(t) => rateAt(tariff, t).periodId === NIGHT_CHEAP_PERIOD_ID,'));
  assert.ok(b.includes('scoreSpanEnd: spans.scoreSpanEndMs, completeMs: spans.completeMs, windowKnown: true,'));
  assert.ok(!b.includes('onpeakStartMs'), 'no plan-day anchor left');
});

test('★★ the scorer writes the governed outcome, its span and its basis, and passes the superseding plan', () => {
  const b = fnBody('function scoreNightRow(');
  assert.ok(b.includes('    onpeak: s.onpeak,'));
  assert.ok(b.includes('actual_onpeak_import_kwh: onpeak.importKwh,'));
  assert.ok(b.includes('onpeak_import_occurred: onpeak.occurred,'));
  assert.ok(b.includes('onpeak_basis: onpeak.basis,'));
  assert.ok(fnBody('function scoreCompletedNights(').includes('scoreNightRow(y, s, shp2Sn, nowMs, supersedingPlanDate(y, rows));'));
  // v1.187.0 (review) — a row with no window writes windowlessLedgerColumns' basis ('none'
  // for a plan that resolved no window), so NULL keeps one meaning.
  assert.ok(b.includes('    const wl = windowlessLedgerColumns(noWindowByDesign);'));
  assert.ok(b.includes('      onpeak_basis: wl.onpeakBasis,'));
});
