import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rateAt,
  inHourWindow,
  seasonOf,
  localParts,
  buildApsREvModel,
  flatTariffModel,
  APS_SUMMER_MONTHS,
  type TariffModel,
} from '../src/tariff.js';

/* ═══════════════════════════════════════════════════════════════════════════
 * tariff — APS R-EV model + rateAt resolver (v1.36.0).
 *
 * Every case is anchored to a KNOWN Phoenix wall-clock instant. Phoenix is a
 * fixed UTC-7 (no DST), so a Phoenix-local (y,mo,d,h) maps to UTC (h+7); Date.UTC
 * with an overflowing hour rolls the day correctly. Building timestamps this way
 * (rather than `new Date(local)`) proves rateAt resolves in the model's OWN
 * timezone regardless of the host clock.
 *
 * Reference week (winter): 2026-01-05 Mon … -09 Fri, -10 Sat, -11 Sun, -12 Mon.
 * Reference day (summer):   2026-07-06 Mon, -10 Fri, -11 Sat.
 * ═════════════════════════════════════════════════════════════════════════ */

/** UTC ms for a Phoenix-local wall time (Phoenix = UTC-7, no DST). */
function phx(y: number, mo: number, d: number, h: number): number {
  return Date.UTC(y, mo - 1, d, h + 7, 0, 0);
}

const rev = buildApsREvModel(); // rates null / unconfirmed by default
const per = (ts: number) => rateAt(rev, ts).periodId;

/* ── localParts resolves in the model timezone ────────────────────────── */

test('tariff — localParts resolves Phoenix wall time from a UTC instant', () => {
  const lp = localParts(phx(2026, 1, 5, 17), 'America/Phoenix');
  assert.deepEqual(
    { y: lp.year, mo: lp.month, d: lp.day, h: lp.hour, dow: lp.dow, ymd: lp.ymd },
    { y: 2026, mo: 1, d: 5, h: 17, dow: 1, ymd: '2026-01-05' },
  );
});

test('tariff — midnight resolves to hour 0 (h23 cycle), not 24', () => {
  assert.equal(localParts(phx(2026, 1, 5, 0), 'America/Phoenix').hour, 0);
});

/* ── inHourWindow (same-day + wrap-around) ────────────────────────────── */

test('tariff — inHourWindow same-day [16,19) is end-exclusive', () => {
  assert.equal(inHourWindow(16, 16, 19), true);
  assert.equal(inHourWindow(18, 16, 19), true);
  assert.equal(inHourWindow(19, 16, 19), false); // end-exclusive
  assert.equal(inHourWindow(15, 16, 19), false);
});

test('tariff — inHourWindow wrap [23,5) spans midnight', () => {
  for (const h of [23, 0, 1, 2, 3, 4]) assert.equal(inHourWindow(h, 23, 5), true, `hour ${h}`);
  for (const h of [5, 6, 12, 22]) assert.equal(inHourWindow(h, 23, 5), false, `hour ${h}`);
});

/* ── season mapping ───────────────────────────────────────────────────── */

test('tariff — APS seasons: May–Oct summer, Nov–Apr winter (boundaries)', () => {
  assert.deepEqual(APS_SUMMER_MONTHS, [5, 6, 7, 8, 9, 10]);
  assert.equal(seasonOf(4, APS_SUMMER_MONTHS), 'winter'); // Apr
  assert.equal(seasonOf(5, APS_SUMMER_MONTHS), 'summer'); // May
  assert.equal(seasonOf(10, APS_SUMMER_MONTHS), 'summer'); // Oct
  assert.equal(seasonOf(11, APS_SUMMER_MONTHS), 'winter'); // Nov
});

/* ── weekday period boundaries (winter Monday) ────────────────────────── */

test('tariff — on-peak window 16:00–19:00 weekday edges', () => {
  assert.equal(per(phx(2026, 1, 5, 15)), 'off_peak'); // 3pm — super-off-peak ended at 15:00
  assert.equal(per(phx(2026, 1, 5, 16)), 'on_peak'); // 4pm — on-peak starts
  assert.equal(per(phx(2026, 1, 5, 18)), 'on_peak'); // 6pm
  assert.equal(per(phx(2026, 1, 5, 19)), 'off_peak'); // 7pm — end-exclusive
});

test('tariff — winter super-off-peak 10:00–15:00 weekday', () => {
  assert.equal(per(phx(2026, 1, 5, 9)), 'off_peak'); // 9am
  assert.equal(per(phx(2026, 1, 5, 10)), 'super_off_peak'); // 10am
  assert.equal(per(phx(2026, 1, 5, 14)), 'super_off_peak'); // 2pm
  assert.equal(per(phx(2026, 1, 5, 15)), 'off_peak'); // 3pm — end-exclusive
});

test('tariff — overnight 23:00–05:00 on a weekday (both sides of midnight)', () => {
  assert.equal(per(phx(2026, 1, 5, 23)), 'overnight'); // Mon 11pm
  assert.equal(per(phx(2026, 1, 5, 0)), 'overnight'); // Mon 12am (Mon is a weekday)
  assert.equal(per(phx(2026, 1, 5, 4)), 'overnight'); // Mon 4am
  assert.equal(per(phx(2026, 1, 5, 5)), 'off_peak'); // Mon 5am — end-exclusive
});

/* ── the load-bearing DOW edges (owner-confirmable) ───────────────────── */

test('tariff — ★Fri 11pm is overnight but Sat 12am–5am is OFF-PEAK (weekend)', () => {
  assert.equal(per(phx(2026, 1, 9, 23)), 'overnight'); // Fri 11pm (weekday)
  assert.equal(per(phx(2026, 1, 10, 0)), 'off_peak'); // Sat 12am (weekend)
  assert.equal(per(phx(2026, 1, 10, 2)), 'off_peak'); // Sat 2am (weekend)
});

test('tariff — ★Sun 11pm is off-peak but Mon 12am–5am is overnight', () => {
  assert.equal(per(phx(2026, 1, 11, 23)), 'off_peak'); // Sun 11pm (weekend)
  assert.equal(per(phx(2026, 1, 12, 0)), 'overnight'); // Mon 12am (weekday)
  assert.equal(per(phx(2026, 1, 12, 4)), 'overnight'); // Mon 4am (weekday)
});

test('tariff — all weekend hours are off-peak, even a 4–7pm on-peak hour', () => {
  assert.equal(per(phx(2026, 1, 10, 17)), 'off_peak'); // Sat 5pm (would be on-peak on a weekday)
  assert.equal(per(phx(2026, 1, 10, 12)), 'off_peak'); // Sat noon (no super-off-peak on weekends)
  assert.equal(per(phx(2026, 1, 11, 17)), 'off_peak'); // Sun 5pm
});

/* ── seasonal behaviour ───────────────────────────────────────────────── */

test('tariff — super-off-peak exists in WINTER only; summer midday is off-peak', () => {
  assert.equal(per(phx(2026, 1, 5, 12)), 'super_off_peak'); // Jan Mon noon (winter)
  assert.equal(per(phx(2026, 7, 6, 12)), 'off_peak'); // Jul Mon noon (summer — no super-off-peak)
});

test('tariff — on-peak and overnight are year-round (present in summer)', () => {
  assert.equal(per(phx(2026, 7, 6, 17)), 'on_peak'); // Jul Mon 5pm
  assert.equal(per(phx(2026, 7, 6, 2)), 'overnight'); // Jul Mon 2am
});

/* ── holidays ─────────────────────────────────────────────────────────── */

test('tariff — an observed holiday is all-day off-peak (overrides on-peak)', () => {
  const withHoliday = buildApsREvModel({ holidays: ['2026-01-05'] });
  assert.equal(rateAt(withHoliday, phx(2026, 1, 5, 17)).periodId, 'off_peak'); // holiday Mon 5pm
  // A non-holiday weekday is unaffected.
  assert.equal(rateAt(withHoliday, phx(2026, 1, 6, 17)).periodId, 'on_peak');
});

/* ── rate confirmation gate + per-season cents ────────────────────────── */

test('tariff — unconfirmed rates resolve to null cents everywhere (no fabrication)', () => {
  // default model is unconfirmed
  assert.equal(rateAt(rev, phx(2026, 1, 5, 17)).centsPerKwh, null);
  assert.equal(rateAt(rev, phx(2026, 7, 6, 2)).centsPerKwh, null);
});

test('tariff — confirmed rates return the correct per-season cents', () => {
  const m = buildApsREvModel({
    confirmed: true,
    onPeak: { summer: 36.8, winter: 34.8 },
    overnight: { summer: 8.5, winter: 8.5 },
    superOffPeak: { summer: null, winter: 3.5 },
    offPeak: { summer: 12.3, winter: 11.9 },
  });
  assert.equal(rateAt(m, phx(2026, 7, 6, 17)).centsPerKwh, 36.8); // summer on-peak
  assert.equal(rateAt(m, phx(2026, 1, 5, 17)).centsPerKwh, 34.8); // winter on-peak
  assert.equal(rateAt(m, phx(2026, 1, 5, 12)).centsPerKwh, 3.5); // winter super-off-peak
  assert.equal(rateAt(m, phx(2026, 7, 6, 2)).centsPerKwh, 8.5); // summer overnight
  assert.equal(rateAt(m, phx(2026, 1, 10, 12)).centsPerKwh, 11.9); // winter weekend off-peak
});

test('tariff — isOnPeak is true only for the on_peak period', () => {
  const m = buildApsREvModel({ confirmed: true, onPeak: { summer: 36, winter: 34 } });
  assert.equal(rateAt(m, phx(2026, 1, 5, 17)).isOnPeak, true);
  assert.equal(rateAt(m, phx(2026, 1, 5, 2)).isOnPeak, false); // overnight
  assert.equal(rateAt(m, phx(2026, 1, 5, 12)).isOnPeak, false); // super-off-peak
  assert.equal(rateAt(m, phx(2026, 1, 10, 17)).isOnPeak, false); // weekend
});

/* ── flat model (legacy behavior as a TariffModel) ────────────────────── */

test('tariff — flatTariffModel: every hour is off-peak at the flat rate', () => {
  const flat = flatTariffModel(17);
  for (const ts of [phx(2026, 1, 5, 17), phx(2026, 7, 6, 2), phx(2026, 1, 10, 12)]) {
    const r = rateAt(flat, ts);
    assert.equal(r.periodId, 'off_peak');
    assert.equal(r.centsPerKwh, 17);
    assert.equal(r.isOnPeak, false);
  }
});

test('tariff — flatTariffModel(null) is unconfirmed → null cents', () => {
  assert.equal(rateAt(flatTariffModel(null), phx(2026, 1, 5, 17)).centsPerKwh, null);
});

/* ── review-hardening (v1.36.0) ───────────────────────────────────────── */

test('tariff — dow is derived from the local calendar date (ICU-weekday independent)', () => {
  // Known DOWs, resolved from the Phoenix-local Y-M-D, not an ICU weekday string.
  assert.equal(localParts(phx(2026, 1, 9, 12), 'America/Phoenix').dow, 5); // Fri
  assert.equal(localParts(phx(2026, 1, 10, 12), 'America/Phoenix').dow, 6); // Sat
  assert.equal(localParts(phx(2026, 1, 11, 12), 'America/Phoenix').dow, 0); // Sun
  assert.equal(localParts(phx(2026, 1, 12, 12), 'America/Phoenix').dow, 1); // Mon
});

test('tariff — RateSlice.ratesConfirmed mirrors the model (distinguishes null-kinds)', () => {
  // Unconfirmed: null cents AND ratesConfirmed=false.
  const u = rateAt(rev, phx(2026, 1, 5, 17));
  assert.equal(u.centsPerKwh, null);
  assert.equal(u.ratesConfirmed, false);
  // Confirmed but a missing-season data gap: null cents BUT ratesConfirmed=true,
  // so a consumer can tell "rate gap" apart from "not yet confirmed".
  const gap = buildApsREvModel({ confirmed: true, overnight: { summer: null, winter: 8.5 } });
  const g = rateAt(gap, phx(2026, 7, 6, 2)); // summer overnight, summer rate null
  assert.equal(g.periodId, 'overnight');
  assert.equal(g.centsPerKwh, null);
  assert.equal(g.ratesConfirmed, true);
});

test('tariff — fixedDailyCents is nulled while unconfirmed (no fabricated money)', () => {
  const unconfirmed = buildApsREvModel({ fixedDailyCents: 45 });
  assert.equal(unconfirmed.ratesConfirmed, false);
  assert.equal(unconfirmed.fixedDailyCents, null); // not leaked
  const confirmed = buildApsREvModel({ confirmed: true, fixedDailyCents: 45 });
  assert.equal(confirmed.fixedDailyCents, 45); // surfaced once confirmed
});

test('tariff — isOnPeak follows the period.onPeak flag, not a magic id string', () => {
  // A model whose on-peak period has a NON-"on_peak" id but onPeak:true must
  // still resolve isOnPeak correctly (proves onPeakAt replacement is id-agnostic).
  const m: TariffModel = {
    planId: 'custom',
    timezone: 'America/Phoenix',
    periods: [
      {
        id: 'peak', // deliberately not 'on_peak'
        label: 'Peak',
        startHour: 16,
        endHour: 19,
        weekdays: [1, 2, 3, 4, 5],
        seasons: null,
        centsBySeason: { summer: 40, winter: 38 },
        onPeak: true,
      },
    ],
    offPeak: { id: 'off', label: 'Off', centsBySeason: { summer: 12, winter: 12 } },
    summerMonths: APS_SUMMER_MONTHS,
    holidays: [],
    ratesConfirmed: true,
  };
  assert.equal(rateAt(m, phx(2026, 1, 5, 17)).isOnPeak, true); // in 'peak' window
  assert.equal(rateAt(m, phx(2026, 1, 5, 2)).isOnPeak, false); // off-peak
});
